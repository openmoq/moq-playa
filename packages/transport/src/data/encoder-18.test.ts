/**
 * draft-18 data encoders round-trip through the draft-18 decoders, proving the
 * publisher send path produces bytes the subscriber receive path accepts.
 */
import { describe, it, expect } from 'vitest';
import { encodeSubgroupHeader18, encodeSubgroupObject18, encodeObjectDatagram18 } from './encoder-18.js';
import { decodeSubgroupHeader18, decodeSubgroupObject18, decodeObjectDatagram18 } from './decoder-18.js';
import { encodeSubgroupHeader } from './encoder.js';
import { MAX_VI64 } from '../primitives/vi64.js';
import type { SubgroupHeader, SubgroupObject, ObjectDatagram } from './types.js';

describe('encodeSubgroupHeader18 ↔ decodeSubgroupHeader18', () => {
  it('round-trips an explicit-subgroup header with priority', () => {
    const header: SubgroupHeader = {
      typeByte: 0x14, // mode 0b10 (explicit), no flags
      trackAlias: 7n, groupId: 42n, subgroupId: 3n,
      publisherPriority: 5, hasExtensions: false, isEndOfGroup: false,
    };
    const { header: decoded, bytesRead } = decodeSubgroupHeader18(encodeSubgroupHeader18(header), 0);
    expect(decoded.trackAlias).toBe(7n);
    expect(decoded.groupId).toBe(42n);
    expect(decoded.subgroupId).toBe(3n);
    expect(decoded.publisherPriority).toBe(5);
    expect(bytesRead).toBe(encodeSubgroupHeader18(header).length);
  });

  it('round-trips a full-uint64 track alias / group above the QUIC range', () => {
    const big = 1n << 63n;
    const header: SubgroupHeader = {
      typeByte: 0x14, trackAlias: big, groupId: big + 1n, subgroupId: big + 2n,
      publisherPriority: 0, hasExtensions: false, isEndOfGroup: false,
    };
    const { header: decoded } = decodeSubgroupHeader18(encodeSubgroupHeader18(header), 0);
    expect(decoded.trackAlias).toBe(big);
    expect(decoded.groupId).toBe(big + 1n);
    expect(decoded.subgroupId).toBe(big + 2n);
    void MAX_VI64;
  });

  it('the draft-14/16 encoder REJECTS a track alias above the QUIC-varint range', () => {
    const header: SubgroupHeader = {
      typeByte: 0x14, trackAlias: 1n << 63n, groupId: 0n, subgroupId: 0n,
      publisherPriority: 0, hasExtensions: false, isEndOfGroup: false,
    };
    expect(() => encodeSubgroupHeader(header)).toThrow(RangeError);
  });
});

