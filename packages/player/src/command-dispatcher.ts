/**
 * CommandDispatcher — bridges sans-I/O playback core and browser adapters.
 *
 * Routes DecoderCommands (from PlaybackPipeline) to adapter instances
 * (VideoDecoderLike, AudioDecoderLike) and wires their callbacks through
 * to the renderer/audio-output and back to the player's event system.
 *
 * The dispatcher enriches configure commands with codec metadata from the
 * MSF catalog — the pipeline only knows about binary extradata, while
 * the browser's WebCodecs API needs the full codec string and dimensions.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream = EncodedVideoChunk.data)
 * @see draft-ietf-moq-loc-01 §2.3.2.1 (Video Config → VideoDecoderConfig.description)
 * @see draft-ietf-moq-loc-01 §4.1 (audio independently decodable)
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
 * @see draft-ietf-moq-msf-00 §5.1.29 (width → codedWidth)
 * @see draft-ietf-moq-msf-00 §5.1.30 (height → codedHeight)
 * @see draft-ietf-moq-msf-00 §5.1.25 (samplerate)
 * @see draft-ietf-moq-msf-00 §5.1.26 (channelConfig)
 * @module
 */

import type { DecoderCommand, DecoderFeedback } from '@moqt/playback';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike } from './interfaces.js';

// ─── Queue pressure hysteresis thresholds ─────────────────────────────

/** Emit queue_pressure when depth rises to this level. @see draft-ietf-moq-transport-16 §7 */
const QUEUE_HIGH_THRESHOLD = 8;
/** Emit queue_pressure (cleared) when depth drops to this level. */
const QUEUE_LOW_THRESHOLD = 4;

// ─── Options ──────────────────────────────────────────────────────────

export interface CommandDispatcherOptions {
  readonly videoDecoder?: VideoDecoderLike;
  readonly audioDecoder?: AudioDecoderLike;
  readonly renderer?: VideoRendererLike;
  readonly audioOutput?: AudioOutputLike;

  /** Codec string from MSF catalog for video. @see draft-ietf-moq-msf-00 §5.1.24 */
  readonly videoCodec?: string;
  /** Coded width from MSF catalog. @see draft-ietf-moq-msf-00 §5.1.29 */
  readonly videoWidth?: number;
  /** Coded height from MSF catalog. @see draft-ietf-moq-msf-00 §5.1.30 */
  readonly videoHeight?: number;

  /** Codec string from MSF catalog for audio. @see draft-ietf-moq-msf-00 §5.1.24 */
  readonly audioCodec?: string;
  /** Sample rate from MSF catalog. @see draft-ietf-moq-msf-00 §5.1.25 */
  readonly audioSampleRate?: number;
  /** Channel count from MSF catalog channelConfig. @see draft-ietf-moq-msf-00 §5.1.26 */
  readonly audioChannels?: number;

  readonly onFirstFrame?: () => void;
  readonly onStall?: (durationMs: number) => void;
  readonly onFrameRendered?: (captureTimestampUs: bigint, actualRenderUs: number) => void;
  /**
   * Measured A/V skew at video frame render time:
   * `skewUs = videoFrameCaptureUs − audioOutput.playheadCaptureUs()`.
   * Positive = video ahead of audible audio. Only fired when the audio
   * output exposes a playhead AND audio is currently audible — pure
   * observability, no effect on scheduling or rendering.
   */
  readonly onAvSkew?: (skewUs: number) => void;
  readonly onError?: (mediaType: 'video' | 'audio', error: Error) => void;

  /** Feedback callback for pipeline backpressure. @see draft-ietf-moq-transport-16 §7 */
  readonly onFeedback?: (fb: DecoderFeedback) => void;

  /**
   * Recompute video render time at decode output.
   *
   * Called when a decoded VideoFrame arrives, with the frame's CaptureTimestamp.
   * Returns a fresh render time computed from the SyncController at THIS moment,
   * not the stale render time computed at pipeline processing time.
   *
   * This eliminates startup stutter from async decode latency — render times
   * are always relative to the current clock, not the clock at decode input.
   *
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
   */
  readonly recomputeVideoRenderTime?: (captureTimestampUs: bigint) => number;
  /** Current playback delay (µs) for A/V sync — applied to audio so it
   *  matches the same delay that recomputeVideoRenderTime adds to video. */
  readonly getPlaybackDelayUs?: () => number;

