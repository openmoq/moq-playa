/**
 * LOCMAF Object parsing. Stateless: deltas are applied by the reconstructor.
 *
 * Returned genBox payloads, rawBoxes bytes and the mdat payload are subarrays
 * of the input (no copy): the draft carries them verbatim (sections 8.3, 9.4).
 *
 * @see draft-einarsson-moq-locmaf-01 sections 7, 8, 9, 18
 * @module
 */

import { LocmafFormatError } from './errors.js';
import { LocmafElementType, LocmafFieldId, fieldKind } from './fields.js';
import { LocmafHeader, type GenBox, type LocmafObject } from './model.js';
import { readVi64 } from './vi64.js';

/** Largest genBox box_size: L = 4 + box_size must fit 32 bits (section 8.3). */
export const MAX_GEN_BOX_SIZE = 0xfffffffbn;

/**
 * Parse one LOCMAF Object payload (section 7.1).
 * @throws {LocmafFormatError} for any structural violation.
 */
export function deserializeLocmafObject(payload: Uint8Array): LocmafObject {
    if (payload.length === 0) {
        throw new LocmafFormatError('7.1', 0, 'empty payload');
    }
    const genBoxes: GenBox[] = [];
    let pos = 0;
    for (;;) {
        if (pos >= payload.length) {
            throw new LocmafFormatError('7.1', pos, 'object ends before a header element');
        }
        const elementStart = pos;
        const type = readVi64(payload, pos);
        pos += type.bytesRead;
        switch (type.value) {
            case BigInt(LocmafElementType.RAW_BOXES):
                if (elementStart !== 0) {
                    throw new LocmafFormatError('9.2', elementStart, 'rawBoxes must be the sole element');
                }
                return { kind: 'rawBoxes', boxes: validateRawBoxes(payload.subarray(pos), pos) };
            case BigInt(LocmafElementType.GEN_BOX): {
                const { box, next } = readGenBox(payload, pos, elementStart);
                genBoxes.push(box);
                pos = next;
                break;
            }
            case BigInt(LocmafElementType.FULL_HEADER):
            case BigInt(LocmafElementType.DELTA_HEADER): {
                const full = type.value === BigInt(LocmafElementType.FULL_HEADER);
                const { header, end } = readHeader(payload, pos, full, elementStart);
                return { kind: 'moof', genBoxes, header, mdat: payload.subarray(end) };
            }
            default:
                throw new LocmafFormatError('7.1', elementStart, `unknown element_type ${type.value}`);
        }
    }
}

function readGenBox(payload: Uint8Array, pos: number, elementStart: number): { box: GenBox; next: number } {
    const size = readVi64(payload, pos);
    pos += size.bytesRead;
    if (size.value < 4n) {
        throw new LocmafFormatError('8.1', elementStart, `genBox box_size ${size.value} < 4`);
    }
    if (size.value > MAX_GEN_BOX_SIZE) {
        throw new LocmafFormatError('8.3', elementStart, `genBox box_size ${size.value} does not fit 32 bits`);
    }
    if (size.value > BigInt(payload.length - pos)) {
        throw new LocmafFormatError('8.1', elementStart, 'genBox exceeds the object payload');
    }
    const end = pos + Number(size.value);
    let type = '';
    for (let i = 0; i < 4; i++) type += String.fromCharCode(payload[pos + i]!);
    return { box: { type, payload: payload.subarray(pos + 4, end) }, next: end };
}

/**
 * Validate a rawBoxes body (sections 9.1, 18): one or more complete boxes, each
 * with a 32-bit size of at least 8, no size escapes, tiling the body exactly.
 */
export function validateRawBoxes(boxes: Uint8Array, baseOffset = 0): Uint8Array {
    if (boxes.length === 0) {
        throw new LocmafFormatError('9.1', baseOffset, 'empty rawBoxes');
    }
    const view = new DataView(boxes.buffer, boxes.byteOffset, boxes.byteLength);
    let pos = 0;
    while (pos < boxes.length) {
        if (boxes.length - pos < 8) {
            throw new LocmafFormatError('9.1', baseOffset + pos, 'truncated box header in rawBoxes');
        }
        const size = view.getUint32(pos);
        if (size === 0 || size === 1) {
            throw new LocmafFormatError('9.1', baseOffset + pos, `ISO size escape ${size} not allowed`);
        }
        if (size < 8 || size > boxes.length - pos) {
            throw new LocmafFormatError('9.1', baseOffset + pos, 'box sizes do not sum to the Object remainder');
        }
        pos += size;
    }
    return boxes;
}

function readHeader(
    payload: Uint8Array,
    pos: number,
    full: boolean,
    elementStart: number,
): { header: LocmafHeader; end: number } {
    const length = readVi64(payload, pos);
    pos += length.bytesRead;
    if (length.value > BigInt(payload.length - pos)) {
        throw new LocmafFormatError('7.2', elementStart, 'properties_length exceeds the object payload');
    }
    const end = pos + Number(length.value);
    const block = payload.subarray(0, end); // bound every read to the property block
    const header = new LocmafHeader(full);
    const seen = new Set<bigint>();
    while (pos < end) {
        const fieldStart = pos;
        const idv = readVi64(block, pos);
        pos += idv.bytesRead;
        if (seen.has(idv.value)) {
            throw new LocmafFormatError('7.3', fieldStart, `field ${idv.value} repeated`);
        }
        seen.add(idv.value);
        const known = idv.value <= 64n ? fieldKind(Number(idv.value)) : undefined;
        const id = Number(idv.value);
        if ((idv.value & 1n) === 0n) {
            const value = readVi64(block, pos);
            pos += value.bytesRead;
            if (known === undefined) continue;
            checkRestriction(full, id, fieldStart);
            header.set(id, { kind: 'scalar', value: value.value });
            continue;
        }
        const len = readVi64(block, pos);
        pos += len.bytesRead;
        if (len.value > BigInt(end - pos)) {
            throw new LocmafFormatError('7.2', fieldStart, `field ${idv.value} overruns the property block`);
        }
        const bytes = block.subarray(pos, pos + Number(len.value));
        const valueStart = pos;
        pos += bytes.length;
        if (known === undefined) continue;
        checkRestriction(full, id, fieldStart);
        if (known === 'bytes') {
            header.set(id, { kind: 'bytes', bytes });
        } else {
            header.set(id, { kind: 'list', values: readVi64List(bytes, valueStart) });
        }
    }
    return { header, end };
}

function checkRestriction(full: boolean, id: number, offset: number): void {
    if (full && id === LocmafFieldId.DELTA_DELETED_LOCMAF_IDS) {
        throw new LocmafFormatError('10.4', offset, 'field 27 in a full header');
    }
    if (!full && id === LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME) {
        throw new LocmafFormatError('12.2', offset, 'field 10 in a delta header');
    }
}

/**
 * Read concatenated vi64 elements. The element count is bounded by the byte
 * length (every vi64 is at least one byte), so allocation is bounded by the
 * payload (section 18).
 */
function readVi64List(bytes: Uint8Array, baseOffset: number): bigint[] {
    const out: bigint[] = [];
    let pos = 0;
    while (pos < bytes.length) {
        try {
            const v = readVi64(bytes, pos);
            out.push(v.value);
            pos += v.bytesRead;
        } catch (e) {
            if (e instanceof LocmafFormatError) {
                throw new LocmafFormatError('7.2', baseOffset + pos, 'truncated vi64 in list field');
            }
            throw e;
        }
    }
    return out;
}
