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

import { LocHeaderError } from './errors.js';
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
 * @param value Integer value (varint/vi64) from LOC extension ID 4
 * @returns Parsed VideoFrameMarking
 * @see draft-ietf-moq-loc-01 §2.3.2.2
 * @see RFC 9626 §3.1
 */
export function parseVideoFrameMarking(value: bigint): VideoFrameMarking {
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

// ─── Shared first-byte helpers (LOC-01 integer form and LOC-04 byte form) ──

/** Read the S|E|I|D|B|TID byte shared by both forms. */
function fromFirstByte(firstByte: number): VideoFrameMarking {
    return {
        startOfFrame: (firstByte & 0x80) !== 0,
        endOfFrame: (firstByte & 0x40) !== 0,
        independent: (firstByte & 0x20) !== 0,
        discardable: (firstByte & 0x10) !== 0,
        baseLayerSync: (firstByte & 0x08) !== 0,
        temporalId: firstByte & 0x07,
    };
}

function toFirstByte(marking: VideoFrameMarking): number {
    let b = 0;
    if (marking.startOfFrame) b |= 0x80;
    if (marking.endOfFrame) b |= 0x40;
    if (marking.independent) b |= 0x20;
    if (marking.discardable) b |= 0x10;
    if (marking.baseLayerSync) b |= 0x08;
    return b | (marking.temporalId & 0x07);
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
    const firstByte = toFirstByte(marking);
    if (marking.layerId !== undefined) {
        return BigInt((firstByte << 8) | (marking.layerId & 0xFF));
    }
    return BigInt(firstByte);
}

// ─── LOC-04 byte form ───────────────────────────────────────────────

/**
 * Parse the LOC-04 Video Frame Marking byte form.
 *
 * RFC 9626 §3.1 defines a 1-byte short header (S|E|I|D|B|TID) and a 3-byte
 * long header that appends LID and TL0PICIDX. draft-04 allows 1 to 4 bytes:
 * a 2-byte value is read as short header plus LID, and a fourth byte is
 * accepted and ignored. Anything else is malformed.
 *
 * @see draft-ietf-moq-loc-04 §2.3.2.2
 * @see RFC 9626 §3.1
 */
export function parseVideoFrameMarkingBytes(bytes: Uint8Array): VideoFrameMarking {
    if (bytes.length < 1 || bytes.length > 4) {
        throw new LocHeaderError('videoFrameMarking', `expected 1 to 4 bytes, got ${bytes.length}`);
    }
    const result = fromFirstByte(bytes[0]!) as { -readonly [K in keyof VideoFrameMarking]: VideoFrameMarking[K] };
    if (bytes.length >= 2) result.layerId = bytes[1]!;
    if (bytes.length >= 3) result.tl0PicIdx = bytes[2]!;
    return result;
}

/**
 * Encode the LOC-04 Video Frame Marking byte form: 1 byte without a layer id,
 * otherwise the 3-byte long header with `tl0PicIdx` defaulting to 0.
 *
 * @see draft-ietf-moq-loc-04 §2.3.2.2
 * @see RFC 9626 §3.1
 */
export function encodeVideoFrameMarkingBytes(marking: VideoFrameMarking): Uint8Array {
    const first = toFirstByte(marking);
    if (marking.layerId === undefined) return Uint8Array.from([first]);
    return Uint8Array.from([first, marking.layerId & 0xff, (marking.tl0PicIdx ?? 0) & 0xff]);
}
