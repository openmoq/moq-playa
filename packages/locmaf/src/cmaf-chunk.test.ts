/**
 * Effective values from a source CMAF chunk (draft-einarsson-moq-locmaf-01
 * section 11.1: per-sample trun value, else tfhd default, else trex default).
 * Ported from the Java EffectiveSamplesTest.
 */
import { describe, it, expect } from 'vitest';
import { extractEffectiveSamples, parseCmafChunk } from './cmaf-chunk.js';
import { allEqual, equalExceptFirst, totalDuration } from './effective.js';
import { LocmafFormatError } from './errors.js';
import { parseLocmafTrackContext } from './track-context.js';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, cencVideoInit, stypBox, videoInit } from '../test-support/cmaf.js';
import { fullBox, isoBox, u32, u64 } from '../test-support/bytes.js';

const video = parseLocmafTrackContext(videoInit());

function sectionOf(fn: () => unknown): string {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(LocmafFormatError);
        return (e as LocmafFormatError).section;
    }
    throw new Error('expected a LocmafFormatError');
}

describe('extractEffectiveSamples', () => {
    it('lets per-sample trun values win', () => {
        const chunk = buildChunk({
            bmdt: 9000,
            samples: [
                { duration: 3000, size: 100, flags: SYNC_FLAGS, cto: 0 },
                { duration: 3000, size: 50, flags: NON_SYNC_FLAGS, cto: -3000 },
                { duration: 3000, size: 60, flags: NON_SYNC_FLAGS, cto: 3000 },
            ],
        });
        const e = extractEffectiveSamples(chunk, video);
        expect(e.durations).toHaveLength(3);
        expect(e.baseMediaDecodeTime).toBe(9000n);
        expect(e.durations).toEqual([3000, 3000, 3000]);
        expect(e.sizes).toEqual([100, 50, 60]);
        expect(e.compositionTimeOffsets).toEqual([0, -3000, 3000]);
        expect(allEqual(e.durations)).toBe(true);
        expect(allEqual(e.sizes)).toBe(false);
        expect(allEqual(e.flags)).toBe(false);
        expect(equalExceptFirst(e.flags)).toBe(true);
        expect(totalDuration(e)).toBe(9000n);
        expect(e.sampleDescriptionIndex).toBe(1);
    });

    it('fills missing trun fields from tfhd defaults', () => {
        const chunk = buildChunk({
            bmdt: 100,
            tfhd: { duration: 1500, size: 40, flags: 0x01010000 },
            trun: {},
            samples: [{ duration: 0, size: 40, flags: 0 }, { duration: 0, size: 40, flags: 0 }],
        });
        const e = extractEffectiveSamples(chunk, video);
        expect(e.durations).toEqual([1500, 1500]);
        expect(e.sizes).toEqual([40, 40]);
        expect(e.flags).toEqual([0x01010000, 0x01010000]);
        expect(e.compositionTimeOffsets).toEqual([0, 0]);
    });

    it('applies trun first_sample_flags only to sample 0, and reads tfdt version 0', () => {
        const chunk = buildChunk({
            bmdt: 77,
            tfdtVersion: 0,
            tfhd: { flags: NON_SYNC_FLAGS, duration: 10, size: 5 },
            trun: { firstSampleFlags: SYNC_FLAGS },
            samples: [{ duration: 0, size: 5, flags: 0 }, { duration: 0, size: 5, flags: 0 }],
        });
        const e = extractEffectiveSamples(chunk, video);
        expect(e.flags).toEqual([SYNC_FLAGS, NON_SYNC_FLAGS]);
        expect(e.baseMediaDecodeTime).toBe(77n);
    });

    it('rejects a trun that declares more samples than it carries (section 11)', () => {
        const chunk = buildChunk({
            bmdt: 100,
            trun: { size: true },
            declaredSampleCount: 3,
            samples: [{ duration: 0, size: 40, flags: 0 }, { duration: 0, size: 40, flags: 0 }],
        });
        expect(sectionOf(() => extractEffectiveSamples(chunk, video))).toBe('11');
    });

    it('yields no CENC values for an empty senc and populated values for a protected track', () => {
        const empty = buildChunk({
            bmdt: 100, samples: [{ duration: 1500, size: 40, flags: 0 }],
            senc: { ivSize: 0, useSubsamples: false, samples: [{ iv: new Uint8Array(0), subsamples: [] }] },
        });
        expect(extractEffectiveSamples(empty, video).cenc).toBeNull();

        const cenc = parseLocmafTrackContext(cencVideoInit(8));
        const protectedChunk = buildChunk({
            bmdt: 100, samples: [{ duration: 1500, size: 40, flags: 0 }],
            senc: { ivSize: 8, useSubsamples: true, withSaizSaio: true, samples: [{ iv: new Uint8Array(8).fill(3), subsamples: [[8, 32]] }] },
        });
        const e = extractEffectiveSamples(protectedChunk, cenc);
        expect(e.cenc).toEqual({
            perSampleIvSize: 8, ivs: new Uint8Array(8).fill(3), subsampleCounts: [1], clearBytes: [8], protectedBytes: [32],
        });
    });

    it('infers a per-sample IV size that differs from tenc', () => {
        const cenc = parseLocmafTrackContext(cencVideoInit(8));
        const chunk = buildChunk({
            bmdt: 0, samples: [{ duration: 1, size: 4, flags: 0 }, { duration: 1, size: 4, flags: 0 }],
            senc: { ivSize: 16, useSubsamples: false, samples: [{ iv: new Uint8Array(16).fill(1), subsamples: [] }, { iv: new Uint8Array(16).fill(2), subsamples: [] }] },
        });
        expect(extractEffectiveSamples(chunk, cenc).cenc?.perSampleIvSize).toBe(16);
    });
});

