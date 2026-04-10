/**
 * Low-level binary read/write helpers for MOQT wire format.
 * @see draft-ietf-moq-transport-16
 * @module
 */

import { readVarint, writeVarint, varint, varintEncodingLength } from './varint.js';
import { ProtocolViolationError } from '../errors.js';

/** Read a single byte. */
export function readUint8(buf: Uint8Array, offset: number): { value: number; bytesRead: 1 } {
  if (offset >= buf.length) {
    throw new RangeError(`readUint8 out of bounds: offset ${offset}, length ${buf.length}`);
  }
  return { value: buf[offset]!, bytesRead: 1 };
}

/** Write a single byte. Returns 1 (bytes written). */
export function writeUint8(value: number, buf: Uint8Array, offset: number): 1 {
  buf[offset] = value & 0xff;
  return 1;
}

/** Read a fixed number of bytes as a copy. */
export function readBytes(
  buf: Uint8Array,
  offset: number,
  length: number,
): { value: Uint8Array; bytesRead: number } {
  if (offset + length > buf.length) {
    throw new RangeError(
      `readBytes: need ${length} bytes at offset ${offset}, but buffer length is ${buf.length}`,
    );
  }
  const value = buf.slice(offset, offset + length);
  return { value, bytesRead: length };
}

/** Read a varint-length-prefixed byte array. */
export function readLengthPrefixedBytes(
  buf: Uint8Array,
  offset: number,
): { value: Uint8Array; bytesRead: number } {
  const { value: length, bytesRead: lenBytes } = readVarint(buf, offset);
  const numLen = Number(length);
  const { value, bytesRead: dataBytes } = readBytes(buf, offset + lenBytes, numLen);
  return { value, bytesRead: lenBytes + dataBytes };
}

/** Write a varint-length-prefixed byte array. Returns total bytes written. */
export function writeLengthPrefixedBytes(
  data: Uint8Array,
  buf: Uint8Array,
  offset: number,
): number {
  const v = varint(data.length);
  let pos = offset;
  pos += writeVarint(v, buf, pos);
  buf.set(data, pos);
  pos += data.length;
  return pos - offset;
}

/** Calculate total encoding length for a length-prefixed byte array. */
export function lengthPrefixedBytesEncodingLength(data: Uint8Array): number {
  return varintEncodingLength(varint(data.length)) + data.length;
}

/**
 * Read a varint-count-prefixed tuple of length-prefixed byte segments.
 * Used for Track Namespace (array of byte-string segments).
 * @see draft-ietf-moq-transport-16 §9 (Track Namespace Tuple)
 */
export function readTuple(
  buf: Uint8Array,
  offset: number,
): { value: Uint8Array[]; bytesRead: number } {
  let pos = offset;
  const { value: count, bytesRead: countBytes } = readVarint(buf, pos);
  pos += countBytes;

  const numCount = Number(count);
  const segments: Uint8Array[] = [];
  for (let i = 0; i < numCount; i++) {
    const { value: segment, bytesRead: segBytes } = readLengthPrefixedBytes(buf, pos);
    segments.push(segment);
    pos += segBytes;
  }

  return { value: segments, bytesRead: pos - offset };
}

/**
 * Write a varint-count-prefixed tuple of length-prefixed byte segments.
 * Returns total bytes written.
 */
export function writeTuple(
  segments: Uint8Array[],
  buf: Uint8Array,
  offset: number,
): number {
  let pos = offset;
  pos += writeVarint(varint(segments.length), buf, pos);
  for (const seg of segments) {
    pos += writeLengthPrefixedBytes(seg, buf, pos);
  }
  return pos - offset;
}

/** Calculate encoding length for a tuple. */
export function tupleEncodingLength(segments: Uint8Array[]): number {
  let len = varintEncodingLength(varint(segments.length));
  for (const seg of segments) {
    len += lengthPrefixedBytesEncodingLength(seg);
  }
  return len;
}

// ─── Track Namespace Validation (§2.4.1) ─────────────────────────────

/** Maximum number of Track Namespace Fields per §2.4.1. */
const MAX_NAMESPACE_FIELDS = 32;

/** Maximum total length of Track Namespace or Full Track Name per §2.4.1. */
const MAX_NAME_LENGTH = 4096;

/**
 * Calculate total byte length of namespace fields (sum of field lengths).
 */
function namespaceByteLength(segments: Uint8Array[]): number {
  return segments.reduce((sum, seg) => sum + seg.length, 0);
}

/**
 * Validate field lengths - each must be ≥ 1 byte per §2.4.1.
 * @throws {Error} If any field has length 0
 */
