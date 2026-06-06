/**
 * Data plane decoders.
 * @see draft-ietf-moq-transport-16 §10
 * @module
 */

import { readVarint, varint, type Varint } from '../primitives/varint.js';
import { readUint8 } from '../primitives/bytes.js';
import { ProtocolViolationError } from '../errors.js';
import {
  DataStreamType,
  SubgroupFlags,
  DatagramFlags,
  ObjectStatus,
  FetchFlags,
  FetchSubgroupMode,
  FetchSpecialFlags,
  isSubgroupHeaderType,
  isDatagramType,
  isValidSubgroupIdMode,
  isValidDatagramFlags,
  getSubgroupIdMode,
  SubgroupIdMode,
} from './codes.js';
import type {
  SubgroupHeader,
  SubgroupObject,
  FetchHeader,
  FetchObject,
  FetchEndOfRange,
  ObjectDatagram,
} from './types.js';

/**
 * Valid Object Status codes per §10.2.1.1.
 *
 * Draft-16: 0x0 (Normal), 0x3 (END_OF_GROUP), 0x4 (END_OF_TRACK).
 * Draft-14: also includes 0x1 (OBJECT_DOES_NOT_EXIST).
 *
 * @see draft-ietf-moq-transport-16 §10.2.1.1
 * @see draft-ietf-moq-transport-14 §10.2.1.1
 */
const VALID_STATUS_CODES_V16 = new Set([
  ObjectStatus.NORMAL,
  ObjectStatus.END_OF_GROUP,
  ObjectStatus.END_OF_TRACK,
]);

const VALID_STATUS_CODES_V14 = new Set([
  ObjectStatus.NORMAL,
  ObjectStatus.OBJECT_DOES_NOT_EXIST,
  ObjectStatus.END_OF_GROUP,
  ObjectStatus.END_OF_TRACK,
]);

/**
 * Validate that a status code is one of the allowed values for the given draft version.
 * @throws {ProtocolViolationError} If status is not valid for the version
 */
function validateObjectStatus(status: Varint, version: 14 | 16 = 16): void {
  const validCodes = version === 14 ? VALID_STATUS_CODES_V14 : VALID_STATUS_CODES_V16;
  if (!validCodes.has(status)) {
    const allowed = version === 14 ? '0x0, 0x1, 0x3, 0x4' : '0x0, 0x3, 0x4';
    throw new ProtocolViolationError(
      `Invalid Object Status code: 0x${status.toString(16)} (allowed: ${allowed})`,
    );
  }
}

