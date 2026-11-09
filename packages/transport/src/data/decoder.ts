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
  ObjectHeaderLayout,
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
 * Parse a subgroup object up to its payload: the header grammar of
 * {@link decodeSubgroupObject}, including the Object Status that follows a zero
 * payload length. `previousObjectId` is read, never updated.
 * @throws {RangeError} When `buf` ends before the header does — and, as in the
 *   complete decoder, when a derived Object ID exceeds the varint range
 * @see draft-ietf-moq-transport-16 §10.4.2
 * @see draft-ietf-moq-transport-14 §10.4.2
 */
export function decodeSubgroupObjectHeader(
  buf: Uint8Array,
  offset: number,
  hasExtensions: boolean,
  previousObjectId: bigint,
  isFirstObject: boolean = true,
  version: 14 | 16 = 16,
): ObjectHeaderLayout {
  let pos = offset;

  const { value: delta, bytesRead: deltaBytes } = readVarint(buf, pos);
  pos += deltaBytes;
  const objectId: Varint = isFirstObject ? delta : varint(previousObjectId + delta + 1n);

  // §10.4.2: "Objects with no extensions set Extension Headers Length to 0"
  let propertiesOffset: number | undefined, propertiesLength = 0;
  if (hasExtensions) {
    const { value: extLen, bytesRead: extLenBytes } = readVarint(buf, pos);
    pos += extLenBytes;
    const extensionsLength = Number(extLen);
    if (pos + extensionsLength > buf.length) {
      throw new RangeError(
        `Extension length ${extensionsLength} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }
    propertiesOffset = pos; propertiesLength = extensionsLength;
    pos += extensionsLength;
  }

  const { value: payloadLength, bytesRead: plBytes } = readVarint(buf, pos);
  pos += plBytes;

  // The Object Status field is only present when the payload length is zero.
  let objectStatus: Varint | undefined;
  if (payloadLength === 0n) {
    const { value: st, bytesRead: stBytes } = readVarint(buf, pos);
    pos += stBytes;
    objectStatus = st;
    validateObjectStatus(st, version);
    // §10.2.1.2: Extensions on non-Normal status objects is PROTOCOL_VIOLATION
    if (propertiesLength > 0 && st !== ObjectStatus.NORMAL) {
      throw new ProtocolViolationError(
        `Extensions present on status object (status=0x${st.toString(16)}) per §10.2.1.2`,
      );
    }
  }

  return {
    kind: 'object', headerBytes: pos - offset, payloadLength, objectStatus, propertiesOffset, propertiesLength,
    groupId: undefined, subgroupId: undefined, objectId, publisherPriority: undefined, isDatagram: false,
  };
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
): { object: SubgroupObject; bytesRead: number; header: ObjectHeaderLayout } {
  const header = decodeSubgroupObjectHeader(buf, offset, hasExtensions, previousObjectId, isFirstObject, version);
  let pos = offset + header.headerBytes;
  const extensions = header.propertiesOffset === undefined
    ? undefined
    : buf.slice(header.propertiesOffset, header.propertiesOffset + header.propertiesLength);

  // A zero payload length carried an Object Status (part of the header);
  // otherwise read the payload.
  const numPayloadLen = Number(header.payloadLength);
  let payload: Uint8Array;
  if (numPayloadLen === 0) {
    payload = new Uint8Array(0);
  } else {
    if (pos + numPayloadLen > buf.length) {
      throw new RangeError(
        `Payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }
    payload = buf.slice(pos, pos + numPayloadLen);
    pos += numPayloadLen;
  }

  const object: SubgroupObject = {
    objectId: header.objectId,
    extensions,
    payload,
    status: header.objectStatus,
  };

  return { object, bytesRead: pos - offset, header };
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

/** Header layout of a FETCH stream item, with its Serialization Flags (0 in draft-14). */
export interface FetchObjectHeaderLayout extends ObjectHeaderLayout {
  readonly flags: Varint;
}

/**
 * Parse a draft-16 FETCH stream item up to its payload: the header grammar of
 * {@link decodeFetchObject}. `prior` is read, never updated.
 * @throws {RangeError} When `buf` ends before the header does — and, as in the
 *   complete decoder, when an inherited ID exceeds the varint range
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export function decodeFetchObjectHeader(
  buf: Uint8Array,
  offset: number,
  prior: FetchPriorContext | undefined,
  isFirstObject: boolean,
): FetchObjectHeaderLayout {
  let pos = offset;

  const { value: flags, bytesRead: flagsBytes } = readVarint(buf, pos);
  pos += flagsBytes;
  validateFetchFlags(flags);

  // End of Range markers (§10.4.4.2): Group ID and Object ID are present;
  // Subgroup/Priority/Extensions are NOT. Object Payload Length is still present.
  if (isEndOfRangeFlags(flags)) {
    const { value: groupId, bytesRead: gidBytes } = readVarint(buf, pos);
    pos += gidBytes;
    const { value: objectId, bytesRead: oidBytes } = readVarint(buf, pos);
    pos += oidBytes;
    const { value: payloadLength, bytesRead: plBytes } = readVarint(buf, pos);
    pos += plBytes;
    return {
      kind: 'range', flags, headerBytes: pos - offset, payloadLength, objectStatus: undefined,
      propertiesOffset: undefined, propertiesLength: 0,
      groupId, subgroupId: undefined, objectId, publisherPriority: undefined, isDatagram: false,
    };
  }

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

  let groupId: Varint;
  if ((numFlags & FetchFlags.GROUP_ID) !== 0) {
    const { value: gid, bytesRead: gidBytes } = readVarint(buf, pos);
    pos += gidBytes;
    groupId = gid;
  } else {
    groupId = varint(prior!.groupId);
  }

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

  let objectId: Varint;
  if ((numFlags & FetchFlags.OBJECT_ID) !== 0) {
    const { value: oid, bytesRead: oidBytes } = readVarint(buf, pos);
    pos += oidBytes;
    objectId = oid;
  } else {
    objectId = varint(prior!.objectId + 1n);
  }

  let publisherPriority: number | undefined;
  if ((numFlags & FetchFlags.PRIORITY) !== 0) {
    const { value: prio } = readUint8(buf, pos);
    pos += 1;
    publisherPriority = prio;
  } else if (prior?.priority !== undefined) {
    publisherPriority = prior.priority;
  }

  let propertiesOffset: number | undefined, propertiesLength = 0;
  if ((numFlags & FetchFlags.EXTENSIONS) !== 0) {
    const { value: extLen, bytesRead: extLenBytes } = readVarint(buf, pos);
    pos += extLenBytes;
    const extensionsLength = Number(extLen);
    if (pos + extensionsLength > buf.length) {
      throw new RangeError(
        `Extension length ${extensionsLength} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }
    propertiesOffset = pos; propertiesLength = extensionsLength;
    pos += extensionsLength;
  }

  const { value: payloadLength, bytesRead: plBytes } = readVarint(buf, pos);
  pos += plBytes;

  return {
    kind: 'object', flags, headerBytes: pos - offset, payloadLength, objectStatus: undefined, propertiesOffset, propertiesLength,
    groupId, subgroupId, objectId, publisherPriority, isDatagram,
  };
}

/**
 * Parse a draft-14 FETCH object up to its payload: the header grammar of
 * {@link decodeFetchObjectV14}. A zero payload length is followed by an Object
 * Status, which is part of the header; such an item is still an Object.
 * @throws {RangeError} When `buf` ends before the header does
 * @see draft-ietf-moq-transport-14 §10.4.4
 */
export function decodeFetchObjectHeaderV14(
  buf: Uint8Array,
  offset: number,
): FetchObjectHeaderLayout {
  let pos = offset;

  const { value: groupId, bytesRead: gidBytes } = readVarint(buf, pos);
  pos += gidBytes;
  const { value: subgroupId, bytesRead: sgidBytes } = readVarint(buf, pos);
  pos += sgidBytes;
  const { value: objectId, bytesRead: oidBytes } = readVarint(buf, pos);
  pos += oidBytes;
  const { value: publisherPriority } = readUint8(buf, pos);
  pos += 1;

  const { value: extLen, bytesRead: extLenBytes } = readVarint(buf, pos);
  pos += extLenBytes;
  const extensionsLength = Number(extLen);
  let propertiesOffset: number | undefined, propertiesLength = 0;
  if (extensionsLength > 0) {
    if (pos + extensionsLength > buf.length) {
      throw new RangeError(
        `Extension length ${extensionsLength} exceeds remaining buffer (${buf.length - pos} bytes)`,
      );
    }
    propertiesOffset = pos; propertiesLength = extensionsLength;
    pos += extensionsLength;
  }

  const { value: payloadLength, bytesRead: plBytes } = readVarint(buf, pos);
  pos += plBytes;

  let objectStatus: Varint | undefined;
  if (payloadLength === 0n) {
    const { value: status, bytesRead: stBytes } = readVarint(buf, pos);
    pos += stBytes;
    validateObjectStatus(status, 14);
    objectStatus = status;
  }

  return {
    kind: 'object', flags: varint(0n), headerBytes: pos - offset, payloadLength, objectStatus, propertiesOffset, propertiesLength,
    groupId, subgroupId, objectId, publisherPriority, isDatagram: false,
  };
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
): { item: DecodedFetchItem; bytesRead: number; header: FetchObjectHeaderLayout } {
  const header = decodeFetchObjectHeader(buf, offset, prior, isFirstObject);
  let pos = offset + header.headerBytes;
  const numPayloadLen = Number(header.payloadLength);

  if (header.kind === 'range') {
    // End of Range should have no payload - warn if non-zero but still consume it
    if (numPayloadLen > 0) {
      if (pos + numPayloadLen > buf.length) {
        throw new RangeError(
          `End of Range payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
        );
      }
      pos += numPayloadLen;
    }
    const endOfRange: FetchEndOfRange = {
      flags: header.flags,
      groupId: header.groupId!,
      objectId: header.objectId,
      nonExistent: header.flags === BigInt(FetchSpecialFlags.END_NON_EXISTENT),
    };
    return { item: endOfRange, bytesRead: pos - offset, header };
  }

  const extensions = header.propertiesOffset === undefined
    ? undefined
    : buf.slice(header.propertiesOffset, header.propertiesOffset + header.propertiesLength);
  if (pos + numPayloadLen > buf.length) {
    throw new RangeError(
      `Payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
    );
  }
  const payload = buf.slice(pos, pos + numPayloadLen);
  pos += numPayloadLen;

  const object: FetchObject = {
    flags: header.flags,
    groupId: header.groupId!,
    subgroupId: header.subgroupId!,
    objectId: header.objectId,
    publisherPriority: header.publisherPriority,
    isDatagram: header.isDatagram,
    extensions,
    payload,
  };

  return { item: object, bytesRead: pos - offset, header };
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
): { item: DecodedFetchItem; bytesRead: number; header: FetchObjectHeaderLayout } {
  const header = decodeFetchObjectHeaderV14(buf, offset);
  let pos = offset + header.headerBytes;

  if (header.objectStatus !== undefined) {
    // Status object — return as FetchEndOfRange so the adapter emits it as a
    // gap signal, preserving the exact wire status.
    // @see draft-ietf-moq-transport-14 §10.4.4
    const endOfRange: FetchEndOfRange = {
      flags: varint(0n),
      groupId: header.groupId!,
      objectId: header.objectId,
      nonExistent: header.objectStatus === ObjectStatus.OBJECT_DOES_NOT_EXIST,
      rawStatus: varint(header.objectStatus),
    };
    return { item: endOfRange, bytesRead: pos - offset, header };
  }

  const numPayloadLen = Number(header.payloadLength);
  if (pos + numPayloadLen > buf.length) {
    throw new RangeError(
      `Payload length ${numPayloadLen} exceeds remaining buffer (${buf.length - pos} bytes)`,
    );
  }
  const payload = buf.slice(pos, pos + numPayloadLen);
  pos += numPayloadLen;

  const object: FetchObject = {
    flags: varint(0n), // No flags in draft-14
    groupId: header.groupId!,
    subgroupId: header.subgroupId!,
    objectId: header.objectId,
    publisherPriority: header.publisherPriority,
    isDatagram: false,
    extensions: header.propertiesOffset === undefined
      ? undefined
      : buf.slice(header.propertiesOffset, header.propertiesOffset + header.propertiesLength),
    payload,
  };

  return { item: object, bytesRead: pos - offset, header };
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
