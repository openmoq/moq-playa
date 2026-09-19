/**
 * Object serialization in canonical layout (draft-einarsson-moq-locmaf-01
 * section 15.9). Ported from the Java LocmafSerializerTest.
 */
import { describe, it, expect } from 'vitest';
import { serializeLocmafObject } from './serializer.js';
import { deserializeLocmafObject } from './deserializer.js';
import { LocmafFieldId } from './fields.js';
import { LocmafHeader } from './model.js';
import { ascii, isoBox } from '../test-support/bytes.js';

describe('serializeLocmafObject', () => {
    it('writes fields in ascending ID order', () => {
        const header = new LocmafHeader(true);
        header.set(LocmafFieldId.TRUN_SAMPLE_COUNT, { kind: 'scalar', value: 1n });
        header.set(LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME, { kind: 'scalar', value: 5n });
        header.set(LocmafFieldId.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, { kind: 'list', values: [2n] });
        const bytes = serializeLocmafObject({ kind: 'moof', genBoxes: [], header, mdat: Uint8Array.of(7) });
        // type 2, len 7, (5, len 1, 2), (10, 5), (14, 1), mdat 7
        expect([...bytes]).toEqual([2, 7, 5, 1, 2, 10, 5, 14, 1, 7]);
    });

    it('writes genBoxes, then the header, then the mdat payload', () => {
        const bytes = serializeLocmafObject({
            kind: 'moof',
            genBoxes: [{ type: 'prft', payload: Uint8Array.of(9) }],
            header: new LocmafHeader(false),
            mdat: Uint8Array.of(1, 2),
        });
        expect(bytes).toEqual(Uint8Array.of(1, 5, ...ascii('prft'), 9, 3, 0, 1, 2));
    });

    it('writes rawBoxes verbatim', () => {
        const boxes = isoBox('free', Uint8Array.of(1));
        const bytes = serializeLocmafObject({ kind: 'rawBoxes', boxes });
        expect(bytes[0]).toBe(4);
        expect(bytes.subarray(1)).toEqual(boxes);
    });

    it('round-trips through the deserializer, including multi-byte vi64 values', () => {
        const header = new LocmafHeader(true);
        header.set(LocmafFieldId.TRUN_SAMPLE_COUNT, { kind: 'scalar', value: 3n });
        header.set(LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME, { kind: 'scalar', value: 1n << 40n });
        header.set(LocmafFieldId.TRUN_SAMPLE_SIZES, { kind: 'list', values: [100n, 20000n] });
        header.set(LocmafFieldId.SENC_INITIALIZATION_VECTOR, { kind: 'bytes', bytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) });
        const bytes = serializeLocmafObject({
            kind: 'moof',
            genBoxes: [{ type: 'emsg', payload: new Uint8Array(4) }],
            header,
            mdat: Uint8Array.of(1, 2, 3),
        });
        const parsed = deserializeLocmafObject(bytes);
        expect(serializeLocmafObject(parsed)).toEqual(bytes);
        if (parsed.kind !== 'moof') throw new Error('expected moof');
        expect(parsed.header.scalar(LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME)).toBe(1n << 40n);
        expect(parsed.header.list(LocmafFieldId.TRUN_SAMPLE_SIZES)).toEqual([100n, 20000n]);
    });

    it('rejects empty rawBoxes and malformed genBox types', () => {
        expect(() => serializeLocmafObject({ kind: 'rawBoxes', boxes: new Uint8Array(0) })).toThrow(RangeError);
        expect(() => serializeLocmafObject({
            kind: 'moof', genBoxes: [{ type: 'toolong', payload: new Uint8Array(0) }], header: new LocmafHeader(false), mdat: new Uint8Array(0),
        })).toThrow(RangeError);
    });
});
