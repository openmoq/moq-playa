/**
 * Delta-header reconstruction (draft-einarsson-moq-locmaf-01 sections 3, 12,
 * 15.1). Ported from the Java LocmafReconstructorDeltaTest, plus the
 * section 10.4 / 12.1.1 rules the Java implementation left implicit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LocmafReconstructor } from './reconstruct.js';
import { LocmafGroupState } from './group-state.js';
import { parseLocmafTrackContext, type LocmafTrackContext } from './track-context.js';
import { LocmafFormatError } from './errors.js';
import { LocmafFieldId as F } from './fields.js';
import { LocmafHeader } from './model.js';
import { buildInit, videoInit } from '../test-support/cmaf.js';
import { inspectChunk } from '../test-support/inspect.js';
import { fullHeader, setBytes, setList, setScalar, zz } from '../test-support/locmaf.js';

const reconstructor = new LocmafReconstructor();
let context: LocmafTrackContext;
let state: LocmafGroupState;

beforeEach(() => {
    context = parseLocmafTrackContext(videoInit());
    state = new LocmafGroupState();
    const full = fullHeader(1, 9000);
    setScalar(full, F.TFHD_DEFAULT_SAMPLE_DURATION, 3000);
    setScalar(full, F.TFHD_DEFAULT_SAMPLE_FLAGS, 0x02000000);
    reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header: full, mdat: new Uint8Array(100) }, state, context, 0n);
});

function delta(header: LocmafHeader, mdat: Uint8Array, objectId: bigint) {
    const out = reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header, mdat }, state, context, objectId);
    if (out.kind !== 'chunk') throw new Error('expected a chunk');
    return out;
}

function sectionOf(fn: () => unknown): string {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(LocmafFormatError);
        return (e as LocmafFormatError).section;
    }
    throw new Error('expected a LocmafFormatError');
}

const emptyDelta = () => new LocmafHeader(false);

describe('LocmafReconstructor, delta headers', () => {
    it('inherits everything from an empty delta and derives BMDT (12.2, 12.4)', () => {
        const second = inspectChunk(delta(emptyDelta(), new Uint8Array(80), 1n).bytes);
        expect(second.tfdt.bmdt).toBe(12000n);
        expect(second.tfhd.defaultSampleDuration).toBe(3000);
        expect(second.tfhd.defaultSampleSize).toBe(80);
        expect(second.tfhd.defaultSampleFlags).toBe(0x02000000);
        const third = inspectChunk(delta(emptyDelta(), new Uint8Array(70), 2n).bytes);
        expect(third.tfdt.bmdt).toBe(15000n);
    });

    it('removes deleted fields so the trex default applies (12.3)', () => {
        const d = setList(emptyDelta(), F.DELTA_DELETED_LOCMAF_IDS, [8]);
        expect(inspectChunk(delta(d, new Uint8Array(80), 1n).bytes).tfhd.flags & 0x000020).toBe(0);
    });

    it('ignores unknown IDs in the deletion list rather than failing the chunk (7.3, 12.3)', () => {
        const d = setList(emptyDelta(), F.DELTA_DELETED_LOCMAF_IDS, [99, (1n << 63n) + 5n, 8]);
        const c = inspectChunk(delta(d, new Uint8Array(80), 1n).bytes);
        expect(c.tfhd.defaultSampleFlags).toBeUndefined();
        expect(c.tfhd.defaultSampleDuration).toBe(3000);
    });

    it('applies deletions before deltas: a deleted field re-introduced in the same header is absolute', () => {
        const d = setList(emptyDelta(), F.DELTA_DELETED_LOCMAF_IDS, [4]);
        setScalar(d, F.TFHD_DEFAULT_SAMPLE_DURATION, zz(1500)[0]!);
        expect(inspectChunk(delta(d, new Uint8Array(80), 1n).bytes).tfhd.defaultSampleDuration).toBe(1500);
    });

    it('rejects a deletion of trunSampleCount that leaves no count (11.1)', () => {
        const d = setList(emptyDelta(), F.DELTA_DELETED_LOCMAF_IDS, [14]);
        expect(sectionOf(() => delta(d, new Uint8Array(80), 1n))).toBe('11.1');
    });

    it('treats a deletion of the derived BMDT as a no-op', () => {
        const d = setList(emptyDelta(), F.DELTA_DELETED_LOCMAF_IDS, [10]);
        expect(inspectChunk(delta(d, new Uint8Array(80), 1n).bytes).tfdt.bmdt).toBe(12000n);
    });

    it('applies scalar deltas as zigzag against the reference (12.1)', () => {
        const d = setScalar(emptyDelta(), F.TFHD_DEFAULT_SAMPLE_DURATION, zz(-1000)[0]!);
        expect(inspectChunk(delta(d, new Uint8Array(80), 1n).bytes).tfhd.defaultSampleDuration).toBe(2000);
    });

    it('grows lists with an absolute tail and shrinks by truncation (12.1.1)', () => {
        const grow = emptyDelta();
        setScalar(grow, F.TRUN_SAMPLE_COUNT, zz(2)[0]!);
        setList(grow, F.TRUN_SAMPLE_SIZES, zz(10, 20));
        setList(grow, F.TRUN_SAMPLE_DURATIONS, zz(3000, 3000, 1500));
        let trun = inspectChunk(delta(grow, new Uint8Array(100), 1n).bytes).trun;
        expect(trun.sampleCount).toBe(3);
        expect(trun.samples[2]!.size).toBe(70);
        expect(trun.samples[2]!.duration).toBe(1500);

        const shrink = emptyDelta();
        setScalar(shrink, F.TRUN_SAMPLE_COUNT, zz(-1)[0]!);
        setList(shrink, F.TRUN_SAMPLE_SIZES, [0n]);
        setList(shrink, F.TRUN_SAMPLE_DURATIONS, [0n, 0n]);
        const thirdOut = delta(shrink, new Uint8Array(50), 2n);
        const third = inspectChunk(thirdOut.bytes);
        trun = third.trun;
        expect(trun.sampleCount).toBe(2);
        expect(thirdOut.effective.durations).toEqual([3000, 3000]);
        expect(third.tfhd.defaultSampleDuration).toBe(3000); // uniform again, so canonical form moves it to tfhd
        expect(trun.samples[1]!.size).toBe(40);
        // 9000 + 3000 + (3000 + 3000 + 1500)
        expect(third.tfdt.bmdt).toBe(19500n);
    });

    it('truncates an inherited list when the count shrinks without restating it', () => {
        const grow = emptyDelta();
        setScalar(grow, F.TRUN_SAMPLE_COUNT, zz(2)[0]!);
        setList(grow, F.TRUN_SAMPLE_DURATIONS, zz(1000, 2000, 3000));
        setList(grow, F.TRUN_SAMPLE_SIZES, zz(1, 1));
        delta(grow, new Uint8Array(3), 1n);
        const shrink = emptyDelta();
        setScalar(shrink, F.TRUN_SAMPLE_COUNT, zz(-1)[0]!);
        const out = delta(shrink, new Uint8Array(2), 2n);
        expect(inspectChunk(out.bytes).trun.samples.map((s) => s.duration)).toEqual([1000, 2000]);
        expect(out.effective.sizes).toEqual([1, 1]);
    });

    it('rejects a delta list whose element count is not the known length (12.1.1)', () => {
        const d = emptyDelta();
        setScalar(d, F.TRUN_SAMPLE_COUNT, zz(1)[0]!);
        setList(d, F.TRUN_SAMPLE_DURATIONS, zz(1, 2, 3));
        expect(sectionOf(() => delta(d, new Uint8Array(2), 1n))).toBe('12.1.1');
        expect(state.hasReference).toBe(false);
    });

    it('rejects an inherited list shorter than the new count (12.1.1)', () => {
        const grow = emptyDelta();
        setScalar(grow, F.TRUN_SAMPLE_COUNT, zz(1)[0]!);
        setList(grow, F.TRUN_SAMPLE_DURATIONS, zz(1000, 2000));
        setList(grow, F.TRUN_SAMPLE_SIZES, zz(1));
        delta(grow, new Uint8Array(2), 1n);
        const more = setScalar(emptyDelta(), F.TRUN_SAMPLE_COUNT, zz(1)[0]!);
        expect(sectionOf(() => delta(more, new Uint8Array(3), 2n))).toBe('12.1.1');
    });

    it('overwrites IV bytes rather than applying a delta', () => {
        context = parseLocmafTrackContext(buildInit({
            trackId: 1, timescale: 90000, handler: 'vide', encryption: { scheme: 'cenc', perSampleIvSize: 8 },
        }));
        state = new LocmafGroupState();
        const full = setBytes(fullHeader(1, 0), F.SENC_INITIALIZATION_VECTOR, new Uint8Array(8).fill(1));
        reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header: full, mdat: new Uint8Array(8) }, state, context, 0n);
        const d = setBytes(emptyDelta(), F.SENC_INITIALIZATION_VECTOR, new Uint8Array(8).fill(2));
        expect(inspectChunk(delta(d, new Uint8Array(8), 1n).bytes, 8).senc!.samples[0]!.iv).toEqual(new Uint8Array(8).fill(2));
    });

    it('rejects a delta after an object ID gap and clears the state (section 3)', () => {
        expect(sectionOf(() => delta(emptyDelta(), new Uint8Array(1), 5n))).toBe('3');
        expect(state.hasReference).toBe(false);
        expect(sectionOf(() => delta(emptyDelta(), new Uint8Array(1), 6n))).toBe('3');
    });

    it('re-anchors on a full header after a gap', () => {
        expect(sectionOf(() => delta(emptyDelta(), new Uint8Array(1), 5n))).toBe('3');
        const out = delta(setScalar(fullHeader(1, 1n << 40n), F.TFHD_DEFAULT_SAMPLE_DURATION, 10), new Uint8Array(1), 6n);
        expect(out.effective.baseMediaDecodeTime).toBe(1n << 40n);
        expect(inspectChunk(delta(emptyDelta(), new Uint8Array(1), 7n).bytes).tfdt.bmdt).toBe((1n << 40n) + 10n);
    });

    it('rejects a negative sample count (12.1)', () => {
        const d = setScalar(emptyDelta(), F.TRUN_SAMPLE_COUNT, zz(-5)[0]!);
        expect(sectionOf(() => delta(d, new Uint8Array(1), 1n))).toBe('12.1');
    });

    it('rejects a delta without an in-group reference (9.3)', () => {
        const fresh = new LocmafGroupState();
        expect(sectionOf(() => reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header: emptyDelta(), mdat: new Uint8Array(1) },
            fresh, context, 0n))).toBe('3');
    });

    it('rejects a delta driving the sample count to 2^31 (12.1)', () => {
        const listState = new LocmafGroupState();
        const full = fullHeader(3, 0);
        setList(full, F.TRUN_SAMPLE_DURATIONS, [3000, 3000, 3000]);
        setList(full, F.TRUN_SAMPLE_SIZES, [1, 1]);
        reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header: full, mdat: new Uint8Array(3) }, listState, context, 0n);
        const d = setScalar(emptyDelta(), F.TRUN_SAMPLE_COUNT, zz((1n << 31n) - 3n)[0]!);
        expect(sectionOf(() => reconstructor.reconstruct({ kind: 'moof', genBoxes: [], header: d, mdat: new Uint8Array(3) },
            listState, context, 1n))).toBe('12.1');
    });

    it('clears the state when a delta is rejected, so the next delta is refused too', () => {
        const bad = setScalar(emptyDelta(), F.TFHD_DEFAULT_SAMPLE_SIZE, zz(7)[0]!);
        expect(sectionOf(() => delta(bad, new Uint8Array(80), 1n))).toBe('11.2');
        expect(sectionOf(() => delta(emptyDelta(), new Uint8Array(80), 2n))).toBe('3');
    });
});
