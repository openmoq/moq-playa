/**
 * Data plane decoder tests.
 * @see draft-ietf-moq-transport-16 §10
 */

import { describe, it, expect } from 'vitest';
import {
  decodeSubgroupHeader,
  decodeSubgroupObject,
  decodeFetchHeader,
  decodeFetchObject,
  decodeObjectDatagram,
  decodeFetchObjectV14,
} from './decoder.js';
import { varint, writeVarint, varintEncodingLength } from '../primitives/varint.js';
import { SubgroupFlags, DatagramFlags, DataStreamType } from './codes.js';
import { ProtocolViolationError } from '../errors.js';
import type { FetchObject } from './types.js';

/** Helper to build a buffer with varints and raw bytes. */
function buildBuffer(...parts: (number | bigint | Uint8Array)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (part instanceof Uint8Array) {
      chunks.push(part);
    } else if (typeof part === 'bigint') {
      const v = varint(part);
      const len = varintEncodingLength(v);
      const buf = new Uint8Array(len);
      writeVarint(v, buf, 0);
      chunks.push(buf);
    } else {
      // Single byte
      chunks.push(new Uint8Array([part]));
    }
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe('decodeSubgroupHeader', () => {
  it('decodes minimal header (mode 0, default priority)', () => {
    // Type 0x30: SUBGROUP_MARKER | DEFAULT_PRIORITY, mode=0
    const buf = buildBuffer(
      0x30,      // type byte
      1n,        // track alias
      100n,      // group ID
      // No subgroup ID (mode 0 = subgroup ID is 0)
      // No priority (DEFAULT_PRIORITY set)
    );

    const { header, bytesRead } = decodeSubgroupHeader(buf, 0);
    expect(header.typeByte).toBe(0x30);
    expect(header.trackAlias).toBe(1n);
    expect(header.groupId).toBe(100n);
    expect(header.subgroupId).toBe(0n);
    expect(header.publisherPriority).toBeUndefined();
    expect(header.hasExtensions).toBe(false);
    expect(header.isEndOfGroup).toBe(false);
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes header with explicit subgroup ID (mode 2)', () => {
    // Type 0x14: SUBGROUP_MARKER | mode=2 (bits 1-2 = 10)
    const buf = buildBuffer(
      0x14,      // type byte
      2n,        // track alias
      50n,       // group ID
      7n,        // subgroup ID (explicit)
      128,       // publisher priority
    );

    const { header, bytesRead } = decodeSubgroupHeader(buf, 0);
    expect(header.typeByte).toBe(0x14);
    expect(header.trackAlias).toBe(2n);
    expect(header.groupId).toBe(50n);
    expect(header.subgroupId).toBe(7n);
    expect(header.publisherPriority).toBe(128);
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes header with mode 1 (subgroup = first object ID)', () => {
    // Type 0x12: SUBGROUP_MARKER | mode=1 (bits 1-2 = 01)
    // Subgroup ID will be set to first object's ID when first object is read
    // At header decode time, we return a sentinel or 0
    const buf = buildBuffer(
      0x12,      // type byte
      3n,        // track alias
      200n,      // group ID
      64,        // publisher priority
    );

    const { header, bytesRead } = decodeSubgroupHeader(buf, 0);
    expect(header.typeByte).toBe(0x12);
    expect(header.trackAlias).toBe(3n);
    expect(header.groupId).toBe(200n);
    // Mode 1: subgroup ID derived from first object, return undefined/-1/special value
    // We'll use 0n as placeholder, caller must set from first object
    expect(header.publisherPriority).toBe(64);
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes header with EXTENSIONS flag', () => {
    // Type 0x11: SUBGROUP_MARKER | EXTENSIONS
    const buf = buildBuffer(
      0x11,      // type byte (EXTENSIONS set)
      1n,        // track alias
      1n,        // group ID
      255,       // publisher priority
    );

    const { header } = decodeSubgroupHeader(buf, 0);
    expect(header.hasExtensions).toBe(true);
  });

  it('decodes header with END_OF_GROUP flag', () => {
    // Type 0x18: SUBGROUP_MARKER | END_OF_GROUP
    const buf = buildBuffer(
      0x18,      // type byte (END_OF_GROUP set)
      1n,        // track alias
      1n,        // group ID
      0,         // publisher priority
    );

    const { header } = decodeSubgroupHeader(buf, 0);
    expect(header.isEndOfGroup).toBe(true);
  });

  it('throws on invalid type byte (not subgroup)', () => {
    const buf = buildBuffer(0x00, 1n, 1n); // datagram type
    expect(() => decodeSubgroupHeader(buf, 0)).toThrow();
  });

  it('throws on reserved subgroup ID mode (0b11)', () => {
    // Type 0x16: SUBGROUP_MARKER | mode=3 (reserved)
    const buf = buildBuffer(0x16, 1n, 1n, 1n, 0);
    expect(() => decodeSubgroupHeader(buf, 0)).toThrow();
  });
});

describe('decodeSubgroupObject', () => {
  it('decodes object with payload', () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const buf = buildBuffer(
      5n,                    // object ID delta
      BigInt(payload.length), // payload length
      payload,               // payload
    );

    const { object, bytesRead } = decodeSubgroupObject(buf, 0, false, 0n);
    expect(object.objectId).toBe(5n); // First object, delta = ID
    expect(object.payload).toEqual(payload);
    expect(object.status).toBeUndefined();
    expect(object.extensions).toBeUndefined();
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes object with accumulated ID from previous', () => {
    const payload = new Uint8Array([0x01]);
    const buf = buildBuffer(
      2n,                    // object ID delta
      BigInt(payload.length),
      payload,
    );

    // Previous object ID was 10, delta is 2, so new ID = 10 + 2 + 1 = 13
    const { object } = decodeSubgroupObject(buf, 0, false, 10n, false);
    expect(object.objectId).toBe(13n);
  });

  it('decodes status object (zero-length payload)', () => {
    const buf = buildBuffer(
      0n,        // object ID delta
      0n,        // payload length = 0
      0x3n,      // object status (END_OF_GROUP)
    );

    const { object, bytesRead } = decodeSubgroupObject(buf, 0, false, 0n);
    expect(object.objectId).toBe(0n);
    expect(object.payload.length).toBe(0);
    expect(object.status).toBe(0x3n);
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes object with extensions', () => {
    const extensions = new Uint8Array([0x02, 0x05]); // Simple KVP: type=2, value=5
    const payload = new Uint8Array([0xaa]);
    const buf = buildBuffer(
      1n,                        // object ID delta
      BigInt(extensions.length), // extensions length
      extensions,                // extensions data
      BigInt(payload.length),    // payload length
      payload,                   // payload
    );

    const { object, bytesRead } = decodeSubgroupObject(buf, 0, true, 0n);
    expect(object.objectId).toBe(1n);
    expect(object.extensions).toEqual(extensions);
    expect(object.payload).toEqual(payload);
    expect(bytesRead).toBe(buf.length);
  });
});

