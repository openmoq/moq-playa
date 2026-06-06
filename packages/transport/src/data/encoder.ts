/**
 * Data plane encoders.
 * Inverse of decoder.ts — serializes data plane structures to wire format.
 * @see draft-ietf-moq-transport-16 §10
 * @module
 */

import { writeVarint, varintEncodingLength, varint, type Varint } from '../primitives/varint.js';
import {
  DataStreamType,
  SubgroupFlags,
  SubgroupIdMode,
  DatagramFlags,
  ObjectStatus,
  FetchFlags,
  FetchSubgroupMode,
} from './codes.js';
import type {
  SubgroupHeader,
  SubgroupObject,
  FetchHeader,
  FetchObject,
  FetchEndOfRange,
  ObjectDatagram,
} from './types.js';

// ─── Subgroup Header ─────────────────────────────────────────────────

/**
 * Encode a SUBGROUP_HEADER to wire format.
 * @param header The header to encode
 * @returns Encoded bytes
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export function encodeSubgroupHeader(header: SubgroupHeader): Uint8Array {
  // Calculate total size
  let size = varintEncodingLength(varint(header.typeByte));
  size += varintEncodingLength(header.trackAlias);
  size += varintEncodingLength(header.groupId);

  // Subgroup ID present only in EXPLICIT mode
  const mode = (header.typeByte & SubgroupFlags.SUBGROUP_ID_MODE_MASK) >> 1;
  if (mode === SubgroupIdMode.EXPLICIT) {
    size += varintEncodingLength(header.subgroupId);
  }

  // Publisher priority present unless DEFAULT_PRIORITY
  if (header.publisherPriority !== undefined) {
    size += 1; // uint8
  }

  const buf = new Uint8Array(size);
  let pos = 0;

  // Type byte
  pos += writeVarint(varint(header.typeByte), buf, pos);

  // Track alias
  pos += writeVarint(header.trackAlias, buf, pos);

  // Group ID
  pos += writeVarint(header.groupId, buf, pos);

  // Subgroup ID (only in EXPLICIT mode)
  if (mode === SubgroupIdMode.EXPLICIT) {
    pos += writeVarint(header.subgroupId, buf, pos);
  }

  // Publisher priority
  if (header.publisherPriority !== undefined) {
    buf[pos++] = header.publisherPriority;
  }

  return buf;
}

// ─── Subgroup Object ─────────────────────────────────────────────────

/**
 * Encode a single object for a subgroup stream.
 * @param object The object to encode
 * @param hasExtensions Whether the subgroup header has EXTENSIONS flag
 * @param previousObjectId Previous object ID for delta calculation
 * @param isFirstObject Whether this is the first object in the subgroup
 * @returns Encoded bytes
 * @see draft-ietf-moq-transport-16 §10.4.2
 */
export function encodeSubgroupObject(
  object: SubgroupObject,
  hasExtensions: boolean,
  previousObjectId: Varint,
  isFirstObject: boolean = true,
): Uint8Array {
  // §10.2.1.1: "Zero-length objects explicitly encode the Normal status."
  // Invariant: status is only meaningful on empty-payload objects.
  // Silently dropping status on a non-empty payload was found by property
  // testing (Apr 2026) to cause silent data loss across the wire — reject
  // loudly at the call site instead. See encoder-validation-policy.md.
  if (object.status !== undefined && object.payload.length > 0) {
    throw new Error(
      `SubgroupObject: status (0x${object.status.toString(16)}) is only valid on empty payloads; got payload.length=${object.payload.length}`,
    );
  }

  // Compute delta (semantic bigint; writeVarint range-checks for draft-14/16).
  let delta: bigint;
  if (isFirstObject) {
    delta = object.objectId;
  } else {
    delta = varint(object.objectId - previousObjectId - 1n);
  }

  // Calculate size
  let size = varintEncodingLength(delta);

  // Extensions
  if (hasExtensions) {
    const extLen = object.extensions?.length ?? 0;
    size += varintEncodingLength(varint(extLen));
    size += extLen;
  }

  // Payload length + payload/status
  const payloadLen = object.payload.length;
  size += varintEncodingLength(varint(payloadLen));

  // §10.2.1.1: "Zero-length objects explicitly encode the Normal status."
  const effectiveStatus = payloadLen === 0
    ? (object.status ?? ObjectStatus.NORMAL)
    : object.status;

  if (payloadLen === 0 && effectiveStatus !== undefined) {
    // Status object
    size += varintEncodingLength(effectiveStatus);
  } else {
    size += payloadLen;
  }

  const buf = new Uint8Array(size);
  let pos = 0;

  // Object ID delta
  pos += writeVarint(delta, buf, pos);

  // Extensions
  if (hasExtensions) {
    const extLen = object.extensions?.length ?? 0;
    pos += writeVarint(varint(extLen), buf, pos);
    if (extLen > 0 && object.extensions) {
      buf.set(object.extensions, pos);
      pos += extLen;
    }
  }

  // Payload length
  pos += writeVarint(varint(payloadLen), buf, pos);

  if (payloadLen === 0 && effectiveStatus !== undefined) {
    // Status code
    pos += writeVarint(effectiveStatus, buf, pos);
  } else if (payloadLen > 0) {
    // Payload data
    buf.set(object.payload, pos);
    pos += payloadLen;
  }

  return buf;
}