/**
 * Decode a SUBGROUP_HEADER from a data stream.
 * @param buf Buffer containing the header
 * @param offset Starting position
 * @returns Decoded header and bytes consumed
 * @throws {Error} If type byte is invalid or uses reserved mode
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export function decodeSubgroupHeader(
  buf: Uint8Array,
  offset: number,
  version: 14 | 16 = 16,
): { header: SubgroupHeader; bytesRead: number } {
  let pos = offset;

  // Read type byte (varint, but typically 1 byte)
  const { value: typeVarint, bytesRead: typeBytes } = readVarint(buf, pos);
  pos += typeBytes;
  const typeByte = Number(typeVarint);

  // Validate type byte
  if (!isSubgroupHeaderType(typeByte, version)) {
    throw new ProtocolViolationError(
      `Invalid SUBGROUP_HEADER type byte: 0x${typeByte.toString(16)}`,
    );
  }

  // Check for reserved subgroup ID mode
  if (!isValidSubgroupIdMode(typeByte)) {
    throw new ProtocolViolationError(
      `Reserved subgroup ID mode (0b11) in type byte: 0x${typeByte.toString(16)}`,
    );
  }

  // Read track alias
  const { value: trackAlias, bytesRead: taBytes } = readVarint(buf, pos);
  pos += taBytes;

  // Read group ID
  const { value: groupId, bytesRead: gidBytes } = readVarint(buf, pos);
  pos += gidBytes;

  // Read subgroup ID based on mode
  const mode = getSubgroupIdMode(typeByte);
  let subgroupId: Varint;

  if (mode === SubgroupIdMode.EXPLICIT) {
    // Mode 2: explicit subgroup ID field
    const { value: sgid, bytesRead: sgidBytes } = readVarint(buf, pos);
    pos += sgidBytes;
    subgroupId = sgid;
  } else {
    // Modes 0 (ZERO) and 1 (FIRST_OBJECT) both produce subgroupId=0.
    // For ZERO, 0 is the final value. For FIRST_OBJECT, 0 is a placeholder
    // that the caller overwrites when the first object is decoded.
    // Keeping the two modes collapsed here — a separate branch on
    // `mode === ZERO` would be behaviorally indistinguishable from its
    // sibling (both set subgroupId=0), which Stryker flags as an
    // equivalent-mutant survivor. Collapsing removes the noise.
    subgroupId = varint(0);
  }

  // Read publisher priority.
  // Draft-14 §10.4.2: Publisher Priority is always present.
  // Draft-16: only present when DEFAULT_PRIORITY bit is NOT set.
  let publisherPriority: number | undefined;
  if (version === 14 || (typeByte & SubgroupFlags.DEFAULT_PRIORITY) === 0) {
    const { value: prio } = readUint8(buf, pos);
    pos += 1;
    publisherPriority = prio;
  }

  // Extract flags
  const hasExtensions = (typeByte & SubgroupFlags.EXTENSIONS) !== 0;
  const isEndOfGroup = (typeByte & SubgroupFlags.END_OF_GROUP) !== 0;

  const header: SubgroupHeader = {
    typeByte,
    trackAlias,
    groupId,
    subgroupId,
    publisherPriority,
    hasExtensions,
    isEndOfGroup,
  };

  return { header, bytesRead: pos - offset };
}

/**
 * Decode a single object from a subgroup stream.
 * @param buf Buffer containing the object
 * @param offset Starting position
 * @param hasExtensions Whether extensions are present (from header)
 * @param previousObjectId Previous object ID for delta calculation
 * @param isFirstObject True if this is the first object in the subgroup
 * @returns Decoded object and bytes consumed
 * @throws {RangeError} If extension or payload length exceeds buffer
 * @throws {Error} If extensions length is 0 when EXTENSIONS flag set, or invalid status
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export function decodeSubgroupObject(
  buf: Uint8Array,
  offset: number,
  hasExtensions: boolean,
  previousObjectId: bigint,
  isFirstObject: boolean = true,
  version: 14 | 16 = 16,
): { object: SubgroupObject; bytesRead: number } {
  let pos = offset;

  // Read object ID delta
  const { value: delta, bytesRead: deltaBytes } = readVarint(buf, pos);
  pos += deltaBytes;

  // Compute actual object ID
  // First object: ID = delta
  // Subsequent: ID = previousObjectId + delta + 1
  let objectId: Varint;
  if (isFirstObject) {
    objectId = delta;
  } else {
    objectId = varint(previousObjectId + delta + 1n);
  }

  // Read extensions if present
  // §10.4.2: "Objects with no extensions set Extension Headers Length to 0"
  let extensions: Uint8Array | undefined;
  let extensionsLength = 0;
  if (hasExtensions) {
    const { value: extLen, bytesRead: extLenBytes } = readVarint(buf, pos);
    pos += extLenBytes;
    extensionsLength = Number(extLen);

    // Bounds check
    if (pos + extensionsLength > buf.length) {
      throw new RangeError(
        `Extension length ${extensionsLength} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }

    extensions = buf.slice(pos, pos + extensionsLength);
    pos += extensionsLength;
  }

  // Read payload length
  const { value: payloadLen, bytesRead: plBytes } = readVarint(buf, pos);
  pos += plBytes;
  const numPayloadLen = Number(payloadLen);

  // Read status if payload length is 0, otherwise read payload
  let payload: Uint8Array;
  let status: Varint | undefined;

  if (numPayloadLen === 0) {
    payload = new Uint8Array(0);
    const { value: st, bytesRead: stBytes } = readVarint(buf, pos);
    pos += stBytes;
    status = st;

    // Validate status code (version-aware: draft-14 allows 0x1)
    validateObjectStatus(status, version);

    // §10.2.1.2: Extensions on non-Normal status objects is PROTOCOL_VIOLATION
    if (extensionsLength > 0 && status !== ObjectStatus.NORMAL) {
      throw new ProtocolViolationError(
        `Extensions present on status object (status=0x${status.toString(16)}) per §10.2.1.2`,
      );
    }
  } else {
    // Bounds check for payload
    if (pos + numPayloadLen > buf.length) {
      throw new RangeError(
        `Payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }

    payload = buf.slice(pos, pos + numPayloadLen);
    pos += numPayloadLen;
  }

  const object: SubgroupObject = {
    objectId,
    extensions,
    payload,
    status,
  };

  return { object, bytesRead: pos - offset };
}

/**
 * Decode a FETCH_HEADER from a data stream.
 * @param buf Buffer containing the header
 * @param offset Starting position
 * @returns Decoded header and bytes consumed
 * @throws {Error} If type byte is not FETCH_HEADER (0x05)
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export function decodeFetchHeader(
  buf: Uint8Array,
  offset: number,
): { header: FetchHeader; bytesRead: number } {
  let pos = offset;

  // Read type byte
  const { value: typeVarint, bytesRead: typeBytes } = readVarint(buf, pos);
  pos += typeBytes;
  const typeByte = Number(typeVarint);

  if (typeByte !== DataStreamType.FETCH_HEADER) {
    throw new ProtocolViolationError(
      `Invalid FETCH_HEADER type byte: expected 0x05, got 0x${typeByte.toString(16)}`,
    );
  }

  // Read request ID
  const { value: requestId, bytesRead: ridBytes } = readVarint(buf, pos);
  pos += ridBytes;

  const header: FetchHeader = { requestId };

  return { header, bytesRead: pos - offset };
}

/**
 * Context for tracking prior object state in fetch streams.
 * Used for field inheritance when flags don't include explicit fields.
 */
