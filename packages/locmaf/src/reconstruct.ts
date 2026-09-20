/**
 * Canonical CMAF reconstruction of LOCMAF Objects. Stateless; the in-group
 * state is passed in.
 *
 * @see draft-einarsson-moq-locmaf-01 sections 3, 9.3, 9.4, 11.2, 12, 15, 18
 * @module
 */

import { ByteWriter } from './byte-writer.js';
import { validateRawBoxes } from './deserializer.js';
import {
    allEqual,
    equalExceptFirst,
    totalDuration,
    type LocmafCencSamples,
    type LocmafEffectiveSamples,
} from './effective.js';
import { LocmafFormatError } from './errors.js';
import { LocmafFieldId as F, isCencField, isKnownField } from './fields.js';
import type { LocmafGroupState } from './group-state.js';
import type { GenBox, LocmafHeader, LocmafObject } from './model.js';
import type { LocmafTrackContext } from './track-context.js';
import { MAX_VI64, zigzagDecode, zigzagEncode } from './vi64.js';

/**
 * Implementation bound on trunSampleCount, checked before any per-sample
 * allocation (section 18). A chunk is a fraction of a segment, so real chunks
 * stay far below it, while a delta of a few bytes can otherwise demand per-sample
 * arrays of this length.
 */
export const MAX_SAMPLE_COUNT = 100_000;

const U16_MAX = 0xffffn;
const U32_MAX = 0xffffffffn;
const I32_MIN = -(1n << 31n);
const I32_MAX = (1n << 31n) - 1n;

/** Result of reconstructing one LOCMAF Object. */
export type LocmafReconstruction =
    | {
          /** A moof-carrying Object rebuilt as genBoxes + moof + mdat. */
          readonly kind: 'chunk';
          readonly bytes: Uint8Array;
          readonly effective: LocmafEffectiveSamples;
      }
    | {
          /** A rawBoxes Object: its boxes, verbatim (section 9.4). */
          readonly kind: 'raw';
          readonly bytes: Uint8Array;
      };

export class LocmafReconstructor {
    /**
     * Reconstruct one Object against the group state and update the state.
     *
     * A rawBoxes Object clears the state (section 9.3). A rejected Object also
     * clears it: a malformed or missing chunk is a loss of in-group sync, so
     * later deltas are refused until the next full header (section 3).
     *
     * @throws {LocmafFormatError} when the Object must be rejected.
     */
    reconstruct(object: LocmafObject, state: LocmafGroupState, context: LocmafTrackContext, objectId: bigint): LocmafReconstruction {
        if (object.kind === 'rawBoxes') {
            state.clear();
            state.noteObject(objectId);
            return { kind: 'raw', bytes: validateRawBoxes(object.boxes) };
        }
        const header = object.header;
        if (!header.full) {
            if (!state.hasReference) {
                throw new LocmafFormatError('3', 0, 'delta header without an in-group reference');
            }
            if (objectId !== state.lastObjectId + 1n) {
                const last = state.lastObjectId;
                state.clear();
                throw new LocmafFormatError('3', 0, `object ID gap before delta (${last} -> ${objectId}); waiting for a full header`);
            }
        }
        try {
            const represented = header.full ? header.copy(true) : this.applyDelta(header, state);
            const effective = this.effectiveValues(represented, object.mdat.length, state, context, header.full);
            const bytes = buildCanonicalChunk(object.genBoxes, effective, object.mdat, context);
            state.anchor(represented, effective, objectId);
            return { kind: 'chunk', bytes, effective };
        } catch (e) {
            if (e instanceof LocmafFormatError) state.clear();
            throw e;
        }
    }

