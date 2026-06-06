/**
 * draft-18 data-plane decoders (vi64).
 *
 * Parallels the draft-14/16 `decoder.ts` but with vi64 integer fields and the
 * draft-18 type-byte layouts: the SUBGROUP_HEADER form 0b0XX1XXXX (incl. the
 * FIRST_OBJECT bit) and the OBJECT_DATAGRAM form 0b00X0XXXX. Object/datagram
 * Properties are length-prefixed (vi64); a PROPERTIES flag with an empty block
 * is rejected.
 *
 * Fetch decoding (§11.4.4) is a distinct format, NOT draft-16-with-vi64: the
 * Serialization Flags are vi64, Group ID Deltas are interpreted relative to the
 * requested Group Order (ascending/descending) with overflow/underflow checks,
 * and End-of-Range markers (0x8C / 0x10C) carry their own prior semantics.
 *
 * @see draft-ietf-moq-transport-18 §11.3 (datagrams), §11.4 (subgroups + fetch)
 * @module
 */

import { readVi64, MAX_VI64 } from '../primitives/vi64.js';
import { readUint8 } from '../primitives/bytes.js';
import { varint } from '../primitives/varint.js';
import { ProtocolViolationError } from '../errors.js';
import {
  SubgroupFlags18,
  DatagramFlags18,
  subgroupIdMode18,
  isSubgroupHeaderForm18,
  isValidSubgroupHeaderType18,
  isDatagramForm18,
  isValidDatagramType18,
} from './codes-18.js';
import { StreamType18 } from './codes-18.js';
import { FetchFlags, FetchSubgroupMode, FetchSpecialFlags } from './codes.js';
import type { SubgroupHeader, SubgroupObject, ObjectDatagram, FetchHeader, FetchObject, FetchEndOfRange, GroupOrder } from './types.js';
import type { DecodedFetchItem } from './decoder.js';

/** Subgroup-ID mode 0b10: an explicit Subgroup ID field follows (§11.4.2). */
const SUBGROUP_ID_MODE_EXPLICIT = 0b10;

/**
 * Object Status codes valid in draft-18 (§11.2.1.1): Normal (0x0), End of Group
 * (0x3), End of Track (0x4). Notably 0x1 (Object Does Not Exist) is draft-14-only
 * and MUST be rejected here. Any other value is a PROTOCOL_VIOLATION.
 */
const VALID_STATUS_18 = new Set<bigint>([0n, 0x3n, 0x4n]);

/** Validate a decoded Object Status against the draft-18 enumeration. */
function validateStatus18(status: bigint): void {
  if (!VALID_STATUS_18.has(status)) {
    throw new ProtocolViolationError(`Invalid draft-18 Object Status 0x${status.toString(16)}`);
  }
}

/**
 * Only Normal (0x0) objects may carry Properties (§11.2.1). A non-Normal status
 * with a non-empty Properties block is a PROTOCOL_VIOLATION. An empty block
 * (`undefined` here) is fine — zero-length subgroup objects legally omit them.
 */
function rejectPropertiesOnNonNormal(status: bigint, properties: Uint8Array | undefined): void {
  if (status !== 0n && properties !== undefined && properties.length > 0) {
    throw new ProtocolViolationError(
      `Properties present on a non-Normal status object (status 0x${status.toString(16)})`,
    );
  }
}

/** Read a vi64 length-prefixed byte block. */
function readVi64Bytes(buf: Uint8Array, offset: number): { value: Uint8Array; bytesRead: number } {
  const { value: len, bytesRead } = readVi64(buf, offset);
  const start = offset + bytesRead;
  const n = Number(len);
  if (start + n > buf.length) {
    throw new RangeError(`vi64 length-prefixed block (${n}) exceeds remaining buffer`);
  }
  return { value: buf.slice(start, start + n), bytesRead: bytesRead + n };
}

