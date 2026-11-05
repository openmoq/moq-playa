import { describe, expect, it } from 'vitest';
import { AudioOutputTiming } from './audio-output-timing.js';

describe('AudioDecoder timestamp ownership', () => {
  it('does not need an output from every submitted input', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, 20_000, 100_000);
    const second = timing.remember(20_000, 20_000, 120_000);
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 120_000, input: second });
  });
  it('moves the first rendered timestamp by the actual trimmed duration', () => {
    const timing = new AudioOutputTiming(), first = timing.remember(0, 20_000, 100_000);
    expect(timing.resolve(5_000)).toEqual({ renderTimeUs: 105_000, input: first });
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 100_000, input: first });
  });
  it('uses exclusive interval ends for the first output', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, 20_000, 100_000);
    const second = timing.remember(20_000, 20_000, 120_000);
    expect(timing.resolve(20_000).input).toBe(second);
  });
  it('keeps common timing without claiming an ambiguous unknown-duration contributor', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, undefined, 100_000);
    const second = timing.remember(20_000, 20_000, 120_000);
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 120_000, input: null });
    // A positive native output proves priming has finished. Further outputs preserve input PTS.
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 120_000, input: second });
  });
  it('refuses identity for conflicting timing candidates but keeps the nearest queued render time', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, undefined, 100_000); timing.remember(20_000, 20_000, 300_000);
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 300_000, input: null });
  });
  it('does not use duration containment after the first positive output', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, 20_000, 100_000);
    timing.resolve(0); expect(timing.resolve(5_000)).toEqual({ renderTimeUs: 0, input: null });
  });
  it('permits multiple outputs from one uniquely identified input without consuming a neighbour', () => {
    const timing = new AudioOutputTiming(), first = timing.remember(0, 20_000, 100_000);
    const second = timing.remember(20_000, 20_000, 120_000);
    expect(timing.resolve(0).input).toBe(first); expect(timing.resolve(0).input).toBe(first);
    expect(timing.resolve(20_000).input).toBe(second);
  });
  it.each([false, true])('poisons repeated timestamps even after output=%s', outputFirst => {
    const timing = new AudioOutputTiming(); timing.remember(0, 20_000, 100_000);
    if (outputFirst) timing.resolve(0);
    expect(timing.remember(0, 20_000, 100_000)).toBeUndefined();
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 100_000, input: null });
    // Identity stays refused; the render time follows submission order.
    timing.remember(0, 20_000, 200_000);
    expect(timing.resolve(0)).toEqual({ renderTimeUs: outputFirst ? 200_000 : 100_000, input: null });
  });
  it('keeps a throwing native submission unavailable', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, 20_000, 100_000); timing.poison(0);
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 0, input: null });
  });
  it('does not resurrect an evicted timestamp and refuses uncertain priming after eviction', () => {
    const timing = new AudioOutputTiming(1); timing.remember(0, 20_000, 100_000);
    const current = timing.remember(20_000, 20_000, 120_000);
    expect(timing.remember(0, 20_000, 500_000)).toBeUndefined();
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 120_000, input: null });
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 0, input: null });
    expect(timing.resolve(20_000).input).toBe(current);
  });
  it('does not let an imprecise prior input prove the first output identity', () => {
    const timing = new AudioOutputTiming(); timing.remember(-Number.MAX_SAFE_INTEGER - 1, undefined, 10);
    timing.remember(0, 20_000, 100_000); expect(timing.resolve(0)).toEqual({ renderTimeUs: 100_000, input: null });
  });
  it('clears all ownership and priming state for a fresh generation', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, 20_000, 100_000); timing.resolve(0); timing.clear();
    const next = timing.remember(0, 20_000, 200_000);
    expect(timing.resolve(5_000)).toEqual({ renderTimeUs: 205_000, input: next });
  });
  it('does not assume initial-only priming for an unverified codec registration', () => {
    const timing = new AudioOutputTiming(256, false), input = timing.remember(0, 20_000, 100_000);
    expect(timing.resolve(5_000)).toEqual({ renderTimeUs: 105_000, input });
    expect(timing.resolve(10_000)).toEqual({ renderTimeUs: 110_000, input });
  });
  it.each([0, -1, NaN, Infinity, 1.5])('rejects an invalid retention limit %s', value => {
    expect(() => new AudioOutputTiming(value)).toThrow();
  });
});

