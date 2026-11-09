import { describe, expect, it } from 'vitest';
import { ReceivedPayloadRate } from './received-payload-rate.js';

describe('selected-source received payload rate', () => {
  function stream(key: number, other: number) {
    const rate = new ReceivedPayloadRate();
    rate.observe(20_000, 0);
    for (let frame = 1; frame <= 250; frame++) rate.observe(frame % 25 === 1 ? key : other, frame * 40_000);
    return rate;
  }
  it('gives equal-weight and keyframe-heavy streams the same received rate', () => {
    expect(stream(20_000, 20_000).read(10_000_000)).toBeCloseTo(4000, 6);
    expect(stream(100_016, 16_666).read(10_000_000)).toBeCloseTo(4000, 6);
  });
  it('warms up by observed time, not the number of objects', () => {
    const rate = new ReceivedPayloadRate(); rate.observe(1, 0);
    for (let n = 1; n <= 4999; n++) rate.observe(500, n * 1000);
    expect(rate.read(4_999_000)).toBeNull();
    rate.observe(500, 5_000_000);
    expect(rate.read(5_000_000)).toBeCloseTo(4000, 6);
  });
  it('uses actual elapsed time for a delayed window', () => {
    const rate = new ReceivedPayloadRate(); rate.observe(1, 0);
    for (let n = 1; n <= 4; n++) rate.observe(625_000, n * 1_250_000);
    expect(rate.read(5_000_000)).toBeCloseTo(4000, 6);
  });
  it('includes an arrival closing a window once and excludes the initial unknown interval', () => {
    const rate = new ReceivedPayloadRate(); rate.observe(9_000_000, 0);
    for (let n = 1; n <= 5; n++) rate.observe(125_000, n * 1_000_000);
    expect(rate.read(5_000_000)).toBeCloseTo(1000, 6);
    expect(rate.read(5_000_000)).toBeCloseTo(1000, 6);
  });
  it('decays during observed silence without waiting for another Group', () => {
    const rate = stream(20_000, 20_000);
    for (let n = 11; n <= 15; n++) rate.advance(n * 1_000_000);
    expect(rate.read(15_000_000)).toBeCloseTo(4000 * 0.7 ** 5, 6);
  });
  it('does not invent observations through a suspended clock gap', () => {
    const rate = stream(20_000, 20_000);
    expect(rate.read(16_000_000)).toBeNull();
    rate.observe(500_000, 16_000_000);
    expect(rate.read(17_000_000)).toBeNull();
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('invalid bytes %s retire the estimate', bytes => {
    const rate = stream(20_000, 20_000);
    rate.observe(bytes, 10_010_000);
    expect(rate.read(10_020_000)).toBeNull();
  });
  it.each([NaN, Infinity, -1, 9_000_000])('invalid or reversed clock %s retires the estimate', now => {
    const rate = stream(20_000, 20_000);
    expect(rate.read(now)).toBeNull();
  });
  it('overflow retires an interval instead of rounding its bytes', () => {
    const rate = new ReceivedPayloadRate(); rate.observe(1, 0);
    rate.observe(Number.MAX_SAFE_INTEGER, 1);
    rate.observe(1, 2);
    expect(rate.read(1_000_000)).toBeNull();
  });
  it('reset drops unfinished bytes and all prior source evidence', () => {
    const rate = stream(20_000, 20_000); rate.reset();
    expect(rate.read(10_000_000)).toBeNull();
    rate.observe(1, 10_000_000);
    for (let n = 11; n <= 15; n++) rate.observe(125_000, n * 1_000_000);
    expect(rate.read(15_000_000)).toBeCloseTo(1000, 6);
  });
});