/** Decode a draft-18 SUBGROUP_HEADER. @throws on invalid form / reserved mode. */
export function decodeSubgroupHeader18(
  buf: Uint8Array,
  offset: number,
): { header: SubgroupHeader; bytesRead: number } {
  let pos = offset;
  const t = readVi64(buf, pos); pos += t.bytesRead;
  const typeByte = Number(t.value);
  if (!isSubgroupHeaderForm18(typeByte)) {
    throw new ProtocolViolationError(`Invalid SUBGROUP_HEADER type 0x${typeByte.toString(16)}`);
  }
  if (!isValidSubgroupHeaderType18(typeByte)) {
    throw new ProtocolViolationError(`SUBGROUP_HEADER uses the reserved subgroup-ID mode 0b11`);
  }

  const ta = readVi64(buf, pos); pos += ta.bytesRead;
  const gid = readVi64(buf, pos); pos += gid.bytesRead;

  let subgroupId: bigint;
  if (subgroupIdMode18(typeByte) === SUBGROUP_ID_MODE_EXPLICIT) {
    const sg = readVi64(buf, pos); pos += sg.bytesRead;
    subgroupId = sg.value;
  } else {
    // Mode 0b00 → Subgroup ID is 0. Mode 0b01 → Subgroup ID is the first
    // object's Object ID; we return 0 as a placeholder and the caller fills it
    // once the first object is decoded. (This is the SUBGROUP_ID_MODE field, not
    // the unrelated FIRST_OBJECT header bit.)
    subgroupId = 0n;
  }

  let publisherPriority: number | undefined;
  if ((typeByte & SubgroupFlags18.DEFAULT_PRIORITY) === 0) {
    publisherPriority = readUint8(buf, pos).value;
    pos += 1;
  }

  const header: SubgroupHeader = {
    typeByte,
    trackAlias: ta.value,
    groupId: gid.value,
    subgroupId,
    publisherPriority,
    hasExtensions: (typeByte & SubgroupFlags18.PROPERTIES) !== 0,
    isEndOfGroup: (typeByte & SubgroupFlags18.END_OF_GROUP) !== 0,
    isFirstObjectInSubgroup: (typeByte & SubgroupFlags18.FIRST_OBJECT) !== 0,
  };
  return { header, bytesRead: pos - offset };
}

/** Decode a draft-18 subgroup object. `hasProperties` comes from the header. */
export function decodeSubgroupObject18(
  buf: Uint8Array,
  offset: number,
  hasProperties: boolean,
  previousObjectId: bigint,
  isFirstObject: boolean = true,
): { object: SubgroupObject; bytesRead: number } {
  let pos = offset;
  const d = readVi64(buf, pos); pos += d.bytesRead;
  const objectId = isFirstObject ? d.value : previousObjectId + d.value + 1n;
  // §11.4.2: "If the resulting Object ID would be greater than 2^64 - 1, the
  // endpoint MUST close the session with a PROTOCOL_VIOLATION."
  if (objectId > MAX_VI64) {
    throw new ProtocolViolationError(
      `Subgroup Object ID overflow: ${objectId} exceeds 2^64 - 1 (prev ${previousObjectId} + delta ${d.value} + 1)`,
    );
  }

  // Subgroup objects always carry a Properties Length field when the header's
  // PROPERTIES bit is set, but that length MAY be 0 — objects with no properties
  // encode Properties Length = 0 (§11.4.2). Empty is NOT rejected here (unlike a
  // datagram's PROPERTIES flag, which is contradictory when empty).
  const props = readOptionalProperties(buf, pos, hasProperties, /*rejectEmpty*/ false);
  pos += props.bytesRead;

  const pl = readVi64(buf, pos); pos += pl.bytesRead;
  const n = Number(pl.value);

  let payload: Uint8Array;
  let status: bigint | undefined;
  if (n === 0) {
    payload = new Uint8Array(0);
    const st = readVi64(buf, pos); pos += st.bytesRead;
    status = st.value;
    validateStatus18(status);
    rejectPropertiesOnNonNormal(status, props.value);
  } else {
    if (pos + n > buf.length) throw new RangeError(`object payload (${n}) exceeds remaining buffer`);
    payload = buf.slice(pos, pos + n);
    pos += n;
  }

  return { object: { objectId, extensions: props.value, payload, status }, bytesRead: pos - offset };
}