    /**
     * Apply a delta header to the group reference (sections 12.1 to 12.3):
     * deletions first, then trunSampleCount (it fixes every list length), then
     * scalar zigzag deltas, element-wise list deltas, and raw-bytes overwrite.
     * Returns the chunk's represented fields in full form, without field 10
     * (a delta chunk's BMDT is derived).
     */
    applyDelta(delta: LocmafHeader, state: LocmafGroupState): LocmafHeader {
        const reference = state.reference;
        if (reference === null) {
            throw new LocmafFormatError('3', 0, 'delta header without an in-group reference');
        }
        const result = reference.copy(true);

        if (delta.has(F.DELTA_DELETED_LOCMAF_IDS)) {
            for (const id of delta.list(F.DELTA_DELETED_LOCMAF_IDS)) {
                // Unknown IDs were never stored (section 7.3), so deleting one is a no-op.
                if (id <= 64n && isKnownField(Number(id))) result.delete(Number(id));
            }
        }

        const applyScalar = (id: number): void => {
            const d = delta.get(id);
            if (d?.kind !== 'scalar') return;
            const previous = result.has(id) ? result.scalar(id) : 0n;
            const value = previous + zigzagDecode(d.value);
            if (value < 0n || value > MAX_VI64) {
                throw new LocmafFormatError('12.1', 0, `field ${id} delta yields out-of-range value ${value}`);
            }
            result.set(id, { kind: 'scalar', value });
        };

        applyScalar(F.TRUN_SAMPLE_COUNT);
        if (!result.has(F.TRUN_SAMPLE_COUNT)) {
            throw new LocmafFormatError('11.1', 0, 'trunSampleCount is required');
        }
        const count = result.scalar(F.TRUN_SAMPLE_COUNT);
        if (count > BigInt(MAX_SAMPLE_COUNT)) {
            throw new LocmafFormatError('12.1', 0, `trunSampleCount delta yields out-of-range count ${count}`);
        }
        const n = Number(count);
        for (const id of [F.TFHD_SAMPLE_DESCRIPTION_INDEX, F.TFHD_DEFAULT_SAMPLE_DURATION, F.TFHD_DEFAULT_SAMPLE_SIZE,
            F.TFHD_DEFAULT_SAMPLE_FLAGS, F.TRUN_FIRST_SAMPLE_FLAGS, F.SENC_PER_SAMPLE_IV_SIZE]) {
            applyScalar(id);
        }

        const applyList = (id: number, want: number, signed: boolean): void => {
            const d = delta.get(id);
            const previous = result.has(id) ? result.list(id) : undefined;
            if (d === undefined) {
                // Inherited: keep the prefix at the new length (section 12.1.1).
                if (previous === undefined) return;
                if (previous.length > want) {
                    result.set(id, { kind: 'list', values: previous.slice(0, want) });
                } else if (previous.length < want) {
                    throw new LocmafFormatError('12.1.1', 0, `inherited field ${id} has ${previous.length} elements, need ${want}`);
                }
                return;
            }
            const deltas = d.kind === 'list' ? d.values : [];
            if (deltas.length !== want) {
                throw new LocmafFormatError('12.1.1', 0, `field ${id} carries ${deltas.length} elements, expected ${want}`);
            }
            const values = deltas.map((z, i) => {
                const base = previous !== undefined && i < previous.length ? previous[i]! : 0n;
                if (signed) {
                    const sum = zigzagDecode(base) + zigzagDecode(z);
                    if (sum < -(1n << 63n) || sum >= 1n << 63n) {
                        throw new LocmafFormatError('12.1', 0, `field ${id} element ${i} overflows`);
                    }
                    return zigzagEncode(sum);
                }
                const value = base + zigzagDecode(z);
                if (value < 0n || value > MAX_VI64) {
                    throw new LocmafFormatError('12.1', 0, `field ${id} element ${i} delta yields out-of-range value ${value}`);
                }
                return value;
            });
            result.set(id, { kind: 'list', values });
        };

        applyList(F.TRUN_SAMPLE_DURATIONS, n, false);
        applyList(F.TRUN_SAMPLE_FLAGS, n, false);
        applyList(F.TRUN_SAMPLE_SIZES, Math.max(0, n - 1), false);
        applyList(F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, n, true);
        applyList(F.SENC_SUBSAMPLE_COUNT, n, false);
        let subsamples = 0;
        if (result.has(F.SENC_SUBSAMPLE_COUNT)) {
            for (const c of result.list(F.SENC_SUBSAMPLE_COUNT)) {
                if (c > U16_MAX) throw new LocmafFormatError('18', 0, `subsample count ${c} does not fit 16 bits`);
                subsamples += Number(c);
            }
        }
        applyList(F.SENC_BYTES_OF_CLEAR_DATA, subsamples, false);
        applyList(F.SENC_BYTES_OF_PROTECTED_DATA, subsamples, false);

        const iv = delta.get(F.SENC_INITIALIZATION_VECTOR);
        if (iv !== undefined) result.set(F.SENC_INITIALIZATION_VECTOR, iv);

        result.delete(F.TFDT_BASE_MEDIA_DECODE_TIME);
        return result;
    }

