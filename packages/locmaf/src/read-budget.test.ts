import { describe, expect, it } from 'vitest';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import { LocmafFormatError } from './errors.js';

describe('LocmafReadBudget', () => {
    it('claims cumulative capacity including zero and exact limits', () => {
        const budget = new LocmafReadBudget({ maxSamples: 3, maxEntries: 4, maxBytes: 5 });
        budget.claimSamples(0); budget.claimEntries(0); budget.claimBytes(0);
        budget.claimSamples(1); budget.claimSamples(2);
        budget.claimEntries(1); budget.claimEntries(3);
        budget.claimBytes(2); budget.claimBytes(3);
        expect(budget.usage).toEqual({ samples: 3, entries: 4, bytes: 5 });
        for (const claim of [() => budget.claimSamples(1), () => budget.claimEntries(1), () => budget.claimBytes(1)]) {
            expect(claim).toThrow(LocmafReadLimitError);
            expect(budget.usage).toEqual({ samples: 3, entries: 4, bytes: 5 });
        }
    });

    it('checks samples without reserving or double-charging them', () => {
        const budget = new LocmafReadBudget({ maxSamples: 3, maxEntries: 1, maxBytes: 1 });
        budget.checkSamples(3); budget.checkSamples(3); budget.checkSamples(0);
        expect(budget.usage.samples).toBe(0);
        budget.claimSamples(2);
        budget.checkSamples(1); budget.checkSamples(1);
        expect(() => budget.checkSamples(2)).toThrow(LocmafReadLimitError);
        expect(budget.usage.samples).toBe(2);
        budget.claimSamples(1);
        expect(budget.usage.samples).toBe(3);
        budget.checkSamples(0);
    });

    it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limit %s', invalid => {
        for (const key of ['maxSamples', 'maxEntries', 'maxBytes'] as const) {
            expect(() => new LocmafReadBudget({ maxSamples: 1, maxEntries: 1, maxBytes: 1, [key]: invalid }))
                .toThrow(RangeError);
        }
    });

    it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid claim/check %s without consuming capacity', invalid => {
        const budget = new LocmafReadBudget({ maxSamples: 4, maxEntries: 4, maxBytes: 4 });
        for (const claim of [() => budget.checkSamples(invalid), () => budget.claimSamples(invalid),
            () => budget.claimEntries(invalid), () => budget.claimBytes(invalid)]) {
            expect(claim).toThrow(RangeError);
            expect(budget.usage).toEqual({ samples: 0, entries: 0, bytes: 0 });
        }
    });

    it('checks safe-integer capacity without overflowing the addition', () => {
        const budget = new LocmafReadBudget({ maxSamples: Number.MAX_SAFE_INTEGER,
            maxEntries: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER });
        budget.claimSamples(Number.MAX_SAFE_INTEGER - 1);
        budget.claimEntries(Number.MAX_SAFE_INTEGER);
        budget.claimBytes(Number.MAX_SAFE_INTEGER);
        expect(() => budget.claimSamples(2)).toThrow(LocmafReadLimitError);
        expect(budget.usage.samples).toBe(Number.MAX_SAFE_INTEGER - 1);
        budget.claimSamples(1);
        budget.claimEntries(0); budget.claimBytes(0);
        expect(budget.usage.samples).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('snapshots each limit getter once and retains no caller object', () => {
        const reads = { samples: 0, entries: 0, bytes: 0 };
        let limit = 2;
        const budget = new LocmafReadBudget({
            get maxSamples() { reads.samples++; return limit; },
            get maxEntries() { reads.entries++; return limit; },
            get maxBytes() { reads.bytes++; return limit; },
        });
        limit = 100;
        budget.claimSamples(2); budget.claimEntries(2); budget.claimBytes(2);
        expect(() => budget.claimSamples(1)).toThrow(LocmafReadLimitError);
        expect(() => budget.claimEntries(1)).toThrow(LocmafReadLimitError);
        expect(() => budget.claimBytes(1)).toThrow(LocmafReadLimitError);
        expect(reads).toEqual({ samples: 1, entries: 1, bytes: 1 });
    });

    it('returns frozen detached usage snapshots', () => {
        const budget = new LocmafReadBudget({ maxSamples: 2, maxEntries: 2, maxBytes: 2 });
        const before = budget.usage;
        expect(Object.isFrozen(before)).toBe(true);
        expect(Reflect.set(before, 'samples', 100)).toBe(false);
        budget.claimSamples(1);
        expect(before).toEqual({ samples: 0, entries: 0, bytes: 0 });
        expect(budget.usage).toEqual({ samples: 1, entries: 0, bytes: 0 });
    });

    it('does not coerce a claim object or label resource refusal as malformed media', () => {
        const budget = new LocmafReadBudget({ maxSamples: 1, maxEntries: 1, maxBytes: 1 });
        let coerced = false;
        expect(() => Reflect.apply(budget.claimEntries, budget, [{ valueOf() { coerced = true; return 1; } }]))
            .toThrow(RangeError);
        expect(coerced).toBe(false);
        try { budget.claimEntries(2); } catch (error) {
            expect(error).toBeInstanceOf(LocmafReadLimitError);
            expect(error).not.toBeInstanceOf(LocmafFormatError);
            expect(error).toMatchObject({ name: 'LocmafReadLimitError' });
            return;
        }
        throw new Error('Expected local resource refusal');
    });
});
