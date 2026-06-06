/**
 * Key-Value-Pair encoding per draft-ietf-moq-transport-16 §1.4.2.
 *
 * Type values are delta-encoded from previous.
 * If absolute Type is even → Value is a single varint.
 * If absolute Type is odd → Value is Length (varint) + bytes.
 *
 * Note: Parameters are stored as Map<bigint, KvpValue[]> to support
 * multiple values per type (e.g., AUTHORIZATION_TOKEN in setup, §9.3.1.5).
 *
 * @module
 */

import { readVarint, writeVarint, varint, varintEncodingLength, type Varint } from './varint.js';
import { readLengthPrefixedBytes, writeLengthPrefixedBytes, lengthPrefixedBytesEncodingLength } from './bytes.js';

export type KvpValue = Varint | Uint8Array;

/**
 * Read a list of Key-Value-Pairs.
 * Returns a Map where each key maps to an array of values to support
 * duplicate parameter types (e.g., multiple AUTHORIZATION_TOKEN in setup).
 *
 * @see draft-ietf-moq-transport-16 §1.4.2
 */
export function readKvpList(
  buf: Uint8Array,
  offset: number,
  count: number,
): { value: Map<bigint, KvpValue[]>; bytesRead: number } {
  const result = new Map<bigint, KvpValue[]>();
  let pos = offset;
  let prevType = 0n;

  for (let i = 0; i < count; i++) {
    const { value: delta, bytesRead: deltaBytes } = readVarint(buf, pos);
    pos += deltaBytes;

    const absType = prevType + delta;
    prevType = absType;
    const key = varint(absType);

    let val: KvpValue;
    if (absType % 2n === 0n) {
      // Even type → value is a single varint
      const { value: v, bytesRead: valBytes } = readVarint(buf, pos);
      pos += valBytes;
      val = v;
    } else {
      // Odd type → value is length-prefixed bytes
      const { value: v, bytesRead: valBytes } = readLengthPrefixedBytes(buf, pos);
      if (v.length > 0xffff) {
        throw new RangeError(
          `KVP byte value length ${v.length} exceeds maximum 65535 (2^16-1)`,
        );
      }
      pos += valBytes;
      val = v;
    }

    // Collect into array (supports duplicates)
    const existing = result.get(key);
    if (existing) {
      existing.push(val);
    } else {
      result.set(key, [val]);
    }
  }

  return { value: result, bytesRead: pos - offset };
}

/**
 * Write a list of Key-Value-Pairs with delta-encoded types.
 * Params map has keys mapping to arrays of values.
 * @returns bytes written
 */
export function writeKvpList(
  params: Map<bigint, KvpValue[]>,
  buf: Uint8Array,
  offset: number,
): number {
  let pos = offset;
  let prevType = 0n;

  // Sort keys to ensure ascending order for delta encoding
  const sortedKeys = [...params.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const key of sortedKeys) {
    const values = params.get(key)!;

    for (const val of values) {
      const delta = varint(key - prevType);
      prevType = key;

      pos += writeVarint(delta, buf, pos);

      if (key % 2n === 0n) {
        // Even type → write value as varint
        pos += writeVarint(val as Varint, buf, pos);
      } else {
        // Odd type → write value as length-prefixed bytes
        const bytes = val as Uint8Array;
        if (bytes.length > 0xffff) {
          throw new RangeError(
            `KVP byte value length ${bytes.length} exceeds maximum 65535 (2^16-1)`,
          );
        }
        pos += writeLengthPrefixedBytes(bytes, buf, pos);
      }
    }
  }

  return pos - offset;
}

/** Calculate encoding length for a KVP list. */
export function kvpListEncodingLength(params: Map<bigint, KvpValue[]>): number {
  let len = 0;
  let prevType = 0n;

  const sortedKeys = [...params.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const key of sortedKeys) {
    const values = params.get(key)!;

    for (const val of values) {
      const delta = varint(key - prevType);
      prevType = key;

      len += varintEncodingLength(delta);

      if (key % 2n === 0n) {
        len += varintEncodingLength(val as Varint);
      } else {
        len += lengthPrefixedBytesEncodingLength(val as Uint8Array);
      }
    }
  }

  return len;
}

