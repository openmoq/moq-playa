/**
 * RenderCushionSmoother — slew-rate-limited, clamped playout cushion.
 *
 * Field-data-directed: the raw adaptive gap timeout swings 50–2000 ms and
 * a collapse applied stepwise to render times freezes video for the length
 * of the collapse (queued frames under
 * the old cushion block newer earlier-scheduled ones). The smoother turns
 * steps into bounded slews and caps the render range independently of the
 * gap fuse, which keeps consuming the RAW adaptive value.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  RenderCushionSmoother,
  RENDER_CUSHION_MAX_US,
  RENDER_CUSHION_RISE_US_PER_SEC,
  RENDER_CUSHION_FALL_US_PER_SEC,
} from './render-cushion.js';

function makeClock(startUs = 0) {
  let now = startUs;
  return { now: () => now, advance: (us: number) => { now += us; } };
}

describe('RenderCushionSmoother', () => {
  it('first update snaps to the clamped target (no slew from fiction)', () => {
    const clock = makeClock();
    const s = new RenderCushionSmoother({ floorUs: 200_000 }, clock);
    expect(s.update(400_000)).toBe(400_000);
  });

  it('the field collapse (1848ms → 90ms raw) falls gradually at the fall rate, never a step', () => {
    const clock = makeClock();
    const s = new RenderCushionSmoother({ floorUs: 200_000 }, clock);
    s.update(1_848_000); // snaps to the clamp (750ms), not 1848ms
    expect(s.currentUs).toBe(RENDER_CUSHION_MAX_US);

    clock.advance(1_000_000); // +1s, raw collapses to 90ms (target = floor 200ms)
    const after1s = s.update(90_000);
    expect(after1s).toBe(RENDER_CUSHION_MAX_US - RENDER_CUSHION_FALL_US_PER_SEC);

    clock.advance(1_000_000);
    const after2s = s.update(90_000);
    expect(after2s).toBe(RENDER_CUSHION_MAX_US - 2 * RENDER_CUSHION_FALL_US_PER_SEC);
  });

  it('an upward spike rises gradually at the rise rate and clamps at the max', () => {
    const clock = makeClock();
    const s = new RenderCushionSmoother({ floorUs: 200_000 }, clock);
    s.update(200_000); // settle at floor

    clock.advance(1_000_000);
    expect(s.update(2_000_000)).toBe(200_000 + RENDER_CUSHION_RISE_US_PER_SEC);

    // Long enough elapsed: rises to the clamp, never beyond it.
    clock.advance(60_000_000);
    expect(s.update(2_000_000)).toBe(RENDER_CUSHION_MAX_US);
  });

  it('never goes below the floor (200ms default, 50ms low-RTT floor)', () => {
    const clock = makeClock();
    const s = new RenderCushionSmoother({ floorUs: 200_000 }, clock);
    s.update(0);
    expect(s.currentUs).toBe(200_000);

    const low = new RenderCushionSmoother({ floorUs: 50_000 }, makeClock());
    low.update(0);
    expect(low.currentUs).toBe(50_000);
  });

  it('per-frame deltas are tiny: cushion moves ≤ rate × dt between adjacent updates (monotonic render times)', () => {
    const clock = makeClock();
    const s = new RenderCushionSmoother({ floorUs: 200_000 }, clock);
    s.update(750_000);
    // 30fps cadence during a total collapse: each step ≤ fall_rate × 33ms.
    let prev = s.currentUs;
    for (let i = 0; i < 30; i++) {
      clock.advance(33_333);
      const cur = s.update(0);
      expect(prev - cur).toBeLessThanOrEqual(RENDER_CUSHION_FALL_US_PER_SEC * 0.0334 + 1);
      // Render time = capture(+33ms) + cushion: monotonic ⇔ cushion falls < 33ms/frame.
      expect(prev - cur).toBeLessThan(33_333);
      prev = cur;
    }
  });

  it('same-instant repeat updates do not double-slew (dt = 0)', () => {
    const clock = makeClock();
    const s = new RenderCushionSmoother({ floorUs: 200_000 }, clock);
    s.update(750_000);
    clock.advance(1_000_000);
    const a = s.update(0);
    const b = s.update(0); // audio + video both call within the same instant
    expect(b).toBe(a);
  });
});
