import { describe, expect, it } from 'vitest';
import type { SourceTimestamp } from '@openmoq/loc';
import { constrainLocTimelineMapping, snapshotLocTimelineMapping, UnsupportedLocTimelineMappingError } from './loc-timeline-mapping.js';
import type { LocTimelineMappingState } from './loc-timeline-mapping.js';

const source = (ticks: bigint, ticksPerSecond = 1_000_000n, domain: SourceTimestamp['domain'] = 'unix'): SourceTimestamp =>
  ({ ticks, ticksPerSecond, domain });
const state = (lower: bigint, upper: bigint, upperInclusive = false): LocTimelineMappingState => ({
  domain: 'unix', lowerUs: { numerator: lower, denominator: 1n }, upperUs: { numerator: upper, denominator: 1n }, upperInclusive,
});

describe('cumulative LOC mapping causal controls', () => {
  it('rejects a third band even though each later band intersects the original band', () => {
    const first = constrainLocTimelineMapping(undefined, source(0n), 4000, 'floor');
    const second = constrainLocTimelineMapping(first, source(999_250n), 5000, 'floor');
    // Original [4000000,4001000), second [4000750,4001750),
    // third [3999250,4000250): every pair with original overlaps.
    expect(() => constrainLocTimelineMapping(second, source(2_000_750n), 6000, 'floor'))
      .toThrow(UnsupportedLocTimelineMappingError);
  });

  it('accepts a compatible third indexed sample without changing raw timestamps', () => {
    const raw = source(2_000_000n);
    const first = constrainLocTimelineMapping(undefined, source(0n), 4000, 'floor');
    const second = constrainLocTimelineMapping(first, source(999_250n), 5000, 'floor');
    expect(() => constrainLocTimelineMapping(second, raw, 6000, 'floor')).not.toThrow();
    expect(raw).toEqual(source(2_000_000n));
  });

  it('rejects a disjoint second band with a specific local-profile error', () => {
    const first = constrainLocTimelineMapping(undefined, source(0n), 4000, 'floor');
    expect(() => constrainLocTimelineMapping(first, source(2_000_000n), 5000, 'floor'))
      .toThrow(UnsupportedLocTimelineMappingError);
  });
});

