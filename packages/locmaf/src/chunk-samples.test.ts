/**
 * Lenient sample reader for verbatim chunks on the frame path (section 16):
 * accepts moof structures outside the LOCMAF field model as long as the
 * samples can be placed in time and in the mdat.
 */
import { describe, it, expect, vi } from 'vitest';
import { readCmafChunkSamples } from './chunk-samples.js';
import { parseCmafChunk } from './cmaf-chunk.js';
import { LocmafFormatError } from './errors.js';
import { childBoxes } from './iso-box.js';
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
    ])('reads samples from a chunk outside the field model: %s', (_name, chunk) => {
        expect(parseCmafChunk(chunk, video).fits).toBe(false);
        expectTwoSamples(chunk);
    });

    it('reads a zero-size sample from an empty mdat', () => {
        const chunk = buildChunk({ bmdt: 90000, samples: [{ duration: 3000, size: 0, flags: SYNC_FLAGS }], trun: { duration: true, flags: true } });
        const read = readCmafChunkSamples(chunk, video);
        expect(read.effective.sizes).toEqual([0]);
        expect(read.mdat.length).toBe(0);
    });

    it('reads a run from a second mdat that follows a free box', () => {
        // trun B points into the second mdat; the free box between is not sample data.
        const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
        const tfdt = fullBox('tfdt', 1, 0, u64(90000n));
        const trun = (offset: number, size: number, flags: number): Uint8Array =>
            fullBox('trun', 0, 0x000701, u32(1), i32(offset), u32(3000), u32(size), u32(flags));
        const moofOf = (a: number, b: number): Uint8Array =>
            isoBox('moof', fullBox('mfhd', 0, 0, u32(1)), isoBox('traf', tfhd, tfdt, trun(a, 3, SYNC_FLAGS), trun(b, 2, NON_SYNC_FLAGS)));
        const first = moofOf(0, 0).length + 8;
        const free = isoBox('free', Uint8Array.of(0xee, 0xee));
        const moof = moofOf(first, first + 3 + free.length + 8);
        const chunk = concat(moof, isoBox('mdat', Uint8Array.of(1, 2, 3)), free, isoBox('mdat', Uint8Array.of(4, 5)));
        expectTwoSamples(chunk);
    });

    it.each<[string, 0 | 1]>([['version 0', 0], ['version 1', 1]])('reads a tfdt of %s', (_name, tfdtVersion) => {
        expectTwoSamples(buildChunk({ bmdt: 90000, samples: two, mdat: payload, tfdtVersion }));
    });

    it('reads composition offsets as unsigned in a version-0 trun and signed in a version-1 trun', () => {
        // buildChunk writes version 1 exactly when an offset is negative.
        const unsigned = buildChunk({ bmdt: 90000, samples: [{ ...two[0]!, cto: 0x80000000 }, { ...two[1]!, cto: 5 }], mdat: payload });
        expect(readCmafChunkSamples(unsigned, video).effective.compositionTimeOffsets).toEqual([0x80000000, 5]);
        const signed = buildChunk({ bmdt: 90000, samples: [{ ...two[0]!, cto: -3000 }, { ...two[1]!, cto: 5 }], mdat: payload });
        expect(readCmafChunkSamples(signed, video).effective.compositionTimeOffsets).toEqual([-3000, 5]);
    });

    it('locates each sample among many mdats without scanning them all', () => {
        // 1000 one-sample truns all in the last of 1000 one-byte mdats. A linear
        // scan per sample would visit the interval list a million times; the
        // Array.prototype.some spy counts such visits and is a deterministic
        // discriminator for that regression, not a general complexity proof.
        const count = 1000;
        const run = (offset: number): Uint8Array => fullBox('trun', 0, 0x000701, u32(1), i32(offset), u32(3000), u32(1), u32(SYNC_FLAGS));
        const moofOf = (offset: number): Uint8Array =>
            isoBox('moof', fullBox('mfhd', 0, 0, u32(1)),
                isoBox('traf', fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('tfdt', 1, 0, u64(90000n)),
                    ...Array.from({ length: count }, () => run(offset))));
        const head = moofOf(0).length;
        const last = head + (count - 1) * 9 + 8;
        const chunk = concat(moofOf(last), ...Array.from({ length: count }, () => isoBox('mdat', Uint8Array.of(7))));
        const original = Array.prototype.some;
        let visits = 0;
        const spy = vi.spyOn(Array.prototype, 'some').mockImplementation(function (this: unknown[], predicate, thisArg) {
            return original.call(this, (value, index, array) => {
                visits++;
                return predicate.call(thisArg, value, index, array);
            });
        });
        let read;
        try {
            read = readCmafChunkSamples(chunk, video);
        } finally {
            spy.mockRestore();
        }
        expect(read.mdat).toEqual(new Uint8Array(count).fill(7));
        expect(visits).toBeLessThan(count * 32);
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
        // Section 6: the CMAF Header initializes one track. A lone traf for
        // another track is that track's media, not a relabelling of ours.
        ['a lone traf for another track_ID', buildChunk({ bmdt: 90000, samples: two, mdat: payload, trackId: 9 }), 'track_ID 1'],
        ['two tfhd boxes', buildChunk({ bmdt: 90000, samples: two, mdat: payload, extraTrafBoxes: [fullBox('tfhd', 0, 0x020000, u32(1))] }), 'tfhd'],
        ['two tfdt boxes', buildChunk({ bmdt: 90000, samples: two, mdat: payload, extraTrafBoxes: [fullBox('tfdt', 1, 0, u64(90000n))] }), 'tfdt'],
        ['two trafs for the track', twoTrafsForTrackOne(), 'trafs for track_ID 1'],
        ['runs revisiting the same mdat bytes', revisitingRuns(20), 'total more'],
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

    it('bounds the gathered copy by the mdat payload: revisiting runs would otherwise amplify a small chunk', () => {
        // 20 one-sample truns each pointing at the same 100-byte payload would
        // gather 2000 bytes from a chunk about a third that size; the reader
        // refuses once the running total passes what the mdat carries.
        const chunk = revisitingRuns(20);
        expect(20 * 100).toBeGreaterThan(chunk.length);
        expect(() => readCmafChunkSamples(chunk, video)).toThrow(/total more than the 100 bytes/);
    });

    it.each<[string, number]>([
        ['tfhd', 1], ['tfhd', 2], ['tfdt', 2], ['trun', 2],
    ])('rejects %s FullBox version %d', (type, version) => {
        // A version-2 tfdt would otherwise be read as version 0, turning the
        // 64-bit decode time 90000 into 0.
        const chunk = buildChunk({ bmdt: 90000, samples: two, mdat: payload });
        const top = childBoxes(chunk, 0, chunk.length, '16');
        const moof = top.find((b) => b.type === 'moof')!;
        const traf = childBoxes(chunk, moof.contentStart, moof.end, '16').find((b) => b.type === 'traf')!;
        const box = childBoxes(chunk, traf.contentStart, traf.end, '16').find((b) => b.type === type)!;
        chunk[box.contentStart] = version;
        expect(() => readCmafChunkSamples(chunk, video)).toThrow(LocmafFormatError);
        expect(() => readCmafChunkSamples(chunk, video)).toThrow(`version ${version}`);
    });

    it('is a CMAF Header, not a chunk: a moov is rejected', () => {
        expect(() => readCmafChunkSamples(videoInit(), video)).toThrow(LocmafFormatError);
    });
});

