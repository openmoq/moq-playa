/**
 * Key-Value-Pair encoding per draft-ietf-moq-transport-16 §1.4.2 (delta) and
 * draft-14 §1.4.2 (absolute).
 *
 * Type values are delta-encoded from previous (draft-16) or absolute (draft-14).
 * If absolute Type is even → Value is a single varint.
 * If absolute Type is odd → Value is Length (varint) + bytes.
 *
 * This is a thin adapter over the shared ordered property-wire core
 * ({@link ./property-block.js}): the wire mechanics (delta accumulation, QUIC
 * varint coding, odd-value framing, order/duplicate preservation, the 2^16-1
 * odd-value limit, and range rejection) live there and are shared with the
 * draft-18 Track Properties codec. This layer only adapts the ordered
 * `PropertyMap` to the historical `Map<bigint, KvpValue[]>` shape — which groups
 * by Type to support multiple values per Type (e.g. AUTHORIZATION_TOKEN in
 * setup, §9.3.1.5) — and back.
 *
 * @module
 */

import { varint, type Varint } from './varint.js';
import {
  decodePropertyBlock,
  encodePropertyBlock,
  propertyBlockEncodingLength,
  type PropertyEntry,
  type PropertyWireProfile,
} from './property-block.js';

export type KvpValue = Varint | Uint8Array;

/** Group an ordered property list into the historical Map, preserving occurrence
 *  order within each key's value array; even values are re-branded `Varint`
 *  (safe: the QUIC-varint profiles cannot decode a value above 2^62-1). */
function groupEntries(entries: readonly PropertyEntry[]): Map<bigint, KvpValue[]> {
  const result = new Map<bigint, KvpValue[]>();
  for (const { id, value } of entries) {
    const val: KvpValue = typeof value === 'bigint' ? varint(value) : value;
    const existing = result.get(id);
    if (existing) existing.push(val);
    else result.set(id, [val]);
  }
  return result;
}

/** Flatten the historical Map to an ordered property list (the core canonicalises
 *  the order on encode, so ascending-key order is not required here). */
function flattenParams(params: Map<bigint, KvpValue[]>): PropertyEntry[] {
  const out: PropertyEntry[] = [];
  for (const [id, values] of params) {
    for (const value of values) out.push({ id, value });
  }
  return out;
}

function readList(
  buf: Uint8Array,
  offset: number,
  count: number,
  profile: PropertyWireProfile,
): { value: Map<bigint, KvpValue[]>; bytesRead: number } {
  const { entries, bytesRead } = decodePropertyBlock(buf, offset, { profile, count });
  return { value: groupEntries(entries), bytesRead };
}

function writeList(
  params: Map<bigint, KvpValue[]>,
  buf: Uint8Array,
  offset: number,
  profile: PropertyWireProfile,
): number {
  const bytes = encodePropertyBlock(flattenParams(params), profile);
  buf.set(bytes, offset);
  return bytes.length;
}

/**
 * Read a list of Key-Value-Pairs (draft-16 delta-encoded Types).
 * Returns a Map where each key maps to an array of values to support duplicate
 * parameter Types (e.g. multiple AUTHORIZATION_TOKEN in setup).
 *
 * @see draft-ietf-moq-transport-16 §1.4.2
 */
export function readKvpList(
  buf: Uint8Array,
  offset: number,
  count: number,
): { value: Map<bigint, KvpValue[]>; bytesRead: number } {
  return readList(buf, offset, count, 'd16-delta-varint');
}

/**
 * Write a list of Key-Value-Pairs with delta-encoded types (draft-16).
 * @returns bytes written
 */
export function writeKvpList(
  params: Map<bigint, KvpValue[]>,
  buf: Uint8Array,
  offset: number,
): number {
  return writeList(params, buf, offset, 'd16-delta-varint');
}

/** Calculate encoding length for a delta-encoded KVP list (draft-16). */
export function kvpListEncodingLength(params: Map<bigint, KvpValue[]>): number {
  return propertyBlockEncodingLength(flattenParams(params), 'd16-delta-varint');
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
  return readList(buf, offset, count, 'd14-absolute-varint');
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
  return writeList(params, buf, offset, 'd14-absolute-varint');
}

/**
 * Calculate encoding length for an absolute-typed KVP list.
 *
 * @see draft-ietf-moq-transport-14 §1.4.2
 */
export function kvpListAbsoluteEncodingLength(params: Map<bigint, KvpValue[]>): number {
  return propertyBlockEncodingLength(flattenParams(params), 'd14-absolute-varint');
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
