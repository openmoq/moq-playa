import { describe, it, expect } from 'vitest';
import { parseEmsgBoxes, parseEmsgPayload } from './emsg.js';
import { LocmafFormatError } from './errors.js';
import { deserializeLocmafObject } from './deserializer.js';
import { concat, u32 } from '../test-support/bytes.js';

/** The emsg genBox of the Eyevinn event-only vector, object 0 (version 1). */
const VECTOR_EMSG = Uint8Array.from(Buffer.from('0100000000015f900000000000005f9000000bb80000000175726e3a79006500', 'hex'));

function u64(v: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, v);
    return out;
}

const nul = (s: string) => concat(new TextEncoder().encode(s), Uint8Array.of(0));

describe('parseEmsgPayload (ISO 23009-1 emsg, section 14 event-only tracks)', () => {
    it('parses the version-1 box of the Eyevinn event-only vector', () => {
        expect(parseEmsgPayload(VECTOR_EMSG)).toEqual({
            version: 1,
            schemeIdUri: 'urn:y',
            value: 'e',
            timescale: 90000,
            presentationTime: 24464n,
            presentationTimeIsDelta: false,
            eventDuration: 3000,
            id: 1,
            messageData: new Uint8Array(0),
        });
    });

    it('parses a version-0 box with a presentation time delta and message data', () => {
        const payload = concat(Uint8Array.of(0, 0, 0, 0), nul('urn:scte:scte35:2013:bin'), nul(''),
            u32(1000), u32(250), u32(0xffffffff), u32(7), Uint8Array.of(0xfc, 0x30));
        expect(parseEmsgPayload(payload)).toEqual({
            version: 0,
            schemeIdUri: 'urn:scte:scte35:2013:bin',
            value: '',
            timescale: 1000,
            presentationTime: 250n,
            presentationTimeIsDelta: true,
            eventDuration: 0xffffffff,
            id: 7,
            messageData: Uint8Array.of(0xfc, 0x30),
        });
    });

    it('keeps version-1 message data after the strings', () => {
        const payload = concat(Uint8Array.of(1, 0, 0, 0), u32(90000), u64(5n), u32(1), u32(2), nul('urn:x'), nul('v'), Uint8Array.of(9));
        expect(parseEmsgPayload(payload).messageData).toEqual(Uint8Array.of(9));
    });

    it('rejects truncated boxes and unknown versions', () => {
        expect(() => parseEmsgPayload(Uint8Array.of(1, 0, 0))).toThrow(LocmafFormatError);
        expect(() => parseEmsgPayload(VECTOR_EMSG.subarray(0, 20))).toThrow(LocmafFormatError);
        expect(() => parseEmsgPayload(concat(Uint8Array.of(0, 0, 0, 0), new TextEncoder().encode('urn:x')))).toThrow(LocmafFormatError);
        expect(() => parseEmsgPayload(concat(Uint8Array.of(2, 0, 0, 0), VECTOR_EMSG.subarray(4)))).toThrow(LocmafFormatError);
    });
});

describe('parseEmsgBoxes', () => {
    it('reads every emsg genBox of a deserialized event-only object and skips other box types', () => {
        const objectBytes = Uint8Array.from(Buffer.from(
            '0124656d73670100000000015f900000000000005f9000000bb800000001' + '75726e3a790065000204' + '0a000e00', 'hex'));
        const object = deserializeLocmafObject(objectBytes);
        expect(object.kind).toBe('moof');
        if (object.kind !== 'moof') return;
        const events = parseEmsgBoxes([{ type: 'free', payload: new Uint8Array(0) }, ...object.genBoxes]);
        expect(events.length).toBe(1);
        expect(events[0]!.schemeIdUri).toBe('urn:y');
        expect(events[0]!.presentationTime).toBe(24464n);
    });
});
