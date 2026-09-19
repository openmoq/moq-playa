/**
 * CENC senc/saiz/saio reconstruction (draft-einarsson-moq-locmaf-01 sections
 * 10.2, 10.3, 13, 15.8, 18). Ported from the Java LocmafReconstructorCencTest,
 * plus the section 18 subsample checks the Java implementation did not make.
 */
import { describe, it, expect } from 'vitest';
import { LocmafReconstructor } from './reconstruct.js';
import { LocmafGroupState } from './group-state.js';
import { parseLocmafTrackContext, type LocmafTrackContext } from './track-context.js';
import { LocmafFormatError } from './errors.js';
import { LocmafFieldId as F } from './fields.js';
import type { LocmafHeader } from './model.js';
import { buildInit, cencVideoInit } from '../test-support/cmaf.js';
import { inspectChunk } from '../test-support/inspect.js';
import { indexOfFourcc } from '../test-support/bytes.js';
import { fullHeader, setBytes, setList, setScalar } from '../test-support/locmaf.js';

const reconstructor = new LocmafReconstructor();

function build(header: LocmafHeader, mdat: Uint8Array, context: LocmafTrackContext) {
    const out = reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header, mdat }, new LocmafGroupState(), context, 0n);
    if (out.kind !== 'chunk') throw new Error('expected a chunk');
    return out;
}

function sectionOf(header: LocmafHeader, mdat: Uint8Array, context: LocmafTrackContext): string {
    try {
        build(header, mdat, context);
    } catch (e) {
        expect(e).toBeInstanceOf(LocmafFormatError);
        return (e as LocmafFormatError).section;
    }
    throw new Error('expected a LocmafFormatError');
}

function subsampleHeader(counts: number[], clear: Array<number | bigint>, prot: Array<number | bigint>, n = counts.length): LocmafHeader {
    const h = fullHeader(n, 0);
    setBytes(h, F.SENC_INITIALIZATION_VECTOR, new Uint8Array(8 * n));
    setList(h, F.SENC_SUBSAMPLE_COUNT, counts);
    setList(h, F.SENC_BYTES_OF_CLEAR_DATA, clear);
    setList(h, F.SENC_BYTES_OF_PROTECTED_DATA, prot);
    return h;
}

