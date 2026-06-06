/**
 * draft-18 Track Properties codec — KVP-with-vi64, self-describing by Type parity
 * (even → varint value, odd → length-prefixed bytes), no registry, full uint64.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeTrackProperties18,
  decodeTrackProperties18,
  trackProperties18EncodingLength,
  hasObjectOnlyTrackProperty,
  hasUnsupportedMandatoryTrackProperty,
} from './track-properties-18.js';
import { writeVi64 } from '../primitives/vi64.js';
import type { TrackExtensions } from './messages.js';

/** Build a Track Properties byte block from [type, varintValue] pairs (vi64). */
function bytesOf(...pairs: Array<[bigint, bigint]>): Uint8Array {
  const buf = new Uint8Array(64);
  let n = 0;
  let prev = 0n;
  for (const [type, value] of pairs) {
    n += writeVi64(type - prev, buf, n);
    n += writeVi64(value, buf, n);
    prev = type;
  }
  return buf.subarray(0, n);
}

const props = (m: Map<bigint, (bigint | Uint8Array)[]>): TrackExtensions => m as unknown as TrackExtensions;
const toPlain = (p: TrackExtensions): Map<bigint, (bigint | Uint8Array)[]> =>
  p as unknown as Map<bigint, (bigint | Uint8Array)[]>;

describe('encodeTrackProperties18 ↔ decodeTrackProperties18', () => {
  it('an empty block encodes to zero bytes and round-trips empty', () => {
    const empty = props(new Map());
    const bytes = encodeTrackProperties18(empty);
    expect(bytes.length).toBe(0);
    expect(trackProperties18EncodingLength(empty)).toBe(0);
    const { properties, bytesRead } = decodeTrackProperties18(bytes, 0);
    expect(properties.size).toBe(0);
    expect(bytesRead).toBe(0);
  });

  it('round-trips one even (varint) property', () => {
    const p = props(new Map([[0x02n, [5n]]]));
    const bytes = encodeTrackProperties18(p);
    const { properties } = decodeTrackProperties18(bytes, 0);
    expect(toPlain(properties).get(0x02n)).toEqual([5n]);
  });

  it('round-trips one odd (bytes) property', () => {
    const p = props(new Map([[0x03n, [new Uint8Array([0xaa, 0xbb])]]]));
    const bytes = encodeTrackProperties18(p);
    const { properties } = decodeTrackProperties18(bytes, 0);
    expect(toPlain(properties).get(0x03n)).toEqual([new Uint8Array([0xaa, 0xbb])]);
  });

  it('multiple ascending properties produce exact Type-Delta bytes and round-trip', () => {
    const p = props(new Map<bigint, (bigint | Uint8Array)[]>([
      [0x02n, [5n]],                       // even → varint
      [0x03n, [new Uint8Array([0xaa])]],   // odd  → length + bytes
      [0x08n, [7n]],                       // even → varint
    ]));
    const bytes = encodeTrackProperties18(p);
    // delta 0x02, val 0x05 | delta 0x01, len 0x01, 0xaa | delta 0x05, val 0x07
    expect([...bytes]).toEqual([0x02, 0x05, 0x01, 0x01, 0xaa, 0x05, 0x07]);
    expect(trackProperties18EncodingLength(p)).toBe(bytes.length);

    const { properties, bytesRead } = decodeTrackProperties18(bytes, 0);
    expect(bytesRead).toBe(bytes.length);
    expect(toPlain(properties).get(0x02n)).toEqual([5n]);
    expect(toPlain(properties).get(0x03n)).toEqual([new Uint8Array([0xaa])]);
    expect(toPlain(properties).get(0x08n)).toEqual([7n]);
  });

  it('preserves duplicate values under one Type (delta 0), in order', () => {
    const p = props(new Map([[0x02n, [5n, 9n]]]));
    const bytes = encodeTrackProperties18(p);
    // delta 0x02 val 0x05 | delta 0x00 val 0x09
    expect([...bytes]).toEqual([0x02, 0x05, 0x00, 0x09]);
    const { properties } = decodeTrackProperties18(bytes, 0);
    expect(toPlain(properties).get(0x02n)).toEqual([5n, 9n]);
  });

  it('decodes an UNKNOWN Type without a registry (self-describing by parity), preserved', () => {
    // 0x100 even → varint; 0x101 odd → bytes. Neither is in any registry.
    const p = props(new Map<bigint, (bigint | Uint8Array)[]>([
      [0x100n, [42n]],
      [0x101n, [new Uint8Array([0x01, 0x02])]],
    ]));
    const { properties } = decodeTrackProperties18(encodeTrackProperties18(p), 0);
    expect(toPlain(properties).get(0x100n)).toEqual([42n]);
    expect(toPlain(properties).get(0x101n)).toEqual([new Uint8Array([0x01, 0x02])]);
  });

  it('round-trips a full-uint64 value on an even (vi64) property — above the QUIC range', () => {
    const big = 1n << 63n;
    const p = props(new Map([[0x02n, [big]]]));
    const { properties } = decodeTrackProperties18(encodeTrackProperties18(p), 0);
    expect(toPlain(properties).get(0x02n)).toEqual([big]);
  });

  it('rejects a value whose kind does not match the Type parity', () => {
    // even Type with a bytes value, and odd Type with a varint value.
    expect(() => encodeTrackProperties18(props(new Map([[0x02n, [new Uint8Array([1])]]])))).toThrow(/varint value/i);
    expect(() => encodeTrackProperties18(props(new Map([[0x03n, [5n]]])))).toThrow(/bytes value/i);
  });

  it('rejects an odd-Type byte value longer than 2^16-1 on encode', () => {
    const p = props(new Map([[0x03n, [new Uint8Array(0x10000)]]]));
    expect(() => encodeTrackProperties18(p)).toThrow(/exceeds maximum/i);
  });
});

