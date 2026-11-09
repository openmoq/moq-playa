import { describe, expect, it } from 'vitest';
import { readCmafChunkSamples, readCmafObjectSamples } from './chunk-samples.js';
import { childBoxes, findChild, readBoxHeader } from './iso-box.js';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import { LocmafFormatError } from './errors.js';
import { parseLocmafTrackContext } from './track-context.js';
import { buildChunk, SYNC_FLAGS, videoInit } from '../test-support/cmaf.js';
import { concat, fullBox, i32, isoBox, u32, u64 } from '../test-support/bytes.js';

const context = parseLocmafTrackContext(videoInit());
const budget = (maxSamples = 2, maxEntries = 1000, maxBytes = 1000) =>
    new LocmafReadBudget({ maxSamples, maxEntries, maxBytes });
const chunk = (count = 1, bmdt = 90_000n) => buildChunk({ bmdt,
    samples: Array.from({ length: count }, () => ({ duration: 3000, size: 1, flags: SYNC_FLAGS })) });
const readChunk = (bytes: Uint8Array, allowance: LocmafReadBudget): ReturnType<typeof readCmafChunkSamples> =>
    readCmafChunkSamples(bytes, context, allowance);
const readObject = (bytes: Uint8Array, allowance: LocmafReadBudget): ReturnType<typeof readCmafObjectSamples> =>
    readCmafObjectSamples(bytes, context, allowance);

function runs(noncontiguous: boolean, bmdt = 90_000n): Uint8Array {
    const tfhd = fullBox('tfhd', 0, 0x020000, u32(context.trackId));
    const tfdt = fullBox('tfdt', 1, 0, u64(bmdt));
    const trun = (offset: number) => fullBox('trun', 0, 0x701,
        u32(1), i32(offset), u32(3000), u32(1), u32(SYNC_FLAGS));
    const moof = (offset: number) => isoBox('moof', fullBox('mfhd', 0, 0, u32(1)),
        isoBox('traf', tfhd, tfdt, trun(offset), trun(offset + (noncontiguous ? 2 : 1))));
    const start = moof(0).length + 8;
    return concat(moof(start), isoBox('mdat', Uint8Array.of(10, 20, 30)));
}

