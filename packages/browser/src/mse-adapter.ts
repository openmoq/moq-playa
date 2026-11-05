/**
 * MseMediaSource — native MSE append scheduling for CMAF playback.
 *
 * Implements MediaSourceLike for use with MoqtPlayer.
 * The player supplies initialized, assembled segments. This adapter serializes
 * native mutations and briefly holds timestamp holes for reordered segments;
 * it does not interpret transport streams or infer group completion.
 *
 * Uses 'segments' mode to preserve moof baseDecodeTime timestamps.
 * The caller sets timestampOffset via setTimestampOffset() to rebase
 * live timestamps to zero.
 *
 * @see draft-ietf-moq-cmsf-00 §3.1 (Initialization headers — ftyp+moov)
 * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging — moof+mdat)
 * @module
 */

import type { MediaSourceLike, MediaAppendToken, MediaAppendReason, MediaAppendObserver, MediaSeekResource, MediaSeekSample, VideoPlaybackQualityStats } from '@openmoq/player';
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
import { mediaTrackIdentity } from './media-track-identity.js';

interface AppendEntry {
  data: Uint8Array; trackName: string; trackIdentity: string; sourceKey?: string;
  groupId?: bigint; token?: MediaAppendToken;
  ranges?: readonly SegmentTimeRange[] | null;
  waitUntil?: number;
  waitStartedAt?: number;
  skipsGap?: boolean;
}
interface TrackTimeline {
  readonly trackName: string;
  readonly index: TimelineIndex;
}
interface AppendGapWait {
  entry: AppendEntry;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
}
interface ReceivingGroup {
  readonly trackName: string;
  readonly trackIdentity: string;
  readonly groupId: bigint;
  isCurrent: (() => boolean) | null;
  release: (() => void) | null;
}
function receivingHandle(group: ReceivingGroup): () => void {
  return () => group.release?.();
}

/** Queue ownership only; the caller owns codec, timestamp and recovery-point restoration. */
export interface MseAppendQueueLease {
  readonly current: boolean;
  resume(): void;
  discard(): void;
}

interface AppendQueueHold {
  readonly generation: number;
  readonly types: ReadonlySet<'video' | 'audio'>;
  readonly reconfigured: Set<'video' | 'audio'>;
  invalidated: boolean;
}

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
  /** Recovery rung: 1 seek nudge, 2 pause/play pulse, 3 live-edge seek, 4 onError. */
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

/** Diagnostics for one buffered-hole gap-jump (see onGapJump). */
export interface GapJumpInfo {
  /** Playhead position before the jump (seconds). */
  readonly from: number;
  /** Landing position just inside the next buffered range (seconds). */
  readonly to: number;
  /** Width of the skipped hole (seconds). */
  readonly holeSec: number;
  /** How long the hole persisted before the jump (ms). */
  readonly waitedMs: number;
  /** "start-end|start-end" of the element's buffered ranges at jump time. */
  readonly bufferedRanges: string;
}

/**
 * Validate a stall-detection threshold.
 *
 * This becomes a `setTimeout` delay, where a NaN, negative, or overflowing
 * value silently degrades to an immediate timer in browsers — turning an
 * explicit policy back into an accidental one.
 */
export function validateStallThresholdMs(value: number | undefined): number {
  if (value === undefined) return 250;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError(
      `stallThresholdMs must be a non-negative integer number of milliseconds (got ${value})`,
    );
  }
  // setTimeout stores its delay in a 32-bit signed int; beyond that it fires
  // immediately.
  if (value > 2_147_483_647) {
    throw new RangeError(`stallThresholdMs exceeds the maximum timer delay (got ${value})`);
  }
  return value;
}

/**
 * DRM configuration for EME (Encrypted Media Extensions) support.
 * When provided, the adapter sets up MediaKeys on the video element
 * and handles license acquisition transparently.
 */
export interface DrmConfig {
  /** License server URL — receives POST with the license challenge. */
  readonly licenseUrl: string;
  /** EME key system identifier. Default: 'com.widevine.alpha'. */
  readonly keySystem?: string;
  /** Optional license-server certificate passed to the CDM. */
  readonly serverCertificate?: Uint8Array;
}

interface DrmElementState {
  ready: Promise<void>;
  keys: MediaKeys | null;
  keySystem: string | null;
  certificate: Uint8Array | undefined;
}

interface DrmSessionState {
  initDataType: string;
  initData: Uint8Array;
  abort: AbortController;
}

function equalDrmBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === b) return true;
  return a !== undefined && b !== undefined && a.length === b.length
    && a.every((byte, i) => byte === b[i]);
}

export interface MseMediaSourceOptions {
  /** Ordinary wait for a known decode-time hole. Default 250 ms; current
   *  receiving-stream evidence can extend it to at least 2s (never beyond
   *  max(this value, 2s)). Zero preserves immediate append scheduling. */
  readonly reorderWindowMs?: number;
  /** Retained append-queue limits, per media type. Defaults 100 chunks / 8 MiB. */
  readonly maxQueuedChunks?: number;
  readonly maxQueuedBytes?: number;
  /** DRM configuration. When set, EME is initialized and license requests
   *  are handled automatically via the encrypted event. */
  readonly drmConfig?: DrmConfig;
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
   * Buffered-hole gap-jump: when the playhead is frozen at the end of a
   * buffered range with a bounded hole (≤ 2 s) and more buffered media
   * ahead, wait this long, then seek just past the hole. Live streams from
   * real-world chains carry such holes (content loss at the packager,
   * delivery loss at a relay); nothing else in the element or adapter will
   * ever cross one. `0` disables. Default 2000. Detection runs on the 1 Hz
   * watchdog, so effective resolution is ±1 s. Must be finite and >= 0.
   */
  readonly gapJumpMs?: number;
  /**
   * How long playback must be stalled before a stall is *detected*.
   *
   * Detection previously happened on whichever `timeupdate` landed first,
   * so the threshold was really the browser's ~250 ms event cadence. This
   * makes it explicit and independent of that cadence.
   */
  readonly stallThresholdMs?: number;
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

interface SeekResourceState {
  readonly epoch: object;
  readonly resource: object;
  readonly source: MediaSource;
  readonly revision: number;
  url: string | null;
  retired: boolean;
  positioned: boolean;
  released: boolean;
  cancelPosition: ((error: Error) => void) | null;
  attachmentError: Error | null;
  initializationAttempt: number;
  attachmentWaiters?: Set<{ resolve: () => void; reject: (error: Error) => void }>;
}

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
interface BufferOperation {
  id: number;
  cause: BufferOpCause;
  errored?: boolean;
  aborted?: boolean;
  succeeded?: boolean;
  token?: MediaAppendToken;
  ended?: boolean;
  terminalWaiters?: Set<() => void>;
}

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
 * Native MSE append scheduler.
 *
 * The player MUST call initialize() before appendChunk(). Data ordering
 * (init before media, moof+mdat concatenation) is the player's job.
 * MseMediaSource handles bounded decode-time reordering, SourceBuffer back-pressure, and
 * live-buffer hygiene: back-buffer eviction, a behind-live cap, and
 * QuotaExceededError recovery (evict + retry, escalating to flush-and-rejoin).
 *
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
 */
export class MseMediaSource implements MediaSourceLike {
  readonly supportsTrackIdentity = true;

  private ms: MediaSource;
  private readonly mediaSourceConstructor: typeof MediaSource;
  private resourceRevision = 0;
  private seekResource: SeekResourceState | null = null;
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
    if (!intent && this.seekResource) this.seekResource.released = false;
    this.diag('playback-intent %s', String(intent));
    if (!intent) {
      // Withdrawn intent supersedes playback rather than recovering it: an
      // in-flight episode must not span the paused interval and then complete
      // on resume.
      this.cancelStallEpisode();
      // Cancel a startup in flight AND stop playback that already started —
      // withdrawing intent is a pause, not merely "don't start".
      // Also drop any armed gap candidate AND the post-jump landing watch
      // synchronously: a pause/resume entirely between watchdog ticks must
      // not preserve an old deadline, and an intentional pause must never
      // ripen into a landing-failure fatal.
      this.disarmGap();
      this.clearVideoHoleEvidence(); this.handleWatchdogSeeked(); this.wedgeLastQuality = null;
      this.wedgeLastTime = null; this.wedgeFrozenSinceMs = null;
      this.gapStallEpisode = false;
      this.retireGapLanding();
      this.cancelStartup();
      if (this.playTriggered && this.video.paused === false) this.video.pause();
      return;
    }
    if (this.destroyed) return;
    if (this.seekResource && !this.seekResource.released) return;
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
    if (this.seekResource && !this.seekResource.released) return;
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
   * Back-pressure queues — serialized through each mutation's updateend.
   * Each entry preserves its tagged identity and raw source label so the
   * timeline check runs against the right source when the queue drains.
   */
  private readonly videoQueue: AppendEntry[] = [];
  private readonly audioQueue: AppendEntry[] = [];
  private appendQueueHold: AppendQueueHold | null = null;
  private readonly reorderWindowMs: number;
  private readonly maxQueuedChunks: number;
  private readonly maxQueuedBytes: number;
  private readonly appendGapWait: Record<'video' | 'audio', AppendGapWait | null> = { video: null, audio: null };
  /** Metadata only, bounded like the append queue. No group arithmetic or history. */
  private readonly receivingGroups = {
    video: new Set<ReceivingGroup>(),
    audio: new Set<ReceivingGroup>(),
  };
  private static readonly RECEIVING_GROUP_WAIT_MS = 2_000;
  private readonly lateAppendFloor = { video: new Map<string, bigint>(), audio: new Map<string, bigint>() };
  private readonly pendingGapSkip = { video: false, audio: false };
  private endRequested = false;

  /** Per-(mediaType:tagged identity) committed group high-water mark. */
  private readonly committedGroupFloor = new Map<string, bigint>();

  private readonly video: HTMLVideoElement;
  private objectUrl: string | null = null;
  private destroyed = false;
  private initialized = false;
  /** Deferred initialization owned by the current buffer generation. */
  private sourceOpenListener: (() => void) | null = null;

  // ─── Callbacks ──────────────────────────────────────────────────

  /**
   * True once the media element has attached the MediaSource (`sourceopen`)
   * and initialize() has created the SourceBuffers. Browsers defer the
   * attachment while the document is hidden; until then appendChunk() has
   * nothing to append to. Cleared by reset().
   */
  private _attached = false;
  get attached(): boolean { return this._attached; }

  /** Callback: the MediaSource attached and SourceBuffers now exist. */
  onAttached: (() => void) | null = null;

  onFirstFrame: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  /** `cause` is set for stalls the adapter itself resolved by a gap-jump
   *  (a source hole, not bandwidth) — consumers may exempt those from
   *  bandwidth-driven reactions while still counting them. */
  onStall: ((durationMs: number, cause?: 'media-gap') => void) | null = null;

  /**
   * A detected stall ended with genuine playback resumption (`playing`).
   * Carries the full outage length.
   */
  onStallRecovered: ((durationMs: number) => void) | null = null;
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

  /**
   * Fired after the adapter jumped the playhead across a bounded buffered
   * hole (see MseMediaSourceOptions.gapJumpMs). Wired by MoqtPlayer into
   * stats + the public `gap_jump` event; applications should subscribe to
   * the player event, not this slot.
   */
  onGapJump: ((info: GapJumpInfo) => void) | null = null;

  private firstFrameFired = false;
  /** One-shot guard for the "no SourceBuffer yet" drop diagnostic in appendChunk(). */
  private preInitDropLogged = false;
  private playTriggered = false;
  private stallStartTime: number | null = null;
  /** True once this episode has been reported as detected. */
  private stallDetected = false;
  /** Fires detection at the explicit threshold, not on an event cadence. */
  private stallDetectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stallThresholdMs: number;

  // ── EME / DRM state ──
  private readonly drmConfig: DrmConfig | null = null;
  private mediaKeys: MediaKeys | null = null;
  private mediaKeysReady: Promise<void> | null = null;
  private readonly keySessions = new Map<MediaKeySession, DrmSessionState>();
  // Attachment can outlive an adapter; serialize it across reconnects on the
  // same element. Sessions and license requests remain adapter-owned.
  private static readonly drmElements = new WeakMap<HTMLVideoElement, DrmElementState>();

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
  private wedgeLastQuality: Readonly<VideoPlaybackQualityStats> | null = null;
  /** One observed hole traversal, owned by the current native buffers. Clock
   * movement alone does not retire it; counter progress vetoes recovery. */
  private wedgeVideoHole: {
    readonly end: number; readonly start: number; readonly generation: number;
    readonly videoBuffer: SourceBuffer; readonly audioBuffer: SourceBuffer | null;
  } | null = null;
  /** One native covered position, retained while a later range is not visible. */
  private wedgeCoveredPosition: {
    readonly time: number; readonly generation: number;
    readonly videoBuffer: SourceBuffer; readonly audioBuffer: SourceBuffer | null;
  } | null = null;
  private wedgeSeekTarget: number | null = null;