  /**
   * Returns true when the sync reference is established.
   * When false, decoded video frames are held in a queue instead of
   * being sent to the renderer. Drained on the first frame arrival
   * after the reference is ready.
   * @see Chromium VideoRendererAlgorithm (OnTimeProgressing gate)
   */
  readonly hasSyncReference?: () => boolean;
}

// ─── CommandDispatcher ────────────────────────────────────────────────

/**
 * Routes DecoderCommands to browser adapter instances.
 *
 * The PlaybackPipeline (sans-I/O) emits typed commands. This class
 * translates them into adapter method calls and wires the adapter
 * callbacks (decoded frames, errors) back to the player's event system.
 */
export class CommandDispatcher {
  private readonly videoDecoder: VideoDecoderLike | undefined;
  private readonly audioDecoder: AudioDecoderLike | undefined;
  private readonly renderer: VideoRendererLike | undefined;
  private readonly audioOutput: AudioOutputLike | undefined;

  private videoCodec: string;
  private videoWidth: number | undefined;
  private videoHeight: number | undefined;
  private readonly audioCodec: string;
  private readonly audioSampleRate: number | undefined;
  private readonly audioChannels: number | undefined;

  private readonly onError: ((mediaType: 'video' | 'audio', error: Error) => void) | undefined;
  private readonly onFeedback: ((fb: DecoderFeedback) => void) | undefined;

  /** Hysteresis state for queue pressure — prevents oscillation. */
  private videoQueuePressureHigh = false;
  private audioQueuePressureHigh = false;

  /** Hold queue for video frames decoded before sync reference exists. */
  private readonly videoHoldQueue: Array<{ frame: unknown; captureTimestampUs: bigint }> = [];
  private static readonly MAX_HOLD_QUEUE = 30; // 1 GOP at 30fps
  private readonly _hasSyncReference: (() => boolean) | undefined;
  private readonly _recomputeVideoRenderTime: ((captureTimestampUs: bigint) => number) | undefined;
  // @ts-expect-error Reserved for future playback delay compensation
  private readonly _getPlaybackDelayUs: (() => number) | undefined;

