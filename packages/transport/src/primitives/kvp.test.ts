import { describe, it, expect } from 'vitest';
import {
  readKvpList,
  writeKvpList,
  kvpListEncodingLength,
  readKvpListAbsolute,
  writeKvpListAbsolute,
  kvpListAbsoluteEncodingLength,
  kvpListEntryCount,
  findDuplicateKey,
  type KvpValue,
} from './kvp.js';
import { varint, type Varint } from './varint.js';

describe('KVP encoding', () => {
  function roundTrip(params: Map<Varint, KvpValue[]>): Map<Varint, KvpValue[]> {
    const len = kvpListEncodingLength(params);
    const buf = new Uint8Array(len + 20);
    const written = writeKvpList(params, buf, 0);
    expect(written).toBe(len);
    const count = kvpListEntryCount(params);
    const { value, bytesRead } = readKvpList(buf, 0, count);
    expect(bytesRead).toBe(len);
    return value;
  }

  it('round-trips an empty KVP list', () => {
    const params = new Map<Varint, KvpValue[]>();
    const result = roundTrip(params);
    expect(result.size).toBe(0);
  });

  it('round-trips a single varint KVP (even type)', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(0x02), [varint(500)]); // DELIVERY_TIMEOUT = 500ms
    const result = roundTrip(params);
    expect(result.size).toBe(1);
    expect(result.get(varint(0x02))?.[0]).toBe(500n);
  });

  it('round-trips a single bytes KVP (odd type)', () => {
    const params = new Map<Varint, KvpValue[]>();
    const tokenData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    params.set(varint(0x03), [tokenData]); // AUTHORIZATION_TOKEN
    const result = roundTrip(params);
    expect(result.size).toBe(1);
    expect(result.get(varint(0x03))?.[0]).toEqual(tokenData);
  });

  it('round-trips multiple KVPs with delta encoding', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(0x02), [varint(1000)]);  // type 2, even → varint
    params.set(varint(0x03), [new Uint8Array([0x01, 0x02])]); // type 3, odd → bytes
    params.set(varint(0x20), [varint(128)]);   // type 0x20 (32), even → varint
    const result = roundTrip(params);
    expect(result.size).toBe(3);
    expect(result.get(varint(0x02))?.[0]).toBe(1000n);
    expect(result.get(varint(0x03))?.[0]).toEqual(new Uint8Array([0x01, 0x02]));
    expect(result.get(varint(0x20))?.[0]).toBe(128n);
  });

  it('uses delta encoding for Types', () => {
    // Types 2 and 4 → deltas are 2 and 2
    // If delta encoding works, the second delta should be 2, not 4
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(2), [varint(10)]);
    params.set(varint(4), [varint(20)]);
    const buf = new Uint8Array(50);
    const written = writeKvpList(params, buf, 0);

    // First KVP: delta=2 (varint 1byte), value=10 (varint 1byte) → 2 bytes
    // Second KVP: delta=2 (varint 1byte), value=20 (varint 1byte) → 2 bytes
    // Total: 4 bytes
    expect(written).toBe(4);
  });

  it('reads from a non-zero offset', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(0x02), [varint(42)]);
    const buf = new Uint8Array(30);
    buf[0] = 0xff; // junk
    buf[1] = 0xff; // junk
    const written = writeKvpList(params, buf, 2);
    const { value, bytesRead } = readKvpList(buf, 2, 1);
    expect(bytesRead).toBe(written);
    expect(value.get(varint(0x02))?.[0]).toBe(42n);
  });

  it('handles zero-length bytes value for odd type', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(0x01), [new Uint8Array(0)]); // odd type, empty bytes
    const result = roundTrip(params);
    expect(result.get(varint(0x01))?.[0]).toEqual(new Uint8Array(0));
  });

  it('throws if odd-type bytes value exceeds 2^16-1', () => {
    const params = new Map<Varint, KvpValue[]>();
    const tooBig = new Uint8Array(65536); // 2^16 bytes — one more than max
    params.set(varint(0x03), [tooBig]);
    expect(() => {
      const buf = new Uint8Array(70000);
      writeKvpList(params, buf, 0);
    }).toThrow(RangeError);
  });

  it('accepts odd-type bytes value at exactly 2^16-1', () => {
    const params = new Map<Varint, KvpValue[]>();
    const maxSize = new Uint8Array(65535); // 2^16 - 1 = max allowed
    params.set(varint(0x03), [maxSize]);
    // Should not throw
    const len = kvpListEncodingLength(params);
    const buf = new Uint8Array(len);
    expect(() => writeKvpList(params, buf, 0)).not.toThrow();
  });
});