describe('LocmafReconstructor, CENC', () => {
    const cenc8 = parseLocmafTrackContext(cencVideoInit(8));
    const cbcs = parseLocmafTrackContext(cencVideoInit(0));

    it('emits saiz, saio and senc with subsamples, in that order (15.8)', () => {
        const h = fullHeader(2, 0);
        setList(h, F.TRUN_SAMPLE_SIZES, [1000]);
        setBytes(h, F.SENC_INITIALIZATION_VECTOR, new Uint8Array(16));
        setList(h, F.SENC_SUBSAMPLE_COUNT, [2, 0]);
        setList(h, F.SENC_BYTES_OF_CLEAR_DATA, [10, 0]);
        setList(h, F.SENC_BYTES_OF_PROTECTED_DATA, [974, 16]);
        const out = build(h, new Uint8Array(1200), cenc8);
        const c = inspectChunk(out.bytes, 8);
        expect(c.senc!.flags).toBe(0x000002);
        expect(c.senc!.samples).toHaveLength(2);
        expect(c.senc!.samples[0]!.subsamples).toEqual([[10, 974], [0, 16]]);
        expect(c.senc!.samples[1]!.subsamples).toEqual([]);
        // aux sizes: 8 + 2 + 6*2 = 22 ; 8 + 2 + 0 = 10 -> non-uniform
        expect(c.saiz).toEqual({ defaultSize: 0, sampleCount: 2, sizes: [22, 10] });
        const sencOffset = indexOfFourcc(c.moof, 'senc') - 4;
        expect(c.saio!.offsets).toEqual([sencOffset + 16]);
        expect(c.trafOrder).toEqual(['tfhd', 'tfdt', 'trun', 'saiz', 'saio', 'senc']);
        expect(c.trun.dataOffset).toBe(c.moof.length + 8);
        expect(out.effective.cenc).toMatchObject({ perSampleIvSize: 8, subsampleCounts: [2, 0], clearBytes: [10, 0], protectedBytes: [974, 16] });
    });

    it('uses the saiz default when all aux sizes are equal', () => {
        const h = setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, 50);
        setBytes(h, F.SENC_INITIALIZATION_VECTOR, new Uint8Array(16));
        const c = inspectChunk(build(h, new Uint8Array(100), cenc8).bytes, 8);
        expect(c.senc!.flags).toBe(0);
        expect(c.saiz).toEqual({ defaultSize: 8, sampleCount: 2, sizes: [] });
    });

    it('emits no CENC boxes for cbcs without per-sample auxiliary information', () => {
        const c = inspectChunk(build(fullHeader(1, 0), new Uint8Array(100), cbcs).bytes);
        expect(c.senc).toBeUndefined();
        expect(c.saiz).toBeUndefined();
        expect(c.saio).toBeUndefined();
        expect(c.trafOrder).toEqual(['tfhd', 'tfdt', 'trun']);
    });

    it('rejects a wrong IV length and an oversized aux size', () => {
        const badIv = setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, 1);
        setBytes(badIv, F.SENC_INITIALIZATION_VECTOR, new Uint8Array(8));
        expect(sectionOf(badIv, new Uint8Array(2), cenc8)).toBe('10.2');
        // 8 + 2 + 6*50 > 255; the subsample bytes sum to the sample size so only the aux rule fails.
        const prot = new Array<number>(50).fill(0);
        prot[0] = 1;
        expect(sectionOf(subsampleHeader([50], new Array<number>(50).fill(0), prot), new Uint8Array(1), cenc8)).toBe('15.8');
    });

    it('rejects an invalid per-sample IV size', () => {
        const bad = setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, 1);
        setScalar(bad, F.SENC_PER_SAMPLE_IV_SIZE, 12);
        setBytes(bad, F.SENC_INITIALIZATION_VECTOR, new Uint8Array(24));
        expect(sectionOf(bad, new Uint8Array(2), cenc8)).toBe('10.2');
        const huge = setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, 1);
        setScalar(huge, F.SENC_PER_SAMPLE_IV_SIZE, 1n << 40n);
        setBytes(huge, F.SENC_INITIALIZATION_VECTOR, new Uint8Array(24));
        expect(sectionOf(huge, new Uint8Array(2), cenc8)).toBe('10.2');
    });

    it('rejects missing IVs, IVs without an IV size, and mismatched subsample lists (10.2)', () => {
        expect(sectionOf(fullHeader(1, 0), new Uint8Array(1), cenc8)).toBe('10.2');
        const ivsOnCbcs = setBytes(fullHeader(1, 0), F.SENC_INITIALIZATION_VECTOR, new Uint8Array(8));
        expect(sectionOf(ivsOnCbcs, new Uint8Array(1), cbcs)).toBe('10.2');
        expect(sectionOf(subsampleHeader([2], [1], [1]), new Uint8Array(2), cenc8)).toBe('10.2');
        const noCounts = setBytes(fullHeader(1, 0), F.SENC_INITIALIZATION_VECTOR, new Uint8Array(8));
        setList(noCounts, F.SENC_BYTES_OF_CLEAR_DATA, [1]);
        expect(sectionOf(noCounts, new Uint8Array(1), cenc8)).toBe('10.2');
    });

    it('enforces the section 18 subsample widths and per-sample sums', () => {
        expect(sectionOf(subsampleHeader([1], [0x10000], [0]), new Uint8Array(1), cenc8)).toBe('18'); // clear > 16 bits
        expect(sectionOf(subsampleHeader([1], [0], [0x1_0000_0000n]), new Uint8Array(1), cenc8)).toBe('18'); // protected > 32 bits
        expect(sectionOf(subsampleHeader([1], [3], [4]), new Uint8Array(8), cenc8)).toBe('18'); // 3 + 4 != 8
        expect(sectionOf(subsampleHeader([0x10000], [], []), new Uint8Array(1), cenc8)).toBe('18'); // count > 16 bits
        // A sample with subsample count 0 is unconstrained.
        const ok = subsampleHeader([1, 0], [3], [5], 2);
        setList(ok, F.TRUN_SAMPLE_SIZES, [8]);
        expect(build(ok, new Uint8Array(20), cenc8).effective.sizes).toEqual([8, 12]);
    });

    it('rejects CENC fields when tenc signals default_isProtected = 0 (10.3)', () => {
        const unprotected = parseLocmafTrackContext(buildInit({
            trackId: 1, timescale: 90000, handler: 'vide', encryption: { scheme: 'cenc', perSampleIvSize: 8, isProtected: 0 },
        }));
        expect(unprotected.isProtected).toBe(false);
        expect(sectionOf(setBytes(fullHeader(1, 0), F.SENC_INITIALIZATION_VECTOR, new Uint8Array(8)), new Uint8Array(1), unprotected)).toBe('10.3');
        expect(build(fullHeader(1, 0), new Uint8Array(1), unprotected).effective.cenc).toBeNull();
    });
});