/** The chunk's leading moof box alone. */
function moofOnly(chunk: Uint8Array): Uint8Array {
    return chunk.subarray(0, new DataView(chunk.buffer, chunk.byteOffset).getUint32(0));
}

/** A moof with two trafs for track 1, each with its own tfdt and one sample. */
function twoTrafsForTrackOne(): Uint8Array {
    const trafOf = (offset: number, size: number, flags: number, bmdt: bigint): Uint8Array =>
        isoBox('traf',
            fullBox('tfhd', 0, 0x020000, u32(1)),
            fullBox('tfdt', 1, 0, u64(bmdt)),
            fullBox('trun', 0, 0x000701, u32(1), i32(offset), u32(3000), u32(size), u32(flags)));
    const moofOf = (o: number): Uint8Array =>
        isoBox('moof', fullBox('mfhd', 0, 0, u32(1)), trafOf(o, 3, SYNC_FLAGS, 90000n), trafOf(o + 3, 2, NON_SYNC_FLAGS, 93000n));
    const moof = moofOf(moofOf(0).length + 8);
    return concat(moof, isoBox('mdat', payload));
}

/** `count` one-sample truns, every one pointing at the same 100-byte mdat payload. */
function revisitingRuns(count: number): Uint8Array {
    const bytes = new Uint8Array(100).fill(0xab);
    const trun = (offset: number): Uint8Array =>
        fullBox('trun', 0, 0x000701, u32(1), i32(offset), u32(3000), u32(bytes.length), u32(SYNC_FLAGS));
    const moofOf = (offset: number): Uint8Array =>
        isoBox('moof', fullBox('mfhd', 0, 0, u32(1)),
            isoBox('traf', fullBox('tfhd', 0, 0x020000, u32(1)), fullBox('tfdt', 1, 0, u64(90000n)),
                ...Array.from({ length: count }, () => trun(offset))));
    const moof = moofOf(moofOf(0).length + 8);
    return concat(moof, isoBox('mdat', bytes));
}
