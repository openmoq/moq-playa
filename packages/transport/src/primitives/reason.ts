/**
 * Reason Phrase encoding per draft-ietf-moq-transport-16 §1.4.3.
 * Varint length + UTF-8 bytes.
 * @module
 */

import { readVarint, writeVarint, varint, varintEncodingLength } from './varint.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Read a Reason Phrase (varint length + UTF-8 string). */
export function readReasonPhrase(
  buf: Uint8Array,
  offset: number,
): { value: string; bytesRead: number } {
  let pos = offset;
  const { value: length, bytesRead: lenBytes } = readVarint(buf, pos);
  pos += lenBytes;
  const numLen = Number(length);
  if (numLen > 1024) {
    throw new RangeError(
      `Reason Phrase length ${numLen} exceeds maximum 1024 bytes`,
    );
  }
  if (pos + numLen > buf.length) {
    throw new RangeError(
      `Reason Phrase declared length ${numLen} exceeds remaining buffer (${buf.length - pos} bytes available)`,
    );
  }
  const strBytes = buf.slice(pos, pos + numLen);
  const value = decoder.decode(strBytes);
  pos += numLen;
  return { value, bytesRead: pos - offset };
}

/** Write a Reason Phrase (varint length + UTF-8 string). Returns bytes written. */
export function writeReasonPhrase(
  reason: string,
  buf: Uint8Array,
  offset: number,
): number {
  const encoded = encoder.encode(reason);
  if (encoded.length > 1024) {
    throw new RangeError(
      `Reason Phrase length ${encoded.length} exceeds maximum 1024 bytes`,
    );
  }
  let pos = offset;
  pos += writeVarint(varint(encoded.length), buf, pos);
  buf.set(encoded, pos);
  pos += encoded.length;
  return pos - offset;
}

/** Calculate encoding length for a Reason Phrase. */
export function reasonPhraseEncodingLength(reason: string): number {
  const byteLen = encoder.encode(reason).length;
  return varintEncodingLength(varint(byteLen)) + byteLen;
}
