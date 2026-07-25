/**
 * The reference codec is the corpus's INDEPENDENT oracle for spec-derived bytes.
 * These tests (a) pin a few literal encodings straight from the specs, and (b)
 * cross-check the reference against the production primitives over a value sweep
 * — a disagreement flags a bug in EITHER, for a human to resolve. The corpus
 * bytes come from the reference, so this cross-check is a sanity net, not the
 * oracle itself.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { writeVi64, writeVarint } from '@moqt/transport';
import { refVi64, refQuicVarint, refEncodeBlock } from './ref-codec.js';
import { toHex } from './canonical.js';

const prodVi64 = (v: bigint): string => { const b = new Uint8Array(9); return toHex(b.subarray(0, writeVi64(v, b, 0))); };
const prodVarint = (v: bigint): string => { const b = new Uint8Array(8); return toHex(b.subarray(0, writeVarint(v, b, 0))); };

describe('reference codec — literal spec anchors', () => {
  it('vi64 minimal encodings (draft-18 §1.4.1)', () => {
    expect(toHex(refVi64(0n))).toBe('00');
    expect(toHex(refVi64(63n))).toBe('3f');
    expect(toHex(refVi64(64n))).toBe('40'); // still 1 byte (vi64 diverges from QUIC here)
    expect(toHex(refVi64(127n))).toBe('7f');
    expect(toHex(refVi64(18446744073709551615n))).toBe('ffffffffffffffffff'); // 9 bytes
  });
  it('QUIC varint minimal encodings (RFC 9000 §16)', () => {
    expect(toHex(refQuicVarint(63n))).toBe('3f');
    expect(toHex(refQuicVarint(64n))).toBe('4040'); // 2 bytes — the divergence point
  });
  it('rejects out-of-range values', () => {
    expect(() => refQuicVarint(4611686018427387904n)).toThrow(); // 2^62
    expect(() => refVi64(18446744073709551616n)).toThrow(); // 2^64
  });
  it('odd-property value length boundary (65535 accepted, 65536 rejected — §1.4.3)', () => {
    expect(refEncodeBlock([{ id: 13n, value: new Uint8Array(65535) }], 'd18-delta-vi64', { canonical: false })).toBeInstanceOf(Uint8Array);
    expect(() => refEncodeBlock([{ id: 13n, value: new Uint8Array(65536) }], 'd18-delta-vi64', { canonical: false })).toThrow(/2\^16-1/);
  });

  it('parity + non-decreasing enforcement', () => {
    expect(() => refEncodeBlock([{ id: 2n, value: new Uint8Array([1]) }], 'd18-delta-vi64', { canonical: false })).toThrow(/parity/);
    expect(() => refEncodeBlock([{ id: 6n, value: 2n }, { id: 2n, value: 3n }], 'd18-delta-vi64', { canonical: false })).toThrow(/non-decreasing/);
    // canonical mode sorts, so the same entries encode fine
    expect(refEncodeBlock([{ id: 6n, value: 2n }, { id: 2n, value: 3n }], 'd18-delta-vi64', { canonical: true })).toBeInstanceOf(Uint8Array);
  });
});

describe('reference vs production cross-check (sanity net)', () => {
  const values = [0n, 1n, 63n, 64n, 127n, 128n, 16383n, 16384n, 1073741823n, 1073741824n, 1726000000000000n, 4611686018427387903n];
  it('vi64 agrees over the sweep', () => {
    for (const v of values) expect(toHex(refVi64(v)), `vi64 ${v}`).toBe(prodVi64(v));
    // vi64-only range above 2^62-1
    for (const v of [4611686018427387904n, 18446744073709551615n]) expect(toHex(refVi64(v)), `vi64 ${v}`).toBe(prodVi64(v));
  });
  it('QUIC varint agrees over the in-range sweep', () => {
    for (const v of values) expect(toHex(refQuicVarint(v)), `varint ${v}`).toBe(prodVarint(v));
  });
});
