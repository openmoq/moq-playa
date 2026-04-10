/**
 * Audio Level — RFC 6464 bit-level parsing and encoding.
 *
 * The Audio Level extension (LOC ID 6) carries RFC 6464 voice activity
 * and magnitude in the least significant 8 bits of a varint value.
 *
 * @see draft-ietf-moq-loc-01 §2.3.3.1
 * @see RFC 6464 §3
 * @module
 */

import type { Varint } from '@moqt/transport';
import type { AudioLevel } from './types.js';

/**
 * Parse RFC 6464 audio level from a varint value.
 *
 * Bit layout (least significant 8 bits):
 * ```
 * Bit 7: V — Voice activity (1 = speech detected)
 * Bits 6-0: level — Audio magnitude in -dBov (0 = loudest, 127 = silence)
 * ```
 *
 * @param value Varint value from LOC extension ID 6
 * @returns Parsed AudioLevel
 * @see draft-ietf-moq-loc-01 §2.3.3.1
 * @see RFC 6464 §3
 */
export function parseAudioLevel(value: Varint): AudioLevel {
    const byte = Number(value) & 0xFF;
    return {
        voiceActivity: (byte & 0x80) !== 0,
        level: byte & 0x7F,
    };
}

/**
 * Encode AudioLevel into a bigint value for use in a varint.
 *
 * @param al Structured audio level
 * @returns bigint value ready to be wrapped with `varint()`
 * @see draft-ietf-moq-loc-01 §2.3.3.1
 * @see RFC 6464 §3
 */
export function encodeAudioLevel(al: AudioLevel): bigint {
    let byte = al.level & 0x7F;
    if (al.voiceActivity) byte |= 0x80;
    return BigInt(byte);
}
