import { describe, expect, it, vi } from 'vitest';
import { placePresentationAnchor } from './presentation-placement.js';
import * as nativeTime from './presentation-placement.js';

const placement = { token: {}, toRebasedTimeUs: (source: bigint) => ({ numerator: source - 990_000_000n, denominator: 1n }) };

describe('canonical presentation placement', () => {
  it('maps target 90s through reference audio 1000s/epoch990s rather than the old video epoch', () => {
    expect(placePresentationAnchor(placement, 90_000_000n, 1_000_000_000n, 0, 0)).toEqual({
      sourceTimeUs: 90_000_000n, rebasedTimeUs: { numerator: 10_000_000n, denominator: 1n },
    });
  });

  it('accounts for both native offsets without changing the reference snapshot', () => {
    const snapshot = Object.freeze({ numerator: 10_000_000n, denominator: 1n });
    const ref = { token: {}, toRebasedTimeUs: () => snapshot };
    const result = placePresentationAnchor(ref, 90_000_000n, 1_000_000_000n, 0.25, 0.75);
    expect(result?.rebasedTimeUs).toEqual({ numerator: 9_500_000n, denominator: 1n });
    expect(snapshot).toEqual({ numerator: 10_000_000n, denominator: 1n });
  });

  it('preserves fractional native offsets exactly until target tick conversion', () => {
    const ref = { token: {}, toRebasedTimeUs: () => ({ numerator: 0n, denominator: 1n }) };
    const result = placePresentationAnchor(ref, 90_000_000n, 0n, 0.1, 0)!;
    const expectedNumerator = 3_602_879_701_896_397n * 1_000_000n;
    const expectedDenominator = 1n << 55n;
    expect(result.rebasedTimeUs.numerator * expectedDenominator)
      .toBe(expectedNumerator * result.rebasedTimeUs.denominator);
    expect(result.rebasedTimeUs.denominator).not.toBe(1n);
  });

  it('keeps nonintegral reference placement and negative offsets without clamping', () => {
    const ref = { token: {}, toRebasedTimeUs: () => ({ numerator: 1n, denominator: 3n }) };
    expect(placePresentationAnchor(ref, 0n, 0n, -0.25, 0.5)?.rebasedTimeUs)
      .toEqual({ numerator: -2_249_999n, denominator: 3n });
  });

  it.each([undefined, Infinity, -Infinity, NaN])('refuses unavailable native offset %s before consulting the source', offset => {
    const read = vi.fn(() => ({ numerator: 1n, denominator: 1n }));
    const ref = { token: {}, toRebasedTimeUs: read };
    expect(placePresentationAnchor(ref, 0n, 0n, offset, 0)).toBeNull();
    expect(placePresentationAnchor(ref, 0n, 0n, 0, offset)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('propagates unavailable source placement without inventing an epoch', () => {
    expect(placePresentationAnchor({ token: {}, toRebasedTimeUs: () => null }, 0n, 0n, 0, 0)).toBeNull();
  });

  it.each([0n, -1n])('rejects an invalid placement denominator %s', denominator => {
    expect(() => placePresentationAnchor({ token: {}, toRebasedTimeUs: () => ({ numerator: 1n, denominator }) },
      0n, 0n, 0, 0)).toThrow(/placement/);
  });
});

describe('shared exact native time conversion', () => {
  const convert = (seconds: number | undefined) => {
    expect(nativeTime.nativeTimeUs).toBeTypeOf('function');
    return nativeTime.nativeTimeUs(seconds);
  };

  it.each([undefined, NaN, Infinity, -Infinity])('returns unavailable for %s', seconds => {
    expect(convert(seconds)).toBeNull();
  });

  it('keeps zero, negative offsets and binary fractional seconds exact', () => {
    expect(convert(0)).toEqual({ numerator: 0n, denominator: 1n });
    expect(convert(-0)).toEqual({ numerator: 0n, denominator: 1n });
    expect(convert(1)).toEqual({ numerator: 1_000_000n, denominator: 1n });
    expect(convert(-0.25)).toEqual({ numerator: -250_000n, denominator: 1n });
    expect(convert(1.25)).toEqual({ numerator: 1_250_000n, denominator: 1n });
    const positive = convert(0.1)!, negative = convert(-0.1)!;
    const numerator = 3_602_879_701_896_397n * 1_000_000n, denominator = 1n << 55n;
    expect(positive.numerator * denominator).toBe(numerator * positive.denominator);
    expect(negative.numerator * denominator).toBe(-numerator * negative.denominator);
  });

  it('preserves finite extremes and subnormal seconds without rounding to zero or infinity', () => {
    const tiny = convert(Number.MIN_VALUE)!, negativeTiny = convert(-Number.MIN_VALUE)!;
    expect(tiny.numerator * (1n << 1074n)).toBe(1_000_000n * tiny.denominator);
    expect(negativeTiny.numerator * (1n << 1074n)).toBe(-1_000_000n * negativeTiny.denominator);
    const largest = ((1n << 1024n) - (1n << 971n)) * 1_000_000n;
    expect(convert(Number.MAX_VALUE)).toEqual({ numerator: largest, denominator: 1n });
    expect(convert(-Number.MAX_VALUE)).toEqual({ numerator: -largest, denominator: 1n });
  });
});