describe('encodeSubgroupObject18 ↔ decodeSubgroupObject18', () => {
  it('round-trips a first object with payload', () => {
    const bytes = encodeSubgroupObject18(
      { objectId: 5n, extensions: undefined, payload: new Uint8Array([0xaa, 0xbb]), status: undefined },
      false, 0n, true,
    );
    const { object } = decodeSubgroupObject18(bytes, 0, false, 0n, true);
    expect(object.objectId).toBe(5n);
    expect(object.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it('round-trips a subsequent object via delta', () => {
    const bytes = encodeSubgroupObject18(
      { objectId: 8n, extensions: undefined, payload: new Uint8Array([0x01]), status: undefined },
      false, 5n, false,
    );
    const { object } = decodeSubgroupObject18(bytes, 0, false, 5n, false);
    expect(object.objectId).toBe(8n); // 5 + delta(2) + 1
  });
});

describe('encodeObjectDatagram18 ↔ decodeObjectDatagram18', () => {
  it('round-trips a plain object datagram', () => {
    const bytes = encodeObjectDatagram18({
      typeByte: 0x00, trackAlias: 7n, groupId: 42n, objectId: 3n,
      publisherPriority: 4, isEndOfGroup: false, extensions: undefined,
      payload: new Uint8Array([0x09, 0x08]), status: undefined,
    });
    const { datagram } = decodeObjectDatagram18(bytes, 0);
    expect(datagram.trackAlias).toBe(7n);
    expect(datagram.groupId).toBe(42n);
    expect(datagram.objectId).toBe(3n);
    expect(datagram.publisherPriority).toBe(4);
    expect(datagram.payload).toEqual(new Uint8Array([0x09, 0x08]));
  });
});

import { encodeFetchHeader18, encodeFetchObject18, encodeFetchEndOfRange18 } from './encoder-18.js';
import { decodeFetchHeader18, decodeFetchObject18, type FetchObjectPrior18 } from './decoder-18.js';
import type { FetchObject, FetchEndOfRange } from './types.js';

describe('encodeFetchHeader18 ↔ decodeFetchHeader18', () => {
  it('round-trips a Request ID above the QUIC range', () => {
    const big = 1n << 63n;
    const { header, bytesRead } = decodeFetchHeader18(encodeFetchHeader18(big), 0);
    expect(header.requestId).toBe(big);
    expect(bytesRead).toBe(encodeFetchHeader18(big).length);
  });
});

describe('encodeFetchObject18 ↔ decodeFetchObject18', () => {
  it('first object carries absolute group/object + priority and decodes as the first object', () => {
    const { bytes, nextPrior } = encodeFetchObject18(
      { groupId: 10n, subgroupId: 2n, objectId: 5n, publisherPriority: 7, payload: new Uint8Array([0xaa]) },
      undefined, true, 'ascending',
    );
    const { item: object } = decodeFetchObject18(bytes, 0, undefined, true, 'ascending');
    const o = object as FetchObject;
    expect(o.groupId).toBe(10n);
    expect(o.subgroupId).toBe(2n);
    expect(o.objectId).toBe(5n);
    expect(o.publisherPriority).toBe(7);
    expect(o.payload).toEqual(new Uint8Array([0xaa]));
    expect(nextPrior).toEqual({ groupId: 10n, objectId: 5n, lastObjectSubgroupId: 2n, lastObjectPriority: 7 });
  });

  it('subsequent object in the same group uses an Object ID delta', () => {
    const prior: FetchObjectPrior18 = { groupId: 10n, objectId: 5n, lastObjectSubgroupId: 2n, lastObjectPriority: 7 };
    const { bytes } = encodeFetchObject18(
      { groupId: 10n, subgroupId: 2n, objectId: 9n, publisherPriority: 7, payload: new Uint8Array([0x01]) },
      prior, false, 'ascending',
    );
    const { item: object } = decodeFetchObject18(bytes, 0, prior, false, 'ascending');
    expect((object as FetchObject).groupId).toBe(10n);
    expect((object as FetchObject).objectId).toBe(9n);
  });

  it('new group in ASCENDING order round-trips', () => {
    const prior: FetchObjectPrior18 = { groupId: 10n, objectId: 9n, lastObjectSubgroupId: 2n, lastObjectPriority: 7 };
    const { bytes } = encodeFetchObject18(
      { groupId: 13n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: new Uint8Array([0x02]) },
      prior, false, 'ascending',
    );
    const { item: object } = decodeFetchObject18(bytes, 0, prior, false, 'ascending');
    expect((object as FetchObject).groupId).toBe(13n);
    expect((object as FetchObject).objectId).toBe(0n);
  });

  it('new group in DESCENDING order round-trips', () => {
    const prior: FetchObjectPrior18 = { groupId: 13n, objectId: 0n, lastObjectSubgroupId: 0n, lastObjectPriority: 7 };
    const { bytes } = encodeFetchObject18(
      { groupId: 10n, subgroupId: 0n, objectId: 4n, publisherPriority: 7, payload: new Uint8Array([0x03]) },
      prior, false, 'descending',
    );
    const { item: object } = decodeFetchObject18(bytes, 0, prior, false, 'descending');
    expect((object as FetchObject).groupId).toBe(10n);
    expect((object as FetchObject).objectId).toBe(4n);
  });

  it('an empty-payload fetch object round-trips with no stray status byte', () => {
    // Regression: the encoder previously wrote an extra Normal-status vi64 for an
    // empty payload that the decoder never consumed, misaligning the next object.
    // A normal fetch object is just Payload Length (= 0) with no trailing status;
    // fetch status/end markers are End-of-Range (0x8C / 0x10C), not zero-length
    // objects (FetchObject has no status field).
    const { bytes } = encodeFetchObject18(
      { groupId: 5n, subgroupId: 2n, objectId: 7n, publisherPriority: 3, payload: new Uint8Array(0) },
      undefined, true, 'ascending',
    );
    const { item, bytesRead } = decodeFetchObject18(bytes, 0, undefined, true, 'ascending');
    expect(bytesRead).toBe(bytes.length); // decode consumes exactly what was written
    const o = item as FetchObject;
    expect(o.groupId).toBe(5n);
    expect(o.subgroupId).toBe(2n);
    expect(o.objectId).toBe(7n);
    expect(o.publisherPriority).toBe(3);
    expect(o.payload).toEqual(new Uint8Array(0));
  });

  it('two empty-payload fetch objects in a stream stay aligned', () => {
    const r1 = encodeFetchObject18(
      { groupId: 5n, subgroupId: 2n, objectId: 7n, publisherPriority: 3, payload: new Uint8Array(0) },
      undefined, true, 'ascending',
    );
    const r2 = encodeFetchObject18(
      { groupId: 5n, subgroupId: 2n, objectId: 9n, publisherPriority: 3, payload: new Uint8Array(0) },
      r1.nextPrior, false, 'ascending',
    );
    const buf = new Uint8Array(r1.bytes.length + r2.bytes.length);
    buf.set(r1.bytes, 0);
    buf.set(r2.bytes, r1.bytes.length);
    const d1 = decodeFetchObject18(buf, 0, undefined, true, 'ascending');
    const d2 = decodeFetchObject18(buf, d1.bytesRead, d1.nextPrior, false, 'ascending');
    expect(d1.bytesRead + d2.bytesRead).toBe(buf.length);
    expect((d2.item as FetchObject).objectId).toBe(9n);
  });

  it('End-of-Range marker round-trips and threads prior from the marker', () => {
    const prior: FetchObjectPrior18 = { groupId: 10n, objectId: 5n, lastObjectSubgroupId: 2n, lastObjectPriority: 7 };
    const { bytes, nextPrior } = encodeFetchEndOfRange18(true, 11n, 0n, prior);
    const { item } = decodeFetchObject18(bytes, 0, prior, false, 'ascending');
    const m = item as FetchEndOfRange;
    expect(m.nonExistent).toBe(true);
    expect(m.groupId).toBe(11n);
    expect(m.objectId).toBe(0n);
    // position from marker; field priors unchanged (last actual object).
    expect(nextPrior.groupId).toBe(11n);
    expect(nextPrior.lastObjectSubgroupId).toBe(2n);
    expect(nextPrior.lastObjectPriority).toBe(7);
  });
});

describe('exported encoder guards — reject contradictory direct inputs', () => {
  const baseDatagram = (over: Partial<ObjectDatagram> = {}): ObjectDatagram => ({
    typeByte: 0x00, // PROPERTIES/STATUS/ZERO/DEFAULT_PRIORITY all clear
    trackAlias: 7n, groupId: 42n, objectId: 3n,
    publisherPriority: 4, isEndOfGroup: false,
    extensions: undefined, payload: new Uint8Array([0x01]), status: undefined,
    ...over,
  });
  const baseHeader = (over: Partial<SubgroupHeader> = {}): SubgroupHeader => ({
    typeByte: 0x14, // mode 0b10 (explicit), no flags
    trackAlias: 1n, groupId: 2n, subgroupId: 3n,
    publisherPriority: 5, hasExtensions: false, isEndOfGroup: false,
    ...over,
  });

  // ── encodeObjectDatagram18 ──
  it('datagram: STATUS flag (0x20) with a non-empty payload throws', () => {
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x20, payload: new Uint8Array([0x01]), status: 3n })))
      .toThrow(/empty payload/i);
  });

  it('datagram: status provided WITHOUT the STATUS flag throws', () => {
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x00, status: 5n, payload: new Uint8Array(0) })))
      .toThrow(/STATUS/);
  });

  it('datagram: ZERO_OBJECT_ID (0x04) with a non-zero objectId throws', () => {
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x04, objectId: 5n })))
      .toThrow(/ZERO_OBJECT_ID|objectId/i);
  });

  it('datagram: ZERO_OBJECT_ID with objectId === 0n is accepted', () => {
    const bytes = encodeObjectDatagram18(baseDatagram({ typeByte: 0x04, objectId: 0n }));
    const { datagram } = decodeObjectDatagram18(bytes);
    expect(datagram.objectId).toBe(0n);
  });

  it('datagram: DEFAULT_PRIORITY (0x08) flag with a publisherPriority supplied throws', () => {
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x08, publisherPriority: 4 })))
      .toThrow(/DEFAULT_PRIORITY/i);
  });

  it('datagram: DEFAULT_PRIORITY flag absent but publisherPriority undefined throws (XOR)', () => {
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x00, publisherPriority: undefined })))
      .toThrow(/DEFAULT_PRIORITY/i);
  });

  it('datagram: PROPERTIES flag absent but extensions supplied throws', () => {
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x00, extensions: new Uint8Array([0xaa]) })))
      .toThrow(/PROPERTIES/i);
  });

  it('datagram: PROPERTIES flag present with empty/undefined extensions throws (decoder rejects an empty block)', () => {
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x01, extensions: new Uint8Array(0) })))
      .toThrow(/PROPERTIES/i);
    expect(() => encodeObjectDatagram18(baseDatagram({ typeByte: 0x01, extensions: undefined })))
      .toThrow(/PROPERTIES/i);
  });

  it('datagram: PROPERTIES flag present with non-empty extensions round-trips', () => {
    const bytes = encodeObjectDatagram18(baseDatagram({ typeByte: 0x01, extensions: new Uint8Array([0xaa, 0xbb]) }));
    const { datagram } = decodeObjectDatagram18(bytes, 0);
    expect(datagram.extensions).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  // ── encodeSubgroupHeader18 ──
  it('subgroup header: non-explicit subgroup-ID mode with a meaningful subgroupId throws', () => {
    // typeByte 0x10 → mode 0b00 (no explicit Subgroup ID field on the wire)
    expect(() => encodeSubgroupHeader18(baseHeader({ typeByte: 0x10, subgroupId: 5n })))
      .toThrow(/subgroupId/i);
  });

  it('subgroup header: non-explicit mode with subgroupId 0n is accepted', () => {
    expect(() => encodeSubgroupHeader18(baseHeader({ typeByte: 0x10, subgroupId: 0n }))).not.toThrow();
  });

  it('subgroup header: DEFAULT_PRIORITY (0x20) flag with a publisherPriority supplied throws', () => {
    expect(() => encodeSubgroupHeader18(baseHeader({ typeByte: 0x34, publisherPriority: 5 })))
      .toThrow(/DEFAULT_PRIORITY/i);
  });

  it('subgroup header: DEFAULT_PRIORITY flag absent but publisherPriority undefined throws (XOR)', () => {
    expect(() => encodeSubgroupHeader18(baseHeader({ typeByte: 0x14, publisherPriority: undefined })))
      .toThrow(/DEFAULT_PRIORITY/i);
  });

  // ── encodeSubgroupObject18 ──
  it('subgroup object: extensions supplied while hasProperties=false throws', () => {
    expect(() => encodeSubgroupObject18(
      { objectId: 1n, extensions: new Uint8Array([0xaa]), payload: new Uint8Array([0x01]), status: undefined },
      false, 0n, true,
    )).toThrow(/PROPERTIES/i);
  });

  it('subgroup object: status with a non-empty payload still throws', () => {
    expect(() => encodeSubgroupObject18(
      { objectId: 1n, extensions: undefined, payload: new Uint8Array([0x01]), status: 3n },
      false, 0n, true,
    )).toThrow(/empty payload/i);
  });

  it('subgroup object: hasProperties=true with empty/undefined extensions encodes length 0 (unlike a datagram, this is legal and round-trips)', () => {
    const bytes = encodeSubgroupObject18(
      { objectId: 1n, extensions: undefined, payload: new Uint8Array([0x01]), status: undefined },
      true, 0n, true,
    );
    const { object } = decodeSubgroupObject18(bytes, 0, true, 0n, true);
    expect(object.objectId).toBe(1n);
    expect(object.extensions).toBeUndefined(); // empty Properties block → undefined
  });
});
