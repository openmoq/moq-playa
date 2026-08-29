/**
 * `CanvasRenderer` must report the EXACT queued schedule alongside each
 * presentation.
 *
 * That timestamp is the authority for presentation-schedule drift: it already
 * carries the playout cushion applied to this frame, the live-join offset and
 * any late-frame handling. Without it the pipeline suppresses the diagnostic —
 * so silently dropping this argument would not fail any downstream test, which
 * is exactly why this one exists.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { CanvasRenderer } from './canvas-renderer.js';
import type { ClockSource } from '@moqt/playback';

class SimClock implements ClockSource {
  private nowUs = 0;
  now(): number { return this.nowUs; }
  set(us: number): void { this.nowUs = us; }
}

/** Minimal canvas stub — the renderer only needs a 2d context to draw into. */
function stubCanvas(): HTMLCanvasElement {
  const canvas = { width: 16, height: 16 };
  // The renderer reads `ctx.canvas.width/height` when drawing.
  const ctx = { drawImage() {}, clearRect() {}, canvas };
  return { getContext: () => ctx, ...canvas } as unknown as HTMLCanvasElement;
}

/** VideoFrame stand-in: the renderer reads `timestamp` and calls `close()`. */
function frame(timestampUs: number): unknown {
  return { timestamp: timestampUs, close() {} };
}

describe('CanvasRenderer — reports the queued schedule', () => {
  it('passes the frame\'s exact scheduled render time to onFrameRendered', () => {
    const clock = new SimClock();
    const renderer = new CanvasRenderer(stubCanvas(), { clock });
    const reports: { captureUs: bigint; actualUs: number; scheduledUs: number | undefined }[] = [];
    renderer.onFrameRendered = (captureTimestampUs, actualRenderUs, scheduledRenderUs) => {
      reports.push({ captureUs: captureTimestampUs, actualUs: actualRenderUs, scheduledUs: scheduledRenderUs });
    };

    const scheduledUs = 1_000_000;
    renderer.enqueue(frame(42_000), scheduledUs);

    // Not yet due — nothing presented.
    clock.set(scheduledUs - 1);
    renderer.renderTick(clock.now());
    expect(reports).toHaveLength(0);

    // Due, and presented one tick late: the report must carry BOTH times, so the
    // pipeline can compute actual - scheduled rather than guess.
    clock.set(scheduledUs + 16_667);
    renderer.renderTick(clock.now());

    expect(reports).toHaveLength(1);
    expect(reports[0]!.scheduledUs).toBe(scheduledUs);
    expect(reports[0]!.actualUs).toBe(scheduledUs + 16_667);
    expect(reports[0]!.captureUs).toBe(42_000n);
  });

  it('reports each frame\'s own schedule, not a shared or recomputed value', () => {
    const clock = new SimClock();
    const renderer = new CanvasRenderer(stubCanvas(), { clock });
    const scheduled: (number | undefined)[] = [];
    renderer.onFrameRendered = (_c, _a, scheduledRenderUs) => { scheduled.push(scheduledRenderUs); };

    // Two frames with DIFFERENT cushions applied, both due on the same tick and
    // neither stale enough to be late-dropped.
    renderer.enqueue(frame(0), 1_000_000);
    renderer.enqueue(frame(33_333), 1_250_000);
    clock.set(1_300_000);
    renderer.renderTick(clock.now());

    expect(scheduled).toEqual([1_000_000, 1_250_000]);
  });
});