describe('decodeFetchHeader', () => {
  it('decodes FETCH_HEADER', () => {
    const buf = buildBuffer(
      DataStreamType.FETCH_HEADER, // type = 0x05
      42n,                         // request ID
    );

    const { header, bytesRead } = decodeFetchHeader(buf, 0);
    expect(header.requestId).toBe(42n);
    expect(bytesRead).toBe(buf.length);
  });

  it('throws on wrong type byte', () => {
    const buf = buildBuffer(0x10, 1n); // subgroup type instead
    expect(() => decodeFetchHeader(buf, 0)).toThrow();
  });
});

describe('decodeObjectDatagram', () => {
  it('decodes minimal datagram (all fields present)', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const buf = buildBuffer(
      0x00,      // type byte (no flags)
      5n,        // track alias
      10n,       // group ID
      3n,        // object ID
      128,       // publisher priority
      payload,   // rest is payload
    );

    const { datagram, bytesRead } = decodeObjectDatagram(buf, 0);
    expect(datagram.typeByte).toBe(0x00);
    expect(datagram.trackAlias).toBe(5n);
    expect(datagram.groupId).toBe(10n);
    expect(datagram.objectId).toBe(3n);
    expect(datagram.publisherPriority).toBe(128);
    expect(datagram.payload).toEqual(payload);
    expect(datagram.status).toBeUndefined();
    expect(datagram.isEndOfGroup).toBe(false);
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes datagram with ZERO_OBJECT_ID flag', () => {
    const payload = new Uint8Array([0xff]);
    const buf = buildBuffer(
      DatagramFlags.ZERO_OBJECT_ID, // 0x04
      1n,        // track alias
      1n,        // group ID
      // No object ID field
      64,        // publisher priority
      payload,
    );

    const { datagram } = decodeObjectDatagram(buf, 0);
    expect(datagram.objectId).toBe(1n); // Implicit object ID = 1
  });

  it('decodes datagram with DEFAULT_PRIORITY flag', () => {
    const payload = new Uint8Array([0xab]);
    const buf = buildBuffer(
      DatagramFlags.DEFAULT_PRIORITY, // 0x08
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      // No priority field
      payload,
    );

    const { datagram } = decodeObjectDatagram(buf, 0);
    expect(datagram.publisherPriority).toBeUndefined();
  });

  it('decodes datagram with END_OF_GROUP flag', () => {
    const buf = buildBuffer(
      DatagramFlags.END_OF_GROUP, // 0x02
      1n, 1n, 1n, 0,
      new Uint8Array([0x00]),
    );

    const { datagram } = decodeObjectDatagram(buf, 0);
    expect(datagram.isEndOfGroup).toBe(true);
  });

  it('decodes status datagram (STATUS flag, no payload)', () => {
    const buf = buildBuffer(
      DatagramFlags.STATUS, // 0x20
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      0,         // publisher priority
      0x4n,      // status = END_OF_TRACK
    );

    const { datagram } = decodeObjectDatagram(buf, 0);
    expect(datagram.status).toBe(0x4n);
    expect(datagram.payload.length).toBe(0);
  });

  it('throws on invalid type byte (subgroup type)', () => {
    const buf = buildBuffer(0x10, 1n, 1n);
    expect(() => decodeObjectDatagram(buf, 0)).toThrow();
  });

  it('throws on invalid flag combination (STATUS + END_OF_GROUP)', () => {
    const buf = buildBuffer(0x22, 1n, 1n, 1n, 0);
    expect(() => decodeObjectDatagram(buf, 0)).toThrow();
  });
});

