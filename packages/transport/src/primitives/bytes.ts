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
 *
 * Field-count lower bound is version-specific: draft-18 §2.4.1 allows a Track
 * Namespace of **0 to 32** fields (an empty full namespace is legal), so callers
 * on draft-18 pass `{ allowEmpty: true }`. draft-14/16 require at least one field
 * — the default — so legacy callers are unchanged.
 *
 * @param segments Array of namespace field byte arrays
 * @param opts.allowEmpty Permit a zero-field namespace (draft-18 §2.4.1).
 * @throws {ProtocolViolationError} If field count is out of range, any field is
 *   empty, or the total exceeds 4096 bytes.
 * @see draft-ietf-moq-transport-18 §2.4.1
 */
export function validateTrackNamespace(
  segments: Uint8Array[],
  opts: { allowEmpty?: boolean } = {},
): void {
  // §2.4.1: draft-18 allows 0 fields; draft-14/16 require ≥ 1.
  if (segments.length === 0 && !opts.allowEmpty) {
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

/** The `.session` reserved first-field value: bytes of the ASCII string ".session". */
const SESSION_NAMESPACE_FIELD = new Uint8Array([0x2e, 0x73, 0x65, 0x73, 0x73, 0x69, 0x6f, 0x6e]);

/** True if a namespace's first field equals `expected` (exact byte comparison). */
function firstFieldEquals(segments: Uint8Array[], expected: Uint8Array): boolean {
  const first = segments[0];
  if (first === undefined || first.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (first[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * §3.2.2: whether a Track Namespace is in the reserved `.session` namespace —
 * its first field is exactly `.session`. Such tracks/namespaces are managed by
 * the MOQT implementation; the Application MUST NOT publish under them.
 * @see draft-ietf-moq-transport-18 §3.2.2
 */
export function isReservedSessionNamespace(segments: Uint8Array[]): boolean {
  return firstFieldEquals(segments, SESSION_NAMESPACE_FIELD);
}

/**
 * §3.2.1: whether a Track Namespace's first field is exactly a single period
 * (`.`, 0x2e). This value is reserved and MUST NOT be used for any purpose.
 * @see draft-ietf-moq-transport-18 §3.2.1
 */
export function isReservedDotNamespace(segments: Uint8Array[]): boolean {
  const first = segments[0];
  return first !== undefined && first.length === 1 && first[0] === 0x2e;
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
 *
 * The namespace must be valid (each field non-empty, ≤ 32 fields) and the combined
 * namespace + track-name byte length must be ≤ 4096 (§2.4.1). The namespace
 * field-count lower bound is version-specific: draft-14/16 require ≥ 1 field (the
 * default), while draft-18 §2.4.1 permits an empty namespace — pass
 * `{ allowEmptyNamespace: true }` there. Note that an *empty namespace* (0 fields)
 * is distinct from an *empty field* (a present field of length 0): the latter is
 * always a violation.
 *
 * @param namespace Array of namespace field byte arrays
 * @param trackName Track name byte array
 * @param opts.allowEmptyNamespace Permit a zero-field namespace (draft-18 §2.4.1).
 * @throws {ProtocolViolationError} If namespace invalid or combined length > 4096 bytes
 * @see draft-ietf-moq-transport-18 §2.4.1
 */
export function validateFullTrackName(
  namespace: Uint8Array[],
  trackName: Uint8Array,
  opts: { allowEmptyNamespace?: boolean } = {},
): void {
  // Validate namespace itself (≤ 32 fields, each non-empty; empty namespace only
  // when explicitly allowed for draft-18).
  validateTrackNamespace(namespace, opts.allowEmptyNamespace ? { allowEmpty: true } : {});

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
