import { describe, expect, it } from 'vitest';
import { LiveCatchUp } from './live-catch-up.js';

const options = { maxRate: 1.1, thresholdUs: 500_000, recoveryUs: 50_000, floorAheadUs: 500_000 };

describe('LiveCatchUp', () => {
  it('speeds up past the threshold, in proportion to the excess, and stops at the recovery level', () => {
    const c = new LiveCatchUp(options);
    // 0.9 s ahead: 0.4 s over the floor, under the threshold.
    expect(c.evaluate(900_000, null, undefined)).toEqual({ active: false, rate: 1, excessUs: 400_000 });
    // 2 s ahead: 1.5 s over, past the threshold: full rate.
    expect(c.evaluate(2_000_000, null, undefined)).toMatchObject({ active: true, rate: 1.1 });
    // Draining: 0.75 s ahead is 0.25 s over — half the threshold, 1.05×.
    expect(c.evaluate(750_000, null, undefined)).toMatchObject({ active: true, rate: 1.05 });
    // Hysteresis: still active until the excess reaches the recovery level.
    expect(c.evaluate(560_000, null, undefined)).toMatchObject({ active: true });
    expect(c.evaluate(550_000, null, undefined)).toMatchObject({ active: false, rate: 1 });
    expect(c.currentRate).toBe(1);
  });

  it('keeps draining a small excess at the lowest step rather than stalling at 1×', () => {
    const c = new LiveCatchUp({ ...options, maxRate: 1.05 });
    expect(c.evaluate(2_000_000, null, undefined)).toMatchObject({ active: true, rate: 1.05 });
    // 0.1 s over the floor: a fifth of the threshold, still above recovery.
    expect(c.evaluate(600_000, null, undefined)).toMatchObject({ active: true, rate: 1.05 });
  });

  it('stops at the target latency where latency is measurable', () => {
    const c = new LiveCatchUp(options);
    // 4 s buffered ahead, but latency is only 0.2 s over a 3 s target.
    expect(c.evaluate(4_000_000, 3_200_000, 3_000_000)).toEqual({ active: false, rate: 1, excessUs: 200_000 });
    // Far over the target as well: catch up.
    expect(c.evaluate(4_000_000, 6_000_000, 3_000_000)).toMatchObject({ active: true, rate: 1.1 });
  });

  it('never runs with a maximum rate of 1', () => {
    const c = new LiveCatchUp({ ...options, maxRate: 1 });
    expect(c.evaluate(10_000_000, null, undefined)).toMatchObject({ active: false, rate: 1 });
  });
});


it('passes the optional output latency and configured target through the standing-window policy', () => {
  const policy = new LiveCatchUp(options);
  const rates: number[] = [];
  let latency = 3_200_000;
  const output = { getBufferAheadUs: () => 4_000_000, latencyUs: () => latency,
    setPlaybackRate: (rate: number) => rates.push(rate) };
  for (let now = 0; now <= 3_000_000; now += 100_000) policy.tick(output, now, () => true, 3_000_000);
  expect(rates).toEqual([]);
  latency = 6_000_000; policy.tick(output, 3_100_000, () => true, 3_000_000);
  expect(rates).toEqual([1.1]);
  latency = 3_000_000; policy.tick(output, 3_200_000, () => true, 3_000_000);
  expect(rates).toEqual([1.1, 1]);
});
