/**
 * Field table and header model (draft-einarsson-moq-locmaf-01 sections 7.3, 10).
 * Ported from the Java LocmafHeaderTest.
 */
import { describe, it, expect } from 'vitest';
import { LocmafFieldId, fieldKind, isCencField, isKnownField } from './fields.js';
import { LocmafHeader } from './model.js';

describe('field table (Table 4)', () => {
    it('matches draft IDs, kinds and restrictions', () => {
        expect(LocmafFieldId.TRUN_SAMPLE_SIZES).toBe(1);
        expect(fieldKind(LocmafFieldId.TRUN_SAMPLE_SIZES)).toBe('list');
        expect(LocmafFieldId.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS).toBe(5);
        expect(fieldKind(5)).toBe('signed-list');
        expect(LocmafFieldId.SENC_INITIALIZATION_VECTOR).toBe(9);
        expect(fieldKind(9)).toBe('bytes');
        expect(LocmafFieldId.DELTA_DELETED_LOCMAF_IDS).toBe(27);
        expect(fieldKind(27)).toBe('deletion-list');
        expect(isCencField(LocmafFieldId.SENC_SUBSAMPLE_COUNT)).toBe(true);
        expect(isCencField(LocmafFieldId.TRUN_SAMPLE_COUNT)).toBe(false);
        expect(isKnownField(99)).toBe(false);
        for (const id of Object.values(LocmafFieldId)) {
            expect(id % 2 === 0, `parity rule for ${id}`).toBe(fieldKind(id) === 'scalar');
        }
    });
});

describe('LocmafHeader', () => {
    it('orders fields by ID and rejects restricted or mistyped fields', () => {
        const full = new LocmafHeader(true);
        full.set(LocmafFieldId.TRUN_SAMPLE_COUNT, { kind: 'scalar', value: 2n });
        full.set(LocmafFieldId.TRUN_SAMPLE_SIZES, { kind: 'list', values: [100n] });
        full.set(LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME, { kind: 'scalar', value: 9000n });
        expect(full.ids()).toEqual([1, 10, 14]);
        expect(full.scalar(LocmafFieldId.TRUN_SAMPLE_COUNT)).toBe(2n);
        expect(full.list(LocmafFieldId.TRUN_SAMPLE_SIZES)).toEqual([100n]);
        expect(() => full.set(LocmafFieldId.DELTA_DELETED_LOCMAF_IDS, { kind: 'list', values: [12n] })).toThrow(TypeError);
        const delta = new LocmafHeader(false);
        expect(() => delta.set(LocmafFieldId.TFDT_BASE_MEDIA_DECODE_TIME, { kind: 'scalar', value: 1n })).toThrow(TypeError);
        expect(() => delta.set(LocmafFieldId.TRUN_SAMPLE_COUNT, { kind: 'list', values: [1n] })).toThrow(TypeError);
        expect(() => delta.set(99, { kind: 'scalar', value: 1n })).toThrow(TypeError);
    });

    it('copies independently', () => {
        const full = new LocmafHeader(true);
        full.set(LocmafFieldId.TRUN_SAMPLE_COUNT, { kind: 'scalar', value: 1n });
        const copy = full.copy();
        copy.delete(LocmafFieldId.TRUN_SAMPLE_COUNT);
        expect(full.has(LocmafFieldId.TRUN_SAMPLE_COUNT)).toBe(true);
        expect(copy.has(LocmafFieldId.TRUN_SAMPLE_COUNT)).toBe(false);
    });
});
