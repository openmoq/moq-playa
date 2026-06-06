/**
 * PR2 — property tests for the integer primitives (QUIC varint + vi64).
 *
 * These are pure encode→decode round-trips with boundary-biased generators, plus
 * targeted out-of-range "throws" properties. fast-check shrinks any failure to a
 * minimal counterexample and prints the seed/path for replay. Env knobs: FC_RUNS
 * (default 200) and FC_SEED.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_VARINT,
  varint,
  varintEncodingLength,
  writeVarint,
  readVarint,
} from './varint.js';
import { MAX_VI64, vi64EncodingLength, writeVi64, readVi64 } from './vi64.js';
import { fc, fcParams, varintValue, vi64Value, aboveVarint, aboveVi64 } from '../testkit/arbitraries.js';

describe('QUIC varint properties', () => {
  it('round-trips every value in [0, 2^62-1] exactly, with matching length', () => {
    fc.assert(
      fc.property(varintValue, (v) => {
        const buf = new Uint8Array(8);
        const written = writeVarint(v, buf, 0);
        const { value, bytesRead } = readVarint(buf, 0);
        expect(value).toBe(v);
        expect(bytesRead).toBe(written);
        expect(written).toBe(varintEncodingLength(v));
      }),
      fcParams(),
    );
  });

  it('round-trips at a non-zero offset (no aliasing of the length flag)', () => {
    fc.assert(
      fc.property(varintValue, fc.integer({ min: 0, max: 4 }), (v, off) => {
        const buf = new Uint8Array(off + 8);
        const written = writeVarint(v, buf, off);
        const { value, bytesRead } = readVarint(buf, off);
        expect(value).toBe(v);
        expect(bytesRead).toBe(written);
      }),
      fcParams(),
    );
  });

  it('rejects values > 2^62-1 on write and on length computation', () => {
    fc.assert(
      fc.property(aboveVarint, (v) => {
        const buf = new Uint8Array(8);
        expect(() => writeVarint(v, buf, 0)).toThrow(RangeError);
        expect(() => varintEncodingLength(v)).toThrow(RangeError);
        expect(() => varint(v)).toThrow(RangeError);
      }),
      fcParams(),
    );
  });

  it('the branded varint() factory accepts exactly the in-range values', () => {
    fc.assert(
      fc.property(varintValue, (v) => {
        expect(varint(v)).toBe(v);
        expect(v).toBeLessThanOrEqual(MAX_VARINT);
      }),
      fcParams(),
    );
  });
});

describe('vi64 properties', () => {
  it('round-trips every value in [0, 2^64-1] exactly, with matching length', () => {
    fc.assert(
      fc.property(vi64Value, (v) => {
        const buf = new Uint8Array(9);
        const written = writeVi64(v, buf, 0);
        const { value, bytesRead } = readVi64(buf, 0);
        expect(value).toBe(v);
        expect(bytesRead).toBe(written);
        expect(written).toBe(vi64EncodingLength(v));
      }),
      fcParams(),
    );
  });

  it('writeVi64 always emits the minimal length for the value', () => {
    fc.assert(
      fc.property(vi64Value, (v) => {
        const buf = new Uint8Array(9);
        const written = writeVi64(v, buf, 0);
        // A shorter encoding would mean the value fit a smaller length class.
        expect(written).toBe(vi64EncodingLength(v));
        expect(v).toBeLessThanOrEqual(MAX_VI64);
      }),
      fcParams(),
    );
  });

  it('rejects values > 2^64-1 on write and on length computation', () => {
    fc.assert(
      fc.property(aboveVi64, (v) => {
        const buf = new Uint8Array(9);
        expect(() => writeVi64(v, buf, 0)).toThrow(RangeError);
        expect(() => vi64EncodingLength(v)).toThrow(RangeError);
      }),
      fcParams(),
    );
  });
});