export interface FetchPriorContext {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly priority?: number;
}

/**
 * Discriminated result type for fetch object decoding.
 * Either a normal FetchObject or a FetchEndOfRange marker.
 */
export type DecodedFetchItem = FetchObject | FetchEndOfRange;

/**
 * Check if serialization flags represent an End of Range marker.
 */
function isEndOfRangeFlags(flags: Varint): boolean {
  return (
    flags === BigInt(FetchSpecialFlags.END_NON_EXISTENT) ||
    flags === BigInt(FetchSpecialFlags.END_UNKNOWN)
  );
}

/**
 * Validate that serialization flags are in allowed range.
 * Valid: 0x00-0x7F, 0x8C, 0x10C. All else is PROTOCOL_VIOLATION.
 * @throws {Error} If flags are invalid
 */
function validateFetchFlags(flags: Varint): void {
  // Special flags
  if (isEndOfRangeFlags(flags)) {
    return;
  }

  // Normal flags: 0x00-0x7F
  if (flags >= 0n && flags <= 0x7fn) {
    return;
  }

  throw new ProtocolViolationError(
    `Invalid fetch serialization flags 0x${flags.toString(16)} (allowed: 0x00-0x7F, 0x8C, 0x10C)`,
  );
}

/**
 * Validate that first object doesn't try to inherit fields.
 * Per §10.4.4.1 Table 6: any flag that references prior object is PROTOCOL_VIOLATION.
 * @throws {Error} If first object has inheritance flags set
 */
