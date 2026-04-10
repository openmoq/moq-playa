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
   * Next scheduled playout time in AudioContext.currentTime units.
   * Tracks the end of the last scheduled buffer for seamless playback.
   */
  private nextScheduledTime = 0;

  /** Active source nodes — tracked for flush/destroy. */
  private readonly activeSources: AudioBufferSourceNode[] = [];

  /** Current playback rate for live catch-up. @see draft-ietf-moq-msf-00 §5.1.16 */
  private _playbackRate = 1.0;

  constructor(audioCtx: AudioContext) {
    this.audioCtx = audioCtx;
  }

  /**
   * Convert renderTimeUs (pipeline clock: performance.now * 1000) to
   * AudioContext.currentTime seconds.
   *
   * Both clocks represent "now" simultaneously:
   *   performance.now() / 1000  ≡  audioCtx.currentTime  (at this instant)
   * So any future/past renderTimeUs maps as:
   *   audioCtxTime = audioCtx.currentTime + (renderTimeSec - perfNowSec)
   */
  private toAudioCtxTime(renderTimeUs: number): number {
    const renderTimeSec = renderTimeUs / 1_000_000;
    const perfNowSec = performance.now() / 1000;
    return this.audioCtx.currentTime + (renderTimeSec - perfNowSec);
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
    let startTime: number;
    if (this.nextScheduledTime >= now) {
      // Normal playback — back-to-back for seamless audio
      startTime = this.nextScheduledTime;
    } else if (renderTimeUs > 0) {
      // After stall — jump to sync-aligned position
      startTime = Math.max(this.toAudioCtxTime(renderTimeUs), now);
    } else {
      // No render time (sync not established) — start from now
      startTime = now;
    }

    // Schedule for playout.
    const source = this.audioCtx.createBufferSource();
    source.buffer = buf;
    // Apply catch-up playback rate (>1.0 = faster playout).
    // @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
    source.playbackRate.value = this._playbackRate;
    source.connect(this.audioCtx.destination);
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
