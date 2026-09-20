/**
 * Canonical LOCMAF encoding of CMAF chunks. Stateless; the in-group state is
 * passed in and kept identical in shape to the reconstructor's.
 *
 * @see draft-einarsson-moq-locmaf-01 sections 9 (rawBoxes fallback), 11.1
 *   (emission rules), 12 (deltas), 15.9 (canonical encoding)
 * @module
 */

import { parseCmafChunk } from './cmaf-chunk.js';
import { validateRawBoxes } from './deserializer.js';
import { allEqual, equalExceptFirst, totalDuration, type LocmafEffectiveSamples } from './effective.js';
import { LocmafFormatError } from './errors.js';
import { LocmafFieldId as F, fieldKind } from './fields.js';
import type { LocmafGroupState } from './group-state.js';
import { LocmafHeader, type LocmafObject } from './model.js';
import type { LocmafTrackContext } from './track-context.js';
import { zigzagDecode, zigzagEncode } from './vi64.js';

export class LocmafEncoder {
    /**
     * Encode one CMAF chunk (genBoxes + moof + mdat) as a LOCMAF Object.
     *
     * A full header is emitted when forced, when the group has no reference,
     * after an Object ID gap, or when the BMDT diverges from the delta
     * derivation (section 12.2); otherwise a delta header. A chunk outside the
     * field model rides verbatim as rawBoxes and resets the chain (section 9.3).
     *
     * @throws {LocmafFormatError} (section 9.1) when the chunk cannot be carried
     *   even as rawBoxes (not a sequence of complete boxes, or size escapes).
     */
    encode(chunk: Uint8Array, state: LocmafGroupState, context: LocmafTrackContext, forceFull: boolean, objectId: bigint): LocmafObject {
        let parsed;
        try {
            parsed = parseCmafChunk(chunk, context);
        } catch (e) {
            if (!(e instanceof LocmafFormatError)) throw e;
            parsed = { fits: false as const, reason: e.message };
        }
        if (!parsed.fits) {
            validateRawBoxes(chunk);
            state.clear();
            state.noteObject(objectId);
            return { kind: 'rawBoxes', boxes: chunk };
        }
        const effective = parsed.effective;
        const represented = representedFields(effective, parsed.sencPerSampleIvSize, context);
        const previous = state.lastEffective;
        const reference = state.reference;
        const full = forceFull
            || reference === null
            || previous === null
            || objectId !== state.lastObjectId + 1n
            || effective.baseMediaDecodeTime !== state.baseMediaDecodeTime + totalDuration(previous);
        const header = full || reference === null ? represented.copy(true) : deltaFields(represented, reference);
        state.anchor(represented, effective, objectId);
        return { kind: 'moof', genBoxes: parsed.genBoxes, header, mdat: parsed.mdat };
    }
}

/**
 * Section 11.1 emission rules: the minimal absolute field set for one chunk.
 * `sencPerSampleIvSize` is the chunk's senc IV size, or null without senc.
 */