  // ── Buffered-hole gap-jump state (fully separate from wedge state) ──
  /** Holes wider than this are never jumped (escalate instead). */
  private static readonly GAP_JUMP_MAX_HOLE_SEC = 2.0;
  /** Minimum spacing between jumps (swiss-cheese streams keep jumping, bounded). */
  private static readonly GAP_JUMP_MIN_INTERVAL_MS = 5_000;
  /** A persistent unjumpable hole escalates to a fatal error after this long. */
  private static readonly GAP_WIDE_HOLE_FATAL_MS = 10_000;
  /** Playhead must be this close to its range's end to count as "at the hole". */
  private static readonly GAP_EDGE_WINDOW_SEC = 0.5;
  /** Playhead movement below this is "stuck" (gap detection only). */
  private static readonly GAP_MOVE_TOLERANCE_SEC = 0.05;
  /** Candidate identity comparison tolerance (never float equality). */
  private static readonly GAP_IDENTITY_TOLERANCE_SEC = 0.01;
  /** Per-attempt wait before jumping; 0 disables. */
  private readonly gapJumpMs: number;
  /** Armed hole candidate; identity is {curEnd, nextStart} ONLY (the next
   *  range's tail grows under live append and must not restart the wait). */
  private gapCandidate: {
    curEnd: number; nextStart: number; armedAtMs: number; kind: 'combined' | 'video';
    wideWarned: boolean; spent: boolean;
  } | null = null;
  /** Own last-observed playhead — never reads or writes wedgeLastTime. */
  private gapLastPlayheadTime: number | null = null;
  private gapLastQuality: Readonly<VideoPlaybackQualityStats> | null = null;
  private lastGapJumpAtMs = Number.NEGATIVE_INFINITY;
  /** Suppresses ONE seek-generated waiting/timeupdate episode after a jump. */
  private gapStallEpisode = false;
  /** Watchdog-tick fallback so an undecodable landing can't mute stalls forever. */
  private gapEpisodeTicks = 0;
  /** Post-jump landing watch: cleared on organic progress past `to`; a
   *  landing with no progress escalates to a bounded fatal — even when the
   *  wedge ladder's eligibility conditions never become true. Preserves the
   *  single seek-generated `waiting` timestamp so the frozen span can still
   *  report as a stall after the suppression episode ends. */
  private gapLanding: {
    to: number; jumpedAtMs: number; waitingAtMs: number | null; spent: boolean;
  } | null = null;
  /** True while stallStartTime holds evidence TRANSFERRED from the landing
   *  transaction — retired together with the landing so an intentional
   *  pause can never report as an ordinary bandwidth stall. */
  private gapStallFromLanding = false;

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
   * Per-track timelines, keyed by tagged source identity. ABR switches deliver the
   * same decode-time range under a different identity — those overlaps
   * are legitimate splices and must not be dropped, so each track gets
   * its own index. Single-track duplicates (e.g., a relay that
   * publishes both regular IDR-GOP segments and mid-segment CRA entry
   * points under one track-name) still collide within their shared
   * index and are dropped.
   */
  private readonly videoTimelines = new Map<string, TrackTimeline>();
  private readonly audioTimelines = new Map<string, TrackTimeline>();

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
  /** Ownership lasts through updateend, including the updating=false interval. */
  private readonly inFlightOp: {
    video: BufferOperation | null;
    audio: BufferOperation | null;
  } = { video: null, audio: null };
  /** Most recently completed op id per media type, for after-the-fact context. */
  private readonly lastCompletedOp: { video: number | null; audio: number | null } =
    { video: null, audio: null };

  /** trex defaults from the init segment, per media type. */
  private videoTrex: TrexDefaults | undefined;
  private audioTrex: TrexDefaults | undefined;
  /** MIME selected at SourceBuffer creation or by the last successful retype. */
  private readonly bufferMime: { video: string | null; audio: string | null } =
    { video: null, audio: null };

