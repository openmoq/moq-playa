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
  /**
   * Which MediaSource implementation to construct.
   *
   * - `auto` (default): prefer `ManagedMediaSource` when the browser exposes
   *   it, else standard `MediaSource`. MMS has better power behavior and is the
   *   only implementation iPhone-class Safari ships.
   * - `managed`: explicitly prefer `ManagedMediaSource` (same selection as
   *   `auto`; states the intent rather than relying on the default).
   * - `standard`: prefer standard `MediaSource`.
   *
   * The explicit preferences exist for investigation. A desktop-Safari A/V
   * synchronization problem was initially thought to be specific to
   * ManagedMediaSource, but a later run reproduced it under standard
   * MediaSource too, so NOTHING here should be read as one implementation
   * avoiding it.
   *
   * Selection is capability-based — there is NO user-agent sniffing. Every
   * preference FALLS BACK to the other implementation when the requested one is
   * absent (iPhone Safari ships ManagedMediaSource only; most non-Safari
   * browsers ship standard MediaSource only), so a preference can never make an
   * otherwise-playable device unplayable. Construction still throws when
   * NEITHER exists, exactly as before.
   */
  readonly mseImplementation?: MseImplementationPreference;
  /**
   * How to attach the MediaSource to the element.
   *
   * - `auto` (default): preserves the historical pairing — standard uses an
   *   object URL, managed uses `srcObject`.
   * - `object-url` / `src-object`: force that mode for EITHER implementation.
   *
   * This exists because implementation and attachment were previously coupled,
   * so a standard-vs-managed comparison silently varied both. Separating them
   * makes it possible to tell a ManagedMediaSource problem apart from an
   * attachment-path problem. An explicit mode is used exactly as requested or
   * THROWS — a silent fallback would reintroduce the confound it removes.
   */
  readonly mseAttachment?: MseAttachmentPreference;
}

/** Which MediaSource implementation was actually constructed. */
export type MseImplementation = 'managed' | 'standard';

/** Requested MediaSource implementation. @see MseMediaSourceOptions.mseImplementation */
export type MseImplementationPreference = 'auto' | 'managed' | 'standard';

/** Requested attachment mode. @see MseMediaSourceOptions.mseAttachment */
export type MseAttachmentPreference = 'auto' | 'object-url' | 'src-object';

/** How the MediaSource was actually attached to the element. */
export type MseAttachment = 'object-url' | 'src-object';

/**
 * Startup lifecycle phase. Positioning is asynchronous, so startup is modelled
 * explicitly instead of being implied by `playTriggered`.
 */
type StartupPhase = 'idle' | 'positioning' | 'play-pending' | 'started';

/**
 * How far `currentTime` may sit from the requested start position and still
 * count as positioned there.
 *
 * We always seek to the START of a buffered range, which is already a random
 * access point, so no keyframe snapping is expected — the residual is the
 * element rounding to the nearest sample. One frame is ~42ms at 24fps and an
 * audio frame ~21ms at 48kHz, so 100ms covers roughly two frames of rounding
 * while still rejecting a seek that landed somewhere genuinely different. (The
 * previous 0.5s was far looser than the rounding it claimed to absorb: it would
 * have accepted a landing point up to a dozen frames away.)
 */
const STARTUP_SEEK_TOLERANCE_SEC = 0.1;

/**
 * Bounded wait for a startup seek to settle. Not configurable: no consumer
 * needs to tune it, and an unvalidated public knob accepting NaN/negative/
 * Infinity would be a worse contract than a considered constant.
 */
const STARTUP_SEEK_TIMEOUT_MS = 2000;

/**
 * How an awaited positioning operation ended. `timeout-accepted` is a timeout
 * whose postcondition nevertheless held (not seeking, landed at target) — it
 * releases startup like a settlement, but is reported distinctly because the
 * `seeked` event never arrived.
 */
type PositionOutcome = 'settled' | 'timeout-accepted' | 'cancelled';

/**
 * Outcomes under which startup SUCCEEDED — positioning completed and play()
 * started. Exactly one of these accompanies an emitted startup report.
 */
export type MseStartupSuccess = 'no-seek-needed' | 'seek-settled' | 'seek-timeout-accepted';

/**
 * Outcomes under which startup did NOT start playback but WILL be retried by a
 * later drain or a renewed play intent. These are recorded in `startupReport`
 * for inspection but are deliberately NOT emitted: a once-only report carrying
 * a retriable failure would be permanently misleading once a later attempt
 * succeeds.
 */
export type MseStartupRetriable = 'cancelled' | 'autoplay-blocked' | 'seek-timeout-unsettled';

/** How the startup transaction's positioning phase ended. */
export type MseSeekOutcome = MseStartupSuccess | MseStartupRetriable;

/** Session-scoped, mutable form of the facts an `MseStartupReport` exposes. */
interface MutableStartupFacts {
  session: number;
  startPosition: number | null;
  seekOutcome: MseSeekOutcome | null;
  playTimeSec: number | null;
}

/** Adapter-side startup facts for the joined diagnostic summary. */
export interface MseStartupReport {
  readonly implementation: MseImplementation;
  readonly attachment: MseAttachment;
  readonly disableRemotePlayback: boolean;
  /** Session generation these facts belong to (bumped by reset/destroy). */
  readonly session: number;
  readonly startPosition: number | null;
  readonly seekOutcome: MseSeekOutcome | null;
  readonly playTimeSec: number | null;
}

