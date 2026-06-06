/**
 * draft-18 data-plane encoders (vi64) — the publisher counterpart to
 * `decoder-18.ts`. Produces bytes the draft-18 decoders accept: vi64 integer
 * fields, the 0b0XX1XXXX SUBGROUP_HEADER form, vi64-length-prefixed Properties,
 * and the 0b00X0XXXX OBJECT_DATAGRAM form.
 *
 * Scope is the subscriber-acceptance happy path: SUBGROUP_HEADER + objects and a
 * single OBJECT_DATAGRAM. Fetch encoding is not part of this increment.
 *
 * @see draft-ietf-moq-transport-18 §11.3 (datagrams), §11.4 (subgroups)
 * @module
 */

import { writeVi64, vi64EncodingLength, MAX_VI64 } from '../primitives/vi64.js';
import { DatagramFlags18, SubgroupFlags18, subgroupIdMode18 } from './codes-18.js';
import { FetchFlags, FetchSpecialFlags, FetchSubgroupMode } from './codes.js';
import type { SubgroupHeader, SubgroupObject, ObjectDatagram, GroupOrder } from './types.js';
import type { FetchObjectPrior18 } from './decoder-18.js';
import { StreamType18 } from './codes-18.js';

/** Subgroup-ID mode 0b10: an explicit Subgroup ID field is present (§11.4.2). */
const SUBGROUP_ID_MODE_EXPLICIT = 0b10;

/** Encode a draft-18 SUBGROUP_HEADER. */
export function encodeSubgroupHeader18(header: SubgroupHeader): Uint8Array {
  const explicit = subgroupIdMode18(header.typeByte) === SUBGROUP_ID_MODE_EXPLICIT;
  const flagDefaultPriority = (header.typeByte & SubgroupFlags18.DEFAULT_PRIORITY) !== 0;

  // Reject contradictory direct inputs that would otherwise be silently dropped or
  // emit invalid wire. A non-explicit subgroup-ID mode carries NO Subgroup ID field
  // (mode 0b00 → 0; 0b01 → derived from the first object), so a meaningful value here
  // would be dropped.
  if (!explicit && header.subgroupId !== 0n) {
    throw new Error('SUBGROUP_HEADER: a non-explicit subgroup-ID mode must not carry a meaningful subgroupId (use 0n)');
  }
  // publisherPriority presence MUST match the DEFAULT_PRIORITY flag (XOR): the flag
  // means "omit, use subscription priority"; its absence means a priority byte follows.
  if (flagDefaultPriority === (header.publisherPriority !== undefined)) {
    throw new Error('SUBGROUP_HEADER: publisherPriority presence must match the DEFAULT_PRIORITY (0x20) flag (set ⇒ omit, clear ⇒ provide)');
  }
  const hasPriority = !flagDefaultPriority; // guaranteed defined when the flag is clear

  let size = vi64EncodingLength(BigInt(header.typeByte));
  size += vi64EncodingLength(header.trackAlias);
  size += vi64EncodingLength(header.groupId);
  if (explicit) size += vi64EncodingLength(header.subgroupId);
  if (hasPriority) size += 1;

  const buf = new Uint8Array(size);
  let p = writeVi64(BigInt(header.typeByte), buf, 0);
  p += writeVi64(header.trackAlias, buf, p);
  p += writeVi64(header.groupId, buf, p);
  if (explicit) p += writeVi64(header.subgroupId, buf, p);
  if (hasPriority) buf[p++] = header.publisherPriority!;
  return buf;
}

/**
 * Encode a single draft-18 subgroup object. `hasProperties` mirrors the header's
 * PROPERTIES bit; when set, a Properties Length is always written (0 if none).
 */
export function encodeSubgroupObject18(
  object: SubgroupObject,
  hasProperties: boolean,
  previousObjectId: bigint,
  isFirstObject: boolean = true,
): Uint8Array {
  if (object.status !== undefined && object.payload.length > 0) {
    throw new Error('SubgroupObject: status is only valid on empty payloads');
  }
  // The stream's PROPERTIES bit (hasProperties) governs whether a Properties block
  // is written. Supplying extensions when the bit is clear would silently drop them.
  if (!hasProperties && object.extensions !== undefined && object.extensions.length > 0) {
    throw new Error('SubgroupObject: extensions provided but the stream PROPERTIES bit is not set');
  }
  const delta = isFirstObject ? object.objectId : object.objectId - previousObjectId - 1n;
  const props = hasProperties ? (object.extensions ?? new Uint8Array(0)) : undefined;
  const n = object.payload.length;
  const status = n === 0 ? (object.status ?? 0n) : undefined;

  let size = vi64EncodingLength(delta);
  if (props !== undefined) size += vi64EncodingLength(BigInt(props.length)) + props.length;
  size += vi64EncodingLength(BigInt(n));
  if (status !== undefined) size += vi64EncodingLength(status);
  else size += n;

  const buf = new Uint8Array(size);
  let p = writeVi64(delta, buf, 0);
  if (props !== undefined) {
    p += writeVi64(BigInt(props.length), buf, p);
    buf.set(props, p); p += props.length;
  }
  p += writeVi64(BigInt(n), buf, p);
  if (status !== undefined) {
    p += writeVi64(status, buf, p);
  } else {
    buf.set(object.payload, p); p += n;
  }
  return buf;
}

