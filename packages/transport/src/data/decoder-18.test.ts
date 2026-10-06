/**
 * Golden-vector tests for the draft-18 data-plane decoders (vi64).
 *
 * Buffers are hand-built byte-by-byte from the spec field layouts so a decoder
 * regression shows up as a wire mismatch, not just a round-trip drift. Covers:
 * FIRST_OBJECT, explicit subgroup ID, full uint64 track alias / object IDs,
 * status objects, Properties present/empty handling, and invalid forms.
 *
 * @see draft-ietf-moq-transport-18 §11.3–§11.4
 */
import { describe, it, expect } from 'vitest';
import {
  decodeSubgroupHeader18,
  decodeSubgroupObject18,
  decodeObjectDatagram18,
  decodeFetchHeader18,
  decodeFetchObject18,
  type FetchObjectPrior18,
} from './decoder-18.js';
import { ProtocolViolationError } from '../errors.js';
import { writeVi64, vi64EncodingLength, MAX_VI64 } from '../primitives/vi64.js';
import { SubgroupFlags18, DatagramFlags18 } from './codes-18.js';
import type { FetchObject, FetchEndOfRange } from './types.js';

/** Build a buffer from vi64 fields and raw byte spans. */
function pack(...parts: Array<bigint | { u8: number } | { raw: number[] }>): Uint8Array {
  let len = 0;
  for (const p of parts) {
    if (typeof p === 'bigint') len += vi64EncodingLength(p);
    else if ('u8' in p) len += 1;
    else len += p.raw.length;
  }
  const buf = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) {
    if (typeof p === 'bigint') pos += writeVi64(p, buf, pos);
    else if ('u8' in p) buf[pos++] = p.u8;
    else { buf.set(p.raw, pos); pos += p.raw.length; }
  }
  return buf;
}
const u8 = (n: number) => ({ u8: n });
const raw = (...b: number[]) => ({ raw: b });

describe('decodeFetchObject18 — robustness', () => {
  it('rejects a non-first object with no prior context (ProtocolViolationError, not a crash)', () => {
    // Found by parser-crash fuzz: isFirstObject=false + prior=undefined previously
    // threw `TypeError: Cannot read properties of undefined (reading 'groupId')`.
    expect(() => decodeFetchObject18(Uint8Array.from([0x02]), 0, undefined, false, 'ascending'))
      .toThrow(ProtocolViolationError);
  });
});

describe('decodeSubgroupHeader18', () => {
  it('decodes a plain explicit-subgroup header (mode 0b10)', () => {
    // type 0x14 = bit4 set, mode 0b10 (explicit), no flags
    const buf = pack(0x14n, 7n /*alias*/, 42n /*group*/, 3n /*subgroup*/, u8(5) /*prio*/);
    const { header, bytesRead } = decodeSubgroupHeader18(buf, 0);
    expect(header).toEqual({
      typeByte: 0x14,
      trackAlias: 7n,
      groupId: 42n,
      subgroupId: 3n,
      publisherPriority: 5,
      hasExtensions: false,
      isEndOfGroup: false,
      isFirstObjectInSubgroup: false,
    });
    expect(bytesRead).toBe(buf.length);
  });

  it('sets isFirstObjectInSubgroup when the FIRST_OBJECT bit (0x40) is present', () => {
    // 0x40 | 0x14 = 0x54 → still mode 0b10 (explicit subgroup id). The 0x40 bit
    // is the FIRST_OBJECT header flag, NOT subgroup-id mode 0b01.
    const type = 0x40 | 0x14;
    const buf = pack(BigInt(type), 1n, 2n, 9n, u8(0));
    const { header } = decodeSubgroupHeader18(buf, 0);
    expect(header.isFirstObjectInSubgroup).toBe(true);
    expect(header.subgroupId).toBe(9n);
  });

  it('subgroup ID is 0 for mode 0b00 and omits the explicit field', () => {
    // type 0x10 = bit4 set, mode 0b00 (zero)
    const buf = pack(0x10n, 1n, 2n, u8(7));
    const { header, bytesRead } = decodeSubgroupHeader18(buf, 0);
    expect(header.subgroupId).toBe(0n);
    expect(header.publisherPriority).toBe(7);
    expect(bytesRead).toBe(buf.length);
  });

  it('omits publisher priority when DEFAULT_PRIORITY (0x20) is set', () => {
    const type = 0x10 | SubgroupFlags18.DEFAULT_PRIORITY; // 0x30
    const buf = pack(BigInt(type), 1n, 2n);
    const { header, bytesRead } = decodeSubgroupHeader18(buf, 0);
    expect(header.publisherPriority).toBeUndefined();
    expect(bytesRead).toBe(buf.length);
  });

  it('carries a full uint64 track alias', () => {
    const buf = pack(0x10n, MAX_VI64, 0n, u8(0));
    const { header } = decodeSubgroupHeader18(buf, 0);
    expect(header.trackAlias).toBe(MAX_VI64);
  });

  it('reports hasExtensions / isEndOfGroup flags', () => {
    const type = 0x10 | SubgroupFlags18.PROPERTIES | SubgroupFlags18.END_OF_GROUP; // 0x19
    const buf = pack(BigInt(type), 1n, 2n, u8(3));
    const { header } = decodeSubgroupHeader18(buf, 0);
    expect(header.hasExtensions).toBe(true);
    expect(header.isEndOfGroup).toBe(true);
  });

  it('rejects a non-subgroup form', () => {
    expect(() => decodeSubgroupHeader18(pack(0x00n), 0)).toThrow(/Invalid SUBGROUP_HEADER/);
  });

  it('rejects the reserved subgroup-ID mode 0b11', () => {
    const type = 0x10 | SubgroupFlags18.SUBGROUP_ID_MODE_MASK; // 0x16 → mode 0b11
    expect(() => decodeSubgroupHeader18(pack(BigInt(type), 1n, 2n, u8(0)), 0)).toThrow(/reserved/);
  });
});

