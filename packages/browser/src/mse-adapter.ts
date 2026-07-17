/**
 * MseMediaSource — stateless MSE SourceBuffer pipe for CMAF playback.
 *
 * Implements MediaSourceLike for use with MoqtPlayer.
 * MseMediaSource is a dumb pipe: initialize() creates SourceBuffers,
 * appendChunk() appends data. All data ordering, moof+mdat concatenation,
 * and init-before-media sequencing is the player's responsibility.
 *
 * Uses 'segments' mode to preserve moof baseDecodeTime timestamps.
 * The caller sets timestampOffset via setTimestampOffset() to rebase
 * live timestamps to zero.
 *
 * @see draft-ietf-moq-cmsf-00 §3.1 (Initialization headers — ftyp+moov)
 * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging — moof+mdat)
 * @module
 */

import type { MediaSourceLike } from '@moqt/player';
import {
  filterInitSegment,
  describeBoxes,
  peekSegmentMetadata,
  readSegmentTimeRanges,
  readTrexDefaults,
  type SegmentTimeRange,
  type TrexDefaults,
} from './mp4-box.js';
import { TimelineIndex } from './timeline-index.js';

// ─── Diagnostic ring buffer ──────────────────────────────────────────

/**
 * Per-segment metadata recorded just before appendBuffer, kept in a small
 * ring per media type. Dumped to console on any video-element error or
 * SourceBuffer error so the frame-before-the-crash is visible in logs.
 */
interface AppendRecord {
  readonly mediaType: 'video' | 'audio';
  /** Order in which this append happened within the session. */
  readonly seq: number;
  /** Total bytes in this segment (including styp/sidx prefix if any). */
  readonly totalSize: number;
  /** baseMediaDecodeTime from the moof's tfdt (post-patch), or null if none found. */
  readonly bmd: bigint | null;
  /** mdat box size if present, or null. Useful for size anomalies. */
  readonly mdatSize: number | null;
  /** HEVC/AVC NAL unit types found inside the mdat (first byte of each NAL). */
  readonly nalTypes: number[];
  /** Hex-encoded first 48 bytes of the mdat payload (after the box header). */
  readonly mdatHead: string;
  /** Wall-clock ms of this append (performance.now()). */
  readonly appendWallMs: number;
  /** Delta from the previous append on the same media type, in ms. */
  readonly deltaFromPrevMs: number | null;
}

const RING_CAPACITY = 8;

/**
 * Scan a CMAF segment for mdat and return:
 *   - NAL unit types (first byte, HEVC-style: `(byte >> 1) & 0x3F`)
 *   - Hex-encoded first 48 bytes of the NAL stream
 *
 * MSE CMAF segments use length-prefixed NAL units (AVCC/HVCC format):
 * [4-byte length][NAL unit][4-byte length][NAL unit]...
 *
 * Bounded to the first 16 NAL units inspected to keep the cost fixed even
 * on weird segments. On decode failure the last few NAL types are the
 * signal; the head-hex lets us analyze offline.
 */
function scanMdatNals(segment: Uint8Array): { nalTypes: number[]; mdatHead: string } {
  const nalTypes: number[] = [];
  let mdatHead = '';

  // Find mdat box.
  let pos = 0;
  while (pos + 8 <= segment.byteLength) {
    const size = ((segment[pos]! << 24) | (segment[pos + 1]! << 16)
                | (segment[pos + 2]! << 8) | segment[pos + 3]!) >>> 0;
    const type = String.fromCharCode(
      segment[pos + 4]!, segment[pos + 5]!, segment[pos + 6]!, segment[pos + 7]!,
    );
    if (type === 'mdat') {
      const payloadStart = pos + 8;
      const payloadEnd = Math.min(pos + size, segment.byteLength);

      // Hex head — first 48 bytes of the mdat payload.
      const headLen = Math.min(48, payloadEnd - payloadStart);
      mdatHead = Array.from(segment.subarray(payloadStart, payloadStart + headLen))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');

      // Walk NAL units. AVCC: [uint32 nalLen][NAL...].
      let np = payloadStart;
      let inspected = 0;
      while (np + 4 < payloadEnd && inspected < 16) {
        const nalLen = ((segment[np]! << 24) | (segment[np + 1]! << 16)
                      | (segment[np + 2]! << 8) | segment[np + 3]!) >>> 0;
        np += 4;
        if (nalLen === 0 || np >= payloadEnd) break;
        // HEVC NAL header: byte[0] bit 0 = forbidden_zero, bits 1-6 = nal_unit_type.
        // For H.264: byte[0] bits 0-4 = nal_unit_type (lower 5 bits).
        // We record the HEVC decoding; the H.264 type is `type & 0x1F` of the same byte.
        // Consumer inspects the codec string; this is a raw diagnostic.
        const nalHeader = segment[np]!;
        const hevcType = (nalHeader >> 1) & 0x3F;
        nalTypes.push(hevcType);
        inspected++;
        np += nalLen;
      }
      return { nalTypes, mdatHead };
    }
    if (size < 8) break;
    pos += size;
  }
  return { nalTypes, mdatHead };
}

// ─── Adapter ──────────────────────────────────────────────────────────

/**
 * Live-buffer management knobs for {@link MseMediaSource}. All optional.
 *
 * NOTE: the behind-live cap (`maxAheadSec`) is LIVE-specific behavior — it
 * deliberately skips playback forward to chase the live edge. If CMAF VOD /
 * time-shift playback becomes a supported mode, it will need an opt-out or
 * live-aware configuration (e.g. `maxAheadSec: Infinity` disables the jump).
 */
/**
 * Diagnostic snapshot emitted by the playhead-wedge watchdog — one per
 * recovery rung. Mirrors the manual console capture this replaces.
 */
export interface PlayheadWedgeInfo {
  /** Recovery rung: 1 nudge, 2 pause/play pulse, 3 live-edge seek, 4 onError. */
  readonly rung: number;
  readonly currentTime: number;
  readonly readyState: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  /** "start-end|start-end" of the element's buffered ranges. */
  readonly bufferedRanges: string;
  readonly decodedFrames?: number;
  readonly droppedFrames?: number;
}

export interface MseMediaSourceOptions {
  /** Seconds of played-out media to keep behind currentTime; older buffered data
   *  is evicted via SourceBuffer.remove() so the browser quota is never exhausted
   *  by stale history. Default 10. */
  readonly keepBehindSec?: number;
  /** Behind-live cap: if buffered-ahead of currentTime exceeds this, playback
   *  jumps toward the live edge (post-startup only). Default 15.
   *  Set Infinity to disable (VOD/time-shift). */
  readonly maxAheadSec?: number;
  /** Where a behind-live jump lands: rangeEnd - targetAheadSec. Default 2. */
  readonly targetAheadSec?: number;
}

/**
 * Stateless MSE SourceBuffer pipe.
 *
 * The player MUST call initialize() before appendChunk(). Data ordering
 * (init before media, moof+mdat concatenation) is the player's job.
 * MseMediaSource handles SourceBuffer back-pressure (updateend drain) plus
 * live-buffer hygiene: back-buffer eviction, a behind-live cap, and
 * QuotaExceededError recovery (evict + retry, escalating to flush-and-rejoin).
 *
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
 */
export class MseMediaSource implements MediaSourceLike {
  private ms: MediaSource;
  private videoBuffer: SourceBuffer | null = null;
  private audioBuffer: SourceBuffer | null = null;

