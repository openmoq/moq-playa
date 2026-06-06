/**
 * QUIC variable-length integer encoding.
 * @see RFC 9000 §16
 * @see draft-ietf-moq-transport-16 §1.4
 * @module
 */

/** Maximum value representable as a QUIC varint: 2^62 - 1 */
export const MAX_VARINT = 4611686018427387903n as Varint; // 2n**62n - 1n

declare const VARINT_BRAND: unique symbol;

/**
 * A branded bigint guaranteed to be a valid QUIC varint value:
 * non-negative integer ≤ MAX_VARINT (2^62 - 1).
 */
export type Varint = bigint & { readonly [VARINT_BRAND]: never };

/**
 * Validate and create a branded Varint value.
 * Accepts both number and bigint inputs.
 * @throws {RangeError} if value is negative, non-integer, or > MAX_VARINT
 */
export function varint(n: number | bigint): Varint {
  if (typeof n === 'number') {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(
        `Varint value must be a non-negative integer, got ${n}`,
      );
    }
    if (n > Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        `Varint number value ${n} exceeds MAX_SAFE_INTEGER; use bigint for values > 2^53-1`,
      );
    }
    return BigInt(n) as Varint;
  }
  // bigint path
  if (n < 0n || n > MAX_VARINT) {
    throw new RangeError(
      `Varint value must be 0 ≤ n ≤ ${MAX_VARINT}, got ${n}`,
    );
  }
  return n as Varint;
}

/**
 * Determine the wire encoding length of a varint value.
 *
 * Accepts a raw `bigint` (not just a branded {@link Varint}) so that message
 * fields widened to `bigint` for draft-18 (full uint64) can pass through the
 * draft-14/16 QUIC encoders — but a value outside the QUIC range is rejected
 * here rather than silently truncated, which is what keeps a draft-14/16 message
 * from ever encoding a value > 2^62-1.
 *
 * @see RFC 9000 §16 — first 2 bits encode length
 * @throws {RangeError} if value is negative or exceeds MAX_VARINT (2^62-1).
 */
export function varintEncodingLength(value: bigint): 1 | 2 | 4 | 8 {
  if (value < 0n || value > MAX_VARINT) {
    throw new RangeError(`QUIC varint value out of range (0..${MAX_VARINT}): ${value}`);
  }
  if (value <= 63n) return 1;
  if (value <= 16383n) return 2;
  if (value <= 1073741823n) return 4;
  return 8;
}

/**
 * Read a varint from a buffer at the given offset.
 * @see RFC 9000 §16
 * @throws {RangeError} if buffer is too short
 */
export function readVarint(
  buf: Uint8Array,
  offset: number,
): { value: Varint; bytesRead: number } {
  if (offset >= buf.length) {
    throw new RangeError(`Varint read out of bounds: offset ${offset}, length ${buf.length}`);
  }

  const first = buf[offset]!;
  const lengthFlag = first >> 6; // first 2 bits
  const bytesRead = (1 << lengthFlag) as 1 | 2 | 4 | 8;

  if (offset + bytesRead > buf.length) {
    throw new RangeError(
      `Varint requires ${bytesRead} bytes but only ${buf.length - offset} available`,
    );
  }

  let value: bigint;

  switch (bytesRead) {
    case 1:
      value = BigInt(first & 0x3f);
      break;
    case 2:
      value = BigInt(((first & 0x3f) << 8) | buf[offset + 1]!);
      break;
    case 4:
      value = BigInt(
        (((first & 0x3f) << 24) |
        (buf[offset + 1]! << 16) |
        (buf[offset + 2]! << 8) |
        buf[offset + 3]!) >>> 0,
      );
      break;
    case 8: {
      // Assemble all 8 bytes into a single bigint, masking the length flag bits
      value =
        (BigInt(first & 0x3f) << 56n) |
        (BigInt(buf[offset + 1]!) << 48n) |
        (BigInt(buf[offset + 2]!) << 40n) |
        (BigInt(buf[offset + 3]!) << 32n) |
        (BigInt(buf[offset + 4]!) << 24n) |
        (BigInt(buf[offset + 5]!) << 16n) |
        (BigInt(buf[offset + 6]!) << 8n) |
        BigInt(buf[offset + 7]!);
      break;
    }
  }

  return { value: value! as Varint, bytesRead };
}

/**
 * Write a varint to a buffer at the given offset.
 *
 * Accepts a raw `bigint`; out-of-QUIC-range values throw via
 * {@link varintEncodingLength} rather than being silently truncated.
 *
 * @see RFC 9000 §16
 * @returns Number of bytes written.
 * @throws {RangeError} if value is negative or exceeds MAX_VARINT (2^62-1).
 */
export function writeVarint(
  value: bigint,
  buf: Uint8Array,
  offset: number,
): number {
  const len = varintEncodingLength(value);

  switch (len) {
    case 1:
      buf[offset] = Number(value); // top 2 bits are 00
      return 1;
    case 2:
      buf[offset] = 0x40 | Number(value >> 8n);
      buf[offset + 1] = Number(value & 0xffn);
      return 2;
    case 4: {
      buf[offset] = 0x80 | Number((value >> 24n) & 0x3fn);
      buf[offset + 1] = Number((value >> 16n) & 0xffn);
      buf[offset + 2] = Number((value >> 8n) & 0xffn);
      buf[offset + 3] = Number(value & 0xffn);
      return 4;
    }
    case 8: {
      buf[offset] = 0xc0 | Number((value >> 56n) & 0x3fn);
      buf[offset + 1] = Number((value >> 48n) & 0xffn);
      buf[offset + 2] = Number((value >> 40n) & 0xffn);
      buf[offset + 3] = Number((value >> 32n) & 0xffn);
      buf[offset + 4] = Number((value >> 24n) & 0xffn);
      buf[offset + 5] = Number((value >> 16n) & 0xffn);
      buf[offset + 6] = Number((value >> 8n) & 0xffn);
      buf[offset + 7] = Number(value & 0xffn);
      return 8;
    }
  }
}