describe('KVP decoding bounds checks', () => {
  it('readKvpList throws if odd-type bytes value length exceeds 2^16-1', () => {
    // Hand-craft a buffer with odd type (0x01) and length = 65536 (exceeds 2^16-1)
    // Need full payload for readLengthPrefixedBytes to return all bytes
    const payloadSize = 65536;
    const buf = new Uint8Array(1 + 4 + payloadSize); // type(1) + length-varint(4) + payload

    let pos = 0;
    // Type delta = 1 (odd type)
    buf[pos++] = 0x01;
    // Length = 65536 as 4-byte varint
    // 4-byte varint format: 10xxxxxx xxxxxxxx xxxxxxxx xxxxxxxx (30 bits of value)
    // 65536 = 0x10000
    buf[pos++] = 0x80; // 10 prefix + high 6 bits (0)
    buf[pos++] = 0x01; // next 8 bits (0x01)
    buf[pos++] = 0x00; // next 8 bits (0x00)
    buf[pos++] = 0x00; // low 8 bits (0x00)
    // Payload bytes (zeros are fine)

    expect(() => readKvpList(buf, 0, 1)).toThrow(RangeError);
  });

  it('readKvpList accepts odd-type bytes value at exactly 2^16-1', () => {
    // Construct buffer with type=1 (odd), length=65535, and 65535 bytes of payload
    const payloadSize = 65535;
    const buf = new Uint8Array(1 + 4 + payloadSize); // type(1) + length-varint(4) + payload

    let pos = 0;
    // Type delta = 1 (odd type)
    buf[pos++] = 0x01;
    // Length = 65535 as 4-byte varint
    // 65535 = 0xFFFF
    buf[pos++] = 0x80; // 10 prefix + high 6 bits (0)
    buf[pos++] = 0x00; // next 8 bits (0x00)
    buf[pos++] = 0xFF; // next 8 bits (0xFF)
    buf[pos++] = 0xFF; // low 8 bits (0xFF)
    // Payload bytes (zeros are fine)

    expect(() => readKvpList(buf, 0, 1)).not.toThrow();
  });
});

describe('KVP duplicate parameter support', () => {
  it('collects duplicate types into arrays', () => {
    // Hand-craft a buffer with duplicate parameter types
    // Two parameters with same absolute type (delta 2, then delta 0 → same type 2)
    // First: delta=2, value=10
    // Second: delta=0, value=20 (absolute type still 2)
    const buf = new Uint8Array([
      0x02, // delta = 2 (type 2, even)
      0x0A, // value = 10
      0x00, // delta = 0 (type still 2)
      0x14, // value = 20
    ]);

    const { value } = readKvpList(buf, 0, 2);
    expect(value.size).toBe(1); // Only one key
    const values = value.get(varint(2));
    expect(values).toHaveLength(2);
    expect(values?.[0]).toBe(10n);
    expect(values?.[1]).toBe(20n);
  });

  it('findDuplicateKey returns duplicate key', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(2), [varint(10), varint(20)]); // Multiple values = duplicate
    params.set(varint(4), [varint(30)]); // Single value = no duplicate

    expect(findDuplicateKey(params)).toBe(2n);
  });

  it('findDuplicateKey returns undefined when no duplicates', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(2), [varint(10)]);
    params.set(varint(4), [varint(20)]);

    expect(findDuplicateKey(params)).toBeUndefined();
  });

  it('allows different types (no duplicate)', () => {
    // Types 2 and 4 (different absolute types)
    const buf = new Uint8Array([
      0x02, // delta = 2 (type 2, even)
      0x0A, // value = 10
      0x02, // delta = 2 (type 4, even) - different from type 2
      0x14, // value = 20
    ]);

    const { value } = readKvpList(buf, 0, 2);
    expect(value.size).toBe(2);
    expect(value.get(varint(2))?.[0]).toBe(10n);
    expect(value.get(varint(4))?.[0]).toBe(20n);
  });
});

/**
 * Draft-14 KVP absolute encoding tests.
 *
 * Draft-14 §1.4.2 uses absolute Type values:
 *   Key-Value-Pair { Type (i), [Length (i),] Value (..) }
 *
 * Draft-16 §1.4.2 changed to delta-encoded Type values:
 *   Key-Value-Pair { Delta Type (i), [Length (i),] Value (..) }
 *
 * The even/odd rule and Length/Value semantics are identical in both drafts.
 *
 * @see draft-ietf-moq-transport-14 §1.4.2
 */
