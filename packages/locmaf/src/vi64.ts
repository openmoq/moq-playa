/**
 * vi64 variable-length integers and the zigzag signed mapping.
 *
 * LOCMAF defers vi64 to MOQT: the number of leading 1-bits in the first byte
 * gives the length (1 to 9 bytes), the remaining bits carry the value in network
 * byte order, covering 0 to 2^64-1. This is NOT the QUIC varint of draft-16 and
 * earlier. Wire values are `bigint`; {@link vi64ToNumber} converts where a
 * JavaScript number is required.
 *
 * @see draft-einarsson-moq-locmaf-01 section 2 (vi64), section 7.4 (zigzag)
 * @see draft-ietf-moq-transport-18 section 1.4.1
 * @module
 */

import { LocmafFormatError } from './errors.js';

/** Largest vi64 value: 2^64 - 1. */
export const MAX_VI64 = (1n << 64n) - 1n;

const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

/**
 * Minimal encoded length (1 to 9 bytes) of a vi64 value.
 * @throws {RangeError} when the value is negative or above 2^64-1.
 */
export function vi64Length(value: bigint): number {
    if (value < 0n || value > MAX_VI64) {
        throw new RangeError(`vi64 value out of range: ${value}`);
    }
    for (let len = 1; len <= 8; len++) {
        if (value < 1n << BigInt(7 * len)) return len;
    }
    return 9;
}

/**
 * Encode a vi64 value in its shortest form.
 * @throws {RangeError} when the value is negative or above 2^64-1.
 */
export function encodeVi64(value: bigint): Uint8Array {
    const len = vi64Length(value);
    const out = new Uint8Array(len);
    let v = value;
    for (let i = len - 1; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    if (len > 1) {
        out[0] = out[0]! | ((0xff << (9 - len)) & 0xff);
    }
    return out;
}

/**
 * Read a vi64 at `offset`. Non-minimal encodings are accepted.
 * @throws {LocmafFormatError} (section 7.2) when the buffer ends inside the value.
 */
export function readVi64(buf: Uint8Array, offset: number): { value: bigint; bytesRead: number } {
    if (offset >= buf.length) {
        throw new LocmafFormatError('7.2', offset, 'truncated vi64');
    }
    const first = buf[offset]!;
    let len = 1;
    for (let mask = 0x80; mask !== 0 && (first & mask) !== 0; mask >>= 1) len++;
    if (offset + len > buf.length) {
        throw new LocmafFormatError('7.2', offset, `truncated vi64 (${len} bytes)`);
    }
    let value = len === 9 ? 0n : BigInt(first & (0xff >> len));
    for (let i = 1; i < len; i++) {
        value = (value << 8n) | BigInt(buf[offset + i]!);
    }
    return { value, bytesRead: len };
}

/**
 * Zigzag-encode a signed 64-bit integer (section 7.4).
 * @throws {RangeError} when `n` is outside the signed 64-bit range.
 */
export function zigzagEncode(n: bigint): bigint {
    if (n < MIN_I64 || n > MAX_I64) {
        throw new RangeError(`zigzag input outside signed 64-bit range: ${n}`);
    }
    return n >= 0n ? n << 1n : (-n << 1n) - 1n;
}

/** Decode a zigzag value (section 7.4) back to a signed integer. */
export function zigzagDecode(z: bigint): bigint {
    return (z & 1n) === 0n ? z >> 1n : -((z + 1n) >> 1n);
}

/**
 * Convert a wire value to a JavaScript number.
 * @throws {RangeError} when the value is beyond `Number.MAX_SAFE_INTEGER`.
 */
export function vi64ToNumber(value: bigint, what = 'value'): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`${what} ${value} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
}