/**
 * Read a list of Key-Value-Pairs with absolute (non-delta) type values.
 *
 * Draft-14 §1.4.2 uses absolute Type values:
 *   Key-Value-Pair { Type (i), [Length (i),] Value (..) }
 *
 * @see draft-ietf-moq-transport-14 §1.4.2
 */
export function readKvpListAbsolute(
  buf: Uint8Array,
  offset: number,
  count: number,
): { value: Map<bigint, KvpValue[]>; bytesRead: number } {
  const result = new Map<bigint, KvpValue[]>();
  let pos = offset;

  for (let i = 0; i < count; i++) {
    const { value: absType, bytesRead: typeBytes } = readVarint(buf, pos);
    pos += typeBytes;

    const key = varint(absType);

    let val: KvpValue;
    if (absType % 2n === 0n) {
      const { value: v, bytesRead: valBytes } = readVarint(buf, pos);
      pos += valBytes;
      val = v;
    } else {
      const { value: v, bytesRead: valBytes } = readLengthPrefixedBytes(buf, pos);
      if (v.length > 0xffff) {
        throw new RangeError(
          `KVP byte value length ${v.length} exceeds maximum 65535 (2^16-1)`,
        );
      }
      pos += valBytes;
      val = v;
    }

    const existing = result.get(key);
    if (existing) {
      existing.push(val);
    } else {
      result.set(key, [val]);
    }
  }

  return { value: result, bytesRead: pos - offset };
}

/**
 * Write a list of Key-Value-Pairs with absolute (non-delta) type values.
 *
 * @see draft-ietf-moq-transport-14 §1.4.2
 * @returns bytes written
 */
export function writeKvpListAbsolute(
  params: Map<bigint, KvpValue[]>,
  buf: Uint8Array,
  offset: number,
): number {
  let pos = offset;

  const sortedKeys = [...params.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const key of sortedKeys) {
    const values = params.get(key)!;

    for (const val of values) {
      pos += writeVarint(key, buf, pos);

      if (key % 2n === 0n) {
        pos += writeVarint(val as Varint, buf, pos);
      } else {
        const bytes = val as Uint8Array;
        if (bytes.length > 0xffff) {
          throw new RangeError(
            `KVP byte value length ${bytes.length} exceeds maximum 65535 (2^16-1)`,
          );
        }
        pos += writeLengthPrefixedBytes(bytes, buf, pos);
      }
    }
  }

  return pos - offset;
}

/**
 * Calculate encoding length for an absolute-typed KVP list.
 *
 * @see draft-ietf-moq-transport-14 §1.4.2
 */
export function kvpListAbsoluteEncodingLength(params: Map<bigint, KvpValue[]>): number {
  let len = 0;

  const sortedKeys = [...params.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const key of sortedKeys) {
    const values = params.get(key)!;

    for (const _val of values) {
      len += varintEncodingLength(key);

      if (key % 2n === 0n) {
        len += varintEncodingLength(_val as Varint);
      } else {
        len += lengthPrefixedBytesEncodingLength(_val as Uint8Array);
      }
    }
  }

  return len;
}

/**
 * Count total number of KVP entries (for wire format count field).
 */
export function kvpListEntryCount(params: Map<bigint, KvpValue[]>): number {
  let count = 0;
  for (const values of params.values()) {
    count += values.length;
  }
  return count;
}

/**
 * Check if a KVP list has any duplicate keys.
 * Used for message parameter validation (§9.2 requires no duplicates).
 * @returns The first duplicate key found, or undefined if no duplicates
 */
export function findDuplicateKey(params: Map<bigint, KvpValue[]>): bigint | undefined {
  for (const [key, values] of params) {
    if (values.length > 1) {
      return key;
    }
  }
  return undefined;
}