    /**
     * Expand represented fields plus the payload length into effective values
     * (sections 11.2, 12.2, 15.1), applying every receiver MUST-reject rule.
     */
    effectiveValues(
        r: LocmafHeader,
        payloadLength: number,
        state: LocmafGroupState,
        context: LocmafTrackContext,
        full: boolean,
    ): LocmafEffectiveSamples {
        if (!context.isProtected) {
            const cenc = r.ids().find(isCencField);
            if (cenc !== undefined) {
                throw new LocmafFormatError('10.3', 0, `CENC field ${cenc} on an unprotected track`);
            }
        }
        if (!r.has(F.TRUN_SAMPLE_COUNT)) {
            throw new LocmafFormatError('11.1', 0, 'trunSampleCount is required');
        }
        const count = r.scalar(F.TRUN_SAMPLE_COUNT);
        if (count > BigInt(MAX_SAMPLE_COUNT)) {
            throw new LocmafFormatError(full ? '11.2' : '12.1', 0, `trunSampleCount ${count} exceeds the implementation limit`);
        }
        const n = Number(count);

        let bmdt: bigint;
        if (full) {
            if (!r.has(F.TFDT_BASE_MEDIA_DECODE_TIME)) {
                throw new LocmafFormatError('11.1', 0, 'tfdtBaseMediaDecodeTime is required in a full header');
            }
            bmdt = r.scalar(F.TFDT_BASE_MEDIA_DECODE_TIME);
        } else {
            const previous = state.lastEffective;
            if (previous === null) {
                throw new LocmafFormatError('3', 0, 'delta header without an in-group reference');
            }
            bmdt = state.baseMediaDecodeTime + totalDuration(previous);
            if (bmdt > MAX_VI64) {
                throw new LocmafFormatError('12.2', 0, 'derived BMDT overflows 64 bits');
            }
        }

        const sampleDescriptionIndex = u32Scalar(r, F.TFHD_SAMPLE_DESCRIPTION_INDEX, context.defaultSampleDescriptionIndex);
        const defaultDuration = u32Scalar(r, F.TFHD_DEFAULT_SAMPLE_DURATION, context.defaultSampleDuration);
        const durations = r.has(F.TRUN_SAMPLE_DURATIONS)
            ? u32List(requireLength(r, F.TRUN_SAMPLE_DURATIONS, n), F.TRUN_SAMPLE_DURATIONS)
            : new Array<number>(n).fill(defaultDuration);

        const sizes = deriveSizes(r, n, payloadLength, context);

        const defaultFlags = u32Scalar(r, F.TFHD_DEFAULT_SAMPLE_FLAGS, context.defaultSampleFlags);
        const firstFlags = r.has(F.TRUN_FIRST_SAMPLE_FLAGS) ? u32Scalar(r, F.TRUN_FIRST_SAMPLE_FLAGS, 0) : undefined;
        let flags: number[];
        if (r.has(F.TRUN_SAMPLE_FLAGS)) {
            flags = u32List(requireLength(r, F.TRUN_SAMPLE_FLAGS, n), F.TRUN_SAMPLE_FLAGS);
        } else {
            flags = new Array<number>(n).fill(defaultFlags);
            if (n > 0 && firstFlags !== undefined) flags[0] = firstFlags;
        }

        let compositionTimeOffsets: number[] = new Array<number>(n).fill(0);
        if (r.has(F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS)) {
            const signed = requireLength(r, F.TRUN_SAMPLE_COMPOSITION_TIME_OFFSETS, n).map(zigzagDecode);
            const anyNegative = signed.some((c) => c < 0n);
            compositionTimeOffsets = signed.map((c) => {
                if (c < I32_MIN || c > (anyNegative ? I32_MAX : U32_MAX)) {
                    throw new LocmafFormatError('18', 0, `composition time offset ${c} does not fit the trun field`);
                }
                return Number(c);
            });
        }

        const cenc = context.isProtected ? cencValues(r, n, sizes, context) : null;
        return { baseMediaDecodeTime: bmdt, sampleDescriptionIndex, durations, sizes, flags, compositionTimeOffsets, cenc };
    }
}