// ─── Reviewer Finding: Object ID delta with previousObjectId=0 ───────
describe('decodeSubgroupObject: object ID delta edge cases', () => {
  it('correctly decodes second object when first object had ID 0', () => {
    // First object has ID 0, second object has delta 0
    // Second object ID should be 0 + 0 + 1 = 1
    const payload = new Uint8Array([0xaa]);
    const buf = buildBuffer(
      0n,                      // delta = 0
      BigInt(payload.length),
      payload,
    );

    // Pass isFirstObject=false and previousObjectId=0n
    const { object } = decodeSubgroupObject(buf, 0, false, 0n, false);
    expect(object.objectId).toBe(1n); // 0 + 0 + 1 = 1
  });

  it('correctly decodes first object with delta 0', () => {
    const payload = new Uint8Array([0xbb]);
    const buf = buildBuffer(
      0n,                      // delta = 0
      BigInt(payload.length),
      payload,
    );

    // First object: ID = delta = 0
    const { object } = decodeSubgroupObject(buf, 0, false, 0n, true);
    expect(object.objectId).toBe(0n);
  });

  it('correctly decodes first object with delta 5', () => {
    const payload = new Uint8Array([0xcc]);
    const buf = buildBuffer(
      5n,                      // delta = 5
      BigInt(payload.length),
      payload,
    );

    // First object: ID = delta = 5
    const { object } = decodeSubgroupObject(buf, 0, false, 0n, true);
    expect(object.objectId).toBe(5n);
  });
});

// ─── Reviewer Finding: Object Status validation ──────────────────────
describe('Object Status validation', () => {
  it('throws on invalid status code 0x1 in subgroup object (draft-16)', () => {
    // Draft-16 §10.2.1.1: status 0x1 (OBJECT_DOES_NOT_EXIST) was removed.
    // Only 0x0, 0x3, 0x4 allowed in draft-16.
    const buf = buildBuffer(
      0n,        // object ID delta
      0n,        // payload length = 0 (triggers status read)
      0x1n,      // status 0x1 — invalid in draft-16
    );

    expect(() => decodeSubgroupObject(buf, 0, false, 0n, true, 16)).toThrow();
  });

  it('accepts OBJECT_DOES_NOT_EXIST (0x1) in subgroup object (draft-14)', () => {
    // Draft-14 §10.2.1.1: "0x1 := Indicates Object Does Not Exist.
    // Indicates that this Object does not exist at any publisher
    // and it will not be published in the future."
    const buf = buildBuffer(
      0n,        // object ID delta
      0n,        // payload length = 0 (triggers status read)
      0x1n,      // status 0x1 — valid in draft-14
    );

    const { object } = decodeSubgroupObject(buf, 0, false, 0n, true, 14);
    expect(object.status).toBe(0x1n);
  });

  it('throws on invalid status code in datagram (draft-16)', () => {
    const buf = buildBuffer(
      DatagramFlags.STATUS, // 0x20
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      0,         // publisher priority
      0x2n,      // invalid status (only 0x0, 0x3, 0x4 allowed)
    );

    expect(() => decodeObjectDatagram(buf, 0, 16)).toThrow();
  });

  it('accepts OBJECT_DOES_NOT_EXIST (0x1) in datagram (draft-14)', () => {
    // Draft-14 §10.2.1.1: status 0x1 is valid.
    const buf = buildBuffer(
      DatagramFlags.STATUS, // 0x20
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      0,         // publisher priority
      0x1n,      // status 0x1 — valid in draft-14
    );

    const { datagram } = decodeObjectDatagram(buf, 0, 14);
    expect(datagram.status).toBe(0x1n);
  });

  it('accepts valid status codes (draft-16)', () => {
    for (const status of [0x0n, 0x3n, 0x4n]) {
      const buf = buildBuffer(
        0n,      // delta
        0n,      // payload length = 0
        status,
      );
      expect(() => decodeSubgroupObject(buf, 0, false, 0n, true, 16)).not.toThrow();
    }
  });

  it('accepts all draft-14 status codes including 0x1', () => {
    for (const status of [0x0n, 0x1n, 0x3n, 0x4n]) {
      const buf = buildBuffer(
        0n,      // delta
        0n,      // payload length = 0
        status,
      );
      expect(() => decodeSubgroupObject(buf, 0, false, 0n, true, 14)).not.toThrow();
    }
  });
});

// ─── Reviewer Finding: Extensions validation per §10.2.1.2 ───────────
describe('Extensions validation', () => {
  it('accepts extension length 0 in subgroup object (§10.4.2 allows this)', () => {
    // "Objects with no extensions set Extension Headers Length to 0"
    const payload = new Uint8Array([0xaa]);
    const buf = buildBuffer(
      0n,        // delta
      0n,        // extensions length = 0 (valid per §10.4.2)
      BigInt(payload.length),
      payload,
    );

    // Should NOT throw - length 0 is valid
    const { object } = decodeSubgroupObject(buf, 0, true, 0n, true);
    expect(object.extensions).toEqual(new Uint8Array(0));
    expect(object.payload).toEqual(payload);
  });

  it('throws when extensions present on status object in subgroup (§10.2.1.2)', () => {
    // §10.2.1.2: "If extensions are set on an object with a non‑Normal status,
    // this is a protocol violation"
    const extensions = new Uint8Array([0x02, 0x05]);
    const buf = buildBuffer(
      0n,                        // delta
      BigInt(extensions.length), // extensions length
      extensions,
      0n,                        // payload length = 0 (status object)
      0x3n,                      // status = END_OF_GROUP (non-Normal)
    );

    expect(() => decodeSubgroupObject(buf, 0, true, 0n, true)).toThrow(/extension.*status/i);
  });

  it('throws when extensions present on status datagram (§10.2.1.2)', () => {
    // STATUS flag + EXTENSIONS flag together with non-zero extensions is invalid
    const buf = buildBuffer(
      DatagramFlags.STATUS | DatagramFlags.EXTENSIONS, // 0x21
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      0,         // priority
      2n,        // extensions length = 2
      new Uint8Array([0x02, 0x05]), // extensions data
      0x3n,      // status
    );

    expect(() => decodeObjectDatagram(buf, 0)).toThrow(/extension.*status/i);
  });

  it('throws when datagram EXTENSIONS flag set with length 0 (§10.3.1)', () => {
    // §10.3.1: "If an endpoint receives a datagram with the EXTENSIONS
    // bit set and an Extension Headers Length of 0, it MUST close the
    // session with a PROTOCOL_VIOLATION"
    const payload = new Uint8Array([0xaa]);
    const buf = buildBuffer(
      DatagramFlags.EXTENSIONS, // 0x01
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      0,         // priority
      0n,        // extensions length = 0 (PROTOCOL_VIOLATION for datagrams)
      payload,
    );

    expect(() => decodeObjectDatagram(buf, 0)).toThrow(/PROTOCOL_VIOLATION|Extension.*0/i);
  });
});