  constructor(opts: CommandDispatcherOptions) {
    this.videoDecoder = opts.videoDecoder;
    this.audioDecoder = opts.audioDecoder;
    this.renderer = opts.renderer;
    this.audioOutput = opts.audioOutput;

    this.videoCodec = opts.videoCodec ?? '';
    this.videoWidth = opts.videoWidth;
    this.videoHeight = opts.videoHeight;
    this.audioCodec = opts.audioCodec ?? '';
    this.audioSampleRate = opts.audioSampleRate;
    this.audioChannels = opts.audioChannels;
    this.onError = opts.onError;
    this.onFeedback = opts.onFeedback;
    this._hasSyncReference = opts.hasSyncReference;
    this._recomputeVideoRenderTime = opts.recomputeVideoRenderTime;
    this._getPlaybackDelayUs = opts.getPlaybackDelayUs;

    // Wire video decoder → renderer
    // Also check queue pressure on output — this is the un-throttle path.
    // When throttled, no decode() calls happen, so the only way to observe
    // the queue shrinking is when the decoder outputs a decoded frame.
    if (this.videoDecoder && this.renderer) {
      const renderer = this.renderer;
      const vd = this.videoDecoder;
      const recompute = opts.recomputeVideoRenderTime;
      this.videoDecoder.onFrame = (frame, renderTimeUs) => {
        const captureTs = BigInt((frame as any).timestamp);
        const syncReady = this._hasSyncReference?.() ?? true;

        if (!syncReady) {
          // No sync reference yet — hold frame, decode eagerly but don't render.
          // @see Chromium: VideoRendererAlgorithm only starts after OnTimeProgressing()
          if (this.videoHoldQueue.length >= CommandDispatcher.MAX_HOLD_QUEUE) {
            // Cap at 1 GOP — close oldest to prevent GPU memory leak
            const oldest = this.videoHoldQueue.shift()!;
            (oldest.frame as any).close?.();
          }
          this.videoHoldQueue.push({ frame, captureTimestampUs: captureTs });
          this.checkQueuePressure('video', vd);
          return;
        }

        // Drain any held frames first (reference just became ready)
        this.drainVideoHoldQueue(renderer);

        // Recompute render time at decode OUTPUT for correct pacing.
        const actualRenderTime = recompute
          ? recompute(captureTs)
          : renderTimeUs;
        renderer.enqueue(frame, actualRenderTime);
        this.checkQueuePressure('video', vd);
      };
    }

    // Wire audio decoder → audio output (same un-throttle path as video)
    if (this.audioDecoder && this.audioOutput) {
      const audioOutput = this.audioOutput;
      const ad = this.audioDecoder;
      this.audioDecoder.onData = (data, renderTimeUs) => {
        // WebAudioOutput.schedule() already applies its own playback
        // delay (200ms) on the first-chunk anchor. Adding our
        // getPlaybackDelayUs here would double-delay audio relative
        // to video (which gets 200ms via recomputeVideoRenderTime).
        audioOutput.schedule(data, renderTimeUs);
        this.checkQueuePressure('audio', ad);
      };
    }

    // Wire decoder errors — fires BOTH onError and onFeedback (different purposes)
    if (this.videoDecoder) {
      this.videoDecoder.onError = (err) => {
        opts.onError?.('video', err);
        this.onFeedback?.({ type: 'decode_error', mediaType: 'video', message: err.message });
      };
    }
    if (this.audioDecoder) {
      this.audioDecoder.onError = (err) => {
        opts.onError?.('audio', err);
        this.onFeedback?.({ type: 'decode_error', mediaType: 'audio', message: err.message });
      };
    }

    // Wire renderer lifecycle events
    if (this.renderer) {
      if (opts.onFirstFrame) {
        const onFirstFrame = opts.onFirstFrame;
        this.renderer.onFirstFrame = () => onFirstFrame();
      }
      if (opts.onStall) {
        const onStall = opts.onStall;
        this.renderer.onStall = (durationMs) => onStall(durationMs);
      }
      // Always wire onFrameRendered when renderer exists — for feedback path.
      // User callback is also fired if provided.
      const audioOutput = this.audioOutput;
      this.renderer.onFrameRendered = (captureTimestampUs, actualRenderUs) => {
        opts.onFrameRendered?.(captureTimestampUs, actualRenderUs);
        // A/V skew observability: compare the rendered frame's capture
        // timestamp against what the speakers are playing RIGHT NOW.
        // Measurement only — no scheduling/render behavior depends on it.
        if (opts.onAvSkew && audioOutput?.playheadCaptureUs) {
          const playheadUs = audioOutput.playheadCaptureUs();
          if (playheadUs !== null) {
            opts.onAvSkew(Number(captureTimestampUs) - playheadUs);
          }
        }
        this.onFeedback?.({ type: 'frame_rendered', mediaType: 'video', captureTimestampUs, actualRenderUs });
      };
    }
  }

  /**
   * Update video codec metadata for subsequent configure commands.
   * Called during track switch when the codec changes (e.g., H.264 → HEVC).
   */
  updateVideoCodec(codec: string, width?: number, height?: number): void {
    this.videoCodec = codec;
    this.videoWidth = width;
    this.videoHeight = height;
  }

