/**
 * WebCodecsVideoDecoder — wraps browser VideoDecoder.
 *
 * Implements VideoDecoderLike for use with CommandDispatcher.
 * Translates configure/decode/flush/reset commands into browser
 * VideoDecoder API calls.
 *
 * Codec-specific behavior (format conversion, keyframe gating,
 * NAL/OBU sanitization) is delegated to a CodecStrategy selected
 * at configure() time. Supports H.264/AVC, H.265/HEVC, AV1, and
 * unknown codecs via passthrough.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream = EncodedVideoChunk.data)
 * @see draft-ietf-moq-loc-01 §2.3.2.1 (VideoConfig → VideoDecoderConfig.description)
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
 * @see draft-ietf-moq-msf-00 §5.1.29 (width → codedWidth)
 * @see draft-ietf-moq-msf-00 §5.1.30 (height → codedHeight)
 * @module
 */

import type { VideoDecoderLike } from '@openmoq/player';
import type { VideoChunkInit, SourceTimestamp } from '@openmoq/loc';
import { createCodecStrategy } from './codec-strategy.js';
import type { CodecStrategy } from './codec-strategy.js';

/**
 * Maximum decode queue depth before dropping frames.
 * Chrome's GPU process can crash if the VideoDecoder queue grows unbounded
 * (e.g., initial burst when catching up to a live stream).
 * 16 frames ≈ ~500ms at 30fps — enough for B-frame reorder without OOM.
 */
const MAX_DECODE_QUEUE_SIZE = 16;
const MAX_CHUNK_HISTORY = 8;
const HEX_PREVIEW_BYTES = 24;
const MAX_SOURCE_TIMESTAMPS = 256;
const MAX_DECODER_OWNERS = 2; // Current decoder plus one draining predecessor.

interface DecoderOwner {
  readonly decoder: VideoDecoder;
  readonly renderTimes: Map<number, number>;
  readonly sourceTimes: Map<number, SourceTimestamp | null>;
  retiredTimestampFloor: number;
  active: boolean;
}

/**
 * Wraps the browser's VideoDecoder API behind VideoDecoderLike.
 *
 * Key responsibilities:
 * - Maps configure() with catalog metadata → VideoDecoderConfig
 * - Maps decode() with VideoChunkInit → EncodedVideoChunk
 * - Tracks render time via timestamp-keyed map (handles B-frame reorder)
 * - Delegates codec-specific logic to CodecStrategy
 * - Exposes queueDepth from VideoDecoder.decodeQueueSize
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream format)
 */
/** Configuration for WebCodecsVideoDecoder. */
export interface WebCodecsVideoDecoderConfig {
  /**
   * Prefer software H.264 decoding over hardware.
   * Software decoders (FFmpeg) are more tolerant of malformed NAL units
   * from some relays. Hardware decoders may fail silently mid-stream.
   * Only affects codecs where the strategy reports supportsSoftwarePreference.
   * Default: false (prefer hardware for performance).
   */
  readonly preferSoftwareDecoder?: boolean;
}

export class WebCodecsVideoDecoder implements VideoDecoderLike {
  private decoder: VideoDecoder | null = null;
  private owner: DecoderOwner | null = null;
  private readonly owners = new Set<DecoderOwner>();
  private destroyed = false;
  private lifecycleRevision = 0;
  private readonly preferSoftwareDecoder: boolean;

  constructor(config?: WebCodecsVideoDecoderConfig) {
    this.preferSoftwareDecoder = config?.preferSoftwareDecoder ?? false;
  }

  /** Last configured codec string — needed for reset+reconfigure. */
  private lastCodec = '';
  private lastWidth: number | undefined;
  private lastHeight: number | undefined;
  private lastDescription: Uint8Array | undefined;

  /** Codec-specific strategy — selected at configure() time. */
  private strategy: CodecStrategy = createCodecStrategy('');

  /**
   * Keyframe gating flag — when true, frames are dropped until the
   * strategy confirms an acceptable sync point. Replaces the old
   * H.264-only awaitingH264Idr flag with codec-agnostic gating.
   */
  private awaitingKeyframe = false;

  /** Enable diagnostic logging. */
  debug = false;