// ─── Reviewer Finding: Type byte range checks ────────────────────────
describe('Type byte range validation', () => {
  it('throws on subgroup type byte > 0x3F', () => {
    // 0x50 has bit pattern that might pass low-bit check but exceeds range
    const buf = buildBuffer(0x50, 1n, 1n, 0);
    expect(() => decodeSubgroupHeader(buf, 0)).toThrow();
  });

  it('throws on datagram type byte > 0x2F', () => {
    // 0x40 exceeds datagram range
    const buf = buildBuffer(0x40, 1n, 1n, 1n, 0, new Uint8Array([0x00]));
    expect(() => decodeObjectDatagram(buf, 0)).toThrow();
  });

  it('throws on type byte 0x110 (varint encoding)', () => {
    // Large type value that might pass pattern check
    const buf = buildBuffer(0x110n, 1n, 1n, 0);
    expect(() => decodeSubgroupHeader(buf, 0)).toThrow();
  });
});

// ─── Reviewer Finding: Bounds checks ─────────────────────────────────
describe('Bounds checks', () => {
  it('throws when extension length exceeds remaining buffer in subgroup', () => {
    const buf = buildBuffer(
      0n,        // delta
      100n,      // extensions length = 100 (but buffer is smaller)
    );

    expect(() => decodeSubgroupObject(buf, 0, true, 0n, true)).toThrow(RangeError);
  });

  it('throws when payload length exceeds remaining buffer in subgroup', () => {
    const buf = buildBuffer(
      0n,        // delta
      100n,      // payload length = 100 (but buffer is smaller)
    );

    expect(() => decodeSubgroupObject(buf, 0, false, 0n, true)).toThrow(RangeError);
  });

  it('throws when extension length exceeds remaining buffer in datagram', () => {
    const buf = buildBuffer(
      DatagramFlags.EXTENSIONS, // 0x01
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      0,         // priority
      100n,      // extensions length = 100 (but buffer is smaller)
    );

    expect(() => decodeObjectDatagram(buf, 0)).toThrow(RangeError);
  });

  it('throws when STATUS datagram has trailing bytes', () => {
    const buf = buildBuffer(
      DatagramFlags.STATUS, // 0x20
      1n,        // track alias
      1n,        // group ID
      1n,        // object ID
      0,         // publisher priority
      0x3n,      // status = END_OF_GROUP
      0x00,      // trailing byte - should not be here
    );

    expect(() => decodeObjectDatagram(buf, 0)).toThrow();
  });
});

// ─── FETCH Object Parsing Tests (§10.4.4) ─────────────────────────────
import { decodeFetchObject } from './decoder.js';
import { FetchFlags, FetchSubgroupMode, FetchSpecialFlags } from './codes.js';
import type { FetchObject, FetchEndOfRange } from './types.js';

/** Context for tracking prior object state in fetch streams. */
interface FetchPriorContext {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  priority?: number;
}