/** Decode a draft-18 OBJECT_DATAGRAM. @throws on invalid form / flag combo. */
export function decodeObjectDatagram18(
  buf: Uint8Array,
  offset: number,
): { datagram: ObjectDatagram; bytesRead: number } {
  let pos = offset;
  const t = readVi64(buf, pos); pos += t.bytesRead;
  const typeByte = Number(t.value);
  if (!isDatagramForm18(typeByte)) {
    throw new ProtocolViolationError(`Invalid OBJECT_DATAGRAM type 0x${typeByte.toString(16)}`);
  }
  if (!isValidDatagramType18(typeByte)) {
    throw new ProtocolViolationError(`OBJECT_DATAGRAM sets both STATUS and END_OF_GROUP (0x${typeByte.toString(16)})`);
  }

  const ta = readVi64(buf, pos); pos += ta.bytesRead;
  const gid = readVi64(buf, pos); pos += gid.bytesRead;

  let objectId: bigint;
  if ((typeByte & DatagramFlags18.ZERO_OBJECT_ID) !== 0) {
    objectId = 0n;
  } else {
    const o = readVi64(buf, pos); pos += o.bytesRead;
    objectId = o.value;
  }

  let publisherPriority: number | undefined;
  if ((typeByte & DatagramFlags18.DEFAULT_PRIORITY) === 0) {
    publisherPriority = readUint8(buf, pos).value;
    pos += 1;
  }

  // A datagram's PROPERTIES flag asserts properties are present, so an empty
  // Properties block is contradictory and rejected.
  const extensions = readOptionalProperties(
    buf,
    pos,
    (typeByte & DatagramFlags18.PROPERTIES) !== 0,
    /*rejectEmpty*/ true,
  );
  pos += extensions.bytesRead;

  let status: bigint | undefined;
  let payload: Uint8Array;
  if ((typeByte & DatagramFlags18.STATUS) !== 0) {
    const st = readVi64(buf, pos); pos += st.bytesRead;
    status = st.value;
    validateStatus18(status);
    rejectPropertiesOnNonNormal(status, extensions.value);
    payload = new Uint8Array(0);
    // STATUS datagrams carry no payload; any remaining bytes are a violation.
    if (pos !== buf.length) {
      throw new ProtocolViolationError(`STATUS datagram has ${buf.length - pos} trailing payload byte(s)`);
    }
  } else {
    // Datagram payload runs to the end of the datagram (no length prefix).
    payload = buf.slice(pos);
    pos = buf.length;
  }

  return {
    datagram: {
      typeByte,
      trackAlias: ta.value,
      groupId: gid.value,
      objectId,
      publisherPriority,
      isEndOfGroup: (typeByte & DatagramFlags18.END_OF_GROUP) !== 0,
      extensions: extensions.value,
      payload,
      status,
    },
    bytesRead: pos - offset,
  };
}

/**
 * Read a vi64 length-prefixed Properties block when present.
 * @param rejectEmpty when true (datagrams), an empty block is a violation; when
 *   false (subgroup objects), an empty block is legal and yields `undefined`.
 */
function readOptionalProperties(
  buf: Uint8Array,
  offset: number,
  present: boolean,
  rejectEmpty: boolean,
): { value: Uint8Array | undefined; bytesRead: number } {
  if (!present) return { value: undefined, bytesRead: 0 };
  const r = readVi64Bytes(buf, offset);
  if (r.value.length === 0) {
    if (rejectEmpty) {
      throw new ProtocolViolationError('PROPERTIES flag set but the Properties block is empty');
    }
    return { value: undefined, bytesRead: r.bytesRead };
  }
  return { value: r.value, bytesRead: r.bytesRead };
}

// ─── FETCH data (§11.4.4) ───────────────────────────────────────────────

// GroupOrder now lives in the draft-neutral `types.js` (so the sans-I/O session
// core can reference it without importing this wire decoder). Re-exported here
// for backwards compatibility with callers importing it from this module.
export type { GroupOrder } from './types.js';

/**
 * Prior-object context threaded through a draft-18 FETCH stream. `groupId` /
 * `objectId` track the *position* of the last item (a normal object OR an
 * End-of-Range marker). `lastObjectSubgroupId` / `lastObjectPriority` come from
 * the last *actual object* only — an End-of-Range marker does not change them
 * (§11.4.4.2). Both are `undefined` until the first actual object is seen.
 */
export interface FetchObjectPrior18 {
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly lastObjectSubgroupId: bigint | undefined;
  readonly lastObjectPriority: number | undefined;
}

/** Decode a draft-18 FETCH_HEADER: Type (vi64) = 0x05, Request ID (vi64). */
export function decodeFetchHeader18(
  buf: Uint8Array,
  offset: number,
): { header: FetchHeader; bytesRead: number } {
  let pos = offset;
  const t = readVi64(buf, pos); pos += t.bytesRead;
  if (Number(t.value) !== StreamType18.FETCH_HEADER) {
    throw new ProtocolViolationError(
      `Invalid FETCH_HEADER type: expected 0x05, got 0x${t.value.toString(16)}`,
    );
  }
  const rid = readVi64(buf, pos); pos += rid.bytesRead;
  return { header: { requestId: rid.value }, bytesRead: pos - offset };
}

