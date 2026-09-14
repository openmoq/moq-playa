/**
 * Object parsing (draft-einarsson-moq-locmaf-01 sections 7, 8, 9, 10, 18).
 * Ported from the Java LocmafDeserializerTest, plus the section 18 and
 * verbatim-carriage rules the Java implementation did not enforce.
 */
import { describe, it, expect } from 'vitest';
import { deserializeLocmafObject } from './deserializer.js';
import { LocmafFormatError } from './errors.js';
import { LocmafFieldId } from './fields.js';
import { ascii, concat, isoBox, vi } from '../test-support/bytes.js';

function sectionOf(payload: Uint8Array): string {
    try {
        deserializeLocmafObject(payload);
    } catch (e) {
        expect(e).toBeInstanceOf(LocmafFormatError);
        return (e as LocmafFormatError).section;
    }
    throw new Error('expected a LocmafFormatError');
}

describe('deserializeLocmafObject', () => {
    it('parses a genBox, a full header with list and scalars, and the mdat payload', () => {
        // 100 is one vi64 byte (the Java port's QUIC varint needed two).
        const props = vi(1, 1, 100, 10, 9000, 14, 2);
        const payload = concat(vi(1, 7), ascii('prft'), ascii('abc'), vi(2, props.length), props, Uint8Array.of(1, 2, 3, 4, 5));
        const object = deserializeLocmafObject(payload);
        expect(object.kind).toBe('moof');
        if (object.kind !== 'moof') return;
        expect(object.genBoxes).toHaveLength(1);
        expect(object.genBoxes[0]!.type).toBe('prft');
        expect(object.genBoxes[0]!.payload).toEqual(ascii('abc'));
        expect(object.header.full).toBe(true);
        expect(object.header.scalar(LocmafFieldId.TRUN_SAMPLE_COUNT)).toBe(2n);
        expect(object.header.scalar(LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME)).toBe(9000n);
        expect(object.header.list(LocmafFieldId.TRUN_SAMPLE_SIZES)).toEqual([100n]);
        expect(object.mdat).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
    });

    it('carries genBox and mdat bytes verbatim, without copying or re-parsing (sections 8.3, 8.5)', () => {
        // A 'prft' whose contents are far too short to be a real prft is still carried as-is.
        const payload = concat(vi(1, 5), ascii('prft'), Uint8Array.of(0xee), vi(3, 0), Uint8Array.of(9, 9));
        const object = deserializeLocmafObject(payload);
        if (object.kind !== 'moof') throw new Error('expected moof');
        expect(object.genBoxes[0]!.payload).toEqual(Uint8Array.of(0xee));
        expect(object.genBoxes[0]!.payload.buffer).toBe(payload.buffer);
        expect(object.mdat.buffer).toBe(payload.buffer);
    });

    it('parses an empty delta and a raw-bytes field', () => {
        let object = deserializeLocmafObject(concat(vi(3, 0), Uint8Array.of(9)));
        if (object.kind !== 'moof') throw new Error('expected moof');
        expect(object.header.full).toBe(false);
        expect(object.header.size).toBe(0);
        expect(object.mdat).toEqual(Uint8Array.of(9));

        const props = concat(vi(9, 2), Uint8Array.of(0xaa, 0xbb));
        object = deserializeLocmafObject(concat(vi(3, props.length), props));
        if (object.kind !== 'moof') throw new Error('expected moof');
        expect(object.header.bytes(LocmafFieldId.SENC_INITIALIZATION_VECTOR)).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(object.mdat.length).toBe(0);
    });

    it('skips unknown field IDs by parity (section 7.3)', () => {
        const props = concat(vi(100, 7), vi(101, 3), Uint8Array.of(1, 2, 3), vi(14, 1));
        const object = deserializeLocmafObject(concat(vi(2, props.length), props));
        if (object.kind !== 'moof') throw new Error('expected moof');
        expect(object.header.size).toBe(1);
        expect(object.header.scalar(LocmafFieldId.TRUN_SAMPLE_COUNT)).toBe(1n);
    });

    it('parses rawBoxes verbatim (section 9.4)', () => {
        const payload = concat(vi(4), isoBox('free', Uint8Array.of(1, 2)), isoBox('skip', new Uint8Array(0)));
        const object = deserializeLocmafObject(payload);
        expect(object.kind).toBe('rawBoxes');
        if (object.kind !== 'rawBoxes') return;
        expect(object.boxes).toEqual(payload.subarray(1));
        expect(object.boxes.buffer).toBe(payload.buffer);
    });

    it('rejects structural violations with the draft section', () => {
        expect(sectionOf(vi(5))).toBe('7.1'); // unknown element type
        expect(sectionOf(new Uint8Array(0))).toBe('7.1'); // empty object
        expect(sectionOf(concat(vi(1, 4), ascii('styp')))).toBe('7.1'); // no header element
        expect(sectionOf(concat(vi(1, 4), ascii('styp'), vi(4)))).toBe('9.2'); // rawBoxes after genBox
        expect(sectionOf(vi(1, 3))).toBe('8.1'); // box_size < 4
        expect(sectionOf(concat(vi(1, 9), ascii('styp')))).toBe('8.1'); // genBox beyond the object
        expect(sectionOf(concat(vi(1, 0xfffffffcn), ascii('styp')))).toBe('8.3'); // box_size above 0xFFFFFFFB
        expect(sectionOf(concat(vi(2, 4), vi(14, 1, 14, 2)))).toBe('7.3'); // repeated ID
        expect(sectionOf(concat(vi(2, 4), vi(100, 1, 100, 2)))).toBe('7.3'); // repeated unknown ID
        expect(sectionOf(concat(vi(3, 2), vi(10, 5)))).toBe('12.2'); // ID 10 in delta
        expect(sectionOf(concat(vi(2, 3), vi(27, 1, 12)))).toBe('10.4'); // ID 27 in full
        expect(sectionOf(concat(vi(2, 5), vi(14, 1)))).toBe('7.2'); // properties_length overruns
        expect(sectionOf(concat(vi(2, 3), vi(1, 5, 0)))).toBe('7.2'); // odd field overruns the block
        expect(sectionOf(concat(vi(2, 3), vi(1, 1), Uint8Array.of(0x80)))).toBe('7.2'); // truncated vi64 inside a list
        expect(sectionOf(vi(4))).toBe('9.1'); // empty rawBoxes
        expect(sectionOf(concat(vi(4), isoBox('free', Uint8Array.of(1)), Uint8Array.of(0)))).toBe('9.1'); // sizes don't sum
        expect(sectionOf(concat(vi(4), Uint8Array.of(0, 0, 0, 0), ascii('free')))).toBe('9.1'); // size escape 0
        expect(sectionOf(concat(vi(4), Uint8Array.of(0, 0, 0, 1), ascii('free'), new Uint8Array(8)))).toBe('9.1'); // size escape 1
    });

    it('reports byte offsets for the element that failed', () => {
        try {
            deserializeLocmafObject(concat(vi(1, 4), ascii('styp'), vi(7)));
            throw new Error('expected failure');
        } catch (e) {
            expect(e).toBeInstanceOf(LocmafFormatError);
            expect((e as LocmafFormatError).offset).toBe(6);
        }
    });
});