  /**
   * Back-pressure queues — only for SourceBuffer.updating serialization.
   * Each entry preserves its source `trackName` so the timeline check
   * runs against the right per-track index when the queue drains.
   */
  private readonly videoQueue: Array<{ data: Uint8Array; trackName: string; groupId?: bigint }> = [];
  private readonly audioQueue: Array<{ data: Uint8Array; trackName: string; groupId?: bigint }> = [];

  /** Per-(mediaType:trackName) committed group high-water mark. */
  private readonly committedGroupFloor = new Map<string, bigint>();

  private readonly video: HTMLVideoElement;
  private objectUrl: string | null = null;
  private destroyed = false;
  private initialized = false;

  // ─── Callbacks ──────────────────────────────────────────────────

  onFirstFrame: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onStall: ((durationMs: number) => void) | null = null;
  /** Fired after the adapter repositioned playback toward the live edge —
   *  'behind-live' (buffered-ahead cap) or 'quota' (flush + rejoin after
   *  QuotaExceededError). INFORMATIONAL, concrete-class only: it is NOT part of
   *  MediaSourceLike and MoqtPlayer does not wire it yet — an app holding the
   *  concrete adapter may use it for logging, or (future work) the player could
   *  consume it to request fresh keyframe-led media when the publisher doesn't
   *  keyframe-align chunks. */
  onLiveEdgeResync: ((reason: 'quota' | 'behind-live') => void) | null = null;

  /**
   * Fired when the playhead-wedge watchdog detects or escalates a wedge
   * (Safari MSE: currentTime frozen, readyState high, buffer growing — no
   * `waiting` event, no error event, so the stall path is structurally
   * blind). INFORMATIONAL, concrete-class only — like {@link onLiveEdgeResync},
   * it is NOT part of MediaSourceLike; apps may wire it for diagnostics.
   * Recovery itself runs internally (see checkPlayheadWedge), and the final
   * rung surfaces through the already-wired onError.
   */
  onWedge: ((info: PlayheadWedgeInfo) => void) | null = null;

  private firstFrameFired = false;
  private playTriggered = false;
  private stallStartTime: number | null = null;

  // ── Playhead-wedge watchdog state ──
  /** Watchdog cadence; detection threshold per escalation rung. */
  private static readonly WEDGE_CHECK_INTERVAL_MS = 1_000;
  private static readonly WEDGE_FROZEN_MS = 2_500;
  private wedgeTimer: ReturnType<typeof setInterval> | null = null;
  /** Last observed currentTime; ladder resets only on ORGANIC movement. */
  private wedgeLastTime: number | null = null;
  /** When the playhead stopped moving while wedge-eligible. */
  private wedgeFrozenSinceMs: number | null = null;
  /** Escalation rung of the current wedge episode (0 = healthy). */
  private wedgeRung = 0;

  // ── Live-buffer management (eviction / behind-live cap / quota recovery) ──
  /** Seconds of played-out media kept behind currentTime; older data is evicted. */
  private readonly keepBehindSec: number;
  /** Buffered-ahead cap: beyond this, jump toward the live edge (post-startup only). */
  private readonly maxAheadSec: number;
  /** Where a live-edge jump lands: rangeEnd - targetAheadSec. */
  private readonly targetAheadSec: number;
  /** One evict+retry is allowed per quota error before escalating to flush. */
  private readonly quotaRetried: { video: boolean; audio: boolean } = { video: false, audio: false };
  /** A quota flush happened; the next committed append jumps playback to it. */
  private chaseAfterFlush = false;
  /** Guards a flush→quota→flush loop: emit one onError, drop until recovered. */
  private quotaFlushInFlight = false;

  // ── Diagnostic ring buffer (last RING_CAPACITY appends per media type) ──
  private readonly videoRing: AppendRecord[] = [];
  private readonly audioRing: AppendRecord[] = [];
  private appendSeq = 0;
  private lastAppendWallMs: { video: number | null; audio: number | null } = {
    video: null,
    audio: null,
  };
  /** Init-segment summary, captured at initialize() for inclusion in failure dumps. */
  private videoInitSummary: string | null = null;
  private audioInitSummary: string | null = null;
  /** Set once the video element enters an error state — prevents repeated dumps. */
  private videoErrorDumped = false;

  // ── Timeline-owned append state (see timeline-index.ts) ─────────
  /**
   * Per-track timelines, keyed by trackName. ABR switches deliver the
   * same decode-time range under a different trackName — those overlaps
   * are legitimate splices and must not be dropped, so each track gets
   * its own index. Single-track duplicates (e.g., a relay that
   * publishes both regular IDR-GOP segments and mid-segment CRA entry
   * points under one track-name) still collide within their shared
   * index and are dropped.
   */
  private readonly videoTimelines = new Map<string, TimelineIndex>();
  private readonly audioTimelines = new Map<string, TimelineIndex>();

  /** trex defaults from the init segment, per media type. */
  private videoTrex: TrexDefaults | undefined;
  private audioTrex: TrexDefaults | undefined;

  /**
   * Ranges for the in-flight appendBuffer, per media type, with the
   * source trackName so updateend commits into the right per-track
   * index. Single-entry sufficient because `buffer.updating` guards
   * against concurrent appends on the same SourceBuffer.
   */
  private pendingVideoRanges: readonly SegmentTimeRange[] = [];
  private pendingAudioRanges: readonly SegmentTimeRange[] = [];
  private pendingVideoTrackName: string | null = null;
  private pendingAudioTrackName: string | null = null;
  private pendingVideoGroupId: bigint | undefined;
  private pendingAudioGroupId: bigint | undefined;

  /** Set by the SourceBuffer/video error handlers; cleared on successful commit. */
  private appendErrored: { video: boolean; audio: boolean } = { video: false, audio: false };

  /**
   * Lifecycle gate for `changeType()`. While true for a given media type:
   *   - `appendChunk()` queues incoming data instead of dispatching.
   *   - `drainQueue()` is a no-op (queue stays parked until the type change finishes).
   *
   * Borrowed from the WebCodecs path: state-mutating operations
   * (configure / changeType) must serialize with data appends to avoid
   * mid-flight format mismatches.
   */
  private readonly changingType: { video: boolean; audio: boolean } = {
    video: false,
    audio: false,
  };

  /**
   * Warn-once guard for parser diagnostics. Per-instance so test
   * isolation is automatic. Keyed by `${mediaType}:${kind}` — video and
   * audio warn independently.
   */
  private readonly seenDiagnostics = new Set<string>();

  /** Enable diagnostic logging (MSE init, changeType, append details). */
  debug = false;

  private logDebug(msg: string, ...args: unknown[]): void {
    if (this.debug) console.log(msg, ...args);
  }

  private logWarn(msg: string, ...args: unknown[]): void {
    if (this.debug) console.warn(msg, ...args);
  }

