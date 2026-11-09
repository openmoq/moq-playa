import { describe, expect, it, vi } from 'vitest';
import { LocmafHeader } from './model.js';
import { LocmafGroupState } from './group-state.js';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import { LocmafReconstructor } from './reconstruct.js';
import { parseLocmafTrackContext } from './track-context.js';
import type { LocmafEffectiveSamples } from './effective.js';
import { zigzagEncode } from './vi64.js';
import { fullHeader, setScalar } from '../test-support/locmaf.js';
import { SYNC_FLAGS, videoInit } from '../test-support/cmaf.js';

function header() {
    const value = fullHeader(2, 9000);
    value.set(3, { kind: 'list', values: Object.freeze([3000n, 3000n]) });
    value.set(1, { kind: 'list', values: Object.freeze([4n]) });
    value.set(9, { kind: 'bytes', bytes: new Uint8Array(32) });
    return value;
}
function effective(cenc: LocmafEffectiveSamples['cenc'] = null): LocmafEffectiveSamples {
    return Object.freeze({ baseMediaDecodeTime: 9000n, sampleDescriptionIndex: 1,
        durations: Object.freeze([3000, 3000]), sizes: Object.freeze([4, 4]),
        flags: Object.freeze([SYNC_FLAGS, SYNC_FLAGS]), compositionTimeOffsets: Object.freeze([0, -100]), cenc });
}
function anchored(cenc: LocmafEffectiveSamples['cenc'] = null) {
    const state = new LocmafGroupState(), represented = header(), values = effective(cenc);
    state.anchor(represented, values, 5n);
    return { state, represented, values };
}
const budget = (entries: number) => new LocmafReadBudget({ maxSamples: 1, maxEntries: entries, maxBytes: 1 });

describe('Header and Group reference entry counts', () => {
    it('counts actual Header fields and list slots, not byte payload length', () => {
        const value = header();
        expect(value.size).toBe(5);
        expect(value.retainedEntryCount).toBe(8);
        value.set(3, { kind: 'list', values: [1n] });
        expect(value.retainedEntryCount).toBe(7);
        value.delete(1);
        expect(value.retainedEntryCount).toBe(5);
        value.set(9, { kind: 'bytes', bytes: new Uint8Array(64) });
        expect(value.retainedEntryCount).toBe(5);
    });

    it('reads the private Header map without ids/copy helpers or mutation', () => {
        const value = header(), ids = vi.spyOn(value, 'ids'), copy = vi.spyOn(value, 'copy');
        for (let i = 0; i < 3; i++) expect(value.retainedEntryCount).toBe(8);
        expect(ids).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled();
        expect(value.size).toBe(5);
    });

    it('counts Header plus all effective vector lengths and clears references only', () => {
        const { state } = anchored();
        expect(state.retainedEntryCount).toBe(16);
        state.clear();
        expect(state.retainedEntryCount).toBe(0);
        expect(state.hasReference).toBe(false);
        expect(state.lastEffective).toBeNull();
        expect(state.lastObjectId).toBe(5n);
    });

    it('includes present CENC numeric vectors and excludes IV byte backing', () => {
        const cenc = Object.freeze({ perSampleIvSize: 8, ivs: new Uint8Array(16),
            subsampleCounts: Object.freeze([1, 2]), clearBytes: Object.freeze([0, 1, 2]),
            protectedBytes: Object.freeze([4, 3, 2]) });
        expect(anchored(cenc).state.retainedEntryCount).toBe(24);
        expect(anchored({ ...cenc, subsampleCounts: null, clearBytes: null, protectedBytes: null })
            .state.retainedEntryCount).toBe(16);
    });
});

