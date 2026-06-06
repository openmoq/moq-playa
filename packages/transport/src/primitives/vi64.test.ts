/**
 * vi64 — MoQT draft-18 variable-length integer.
 *
 * Distinct from the QUIC varint (draft-16): length is signalled by the number of
 * leading 1-bits of the first byte, encodes 1–9 bytes, and covers the FULL 64-bit
 * unsigned range (0 .. 2^64-1) — beyond QUIC varint's 2^62-1. Non-minimal
 * encodings are explicitly valid and MUST decode.
 *
 * Golden vectors are taken verbatim from draft-ietf-moq-transport-18 §1.4.1
 * Table 1 (boundaries) and Table 2 (examples).
 *
 * @see draft-ietf-moq-transport-18 §1.4.1
 */
import { describe, it, expect } from 'vitest';
import { readVi64, writeVi64, vi64EncodingLength, MAX_VI64 } from './vi64.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// draft-18 §1.4.1 Table 2 — minimal example encodings.
const TABLE2: ReadonlyArray<[string, bigint]> = [
  ['25', 37n],
  ['bbbd', 15293n],
  ['ed7f3e7d', 226442877n],
  ['faa1a0e403d8', 2893212287960n],
  ['fc8998abc66bc0', 151288809941952n],
  ['fefa318fa8e3ca11', 70423237261249041n],
  ['ffffffffffffffffff', 18446744073709551615n],
];

// Table 1 — per-length max values (minimal boundaries).
const BOUNDARIES: ReadonlyArray<[number, bigint]> = [
  [1, 127n],
  [2, 16383n],
  [3, 2097151n],
  [4, 268435455n],
  [5, 34359738367n],
  [6, 4398046511103n],
  [7, 562949953421311n],
  [8, 72057594037927935n],
  [9, 18446744073709551615n],
];

describe('vi64EncodingLength', () => {
  it('matches the Table 1 length boundaries', () => {
    expect(vi64EncodingLength(0n)).toBe(1);
    for (const [len, max] of BOUNDARIES) {
      expect(vi64EncodingLength(max)).toBe(len);
      if (len < 9) expect(vi64EncodingLength(max + 1n)).toBe(len + 1);
    }
  });

  it('includes the 7-byte length (new in draft-18)', () => {
    expect(vi64EncodingLength(562949953421311n)).toBe(7);
    expect(vi64EncodingLength(562949953421312n)).toBe(8);
  });

  it('throws below 0 or above 2^64-1', () => {
    expect(() => vi64EncodingLength(-1n)).toThrow(RangeError);
    expect(() => vi64EncodingLength(MAX_VI64 + 1n)).toThrow(RangeError);
  });
});

describe('readVi64', () => {
  it('decodes every Table 2 example', () => {
    for (const [hex, value] of TABLE2) {
      const buf = hexToBytes(hex);
      expect(readVi64(buf, 0)).toEqual({ value, bytesRead: buf.length });
    }
  });

  it('decodes a non-minimal encoding (0x8025 → 37)', () => {
    expect(readVi64(hexToBytes('8025'), 0)).toEqual({ value: 37n, bytesRead: 2 });
  });

  it('reads at an offset and reports bytesRead', () => {
    const buf = hexToBytes('aaaa' + 'bbbd');
    expect(readVi64(buf, 2)).toEqual({ value: 15293n, bytesRead: 2 });
  });

  it('throws RangeError when the buffer is too short', () => {
    expect(() => readVi64(hexToBytes('ff'), 0)).toThrow(RangeError); // needs 9 bytes
    expect(() => readVi64(new Uint8Array(0), 0)).toThrow(RangeError);
  });
});

describe('writeVi64', () => {
  it('produces the minimal encoding for each Table 2 example', () => {
    for (const [hex, value] of TABLE2) {
      const buf = new Uint8Array(9);
      const n = writeVi64(value, buf, 0);
      expect(bytesToHex(buf.subarray(0, n))).toBe(hex);
    }
  });

  it('round-trips Table 1 boundary values and ±1 around them', () => {
    const probes = [0n, ...BOUNDARIES.flatMap(([, max]) => [max, max > 0n ? max - 1n : 0n])];
    for (const value of probes) {
      const buf = new Uint8Array(9);
      const n = writeVi64(value, buf, 0);
      expect(readVi64(buf, 0)).toEqual({ value, bytesRead: n });
    }
  });

  it('round-trips a dense sweep of exponential probes', () => {
    for (let bits = 0n; bits < 64n; bits++) {
      for (const value of [1n << bits, (1n << bits) - 1n]) {
        if (value > MAX_VI64) continue;
        const buf = new Uint8Array(9);
        const n = writeVi64(value, buf, 0);
        expect(readVi64(buf, 0).value).toBe(value);
      }
    }
  });

  it('writes 0xFF + 8 bytes for the full 64-bit max', () => {
    const buf = new Uint8Array(9);
    const n = writeVi64(MAX_VI64, buf, 0);
    expect(n).toBe(9);
    expect(bytesToHex(buf.subarray(0, 9))).toBe('ffffffffffffffffff');
  });

  it('throws below 0 or above 2^64-1', () => {
    const buf = new Uint8Array(9);
    expect(() => writeVi64(-1n, buf, 0)).toThrow(RangeError);
    expect(() => writeVi64(MAX_VI64 + 1n, buf, 0)).toThrow(RangeError);
  });
});