describe('decodeFetchObject', () => {
  it('rejects a non-first object with no prior context (ProtocolViolationError, not a crash)', () => {
    // Found by parser-crash fuzz: isFirstObject=false + prior=undefined previously
    // threw `TypeError: Cannot read properties of undefined (reading 'groupId')`.
    expect(() => decodeFetchObject(Uint8Array.from([0x02]), 0, undefined, false))
      .toThrow(ProtocolViolationError);
  });

  describe('basic object parsing', () => {
    it('decodes first object with all fields present (flags = 0x3F)', () => {
      // All fields present: EXTENSIONS | PRIORITY | GROUP_ID | OBJECT_ID | SUBGROUP_EXPLICIT(0x03)
      // 0x3F = 0x20 | 0x10 | 0x08 | 0x04 | 0x03
      const extensions = new Uint8Array([0x02, 0x05]); // type=2, value=5
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const buf = buildBuffer(
        0x3fn,                       // flags: all fields present, explicit subgroup
        10n,                         // group ID
        5n,                          // subgroup ID (explicit mode)
        7n,                          // object ID
        128,                         // priority (uint8)
        BigInt(extensions.length),   // extensions length
        extensions,
        BigInt(payload.length),      // payload length
        payload,
      );

      const { item, bytesRead } = decodeFetchObject(buf, 0, undefined, true);
      expect(item.flags).toBe(0x3fn);
      const obj = item as FetchObject;
      expect(obj.groupId).toBe(10n);
      expect(obj.subgroupId).toBe(5n);
      expect(obj.objectId).toBe(7n);
      expect(obj.publisherPriority).toBe(128);
      expect(obj.isDatagram).toBe(false);
      expect(obj.extensions).toEqual(extensions);
      expect(obj.payload).toEqual(payload);
      expect(bytesRead).toBe(buf.length);
    });

    it('decodes minimal first object (flags = 0x1C, GROUP_ID | OBJECT_ID | PRIORITY)', () => {
      // Subgroup mode 0 (= 0), no extensions
      // First object MUST have PRIORITY per §10.4.4.1 Table 6
      const payload = new Uint8Array([0x01, 0x02]);
      const buf = buildBuffer(
        0x1cn,                     // flags: PRIORITY | GROUP_ID | OBJECT_ID, subgroup mode 0
        5n,                        // group ID
        3n,                        // object ID
        64,                        // priority (uint8)
        BigInt(payload.length),    // payload length
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.groupId).toBe(5n);
      expect(obj.subgroupId).toBe(0n); // mode 0 = subgroup 0
      expect(obj.objectId).toBe(3n);
      expect(obj.publisherPriority).toBe(64);
      expect(obj.extensions).toBeUndefined();
    });
  });

  describe('field inheritance', () => {
    it('inherits group ID when GROUP_ID flag clear', () => {
      const prior: FetchPriorContext = { groupId: 100n, subgroupId: 0n, objectId: 5n, priority: 64 };
      const payload = new Uint8Array([0xaa]);
      const buf = buildBuffer(
        0x04n,                     // flags: OBJECT_ID only (GROUP_ID clear)
        99n,                       // object ID (explicit)
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, prior, false);
      const obj = item as FetchObject;
      expect(obj.groupId).toBe(100n); // inherited from prior
      expect(obj.objectId).toBe(99n);
    });

    it('inherits object ID + 1 when OBJECT_ID flag clear', () => {
      const prior: FetchPriorContext = { groupId: 10n, subgroupId: 2n, objectId: 50n, priority: 128 };
      const payload = new Uint8Array([0xbb]);
      const buf = buildBuffer(
        0x08n,                     // flags: GROUP_ID only (OBJECT_ID clear)
        10n,                       // group ID (explicit, same value)
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, prior, false);
      const obj = item as FetchObject;
      expect(obj.objectId).toBe(51n); // prior + 1
    });

    it('inherits priority when PRIORITY flag clear', () => {
      const prior: FetchPriorContext = { groupId: 1n, subgroupId: 0n, objectId: 1n, priority: 200 };
      const payload = new Uint8Array([0xcc]);
      const buf = buildBuffer(
        0x0cn,                     // flags: GROUP_ID | OBJECT_ID (no PRIORITY)
        2n,                        // group ID
        5n,                        // object ID
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, prior, false);
      const obj = item as FetchObject;
      expect(obj.publisherPriority).toBe(200); // inherited
    });
  });

  describe('subgroup modes', () => {
    it('mode 0: subgroup ID = 0', () => {
      // First object needs PRIORITY per §10.4.4.1
      const payload = new Uint8Array([0x01]);
      const buf = buildBuffer(
        0x1cn,                     // flags: PRIORITY | GROUP_ID | OBJECT_ID, mode 0
        1n, 1n,
        128,                       // priority
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.subgroupId).toBe(0n);
    });

    it('mode 1: subgroup ID = prior subgroup ID', () => {
      const prior: FetchPriorContext = { groupId: 1n, subgroupId: 42n, objectId: 1n, priority: 64 };
      const payload = new Uint8Array([0x02]);
      const buf = buildBuffer(
        0x0dn,                     // flags: bits 0-1 = 01 (mode 1) + GROUP_ID | OBJECT_ID
        1n, 2n,
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, prior, false);
      const obj = item as FetchObject;
      expect(obj.subgroupId).toBe(42n); // same as prior
    });

    it('mode 2: subgroup ID = prior subgroup ID + 1', () => {
      const prior: FetchPriorContext = { groupId: 1n, subgroupId: 10n, objectId: 1n, priority: 64 };
      const payload = new Uint8Array([0x03]);
      const buf = buildBuffer(
        0x0en,                     // flags: bits 0-1 = 10 (mode 2) + GROUP_ID | OBJECT_ID
        1n, 3n,
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, prior, false);
      const obj = item as FetchObject;
      expect(obj.subgroupId).toBe(11n); // prior + 1
    });

    it('mode 3: explicit subgroup ID field present', () => {
      // First object needs PRIORITY per §10.4.4.1
      const payload = new Uint8Array([0x04]);
      const buf = buildBuffer(
        0x1fn,                     // flags: PRIORITY | GROUP_ID | OBJECT_ID | mode 3
        5n,                        // group ID
        99n,                       // subgroup ID (explicit)
        7n,                        // object ID
        64,                        // priority
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.subgroupId).toBe(99n);
    });
  });

  describe('DATAGRAM flag (0x40)', () => {
    it('sets isDatagram=true and ignores subgroup bits', () => {
      // First object needs PRIORITY per §10.4.4.1
      const payload = new Uint8Array([0xdd]);
      const buf = buildBuffer(
        0x5cn,                     // flags: DATAGRAM | PRIORITY | GROUP_ID | OBJECT_ID, subgroup bits = 00
        1n, 1n,
        128,                       // priority
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.isDatagram).toBe(true);
      expect(obj.subgroupId).toBe(0n); // ignored, defaults to 0
    });

    it('ignores subgroup mode bits when DATAGRAM set', () => {
      // First object needs PRIORITY per §10.4.4.1
      const payload = new Uint8Array([0xee]);
      // DATAGRAM flag + subgroup bits = 11 (explicit mode), but should be ignored
      const buf = buildBuffer(
        0x5fn,                     // DATAGRAM | PRIORITY | GROUP_ID | OBJECT_ID | subgroup=11
        1n, 1n,                    // group, object (no subgroup field despite bits=11)
        64,                        // priority
        BigInt(payload.length),
        payload,
      );

      // Should NOT try to read subgroup field even though bits = 11
      const { item, bytesRead } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.isDatagram).toBe(true);
      expect(bytesRead).toBe(buf.length);
    });
  });

  describe('End of Range markers (§10.4.4.2)', () => {
    it('decodes END_NON_EXISTENT (0x8C)', () => {
      // §10.4.4.2: Group ID and Object ID present; Subgroup/Priority/Extensions absent
      // Object Payload Length is always present per §10.4.4
      const buf = buildBuffer(
        0x8cn,                     // special flag: end non-existent
        100n,                      // group ID
        50n,                       // object ID
        0n,                        // payload length (always present, should be 0)
      );

      const { item, bytesRead } = decodeFetchObject(buf, 0, undefined, true);
      expect(item.flags).toBe(0x8cn);
      const eor = item as FetchEndOfRange;
      expect(eor.groupId).toBe(100n);
      expect(eor.objectId).toBe(50n);
      expect(eor.nonExistent).toBe(true);
      expect(bytesRead).toBe(buf.length);
    });

    it('decodes END_UNKNOWN (0x10C)', () => {
      const buf = buildBuffer(
        0x10cn,                    // special flag: end unknown
        200n,                      // group ID
        75n,                       // object ID
        0n,                        // payload length (always present)
      );

      const { item, bytesRead } = decodeFetchObject(buf, 0, undefined, true);
      expect(item.flags).toBe(0x10cn);
      const eor = item as FetchEndOfRange;
      expect(eor.groupId).toBe(200n);
      expect(eor.objectId).toBe(75n);
      expect(eor.nonExistent).toBe(false);
      expect(bytesRead).toBe(buf.length);
    });

    it('END_NON_EXISTENT does not have payload field in result', () => {
      const buf = buildBuffer(
        0x8cn,
        1n, 1n,
        0n,                        // payload length = 0 (always present per §10.4.4)
      );

      const { item } = decodeFetchObject(buf, 0, undefined, true);
      expect('payload' in item).toBe(false); // FetchEndOfRange, not FetchObject
    });
  });

  describe('first object validation (§10.4.4.1)', () => {
    it('throws when first object inherits group ID (GROUP_ID flag clear)', () => {
      const payload = new Uint8Array([0x01]);
      const buf = buildBuffer(
        0x14n,                     // PRIORITY | OBJECT_ID - no GROUP_ID
        1n,                        // object ID
        64,                        // priority
        BigInt(payload.length),
        payload,
      );

      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/first.*inherit|PROTOCOL_VIOLATION/i);
    });

    it('throws when first object inherits object ID (OBJECT_ID flag clear)', () => {
      const payload = new Uint8Array([0x02]);
      const buf = buildBuffer(
        0x18n,                     // PRIORITY | GROUP_ID - no OBJECT_ID
        1n,                        // group ID
        64,                        // priority
        BigInt(payload.length),
        payload,
      );

      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/first.*inherit|PROTOCOL_VIOLATION/i);
    });

    it('throws when first object inherits priority (PRIORITY flag clear)', () => {
      const payload = new Uint8Array([0x05]);
      const buf = buildBuffer(
        0x0cn,                     // GROUP_ID | OBJECT_ID - no PRIORITY
        1n, 1n,
        BigInt(payload.length),
        payload,
      );

      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/first.*inherit|PROTOCOL_VIOLATION/i);
    });

    it('throws when first object uses subgroup mode 1 (PRIOR)', () => {
      const payload = new Uint8Array([0x03]);
      const buf = buildBuffer(
        0x1dn,                     // PRIORITY | GROUP_ID | OBJECT_ID | subgroup mode 1
        1n, 1n,
        64,                        // priority
        BigInt(payload.length),
        payload,
      );

      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/first.*inherit|PROTOCOL_VIOLATION/i);
    });

    it('throws when first object uses subgroup mode 2 (PRIOR + 1)', () => {
      const payload = new Uint8Array([0x04]);
      const buf = buildBuffer(
        0x1en,                     // PRIORITY | GROUP_ID | OBJECT_ID | subgroup mode 2
        1n, 1n,
        64,                        // priority
        BigInt(payload.length),
        payload,
      );

      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/first.*inherit|PROTOCOL_VIOLATION/i);
    });

    it('first object with DATAGRAM flag + subgroup mode 1 is allowed (mode ignored)', () => {
      // First object needs PRIORITY, but DATAGRAM ignores subgroup mode
      const payload = new Uint8Array([0x05]);
      const buf = buildBuffer(
        0x5dn,                     // DATAGRAM | PRIORITY | GROUP_ID | OBJECT_ID | subgroup mode 1
        1n, 1n,
        64,                        // priority
        BigInt(payload.length),
        payload,
      );

      // Should NOT throw - DATAGRAM flag means subgroup bits are ignored
      expect(() => decodeFetchObject(buf, 0, undefined, true)).not.toThrow();
    });
  });

  describe('invalid serialization flags', () => {
    it('throws on flags 0x80 (not special, exceeds 0x7F)', () => {
      const buf = buildBuffer(0x80n, 1n, 1n, 1n);
      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/PROTOCOL_VIOLATION|invalid.*flag/i);
    });

    it('throws on flags 0x100 (not special 0x10C)', () => {
      const buf = buildBuffer(0x100n, 1n, 1n);
      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/PROTOCOL_VIOLATION|invalid.*flag/i);
    });

    it('throws on flags 0x8D (close to special 0x8C but not equal)', () => {
      const buf = buildBuffer(0x8dn, 1n, 1n);
      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(/PROTOCOL_VIOLATION|invalid.*flag/i);
    });

    it('accepts all valid flags 0x00-0x7F', () => {
      // Test 0x1C (PRIORITY | GROUP_ID | OBJECT_ID) as representative for first object
      const payload = new Uint8Array([0x01]);
      const buf = buildBuffer(0x1cn, 1n, 1n, 64, BigInt(payload.length), payload);
      expect(() => decodeFetchObject(buf, 0, undefined, true)).not.toThrow();
    });
  });

  describe('extensions parsing', () => {
    it('parses extensions when EXTENSIONS flag set', () => {
      // First object needs PRIORITY
      const extensions = new Uint8Array([0x02, 0x07, 0x04, 0x10]); // 2 KVPs
      const payload = new Uint8Array([0xff]);
      const buf = buildBuffer(
        0x3cn,                       // EXTENSIONS | PRIORITY | GROUP_ID | OBJECT_ID
        1n, 1n,
        64,                          // priority
        BigInt(extensions.length),   // extensions length
        extensions,
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.extensions).toEqual(extensions);
    });

    it('accepts extension length 0 (empty extensions)', () => {
      // First object needs PRIORITY
      const payload = new Uint8Array([0xee]);
      const buf = buildBuffer(
        0x3cn,                       // EXTENSIONS | PRIORITY | GROUP_ID | OBJECT_ID
        1n, 1n,
        64,                          // priority
        0n,                          // extensions length = 0
        BigInt(payload.length),
        payload,
      );

      // §10.4.4: length 0 is allowed for fetch objects (unlike datagrams)
      const { item } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.extensions).toEqual(new Uint8Array(0));
    });

    it('throws when extension length exceeds buffer', () => {
      // First object needs PRIORITY
      const buf = buildBuffer(
        0x3cn,                       // EXTENSIONS | PRIORITY | GROUP_ID | OBJECT_ID
        1n, 1n,
        64,                          // priority
        1000n,                       // extensions length exceeds buffer
      );

      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(RangeError);
    });
  });

  describe('payload parsing', () => {
    it('reads payload with correct length', () => {
      // First object needs PRIORITY
      const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
      const buf = buildBuffer(
        0x1cn,                       // PRIORITY | GROUP_ID | OBJECT_ID
        1n, 1n,
        64,                          // priority
        BigInt(payload.length),
        payload,
      );

      const { item, bytesRead } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.payload).toEqual(payload);
      expect(bytesRead).toBe(buf.length);
    });

    it('handles empty payload', () => {
      // First object needs PRIORITY
      const buf = buildBuffer(
        0x1cn,                       // PRIORITY | GROUP_ID | OBJECT_ID
        1n, 1n,
        64,                          // priority
        0n,                          // payload length = 0
      );

      const { item } = decodeFetchObject(buf, 0, undefined, true);
      const obj = item as FetchObject;
      expect(obj.payload).toEqual(new Uint8Array(0));
    });

    it('throws when payload length exceeds buffer', () => {
      // First object needs PRIORITY
      const buf = buildBuffer(
        0x1cn,                       // PRIORITY | GROUP_ID | OBJECT_ID
        1n, 1n,
        64,                          // priority
        500n,                        // payload length exceeds buffer
      );

      expect(() => decodeFetchObject(buf, 0, undefined, true)).toThrow(RangeError);
    });
  });

  describe('full inheritance scenario', () => {
    it('decodes subsequent object inheriting all fields (flags = 0x00)', () => {
      const prior: FetchPriorContext = {
        groupId: 50n,
        subgroupId: 3n,
        objectId: 100n,
        priority: 64,
      };
      const payload = new Uint8Array([0xab, 0xcd]);
      const buf = buildBuffer(
        0x00n,                       // inherit everything
        BigInt(payload.length),
        payload,
      );

      const { item } = decodeFetchObject(buf, 0, prior, false);
      const obj = item as FetchObject;
      expect(obj.groupId).toBe(50n);       // inherited
      expect(obj.subgroupId).toBe(0n);     // mode 0 = 0
      expect(obj.objectId).toBe(101n);     // prior + 1
      expect(obj.publisherPriority).toBe(64); // inherited
    });
  });
});

