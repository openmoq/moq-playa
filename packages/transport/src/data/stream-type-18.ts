/**
 * draft-18 unidirectional stream-type classification.
 *
 * In draft-18 a stream's type is a vi64 VALUE (§3.4), so types span 1..N bytes:
 * FETCH_HEADER (0x05) and SUBGROUP_HEADER (0b0XX1XXXX) are single-byte, but
 * SETUP (0x2F00) is 2 bytes and PADDING (0x132B3E28) is 5. Classification MUST
 * decode the full vi64 — peeking the first byte misreads SETUP (first byte 0xAF)
 * and PADDING (first byte 0xF0). This replaces draft-14/16's one-byte model.
 *
 * @see draft-ietf-moq-transport-18 §3.4
 * @module
 */

import { readVi64 } from '../primitives/vi64.js';
import {
  StreamType18,
  PADDING_DATAGRAM_TYPE,
  isSubgroupHeaderForm18,
  isDatagramForm18,
  isValidDatagramType18,
} from './codes-18.js';

/** Coarse classification of a draft-18 unidirectional stream. */
export type StreamClass18 = 'fetch' | 'subgroup' | 'setup' | 'padding' | 'unknown';

/** Coarse classification of a draft-18 datagram. */
export type DatagramClass18 = 'object' | 'padding' | 'invalid';

/**
 * Classify a draft-18 datagram by its leading vi64 type. The type is vi64 (so
 * the multi-byte PADDING datagram 0x132B3E29 spans several bytes and cannot be
 * read from a single byte); padding is classified so the caller can discard it
 * rather than mis-decode it as an invalid OBJECT_DATAGRAM.
 * @throws {RangeError} if the buffer is too short to hold the type vi64.
 */
export function classifyDatagram18(buf: Uint8Array, offset = 0): DatagramClass18 {
  const { value } = readVi64(buf, offset);
  if (value === BigInt(PADDING_DATAGRAM_TYPE)) return 'padding';
  if (value <= 0x2fn && isDatagramForm18(Number(value)) && isValidDatagramType18(Number(value))) {
    return 'object';
  }
  return 'invalid';
}

/** Result of decoding and classifying a stream's leading vi64 type. */
export interface ClassifiedStream18 {
  /** The decoded vi64 stream-type value. */
  readonly streamType: bigint;
  /** Coarse kind. */
  readonly kind: StreamClass18;
  /** Bytes consumed by the stream-type vi64. */
  readonly bytesRead: number;
}

/** Classify a stream-type vi64 VALUE that has already been decoded. */
export function classifyStreamTypeValue18(value: bigint): StreamClass18 {
  if (value === BigInt(StreamType18.FETCH_HEADER)) return 'fetch';
  if (value === BigInt(StreamType18.SETUP)) return 'setup';
  if (value === BigInt(StreamType18.PADDING)) return 'padding';
  // Classification matches the subgroup *form*; a reserved subgroup-ID mode is
  // still a (malformed) subgroup stream and is rejected later by the decoder.
  if (value <= 0x7fn && isSubgroupHeaderForm18(Number(value))) return 'subgroup';
  return 'unknown';
}

/**
 * Decode the leading vi64 stream type from `buf` and classify it.
 * @throws {RangeError} if the buffer is too short to hold the vi64.
 */
export function classifyStream18(buf: Uint8Array, offset = 0): ClassifiedStream18 {
  const { value, bytesRead } = readVi64(buf, offset);
  return { streamType: value, kind: classifyStreamTypeValue18(value), bytesRead };
}
