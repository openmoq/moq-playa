/**
 * LOCMAF Object serialization in the canonical layout: genBoxes in order,
 * header fields in ascending ID order, shortest vi64 forms.
 *
 * @see draft-einarsson-moq-locmaf-01 sections 7, 15.9
 * @module
 */

import { ByteWriter } from './byte-writer.js';
import { MAX_GEN_BOX_SIZE, validateRawBoxes } from './deserializer.js';
import { LocmafElementType } from './fields.js';
import type { LocmafHeader, LocmafObject } from './model.js';

/**
 * Serialize a LOCMAF Object.
 * @throws {RangeError} for an empty or malformed rawBoxes body, a genBox type
 *   that is not a FourCC, or a genBox too large for a 32-bit box size.
 */
export function serializeLocmafObject(object: LocmafObject): Uint8Array {
    const out = new ByteWriter();
    if (object.kind === 'rawBoxes') {
        try {
            validateRawBoxes(object.boxes);
        } catch (e) {
            throw new RangeError(`invalid rawBoxes body: ${(e as Error).message}`);
        }
        out.vi64(BigInt(LocmafElementType.RAW_BOXES));
        out.bytes(object.boxes);
        return out.finish();
    }
    for (const box of object.genBoxes) {
        if (box.type.length !== 4 || /[^\x00-\xff]/.test(box.type)) {
            throw new RangeError(`genBox type "${box.type}" is not a FourCC`);
        }
        const size = 4n + BigInt(box.payload.length);
        if (size > MAX_GEN_BOX_SIZE) {
            throw new RangeError(`genBox ${box.type} exceeds a 32-bit box size (section 8.3)`);
        }
        out.vi64(BigInt(LocmafElementType.GEN_BOX));
        out.vi64(size);
        out.fourcc(box.type);
        out.bytes(box.payload);
    }
    const properties = serializeProperties(object.header);
    out.vi64(BigInt(object.header.full ? LocmafElementType.FULL_HEADER : LocmafElementType.DELTA_HEADER));
    out.vi64(BigInt(properties.length));
    out.bytes(properties);
    out.bytes(object.mdat);
    return out.finish();
}

/** The property block of a header, fields in ascending ID order (section 7.3). */
export function serializeProperties(header: LocmafHeader): Uint8Array {
    const out = new ByteWriter();
    for (const id of header.ids()) {
        const value = header.get(id)!;
        out.vi64(BigInt(id));
        if (value.kind === 'scalar') {
            out.vi64(value.value);
        } else if (value.kind === 'bytes') {
            out.vi64(BigInt(value.bytes.length));
            out.bytes(value.bytes);
        } else {
            const list = new ByteWriter(value.values.length + 8);
            for (const element of value.values) list.vi64(element);
            out.vi64(BigInt(list.length));
            out.bytes(list.finish());
        }
    }
    return out.finish();
}