function requireLength(r: LocmafHeader, id: number, n: number): readonly bigint[] {
    const values = r.list(id);
    if (values.length !== n) {
        throw new LocmafFormatError('10.2', 0, `field ${id} has ${values.length} elements, trunSampleCount is ${n}`);
    }
    return values;
}

function u32Scalar(r: LocmafHeader, id: number, fallback: number): number {
    if (!r.has(id)) return fallback;
    const v = r.scalar(id);
    if (v > U32_MAX) throw new LocmafFormatError('18', 0, `field ${id} value ${v} does not fit 32 bits`);
    return Number(v);
}

function u32List(values: readonly bigint[], id: number): number[] {
    return values.map((v) => {
        if (v > U32_MAX) throw new LocmafFormatError('18', 0, `field ${id} element ${v} does not fit 32 bits`);
        return Number(v);
    });
}

/**
 * Section 11.2 sample-size derivation. Zero-size samples make n > P legal, so
 * the count is bounded by {@link MAX_SAMPLE_COUNT}, not by the payload length.
 */
function deriveSizes(r: LocmafHeader, n: number, p: number, context: LocmafTrackContext): number[] {
    if (n === 0) {
        if (p !== 0) throw new LocmafFormatError('11.2', 0, 'trunSampleCount 0 with a non-empty mdat payload');
        return [];
    }
    const payload = BigInt(p);
    if (r.has(F.TRUN_SAMPLE_SIZES)) {
        const listed = r.list(F.TRUN_SAMPLE_SIZES);
        if (listed.length !== n - 1) {
            throw new LocmafFormatError('11.2', 0, `trunSampleSizes carries ${listed.length} entries, expected ${n - 1}`);
        }
        const sizes = new Array<number>(n);
        let sum = 0n;
        for (let i = 0; i < n - 1; i++) {
            sum += listed[i]!;
            if (sum > payload) throw new LocmafFormatError('11.2', 0, 'sum of listed sample sizes exceeds the mdat payload');
            sizes[i] = Number(listed[i]!);
        }
        const last = payload - sum;
        if (last > U32_MAX || sizes.some((s) => s > 0xffffffff)) {
            throw new LocmafFormatError('18', 0, 'sample size does not fit 32 bits');
        }
        sizes[n - 1] = Number(last);
        return sizes;
    }
    let uniform: bigint;
    if (r.has(F.TFHD_DEFAULT_SAMPLE_SIZE)) {
        uniform = r.scalar(F.TFHD_DEFAULT_SAMPLE_SIZE);
    } else if (n === 1) {
        uniform = payload;
    } else if (context.defaultSampleSize !== 0) {
        uniform = BigInt(context.defaultSampleSize);
    } else if (p === 0) {
        uniform = 0n;
    } else {
        throw new LocmafFormatError('11.2', 0, `no sample size source for ${n} samples`);
    }
    if (uniform * BigInt(n) !== payload) {
        throw new LocmafFormatError('11.2', 0, `${n} x ${uniform} != payload length ${p}`);
    }
    if (uniform > U32_MAX) throw new LocmafFormatError('18', 0, 'sample size does not fit 32 bits');
    return new Array<number>(n).fill(Number(uniform));
}