describe('decodeSubgroupObject18', () => {
  it('decodes a first object (absolute ID) with payload', () => {
    const buf = pack(5n /*objId*/, 2n /*payloadLen*/, raw(0xaa, 0xbb));
    const { object, bytesRead } = decodeSubgroupObject18(buf, 0, false, 0n, true);
    expect(object.objectId).toBe(5n);
    expect(object.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(object.status).toBeUndefined();
    expect(object.extensions).toBeUndefined();
    expect(bytesRead).toBe(buf.length);
  });

  it('computes a subsequent object ID as prev + delta + 1', () => {
    // delta=2, prev=5 → 5 + 2 + 1 = 8
    const buf = pack(2n, 1n, raw(0x01));
    const { object } = decodeSubgroupObject18(buf, 0, false, 5n, false);
    expect(object.objectId).toBe(8n);
  });

  it('handles a full uint64 object ID', () => {
    const buf = pack(MAX_VI64, 1n, raw(0xff));
    const { object } = decodeSubgroupObject18(buf, 0, false, 0n, true);
    expect(object.objectId).toBe(MAX_VI64);
  });

  it('rejects an Object ID that overflows 2^64 - 1 (§11.4.2)', () => {
    // prev = MAX_VI64, delta = 0 → MAX_VI64 + 0 + 1 = 2^64, out of range.
    const buf = pack(0n, 1n, raw(0x01));
    expect(() => decodeSubgroupObject18(buf, 0, false, MAX_VI64, false)).toThrow(/overflow|2\^64/i);
  });

  it('reads a status code when payload length is 0', () => {
    // objId=4, payloadLen=0, status=3 (END_OF_GROUP)
    const buf = pack(4n, 0n, 3n);
    const { object, bytesRead } = decodeSubgroupObject18(buf, 0, false, 0n, true);
    expect(object.payload.length).toBe(0);
    expect(object.status).toBe(3n);
    expect(bytesRead).toBe(buf.length);
  });

  it('rejects a draft-14-only status (0x1) on a subgroup object', () => {
    // objId=4, payloadLen=0, status=1 (OBJECT_DOES_NOT_EXIST, 14-only)
    const buf = pack(4n, 0n, 1n);
    expect(() => decodeSubgroupObject18(buf, 0, false, 0n, true)).toThrow(/Object Status/i);
  });

  it('rejects an unknown status code', () => {
    const buf = pack(4n, 0n, 7n);
    expect(() => decodeSubgroupObject18(buf, 0, false, 0n, true)).toThrow(/Object Status/i);
  });

  it('decodes a Properties block when the header says present', () => {
    // objId=1, propLen=2, props=[0x40,0x01], payloadLen=1, payload=[0x09]
    const buf = pack(1n, 2n, raw(0x40, 0x01), 1n, raw(0x09));
    const { object } = decodeSubgroupObject18(buf, 0, true, 0n, true);
    expect(object.extensions).toEqual(new Uint8Array([0x40, 0x01]));
    expect(object.payload).toEqual(new Uint8Array([0x09]));
  });

  it('accepts Properties Length 0 on a subgroup object (no properties)', () => {
    // §11.4.2: objects with no properties set Properties Length to 0 — legal.
    // objId=1, propLen=0, payloadLen=1, payload=[0x09]
    const buf = pack(1n, 0n, 1n, raw(0x09));
    const { object, bytesRead } = decodeSubgroupObject18(buf, 0, true, 0n, true);
    expect(object.extensions).toBeUndefined();
    expect(object.payload).toEqual(new Uint8Array([0x09]));
    expect(bytesRead).toBe(buf.length);
  });

  it('rejects non-empty Properties on a non-Normal subgroup status object', () => {
    // objId=1, propLen=2, props=[0x40,0x01], payloadLen=0, status=3 (End of Group)
    const buf = pack(1n, 2n, raw(0x40, 0x01), 0n, 3n);
    expect(() => decodeSubgroupObject18(buf, 0, true, 0n, true)).toThrow(/non-Normal/i);
  });

  it('accepts Properties on a zero-length Normal subgroup object (status 0x0)', () => {
    // objId=1, propLen=2, props=[0x40,0x01], payloadLen=0, status=0 (Normal)
    const buf = pack(1n, 2n, raw(0x40, 0x01), 0n, 0n);
    const { object } = decodeSubgroupObject18(buf, 0, true, 0n, true);
    expect(object.status).toBe(0n);
    expect(object.extensions).toEqual(new Uint8Array([0x40, 0x01]));
    expect(object.payload.length).toBe(0);
  });
});

describe('decodeObjectDatagram18', () => {
  it('decodes a plain datagram with object ID and payload', () => {
    // type 0x00 = no flags
    const buf = pack(0x00n, 1n /*alias*/, 2n /*group*/, 3n /*obj*/, u8(4) /*prio*/, raw(0x09, 0x08));
    const { datagram, bytesRead } = decodeObjectDatagram18(buf, 0);
    expect(datagram).toEqual({
      typeByte: 0x00,
      trackAlias: 1n,
      groupId: 2n,
      objectId: 3n,
      publisherPriority: 4,
      isEndOfGroup: false,
      extensions: undefined,
      payload: new Uint8Array([0x09, 0x08]),
      status: undefined,
    });
    expect(bytesRead).toBe(buf.length);
  });

  it('uses object ID 0 when ZERO_OBJECT_ID (0x04) is set and omits the field', () => {
    const type = DatagramFlags18.ZERO_OBJECT_ID; // 0x04
    const buf = pack(BigInt(type), 1n, 2n, u8(4), raw(0x09));
    const { datagram } = decodeObjectDatagram18(buf, 0);
    expect(datagram.objectId).toBe(0n);
    expect(datagram.payload).toEqual(new Uint8Array([0x09]));
  });

  it('omits publisher priority when DEFAULT_PRIORITY (0x08) is set', () => {
    const type = DatagramFlags18.DEFAULT_PRIORITY; // 0x08
    const buf = pack(BigInt(type), 1n, 2n, 3n, raw(0x09));
    const { datagram } = decodeObjectDatagram18(buf, 0);
    expect(datagram.publisherPriority).toBeUndefined();
    expect(datagram.objectId).toBe(3n);
  });

  it('reads a status code when STATUS (0x20) is set (no payload)', () => {
    const type = DatagramFlags18.STATUS; // 0x20
    const buf = pack(BigInt(type), 1n, 2n, 3n, u8(4), 3n /*status*/);
    const { datagram, bytesRead } = decodeObjectDatagram18(buf, 0);
    expect(datagram.status).toBe(3n);
    expect(datagram.payload.length).toBe(0);
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes Properties when PROPERTIES (0x01) is set', () => {
    const type = DatagramFlags18.PROPERTIES; // 0x01
    const buf = pack(BigInt(type), 1n, 2n, 3n, u8(4), 2n, raw(0x40, 0x01), raw(0x09));
    const { datagram } = decodeObjectDatagram18(buf, 0);
    expect(datagram.extensions).toEqual(new Uint8Array([0x40, 0x01]));
    expect(datagram.payload).toEqual(new Uint8Array([0x09]));
  });

  it('rejects a present-but-empty Properties block on a datagram', () => {
    const type = DatagramFlags18.PROPERTIES; // 0x01
    const buf = pack(BigInt(type), 1n, 2n, 3n, u8(4), 0n, raw(0x09));
    expect(() => decodeObjectDatagram18(buf, 0)).toThrow(/empty/i);
  });

  it('rejects a draft-14-only status (0x1) on a STATUS datagram', () => {
    const type = DatagramFlags18.STATUS; // 0x20
    const buf = pack(BigInt(type), 1n, 2n, 3n, u8(4), 1n /*status*/);
    expect(() => decodeObjectDatagram18(buf, 0)).toThrow(/Object Status/i);
  });

  it('rejects trailing bytes after a STATUS datagram', () => {
    const type = DatagramFlags18.STATUS; // 0x20
    // valid status 0x3, then a stray trailing payload byte
    const buf = pack(BigInt(type), 1n, 2n, 3n, u8(4), 3n, raw(0xde));
    expect(() => decodeObjectDatagram18(buf, 0)).toThrow(/trailing/i);
  });

  it('rejects non-empty Properties on a non-Normal STATUS datagram', () => {
    const type = DatagramFlags18.STATUS | DatagramFlags18.PROPERTIES; // 0x21
    // props=[0x40,0x01], status=3 (End of Group)
    const buf = pack(BigInt(type), 1n, 2n, 3n, u8(4), 2n, raw(0x40, 0x01), 3n);
    expect(() => decodeObjectDatagram18(buf, 0)).toThrow(/non-Normal/i);
  });

  it('accepts Properties on a Normal STATUS datagram (status 0x0)', () => {
    const type = DatagramFlags18.STATUS | DatagramFlags18.PROPERTIES; // 0x21
    const buf = pack(BigInt(type), 1n, 2n, 3n, u8(4), 2n, raw(0x40, 0x01), 0n);
    const { datagram } = decodeObjectDatagram18(buf, 0);
    expect(datagram.status).toBe(0n);
    expect(datagram.extensions).toEqual(new Uint8Array([0x40, 0x01]));
    expect(datagram.payload.length).toBe(0);
  });

  it('carries full uint64 track alias and object ID', () => {
    const buf = pack(0x00n, MAX_VI64, 0n, MAX_VI64, u8(0), raw(0x01));
    const { datagram } = decodeObjectDatagram18(buf, 0);
    expect(datagram.trackAlias).toBe(MAX_VI64);
    expect(datagram.objectId).toBe(MAX_VI64);
  });

  it('rejects a non-datagram form', () => {
    expect(() => decodeObjectDatagram18(pack(0x10n), 0)).toThrow(/Invalid OBJECT_DATAGRAM/);
  });

  it('rejects the STATUS+END_OF_GROUP combination', () => {
    const type = DatagramFlags18.STATUS | DatagramFlags18.END_OF_GROUP; // 0x22
    expect(() => decodeObjectDatagram18(pack(BigInt(type), 1n, 2n, 3n, u8(0), 0n), 0)).toThrow(
      /STATUS.*END_OF_GROUP/,
    );
  });
});

// ─── FETCH data (§11.4.4) ───────────────────────────────────────────────

// Flag bits: SUBGROUP_MODE 0x03, OBJECT_ID 0x04, GROUP_ID 0x08, PRIORITY 0x10,
// PROPERTIES 0x20, DATAGRAM 0x40. End-of-Range markers: 0x8C / 0x10C.
const FIRST = 0x08 | 0x04 | 0x10; // group + object + priority present, subgroup mode 0

describe('decodeFetchHeader18', () => {
  it('decodes Type 0x05 + Request ID, full uint64', () => {
    const buf = pack(0x05n, MAX_VI64);
    const { header, bytesRead } = decodeFetchHeader18(buf, 0);
    expect(header.requestId).toBe(MAX_VI64);
    expect(bytesRead).toBe(buf.length);
  });

  it('rejects a wrong FETCH_HEADER type', () => {
    expect(() => decodeFetchHeader18(pack(0x06n, 0n), 0)).toThrow(/FETCH_HEADER type/i);
  });
});

describe('decodeFetchObject18 — first object', () => {
  it('reads absolute Group/Object from the first object and sets prior', () => {
    const buf = pack(BigInt(FIRST), 10n /*group*/, 5n /*object*/, u8(3) /*prio*/, 2n, raw(0xaa, 0xbb));
    const { item, bytesRead, nextPrior } = decodeFetchObject18(buf, 0, undefined, true, 'ascending');
    const o = item as FetchObject;
    expect(o.groupId).toBe(10n);
    expect(o.subgroupId).toBe(0n);
    expect(o.objectId).toBe(5n);
    expect(o.publisherPriority).toBe(3);
    expect(o.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(bytesRead).toBe(buf.length);
    expect(nextPrior).toEqual({ groupId: 10n, objectId: 5n, lastObjectSubgroupId: 0n, lastObjectPriority: 3 });
  });

  it('rejects a first object missing Group/Object Delta', () => {
    // flags 0x10 = priority only, no group/object delta
    expect(() => decodeFetchObject18(pack(0x10n, 0n), 0, undefined, true, 'ascending')).toThrow(/Group ID Delta and Object ID Delta/i);
  });

  it('rejects a first object that inherits Priority', () => {
    // group+object present, priority bit clear
    expect(() => decodeFetchObject18(pack(0x0cn, 1n, 2n, 1n, raw(0)), 0, undefined, true, 'ascending')).toThrow(/inherit Priority/i);
  });
});

describe('decodeFetchObject18 — group deltas + order', () => {
  const prior: FetchObjectPrior18 = { groupId: 10n, objectId: 5n, lastObjectSubgroupId: 0n, lastObjectPriority: 3 };

  it('ascending: groupId = prior + delta + 1', () => {
    // flags: group + object present (0x0C), priority inherited
    const buf = pack(0x0cn, 0n /*groupDelta*/, 7n /*object(absolute, new group)*/, 1n, raw(0x01));
    const { item } = decodeFetchObject18(buf, 0, prior, false, 'ascending');
    const o = item as FetchObject;
    expect(o.groupId).toBe(11n); // 10 + 0 + 1
    expect(o.objectId).toBe(7n); // group present → object delta is absolute
    expect(o.publisherPriority).toBe(3); // inherited
  });

  it('descending: groupId = prior - (delta + 1)', () => {
    const buf = pack(0x0cn, 2n /*groupDelta*/, 0n, 1n, raw(0x01));
    const { item } = decodeFetchObject18(buf, 0, prior, false, 'descending');
    expect((item as FetchObject).groupId).toBe(7n); // 10 - (2 + 1)
  });

  it('descending underflow below 0 is a PROTOCOL_VIOLATION', () => {
    const lowPrior: FetchObjectPrior18 = { groupId: 1n, objectId: 0n, lastObjectSubgroupId: 0n, lastObjectPriority: 1 };
    const buf = pack(0x0cn, 5n, 0n, 1n, raw(0x01));
    expect(() => decodeFetchObject18(buf, 0, lowPrior, false, 'descending')).toThrow(/underflow/i);
  });

  it('ascending group overflow above 2^64-1 is a PROTOCOL_VIOLATION', () => {
    const hi: FetchObjectPrior18 = { groupId: MAX_VI64, objectId: 0n, lastObjectSubgroupId: 0n, lastObjectPriority: 1 };
    const buf = pack(0x0cn, 0n, 0n, 1n, raw(0x01));
    expect(() => decodeFetchObject18(buf, 0, hi, false, 'ascending')).toThrow(/overflow/i);
  });
});

describe('decodeFetchObject18 — object id inheritance', () => {
  const prior: FetchObjectPrior18 = { groupId: 10n, objectId: 5n, lastObjectSubgroupId: 2n, lastObjectPriority: 3 };

  it('object delta absent → prior objectId + 1 (same group)', () => {
    // flags 0x00: subgroup mode 0, no group/object/priority → all inherited
    const buf = pack(0x00n, 1n, raw(0x09));
    const { item } = decodeFetchObject18(buf, 0, prior, false, 'ascending');
    const o = item as FetchObject;
    expect(o.groupId).toBe(10n); // inherited
    expect(o.objectId).toBe(6n); // 5 + 1
    expect(o.subgroupId).toBe(0n); // mode 0 → zero
    expect(o.publisherPriority).toBe(3); // inherited
  });

  it('group absent + object delta present → prior objectId + delta', () => {
    const buf = pack(0x04n /*OBJECT_ID*/, 4n /*objDelta*/, 1n, raw(0x09));
    const { item } = decodeFetchObject18(buf, 0, prior, false, 'ascending');
    expect((item as FetchObject).objectId).toBe(9n); // 5 + 4
  });

  it('object id overflow is a PROTOCOL_VIOLATION', () => {
    const hi: FetchObjectPrior18 = { groupId: 0n, objectId: MAX_VI64, lastObjectSubgroupId: 0n, lastObjectPriority: 1 };
    const buf = pack(0x00n, 1n, raw(0x09)); // object delta absent → MAX+1
    expect(() => decodeFetchObject18(buf, 0, hi, false, 'ascending')).toThrow(/overflow/i);
  });
});

describe('decodeFetchObject18 — subgroup modes', () => {
  const prior: FetchObjectPrior18 = { groupId: 10n, objectId: 5n, lastObjectSubgroupId: 4n, lastObjectPriority: 3 };

  it('mode 0x01: subgroup = prior subgroup', () => {
    const { item } = decodeFetchObject18(pack(0x01n, 1n, raw(0x09)), 0, prior, false, 'ascending');
    expect((item as FetchObject).subgroupId).toBe(4n);
  });

  it('mode 0x02: subgroup = prior subgroup + 1', () => {
    const { item } = decodeFetchObject18(pack(0x02n, 1n, raw(0x09)), 0, prior, false, 'ascending');
    expect((item as FetchObject).subgroupId).toBe(5n);
  });

  it('mode 0x03: explicit subgroup field', () => {
    // flags 0x03 (explicit subgroup); subgroup field read after (absent) group delta
    const { item } = decodeFetchObject18(pack(0x03n, 9n /*subgroup*/, 1n, raw(0x09)), 0, prior, false, 'ascending');
    expect((item as FetchObject).subgroupId).toBe(9n);
  });

  it('mode 0x01 with no prior actual object is a PROTOCOL_VIOLATION', () => {
    const noObj: FetchObjectPrior18 = { groupId: 1n, objectId: 1n, lastObjectSubgroupId: undefined, lastObjectPriority: undefined };
    expect(() => decodeFetchObject18(pack(0x01n, 1n, raw(0x09)), 0, noObj, false, 'ascending')).toThrow(/prior Subgroup ID/i);
  });
});

describe('decodeFetchObject18 — End of Range markers', () => {
  it('decodes 0x8C End of Non-Existent Range', () => {
    const buf = pack(0x8cn, 3n /*group*/, 9n /*object*/, 0n /*payloadLen*/);
    const { item, nextPrior } = decodeFetchObject18(buf, 0, undefined, true, 'ascending');
    const m = item as FetchEndOfRange;
    expect(m.nonExistent).toBe(true);
    expect(m.groupId).toBe(3n);
    expect(m.objectId).toBe(9n);
    // Position prior comes from the marker; field priors stay undefined.
    expect(nextPrior).toEqual({ groupId: 3n, objectId: 9n, lastObjectSubgroupId: undefined, lastObjectPriority: undefined });
  });

  it('decodes 0x10C End of Unknown Range (nonExistent=false)', () => {
    const { item } = decodeFetchObject18(pack(0x10cn, 1n, 2n, 0n), 0, undefined, true, 'ascending');
    expect((item as FetchEndOfRange).nonExistent).toBe(false);
  });

  it('after End of Range, an object referencing prior subgroup uses the LAST ACTUAL object', () => {
    // First a real object sets prior subgroup=0; then an EoR marker; then an
    // object with subgroup mode PRIOR must see subgroup=0 (the actual object).
    const first = decodeFetchObject18(pack(BigInt(FIRST), 10n, 5n, u8(3), 1n, raw(0x01)), 0, undefined, true, 'ascending');
    const afterEor = decodeFetchObject18(pack(0x8cn, 12n, 0n, 0n), 0, first.nextPrior, false, 'ascending');
    expect(afterEor.nextPrior.lastObjectSubgroupId).toBe(0n); // unchanged by the marker
    expect(afterEor.nextPrior.groupId).toBe(12n); // position from marker
    // Next object: subgroup mode PRIOR → uses the last actual object's subgroup (0).
    const next = decodeFetchObject18(pack(0x01n, 1n, raw(0x09)), 0, afterEor.nextPrior, false, 'ascending');
    expect((next.item as FetchObject).subgroupId).toBe(0n);
    expect((next.item as FetchObject).objectId).toBe(1n); // prior(marker).objectId 0 + 1
  });

  it('referencing prior subgroup after an EoR-only stream (no actual object) is a PROTOCOL_VIOLATION', () => {
    const eor = decodeFetchObject18(pack(0x8cn, 1n, 2n, 0n), 0, undefined, true, 'ascending');
    expect(() => decodeFetchObject18(pack(0x01n, 1n, raw(0x09)), 0, eor.nextPrior, false, 'ascending')).toThrow(/prior Subgroup ID/i);
  });
});

describe('decodeFetchObject18 — invalid flags', () => {
  it('rejects an out-of-range Serialization Flags value', () => {
    // 0x80 is >= 128 and not 0x8C/0x10C
    expect(() => decodeFetchObject18(pack(0x80n, 0n), 0, undefined, true, 'ascending')).toThrow(/Serialization Flags/i);
  });
});

describe('decodeFetchObject18 — tightenings', () => {
  const prior: FetchObjectPrior18 = { groupId: 10n, objectId: 5n, lastObjectSubgroupId: 4n, lastObjectPriority: 3 };

  it('rejects an End-of-Range marker with a non-zero payload length', () => {
    const buf = pack(0x8cn, 1n, 2n, 1n /*payloadLen*/, raw(0xff));
    expect(() => decodeFetchObject18(buf, 0, undefined, true, 'ascending')).toThrow(/non-zero payload/i);
  });

  it('PRIOR_PLUS_ONE subgroup overflow above 2^64-1 is a PROTOCOL_VIOLATION', () => {
    const hi: FetchObjectPrior18 = { groupId: 1n, objectId: 1n, lastObjectSubgroupId: MAX_VI64, lastObjectPriority: 1 };
    // flags 0x02 = subgroup mode PRIOR_PLUS_ONE, everything else inherited
    expect(() => decodeFetchObject18(pack(0x02n, 1n, raw(0x09)), 0, hi, false, 'ascending')).toThrow(/Subgroup ID overflow/i);
  });

  it('a datagram fetch object yields no prior Subgroup ID; a following PRIOR object is a PROTOCOL_VIOLATION', () => {
    // First object, DATAGRAM form (0x40) + group/object/priority present (0x1C) = 0x5C.
    const dg = decodeFetchObject18(pack(0x5cn, 1n, 0n, u8(3), 1n, raw(0xaa)), 0, undefined, true, 'ascending');
    expect((dg.item as FetchObject).isDatagram).toBe(true);
    expect((dg.item as FetchObject).subgroupId).toBe(0n); // fabricated for delivery
    expect(dg.nextPrior.lastObjectSubgroupId).toBeUndefined(); // but NOT inheritable
    // A following object using subgroup mode PRIOR must fail — no prior subgroup.
    expect(() => decodeFetchObject18(pack(0x01n, 1n, raw(0x09)), 0, dg.nextPrior, false, 'ascending')).toThrow(/prior Subgroup ID/i);
  });

  it('a normal object after a datagram object can still inherit non-subgroup fields', () => {
    // sanity: prior priority/group/object still flow from a datagram object.
    void prior;
    const dg = decodeFetchObject18(pack(0x5cn, 1n, 0n, u8(7), 1n, raw(0xaa)), 0, undefined, true, 'ascending');
    // flags 0x00: subgroup mode 0 (zero, no prior ref), inherit group/object+1/priority
    const next = decodeFetchObject18(pack(0x00n, 1n, raw(0x09)), 0, dg.nextPrior, false, 'ascending');
    const o = next.item as FetchObject;
    expect(o.subgroupId).toBe(0n);
    expect(o.objectId).toBe(1n); // 0 + 1
    expect(o.publisherPriority).toBe(7); // inherited
  });
});
