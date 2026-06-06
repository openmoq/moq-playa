/**
 * vi64 — MoQT draft-18 variable-length integer encoding.
 *
 * The length is signalled by the number of leading 1-bits of the first byte:
 * `k` leading ones ⇒ a `k+1` byte encoding (k = 0..8, so 1..9 bytes). After the
 * leading ones and their terminating 0 bit, the remaining bits of the first byte
 * plus all subsequent bytes hold the value in network byte order. This covers
 * the full unsigned 64-bit range.
 *
 * Differences from the QUIC varint (`./varint.ts`, used by draft-14/16):
 *   - QUIC varint uses the top 2 bits for length (1/2/4/8 bytes, max 2^62-1).
 *   - vi64 uses unary leading-ones (1..9 bytes, max 2^64-1) and includes the
 *     7-byte length introduced in draft-18.
 *
 * Values are plain `bigint` — vi64 deliberately does NOT reuse the QUIC-varint
 * `Varint` brand, whose domain stops at 2^62-1. Wire encoding is a codec
 * concern; semantic integer types are chosen by the messages that carry them.
 *
 * Non-minimal encodings are valid on read (§1.4.1); `writeVi64` always emits the
 * minimal length.
 *
 * @see draft-ietf-moq-transport-18 §1.4.1
 * @module
 */

/** Maximum value representable as a vi64: 2^64 - 1. */
export const MAX_VI64 = 18446744073709551615n; // 2n ** 64n - 1n

function assertInRange(value: bigint): void {
  if (value < 0n || value > MAX_VI64) {
    throw new RangeError(`vi64 value must be 0 ≤ n ≤ ${MAX_VI64}, got ${value}`);
  }
}

/**
 * Minimal wire length (1–9 bytes) for a vi64 value.
 * @throws {RangeError} if value is negative or exceeds 2^64-1.
 */
export function vi64EncodingLength(value: bigint): number {
  assertInRange(value);
  if (value <= 0x7fn) return 1; //                      2^7  - 1
  if (value <= 0x3fffn) return 2; //                    2^14 - 1
  if (value <= 0x1fffffn) return 3; //                  2^21 - 1
  if (value <= 0xfffffffn) return 4; //                 2^28 - 1
  if (value <= 0x7ffffffffn) return 5; //               2^35 - 1
  if (value <= 0x3ffffffffffn) return 6; //             2^42 - 1
  if (value <= 0x1ffffffffffffn) return 7; //           2^49 - 1 (new in draft-18)
  if (value <= 0xffffffffffffffn) return 8; //          2^56 - 1
  return 9; //                                          2^64 - 1
}

/**
 * Read a vi64 from `buf` at `offset`.
 * @returns the decoded value and the number of bytes consumed.
 * @throws {RangeError} if the buffer is too short.
 */
export function readVi64(buf: Uint8Array, offset: number): { value: bigint; bytesRead: number } {
  if (offset >= buf.length) {
    throw new RangeError(`vi64 read out of bounds: offset ${offset}, length ${buf.length}`);
  }
  const first = buf[offset]!;

  // Count leading 1-bits of the first byte → length.
  let leadingOnes = 0;
  for (let mask = 0x80; mask !== 0 && (first & mask) !== 0; mask >>= 1) leadingOnes++;
  const len = leadingOnes + 1; // 1..9

  if (offset + len > buf.length) {
    throw new RangeError(`vi64 requires ${len} bytes but only ${buf.length - offset} available`);
  }

  // Value bits remaining in the first byte after the leading ones + terminating
  // 0 bit. For len 9 (first byte 0xFF) there are none.
  let value: bigint = len === 9 ? 0n : BigInt(first & (0xff >> len));
  for (let i = 1; i < len; i++) {
    value = (value << 8n) | BigInt(buf[offset + i]!);
  }
  return { value, bytesRead: len };
}

/**
 * Write a vi64 to `buf` at `offset` using the minimal encoding.
 * @returns the number of bytes written.
 * @throws {RangeError} if value is negative or exceeds 2^64-1.
 */
export function writeVi64(value: bigint, buf: Uint8Array, offset: number): number {
  const len = vi64EncodingLength(value);

  // Emit the low bytes first, then OR the length prefix into the first byte.
  for (let i = len - 1; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
  // Length prefix: the top `len-1` bits of the first byte set to 1. For len 9
  // that is 0xFF, which also leaves no value bits in the first byte.
  const prefix = len === 1 ? 0 : (0xff << (9 - len)) & 0xff;
  buf[offset] = buf[offset]! | prefix;
  return len;
}
