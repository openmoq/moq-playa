/**
 * Shared NAL unit framing utilities for H.264/AVC and H.265/HEVC.
 *
 * Both codecs use identical length-prefix and Annex B start-code formats
 * for NAL unit delimiting. These utilities handle detection, validation,
 * and conversion between the two formats.
 *
 * @see draft-ietf-moq-loc-01 §2.1.3 (length prefixes in payload)
 * @see draft-ietf-moq-loc-01 §2.1.4 (start code prefixes in payload)
 * @see ISO/IEC 14496-15 §5.3.3.1 (AVC length-prefix format)
 * @see ISO/IEC 14496-15 §8.3.2 (HEVC length-prefix format)
 * @module
 */

/**
 * Validate length-prefixed NAL format: length fields must chain correctly
 * across the entire buffer with no leftover bytes.
 *
 * Checked BEFORE isAnnexB because payloads between 256-511 bytes have a
 * length prefix starting 00 00 01 xx which falsely matches the Annex B
 * 3-byte start code pattern.
 *
 * @param data Raw NAL unit payload
 * @param lengthSize Length prefix size in bytes (1-4, almost always 4)
 */
export function isValidLengthPrefixed(data: Uint8Array, lengthSize: number): boolean {
  if (data.byteLength < lengthSize + 1) return false;
  let pos = 0;
  while (pos < data.byteLength) {
    if (pos + lengthSize > data.byteLength) return false;
    let nalLength = 0;
    for (let i = 0; i < lengthSize; i++) {
      nalLength = (nalLength << 8) | data[pos + i]!;
    }
    pos += lengthSize;
    if (nalLength <= 0 || pos + nalLength > data.byteLength) return false;
    pos += nalLength;
  }
  return pos === data.byteLength;
}

/**
 * Detect Annex B start-code format.
 *
 * Checks for 3-byte (00 00 01) or 4-byte (00 00 00 01) start codes
 * at the beginning of the data.
 *
 * @see ITU-T H.264 §B.1 (byte stream NAL unit syntax)
 * @see ITU-T H.265 §B.1 (byte stream NAL unit syntax)
 */
export function isAnnexB(data: Uint8Array): boolean {
  if (data.byteLength < 3) return false;
  return (
    (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01) ||
    (data.byteLength >= 4 && data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x01)
  );
}

/**
 * Convert Annex B (start-code-delimited) to length-prefixed format.
 *
 * Scans for start codes, extracts NAL units between them, strips
 * trailing zero bytes, and reconstructs with length prefixes.
 *
 * Returns the original data reference if no start codes are found.
 *
 * @param data Annex B payload
 * @param lengthSize Length prefix size in bytes (1-4)
 * @see draft-ietf-moq-loc-01 §2.1.3 (length prefix SHOULD be 4 bytes)
 */
export function annexBToLengthPrefixed(data: Uint8Array, lengthSize: number): Uint8Array {
  const nalUnits: Uint8Array[] = [];
  let start = findStartCode(data, 0);

  if (start < 0) return data;

  while (start >= 0) {
    const startCodeLength = data[start + 2] === 0x01 ? 3 : 4;
    const nalStart = start + startCodeLength;
    let nextStart = findStartCode(data, nalStart);
    if (nextStart < 0) nextStart = data.byteLength;

    // Strip trailing zeros between NALs
    let nalEnd = nextStart;
    while (nalEnd > nalStart && data[nalEnd - 1] === 0x00) {
      nalEnd--;
    }

    if (nalEnd > nalStart) {
      nalUnits.push(data.subarray(nalStart, nalEnd));
    }
    start = nextStart < data.byteLength ? nextStart : -1;
  }

  if (nalUnits.length === 0) return data;

  const totalSize = nalUnits.reduce((sum, nal) => sum + lengthSize + nal.byteLength, 0);
  const out = new Uint8Array(totalSize);
  let pos = 0;

  for (const nal of nalUnits) {
    writeLength(out, pos, nal.byteLength, lengthSize);
    pos += lengthSize;
    out.set(nal, pos);
    pos += nal.byteLength;
  }

  return out;
}

/**
 * Find the next Annex B start code (00 00 01 or 00 00 00 01) at or after `from`.
 *
 * @returns Byte offset of the start code, or -1 if not found.
 */
export function findStartCode(data: Uint8Array, from: number): number {
  for (let i = from; i <= data.byteLength - 3; i++) {
    if (data[i] === 0x00 && data[i + 1] === 0x00) {
      if (data[i + 2] === 0x01) return i;
      if (i + 3 < data.byteLength && data[i + 2] === 0x00 && data[i + 3] === 0x01) return i;
    }
  }
  return -1;
}

/**
 * Write a big-endian unsigned integer length value into a buffer.
 *
 * @param buf Target buffer
 * @param pos Write offset
 * @param value Length value to write
 * @param lengthSize Number of bytes (1-4)
 */
export function writeLength(buf: Uint8Array, pos: number, value: number, lengthSize: number): void {
  for (let i = lengthSize - 1; i >= 0; i--) {
    buf[pos + i] = value & 0xFF;
    value >>>= 8;
  }
}