describe('AudioDecoder render-time fallback to submission order', () => {
  const FRAME_US = 21_333; // 1024 samples at 48 kHz

  it('keeps distinct render times when every input timestamp is 0 (no LOC capture timestamp)', () => {
    const timing = new AudioOutputTiming();
    for (let i = 0; i < 5; i++) timing.remember(0, FRAME_US, 100_000 + i * FRAME_US);
    const times = Array.from({ length: 5 }, () => timing.resolve(0).renderTimeUs);
    expect(times).toEqual([0, 1, 2, 3, 4].map(i => 100_000 + i * FRAME_US));
  });

  it('keeps distinct render times when outputs interleave with zero-timestamp inputs', () => {
    const timing = new AudioOutputTiming(), times: number[] = [];
    for (let i = 0; i < 5; i++) { timing.remember(0, FRAME_US, 100_000 + i * FRAME_US); times.push(timing.resolve(0).renderTimeUs); }
    expect(times).toEqual([0, 1, 2, 3, 4].map(i => 100_000 + i * FRAME_US));
  });

  it('pairs frame-count output timestamps with +/-2 us jittered input timestamps', () => {
    const timing = new AudioOutputTiming(), expected: number[] = [];
    for (let i = 0; i < 50; i++) {
      const jitter = [0, 2, -2, 1, -1][i % 5]!;
      const ts = Math.max(0, Math.round(i * 1024 * 1e6 / 48_000) + jitter);
      timing.remember(ts, FRAME_US, 1_000_000 + ts); expected.push(1_000_000 + ts);
    }
    // Decoder synthesizes output timestamps from the first timestamp plus frames emitted.
    const times = Array.from({ length: 50 }, (_, i) => timing.resolve(Math.round(i * 1024 * 1e6 / 48_000)).renderTimeUs);
    expect(times).toEqual(expected);
  });

  it('skips a suppressed priming input when synthesized output timestamps miss jittered inputs', () => {
    const timing = new AudioOutputTiming();
    timing.remember(0, FRAME_US, 100_000); timing.remember(FRAME_US + 2, FRAME_US, 200_000);
    timing.remember(2 * FRAME_US - 1, FRAME_US, 300_000);
    // Priming suppressed the first input's output entirely.
    expect(timing.resolve(FRAME_US).renderTimeUs).toBe(200_000);
    expect(timing.resolve(2 * FRAME_US + 1).renderTimeUs).toBe(300_000);
  });

  it('falls back to the oldest pending submission when no timestamp is within a frame', () => {
    const timing = new AudioOutputTiming();
    timing.remember(0, FRAME_US, 100_000); timing.resolve(0);
    timing.remember(1_000_000, FRAME_US, 200_000); timing.remember(1_021_333, FRAME_US, 220_000);
    expect(timing.resolve(5_000_000)).toEqual({ renderTimeUs: 200_000, input: null });
    expect(timing.resolve(6_000_000)).toEqual({ renderTimeUs: 220_000, input: null });
    expect(timing.resolve(7_000_000)).toEqual({ renderTimeUs: 0, input: null });
  });

  it('drops a fallback queue on clear', () => {
    const timing = new AudioOutputTiming();
    timing.remember(0, FRAME_US, 100_000); timing.remember(0, FRAME_US, 120_000); timing.clear();
    timing.remember(0, FRAME_US, 500_000); timing.remember(0, FRAME_US, 520_000);
    expect([timing.resolve(0).renderTimeUs, timing.resolve(0).renderTimeUs]).toEqual([500_000, 520_000]);
  });
});
