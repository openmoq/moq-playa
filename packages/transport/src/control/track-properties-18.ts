/**
 * draft-18 Track Properties codec (§2.5, §12).
 *
 * Track Properties are carried at the END of certain control messages — PUBLISH,
 * SUBSCRIBE_OK, FETCH_OK, and a TRACK_STATUS_OK (REQUEST_OK) — after the Message
 * Parameters block. The type-space is shared with data-object Properties.
 *
 * The wire form is a Key-Value-Pair list, but — unlike Message Parameters
 * (§10.2), which are Type-Delta + a registry-fixed value and reject unknown
 * Types — Properties are SELF-DESCRIBING by Type parity, so an unknown Property
 * can still be parsed (and is preserved), and there is no separate registry:
 *
 *   Property { Type Delta (vi64); [Length (vi64)]; Value }
 *     - Type (cumulative from delta) EVEN  → Value is a single vi64 (full uint64).
 *     - Type (cumulative from delta) ODD   → Length (vi64) + that many Value bytes
 *                                            (Length ≤ 2^16-1, else protocol error).
 *
 * The block is NOT count-prefixed: it spans the remaining message bytes, so an
 * EMPTY Track Properties block is zero bytes (the field is simply absent). All
 * integers are vi64 (NOT the QUIC-varint range), so values use raw `bigint`.
 *
 * @see draft-ietf-moq-transport-18 §2.5, §12
 * @module
 */

import { readVi64, writeVi64, vi64EncodingLength, MAX_VI64 } from '../primitives/vi64.js';
import { ProtocolViolationError } from '../errors.js';
import type { TrackExtensions } from './messages.js';

/** Max byte-value length for an odd-Type Property (§12). */
const MAX_PROPERTY_VALUE_BYTES = 0xffff;

/** A single Property's value, by the Type-parity rule (even → bigint, odd → bytes). */
type PropertyValue = bigint | Uint8Array;

/**
 * Properties defined for data OBJECTS only — they MUST NOT apply to Tracks (§2.5).
 * The type-space is shared and their KVP/value shape is perfectly valid, so this
 * is NOT a wire-format violation: their presence in a Track Properties block is a
 * MALFORMED TRACK, handled by the semantic layer (session/adapter), not the codec.
 * They are therefore decoded normally here; {@link hasObjectOnlyTrackProperty}
 * lets the semantic layer detect them.
 */
const OBJECT_ONLY_TRACK_PROPERTIES = new Set<bigint>([0x3cn, 0x3en]);

/** Whether `props` contains a data-Object-only Property (0x3C / 0x3E) — which,
 *  in a Track Properties block, means a malformed track (§2.5). */
export function hasObjectOnlyTrackProperty(props: TrackExtensions): boolean {
  for (const type of props.keys()) {
    if (OBJECT_ONLY_TRACK_PROPERTIES.has(type as bigint)) return true;
  }
  return false;
}

/**
 * Mandatory Track Property type range (§2.5.1): 0x4000–0x7FFF. These MUST be
 * understood or the track MUST NOT be processed/forwarded. We implement no
 * Mandatory Track Properties, so ANY type in this range is "unsupported".
 */
const MANDATORY_TRACK_PROPERTY_MIN = 0x4000n;
const MANDATORY_TRACK_PROPERTY_MAX = 0x7fffn;

/**
 * Whether `props` contains a Mandatory Track Property (0x4000–0x7FFF) this
 * endpoint does not understand (§2.5.1). Since no Mandatory Track Property is
 * implemented, any type in the range qualifies — the request MUST be rejected
 * (PUBLISH) or cancelled (SUBSCRIBE_OK / FETCH_OK), NOT processed or forwarded.
 */
export function hasUnsupportedMandatoryTrackProperty(props: TrackExtensions): boolean {
  for (const type of props.keys()) {
    const t = type as bigint;
    if (t >= MANDATORY_TRACK_PROPERTY_MIN && t <= MANDATORY_TRACK_PROPERTY_MAX) return true;
  }
  return false;
}

/**
 * Per-Type VALUE-FORMAT validation for KNOWN Track Properties (§2.5) — enforced by
 * the codec because an out-of-range value is a wire/value-format error. Unknown
 * Types and Object-only Types (wrong-scope, not wrong-format) pass through here.
 * All known Types below are even, so their value is a vi64 `bigint` (parity rule).
 *
 * @throws {ProtocolViolationError} for an out-of-range value on a known Track
 *   Property (DEFAULT_PUBLISHER_PRIORITY / DEFAULT_PUBLISHER_GROUP_ORDER /
 *   DYNAMIC_GROUPS).
 */
function assertTrackPropertySemantics(type: bigint, value: PropertyValue): void {
  switch (type) {
    case 0x0en: // DEFAULT_PUBLISHER_PRIORITY — a priority byte, 0..255
      if (typeof value !== 'bigint' || value < 0n || value > 255n) {
        throw new ProtocolViolationError(`DEFAULT_PUBLISHER_PRIORITY (0x0E) must be 0..255, got ${value}`);
      }
      break;
    case 0x22n: // DEFAULT_PUBLISHER_GROUP_ORDER — 1 (Ascending) or 2 (Descending)
      if (value !== 1n && value !== 2n) {
        throw new ProtocolViolationError(`DEFAULT_PUBLISHER_GROUP_ORDER (0x22) must be 1 or 2, got ${value}`);
      }
      break;
    case 0x30n: // DYNAMIC_GROUPS — boolean 0 or 1
      if (value !== 0n && value !== 1n) {
        throw new ProtocolViolationError(`DYNAMIC_GROUPS (0x30) must be 0 or 1, got ${value}`);
      }
      break;
  }
}