function validateFirstFetchObject(flags: Varint): void {
  const numFlags = Number(flags);
  const isDatagram = (numFlags & FetchFlags.DATAGRAM) !== 0;

  // GROUP_ID must be present (absent = "prior Object's Group ID")
  if ((numFlags & FetchFlags.GROUP_ID) === 0) {
    throw new ProtocolViolationError(
      `First fetch object cannot inherit Group ID (GROUP_ID flag must be set)`,
    );
  }

  // OBJECT_ID must be present (absent = "prior Object's Object ID + 1")
  if ((numFlags & FetchFlags.OBJECT_ID) === 0) {
    throw new ProtocolViolationError(
      `First fetch object cannot inherit Object ID (OBJECT_ID flag must be set)`,
    );
  }

  // PRIORITY must be present (absent = "prior Object's Priority" per Table 6)
  if ((numFlags & FetchFlags.PRIORITY) === 0) {
    throw new ProtocolViolationError(
      `First fetch object cannot inherit Priority (PRIORITY flag must be set)`,
    );
  }

  // Subgroup mode 1 or 2 requires prior object (unless DATAGRAM flag ignores subgroup)
  if (!isDatagram) {
    const subgroupMode = numFlags & FetchFlags.SUBGROUP_MODE_MASK;
    if (subgroupMode === FetchSubgroupMode.PRIOR || subgroupMode === FetchSubgroupMode.PRIOR_PLUS_ONE) {
      throw new ProtocolViolationError(
        `First fetch object cannot inherit Subgroup ID (subgroup mode ${subgroupMode} requires prior object)`,
      );
    }
  }
}

