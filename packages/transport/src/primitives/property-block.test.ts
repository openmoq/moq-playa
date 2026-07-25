/**
 * Direct contract tests for the shared ordered property-wire core — the codec
 * extracted from kvp.ts and track-properties-18.ts and consumed by both. The
 * media conformance corpus exercises it end-to-end; these pin the invariants
 * locally: profile divergence at 64, order/duplicate preservation, non-minimal
 * decode legality, canonical minimal encode, parity, and range rejection.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  decodePropertyBlock,
  encodePropertyBlock,
  propertyBlockEncodingLength,
  PropertyWireError,
  type PropertyEntry,
  type PropertyWireProfile,
} from './property-block.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

describe('property-block — profile divergence at 64', () => {
  // id 2 (even) carries value 64. QUIC goes two-byte (0x4040) at 64; vi64 stays
  // one-byte (0x40) through 127 — the exact divergence this codec must honor.
  it('d16 encodes value 64 as a two-byte QUIC varint', () => {
    expect(hex(encodePropertyBlock([{ id: 2n, value: 64n }], 'd16-delta-varint'))).toBe('024040');
  });
  it('d18 encodes value 64 as a one-byte vi64', () => {
    expect(hex(encodePropertyBlock([{ id: 2n, value: 64n }], 'd18-delta-vi64'))).toBe('0240');
  });
  it('they agree below 64 (63 is one byte in both)', () => {
    expect(hex(encodePropertyBlock([{ id: 2n, value: 63n }], 'd16-delta-varint'))).toBe('023f');
    expect(hex(encodePropertyBlock([{ id: 2n, value: 63n }], 'd18-delta-vi64'))).toBe('023f');
  });
});

describe('property-block — order and duplicates', () => {
  it('decode preserves occurrence order and duplicate ids', () => {
    // d18 deltas: +2 (=2), +0 (=2 again), +4 (=6) — a duplicate id 2 then id 6.
    const { entries } = decodePropertyBlock(bytes('020a00140407'), 0, { profile: 'd18-delta-vi64' });
    expect(entries).toEqual<PropertyEntry[]>([
      { id: 2n, value: 10n },
      { id: 2n, value: 20n },
      { id: 6n, value: 7n },
    ]);
  });

  it('canonical encode is stable ascending-id, preserving duplicate relative order', () => {
    const unsorted: PropertyEntry[] = [
      { id: 6n, value: 7n },
      { id: 2n, value: 10n },
      { id: 2n, value: 20n },
    ];
    // ids ascend; the two id-2 entries keep their input order (10 before 20).
    // deltas +2,+0,+4 → 02 0a | 00 14 | 04 07.
    expect(hex(encodePropertyBlock(unsorted, 'd18-delta-vi64'))).toBe('020a00140407');
  });
});

describe('property-block — non-minimal decode legality vs minimal encode', () => {
  it('accepts a non-minimal vi64 on read but re-encodes minimally', () => {
    const { entries } = decodePropertyBlock(bytes('028025'), 0, { profile: 'd18-delta-vi64' });
    expect(entries).toEqual([{ id: 2n, value: 37n }]);
    expect(hex(encodePropertyBlock(entries, 'd18-delta-vi64'))).toBe('0225');
  });
});

describe('property-block — full u64 range on d18, rejection on d14/d16', () => {
  it('d18 round-trips 2^64-1', () => {
    const max = (1n << 64n) - 1n;
    const enc = encodePropertyBlock([{ id: 2n, value: max }], 'd18-delta-vi64');
    const { entries } = decodePropertyBlock(enc, 0, { profile: 'd18-delta-vi64' });
    expect(entries[0]!.value).toBe(max);
  });
  it('d16 encoder rejects a value above the QUIC range (2^62), not truncates', () => {
    expect(() => encodePropertyBlock([{ id: 2n, value: 1n << 62n }], 'd16-delta-varint')).toThrow(PropertyWireError);
    try {
      encodePropertyBlock([{ id: 2n, value: 1n << 62n }], 'd16-delta-varint');
    } catch (e) {
      expect((e as PropertyWireError).category).toBe('value-out-of-range');
    }
  });
});

describe('property-block — parity, odd-value length, delta overflow', () => {
  const p: PropertyWireProfile = 'd18-delta-vi64';

  it('even id requires an integer, odd id requires bytes', () => {
    expect(() => encodePropertyBlock([{ id: 2n, value: new Uint8Array(1) }], p)).toThrow(/varint value/);
    expect(() => encodePropertyBlock([{ id: 3n, value: 5n }], p)).toThrow(/bytes value/);
  });

  it('odd-value length is capped at 2^16-1 (65535 ok, 65536 rejected)', () => {
    const ok = encodePropertyBlock([{ id: 3n, value: new Uint8Array(65535) }], p);
    expect(propertyBlockEncodingLength([{ id: 3n, value: new Uint8Array(65535) }], p)).toBe(ok.length);
    expect(() => encodePropertyBlock([{ id: 3n, value: new Uint8Array(65536) }], p)).toThrow(/exceeds maximum/);
  });

  it('decode rejects an odd-value length that overruns the block', () => {
    // id 3 (odd), declared length 10, only 2 value bytes present.
    expect(() => decodePropertyBlock(bytes('030a0102'), 0, { profile: p })).toThrow(PropertyWireError);
  });

  it('decode rejects a delta that overflows 2^64-1', () => {
    // First entry id = 2^64-2 (even), value 0; then delta +2 → 2^64 overflows.
    const first = encodePropertyBlock([{ id: (1n << 64n) - 2n, value: 0n }], p);
    const overflow = new Uint8Array([...first, 0x02, 0x00]); // delta 2, value 0
    expect(() => decodePropertyBlock(overflow, 0, { profile: p })).toThrow(/2\^64-1/);
  });

  it('a truncated integer is a plain RangeError (not a categorised PropertyWireError)', () => {
    // 8-byte QUIC length flag but no following bytes.
    expect(() => decodePropertyBlock(bytes('02c0'), 0, { profile: 'd16-delta-varint' })).toThrow(RangeError);
  });
});

describe('property-block — `end` bounds every integer read, not just odd-value bytes', () => {
  // id 2 (0x02) then a 2-byte vi64 value 128 (0x8080): the full block is 3 bytes.
  const block = bytes('028080');

  it('an even value that would cross `end` is truncated, not read from beyond', () => {
    // end=2 cuts the 2-byte value after one byte → truncated (must NOT read buf[2]).
    expect(() => decodePropertyBlock(block, 0, { profile: 'd18-delta-vi64', end: 2 })).toThrow(RangeError);
  });

  it('an id/value read with no room before `end` is truncated', () => {
    // end=1: the id is read, then the value read starts at end → truncated.
    expect(() => decodePropertyBlock(block, 0, { profile: 'd18-delta-vi64', end: 1 })).toThrow(RangeError);
  });

  it('a full decode within `end` still succeeds and reports the true bytesRead', () => {
    const { entries, bytesRead } = decodePropertyBlock(block, 0, { profile: 'd18-delta-vi64', end: 3 });
    expect(entries).toEqual([{ id: 2n, value: 128n }]);
    expect(bytesRead).toBe(3);
  });
});

describe('property-block — decode rejects invalid framing before trusting it', () => {
  const p = 'd18-delta-vi64' as const;

  it('an `end` past the buffer is rejected, not silently truncated', () => {
    // Odd id 1, declared value length 5, but the buffer is truncated to 2 bytes
    // of value. With end:7 the old code returned a 2-byte value and bytesRead:7.
    const truncated = bytes('01050102'); // [id 1, len 5, 0x01, 0x02] — 4 bytes
    expect(() => decodePropertyBlock(truncated, 0, { profile: p, end: 7 })).toThrow(RangeError);
  });

  it('offset > end, negative end, and negative count are rejected (not empty success)', () => {
    const buf = bytes('0205');
    expect(() => decodePropertyBlock(buf, 2, { profile: p, end: 1 })).toThrow(RangeError); // offset > end
    expect(() => decodePropertyBlock(buf, 0, { profile: p, end: -1 })).toThrow(RangeError);
    expect(() => decodePropertyBlock(buf, 0, { profile: p, count: -1 })).toThrow(RangeError);
  });

  it('exact bounds (offset == end == buffer length) decode as an empty block', () => {
    const buf = bytes('0205');
    const { entries, bytesRead } = decodePropertyBlock(buf, 2, { profile: p, end: 2 });
    expect(entries).toEqual([]);
    expect(bytesRead).toBe(0);
  });
});

describe('property-block — encode range failures are categorised, not bare RangeError', () => {
  it('a d16/d14 id at 2^62 (above the QUIC range) is value-out-of-range, not truncated', () => {
    for (const profile of ['d16-delta-varint', 'd14-absolute-varint'] as const) {
      try {
        encodePropertyBlock([{ id: 1n << 62n, value: 0n }], profile);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(PropertyWireError);
        expect((e as PropertyWireError).category).toBe('value-out-of-range');
      }
    }
  });

  it('a negative even value is value-out-of-range, not a bare RangeError', () => {
    try {
      encodePropertyBlock([{ id: 2n, value: -5n }], 'd18-delta-vi64');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PropertyWireError);
      expect((e as PropertyWireError).category).toBe('value-out-of-range');
    }
  });
});
