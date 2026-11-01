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

import type { DecoderCommand, DecoderFeedback } from '@openmoq/playback';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike, VideoPresentation } from './interfaces.js';

/** Optional engine-owned unit creation at actual native output, before target submission. */
export type DispatcherOutputReason = 'hold queue overflow' | 'decoder reset' | 'flushed' | 'destroyed' | 'output failed';
export interface DispatcherOutputObserver {
  decoded(mediaType: 'video' | 'audio', input: object | undefined, target: VideoRendererLike | AudioOutputLike): object | undefined;
  discarded(unit: object, reason: DispatcherOutputReason): void | Promise<void>;
}
interface OutputOwnership { readonly observer: DispatcherOutputObserver; readonly token: object }
interface HeldVideo { readonly frame: unknown; readonly captureTimestampUs: bigint; observation?: OutputOwnership }

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
  /** A detected stall ended with a rendered frame. Full outage length. */
  readonly onStallRecovered?: (durationMs: number) => void;
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
  private renderFeedbackRetired = false;

  /** Hold queue for video frames decoded before sync reference exists. */
  private readonly videoHoldQueue: HeldVideo[] = [];
  private _outputObserver: DispatcherOutputObserver | undefined;
  private outputRevision = 0;
  private audioOutputRevision = 0;
  private outputRetirementReason: DispatcherOutputReason = 'flushed';
  private audioRetirementReason: DispatcherOutputReason = 'flushed';

  /** Reassignment ends evidence, not playback; no old unit passes into a new observer lifetime. */
  set outputObserver(observer: DispatcherOutputObserver | undefined) {
    this._outputObserver = observer;
    for (const held of this.videoHoldQueue) delete held.observation;
  }

  private decodedOutput(mediaType: 'video' | 'audio', input: object | undefined,
      target: VideoRendererLike | AudioOutputLike): OutputOwnership | undefined {
    const observer = this._outputObserver;
    if (!observer) return;
    try {
      const token = observer.decoded(mediaType, input, target);
      return token !== undefined ? { observer, token } : undefined;
    } catch { /* Optional metadata cannot prevent decode output. */ }
  }

  private discardOutput(ownership: OutputOwnership | undefined, reason: DispatcherOutputReason): void {
    if (!ownership) return;
    try { const pending = ownership.observer.discarded(ownership.token, reason); if (pending) void Promise.resolve(pending).catch(() => {}); }
    catch { /* Optional metadata cannot interrupt cleanup. */ }
  }

  private releaseOutputFrame(frame: unknown, ownership: OutputOwnership | undefined, reason: DispatcherOutputReason): void {
    try { (frame as { close?: () => void }).close?.(); }
    finally { this.discardOutput(ownership, reason); }
  }

  private releaseHeld(held: HeldVideo, reason: DispatcherOutputReason): void {
    const ownership = held.observation;
    delete held.observation;
    this.releaseOutputFrame(held.frame, ownership, reason);
  }
  private static readonly MAX_HOLD_QUEUE = 30; // 1 GOP at 30fps
  private readonly _hasSyncReference: (() => boolean) | undefined;
  private readonly _recomputeVideoRenderTime: ((captureTimestampUs: bigint) => number) | undefined;
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
      this.videoDecoder.onFrame = (frame, renderTimeUs, _sourceTimestamp, inputToken) => {
        if (this.renderFeedbackRetired) { (frame as { close?: () => void }).close?.(); return; }
        const revision = this.outputRevision;
        const captureTs = BigInt((frame as { timestamp: number }).timestamp);
        const observation = this.decodedOutput('video', inputToken, renderer);
        if (this.renderFeedbackRetired || this.outputRevision !== revision) {
          this.releaseOutputFrame(frame, observation, this.outputRetirementReason); return;
        }
        let syncReady: boolean;
        try { syncReady = this._hasSyncReference?.() ?? true; }
        catch (error) { this.releaseOutputFrame(frame, observation, 'output failed'); throw error; }
        if (this.renderFeedbackRetired || this.outputRevision !== revision) {
          this.releaseOutputFrame(frame, observation, this.outputRetirementReason); return;
        }
        if (!syncReady) {
          // Admission precedes overflow reporting, so a reentrant reset owns the new entry too.
          const oldest = this.videoHoldQueue.length >= CommandDispatcher.MAX_HOLD_QUEUE ? this.videoHoldQueue.shift() : undefined;
          this.videoHoldQueue.push({ frame, captureTimestampUs: captureTs, ...(observation ? { observation } : {}) });
          if (oldest) this.releaseHeld(oldest, 'hold queue overflow');
          if (!this.renderFeedbackRetired && this.outputRevision === revision) this.checkQueuePressure('video', vd);
          return;
        }
        try { this.drainVideoHoldQueue(renderer, revision); }
        catch (error) { this.releaseOutputFrame(frame, observation, 'output failed'); throw error; }
        if (this.renderFeedbackRetired || this.outputRevision !== revision) {
          this.releaseOutputFrame(frame, observation, this.outputRetirementReason); return;
        }
        let actualRenderTime: number;
        try { actualRenderTime = recompute ? recompute(captureTs) : renderTimeUs; }
        catch (error) { this.releaseOutputFrame(frame, observation, 'output failed'); throw error; }
        if (this.renderFeedbackRetired || this.outputRevision !== revision) {
          this.releaseOutputFrame(frame, observation, this.outputRetirementReason); return;
        }
        this.enqueueVideo(renderer, frame, observation, actualRenderTime);
        if (!this.renderFeedbackRetired && this.outputRevision === revision) this.checkQueuePressure('video', vd);
      };
    }

    // Wire audio decoder → audio output (same un-throttle path as video).
    if (this.audioDecoder && this.audioOutput) {
      const audioOutput = this.audioOutput;
      const ad = this.audioDecoder;
      this.audioDecoder.onData = (data, renderTimeUs, inputToken) => {
        if (this.renderFeedbackRetired) { (data as { close?: () => void }).close?.(); return; }
        const revision = this.audioOutputRevision;
        const observation = this.decodedOutput('audio', inputToken, audioOutput);
        let cushionUs: number;
        try { cushionUs = this._getPlaybackDelayUs?.() ?? 0; }
        catch (error) {
          try { (data as { close?: () => void }).close?.(); }
          finally { this.discardOutput(observation, 'output failed'); }
          throw error;
        }
        if (this.renderFeedbackRetired || this.audioOutputRevision !== revision) {
          try { (data as { close?: () => void }).close?.(); }
          finally { this.discardOutput(observation, this.audioRetirementReason); }
          return;
        }
        // The shared cushion reaches WebAudioOutput at its next anchor/underrun;
        // a healthy chain remains back-to-back, as before.
        try {
          if (observation) audioOutput.schedule(data, renderTimeUs + cushionUs, observation.token);
          else audioOutput.schedule(data, renderTimeUs + cushionUs);
        } catch (error) { this.discardOutput(observation, 'output failed'); throw error; }
        if (!this.renderFeedbackRetired && this.audioOutputRevision === revision) this.checkQueuePressure('audio', ad);
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
      if (opts.onStallRecovered) {
        const onStallRecovered = opts.onStallRecovered;
        this.renderer.onStallRecovered = (durationMs) => onStallRecovered(durationMs);
      }
      // Always wire onFrameRendered when renderer exists — for feedback path.
      // User callback is also fired if provided.
      const audioOutput = this.audioOutput;
      this.renderer.onFrameRendered = (captureTimestampUs, actualRenderUs, scheduledRenderUs) => {
        if (this.renderFeedbackRetired) return;
        opts.onFrameRendered?.(captureTimestampUs, actualRenderUs);
        if (this.renderFeedbackRetired) return;
        // A/V skew observability: compare the rendered frame's capture
        // timestamp against what the speakers are playing RIGHT NOW.
        // Measurement only — no scheduling/render behavior depends on it.
        if (opts.onAvSkew && audioOutput?.playheadCaptureUs) {
          const playheadUs = audioOutput.playheadCaptureUs();
          if (this.renderFeedbackRetired) return;
          if (playheadUs !== null) {
            opts.onAvSkew(Number(captureTimestampUs) - playheadUs);
          }
        }
        if (this.renderFeedbackRetired) return;
        this.onFeedback?.({
          type: 'frame_rendered', mediaType: 'video', captureTimestampUs, actualRenderUs,
          ...(scheduledRenderUs !== undefined ? { scheduledRenderUs } : {}),
        });
      };
    }
  }

  /** Whether this dispatcher actually owns that decoder-to-output callback. */
  canObserveDecodedOutputs(mediaType: 'video' | 'audio'): boolean {
    return !this.renderFeedbackRetired && (mediaType === 'video'
      ? this.videoDecoder !== undefined && this.renderer !== undefined
      : this.audioDecoder !== undefined && this.audioOutput !== undefined);
  }

  /** Historical draw evidence; unavailable without the optional renderer hook. */
  get videoPresentation(): VideoPresentation | null {
    if (this.renderFeedbackRetired) return null;
    const observation = this.renderer?.videoPresentation;
    if (!observation || this.renderFeedbackRetired) return null;
    const snapshot: VideoPresentation = {
      frameTimestampUs: observation.frameTimestampUs,
      timestampDomain: observation.timestampDomain,
      renderedAtUs: observation.renderedAtUs,
    };
    return this.renderFeedbackRetired ? null : Object.freeze(snapshot);
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
          if (cmd.inputToken !== undefined) this.videoDecoder?.decode(cmd.chunk, cmd.renderTimeUs, cmd.inputToken);
          else this.videoDecoder?.decode(cmd.chunk, cmd.renderTimeUs);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          this.onError?.('video', e);
          this.onFeedback?.({ type: 'decode_error', mediaType: 'video', message: e.message });
        }
        if (this.videoDecoder) this.checkQueuePressure('video', this.videoDecoder);
        break;

      case 'decode_audio':
        try {
          if (cmd.inputToken !== undefined) this.audioDecoder?.decode(cmd.chunk, cmd.renderTimeUs, cmd.inputToken);
          else this.audioDecoder?.decode(cmd.chunk, cmd.renderTimeUs);
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
          this.outputRevision++;
          this.outputRetirementReason = 'decoder reset';
          this.closeVideoHoldQueue('decoder reset');
          this.renderer?.flush();
          this.videoDecoder?.reset();
          this.videoQueuePressureHigh = false;
        } else {
          this.audioOutputRevision++;
          this.audioRetirementReason = 'decoder reset';
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

  private enqueueVideo(renderer: VideoRendererLike, frame: unknown, observation: OutputOwnership | undefined, renderTimeUs: number): void {
    try {
      if (observation) renderer.enqueue(frame, renderTimeUs, observation.token);
      else renderer.enqueue(frame, renderTimeUs);
    } catch (error) { this.discardOutput(observation, 'output failed'); throw error; }
  }

  /** Remove before delivery so reentrant flush owns only the not-yet-submitted entries. */
  private drainVideoHoldQueue(renderer: VideoRendererLike, revision: number): void {
    while (this.videoHoldQueue.length && !this.renderFeedbackRetired && this.outputRevision === revision) {
      const held = this.videoHoldQueue.shift()!;
      let renderTimeUs: number;
      try { renderTimeUs = this._recomputeVideoRenderTime ? this._recomputeVideoRenderTime(held.captureTimestampUs) : 0; }
      catch (error) { this.releaseHeld(held, 'output failed'); throw error; }
      if (this.renderFeedbackRetired || this.outputRevision !== revision) {
        this.releaseHeld(held, this.outputRetirementReason); return;
      }
      const observation = held.observation;
      delete held.observation;
      this.enqueueVideo(renderer, held.frame, observation, renderTimeUs);
    }
  }

  /** Detach before cleanup so observer reentry cannot close a frame twice. */
  private closeVideoHoldQueue(reason: DispatcherOutputReason): void {
    const held = this.videoHoldQueue.splice(0);
    for (const entry of held) this.releaseHeld(entry, reason);
  }

  /**
   * Flush all pending output — stop scheduled audio and discard queued frames.
   *
   * Reached only from pause and from a seek, both of which supersede playback
   * rather than recover it, so any in-flight stall episode is abandoned. The
   * `reset` command path deliberately does not do this: that flush is owned by
   * stall recovery, and its episode must survive to be completed by the next
   * rendered frame.
   */
  flush(): void {
    this.outputRevision++;
    this.outputRetirementReason = 'flushed';
    this.audioOutputRevision++;
    this.audioRetirementReason = 'flushed';
    // Cancel BEFORE the fallible flush: a custom renderer whose flush throws
    // would otherwise leave the episode live across an intentional pause.
    this.renderer?.cancelStallEpisode?.();
    this.closeVideoHoldQueue('flushed');
    this.renderer?.flush();
    this.audioOutput?.flush();
  }

  /** Release all adapter resources. */
  destroy(): void {
    // Retire before fallible cleanup; custom adapters may retain callbacks.
    this.renderFeedbackRetired = true;
    this.outputRevision++;
    this.outputRetirementReason = 'destroyed';
    this.audioOutputRevision++;
    this.audioRetirementReason = 'destroyed';
    this.closeVideoHoldQueue('destroyed');
    this.videoDecoder?.destroy();
    this.audioDecoder?.destroy();
    this.renderer?.destroy();
    this.audioOutput?.destroy();
  }
}