describe('raw sample reader cumulative budget', () => {
    it('refuses a single run above its sample allowance', () => {
        expect(() => readChunk(chunk(2), budget(1))).toThrow(LocmafReadLimitError);
    });

    it('shares a sample allowance across chunks which individually fit', () => {
        const first = chunk(), second = chunk(1, 93_000n);
        expect(readChunk(first, budget(1)).effective.sizes).toEqual([1]);
        expect(readChunk(second, budget(1)).effective.sizes).toEqual([1]);
        expect(() => readObject(concat(first, second), budget(1))).toThrow(LocmafReadLimitError);
    });

    it('accepts exact combined capacity and original chunk ordering', () => {
        const allowance = budget(2);
        const reads = readObject(concat(chunk(), chunk(1, 93_000n)), allowance);
        expect(reads?.map(read => read.effective.baseMediaDecodeTime)).toEqual([90_000n, 93_000n]);
        expect(allowance.usage.samples).toBe(2);
        expect(allowance.usage.bytes).toBe(0);
    });

    it('refuses stored metadata growth above its entry allowance', () => {
        expect(() => readChunk(chunk(), budget(1, 1))).toThrow(LocmafReadLimitError);
    });

    it('refuses real gather allocation above the remaining byte allowance', () => {
        expect(readCmafChunkSamples(runs(true), context).mdat).toEqual(Uint8Array.of(10, 30));
        expect(() => readChunk(runs(true), budget(2, 1000, 1))).toThrow(LocmafReadLimitError);
    });

    it('keeps contiguous sample views borrowed under an exhausted byte allowance', () => {
        const bytes = runs(false), allowance = budget(2, 1000, 1);
        allowance.claimBytes(1);
        const read = readChunk(bytes, allowance);
        expect(read.mdat).toEqual(Uint8Array.of(10, 20));
        expect(read.mdat.buffer).toBe(bytes.buffer);
        expect(allowance.usage.bytes).toBe(1);
    });

    it('rejects a malformed later chunk without publishing an earlier result', () => {
        let result: ReturnType<typeof readCmafObjectSamples> | undefined;
        expect(() => { result = readObject(concat(chunk(), Uint8Array.of(0, 0, 0)), budget(2)); })
            .toThrow(LocmafFormatError);
        expect(result).toBeUndefined();
    });

    it('claims each run cumulatively once before growing its vectors', () => {
        const allowance = budget(1);
        expect(() => readChunk(runs(false), allowance)).toThrow(LocmafReadLimitError);
        expect(allowance.usage.samples).toBe(1);
        const exact = budget(2);
        expect(readChunk(runs(false), exact).effective.sizes).toEqual([1, 1]);
        expect(exact.usage.samples).toBe(2);
    });

    it('admits the exact measured metadata allowance and refuses one fewer entry', () => {
        const bytes = concat(chunk(), chunk(1, 93_000n)), measured = budget(2);
        readObject(bytes, measured);
        const entries = measured.usage.entries, exact = budget(2, entries);
        expect(readObject(bytes, exact)).toHaveLength(2);
        expect(exact.usage).toEqual({ samples: 2, entries, bytes: 0 });
        expect(() => readObject(bytes, budget(2, entries - 1))).toThrow(LocmafReadLimitError);
    });

    it('shares gather bytes across chunks and refuses before the next copy', () => {
        const bytes = concat(runs(true), runs(true, 96_000n)), short = budget(4, 1000, 3);
        expect(() => readObject(bytes, short)).toThrow(LocmafReadLimitError);
        expect(short.usage.bytes).toBe(2);
        const exact = budget(4, 1000, 4);
        expect(readObject(bytes, exact)?.map(read => read.mdat)).toEqual([
            Uint8Array.of(10, 30), Uint8Array.of(10, 30),
        ]);
        expect(exact.usage).toMatchObject({ samples: 4, bytes: 4 });
    });

    it('publishes nothing when a validly boxed later chunk has a foreign track', () => {
        const foreign = buildChunk({ trackId: context.trackId + 1, bmdt: 93_000n,
            samples: [{ duration: 3000, size: 1, flags: SYNC_FLAGS }] });
        const allowance = budget(2);
        let result: ReturnType<typeof readCmafObjectSamples> | undefined;
        expect(() => { result = readObject(concat(chunk(), foreign), allowance); }).toThrow(LocmafFormatError);
        expect(result).toBeUndefined();
        expect(allowance.usage.samples).toBe(1);
    });
});

describe('ISO helper budget boundary', () => {
    it('claims before returning a new header record', () => {
        const bytes = isoBox('free'), allowance = budget(1, 1);
        allowance.claimEntries(1);
        expect(() => readBoxHeader(bytes, 0, bytes.length, '16', allowance))
            .toThrow(LocmafReadLimitError);
    });

    it('claims before storing child collection entries', () => {
        const bytes = concat(isoBox('free'), isoBox('skip'));
        expect(() => childBoxes(bytes, 0, bytes.length, '16', budget(1, 3)))
            .toThrow(LocmafReadLimitError);
    });

    it('passes the allowance through findChild', () => {
        const bytes = isoBox('free'), allowance = budget(1, 1);
        allowance.claimEntries(1);
        expect(() => findChild(bytes, 0, bytes.length, 'free', '16', allowance))
            .toThrow(LocmafReadLimitError);
    });

    it('still validates all trailing boxes after an early child match', () => {
        const bytes = concat(isoBox('free'), Uint8Array.of(0));
        expect(() => findChild(bytes, 0, bytes.length, 'free', '16', budget()))
            .toThrow(LocmafFormatError);
    });
});