  /**
   * Advisory flag from isConfigSupported(). When true AND a decode error
   * occurs, we know recovery is futile — the codec is genuinely unsupported.
   * Does NOT prevent decode attempts (isConfigSupported can return false for
   * configs that work at runtime, e.g., non-standard resolutions).
   */
  private configLikelyUnsupported = false;

  // ─── Diagnostic state ───────────────────────────────────────────

  private lastObservedChunkSummary = 'none';
  private lastSubmittedChunkSummary = 'none';
  private observedChunkCount = 0;
  private submittedChunkCount = 0;
  private readonly recentObservedChunkSummaries: string[] = [];
  private readonly recentSubmittedChunkSummaries: string[] = [];
  private lastObservedChunkHex = 'none';
  private lastSubmittedChunkHex = 'none';
  private lastSubmittedKeyChunkSummary = 'none';
  private lastSubmittedKeyChunkHex = 'none';
  private lastSubmittedKeyChunkBytes: Uint8Array | null = null;
  private lastSubmittedChunkBytes: Uint8Array | null = null;

  // ─── Callbacks ──────────────────────────────────────────────────

  onFrame: ((frame: unknown, renderTimeUs: number, sourceTimestamp?: SourceTimestamp | null) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  // ─── VideoDecoderLike ───────────────────────────────────────────

  /**
   * Configure the decoder with codec metadata from MSF catalog.
   *
   * Selects the appropriate CodecStrategy based on the codec string,
   * then configures the browser's VideoDecoder.
   *
   * @param config Codec-specific description bytes (SPS/PPS for H.264,
   *               HVCC for HEVC, unused for AV1).
   *               Maps to VideoDecoderConfig.description.
   * @param codec Codec string from MSF catalog (e.g., "avc1.42001f",
   *              "hvc1.1.6.L120.B0", "av01.0.08M.10").
   * @param width Coded width from MSF catalog. Maps to VideoDecoderConfig.codedWidth.
   * @param height Coded height from MSF catalog. Maps to VideoDecoderConfig.codedHeight.
   *
   * @see draft-ietf-moq-loc-01 §2.3.2.1 (VideoConfig extension)
   * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
   */
  configure(config: Uint8Array, codec: string, width?: number, height?: number): void {
    if (this.destroyed) return;
    const revision = ++this.lifecycleRevision;
    const codecChanged = codec !== this.lastCodec;
    this.lastCodec = codec;
    this.lastWidth = width;
    this.lastHeight = height;
    this.lastDescription = config.byteLength > 0 ? config : undefined;

    // Select codec-specific strategy (only when codec changes)
    if (codecChanged) {
      this.strategy = createCodecStrategy(codec);
    }
    this.awaitingKeyframe = this.strategy.gatesAfterReset;
    this.configLikelyUnsupported = false;

    // Reset diagnostic state
    this.observedChunkCount = 0;
    this.submittedChunkCount = 0;
    this.lastObservedChunkSummary = 'none';
    this.lastSubmittedChunkSummary = 'none';
    this.lastObservedChunkHex = 'none';
    this.lastSubmittedChunkHex = 'none';
    this.lastSubmittedKeyChunkSummary = 'none';
    this.lastSubmittedKeyChunkHex = 'none';
    this.lastSubmittedKeyChunkBytes = null;
    this.lastSubmittedChunkBytes = null;
    this.recentObservedChunkSummaries.length = 0;
    this.recentSubmittedChunkSummaries.length = 0;

    // Flush-before-reconfigure: when switching codecs (ABR track switch),
    // flush the old decoder to push pending decoded frames to the renderer
    // before destroying it. The old decoder's output callback closure shares
    // this.onFrame, so flushed frames reach the same renderer queue.
    // @see draft-ietf-moq-msf-00 §4.2 (seamless switch at group boundaries)
    if (codecChanged && this.decoder && this.decoder.state === 'configured') {
      const dyingDecoder = this.decoder;
      const dyingOwner = this.owner!;
      this.decoder = null; // prevent createDecoder() from closing it
      this.owner = null;

      dyingDecoder.flush().then(() => {
        this.retireOwner(dyingOwner);
      }, () => {
        this.retireOwner(dyingOwner);
      });
    }

    if (!this.createDecoder(revision)) return;
    this.applyConfig();
    if (revision === this.lifecycleRevision) this.checkConfigSupport();
  }

  /**
   * Decode a video chunk. Frames arrive asynchronously via onFrame callback.
   *
   * Guards against queue overload: if the decoder's internal queue exceeds
   * MAX_DECODE_QUEUE_SIZE, the decoder is reset and an error is fired so
   * the pipeline waits for the next keyframe. This prevents Chrome's GPU
   * process from crashing under burst conditions.
   *
   * @see draft-ietf-moq-loc-01 §2 (LOC payload = EncodedVideoChunk.data)
   */
  decode(chunk: VideoChunkInit, renderTimeUs: number): void {
    const owner = this.owner;
    if (this.destroyed || !owner?.active || !this.lastCodec || owner.decoder.state !== 'configured') return;

    // Backpressure: if decoder queue is full, reset and wait for the
    // next keyframe. Continuing would break the reference chain — later
    // deltas without their reference produce blocky artifacts.
    if (owner.decoder.decodeQueueSize >= MAX_DECODE_QUEUE_SIZE) {
      const revision = this.lifecycleRevision;
      this.reset(); // full reset preserving description/codedSize/optimizeForLatency
      if (this.destroyed || this.lifecycleRevision !== revision + 1) return;
      this.onError?.(new Error('decode queue overflow — reset to keyframe'));
      return;
    }

    // Codec-specific chunk preparation (format conversion, sanitization)
    const prepared = this.strategy.prepareChunkData(chunk.data, this.lastDescription);
    if (!prepared) return;
    const { data, droppedReason } = prepared;

    // Track observed chunk
    this.observedChunkCount++;
    this.lastObservedChunkSummary = this.strategy.describeChunk
      ? this.strategy.describeChunk(data, chunk.type, this.lastDescription)
      : `#${this.observedChunkCount}|type=${chunk.type}|bytes=${data.byteLength}`;
    this.recentObservedChunkSummaries.push(this.lastObservedChunkSummary);
    if (this.recentObservedChunkSummaries.length > MAX_CHUNK_HISTORY) {
      this.recentObservedChunkSummaries.shift();
    }
    this.lastObservedChunkHex = hexPreview(data);

    if (droppedReason) {
      if (this.debug) console.warn(`[WebCodecsVideoDecoder] Dropped NAL/OBU units: ${droppedReason}`);
    }

    // Keyframe gating: wait for an acceptable sync point after configure/reset
    if (this.awaitingKeyframe) {
      if (!this.strategy.isAcceptableSyncPoint(data, chunk.type, this.lastDescription)) {
        if (this.debug) console.debug('[WebCodecsVideoDecoder] Awaiting keyframe, dropping chunk type=%s', chunk.type);
        return;
      }
      this.awaitingKeyframe = false;
    }

    // Track submitted chunk
    this.submittedChunkCount++;
    this.lastSubmittedChunkSummary = this.lastObservedChunkSummary;
    this.lastSubmittedChunkHex = hexPreview(data);
    this.lastSubmittedChunkBytes = data.slice();
    this.recentSubmittedChunkSummaries.push(this.lastSubmittedChunkSummary);
    if (this.recentSubmittedChunkSummaries.length > MAX_CHUNK_HISTORY) {
      this.recentSubmittedChunkSummaries.shift();
    }
    if (chunk.type === 'key') {
      this.lastSubmittedKeyChunkSummary = this.lastSubmittedChunkSummary;
      this.lastSubmittedKeyChunkHex = this.lastSubmittedChunkHex;
      this.lastSubmittedKeyChunkBytes = data.slice();
    }

    let submittedTimestamp: number | undefined;
    try {
      const encoded = new EncodedVideoChunk({
        type: chunk.type,
        timestamp: chunk.timestamp,
        ...(chunk.duration !== undefined ? { duration: chunk.duration } : {}),
        data,
      });
      const source = copySourceTimestamp(chunk, encoded.timestamp);
      if (!owner.active || this.owner !== owner) return;
      this.rememberSource(owner, encoded.timestamp, source);
      if (!owner.renderTimes.has(encoded.timestamp) && owner.renderTimes.size >= MAX_SOURCE_TIMESTAMPS) {
        owner.renderTimes.delete(owner.renderTimes.keys().next().value!);
      }
      owner.renderTimes.set(encoded.timestamp, renderTimeUs);
      submittedTimestamp = encoded.timestamp;
      owner.decoder.decode(encoded);
    } catch (err) {
      // A throwing submit has no proven output ownership. Keep the tombstone.
      if (submittedTimestamp !== undefined && owner.active) {
        if (owner.sourceTimes.has(submittedTimestamp)) owner.sourceTimes.set(submittedTimestamp, null);
        owner.renderTimes.delete(submittedTimestamp);
      }
      throw this.enrichError(
        err,
        `Video decode submit failed (${this.describeDecoderContext()})`,
      );
    }
  }

  /** Flush pending frames. Resolves when all pending frames are decoded. */
  async flush(): Promise<void> {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    await this.decoder.flush();
  }

  /**
   * Reset the decoder (e.g., after a gap or quality switch).
   * Clears the render time queue and reconfigures.
   *
   * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps)
   */
  reset(): void {
    if (!this.lastCodec) return; // Not yet configured — nothing to reset
    if (this.destroyed) return;
    const revision = ++this.lifecycleRevision;
    this.awaitingKeyframe = this.strategy.gatesAfterReset;
    // A fresh callback owner prevents pre-reset output from binding to reused PTS.
    this.retireAllOwners();
    if (!this.createDecoder(revision)) return;
    this.applyConfig();
    if (revision === this.lifecycleRevision) this.checkConfigSupport();
  }

  /**
   * Current decode queue depth. Used for backpressure decisions.
   * @see draft-ietf-moq-transport-16 §7 (Priority scheduling)
   */
  get queueDepth(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /** Release all resources. */
  destroy(): void {
    this.destroyed = true;
    this.lifecycleRevision++;
    this.onFrame = null;
    this.onError = null;
    this.retireAllOwners();
  }

  // ─── Internal ──────────────────────────────────────────────────

  private createDecoder(revision: number): boolean {
    if (this.destroyed || revision !== this.lifecycleRevision) return false;
    if (this.owner) this.retireOwner(this.owner);
    if (this.destroyed || revision !== this.lifecycleRevision) return false;
    let owner: DecoderOwner;

    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (!owner?.active || this.destroyed) {
          // No consumer wired — MUST close to release GPU memory.
          // VideoFrame holds ~8MB GPU memory outside JS GC.
          frame.close();
          return;
        }
        const timestamp = frame.timestamp;
        if (!owner.active || this.destroyed) {
          frame.close();
          return;
        }
        const renderTimeUs = owner.renderTimes.get(timestamp) ?? 0;
        owner.renderTimes.delete(timestamp);
        const source = owner.sourceTimes.get(timestamp) ?? null;
        if (owner.sourceTimes.has(timestamp)) owner.sourceTimes.set(timestamp, null);
        if (!this.onFrame) {
          frame.close();
          return;
        }
        this.onFrame(frame, renderTimeUs, source);
      },
      error: (err: DOMException) => {
        if (!owner?.active || this.destroyed) return;
        if (this.owner !== owner) {
          this.retireOwner(owner);
          return;
        }
        // If isConfigSupported() said unsupported AND we get a decode error,
        // the codec is genuinely unsupported — close decoder, fire clear error,
        // don't attempt recovery (which would loop forever).
        if (this.configLikelyUnsupported) {
          const revision = this.lifecycleRevision;
          this.retireOwner(owner);
          if (this.destroyed || revision !== this.lifecycleRevision) return;
          this.onError?.(new Error(
            `Codec not supported: ${this.lastCodec} (${this.lastWidth ?? '?'}x${this.lastHeight ?? '?'}). ` +
            `VideoDecoder.isConfigSupported() returned false and decode failed.`,
          ));
          return;
        }
        this.publishDebugBundle();
        if (!this.recoverAfterDecodeError()) return;
        this.onError?.(this.enrichError(
          err,
          `Video decoder error: ${err.message} (${this.describeDecoderContext()})`,
        ));
      },
    });
    owner = { decoder, renderTimes: new Map(), sourceTimes: new Map(), retiredTimestampFloor: -Infinity, active: true };
    if (this.destroyed || revision !== this.lifecycleRevision) {
      owner.active = false;
      if (decoder.state !== 'closed') decoder.close();
      return false;
    }
    this.owners.add(owner);
    this.owner = owner;
    this.decoder = decoder;
    while (this.owners.size > MAX_DECODER_OWNERS) this.retireOwner(this.owners.values().next().value!);
    return !this.destroyed && revision === this.lifecycleRevision;
  }

  private rememberSource(owner: DecoderOwner, timestamp: number, source: SourceTimestamp | null): void {
    if (owner.sourceTimes.has(timestamp)) {
      // Repeated PTS cannot identify an input, even after its first output.
      owner.sourceTimes.set(timestamp, null);
      return;
    }
    if (timestamp <= owner.retiredTimestampFloor) return;
    if (owner.sourceTimes.size >= MAX_SOURCE_TIMESTAMPS) {
      const oldest = owner.sourceTimes.keys().next().value!;
      owner.retiredTimestampFloor = Math.max(owner.retiredTimestampFloor, oldest);
      owner.sourceTimes.delete(oldest);
    }
    owner.sourceTimes.set(timestamp, source);
  }

  private retireOwner(owner: DecoderOwner): void {
    owner.active = false;
    owner.sourceTimes.clear();
    owner.renderTimes.clear();
    this.owners.delete(owner);
    if (this.owner === owner) {
      this.owner = null;
      this.decoder = null;
    }
    if (owner.decoder.state !== 'closed') owner.decoder.close();
  }

  private retireAllOwners(): void {
    const owners = [...this.owners];
    // Fence every callback before invoking fallible native cleanup.
    for (const owner of owners) owner.active = false;
    for (const owner of owners) this.retireOwner(owner);
  }

  /** Build the VideoDecoderConfig from current state + strategy. */
  private buildConfig(): VideoDecoderConfig {
    const config: VideoDecoderConfig = {
      codec: this.lastCodec,
      // H.264 (no B-frames): optimizeForLatency disables the reorder buffer
      // for 1-in-1-out low-latency decode.
      // HEVC with CRA/B-frames: must be false — trailing pictures have PTS
      // before the keyframe, and the decoder needs its reorder buffer.
      optimizeForLatency: this.strategy.optimizeForLatency,
    };
    if (this.preferSoftwareDecoder && this.strategy.supportsSoftwarePreference) {
      config.hardwareAcceleration = 'prefer-software';
    }
    if (this.lastWidth !== undefined) config.codedWidth = this.lastWidth;
    if (this.lastHeight !== undefined) config.codedHeight = this.lastHeight;
    if (this.strategy.usesDescription && this.lastDescription) {
      config.description = this.lastDescription;
    }
    return config;
  }

  private applyConfig(): void {
    if (!this.decoder || !this.lastCodec) return;
    this.decoder.configure(this.buildConfig());
  }

  /**
   * Async codec support check — delegates to the strategy.
   *
   * Each strategy knows the correct VideoDecoderConfig shape for its codec
   * (e.g., AV1 must NOT set description). If unsupported, closes the decoder
   * and fires onError with a clear message, preventing the infinite
   * decode-error → recovery → resubscribe loop.
   *
   * @see https://www.w3.org/TR/webcodecs/#dom-videodecoder-isconfigsupported
   */
  /**
   * Advisory async codec support check.
   *
   * Sets `configLikelyUnsupported` flag but does NOT kill the decoder.
   * The flag is consulted by the decode error handler to distinguish
   * "genuinely unsupported codec" from "transient decode error worth retrying."
   *
   * This avoids the race where an async check from a stale configure() kills
   * a working decoder that was reconfigured in the meantime.
   */
  private checkConfigSupport(): void {
    const owner = this.owner;
    if (!this.lastCodec || !owner?.active || this.destroyed) return;
    this.strategy.checkSupport(this.lastCodec, this.lastWidth, this.lastHeight, this.lastDescription).then((supported) => {
      if (!owner?.active || this.owner !== owner || this.destroyed) return;
      if (!supported) {
        this.configLikelyUnsupported = true;
      }
    });
  }

  private recoverAfterDecodeError(): boolean {
    const revision = ++this.lifecycleRevision;
    this.retireAllOwners();
    if (this.destroyed || revision !== this.lifecycleRevision) return false;
    this.awaitingKeyframe = this.strategy.gatesAfterReset;
    // WebCodecs decoder is terminally closed after an error — reset()
    // cannot revive it. Destroy and recreate with the same config.
    // If the avcC/description itself is defective (e.g., SPS drift
    // from content-adaptive encoding without stitchable=1), the new
    // decoder will hit the same error — that's an encode-side fix.
    if (this.debug) console.warn('[VideoDecoder] decode error → recreating decoder (%s %dx%d)',
      this.lastCodec, this.lastWidth ?? 0, this.lastHeight ?? 0);
    if (!this.createDecoder(revision)) return false;
    this.applyConfig();
    if (this.destroyed || revision !== this.lifecycleRevision) return false;
    this.checkConfigSupport();
    return true;
  }

  private describeDecoderContext(): string {
    const configDesc = this.strategy.describeConfig
      ? this.strategy.describeConfig(this.lastDescription)
      : `initDataBytes=${this.lastDescription?.byteLength ?? 0}`;
    return [
      `codec=${this.lastCodec || 'unknown'}`,
      `size=${this.lastWidth ?? '?'}x${this.lastHeight ?? '?'}`,
      `config=${configDesc}`,
      `lastObserved=${this.lastObservedChunkSummary}`,
      `lastObservedHex=${this.lastObservedChunkHex}`,
      `recentObserved=[${this.recentObservedChunkSummaries.join(', ')}]`,
      `lastSubmitted=${this.lastSubmittedChunkSummary}`,
      `lastSubmittedHex=${this.lastSubmittedChunkHex}`,
      `lastSubmittedKey=${this.lastSubmittedKeyChunkSummary}`,
      `lastSubmittedKeyHex=${this.lastSubmittedKeyChunkHex}`,
      `recentSubmitted=[${this.recentSubmittedChunkSummaries.join(', ')}]`,
    ].join(', ');
  }

  private enrichError(error: unknown, message: string): Error {
    const cause = error instanceof Error ? error : new Error(String(error));
    const enriched = new Error(message);
    (enriched as Error & { cause?: Error }).cause = cause;
    return enriched;
  }

  private publishDebugBundle(): void {
    const target = globalThis as typeof globalThis & {
      __MOQT_LAST_VIDEO_DEBUG__?: Record<string, unknown>;
    };
    target.__MOQT_LAST_VIDEO_DEBUG__ = {
      codec: this.lastCodec,
      width: this.lastWidth,
      height: this.lastHeight,
      initDataBase64: toBase64(this.lastDescription),
      keyframeSampleBase64: toBase64(this.lastSubmittedKeyChunkBytes),
      failingSampleBase64: toBase64(this.lastSubmittedChunkBytes),
      lastObservedSummary: this.lastObservedChunkSummary,
      lastSubmittedSummary: this.lastSubmittedChunkSummary,
      lastSubmittedKeySummary: this.lastSubmittedKeyChunkSummary,
    };
  }
}