function validateFieldLengths(segments: Uint8Array[]): void {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.length === 0) {
      throw new ProtocolViolationError(
        ` Track Namespace Field ${i} has length 0; each field must contain at least one byte (§2.4.1)`,
      );
    }
  }
}

/**
 * Validate a Track Namespace (full namespace, not prefix).
 * @param segments Array of namespace field byte arrays
 * @throws {Error} If field count not 1-32, any field is empty, or total > 4096 bytes
 * @see draft-ietf-moq-transport-16 §2.4.1
 */
export function validateTrackNamespace(segments: Uint8Array[]): void {
  // Must have 1-32 fields
  if (segments.length === 0) {
    throw new ProtocolViolationError(
      ' Track Namespace must have at least 1 field (§2.4.1)',
    );
  }
  if (segments.length > MAX_NAMESPACE_FIELDS) {
    throw new ProtocolViolationError(
      ` Track Namespace has ${segments.length} fields; maximum is 32 (§2.4.1)`,
    );
  }

  // Each field must have at least 1 byte
  validateFieldLengths(segments);

  // Total length must be ≤ 4096
  const totalLength = namespaceByteLength(segments);
  if (totalLength > MAX_NAME_LENGTH) {
    throw new ProtocolViolationError(
      ` Track Namespace length ${totalLength} exceeds maximum 4096 bytes (§2.4.1)`,
    );
  }
}

/**
 * Validate a Track Namespace Prefix (allows 0 fields for SUBSCRIBE_NAMESPACE).
 * @param segments Array of namespace field byte arrays
 * @throws {Error} If field count > 32, any field is empty, or total > 4096 bytes
 * @see draft-ietf-moq-transport-16 §9.25
 */
export function validateTrackNamespacePrefix(segments: Uint8Array[]): void {
  // Prefix allows 0-32 fields
  if (segments.length > MAX_NAMESPACE_FIELDS) {
    throw new ProtocolViolationError(
      ` Track Namespace Prefix has ${segments.length} fields; maximum is 32 (§9.25)`,
    );
  }

  // Each field (if present) must have at least 1 byte
  validateFieldLengths(segments);

  // Total length must be ≤ 4096
  const totalLength = namespaceByteLength(segments);
  if (totalLength > MAX_NAME_LENGTH) {
    throw new ProtocolViolationError(
      ` Track Namespace Prefix length ${totalLength} exceeds maximum 4096 bytes (§2.4.1)`,
    );
  }
}

/**
 * Validate a Full Track Name (namespace + track name).
 * The namespace must be valid (1-32 fields) and combined length ≤ 4096.
 * @param namespace Array of namespace field byte arrays
 * @param trackName Track name byte array
 * @throws {Error} If namespace invalid or combined length > 4096 bytes
 * @see draft-ietf-moq-transport-16 §2.4.1
 */
export function validateFullTrackName(
  namespace: Uint8Array[],
  trackName: Uint8Array,
): void {
  // Validate namespace itself (1-32 fields, non-empty fields)
  validateTrackNamespace(namespace);

  // Total = namespace field lengths + track name length
  const totalLength = namespaceByteLength(namespace) + trackName.length;
  if (totalLength > MAX_NAME_LENGTH) {
    throw new ProtocolViolationError(
      ` Full Track Name length ${totalLength} exceeds maximum 4096 bytes (§2.4.1)`,
    );
  }
}

/**
 * Validate a Track Namespace Suffix (for NAMESPACE, NAMESPACE_DONE).
 * Suffix can have 0+ fields, but must not exceed limits since combined
 * prefix + suffix must satisfy §2.4.1.
 * @param segments Array of namespace field byte arrays
 * @throws {Error} If field count > 32, any field is empty, or total > 4096 bytes
 * @see draft-ietf-moq-transport-16 §9.21, §9.23
 */
export function validateTrackNamespaceSuffix(segments: Uint8Array[]): void {
  // Suffix cannot exceed the maximum field count (since prefix has ≥0 fields)
  if (segments.length > MAX_NAMESPACE_FIELDS) {
    throw new ProtocolViolationError(
      ` Track Namespace Suffix has ${segments.length} fields; maximum is 32 (§2.4.1)`,
    );
  }

  // Each field (if present) must have at least 1 byte
  validateFieldLengths(segments);

  // Total length must be ≤ 4096 (since prefix length ≥ 0)
  const totalLength = namespaceByteLength(segments);
  if (totalLength > MAX_NAME_LENGTH) {
    throw new ProtocolViolationError(
      ` Track Namespace Suffix length ${totalLength} exceeds maximum 4096 bytes (§2.4.1)`,
    );
  }
}