/** Encode a draft-18 OBJECT_DATAGRAM. */
export function encodeObjectDatagram18(datagram: ObjectDatagram): Uint8Array {
  const t = datagram.typeByte;
  const zeroObject = (t & DatagramFlags18.ZERO_OBJECT_ID) !== 0;
  const flagDefaultPriority = (t & DatagramFlags18.DEFAULT_PRIORITY) !== 0;
  const hasProps = (t & DatagramFlags18.PROPERTIES) !== 0;
  const hasStatus = (t & DatagramFlags18.STATUS) !== 0;

  // Reject contradictory direct inputs rather than emitting ambiguous/invalid wire
  // bytes by silently dropping a field whose flag is absent (or vice versa). The
  // type byte is the single source of truth for which fields are on the wire.
  if (hasStatus && datagram.payload.length > 0) {
    throw new Error('OBJECT_DATAGRAM: a STATUS object MUST have an empty payload');
  }
  if (!hasStatus && datagram.status !== undefined) {
    throw new Error('OBJECT_DATAGRAM: status provided without the STATUS (0x20) type flag');
  }
  if (zeroObject && datagram.objectId !== 0n) {
    throw new Error('OBJECT_DATAGRAM: ZERO_OBJECT_ID (0x04) requires objectId === 0n');
  }
  // publisherPriority presence MUST match the DEFAULT_PRIORITY flag (XOR): the flag
  // means "omit, use subscription priority"; its absence means a priority byte follows.
  if (flagDefaultPriority === (datagram.publisherPriority !== undefined)) {
    throw new Error('OBJECT_DATAGRAM: publisherPriority presence must match the DEFAULT_PRIORITY (0x08) flag (set ⇒ omit, clear ⇒ provide)');
  }
  if (!hasProps && datagram.extensions !== undefined && datagram.extensions.length > 0) {
    throw new Error('OBJECT_DATAGRAM: extensions provided without the PROPERTIES (0x01) type flag');
  }
  // Unlike a subgroup object (where an empty Properties block, length 0, is legal),
  // a datagram's PROPERTIES flag asserts a NON-empty block — the decoder rejects an
  // empty one (§11.3.1), so reject it here rather than emit bytes the peer will refuse.
  if (hasProps && (datagram.extensions === undefined || datagram.extensions.length === 0)) {
    throw new Error('OBJECT_DATAGRAM: PROPERTIES (0x01) flag set but extensions are empty');
  }

  const hasPriority = !flagDefaultPriority; // guaranteed defined when the flag is clear
  const props = hasProps ? (datagram.extensions ?? new Uint8Array(0)) : undefined;

  let size = vi64EncodingLength(BigInt(t));
  size += vi64EncodingLength(datagram.trackAlias);
  size += vi64EncodingLength(datagram.groupId);
  if (!zeroObject) size += vi64EncodingLength(datagram.objectId);
  if (hasPriority) size += 1;
  if (props !== undefined) size += vi64EncodingLength(BigInt(props.length)) + props.length;
  if (hasStatus) size += vi64EncodingLength(datagram.status ?? 0n);
  else size += datagram.payload.length;

  const buf = new Uint8Array(size);
  let p = writeVi64(BigInt(t), buf, 0);
  p += writeVi64(datagram.trackAlias, buf, p);
  p += writeVi64(datagram.groupId, buf, p);
  if (!zeroObject) p += writeVi64(datagram.objectId, buf, p);
  if (hasPriority) buf[p++] = datagram.publisherPriority!;
  if (props !== undefined) {
    p += writeVi64(BigInt(props.length), buf, p);
    buf.set(props, p); p += props.length;
  }
  if (hasStatus) {
    p += writeVi64(datagram.status ?? 0n, buf, p);
  } else {
    buf.set(datagram.payload, p); p += datagram.payload.length;
  }
  return buf;
}

// ─── FETCH data (§11.4.4) ───────────────────────────────────────────────

/** Encode a draft-18 FETCH_HEADER: Type (vi64) = 0x05, Request ID (vi64). */
export function encodeFetchHeader18(requestId: bigint): Uint8Array {
  const buf = new Uint8Array(vi64EncodingLength(BigInt(StreamType18.FETCH_HEADER)) + vi64EncodingLength(requestId));
  let p = writeVi64(BigInt(StreamType18.FETCH_HEADER), buf, 0);
  writeVi64(requestId, buf, p);
  return buf;
}

