/**
 * AudioAlignedClock — audio-backed shared clock for A/V sync.
 *
 * When an AudioContext is attached and running, reads the audio hardware
 * clock via getOutputTimestamp(). When no AudioContext exists (video-only,
 * muted autoplay), falls back to performance.now().
 *
 * Eliminates A/V drift caused by separate crystal oscillators driving
 * performance.now() and AudioContext.currentTime (10-50 ppm apart).
 *
 * Implements ClockSource from @moqt/playback — the sans-I/O playback
 * core never knows which physical clock it's running on.
 *
 * @see W3C Web Audio API §10.3 (AudioContext.getOutputTimestamp)
 * @module
 */

import type { ClockSource } from '@moqt/playback';

/**
 * A ClockSource that tracks the audio hardware clock when available,
 * falling back to performance.now() when not.
 *
 * Usage:
 * 1. Pass as `clock` to MoqtPlayer config and CanvasRenderer/WebAudioOutput
 * 2. Call `attachAudioContext()` when AudioContext is created/resumed
 * 3. Call `detachAudioContext()` when AudioContext is closed/suspended for muted autoplay
 *
 * The clock is continuous across the attach transition — no timeline jump.
 */
export class AudioAlignedClock implements ClockSource {
  private audioCtx: AudioContext | null = null;

  /**
   * Offset that maps audio clock domain to performance.now domain.
   * Set at anchor time: anchorOffsetUs = perfTimeUs - audioTimeUs.
   * Preserves continuity: audioTimeUs + anchorOffsetUs === perfTimeUs at anchor.
   */
  private anchorOffsetUs = 0;

  /** Whether we've successfully anchored to the audio clock. */
  private anchored = false;

  /** Speaker output latency in microseconds. */
  private outputLatencyUs = 0;

  /** Last returned value — enforces monotonic contract of ClockSource. */
  private lastNowUs = 0;

  /**
   * Current time in microseconds.
   *
   * When audio is running and getOutputTimestamp() returns nonzero,
   * returns audio-backed time (same oscillator as audio playout).
   * Otherwise falls back to performance.now() * 1000.
   */
  now(): number {
    if (this.audioCtx && this.audioCtx.state === 'running') {
      const ts = this.audioCtx.getOutputTimestamp();

      const ctxTime = ts.contextTime ?? 0;
      const perfTime = ts.performanceTime ?? 0;

      if (perfTime > 0 && ctxTime > 0) {
        if (!this.anchored) {
          this.anchor(ctxTime, perfTime);
        }

        // Extrapolate from the correlated pair to "right now".
        // getOutputTimestamp() is snapped to the last audio render quantum
        // (~2.67ms at 48kHz). The extrapolation uses performance.now() for
        // just this short interval — drift over 2-5ms at 50ppm is <0.25µs.
        const elapsedSinceSampleMs = performance.now() - perfTime;
        const audioNowUs = ctxTime * 1_000_000
          + elapsedSinceSampleMs * 1_000;

        this.lastNowUs = Math.max(this.lastNowUs, audioNowUs + this.anchorOffsetUs);
        return this.lastNowUs;
      }
    }

    // Fallback: performance.now() domain
    this.lastNowUs = Math.max(this.lastNowUs, performance.now() * 1_000);
    return this.lastNowUs;
  }

  /**
   * Attach an AudioContext. Call when AudioContext is created/resumed.
   * Does NOT immediately switch clocks — waits for getOutputTimestamp()
   * to return nonzero values (audio hardware actually running).
   */
  attachAudioContext(ctx: AudioContext): void {
    this.audioCtx = ctx;
    this.anchored = false;
    this.outputLatencyUs = ((ctx as any).outputLatency ?? 0) * 1_000_000;
  }

  /**
   * Detach AudioContext (e.g., on close/suspend for muted autoplay).
   * Reverts to performance.now() fallback seamlessly.
   */
  detachAudioContext(): void {
    this.audioCtx = null;
    this.anchored = false;
    this.outputLatencyUs = 0;
  }

  /**
   * Speaker output latency in microseconds.
   * Separate from jitter cushion — applied to video render times
   * to compensate for audio hardware pipeline delay.
   */
  get speakerLatencyUs(): number {
    return this.outputLatencyUs;
  }

  /** Whether the clock is currently audio-backed. */
  get isAudioBacked(): boolean {
    return this.anchored;
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Anchor the audio clock to the performance.now domain.
   *
   * Uses the correlated {contextTime, performanceTime} pair from
   * getOutputTimestamp() — both values are sampled at the same instant
   * by the browser. No separate performance.now() call needed.
   *
   * Computes anchorOffsetUs so that:
   *   audioTimeUs + anchorOffsetUs === perfTimeUs
   *
   * This preserves continuity — existing render times (computed against
   * the old perf clock) remain valid because the new clock returns the
   * same value at the transition instant.
   */
  private anchor(contextTime: number, performanceTime: number): void {
    const perfTimeUs = performanceTime * 1_000;
    const audioTimeUs = contextTime * 1_000_000;
    this.anchorOffsetUs = perfTimeUs - audioTimeUs;
    this.anchored = true;
  }
}