  constructor(videoElement: HTMLVideoElement, options: MseMediaSourceOptions = {}) {
    this.video = videoElement;
    this.keepBehindSec = options.keepBehindSec ?? 10;
    this.maxAheadSec = options.maxAheadSec ?? 15;
    this.targetAheadSec = options.targetAheadSec ?? 2;

    // Safari iOS (iPhone) only supports ManagedMediaSource, not MediaSource.
    // iPad and desktop Safari support both. Prefer ManagedMediaSource when
    // available — it has better battery behavior and is the only option on iPhone.
    const MMS = (globalThis as any).ManagedMediaSource as typeof MediaSource | undefined;
    const MS = typeof MediaSource !== 'undefined' ? MediaSource : undefined;
    const MSConstructor = MMS ?? MS;
    if (!MSConstructor) {
      throw new Error('Neither MediaSource nor ManagedMediaSource is available');
    }
    this.ms = new MSConstructor();

    if (MMS) {
      // ManagedMediaSource: attach via srcObject, require disableRemotePlayback
      this.video.disableRemotePlayback = true;
      (this.video as any).srcObject = this.ms;
      this.objectUrl = null;
    } else {
      // Standard MediaSource: attach via object URL
      this.objectUrl = URL.createObjectURL(this.ms);
      this.video.src = this.objectUrl;
    }
    this.video.addEventListener('playing', this.handlePlaying);
    this.video.addEventListener('waiting', this.handleWaiting);
    this.video.addEventListener('timeupdate', this.handleTimeUpdate);
    this.video.addEventListener('error', this.handleVideoError);
  }

  // ─── MediaSourceLike ───────────────────────────────────────────

  get mediaElement(): HTMLVideoElement {
    return this.video;
  }