describe('parseCmafChunk', () => {
    it('splits pre-moof boxes into genBoxes and exposes the mdat payload', () => {
        const prft = fullBox('prft', 1, 0, u32(1), u64(42n), u64(7n));
        const chunk = buildChunk({ bmdt: 0, preMoof: [prft, stypBox()], samples: [{ duration: 1, size: 3, flags: 0 }], mdat: Uint8Array.of(1, 2, 3) });
        const parsed = parseCmafChunk(chunk, video);
        expect(parsed.fits).toBe(true);
        if (!parsed.fits) return;
        expect(parsed.genBoxes.map((b) => b.type)).toEqual(['prft', 'styp']);
        expect(parsed.genBoxes[0]!.payload).toEqual(prft.subarray(8));
        expect(parsed.mdat).toEqual(Uint8Array.of(1, 2, 3));
    });

    it('carries a pre-moof uuid box as a genBox with the usertype leading the payload (section 8.1)', () => {
        const usertype = new Uint8Array(16).map((_, i) => 0xa0 + i);
        const uuid = isoBox('uuid', usertype, Uint8Array.of(42));
        const chunk = buildChunk({ bmdt: 0, preMoof: [uuid], samples: [{ duration: 1, size: 3, flags: 0 }], mdat: Uint8Array.of(1, 2, 3) });
        const parsed = parseCmafChunk(chunk, video);
        expect(parsed.fits).toBe(true);
        if (!parsed.fits) return;
        expect(parsed.genBoxes.map((b) => b.type)).toEqual(['uuid']);
        expect(parsed.genBoxes[0]!.payload).toEqual(uuid.subarray(8));
        expect(parsed.genBoxes[0]!.payload.subarray(0, 16)).toEqual(usertype);
    });

    it('reports chunks outside the LOCMAF field model', () => {
        const sample = [{ duration: 1, size: 1, flags: 0 }];
        const cases: Array<[string, Uint8Array]> = [
            ['two truns', buildChunk({ bmdt: 0, samples: sample, extraTrun: true })],
            ['base data offset', buildChunk({ bmdt: 0, samples: sample, baseDataOffset: true })],
            ['sample groups', buildChunk({ bmdt: 0, samples: sample, extraTrafBoxes: [fullBox('sbgp', 0, 0, u32(0))] })],
            ['trailing box', buildChunk({ bmdt: 0, samples: sample, trailing: [isoBox('free')] })],
            ['track mismatch', buildChunk({ bmdt: 0, samples: sample, trackId: 9 })],
            ['no tfdt', buildChunk({ bmdt: 0, samples: sample, omitTfdt: true })],
            ['sizes do not cover mdat', buildChunk({ bmdt: 0, samples: sample, mdat: Uint8Array.of(1, 2) })],
            ['no moof', videoInit()],
        ];
        for (const [what, chunk] of cases) {
            expect(parseCmafChunk(chunk, video).fits, what).toBe(false);
        }
    });
});