describe('LOC unit-rate offset bounds', () => {
  it.each(['floor', 'nearest'] as const)('initializes exact content-minus-source bounds for %s', rounding => {
    const result = constrainLocTimelineMapping(undefined, source(2_000_000n), 4000, rounding);
    expect(result).toEqual(state(rounding === 'floor' ? 2_000_000n : 1_999_500n,
      rounding === 'floor' ? 2_001_000n : 2_000_500n, rounding === 'nearest'));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lowerUs)).toBe(true); expect(Object.isFrozen(result.upperUs)).toBe(true);
  });

  it('narrows and preserves the accumulated band instead of merely comparing against its first anchor', () => {
    const first = constrainLocTimelineMapping(undefined, source(0n), 4000, 'floor');
    const second = constrainLocTimelineMapping(first, source(999_250n), 5000, 'floor');
    expect(second).toEqual(state(4_000_750n, 4_001_000n));
    const third = constrainLocTimelineMapping(second, source(2_000_000n), 6000, 'floor');
    expect(third).toEqual(second); expect(third).not.toBe(second);
    expect(first).toEqual(state(4_000_000n, 4_001_000n));
  });

  it.each([-1000n, 1000n])('refuses a floor-exclusive touching endpoint at source %s', offset => {
    const initial = constrainLocTimelineMapping(undefined, source(0n), 0, 'floor');
    expect(() => constrainLocTimelineMapping(initial, source(offset), 0, 'floor')).toThrow(UnsupportedLocTimelineMappingError);
  });

  it('allows a nearest-inclusive singleton and retains it under a containing floor band', () => {
    const initial = constrainLocTimelineMapping(undefined, source(0n), 0, 'nearest');
    const singleton = constrainLocTimelineMapping(initial, source(-1000n), 0, 'nearest');
    expect(singleton).toEqual(state(500n, 500n, true));
    expect(constrainLocTimelineMapping(singleton, source(-500n), 0, 'floor')).toEqual(singleton);
    expect(() => constrainLocTimelineMapping(singleton, source(500n), 0, 'floor')).toThrow(UnsupportedLocTimelineMappingError);
  });

  it('combines equal upper endpoints with AND, preserving the floor exclusion', () => {
    const initial = constrainLocTimelineMapping(undefined, source(0n), 0, 'floor');
    expect(constrainLocTimelineMapping(initial, source(-500n), 0, 'nearest')).toEqual(state(0n, 1000n));
  });

  it.each(['floor', 'nearest'] as const)('keeps inclusivity of the strictly smaller upper endpoint after %s', rounding => {
    const initial = constrainLocTimelineMapping(undefined, source(0n), 0, rounding);
    const next = rounding === 'floor' ? 'nearest' : 'floor';
    expect(constrainLocTimelineMapping(initial, source(0n), 0, next)).toEqual(state(0n, 500n, true));
  });

  it('compares a sub-microsecond separation exactly rather than treating it as a touching endpoint', () => {
    const singleton = state(0n, 0n, true);
    expect(constrainLocTimelineMapping(singleton, source(1n, 3_000_000n), 0, 'floor')).toEqual(singleton);
    expect(() => constrainLocTimelineMapping(singleton, source(-1n, 3_000_000n), 0, 'floor'))
      .toThrow(UnsupportedLocTimelineMappingError);
  });

  it('supports exact equivalent source scales and rational narrowing without a millisecond tolerance', () => {
    const initial = constrainLocTimelineMapping(undefined, source(1n, 3n), 4000, 'floor');
    expect(initial.lowerUs).toEqual({ numerator: 11_000_000n, denominator: 3n });
    expect(constrainLocTimelineMapping(initial, source(2n, 6n), 4000, 'floor')).toEqual(initial);
    const narrowed = constrainLocTimelineMapping(initial, source(2n, 3n), 4333, 'floor');
    expect(narrowed.lowerUs).toEqual({ numerator: 11_000_000n, denominator: 3n });
    expect(narrowed.upperUs).toEqual({ numerator: 11_002_000n, denominator: 3n });
  });

  it('subtracts a huge epoch exactly and reduces fractions whose scale cannot be represented by Number', () => {
    const epoch = 1n << 1500n, scale = 1n << 1200n;
    const point = source(epoch * scale + scale / 2048n, scale, 'media');
    const initial = constrainLocTimelineMapping(undefined, point, 2000, 'floor');
    const center = 2_000_000n - epoch * 1_000_000n;
    expect(initial.lowerUs).toEqual({ numerator: center * 32n - 15_625n, denominator: 32n });
    expect(initial.upperUs).toEqual({ numerator: center * 32n + 16_375n, denominator: 32n });
    const next = source(point.ticks + scale, scale, 'media');
    expect(constrainLocTimelineMapping(initial, next, 3000, 'floor')).toEqual(initial);
  });

  it('allows negative source and indexed media values without truncating a negative fraction', () => {
    const initial = constrainLocTimelineMapping(undefined, source(-1n, 3n, 'media'), -334, 'floor');
    expect(initial).toEqual({ domain: 'media', lowerUs: { numerator: -2000n, denominator: 3n },
      upperUs: { numerator: 1000n, denominator: 3n }, upperInclusive: false });
  });

  it('retains only two bounds across repeated observations, with no sample history or nominal placement', () => {
    let current: LocTimelineMappingState | undefined;
    for (let i = 0n; i < 20n; i++) current = constrainLocTimelineMapping(current, source(i * 1_000_000n), 4000 + Number(i) * 1000, 'floor');
    expect(current).toEqual(state(4_000_000n, 4_001_000n));
    expect(Object.keys(current!)).toEqual(['domain', 'lowerUs', 'upperUs', 'upperInclusive']);
    expect(Object.keys(current!.lowerUs)).toEqual(['numerator', 'denominator']);
  });
});