/** What app-initiated operation mutated a SourceBuffer. */
type BufferOpCause = 'append' | 'init-append' | 'back-buffer-remove' | 'quota-remove' | 'quota-flush';

/** Render a TimeRanges as "a-b,c-d" for diagnostics; never throws. */
function fmtRanges(ranges: TimeRanges | undefined | null): string {
  if (!ranges) return 'n/a';
  try {
    if (ranges.length === 0) return '';
    return Array.from({ length: ranges.length },
      (_, i) => `${ranges.start(i).toFixed(2)}-${ranges.end(i).toFixed(2)}`).join(',');
  } catch {
    return 'unreadable';
  }
}

/** `buffer.buffered` without letting a transient accessor failure throw. */
function safeBuffered(buffer: SourceBuffer): TimeRanges | null {
  try {
    return buffer.buffered;
  } catch {
    return null;
  }
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
   * Which MediaSource implementation was constructed, and which was asked for.
   * Readable without debug logging so a harness can assert the selection.
   */
  readonly selectedImplementation: MseImplementation;
  readonly implementationRequested: MseImplementationPreference;
  /** Attachment actually used, and the mode asked for. */
  readonly selectedAttachment: MseAttachment;
  readonly attachmentRequested: MseAttachmentPreference;

  /**
   * Whether the player has declared playback intent.
   *
   * Media arriving is NOT a request to play: without this gate the adapter is a
   * second owner of startup and can begin playing while the player is still
   * LOADING or has been paused. Buffering is unaffected — only the startup
   * positioning/play transaction waits. Defaults to true so an embedder that
   * never calls setPlaybackIntent keeps the previous behavior.
   */
  private playbackIntent = true;

  /**
   * Declare (or withdraw) playback intent. Withdrawing cancels an in-flight
   * startup so a late seek/play cannot begin playback afterwards.
   */
  setPlaybackIntent(intent: boolean): void {
    if (this.playbackIntent === intent) return;
    this.playbackIntent = intent;
    this.diag('playback-intent %s', String(intent));
    if (!intent) {
      // Cancel a startup in flight AND stop playback that already started —
      // withdrawing intent is a pause, not merely "don't start".
      this.cancelStartup();
      if (this.playTriggered && this.video.paused === false) this.video.pause();
      return;
    }
    if (this.destroyed) return;
    // Already started: this is a resume, not a new startup transaction.
    if (this.playTriggered) {
      this.resumeElement();
      return;
    }
    // Intent arrived after media: start now if a common range already exists.
    void this.requestStartup().catch(() => { /* contained */ });
  }

  /**
   * Resume playback after an external stall/pause, through the adapter's own
   * startup lifecycle. Embedders must call this rather than `video.play()`
   * directly: a second play owner can race the startup transaction and play
   * into an unresolved seek. No-op without playback intent.
   */
  resumePlayback(): void {
    if (this.destroyed || !this.playbackIntent) return;
    if (!this.playTriggered) {
      void this.requestStartup().catch(() => { /* contained */ });
      return;
    }
    this.resumeElement();
  }

  /**
   * Resume an element that has already completed startup, under the same
   * generation guard as startup itself — so a pause/destroy racing the pending
   * play promise cannot leave it playing.
   */
  private resumeElement(): void {
    if (!this.video.paused) return;
    const generation = this.startupGeneration;
    void this.playElement(generation).catch(() => { /* autoplay policy */ });
  }

  /**
   * Startup facts for the joined diagnostic summary. Session-scoped: cleared on
   * reset()/destroy() so a later session can never report stale facts, and
   * stamped with `session` so a consumer can refuse to join across sessions.
   */
  private startupFacts: MutableStartupFacts =
    { session: 0, startPosition: null, seekOutcome: null, playTimeSec: null };

  /**
   * Fired ONCE per session when startup has SUCCEEDED: positioning completed
   * and play() started, so `startPosition`, `seekOutcome` and `playTimeSec` are
   * all final. Retriable non-starts (see `MseStartupRetriable`) do not fire —
   * they remain visible on `startupReport` and a later successful attempt fires
   * this instead.
   */
  onStartupReport: ((report: MseStartupReport) => void) | null = null;
  private startupReported = false;

  /** Current startup facts (diagnostics only; may be incomplete before terminal). */
  get startupReport(): MseStartupReport {
    return {
      implementation: this.selectedImplementation,
      attachment: this.selectedAttachment,
      disableRemotePlayback: (this.video as { disableRemotePlayback?: boolean }).disableRemotePlayback === true,
      ...this.startupFacts,
    };
  }

  /**
   * Write startup facts into the session they were gathered for.
   *
   * A cancelled startup's continuation resumes LATER — possibly after reset()
   * has installed a fresh facts object for a new session. Taking the target as
   * a parameter, captured when the attempt began, keeps its outcome where it
   * belongs: a cancellation that stays within the session (an intent
   * withdrawal) is still recorded, while one that crosses a reset is DISCARDED
   * by the identity check rather than contaminating the new session.
   */
  private recordStartupFact(
    facts: MutableStartupFacts,
    patch: Partial<Omit<MseStartupReport, 'implementation' | 'attachment' | 'disableRemotePlayback' | 'session'>>,
  ): void {
    if (facts !== this.startupFacts) return;
    Object.assign(facts, patch);
  }

  /** Emit the successful startup report exactly once per session. */
  private reportStartupSucceeded(outcome: MseStartupSuccess): void {
    this.startupFacts.seekOutcome = outcome;
    if (this.startupReported) return;
    this.startupReported = true;
    const cb = this.onStartupReport;
    if (!cb) return;
    // A diagnostic consumer must never break playback.
    try { cb(this.startupReport); } catch { /* contained */ }
  }

  /**
   * Startup lifecycle. Positioning the playhead is ASYNCHRONOUS — assigning
   * `currentTime` starts a seek that completes later — so startup is an owned,
   * cancellable transaction rather than a fire-and-forget pair of statements:
   *
   *   idle → positioning → play-pending → started
   *
   * `drainQueue` only decides ELIGIBILITY and requests startup; at most one
   * attempt is ever in flight, however many `updateend` events land while a
   * seek is outstanding. A rejected autoplay returns the phase to `idle` so a
   * later drain retries, exactly as before.
   */
  private startupPhase: StartupPhase = 'idle';

  /**
   * Bumped by reset()/destroy() to cancel an in-flight startup. A late `seeked`
   * or a resolved play() from a superseded generation must never start playback.
   */
  private startupGeneration = 0;

  /** Removes the in-flight positioning listener + timer, whatever the outcome. */
  private startupCleanup: (() => void) | null = null;

  /** Settles the in-flight positioning promise (cancellation path). */
  private startupSettle: ((outcome: PositionOutcome) => void) | null = null;

  /** How many startup appends per media type carry a debug range log. */
  private static readonly STARTUP_DIAG_COUNT = 5;
  private diagVideoAppends = 0;
  private diagAudioAppends = 0;

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

  /**
   * Diagnostic CHRONOLOGY state — deliberately not ownership.
   *
   * MSE queues `bufferedchange` and `updateend` independently, with no
   * guaranteed relative order (§buffer-append), so deciding which operation
   * caused a buffered change would encode the very ordering assumption the log
   * exists to test. Records are emitted append-only with a monotonic sequence
   * number; `inflight`/`lastDone` appear as chronological context only.
   */
  private diagSeq = 0;
  private opSeq = 0;
  /** Generation of the current SourceBuffer set; bumped on reset/destroy. */
  private bufferGen = 0;
  /** In-flight op per media type — a SourceBuffer serializes to at most one. */
  private readonly inFlightOp: {
    video: { id: number; cause: BufferOpCause; errored?: boolean } | null;
    audio: { id: number; cause: BufferOpCause; errored?: boolean } | null;
  } = { video: null, audio: null };
  /** Most recently completed op id per media type, for after-the-fact context. */
  private readonly lastCompletedOp: { video: number | null; audio: number | null } =
    { video: null, audio: null };

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

    // Capability-based selection, no user-agent sniffing. Safari iOS (iPhone)
    // exposes only ManagedMediaSource; iPad and desktop Safari expose both;
    // other browsers typically expose only standard MediaSource.
    //
    // Default (`auto`) prefers ManagedMediaSource where available: better power
    // behavior, and the only implementation iPhone-class Safari ships. The
    // explicit `standard` / `managed` preferences exist for investigation —
    // notably to separate the implementation from the attachment path below.
    const MMS = (globalThis as any).ManagedMediaSource as typeof MediaSource | undefined;
    const MS = typeof MediaSource !== 'undefined' ? MediaSource : undefined;
    const preferStandard = options.mseImplementation === 'standard';
    const MSConstructor = preferStandard ? (MS ?? MMS) : (MMS ?? MS);
    if (!MSConstructor) {
      throw new Error('Neither MediaSource nor ManagedMediaSource is available');
    }
    // Managed only when the chosen constructor IS the ManagedMediaSource one.
    const usingManaged = MMS !== undefined && MSConstructor === MMS;
    this.selectedImplementation = usingManaged ? 'managed' : 'standard';
    this.implementationRequested = options.mseImplementation ?? 'auto';
    this.ms = new MSConstructor();

    // Attachment is INDEPENDENT of the implementation. `auto` keeps the
    // historical pairing (standard → object URL, managed → srcObject); an
    // explicit mode is honored for either implementation, or throws.
    this.attachmentRequested = options.mseAttachment ?? 'auto';
    const attachment: MseAttachment = this.attachmentRequested === 'auto'
      ? (usingManaged ? 'src-object' : 'object-url')
      : this.attachmentRequested;
    this.selectedAttachment = attachment;

    // ManagedMediaSource requires remote playback to be disabled (Safari 17.1
    // exposes MMS only with an AirPlay alternative or remote playback disabled),
    // so this holds for BOTH managed attachment modes.
    if (usingManaged) this.video.disableRemotePlayback = true;

    if (attachment === 'src-object') {
      if (!('srcObject' in this.video)) {
        // Never silently fall back: a fallback would make the experiment this
        // option exists for report a mode it did not actually use.
        throw new Error('mseAttachment "src-object" requested but HTMLMediaElement.srcObject is unavailable');
      }
      (this.video as any).srcObject = this.ms;
      this.objectUrl = null;
    } else {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error('mseAttachment "object-url" requested but URL.createObjectURL is unavailable');
      }
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

    // Logged here rather than in the constructor: `debug` is assigned by the
    // caller after construction, so a constructor-time log would never print.
    this.logDebug(
      '[MSE] config: implementation=%s (requested %s) attachment=%s (requested %s) disableRemotePlayback=%s',
      this.selectedImplementation, this.implementationRequested,
      this.selectedAttachment, this.attachmentRequested,
      String((this.video as { disableRemotePlayback?: boolean }).disableRemotePlayback === true));

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
          this.wireBufferLifecycle('video', this.videoBuffer);
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
            const vb = this.videoBuffer;
            this.runMutation('video', 'init-append', () => vb.appendBuffer(videoInit.buffer as ArrayBuffer));
          }
        }

        if (config.audio) {
          const mimeType = `audio/mp4; codecs="${config.audio.codec}"`;
          this.logDebug('[MSE] Creating audio SourceBuffer:', mimeType);
          this.audioBuffer = this.ms.addSourceBuffer(mimeType);
          this.audioBuffer.mode = 'segments';
          this.wireBufferLifecycle('audio', this.audioBuffer);
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
            const ab = this.audioBuffer;
            this.runMutation('audio', 'init-append', () => ab.appendBuffer(audioInit.buffer as ArrayBuffer));
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
      this.runMutation(mediaType, 'init-append', () => buffer.appendBuffer(filtered.buffer as ArrayBuffer));
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
    // Re-trigger play through the owned lifecycle so a late codec switch cannot
    // restart a player that has been paused (intent withdrawn) or destroyed.
    this.resumePlayback();
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
      // Recorded because endOfStream() mutates the buffered state and can
      // itself produce a `bufferedchange`.
      this.diag('endOfStream');
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
    // Cancel any in-flight startup FIRST: a late seeked/play from the
    // superseded generation must not resurrect playback against new buffers.
    this.cancelStartup();
    this.diag('reset (buffer generation %d → %d)', this.bufferGen, this.bufferGen + 1);
    this.bufferGen++;
    // New session: stale facts must never join a later summary.
    this.startupFacts = { session: this.bufferGen, startPosition: null, seekOutcome: null, playTimeSec: null };
    this.startupReported = false;
    this.cancelBufferOps('reset');
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
    this.diag('destroy');
    this.destroyed = true;
    this.cancelStartup();
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
      // Eligibility only — the startup transaction itself is owned by
      // requestStartup(), which is idempotent and cancellable.
      // requestStartup() never rejects; the catch is belt-and-braces so a
      // fire-and-forget call can never surface as an unhandled rejection.
      if (triggerHere) void this.requestStartup().catch(() => { /* contained */ });
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
      this.runMutation(mediaType, 'back-buffer-remove', () => buffer.remove(start, evictBefore));
      this.logDebug('[MSE] evict %s back-buffer [%s, %s)', mediaType, start.toFixed(2), evictBefore.toFixed(2));
      return true;
    } catch (err) {
      this.logWarn('[MSE] back-buffer evict failed (%s): %s', mediaType, (err as Error).message);
      return false;
    }
  }

  /** Emit one append-only diagnostic record with a monotonic sequence number. */
  private diag(msg: string, ...args: unknown[]): void {
    if (!this.debug) return;
    this.logDebug(`[MSE] #%d ${msg}`, ++this.diagSeq, ...args);
  }

  /**
   * Record the START of an app-initiated mutation. Returns the operation id.
   * This asserts only that we began the operation — NOT that any particular
   * later event belongs to it.
   */
  private markBufferOp(mediaType: 'video' | 'audio', cause: BufferOpCause): number {
    const id = ++this.opSeq;
    this.inFlightOp[mediaType] = { id, cause };
    this.diag('mutation-start op=%d %s %s', id, mediaType, cause);
    return id;
  }

  /**
   * Run an app-initiated SourceBuffer mutation with chronology bookkeeping.
   *
   * Every stamped operation reaches exactly one terminal record:
   *   - `mutation-sync-failure` when the call throws synchronously (no async
   *     completion will follow),
   *   - `mutation-cancelled` when reset()/destroy() supersedes the buffer before
   *     completion (its late `updateend` is ignored as superseded), or
   *   - `updateend` otherwise — including a FAILED append, where MSE §5.5.3
   *     queues `error` and then `updateend`, so the error is an intermediate
   *     record and `updateend op=N error` is terminal.
   * The original exception is rethrown so existing recovery paths (quota
   * evict/retry, error surfacing) behave exactly as before.
   */
  private runMutation(
    mediaType: 'video' | 'audio', cause: BufferOpCause, mutate: () => void,
  ): number {
    const id = this.markBufferOp(mediaType, cause);
    try {
      mutate();
    } catch (err) {
      this.failBufferOp(mediaType, id, err);
      throw err;
    }
    return id;
  }

  /**
   * Cancel any in-flight operations, recording each as terminally cancelled.
   * The buffers they targeted are superseded, so their eventual `updateend`
   * arrives with no current operation — without this record the chronology
   * would show an operation that simply stops.
   */
  private cancelBufferOps(reason: string): void {
    for (const mediaType of ['video', 'audio'] as const) {
      const op = this.inFlightOp[mediaType];
      if (!op) continue;
      this.inFlightOp[mediaType] = null;
      this.diag('mutation-cancelled op=%d %s %s reason=%s', op.id, mediaType, op.cause, reason);
    }
  }

  /** Record that a mutation threw synchronously, so no completion will follow. */
  private failBufferOp(mediaType: 'video' | 'audio', id: number, err: unknown): void {
    if (this.inFlightOp[mediaType]?.id === id) this.inFlightOp[mediaType] = null;
    this.diag('mutation-sync-failure op=%d %s: %s', id, mediaType,
      err instanceof Error ? err.message : String(err));
  }

  // ─── ManagedSourceBuffer observation (diagnostics only) ──────────

  /**
   * Report buffer changes. OBSERVATION ONLY — nothing here changes append or
   * drop behavior.
   *
   * `bufferedchange` fires for appendBuffer(), for explicit remove(), AND for
   * the user agent's own memory cleanup (MSE
   * §dom-managedsourcebuffer-onbufferedchange), and MSE queues it independently
   * of `updateend` with no guaranteed relative order. Nothing here decides which
   * operation caused a change: `inflight` and `lastDone` are CHRONOLOGICAL
   * CONTEXT only — an operation we started and have not seen complete, and the
   * most recently completed one. (Standard `SourceBuffer` can also evict coded
   * frames during an append; what it lacks is MMS's autonomous cleanup and this
   * event.)
   *
   * `BufferedChangeEvent` carries the EXACT `addedRanges` / `removedRanges`, so
   * both are logged verbatim rather than inferred from aggregate coverage — an
   * aggregate can hide a removal behind a larger addition in the same event.
   *
   * TIMELINE CAVEAT: these ranges are PRESENTATION time in seconds, while the
   * overlap-drop log reports DECODE time in the track's timescale ticks. Without
   * the track timescale, the SourceBuffer's timestampOffset, and any composition
   * offsets, the two are not numerically comparable — do not equate them.
   * Conclusions drawn from these logs must rest on chronology and on repeated
   * (mediaType, trackName, groupId) identity, not on matching numbers.
   *
   * The open question this exists to answer: when a range leaves the buffer, is
   * the same object ever delivered again? Playa has NO eviction-triggered
   * retrieval path — nothing re-requests evicted media — so unless redelivery
   * happens for some other reason (resubscription, replay), an eviction leaves a
   * hole that append-side bookkeeping cannot repair. The drop log below shows
   * whether any redelivered data is being discarded at all.
   */
  /**
   * Wire the completion + observation listeners for a SourceBuffer, capturing
   * its identity and generation. `reset()` bumps the generation but can leave an
   * UPDATING old buffer attached, whose late `updateend` would otherwise
   * complete an operation on, commit pending ranges into, and drain the queue of
   * the REPLACEMENT buffer. Guarding on identity keeps a superseded buffer's
   * events observational only.
   */
  private wireBufferLifecycle(mediaType: 'video' | 'audio', buffer: SourceBuffer): void {
    const gen = this.bufferGen;
    // error, updateend and bufferedchange are wired together so identity and
    // generation handling cannot drift apart between them.
    buffer.addEventListener('error', () => {
      if (this.isSuperseded(mediaType, buffer, gen)) {
        this.diag('sourcebuffer-error %s SUPERSEDED (gen %d, current %d) — ignored',
          mediaType, gen, this.bufferGen);
        return;
      }
      // MSE §5.5.3 queues `error` and THEN `updateend` for a failed append, so
      // the operation is NOT finished here — mark it errored and let updateend
      // remain its terminal event, carrying the same id.
      const failing = this.inFlightOp[mediaType];
      if (failing) failing.errored = true;
      this.diag('sourcebuffer-error %s op=%s', mediaType, failing ? String(failing.id) : 'none');
      const e = this.video.error;
      this.appendErrored[mediaType] = true;
      if (mediaType === 'video') this.pendingVideoRanges = [];
      else this.pendingAudioRanges = [];
      this.dumpRingOnFailure(`${mediaType} SourceBuffer error`);
      const label = mediaType === 'video' ? 'Video' : 'Audio';
      this.onError?.(new Error(`${label} SourceBuffer error (code=${e?.code}, ${e?.message ?? 'unknown'})`));
    });
    buffer.addEventListener('updateend', () => {
      if (this.isSuperseded(mediaType, buffer, gen)) {
        this.diag('updateend %s SUPERSEDED (gen %d, current %d) — ignored', mediaType, gen, this.bufferGen);
        return;
      }
      this.handleUpdateEnd(mediaType);
    });
    this.watchBufferedChange(mediaType, buffer, gen);
  }

  /** Whether an event came from a SourceBuffer that reset()/destroy() replaced. */
  private isSuperseded(mediaType: 'video' | 'audio', buffer: SourceBuffer, gen: number): boolean {
    const current = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    return gen !== this.bufferGen || buffer !== current;
  }

  private watchBufferedChange(mediaType: 'video' | 'audio', buffer: SourceBuffer, gen: number): void {
    buffer.addEventListener('bufferedchange', (event?: Event) => {
      if (!this.debug || this.destroyed) return;
      // The range payload is optional defensively: a UA (or a harness) may fire
      // the event without it, and a diagnostic must never throw.
      const e = event as (Event & { addedRanges?: TimeRanges; removedRanges?: TimeRanges }) | undefined;
      // CHRONOLOGICAL CONTEXT ONLY. `inflight` is an operation we started
      // and have not seen complete; `lastDone` is the most recently completed
      // one. Which (if either) caused this change is exactly what the log is
      // meant to reveal, so it is not asserted here.
      const inflight = this.inFlightOp[mediaType];
      const superseded = this.isSuperseded(mediaType, buffer, gen);
      this.diag('bufferedchange %s%s inflight=%s lastDone=%s added=[%s] removed=[%s] now=[%s]',
        mediaType, superseded ? ' (SUPERSEDED buffer)' : '',
        inflight ? `${inflight.id}/${inflight.cause}` : 'none',
        this.lastCompletedOp[mediaType] ?? 'none',
        fmtRanges(e?.addedRanges), fmtRanges(e?.removedRanges), fmtRanges(safeBuffered(buffer)));
    });
  }

  // ─── Startup transaction: position, then play ────────────────────
  //
  // Assigning `currentTime` begins an ASYNCHRONOUS seek. Calling play()
  // on the next statement races that seek — the element can begin playout
  // while positioning is still unresolved. Modelling startup as an owned,
  // cancellable transaction removes that race and makes cancellation
  // well-defined. This is independent positioning/cancellation hardening; it
  // is NOT a fix for any particular browser's synchronization behavior.

  /**
   * Pick the start position: the START of the LONGEST buffered range, not
   * simply `buffered.start(0)`. Tuning in at a CRA-led entry whose leading
   * RASLs we strip can leave a stub range like [0, 0.07s] separated from the
   * real content at [1.5s, …]; seeking to 0 would strand playback in the
   * 2-frame stub. The longest range is also correct for normal streams (one
   * big range from t=0) and live tune-ins (the latest gap-free run).
   */
  private selectStartPosition(): { start: number; duration: number } | null {
    const buffered = this.video.buffered;
    if (buffered.length === 0) return null;
    let start = buffered.start(0);
    let duration = buffered.end(0) - start;
    for (let i = 1; i < buffered.length; i++) {
      const s = buffered.start(i);
      const d = buffered.end(i) - s;
      if (d > duration) { start = s; duration = d; }
    }
    return { start, duration };
  }

  /**
   * Request playback startup. Idempotent: returns immediately unless the
   * lifecycle is `idle`, so any number of `updateend`-driven drains during an
   * outstanding seek still produce exactly ONE seek and ONE play attempt.
   *
   * NEVER REJECTS — it is invoked fire-and-forget from `drainQueue`, so every
   * failure path (including a throwing `onError`) is contained here.
   */
  private async requestStartup(): Promise<void> {
    try {
      // Buffering continues regardless; only STARTUP waits for intent.
      if (this.destroyed || !this.playbackIntent || this.playTriggered || this.startupPhase !== 'idle') return;
      const position = this.selectStartPosition();
      if (position === null) return;

      const generation = this.startupGeneration;
      // Bind every fact this attempt records to the session it started in.
      const facts = this.startupFacts;
      const { start, duration } = position;
      const needsSeek = this.video.currentTime < start
        || this.video.currentTime >= start + duration;

      // INVARIANT: never play while the element is still seeking.
      //
      // Assigning `currentTime` updates it SYNCHRONOUSLY even though the seek
      // completes later. So after a seek that timed out unresolved, currentTime
      // already equals the target and `needsSeek` is false — a later drain would
      // sail past positioning and play straight into the unresolved seek,
      // recreating the exact race this transaction exists to remove. Waiting on
      // `seeking` (without issuing a second seek) closes that door: only a
      // genuine settlement, or a timeout that proves the element is idle AT the
      // target, may start playback.
      const elementSeeking = this.video.seeking === true;
      if (!needsSeek && !elementSeeking) {
        this.recordStartupFact(facts, { startPosition: start, seekOutcome: 'no-seek-needed' });
        this.startupPhase = 'play-pending';
        await this.attemptPlay(generation, facts);
        return;
      }

      this.startupPhase = 'positioning';
      this.recordStartupFact(facts, { startPosition: start });
      this.logDebug('[MSE] startup: positioning currentTime=%s → target=%s (seek=%s, seeking=%s)',
        this.video.currentTime.toFixed(3), start.toFixed(3), String(needsSeek), String(elementSeeking));

      let outcome: PositionOutcome;
      try {
        outcome = await this.awaitPositioned(start, generation, needsSeek);
      } catch (err) {
        // Positioning never settled. Do NOT play into an unresolved seek —
        // surface it and return to idle so a later drain can retry (which will
        // re-await settlement, per the invariant above).
        if (generation !== this.startupGeneration || this.destroyed) return;
        this.startupPhase = 'idle';
        // Retriable: recorded, not emitted (a later attempt may still succeed).
        this.recordStartupFact(facts, { seekOutcome: 'seek-timeout-unsettled' });
        this.logWarn('[MSE] startup: %s', (err as Error).message);
        this.safeOnError(err as Error);
        return;
      }
      // `cancelled` means reset()/destroy() superseded this attempt; the phase
      // was already returned to idle by cancelStartup().
      if (outcome === 'cancelled') {
        this.recordStartupFact(facts, { seekOutcome: 'cancelled' });
        return;
      }
      this.recordStartupFact(facts, {
        seekOutcome: outcome === 'timeout-accepted' ? 'seek-timeout-accepted' : 'seek-settled',
      });
      if (generation !== this.startupGeneration || this.destroyed) return;

      this.startupPhase = 'play-pending';
      await this.attemptPlay(generation, facts);
    } catch (err) {
      // Last-resort containment: this method is called fire-and-forget, so an
      // unexpected throw (e.g. a failing `buffered` accessor or a throwing
      // currentTime setter) must not surface as an unhandled rejection. It is
      // still REPORTED — silently swallowing a startup failure would hide a
      // player that never starts — with the consumer contained by safeOnError.
      if (this.startupPhase !== 'started') this.startupPhase = 'idle';
      const error = err instanceof Error ? err : new Error(String(err));
      this.logWarn('[MSE] startup: unexpected failure: %s', error.message);
      this.safeOnError(error);
    }
  }

  /** Invoke onError without letting a throwing consumer escape startup. */
  private safeOnError(err: Error): void {
    try {
      this.onError?.(err);
    } catch {
      /* a throwing consumer must not break the startup lifecycle */
    }
  }

  /**
   * Wait until the element is positioned at `target`.
   *
   * When `assign` is true this issues the seek; when false it only waits for an
   * already-outstanding seek to settle (the timed-out-retry path — issuing a
   * second seek there would restart the very operation we are waiting on).
   *
   * The `seeked` listener is installed BEFORE `currentTime` is assigned, so a
   * browser that completes the seek synchronously cannot slip through. The
   * bounded timeout resolves only when the element is no longer seeking AND
   * landed within tolerance of the target; otherwise it rejects rather than
   * letting playback start against an unresolved position. Listener and timer
   * are removed on every outcome — settlement, timeout, and cancellation.
   */
  private awaitPositioned(target: number, generation: number, assign: boolean): Promise<PositionOutcome> {
    return new Promise<PositionOutcome>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (done) return;
        done = true;
        this.video.removeEventListener('seeked', onSeeked);
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (this.startupCleanup === cleanup) this.startupCleanup = null;
        if (this.startupSettle === settle) this.startupSettle = null;
      };
      const onSeeked = (): void => {
        if (done) return;
        // Same postcondition as the timeout path: a `seeked` only releases
        // startup if it actually left the element idle AT the target. A
        // superseding seek elsewhere (user scrub, recovery jump) fires `seeked`
        // too, and must not be mistaken for our positioning completing —
        // otherwise play() starts at the wrong position. A non-matching event
        // is IGNORED rather than treated as failure; the bounded timeout
        // remains the backstop, so this can never wait forever.
        if (this.video.seeking === true
          || Math.abs(this.video.currentTime - target) > STARTUP_SEEK_TOLERANCE_SEC) {
          this.logDebug('[MSE] startup: ignoring seeked at %s (target %s, seeking=%s)',
            this.video.currentTime.toFixed(3), target.toFixed(3), String(this.video.seeking === true));
          return;
        }
        cleanup();
        this.logDebug('[MSE] startup: seeked settled at %s (target %s)',
          this.video.currentTime.toFixed(3), target.toFixed(3));
        resolve('settled');
      };
      /** Cancellation entry point — settles the promise instead of orphaning it. */
      const settle = (outcome: PositionOutcome): void => {
        if (done) return;
        cleanup();
        resolve(outcome);
      };

      this.video.addEventListener('seeked', onSeeked);
      timer = setTimeout(() => {
        if (done) return;
        const stillSeeking = this.video.seeking === true;
        const landed = Math.abs(this.video.currentTime - target) <= STARTUP_SEEK_TOLERANCE_SEC;
        const superseded = generation !== this.startupGeneration || this.destroyed;
        cleanup();
        this.logDebug('[MSE] startup: seek timeout after %dms — seeking=%s currentTime=%s target=%s',
          STARTUP_SEEK_TIMEOUT_MS, String(stillSeeking), this.video.currentTime.toFixed(3), target.toFixed(3));
        if (superseded) { resolve('cancelled'); return; }
        if (!stillSeeking && landed) resolve('timeout-accepted');
        else reject(new Error(
          `startup seek to ${target.toFixed(3)} did not settle within ${STARTUP_SEEK_TIMEOUT_MS}ms `
          + `(seeking=${stillSeeking}, currentTime=${this.video.currentTime.toFixed(3)})`));
      }, STARTUP_SEEK_TIMEOUT_MS);

      this.startupCleanup = cleanup;
      this.startupSettle = settle;
      // Assign LAST: the listener and timeout are already armed. A setter that
      // throws must not leave them armed behind a rejected promise — clean up
      // both, clear the transaction hooks, and reject exactly once so the next
      // drain starts from a clean slate.
      try {
        if (assign) this.video.currentTime = target;
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Is the attempt identified by `generation` still the one the adapter wants?
   *
   * A superseded generation, a destroyed adapter, and withdrawn playback intent
   * are all equivalent here: none of them may result in a playing element.
   */
  private startupLive(generation: number): boolean {
    return generation === this.startupGeneration && !this.destroyed && this.playbackIntent;
  }

  /**
   * THE single place playback is started on the element.
   *
   * `video.play()` resolves asynchronously, and the element is playing by the
   * time it resolves. So a pause/destroy that happens WHILE the promise is
   * pending cannot be honored by invalidating internal state alone — that would
   * leave the element audibly playing with the adapter believing it is not.
   * Every start therefore re-checks liveness on resolution and pauses the
   * element when the attempt is no longer wanted.
   *
   * Returns true when playback legitimately started; false when the attempt was
   * superseded (and any playback it caused has been undone). Rejection is left
   * to the caller so the autoplay ladder can retry muted.
   */
  private async playElement(generation: number): Promise<boolean> {
    await this.video.play();
    if (this.startupLive(generation)) return true;
    // Withdrawn/destroyed while the promise was pending: the element started
    // anyway. Undo it — this is the late-playback hole a generation check alone
    // cannot close.
    if (this.video.paused === false) this.video.pause();
    return false;
  }

  /**
   * Play, preserving the established autoplay ladder: unmuted first, muted
   * retry when policy rejects. A truly blocked attempt returns the lifecycle to
   * `idle` so the next drain retries — unchanged from the previous behavior.
   */
  private async attemptPlay(generation: number, facts: MutableStartupFacts): Promise<void> {
    const live = (): boolean => this.startupLive(generation);
    try {
      if (!await this.playElement(generation)) return;
    } catch {
      if (!live()) return;
      this.video.muted = true;
      try {
        if (!await this.playElement(generation)) return;
      } catch {
        if (live()) {
          this.startupPhase = 'idle'; // truly blocked — user must interact
          this.recordStartupFact(facts, { seekOutcome: 'autoplay-blocked' });
        }
        return;
      }
    }
    this.playTriggered = true;
    this.startupPhase = 'started';
    this.recordStartupFact(facts, { playTimeSec: this.video.currentTime });
    this.logDebug('[MSE] startup: play() started at %s', this.video.currentTime.toFixed(3));
    // Success: positioning AND play have completed, so the facts are final.
    // The recorded outcome is always a success variant on this path.
    this.reportStartupSucceeded(
      (this.startupFacts.seekOutcome as MseStartupSuccess | null) ?? 'seek-settled');
    this.startWedgeWatchdog();
  }

  /**
   * Cancel any in-flight startup. Bumping the generation invalidates a late
   * `seeked` or a play() that resolves afterwards, and the pending positioning
   * promise is SETTLED (not orphaned) with a `cancelled` outcome so its awaiter
   * unwinds instead of hanging forever.
   */
  private cancelStartup(): void {
    this.startupGeneration++;
    const settle = this.startupSettle;
    this.startupSettle = null;
    if (settle) settle('cancelled'); // settles + cleans up
    else this.startupCleanup?.();
    this.startupCleanup = null;
    this.startupPhase = 'idle';
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
        // Through the owned lifecycle, not a bare v.play(): the pulse's play
        // promise is pending across turns, so a pause/destroy landing in that
        // window must still leave the element paused.
        this.resumeElement();
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
   * timeline-owned replay suppression.
   *
   * Pipeline:
   *   1. Parse the payload's time ranges (tri-state: null / [] / ranges).
   *   2. If null — unscorable moof in the payload — append anyway (fail
   *      open, with a warn).
   *   3. If [] — no moofs, fail open.
   *   4. If ranges — drop ONLY when every range is fully contained in the
   *      track's timeline (contained payload treated as a replay); any
   *      range extending the timeline appends.
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
    //
    // Containment policy: drop ONLY when EVERY decoded range in the payload
    // is fully contained in this track's timeline — a contained payload is
    // treated as a replay (relay group redelivery). Anything extending the
    // timeline appends: MSE's coded-frame replacement natively absorbs seam
    // overlaps, and live encoders routinely emit fragments whose decode
    // range starts a few ticks before the previous fragment's end. Dropping
    // those wholesale manufactures fragment-sized buffered holes and stalls
    // playback at the first hole.
    const timelines = mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
    const timeline = timelines.get(trackName);
    if (ranges !== null && ranges.length > 0 && timeline) {
      const allContained = ranges.every((r) => timeline.containsRange(r.startTime, r.endTime));
      if (allContained) {
        // Logged with group id and the exact decode range so an eviction can be
        // correlated against a later drop of the SAME range — the evidence
        // needed before any residency/refill policy is designed.
        this.logWarn(
          `[MSE] drop contained replay candidate: ${mediaType} payload on track "${trackName}" `
          + `group=${groupId ?? 'n/a'}: ranges=${ranges
            .map((r) => `[${r.startTime}-${r.endTime})`)
            .join(',')} all contained in `
          + `timeline=${timeline.toString()} buffered=[${fmtRanges(safeBuffered(buffer))}]`,
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
      this.runMutation(mediaType, 'append', () => buffer.appendBuffer(data.buffer as ArrayBuffer));
    } catch (err) {
      // runMutation already recorded mutation-sync-failure.
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
          // updateend → drainQueue → retry
          this.runMutation(mediaType, 'quota-remove', () => buffer.remove(start, evictBefore));
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
        this.runMutation(label, 'quota-flush',
          () => b.remove(b.buffered.start(0), b.buffered.end(b.buffered.length - 1)));
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
    // Chronology record: which operation just completed. Deliberately does NOT
    // claim ownership of any bufferedchange — the two events are queued
    // independently and may arrive in either order.
    const completing = this.inFlightOp[mediaType];
    if (completing) {
      this.inFlightOp[mediaType] = null;
      this.lastCompletedOp[mediaType] = completing.id;
    }
    // `updateend` is the terminal event even for a failed append (MSE §5.5.3
    // queues error then updateend), so the id survives and the outcome is
    // recorded alongside it.
    this.diag('updateend %s op=%s%s', mediaType,
      completing ? String(completing.id) : 'none', completing?.errored ? ' error' : '');
    // Startup buffered-range diagnostic (debug-only, first N appends per media
    // type). The element's own `buffered` is the INTERSECTION of both
    // SourceBuffers, so per-buffer ranges are the only way to see the two
    // timelines separately — which is exactly what an A/V skew report needs.
    if (this.debug) {
      const seen = mediaType === 'video' ? this.diagVideoAppends : this.diagAudioAppends;
      if (seen < MseMediaSource.STARTUP_DIAG_COUNT) {
        if (mediaType === 'video') this.diagVideoAppends++; else this.diagAudioAppends++;
        const fmt = (sb: SourceBuffer | null): string => {
          if (!sb) return 'none';
          try {
            const b = sb.buffered;
            return b.length === 0 ? '(empty)' : Array.from({ length: b.length },
              (_, i) => `${b.start(i).toFixed(2)}-${b.end(i).toFixed(2)}`).join(',');
          } catch { return '(unreadable)'; }
        };
        this.logDebug('[MSE] startup#%d append %s done — video=[%s] audio=[%s] currentTime=%s',
          seen + 1, mediaType, fmt(this.videoBuffer), fmt(this.audioBuffer), this.video.currentTime.toFixed(2));
      }
    }

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
