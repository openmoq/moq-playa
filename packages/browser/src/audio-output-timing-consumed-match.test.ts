/** Scalar scheduling regressions, not native decoder/PCM or input-identity proof. */
import { describe, expect, it } from 'vitest';
import { AudioOutputTiming } from './audio-output-timing.js';

function forwardGap(duplicate: boolean) {
  const timing = new AudioOutputTiming();
  const timestamps = [0, ...(duplicate ? [120_000, 120_000] : [120_000]),
    ...Array.from({ length: 10 }, (_, index) => 140_000 + index * 20_000)];
  for (const timestamp of timestamps) timing.remember(timestamp, 20_000, 100_000 + timestamp);
  const results = timestamps.map((_, index) => timing.resolve(index * 20_000));
  return { expected: timestamps.map(timestamp => 100_000 + timestamp), results };
}

describe('AudioDecoder consumed ambiguous matches and pending common intervals', () => {
  it('does not resurrect a repeated PTS schedule after a forward gap consumed both copies', () => {
    const { expected, results } = forwardGap(true);
    // The prior output used 280000; output PTS 120000 now
    // collides with an ambiguous record whose two schedules were consumed.
    expect(results[5]!.renderTimeUs).toBe(280_000);
    expect(results[6]).toEqual({ renderTimeUs: 300_000, input: null });
    expect(results.map(result => result.renderTimeUs)).toEqual(expected);
    expect(results.slice(1).every(result => result.input === null)).toBe(true);
  });

  it('control: preserves the existing consumed unique-match guard across a forward gap', () => {
    const { expected, results } = forwardGap(false);
    expect(results.map(result => result.renderTimeUs)).toEqual(expected);
    expect(results.slice(1).every(result => result.input === null)).toBe(true);
  });

  it('control: repeated PTS with no forward gap retain both submitted schedules without identity', () => {
    const timing = new AudioOutputTiming();
    timing.remember(0, 20_000, 100_000); timing.remember(0, 20_000, 100_000);
    const next = timing.remember(20_000, 20_000, 120_000);
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 100_000, input: null });
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 100_000, input: null });
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 120_000, input: next });
  });

  it('control: retains the first common trimmed time while matching unknown spans remain pending', () => {
    const timing = new AudioOutputTiming();
    timing.remember(0, undefined, 100_000); timing.remember(20_000, undefined, 120_000);
    expect(timing.resolve(25_000)).toEqual({ renderTimeUs: 125_000, input: null });
  });

  it('control: retains a later common trimmed time for a non-initial-priming codec with a pending candidate', () => {
    const timing = new AudioOutputTiming(256, false);
    const first = timing.remember(0, undefined, 100_000);
    timing.remember(20_000, undefined, 120_000);
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 100_000, input: first });
    // Both retained spans agree on 125000; the 20000 submission is still pending.
    expect(timing.resolve(25_000)).toEqual({ renderTimeUs: 125_000, input: null });
  });

  it('does not use consumed common intervals to bypass the guard merely because a codec can trim later', () => {
    const timing = new AudioOutputTiming(256, false);
    timing.remember(0, 30_000, 100_000); timing.remember(10_000, 20_000, 110_000);
    expect(timing.resolve(0).renderTimeUs).toBe(100_000);
    expect(timing.resolve(10_000)).toEqual({ renderTimeUs: 110_000, input: null });
    timing.remember(40_000, 10_000, 200_000);
    // Both old intervals still contain PTS 20000, but neither has a pending
    // submission. The unrelated pending 40000 carrier must not earn trim credit.
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 200_000, input: null });
  });
});
