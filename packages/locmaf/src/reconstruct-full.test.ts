/**
 * Full-header reconstruction (draft-einarsson-moq-locmaf-01 sections 8.3, 9.4,
 * 11.2, 15). Ported from the Java LocmafReconstructorFullTest, with the Java
 * deviations corrected: genBox/rawBoxes bytes pass through verbatim, n > P is
 * legal for zero-size samples, and field widths are range-checked (section 18).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LocmafReconstructor } from './reconstruct.js';
import { LocmafGroupState } from './group-state.js';
import { parseLocmafTrackContext, type LocmafTrackContext } from './track-context.js';
import { LocmafFormatError } from './errors.js';
import { LocmafFieldId as F } from './fields.js';
import { LocmafHeader, type GenBox } from './model.js';
import { videoInit } from '../test-support/cmaf.js';
import { inspectChunk } from '../test-support/inspect.js';
import { fullHeader, setBytes, setList, setScalar } from '../test-support/locmaf.js';
import { ascii, concat, isoBox, u32 } from '../test-support/bytes.js';

const reconstructor = new LocmafReconstructor();
let context: LocmafTrackContext;

beforeEach(() => {
    context = parseLocmafTrackContext(videoInit());
});

function chunk(header: LocmafHeader, mdat: Uint8Array, genBoxes: GenBox[] = [], state = new LocmafGroupState()) {
    const out = reconstructor.reconstruct({ kind: 'moof', genBoxes, header, mdat }, state, context, 0n);
    if (out.kind !== 'chunk') throw new Error('expected a chunk');
    return out;
}

function sectionOf(header: LocmafHeader, mdat: Uint8Array): string {
    try {
        chunk(header, mdat);
    } catch (e) {
        expect(e).toBeInstanceOf(LocmafFormatError);
        return (e as LocmafFormatError).section;
    }
    throw new Error('expected a LocmafFormatError');
}

describe('LocmafReconstructor, full headers', () => {
    it('derives a single sample size from the payload and emits it as a tfhd default (15.6.1)', () => {
        const state = new LocmafGroupState();
        const out = chunk(setScalar(fullHeader(1, 9000), F.TFHD_DEFAULT_SAMPLE_DURATION, 3000), new Uint8Array(120), [], state);
        const c = inspectChunk(out.bytes);
        expect(c.boxes).toEqual(['moof', 'mdat']);
        expect(c.mfhdSequence).toBe(0);
        expect(c.tfhd.trackId).toBe(1);
        expect(c.tfhd.flags).toBe(0x020000 | 0x000008 | 0x000010);
        expect(c.tfhd.defaultSampleSize).toBe(120);
        expect(c.tfdt).toEqual({ version: 1, bmdt: 9000n });
        expect(c.trun.flags).toBe(0x000001);
        expect(c.trun.version).toBe(0);
        expect(c.trun.sampleCount).toBe(1);
        expect(c.trun.dataOffset).toBe(c.moof.length + 8);
        expect(c.mdat.length).toBe(120);
        expect(state.hasReference).toBe(true);
        expect(state.baseMediaDecodeTime).toBe(9000n);
        expect(out.effective.sizes).toEqual([120]);
    });

    it('rebuilds varying sizes, first-sample flags and signed offsets (trun v1)', () => {
        const h = fullHeader(3, 0);
        setList(h, F.TRUN_SAMPLE_SIZES, [100, 50]);
        setScalar(h, F.TFHD_DEFAULT_SAMPLE_DURATION, 3000);
        setScalar(h, F.TRUN_FIRST_SAMPLE_FLAGS, 0x02000000);
        setScalar(h, F.TFHD_DEFAULT_SAMPLE_FLAGS, 0x01010000);
        setList(h, F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, [0, 1, 2]); // zigzag: 0, -1, 1
        const c = inspectChunk(chunk(h, new Uint8Array(210)).bytes);
        expect(c.trun.version).toBe(1);
        expect(c.trun.flags).toBe(0x000001 | 0x000004 | 0x000200 | 0x000800);
        expect(c.trun.firstSampleFlags).toBe(0x02000000);
        expect(c.trun.samples.map((s) => s.size)).toEqual([100, 50, 60]);
        expect(c.trun.samples.map((s) => s.cto)).toEqual([0, -1, 1]);
        expect(c.tfhd.defaultSampleFlags).toBe(0x01010000);
    });

    it('wraps genBoxes verbatim before the moof and writes an 8-byte empty mdat (8.3, 14)', () => {
        const prft = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        const out = chunk(fullHeader(0, 500), new Uint8Array(0), [{ type: 'prft', payload: prft }]);
        const c = inspectChunk(out.bytes);
        expect(c.preMoof).toEqual([{ type: 'prft', bytes: isoBox('prft', prft) }]);
        expect(c.mdat.length).toBe(0);
        expect(out.bytes.length).toBe(isoBox('prft', prft).length + c.moof.length + 8);
        expect(c.trun.flags).toBe(0x000001);
        expect(c.tfhd.flags).toBe(0x020000);
    });

    it('does not re-parse genBox contents: a truncated prft still wraps byte-for-byte (Java rejected it)', () => {
        const out = chunk(fullHeader(0, 0), new Uint8Array(0), [{ type: 'prft', payload: new Uint8Array(0) }]);
        expect(out.bytes.subarray(0, 8)).toEqual(concat(u32(8), ascii('prft')));
    });

    it('passes rawBoxes through verbatim and clears the group state (9.3, 9.4)', () => {
        const state = new LocmafGroupState();
        chunk(fullHeader(1, 0), new Uint8Array(1), [], state);
        const boxes = isoBox('free', Uint8Array.of(1));
        const out = reconstructor.reconstruct({ kind: 'rawBoxes', boxes }, state, context, 1n);
        expect(out).toEqual({ kind: 'raw', bytes: boxes });
        expect(state.hasReference).toBe(false);
    });

    it('does not parse rawBoxes children: a moof with junk inside is still verbatim (Java rejected it)', () => {
        const bytes = Uint8Array.of(0, 0, 0, 32, ...ascii('moof'), 0xff, 0xff, 0xff, 0xff, ...ascii('junk'),
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
        const out = reconstructor.reconstruct({ kind: 'rawBoxes', boxes: bytes }, new LocmafGroupState(), context, 0n);
        expect(out).toEqual({ kind: 'raw', bytes });
    });

    it('still validates the top-level tiling of an in-memory rawBoxes object (section 18)', () => {
        expect(() => reconstructor.reconstruct({ kind: 'rawBoxes', boxes: Uint8Array.of(0, 0, 0, 9, 1, 2, 3, 4) },
            new LocmafGroupState(), context, 0n)).toThrow(LocmafFormatError);
    });

    it('rejects the section 11.2 / 15.6.1 size-derivation failures', () => {
        expect(sectionOf(fullHeader(2, 0), new Uint8Array(10))).toBe('11.2'); // n>1, no sizes, trex default 0
        expect(sectionOf(setList(fullHeader(2, 0), F.TRUN_SAMPLE_SIZES, [20]), new Uint8Array(10))).toBe('11.2'); // sum > P
        expect(sectionOf(setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, 4), new Uint8Array(10))).toBe('11.2'); // 2*4 != 10
        expect(sectionOf(fullHeader(0, 0), new Uint8Array(1))).toBe('11.2'); // n==0 with payload
        expect(sectionOf(fullHeader(5_000_000, 0), new Uint8Array(10))).toBe('11.2'); // implementation cap
        expect(sectionOf(fullHeader(50, 0), new Uint8Array(10))).toBe('11.2'); // no size source
        expect(sectionOf(setList(fullHeader(2, 0), F.TRUN_SAMPLE_SIZES, []), new Uint8Array(10))).toBe('11.2'); // n-1 entries required
        expect(sectionOf(setList(fullHeader(3, 0), F.TRUN_SAMPLE_DURATIONS, [1, 2]), new Uint8Array(3))).toBe('10.2'); // list length != n
        expect(sectionOf(setScalar(fullHeader(1, 0), F.SENC_PER_SAMPLE_IV_SIZE, 8), new Uint8Array(1))).toBe('10.3'); // CENC on unprotected
        expect(sectionOf(new LocmafHeader(false), new Uint8Array(1))).toBe('3'); // delta without reference
        const noCount = new LocmafHeader(true);
        setScalar(noCount, F.TFDT_BASE_MEDIA_DECODE_TIME, 0);
        expect(sectionOf(noCount, new Uint8Array(0))).toBe('11.1');
        const noBmdt = new LocmafHeader(true);
        setScalar(noBmdt, F.TRUN_SAMPLE_COUNT, 0);
        expect(sectionOf(noBmdt, new Uint8Array(0))).toBe('11.1');
    });

    it('accepts more samples than payload bytes when the samples are zero-size (Java rejected n > P)', () => {
        const listed = chunk(setList(fullHeader(5, 0), F.TRUN_SAMPLE_SIZES, [0, 0, 0, 0]), new Uint8Array(2));
        expect(listed.effective.sizes).toEqual([0, 0, 0, 0, 2]);
        const zero = chunk(setScalar(fullHeader(3, 0), F.TFHD_DEFAULT_SAMPLE_DURATION, 1), new Uint8Array(0));
        expect(zero.effective.sizes).toEqual([0, 0, 0]);
        const c = inspectChunk(zero.bytes);
        expect(c.tfhd.defaultSampleSize).toBeUndefined(); // 0 equals trex.default_sample_size
    });

    it('rejects listed and uniform sizes whose arithmetic would overflow', () => {
        const huge = (1n << 62n) - 1n;
        expect(sectionOf(setList(fullHeader(4, 0), F.TRUN_SAMPLE_SIZES, [huge, huge, huge]), new Uint8Array(10))).toBe('11.2');
        expect(sectionOf(setScalar(fullHeader(8, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, 1n << 61n), new Uint8Array(0))).toBe('11.2');
    });

    it('range-checks 32-bit fields before writing them (section 18)', () => {
        const big = 0x1_0000_0000n;
        expect(sectionOf(setScalar(fullHeader(1, 0), F.TFHD_DEFAULT_SAMPLE_DURATION, big), new Uint8Array(1))).toBe('18');
        expect(sectionOf(setScalar(fullHeader(1, 0), F.TFHD_DEFAULT_SAMPLE_FLAGS, big), new Uint8Array(1))).toBe('18');
        expect(sectionOf(setScalar(fullHeader(1, 0), F.TRUN_FIRST_SAMPLE_FLAGS, big), new Uint8Array(1))).toBe('18');
        expect(sectionOf(setScalar(fullHeader(1, 0), F.TFHD_SAMPLE_DESCRIPTION_INDEX, big), new Uint8Array(1))).toBe('18');
        expect(sectionOf(setList(setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, 1), F.TRUN_SAMPLE_FLAGS, [0, big]), new Uint8Array(2))).toBe('18');
        expect(sectionOf(setList(fullHeader(1, 0), F.TRUN_SAMPLE_DURATIONS, [big]), new Uint8Array(1))).toBe('18');
        expect(sectionOf(setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_SIZE, big), new Uint8Array(0))).toBe('11.2');
        // A negative offset below int32, and a positive one above uint32.
        expect(sectionOf(setList(fullHeader(1, 0), F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, [(1n << 32n) + 1n]), new Uint8Array(1))).toBe('18');
        expect(sectionOf(setList(fullHeader(1, 0), F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, [1n << 33n]), new Uint8Array(1))).toBe('18');
        // 2^32-1 as the only (non-negative) offset still fits trun v0.
        const v0 = chunk(setList(fullHeader(1, 0), F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, [(1n << 33n) - 2n]), new Uint8Array(1));
        expect(inspectChunk(v0.bytes).trun.samples[0]!.cto).toBe(0xffffffff);
    });

    it('omits a sample description index equal to trex and emits one that differs', () => {
        const same = inspectChunk(chunk(setScalar(fullHeader(1, 0), F.TFHD_SAMPLE_DESCRIPTION_INDEX, 1), new Uint8Array(1)).bytes);
        expect(same.tfhd.sampleDescriptionIndex).toBeUndefined();
        const other = inspectChunk(chunk(setScalar(fullHeader(1, 0), F.TFHD_SAMPLE_DESCRIPTION_INDEX, 2), new Uint8Array(1)).bytes);
        expect(other.tfhd.sampleDescriptionIndex).toBe(2);
    });

    it('treats a strict cmf2 encoding (tfhd defaults equal to trex) like the minimal one (15.4)', () => {
        const minimalHeader = setScalar(fullHeader(2, 0), F.TFHD_DEFAULT_SAMPLE_DURATION, 3000);
        setScalar(minimalHeader, F.TFHD_DEFAULT_SAMPLE_SIZE, 10);
        const minimal = chunk(minimalHeader, new Uint8Array(20));
        const strict = fullHeader(2, 0);
        setScalar(strict, F.TFHD_DEFAULT_SAMPLE_DURATION, 3000);
        setScalar(strict, F.TFHD_SAMPLE_DESCRIPTION_INDEX, 1);
        setScalar(strict, F.TFHD_DEFAULT_SAMPLE_SIZE, 10);
        setScalar(strict, F.TFHD_DEFAULT_SAMPLE_FLAGS, 0);
        expect(chunk(strict, new Uint8Array(20)).bytes).toEqual(minimal.bytes);
        setBytes(new LocmafHeader(true), F.SENC_INITIALIZATION_VECTOR, new Uint8Array(0)); // bytes setter type-checks
    });
});
