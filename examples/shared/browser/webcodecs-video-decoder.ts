/**
 * WebCodecsVideoDecoder — wraps browser VideoDecoder.
 *
 * Implements VideoDecoderLike for use with CommandDispatcher.
 * Translates configure/decode/flush/reset commands into browser
 * VideoDecoder API calls.
 *
 * Uses CodecStrategy for codec-specific chunk preparation (format
 * conversion, sanitization) and keyframe gating.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream = EncodedVideoChunk.data)
 * @see draft-ietf-moq-loc-01 §2.3.2.1 (VideoConfig → VideoDecoderConfig.description)
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
 * @see draft-ietf-moq-msf-00 §5.1.29 (width → codedWidth)
 * @see draft-ietf-moq-msf-00 §5.1.30 (height → codedHeight)
 * @module
 */

import type { VideoDecoderLike } from '@moqt/player';
import type { VideoChunkInit } from '@moqt/loc';
// Codec strategies are not part of the @moqt/browser public API.
// Import directly from source for example/dev usage.
import { createCodecStrategy, type CodecStrategy } from '../../../packages/browser/src/codec-strategy.js';

/**
 * Maximum decode queue depth before dropping frames.
 * Chrome's GPU process can crash if the VideoDecoder queue grows unbounded
 * (e.g., initial burst when catching up to a live stream).
 * 16 frames ≈ ~500ms at 30fps — enough for B-frame reorder without OOM.
 */
const MAX_DECODE_QUEUE_SIZE = 16;

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
export class WebCodecsVideoDecoder implements VideoDecoderLike {
  private decoder: VideoDecoder | null = null;

  /** Last configured codec string — needed for reset+reconfigure. */
  private lastCodec = '';
  private lastWidth: number | undefined;
  private lastHeight: number | undefined;
  private lastDescription: Uint8Array | undefined;

  /** Codec-specific strategy — selected at configure() time. */
  private strategy: CodecStrategy = createCodecStrategy('');

  /** Keyframe gating — drops frames until strategy confirms sync point. */
  private awaitingKeyframe = false;

  /** Set when isConfigSupported() returns false — disables all decode. */
  private configUnsupported = false;

  /**
   * Map from chunk timestamp → renderTimeUs.
   * Keyed by EncodedVideoChunk.timestamp so that B-frame reordering
   * in the browser's VideoDecoder doesn't scramble the render times.
   * (Decode order ≠ output/presentation order for H.264 B-frames.)
   */
  private readonly renderTimeMap = new Map<number, number>();

  // ─── Callbacks ──────────────────────────────────────────────────

  onFrame: ((frame: unknown, renderTimeUs: number) => void) | null = null;
  onError: ((error: Error) => void) | null = null;

  // ─── VideoDecoderLike ───────────────────────────────────────────

  /**
   * Configure the decoder with codec metadata from MSF catalog.
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
    this.lastCodec = codec;
    this.lastWidth = width;
    this.lastHeight = height;
    this.lastDescription = config.byteLength > 0 ? config : undefined;
    this.strategy = createCodecStrategy(codec);
    this.awaitingKeyframe = this.strategy.gatesAfterReset;
    this.configUnsupported = false;

    this.createDecoder();
    this.applyConfig();
    this.checkConfigSupport();
  }

  /**
   * Decode a video chunk. Frames arrive asynchronously via onFrame callback.
   *
   * @see draft-ietf-moq-loc-01 §2 (LOC payload = EncodedVideoChunk.data)
   */
  decode(chunk: VideoChunkInit, renderTimeUs: number): void {
    if (!this.lastCodec || !this.decoder || this.decoder.state !== 'configured' || this.configUnsupported) return;

    // Backpressure: drop frames when decoder queue is too deep.
    if (this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE_SIZE) return;

    // Codec-specific chunk preparation
    const prepared = this.strategy.prepareChunkData(chunk.data, this.lastDescription);
    if (!prepared) return;

    // Keyframe gating
    if (this.awaitingKeyframe) {
      if (!this.strategy.isAcceptableSyncPoint(prepared.data, chunk.type, this.lastDescription)) {
        return;
      }
      this.awaitingKeyframe = false;
    }

    this.renderTimeMap.set(chunk.timestamp, renderTimeUs);
    this.decoder.decode(new EncodedVideoChunk({
      ...chunk,
      data: prepared.data,
    }));
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
    if (!this.lastCodec) return;
    this.renderTimeMap.clear();
    this.awaitingKeyframe = this.strategy.gatesAfterReset;
    if (this.decoder && this.decoder.state === 'configured') {
      this.decoder.reset();
    }
    if (!this.decoder || this.decoder.state === 'closed') {
      this.createDecoder();
    }
    this.applyConfig();
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
    this.renderTimeMap.clear();
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
    this.onFrame = null;
    this.onError = null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private createDecoder(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (!this.onFrame) {
          frame.close();
          return;
        }
        const renderTimeUs = this.renderTimeMap.get(frame.timestamp) ?? 0;
        this.renderTimeMap.delete(frame.timestamp);
        this.onFrame(frame, renderTimeUs);
      },
      error: (err: DOMException) => {
        if (this.configUnsupported) return;
        this.onError?.(new Error(err.message));
      },
    });
  }

  private buildConfig(): VideoDecoderConfig {
    const config: VideoDecoderConfig = {
      codec: this.lastCodec,
      optimizeForLatency: true,
    };
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

  private checkConfigSupport(): void {
    if (!this.lastCodec) return;
    this.strategy.checkSupport(this.lastCodec, this.lastWidth, this.lastHeight, this.lastDescription).then((supported) => {
      if (supported) return;
      this.configUnsupported = true;
      if (this.decoder && this.decoder.state !== 'closed') {
        this.decoder.close();
      }
      this.decoder = null;
      this.onError?.(new Error(
        `Codec not supported: ${this.lastCodec} (${this.lastWidth ?? '?'}x${this.lastHeight ?? '?'}). ` +
        `VideoDecoder.isConfigSupported() returned false.`,
      ));
    });
  }
}