// ─── Draft-14 Data Plane ────────────────────────────────────────────────

describe('draft-14: decodeSubgroupHeader (version=14)', () => {
  /**
   * draft-ietf-moq-transport-14 §10.4.2: Publisher Priority is ALWAYS present.
   * No DEFAULT_PRIORITY bit. Type range: 0x10..0x1D.
   */
  it('always reads publisher priority (no DEFAULT_PRIORITY flag)', () => {
    // Type 0x10: mode=0, no extensions, no end-of-group
    // In draft-16 this would NOT have DEFAULT_PRIORITY set, so priority is read.
    // In draft-14, priority is ALWAYS read regardless.
    const buf = buildBuffer(
      0x10,      // type byte (mode 0)
      1n,        // track alias
      100n,      // group ID
      // No subgroup ID (mode 0)
      42,        // publisher priority (always present in v14)
    );

    const { header, bytesRead } = decodeSubgroupHeader(buf, 0, 14);

    expect(header.trackAlias).toBe(1n);
    expect(header.groupId).toBe(100n);
    expect(header.subgroupId).toBe(0n);
    expect(header.publisherPriority).toBe(42);
    expect(bytesRead).toBe(buf.length);
  });

  it('rejects type 0x30 (DEFAULT_PRIORITY range not valid in draft-14)', () => {
    const buf = buildBuffer(
      0x30,      // type byte — valid in draft-16, invalid in draft-14
      1n,        // track alias
      100n,      // group ID
    );

    expect(() => decodeSubgroupHeader(buf, 0, 14)).toThrow();
  });
});