/** CENC effective values for a protected track (sections 10.2, 13, 15.8, 18). */
function cencValues(r: LocmafHeader, n: number, sizes: readonly number[], context: LocmafTrackContext): LocmafCencSamples | null {
    const ivSizeValue = r.has(F.SENC_PER_SAMPLE_IV_SIZE) ? r.scalar(F.SENC_PER_SAMPLE_IV_SIZE) : BigInt(context.perSampleIvSize);
    if (ivSizeValue !== 0n && ivSizeValue !== 8n && ivSizeValue !== 16n) {
        throw new LocmafFormatError('10.2', 0, `sencPerSampleIVSize must be 0, 8 or 16, got ${ivSizeValue}`);
    }
    const ivSize = Number(ivSizeValue);
    const ivs = r.has(F.SENC_INITIALIZATION_VECTOR) ? r.bytes(F.SENC_INITIALIZATION_VECTOR) : new Uint8Array(0);
    if (ivSize > 0 && ivs.length !== ivSize * n) {
        throw new LocmafFormatError('10.2', 0, `sencInitializationVector length ${ivs.length} != ${ivSize} x ${n}`);
    }
    if (ivSize === 0 && ivs.length > 0) {
        throw new LocmafFormatError('10.2', 0, 'sencInitializationVector present with per-sample IV size 0');
    }

    let subsampleCounts: number[] | null = null;
    let clearBytes: number[] | null = null;
    let protectedBytes: number[] | null = null;
    if (r.has(F.SENC_SUBSAMPLE_COUNT)) {
        subsampleCounts = requireLength(r, F.SENC_SUBSAMPLE_COUNT, n).map((c) => {
            if (c > U16_MAX) throw new LocmafFormatError('18', 0, `subsample count ${c} does not fit 16 bits`);
            return Number(c);
        });
        const total = subsampleCounts.reduce((a, b) => a + b, 0);
        const clear = r.has(F.SENC_BYTES_OF_CLEAR_DATA) ? r.list(F.SENC_BYTES_OF_CLEAR_DATA) : [];
        const prot = r.has(F.SENC_BYTES_OF_PROTECTED_DATA) ? r.list(F.SENC_BYTES_OF_PROTECTED_DATA) : [];
        if (clear.length !== total || prot.length !== total) {
            throw new LocmafFormatError('10.2', 0, `subsample lists (${clear.length}, ${prot.length}) must total ${total} entries`);
        }
        clearBytes = clear.map((v) => {
            if (v > U16_MAX) throw new LocmafFormatError('18', 0, `BytesOfClearData ${v} does not fit 16 bits`);
            return Number(v);
        });
        protectedBytes = prot.map((v) => {
            if (v > U32_MAX) throw new LocmafFormatError('18', 0, `BytesOfProtectedData ${v} does not fit 32 bits`);
            return Number(v);
        });
        let cursor = 0;
        for (let i = 0; i < n; i++) {
            const c = subsampleCounts[i]!;
            if (c === 0) continue;
            let sum = 0;
            for (let j = 0; j < c; j++, cursor++) sum += clearBytes[cursor]! + protectedBytes[cursor]!;
            if (sum !== sizes[i]) {
                throw new LocmafFormatError('18', 0, `subsample bytes sum to ${sum} for sample ${i} of size ${sizes[i]}`);
            }
            if (ivSize + 2 + 6 * c > 255) {
                throw new LocmafFormatError('15.8', 0, `auxiliary info size ${ivSize + 2 + 6 * c} exceeds 255`);
            }
        }
    } else if (r.has(F.SENC_BYTES_OF_CLEAR_DATA) || r.has(F.SENC_BYTES_OF_PROTECTED_DATA)) {
        throw new LocmafFormatError('10.2', 0, 'subsample byte lists without subsample counts');
    }
    if (ivSize === 0 && subsampleCounts === null) return null;
    return { perSampleIvSize: ivSize, ivs, subsampleCounts, clearBytes, protectedBytes };
}

