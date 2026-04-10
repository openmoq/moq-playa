/**
 * PTS-anchored render scheduler.
 *
 * Computes wall-clock render times from CaptureTimestamps at decode OUTPUT,
 * solving the async decode latency problem. Anchors on the first rendered
 * frame's PTS and spaces subsequent frames by PTS delta.
 *
 * This produces correct 33ms pacing regardless of delivery pattern:
 * - Burst delivery (cached GOP): 8 frames decoded in 40ms → render 33ms apart
 * - Live delivery: frames arrive at 33ms intervals → render at 33ms intervals
 * - Burst-to-live transition: automatic rebase when delivery catches up to PTS
 *
 * Used by the CanvasRenderer to schedule frame presentation.
 * Sans-I/O: depends only on ClockSource, no browser APIs.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
 * @module
 */

import type { ClockSource } from './types.js';

export interface RenderSchedulerOptions {
  /** Extra future cushion for first frame in microseconds. Default: 16000 (1 rAF tick). */
  readonly cushionUs?: number;
}

/**
 * Computes wall-clock render times from CaptureTimestamps.
 *
 * Call `schedule(captureTimestampUs)` when a decoded frame arrives.
 * Returns the wall-clock time (in µs) when the frame should be painted.
 */
export class RenderScheduler {
  private readonly clock: ClockSource;
  private readonly cushionUs: number;

  /** Wall-clock anchor: local time when the first frame was scheduled. */
  private baseTimeUs: number | null = null;
  /** PTS anchor: captureTimestamp of the first frame. */
  private basePtsUs: number | null = null;

  /** Previous frame's arrival time — for burst-to-live detection. */
  private lastArrivalUs: number = 0;

  constructor(clock: ClockSource, options?: RenderSchedulerOptions) {
    this.clock = clock;
    this.cushionUs = options?.cushionUs ?? 16_000;
  }

  /**
   * Compute the wall-clock render time for a decoded frame.
   *
   * @param captureTimestampUs CaptureTimestamp from LOC header (microseconds)
   * @returns Wall-clock time in microseconds when the frame should be painted
   */
  schedule(captureTimestampUs: bigint): number {
    const nowUs = this.clock.now();
    const ptsUs = Number(captureTimestampUs);

    // INVARIANT: baseTimeUs and basePtsUs are always co-null or co-set —
    // every write site (init / first-frame / rebase / reset) updates both.
    // The `||` here is required for TypeScript narrowing: with `&&`, TS
    // can't prove either is non-null in the else branch.
    if (this.baseTimeUs === null || this.basePtsUs === null) {
      // First frame: set anchor
      this.baseTimeUs = nowUs + this.cushionUs;
      this.basePtsUs = ptsUs;
      this.lastArrivalUs = nowUs;
      return this.baseTimeUs;
    }

    // PTS-relative render time
    const ptsDelta = ptsUs - this.basePtsUs;
    let renderTimeUs = this.baseTimeUs + ptsDelta;

    // Burst-to-live transition detection:
    // During burst, frames arrive faster than their PTS spacing (inter-arrival < 33ms).
    // During live, frames arrive at PTS spacing (inter-arrival ≈ 33ms).
    // When the scheduled render time falls behind the current clock (render time is in
    // the past), and the frame is arriving at real-time rate, snap the anchor forward.
    const arrivalDelta = nowUs - this.lastArrivalUs;

    if (renderTimeUs < nowUs && arrivalDelta > 20_000) {
      // Frame is late AND arrived at real-time rate (not burst)
      // → transition from burst to live, rebase anchor
      this.baseTimeUs = nowUs + this.cushionUs;
      this.basePtsUs = ptsUs;
      renderTimeUs = this.baseTimeUs;
    }

    this.lastArrivalUs = nowUs;
    return renderTimeUs;
  }

  /** Reset anchor (seek, pause→resume, gap skip). */
  reset(): void {
    this.baseTimeUs = null;
    this.basePtsUs = null;
    this.lastArrivalUs = 0;
  }
}