// ─── Fetch Header ────────────────────────────────────────────────────

/**
 * Encode a FETCH_HEADER to wire format.
 * @param header The fetch header (or just a requestId)
 * @returns Encoded bytes
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export function encodeFetchHeader(header: FetchHeader): Uint8Array {
  const typeVarint = varint(DataStreamType.FETCH_HEADER);
  const size = varintEncodingLength(typeVarint) + varintEncodingLength(header.requestId);

  const buf = new Uint8Array(size);
  let pos = 0;

  pos += writeVarint(typeVarint, buf, pos);
  pos += writeVarint(header.requestId, buf, pos);

  return buf;
}

// ─── Object Datagram ─────────────────────────────────────────────────

/**
 * Encode an OBJECT_DATAGRAM to wire format.
 * @param datagram The datagram to encode
 * @returns Encoded bytes
 * @see draft-ietf-moq-transport-16 §10.3.1
 */
export function encodeObjectDatagram(datagram: ObjectDatagram): Uint8Array {
  const typeByte = datagram.typeByte;

  // §10.3.1: Validate flag/field consistency — symmetric both directions.
  // Silent drop (flag-clear-but-field-present) was found by property
  // testing (Apr 2026) to cause silent data loss across the wire. The
  // encoder validates both directions now. See encoder-validation-policy.md.

  // EXTENSIONS
  const hasExtensionsFlag = (typeByte & DatagramFlags.EXTENSIONS) !== 0;
  if (hasExtensionsFlag && datagram.extensions == null) {
    throw new Error('EXTENSIONS flag set but extensions data is missing');
  }
  if (!hasExtensionsFlag && datagram.extensions != null) {
    throw new Error('extensions field is present but EXTENSIONS flag is clear (would be silently dropped)');
  }

  // DEFAULT_PRIORITY ⇔ (publisherPriority === undefined)
  const defaultPriorityFlag = (typeByte & DatagramFlags.DEFAULT_PRIORITY) !== 0;
  if (!defaultPriorityFlag && datagram.publisherPriority == null) {
    throw new Error('DEFAULT_PRIORITY not set but publisherPriority is missing');
  }
  if (defaultPriorityFlag && datagram.publisherPriority != null) {
    throw new Error('publisherPriority is present but DEFAULT_PRIORITY flag is set (would be silently dropped)');
  }

  // STATUS ⇔ (status !== undefined)
  const statusFlag = (typeByte & DatagramFlags.STATUS) !== 0;
  if (statusFlag && datagram.status == null) {
    throw new Error('STATUS flag set but status field is missing');
  }
  if (!statusFlag && datagram.status != null) {
    throw new Error('status field is present but STATUS flag is clear (would be silently dropped)');
  }

  // Calculate size
  let size = varintEncodingLength(varint(typeByte));
  size += varintEncodingLength(datagram.trackAlias);
  size += varintEncodingLength(datagram.groupId);

  // Object ID unless ZERO_OBJECT_ID
  if ((typeByte & DatagramFlags.ZERO_OBJECT_ID) === 0) {
    size += varintEncodingLength(datagram.objectId);
  }

  // Publisher priority unless DEFAULT_PRIORITY
  if (datagram.publisherPriority !== undefined) {
    size += 1; // uint8
  }

  // Extensions
  if ((typeByte & DatagramFlags.EXTENSIONS) !== 0 && datagram.extensions) {
    size += varintEncodingLength(varint(datagram.extensions.length));
    size += datagram.extensions.length;
  }

  // Status or payload
  if ((typeByte & DatagramFlags.STATUS) !== 0 && datagram.status !== undefined) {
    size += varintEncodingLength(datagram.status);
  } else {
    size += datagram.payload.length;
  }

  const buf = new Uint8Array(size);
  let pos = 0;

  // Type byte
  pos += writeVarint(varint(typeByte), buf, pos);

  // Track alias
  pos += writeVarint(datagram.trackAlias, buf, pos);

  // Group ID
  pos += writeVarint(datagram.groupId, buf, pos);

  // Object ID
  if ((typeByte & DatagramFlags.ZERO_OBJECT_ID) === 0) {
    pos += writeVarint(datagram.objectId, buf, pos);
  }

  // Publisher priority
  if (datagram.publisherPriority !== undefined) {
    buf[pos++] = datagram.publisherPriority;
  }

  // Extensions
  if ((typeByte & DatagramFlags.EXTENSIONS) !== 0 && datagram.extensions) {
    pos += writeVarint(varint(datagram.extensions.length), buf, pos);
    buf.set(datagram.extensions, pos);
    pos += datagram.extensions.length;
  }

  // Status or payload
  if ((typeByte & DatagramFlags.STATUS) !== 0 && datagram.status !== undefined) {
    pos += writeVarint(datagram.status, buf, pos);
  } else {
    buf.set(datagram.payload, pos);
    pos += datagram.payload.length;
  }

  return buf;
}

