/**
 * DataCodec — verifies the per-version data-plane wrapper produces byte-for-byte
 * identical results to calling the underlying free functions with an explicit
 * version, and that it dispatches the draft-14 vs draft-16 fetch-object variants.
 */
import { describe, it, expect } from 'vitest';
import { createDataCodec } from './data-codec.js';
import {
  decodeSubgroupHeader,
  decodeSubgroupObject,
  decodeObjectDatagram,
  decodeFetchHeader,
  decodeFetchObject,
  decodeFetchObjectV14,
} from './decoder.js';
import {
  encodeSubgroupHeader,
  encodeSubgroupObject,
  encodeObjectDatagram,
  encodeFetchHeader,
} from './encoder.js';
import { writeVarint, varint, type Varint } from '../primitives/varint.js';
import { writeVi64 } from '../primitives/vi64.js';
import { PADDING_DATAGRAM_TYPE } from './codes-18.js';
import type { SubgroupHeader, ObjectDatagram } from './types.js';

const v = (n: number): Varint => varint(n);

describe('createDataCodec', () => {
  it('exposes its version', () => {
    expect(createDataCodec(16).version).toBe(16);
    expect(createDataCodec(14).version).toBe(14);
    expect(createDataCodec().version).toBe(16); // defaults to 16
  });

  it('exposes a draft-18 data codec', () => {
    expect(createDataCodec(18).version).toBe(18);
  });

  // ─── Subgroup header parity ───────────────────────────────────────────
  for (const version of [14, 16] as const) {
    it(`decodeSubgroupHeader matches raw fn (v${version})`, () => {
      const header: SubgroupHeader = {
        typeByte: 0x14, // bit4 set, mode present-ish — valid in both 14 & 16
        trackAlias: v(7),
        groupId: v(42),
        subgroupId: v(3),
        publisherPriority: 5,
        hasExtensions: false,
        isEndOfGroup: false,
      };
      const buf = encodeSubgroupHeader(header);
      const codec = createDataCodec(version);
      expect(codec.decodeSubgroupHeader(buf, 0)).toEqual(
        decodeSubgroupHeader(buf, 0, version),
      );
    });
  }

  // ─── Datagram parity ──────────────────────────────────────────────────
  for (const version of [14, 16] as const) {
    it(`decodeObjectDatagram matches raw fn (v${version})`, () => {
      const dg: ObjectDatagram = {
        typeByte: 0x00, // valid datagram type in both versions
        trackAlias: v(1),
        groupId: v(2),
        objectId: v(3),
        publisherPriority: 4,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([9, 8, 7]),
        status: undefined,
      };
      const buf = encodeObjectDatagram(dg);
      const codec = createDataCodec(version);
      expect(codec.decodeObjectDatagram(buf, 0)).toEqual(
        decodeObjectDatagram(buf, 0, version),
      );
    });
  }

  // ─── Subgroup object parity ───────────────────────────────────────────
  it('decodeSubgroupObject matches raw fn (binds version)', () => {
    const buf = encodeSubgroupObject(
      { objectId: v(5), extensions: undefined, payload: new Uint8Array([1, 2]), status: undefined },
      false,
      v(4),
      true,
    );
    const codec = createDataCodec(16);
    expect(codec.decodeSubgroupObject(buf, 0, false, v(4), true)).toEqual(
      decodeSubgroupObject(buf, 0, false, v(4), true, 16),
    );
  });

  // ─── Fetch header parity ──────────────────────────────────────────────
  it('decodeFetchHeader matches raw fn', () => {
    const buf = encodeFetchHeader({ requestId: v(11) });
    expect(createDataCodec(16).decodeFetchHeader(buf, 0)).toEqual(decodeFetchHeader(buf, 0));
  });

  // ─── Fetch object dispatch (the real per-version function swap) ────────
  it('decodeFetchObject routes v16 → decodeFetchObject', () => {
    // Build a draft-16 fetch object buffer: flags=0x00 (subgroup mode 0, no
    // group delta, no obj delta, normal), then payload-length + payload.
    const buf = new Uint8Array(8);
    let p = 0;
    p += writeVarint(v(0x00), buf, p); // flags
    p += writeVarint(v(2), buf, p); // payload length
    buf[p++] = 0xaa;
    buf[p++] = 0xbb;
    const slice = buf.subarray(0, p);
    const prior = { groupId: v(1), subgroupId: v(0), objectId: v(0), publisherPriority: 3 };
    expect(createDataCodec(16).decodeFetchObject(slice, 0, prior, false)).toEqual(
      decodeFetchObject(slice, 0, prior, false),
    );
  });

  it('decodeFetchObject routes v14 → decodeFetchObjectV14', () => {
    // Draft-14 fetch object: Group, Subgroup, Object, Priority(8), ExtLen, PayloadLen, Payload
    const buf = new Uint8Array(16);
    let p = 0;
    p += writeVarint(v(1), buf, p); // group
    p += writeVarint(v(0), buf, p); // subgroup
    p += writeVarint(v(0), buf, p); // object
    buf[p++] = 3; // priority (uint8)
    p += writeVarint(v(0), buf, p); // extensions length 0
    p += writeVarint(v(2), buf, p); // payload length
    buf[p++] = 0xcc;
    buf[p++] = 0xdd;
    const slice = buf.subarray(0, p);
    expect(createDataCodec(14).decodeFetchObject(slice, 0, undefined, true)).toEqual(
      decodeFetchObjectV14(slice, 0),
    );
  });

  // ─── Stream / datagram classification ─────────────────────────────────
  it('classifyStream identifies fetch, subgroup, and unknown', () => {
    const codec = createDataCodec(16);
    expect(codec.classifyStream(new Uint8Array([0x05]), 0)).toBe('fetch');
    expect(codec.classifyStream(new Uint8Array([0x14]), 0)).toBe('subgroup');
    expect(codec.classifyStream(new Uint8Array([0xff]), 0)).toBe('unknown');
  });

  it('classifyDatagram identifies object vs invalid (buffer-based)', () => {
    const codec = createDataCodec(16);
    expect(codec.classifyDatagram(new Uint8Array([0x00]), 0)).toBe('object');
    expect(codec.classifyDatagram(new Uint8Array([0xff]), 0)).toBe('invalid');
  });

  it('draft-18 classifyDatagram identifies object, padding, and invalid', () => {
    const codec = createDataCodec(18);
    expect(codec.classifyDatagram(new Uint8Array([0x00]), 0)).toBe('object');
    // PADDING datagram 0x132B3E29 is a multi-byte vi64; encode it.
    const padding = new Uint8Array(8);
    const wrote = writeVi64(BigInt(PADDING_DATAGRAM_TYPE), padding, 0);
    expect(codec.classifyDatagram(padding.subarray(0, wrote), 0)).toBe('padding');
    // 0x10 is the SUBGROUP_HEADER form, not a datagram.
    expect(codec.classifyDatagram(new Uint8Array([0x10]), 0)).toBe('invalid');
  });
});
