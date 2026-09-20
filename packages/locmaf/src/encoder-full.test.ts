/**
 * Full-header encoding and the rawBoxes fallback (draft-einarsson-moq-locmaf-01
 * sections 8, 9, 11.1, 11.2). Ported from the Java LocmafEncoderFullTest.
 */
import { describe, it, expect } from 'vitest';
import { LocmafEncoder } from './encoder.js';
import { LocmafGroupState } from './group-state.js';
import { parseLocmafTrackContext } from './track-context.js';
import { LocmafFormatError } from './errors.js';
import { LocmafFieldId as F } from './fields.js';
import type { LocmafObject } from './model.js';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, cencVideoInit, stypBox, videoInit } from '../test-support/cmaf.js';
import { ascii, concat, fullBox, u32, u64 } from '../test-support/bytes.js';
import { zz } from '../test-support/locmaf.js';

const encoder = new LocmafEncoder();
const video = parseLocmafTrackContext(videoInit());

function moof(object: LocmafObject) {
    if (object.kind !== 'moof') throw new Error(`expected a moof-carrying object, got ${object.kind}`);
    return object;
}

describe('LocmafEncoder, full headers', () => {
    it('emits only count, BMDT, duration and flags for a single-sample chunk', () => {
        const chunk = buildChunk({ bmdt: 9000, samples: [{ duration: 3000, size: 120, flags: SYNC_FLAGS }], mdat: new Uint8Array(120) });
        const object = moof(encoder.encode(chunk, new LocmafGroupState(), video, true, 0n));
        const h = object.header;
        expect(h.full).toBe(true);
        expect(h.ids()).toEqual([F.TFHD_DEFAULT_SAMPLE_DURATION, F.TFHD_DEFAULT_SAMPLE_FLAGS, F.TFDT_BASE_MEDIA_DECODE_TIME, F.TRUN_SAMPLE_COUNT]);
        expect(h.scalar(F.TRUN_SAMPLE_COUNT)).toBe(1n);
        expect(h.scalar(F.TFDT_BASE_MEDIA_DECODE_TIME)).toBe(9000n);
        expect(h.scalar(F.TFHD_DEFAULT_SAMPLE_DURATION)).toBe(3000n);
        expect(h.has(F.TRUN_SAMPLE_SIZES)).toBe(false);
        expect(h.has(F.TFHD_DEFAULT_SAMPLE_SIZE)).toBe(false);
        expect(object.mdat.length).toBe(120);
        expect(object.genBoxes).toEqual([]);
    });

    it('uses n-1 sizes, first-sample flags and zigzag offsets for varying samples', () => {
        const chunk = buildChunk({
            bmdt: 0,
            samples: [
                { duration: 3000, size: 100, flags: SYNC_FLAGS, cto: 0 },
                { duration: 3000, size: 50, flags: NON_SYNC_FLAGS, cto: -3000 },
                { duration: 3000, size: 60, flags: NON_SYNC_FLAGS, cto: 3000 },
            ],
        });
        const h = moof(encoder.encode(chunk, new LocmafGroupState(), video, true, 0n)).header;
        expect(h.list(F.TRUN_SAMPLE_SIZES)).toEqual([100n, 50n]);
        expect(h.scalar(F.TRUN_FIRST_SAMPLE_FLAGS)).toBe(BigInt(SYNC_FLAGS));
        expect(h.scalar(F.TFHD_DEFAULT_SAMPLE_FLAGS)).toBe(BigInt(NON_SYNC_FLAGS));
        expect(h.has(F.TRUN_SAMPLE_FLAGS)).toBe(false);
        expect(h.list(F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS)).toEqual(zz(0, -3000, 3000));
    });

    it('uses the default sample size for uniform sizes', () => {
        const chunk = buildChunk({ bmdt: 0, samples: [{ duration: 1024, size: 40, flags: SYNC_FLAGS }, { duration: 1024, size: 40, flags: SYNC_FLAGS }] });
        const h = moof(encoder.encode(chunk, new LocmafGroupState(), video, true, 0n)).header;
        expect(h.scalar(F.TFHD_DEFAULT_SAMPLE_SIZE)).toBe(40n);
        expect(h.has(F.TRUN_SAMPLE_SIZES)).toBe(false);
        expect(h.has(F.TRUN_FIRST_SAMPLE_FLAGS)).toBe(false);
    });

    it('emits a per-sample flags list when flags are neither uniform nor equal-except-first', () => {
        const chunk = buildChunk({ bmdt: 0, samples: [
            { duration: 1, size: 1, flags: SYNC_FLAGS }, { duration: 1, size: 1, flags: NON_SYNC_FLAGS }, { duration: 1, size: 1, flags: SYNC_FLAGS },
        ] });
        const h = moof(encoder.encode(chunk, new LocmafGroupState(), video, true, 0n)).header;
        expect(h.list(F.TRUN_SAMPLE_FLAGS)).toEqual([SYNC_FLAGS, NON_SYNC_FLAGS, SYNC_FLAGS].map(BigInt));
        expect(h.has(F.TFHD_DEFAULT_SAMPLE_FLAGS)).toBe(false);
        expect(h.has(F.TRUN_FIRST_SAMPLE_FLAGS)).toBe(false);
    });

    it('turns pre-moof boxes into genBoxes, carrying their contents verbatim', () => {
        const prft = fullBox('prft', 1, 0, u32(1), u64(42n), u64(7n));
        const chunk = buildChunk({ bmdt: 0, preMoof: [prft, stypBox()], samples: [{ duration: 3000, size: 5, flags: SYNC_FLAGS }] });
        const object = moof(encoder.encode(chunk, new LocmafGroupState(), video, true, 0n));
        expect(object.genBoxes.map((b) => b.type)).toEqual(['prft', 'styp']);
        expect(object.genBoxes[0]!.payload).toEqual(prft.subarray(8));
    });

    it('falls back to rawBoxes for a multi-trun fragment and clears the state (section 9)', () => {
        const chunk = buildChunk({ bmdt: 0, samples: [{ duration: 3000, size: 5, flags: SYNC_FLAGS }], extraTrun: true });
        const state = new LocmafGroupState();
        encoder.encode(buildChunk({ bmdt: 0, samples: [{ duration: 3000, size: 5, flags: SYNC_FLAGS }] }), state, video, true, 0n);
        const object = encoder.encode(chunk, state, video, false, 1n);
        expect(object).toEqual({ kind: 'rawBoxes', boxes: chunk });
        expect(state.hasReference).toBe(false);
    });

    it('falls back to rawBoxes for an init segment and for CENC data on an unprotected track', () => {
        expect(encoder.encode(videoInit(), new LocmafGroupState(), video, false, 0n).kind).toBe('rawBoxes');
        const senc = buildChunk({
            bmdt: 0, samples: [{ duration: 1, size: 8, flags: 0 }],
            senc: { ivSize: 8, useSubsamples: false, samples: [{ iv: new Uint8Array(8), subsamples: [] }] },
        });
        expect(encoder.encode(senc, new LocmafGroupState(), video, false, 0n).kind).toBe('rawBoxes');
    });

    it('falls back to rawBoxes when a protected track has a per-sample IV size but no senc', () => {
        const cenc = parseLocmafTrackContext(cencVideoInit(8));
        const chunk = buildChunk({ bmdt: 0, samples: [{ duration: 1, size: 8, flags: 0 }] });
        expect(encoder.encode(chunk, new LocmafGroupState(), cenc, false, 0n).kind).toBe('rawBoxes');
    });

    it('emits the CENC fields, and field 16 only when the IV size differs from tenc', () => {
        const cenc = parseLocmafTrackContext(cencVideoInit(8));
        const chunk = buildChunk({
            bmdt: 0, samples: [{ duration: 1, size: 40, flags: 0 }],
            senc: { ivSize: 8, useSubsamples: true, withSaizSaio: true, samples: [{ iv: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8), subsamples: [[8, 32]] }] },
        });
        const h = moof(encoder.encode(chunk, new LocmafGroupState(), cenc, false, 0n)).header;
        expect(h.has(F.SENC_PER_SAMPLE_IV_SIZE)).toBe(false);
        expect(h.bytes(F.SENC_INITIALIZATION_VECTOR)).toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
        expect(h.list(F.SENC_SUBSAMPLE_COUNT)).toEqual([1n]);
        expect(h.list(F.SENC_BYTES_OF_CLEAR_DATA)).toEqual([8n]);
        expect(h.list(F.SENC_BYTES_OF_PROTECTED_DATA)).toEqual([32n]);
        const empty = buildChunk({
            bmdt: 0, samples: [{ duration: 1, size: 40, flags: 0 }],
            senc: { ivSize: 0, useSubsamples: true, samples: [{ iv: new Uint8Array(0), subsamples: [[8, 32]] }] },
        });
        expect(moof(encoder.encode(empty, new LocmafGroupState(), cenc, false, 0n)).header.scalar(F.SENC_PER_SAMPLE_IV_SIZE)).toBe(0n);
    });

    it('throws when a chunk cannot be carried even as rawBoxes (size escapes, section 9.1)', () => {
        const chunk = concat(u32(0), ascii('mdat'), Uint8Array.of(1, 2, 3));
        expect(() => encoder.encode(chunk, new LocmafGroupState(), video, false, 0n)).toThrow(LocmafFormatError);
    });
});