  /**
   * Dispatch a decoder command to the appropriate adapter.
   *
   * @see draft-ietf-moq-loc-01 §2.1 (decode_video)
   * @see draft-ietf-moq-loc-01 §4.1 (decode_audio)
   * @see draft-ietf-moq-loc-01 §2.3.2.1 (configure video)
   */
  dispatch(cmd: DecoderCommand): void {
    switch (cmd.type) {
      case 'configure':
        if (cmd.mediaType === 'video') {
          this.videoDecoder?.configure(
            cmd.config, this.videoCodec, this.videoWidth, this.videoHeight,
          );
        } else {
          this.audioDecoder?.configure(
            cmd.config, this.audioCodec, this.audioSampleRate, this.audioChannels,
          );
        }
        break;

      case 'decode_video':
        try {
          this.videoDecoder?.decode(cmd.chunk, cmd.renderTimeUs);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          this.onError?.('video', e);
          this.onFeedback?.({ type: 'decode_error', mediaType: 'video', message: e.message });
        }
        if (this.videoDecoder) this.checkQueuePressure('video', this.videoDecoder);
        break;

      case 'decode_audio':
        try {
          this.audioDecoder?.decode(cmd.chunk, cmd.renderTimeUs);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          this.onError?.('audio', e);
          this.onFeedback?.({ type: 'decode_error', mediaType: 'audio', message: e.message });
        }
        if (this.audioDecoder) this.checkQueuePressure('audio', this.audioDecoder);
        break;

      case 'flush':
        if (cmd.mediaType === 'video') {
          const p = this.videoDecoder?.flush();
          if (p) p.then(() => this.onFeedback?.({ type: 'flush_complete', mediaType: 'video' }));
        } else {
          const p = this.audioDecoder?.flush();
          if (p) p.then(() => this.onFeedback?.({ type: 'flush_complete', mediaType: 'audio' }));
        }
        break;

      case 'reset':
        if (cmd.mediaType === 'video') {
          this.closeVideoHoldQueue();
          this.renderer?.flush();
          this.videoDecoder?.reset();
          this.videoQueuePressureHigh = false;
        } else {
          this.audioDecoder?.reset();
          this.audioOutput?.flush?.();
          this.audioQueuePressureHigh = false;
        }
        break;

      case 'set_playback_rate':
        // Route to audio output — video catch-up uses frame dropping, not rate.
        // Optional chaining: AudioOutputLike.setPlaybackRate is optional.
        // @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
        this.audioOutput?.setPlaybackRate?.(cmd.rate);
        break;
    }
  }

  /**
   * Check decoder queue depth and emit queue_pressure feedback with hysteresis.
   *
   * Pressure emitted when crossing HIGH going up, LOW going down.
   * Prevents oscillation from rapid depth changes.
   *
   * @see draft-ietf-moq-transport-16 §7
   */
  private checkQueuePressure(
    mediaType: 'video' | 'audio',
    decoder: { readonly queueDepth: number },
  ): void {
    if (!this.onFeedback) return;
    const depth = decoder.queueDepth;
    const isVideo = mediaType === 'video';
    const wasHigh = isVideo ? this.videoQueuePressureHigh : this.audioQueuePressureHigh;

    if (!wasHigh && depth >= QUEUE_HIGH_THRESHOLD) {
      // Crossed high threshold going up
      if (isVideo) this.videoQueuePressureHigh = true;
      else this.audioQueuePressureHigh = true;
      this.onFeedback({
        type: 'queue_pressure', mediaType, depth, maxRecommended: QUEUE_HIGH_THRESHOLD,
      });
    } else if (wasHigh && depth <= QUEUE_LOW_THRESHOLD) {
      // Crossed low threshold going down
      if (isVideo) this.videoQueuePressureHigh = false;
      else this.audioQueuePressureHigh = false;
      this.onFeedback({
        type: 'queue_pressure', mediaType, depth, maxRecommended: QUEUE_HIGH_THRESHOLD,
      });
    }
  }

  /** Drain held video frames to renderer with recomputed render times. */
  private drainVideoHoldQueue(renderer: VideoRendererLike): void {
    for (const held of this.videoHoldQueue) {
      const renderTimeUs = this._recomputeVideoRenderTime
        ? this._recomputeVideoRenderTime(held.captureTimestampUs)
        : 0;
      renderer.enqueue(held.frame, renderTimeUs);
    }
    this.videoHoldQueue.length = 0;
  }

  /** Close all held video frames (GPU memory!). */
  private closeVideoHoldQueue(): void {
    for (const held of this.videoHoldQueue) {
      (held.frame as any).close?.();
    }
    this.videoHoldQueue.length = 0;
  }

  /** Flush all pending output — stop scheduled audio and discard queued frames. */
  flush(): void {
    this.closeVideoHoldQueue();
    this.renderer?.flush();
    this.audioOutput?.flush();
  }

  /** Release all adapter resources. */
  destroy(): void {
    this.closeVideoHoldQueue();
    this.videoDecoder?.destroy();
    this.audioDecoder?.destroy();
    this.renderer?.destroy();
    this.audioOutput?.destroy();
  }
}