export function representedFields(e: LocmafEffectiveSamples, sencPerSampleIvSize: number | null, context: LocmafTrackContext): LocmafHeader {
    const n = e.durations.length;
    const h = new LocmafHeader(true);
    const scalar = (id: number, v: number | bigint): void => h.set(id, { kind: 'scalar', value: BigInt(v) });
    const list = (id: number, v: ReadonlyArray<number | bigint>): void => h.set(id, { kind: 'list', values: v.map((x) => BigInt(x)) });

    scalar(F.TRUN_SAMPLE_COUNT, n);
    scalar(F.TFDT_BASE_MEDIA_DECODE_TIME, e.baseMediaDecodeTime);
    if (e.sampleDescriptionIndex !== context.defaultSampleDescriptionIndex) {
        scalar(F.TFHD_SAMPLE_DESCRIPTION_INDEX, e.sampleDescriptionIndex);
    }
    if (n > 0) {
        if (!allEqual(e.durations)) list(F.TRUN_SAMPLE_DURATIONS, e.durations);
        else if (e.durations[0] !== context.defaultSampleDuration) scalar(F.TFHD_DEFAULT_SAMPLE_DURATION, e.durations[0]!);

        if (n > 1) {
            if (!allEqual(e.sizes)) list(F.TRUN_SAMPLE_SIZES, e.sizes.slice(0, n - 1));
            else if (e.sizes[0] !== context.defaultSampleSize) scalar(F.TFHD_DEFAULT_SAMPLE_SIZE, e.sizes[0]!);
        }

        if (allEqual(e.flags)) {
            if (e.flags[0] !== context.defaultSampleFlags) scalar(F.TFHD_DEFAULT_SAMPLE_FLAGS, e.flags[0]!);
        } else if (equalExceptFirst(e.flags)) {
            scalar(F.TRUN_FIRST_SAMPLE_FLAGS, e.flags[0]!);
            if (e.flags[1] !== context.defaultSampleFlags) scalar(F.TFHD_DEFAULT_SAMPLE_FLAGS, e.flags[1]!);
        } else {
            list(F.TRUN_SAMPLE_FLAGS, e.flags);
        }

        if (e.compositionTimeOffsets.some((c) => c !== 0)) {
            list(F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, e.compositionTimeOffsets.map((c) => zigzagEncode(BigInt(c))));
        }
    }
    if (sencPerSampleIvSize !== null) {
        if (sencPerSampleIvSize !== context.perSampleIvSize) scalar(F.SENC_PER_SAMPLE_IV_SIZE, sencPerSampleIvSize);
        const c = e.cenc;
        if (c !== null && c.perSampleIvSize > 0) h.set(F.SENC_INITIALIZATION_VECTOR, { kind: 'bytes', bytes: c.ivs });
        if (c?.subsampleCounts && c.clearBytes && c.protectedBytes) {
            list(F.SENC_SUBSAMPLE_COUNT, c.subsampleCounts);
            list(F.SENC_BYTES_OF_CLEAR_DATA, c.clearBytes);
            list(F.SENC_BYTES_OF_PROTECTED_DATA, c.protectedBytes);
        }
    }
    return h;
}

/**
 * Sections 12.1, 12.3 and 15.9: exactly the fields whose represented values
 * changed from the reference (a list counts as changed when its length does),
 * plus the deletion marker for fields that left it. BMDT is never carried.
 */
export function deltaFields(represented: LocmafHeader, reference: LocmafHeader): LocmafHeader {
    const delta = new LocmafHeader(false);
    const deleted = reference.ids().filter((id) => id !== F.TFDT_BASE_MEDIA_DECODE_TIME && !represented.has(id));
    if (deleted.length > 0) {
        delta.set(F.DELTA_DELETED_LOCMAF_IDS, { kind: 'list', values: deleted.map((id) => BigInt(id)) });
    }
    for (const id of represented.ids()) {
        if (id === F.TFDT_BASE_MEDIA_DECODE_TIME) continue;
        const current = represented.get(id)!;
        const previous = reference.get(id);
        if (current.kind === 'scalar') {
            const before = previous?.kind === 'scalar' ? previous.value : 0n;
            if (previous === undefined || current.value !== before) {
                delta.set(id, { kind: 'scalar', value: zigzagEncode(current.value - before) });
            }
        } else if (current.kind === 'bytes') {
            if (previous?.kind !== 'bytes' || !bytesEqual(previous.bytes, current.bytes)) delta.set(id, current);
        } else {
            const before = previous?.kind === 'list' ? previous.values : [];
            if (previous !== undefined && listEqual(before, current.values)) continue;
            const signed = fieldKind(id) === 'signed-list';
            delta.set(id, {
                kind: 'list',
                values: current.values.map((v, i) => {
                    const base = i < before.length ? before[i]! : 0n;
                    return signed ? zigzagEncode(zigzagDecode(v) - zigzagDecode(base)) : zigzagEncode(v - base);
                }),
            });
        }
    }
    return delta;
}

function listEqual(a: readonly bigint[], b: readonly bigint[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
