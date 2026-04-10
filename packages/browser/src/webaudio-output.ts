/**
 * WebAudioOutput — schedules decoded audio for playout via AudioContext.
 *
 * Implements AudioOutputLike for use with CommandDispatcher.
 * Uses AudioBufferSourceNode for sample-accurate scheduling.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 * @see draft-ietf-moq-loc-01 §2.3.3.1 (AudioLevel for silence optimization)
 * @module
 */

import type { AudioOutputLike } from '@moqt/player';
import type { ClockSource } from '@moqt/playback';


/**
 * WebAudio playout behind AudioOutputLike.
 *
 * Schedules decoded AudioData as AudioBufferSourceNodes aligned with
 * the pipeline's render timeline (CaptureTimestamp-based A/V sync).
 * Maps renderTimeUs (performance.now domain) → AudioContext.currentTime
 * so audio playout is synchronized with video frame presentation.
 *
 * Falls back to seamless back-to-back chaining when render times would
 * cause overlap (contiguous samples) or when audio needs to catch up.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 */
export class WebAudioOutput implements AudioOutputLike {
  private readonly audioCtx: AudioContext;

  /**
   * Audio destination node. Sources connect here instead of directly
   * to audioCtx.destination. Defaults to audioCtx.destination but can
   * be overridden to insert a GainNode for volume control.
   */
  private readonly destination: AudioNode;

  /**
   * Next scheduled playout time in AudioContext.currentTime units.
   * Tracks the end of the last scheduled buffer for seamless playback.
   */
  private nextScheduledTime = 0;

  /** Active source nodes — tracked for flush/destroy. */
  private readonly activeSources: AudioBufferSourceNode[] = [];

  /** Current playback rate for live catch-up. @see draft-ietf-moq-msf-00 §5.1.16 */
  private _playbackRate = 1.0;

  /**
   * Playback delay in seconds — matches the video output delay so audio
   * and video start at the same wall-clock offset. Without this, video
   * is delayed by up to MAX_OUTPUT_VIDEO_DELAY_US (250ms) for jitter
   * absorption while audio plays immediately, causing audio-ahead desync.
   */
  private readonly playbackDelaySec: number;

  /** Shared clock — when audio-backed, eliminates drift in toAudioCtxTime(). */
  private readonly clock: ClockSource;

  constructor(audioCtx: AudioContext, destination?: AudioNode, playbackDelayMs = 200, clock?: ClockSource) {
    this.audioCtx = audioCtx;
    this.destination = destination ?? audioCtx.destination;
    this.playbackDelaySec = playbackDelayMs / 1000;
    this.clock = clock ?? { now: () => performance.now() * 1000 };
  }

  /**
   * Convert renderTimeUs (pipeline clock domain) to AudioContext.currentTime seconds.
   *
   * Uses the shared clock for the delta computation. When the clock is audio-backed
   * (AudioAlignedClock), clock.now() and audioCtx.currentTime are on the same
   * oscillator — the delta has zero drift. When performance-backed, equivalent
   * to the original performance.now() conversion.
   */
  private toAudioCtxTime(renderTimeUs: number): number {
    const nowUs = this.clock.now();
    const deltaSec = (renderTimeUs - nowUs) / 1_000_000;
    return this.audioCtx.currentTime + deltaSec;
  }

  /**
   * Schedule an audio chunk for playout.
   *
   * Decodes AudioData to AudioBuffer, schedules via AudioBufferSourceNode.
   * Uses renderTimeUs to align with video, but ensures seamless back-to-back
   * when samples are contiguous.
   *
   * @param data AudioData from the decoder output callback
   * @param renderTimeUs Render time in microseconds (pipeline clock domain)
   *
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for A/V sync)
   */
  schedule(data: unknown, renderTimeUs: number): void {
    const audioData = data as AudioData;

    // Copy decoded PCM into an AudioBuffer.
    // AudioData holds native memory — close() is required.
    const buf = this.audioCtx.createBuffer(
      audioData.numberOfChannels,
      audioData.numberOfFrames,
      audioData.sampleRate,
    );

    for (let ch = 0; ch < audioData.numberOfChannels; ch++) {
      const dest = buf.getChannelData(ch);
      audioData.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
    }
    audioData.close();

    const now = this.audioCtx.currentTime;

    // Audio scheduling strategy:
    // - Normal playback: chain back-to-back (nextScheduledTime) for
    //   seamless, gap-free audio. Using targetTime per-sample causes
    //   drift when samples arrive in bursts from the jitter buffer.
    // - After stall/gap: snap to sync-aligned targetTime to re-sync
    //   with video (nextScheduledTime is in the past).
    // - playbackDelaySec matches the video output delay so both media
    //   types start at the same wall-clock offset.
    let startTime: number;
    if (this.nextScheduledTime >= now) {
      // Normal playback — back-to-back for seamless audio
      startTime = this.nextScheduledTime;
    } else if (renderTimeUs > 0) {
      // After stall — jump to sync-aligned position + playback delay
      startTime = Math.max(this.toAudioCtxTime(renderTimeUs) + this.playbackDelaySec, now);
    } else {
      // No render time (sync not established) — start from now + delay
      startTime = now + this.playbackDelaySec;
    }

    // Schedule for playout.
    const source = this.audioCtx.createBufferSource();
    source.buffer = buf;
    // Apply catch-up playback rate (>1.0 = faster playout).
    // @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
    source.playbackRate.value = this._playbackRate;
    source.connect(this.destination);
    source.start(startTime);
    // Duration at adjusted rate — faster playout means shorter wall-clock time.
    this.nextScheduledTime = startTime + buf.duration / this._playbackRate;

    // Track for flush/destroy cleanup
    this.activeSources.push(source);
    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) this.activeSources.splice(idx, 1);
    };
  }

  /**
   * Set playback rate for live catch-up.
   * Applied to each new AudioBufferSourceNode on schedule().
   * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
   */
  setPlaybackRate(rate: number): void {
    this._playbackRate = rate;
  }

  /** Cancel all scheduled audio. */
  flush(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Already stopped or disconnected
      }
    }
    this.activeSources.length = 0;
    this.nextScheduledTime = 0;
  }

  /**
   * Current playout position in microseconds.
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
   */
  get currentPlayoutTimeUs(): number {
    return this.audioCtx.currentTime * 1_000_000;
  }

  /** Release resources. */
  destroy(): void {
    this.flush();
  }
}