describe('draft-14: decodeObjectDatagram (version=14)', () => {
  /**
   * draft-ietf-moq-transport-14 §10.3.1: Publisher Priority is ALWAYS present.
   * Type range: 0x0-0x7, 0x20-0x21. No DEFAULT_PRIORITY bit.
   */
  it('always reads publisher priority', () => {
    // Type 0x00: plain datagram with Object ID + Priority
    const payload = new Uint8Array([0xDE, 0xAD]);
    const buf = buildBuffer(
      0x00,      // type byte
      5n,        // track alias
      10n,       // group ID
      1n,        // object ID
      128,       // publisher priority (always present)
      payload,   // payload (rest of datagram)
    );

    const { datagram } = decodeObjectDatagram(buf, 0, 14);

    expect(datagram.trackAlias).toBe(5n);
    expect(datagram.groupId).toBe(10n);
    expect(datagram.objectId).toBe(1n);
    expect(datagram.publisherPriority).toBe(128);
    expect(datagram.payload).toEqual(payload);
  });

  it('rejects type 0x08 (DEFAULT_PRIORITY range not valid in draft-14)', () => {
    const buf = buildBuffer(
      0x08,      // type byte — valid in draft-16, invalid in draft-14
      5n,        // track alias
      10n,       // group ID
      1n,        // object ID
    );

    expect(() => decodeObjectDatagram(buf, 0, 14)).toThrow();
  });
});

