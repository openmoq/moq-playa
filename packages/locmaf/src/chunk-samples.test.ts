/**
 * Lenient sample reader for verbatim chunks on the frame path (section 16):
 * accepts moof structures outside the LOCMAF field model as long as the
 * samples can be placed in time and in the mdat.
 */
import { describe, it, expect } from 'vitest';
import { readCmafChunkSamples } from './chunk-samples.js';
import { parseCmafChunk } from './cmaf-chunk.js';
import { LocmafFormatError } from './errors.js';
import { parseLocmafTrackContext } from './track-context.js';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, stypBox, videoInit } from '../test-support/cmaf.js';
import { concat, fullBox, i32, isoBox, u32, u64 } from '../test-support/bytes.js';

const video = parseLocmafTrackContext(videoInit());
const two = [
    { duration: 3000, size: 3, flags: SYNC_FLAGS },
    { duration: 3000, size: 2, flags: NON_SYNC_FLAGS },
];
const payload = Uint8Array.of(1, 2, 3, 4, 5);

function expectTwoSamples(chunk: Uint8Array): void {
    const read = readCmafChunkSamples(chunk, video);
    expect(read.effective.baseMediaDecodeTime).toBe(90000n);
    expect(read.effective.durations).toEqual([3000, 3000]);
    expect(read.effective.sizes).toEqual([3, 2]);
    expect(read.effective.flags).toEqual([SYNC_FLAGS, NON_SYNC_FLAGS]);
    expect(read.effective.compositionTimeOffsets).toEqual([0, 0]);
    expect(read.effective.cenc).toBeNull();
    expect(read.mdat).toEqual(payload);
}