  /**
   * Create SourceBuffers and append init segments.
   * MUST be called exactly once, before any appendChunk() calls.
   */
  initialize(config: {
    video?: { codec: string; initData: Uint8Array };
    audio?: { codec: string; initData: Uint8Array };
  }): boolean {
    if (this.initialized) return true;

    // Bootstrap validation — ALL-OR-NOTHING, BEFORE latching. A partially
    // initialized MediaSource (one good SourceBuffer, one rejected) would
    // latch this adapter into a state the player believes is complete;
    // instead: validate every entry first, and on any rejection create NO
    // SourceBuffers, stay un-latched (a corrected call may succeed later),
    // surface each reason via onError, and return false.
    //   - Unsupported codec (per MediaSource.isTypeSupported, where the UA
    //     exposes it): named error so the player can escalate to fatal.
    //   - Zero-byte init entry: the caller's contract is "only initialize
    //     with real init bytes" — never a silent init-less SourceBuffer.
    const validateEntry = (
      mediaType: 'video' | 'audio',
      entry: { codec: string; initData: Uint8Array },
    ): Error | null => {
      const mimeType = `${mediaType}/mp4; codecs="${entry.codec}"`;
      const MS = (globalThis as { MediaSource?: { isTypeSupported?: (m: string) => boolean } }).MediaSource;
      if (typeof MS?.isTypeSupported === 'function' && !MS.isTypeSupported(mimeType)) {
        const err = new Error(`Codec not supported by this UA: ${mimeType}`);
        err.name = 'CodecUnsupportedError';
        return err;
      }
      if (entry.initData.byteLength === 0) {
        return new Error(
          `Empty ${mediaType} init data (codec=${entry.codec}) — refusing to create an init-less SourceBuffer`,
        );
      }
      return null;
    };
    const failures: Error[] = [];
    if (config.video) { const e = validateEntry('video', config.video); if (e) failures.push(e); }
    if (config.audio) { const e = validateEntry('audio', config.audio); if (e) failures.push(e); }
    if (failures.length > 0) {
      for (const e of failures) this.onError?.(e);
      return false;
    }
    this.initialized = true;

    const doInit = () => {
      try {
        if (config.video) {
          const mimeType = `video/mp4; codecs="${config.video.codec}"`;
          this.logDebug('[MSE] Creating video SourceBuffer:', mimeType);
          this.videoBuffer = this.ms.addSourceBuffer(mimeType);
          this.videoBuffer.mode = 'segments';
          this.videoBuffer.addEventListener('error', () => {
            const e = this.video.error;
            this.appendErrored.video = true;
            this.pendingVideoRanges = [];
            this.dumpRingOnFailure('video SourceBuffer error');
            this.onError?.(new Error(`Video SourceBuffer error (code=${e?.code}, ${e?.message ?? 'unknown'})`));
          });
          this.videoBuffer.addEventListener('updateend', () => this.handleUpdateEnd('video'));
          if (config.video.initData.byteLength > 0) {
            const videoInit = filterInitSegment(config.video.initData, 'vide');
            const boxes = describeBoxes(videoInit);
            const head = Array.from(videoInit.slice(0, 64))
              .map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
            this.videoInitSummary = `codec=${config.video.codec} bytes=${videoInit.byteLength} boxes=[${boxes}] head=[${head}]`;
            this.logDebug('[MSE] Video init: %s', this.videoInitSummary);
            // Cache trex defaults for the timeline-owned append path.
            // filterInitSegment produces a single-track init, so any
            // trex entry found is our track's.
            const trexMap = readTrexDefaults(videoInit);
            const first = trexMap.values().next();
            if (!first.done) this.videoTrex = first.value;
            this.videoBuffer.appendBuffer(videoInit.buffer as ArrayBuffer);
          }
        }

        if (config.audio) {
          const mimeType = `audio/mp4; codecs="${config.audio.codec}"`;
          this.logDebug('[MSE] Creating audio SourceBuffer:', mimeType);
          this.audioBuffer = this.ms.addSourceBuffer(mimeType);
          this.audioBuffer.mode = 'segments';
          this.audioBuffer.addEventListener('error', () => {
            const e = this.video.error;
            this.appendErrored.audio = true;
            this.pendingAudioRanges = [];
            this.dumpRingOnFailure('audio SourceBuffer error');
            this.onError?.(new Error(`Audio SourceBuffer error (code=${e?.code}, ${e?.message ?? 'unknown'})`));
          });
          this.audioBuffer.addEventListener('updateend', () => this.handleUpdateEnd('audio'));
          if (config.audio.initData.byteLength > 0) {
            const audioInit = filterInitSegment(config.audio.initData, 'soun');
            const boxes = describeBoxes(audioInit);
            const head = Array.from(audioInit.slice(0, 64))
              .map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
            this.audioInitSummary = `codec=${config.audio.codec} bytes=${audioInit.byteLength} boxes=[${boxes}] head=[${head}]`;
            this.logDebug('[MSE] Audio init: %s', this.audioInitSummary);
            const trexMap = readTrexDefaults(audioInit);
            const first = trexMap.values().next();
            if (!first.done) this.audioTrex = first.value;
            this.audioBuffer.appendBuffer(audioInit.buffer as ArrayBuffer);
          }
        }
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    if (this.ms.readyState === 'open') {
      doInit();
    } else {
      this.ms.addEventListener('sourceopen', doInit, { once: true });
    }
    return true;
  }

  /**
   * Append a complete CMAF segment (moof+mdat) to the SourceBuffer.
   *
   * The caller MUST:
   * - Call initialize() first
   * - Concatenate moof+mdat into a single buffer before calling this
   * - Only send data that follows the init segment's codec context
   *
   * MseMediaSource handles only SourceBuffer back-pressure (updateend queue).
   */
  appendChunk(mediaType: 'video' | 'audio', data: Uint8Array, trackName: string, groupId?: bigint): void {
    if (this.destroyed) return;

    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    if (!buffer) {
      return;
    }

    // Stale-group drop: if this group is older than what MSE has
    // already committed, skip it. Prevents late-arriving old-group
    // data from causing blocky artifacts or false discontinuities.
    if (groupId !== undefined) {
      const key = `${mediaType}:${trackName}`;
      const floor = this.committedGroupFloor.get(key);
      if (floor !== undefined && groupId < floor) {
        return;
      }
    }

    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;

    if (this.changingType[mediaType] || buffer.updating || queue.length > 0) {
      queue.push(groupId !== undefined ? { data, trackName, groupId } : { data, trackName });
    } else if (this.maybeEvictBackBuffer(mediaType, buffer)) {
      // An eviction remove() is now in flight (it sets `updating`); park the
      // chunk — its updateend re-enters drainQueue and dispatches it.
      queue.push(groupId !== undefined ? { data, trackName, groupId } : { data, trackName });
    } else {
      this.doAppend(mediaType, buffer, data, trackName, groupId);
    }
  }

  /**
   * Re-initialize a SourceBuffer for a new codec/init segment.
   *
   * Used when the player switches to a track in a different codec
   * family (e.g., AVC → HEVC). The MSE spec lets a SourceBuffer parse
   * a new mime type via `changeType()`, after which the next append
   * MUST be the init segment for that codec.
   *
   * Borrowed from the WebCodecs path: serialize state-mutating ops
   * with data appends. Concretely:
   *   1. Drop any queued media — those are old-codec bytes that would
   *      land *after* the new init and corrupt the splice.
   *   2. Wait for the in-flight `appendBuffer` to settle.
   *   3. `sourceBuffer.changeType(newMime)`.
   *   4. Append the new init segment, await `updateend`.
   *   5. Refresh the trex cache from the new init (per-sample-duration
   *      defaults change with the codec family).
   *   6. Resume normal append flow — anything queued during the change
   *      drains immediately.
   *
   * @param mediaType Which SourceBuffer to retype.
   * @param codec Codec string for the new mime type
   *              (e.g. `"hvc1.1.6.L93.90"`).
   * @param initData Raw init segment bytes (ftyp+moov) for the new codec.
   * @throws If the SourceBuffer is not initialized or the browser
   *         doesn't implement `SourceBuffer.changeType()`.
   *
   * @see https://www.w3.org/TR/media-source-2/#dom-sourcebuffer-changetype
   */
  async changeType(
    mediaType: 'video' | 'audio',
    codec: string,
    initData: Uint8Array,
  ): Promise<void> {
    if (this.destroyed) return;
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    if (!buffer) {
      throw new Error(`MseMediaSource.changeType: ${mediaType} SourceBuffer not initialized`);
    }
    const sb = buffer as SourceBuffer & { changeType?: (mime: string) => void };
    if (typeof sb.changeType !== 'function') {
      throw new Error('MseMediaSource.changeType: SourceBuffer.changeType not supported');
    }
    if (this.changingType[mediaType]) {
      throw new Error(`MseMediaSource.changeType: ${mediaType} already in changing-type state`);
    }

    this.changingType[mediaType] = true;
    try {
      const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;
      // Drop any queued media — old-codec bytes that would be appended
      // *after* the new init segment, ahead of new-codec media. The
      // player has staged the new-track segments separately and will
      // re-deliver them after this resolves.
      queue.length = 0;

      // Wait for any in-flight appendBuffer to settle. Use the buffer's
      // own updateend event — this is the only signal the MSE spec
      // gives us for "now is safe to mutate".
      while (buffer.updating) {
        await this.waitForBufferEvent(buffer);
      }

      // Pivot the parser to the new codec.
      const handler = mediaType === 'video' ? 'vide' : 'soun';
      const filtered = filterInitSegment(initData, handler);
      const mimeType = `${mediaType}/mp4; codecs="${codec}"`;
      this.logDebug('[MSE] changeType %s → %s (init=%dB)', mediaType, mimeType, filtered.byteLength);
      sb.changeType(mimeType);

      // Append the new init segment and wait for it to commit. Done
      // outside doAppend because init segments carry no tfdt/trun and
      // must skip the timeline-overlap path.
      buffer.appendBuffer(filtered.buffer as ArrayBuffer);
      await this.waitForBufferEvent(buffer);

      // Refresh trex defaults — codec family change generally means a
      // different default_sample_duration in the new init.
      const trexMap = readTrexDefaults(filtered);
      const trex = Array.from(trexMap.values())[0];
      if (mediaType === 'video') this.videoTrex = trex;
      else this.audioTrex = trex;

      // Refresh init summary so failure dumps reflect the current codec.
      const boxes = describeBoxes(filtered);
      const summary = `codec=${codec} bytes=${filtered.byteLength} (post-changeType) boxes=[${boxes}]`;
      if (mediaType === 'video') this.videoInitSummary = summary;
      else this.audioInitSummary = summary;

      // Set timestampOffset so the new track's segments (rebased to ~0
      // by the assembler's per-track epoch) land at the current playback
      // position. Only video changes — audio stays on its original offset
      // since the audio track doesn't switch.
      if (!buffer.updating) {
        buffer.timestampOffset = this.video.currentTime;
        this.logDebug('[MSE] changeType timestampOffset set to %.2f', this.video.currentTime);
      }

      // Clear all video timeline entries — the overlap index records raw
      // tfdt values, but timestampOffset has changed. Old entries would
      // cause false overlap drops on the new track's segments.
      const timelines = mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
      timelines.clear();
    } finally {
      this.changingType[mediaType] = false;
    }

    // Resume normal append flow for anything queued during the change.
    this.drainQueue(mediaType);

    // changeType() can pause the video element (browser behavior varies).
    // Re-trigger play to ensure playback resumes after the codec switch.
    if (this.playTriggered && this.video.paused) {
      this.video.play().catch(() => { /* autoplay policy */ });
    }
  }

  /**
   * Wait for the next `updateend` (success) or `error` event on a
   * SourceBuffer. Resolves on either, with `error` rejecting.
   */
  private waitForBufferEvent(buffer: SourceBuffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onEnd = () => {
        buffer.removeEventListener('updateend', onEnd);
        buffer.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = () => {
        buffer.removeEventListener('updateend', onEnd);
        buffer.removeEventListener('error', onErr);
        reject(new Error('SourceBuffer error during changeType'));
      };
      buffer.addEventListener('updateend', onEnd);
      buffer.addEventListener('error', onErr);
    });
  }

  /**
   * Set the timestampOffset on a SourceBuffer.
   * Used by the assembler to rebase CMAF timestamps to zero so that
   * MSE 'segments' mode starts playback immediately.
   */
  setTimestampOffset(mediaType: 'video' | 'audio', offset: number): void {
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    if (!buffer) return;
    try {
      if (!buffer.updating) {
        buffer.timestampOffset = offset;
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  endOfStream(): void {
    if (this.ms.readyState === 'open') {
      try { this.ms.endOfStream(); } catch { /* already ended */ }
    }
  }

  getBufferAheadUs(): number | null {
    const v = this.video;
    if (!v.buffered.length) {
      return this.playTriggered ? 0 : null;
    }

    for (let i = 0; i < v.buffered.length; i++) {
      if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) {
        return Math.max(0, v.buffered.end(i) - v.currentTime) * 1_000_000;
      }
    }

    return this.playTriggered ? 0 : null;
  }

  /**
   * Get the committed group floor for a (mediaType, trackName) pair.
   * Returns undefined if no group has been committed yet.
   */
  getCommittedGroupFloor(mediaType: 'video' | 'audio', trackName: string): bigint | undefined {
    return this.committedGroupFloor.get(`${mediaType}:${trackName}`);
  }

  /**
   * Clear a specific track's timeline index.
   * Called on decode-time discontinuity so old ranges don't cause
   * overlap drops on segments from the new epoch. Scoped to the
   * affected track — other tracks (e.g., during ABR switch) keep
   * their overlap protection intact.
   */
  clearTimeline(mediaType: 'video' | 'audio', trackName: string): void {
    const timelines = mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
    if (timelines.delete(trackName)) {
      this.logWarn('[MSE] timeline cleared for %s track "%s" (discontinuity)', mediaType, trackName);
    }
  }

  reset(): void {
    try {
      if (this.videoBuffer && !this.videoBuffer.updating) {
        this.ms.removeSourceBuffer(this.videoBuffer);
      }
      if (this.audioBuffer && !this.audioBuffer.updating) {
        this.ms.removeSourceBuffer(this.audioBuffer);
      }
    } catch { /* MediaSource may be closed */ }
    this.videoBuffer = null;
    this.audioBuffer = null;
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
    this.initialized = false;
    // Timeline-owned append state.
    this.videoTimelines.clear();
    this.audioTimelines.clear();
    this.committedGroupFloor.clear();
    this.pendingVideoRanges = [];
    this.pendingAudioRanges = [];
    this.pendingVideoTrackName = null;
    this.pendingAudioTrackName = null;
    this.pendingVideoGroupId = undefined;
    this.pendingAudioGroupId = undefined;
    this.appendErrored = { video: false, audio: false };
    this.changingType.video = false;
    this.changingType.audio = false;
    this.videoTrex = undefined;
    this.audioTrex = undefined;
    this.seenDiagnostics.clear();
    this.quotaRetried.video = false;
    this.quotaRetried.audio = false;
    this.chaseAfterFlush = false;
    this.quotaFlushInFlight = false;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.wedgeTimer !== null) {
      clearInterval(this.wedgeTimer);
      this.wedgeTimer = null;
    }
    this.onWedge = null;
    this.video.removeEventListener('playing', this.handlePlaying);
    this.video.removeEventListener('waiting', this.handleWaiting);
    this.video.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.video.removeEventListener('error', this.handleVideoError);
    this.reset();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.video.removeAttribute('src');
    (this.video as any).srcObject = null;
    this.video.load();
    this.onFirstFrame = null;
    this.onError = null;
    this.onStall = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Drain queued chunks after SourceBuffer updateend. */
  private drainQueue(mediaType: 'video' | 'audio'): void {
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;

    // While a changeType is in flight for this media type, leave the
    // queue parked. The changeType handler resumes draining itself
    // once the format-change + init append is committed.
    if (this.changingType[mediaType]) return;

    if (!buffer || buffer.updating || queue.length === 0) {
      // Trigger play after the first relevant media data is buffered.
      // Seek into the LONGEST buffered range, not just buffered.start(0):
      // when we tune into a stream at a CRA-led entry whose leading
      // RASLs we strip, a preceding tiny IDR fragment can leave a stub
      // range like [0, 0.07s] separated from the main content
      // [1.5s, ...]. Seeking to 0 would leave playback marooned in the
      // 2-frame stub. Picking the longest range is also the right
      // choice for normal streams (one big range from t=0 wins) and
      // live tune-ins (the latest gap-free run wins).
      //
      // Gating: when video is present, only the video drain path may
      // trigger this — otherwise an audio updateend (which can fire
      // before the first video append commits) would latch
      // playTriggered against whatever stub video.buffered happens to
      // hold at that instant. For audio-only setups (no video buffer
      // ever created), the audio drain path triggers instead, since
      // no video updateend will ever come.
      const hasVideoTrack = this.videoBuffer !== null;
      const triggerHere = hasVideoTrack
        ? mediaType === 'video'
        : mediaType === 'audio';
      if (
        triggerHere &&
        !this.playTriggered &&
        this.video.buffered.length > 0
      ) {
        let bestStart = this.video.buffered.start(0);
        let bestDuration = this.video.buffered.end(0) - bestStart;
        for (let i = 1; i < this.video.buffered.length; i++) {
          const start = this.video.buffered.start(i);
          const dur = this.video.buffered.end(i) - start;
          if (dur > bestDuration) {
            bestStart = start;
            bestDuration = dur;
          }
        }
        if (this.video.currentTime < bestStart || this.video.currentTime >= bestStart + bestDuration) {
          this.video.currentTime = bestStart;
        }
        // Try unmuted first; if autoplay policy rejects, mute and retry.
        // Set playTriggered only after play succeeds — rejected play must
        // be retried on the next drainQueue cycle.
        this.video.play().then(() => {
          this.playTriggered = true;
          this.startWedgeWatchdog();
        }).catch(() => {
          this.video.muted = true;
          this.video.play().then(() => {
            this.playTriggered = true;
            this.startWedgeWatchdog();
          }).catch(() => { /* truly blocked — user must interact */ });
        });
      }
      return;
    }

    // Skip stale queued entries whose group is below the committed floor
    while (queue.length > 0) {
      const peek = queue[0]!;
      if (peek.groupId !== undefined) {
        const floorKey = `${mediaType}:${peek.trackName}`;
        const floor = this.committedGroupFloor.get(floorKey);
        if (floor !== undefined && peek.groupId < floor) {
          queue.shift();
          continue;
        }
      }
      break;
    }
    if (queue.length === 0) return;

    // Back-buffer hygiene before the next append: if played-out media beyond
    // keepBehindSec exists, evict it first. The remove() sets `updating`; its
    // updateend re-enters this drain and dispatches the queued chunk.
    if (this.maybeEvictBackBuffer(mediaType, buffer)) return;

    const next = queue.shift()!;
    this.doAppend(mediaType, buffer, next.data, next.trackName, next.groupId);
  }

  /**
   * Evict played-out media older than `currentTime - keepBehindSec` from one
   * SourceBuffer, using a FINITE range. Serialized exactly like an append:
   * remove() sets `updating` and fires `updateend`, so callers must not issue
   * another SourceBuffer op until then (both call sites guard on `updating`).
   * Returns true if a remove() was started. Startup is exempt (pre-playTriggered)
   * — initial buffering must not be trimmed.
   */
  private maybeEvictBackBuffer(mediaType: 'video' | 'audio', buffer: SourceBuffer): boolean {
    if (!this.playTriggered) return false;
    const evictBefore = this.video.currentTime - this.keepBehindSec;
    if (evictBefore <= 0) return false;
    let start: number;
    try {
      if (buffer.buffered.length === 0) return false;
      start = buffer.buffered.start(0);
    } catch { return false; /* buffer detached */ }
    // Hysteresis: only evict once at least 1s of stale media has accumulated,
    // so we don't churn a remove() per append.
    if (evictBefore - start < 1) return false;
    try {
      buffer.remove(start, evictBefore);
      this.logDebug('[MSE] evict %s back-buffer [%s, %s)', mediaType, start.toFixed(2), evictBefore.toFixed(2));
      return true;
    } catch (err) {
      this.logWarn('[MSE] back-buffer evict failed (%s): %s', mediaType, (err as Error).message);
      return false;
    }
  }

  // ─── Playhead-wedge watchdog ─────────────────────────────────────

  /** Start the 1s wedge check. Idempotent; cleared in destroy(). */
  private startWedgeWatchdog(): void {
    if (this.wedgeTimer !== null || this.destroyed) return;
    this.wedgeTimer = setInterval(
      () => this.checkPlayheadWedge(performance.now()),
      MseMediaSource.WEDGE_CHECK_INTERVAL_MS,
    );
  }

  /**
   * Detect and recover a wedged playhead: currentTime frozen while
   * readyState ≥ 3 and buffered media sits ahead of the playhead, with no
   * `waiting` event and no error event — a failure class observed in
   * practice (Safari MSE) that the waiting-based stall path is
   * structurally unable to detect.
   *
   * Escalating recovery ladder, one rung per WEDGE_FROZEN_MS of continued
   * freeze:
   *   1. gentle nudge: currentTime += 0.1 (inside the containing range)
   *   2. pause()/play() pulse
   *   3. live-edge seek (rangeEnd − targetAheadSec)
   *   4. onError — the app must rebuild the MediaSource/session
   *
   * A seek WE perform must not read as recovery — wedgeLastTime is
   * re-stamped after each action, so only ORGANIC playhead movement
   * resets the ladder.
   */
  private checkPlayheadWedge(nowMs: number): void {
    if (this.destroyed || !this.playTriggered) return;
    const v = this.video;
    const ct = v.currentTime;

    // Organic movement (or first observation): healthy — reset the ladder.
    if (this.wedgeLastTime === null || ct !== this.wedgeLastTime) {
      this.wedgeLastTime = ct;
      this.wedgeFrozenSinceMs = null;
      this.wedgeRung = 0;
      return;
    }

    // Frozen. Only a wedge if the element CLAIMS it could be playing:
    // not paused, not seeking, decodable data ready, media ahead of the
    // playhead within its containing range. Anything else is a normal
    // pause/buffer/seek state owned by the existing paths.
    let aheadSec = 0;
    try {
      const buffered = v.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (ct >= buffered.start(i) && ct <= buffered.end(i)) {
          aheadSec = buffered.end(i) - ct;
          break;
        }
      }
    } catch { /* detached element */ }
    if (v.paused || v.seeking || (v.readyState ?? 0) < 3 || aheadSec <= 1) {
      this.wedgeFrozenSinceMs = null;
      return;
    }

    if (this.wedgeFrozenSinceMs === null) {
      this.wedgeFrozenSinceMs = nowMs;
      return;
    }
    if (nowMs - this.wedgeFrozenSinceMs < MseMediaSource.WEDGE_FROZEN_MS) return;
    if (this.wedgeRung >= 4) return; // exhausted — error already surfaced

    this.wedgeRung++;
    const rung = this.wedgeRung;

    // Diagnostic snapshot — this is the capture we used to ask humans for.
    const q = (v as { getVideoPlaybackQuality?: () => VideoPlaybackQuality }).getVideoPlaybackQuality?.();
    const ranges: string[] = [];
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) ranges.push(`${b.start(i).toFixed(1)}-${b.end(i).toFixed(1)}`);
    } catch { /* detached */ }
    const info: PlayheadWedgeInfo = {
      rung,
      currentTime: ct,
      readyState: v.readyState,
      paused: v.paused,
      seeking: v.seeking,
      bufferedRanges: ranges.join('|'),
      ...(q ? { decodedFrames: q.totalVideoFrames, droppedFrames: q.droppedVideoFrames } : {}),
    };
    this.logWarn('[MSE] playhead wedged at t=%s (rung %d): %s',
      ct.toFixed(2), rung, JSON.stringify(info));
    this.onWedge?.(info);

    switch (rung) {
      case 1: { // gentle nudge inside the containing range (hls.js-classic)
        const target = Math.min(ct + 0.1, ct + aheadSec - 0.05);
        if (target > ct) v.currentTime = target;
        break;
      }
      case 2: // pause/play pulse
        v.pause();
        void v.play().catch(() => { /* autoplay policy — rung 3 follows */ });
        break;
      case 3: { // live-edge seek within the containing range
        const target = Math.max(ct, ct + aheadSec - this.targetAheadSec);
        if (target > ct) v.currentTime = target;
        break;
      }
      case 4: {
        // Named error so @moqt/player can distinguish "rebuild required"
        // from ordinary (degraded) decode errors and escalate to FATAL.
        const err = new Error(
          `playhead wedge unrecoverable: frozen at t=${ct.toFixed(2)} with `
          + `${aheadSec.toFixed(1)}s buffered ahead (readyState=${v.readyState}) `
          + `after nudge/pulse/seek — MediaSource rebuild required`,
        );
        err.name = 'PlayheadWedgeError';
        this.onError?.(err);
        break;
      }
    }

    // Our own action must not look like recovery on the next check.
    this.wedgeLastTime = v.currentTime;
    this.wedgeFrozenSinceMs = nowMs;
  }