/**
 * Decode a single object from a fetch stream.
 * @param buf Buffer containing the object
 * @param offset Starting position
 * @param prior Context from prior object for inheritance (undefined for first object)
 * @param isFirstObject True if this is the first object in the fetch stream
 * @returns Decoded item (FetchObject or FetchEndOfRange) and bytes consumed
 * @throws {RangeError} If extension or payload length exceeds buffer
 * @throws {Error} If flags are invalid or first object tries to inherit
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export function decodeFetchObject(
  buf: Uint8Array,
  offset: number,
  prior: FetchPriorContext | undefined,
  isFirstObject: boolean,
): { item: DecodedFetchItem; bytesRead: number } {
  let pos = offset;

  // Read serialization flags
  const { value: flags, bytesRead: flagsBytes } = readVarint(buf, pos);
  pos += flagsBytes;

  // Validate flags are in allowed range
  validateFetchFlags(flags);

  // Handle End of Range markers (§10.4.4.2)
  // Group ID and Object ID are present; Subgroup/Priority/Extensions are NOT present
  // Object Payload Length is still present per §10.4.4 (always present in Fetch objects)
  if (isEndOfRangeFlags(flags)) {
    // Read Group ID and Object ID
    const { value: groupId, bytesRead: gidBytes } = readVarint(buf, pos);
    pos += gidBytes;

    const { value: objectId, bytesRead: oidBytes } = readVarint(buf, pos);
    pos += oidBytes;

    // Read Object Payload Length (should be 0 for End of Range, but must be present)
    const { value: payloadLen, bytesRead: plBytes } = readVarint(buf, pos);
    pos += plBytes;

    // End of Range should have no payload - warn if non-zero but still consume it
    const numPayloadLen = Number(payloadLen);
    if (numPayloadLen > 0) {
      // Bounds check and skip payload if present
      if (pos + numPayloadLen > buf.length) {
        throw new RangeError(
          `End of Range payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
        );
      }
      pos += numPayloadLen;
    }

    const endOfRange: FetchEndOfRange = {
      flags,
      groupId,
      objectId,
      nonExistent: flags === BigInt(FetchSpecialFlags.END_NON_EXISTENT),
    };

    return { item: endOfRange, bytesRead: pos - offset };
  }

  // Normal object - validate first object constraints
  if (isFirstObject) {
    validateFirstFetchObject(flags);
  } else if (prior === undefined) {
    // A non-first object inherits Group/Subgroup/Object/Priority from the prior
    // object; without one there is nothing to inherit. Fail cleanly rather than
    // dereferencing an undefined prior.
    throw new ProtocolViolationError('Non-first fetch object requires prior-object context');
  }

  const numFlags = Number(flags);
  const isDatagram = (numFlags & FetchFlags.DATAGRAM) !== 0;

  // Read Group ID (if present) or inherit
  let groupId: Varint;
  if ((numFlags & FetchFlags.GROUP_ID) !== 0) {
    const { value: gid, bytesRead: gidBytes } = readVarint(buf, pos);
    pos += gidBytes;
    groupId = gid;
  } else {
    // Inherit from prior (already validated not first object)
    groupId = varint(prior!.groupId);
  }

  // Determine subgroup ID based on mode
  let subgroupId: Varint;
  if (isDatagram) {
    // DATAGRAM flag: ignore subgroup bits, subgroup = 0
    subgroupId = varint(0);
  } else {
    const subgroupMode = numFlags & FetchFlags.SUBGROUP_MODE_MASK;
    switch (subgroupMode) {
      case FetchSubgroupMode.ZERO:
        subgroupId = varint(0);
        break;
      case FetchSubgroupMode.PRIOR:
        subgroupId = varint(prior!.subgroupId);
        break;
      case FetchSubgroupMode.PRIOR_PLUS_ONE:
        subgroupId = varint(prior!.subgroupId + 1n);
        break;
      case FetchSubgroupMode.EXPLICIT: {
        const { value: sgid, bytesRead: sgidBytes } = readVarint(buf, pos);
        pos += sgidBytes;
        subgroupId = sgid;
        break;
      }
      default:
        throw new ProtocolViolationError(`Invalid subgroup mode: ${subgroupMode}`);
    }
  }

  // Read Object ID (if present) or inherit + 1
  let objectId: Varint;
  if ((numFlags & FetchFlags.OBJECT_ID) !== 0) {
    const { value: oid, bytesRead: oidBytes } = readVarint(buf, pos);
    pos += oidBytes;
    objectId = oid;
  } else {
    // Inherit from prior + 1
    objectId = varint(prior!.objectId + 1n);
  }

  // Read Priority (if present) or inherit
  let publisherPriority: number | undefined;
  if ((numFlags & FetchFlags.PRIORITY) !== 0) {
    const { value: prio } = readUint8(buf, pos);
    pos += 1;
    publisherPriority = prio;
  } else if (prior?.priority !== undefined) {
    publisherPriority = prior.priority;
  }

  // Read Extensions (if present)
  let extensions: Uint8Array | undefined;
  if ((numFlags & FetchFlags.EXTENSIONS) !== 0) {
    const { value: extLen, bytesRead: extLenBytes } = readVarint(buf, pos);
    pos += extLenBytes;
    const extensionsLength = Number(extLen);

    // Bounds check
    if (pos + extensionsLength > buf.length) {
      throw new RangeError(
        `Extension length ${extensionsLength} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }

    extensions = buf.slice(pos, pos + extensionsLength);
    pos += extensionsLength;
  }

  // Read payload length and payload
  const { value: payloadLen, bytesRead: plBytes } = readVarint(buf, pos);
  pos += plBytes;
  const numPayloadLen = Number(payloadLen);

  // Bounds check for payload
  if (pos + numPayloadLen > buf.length) {
    throw new RangeError(
      `Payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
    );
  }

  const payload = buf.slice(pos, pos + numPayloadLen);
  pos += numPayloadLen;

  const object: FetchObject = {
    flags,
    groupId,
    subgroupId,
    objectId,
    publisherPriority,
    isDatagram,
    extensions,
    payload,
  };

  return { item: object, bytesRead: pos - offset };
}

/**
 * Decode a single object from a draft-14 fetch stream.
 *
 * Draft-14 §10.4.4: All fields are always present (no serialization flags).
 * { Group ID (i), Subgroup ID (i), Object ID (i), Publisher Priority (8),
 *   Extension Headers Length (i), [Extension headers (...)],
 *   Object Payload Length (i), [Object Status (i)], Object Payload (..) }
 *
 * @see draft-ietf-moq-transport-14 §10.4.4
 */
