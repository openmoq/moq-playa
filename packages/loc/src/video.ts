/**
 * Video Frame Marking — RFC 9626 bit-level parsing and encoding.
 *
 * The Video Frame Marking extension (LOC ID 4) carries RFC 9626 flags
 * packed into the least significant bits of a varint value.
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.2
 * @see RFC 9626 §3.1
 * @module
 */

import type { Varint } from '@moqt/transport';
import type { VideoFrameMarking } from './types.js';

/**
 * Parse RFC 9626 video frame marking flags from a varint value.
 *
 * Bit layout — first byte (always present):
 * ```
 * Bit 7: S — Start of frame
 * Bit 6: E — End of frame
 * Bit 5: I — Independent frame (keyframe)
 * Bit 4: D — Discardable frame
 * Bit 3: B — Base layer sync
 * Bits 2-0: TID — Temporal layer ID (0-7)
 * ```
 *
 * Second byte (present when varint value >= 256):
 * ```
 * Bits 7-0: LID — Layer ID (0-255)
 * ```
 *
 * LID presence is determined by byte count (value >= 256), NOT by the
 * B flag. RFC 9626 §3.1 uses the RTP extension L field for this; in
 * LOC the varint size serves the same purpose.
 *
 * @param value Varint value from LOC extension ID 4
 * @returns Parsed VideoFrameMarking
 * @see draft-ietf-moq-loc-01 §2.3.2.2
 * @see RFC 9626 §3.1
 */
export function parseVideoFrameMarking(value: Varint): VideoFrameMarking {
    const num = Number(value);

    // Determine byte count from varint value size.
    // 1 byte (value < 256): S|E|I|D|B|TID — no LID
    // 2 bytes (value >= 256): S|E|I|D|B|TID | LID(8)
    const hasLid = num >= 256;
    const firstByte = hasLid ? (num >> 8) & 0xFF : num & 0xFF;

    const startOfFrame = (firstByte & 0x80) !== 0;
    const endOfFrame = (firstByte & 0x40) !== 0;
    const independent = (firstByte & 0x20) !== 0;
    const discardable = (firstByte & 0x10) !== 0;
    const baseLayerSync = (firstByte & 0x08) !== 0;
    const temporalId = firstByte & 0x07;

    const result: VideoFrameMarking = {
        startOfFrame,
        endOfFrame,
        independent,
        discardable,
        baseLayerSync,
        temporalId,
    };

    if (hasLid) {
        // RFC 9626 §3.1: LID is 8 bits
        (result as any).layerId = num & 0xFF;
    }

    return result;
}

/**
 * Encode VideoFrameMarking into a bigint value for use in a varint.
 *
 * @param marking Structured video frame marking
 * @returns bigint value ready to be wrapped with `varint()`
 * @see draft-ietf-moq-loc-01 §2.3.2.2
 * @see RFC 9626 §3.1
 */
export function encodeVideoFrameMarking(marking: VideoFrameMarking): bigint {
    let firstByte = 0;
    if (marking.startOfFrame) firstByte |= 0x80;
    if (marking.endOfFrame) firstByte |= 0x40;
    if (marking.independent) firstByte |= 0x20;
    if (marking.discardable) firstByte |= 0x10;
    if (marking.baseLayerSync) firstByte |= 0x08;
    firstByte |= marking.temporalId & 0x07;

    if (marking.layerId !== undefined) {
        // RFC 9626 §3.1: LID is 8 bits
        const secondByte = marking.layerId & 0xFF;
        return BigInt((firstByte << 8) | secondByte);
    }

    return BigInt(firstByte);
}
