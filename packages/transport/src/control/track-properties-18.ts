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

import {
  decodePropertyBlock,
  encodePropertyBlock,
  propertyBlockEncodingLength,
  PropertyWireError,
  type PropertyEntry,
} from '../primitives/property-block.js';
import { ProtocolViolationError } from '../errors.js';
import type { TrackExtensions } from './messages.js';

/** The shared property-wire core carries these draft-18 Properties as vi64. */
const D18_PROFILE = 'd18-delta-vi64' as const;

/** A single Property's value, by the Type-parity rule (even → bigint, odd → bytes). */
type PropertyValue = bigint | Uint8Array;

/**
 * Track Properties are a MUST-close protocol element, so a wire-format violation
 * surfaced by the generic core (a categorised {@link PropertyWireError}) is
 * re-raised as a {@link ProtocolViolationError} — the class the session layer
 * closes on. A plain `RangeError` (a truncated vi64 read) propagates unchanged,
 * matching the historical behaviour of this codec.
 */
function asTrackViolation(err: unknown): never {
  if (err instanceof PropertyWireError) throw new ProtocolViolationError(err.message);
  throw err;
}

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

/**
 * Build the ordered entry list the core encodes from, applying the
 * track-specific value validation the generic core does not (and must not) do:
 * the per-Type semantic ranges (§2.5) for known Track Properties. Generic parity,
 * the 2^16-1 odd-value limit, delta-overflow and canonical ordering are the
 * core's responsibility.
 */
function prepareForEncode(props: TrackExtensions): PropertyEntry[] {
  const out: PropertyEntry[] = [];
  for (const [typeKey, values] of props.entries()) {
    const type = typeKey as bigint;
    for (const value of values as readonly PropertyValue[]) {
      assertTrackPropertySemantics(type, value);
      out.push({ id: type, value });
    }
  }
  return out;
}

/** Wire length of the encoded Track Properties block (0 when empty). */
export function trackProperties18EncodingLength(props: TrackExtensions): number {
  try {
    return propertyBlockEncodingLength(prepareForEncode(props), D18_PROFILE);
  } catch (err) {
    asTrackViolation(err);
  }
}

/** Encode a Track Properties block to its draft-18 wire form (empty → 0 bytes). */
export function encodeTrackProperties18(props: TrackExtensions): Uint8Array {
  try {
    return encodePropertyBlock(prepareForEncode(props), D18_PROFILE);
  } catch (err) {
    asTrackViolation(err);
  }
}

/**
 * Decode a Track Properties block occupying `buf[offset..end)` (defaults to the
 * end of `buf`). Reads Property entries until the boundary; an EMPTY range yields
 * an empty map. Duplicate Types are preserved (multiple values under one key).
 *
 * @throws {ProtocolViolationError} on a Type above 2^64-1, an over-long byte
 *   value, or an out-of-range known Track Property value.
 * @throws {RangeError} on a truncated vi64 (an out-of-bounds read).
 */
export function decodeTrackProperties18(
  buf: Uint8Array,
  offset: number,
  end: number = buf.length,
): { properties: TrackExtensions; bytesRead: number } {
  const decoded = ((): { entries: PropertyEntry[]; bytesRead: number } => {
    try {
      return decodePropertyBlock(buf, offset, { profile: D18_PROFILE, end });
    } catch (err) {
      asTrackViolation(err);
    }
  })();
  const properties = new Map<bigint, PropertyValue[]>();
  for (const { id, value } of decoded.entries) {
    // Reject known-but-invalid Track Properties (out-of-range / Object-only);
    // unknown Types pass through and are preserved.
    assertTrackPropertySemantics(id, value);
    const existing = properties.get(id);
    if (existing) existing.push(value);
    else properties.set(id, [value]);
  }
  return { properties, bytesRead: decoded.bytesRead };
}