describe('readCmafChunkSamples', () => {
    it('reads a canonical chunk exactly as parseCmafChunk does', () => {
        const chunk = buildChunk({ bmdt: 90000, samples: two, mdat: payload, preMoof: [stypBox()] });
        const strict = parseCmafChunk(chunk, video);
        expect(strict.fits).toBe(true);
        if (!strict.fits) return;
        const read = readCmafChunkSamples(chunk, video);
        expect(read.effective).toEqual(strict.effective);
        expect(read.mdat).toEqual(strict.mdat);
        expect(read.genBoxes).toEqual(strict.genBoxes);
    });

    it.each<[string, Uint8Array]>([
        ['base data offset', buildChunk({ bmdt: 90000, samples: two, mdat: payload, baseDataOffset: true })],
        ['sample groups in the traf', buildChunk({ bmdt: 90000, samples: two, mdat: payload, extraTrafBoxes: [fullBox('sbgp', 0, 0, u32(0))] })],
        ['an empty second trun', buildChunk({ bmdt: 90000, samples: two, mdat: payload, extraTrun: true })],
        ['a trailing box', buildChunk({ bmdt: 90000, samples: two, mdat: payload, trailing: [isoBox('free')] })],
        ['a differing track_ID in the only traf', buildChunk({ bmdt: 90000, samples: two, mdat: payload, trackId: 9 })],
    ])('reads samples from a chunk outside the field model: %s', (_name, chunk) => {
        expect(parseCmafChunk(chunk, video).fits).toBe(false);
        expectTwoSamples(chunk);
    });

    it('keeps a pre-moof uuid as a genBox with its usertype leading the payload', () => {
        const usertype = new Uint8Array(16).fill(7);
        const chunk = buildChunk({ bmdt: 90000, samples: two, mdat: payload, preMoof: [isoBox('uuid', usertype, Uint8Array.of(1))] });
        const read = readCmafChunkSamples(chunk, video);
        expect(read.genBoxes.map((b) => b.type)).toEqual(['uuid']);
        expect(read.genBoxes[0]!.payload).toEqual(concat(usertype, Uint8Array.of(1)));
    });

    it('concatenates the samples of several truns, the second continuing from the first', () => {
        // trun A: data_offset relative to the moof (default-base-is-moof).
        // trun B: no data_offset, so ISO places its run right after trun A's.
        const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
        const tfdt = fullBox('tfdt', 1, 0, u64(90000n));
        const trunA = (offset: number): Uint8Array =>
            fullBox('trun', 0, 0x000701, u32(1), i32(offset), u32(3000), u32(3), u32(SYNC_FLAGS));
        const trunB = fullBox('trun', 0, 0x000700, u32(1), u32(3000), u32(2), u32(NON_SYNC_FLAGS));
        const moofOf = (offset: number): Uint8Array =>
            isoBox('moof', fullBox('mfhd', 0, 0, u32(1)), isoBox('traf', tfhd, tfdt, trunA(offset), trunB));
        const moof = moofOf(moofOf(0).length + 8);
        const chunk = concat(moof, isoBox('mdat', payload));
        expect(parseCmafChunk(chunk, video).fits).toBe(false);
        expectTwoSamples(chunk);
    });

    it('copies the sample bytes when the runs are not contiguous', () => {
        // trun B points past a 2-byte gap in the mdat.
        const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
        const tfdt = fullBox('tfdt', 1, 0, u64(90000n));
        const trun = (offset: number, size: number, flags: number): Uint8Array =>
            fullBox('trun', 0, 0x000701, u32(1), i32(offset), u32(3000), u32(size), u32(flags));
        const moofOf = (a: number, b: number): Uint8Array =>
            isoBox('moof', fullBox('mfhd', 0, 0, u32(1)), isoBox('traf', tfhd, tfdt, trun(a, 3, SYNC_FLAGS), trun(b, 2, NON_SYNC_FLAGS)));
        const first = moofOf(0, 0).length + 8;
        const moof = moofOf(first, first + 3 + 2);
        const chunk = concat(moof, isoBox('mdat', Uint8Array.of(1, 2, 3), Uint8Array.of(0xee, 0xee), Uint8Array.of(4, 5)));
        expectTwoSamples(chunk);
    });

    it('picks the traf whose track_ID matches the CMAF Header when a moof carries several', () => {
        const trafOf = (trackId: number, offset: number, size: number, flags: number, bmdt: bigint): Uint8Array =>
            isoBox('traf',
                fullBox('tfhd', 0, 0x020000, u32(trackId)),
                fullBox('tfdt', 1, 0, u64(bmdt)),
                fullBox('trun', 0, 0x000701, u32(1), i32(offset), u32(3000), u32(size), u32(flags)));
        // Track 2's single sample leads the mdat; our two samples follow it.
        const moofOf = (o: number): Uint8Array =>
            isoBox('moof', fullBox('mfhd', 0, 0, u32(1)),
                trafOf(2, o, 1, 0, 5n),
                isoBox('traf',
                    fullBox('tfhd', 0, 0x020000, u32(1)),
                    fullBox('tfdt', 1, 0, u64(90000n)),
                    fullBox('trun', 0, 0x000701, u32(2), i32(o + 1), u32(3000), u32(3), u32(SYNC_FLAGS), u32(3000), u32(2), u32(NON_SYNC_FLAGS))));
        const moof = moofOf(moofOf(0).length + 8);
        const chunk = concat(moof, isoBox('mdat', Uint8Array.of(9), payload));
        expectTwoSamples(chunk);
    });

    it.each<[string, Uint8Array, string]>([
        ['no moof', concat(stypBox(), isoBox('mdat', payload)), 'moof'],
        ['no mdat', moofOnly(buildChunk({ bmdt: 90000, samples: two, mdat: payload })), 'mdat'],
        ['no tfdt', buildChunk({ bmdt: 90000, samples: two, mdat: payload, omitTfdt: true }), 'tfdt'],
        ['samples past the chunk', buildChunk({ bmdt: 90000, samples: two, mdat: payload, declaredSampleCount: 2, trun: { duration: true, size: true, flags: true } }).subarray(0, -1), ''],
    ])('throws a LocmafFormatError when the samples cannot be placed: %s', (_name, chunk, word) => {
        let caught: unknown;
        try {
            readCmafChunkSamples(chunk, video);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(LocmafFormatError);
        if (word) expect((caught as Error).message).toContain(word);
    });

    it('is a CMAF Header, not a chunk: a moov is rejected', () => {
        expect(() => readCmafChunkSamples(videoInit(), video)).toThrow(LocmafFormatError);
    });
});

/** The chunk's leading moof box alone. */
function moofOnly(chunk: Uint8Array): Uint8Array {
    return chunk.subarray(0, new DataView(chunk.buffer, chunk.byteOffset).getUint32(0));
}
