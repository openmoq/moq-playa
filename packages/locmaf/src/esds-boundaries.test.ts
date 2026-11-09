import { describe, expect, it, vi } from 'vitest';
import { codecDescriptionFromInit } from './frame.js';
import { childBoxes, type IsoBoxHeader } from './iso-box.js';
import { audioInit } from '../test-support/cmaf.js';
import { concat, fullBox, isoBox } from '../test-support/bytes.js';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import { LocmafFormatError } from './errors.js';

const asc = Uint8Array.of(0x12, 0x10);
const configFields = Uint8Array.of(0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const esFields = Uint8Array.of(0, 1, 0);
const sl = Uint8Array.of(6, 1, 2);
function length(value: number, width = 1): Uint8Array {
    const bytes = new Uint8Array(width);
    for (let i = width - 1; i >= 0; i--) {
        bytes[i] = (value & 0x7f) | (i < width - 1 ? 0x80 : 0);
        value = Math.floor(value / 128);
    }
    if (value !== 0) throw new Error('Fixture length does not fit');
    return bytes;
}
const descriptor = (tag: number, body: Uint8Array, width = 1) => concat(Uint8Array.of(tag), length(body.length, width), body);
const decoder = (inner: Uint8Array, width = 1) => descriptor(4, concat(configFields, inner), width);
const es = (inner: Uint8Array, width = 1) => descriptor(3, concat(esFields, inner, sl), width);

// Replace only esds while rebuilding the actual audioInit ancestors' lengths.
function init(descriptors: Uint8Array): Uint8Array {
    const bytes = audioInit(), chain: IsoBoxHeader[] = [];
    let start = 0, end = bytes.length;
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a', 'esds']) {
        const box = childBoxes(bytes, start, end, '6').find(value => value.type === type);
        if (!box) throw new Error('Missing fixture box ' + type);
        chain.push(box);
        start = box.contentStart + (type === 'stsd' ? 8 : type === 'mp4a' ? 28 : 0);
        end = box.end;
    }
    let child = chain.pop();
    if (!child) throw new Error('Missing fixture esds');
    let replacement = fullBox('esds', 0, 0, descriptors);
    while (chain.length) {
        const parent = chain.pop()!;
        replacement = isoBox(parent.type, bytes.subarray(parent.contentStart, child.start),
            replacement, bytes.subarray(child.end, parent.end));
        child = parent;
    }
    return concat(bytes.subarray(0, child.start), replacement, bytes.subarray(child.end));
}

function malformed(descriptors: Uint8Array): void {
    let result: Uint8Array | null | undefined, error: unknown;
    try { result = codecDescriptionFromInit(init(descriptors)); } catch (failure) { error = failure; }
    expect({ error: error instanceof Error ? error.name : null,
        config: result === undefined || result === null ? result : Array.from(result) })
        .toEqual({ error: 'LocmafFormatError', config: undefined });
}

describe('ESDS nested descriptor boundaries', () => {
    it('rejects a truncated inner payload rather than clamping it to esds', () => {
        malformed(es(decoder(concat(Uint8Array.of(5, 127), asc))));
    });

    it('does not borrow the ES sibling as DecoderSpecificInfo payload', () => {
        malformed(es(decoder(concat(Uint8Array.of(5, 3), asc))));
    });

    it('rejects an unterminated inner length instead of returning empty config', () => {
        malformed(es(decoder(Uint8Array.of(5, 0x80, 0x80, 0x80, 0x80))));
    });

    it('rejects a DecoderConfigDescriptor declaring bytes outside its ES parent', () => {
        const body = concat(configFields, descriptor(5, asc));
        malformed(es(concat(Uint8Array.of(4, 127), body)));
    });

    it('rejects an ES descriptor declaring bytes outside its esds box', () => {
        malformed(concat(Uint8Array.of(3, 127), esFields, decoder(descriptor(5, asc)), sl));
    });

    it.each([1, 2, 3, 4])('preserves valid AAC with %i-byte expandable lengths', width => {
        expect(codecDescriptionFromInit(init(es(decoder(descriptor(5, asc, width), width), width)))).toEqual(asc);
    });

    it('preserves the original AAC fixture and missing optional specific info', () => {
        expect(codecDescriptionFromInit(audioInit())).toEqual(asc);
        expect(codecDescriptionFromInit(init(es(decoder(new Uint8Array(0)))))).toBeNull();
    });

    it('preserves all ES optional fixed fields and bounded URL bytes', () => {
        const fields = Uint8Array.of(0, 1, 0xe0, 0, 2, 3, 65, 66, 67, 0, 3);
        expect(codecDescriptionFromInit(init(descriptor(3, concat(fields, decoder(descriptor(5, asc)), sl)))))
            .toEqual(asc);
    });

    it.each(['ES', 'DecoderConfig'])('classifies truncated %s fixed fields as malformed', kind => {
        malformed(kind === 'ES' ? descriptor(3, Uint8Array.of(0, 1))
            : es(descriptor(4, new Uint8Array(12))));
    });

    it('refuses an ES URL extending beyond its descriptor', () => {
        malformed(descriptor(3, Uint8Array.of(0, 1, 0x40, 5, 65, 66)));
    });

    it('skips a bounded unknown descriptor without interpreting its body', () => {
        expect(codecDescriptionFromInit(init(es(decoder(concat(
            descriptor(0xc0, Uint8Array.of(0x80)), descriptor(5, asc))))))).toEqual(asc);
    });

    it('returns no config for a bounded unsupported root tag', () => {
        expect(codecDescriptionFromInit(init(descriptor(0xc0, Uint8Array.of(1))))).toBeNull();
    });

    it('refuses a wider length profile without declaring it malformed or inventing config', () => {
        const inner = concat(Uint8Array.of(5, 0x80, 0x80, 0x80, 0x80, 2), asc);
        expect(codecDescriptionFromInit(init(es(decoder(inner))))).toBeNull();
    });

    it('preserves exact AAC byte accounting and refuses the copy before allocation', () => {
        const bytes = init(es(decoder(descriptor(5, asc))));
        const exact = new LocmafReadBudget({ maxSamples: 1, maxEntries: 1000, maxBytes: 2 });
        expect(codecDescriptionFromInit(bytes, exact)).toEqual(asc);
        expect(exact.usage).toMatchObject({ samples: 0, bytes: 2 });
        const short = new LocmafReadBudget({ maxSamples: 1, maxEntries: 1000, maxBytes: 1 });
        const slices = vi.spyOn(Uint8Array.prototype, 'slice');
        try {
            expect(() => codecDescriptionFromInit(bytes, short)).toThrow(LocmafReadLimitError);
            expect(slices).not.toHaveBeenCalled();
            expect(short.usage.bytes).toBe(0);
        } finally { slices.mockRestore(); }
    });

    it('never copies or charges config bytes for malformed descriptor payload', () => {
        const bytes = init(es(decoder(concat(Uint8Array.of(5, 127), asc))));
        const allowance = new LocmafReadBudget({ maxSamples: 1, maxEntries: 1000, maxBytes: 2 });
        const slices = vi.spyOn(Uint8Array.prototype, 'slice');
        try {
            expect(() => codecDescriptionFromInit(bytes, allowance)).toThrow(LocmafFormatError);
            expect(slices).not.toHaveBeenCalled();
            expect(allowance.usage.bytes).toBe(0);
        } finally { slices.mockRestore(); }
    });
});