/** A normal fetch object's absolute fields (status/properties deferred). */
export interface FetchObjectFields {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly publisherPriority: number;
  readonly payload: Uint8Array;
}

/**
 * Encode a normal draft-18 fetch object using §11.4.4 serialization flags and
 * the threaded prior state. The encoding is deterministic: subgroup ID and
 * priority are always explicit; a new group writes a Group ID Delta interpreted
 * by `groupOrder`; the same group writes a relative Object ID Delta.
 *
 * @returns the bytes plus the `nextPrior` to thread into the following object.
 */
export function encodeFetchObject18(
  fields: FetchObjectFields,
  prior: FetchObjectPrior18 | undefined,
  isFirstObject: boolean,
  groupOrder: GroupOrder,
): { bytes: Uint8Array; nextPrior: FetchObjectPrior18 } {
  const { groupId, subgroupId, objectId, publisherPriority, payload } = fields;
  const newGroup = isFirstObject || groupId !== prior!.groupId;

  // Subgroup ID explicit (mode 0b11), Object ID Delta + Priority always present.
  let flags = FetchSubgroupMode.EXPLICIT | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY;

  let groupDelta: bigint | undefined;
  let objDelta: bigint;
  if (newGroup) {
    flags |= FetchFlags.GROUP_ID;
    if (isFirstObject) {
      groupDelta = groupId; // absolute
    } else if (groupOrder === 'ascending') {
      groupDelta = groupId - prior!.groupId - 1n;
    } else {
      groupDelta = prior!.groupId - groupId - 1n;
    }
    if (groupDelta < 0n || groupDelta > MAX_VI64) {
      throw new Error(`fetch Group ID Delta out of range for ${groupOrder} order`);
    }
    objDelta = objectId; // group present → object delta is absolute
  } else {
    objDelta = objectId - prior!.objectId; // group absent → prior + delta
    if (objDelta < 0n) throw new Error('fetch Object ID must not decrease within a group');
  }

  const n = payload.length;
  let size = vi64EncodingLength(BigInt(flags));
  if (groupDelta !== undefined) size += vi64EncodingLength(groupDelta);
  size += vi64EncodingLength(subgroupId);
  size += vi64EncodingLength(objDelta);
  size += 1; // priority
  size += vi64EncodingLength(BigInt(n));
  size += n; // payload bytes (0 when empty — a normal fetch object carries no status)

  const buf = new Uint8Array(size);
  let p = writeVi64(BigInt(flags), buf, 0);
  if (groupDelta !== undefined) p += writeVi64(groupDelta, buf, p);
  p += writeVi64(subgroupId, buf, p);
  p += writeVi64(objDelta, buf, p);
  buf[p++] = publisherPriority;
  p += writeVi64(BigInt(n), buf, p);
  // §11.4.4: a normal fetch object is Payload Length + payload bytes. It has NO
  // Object Status field (unlike subgroup/datagram objects) — fetch status / end
  // markers are End-of-Range (0x8C / 0x10C). An empty payload is just length 0.
  buf.set(payload, p); p += n;

  const nextPrior: FetchObjectPrior18 = {
    groupId, objectId, lastObjectSubgroupId: subgroupId, lastObjectPriority: publisherPriority,
  };
  return { bytes: buf, nextPrior };
}

/**
 * Encode a draft-18 End-of-Range marker (§11.4.4.2): Serialization Flags 0x8C
 * (non-existent) or 0x10C (unknown), Group ID, Object ID, and a zero Payload
 * Length. Position prior advances to the marker; field priors are unchanged.
 */
export function encodeFetchEndOfRange18(
  nonExistent: boolean,
  groupId: bigint,
  objectId: bigint,
  prior: FetchObjectPrior18 | undefined,
): { bytes: Uint8Array; nextPrior: FetchObjectPrior18 } {
  const flags = BigInt(nonExistent ? FetchSpecialFlags.END_NON_EXISTENT : FetchSpecialFlags.END_UNKNOWN);
  const size = vi64EncodingLength(flags) + vi64EncodingLength(groupId) + vi64EncodingLength(objectId) + vi64EncodingLength(0n);
  const buf = new Uint8Array(size);
  let p = writeVi64(flags, buf, 0);
  p += writeVi64(groupId, buf, p);
  p += writeVi64(objectId, buf, p);
  writeVi64(0n, buf, p); // §11.4.4.2: payload length MUST be 0
  const nextPrior: FetchObjectPrior18 = {
    groupId, objectId,
    lastObjectSubgroupId: prior?.lastObjectSubgroupId,
    lastObjectPriority: prior?.lastObjectPriority,
  };
  return { bytes: buf, nextPrior };
}