// ─── Fetch Object ────────────────────────────────────────────────────

/**
 * Encode a single object for a fetch stream.
 * @param object The fetch object to encode
 * @returns Encoded bytes
 * @see draft-ietf-moq-transport-16 §10.4.4
 */
export function encodeFetchObject(object: FetchObject): Uint8Array {
  const numFlags = Number(object.flags);

  // §10.4.4: Validate flag/field consistency — symmetric both directions.
  // Silent drop (flag-clear-but-field-present) was found by property
  // testing (Apr 2026) to cause silent data loss. See
  // encoder-validation-policy.md.

  // PRIORITY ⇔ (publisherPriority !== undefined)
  const priorityFlag = (numFlags & FetchFlags.PRIORITY) !== 0;
  if (priorityFlag && object.publisherPriority == null) {
    throw new Error('PRIORITY flag set but publisherPriority is missing');
  }
  if (!priorityFlag && object.publisherPriority != null) {
    throw new Error('publisherPriority is present but PRIORITY flag is clear (would be silently dropped)');
  }

  // EXTENSIONS ⇔ (extensions !== undefined)
  const extensionsFlag = (numFlags & FetchFlags.EXTENSIONS) !== 0;
  if (extensionsFlag && object.extensions == null) {
    throw new Error('EXTENSIONS flag set but extensions data is missing');
  }
  if (!extensionsFlag && object.extensions != null) {
    throw new Error('extensions field is present but EXTENSIONS flag is clear (would be silently dropped)');
  }

  // Calculate size
  let size = varintEncodingLength(object.flags);

  // Group ID (if present)
  if ((numFlags & FetchFlags.GROUP_ID) !== 0) {
    size += varintEncodingLength(object.groupId);
  }

  // Subgroup ID (if EXPLICIT mode and not DATAGRAM)
  const isDatagram = (numFlags & FetchFlags.DATAGRAM) !== 0;
  if (!isDatagram) {
    const subgroupMode = numFlags & FetchFlags.SUBGROUP_MODE_MASK;
    if (subgroupMode === FetchSubgroupMode.EXPLICIT) {
      size += varintEncodingLength(object.subgroupId);
    }
  }

  // Object ID (if present)
  if ((numFlags & FetchFlags.OBJECT_ID) !== 0) {
    size += varintEncodingLength(object.objectId);
  }

  // Priority (if present)
  if ((numFlags & FetchFlags.PRIORITY) !== 0) {
    size += 1; // uint8
  }

  // Extensions (if present)
  if ((numFlags & FetchFlags.EXTENSIONS) !== 0 && object.extensions) {
    size += varintEncodingLength(varint(object.extensions.length));
    size += object.extensions.length;
  }

  // Payload length + payload
  size += varintEncodingLength(varint(object.payload.length));
  size += object.payload.length;

  const buf = new Uint8Array(size);
  let pos = 0;

  // Flags
  pos += writeVarint(object.flags, buf, pos);

  // Group ID
  if ((numFlags & FetchFlags.GROUP_ID) !== 0) {
    pos += writeVarint(object.groupId, buf, pos);
  }

  // Subgroup ID
  if (!isDatagram) {
    const subgroupMode = numFlags & FetchFlags.SUBGROUP_MODE_MASK;
    if (subgroupMode === FetchSubgroupMode.EXPLICIT) {
      pos += writeVarint(object.subgroupId, buf, pos);
    }
  }

  // Object ID
  if ((numFlags & FetchFlags.OBJECT_ID) !== 0) {
    pos += writeVarint(object.objectId, buf, pos);
  }

  // Priority
  if ((numFlags & FetchFlags.PRIORITY) !== 0 && object.publisherPriority !== undefined) {
    buf[pos++] = object.publisherPriority;
  }

  // Extensions
  if ((numFlags & FetchFlags.EXTENSIONS) !== 0 && object.extensions) {
    pos += writeVarint(varint(object.extensions.length), buf, pos);
    buf.set(object.extensions, pos);
    pos += object.extensions.length;
  }

  // Payload length + payload
  pos += writeVarint(varint(object.payload.length), buf, pos);
  buf.set(object.payload, pos);
  pos += object.payload.length;

  return buf;
}

/**
 * Encode a FETCH End of Range marker.
 * @param marker The end-of-range to encode
 * @returns Encoded bytes
 * @see draft-ietf-moq-transport-16 §10.4.4.2
 */
export function encodeFetchEndOfRange(marker: FetchEndOfRange): Uint8Array {
  // Calculate size
  let size = varintEncodingLength(marker.flags);
  size += varintEncodingLength(marker.groupId);
  size += varintEncodingLength(marker.objectId);
  // Payload length (always 0 for end of range)
  size += varintEncodingLength(varint(0));

  const buf = new Uint8Array(size);
  let pos = 0;

  pos += writeVarint(marker.flags, buf, pos);
  pos += writeVarint(marker.groupId, buf, pos);
  pos += writeVarint(marker.objectId, buf, pos);
  pos += writeVarint(varint(0), buf, pos); // zero-length payload

  return buf;
}