/** Whether a Serialization Flags value is an End-of-Range marker. */
function isEndOfRange18(flags: bigint): boolean {
  return flags === BigInt(FetchSpecialFlags.END_NON_EXISTENT) || flags === BigInt(FetchSpecialFlags.END_UNKNOWN);
}

/** Validate Serialization Flags: 0x00–0x7F, 0x8C, or 0x10C; else PROTOCOL_VIOLATION. */
function validateFetchFlags18(flags: bigint): void {
  if (isEndOfRange18(flags)) return;
  if (flags >= 0n && flags <= 0x7fn) return;
  throw new ProtocolViolationError(
    `Invalid draft-18 fetch Serialization Flags 0x${flags.toString(16)} (allowed: 0x00-0x7F, 0x8C, 0x10C)`,
  );
}

/**
 * Decode a single object (or End-of-Range marker) from a draft-18 FETCH stream.
 *
 * Returns the decoded item, bytes consumed, and the `nextPrior` to thread into
 * the following call. `groupOrder` is the FETCH's requested Group Order; it is
 * Ascending by default when the request omitted GROUP_ORDER (§11.4.4.1).
 *
 * @see draft-ietf-moq-transport-18 §11.4.4
 */
export function decodeFetchObject18(
  buf: Uint8Array,
  offset: number,
  prior: FetchObjectPrior18 | undefined,
  isFirstObject: boolean,
  groupOrder: GroupOrder,
): { item: DecodedFetchItem; bytesRead: number; nextPrior: FetchObjectPrior18 } {
  let pos = offset;
  const fl = readVi64(buf, pos); pos += fl.bytesRead;
  const flags = fl.value;
  validateFetchFlags18(flags);

  // ── End-of-Range marker (§11.4.4.2) ──────────────────────────────────
  if (isEndOfRange18(flags)) {
    const gid = readVi64(buf, pos); pos += gid.bytesRead;
    const oid = readVi64(buf, pos); pos += oid.bytesRead;
    const pl = readVi64(buf, pos); pos += pl.bytesRead;
    // §11.4.4.2: an End-of-Range marker carries no Object Payload — the always-
    // present Object Payload Length MUST be 0.
    if (pl.value !== 0n) {
      throw new ProtocolViolationError(`End-of-Range marker has a non-zero payload length (${pl.value})`);
    }
    const item: FetchEndOfRange = {
      flags: varint(flags),
      groupId: gid.value,
      objectId: oid.value,
      nonExistent: flags === BigInt(FetchSpecialFlags.END_NON_EXISTENT),
    };
    // Position prior comes from the marker; field priors are UNCHANGED.
    const nextPrior: FetchObjectPrior18 = {
      groupId: gid.value,
      objectId: oid.value,
      lastObjectSubgroupId: prior?.lastObjectSubgroupId,
      lastObjectPriority: prior?.lastObjectPriority,
    };
    return { item, bytesRead: pos - offset, nextPrior };
  }

  // ── Normal object ────────────────────────────────────────────────────
  const numFlags = Number(flags);
  const isDatagram = (numFlags & FetchFlags.DATAGRAM) !== 0;
  const groupPresent = (numFlags & FetchFlags.GROUP_ID) !== 0;
  const objectPresent = (numFlags & FetchFlags.OBJECT_ID) !== 0;
  const priorityPresent = (numFlags & FetchFlags.PRIORITY) !== 0;
  const propertiesPresent = (numFlags & FetchFlags.EXTENSIONS) !== 0;
  const subgroupMode = numFlags & FetchFlags.SUBGROUP_MODE_MASK;

  if (isFirstObject) {
    // §11.4.4: the first object MUST carry absolute Group/Object deltas and MUST
    // NOT reference any prior-object field.
    if (!groupPresent || !objectPresent) {
      throw new ProtocolViolationError('First fetch object must include Group ID Delta and Object ID Delta');
    }
    if (!priorityPresent) {
      throw new ProtocolViolationError('First fetch object cannot inherit Priority from a prior object');
    }
    if (!isDatagram && (subgroupMode === FetchSubgroupMode.PRIOR || subgroupMode === FetchSubgroupMode.PRIOR_PLUS_ONE)) {
      throw new ProtocolViolationError('First fetch object cannot inherit Subgroup ID from a prior object');
    }
  } else if (prior === undefined) {
    // A non-first object derives Group/Object/Subgroup/Priority from the prior
    // object; without one there is nothing to derive from. Fail cleanly rather
    // than dereferencing an undefined prior.
    throw new ProtocolViolationError('Non-first fetch object requires prior-object context');
  }

  // Group ID
  let groupId: bigint;
  if (groupPresent) {
    const gd = readVi64(buf, pos); pos += gd.bytesRead;
    if (isFirstObject) {
      groupId = gd.value; // absolute
    } else if (groupOrder === 'ascending') {
      groupId = prior!.groupId + gd.value + 1n;
      if (groupId > MAX_VI64) {
        throw new ProtocolViolationError(`Fetch Group ID overflow (ascending): ${groupId} > 2^64-1`);
      }
    } else {
      const step = gd.value + 1n;
      if (step > prior!.groupId) {
        throw new ProtocolViolationError(`Fetch Group ID underflow (descending): ${prior!.groupId} - ${step} < 0`);
      }
      groupId = prior!.groupId - step;
    }
  } else {
    groupId = prior!.groupId; // not first (guaranteed by validation)
  }

  // Subgroup ID
  let subgroupId: bigint;
  if (isDatagram) {
    subgroupId = 0n; // §11.4.4.1: Datagram forwarding preference has no Subgroup
  } else {
    switch (subgroupMode) {
      case FetchSubgroupMode.ZERO:
        subgroupId = 0n;
        break;
      case FetchSubgroupMode.PRIOR:
      case FetchSubgroupMode.PRIOR_PLUS_ONE: {
        if (prior?.lastObjectSubgroupId === undefined) {
          throw new ProtocolViolationError('Fetch object references prior Subgroup ID but no prior actual object exists');
        }
        if (subgroupMode === FetchSubgroupMode.PRIOR_PLUS_ONE) {
          subgroupId = prior.lastObjectSubgroupId + 1n;
          if (subgroupId > MAX_VI64) {
            throw new ProtocolViolationError(`Fetch Subgroup ID overflow: ${subgroupId} > 2^64-1`);
          }
        } else {
          subgroupId = prior.lastObjectSubgroupId;
        }
        break;
      }
      default: { // EXPLICIT
        const sg = readVi64(buf, pos); pos += sg.bytesRead;
        subgroupId = sg.value;
        break;
      }
    }
  }

  // Object ID (§11.4.4 three-case prose)
  let objectId: bigint;
  if (objectPresent) {
    const od = readVi64(buf, pos); pos += od.bytesRead;
    if (isFirstObject || groupPresent) {
      objectId = od.value; // absolute (first object, or first in a new group)
    } else {
      objectId = prior!.objectId + od.value;
      if (objectId > MAX_VI64) throw new ProtocolViolationError(`Fetch Object ID overflow: ${objectId} > 2^64-1`);
    }
  } else {
    objectId = prior!.objectId + 1n;
    if (objectId > MAX_VI64) throw new ProtocolViolationError(`Fetch Object ID overflow: ${objectId} > 2^64-1`);
  }

  // Priority
  let publisherPriority: number | undefined;
  if (priorityPresent) {
    publisherPriority = readUint8(buf, pos).value;
    pos += 1;
  } else {
    if (prior?.lastObjectPriority === undefined) {
      throw new ProtocolViolationError('Fetch object references prior Priority but no prior actual object exists');
    }
    publisherPriority = prior.lastObjectPriority;
  }

  // Properties
  const props = readOptionalProperties(buf, pos, propertiesPresent, /*rejectEmpty*/ false);
  pos += props.bytesRead;

  // Payload
  const pl = readVi64(buf, pos); pos += pl.bytesRead;
  const n = Number(pl.value);
  if (pos + n > buf.length) throw new RangeError(`Fetch object payload (${n}) exceeds remaining buffer`);
  const payload = buf.slice(pos, pos + n);
  pos += n;

  const item: FetchObject = {
    flags: varint(flags),
    groupId,
    subgroupId,
    objectId,
    publisherPriority,
    isDatagram,
    extensions: props.value,
    payload,
  };
  const nextPrior: FetchObjectPrior18 = {
    groupId,
    objectId,
    // §11.4.4.1: a Datagram-form fetch object has NO Subgroup ID, so a following
    // object using subgroup mode PRIOR/PRIOR_PLUS_ONE must NOT inherit from it —
    // record `undefined`, not the fabricated 0 used for delivery.
    lastObjectSubgroupId: isDatagram ? undefined : subgroupId,
    lastObjectPriority: publisherPriority,
  };
  return { item, bytesRead: pos - offset, nextPrior };
}