  /**
   * Stamp a seek WE performed (behind-live chase, quota rejoin) so the
   * watchdog doesn't read it as organic playhead movement. Without this,
   * an adapter-initiated seek would reset the recovery ladder mid-episode
   * and the wedge could persist indefinitely behind periodic seeks.
   */
  private noteSelfSeek(): void {
    if (this.wedgeLastTime !== null) this.wedgeLastTime = this.video.currentTime;
  }

  /**
   * Behind-live cap: when playback has fallen more than `maxAheadSec` behind the
   * buffered data it is inside of (a perpetually-behind live subscriber being
   * burst-fed by the relay), jump to `rangeEnd - targetAheadSec`. Only acts after
   * startup (playTriggered) and only within the range CONTAINING currentTime —
   * never across gaps.
   */
  private maybeChaseLiveEdge(): void {
    if (!this.playTriggered) return;
    const v = this.video;
    // Never seek a paused element. The UA may pause playback autonomously
    // (e.g. power saving for muted, non-visible video), and seeking a
    // paused playhead provides no playback benefit — it only forces decode
    // work and frame repaints. The chase catches up on the first commit
    // after playback resumes.
    if (v.paused) return;
    const ct = v.currentTime;
    let buffered: TimeRanges;
    try { buffered = v.buffered; } catch { return; }
    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (ct < start || ct > end) continue;
      const ahead = end - ct;
      if (ahead > this.maxAheadSec) {
        const target = Math.max(start, end - this.targetAheadSec);
        if (target > ct) {
          this.logWarn('[MSE] behind live by %ss — jumping %s -> %s', ahead.toFixed(1), ct.toFixed(2), target.toFixed(2));
          v.currentTime = target;
          this.noteSelfSeek();
          this.onLiveEdgeResync?.('behind-live');
        }
      }
      return; // containing range handled (or within cap) — done either way
    }
  }

  /**
   * Append a segment to a SourceBuffer with diagnostic recording and
   * timeline-owned overlap protection.
   *
   * Pipeline:
   *   1. Parse the payload's time ranges (tri-state: null / [] / ranges).
   *   2. If null — unscorable moof in the payload — drop with a warn.
   *   3. If [] — no moofs, fail open.
   *   4. If ranges — check against the timeline; drop on overlap.
   *   5. Record a ring entry; mark pending; call appendBuffer.
   *   6. On `updateend` without a preceding error, commit pending.
   *
   * Any thrown error (synchronous path) or SourceBuffer/video-element
   * error (async paths) clears the pending range so nothing unverified
   * ends up in the timeline.
   */
  private doAppend(
    mediaType: 'video' | 'audio',
    buffer: SourceBuffer,
    data: Uint8Array,
    trackName: string,
    groupId?: bigint,
  ): void {
    // ── Step 1: parse + tri-state decide ─────────────────────────
    const trex = mediaType === 'video' ? this.videoTrex : this.audioTrex;
    const ranges = readSegmentTimeRanges(data, trex, (kind, detail) => {
      const key = `${mediaType}:${kind}`;
      if (this.seenDiagnostics.has(key)) return;
      this.seenDiagnostics.add(key);
      this.logWarn(`[MSE] ${mediaType} parse skipped (${kind}): ${detail}`);
    });

    if (ranges === null) {
      // Saw moofs but couldn't score all of them — fail open.
      // Dropping unscored segments causes silent video freeze on
      // publishers with non-standard box layouts (prft inside moof,
      // multi-traf, etc.). MSE itself will reject truly corrupt data.
      this.logWarn(
        `[MSE] ${mediaType} payload analysis incomplete — appending anyway (fail open)`,
      );
    }

    // ranges is an array (possibly empty) or null (fail-open).
    const timelines = mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
    const timeline = timelines.get(trackName);
    if (ranges !== null && ranges.length > 0 && timeline) {
      const overlap = ranges.find((r) => timeline.overlaps(r.startTime, r.endTime));
      if (overlap !== undefined) {
        this.logWarn(
          `[MSE] drop overlapping ${mediaType} payload on track "${trackName}": ranges=${ranges
            .map((r) => `[${r.startTime}-${r.endTime})`)
            .join(',')} timeline=${timeline.toString()}`,
        );
        return;
      }
    }

    // ── Step 2: record diagnostic ring entry ─────────────────────
    this.recordAppend(mediaType, data);

    // Retain the existing debug-print for the first few appends.
    if (!this.playTriggered) {
      const hex = Array.from(data.slice(0, 24))
        .map((b: number) => b.toString(16).padStart(2, '0'))
        .join(' ');
      this.logDebug('[MSE] appendBuffer %s: %dB head=[%s]', mediaType, data.byteLength, hex);
    }

    // ── Step 3: mark pending + call appendBuffer ─────────────────
    this.appendErrored[mediaType] = false;
    const safeRanges = ranges ?? [];
    if (mediaType === 'video') {
      this.pendingVideoRanges = safeRanges;
      this.pendingVideoTrackName = trackName;
      this.pendingVideoGroupId = groupId;
    } else {
      this.pendingAudioRanges = safeRanges;
      this.pendingAudioTrackName = trackName;
      this.pendingAudioGroupId = groupId;
    }

    try {
      buffer.appendBuffer(data.buffer as ArrayBuffer);
    } catch (err) {
      // Synchronous throw — the append never happened. Clear pending
      // so updateend (which may or may not fire) doesn't commit it.
      if (mediaType === 'video') {
        this.pendingVideoRanges = [];
        this.pendingVideoTrackName = null;
      } else {
        this.pendingAudioRanges = [];
        this.pendingAudioTrackName = null;
      }
      // QuotaExceededError is RECOVERABLE (evict + retry, escalating to
      // flush-and-rejoin) — handle it without surfacing an error event.
      if ((err as Error)?.name === 'QuotaExceededError') {
        this.handleQuotaExceeded(mediaType, buffer, data, trackName, groupId);
        return;
      }
      this.dumpRingOnFailure(`appendBuffer throw on ${mediaType}`, err);
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * QuotaExceededError recovery. Two stages, taxonomy-quiet while handled:
   *
   *   1. EVICT + RETRY (once per incident): if played-out media exists behind
   *      currentTime, remove it (finite range, 1s margin) and re-queue the failed
   *      chunk at the FRONT — its updateend retries the append with space freed.
   *   2. FLUSH + REJOIN LIVE: nothing evictable (the report's case: the entire
   *      buffered range is AHEAD of a stalled/behind currentTime — the UA cannot
   *      free space either). Drop the stale queued backlog AND this chunk, remove
   *      each buffer's full FINITE buffered span, clear the timeline indexes, and
   *      let the next committed append pull playback to its (live-edge) position.
   *
   * Only if stage 2 itself cannot run (or quota recurs mid-flush) does onError
   * fire — once.
   *
   * Keyframe caveat: MSE-only recovery resumes at the next appended chunk; clean
   * decode from it requires the publisher to keyframe-lead chunks/groups (true
   * for CMSF-style publishers and our fixtures). `onLiveEdgeResync('quota')` is an
   * informational concrete-class hook (NOT player-wired yet) an app could use to
   * request fresh keyframe-led media when that doesn't hold.
   */
  private handleQuotaExceeded(
    mediaType: 'video' | 'audio',
    buffer: SourceBuffer,
    data: Uint8Array,
    trackName: string,
    groupId?: bigint,
  ): void {
    const ct = this.video.currentTime;

    // ── Stage 1: evict played-out media and retry this chunk once ──────────
    if (!this.quotaRetried[mediaType]) {
      let start: number | null = null;
      try {
        if (buffer.buffered.length > 0) start = buffer.buffered.start(0);
      } catch { /* detached */ }
      const evictBefore = ct - 1; // keep a 1s margin behind the playhead
      if (start !== null && evictBefore > start) {
        this.quotaRetried[mediaType] = true;
        const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;
        queue.unshift(groupId !== undefined ? { data, trackName, groupId } : { data, trackName });
        try {
          this.logWarn('[MSE] quota exceeded (%s) — evicting [%s, %s) and retrying', mediaType, start.toFixed(2), evictBefore.toFixed(2));
          buffer.remove(start, evictBefore); // updateend → drainQueue → retry
          return;
        } catch { /* fall through to flush */ }
      }
    }

    // ── Stage 2: flush both buffers and rejoin at the next appended media ──
    if (this.quotaFlushInFlight) {
      // Flush already in progress and quota STILL exceeded — genuine failure.
      this.dumpRingOnFailure(`appendBuffer quota on ${mediaType} during flush`, new Error('QuotaExceededError'));
      this.onError?.(new Error('MSE quota exceeded and flush recovery failed'));
      return;
    }
    this.quotaFlushInFlight = true;
    this.logWarn('[MSE] quota exceeded (%s) with nothing evictable — flushing buffers and rejoining live', mediaType);
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
    this.videoTimelines.clear();
    this.audioTimelines.clear();
    this.quotaRetried.video = false;
    this.quotaRetried.audio = false;
    this.chaseAfterFlush = true;
    for (const [b, label] of [[this.videoBuffer, 'video'], [this.audioBuffer, 'audio']] as const) {
      if (!b) continue;
      try {
        if (b.updating || b.buffered.length === 0) continue;
        // FINITE range: first buffered start → last buffered end.
        b.remove(b.buffered.start(0), b.buffered.end(b.buffered.length - 1));
      } catch (err) {
        this.logWarn('[MSE] flush remove failed (%s): %s', label, (err as Error).message);
      }
    }
  }

  /**
   * SourceBuffer `updateend` — commits the pending range if no error
   * fired for this append, then drains the next queued append.
   */
  private handleUpdateEnd(mediaType: 'video' | 'audio'): void {
    if (!this.appendErrored[mediaType]) {
      const pending =
        mediaType === 'video' ? this.pendingVideoRanges : this.pendingAudioRanges;
      const pendingTrack =
        mediaType === 'video' ? this.pendingVideoTrackName : this.pendingAudioTrackName;
      const pendingGroup =
        mediaType === 'video' ? this.pendingVideoGroupId : this.pendingAudioGroupId;
      const timelines =
        mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
      if (pendingTrack !== null) {
        let timeline = timelines.get(pendingTrack);
        if (!timeline) {
          timeline = new TimelineIndex();
          timelines.set(pendingTrack, timeline);
        }
        for (const r of pending) {
          timeline.insert(r.startTime, r.endTime);
        }
        // Advance committed group floor on successful append.
        if (pendingGroup !== undefined) {
          const floorKey = `${mediaType}:${pendingTrack}`;
          const existing = this.committedGroupFloor.get(floorKey);
          if (existing === undefined || pendingGroup > existing) {
            this.committedGroupFloor.set(floorKey, pendingGroup);
          }
        }
        // A successful commit clears the per-incident quota retry budget.
        this.quotaRetried[mediaType] = false;
        // Post-quota-flush rejoin: pull playback to the newly committed media.
        // The flush emptied the buffers, so the LAST buffered range of the
        // element is the fresh (live-edge) data — jump to its start (seconds;
        // SegmentTimeRange tick values are timescale units, not usable here).
        if (this.chaseAfterFlush) {
          let buffered: TimeRanges | null = null;
          try { buffered = this.video.buffered; } catch { /* detached */ }
          if (buffered && buffered.length > 0) {
            this.chaseAfterFlush = false;
            this.quotaFlushInFlight = false;
            const target = buffered.start(buffered.length - 1);
            this.logWarn('[MSE] quota flush recovery: rejoining playback at %ss', target.toFixed(2));
            this.video.currentTime = target;
            this.noteSelfSeek();
            this.onLiveEdgeResync?.('quota');
          }
        }
      }
    }
    if (mediaType === 'video') {
      this.pendingVideoRanges = [];
      this.pendingVideoTrackName = null;
      this.pendingVideoGroupId = undefined;
    } else {
      this.pendingAudioRanges = [];
      this.pendingAudioTrackName = null;
      this.pendingAudioGroupId = undefined;
    }
    this.appendErrored[mediaType] = false;
    // Behind-live cap: act on fresh data arrival (post-startup only).
    this.maybeChaseLiveEdge();
    this.drainQueue(mediaType);
  }

  /**
   * Push one AppendRecord onto the ring for the given media type.
   * Also updates the "last append wall time" so subsequent records carry
   * a meaningful deltaFromPrevMs.
   */
  private recordAppend(mediaType: 'video' | 'audio', data: Uint8Array): void {
    const ring = mediaType === 'video' ? this.videoRing : this.audioRing;
    const appendWallMs = performance.now();
    const prevWallMs = this.lastAppendWallMs[mediaType];
    const meta = peekSegmentMetadata(data);
    const { nalTypes, mdatHead } = scanMdatNals(data);

    const record: AppendRecord = {
      mediaType,
      seq: this.appendSeq++,
      totalSize: data.byteLength,
      bmd: meta?.bmd ?? null,
      mdatSize: meta?.mdatSize ?? null,
      nalTypes,
      mdatHead,
      appendWallMs,
      deltaFromPrevMs: prevWallMs === null ? null : appendWallMs - prevWallMs,
    };

    ring.push(record);
    while (ring.length > RING_CAPACITY) ring.shift();
    this.lastAppendWallMs[mediaType] = appendWallMs;
  }

  /**
   * Dump the ring buffer + video.error (if any) to console. Called on
   * any path that signals the pipe has died: video-element 'error' event,
   * SourceBuffer 'error' event, or a thrown error from appendBuffer.
   *
   * Guarded by videoErrorDumped so the flood of downstream failures after
   * the root-cause frame don't spam the console.
   */
  private dumpRingOnFailure(source: string, err?: unknown): void {
    if (this.videoErrorDumped) return;
    this.videoErrorDumped = true;
    if (!this.debug) return;

    const videoErr = this.video.error;
    console.error('[MSE] pipeline failure — source: %s', source);
    if (err) {
      console.error('[MSE]   thrown:', err);
    }
    if (videoErr) {
      console.error(
        '[MSE]   video.error: code=%d message=%s',
        videoErr.code,
        videoErr.message,
      );
    }
    if (this.videoInitSummary) {
      console.error(`[MSE]   video init: ${this.videoInitSummary}`);
    }
    if (this.audioInitSummary) {
      console.error(`[MSE]   audio init: ${this.audioInitSummary}`);
    }
    const fmtTimelines = (m: Map<string, TimelineIndex>): string =>
      m.size === 0
        ? 'empty'
        : Array.from(m.entries())
            .map(([t, idx]) => `"${t}": ${idx.toString()}`)
            .join('; ');
    console.error(`[MSE]   video timelines: ${fmtTimelines(this.videoTimelines)}`);
    console.error(`[MSE]   audio timelines: ${fmtTimelines(this.audioTimelines)}`);
    console.error(`[MSE]   last ${RING_CAPACITY} appends (oldest → newest):`);
    // Template literals — Chrome's console.* doesn't honor %.1f / %.2fs
    // precision specifiers, so the previous %-format lines printed
    // "wall=%.1f" literally. See
    // https://developer.mozilla.org/en-US/docs/Web/API/console#using_string_substitutions
    for (const r of [...this.videoRing, ...this.audioRing].sort((a, b) => a.seq - b.seq)) {
      const delta = r.deltaFromPrevMs === null ? 'n/a' : `${r.deltaFromPrevMs.toFixed(1)}ms`;
      const bmd = r.bmd === null ? 'n/a' : r.bmd.toString();
      console.error(
        `[MSE]     #${r.seq} ${r.mediaType}: total=${r.totalSize}B mdat=${r.mdatSize ?? 'n/a'} bmd=${bmd} Δ=${delta} wall=${r.appendWallMs.toFixed(1)} nal=[${r.nalTypes.join(',')}]`,
      );
      if (r.mdatHead) {
        console.error(`[MSE]       mdat head: ${r.mdatHead}`);
      }
    }
    // Also log current buffered ranges — "how much did MSE accept before
    // failing?" is often useful context.
    try {
      if (this.videoBuffer) {
        for (let i = 0; i < this.videoBuffer.buffered.length; i++) {
          const start = this.videoBuffer.buffered.start(i);
          const end = this.videoBuffer.buffered.end(i);
          console.error(
            `[MSE]   video.buffered[${i}]: ${start} → ${end} (${(end - start).toFixed(2)}s)`,
          );
        }
      }
      console.error(`[MSE]   video.currentTime: ${this.video.currentTime}`);
    } catch {
      /* buffered may throw if SourceBuffer was removed */
    }
  }

  // ─── Event handlers ────────────────────────────────────────────

  private handlePlaying = (): void => {
    if (this.stallStartTime !== null) this.stallStartTime = null;
    if (!this.firstFrameFired) {
      this.firstFrameFired = true;
      this.onFirstFrame?.();
    }
  };

  private handleWaiting = (): void => {
    this.stallStartTime = performance.now();
  };

  private handleTimeUpdate = (): void => {
    if (!this.firstFrameFired && this.video.currentTime > 0) {
      this.firstFrameFired = true;
      this.onFirstFrame?.();
    }
    if (this.stallStartTime !== null) {
      const durationMs = performance.now() - this.stallStartTime;
      this.stallStartTime = null;
      this.onStall?.(durationMs);
    }
  };

  /**
   * The `<video>` element's own error event — fires when the media
   * pipeline (browser's decoder / renderer) enters MEDIA_ERR_* state.
   * After this, every appendBuffer call fails with
   * "HTMLMediaElement.error attribute is not null" — the actual cause is
   * video.error.code/message, which we capture here BEFORE the cascade
   * of downstream failures buries it.
   */
  private handleVideoError = (): void => {
    // A video-element error kills the whole media pipeline — both
    // tracks. Mark both errored and clear pending ranges so no phantom
    // coverage is committed by a trailing updateend.
    this.appendErrored.video = true;
    this.appendErrored.audio = true;
    this.pendingVideoRanges = [];
    this.pendingAudioRanges = [];
    this.dumpRingOnFailure('<video> element error');
    const e = this.video.error;
    this.onError?.(
      new Error(
        `HTMLMediaElement error (code=${e?.code ?? 'unknown'}, ${e?.message ?? 'no message'})`,
      ),
    );
  };
}
