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
  it('refuses conflicting timing candidates instead of choosing the latest or oldest input', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, undefined, 100_000); timing.remember(20_000, 20_000, 300_000);
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 0, input: null });
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
    timing.remember(0, 20_000, 200_000); expect(timing.resolve(0)).toEqual({ renderTimeUs: 0, input: null });
  });
  it('keeps a throwing native submission unavailable', () => {
    const timing = new AudioOutputTiming(); timing.remember(0, 20_000, 100_000); timing.poison(0);
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 0, input: null });
  });
  it('does not resurrect an evicted timestamp and refuses uncertain priming after eviction', () => {
    const timing = new AudioOutputTiming(1); timing.remember(0, 20_000, 100_000);
    const current = timing.remember(20_000, 20_000, 120_000);
    expect(timing.remember(0, 20_000, 500_000)).toBeUndefined();
    expect(timing.resolve(20_000)).toEqual({ renderTimeUs: 0, input: null });
    expect(timing.resolve(0)).toEqual({ renderTimeUs: 0, input: null });
    expect(timing.resolve(20_000).input).toBe(current);
  });
  it('does not let an imprecise prior input prove the first output identity', () => {
    const timing = new AudioOutputTiming(); timing.remember(-Number.MAX_SAFE_INTEGER - 1, undefined, 10);
    timing.remember(0, 20_000, 100_000); expect(timing.resolve(0)).toEqual({ renderTimeUs: 0, input: null });
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
