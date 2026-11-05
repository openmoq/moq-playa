import { describe, expect, it } from 'vitest';
import { readCmafChunkSamples, readCmafObjectSamples, parseLocmafTrackContext } from './index.js';
import { childBoxes } from './iso-box.js';
import { buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS, videoInit } from '../test-support/cmaf.js';
import { concat, isoBox } from '../test-support/bytes.js';

const context = parseLocmafTrackContext(videoInit());
const payload = Uint8Array.of(1, 2, 3, 4, 5, 6);
const chunk = (bmdt = 90_000n, flags = SYNC_FLAGS) => buildChunk({ bmdt,
    samples: [{ duration: 3000, size: payload.length, flags, cto: -1500 }], mdat: payload });

function moofOnly(bytes: Uint8Array): Uint8Array {
    const boxes = childBoxes(bytes, 0, bytes.length, '16');
    const mdat = boxes.find(box => box.type === 'mdat')!;
    return bytes.slice(0, mdat.start);
}

describe('readCmafObjectSamples', () => {
    it('reads one complete chunk identically to the existing one-chunk API', () => {
        const bytes = chunk();
        expect(readCmafObjectSamples(bytes, context)).toEqual([readCmafChunkSamples(bytes, context)]);
    });

    it('returns every chunk with exact large tfdt, composition offsets, flags and sample bytes', () => {
        const first = chunk((1n << 60n) + 123n), second = chunk((1n << 60n) + 3123n, NON_SYNC_FLAGS);
        const reads = readCmafObjectSamples(concat(first, second), context)!;
        expect(reads).toHaveLength(2);
        expect(reads.map(read => read.effective.baseMediaDecodeTime)).toEqual([(1n << 60n) + 123n, (1n << 60n) + 3123n]);
        expect(reads.map(read => read.effective.compositionTimeOffsets)).toEqual([[-1500], [-1500]]);
        expect(reads.map(read => read.effective.flags)).toEqual([[SYNC_FLAGS], [NON_SYNC_FLAGS]]);
        expect(reads.map(read => read.mdat)).toEqual([payload, payload]);
    });

    it('preserves prefixes before successive chunks and bounded trailing boxes', () => {
        const first = buildChunk({ bmdt: 90_000n, preMoof: [isoBox('styp', Uint8Array.of(7))],
            samples: [{ duration: 3000, size: payload.length, flags: SYNC_FLAGS }], mdat: payload });
        const second = buildChunk({ bmdt: 93_000n, preMoof: [isoBox('prft', Uint8Array.of(8))],
            trailing: [isoBox('free', Uint8Array.of(9))],
            samples: [{ duration: 3000, size: payload.length, flags: NON_SYNC_FLAGS }], mdat: payload });
        const reads = readCmafObjectSamples(concat(first, second), context)!;
        expect(reads.map(read => read.genBoxes.map(box => box.type))).toEqual([['styp'], ['prft']]);
        expect(reads.map(read => read.mdat)).toEqual([payload, payload]);
    });

    it.each([false, true])('reports a sole bounded moof as pending mdat: prefix=%s', prefix => {
        const bytes = moofOnly(chunk());
        expect(readCmafObjectSamples(prefix ? concat(isoBox('styp', Uint8Array.of(7)), bytes) : bytes, context)).toBeNull();
    });

    it('does not change the existing one-chunk reader refusal of multiple moofs or missing mdat', () => {
        expect(() => readCmafChunkSamples(concat(chunk(), chunk(93_000n)), context)).toThrow(/2 moof/);
        expect(() => readCmafChunkSamples(moofOnly(chunk()), context)).toThrow(/mdat/);
    });

    it.each(['truncated-box', 'missing-mdat', 'wrong-track', 'sample-outside-mdat'] as const)(
        'rejects a later %s instead of returning the earlier complete chunk', kind => {
            const tail = kind === 'truncated-box' ? Uint8Array.of(0, 0, 0, 8)
                : kind === 'missing-mdat' ? moofOnly(chunk(93_000n))
                : buildChunk({ bmdt: 93_000n, trackId: kind === 'wrong-track' ? 2 : 1,
                    samples: [{ duration: 3000, size: kind === 'sample-outside-mdat' ? 99 : payload.length, flags: SYNC_FLAGS }], mdat: payload });
            expect(() => readCmafObjectSamples(concat(chunk(), tail), context)).toThrow();
        });

    it('keeps absolute base-data offsets in object coordinates and refuses borrowing another chunk mdat', () => {
        const spec = { bmdt: 90_000n, baseDataOffset: true,
            samples: [{ duration: 3000, size: payload.length, flags: SYNC_FLAGS }], mdat: payload };
        const first = buildChunk(spec), second = buildChunk({ ...spec, bmdt: 93_000n });
        // The second chunk's base_data_offset names its start in this Object.
        const moof = childBoxes(second, 0, second.length, '16').find(box => box.type === 'moof')!;
        const traf = childBoxes(second, moof.contentStart, moof.end, '16').find(box => box.type === 'traf')!;
        const tfhd = childBoxes(second, traf.contentStart, traf.end, '16').find(box => box.type === 'tfhd')!;
        new DataView(second.buffer).setBigUint64(tfhd.contentStart + 8, BigInt(first.length));
        expect(readCmafObjectSamples(concat(first, second), context)?.map(read => read.mdat)).toEqual([payload, payload]);
        new DataView(second.buffer).setBigUint64(tfhd.contentStart + 8, 0n);
        expect(() => readCmafObjectSamples(concat(first, second), context)).toThrow(/outside the mdat/);
    });

    it('does not borrow a later chunk mdat when an earlier moof has none', () => {
        expect(() => readCmafObjectSamples(concat(moofOnly(chunk()), chunk(93_000n)), context)).toThrow(/mdat/);
    });

    it('rejects malformed pending prefixes, empty objects and orphan mdat', () => {
        expect(() => readCmafObjectSamples(concat(moofOnly(chunk()), Uint8Array.of(0)), context)).toThrow();
        expect(() => readCmafObjectSamples(new Uint8Array(), context)).toThrow();
        expect(() => readCmafObjectSamples(isoBox('mdat', payload), context)).toThrow();
    });
});