describe('Track Properties — known-property semantics (§2.5)', () => {
  it('round-trips valid known Track Properties (priority 128, group order 2, dynamic groups 1)', () => {
    const p = props(new Map<bigint, (bigint | Uint8Array)[]>([
      [0x0en, [128n]], [0x22n, [2n]], [0x30n, [1n]],
    ]));
    const { properties } = decodeTrackProperties18(encodeTrackProperties18(p), 0);
    expect(toPlain(properties).get(0x0en)).toEqual([128n]);
    expect(toPlain(properties).get(0x22n)).toEqual([2n]);
    expect(toPlain(properties).get(0x30n)).toEqual([1n]);
  });

  it('rejects DEFAULT_PUBLISHER_PRIORITY (0x0E) > 255 on encode and decode', () => {
    expect(() => encodeTrackProperties18(props(new Map([[0x0en, [256n]]])))).toThrow(/0\.\.255/);
    expect(() => decodeTrackProperties18(bytesOf([0x0en, 256n]), 0)).toThrow(/0\.\.255/);
  });

  it('rejects DEFAULT_PUBLISHER_GROUP_ORDER (0x22) outside {1,2}', () => {
    expect(() => encodeTrackProperties18(props(new Map([[0x22n, [0n]]])))).toThrow(/1 or 2/);
    expect(() => encodeTrackProperties18(props(new Map([[0x22n, [3n]]])))).toThrow(/1 or 2/);
    expect(() => decodeTrackProperties18(bytesOf([0x22n, 3n]), 0)).toThrow(/1 or 2/);
  });

  it('rejects DYNAMIC_GROUPS (0x30) outside {0,1}', () => {
    expect(() => encodeTrackProperties18(props(new Map([[0x30n, [2n]]])))).toThrow(/0 or 1/);
    expect(() => decodeTrackProperties18(bytesOf([0x30n, 2n]), 0)).toThrow(/0 or 1/);
  });

  it('parses Object-only Properties (0x3C / 0x3E) normally — wrong scope is a SEMANTIC concern, not a codec error', () => {
    // The KVP/value shape is valid; the codec must NOT reject them. Detection of
    // the malformed-track condition is exposed via hasObjectOnlyTrackProperty.
    const p = props(new Map<bigint, (bigint | Uint8Array)[]>([[0x3cn, [1n]], [0x3en, [2n]]]));
    const bytes = encodeTrackProperties18(p);
    const { properties } = decodeTrackProperties18(bytes, 0);
    expect(toPlain(properties).get(0x3cn)).toEqual([1n]);
    expect(toPlain(properties).get(0x3en)).toEqual([2n]);
    expect(hasObjectOnlyTrackProperty(properties)).toBe(true);
    // and decoding hand-built bytes does not throw either
    expect(() => decodeTrackProperties18(bytesOf([0x3cn, 0n]), 0)).not.toThrow();
  });

  it('hasObjectOnlyTrackProperty is false for a block with only known/unknown Track Properties', () => {
    expect(hasObjectOnlyTrackProperty(props(new Map([[0x0en, [128n]]])))).toBe(false);
    expect(hasObjectOnlyTrackProperty(props(new Map([[0x100n, [1n]]])))).toBe(false);
  });

  it('still preserves UNKNOWN properties (no semantic constraint)', () => {
    const p = props(new Map([[0x100n, [999n]]]));
    const { properties } = decodeTrackProperties18(encodeTrackProperties18(p), 0);
    expect(toPlain(properties).get(0x100n)).toEqual([999n]);
  });
});

describe('Track Properties — unsupported Mandatory Track Property detector (§2.5.1)', () => {
  it('detects a Mandatory Track Property (0x4000..0x7FFF) and not other ranges', () => {
    expect(hasUnsupportedMandatoryTrackProperty(props(new Map([[0x4000n, [1n]]])))).toBe(true);
    expect(hasUnsupportedMandatoryTrackProperty(props(new Map([[0x7fffn, [1n]]])))).toBe(true);
    expect(hasUnsupportedMandatoryTrackProperty(props(new Map([[0x3fffn, [1n]]])))).toBe(false); // just below
    expect(hasUnsupportedMandatoryTrackProperty(props(new Map([[0x8000n, [1n]]])))).toBe(false); // just above
    expect(hasUnsupportedMandatoryTrackProperty(props(new Map([[0x0en, [1n]]])))).toBe(false);  // known optional
  });
  it('decodes a Mandatory Track Property normally (rejection is semantic, not codec)', () => {
    const { properties } = decodeTrackProperties18(encodeTrackProperties18(props(new Map([[0x4000n, [9n]]]))), 0);
    expect(toPlain(properties).get(0x4000n)).toEqual([9n]); // parsed/preserved by the codec
    expect(hasUnsupportedMandatoryTrackProperty(properties)).toBe(true);
  });
});