// ─── Diagnostic helpers ─────────────────────────────────────────────

function copySourceTimestamp(chunk: VideoChunkInit, submittedTimestamp: number): SourceTimestamp | null {
  if (!Number.isSafeInteger(submittedTimestamp)) return null;
  try {
    const source = chunk.sourceTimestamp;
    if (!source) return null;
    const { ticks, ticksPerSecond, domain } = source;
    if (typeof ticks !== 'bigint' || typeof ticksPerSecond !== 'bigint' || ticksPerSecond <= 0n
        || !['unix', 'media', 'unknown'].includes(domain)) return null;
    const scaled = ticks * 1_000_000n;
    const micros = BigInt(submittedTimestamp);
    const rounded = (scaled + (scaled >= 0n ? ticksPerSecond / 2n : -(ticksPerSecond / 2n))) / ticksPerSecond;
    if (micros !== scaled / ticksPerSecond && micros !== rounded) return null;
    return Object.freeze({ ticks, ticksPerSecond, domain });
  } catch {
    return null;
  }
}

function hexPreview(data: Uint8Array): string {
  const preview = Array.from(data.subarray(0, HEX_PREVIEW_BYTES), (b) =>
    b.toString(16).padStart(2, '0'));
  const suffix = data.byteLength > HEX_PREVIEW_BYTES ? '+' : '';
  return `${preview.join('')}${suffix}`;
}

function toBase64(data: Uint8Array | null | undefined): string {
  if (!data || data.byteLength === 0) return '';
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}
