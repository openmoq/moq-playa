/**
 * Delta encoding and the full-header choice (draft-einarsson-moq-locmaf-01
 * sections 12, 15.9). Ported from the Java LocmafEncoderDeltaTest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LocmafEncoder } from './encoder.js';
import { LocmafGroupState } from './group-state.js';
import { parseLocmafTrackContext } from './track-context.js';
import { LocmafFieldId as F } from './fields.js';
import type { LocmafHeader } from './model.js';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, videoInit, type SampleSpec } from '../test-support/cmaf.js';
import { zz } from '../test-support/locmaf.js';

const encoder = new LocmafEncoder();
const context = parseLocmafTrackContext(videoInit());
let state: LocmafGroupState;

beforeEach(() => {
    state = new LocmafGroupState();
});

const s = (duration: number, size: number, flags: number): SampleSpec => ({ duration, size, flags });

function encode(bmdt: number, objectId: number, samples: SampleSpec[], forceFull = false): LocmafHeader {
    const object = encoder.encode(buildChunk({ bmdt, samples }), state, context, forceFull, BigInt(objectId));
    if (object.kind !== 'moof') throw new Error('expected a moof-carrying object');
    return object.header;
}

describe('LocmafEncoder, delta headers', () => {
    it('produces empty deltas in steady state, after a flags change on the second chunk', () => {
        expect(encode(0, 0, [s(3000, 100, SYNC_FLAGS)]).full).toBe(true);
        const second = encode(3000, 1, [s(3000, 90, NON_SYNC_FLAGS)]);
        expect(second.full).toBe(false);
        expect(second.ids()).toEqual([F.TFHD_DEFAULT_SAMPLE_FLAGS]);
        expect(second.scalar(F.TFHD_DEFAULT_SAMPLE_FLAGS)).toBe(zz(NON_SYNC_FLAGS - SYNC_FLAGS)[0]);
        const third = encode(6000, 2, [s(3000, 95, NON_SYNC_FLAGS)]);
        expect(third.size).toBe(0);
    });

    it('lists a field leaving the reference in the deletion marker (12.3)', () => {
        encode(0, 0, [s(3000, 10, SYNC_FLAGS), s(3000, 20, NON_SYNC_FLAGS)]);
        const delta = encode(6000, 1, [s(3000, 10, NON_SYNC_FLAGS), s(3000, 20, NON_SYNC_FLAGS)]);
        expect(delta.list(F.DELTA_DELETED_LOCMAF_IDS)).toEqual([12n]);
        expect(delta.has(F.TRUN_SAMPLE_SIZES)).toBe(false);
    });

    it('always emits a list whose length changed (15.9)', () => {
        encode(0, 0, [s(1000, 10, SYNC_FLAGS), s(1000, 20, SYNC_FLAGS), s(1000, 30, SYNC_FLAGS)]);
        const delta = encode(3000, 1, [s(1000, 10, SYNC_FLAGS), s(1000, 20, SYNC_FLAGS)]);
        expect(delta.scalar(F.TRUN_SAMPLE_COUNT)).toBe(zz(-1)[0]);
        expect(delta.list(F.TRUN_SAMPLE_SIZES)).toEqual([0n]);
    });

    it('re-anchors with a full header on a timeline discontinuity (12.2)', () => {
        encode(0, 0, [s(3000, 10, SYNC_FLAGS)]);
        expect(encode(9999, 1, [s(3000, 10, SYNC_FLAGS)]).full).toBe(true);
    });

    it('re-anchors with a full header after an object ID gap or when forced', () => {
        encode(0, 0, [s(3000, 10, SYNC_FLAGS)]);
        expect(encode(3000, 2, [s(3000, 10, SYNC_FLAGS)]).full).toBe(true);
        expect(encode(6000, 3, [s(3000, 10, SYNC_FLAGS)], true).full).toBe(true);
        expect(encode(9000, 4, [s(3000, 10, SYNC_FLAGS)]).full).toBe(false);
    });

    it('emits a full header after a rawBoxes object resets the chain (9.3)', () => {
        encode(0, 0, [s(3000, 10, SYNC_FLAGS)]);
        expect(encoder.encode(videoInit(), state, context, false, 1n).kind).toBe('rawBoxes');
        expect(encode(3000, 2, [s(3000, 10, SYNC_FLAGS)]).full).toBe(true);
    });
});
