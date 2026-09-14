import { describe, it, expect } from 'vitest';
import { childBoxes, findChild, readBoxHeader } from './iso-box.js';
import { LocmafFormatError } from './errors.js';
import { ascii, concat, isoBox, u32, u64 } from '../test-support/bytes.js';

describe('ISO BMFF box reader', () => {
    it('reads 32-bit, 64-bit largesize and to-end boxes', () => {
        const small = isoBox('free', Uint8Array.of(1, 2));
        const large = concat(u32(1), ascii('skip'), u64(20n), Uint8Array.of(9, 9, 9, 9));
        const toEnd = concat(u32(0), ascii('mdat'), Uint8Array.of(7, 7, 7));
        const buf = concat(small, large, toEnd);
        const boxes = childBoxes(buf, 0, buf.length, '6');
        expect(boxes.map((b) => [b.type, b.start, b.headerSize, b.size, b.contentStart, b.end])).toEqual([
            ['free', 0, 8, 10, 8, 10],
            ['skip', 10, 16, 20, 26, 30],
            ['mdat', 30, 8, 11, 38, 41],
        ]);
        expect(findChild(buf, 0, buf.length, 'skip', '6')?.start).toBe(10);
        expect(findChild(buf, 0, buf.length, 'moov', '6')).toBeUndefined();
    });

    it('rejects sizes that overrun the parent or undercut the header', () => {
        expect(() => readBoxHeader(concat(u32(0x80000000), ascii('free')), 0, 8, '6')).toThrow(LocmafFormatError);
        expect(() => readBoxHeader(concat(u32(4), ascii('free')), 0, 8, '6')).toThrow(LocmafFormatError);
        expect(() => readBoxHeader(concat(u32(1), ascii('free'), u64(8n)), 0, 16, '6')).toThrow(LocmafFormatError);
        expect(() => readBoxHeader(Uint8Array.of(0, 0, 0), 0, 3, '6')).toThrow(LocmafFormatError);
        try {
            readBoxHeader(concat(new Uint8Array(4), u32(99), ascii('free')), 4, 12, '9.1');
        } catch (e) {
            expect((e as LocmafFormatError).section).toBe('9.1');
            expect((e as LocmafFormatError).offset).toBe(4);
        }
    });
});
