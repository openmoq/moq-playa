import { describe, it, expect } from 'vitest';
import { wideInt, wideStr, fromHex, toHex, deepEqualCanonical } from './canonical.js';

describe('canonical wide-integer rules', () => {
  it('parses a decimal-string wide integer', () => {
    expect(wideInt('18446744073709551615')).toBe(18446744073709551615n);
    expect(wideInt('0')).toBe(0n);
  });

  it('REJECTS a JSON number in a wide-integer field (precision hazard)', () => {
    expect(() => wideInt(42)).toThrow(/must be a decimal STRING/);
    expect(() => wideInt(9007199254740993)).toThrow(/JSON number/);
  });

  it('rejects a non-canonical decimal string', () => {
    expect(() => wideInt('01')).toThrow(); // leading zero
    expect(() => wideInt('0x2a')).toThrow();
    expect(() => wideInt('4.2')).toThrow();
    expect(() => wideInt('')).toThrow();
  });

  it('round-trips wideStr', () => {
    expect(wideStr(18446744073709551615n)).toBe('18446744073709551615');
  });
});

describe('canonical hex', () => {
  it('round-trips bytes', () => {
    const bytes = Uint8Array.from([0x00, 0x2a, 0xff]);
    expect(toHex(bytes)).toBe('002aff');
    expect([...fromHex('002aff')]).toEqual([0x00, 0x2a, 0xff]);
  });

  it('rejects non-canonical hex', () => {
    expect(() => fromHex('0')).toThrow(); // odd length
    expect(() => fromHex('00FF')).toThrow(); // uppercase
    expect(() => fromHex('zz')).toThrow();
  });
});

describe('deepEqualCanonical', () => {
  it('is key-order independent but array-order significant', () => {
    expect(deepEqualCanonical({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqualCanonical([1, 2], [2, 1])).toBe(false);
  });
  it('fails on extra keys either side', () => {
    expect(deepEqualCanonical({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqualCanonical({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });
  it('compares nested structures', () => {
    expect(deepEqualCanonical({ x: [{ id: '2' }] }, { x: [{ id: '2' }] })).toBe(true);
    expect(deepEqualCanonical({ x: [{ id: '2' }] }, { x: [{ id: '3' }] })).toBe(false);
  });
});