  /**
   * Ranges for the in-flight appendBuffer, per media type, with the
   * source identity and label so updateend commits into the right per-track
   * index. The owned operation prevents concurrent appends until updateend.
   */
  private pendingVideoRanges: readonly SegmentTimeRange[] = [];
  private pendingAudioRanges: readonly SegmentTimeRange[] = [];
  private pendingVideoTrackName: string | null = null;
  private pendingAudioTrackName: string | null = null;
  private pendingVideoTrackIdentity: string | null = null;
  private pendingAudioTrackIdentity: string | null = null;
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
    const boundedInteger = (name: string, value: number, minimum: number): number => {
      if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`);
      return value;
    };
    this.reorderWindowMs = boundedInteger('reorderWindowMs', options.reorderWindowMs ?? 250, 0);
    if (this.reorderWindowMs > 0x7fffffff) throw new Error('reorderWindowMs exceeds the timer range');
    this.maxQueuedChunks = boundedInteger('maxQueuedChunks', options.maxQueuedChunks ?? 100, 1);
    this.maxQueuedBytes = boundedInteger('maxQueuedBytes', options.maxQueuedBytes ?? 8 * 1024 * 1024, 1);
    this.keepBehindSec = options.keepBehindSec ?? 10;
    this.maxAheadSec = options.maxAheadSec ?? 15;
    this.targetAheadSec = options.targetAheadSec ?? 2;
    const gapJumpMs = options.gapJumpMs ?? 2_000;
    this.stallThresholdMs = validateStallThresholdMs(options.stallThresholdMs);
    if (!Number.isFinite(gapJumpMs) || gapJumpMs < 0) {
      throw new Error(`gapJumpMs must be finite and >= 0 (got ${String(options.gapJumpMs)})`);
    }
    this.gapJumpMs = gapJumpMs;

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
    this.mediaSourceConstructor = MSConstructor;
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
    this.video.addEventListener('seeking', this.handleWatchdogSeek);
    this.video.addEventListener('pause', this.handleCoveredPositionPause);
    this.video.addEventListener('timeupdate', this.handleTimeUpdate);
    this.video.addEventListener('error', this.handleVideoError);

    // ── EME / DRM setup ─────────────────────────────────────────────
    const drm = options.drmConfig;
    this.drmConfig = drm ? {
      ...drm,
      ...(drm.serverCertificate ? { serverCertificate: new Uint8Array(drm.serverCertificate) } : {}),
    } : null;
    if (this.drmConfig) {
      const config = this.drmConfig;
      let state = MseMediaSource.drmElements.get(this.video);
      if (!state) {
        state = { ready: Promise.resolve(), keys: null, keySystem: null, certificate: undefined };
        MseMediaSource.drmElements.set(this.video, state);
      }
      const elementState = state;
      this.video.addEventListener('encrypted', this.handleEncrypted);
      this.mediaKeysReady = Promise.resolve().then(() => this.setupMediaKeys(config, elementState));
    }
  }

  // ─── MediaSourceLike ───────────────────────────────────────────

  /** Fresh native resource; source-clock policy belongs to the caller. */
  beginSeek(epoch: object): MediaSeekResource {
    if (this.destroyed) throw new DOMException('MediaSource destroyed', 'AbortError');
    const revision = ++this.resourceRevision;
    const reserved = () => !this.destroyed && this.resourceRevision === revision;
    const check = () => { if (!reserved()) throw new DOMException('Seek resource superseded', 'AbortError'); };
    const oldUrl = this.objectUrl, oldSrc = this.video.src, oldObject = this.video.srcObject;
    const checkAttachment = (src = oldSrc, object: unknown = oldObject) => {
      check();
      let attached = false;
      try { attached = this.video.src === src && this.video.srcObject === object; } catch { /* Ownership unproven. */ }
      check();
      if (!attached) {
        this.revokeOwnedUrl(oldUrl);
        throw new DOMException('Seek attachment replaced', 'AbortError');
      }
    };
    checkAttachment();
    const source = new this.mediaSourceConstructor();
    checkAttachment();
    this.cancelStallEpisode();
    this.retireSeek();
    checkAttachment();
    this.resetBuffers();
    // Reset publishes append terminals; their observers can replace the DOM
    // attachment without going through this adapter's resource revision.
    checkAttachment();
    this.video.pause();
    checkAttachment();
    this.revokeOwnedUrl(oldUrl);
    checkAttachment();
    this.video.removeAttribute('src');
    checkAttachment('', oldObject);
    this.video.srcObject = null;
    checkAttachment('', null);
    this.video.load();
    checkAttachment('', null);
    this.ms = source;
    this.playTriggered = false;
    this.firstFrameFired = false;
    this.videoErrorDumped = false;
    const state: SeekResourceState = { epoch, resource: {}, source, revision, url: null,
      retired: false, positioned: false, released: false, cancelPosition: null, attachmentError: null, initializationAttempt: 0 };
    this.seekResource = state;
    try {
      if (this.selectedAttachment === 'src-object') this.video.srcObject = source;
      else {
        const url = URL.createObjectURL(source);
        if (!reserved()) { URL.revokeObjectURL(url); check(); }
        state.url = this.objectUrl = url;
        this.video.src = url;
      }
      check();
      if (!this.seekCurrent(state)) throw new DOMException('Seek attachment replaced', 'AbortError');
    } catch (error) {
      if (reserved()) this.cancelSeek(state);
      throw error;
    }
    const observers = new Set<{ tokens: WeakSet<object>; detach: () => void }>();
    const current = () => this.seekCurrent(state);
    const assertCurrent = () => { if (!current()) throw new DOMException('Seek resource retired', 'AbortError'); };
    return {
      epoch, resource: state.resource,
      get current() { return current(); },
      initialize: config => {
        assertCurrent();
        // A validation refusal creates no buffers, so the inherited initialize
        // contract permits a corrected retry. An error observer may start that
        // retry before the refused outer call returns.
        const attempt = this.initialized ? state.initializationAttempt : ++state.initializationAttempt;
        if (!this.initialized) state.attachmentError = null;
        try {
          // Read application-owned values before initialization can capture a
          // source. A getter may replace this lease while supplying a value.
          const snapshot: Parameters<MediaSourceLike['initialize']>[0] = {};
          for (const role of ['video', 'audio'] as const) {
            const entry = config[role];
            assertCurrent();
            if (entry) {
              const codec = entry.codec;
              const initData = new Uint8Array(entry.initData);
              assertCurrent();
              snapshot[role] = { codec, initData };
            }
          }
          const accepted = this.initialize(snapshot);
          assertCurrent();
          if (accepted === false && state.initializationAttempt === attempt) {
            this.settleSeekAttachment(state, new Error('Seek initialization refused'));
          }
          return accepted;
        } catch (error) {
          if (state.initializationAttempt === attempt) this.settleSeekAttachment(state, error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      },
      whenAttached: () => {
        try {
          assertCurrent();
          if (state.attachmentError) return Promise.reject(state.attachmentError);
          if (!this.initialized) return Promise.reject(new DOMException('Seek initialize() has not been accepted', 'InvalidStateError'));
          if (this._attached) return Promise.resolve();
          return new Promise<void>((resolve, reject) => { (state.attachmentWaiters ??= new Set()).add({ resolve, reject }); });
        } catch (error) { return Promise.reject(error); }
      },
      appendChunk: (...args) => {
        const token = args[4];
        if (token) for (const observer of observers) observer.tokens.add(token);
        if (!current()) {
          this.appendOutcome(token, 'discarded', 'decoder reset');
          assertCurrent();
        }
        this.appendChunk(...args);
      },
      observeAppends: observer => {
        if (typeof observer !== 'function') throw new TypeError('Expected an append observer');
        const tokens = new WeakSet<object>();
        const detach = this.observeAppends(event => { if (tokens.delete(event.token)) return observer(event); });
        const entry = { tokens, detach }; observers.add(entry);
        return () => { observers.delete(entry); detach(); };
      },
      getTimestampOffset: role => { assertCurrent(); return this.getTimestampOffset(role); },
      setTimestampOffset: (role, offset) => { assertCurrent(); this.setTimestampOffset(role, offset); },
      position: time => this.positionSeek(state, time),
      sample: () => state.positioned ? this.seekSample(state) : null,
      setPlaybackIntent: intent => {
        assertCurrent();
        if (intent && (!state.positioned || !this.seekSample(state))) {
          throw new DOMException('Seek positioning is pending or unavailable', 'InvalidStateError');
        }
        if (intent) {
          state.released = true;
          this.playTriggered = true;
          this.startupPhase = 'started';
          if (this.playbackIntent) this.resumePlayback();
          else this.setPlaybackIntent(true);
          this.startWedgeWatchdog();
        } else this.setPlaybackIntent(false);
      },
      cancel: () => this.cancelSeek(state),
    };
  }

  private seekCurrent(state: SeekResourceState): boolean {
    const owned = () => !this.destroyed && !state.retired && this.seekResource === state
      && this.ms === state.source && this.resourceRevision === state.revision;
    if (!owned()) return false;
    return this.seekAttached(state) && owned();
  }

  /** Attachment ownership remains relevant after a view has been retired. */
  private seekAttached(state: SeekResourceState): boolean {
    try {
      const attached = state.url === null ? this.video.srcObject === state.source
        : this.video.src === state.url && this.video.srcObject == null && this.objectUrl === state.url;
      return attached && this.ms === state.source;
    } catch { return false; }
  }

  private revokeOwnedUrl(url: string | null): void {
    if (url !== null && this.objectUrl === url) {
      this.objectUrl = null;
      URL.revokeObjectURL(url);
    }
  }

  private seekSample(state: SeekResourceState): MediaSeekSample | null {
    if (!this.seekCurrent(state) || !this._attached || state.source.readyState === 'closed') return null;
    try {
      if (this.video.seeking || this.video.readyState < 2 || this.video.error) return null;
      const time = this.video.currentTime, ranges = this.video.buffered;
      if (!Number.isFinite(time) || time < 0) return null;
      // Optional playback state must not hide an otherwise observable clock.
      let paused: boolean | undefined, playbackRate: number | undefined;
      try { const value = this.video.paused; if (typeof value === 'boolean') paused = value; } catch { /* Unavailable. */ }
      try { const value = this.video.playbackRate; if (typeof value === 'number' && Number.isFinite(value)) playbackRate = value; } catch { /* Unavailable. */ }
      for (let i = 0; i < ranges.length; i++) {
        const start = ranges.start(i), end = ranges.end(i);
        if (Number.isFinite(start) && Number.isFinite(end) && start <= time && time <= end
            && this.seekCurrent(state) && !this.video.seeking && this.video.readyState >= 2 && !this.video.error) {
          if (!this.seekCurrent(state)) return null;
          return { epoch: state.epoch, resource: state.resource, currentTime: time, buffered: { start, end },
            ...(paused === undefined ? {} : { paused }), ...(playbackRate === undefined ? {} : { playbackRate }) };
        }
      }
    } catch { /* Detached or reentrant native reads cannot prove a position. */ }
    return null;
  }

  private settleSeekAttachment(state: SeekResourceState, error?: Error): void {
    if (error) state.attachmentError = error;
    const waiters = state.attachmentWaiters;
    delete state.attachmentWaiters;
    if (waiters) for (const waiter of waiters) {
      if (error) waiter.reject(error); else waiter.resolve();
    }
  }

  private retireSeek(): void {
    const state = this.seekResource;
    if (!state) return;
    state.retired = true; state.positioned = false; state.released = false;
    this.settleSeekAttachment(state, new DOMException('Seek resource retired', 'AbortError'));
    state.cancelPosition?.(new DOMException('Seek resource retired', 'AbortError'));
  }

  private cancelSeek(state: SeekResourceState): void {
    if (state.retired || this.seekResource !== state) return;
    const revision = ++this.resourceRevision;
    this.cancelStallEpisode();
    this.retireSeek();
    if (this.resourceRevision !== revision) return;
    this.resetBuffers();
    if (this.resourceRevision !== revision) return;
    // Terminal append observers may install an external attachment without
    // calling this adapter. Revision checks alone cannot authorize detachment.
    if (!this.seekAttached(state)) { this.revokeOwnedUrl(state.url); return; }
    this.video.pause();
    if (this.resourceRevision !== revision) return;
    if (!this.seekAttached(state)) { this.revokeOwnedUrl(state.url); return; }
    this.video.removeAttribute('src');
    if (this.resourceRevision !== revision) return;
    this.video.srcObject = null;
    if (this.resourceRevision !== revision) return;
    this.video.load();
    if (this.resourceRevision !== revision) return;
    this.revokeOwnedUrl(state.url);
  }

  private positionSeek(state: SeekResourceState, time: number): Promise<MediaSeekSample> {
    if (!Number.isFinite(time) || time < 0) return Promise.reject(new TypeError('Expected finite nonnegative native seconds'));
    if (!this.seekCurrent(state)) return Promise.reject(new DOMException('Seek resource retired', 'AbortError'));
    state.cancelPosition?.(new DOMException('Positioning superseded', 'AbortError'));
    if (!this.seekCurrent(state)) return Promise.reject(new DOMException('Seek resource retired', 'AbortError'));
    state.positioned = false;
    return new Promise((resolve, reject) => {
      let done = false, assigning = false, completed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wakes = ['loadeddata', 'canplay', 'progress', 'timeupdate'];
      const cleanup = () => {
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        this.video.removeEventListener('seeked', onSeeked);
        this.video.removeEventListener('error', evaluate);
        for (const event of wakes) this.video.removeEventListener(event, evaluate);
        if (state.cancelPosition === fail) state.cancelPosition = null;
      };
      const fail = (error: Error) => { if (!done) { cleanup(); reject(error); } };
      const evaluate = () => {
        if (done || assigning) return;
        if (!this.seekCurrent(state)) { fail(new DOMException('Seek resource retired', 'AbortError')); return; }
        try {
          const error = this.video.error;
          if (error) { fail(new Error(`Native media error ${error.code}: ${error.message}`)); return; }
          if (!completed) return;
          const sample = this.seekSample(state);
          if (done) return;
          if (!this.seekCurrent(state)) { fail(new DOMException('Seek resource retired', 'AbortError')); return; }
          if (sample) { state.positioned = true; cleanup(); resolve(sample); }
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      const onSeeked = () => { completed = true; evaluate(); };
      state.cancelPosition = fail;
      this.video.addEventListener('seeked', onSeeked);
      this.video.addEventListener('error', evaluate);
      for (const event of wakes) this.video.addEventListener(event, evaluate);
      // Application policy shared with startup, not an HTML seek-time guarantee.
      timer = setTimeout(() => { evaluate(); if (!done) fail(new DOMException('Native seek completion unproven', 'TimeoutError')); }, STARTUP_SEEK_TIMEOUT_MS);
      try {
        // Fresh zero may already be ready; setting the official position alone
        // does not prove a changed seek complete. Its seeked witness is required.
        if (time === 0 && this.video.currentTime === 0 && !this.video.seeking) completed = true;
        else { assigning = true; this.video.currentTime = time; assigning = false; }
        evaluate();
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

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
    const generation = this.bufferGen, source = this.ms;

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
    // Capability checks and logging can invoke application code too. Never
    // latch an earlier initialization onto a replacement MediaSource.
    if (this.destroyed || this.ms !== source || this.bufferGen !== generation) {
      throw new DOMException('Initialization resource retired', 'AbortError');
    }
    this.initialized = true;

    const doInit = () => {
      if (this.sourceOpenListener === doInit) {
        source.removeEventListener('sourceopen', doInit);
        this.sourceOpenListener = null;
      }
      if (this.destroyed || this.ms !== source || this.bufferGen !== generation || !this.initialized) return;
      const openingSeek = this.seekResource;
      // Native sourceopen is queued. DOM replacement can detach its source
      // before dispatch without changing this adapter's generation fields.
      if (openingSeek?.source === source && (!this.seekCurrent(openingSeek) || source.readyState !== 'open')) {
        this.settleSeekAttachment(openingSeek, new DOMException('Seek attachment replaced', 'AbortError'));
        return;
      }
      try {
        if (config.video) {
          const mimeType = `video/mp4; codecs="${config.video.codec}"`;
          this.logDebug('[MSE] Creating video SourceBuffer:', mimeType);
          this.videoBuffer = this.ms.addSourceBuffer(mimeType);
          this.bufferMime.video = mimeType;
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
          this.bufferMime.audio = mimeType;
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
        // SourceBuffers exist from here on: appendChunk() can take effect.
        this._attached = true;
        const seek = this.seekResource;
        if (seek?.source === source) this.settleSeekAttachment(seek, this.seekCurrent(seek)
          ? undefined : new DOMException('Seek attachment replaced', 'AbortError'));
        this.onAttached?.();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const seek = this.seekResource;
        if (!this._attached && seek?.source === source) this.settleSeekAttachment(seek, error);
        this.onError?.(error);
      }
    };

    if (this.ms.readyState === 'open') {
      doInit();
    } else {
      this.sourceOpenListener = doInit;
      this.ms.addEventListener('sourceopen', doInit, { once: true });
    }
    return true;
  }

  private appendObservers: Set<MediaAppendObserver> | undefined;

  /** Outcomes are future observations only; callers own the returned unsubscribe. */
  observeAppends(observer: MediaAppendObserver): () => void {
    if (typeof observer !== 'function') throw new TypeError('Expected an append observer');
    const observers = this.appendObservers ??= new Set();
    observers.add(observer);
    return () => {
      observers.delete(observer);
      if (this.appendObservers === observers && observers.size === 0) this.appendObservers = undefined;
    };
  }

  private appendOutcome(token: MediaAppendToken | undefined, state: 'appended' | 'discarded' | 'unavailable', reason: MediaAppendReason | null): void {
    const observers = this.appendObservers;
    if (!token || !observers) return;
    for (const observer of [...observers]) {
      if (!observers.has(observer)) continue;
      try {
        const result = observer({ token, state, reason });
        if (result) void Promise.resolve(result).catch(() => {});
      } catch { /* Optional observations cannot break media playback. */ }
    }
  }

  private appendEntry(
    data: Uint8Array, trackName: string, trackIdentity: string, groupId: bigint | undefined,
    token: MediaAppendToken | undefined, sourceKey: string | undefined,
  ): AppendEntry {
    const entry: AppendEntry = groupId === undefined ? { data, trackName, trackIdentity } : { data, trackName, trackIdentity, groupId };
    if (token !== undefined) entry.token = token;
    if (sourceKey !== undefined) entry.sourceKey = sourceKey;
    return entry;
  }

  private queuedTokens(queue: readonly AppendEntry[], tokens?: Set<MediaAppendToken>): Set<MediaAppendToken> | undefined {
    if (!this.appendObservers) return tokens;
    for (const entry of queue) if (entry.token) (tokens ??= new Set()).add(entry.token);
    return tokens;
  }

  private discardTokens(tokens: Set<MediaAppendToken> | undefined, reason: MediaAppendReason): void {
    if (tokens) for (const token of tokens) this.appendOutcome(token, 'discarded', reason);
  }

  private discardQueue(queue: AppendEntry[], reason: MediaAppendReason): void {
    const tokens = this.queuedTokens(queue);
    this.clearAppendGap(queue === this.videoQueue ? 'video' : 'audio');
    queue.length = 0; // Relinquish ownership before a listener can reenter.
    this.discardTokens(tokens, reason);
  }

  private clearAppendGap(mediaType: 'video' | 'audio'): void {
    const wait = this.appendGapWait[mediaType];
    this.appendGapWait[mediaType] = null;
    if (wait?.timer !== null && wait?.timer !== undefined) clearTimeout(wait.timer);
  }

  private enqueueAppend(mediaType: 'video' | 'audio', entry: AppendEntry): boolean {
    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;
    const bytes = queue.reduce((total, queued) => total + queued.data.byteLength, 0);
    if (queue.length >= this.maxQueuedChunks || entry.data.byteLength > this.maxQueuedBytes - bytes) {
      this.appendOutcome(entry.token, 'discarded', 'queue capacity');
      this.logWarn('[MSE] %s append queue capacity reached', mediaType);
      return false;
    }
    // Retaining a small view must not retain or append its larger backing pool.
    if (entry.data.byteOffset !== 0 || entry.data.byteLength !== entry.data.buffer.byteLength) {
      entry.data = Uint8Array.from(entry.data);
    }
    queue.push(entry);
    return true;
  }

  private scoreAppend(mediaType: 'video' | 'audio', entry: AppendEntry): readonly SegmentTimeRange[] | null {
    if (entry.ranges === undefined) {
      const trex = mediaType === 'video' ? this.videoTrex : this.audioTrex;
      entry.ranges = readSegmentTimeRanges(entry.data, trex, (kind, detail) => {
        const key = `${mediaType}:${kind}`;
        if (this.seenDiagnostics.has(key)) return;
        this.seenDiagnostics.add(key);
        this.logWarn(`[MSE] ${mediaType} parse skipped (${kind}): ${detail}`);
      });
    }
    return entry.ranges;
  }

  private nextAppendIndex(mediaType: 'video' | 'audio', queue: AppendEntry[]): number {
    if (this.reorderWindowMs === 0) return 0;
    const first = queue[0]!;
    const ranges = this.scoreAppend(mediaType, first);
    if (!ranges?.length) return 0;
    let chosen = 0, start = ranges[0]!.startTime;
    for (let i = 1; i < queue.length; i++) {
      const entry = queue[i]!;
      if (entry.trackIdentity !== first.trackIdentity) break; // Source boundaries retain caller order.
      const candidate = this.scoreAppend(mediaType, entry);
      if (!candidate?.length) break;
      if (candidate[0]!.startTime < start) { chosen = i; start = candidate[0]!.startTime; }
    }
    return chosen;
  }

  /**
   * Decode-time slack below which a start past the buffered end is not a hole.
   * Ticks are in the track timescale, which the adapter does not know, so the
   * tolerance is relative to the segment's own mean sample duration: less than
   * half a frame cannot be a missing sample, only producer clock jitter (tfdt
   * from capture time, nominal trun durations). Same spirit as
   * GAP_IDENTITY_TOLERANCE_SEC on the presentation side, which is also well
   * under one frame. A segment with no samples/duration keeps exact comparison.
   */
  private static appendHoleTolerance(range: SegmentTimeRange): bigint {
    if (range.sampleCount <= 0 || range.endTime <= range.startTime) return 0n;
    return (range.endTime - range.startTime) / BigInt(range.sampleCount) / 2n;
  }

  private holdAppendGap(mediaType: 'video' | 'audio', entry: AppendEntry): boolean {
    const generation = this.bufferGen;
    delete entry.skipsGap;
    if (this.reorderWindowMs === 0) return false;
    const ranges = this.scoreAppend(mediaType, entry);
    const timelines = mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
    const end = timelines.get(entry.trackIdentity)?.index.extent?.end;
    // The first segment anchors the clock. Unknown layouts retain the existing
    // fail-open policy; tick values are compared only within this track/context.
    if (!ranges?.length || end === undefined
        || ranges[0]!.startTime - end <= MseMediaSource.appendHoleTolerance(ranges[0]!)) return false;
    const previous = this.appendGapWait[mediaType];
    const now = performance.now();
    entry.waitStartedAt ??= now;
    if (previous?.entry.trackIdentity === entry.trackIdentity && previous.entry.waitStartedAt !== undefined) {
      entry.waitStartedAt = Math.min(entry.waitStartedAt, previous.entry.waitStartedAt);
    }
    // An observed stream in this or an older group can still supply the tail.
    // Same-group accepted transforms may complete out of order. FIN releases only
    // that stream, after its accepted async work. Without such evidence use
    // the ordinary 250ms policy, including fully received sparse groups.
    const receiving = entry.groupId !== undefined && this.currentReceivingGroups(mediaType)
      .some(group => group.trackIdentity === entry.trackIdentity && group.groupId <= entry.groupId!);
    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;
    if (this.destroyed || generation !== this.bufferGen || !queue.includes(entry) || this.changingType[mediaType]) return true;
    const deadline = entry.waitStartedAt + (receiving
      ? Math.max(this.reorderWindowMs, MseMediaSource.RECEIVING_GROUP_WAIT_MS) : this.reorderWindowMs);
    if (entry.waitUntil !== deadline) this.clearAppendGap(mediaType);
    entry.waitUntil = deadline;
    if (now >= entry.waitUntil) { entry.skipsGap = true; return false; }
    if (this.appendGapWait[mediaType]?.entry === entry && this.appendGapWait[mediaType]?.timer !== null) return true;
    this.clearAppendGap(mediaType);
    const wait: AppendGapWait = { entry, generation, timer: setTimeout(() => {
      if (this.appendGapWait[mediaType] !== wait || this.destroyed || generation !== this.bufferGen) return;
      wait.timer = null; // A timer may wake before its monotonic deadline.
      this.drainQueue(mediaType);
    }, entry.waitUntil - now) };
    this.appendGapWait[mediaType] = wait;
    return true;
  }

  retainReceivingGroup(mediaType: 'video' | 'audio', trackName: string, groupId: bigint, isCurrent: () => boolean, sourceKey?: string): () => void {
    const generation = this.bufferGen;
    const groups = this.receivingGroups[mediaType];
    this.currentReceivingGroups(mediaType);
    if (this.destroyed || this.reorderWindowMs === 0 || generation !== this.bufferGen || groups.size >= this.maxQueuedChunks) return () => {};
    const group: ReceivingGroup = { trackName, trackIdentity: mediaTrackIdentity(trackName, sourceKey), groupId, isCurrent, release: null };
    groups.add(group);
    group.release = () => {
      this.retireReceivingGroup(mediaType, group);
      if (this.destroyed) return;
      this.clearAppendGap(mediaType);
      this.drainQueue(mediaType);
    };
    // A handle retained by accepted async work becomes a small inert record
    // after retirement; it must not retain the adapter/registration/source.
    return receivingHandle(group);
  }

  private retireReceivingGroup(mediaType: 'video' | 'audio', group: ReceivingGroup): void {
    this.receivingGroups[mediaType].delete(group);
    group.isCurrent = null;
    group.release = null;
  }

  private clearReceivingGroups(mediaType: 'video' | 'audio', trackIdentity?: string): void {
    for (const group of this.receivingGroups[mediaType]) {
      if (trackIdentity === undefined || group.trackIdentity === trackIdentity) this.retireReceivingGroup(mediaType, group);
    }
  }

  private currentReceivingGroups(mediaType: 'video' | 'audio') {
    const groups = this.receivingGroups[mediaType];
    for (const group of [...groups]) {
      const floor = this.committedGroupFloor.get(`${mediaType}:${group.trackIdentity}`);
      if (floor !== undefined && group.groupId < floor) { this.retireReceivingGroup(mediaType, group); continue; }
      let current = false;
      try { current = group.isCurrent?.() === true; } catch { /* Retired owner cannot hold playback. */ }
      if (!current) this.retireReceivingGroup(mediaType, group);
    }
    return [...groups];
  }

  private finishEndOfStream(): void {
    if (!this.endRequested || this.destroyed || this.ms.readyState !== 'open'
        || this.appendQueueHold !== null
        || this.videoQueue.length || this.audioQueue.length
        || this.inFlightOp.video || this.inFlightOp.audio
        || this.videoBuffer?.updating || this.audioBuffer?.updating
        || this.changingType.video || this.changingType.audio) return;
    this.endRequested = false;
    this.diag('endOfStream');
    try { this.ms.endOfStream(); } catch { /* Native state may already have ended. */ }
  }

  /**
   * Append a complete CMAF segment (moof+mdat) to the SourceBuffer.
   *
   * The caller MUST:
   * - Call initialize() first
   * - Concatenate moof+mdat into a single buffer before calling this
   * - Only send data that follows the init segment's codec context
   *
   * Known timestamp holes are held briefly; native back-pressure is serialized.
   */
  appendChunk(mediaType: 'video' | 'audio', data: Uint8Array, trackName: string, groupId?: bigint, token?: MediaAppendToken, sourceKey?: string): void {
    if (this.destroyed) { this.appendOutcome(token, 'discarded', 'destroyed'); return; }
    // Without observers, never add diagnostic ownership to a normal queue entry.
    if (!this.appendObservers) token = undefined;
    if (this.appendQueueHold?.types.has(mediaType)) {
      // Identity belongs to the caller; never guess whether this is old or target media.
      this.appendOutcome(token, 'discarded', 'retype');
      return;
    }

    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    if (!buffer) {
      // No SourceBuffer yet: either initialize() hasn't been called, or it has
      // and we are still waiting for `sourceopen`. The latter is normal for a
      // hidden tab — browsers defer the media load (and so the MediaSource
      // attachment) until the document is visible — but it must not be silent:
      // every chunk dropped here is media the element will never see.
      if (!this.preInitDropLogged) {
        this.preInitDropLogged = true;
        const doc = (globalThis as { document?: { visibilityState?: string } }).document;
        this.logDebug('[MSE] dropping %s chunk: no SourceBuffer yet (initialized=%s, ms.readyState=%s, '
          + 'document.visibilityState=%s) — waiting for sourceopen; further drops not logged',
          mediaType, String(this.initialized), this.ms.readyState, doc?.visibilityState ?? 'n/a');
      }
      this.appendOutcome(token, 'discarded', 'not attached');
      return;
    }

    // Stale-group drop: if this group is older than what MSE has
    // already committed, skip it. Prevents late-arriving old-group
    // data from causing blocky artifacts or false discontinuities.
    const trackIdentity = mediaTrackIdentity(trackName, sourceKey);
    if (groupId !== undefined) {
      const key = `${mediaType}:${trackIdentity}`;
      const floor = this.committedGroupFloor.get(key);
      if (floor !== undefined && groupId < floor) {
        this.appendOutcome(token, 'discarded', 'stale group');
        return;
      }
    }

    const entry = this.appendEntry(data, trackName, trackIdentity, groupId, token, sourceKey);
    if (!this.enqueueAppend(mediaType, entry)) return;
    this.drainQueue(mediaType);
  }

  /**
   * Retain the current bounded queues while the caller prepares output changes.
   * New direct appends for these types are rejected until release. In-flight
   * native operations finish normally. Resume only after restoring the old
   * initialization and offsets, with a valid random-access recovery chain:
   * another init can require a new random-access point (MSE §5.5.7).
   * This lease does not roll back native buffers or guarantee uninterrupted decoding.
   * A quota flush invalidates the lease and keeps its types gated until reset;
   * releasing an invalidated handle cannot make a temporary init safe to use.
   */
  holdQueuedAppends(types: readonly ('video' | 'audio')[]): MseAppendQueueLease {
    if (!Array.isArray(types)) throw new TypeError('Expected distinct video/audio queue types');
    const count = types.length;
    if (count !== 1 && count !== 2) throw new TypeError('Expected distinct video/audio queue types');
    const requested = new Set<'video' | 'audio'>();
    for (let i = 0; i < count; i++) {
      const type = types[i];
      if (type !== 'video' && type !== 'audio' || requested.has(type)) throw new TypeError('Expected distinct video/audio queue types');
      requested.add(type);
    }
    if (this.destroyed || !this._attached) throw new Error('Cannot hold queues before attachment');
    if (this.appendQueueHold !== null) throw new Error(this.appendQueueHold.invalidated
      ? 'Append queues invalidated; reset is required' : 'Append queues are already owned');
    if (this.quotaFlushInFlight) throw new Error('Cannot hold queues during quota recovery');
    for (const type of requested) {
      if (!(type === 'video' ? this.videoBuffer : this.audioBuffer)) throw new Error(`No ${type} SourceBuffer to hold`);
      if (this.changingType[type]) throw new Error('Cannot acquire queues during reconfiguration');
    }
    const hold: AppendQueueHold = { generation: this.bufferGen, types: requested, reconfigured: new Set(), invalidated: false };
    this.appendQueueHold = hold;
    for (const type of hold.types) this.clearAppendGap(type);
    const current = () => this.appendQueueHold === hold && !hold.invalidated && !this.destroyed && this.bufferGen === hold.generation;
    const release = (discard: boolean) => {
      if (!current()) return;
      for (const type of hold.types) if (this.changingType[type]) throw new Error('Queue reconfiguration is still in progress');
      let tokens: Set<MediaAppendToken> | undefined;
      if (discard) for (const type of hold.types) {
        const queue = type === 'video' ? this.videoQueue : this.audioQueue;
        tokens = this.queuedTokens(queue, tokens);
        queue.length = 0;
        this.clearAppendGap(type);
        if (hold.reconfigured.has(type)) {
          (type === 'video' ? this.videoTimelines : this.audioTimelines).clear();
          this.lateAppendFloor[type].clear();
        }
      }
      // Clear every owned queue before any observer can reenter or take a successor lease.
      this.appendQueueHold = null;
      this.discardTokens(tokens, 'retype');
      for (const type of hold.types) {
        if (this.destroyed || this.bufferGen !== hold.generation) return;
        this.drainQueue(type);
      }
      if (this.destroyed || this.bufferGen !== hold.generation) return;
      this.finishEndOfStream();
    };
    return Object.freeze({ get current() { return current(); }, resume: () => release(false), discard: () => release(true) });
  }

  /**
   * Append the target init for every requested track reconfiguration.
   *
   * Matching MIME does not imply matching track initialization. Compatible
   * subsequent inits are handled by MSE's initialization-segment algorithm;
   * retype only when the MIME changes, then append the required init.
   *
   * Discard queued media, wait for the current mutation, and hold new appends
   * until the init succeeds. The caller owns track selection and rollback.
   *
   * @param mediaType Which SourceBuffer to retype.
   * @param codec Codec string for the new mime type
   *              (e.g. `"hvc1.1.6.L93.90"`).
   * @param initData Raw init segment bytes (ftyp+moov) for the new codec.
   * @throws If the SourceBuffer is not initialized, the reconfiguration fails,
   *         or a MIME change requires unavailable `SourceBuffer.changeType()`.
   *
   * @see https://www.w3.org/TR/media-source-2/#dom-sourcebuffer-changetype
   * @see https://www.w3.org/TR/media-source-2/#sourcebuffer-init-segment-received
   */
  async changeType(
    mediaType: 'video' | 'audio',
    codec: string,
    initData: Uint8Array,
  ): Promise<void> {
    if (this.destroyed) return;
    const generation = this.bufferGen;
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    if (!buffer) {
      throw new Error(`MseMediaSource.changeType: ${mediaType} SourceBuffer not initialized`);
    }
    const sb = buffer as SourceBuffer & { changeType?: (mime: string) => void };
    const mimeType = `${mediaType}/mp4; codecs="${codec}"`;
    const retype = this.bufferMime[mediaType] !== mimeType;
    if (retype && typeof sb.changeType !== 'function') {
      throw new Error('MseMediaSource.changeType: SourceBuffer.changeType not supported');
    }
    if (this.changingType[mediaType]) {
      throw new Error(`MseMediaSource.changeType: ${mediaType} already in changing-type state`);
    }

    this.changingType[mediaType] = true;
    this.clearReceivingGroups(mediaType);
    this.clearVideoHoleEvidence(); this.handleWatchdogSeeked();
    this.endRequested = false;
    try {
      const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;
      // Discard queued media from the previous configuration before its
      // replacement init. The caller stages and re-delivers the target media.
      const hold = this.appendQueueHold?.types.has(mediaType) ? this.appendQueueHold : null;
      if (hold) hold.reconfigured.add(mediaType);
      else this.discardQueue(queue, 'retype');
      if (this.destroyed || generation !== this.bufferGen) return;

      // Wait for the in-flight mutation's terminal event before reconfiguring.
      while (this.bufferBusy(mediaType, buffer)) {
        await this.waitForBufferEvent(buffer, this.inFlightOp[mediaType]);
        if (this.destroyed || generation !== this.bufferGen) return;
      }

      // A same-MIME target still needs its init, without a native retype.
      const handler = mediaType === 'video' ? 'vide' : 'soun';
      const filtered = filterInitSegment(initData, handler);
      this.logDebug('[MSE] changeType %s → %s (init=%dB, retype=%s)',
        mediaType, mimeType, filtered.byteLength, retype);
      if (retype) {
        sb.changeType!(mimeType);
        this.bufferMime[mediaType] = mimeType;
      }

      // Append the new init segment and wait for it to commit. Done
      // outside doAppend because init segments carry no tfdt/trun and
      // must skip the timeline-overlap path.
      const init = this.runMutation(mediaType, 'init-append', () => buffer.appendBuffer(filtered.buffer as ArrayBuffer));
      await this.waitForBufferEvent(buffer, init);
      if (this.destroyed || generation !== this.bufferGen) return;

      // Init defaults can differ even when the MIME is unchanged.
      const trexMap = readTrexDefaults(filtered);
      const trex = Array.from(trexMap.values())[0];
      if (mediaType === 'video') this.videoTrex = trex;
      else this.audioTrex = trex;

      // Refresh init summary so failure dumps reflect the current codec.
      const boxes = describeBoxes(filtered);
      const summary = `codec=${codec} bytes=${filtered.byteLength} (post-changeType) boxes=[${boxes}]`;
      if (mediaType === 'video') this.videoInitSummary = summary;
      else this.audioInitSummary = summary;

      // Preserve timestampOffset: the caller owns timeline placement, including
      // any rebasing needed by a custom pipeline or a discontinuity.

      // Drop the per-track overlap indexes; the retired track's entries are
      // dead weight, and a later switch back to it starts a fresh index.
      const timelines = mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
      if (!hold) {
        timelines.clear();
        this.lateAppendFloor[mediaType].clear();
      }
    } finally {
      if (generation === this.bufferGen) this.changingType[mediaType] = false;
    }

    // Resume normal append flow for anything queued during the change.
    this.drainQueue(mediaType);

    // changeType() can pause the video element (browser behavior varies).
    // Re-trigger play through the owned lifecycle so a late codec switch cannot
    // restart a player that has been paused (intent withdrawn) or destroyed.
    this.resumePlayback();
  }

  /**
   * Wait for the mutation to end; only `update` witnesses successful completion.
   * Error and abort also terminate with `updateend` (MSE §5.4).
   */
  private waitForBufferEvent(buffer: SourceBuffer, operation: BufferOperation | null): Promise<void> {
    if (operation) {
      const generation = this.bufferGen;
      return new Promise<void>((resolve, reject) => {
        const onTerminal = () => {
          if (this.destroyed || generation !== this.bufferGen) resolve();
          else if (operation.errored) reject(new Error('SourceBuffer error during changeType'));
          else if (operation.aborted) reject(new Error('SourceBuffer abort during changeType'));
          else if (!operation.succeeded) reject(new Error('SourceBuffer ended without success during changeType'));
          else resolve();
        };
        if (operation.ended) onTerminal();
        else (operation.terminalWaiters ??= new Set()).add(onTerminal);
      });
    }
    // External native mutations have no adapter-owned operation.
    return new Promise<void>((resolve, reject) => {
      let succeeded = false;
      let failure: Error | undefined;
      const onUpdate = () => { succeeded = true; };
      const onErr = () => { failure = new Error('SourceBuffer error during changeType'); };
      const onAbort = () => { failure = new Error('SourceBuffer abort during changeType'); };
      const onEnd = () => {
        buffer.removeEventListener('update', onUpdate);
        buffer.removeEventListener('updateend', onEnd);
        buffer.removeEventListener('error', onErr);
        buffer.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else if (!succeeded) reject(new Error('SourceBuffer ended without success during changeType'));
        else resolve();
      };
      buffer.addEventListener('update', onUpdate);
      buffer.addEventListener('updateend', onEnd);
      buffer.addEventListener('error', onErr);
      buffer.addEventListener('abort', onAbort);
    });
  }

  /**
   * The timestamp offset in force for a SourceBuffer, or undefined when that
   * buffer does not exist yet. Lets a caller that retains an ongoing timeline
   * across {@link changeType} restore the offset this method reports.
   */
  getTimestampOffset(mediaType: 'video' | 'audio'): number | undefined {
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    return buffer ? buffer.timestampOffset : undefined;
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
      if (!this.bufferBusy(mediaType, buffer)) {
        buffer.timestampOffset = offset;
      }
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  endOfStream(): void {
    if (this.ms.readyState !== 'open') return;
    this.endRequested = true;
    this.finishEndOfStream();
  }

  getVideoPlaybackQuality(): Readonly<VideoPlaybackQualityStats> | null {
    if (this.destroyed || !this._attached || !this.videoBuffer) return null;
    try {
      // A latched sourceopen does not prove the element still belongs to us.
      if (this.ms.readyState === 'closed') return null;
      if (this.selectedAttachment === 'src-object') {
        if (this.video.srcObject !== this.ms) return null;
      } else if (this.video.srcObject != null || this.video.src !== this.objectUrl
          || (this.video.currentSrc && this.video.currentSrc !== this.objectUrl)) return null;
      let ownsVideo = false;
      for (let i = 0; i < this.ms.sourceBuffers.length; i++) {
        if (this.ms.sourceBuffers[i] === this.videoBuffer) { ownsVideo = true; break; }
      }
      if (!ownsVideo) return null;
      const quality = this.video.getVideoPlaybackQuality?.();
      if (!quality) return null;
      const { totalVideoFrames, droppedVideoFrames, creationTime } = quality;
      if (!Number.isSafeInteger(totalVideoFrames) || totalVideoFrames < 0 || totalVideoFrames > 0xffffffff
          || !Number.isSafeInteger(droppedVideoFrames) || droppedVideoFrames < 0 || droppedVideoFrames > totalVideoFrames
          || !Number.isFinite(creationTime) || creationTime < 0) return null;
      return Object.freeze({ totalVideoFrames, droppedVideoFrames,
        displayedVideoFrames: totalVideoFrames - droppedVideoFrames, creationTimeMs: creationTime });
    } catch { return null; }
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
   * Get the committed group floor for a media type and source identity.
   * Returns undefined if no group has been committed yet.
   */
  getCommittedGroupFloor(mediaType: 'video' | 'audio', trackName: string, sourceKey?: string): bigint | undefined {
    return this.committedGroupFloor.get(`${mediaType}:${mediaTrackIdentity(trackName, sourceKey)}`);
  }

  /**
   * Clear a specific track's timeline index.
   * Called on decode-time discontinuity so old ranges don't cause
   * overlap drops on segments from the new epoch. Scoped to the
   * affected track — other tracks (e.g., during ABR switch) keep
   * their overlap protection intact.
   */
  clearTimeline(mediaType: 'video' | 'audio', trackName: string, sourceKey?: string): void {
    this.endRequested = false;
    const generation = this.bufferGen;
    const trackIdentity = mediaTrackIdentity(trackName, sourceKey);
    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;
    if (this.appendGapWait[mediaType]?.entry.trackIdentity === trackIdentity) this.clearAppendGap(mediaType);
    this.lateAppendFloor[mediaType].delete(trackIdentity);
    this.clearReceivingGroups(mediaType, trackIdentity);
    this.clearVideoHoleEvidence(); this.handleWatchdogSeeked();
    // The assembler notifies after delivering the rebased restart segment.
    // Keep accepted media, including that segment, and reset only its wait/index.
    for (const entry of queue) if (entry.trackIdentity === trackIdentity) {
      delete entry.waitUntil; delete entry.waitStartedAt; delete entry.skipsGap;
    }
    const timelines = mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
    timelines.delete(trackIdentity);
    if (mediaType === 'video' && this.pendingVideoTrackIdentity === trackIdentity) {
      this.pendingVideoRanges = []; this.pendingVideoTrackName = null; this.pendingVideoGroupId = undefined;
      this.pendingVideoTrackIdentity = null;
      this.pendingGapSkip.video = false;
    } else if (mediaType === 'audio' && this.pendingAudioTrackIdentity === trackIdentity) {
      this.pendingAudioRanges = []; this.pendingAudioTrackName = null; this.pendingAudioGroupId = undefined;
      this.pendingAudioTrackIdentity = null;
      this.pendingGapSkip.audio = false;
    }
    if (!this.destroyed && generation === this.bufferGen) this.drainQueue(mediaType);
  }

  reset(): void {
    const revision = ++this.resourceRevision;
    this.retireSeek();
    if (this.resourceRevision !== revision) return;
    this.seekResource = null;
    this.resetBuffers();
  }

  private resetBuffers(): void {
    // Cancel any in-flight startup FIRST: a late seeked/play from the
    // superseded generation must not resurrect playback against new buffers.
    this.cancelStartup();
    if (this.sourceOpenListener) {
      this.ms.removeEventListener('sourceopen', this.sourceOpenListener);
      this.sourceOpenListener = null;
    }
    this.diag('reset (buffer generation %d → %d)', this.bufferGen, this.bufferGen + 1);
    this.bufferGen++;
    this.appendQueueHold = null;
    this.clearAppendGap('video'); this.clearAppendGap('audio');
    this.clearReceivingGroups('video'); this.clearReceivingGroups('audio');
    this.clearVideoHoleEvidence(); this.handleWatchdogSeeked(); this.wedgeLastQuality = null;
    this.wedgeLastTime = null; this.wedgeFrozenSinceMs = null;
    this.lateAppendFloor.video.clear(); this.lateAppendFloor.audio.clear();
    this.pendingGapSkip.video = false; this.pendingGapSkip.audio = false;
    this.endRequested = false;
    // New session: stale facts must never join a later summary.
    this.startupFacts = { session: this.bufferGen, startPosition: null, seekOutcome: null, playTimeSec: null };
    this.startupReported = false;
    let tokens = this.cancelBufferOps('reset');
    tokens = this.queuedTokens(this.videoQueue, tokens);
    tokens = this.queuedTokens(this.audioQueue, tokens);
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
    this.bufferMime.video = null;
    this.bufferMime.audio = null;
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
    this.initialized = false;
    this._attached = false;
    this.preInitDropLogged = false;
    // Timeline-owned append state.
    this.videoTimelines.clear();
    this.audioTimelines.clear();
    this.committedGroupFloor.clear();
    this.pendingVideoRanges = [];
    this.pendingAudioRanges = [];
    this.pendingVideoTrackName = null;
    this.pendingAudioTrackName = null;
    this.pendingVideoTrackIdentity = null;
    this.pendingAudioTrackIdentity = null;
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
    // Gap-jump state: quality switches / MediaSource reconstruction must
    // clear the armed candidate, episode, and rate-limit history.
    this.disarmGap();
    this.gapStallEpisode = false;
    this.gapEpisodeTicks = 0;
    this.retireGapLanding();
    this.lastGapJumpAtMs = Number.NEGATIVE_INFINITY;
    this.discardTokens(tokens, this.destroyed ? 'destroyed' : 'decoder reset');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancelStallEpisode();
    this.diag('destroy');
    this.destroyed = true;
    this.cancelStartup();
    if (this.wedgeTimer !== null) {
      clearInterval(this.wedgeTimer);
      this.wedgeTimer = null;
    }
    this.onWedge = null;
    this.onGapJump = null;
    this.video.removeEventListener('playing', this.handlePlaying);
    this.video.removeEventListener('waiting', this.handleWaiting);
    this.video.removeEventListener('seeking', this.handleWatchdogSeek);
    this.video.removeEventListener('pause', this.handleCoveredPositionPause);
    this.video.removeEventListener('seeked', this.handleWatchdogSeeked);
    this.video.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.video.removeEventListener('error', this.handleVideoError);
    this.video.removeEventListener('encrypted', this.handleEncrypted);
    for (const session of this.keySessions.keys()) this.retireKeySession(session);
    this.mediaKeys = null;
    // Leave the attachment available for a compatible reconnect. Temporary
    // sessions are closed; no old license work survives the adapter.
    this.reset();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.video.removeAttribute('src');
    (this.video as any).srcObject = null;
    this.video.load();
    this.onFirstFrame = null;
    this.onAttached = null;
    this.onError = null;
    this.onStall = null;
    this.onStallRecovered = null;
  }

  // ─── EME / DRM ─────────────────────────────────────────────────

  /**
   * Asynchronously set up MediaKeys on the video element. Fire-and-forget
   * from the constructor — EME is transparent to MSE once configured; the
   * browser enqueues encrypted frames until keys are available.
   */
  private async setupMediaKeys(drm: DrmConfig, state: DrmElementState): Promise<void> {
    if (this.destroyed) return;
    const keySystem = drm.keySystem ?? 'com.widevine.alpha';
    try {
      await state.ready;
      if (this.destroyed) return;
      // An arbitrary MediaKeys object does not expose its key system. Only
      // reuse an attachment whose configuration we established ourselves.
      if (state.keys && this.video.mediaKeys === state.keys
          && state.keySystem === keySystem
          && equalDrmBytes(state.certificate, drm.serverCertificate)) {
        this.mediaKeys = state.keys;
        return;
      }
      const access = await navigator.requestMediaKeySystemAccess(keySystem, [{
        initDataTypes: ['cenc'],
        videoCapabilities: [
          { contentType: 'video/mp4; codecs="avc1.640028"', robustness: '' },
          { contentType: 'video/mp4; codecs="avc3.640028"', robustness: '' },
        ],
        audioCapabilities: [
          { contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: '' },
        ],
      }]);
      if (this.destroyed) return;
      const keys = await access.createMediaKeys();
      if (this.destroyed) return;
      if (drm.serverCertificate) {
        await keys.setServerCertificate(new Uint8Array(drm.serverCertificate).buffer);
        if (this.destroyed) return;
      }
      const attach = state.ready.then(async () => {
        if (this.destroyed) return;
        await this.video.setMediaKeys(keys);
        // setMediaKeys cannot be cancelled. Record the completed attachment for
        // the next queued owner even if this adapter was destroyed meanwhile.
        state.keys = keys;
        state.keySystem = keySystem;
        state.certificate = drm.serverCertificate;
        if (!this.destroyed) this.mediaKeys = keys;
      });
      // A failed attachment must not poison the next owner's queue. Permission
      // requests are not queued: a retired prompt may never finish.
      state.ready = attach.catch(() => {});
      await attach;
    } catch (err) {
      this.reportDrmError('setup', err);
    }
  }

  /**
   * Handle the 'encrypted' event on the video element. Fired when the
   * browser encounters PSSH in an init segment. Creates a key session
   * and fetches the license from the configured server.
   */
  private handleEncrypted = async (event: MediaEncryptedEvent): Promise<void> => {
    if (this.destroyed || !this.drmConfig || !event.initData) return;
    const initData = new Uint8Array(event.initData).slice();
    let session: MediaKeySession | null = null;
    try {
      await this.mediaKeysReady;
      if (this.destroyed || !this.mediaKeys) return;
      for (const state of this.keySessions.values()) {
        if (state.initDataType === event.initDataType && equalDrmBytes(state.initData, initData)) return;
      }
      session = this.mediaKeys.createSession('temporary');
      this.keySessions.set(session, {
        initDataType: event.initDataType, initData, abort: new AbortController(),
      });
      session.addEventListener('message', this.handleKeyMessage);
      const ownedSession = session;
      void session.closed.then(() => this.retireKeySession(ownedSession, false));
      await session.generateRequest(event.initDataType, initData);
    } catch (err) {
      if (session && !this.keySessions.has(session)) return;
      if (session) this.retireKeySession(session);
      this.reportDrmError('session', err);
    }
  };

  /**
   * Handle license request from the CDM. POST the challenge to the
   * license server and feed the response back to the session.
   */
  private handleKeyMessage = async (event: MediaKeyMessageEvent): Promise<void> => {
    const session = event.target as MediaKeySession;
    const state = this.keySessions.get(session);
    if (!this.drmConfig || !state || this.destroyed) return;
    const live = (): boolean => !this.destroyed && this.keySessions.get(session) === state;
    try {
      const response = await fetch(this.drmConfig.licenseUrl, {
        method: 'POST',
        body: event.message,
        signal: state.abort.signal,
      });
      if (!live()) return;
      if (!response.ok) {
        throw new Error(`License server returned ${response.status} ${response.statusText}`);
      }
      const license = await response.arrayBuffer();
      if (!live()) return;
      await session.update(new Uint8Array(license));
    } catch (err) {
      if (!live()) return;
      this.retireKeySession(session);
      this.reportDrmError('license', err);
    }
  };

  private retireKeySession(session: MediaKeySession, close = true): void {
    const state = this.keySessions.get(session);
    if (!state) return;
    this.keySessions.delete(session);
    session.removeEventListener('message', this.handleKeyMessage);
    state.abort.abort();
    if (close) {
      try { void session.close().catch(() => {}); } catch { /* Already closed by the CDM. */ }
    }
  }

  private reportDrmError(stage: string, err: unknown): void {
    if (this.destroyed) return;
    const error = err instanceof Error ? err : new Error(`DRM ${stage} failed: ${String(err)}`);
    try { this.onError?.(error); } catch { /* Do not reject an asynchronous event handler. */ }
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Drain queued chunks after SourceBuffer updateend. */
  private drainQueue(mediaType: 'video' | 'audio'): void {
    const generation = this.bufferGen;
    const buffer = mediaType === 'video' ? this.videoBuffer : this.audioBuffer;
    const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;

    // While a changeType is in flight for this media type, leave the
    // queue parked. The changeType handler resumes draining itself
    // once the format-change + init append is committed.
    if (this.changingType[mediaType] || this.appendQueueHold?.types.has(mediaType)) return;

    if (!buffer || this.bufferBusy(mediaType, buffer) || queue.length === 0) {
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
      if (triggerHere && buffer && !this.bufferBusy(mediaType, buffer)) {
        void this.requestStartup().catch(() => { /* contained */ });
      }
      this.finishEndOfStream();
      return;
    }

    while (queue.length > 0 && !this.bufferBusy(mediaType, buffer) && !this.changingType[mediaType]
        && !this.appendQueueHold?.types.has(mediaType)) {
      const index = this.nextAppendIndex(mediaType, queue);
      const entry = queue[index]!;
      if (entry.groupId !== undefined) {
        const floor = this.committedGroupFloor.get(`${mediaType}:${entry.trackIdentity}`);
        if (floor !== undefined && entry.groupId < floor) {
          queue.splice(index, 1);
          if (this.appendGapWait[mediaType]?.entry === entry) this.clearAppendGap(mediaType);
          this.appendOutcome(entry.token, 'discarded', 'stale group');
          if (this.destroyed || generation !== this.bufferGen) return;
          continue;
        }
      }
      if (this.holdAppendGap(mediaType, entry)) return;
      if (this.maybeEvictBackBuffer(mediaType, buffer)) return;
      queue.splice(index, 1);
      if (this.appendGapWait[mediaType]?.entry === entry) this.clearAppendGap(mediaType);
      this.doAppend(mediaType, buffer, entry);
      if (this.destroyed || generation !== this.bufferGen) return;
    }
    this.finishEndOfStream();
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

  private bufferBusy(mediaType: 'video' | 'audio', buffer: SourceBuffer): boolean {
    return buffer.updating || this.inFlightOp[mediaType] !== null;
  }

  /** Record a mutation's start; completion is observed by the buffer lifecycle. */
  private markBufferOp(mediaType: 'video' | 'audio', cause: BufferOpCause, token?: MediaAppendToken): BufferOperation {
    const id = ++this.opSeq;
    const operation: BufferOperation = token === undefined ? { id, cause } : { id, cause, token };
    this.inFlightOp[mediaType] = operation;
    this.diag('mutation-start op=%d %s %s', id, mediaType, cause);
    return operation;
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
    mediaType: 'video' | 'audio', cause: BufferOpCause, mutate: () => void, token?: MediaAppendToken,
  ): BufferOperation {
    const operation = this.markBufferOp(mediaType, cause, token);
    try {
      mutate();
    } catch (err) {
      this.failBufferOp(mediaType, operation, err);
      throw err;
    }
    return operation;
  }

  private finishBufferOp(operation: BufferOperation): void {
    operation.ended = true;
    const waiters = operation.terminalWaiters;
    delete operation.terminalWaiters;
    if (waiters) for (const waiter of waiters) waiter();
  }

  /**
   * Cancel any in-flight operations, recording each as terminally cancelled.
   * The buffers they targeted are superseded, so their eventual `updateend`
   * arrives with no current operation — without this record the chronology
   * would show an operation that simply stops.
   */
  private cancelBufferOps(reason: string): Set<MediaAppendToken> | undefined {
    let tokens: Set<MediaAppendToken> | undefined;
    for (const mediaType of ['video', 'audio'] as const) {
      const op = this.inFlightOp[mediaType];
      if (!op) continue;
      this.inFlightOp[mediaType] = null;
      this.finishBufferOp(op);
      if (op.token && this.appendObservers) (tokens ??= new Set()).add(op.token);
      this.diag('mutation-cancelled op=%d %s %s reason=%s', op.id, mediaType, op.cause, reason);
    }
    return tokens;
  }

  /** Record that a mutation threw synchronously, so no completion will follow. */
  private failBufferOp(mediaType: 'video' | 'audio', operation: BufferOperation, err: unknown): void {
    if (this.inFlightOp[mediaType] === operation) this.inFlightOp[mediaType] = null;
    operation.errored = true;
    this.finishBufferOp(operation);
    this.diag('mutation-sync-failure op=%d %s: %s', operation.id, mediaType,
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
    buffer.addEventListener('update', () => {
      if (this.isSuperseded(mediaType, buffer, gen)) return;
      const operation = this.inFlightOp[mediaType];
      // This bit also protects normal replay bookkeeping: an ended operation
      // without positive success evidence must not manufacture committed media.
      if (operation) operation.succeeded = true;
    });
    buffer.addEventListener('abort', () => {
      if (this.isSuperseded(mediaType, buffer, gen)) return;
      const operation = this.inFlightOp[mediaType];
      if (operation) operation.aborted = true;
      // MSE §5.2 / §5.4: abort also queues updateend. Its pending ranges were
      // not a completed append and must not become replay-suppression knowledge.
      this.appendErrored[mediaType] = true;
      if (mediaType === 'video') this.pendingVideoRanges = [];
      else this.pendingAudioRanges = [];
    });
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
      if (this.destroyed || this.seekResource || !this.playbackIntent || this.playTriggered || this.startupPhase !== 'idle') return;
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
    const source = this.ms;
    await this.video.play();
    if (this.startupLive(generation)) return true;
    // Withdrawn/destroyed while the promise was pending: the element started
    // anyway. Undo it — this is the late-playback hole a generation check alone
    // cannot close.
    if (this.ms === source && this.video.paused === false) this.video.pause();
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
      () => {
        const nowMs = performance.now();
        // Gap-jump first: the wedge detector structurally ignores the
        // at-a-hole case (aheadSec is computed only within the containing
        // range), so the two never race for the same playhead state.
        this.checkGapJump(nowMs);
        this.checkPlayheadWedge(nowMs);
      },
      MseMediaSource.WEDGE_CHECK_INTERVAL_MS,
    );
  }

  // ─── Buffered-hole gap-jump ──────────────────────────────────────

  /** Drop the armed hole candidate (wait restarts on the next sighting). */
  private disarmGap(): void {
    this.gapCandidate = null;
    this.gapLastPlayheadTime = null;
    this.gapLastQuality = null;
  }

  /** Retire the post-jump landing transaction INCLUDING any stall evidence
   *  it transferred — intentional pause/seek must leave nothing armed. */
  private retireGapLanding(): void {
    if (this.gapStallFromLanding) {
      // Intentional pause/seek: abandon the whole episode, timer included, so
      // nothing is left armed to fire against superseded playback.
      this.cancelStallEpisode();
      this.gapStallFromLanding = false;
    }
    this.gapLanding = null;
  }

  private hasPendingNativeWork(): boolean {
    return this.videoQueue.length > 0 || this.audioQueue.length > 0
      || this.inFlightOp.video !== null || this.inFlightOp.audio !== null
      || this.videoBuffer?.updating === true || this.audioBuffer?.updating === true
      || this.changingType.video || this.changingType.audio;
  }

  /**
   * Detect a playhead frozen at a buffered hole and, after a bounded wait,
   * seek just past it. Holes wider than GAP_JUMP_MAX_HOLE_SEC never jump;
   * if one persists GAP_WIDE_HOLE_FATAL_MS it escalates exactly once via
   * onError with name 'MediaGapUnrecoverableError' (the same name-based
   * fatal channel as the wedge ladder's final rung — the app rebuilds).
   *
   * Commit-before-publish discipline throughout: state is finalized before
   * any callback runs, so throwing or re-entrant listeners cannot skip the
   * seek, double-jump, or re-emit the escalation.
   */
  private checkGapJump(nowMs: number): void {
    const generation = this.bufferGen;
    // Landing cancellation FIRST — before the episode fallback can transfer
    // any landing-owned evidence. Pause / element-error / withdrawn intent
    // retire the transaction; `seeking` retires it ONLY when the seek is
    // not our own: the adapter's landing seek reports currentTime at the
    // landing target while pending, so a seek away from the target is a
    // user seek (user intent wins), while our own never-settling seek is
    // precisely the failure the landing deadline exists to bound.
    if (this.gapLanding !== null) {
      // Seek ownership must survive the transient `seeking` flag: a normal
      // user seek settles well inside the 1 s cadence, so the POSITION is
      // the durable signal. A playhead materially BEHIND the landing target
      // is a superseding user seek whether or not `seeking` is still true
      // (our own pending seek reports currentTime AT the target; forward
      // movement past the target resolves as success below).
      const behindTarget = this.video.currentTime
        < this.gapLanding.to - MseMediaSource.GAP_MOVE_TOLERANCE_SEC;
      const seekIsOurs = this.video.seeking
        && Math.abs(this.video.currentTime - this.gapLanding.to)
           <= MseMediaSource.GAP_MOVE_TOLERANCE_SEC;
      if (this.video.paused || this.video.error !== null || !this.playbackIntent
          || behindTarget || (this.video.seeking && !seekIsOurs)) {
        this.retireGapLanding();
      }
    }

    // Episode-tick fallback: an undecodable landing must not mute stall
    // reporting forever — two ticks after a jump the episode ends
    // unconditionally and freezes belong to the normal machinery. The
    // suppressed seek-generated `waiting` (browsers need not emit another
    // for the same uninterrupted freeze) is the only stall evidence; hand
    // it back to the stall detector when the episode expires — evidence
    // stays OWNED by the landing (gapStallFromLanding) so retirement can
    // reclaim it.
    if (this.gapStallEpisode && ++this.gapEpisodeTicks >= 2) {
      this.gapStallEpisode = false;
      if (this.gapLanding !== null && this.gapLanding.waitingAtMs !== null
          && this.stallStartTime === null) {
        this.stallStartTime = this.gapLanding.waitingAtMs;
        this.gapStallFromLanding = true;
      }
    }

    // Landing watch: independent of wedge eligibility, a jump whose landing
    // never produces organic progress reaches a bounded fatal outcome.
    if (this.gapLanding !== null && !this.gapLanding.spent) {
      if (this.video.currentTime > this.gapLanding.to + MseMediaSource.GAP_MOVE_TOLERANCE_SEC) {
        this.gapLanding = null;                                        // landed successfully
      } else if (nowMs - this.gapLanding.jumpedAtMs >= MseMediaSource.GAP_WIDE_HOLE_FATAL_MS) {
        this.gapLanding.spent = true;                                  // committed BEFORE publish
        const err = new Error(
          `[MSE] gap-jump landing failed: no playback progress past `
          + `t=${this.gapLanding.to.toFixed(2)}s since the jump — MediaSource rebuild required`,
        );
        err.name = 'MediaGapUnrecoverableError';
        try {
          this.onError?.(err);
        } catch {
          // Listener bugs must not corrupt adapter state.
        }
      }
    }

    if (this.destroyed || !this.playTriggered || this.gapJumpMs <= 0) return;
    const v = this.video;
    if (v.paused || v.seeking || v.error !== null || !this.playbackIntent) {
      this.disarmGap();
      return;
    }

    // Accepted native work can still fill the hole. Neither buffered ranges
    // nor elapsed wall time authorizes skipping that work, including finite EOS.
    if (this.hasPendingNativeWork()) {
      this.disarmGap();
      return;
    }
    const ct = v.currentTime;
    const quality = this.getVideoPlaybackQuality();
    if (this.destroyed || generation !== this.bufferGen || !this.playTriggered || !this.playbackIntent || v.paused || v.seeking) return;
    const qualityMoved = quality !== null && this.gapLastQuality !== null
      && (quality.totalVideoFrames !== this.gapLastQuality.totalVideoFrames
        || quality.droppedVideoFrames !== this.gapLastQuality.droppedVideoFrames);
    this.gapLastQuality = quality;
    // Counter movement (or reset) vetoes recovery. Unchanged counters alone do
    // not establish a freeze: the playhead, native readiness and hole must agree.
    if (qualityMoved) {
      this.gapCandidate = null;
      this.gapLastPlayheadTime = ct;
      return;
    }
    // Locate the containing range and the next range ahead.
    let curEnd: number | null = null;
    let nextStart: number | null = null;
    let nextEnd: number | null = null;
    let buffered: TimeRanges;
    try {
      buffered = v.buffered;
    } catch {
      return;
    }
    for (let i = 0; i < buffered.length; i++) {
      if (ct >= buffered.start(i) && ct <= buffered.end(i)) {
        curEnd = buffered.end(i);
        if (i + 1 < buffered.length) {
          nextStart = buffered.start(i + 1);
          nextEnd = buffered.end(i + 1);
        }
        break;
      }
    }

    // Edge holes use the combined element ranges. The narrow low-readiness
    // video-only exception below also checks both native SourceBuffers.
    const tol = MseMediaSource.GAP_IDENTITY_TOLERANCE_SEC;
    let kind: 'combined' | 'video' = 'combined';
    // A video hole can leave currentTime *inside* the gap while audio has
    // continuous coverage. Use that exact native shape only when readiness is
    // low and the audio buffer (if present) covers the landing. It shares this
    // candidate, wait, rate limit and post-seek landing watch with edge holes.
    if (curEnd === null && (v.readyState ?? 0) <= 2 && this.videoBuffer) {
      try {
        const ranges = this.videoBuffer.buffered;
        for (let i = 0; i + 1 < ranges.length; i++) {
          const end = ranges.end(i), start = ranges.start(i + 1);
          if (ct < end || ct >= start || start - end <= tol) continue;
          const landing = start + Math.min(0.01, (ranges.end(i + 1) - start) / 2);
          const audio = this.audioBuffer?.buffered;
          const audioCovered = !audio || Array.from({ length: audio.length }, (_, j) => j)
            .some(j => audio.start(j) <= ct && audio.end(j) >= landing);
          if (audioCovered) {
            curEnd = end; nextStart = start; nextEnd = ranges.end(i + 1);
            buffered = ranges; kind = 'video';
          }
          break;
        }
      } catch { /* Detached/evicted ranges cannot establish a recovery target. */ }
    }
    const holeSec = curEnd !== null && nextStart !== null ? nextStart - curEnd : 0;
    const atHole = curEnd !== null && nextStart !== null
      && (kind === 'video' || curEnd - ct < MseMediaSource.GAP_EDGE_WINDOW_SEC)
      && holeSec > tol;
    if (!atHole) {
      this.disarmGap();
      return;
    }

    // Stuck check (own state — never wedgeLastTime).
    const moved = this.gapLastPlayheadTime !== null
      && Math.abs(ct - this.gapLastPlayheadTime) > MseMediaSource.GAP_MOVE_TOLERANCE_SEC;
    this.gapLastPlayheadTime = ct;
    if (moved) {
      this.gapCandidate = null;
      return;
    }

    // Candidate identity: {curEnd, nextStart} only — a growing next-range
    // tail must not restart the wait; any real drift must.
    const c = this.gapCandidate;
    if (c === null || c.kind !== kind || Math.abs(c.curEnd - curEnd!) > tol || Math.abs(c.nextStart - nextStart!) > tol) {
      this.gapCandidate = {
        curEnd: curEnd!, nextStart: nextStart!, armedAtMs: nowMs, kind,
        wideWarned: false, spent: false,
      };
      return;
    }
    if (c.spent) return;

    // Unjumpable width: warn once; escalate once if it persists.
    // Strictly the advertised bound; 1e-9 guards float subtraction noise
    // only — the 10ms identity tolerance must never widen the policy.
    if (holeSec > MseMediaSource.GAP_JUMP_MAX_HOLE_SEC + 1e-9) {
      if (!c.wideWarned) {
        c.wideWarned = true;
        this.logWarn(
          `[MSE] gap-too-wide: ${holeSec.toFixed(2)}s buffered hole at t=${ct.toFixed(2)}s `
          + `exceeds the ${MseMediaSource.GAP_JUMP_MAX_HOLE_SEC}s jump bound — not skipping`,
        );
      }
      if (nowMs - c.armedAtMs >= MseMediaSource.GAP_WIDE_HOLE_FATAL_MS) {
        c.spent = true;                                    // committed BEFORE publish
        const err = new Error(
          `[MSE] unrecoverable buffered hole (${holeSec.toFixed(2)}s) at `
          + `t=${ct.toFixed(2)}s — MediaSource rebuild required`,
        );
        err.name = 'MediaGapUnrecoverableError';
        try {
          this.onError?.(err);
        } catch {
          // Listener bugs must not corrupt adapter state.
        }
      }
      return;
    }

    // Jumpable: wait + rate limit.
    if (nowMs - c.armedAtMs < this.gapJumpMs) return;
    if (nowMs - this.lastGapJumpAtMs < MseMediaSource.GAP_JUMP_MIN_INTERVAL_MS) return;

    // Re-validate the landing at jump time (the tail may have grown; the
    // range must be nonempty).
    if (nextEnd === null || nextEnd - nextStart! <= tol) {
      this.disarmGap();
      return;
    }
    const to = nextStart! + Math.min(0.01, (nextEnd - nextStart!) / 2);
    const info: GapJumpInfo = {
      from: ct,
      to,
      holeSec,
      waitedMs: nowMs - c.armedAtMs,
      bufferedRanges: fmtRanges(buffered),
    };
    const stallDur = nowMs - (this.stallStartTime ?? c.armedAtMs);

    // Commit first…
    this.gapCandidate = null;
    this.gapLastPlayheadTime = null;
    this.gapLastQuality = null;
    this.lastGapJumpAtMs = nowMs;
    // The jump reports its own `media-gap` stall below; retire the ordinary
    // episode wholesale rather than leaving its timer armed.
    this.cancelStallEpisode();
    this.gapStallEpisode = true;
    this.gapEpisodeTicks = 0;
    this.gapLanding = { to, jumpedAtMs: nowMs, waitingAtMs: null, spent: false };

    // …seek…
    v.currentTime = to;
    this.noteSelfSeek();

    // …publish last (no adapter work after these).
    try {
      this.onStall?.(stallDur, 'media-gap');
    } catch { /* listener bug — state already committed */ }
    try {
      this.onGapJump?.(info);
    } catch { /* listener bug */ }
    this.logWarn(
      `[MSE] gap-jump: skipped ${holeSec.toFixed(2)}s hole `
      + `${info.from.toFixed(2)}s -> ${info.to.toFixed(2)}s after ${info.waitedMs.toFixed(0)}ms`,
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
   * A crossed hole wider than the jump bound permits only a same-position
   * nudge. Continued freeze reaches rung 4 after the normal landing deadline;
   * neither the pulse nor the forward-seek rungs apply to that episode.
   *
   * A seek WE perform must not read as recovery — wedgeLastTime is
   * re-stamped after each action, so only ORGANIC playhead movement
   * resets the ladder.
   */
  private checkPlayheadWedge(nowMs: number): void {
    if (this.destroyed || !this.playTriggered) return;
    const v = this.video;
    const ct = v.currentTime;
    const ownSeek = this.wedgeSeekTarget !== null
      && Math.abs(ct - this.wedgeSeekTarget) <= MseMediaSource.GAP_MOVE_TOLERANCE_SEC;
    const generation = this.bufferGen;
    const quality = this.getVideoPlaybackQuality();
    if (this.destroyed || generation !== this.bufferGen) return;
    const qualityMoved = quality !== null && this.wedgeLastQuality !== null
      && (quality.totalVideoFrames !== this.wedgeLastQuality.totalVideoFrames
        || quality.droppedVideoFrames !== this.wedgeLastQuality.droppedVideoFrames);
    const qualityReset = quality !== null && this.wedgeLastQuality !== null
      && (quality.totalVideoFrames < this.wedgeLastQuality.totalVideoFrames
        || quality.droppedVideoFrames < this.wedgeLastQuality.droppedVideoFrames);
    this.wedgeLastQuality = quality;

    if (qualityReset) {
      this.clearVideoHoleEvidence(); this.handleWatchdogSeeked();
      this.wedgeLastTime = null;
      this.wedgeFrozenSinceMs = null;
      this.wedgeRung = 0;
      return;
    }
    // Counter progress always vetoes recovery on this sample. A crossing
    // interval has no frame timestamps, so it may record potential traversal.
    // Retire it on later progress whose interval starts in its successor range.
    if (quality === null || v.paused || (v.seeking && !ownSeek) || !this.playbackIntent
        || v.error !== null || v.ended || this.wedgeLastTime !== null && ct < this.wedgeLastTime) {
      this.clearVideoHoleEvidence();
    }

    // Organic clock movement resets the freeze deadline, but one observed hole
    // may span several samples before the clock finally freezes after it.
    const from = this.wedgeLastTime;
    if (from === null || ct !== from) {
      const witness = from === null || quality === null || v.paused
        || (v.seeking && !ownSeek) || !this.playbackIntent
        ? null : this.observeVideoHole(from, ct);
      if (this.destroyed || generation !== this.bufferGen) return;
      this.wedgeVideoHole = qualityMoved && witness !== null && from !== null && from >= witness.start ? null : witness;
      // Observe the old covered point before replacing it with an upper-range
      // point. The upper range may arrive after playback left the lower one.
      if (quality !== null && !v.paused && !v.seeking && this.playbackIntent
          && v.error === null && !v.ended) this.rememberCoveredVideoPosition(ct);
      this.handleWatchdogSeeked();
      this.wedgeLastTime = ct;
      this.wedgeFrozenSinceMs = null;
      this.wedgeRung = 0;
      return;
    }
    this.wedgeVideoHole = this.observeVideoHole(ct, ct);
    if (qualityMoved) {
      if (this.wedgeVideoHole !== null && from >= this.wedgeVideoHole.start) this.clearVideoHoleEvidence();
      this.handleWatchdogSeeked();
      this.wedgeFrozenSinceMs = null;
      this.wedgeRung = 0;
      return;
    }
    // Accepted work vetoes recovery while pending. Its completion alone does
    // not repair a witnessed video hole: revalidate the actual buffers/ranges
    // and continue sampling clock/quality progress through the pending period.
    if (this.hasPendingNativeWork()) {
      this.wedgeFrozenSinceMs = null;
      this.handleWatchdogSeeked();
      return;
    }
    const hole = this.wedgeVideoHole;
    const wideHole = hole !== null && hole.start - hole.end > MseMediaSource.GAP_JUMP_MAX_HOLE_SEC;
    if (wideHole && (v.ended || v.error !== null || this.appendQueueHold !== null)) {
      this.wedgeFrozenSinceMs = null;
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
    let postHole = false;
    if (this.gapJumpMs > 0 && hole !== null && quality !== null && ((v.readyState ?? 0) === 2 || wideHole)) {
      postHole = this.hasPostHoleCoverage(ct, wideHole);
      if (!postHole) { this.clearVideoHoleEvidence(); this.handleWatchdogSeeked(); }
    }
    if (v.paused || (v.seeking && !ownSeek) || !this.playbackIntent || (wideHole && (!postHole || (v.readyState ?? 0) < 2))
        || ((v.readyState ?? 0) < 3 && !postHole) || aheadSec <= 1) {
      this.wedgeFrozenSinceMs = null;
      return;
    }

    if (this.wedgeFrozenSinceMs === null) {
      this.wedgeFrozenSinceMs = nowMs;
      return;
    }
    if (nowMs - this.wedgeFrozenSinceMs < MseMediaSource.WEDGE_FROZEN_MS) return;
    if (this.wedgeRung >= 4) return; // exhausted — error already surfaced
    if (wideHole && nowMs - this.lastGapJumpAtMs < (this.wedgeRung === 0
        ? MseMediaSource.GAP_JUMP_MIN_INTERVAL_MS : MseMediaSource.GAP_WIDE_HOLE_FATAL_MS)) return;

    const rung = wideHole && this.wedgeRung > 0 ? 4 : this.wedgeRung + 1;
    if (!wideHole) this.wedgeRung = rung;

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
    try { this.onWedge?.(info); } catch { /* Diagnostics must not stop recovery. */ }
    // A diagnostics callback can retire media or expose fresh output. Recheck
    // both native targets and the freeze before resetting every decoder.
    const currentQuality = wideHole ? this.getVideoPlaybackQuality() : quality;
    if (this.destroyed || generation !== this.bufferGen || !this.playbackIntent
        || v.paused || v.currentTime !== ct || this.wedgeLastTime !== ct || this.hasPendingNativeWork()) return;
    if (wideHole && (v.ended || v.error !== null || (v.seeking && !ownSeek) || this.appendQueueHold !== null
        || this.wedgeVideoHole !== hole || !this.hasPostHoleCoverage(ct, true)
        || currentQuality === null || currentQuality.totalVideoFrames !== quality!.totalVideoFrames
        || currentQuality.droppedVideoFrames !== quality!.droppedVideoFrames)) {
      this.wedgeFrozenSinceMs = null;
      return;
    }
    if (wideHole) this.wedgeRung = rung;

    switch (rung) {
      case 1: { // gentle nudge inside the containing range (hls.js-classic)
        const target = wideHole ? ct : Math.min(ct + 0.1, ct + aheadSec - 0.05);
        if (wideHole) this.lastGapJumpAtMs = nowMs;
        if (wideHole || target > ct) { this.seekForWedge(target); }
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
        if (target > ct) { this.seekForWedge(target); }
        break;
      }
      case 4: {
        // Named error so @openmoq/player can distinguish "rebuild required"
        // from ordinary (degraded) decode errors and escalate to FATAL.
        const err = new Error(
          `playhead wedge unrecoverable: frozen at t=${ct.toFixed(2)} with `
          + `${aheadSec.toFixed(1)}s buffered ahead (readyState=${v.readyState}) `
          + `after ${wideHole ? 'same-position seek' : 'nudge/pulse/seek'} — MediaSource rebuild required`,
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

  private clearVideoHoleEvidence(): void {
    this.wedgeVideoHole = null;
    this.wedgeCoveredPosition = null;
  }

  private rememberCoveredVideoPosition(time: number): void {
    const videoBuffer = this.videoBuffer, audioBuffer = this.audioBuffer, generation = this.bufferGen;
    if (!videoBuffer || !Number.isFinite(time)) { this.wedgeCoveredPosition = null; return; }
    try {
      const ranges = videoBuffer.buffered;
      for (let i = 0; i < ranges.length; i++) {
        if (time < ranges.start(i) || time > ranges.end(i)) continue;
        if (!this.destroyed && generation === this.bufferGen && videoBuffer === this.videoBuffer
            && audioBuffer === this.audioBuffer) {
          this.wedgeCoveredPosition = { time, generation, videoBuffer, audioBuffer };
        }
        return;
      }
    } catch { this.wedgeCoveredPosition = null; }
  }

  private hasPostHoleCoverage(ct: number, requireAudio: boolean): boolean {
    const hole = this.wedgeVideoHole;
    if (hole === null || this.observeVideoHole(ct, ct) !== hole) return false;
    try {
      const ranges = this.videoBuffer?.buffered, audio = this.audioBuffer?.buffered;
      return ranges !== undefined && Array.from({ length: ranges.length }, (_, i) => i).some(i =>
        ranges.start(i) === hole.start && ranges.start(i) <= ct && ranges.end(i) - ct > 1)
        && ((!requireAudio && !audio) || (audio !== undefined && Array.from({ length: audio.length }, (_, i) => i)
          .some(i => audio.start(i) <= ct && audio.end(i) - ct > 1)));
    } catch { return false; /* Detached/evicted native media cannot justify a seek. */ }
  }

  private observeVideoHole(from: number, to: number): typeof this.wedgeVideoHole {
    const videoBuffer = this.videoBuffer, audioBuffer = this.audioBuffer;
    if (this.gapJumpMs === 0 || to < from || !videoBuffer) return null;
    try {
      const ranges = videoBuffer.buffered, audio = audioBuffer?.buffered;
      const prior = this.wedgeVideoHole;
      for (let i = 0; i + 1 < ranges.length; i++) {
        const end = ranges.end(i), start = ranges.start(i + 1);
        if (start - end <= MseMediaSource.GAP_IDENTITY_TOLERANCE_SEC
            || to <= end || to >= ranges.end(i + 1)) continue;
        const same = prior !== null && prior.videoBuffer === videoBuffer && prior.audioBuffer === audioBuffer
          && prior.generation === this.bufferGen && prior.end === end && prior.start === start;
        // A fresh witness needs an observed lower buffered point. A late upper
        // range can make the immediately preceding sample already be in the gap.
        const point = this.wedgeCoveredPosition;
        const anchor = from >= ranges.start(i) && from <= end ? from
          : point !== null && point.videoBuffer === videoBuffer && point.audioBuffer === audioBuffer
            && point.generation === this.bufferGen && point.time <= from ? point.time : null;
        if (!same && (anchor === null || anchor < ranges.start(i) || anchor > end || to <= anchor)) continue;
        const coverageFrom = same ? from : anchor!;
        let covered = audio === undefined;
        if (audio) for (let j = 0; j < audio.length; j++) {
          if (audio.start(j) <= Math.min(coverageFrom, end) && audio.end(j) >= to) { covered = true; break; }
        }
        if (covered) return same ? prior : { end, start, generation: this.bufferGen, videoBuffer, audioBuffer };
      }
    } catch { /* Detached, evicted or replaced ranges cannot retain a witness. */ }
    return null;
  }

  /** A native pause retires a point whose later range has not yet been observed. */
  private handleCoveredPositionPause = (): void => { this.wedgeCoveredPosition = null; };

  /** A user seek that settles between watchdog samples is not organic playback. */
  private handleWatchdogSeek = (): void => {
    if (this.wedgeSeekTarget !== null
        && Math.abs(this.video.currentTime - this.wedgeSeekTarget) <= MseMediaSource.GAP_MOVE_TOLERANCE_SEC) return;
    this.handleWatchdogSeeked();
    this.wedgeLastTime = null;
    this.wedgeFrozenSinceMs = null;
    this.wedgeLastQuality = null;
    this.clearVideoHoleEvidence();
    this.disarmGap();
  };

  private handleWatchdogSeeked = (): void => {
    this.wedgeSeekTarget = null;
    this.video.removeEventListener('seeked', this.handleWatchdogSeeked);
  };

  private seekForWedge(target: number): void {
    this.handleWatchdogSeeked();
    this.wedgeSeekTarget = target;
    this.video.addEventListener('seeked', this.handleWatchdogSeeked);
    try { this.video.currentTime = target; }
    catch (error) { this.handleWatchdogSeeked(); throw error; }
  }

  /**
   * Stamp a seek WE performed (behind-live chase, quota rejoin) so the
   * watchdog doesn't read it as organic playhead movement. Without this,
   * an adapter-initiated seek would reset the recovery ladder mid-episode
   * and the wedge could persist indefinitely behind periodic seeks.
   */
  private noteSelfSeek(): void {
    this.clearVideoHoleEvidence(); this.handleWatchdogSeeked();
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
    mediaType: 'video' | 'audio', buffer: SourceBuffer, entry: AppendEntry,
  ): void {
    const { data, trackName, trackIdentity, groupId, token } = entry;
    // ── Step 1: parse + tri-state decide ─────────────────────────
    const ranges = this.scoreAppend(mediaType, entry);

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
    const timeline = timelines.get(trackIdentity)?.index;
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
        this.appendOutcome(token, 'discarded', 'treated as a replay');
        return;
      }

      const lateFloor = this.lateAppendFloor[mediaType].get(trackIdentity);
      if (lateFloor !== undefined && ranges.every(range => range.endTime <= lateFloor)) {
        this.appendOutcome(token, 'discarded', 'late segment');
        return;
      }

      // Upstream-accountability diagnostic: an appended payload whose range
      // STARTS inside recorded media but extends past it is a seam overlap —
      // the producer's fragments are not contiguous in decode time (e.g. an
      // ms-quantized ingest clock). MSE absorbs it via coded-frame
      // replacement, but absorbing it SILENTLY would erase the evidence
      // trail, so it is named once per track (per-occurrence detail rides
      // the debug channel).
      const seam = ranges.find((r) =>
        !timeline.containsRange(r.startTime, r.endTime)
        && timeline.containsRange(r.startTime, r.startTime + 1n));
      if (seam !== undefined) {
        const key = `${mediaType}:seam:${trackIdentity}`;
        if (!this.seenDiagnostics.has(key)) {
          this.seenDiagnostics.add(key);
          // Unconditional (not debug-gated): accountability for source
          // defects must survive default configuration. Exactly once per
          // track; per-occurrence detail rides the debug channel.
          console.warn(
            `[MSE] seam overlap on track "${trackName}": ${mediaType} fragment `
            + `[${seam.startTime}-${seam.endTime}) starts inside already-recorded media — `
            + `incoming fragments are not contiguous in decode time (appending; MSE replaces `
            + `the overlapped frames; further occurrences logged at debug level)`,
          );
        } else {
          this.diag(
            '[MSE] seam overlap %s track %s group %s range [%s-%s)',
            mediaType, trackName, String(groupId ?? 'n/a'), String(seam.startTime), String(seam.endTime),
          );
        }
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
    this.pendingGapSkip[mediaType] = entry.skipsGap === true;
    const safeRanges = ranges ?? [];
    if (mediaType === 'video') {
      this.pendingVideoRanges = safeRanges;
      this.pendingVideoTrackName = trackName;
      this.pendingVideoTrackIdentity = trackIdentity;
      this.pendingVideoGroupId = groupId;
    } else {
      this.pendingAudioRanges = safeRanges;
      this.pendingAudioTrackName = trackName;
      this.pendingAudioTrackIdentity = trackIdentity;
      this.pendingAudioGroupId = groupId;
    }

    try {
      this.runMutation(mediaType, 'append', () => buffer.appendBuffer(data.buffer as ArrayBuffer), token);
    } catch (err) {
      // runMutation already recorded mutation-sync-failure.
      this.pendingGapSkip[mediaType] = false;
      // Synchronous throw — the append never happened. Clear pending
      // so updateend (which may or may not fire) doesn't commit it.
      if (mediaType === 'video') {
        this.pendingVideoRanges = [];
        this.pendingVideoTrackName = null;
        this.pendingVideoTrackIdentity = null;
      } else {
        this.pendingAudioRanges = [];
        this.pendingAudioTrackName = null;
        this.pendingAudioTrackIdentity = null;
      }
      // QuotaExceededError is RECOVERABLE (evict + retry, escalating to
      // flush-and-rejoin) — handle it without surfacing an error event.
      if ((err as Error)?.name === 'QuotaExceededError') {
        this.handleQuotaExceeded(mediaType, buffer, entry);
        return;
      }
      this.appendOutcome(token, 'discarded', 'append error');
      if (this.destroyed) return;
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
    mediaType: 'video' | 'audio', buffer: SourceBuffer, entry: AppendEntry,
  ): void {
    const { token } = entry;
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
        // drainQueue removed this admission before the synchronous native call.
        // Reinsert the same entry so its deadline and token survive the retry.
        queue.unshift(entry);
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
      // A failed eviction may have already enqueued this retry. It still owns
      // the token until that entry appends or is discarded by reset/flush.
      const queue = mediaType === 'video' ? this.videoQueue : this.audioQueue;
      if (token && !queue.some(entry => entry.token === token)) this.appendOutcome(token, 'discarded', 'append error');
      if (this.destroyed) return;
      this.dumpRingOnFailure(`appendBuffer quota on ${mediaType} during flush`, new Error('QuotaExceededError'));
      this.onError?.(new Error('MSE quota exceeded and flush recovery failed'));
      return;
    }
    this.quotaFlushInFlight = true;
    if (this.appendQueueHold) this.appendQueueHold.invalidated = true;
    this.logWarn('[MSE] quota exceeded (%s) with nothing evictable — flushing buffers and rejoining live', mediaType);
    let tokens = this.queuedTokens(this.videoQueue);
    tokens = this.queuedTokens(this.audioQueue, tokens);
    if (token && this.appendObservers) (tokens ??= new Set()).add(token);
    this.videoQueue.length = 0;
    this.audioQueue.length = 0;
    this.clearAppendGap('video'); this.clearAppendGap('audio');
    this.clearReceivingGroups('video'); this.clearReceivingGroups('audio');
    this.clearVideoHoleEvidence(); this.handleWatchdogSeeked(); this.wedgeLastQuality = null;
    this.wedgeLastTime = null; this.wedgeFrozenSinceMs = null;
    this.lateAppendFloor.video.clear(); this.lateAppendFloor.audio.clear();
    this.videoTimelines.clear();
    this.audioTimelines.clear();
    this.quotaRetried.video = false;
    this.quotaRetried.audio = false;
    this.chaseAfterFlush = true;
    this.discardTokens(tokens, 'flushed');
    if (this.destroyed) return;
    for (const [b, label] of [[this.videoBuffer, 'video'], [this.audioBuffer, 'audio']] as const) {
      if (!b) continue;
      try {
        if (this.changingType[label] || this.bufferBusy(label, b) || b.buffered.length === 0) continue;
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
    const generation = this.bufferGen;
    const completing = this.inFlightOp[mediaType];
    if (completing) {
      this.inFlightOp[mediaType] = null;
      this.lastCompletedOp[mediaType] = completing.id;
      this.finishBufferOp(completing);
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

    if (completing?.cause === 'append' && completing.succeeded === true
        && !completing.errored && !completing.aborted && !this.appendErrored[mediaType]) {
      const pending =
        mediaType === 'video' ? this.pendingVideoRanges : this.pendingAudioRanges;
      const pendingTrack =
        mediaType === 'video' ? this.pendingVideoTrackIdentity : this.pendingAudioTrackIdentity;
      const pendingTrackName =
        mediaType === 'video' ? this.pendingVideoTrackName : this.pendingAudioTrackName;
      const pendingGroup =
        mediaType === 'video' ? this.pendingVideoGroupId : this.pendingAudioGroupId;
      const timelines =
        mediaType === 'video' ? this.videoTimelines : this.audioTimelines;
      if (pendingTrack !== null && pendingTrackName !== null) {
        let timeline = timelines.get(pendingTrack)?.index;
        if (!timeline) {
          timeline = new TimelineIndex();
          timelines.set(pendingTrack, { trackName: pendingTrackName, index: timeline });
        }
        for (const r of pending) {
          timeline.insert(r.startTime, r.endTime);
        }
        if (this.pendingGapSkip[mediaType] || this.lateAppendFloor[mediaType].has(pendingTrack)) {
          const end = timeline.extent?.end;
          if (end !== undefined) this.lateAppendFloor[mediaType].set(pendingTrack, end);
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
      this.pendingVideoTrackIdentity = null;
      this.pendingVideoGroupId = undefined;
    } else {
      this.pendingAudioRanges = [];
      this.pendingAudioTrackName = null;
      this.pendingAudioTrackIdentity = null;
      this.pendingAudioGroupId = undefined;
    }
    this.pendingGapSkip[mediaType] = false;
    const appendFailed = this.appendErrored[mediaType] || completing?.errored === true;
    this.appendErrored[mediaType] = false;
    if (completing?.cause === 'append') {
      if (completing.aborted) this.appendOutcome(completing.token, 'discarded', 'append aborted');
      else if (appendFailed) this.appendOutcome(completing.token, 'discarded', 'append error');
      else if (completing.succeeded) this.appendOutcome(completing.token, 'appended', null);
      else this.appendOutcome(completing.token, 'unavailable', 'completion unproven');
    }
    if (this.destroyed || generation !== this.bufferGen) return;
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
    const fmtTimelines = (m: Map<string, TrackTimeline>): string =>
      m.size === 0
        ? 'empty'
        : Array.from(m.values())
            .map(({ trackName, index }) => `"${trackName}": ${index.toString()}`)
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
    if (this.seekResource && !this.seekResource.released) return;
    this.gapStallEpisode = false;                 // post-jump churn episode over
    // `playing` is the only genuine resumption signal: it is queued when ready
    // state recovers. A sub-threshold wait clears silently.
    // Capture, but publish after every internal commit below: emit()
    // propagates listener exceptions, and a throwing `stall_recovered`
    // listener must not leave first-frame state uncommitted.
    let recoveredMs: number | null = null;
    if (this.stallStartTime !== null) {
      const startedAt = this.stallStartTime;
      const detected = this.stallDetected;
      this.cancelStallEpisode();
      if (detected) recoveredMs = performance.now() - startedAt;
    }
    if (!this.firstFrameFired) {
      this.firstFrameFired = true;
      this.onFirstFrame?.();
    }
    if (recoveredMs !== null) this.onStallRecovered?.(recoveredMs);
  };

  private handleWaiting = (): void => {
    if (this.seekResource && !this.seekResource.released) return;
    // A gap-jump's own seek emits a waiting; the adapter already reported
    // that stall itself (cause 'media-gap') — don't arm a duplicate. The
    // episode ends on the first playing/timeupdate or, unconditionally,
    // two watchdog ticks after the jump (no persistent 'seeked' listener:
    // the startup-positioning machinery owns transient seeked listeners,
    // and playing/timeupdate always accompany a successful landing).
    if (this.gapStallEpisode) {
      // Do not lose the only stall evidence: browsers need not re-emit
      // `waiting` for the same uninterrupted freeze.
      if (this.gapLanding !== null) this.gapLanding.waitingAtMs ??= performance.now();
      return;
    }
    // A `waiting` delivered after intent was withdrawn describes stopped
    // playback, not a stall.
    if (!this.playbackIntent) return;
    this.gapStallFromLanding = false;   // fresh evidence, not landing-owned
    // First `waiting` owns the episode: a browser may re-emit it during one
    // uninterrupted freeze, and restarting the clock would shorten the outage.
    this.stallStartTime ??= performance.now();
    this.armStallDetection();
  };

  /** Detect once, at an explicit threshold, independent of `timeupdate`. */
  private armStallDetection(): void {
    if (this.stallDetectTimer !== null || this.stallDetected) return;
    this.stallDetectTimer = setTimeout(() => {
      this.stallDetectTimer = null;
      if (this.stallStartTime === null || this.stallDetected) return;
      this.stallDetected = true;
      this.onStall?.(performance.now() - this.stallStartTime);
    }, this.stallThresholdMs);
  }

  /**
   * Abandon an in-flight episode without completing it.
   *
   * For teardown and for playback that is superseded rather than recovered.
   */
  cancelStallEpisode(): void {
    if (this.stallDetectTimer !== null) {
      clearTimeout(this.stallDetectTimer);
      this.stallDetectTimer = null;
    }
    this.stallStartTime = null;
    this.stallDetected = false;
  };

  private handleTimeUpdate = (): void => {
    if (this.seekResource && !this.seekResource.released) return;
    if (!this.firstFrameFired && this.video.currentTime > 0) {
      this.firstFrameFired = true;
      this.onFirstFrame?.();
    }
    if (this.gapStallEpisode) {
      // First post-jump progress signal ends the suppression episode; the
      // jump's stall was already reported by the adapter.
      this.gapStallEpisode = false;
      return;
    }
    // Deliberately does NOT close the episode. `timeupdate` is queued when the
    // ready state falls and `waiting` is fired, and runs on a ~250 ms cadence,
    // so treating it as recovery both ended measurement early and let a
    // continuing freeze go unmeasured.
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
    if (this.seekResource && (!this.seekCurrent(this.seekResource) || this.video.error === null)) return;
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