/** Flatten to ascending-Type, delta-encoded entries (duplicates preserved in order). */
interface FlatProperty {
  readonly type: bigint;
  readonly delta: bigint;
  readonly value: PropertyValue;
}

function flatten(props: TrackExtensions): FlatProperty[] {
  const entries = [...props.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: FlatProperty[] = [];
  let prev = 0n;
  for (const [typeKey, values] of entries) {
    const type = typeKey as bigint;
    if (type < 0n || type > MAX_VI64) {
      throw new ProtocolViolationError(`Track Property Type ${type} out of vi64 range`);
    }
    for (const value of values as readonly PropertyValue[]) {
      assertValueMatchesParity(type, value);
      assertTrackPropertySemantics(type, value);
      out.push({ type, delta: type - prev, value });
      prev = type;
    }
  }
  return out;
}

/** Even Type ⇒ vi64 value (bigint); odd Type ⇒ length-prefixed bytes (Uint8Array). */
function assertValueMatchesParity(type: bigint, value: PropertyValue): void {
  const odd = (type & 1n) === 1n;
  if (odd) {
    if (!(value instanceof Uint8Array)) {
      throw new ProtocolViolationError(`Odd Track Property Type 0x${type.toString(16)} expects a bytes value`);
    }
    if (value.length > MAX_PROPERTY_VALUE_BYTES) {
      throw new ProtocolViolationError(
        `Track Property value length ${value.length} exceeds maximum ${MAX_PROPERTY_VALUE_BYTES}`,
      );
    }
  } else if (typeof value !== 'bigint') {
    throw new ProtocolViolationError(`Even Track Property Type 0x${type.toString(16)} expects a varint value`);
  }
}

function propertyValueLength(type: bigint, value: PropertyValue): number {
  if ((type & 1n) === 1n) {
    const bytes = value as Uint8Array;
    return vi64EncodingLength(BigInt(bytes.length)) + bytes.length;
  }
  return vi64EncodingLength(value as bigint);
}

/** Wire length of the encoded Track Properties block (0 when empty). */
export function trackProperties18EncodingLength(props: TrackExtensions): number {
  let len = 0;
  for (const { type, delta, value } of flatten(props)) {
    len += vi64EncodingLength(delta) + propertyValueLength(type, value);
  }
  return len;
}

/** Encode a Track Properties block to its draft-18 wire form (empty → 0 bytes). */
export function encodeTrackProperties18(props: TrackExtensions): Uint8Array {
  const flat = flatten(props);
  const buf = new Uint8Array(
    flat.reduce((n, { type, delta, value }) => n + vi64EncodingLength(delta) + propertyValueLength(type, value), 0),
  );
  let p = 0;
  for (const { type, delta, value } of flat) {
    p += writeVi64(delta, buf, p);
    if ((type & 1n) === 1n) {
      const bytes = value as Uint8Array;
      p += writeVi64(BigInt(bytes.length), buf, p);
      buf.set(bytes, p);
      p += bytes.length;
    } else {
      p += writeVi64(value as bigint, buf, p);
    }
  }
  return buf;
}

/**
 * Decode a Track Properties block occupying `buf[offset..end)` (defaults to the
 * end of `buf`). Reads Property entries until the boundary; an EMPTY range yields
 * an empty map. Duplicate Types are preserved (multiple values under one key).
 *
 * @throws {ProtocolViolationError} on a Type above 2^64-1, an over-long byte
 *   value, or a truncated entry.
 */
export function decodeTrackProperties18(
  buf: Uint8Array,
  offset: number,
  end: number = buf.length,
): { properties: TrackExtensions; bytesRead: number } {
  const properties = new Map<bigint, PropertyValue[]>();
  let p = offset;
  let prevType = 0n;
  while (p < end) {
    const delta = readVi64(buf, p);
    p += delta.bytesRead;
    const type = prevType + delta.value;
    if (type > MAX_VI64) {
      throw new ProtocolViolationError(`Track Property Type ${type} exceeds 2^64-1`);
    }
    prevType = type;

    let value: PropertyValue;
    if ((type & 1n) === 1n) {
      const len = readVi64(buf, p);
      p += len.bytesRead;
      const n = Number(len.value);
      if (n > MAX_PROPERTY_VALUE_BYTES) {
        throw new ProtocolViolationError(`Track Property value length ${n} exceeds maximum ${MAX_PROPERTY_VALUE_BYTES}`);
      }
      if (p + n > end) {
        throw new ProtocolViolationError('Track Property bytes value exceeds the Track Properties block');
      }
      value = buf.slice(p, p + n);
      p += n;
    } else {
      const v = readVi64(buf, p);
      p += v.bytesRead;
      value = v.value;
    }
    // Reject known-but-invalid Track Properties (out-of-range / Object-only);
    // unknown Types pass through and are preserved.
    assertTrackPropertySemantics(type, value);

    const existing = properties.get(type);
    if (existing) existing.push(value);
    else properties.set(type, [value]);
  }
  return { properties, bytesRead: p - offset };
}