export function decodeFetchObjectV14(
  buf: Uint8Array,
  offset: number,
): { item: DecodedFetchItem; bytesRead: number } {
  let pos = offset;

  // Group ID
  const { value: groupId, bytesRead: gidBytes } = readVarint(buf, pos);
  pos += gidBytes;

  // Subgroup ID
  const { value: subgroupId, bytesRead: sgidBytes } = readVarint(buf, pos);
  pos += sgidBytes;

  // Object ID
  const { value: objectId, bytesRead: oidBytes } = readVarint(buf, pos);
  pos += oidBytes;

  // Publisher Priority (always present)
  const { value: publisherPriority } = readUint8(buf, pos);
  pos += 1;

  // Extension Headers Length
  const { value: extLen, bytesRead: extLenBytes } = readVarint(buf, pos);
  pos += extLenBytes;
  const extensionsLength = Number(extLen);

  let extensions: Uint8Array | undefined;
  if (extensionsLength > 0) {
    if (pos + extensionsLength > buf.length) {
      throw new RangeError(
        `Extension length ${extensionsLength} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }
    extensions = buf.slice(pos, pos + extensionsLength);
    pos += extensionsLength;
  }

  // Object Payload Length
  const { value: payloadLen, bytesRead: plBytes } = readVarint(buf, pos);
  pos += plBytes;
  const numPayloadLen = Number(payloadLen);

  if (numPayloadLen === 0) {
    // Status object — read status varint and return as FetchEndOfRange
    // so the adapter emits it as a gap signal.
    // @see draft-ietf-moq-transport-14 §10.4.4
    const { value: status, bytesRead: stBytes } = readVarint(buf, pos);
    pos += stBytes;
    validateObjectStatus(status, 14);

    const endOfRange: FetchEndOfRange = {
      flags: varint(0n),
      groupId,
      objectId,
      nonExistent: status === ObjectStatus.OBJECT_DOES_NOT_EXIST,
      rawStatus: status,
    };
    return { item: endOfRange, bytesRead: pos - offset };
  }

  if (pos + numPayloadLen > buf.length) {
    throw new RangeError(
      `Payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
    );
  }
  const payload = buf.slice(pos, pos + numPayloadLen);
  pos += numPayloadLen;

  const object: FetchObject = {
    flags: varint(0n), // No flags in draft-14
    groupId,
    subgroupId,
    objectId,
    publisherPriority,
    isDatagram: false,
    extensions,
    payload,
  };

  return { item: object, bytesRead: pos - offset };
}

/**
 * Decode an OBJECT_DATAGRAM.
 * @param buf Buffer containing the entire datagram
 * @param offset Starting position
 * @returns Decoded datagram and bytes consumed
 * @throws {Error} If type byte is invalid or has invalid flag combination
 * @see draft-ietf-moq-transport-16 §10.3.1
 */
export function decodeObjectDatagram(
  buf: Uint8Array,
  offset: number,
  version: 14 | 16 = 16,
): { datagram: ObjectDatagram; bytesRead: number } {
  let pos = offset;

  // Read type byte (varint, but typically 1 byte)
  const { value: typeVarint, bytesRead: typeBytes } = readVarint(buf, pos);
  pos += typeBytes;
  const typeByte = Number(typeVarint);

  // Validate type byte
  if (!isDatagramType(typeByte, version)) {
    throw new ProtocolViolationError(
      `Invalid OBJECT_DATAGRAM type byte: 0x${typeByte.toString(16)}`,
    );
  }

  // Check for invalid flag combinations
  if (!isValidDatagramFlags(typeByte)) {
    throw new ProtocolViolationError(
      `Invalid OBJECT_DATAGRAM flag combination (STATUS + END_OF_GROUP): 0x${typeByte.toString(16)}`,
    );
  }

  // Read track alias
  const { value: trackAlias, bytesRead: taBytes } = readVarint(buf, pos);
  pos += taBytes;

  // Read group ID
  const { value: groupId, bytesRead: gidBytes } = readVarint(buf, pos);
  pos += gidBytes;

  // Read object ID (unless ZERO_OBJECT_ID flag set)
  let objectId: Varint;
  if ((typeByte & DatagramFlags.ZERO_OBJECT_ID) !== 0) {
    objectId = varint(1);
  } else {
    const { value: oid, bytesRead: oidBytes } = readVarint(buf, pos);
    pos += oidBytes;
    objectId = oid;
  }

  // Read publisher priority.
  // Draft-14 §10.3.1: Publisher Priority is always present.
  // Draft-16: only present when DEFAULT_PRIORITY bit is NOT set.
  let publisherPriority: number | undefined;
  if (version === 14 || (typeByte & DatagramFlags.DEFAULT_PRIORITY) === 0) {
    const { value: prio } = readUint8(buf, pos);
    pos += 1;
    publisherPriority = prio;
  }

  // Read extensions if EXTENSIONS flag set
  let extensions: Uint8Array | undefined;
  let extensionsLength = 0;
  if ((typeByte & DatagramFlags.EXTENSIONS) !== 0) {
    const { value: extLen, bytesRead: extLenBytes } = readVarint(buf, pos);
    pos += extLenBytes;
    extensionsLength = Number(extLen);

    // §10.3.1: "If an endpoint receives a datagram with the EXTENSIONS
    // bit set and an Extension Headers Length of 0, it MUST close the
    // session with a PROTOCOL_VIOLATION"
    if (extensionsLength === 0) {
      throw new ProtocolViolationError(
        'OBJECT_DATAGRAM has EXTENSIONS flag set but Extension Headers Length is 0',
      );
    }

    // Bounds check
    if (pos + extensionsLength > buf.length) {
      throw new RangeError(
        `Extension length ${extensionsLength} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }

    extensions = buf.slice(pos, pos + extensionsLength);
    pos += extensionsLength;
  }

  // Extract END_OF_GROUP flag
  const isEndOfGroup = (typeByte & DatagramFlags.END_OF_GROUP) !== 0;

  // Read status or payload
  let payload: Uint8Array;
  let status: Varint | undefined;

  if ((typeByte & DatagramFlags.STATUS) !== 0) {
    // STATUS flag: read status varint, no payload
    const { value: st, bytesRead: stBytes } = readVarint(buf, pos);
    pos += stBytes;
    status = st;
    payload = new Uint8Array(0);

    // Validate status code (version-aware: draft-14 allows 0x1)
    validateObjectStatus(status, version);

    // §10.2.1.2: Extensions on non-Normal status objects is PROTOCOL_VIOLATION
    if (extensionsLength > 0 && status !== ObjectStatus.NORMAL) {
      throw new ProtocolViolationError(
        `Extensions present on status datagram (status=0x${status.toString(16)}) per §10.2.1.2`,
      );
    }

    // STATUS datagrams must not have trailing bytes
    if (pos < buf.length) {
      throw new ProtocolViolationError(
        `STATUS datagram has ${buf.length - pos} trailing bytes (expected none)`,
      );
    }
  } else {
    // No STATUS flag: rest of datagram is payload
    payload = buf.slice(pos);
    pos = buf.length;
  }

  const datagram: ObjectDatagram = {
    typeByte,
    trackAlias,
    groupId,
    objectId,
    publisherPriority,
    isEndOfGroup,
    extensions,
    payload,
    status,
  };

  return { datagram, bytesRead: pos - offset };
}