describe('KVP absolute encoding (draft-14)', () => {
  function roundTripAbsolute(params: Map<Varint, KvpValue[]>): Map<Varint, KvpValue[]> {
    const len = kvpListAbsoluteEncodingLength(params);
    const buf = new Uint8Array(len + 20);
    const written = writeKvpListAbsolute(params, buf, 0);
    expect(written).toBe(len);
    const count = kvpListEntryCount(params);
    const { value, bytesRead } = readKvpListAbsolute(buf, 0, count);
    expect(bytesRead).toBe(len);
    return value;
  }

  it('round-trips an empty KVP list', () => {
    const params = new Map<Varint, KvpValue[]>();
    const result = roundTripAbsolute(params);
    expect(result.size).toBe(0);
  });

  it('round-trips a single varint KVP (even type)', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(0x02), [varint(500)]);
    const result = roundTripAbsolute(params);
    expect(result.size).toBe(1);
    expect(result.get(varint(0x02))?.[0]).toBe(500n);
  });

  it('round-trips a single bytes KVP (odd type)', () => {
    const params = new Map<Varint, KvpValue[]>();
    const tokenData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    params.set(varint(0x03), [tokenData]);
    const result = roundTripAbsolute(params);
    expect(result.size).toBe(1);
    expect(result.get(varint(0x03))?.[0]).toEqual(tokenData);
  });

  it('writes absolute type values, not deltas', () => {
    // Types 2 and 4 → absolute encoding writes 2 then 4
    // Delta encoding would write 2 then 2
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(2), [varint(10)]);
    params.set(varint(4), [varint(20)]);
    const buf = new Uint8Array(50);
    writeKvpListAbsolute(params, buf, 0);

    // First KVP: type=2, value=10
    expect(buf[0]).toBe(0x02); // absolute type 2
    expect(buf[1]).toBe(0x0A); // value 10
    // Second KVP: type=4 (NOT delta 2), value=20
    expect(buf[2]).toBe(0x04); // absolute type 4
    expect(buf[3]).toBe(0x14); // value 20
  });

  it('reads absolute type values, not deltas', () => {
    // Hand-craft buffer with absolute types 2 and 4
    const buf = new Uint8Array([
      0x02, // absolute type 2 (even → varint value)
      0x0A, // value = 10
      0x04, // absolute type 4 (even → varint value)
      0x14, // value = 20
    ]);

    const { value } = readKvpListAbsolute(buf, 0, 2);
    expect(value.size).toBe(2);
    expect(value.get(varint(2))?.[0]).toBe(10n);
    expect(value.get(varint(4))?.[0]).toBe(20n);
  });

  it('round-trips multiple KVPs with mixed even/odd types', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(0x02), [varint(1000)]);
    params.set(varint(0x03), [new Uint8Array([0x01, 0x02])]);
    params.set(varint(0x20), [varint(128)]);
    const result = roundTripAbsolute(params);
    expect(result.size).toBe(3);
    expect(result.get(varint(0x02))?.[0]).toBe(1000n);
    expect(result.get(varint(0x03))?.[0]).toEqual(new Uint8Array([0x01, 0x02]));
    expect(result.get(varint(0x20))?.[0]).toBe(128n);
  });

  it('encoding length differs from delta encoding for non-zero types', () => {
    // With types 2 and 0x20 (32):
    // Delta: delta=2(1byte) + delta=30(1byte) = both 1-byte type fields
    // Absolute: type=2(1byte) + type=32(1byte) = both 1-byte type fields
    // But with types 2 and 0x100 (256):
    // Delta: delta=2(1byte) + delta=254(2bytes) = 3 bytes for type fields
    // Absolute: type=2(1byte) + type=256(2bytes) = 3 bytes for type fields
    // Actually for large gaps they're the same. The difference shows with
    // small absolute types after large ones — but KVPs are sorted ascending.
    // The real difference: duplicate keys. Delta=0 for same key vs absolute type repeated.
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(2), [varint(10), varint(20)]); // duplicate key
    const deltaLen = kvpListEncodingLength(params);
    const absLen = kvpListAbsoluteEncodingLength(params);
    // Delta: first delta=2(1byte)+val(1byte), second delta=0(1byte)+val(1byte) = 4
    // Absolute: first type=2(1byte)+val(1byte), second type=2(1byte)+val(1byte) = 4
    // Same here! But for types > 63 (2-byte varint), duplicates cost more in absolute.
    // Let's use a larger type to show the difference clearly:
    const params2 = new Map<Varint, KvpValue[]>();
    params2.set(varint(0x100), [varint(10), varint(20)]); // type 256, duplicate
    const deltaLen2 = kvpListEncodingLength(params2);
    const absLen2 = kvpListAbsoluteEncodingLength(params2);
    // Delta: first delta=256(2bytes)+val(1byte), second delta=0(1byte)+val(1byte) = 5
    // Absolute: first type=256(2bytes)+val(1byte), second type=256(2bytes)+val(1byte) = 6
    expect(absLen2).toBeGreaterThan(deltaLen2);
  });

  it('reads from a non-zero offset', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(0x02), [varint(42)]);
    const buf = new Uint8Array(30);
    buf[0] = 0xff;
    buf[1] = 0xff;
    const written = writeKvpListAbsolute(params, buf, 2);
    const { value, bytesRead } = readKvpListAbsolute(buf, 2, 1);
    expect(bytesRead).toBe(written);
    expect(value.get(varint(0x02))?.[0]).toBe(42n);
  });
});

describe('kvpListEntryCount', () => {
  it('counts total entries across all keys', () => {
    const params = new Map<Varint, KvpValue[]>();
    params.set(varint(2), [varint(10), varint(20)]); // 2 entries
    params.set(varint(4), [varint(30)]); // 1 entry

    expect(kvpListEntryCount(params)).toBe(3);
  });

  it('returns 0 for empty map', () => {
    const params = new Map<Varint, KvpValue[]>();
    expect(kvpListEntryCount(params)).toBe(0);
  });
});