describe('LOC mapping snapshot and invalid input ownership', () => {
  it('copies, reduces and freezes caller state before reuse', () => {
    const original: LocTimelineMappingState = { domain: 'unix', lowerUs: { numerator: 2n, denominator: 4n },
      upperUs: { numerator: 6n, denominator: 4n }, upperInclusive: true };
    const snapshot = snapshotLocTimelineMapping(original);
    expect(snapshot.lowerUs).toEqual({ numerator: 1n, denominator: 2n });
    expect(snapshot.upperUs).toEqual({ numerator: 3n, denominator: 2n });
    Reflect.set(original.lowerUs, 'numerator', 99n); Reflect.set(original, 'upperInclusive', false);
    expect(snapshot.lowerUs.numerator).toBe(1n); expect(snapshot.upperInclusive).toBe(true);
    expect(snapshot).not.toBe(original); expect(snapshot.lowerUs).not.toBe(original.lowerUs);
    for (const value of [snapshot, snapshot.lowerUs, snapshot.upperUs]) expect(Object.isFrozen(value)).toBe(true);
  });

  it('reads declared state and source getters once, ignores unrelated getters, and retains no accessors', () => {
    const reads: string[] = [];
    const observed: LocTimelineMappingState = {
      get domain(): LocTimelineMappingState['domain'] { reads.push('domain'); return 'unix'; },
      get lowerUs() { reads.push('lower'); return { get numerator() { reads.push('ln'); return 0n; },
        get denominator() { reads.push('ld'); return 2n; } }; },
      get upperUs() { reads.push('upper'); return { get numerator() { reads.push('un'); return 1000n; },
        get denominator() { reads.push('ud'); return 2n; } }; },
      get upperInclusive() { reads.push('inclusive'); return true; },
    };
    const snapshot = snapshotLocTimelineMapping(observed);
    expect(reads).toEqual(['domain', 'lower', 'upper', 'inclusive', 'ln', 'ld', 'un', 'ud']);
    const point = { get ticks() { reads.push('ticks'); return 0n; },
      get ticksPerSecond() { reads.push('scale'); return 1_000_000n; },
      get domain(): SourceTimestamp['domain'] { reads.push('source domain'); return 'unix'; },
      get unrelated() { throw new Error('Must not enumerate source'); } };
    const next = constrainLocTimelineMapping(snapshot, point, 0, 'floor');
    expect(reads.slice(8)).toEqual(['ticks', 'scale', 'source domain']);
    expect(next).toEqual(state(0n, 500n, true));
    expect(Object.getOwnPropertyDescriptor(next, 'domain')?.get).toBeUndefined();
  });

  it('contains a nested pure constraint without sharing or replacing either returned state', () => {
    const original = state(0n, 1000n); let nested: LocTimelineMappingState | undefined;
    const point: SourceTimestamp = { get ticks() {
      nested = constrainLocTimelineMapping(original, source(0n), 0, 'nearest'); return -500n;
    }, ticksPerSecond: 1_000_000n, domain: 'unix' };
    const outer = constrainLocTimelineMapping(original, point, 0, 'nearest');
    expect(outer).toEqual(state(0n, 1000n)); expect(nested).toEqual(state(0n, 500n, true));
    expect(original).toEqual(state(0n, 1000n)); expect(Object.isFrozen(original)).toBe(false);
  });

  it.each(['media', 'unknown'] as const)('refuses a changed or unavailable source domain: %s', domain => {
    const current = constrainLocTimelineMapping(undefined, source(0n), 0, 'floor');
    try { constrainLocTimelineMapping(current, source(0n, 1_000_000n, domain), 0, 'floor'); throw new Error('Expected refusal'); }
    catch (error) {
      expect(error).toBeInstanceOf(UnsupportedLocTimelineMappingError);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: 'UnsupportedLocTimelineMappingError', message: expect.stringMatching(/unit-rate.*mapping.*domain/i) });
    }
    expect(current).toEqual(state(0n, 1000n));
  });

  it.each([
    ['ticks', 0], ['ticksPerSecond', 0n], ['ticksPerSecond', -1n],
  ] as const)('rejects malformed source %s without mutating existing bounds', (key, value) => {
    const current = state(0n, 1000n), point = source(0n); Reflect.set(point, key, value);
    expect(() => constrainLocTimelineMapping(current, point, 0, 'floor')).toThrow(TypeError);
    expect(current).toEqual(state(0n, 1000n));
  });

  it.each([NaN, Infinity, -Infinity, 0.25, Number.MAX_SAFE_INTEGER + 1])('refuses an unrepresentable media index %s', index => {
    expect(() => constrainLocTimelineMapping(undefined, source(0n), index, 'floor')).toThrow(RangeError);
  });

  it('rejects unsupported rounding rather than guessing a quantization rule', () => {
    expect(() => Reflect.apply(constrainLocTimelineMapping, undefined, [undefined, source(0n), 0, 'truncate'])).toThrow(TypeError);
  });

  it.each([
    ['numerator', 0], ['denominator', 0n], ['denominator', -1n],
  ] as const)('refuses a malformed resumed fraction %s', (key, value) => {
    const current = state(0n, 1000n); Reflect.set(current.lowerUs, key, value);
    expect(() => snapshotLocTimelineMapping(current)).toThrow(TypeError);
    expect(() => constrainLocTimelineMapping(current, source(0n), 0, 'floor')).toThrow(TypeError);
  });

  it.each([state(1000n, 0n), state(0n, 0n)])('refuses an empty or reversed resumed band', current => {
    expect(() => snapshotLocTimelineMapping(current)).toThrow(UnsupportedLocTimelineMappingError);
  });

  it('requires an explicit boolean endpoint and known state domain', () => {
    const current = state(0n, 1000n); Reflect.set(current, 'upperInclusive', undefined);
    expect(() => snapshotLocTimelineMapping(current)).toThrow(TypeError);
    const unknown = state(0n, 1000n); Reflect.set(unknown, 'domain', 'unknown');
    expect(() => snapshotLocTimelineMapping(unknown)).toThrow(UnsupportedLocTimelineMappingError);
  });
});
