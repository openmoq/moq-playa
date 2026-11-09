import { describe, expect, it, vi as mock } from 'vitest';
import { deserializeLocmafObject } from './deserializer.js';
import { LocmafFormatError } from './errors.js';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import { LocmafHeader } from './model.js';
import { ascii, concat, isoBox, vi } from '../test-support/bytes.js';

function budget(maxEntries: number) {
    return new LocmafReadBudget({ maxSamples: 1, maxEntries, maxBytes: 1 });
}
const full = (extra: Uint8Array = new Uint8Array(0), count = 0) => {
    const properties = concat(vi(10, 0, 14, count), extra);
    return concat(vi(2, properties.length), properties, new Uint8Array(count));
};
const gen = () => concat(vi(1, 4), ascii('free'));
const parse = (bytes: Uint8Array, allowance: ReturnType<typeof budget>) =>
    deserializeLocmafObject(bytes, allowance);
function expectLimit(read: () => unknown): void {
    let failure: unknown;
    try { read(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: 'LocmafReadLimitError' });
    expect(failure).toBeInstanceOf(LocmafReadLimitError);
    expect(failure).not.toBeInstanceOf(LocmafFormatError);
}

describe('deserializer metadata allocation budget', () => {
    it('refuses excess genBox records', () => {
        expectLimit(() => parse(concat(gen(), gen(), full()), budget(1)));
    });

    it('refuses excess known field/seen records', () => {
        expectLimit(() => parse(full(), budget(1)));
    });

    it('counts unknown field IDs while skipping their values by parity', () => {
        const unknown = concat(vi(100, 7, 101, 3), Uint8Array.of(0x80, 0x80, 0x80));
        expectLimit(() => parse(full(unknown), budget(3)));
    });

    it('refuses a known list before materializing beyond its remaining allowance', () => {
        const values = vi(100, 100, 100);
        expectLimit(() => parse(full(concat(vi(3, values.length), values), 3), budget(4)));
    });

    it('shares cumulative allowance across parser calls', () => {
        const shared = budget(2);
        expect(parse(full(), shared).kind).toBe('moof');
        expectLimit(() => parse(full(), shared));
    });

    it('accepts exact combined capacity without inspecting unknown value bytes', () => {
        const values = vi(100, 100, 100);
        const payload = concat(gen(), full(concat(vi(3, values.length), values,
            vi(101, 3), Uint8Array.of(0x80, 0x80, 0x80)), 3));
        const allowance = budget(8);
        const result = parse(payload, allowance);
        expect(result.kind).toBe('moof');
        if (result.kind !== 'moof') throw new Error('Expected moof');
        expect(result.genBoxes).toHaveLength(1);
        expect(result.header.list(3)).toEqual([100n, 100n, 100n]);
        expect(result.header.size).toBe(3);
        expect(result.mdat.buffer).toBe(payload.buffer);
        expect(allowance.usage).toEqual({ samples: 0, entries: 8, bytes: 0 });
    });

    it('does not spend entries on the scalar rawBoxes validator', () => {
        const allowance = budget(1);
        allowance.claimEntries(1);
        const result = parse(concat(vi(4), isoBox('free', Uint8Array.of(1))), allowance);
        expect(result.kind).toBe('rawBoxes');
        expect(allowance.usage).toEqual({ samples: 0, entries: 1, bytes: 0 });
    });

    it('retains format errors with sufficient capacity and leaves default calls unchanged', () => {
        const repeated = concat(vi(2, 4), vi(100, 1, 100, 2));
        expect(() => parse(repeated, budget(8))).toThrow(LocmafFormatError);
        expect(deserializeLocmafObject(full()).kind).toBe('moof');
    });

    it('never stores an exhausted list and retains no parser state after refusal', () => {
        const values = vi(100, 100, 100), payload = full(concat(vi(3, values.length), values), 3);
        const allowance = budget(4), set = mock.spyOn(LocmafHeader.prototype, 'set');
        try {
            expectLimit(() => parse(payload, allowance));
            expect(set.mock.calls.map(([id]) => id)).toEqual([10, 14]);
            expect(allowance.usage).toEqual({ samples: 0, entries: 4, bytes: 0 });
        } finally { set.mockRestore(); }
        expect(parse(payload, budget(6)).kind).toBe('moof');
        expect(deserializeLocmafObject(payload).kind).toBe('moof');
    });

    it('leaves sample expansion and backing-byte accounting to their owners', () => {
        const allowance = budget(3);
        const payload = full(concat(vi(9, 2), Uint8Array.of(0xaa, 0xbb)), 99);
        const object = parse(payload, allowance);
        if (object.kind !== 'moof') throw new Error('Expected moof');
        expect(object.header.scalar(14)).toBe(99n);
        expect(object.header.bytes(9).buffer).toBe(payload.buffer);
        expect(object.mdat.buffer).toBe(payload.buffer);
        expect(allowance.usage).toEqual({ samples: 0, entries: 3, bytes: 0 });
    });

    it('keeps malformed lists and duplicate IDs as format errors with their section', () => {
        const malformed = concat(vi(2, 3), vi(1, 1), Uint8Array.of(0x80));
        expect(() => parse(malformed, budget(8))).toThrow(LocmafFormatError);
        const repeated = concat(vi(2, 4), vi(100, 1, 100, 2));
        const allowance = budget(1);
        try { parse(repeated, allowance); } catch (error) {
            expect(error).toBeInstanceOf(LocmafFormatError);
            expect(error).toMatchObject({ section: '7.3' });
            expect(allowance.usage.entries).toBe(1);
            return;
        }
        throw new Error('Expected format rejection');
    });
});