describe('Group fork ownership', () => {
    it('forks private Header maps while sharing immutable list/effective values', () => {
        const { state, represented, values } = anchored(), allowance = budget(6);
        allowance.claimSamples(1); allowance.claimBytes(1);
        const copy = state.fork(allowance);
        expect(copy).not.toBe(state);
        expect(copy.lastEffective).toBe(values);
        expect(copy.reference?.list(3)).toBe(represented.list(3));
        expect(copy.reference?.bytes(9)).toBe(represented.bytes(9));
        expect(copy.baseMediaDecodeTime).toBe(9000n);
        expect(copy.lastObjectId).toBe(5n);
        expect(copy.retainedEntryCount).toBe(state.retainedEntryCount);
        expect(allowance.usage).toEqual({ samples: 1, entries: 6, bytes: 1 });
        copy.anchor(fullHeader(1, 20), effective(), 6n);
        expect(state.reference?.scalar(14)).toBe(2n);
        expect(state.lastObjectId).toBe(5n);
        expect(copy.reference?.scalar(14)).toBe(1n);
    });

    it('applies a real delta only to the fork', () => {
        const reconstructor = new LocmafReconstructor(), context = parseLocmafTrackContext(videoInit());
        const state = new LocmafGroupState();
        const initial = setScalar(setScalar(fullHeader(1, 9000), 4, 3000), 8, SYNC_FLAGS);
        reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header: initial, mdat: new Uint8Array(4) }, state, context, 0n);
        const previous = state.lastEffective, copy = state.fork();
        const delta = new LocmafHeader(false);
        delta.set(4, { kind: 'scalar', value: zigzagEncode(1000n) });
        reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header: delta, mdat: new Uint8Array(4) }, copy, context, 1n);
        expect(state.lastEffective).toBe(previous);
        expect(state.lastEffective?.durations).toEqual([3000]);
        expect(state.baseMediaDecodeTime).toBe(9000n);
        expect(state.lastObjectId).toBe(0n);
        expect(copy.lastEffective?.durations).toEqual([4000]);
        expect(copy.baseMediaDecodeTime).toBe(12000n);
        expect(copy.lastObjectId).toBe(1n);
    });

    it('refuses the Group record before copying a Header and leaves the owner untouched', () => {
        const { state, values } = anchored(), allowance = budget(1);
        allowance.claimEntries(1);
        const copy = vi.spyOn(LocmafHeader.prototype, 'copy');
        try {
            expect(() => state.fork(allowance)).toThrow(LocmafReadLimitError);
            expect(copy).not.toHaveBeenCalled();
        } finally { copy.mockRestore(); }
        expect(state.lastEffective).toBe(values);
        expect(state.lastObjectId).toBe(5n);
        expect(state.retainedEntryCount).toBe(16);
        expect(allowance.usage.entries).toBe(1);
    });

    it('refuses a Header map copy without clearing or mutating the original', () => {
        const { state, values } = anchored(), allowance = budget(5);
        expect(() => state.fork(allowance)).toThrow(LocmafReadLimitError);
        expect(allowance.usage).toEqual({ samples: 0, entries: 1, bytes: 0 });
        expect(state.hasReference).toBe(true);
        expect(state.reference?.size).toBe(5);
        expect(state.lastEffective).toBe(values);
        expect(state.baseMediaDecodeTime).toBe(9000n);
        expect(state.lastObjectId).toBe(5n);
    });

    it('preserves a cleared rawBoxes frontier without inventing a reference', () => {
        const { state } = anchored();
        state.clear(); state.noteObject(9n);
        const allowance = budget(1), copy = state.fork(allowance);
        expect(copy.hasReference).toBe(false);
        expect(copy.reference).toBeNull(); expect(copy.lastEffective).toBeNull();
        expect(copy.baseMediaDecodeTime).toBe(0n);
        expect(copy.lastObjectId).toBe(9n);
        expect(copy.retainedEntryCount).toBe(0);
        copy.noteObject(10n);
        expect(state.lastObjectId).toBe(9n);
        expect(allowance.usage).toEqual({ samples: 0, entries: 1, bytes: 0 });
    });

    it('forks an empty state with only one record claim', () => {
        const allowance = budget(1), copy = new LocmafGroupState().fork(allowance);
        expect(copy.lastObjectId).toBe(-1n);
        expect(copy.retainedEntryCount).toBe(0);
        expect(allowance.usage).toEqual({ samples: 0, entries: 1, bytes: 0 });
    });

    it('retains existing Header-copy allowance behavior', () => {
        const value = header(), allowance = budget(5);
        const copy = value.copy(true, allowance);
        expect(copy.list(3)).toBe(value.list(3));
        expect(copy.bytes(9)).toBe(value.bytes(9));
        expect(allowance.usage).toEqual({ samples: 0, entries: 5, bytes: 0 });
    });
});
