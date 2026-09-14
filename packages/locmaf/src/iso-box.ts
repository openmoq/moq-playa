/**
 * Minimal, bounds-checked ISO BMFF box header reader.
 *
 * Self-contained so the codec has no dependency on a browser package. Supports
 * 32-bit sizes, 64-bit largesize (size 1), to-the-end boxes (size 0) and the
 * uuid extended type. Every size is checked against its parent before use.
 *
 * @see ISO/IEC 14496-12 section 4.2
 * @module
 */

import { LocmafFormatError } from './errors.js';

export interface IsoBoxHeader {
    /** FourCC. */
    readonly type: string;
    /** Offset of the first header byte. */
    readonly start: number;
    /** 8, 16 (largesize), plus 16 for a uuid extended type. */
    readonly headerSize: number;
    /** Total box size including the header. */
    readonly size: number;
    /** Offset of the first content byte. */
    readonly contentStart: number;
    /** Offset just past the box. */
    readonly end: number;
}

/** Read a FourCC at `offset` (caller guarantees 4 bytes). */
export function fourccAt(buf: Uint8Array, offset: number): string {
    return String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!);
}

/** A DataView over the whole array. */
export function viewOf(buf: Uint8Array): DataView {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Read one box header at `offset`, bounded by `limit`.
 * @param section draft section to report on malformation.
 * @throws {LocmafFormatError} when the header is truncated or its size is
 *   smaller than its header or extends past `limit`.
 */
export function readBoxHeader(buf: Uint8Array, offset: number, limit: number, section: string): IsoBoxHeader {
    const avail = limit - offset;
    if (avail < 8) {
        throw new LocmafFormatError(section, offset, 'truncated box header');
    }
    const view = viewOf(buf);
    const size32 = view.getUint32(offset);
    const type = fourccAt(buf, offset + 4);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
        if (avail < 16) {
            throw new LocmafFormatError(section, offset, `truncated largesize header for '${type}'`);
        }
        const large = view.getBigUint64(offset + 8);
        headerSize = 16;
        if (large > BigInt(avail)) {
            throw new LocmafFormatError(section, offset, `box '${type}' largesize ${large} exceeds its ${avail}-byte parent`);
        }
        size = Number(large);
    } else if (size32 === 0) {
        size = avail;
    } else {
        size = size32;
        if (size > avail) {
            throw new LocmafFormatError(section, offset, `box '${type}' size ${size} exceeds its ${avail}-byte parent`);
        }
    }
    if (type === 'uuid') headerSize += 16;
    if (size < headerSize) {
        throw new LocmafFormatError(section, offset, `box '${type}' size ${size} is smaller than its header`);
    }
    return { type, start: offset, headerSize, size, contentStart: offset + headerSize, end: offset + size };
}

/** All boxes tiling `[start, end)`. */
export function childBoxes(buf: Uint8Array, start: number, end: number, section: string): IsoBoxHeader[] {
    const out: IsoBoxHeader[] = [];
    let pos = start;
    while (pos < end) {
        const box = readBoxHeader(buf, pos, end, section);
        out.push(box);
        pos = box.end;
    }
    return out;
}

/** First child of the given type in `[start, end)`, or undefined. */
export function findChild(buf: Uint8Array, start: number, end: number, type: string, section: string): IsoBoxHeader | undefined {
    return childBoxes(buf, start, end, section).find((b) => b.type === type);
}
