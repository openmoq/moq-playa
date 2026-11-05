import { describe, expect, it, vi } from 'vitest';
import { placePresentationAnchor } from './presentation-placement.js';

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