/**
 * Build the canonical chunk (sections 15.2 to 15.8): each genBox wrapped
 * verbatim, then moof { mfhd, traf { tfhd, tfdt, trun [, saiz, saio, senc] } },
 * then mdat. Presence decisions follow the effective values only.
 *
 * @throws {LocmafFormatError} when a box would not fit its size fields.
 */
export function buildCanonicalChunk(
    genBoxes: readonly GenBox[],
    e: LocmafEffectiveSamples,
    mdat: Uint8Array,
    context: LocmafTrackContext,
): Uint8Array {
    const n = e.durations.length;
    if (e.sizes.length !== n || e.flags.length !== n || e.compositionTimeOffsets.length !== n) {
        throw new LocmafFormatError('15.1', 0, 'effective per-sample vectors disagree on the sample count');
    }
    if (mdat.length > 0xfffffff7) {
        throw new LocmafFormatError('15.7', 0, 'mdat payload does not fit a 32-bit box size');
    }

    // tfhd (15.4): no optional default for an event-only chunk (15.6).
    const sdiPresent = n > 0 && e.sampleDescriptionIndex !== context.defaultSampleDescriptionIndex;
    const uniformDuration = n > 0 && allEqual(e.durations);
    const durationPresent = uniformDuration && e.durations[0] !== context.defaultSampleDuration;
    const uniformSize = n > 0 && allEqual(e.sizes);
    const sizePresent = uniformSize && e.sizes[0] !== context.defaultSampleSize;
    const firstFlags = n > 1 && equalExceptFirst(e.flags);
    const perSampleFlags = n > 0 && !allEqual(e.flags) && !firstFlags;
    const coveredFlags = firstFlags ? e.flags[1]! : (e.flags[0] ?? 0);
    const flagsPresent = n > 0 && !perSampleFlags && coveredFlags !== context.defaultSampleFlags;

    // trun (15.6).
    const trunDuration = n > 0 && !uniformDuration;
    const trunSize = n > 0 && !uniformSize;
    const trunCto = e.compositionTimeOffsets.some((c) => c !== 0);
    const trunVersion = e.compositionTimeOffsets.some((c) => c < 0) ? 1 : 0;
    let trFlags = 0x000001;
    if (firstFlags) trFlags |= 0x000004;
    if (trunDuration) trFlags |= 0x000100;
    if (trunSize) trFlags |= 0x000200;
    if (perSampleFlags) trFlags |= 0x000400;
    if (trunCto) trFlags |= 0x000800;
    const perSampleFields = [trunDuration, trunSize, perSampleFlags, trunCto].filter(Boolean).length;

    const tfhdSize = 16 + 4 * [sdiPresent, durationPresent, sizePresent, flagsPresent].filter(Boolean).length;
    const tfdtSize = 20;
    const trunSizeBytes = 20 + (firstFlags ? 4 : 0) + n * 4 * perSampleFields;

    // CENC (15.8).
    const c = e.cenc;
    let auxSizes: number[] = [];
    let auxEqual = true;
    let saizSize = 0;
    let sencSize = 0;
    const saioSize = c ? 20 : 0;
    if (c) {
        auxSizes = new Array<number>(n);
        for (let i = 0; i < n; i++) {
            const aux = c.perSampleIvSize + (c.subsampleCounts ? 2 + 6 * c.subsampleCounts[i]! : 0);
            if (aux > 255) throw new LocmafFormatError('15.8', 0, `auxiliary info size ${aux} exceeds 255`);
            auxSizes[i] = aux;
        }
        auxEqual = allEqual(auxSizes);
        saizSize = 17 + (auxEqual ? 0 : n);
        sencSize = 16 + auxSizes.reduce((a, b) => a + b, 0);
    }
    const trafSize = 8 + tfhdSize + tfdtSize + trunSizeBytes + saizSize + saioSize + sencSize;
    const moofSize = 8 + 16 + trafSize;
    if (moofSize + 8 > 0x7fffffff) {
        throw new LocmafFormatError('15.7', 0, `moof size ${moofSize} overflows trun.data_offset`);
    }

    let total = moofSize + 8 + mdat.length;
    for (const box of genBoxes) {
        if (box.type.length !== 4) throw new LocmafFormatError('8.1', 0, `genBox type "${box.type}" is not a FourCC`);
        if (box.payload.length + 8 > 0xffffffff) throw new LocmafFormatError('8.3', 0, `genBox ${box.type} exceeds a 32-bit box size`);
        total += 8 + box.payload.length;
    }
    const w = new ByteWriter(total);

    for (const box of genBoxes) {
        w.u32(8 + box.payload.length);
        w.fourcc(box.type);
        w.bytes(box.payload);
    }

    w.u32(moofSize);
    w.fourcc('moof');
    w.u32(16);
    w.fourcc('mfhd');
    w.u32(0);
    w.u32(0); // sequence_number = 0 (15.3)

    w.u32(trafSize);
    w.fourcc('traf');

    let tfFlags = 0x020000;
    if (sdiPresent) tfFlags |= 0x000002;
    if (durationPresent) tfFlags |= 0x000008;
    if (sizePresent) tfFlags |= 0x000010;
    if (flagsPresent) tfFlags |= 0x000020;
    w.u32(tfhdSize);
    w.fourcc('tfhd');
    w.u32(tfFlags);
    w.u32(context.trackId);
    if (sdiPresent) w.u32(e.sampleDescriptionIndex);
    if (durationPresent) w.u32(e.durations[0]!);
    if (sizePresent) w.u32(e.sizes[0]!);
    if (flagsPresent) w.u32(coveredFlags);

    w.u32(tfdtSize);
    w.fourcc('tfdt');
    w.u32(0x01000000); // version 1 (15.5)
    w.u64(e.baseMediaDecodeTime);

    w.u32(trunSizeBytes);
    w.fourcc('trun');
    w.u32(((trunVersion << 24) | trFlags) >>> 0);
    w.u32(n);
    w.u32(moofSize + 8); // data_offset (15.7)
    if (firstFlags) w.u32(e.flags[0]!);
    for (let i = 0; i < n; i++) {
        if (trunDuration) w.u32(e.durations[i]!);
        if (trunSize) w.u32(e.sizes[i]!);
        if (perSampleFlags) w.u32(e.flags[i]!);
        if (trunCto) {
            if (trunVersion === 1) w.i32(e.compositionTimeOffsets[i]!);
            else w.u32(e.compositionTimeOffsets[i]!);
        }
    }

    if (c) {
        w.u32(saizSize);
        w.fourcc('saiz');
        w.u32(0);
        w.u8(auxEqual && n > 0 ? auxSizes[0]! : 0);
        w.u32(n);
        if (!auxEqual) for (const s of auxSizes) w.u8(s);

        const sencOffset = 8 + 16 + 8 + tfhdSize + tfdtSize + trunSizeBytes + saizSize + saioSize;
        w.u32(saioSize);
        w.fourcc('saio');
        w.u32(0);
        w.u32(1);
        w.u32(sencOffset + 16);

        w.u32(sencSize);
        w.fourcc('senc');
        w.u32(c.subsampleCounts ? 0x000002 : 0);
        w.u32(n);
        let cursor = 0;
        for (let i = 0; i < n; i++) {
            if (c.perSampleIvSize > 0) w.bytes(c.ivs.subarray(i * c.perSampleIvSize, (i + 1) * c.perSampleIvSize));
            if (c.subsampleCounts) {
                const count = c.subsampleCounts[i]!;
                w.u16(count);
                for (let j = 0; j < count; j++, cursor++) {
                    w.u16(c.clearBytes![cursor]!);
                    w.u32(c.protectedBytes![cursor]!);
                }
            }
        }
    }

    w.u32(8 + mdat.length);
    w.fourcc('mdat');
    w.bytes(mdat);
    return w.finish();
}