describe('draft-14: decodeFetchObjectV14', () => {
  /**
   * draft-ietf-moq-transport-14 §10.4.4: Fetch objects have a fixed format
   * with all fields always present (no serialization flags).
   *
   * { Group ID (i), Subgroup ID (i), Object ID (i), Publisher Priority (8),
   *   Extension Headers Length (i), [Extension headers (...)],
   *   Object Payload Length (i), [Object Status (i)], Object Payload (..) }
   */
  it('decodes fetch object with all fields present', () => {
    const payload = new Uint8Array([0xCA, 0xFE]);
    const buf = buildBuffer(
      5n,         // group ID
      0n,         // subgroup ID
      0n,         // object ID
      64,         // publisher priority
      0n,         // extension headers length = 0
      BigInt(payload.length), // payload length
      payload,
    );

    const { item, bytesRead } = decodeFetchObjectV14(buf, 0);
    const obj = item as FetchObject;

    expect(obj.groupId).toBe(5n);
    expect(obj.subgroupId).toBe(0n);
    expect(obj.objectId).toBe(0n);
    expect(obj.publisherPriority).toBe(64);
    expect(obj.payload).toEqual(payload);
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes fetch object with extensions', () => {
    const extensions = new Uint8Array([0x01, 0x02, 0x03]);
    const payload = new Uint8Array([0xBE, 0xEF]);
    const buf = buildBuffer(
      10n,        // group ID
      1n,         // subgroup ID
      3n,         // object ID
      200,        // publisher priority
      BigInt(extensions.length), // extension headers length
      extensions,
      BigInt(payload.length),
      payload,
    );

    const { item } = decodeFetchObjectV14(buf, 0);
    const obj = item as FetchObject;

    expect(obj.groupId).toBe(10n);
    expect(obj.subgroupId).toBe(1n);
    expect(obj.objectId).toBe(3n);
    expect(obj.publisherPriority).toBe(200);
    expect(obj.extensions).toEqual(extensions);
    expect(obj.payload).toEqual(payload);
  });

  it('decodes status object (payload length 0) as FetchEndOfRange', () => {
    const buf = buildBuffer(
      1n,         // group ID
      0n,         // subgroup ID
      5n,         // object ID
      128,        // publisher priority
      0n,         // no extensions
      0n,         // payload length = 0
      0x3n,       // object status = END_OF_GROUP
    );

    const { item, bytesRead } = decodeFetchObjectV14(buf, 0);
    // Status objects now return FetchEndOfRange, not FetchObject
    expect('payload' in item).toBe(false);
    const gap = item as FetchEndOfRange;
    expect(gap.groupId).toBe(1n);
    expect(gap.objectId).toBe(5n);
    expect(gap.nonExistent).toBe(false); // END_OF_GROUP is not "does not exist"
    expect(bytesRead).toBe(buf.length);
  });

  it('decodes OBJECT_DOES_NOT_EXIST status as nonExistent FetchEndOfRange', () => {
    const buf = buildBuffer(
      2n,         // group ID
      0n,         // subgroup ID
      3n,         // object ID
      128,        // publisher priority
      0n,         // no extensions
      0n,         // payload length = 0
      0x1n,       // object status = OBJECT_DOES_NOT_EXIST (draft-14 only)
    );

    const { item, bytesRead } = decodeFetchObjectV14(buf, 0);
    expect('payload' in item).toBe(false);
    const gap = item as FetchEndOfRange;
    expect(gap.groupId).toBe(2n);
    expect(gap.objectId).toBe(3n);
    expect(gap.nonExistent).toBe(true);
    expect(bytesRead).toBe(buf.length);
  });
});
