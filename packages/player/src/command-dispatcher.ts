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

import type { SourceTimestamp } from '@openmoq/loc';
import type { DecoderCommand, DecoderFeedback, VideoRenderTiming, AudioRenderTiming } from '@openmoq/playback';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike, VideoPresentation, VideoProducedTiming } from './interfaces.js';

/** Exact arguments of an adapter configure call that returned normally.
 * config owns a snapshot of the actual byte view before adapter invocation.
 * This is not asynchronous decoder readiness or proof of produced output.
 */
export type ConfiguredDecoder =
  | { readonly mediaType: 'video'; readonly codec: string; readonly config: Uint8Array; readonly width?: number; readonly height?: number }
  | { readonly mediaType: 'audio'; readonly codec: string; readonly config: Uint8Array; readonly sampleRate?: number; readonly channels?: number };

/** Optional engine-owned unit creation at actual native output, before target submission. */
export type DispatcherOutputReason = 'hold queue overflow' | 'decoder reset' | 'flushed' | 'destroyed' | 'output failed' | 'output refused';
export interface VideoOutputAdmission {
  decide(timing: VideoProducedTiming): 'enqueue' | 'hold' | 'discard';
  discarded(timing: VideoProducedTiming, reason: DispatcherOutputReason): void | Promise<void>;
}
export interface VideoOutputAdmissionLease {
  /** Pure registration/lifetime query; does not consult adapters or owner callbacks. */
  readonly current: boolean;
  /** Idempotent, exact-registration withdrawal; renderer-owned frames are unaffected. */
  release(): void;
}
export interface DispatcherOutputObserver {
  decoded(mediaType: 'video' | 'audio', input: object | undefined, target: VideoRendererLike | AudioOutputLike): object | undefined;
  discarded(unit: object, reason: DispatcherOutputReason): void | Promise<void>;
}
type AudioTimingRefusal = Extract<DecoderFeedback, { type: 'audio_timing_unavailable' }>['reason'];
interface OutputOwnership { readonly observer: DispatcherOutputObserver; readonly token: object }
interface VideoAdmissionBinding {
  readonly owner: VideoOutputAdmission;
  readonly decide: VideoOutputAdmission['decide'];
  readonly discarded: VideoOutputAdmission['discarded'];
}
interface HeldVideo {
  readonly frame: unknown;
  readonly captureTimestampUs?: bigint;
  readonly renderTiming?: VideoRenderTiming;
  readonly outputTiming?: VideoProducedTiming;
  observation?: OutputOwnership;
  admission?: VideoAdmissionBinding;
}

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
  private videoOutputRetired = false;
  private get videoRetired(): boolean { return this.renderFeedbackRetired || this.videoOutputRetired; }

  /** Hold queue for video frames decoded before sync reference exists. */
  private readonly videoHoldQueue: HeldVideo[] = [];
  private _outputObserver: DispatcherOutputObserver | undefined;
  private videoAdmission: VideoAdmissionBinding | undefined;
  private outputRevision = 0;
  private audioOutputRevision = 0;
  private audioQueueChangeBinding: { readonly callback: () => void; unsubscribe: (() => void) | undefined } | undefined;
  private videoQueueChangeBinding: { readonly callback: () => void; unsubscribe: (() => void) | undefined } | undefined;
  private audioTimingArmed = false;
  private audioTimingContexts: WeakSet<AudioRenderTiming> | undefined;
  private outputRetirementReason: DispatcherOutputReason = 'flushed';
  private audioRetirementReason: DispatcherOutputReason = 'flushed';

  /** Reassignment ends evidence, not playback; no old unit passes into a new observer lifetime. */
  set outputObserver(observer: DispatcherOutputObserver | undefined) {
    this._outputObserver = observer;
    for (const held of this.videoHoldQueue) delete held.observation;
  }

  /** One functional output owner, independent of optional diagnostic units.
   * Decisions may repeat for a held proof; reservations must be idempotent.
   * The caller still owns retirement of frames already handed to the renderer. */
  installVideoOutputAdmission(owner: VideoOutputAdmission): VideoOutputAdmissionLease {
    if (this.videoRetired) throw new Error('Video output is destroyed');
    const previous = this.videoAdmission;
    const decide = owner.decide, discarded = owner.discarded;
    // Registration reads are external code; neither destruction nor a newer
    // binding can be overwritten when those reads return.
    if (this.videoRetired) throw new Error('Video output is destroyed');
    if (this.videoAdmission !== previous) throw new Error('Video output admission changed during registration');
    if (typeof decide !== 'function' || typeof discarded !== 'function') {
      throw new TypeError('Expected synchronous video admission and a discard handler');
    }
    const binding = Object.freeze({ owner, decide, discarded });
    const dispatcher = this;
    let released = false;
    const lease: VideoOutputAdmissionLease = Object.freeze({
      get current() { return !released && !dispatcher.videoRetired && dispatcher.videoAdmission === binding; },
      release() {
        if (released) return;
        released = true;
        dispatcher.releaseVideoOutputAdmission(binding);
      },
    });
    // Publish before old frame-close/discard or pressure callbacks can reenter.
    this.videoAdmission = binding;
    try {
      this.retireVideoAdmissionFrames(previous);
      if (!this.videoRetired && this.videoAdmission === binding && this.videoDecoder) {
        this.checkQueuePressure('video', this.videoDecoder);
      }
    } catch (error) {
      // A throwing installation cannot leave its own registration without a
      // returned release authority. A replacement created in cleanup survives.
      try { lease.release(); } catch { /* Preserve the first installation error. */ }
      throw error;
    }
    return lease;
  }

  private releaseVideoOutputAdmission(binding: VideoAdmissionBinding): void {
    if (this.videoAdmission !== binding) return;
    this.videoAdmission = undefined;
    let failed = false, failure: unknown;
    try { this.retireVideoAdmissionFrames(binding); }
    catch (error) { failed = true; failure = error; }
    if (!this.videoRetired && this.videoAdmission === undefined && this.videoDecoder) {
      try { this.checkQueuePressure('video', this.videoDecoder); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    if (failed) throw failure;
  }

  private retireVideoAdmissionFrames(binding: VideoAdmissionBinding | undefined): void {
    // First arming retires ordinary sync-held entries too. They have never
    // received the newly installed owner's decision, even if a proof exists.
    const removed = this.videoHoldQueue.filter(held => held.admission === binding);
    for (const held of removed) this.videoHoldQueue.splice(this.videoHoldQueue.indexOf(held), 1);
    let failed = false, failure: unknown;
    for (const held of removed) {
      try { this.releaseHeld(held, 'output refused'); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    if (failed) throw failure;
  }

  /** Reconsider existing held outputs after the owner's readiness/intent changes. */
  refreshVideoOutputs(): void {
    if (this.videoRetired || !this.renderer || !this.videoHoldQueue.length) return;
    const revision = this.outputRevision, admission = this.videoAdmission;
    this.drainVideoHoldQueue(this.renderer, revision);
    if (!this.videoRetired && this.outputRevision === revision && this.videoAdmission === admission && this.videoDecoder) {
      this.checkQueuePressure('video', this.videoDecoder);
    }
  }

  private decideVideoOutput(binding: VideoAdmissionBinding, timing: VideoProducedTiming): 'enqueue' | 'hold' | 'discard' {
    const result: unknown = binding.decide.call(binding.owner, timing);
    if (result === 'enqueue' || result === 'hold' || result === 'discard') return result;
    if (result && (typeof result === 'object' || typeof result === 'function')) void Promise.resolve(result).catch(() => {});
    throw new TypeError('Video output admission must synchronously return enqueue, hold or discard');
  }

  private notifyVideoDiscard(binding: VideoAdmissionBinding | undefined, timing: VideoProducedTiming | undefined,
      reason: DispatcherOutputReason): void {
    if (!binding || !timing) return;
    try {
      const pending = binding.discarded.call(binding.owner, timing, reason);
      if (pending) void Promise.resolve(pending).catch(() => {});
    } catch { /* Cleanup must continue for the other owned frames. */ }
  }

  private reportVideoAdmissionError(error: unknown): void {
    this.onError?.('video', error instanceof Error ? error : new Error('Video output admission failed', { cause: error }));
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

  private releaseOutputFrame(frame: unknown, ownership: OutputOwnership | undefined, reason: DispatcherOutputReason,
      admission?: VideoAdmissionBinding, timing?: VideoProducedTiming): void {
    try { (frame as { close?: () => void }).close?.(); }
    finally { this.discardOutput(ownership, reason); this.notifyVideoDiscard(admission, timing, reason); }
  }

  private releaseHeld(held: HeldVideo, reason: DispatcherOutputReason): void {
    const ownership = held.observation, admission = held.admission;
    delete held.observation; delete held.admission;
    this.releaseOutputFrame(held.frame, ownership, reason, admission, held.outputTiming);
  }
  private static readonly MAX_HOLD_QUEUE = 30; // 1 GOP at 30fps
  private _hasSyncReference: (() => boolean) | undefined;
  private readonly _recomputeVideoRenderTime: ((captureTimestampUs: bigint) => number) | undefined;
  private _getPlaybackDelayUs: (() => number) | undefined;

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

    try { this.wireOutputs(opts); }
    catch (error) {
      // Adapters still belong to the constructing caller, but outputs already
      // transferred through a callback belong to this partial dispatcher.
      this.retireOutputAuthority();
      const failures: unknown[] = [error];
      for (const release of [() => this.clearAudioQueueChange(), () => this.clearVideoQueueChange(), () => this.closeVideoHoldQueue('destroyed')]) {
        try { release(); } catch (cleanupError) { failures.push(cleanupError); }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Output construction failed');
      throw error;
    }
  }

  private wireOutputs(opts: CommandDispatcherOptions): void {
    this.wireVideoQueueChange();
    if (this.renderFeedbackRetired) return;
    // Wire video decoder → renderer
    // Output callbacks supplement native queue progress. A codec can consume
    // inputs without producing a frame until a later input or terminal flush.
    if (this.videoDecoder && this.renderer) {
      const renderer = this.renderer;
      const vd = this.videoDecoder;
      const recompute = opts.recomputeVideoRenderTime;
      this.videoDecoder.onFrame = (frame, renderTimeUs, sourceTimestamp, inputToken, renderTiming) => {
        if (this.videoRetired) { (frame as { close?: () => void }).close?.(); return; }
        const revision = this.outputRevision, binding = this.videoAdmission;
        const captureTs = renderTiming === undefined ? BigInt((frame as { timestamp: number }).timestamp) : undefined;
        const observation = this.decodedOutput('video', inputToken, renderer);
        if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding) {
          this.releaseOutputFrame(frame, observation, this.outputRevision !== revision ? this.outputRetirementReason : 'output refused'); return;
        }
        if (renderTiming === null) {
          this.releaseOutputFrame(frame, observation, 'output failed');
          if (binding && this.videoAdmission === binding && !this.videoRetired && this.outputRevision === revision) {
            this.reportVideoAdmissionError(new Error('Video producing context is unavailable'));
          }
          if (!this.videoRetired && this.outputRevision === revision) this.checkQueuePressure('video', vd);
          return;
        }
        let outputTiming: VideoProducedTiming | undefined;
        try {
          if (renderTiming && sourceTimestamp && renderer.supportsOutputTiming === true) {
            outputTiming = this.videoProducingTiming(renderTiming, sourceTimestamp);
          }
        } catch (error) { this.releaseOutputFrame(frame, observation, 'output failed'); throw error; }
        if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding) {
          this.releaseOutputFrame(frame, observation, this.outputRevision !== revision ? this.outputRetirementReason : 'output refused', binding, outputTiming); return;
        }
        if (binding && outputTiming === undefined) {
          this.releaseOutputFrame(frame, observation, 'output failed');
          if (this.videoAdmission === binding && !this.videoRetired && this.outputRevision === revision) {
            this.reportVideoAdmissionError(new Error('Video producing source is unavailable'));
          }
          return;
        }
        const admission = outputTiming ? binding : undefined;
        let decision: 'enqueue' | 'hold' | 'discard' = 'enqueue';
        try { if (admission) decision = this.decideVideoOutput(admission, outputTiming!); }
        catch (error) {
          this.releaseOutputFrame(frame, observation, 'output failed', admission, outputTiming);
          if (!this.videoRetired && this.outputRevision === revision && this.videoAdmission === admission) this.reportVideoAdmissionError(error);
          return;
        }
        if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding) {
          this.releaseOutputFrame(frame, observation, this.outputRevision !== revision ? this.outputRetirementReason : 'output refused', admission, outputTiming); return;
        }
        if (decision === 'discard') {
          this.releaseOutputFrame(frame, observation, 'output refused', admission, outputTiming);
          if (!this.videoRetired && this.outputRevision === revision && this.videoAdmission === binding) {
            this.checkQueuePressure('video', vd);
          }
          return;
        }
        let syncReady: boolean;
        try { syncReady = this._hasSyncReference?.() ?? true; }
        catch (error) { this.releaseOutputFrame(frame, observation, 'output failed', admission, outputTiming); throw error; }
        if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding) {
          this.releaseOutputFrame(frame, observation, this.outputRevision !== revision ? this.outputRetirementReason : 'output refused', admission, outputTiming); return;
        }
        if (decision === 'hold' || !syncReady) {
          const oldest = this.videoHoldQueue.length >= CommandDispatcher.MAX_HOLD_QUEUE ? this.videoHoldQueue.shift() : undefined;
          this.videoHoldQueue.push(renderTiming
            ? { frame, renderTiming, ...(outputTiming ? { outputTiming } : {}), ...(admission ? { admission } : {}), ...(observation ? { observation } : {}) }
            : { frame, captureTimestampUs: captureTs!, ...(observation ? { observation } : {}) });
          if (oldest) this.releaseHeld(oldest, 'hold queue overflow');
          if (!this.videoRetired && this.outputRevision === revision) this.checkQueuePressure('video', vd);
          return;
        }
        try { this.drainVideoHoldQueue(renderer, revision); }
        catch (error) { this.releaseOutputFrame(frame, observation, 'output failed', admission, outputTiming); throw error; }
        if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding) {
          this.releaseOutputFrame(frame, observation, this.outputRevision !== revision ? this.outputRetirementReason : 'output refused', admission, outputTiming); return;
        }
        let actualRenderTime: number | null;
        try { actualRenderTime = renderTiming ? this.mappedVideoRenderTime(renderTiming, revision)
          : recompute ? recompute(captureTs!) : renderTimeUs; }
        catch (error) { this.releaseOutputFrame(frame, observation, 'output failed', admission, outputTiming); throw error; }
        if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding) {
          this.releaseOutputFrame(frame, observation, this.outputRevision !== revision ? this.outputRetirementReason : 'output refused', admission, outputTiming); return;
        }
        if (actualRenderTime === null) {
          this.releaseOutputFrame(frame, observation, 'output failed', admission, outputTiming);
          if (!this.videoRetired && this.outputRevision === revision) this.checkQueuePressure('video', vd);
          return;
        }
        this.enqueueVideo(renderer, frame, observation, actualRenderTime, outputTiming, admission);
        if (!this.videoRetired && this.outputRevision === revision) this.checkQueuePressure('video', vd);
      };
    }

    this.wireAudioOutput();
    if (this.renderFeedbackRetired) return;

    // Wire decoder errors — fires BOTH onError and onFeedback (different purposes)
    if (this.videoDecoder) {
      this.videoDecoder.onError = (err) => {
        if (this.videoRetired) return;
        opts.onError?.('video', err);
        if (this.videoRetired) return;
        this.onFeedback?.({ type: 'decode_error', mediaType: 'video', message: err.message });
      };
    }
    if (this.audioDecoder) {
      this.audioDecoder.onError = (err) => {
        if (this.renderFeedbackRetired) return;
        opts.onError?.('audio', err);
        if (this.renderFeedbackRetired) return;
        this.onFeedback?.({ type: 'decode_error', mediaType: 'audio', message: err.message });
      };
    }

    // Wire renderer lifecycle events
    if (this.renderer) {
      if (opts.onFirstFrame) {
        const onFirstFrame = opts.onFirstFrame;
        this.renderer.onFirstFrame = () => { if (!this.videoRetired) onFirstFrame(); };
      }
      if (opts.onStall) {
        const onStall = opts.onStall;
        this.renderer.onStall = (durationMs) => { if (!this.videoRetired) onStall(durationMs); };
      }
      if (opts.onStallRecovered) {
        const onStallRecovered = opts.onStallRecovered;
        this.renderer.onStallRecovered = (durationMs) => { if (!this.videoRetired) onStallRecovered(durationMs); };
      }
      // Always wire onFrameRendered when renderer exists — for feedback path.
      // User callback is also fired if provided.
      const audioOutput = this.audioOutput;
      this.renderer.onFrameRendered = (captureTimestampUs, actualRenderUs, scheduledRenderUs) => {
        if (this.videoRetired) return;
        opts.onFrameRendered?.(captureTimestampUs, actualRenderUs);
        if (this.videoRetired) return;
        // A/V skew observability: compare the rendered frame's capture
        // timestamp against what the speakers are playing RIGHT NOW.
        // Measurement only — no scheduling/render behavior depends on it.
        if (opts.onAvSkew && audioOutput?.playheadCaptureUs) {
          const playheadUs = audioOutput.playheadCaptureUs();
          if (this.videoRetired) return;
          if (playheadUs !== null) {
            opts.onAvSkew(Number(captureTimestampUs) - playheadUs);
          }
        }
        if (this.videoRetired) return;
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
      ? !this.videoOutputRetired && this.videoDecoder !== undefined && this.renderer !== undefined
      : this.audioDecoder !== undefined && this.audioOutput !== undefined);
  }

  /** A mapped selection requires the decoder to preserve each input's producing context. */
  get supportsVideoOutputTiming(): boolean {
    return !this.videoRetired && this.videoDecoder?.supportsOutputTiming === true;
  }

  /** Historical draw evidence; unavailable without the optional renderer hook. */
  get videoPresentation(): VideoPresentation | null {
    if (this.videoRetired) return null;
    const observation = this.renderer?.videoPresentation;
    if (!observation || this.videoRetired) return null;
    const snapshot: VideoPresentation = {
      frameTimestampUs: observation.frameTimestampUs,
      timestampDomain: observation.timestampDomain,
      renderedAtUs: observation.renderedAtUs,
    };
    return this.videoRetired ? null : Object.freeze(snapshot);
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

  private audioTimingUnavailable(reason: AudioTimingRefusal, revision: number): void {
    if (this.renderFeedbackRetired || this.audioOutputRevision !== revision) return;
    this.onFeedback?.({ type: 'audio_timing_unavailable', mediaType: 'audio', reason });
  }

  private audioSchedule(timing: AudioRenderTiming, offset: number): number | null {
    try {
      const time = timing.recomputeRenderTimeUs(offset);
      return typeof time === 'number' && Number.isFinite(time) ? time : null;
    } catch { return null; }
  }

  private retireAudioTiming(): void {
    this.audioTimingArmed = false;
    this.audioTimingContexts = undefined;
    this.wireAudioOutput();
  }

  private wireAudioOutput(): void {
    const ad = this.audioDecoder, audioOutput = this.audioOutput;
    if (!ad || this.renderFeedbackRetired) return;
    const callbackRevision = this.audioOutputRevision;
    const binding = { callback: () => {
      if (current()) this.checkQueuePressure('audio', ad, current);
    }, unsubscribe: undefined as (() => void) | undefined };
    const current = () => !this.renderFeedbackRetired && this.audioDecoder === ad
      && this.audioOutputRevision === callbackRevision && this.audioQueueChangeBinding === binding;
    // Reserve before either retiring an old subscription or entering a new
    // registration. A reentrant replacement owns an independent unsubscribe.
    const previous = this.audioQueueChangeBinding;
    this.audioQueueChangeBinding = binding;
    const release = previous?.unsubscribe;
    if (previous) previous.unsubscribe = undefined;
    release?.();
    if (!current()) return;
    const observe = ad.observeQueueDepth;
    if (!current()) return;
    if (observe !== undefined) {
      if (typeof observe !== 'function') throw new TypeError('Expected an audio queue observer');
      let unsubscribe: () => void;
      try {
        unsubscribe = observe.call(ad, binding.callback);
        if (typeof unsubscribe !== 'function') throw new TypeError('Expected an audio queue unsubscribe');
      } catch (error) {
        if (current()) this.audioQueueChangeBinding = undefined;
        throw error;
      }
      if (!current()) { unsubscribe(); return; }
      binding.unsubscribe = unsubscribe;
      // The last dequeue may already be dispatching to a snapshot of the old
      // observers. Do not wait for another event to release existing pressure.
      if (this.audioQueuePressureHigh) this.checkQueuePressure('audio', ad, current);
      if (!current()) return;
    }
    if (!audioOutput) return;
    ad.onData = (data, renderTimeUs, inputToken, outputTiming) => {
      if (this.renderFeedbackRetired || this.audioOutputRevision !== callbackRevision) {
        (data as { close?: () => void }).close?.(); return;
      }
      const revision = callbackRevision;
      const observation = this.decodedOutput('audio', inputToken, audioOutput);
      if (this.renderFeedbackRetired || this.audioOutputRevision !== revision) {
        this.releaseOutputFrame(data, observation, this.audioRetirementReason); return;
      }
      let refusal: AudioTimingRefusal | undefined;
      if (this.audioTimingArmed || outputTiming !== undefined) {
        if (ad.supportsOutputTiming !== true) refusal = 'decoder unsupported';
        else if (audioOutput.supportsOutputTiming !== true) refusal = 'output unsupported';
        else if (!outputTiming || !this.audioTimingContexts?.has(outputTiming.context)
            || !Number.isSafeInteger(outputTiming.sourceOffsetUs) || outputTiming.sourceOffsetUs < 0) refusal = 'output unproven';
        else if (this.audioSchedule(outputTiming.context, outputTiming.sourceOffsetUs) === null) refusal = 'context retired';
      }
      if (this.renderFeedbackRetired || this.audioOutputRevision !== revision) {
        this.releaseOutputFrame(data, observation, this.audioRetirementReason); return;
      }
      if (refusal) {
        try { this.releaseOutputFrame(data, observation, 'output failed'); }
        finally { this.audioTimingUnavailable(refusal, revision); }
        if (!this.renderFeedbackRetired && this.audioOutputRevision === revision) this.checkQueuePressure('audio', ad);
        return;
      }
      let cushionUs: number;
      try { cushionUs = this._getPlaybackDelayUs?.() ?? 0; }
      catch (error) { this.releaseOutputFrame(data, observation, 'output failed'); throw error; }
      if (this.renderFeedbackRetired || this.audioOutputRevision !== revision) {
        this.releaseOutputFrame(data, observation, this.audioRetirementReason); return;
      }
      // Legacy scalar cushion is unchanged. Armed outputs follow the engine's
      // captured output schedule, including its intended cushion, at PCM trim.
      try {
        if (outputTiming !== undefined) audioOutput.schedule(data, renderTimeUs + cushionUs, observation?.token, outputTiming);
        else if (observation) audioOutput.schedule(data, renderTimeUs + cushionUs, observation.token);
        else audioOutput.schedule(data, renderTimeUs + cushionUs);
      } catch (error) { this.discardOutput(observation, 'output failed'); throw error; }
      if (!this.renderFeedbackRetired && this.audioOutputRevision === revision) this.checkQueuePressure('audio', ad);
    };
  }

  private clearAudioQueueChange(): void {
    const binding = this.audioQueueChangeBinding;
    this.audioQueueChangeBinding = undefined;
    const unsubscribe = binding?.unsubscribe;
    if (binding) binding.unsubscribe = undefined;
    unsubscribe?.();
  }

  private wireVideoQueueChange(): void {
    const decoder = this.videoDecoder;
    if (!decoder || this.videoRetired) return;
    const binding = { callback: () => { if (current()) this.checkQueuePressure('video', decoder, current); },
      unsubscribe: undefined as (() => void) | undefined };
    const current = () => !this.videoRetired && this.videoDecoder === decoder && this.videoQueueChangeBinding === binding;
    const previous = this.videoQueueChangeBinding;
    this.videoQueueChangeBinding = binding;
    const release = previous?.unsubscribe;
    if (previous) previous.unsubscribe = undefined;
    release?.();
    if (!current()) return;
    const observe = decoder.observeQueueDepth;
    if (!current()) return;
    if (observe === undefined) return;
    if (typeof observe !== 'function') throw new TypeError('Expected a video queue observer');
    let unsubscribe: () => void;
    try {
      unsubscribe = observe.call(decoder, binding.callback);
      if (typeof unsubscribe !== 'function') throw new TypeError('Expected a video queue unsubscribe');
    } catch (error) { if (current()) this.videoQueueChangeBinding = undefined; throw error; }
    if (!current()) { unsubscribe(); return; }
    binding.unsubscribe = unsubscribe;
    if (this.videoQueuePressureHigh) this.checkQueuePressure('video', decoder, current);
  }
  private clearVideoQueueChange(): void {
    const binding = this.videoQueueChangeBinding;
    this.videoQueueChangeBinding = undefined;
    const unsubscribe = binding?.unsubscribe;
    if (binding) binding.unsubscribe = undefined;
    unsubscribe?.();
  }

  /** Resample legacy adapters lacking queue events; this proves no output. */
  resampleQueuePressure(): void {
    const video = this.videoDecoder, audio = this.audioDecoder;
    if (video && !this.videoRetired) this.checkQueuePressure('video', video,
      () => !this.videoRetired && this.videoDecoder === video);
    if (audio && !this.renderFeedbackRetired) this.checkQueuePressure('audio', audio,
      () => !this.renderFeedbackRetired && this.audioDecoder === audio);
  }
  /** Registration availability, not a promise of output or queue completion. */
  hasQueueProgressObserver(mediaType: 'video' | 'audio'): boolean {
    return !this.renderFeedbackRetired && (mediaType === 'video' ? this.videoQueueChangeBinding : this.audioQueueChangeBinding)?.unsubscribe !== undefined;
  }

  /**
   * Dispatch a decoder command to the appropriate adapter.
   *
   * @see draft-ietf-moq-loc-01 §2.1 (decode_video)
   * @see draft-ietf-moq-loc-01 §4.1 (decode_audio)
   * @see draft-ietf-moq-loc-01 §2.3.2.1 (configure video)
   */
  dispatch(cmd: DecoderCommand, options?: { readonly preserveDecoder?: boolean; readonly isCurrent?: () => boolean }): ConfiguredDecoder | undefined {
    if (this.renderFeedbackRetired || (this.videoOutputRetired && (cmd.type === 'decode_video'
      || ('mediaType' in cmd && cmd.mediaType === 'video')))) return;
    switch (cmd.type) {
      case 'configure':
        if (this.renderFeedbackRetired || options?.isCurrent?.() === false) return;
        if (cmd.mediaType === 'video') {
          const decoder = this.videoDecoder;
          if (!decoder) return;
          // Preserve method/argument evaluation order. Both getters and the
          // configure callback can synchronously change dispatcher metadata.
          const configure = decoder.configure, config = cmd.config;
          const codec = this.videoCodec, width = this.videoWidth, height = this.videoHeight;
          const receipt: { mediaType: 'video'; codec: string; config: Uint8Array; width?: number; height?: number }
            = { mediaType: 'video', codec, config: new Uint8Array(config) };
          if (width !== undefined) receipt.width = width;
          if (height !== undefined) receipt.height = height;
          Object.freeze(receipt);
          // Argument acquisition may synchronously install a newer command.
          // Check mutation authority after every acquired argument is owned.
          if (this.videoRetired || options?.isCurrent?.() === false) return;
          // An adapter function may itself carry a `call` property. Invoke the
          // captured callable through the intrinsic operation instead.
          Function.prototype.call.call(configure, decoder, config, codec, width, height);
          return receipt;
        } else {
          const decoder = this.audioDecoder;
          if (!decoder) return;
          const configure = decoder.configure, config = cmd.config;
          const codec = this.audioCodec, sampleRate = this.audioSampleRate, channels = this.audioChannels;
          const receipt: { mediaType: 'audio'; codec: string; config: Uint8Array; sampleRate?: number; channels?: number }
            = { mediaType: 'audio', codec, config: new Uint8Array(config) };
          if (sampleRate !== undefined) receipt.sampleRate = sampleRate;
          if (channels !== undefined) receipt.channels = channels;
          Object.freeze(receipt);
          if (this.renderFeedbackRetired || options?.isCurrent?.() === false) return;
          Function.prototype.call.call(configure, decoder, config, codec, sampleRate, channels);
          return receipt;
        }

      case 'decode_video':
        try {
          if (cmd.renderTiming !== undefined) this.videoDecoder?.decode(cmd.chunk, cmd.renderTimeUs, cmd.inputToken, cmd.renderTiming);
          else if (cmd.inputToken !== undefined) this.videoDecoder?.decode(cmd.chunk, cmd.renderTimeUs, cmd.inputToken);
          else this.videoDecoder?.decode(cmd.chunk, cmd.renderTimeUs);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          this.onError?.('video', e);
          this.onFeedback?.({ type: 'decode_error', mediaType: 'video', message: e.message });
        }
        if (this.videoDecoder) this.checkQueuePressure('video', this.videoDecoder);
        break;

      case 'decode_audio':
        if (cmd.renderTiming !== undefined) {
          const revision = this.audioOutputRevision;
          if (this.renderFeedbackRetired) break;
          this.audioTimingArmed = true;
          if (this.audioDecoder?.supportsOutputTiming !== true) {
            this.audioTimingUnavailable('decoder unsupported', revision); break;
          }
          if (this.audioOutput?.supportsOutputTiming !== true) {
            this.audioTimingUnavailable('output unsupported', revision); break;
          }
          const schedule = cmd.renderTiming ? this.audioSchedule(cmd.renderTiming, 0) : null;
          if (this.renderFeedbackRetired || this.audioOutputRevision !== revision) break;
          if (schedule === null) { this.audioTimingUnavailable('context retired', revision); break; }
          (this.audioTimingContexts ??= new WeakSet()).add(cmd.renderTiming);
        }
        try {
          if (cmd.renderTiming !== undefined) this.audioDecoder?.decode(cmd.chunk, cmd.renderTimeUs, cmd.inputToken, cmd.renderTiming);
          else if (cmd.inputToken !== undefined) this.audioDecoder?.decode(cmd.chunk, cmd.renderTimeUs, cmd.inputToken);
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
          if (p) p.then(() => { if (!this.videoRetired) this.onFeedback?.({ type: 'flush_complete', mediaType: 'video' }); });
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
          if (!options?.preserveDecoder) this.videoDecoder?.reset();
          this.videoQueuePressureHigh = false;
        } else {
          const revision = ++this.audioOutputRevision;
          this.audioRetirementReason = 'decoder reset';
          this.retireAudioTiming();
          if (this.renderFeedbackRetired || this.audioOutputRevision !== revision) break;
          if (!options?.preserveDecoder) this.audioDecoder?.reset();
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
    isCurrent?: () => boolean,
  ): void {
    if (!this.onFeedback || (mediaType === 'video' && this.videoRetired)) return;
    const revision = mediaType === 'video' ? this.outputRevision : this.audioOutputRevision;
    let depth = decoder.queueDepth;
    if (this.renderFeedbackRetired || (mediaType === 'video' && this.videoOutputRetired) || revision !== (mediaType === 'video' ? this.outputRevision : this.audioOutputRevision)) return;
    if (isCurrent && !isCurrent()) return;
    if (mediaType === 'video') for (const held of this.videoHoldQueue) if (held.admission) depth++;
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

  private videoProducingTiming(context: VideoRenderTiming, source: SourceTimestamp): VideoProducedTiming | undefined {
    const ticks = source.ticks, ticksPerSecond = source.ticksPerSecond, domain = source.domain;
    if (typeof ticks !== 'bigint' || typeof ticksPerSecond !== 'bigint' || ticksPerSecond <= 0n
        || domain !== 'media' && domain !== 'unix' && domain !== 'unknown') return;
    return Object.freeze({ context, sourceTimestamp: Object.freeze({ ticks, ticksPerSecond, domain }) });
  }

  private enqueueVideo(renderer: VideoRendererLike, frame: unknown, observation: OutputOwnership | undefined,
      renderTimeUs: number, outputTiming?: VideoProducedTiming, admission?: VideoAdmissionBinding): void {
    try {
      // Diagnostics retains its own unit. Without it, the producing context is
      // an observation identity only; it is not a new queued ownership ledger.
      if (outputTiming) renderer.enqueue(frame, renderTimeUs, observation?.token ?? outputTiming.context, outputTiming);
      else if (observation) renderer.enqueue(frame, renderTimeUs, observation.token);
      else renderer.enqueue(frame, renderTimeUs);
    } catch (error) {
      this.discardOutput(observation, 'output failed');
      this.notifyVideoDiscard(admission, outputTiming, 'output failed');
      throw error;
    }
  }

  private mappedVideoRenderTime(timing: VideoRenderTiming, revision: number): number | null {
    const nominal = timing.recomputeRenderTimeUs();
    if (this.videoRetired || this.outputRevision !== revision || nominal === null || !Number.isFinite(nominal)) return null;
    const cushion = this._getPlaybackDelayUs?.() ?? 0;
    const result = nominal + cushion;
    return Number.isFinite(cushion) && Number.isFinite(result) ? result : null;
  }

  /** Remove before delivery so reentrant flush owns only the not-yet-submitted entries. */
  private drainVideoHoldQueue(renderer: VideoRendererLike, revision: number): void {
    const binding = this.videoAdmission;
    while (this.videoHoldQueue.length && !this.videoRetired && this.outputRevision === revision && this.videoAdmission === binding) {
      const held = this.videoHoldQueue[0]!;
      let decision: 'enqueue' | 'hold' | 'discard' = 'enqueue';
      try { if (held.admission) decision = this.decideVideoOutput(held.admission, held.outputTiming!); }
      catch (error) {
        if (this.videoHoldQueue[0] === held) { this.videoHoldQueue.shift(); this.releaseHeld(held, 'output failed'); }
        if (!this.videoRetired && this.outputRevision === revision && this.videoAdmission === binding) this.reportVideoAdmissionError(error);
        return;
      }
      if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding || this.videoHoldQueue[0] !== held) return;
      if (decision === 'hold') return;
      if (decision === 'discard') { this.videoHoldQueue.shift(); this.releaseHeld(held, 'output refused'); continue; }
      const ready = this._hasSyncReference?.() ?? true;
      if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding || this.videoHoldQueue[0] !== held) return;
      if (!ready) return;
      this.videoHoldQueue.shift();
      let renderTimeUs: number | null;
      try { renderTimeUs = held.renderTiming ? this.mappedVideoRenderTime(held.renderTiming, revision)
        : this._recomputeVideoRenderTime ? this._recomputeVideoRenderTime(held.captureTimestampUs!) : 0; }
      catch (error) { this.releaseHeld(held, 'output failed'); throw error; }
      if (this.videoRetired || this.outputRevision !== revision || this.videoAdmission !== binding) {
        this.releaseHeld(held, this.outputRevision !== revision ? this.outputRetirementReason : 'output refused'); return;
      }
      if (renderTimeUs === null) { this.releaseHeld(held, 'output failed'); continue; }
      const observation = held.observation, admission = held.admission;
      delete held.observation; delete held.admission;
      this.enqueueVideo(renderer, held.frame, observation, renderTimeUs, held.outputTiming, admission);
    }
  }

  /** Detach before cleanup so observer reentry cannot close a frame twice. */
  private closeVideoHoldQueue(reason: DispatcherOutputReason): void {
    const held = this.videoHoldQueue.splice(0);
    const failures: unknown[] = [];
    for (const entry of held) {
      try { this.releaseHeld(entry, reason); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Held frame release failed');
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
    const audioRevision = ++this.audioOutputRevision;
    this.audioRetirementReason = 'flushed';
    this.retireAudioTiming();
    if (this.renderFeedbackRetired || this.audioOutputRevision !== audioRevision) return;
    // Cancel BEFORE the fallible flush: a custom renderer whose flush throws
    // would otherwise leave the episode live across an intentional pause.
    if (!this.videoOutputRetired) {
      this.renderer?.cancelStallEpisode?.();
      this.closeVideoHoldQueue('flushed');
      this.renderer?.flush();
    }
    this.audioOutput?.flush();
  }

  /** Retire only video; audio callbacks, timing contexts and adapters remain owned. */
  retireVideo(): void {
    if (this.videoOutputRetired) return;
    this.videoOutputRetired = true;
    this.videoAdmission = undefined;
    this.outputRevision++;
    this.outputRetirementReason = 'destroyed';
    const failures: unknown[] = [];
    for (const release of [() => this.clearVideoQueueChange(), () => this.closeVideoHoldQueue('destroyed'),
      () => this.videoDecoder?.destroy(), () => this.renderer?.destroy()]) {
      try { release(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Video output destruction failed');
  }

  /** A video-role graph schedules against its retained actor's clock reference. */
  setVideoReferenceGate(hasReference: () => boolean, playbackDelayUs: () => number): void {
    if (this.videoRetired) throw new Error('Video output is destroyed');
    this._hasSyncReference = hasReference;
    this._getPlaybackDelayUs = playbackDelayUs;
  }

  /**
   * The playout timeline moved by `deltaUs` (negative: earlier, a jump toward
   * live). Queued video is retimed, or flushed by a renderer that cannot
   * retime. Scheduled audio is stopped: a started source cannot move, and
   * audio decoded from here on is scheduled on the new timeline.
   */
  retimeOutputs(deltaUs: number): void {
    if (this.renderer?.retime) this.renderer.retime(deltaUs);
    else this.renderer?.flush();
    this.audioOutput?.flush();
  }

  /** Live catch-up: play audio at `rate`. WebAudio changes pitch with it. */
  setCatchUpRate(rate: number): void {
    this.audioOutput?.setPlaybackRate?.(rate);
  }

  /** Shift queued video by `deltaUs` (negative: earlier), where the renderer can. */
  retimeVideo(deltaUs: number): void {
    this.renderer?.retime?.(deltaUs);
  }

  /** Release all adapter resources. */
  destroy(): void {
    if (this.renderFeedbackRetired) return;
    // Retire before fallible cleanup; custom adapters may retain callbacks.
    this.retireOutputAuthority();
    const failures: unknown[] = [];
    // One native failure must not strand another adapter or repeat destruction
    // when cleanup reenters through a custom output callback.
    for (const release of [
      () => this.clearAudioQueueChange(),
      () => this.retireVideo(),
      () => this.audioDecoder?.destroy(),
      () => this.audioOutput?.destroy(),
    ]) {
      try { release(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Output destruction failed');
  }

  private retireOutputAuthority(): void {
    this.renderFeedbackRetired = true;
    this.videoAdmission = undefined;
    this.outputRevision++;
    this.outputRetirementReason = 'destroyed';
    this.audioOutputRevision++;
    this.audioRetirementReason = 'destroyed';
    this.audioTimingArmed = false;
    this.audioTimingContexts = undefined;
  }
}
