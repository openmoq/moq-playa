/**
 * Data plane encoder round-trip tests.
 * Verifies: decode(encode(x)) === x for all data plane structures.
 * @see draft-ietf-moq-transport-16 §10
 */

import { describe, it, expect } from 'vitest';
import { varint, type Varint } from '../primitives/varint.js';
import {
  SubgroupFlags,
  SubgroupIdMode,
  DatagramFlags,
  ObjectStatus,
  FetchFlags,
  FetchSubgroupMode,
  FetchSpecialFlags,
} from './codes.js';
import type {
  SubgroupHeader,
  SubgroupObject,
  FetchHeader,
  FetchObject,
  FetchEndOfRange,
  ObjectDatagram,
} from './types.js';
import {
  encodeSubgroupHeader,
  encodeSubgroupObject,
  encodeFetchHeader,
  encodeObjectDatagram,
  encodeFetchObject,
  encodeFetchEndOfRange,
} from './encoder.js';
import {
  decodeSubgroupHeader,
  decodeSubgroupObject,
  decodeFetchHeader,
  decodeFetchObject,
  decodeObjectDatagram,
} from './decoder.js';

describe('Data Plane Encoder', () => {
  describe('encodeSubgroupHeader round-trip', () => {
    it('encodes minimal subgroup header (mode ZERO, no extensions, no end-of-group)', () => {
      const header: SubgroupHeader = {
        typeByte: SubgroupFlags.SUBGROUP_MARKER, // 0x10 = mode ZERO, no flags
        trackAlias: varint(1n),
        groupId: varint(0n),
        subgroupId: varint(0n),
        publisherPriority: 128,
        hasExtensions: false,
        isEndOfGroup: false,
      };

      const encoded = encodeSubgroupHeader(header);
      const { header: decoded, bytesRead } = decodeSubgroupHeader(encoded, 0);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded.trackAlias).toBe(header.trackAlias);
      expect(decoded.groupId).toBe(header.groupId);
      expect(decoded.subgroupId).toBe(0n); // mode ZERO
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.hasExtensions).toBe(false);
      expect(decoded.isEndOfGroup).toBe(false);
    });

    it('encodes subgroup header with EXPLICIT subgroup ID', () => {
      const typeByte = SubgroupFlags.SUBGROUP_MARKER | (SubgroupIdMode.EXPLICIT << 1); // 0x14
      const header: SubgroupHeader = {
        typeByte,
        trackAlias: varint(42n),
        groupId: varint(100n),
        subgroupId: varint(7n),
        publisherPriority: 255,
        hasExtensions: false,
        isEndOfGroup: false,
      };

      const encoded = encodeSubgroupHeader(header);
      const { header: decoded, bytesRead } = decodeSubgroupHeader(encoded, 0);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded.trackAlias).toBe(42n);
      expect(decoded.groupId).toBe(100n);
      expect(decoded.subgroupId).toBe(7n);
      expect(decoded.publisherPriority).toBe(255);
    });

    it('encodes subgroup header with extensions and end-of-group', () => {
      const typeByte = SubgroupFlags.SUBGROUP_MARKER | SubgroupFlags.EXTENSIONS | SubgroupFlags.END_OF_GROUP; // 0x19
      const header: SubgroupHeader = {
        typeByte,
        trackAlias: varint(5n),
        groupId: varint(50n),
        subgroupId: varint(0n),
        publisherPriority: 0,
        hasExtensions: true,
        isEndOfGroup: true,
      };

      const encoded = encodeSubgroupHeader(header);
      const { header: decoded } = decodeSubgroupHeader(encoded, 0);

      expect(decoded.hasExtensions).toBe(true);
      expect(decoded.isEndOfGroup).toBe(true);
      expect(decoded.publisherPriority).toBe(0);
    });

    it('encodes subgroup header with DEFAULT_PRIORITY (no priority field)', () => {
      const typeByte = SubgroupFlags.SUBGROUP_MARKER | SubgroupFlags.DEFAULT_PRIORITY; // 0x30
      const header: SubgroupHeader = {
        typeByte,
        trackAlias: varint(1n),
        groupId: varint(0n),
        subgroupId: varint(0n),
        publisherPriority: undefined,
        hasExtensions: false,
        isEndOfGroup: false,
      };

      const encoded = encodeSubgroupHeader(header);
      const { header: decoded } = decodeSubgroupHeader(encoded, 0);

      expect(decoded.publisherPriority).toBeUndefined();
    });

    it('encodes subgroup header with FIRST_OBJECT mode', () => {
      const typeByte = SubgroupFlags.SUBGROUP_MARKER | (SubgroupIdMode.FIRST_OBJECT << 1); // 0x12
      const header: SubgroupHeader = {
        typeByte,
        trackAlias: varint(1n),
        groupId: varint(10n),
        subgroupId: varint(0n), // placeholder — resolved on first object
        publisherPriority: 50,
        hasExtensions: false,
        isEndOfGroup: false,
      };

      const encoded = encodeSubgroupHeader(header);
      const { header: decoded } = decodeSubgroupHeader(encoded, 0);

      expect(decoded.trackAlias).toBe(1n);
      expect(decoded.groupId).toBe(10n);
      expect(decoded.publisherPriority).toBe(50);
    });

    it('encodes subgroup header with large varint values', () => {
      const header: SubgroupHeader = {
        typeByte: SubgroupFlags.SUBGROUP_MARKER | (SubgroupIdMode.EXPLICIT << 1),
        trackAlias: varint(16384n), // 4-byte varint
        groupId: varint(1073741824n), // 8-byte varint
        subgroupId: varint(300n),
        publisherPriority: 200,
        hasExtensions: false,
        isEndOfGroup: false,
      };

      const encoded = encodeSubgroupHeader(header);
      const { header: decoded, bytesRead } = decodeSubgroupHeader(encoded, 0);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded.trackAlias).toBe(16384n);
      expect(decoded.groupId).toBe(1073741824n);
      expect(decoded.subgroupId).toBe(300n);
    });
  });

  describe('encodeSubgroupObject round-trip', () => {
    it('encodes first object with payload', () => {
      const object: SubgroupObject = {
        objectId: varint(0n),
        extensions: undefined,
        payload: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]), // "Hello"
        status: undefined,
      };

      const encoded = encodeSubgroupObject(object, false, varint(0n), true);
      const { object: decoded, bytesRead } = decodeSubgroupObject(encoded, 0, false, varint(0n), true);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded.objectId).toBe(0n);
      expect(decoded.payload).toEqual(object.payload);
      expect(decoded.extensions).toBeUndefined();
      expect(decoded.status).toBeUndefined();
    });

    it('encodes subsequent object with delta', () => {
      // Object ID 5, previous was 2 → delta = 5 - 2 - 1 = 2
      const object: SubgroupObject = {
        objectId: varint(5n),
        extensions: undefined,
        payload: new Uint8Array([0x01, 0x02]),
        status: undefined,
      };

      const encoded = encodeSubgroupObject(object, false, varint(2n), false);
      const { object: decoded } = decodeSubgroupObject(encoded, 0, false, varint(2n), false);

      expect(decoded.objectId).toBe(5n);
      expect(decoded.payload).toEqual(object.payload);
    });

    it('encodes object with extensions', () => {
      const extensions = new Uint8Array([0x10, 0x01, 0xFF]); // Some KVP data
      const object: SubgroupObject = {
        objectId: varint(0n),
        extensions,
        payload: new Uint8Array([0xDE, 0xAD]),
        status: undefined,
      };

      const encoded = encodeSubgroupObject(object, true, varint(0n), true);
      const { object: decoded } = decodeSubgroupObject(encoded, 0, true, varint(0n), true);

      expect(decoded.extensions).toEqual(extensions);
      expect(decoded.payload).toEqual(object.payload);
    });

    it('encodes status object (END_OF_GROUP)', () => {
      const object: SubgroupObject = {
        objectId: varint(10n),
        extensions: undefined,
        payload: new Uint8Array(0),
        status: ObjectStatus.END_OF_GROUP,
      };

      const encoded = encodeSubgroupObject(object, false, varint(0n), true);
      const { object: decoded } = decodeSubgroupObject(encoded, 0, false, varint(0n), true);

      expect(decoded.objectId).toBe(10n);
      expect(decoded.payload.length).toBe(0);
      expect(decoded.status).toBe(ObjectStatus.END_OF_GROUP);
    });

    it('encodes status object (END_OF_TRACK)', () => {
      const object: SubgroupObject = {
        objectId: varint(0n),
        extensions: undefined,
        payload: new Uint8Array(0),
        status: ObjectStatus.END_OF_TRACK,
      };

      const encoded = encodeSubgroupObject(object, false, varint(0n), true);
      const { object: decoded } = decodeSubgroupObject(encoded, 0, false, varint(0n), true);

      expect(decoded.status).toBe(ObjectStatus.END_OF_TRACK);
    });

    it('encodes consecutive objects correctly', () => {
      // Encode three consecutive objects and decode them
      const obj0: SubgroupObject = {
        objectId: varint(0n),
        extensions: undefined,
        payload: new Uint8Array([0x01]),
        status: undefined,
      };
      const obj1: SubgroupObject = {
        objectId: varint(1n),
        extensions: undefined,
        payload: new Uint8Array([0x02]),
        status: undefined,
      };
      const obj2: SubgroupObject = {
        objectId: varint(2n),
        extensions: undefined,
        payload: new Uint8Array([0x03]),
        status: undefined,
      };

      const enc0 = encodeSubgroupObject(obj0, false, varint(0n), true);
      const enc1 = encodeSubgroupObject(obj1, false, varint(0n), false);
      const enc2 = encodeSubgroupObject(obj2, false, varint(1n), false);

      // Concatenate
      const stream = new Uint8Array(enc0.length + enc1.length + enc2.length);
      stream.set(enc0, 0);
      stream.set(enc1, enc0.length);
      stream.set(enc2, enc0.length + enc1.length);

      // Decode sequentially
      let pos = 0;
      const { object: d0, bytesRead: br0 } = decodeSubgroupObject(stream, pos, false, varint(0n), true);
      pos += br0;
      const { object: d1, bytesRead: br1 } = decodeSubgroupObject(stream, pos, false, d0.objectId, false);
      pos += br1;
      const { object: d2 } = decodeSubgroupObject(stream, pos, false, d1.objectId, false);

      expect(d0.objectId).toBe(0n);
      expect(d1.objectId).toBe(1n);
      expect(d2.objectId).toBe(2n);
      expect(d0.payload).toEqual(new Uint8Array([0x01]));
      expect(d1.payload).toEqual(new Uint8Array([0x02]));
      expect(d2.payload).toEqual(new Uint8Array([0x03]));
    });

    it('encodes object with empty extensions (length 0)', () => {
      const object: SubgroupObject = {
        objectId: varint(0n),
        extensions: undefined, // No actual extension data
        payload: new Uint8Array([0xAB]),
        status: undefined,
      };

      const encoded = encodeSubgroupObject(object, true, varint(0n), true);
      const { object: decoded } = decodeSubgroupObject(encoded, 0, true, varint(0n), true);

      // Extensions length is 0 → extensions data is empty
      expect(decoded.extensions).toEqual(new Uint8Array(0));
      expect(decoded.payload).toEqual(new Uint8Array([0xAB]));
    });
  });

  describe('encodeFetchHeader round-trip', () => {
    it('encodes fetch header with small request ID', () => {
      const header: FetchHeader = { requestId: varint(0n) };

      const encoded = encodeFetchHeader(header);
      const { header: decoded, bytesRead } = decodeFetchHeader(encoded, 0);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded.requestId).toBe(0n);
    });

    it('encodes fetch header with large request ID', () => {
      const header: FetchHeader = { requestId: varint(16384n) };

      const encoded = encodeFetchHeader(header);
      const { header: decoded, bytesRead } = decodeFetchHeader(encoded, 0);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded.requestId).toBe(16384n);
    });
  });

  describe('encodeObjectDatagram round-trip', () => {
    it('encodes minimal datagram (no flags)', () => {
      const datagram: ObjectDatagram = {
        typeByte: 0x00, // No flags
        trackAlias: varint(1n),
        groupId: varint(5n),
        objectId: varint(10n),
        publisherPriority: 128,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]),
        status: undefined,
      };

      const encoded = encodeObjectDatagram(datagram);
      const { datagram: decoded, bytesRead } = decodeObjectDatagram(encoded, 0);

      expect(bytesRead).toBe(encoded.length);
      expect(decoded.trackAlias).toBe(1n);
      expect(decoded.groupId).toBe(5n);
      expect(decoded.objectId).toBe(10n);
      expect(decoded.publisherPriority).toBe(128);
      expect(decoded.payload).toEqual(datagram.payload);
      expect(decoded.isEndOfGroup).toBe(false);
    });

    it('encodes datagram with END_OF_GROUP', () => {
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.END_OF_GROUP, // 0x02
        trackAlias: varint(1n),
        groupId: varint(5n),
        objectId: varint(10n),
        publisherPriority: 0,
        isEndOfGroup: true,
        extensions: undefined,
        payload: new Uint8Array([0xFF]),
        status: undefined,
      };

      const encoded = encodeObjectDatagram(datagram);
      const { datagram: decoded } = decodeObjectDatagram(encoded, 0);

      expect(decoded.isEndOfGroup).toBe(true);
    });

    it('encodes datagram with ZERO_OBJECT_ID', () => {
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.ZERO_OBJECT_ID, // 0x04
        trackAlias: varint(1n),
        groupId: varint(5n),
        objectId: varint(1n), // Implicitly 1 when ZERO_OBJECT_ID
        publisherPriority: 128,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0x01]),
        status: undefined,
      };

      const encoded = encodeObjectDatagram(datagram);
      const { datagram: decoded } = decodeObjectDatagram(encoded, 0);

      expect(decoded.objectId).toBe(1n); // ZERO_OBJECT_ID → Object ID = 1
    });

    it('encodes datagram with DEFAULT_PRIORITY', () => {
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.DEFAULT_PRIORITY, // 0x08
        trackAlias: varint(1n),
        groupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: undefined, // Not present
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0x42]),
        status: undefined,
      };

      const encoded = encodeObjectDatagram(datagram);
      const { datagram: decoded } = decodeObjectDatagram(encoded, 0);

      expect(decoded.publisherPriority).toBeUndefined();
    });

    it('encodes datagram with extensions', () => {
      const extensions = new Uint8Array([0x10, 0x01, 0xFF]);
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.EXTENSIONS, // 0x01
        trackAlias: varint(1n),
        groupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        isEndOfGroup: false,
        extensions,
        payload: new Uint8Array([0x01, 0x02]),
        status: undefined,
      };

      const encoded = encodeObjectDatagram(datagram);
      const { datagram: decoded } = decodeObjectDatagram(encoded, 0);

      expect(decoded.extensions).toEqual(extensions);
      expect(decoded.payload).toEqual(new Uint8Array([0x01, 0x02]));
    });

    it('encodes status datagram', () => {
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.STATUS, // 0x20
        trackAlias: varint(1n),
        groupId: varint(5n),
        objectId: varint(10n),
        publisherPriority: 128,
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array(0),
        status: ObjectStatus.END_OF_TRACK,
      };

      const encoded = encodeObjectDatagram(datagram);
      const { datagram: decoded } = decodeObjectDatagram(encoded, 0);

      expect(decoded.status).toBe(ObjectStatus.END_OF_TRACK);
      expect(decoded.payload.length).toBe(0);
    });

    it('throws when EXTENSIONS flag set but extensions data undefined (§10.3.1)', () => {
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.EXTENSIONS, // 0x01 — EXTENSIONS flag set
        trackAlias: varint(1n),
        groupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        isEndOfGroup: false,
        extensions: undefined, // Inconsistent: flag says present, field is missing
        payload: new Uint8Array([0x01]),
        status: undefined,
      };

      expect(() => encodeObjectDatagram(datagram)).toThrow();
    });

    it('throws when DEFAULT_PRIORITY not set but publisherPriority undefined (§10.3.1)', () => {
      const datagram: ObjectDatagram = {
        typeByte: 0x00, // No DEFAULT_PRIORITY — priority field MUST be present
        trackAlias: varint(1n),
        groupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: undefined, // Inconsistent: flag says present, field missing
        isEndOfGroup: false,
        extensions: undefined,
        payload: new Uint8Array([0x01]),
        status: undefined,
      };

      expect(() => encodeObjectDatagram(datagram)).toThrow();
    });
  });

  describe('encodeFetchObject round-trip', () => {
    it('encodes first fetch object with all fields present', () => {
      // First object: GROUP_ID, OBJECT_ID, PRIORITY must be present
      const flags = varint(
        FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchSubgroupMode.EXPLICIT,
      );
      const object: FetchObject = {
        flags,
        groupId: varint(5n),
        subgroupId: varint(3n),
        objectId: varint(10n),
        publisherPriority: 200,
        isDatagram: false,
        extensions: undefined,
        payload: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]),
      };

      const encoded = encodeFetchObject(object);
      const { item: decoded, bytesRead } = decodeFetchObject(encoded, 0, undefined, true);

      expect(bytesRead).toBe(encoded.length);
      expect('groupId' in decoded).toBe(true);
      const obj = decoded as FetchObject;
      expect(obj.groupId).toBe(5n);
      expect(obj.subgroupId).toBe(3n);
      expect(obj.objectId).toBe(10n);
      expect(obj.publisherPriority).toBe(200);
      expect(obj.payload).toEqual(object.payload);
    });

    it('encodes fetch object with subgroup mode ZERO', () => {
      const flags = varint(
        FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchSubgroupMode.ZERO,
      );
      const object: FetchObject = {
        flags,
        groupId: varint(1n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        isDatagram: false,
        extensions: undefined,
        payload: new Uint8Array([0x01]),
      };

      const encoded = encodeFetchObject(object);
      const { item: decoded } = decodeFetchObject(encoded, 0, undefined, true);

      const obj = decoded as FetchObject;
      expect(obj.subgroupId).toBe(0n);
    });

    it('encodes fetch object with DATAGRAM flag', () => {
      const flags = varint(
        FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchFlags.DATAGRAM,
      );
      const object: FetchObject = {
        flags,
        groupId: varint(1n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        isDatagram: true,
        extensions: undefined,
        payload: new Uint8Array([0x42]),
      };

      const encoded = encodeFetchObject(object);
      const { item: decoded } = decodeFetchObject(encoded, 0, undefined, true);

      const obj = decoded as FetchObject;
      expect(obj.isDatagram).toBe(true);
      expect(obj.subgroupId).toBe(0n);
    });

    it('encodes fetch object with extensions', () => {
      const extensions = new Uint8Array([0x10, 0x01, 0xFF]);
      const flags = varint(
        FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchFlags.EXTENSIONS | FetchSubgroupMode.ZERO,
      );
      const object: FetchObject = {
        flags,
        groupId: varint(1n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: 128,
        isDatagram: false,
        extensions,
        payload: new Uint8Array([0x01, 0x02]),
      };

      const encoded = encodeFetchObject(object);
      const { item: decoded } = decodeFetchObject(encoded, 0, undefined, true);

      const obj = decoded as FetchObject;
      expect(obj.extensions).toEqual(extensions);
    });

    it('throws when PRIORITY flag set but publisherPriority undefined (§10.4.4)', () => {
      const flags = varint(
        FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY,
      );
      const object: FetchObject = {
        flags,
        groupId: varint(0n),
        subgroupId: varint(0n),
        objectId: varint(0n),
        publisherPriority: undefined, // Inconsistent: PRIORITY flag set, field missing
        isDatagram: false,
        extensions: undefined,
        payload: new Uint8Array([0x01]),
      };

      expect(() => encodeFetchObject(object)).toThrow();
    });
  });

  describe('encodeFetchEndOfRange round-trip', () => {
    it('encodes END_NON_EXISTENT marker', () => {
      const marker: FetchEndOfRange = {
        flags: varint(FetchSpecialFlags.END_NON_EXISTENT),
        groupId: varint(10n),
        objectId: varint(5n),
        nonExistent: true,
      };

      const encoded = encodeFetchEndOfRange(marker);
      const { item: decoded, bytesRead } = decodeFetchObject(encoded, 0, undefined, false);

      expect(bytesRead).toBe(encoded.length);
      const eor = decoded as FetchEndOfRange;
      expect(eor.nonExistent).toBe(true);
      expect(eor.groupId).toBe(10n);
      expect(eor.objectId).toBe(5n);
    });

    it('encodes END_UNKNOWN marker', () => {
      const marker: FetchEndOfRange = {
        flags: varint(FetchSpecialFlags.END_UNKNOWN),
        groupId: varint(20n),
        objectId: varint(15n),
        nonExistent: false,
      };

      const encoded = encodeFetchEndOfRange(marker);
      const { item: decoded } = decodeFetchObject(encoded, 0, undefined, false);

      const eor = decoded as FetchEndOfRange;
      expect(eor.nonExistent).toBe(false);
      expect(eor.groupId).toBe(20n);
      expect(eor.objectId).toBe(15n);
    });
  });

  // ─── Encoder Validation (§10) ────────────────────────────────────────

  describe('encoder validation', () => {
    it('encodes NORMAL status for zero-length subgroup object (§10.2.1.1)', () => {
      // §10.2.1.1: "Zero-length objects explicitly encode the Normal status."
      const object: SubgroupObject = {
        objectId: varint(0n),
        payload: new Uint8Array(0),
        // No status specified — encoder should auto-encode NORMAL
      };

      const encoded = encodeSubgroupObject(object, false, varint(0n), true);
      // Should include ObjectStatus(0x0) after payload length 0
      // Object ID delta (0) + payload length (0) + status NORMAL (0) = 3 bytes min
      const { object: decoded } = decodeSubgroupObject(encoded, 0, false, varint(0n), true);
      expect(decoded.status).toBe(ObjectStatus.NORMAL);
    });

    it('throws on STATUS flag without status field in datagram (§10.3.1)', () => {
      // §10.3.1: STATUS flag set means Object Status is present, not Object Payload
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.STATUS, // STATUS flag but no status value
        trackAlias: varint(1n),
        groupId: varint(0n),
        objectId: varint(0n),
        payload: new Uint8Array(0),
        // status: undefined — violates STATUS flag contract
      };

      expect(() => encodeObjectDatagram(datagram)).toThrow();
    });

    it('throws on EXTENSIONS flag with zero-length extensions in datagram (§10.3.1)', () => {
      // §10.3.1: "If the Extensions Length is zero, the endpoint MUST close
      // the session with 'PROTOCOL_VIOLATION'."
      const datagram: ObjectDatagram = {
        typeByte: DatagramFlags.EXTENSIONS,
        trackAlias: varint(1n),
        groupId: varint(0n),
        objectId: varint(0n),
        payload: new Uint8Array([0x01]),
        extensions: new Uint8Array(0), // Zero-length extensions
      };

      expect(() => encodeObjectDatagram(datagram)).toThrow();
    });
  });
});
