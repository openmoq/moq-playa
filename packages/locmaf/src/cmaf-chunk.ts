/**
 * Source CMAF chunk reader for the encoder: splits a chunk into genBoxes, moof
 * and mdat, decides whether it fits the LOCMAF field model, and derives its
 * effective values.
 *
 * @see draft-einarsson-moq-locmaf-01 sections 4.1, 8, 9 (verbatim fallback),
 *   11.1 (effective values: trun value, else tfhd default, else trex default)
 * @module
 */

import type { LocmafCencSamples, LocmafEffectiveSamples } from './effective.js';
import { LocmafFormatError } from './errors.js';
import { childBoxes, viewOf, type IsoBoxHeader } from './iso-box.js';
import type { GenBox } from './model.js';
import { MAX_SAMPLE_COUNT } from './reconstruct.js';
import type { LocmafTrackContext } from './track-context.js';

/** Result of reading a source CMAF chunk. */
export type CmafChunkParse =
    | {
          readonly fits: true;
          /** Boxes before the moof, as genBoxes (payload is a subarray of the chunk). */
          readonly genBoxes: readonly GenBox[];
          readonly effective: LocmafEffectiveSamples;
          /** The mdat payload (a subarray of the chunk). */
          readonly mdat: Uint8Array;
          /** per_sample_IV_size of the chunk's senc, or null when it has none. */
          readonly sencPerSampleIvSize: number | null;
      }
    | {
          /** The chunk falls outside the field model and must ride as rawBoxes. */
          readonly fits: false;
          readonly reason: string;
      };

const S = '11';

function outside(reason: string): CmafChunkParse {
    return { fits: false, reason };
}

/**
 * Read a source CMAF chunk.
 * @throws {LocmafFormatError} (section 11) when a box inside the moof is truncated
 *   or its fields are inconsistent with its size.
 */
export function parseCmafChunk(chunk: Uint8Array, context: LocmafTrackContext): CmafChunkParse {
    const view = viewOf(chunk);
    const top = childBoxes(chunk, 0, chunk.length, S);
    const moofs = top.filter((b) => b.type === 'moof');
    if (moofs.length !== 1) return outside(`chunk has ${moofs.length} moof boxes`);
    const moofIndex = top.indexOf(moofs[0]!);
    const moof = moofs[0]!;
    const escaped = (b: IsoBoxHeader): boolean => b.headerSize !== 8 || view.getUint32(b.start) === 0;

    const genBoxes: GenBox[] = [];
    for (const box of top.slice(0, moofIndex)) {
        if (box.type === 'mdat' || escaped(box)) return outside(`pre-moof box '${box.type}' cannot be a genBox`);
        genBoxes.push({ type: box.type, payload: chunk.subarray(box.contentStart, box.end) });
    }
    const mdat = top[moofIndex + 1];
    if (mdat?.type !== 'mdat' || escaped(mdat)) return outside('moof is not followed by a 32-bit mdat');
    if (moofIndex + 2 !== top.length) return outside('boxes follow the mdat');
    if (escaped(moof)) return outside('moof uses a size escape');

    const moofChildren = childBoxes(chunk, moof.contentStart, moof.end, S);
    if (moofChildren.some((b) => b.type !== 'mfhd' && b.type !== 'traf')) return outside('moof carries boxes outside the field model');
    const trafs = moofChildren.filter((b) => b.type === 'traf');
    if (trafs.length !== 1) return outside(`moof has ${trafs.length} traf boxes`);
    const traf = trafs[0]!;

    const children = childBoxes(chunk, traf.contentStart, traf.end, S);
    const allowed = new Set(['tfhd', 'tfdt', 'trun', 'senc', 'saiz', 'saio']);
    const seen = new Map<string, IsoBoxHeader>();
    for (const child of children) {
        if (!allowed.has(child.type)) return outside(`traf child '${child.type}' is outside the field model`);
        if (seen.has(child.type)) return outside(`traf has more than one '${child.type}'`);
        seen.set(child.type, child);
    }
    const tfhd = seen.get('tfhd');
    const tfdt = seen.get('tfdt');
    const trun = seen.get('trun');
    if (tfhd === undefined || trun === undefined) throw new LocmafFormatError(S, traf.start, 'traf lacks tfhd or trun');
    if (tfdt === undefined) return outside('traf has no tfdt');

    // tfhd
    const need = (box: IsoBoxHeader, bytes: number): void => {
        if (box.end - box.contentStart < bytes) {
            throw new LocmafFormatError(S, box.start, `'${box.type}' box too short for its fields`);
        }
    };
    need(tfhd, 8);
    const tfFlags = view.getUint32(tfhd.contentStart) & 0xffffff;
    if (tfFlags & 0x000001) return outside('tfhd uses base-data-offset');
    if (view.getUint32(tfhd.contentStart + 4) !== context.trackId) return outside('tfhd track_ID differs from the CMAF Header');
    let p = tfhd.contentStart + 8;
    const tfhdField = (bit: number): number | undefined => {
        if (!(tfFlags & bit)) return undefined;
        if (p + 4 > tfhd.end) throw new LocmafFormatError(S, tfhd.start, 'tfhd truncated');
        const v = view.getUint32(p);
        p += 4;
        return v;
    };
    const sampleDescriptionIndex = tfhdField(0x02) ?? context.defaultSampleDescriptionIndex;
    const defaultDuration = tfhdField(0x08) ?? context.defaultSampleDuration;
    const defaultSize = tfhdField(0x10) ?? context.defaultSampleSize;
    const defaultFlags = tfhdField(0x20) ?? context.defaultSampleFlags;

    // tfdt
    need(tfdt, 8);
    const tfdtV1 = chunk[tfdt.contentStart] === 1;
    if (tfdtV1) need(tfdt, 12);
    const bmdt = tfdtV1 ? view.getBigUint64(tfdt.contentStart + 4) : BigInt(view.getUint32(tfdt.contentStart + 4));

    // trun
    need(trun, 8);
    const trVersion = chunk[trun.contentStart]!;
    const trFlags = view.getUint32(trun.contentStart) & 0xffffff;
    const n = view.getUint32(trun.contentStart + 4);
    if (n > MAX_SAMPLE_COUNT) throw new LocmafFormatError(S, trun.start, `trun sample_count ${n} exceeds the implementation limit`);
    const perSample = [0x100, 0x200, 0x400, 0x800].filter((bit) => trFlags & bit).length * 4;
    const fixed = 8 + (trFlags & 0x001 ? 4 : 0) + (trFlags & 0x004 ? 4 : 0);
    if (fixed + n * perSample > trun.end - trun.contentStart) {
        throw new LocmafFormatError(S, trun.start, `trun declares ${n} samples but is too short to carry them`);
    }
    let q = trun.contentStart + 8;
    if (!(trFlags & 0x001)) return outside('trun has no data_offset');
    const dataOffset = view.getInt32(q);
    q += 4;
    if (dataOffset !== moof.size + 8) return outside('trun data_offset does not point at the mdat payload');
    let firstFlags: number | undefined;
    if (trFlags & 0x004) {
        firstFlags = view.getUint32(q);
        q += 4;
    }
    const durations = new Array<number>(n);
    const sizes = new Array<number>(n);
    const flags = new Array<number>(n);
    const compositionTimeOffsets = new Array<number>(n);
    for (let i = 0; i < n; i++) {
        durations[i] = trFlags & 0x100 ? view.getUint32((q += 4) - 4) : defaultDuration;
        sizes[i] = trFlags & 0x200 ? view.getUint32((q += 4) - 4) : defaultSize;
        if (trFlags & 0x400) flags[i] = view.getUint32((q += 4) - 4);
        else flags[i] = i === 0 && firstFlags !== undefined ? firstFlags : defaultFlags;
        if (trFlags & 0x800) compositionTimeOffsets[i] = trVersion === 0 ? view.getUint32((q += 4) - 4) : view.getInt32((q += 4) - 4);
        else compositionTimeOffsets[i] = 0;
    }
    if (compositionTimeOffsets.some((c) => c < 0) && compositionTimeOffsets.some((c) => c > 0x7fffffff)) {
        return outside('composition time offsets span both signed and unsigned ranges');
    }

    const payload = chunk.subarray(mdat.contentStart, mdat.end);
    const sizeSum = sizes.reduce((a, b) => a + b, 0);
    if (sizeSum !== payload.length) return outside(`sample sizes sum to ${sizeSum} but the mdat payload is ${payload.length} bytes`);

    // CENC
    let cenc: LocmafCencSamples | null = null;
    let sencPerSampleIvSize: number | null = null;
    const senc = seen.get('senc');
    if (senc === undefined) {
        if (context.isProtected && context.perSampleIvSize > 0 && n > 0) {
            return outside('protected track with a per-sample IV size but no senc');
        }
    } else {
        const parsed = parseSenc(chunk, senc, n, sizes, context);
        if (!parsed.fits) return outside(parsed.reason);
        sencPerSampleIvSize = parsed.ivSize;
        if (parsed.cenc !== null && !context.isProtected) return outside('CENC auxiliary data on an unprotected track');
        cenc = parsed.cenc;
    }

    const effective: LocmafEffectiveSamples = {
        baseMediaDecodeTime: bmdt,
        sampleDescriptionIndex,
        durations,
        sizes,
        flags,
        compositionTimeOffsets,
        cenc,
    };
    return { fits: true, genBoxes, effective, mdat: payload, sencPerSampleIvSize };
}

type SencParse =
    | { readonly fits: true; readonly ivSize: number; readonly cenc: LocmafCencSamples | null }
    | { readonly fits: false; readonly reason: string };

/**
 * Parse senc. Its per-sample IV size is not self-describing: try the tenc
 * default first, then 8, 16 and 0, and keep the one that tiles the box exactly.
 */
function parseSenc(buf: Uint8Array, senc: IsoBoxHeader, n: number, sizes: readonly number[], context: LocmafTrackContext): SencParse {
    const view = viewOf(buf);
    if (senc.end - senc.contentStart < 8) throw new LocmafFormatError(S, senc.start, 'senc box too short');
    const flags = view.getUint32(senc.contentStart) & 0xffffff;
    if (flags & 0x000001) return { fits: false, reason: 'senc overrides track encryption parameters' };
    const useSubsamples = (flags & 0x000002) !== 0;
    const count = view.getUint32(senc.contentStart + 4);
    if (count !== n) return { fits: false, reason: `senc has ${count} samples for ${n} trun samples` };
    const start = senc.contentStart + 8;

    const candidates = [...new Set([context.perSampleIvSize, 8, 16, 0])];
    for (const ivSize of candidates) {
        let pos = start;
        const counts: number[] = [];
        const clear: number[] = [];
        const prot: number[] = [];
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
            pos += ivSize;
            if (!useSubsamples) {
                if (pos > senc.end) ok = false;
                continue;
            }
            if (pos + 2 > senc.end) { ok = false; break; }
            const c = view.getUint16(pos);
            pos += 2;
            if (pos + 6 * c > senc.end) { ok = false; break; }
            counts.push(c);
            for (let j = 0; j < c; j++, pos += 6) {
                clear.push(view.getUint16(pos));
                prot.push(view.getUint32(pos + 2));
            }
        }
        if (!ok || pos !== senc.end) continue;

        const ivs = new Uint8Array(ivSize * n);
        for (let i = 0; i < n; i++) {
            const at = start + i * ivSize + (useSubsamples ? offsetOfSample(counts, i) : 0);
            ivs.set(buf.subarray(at, at + ivSize), i * ivSize);
        }
        if (useSubsamples) {
            let cursor = 0;
            for (let i = 0; i < n; i++) {
                const c = counts[i]!;
                if (ivSize + 2 + 6 * c > 255) return { fits: false, reason: 'senc auxiliary info exceeds 255 bytes' };
                if (c === 0) continue;
                let sum = 0;
                for (let j = 0; j < c; j++, cursor++) sum += clear[cursor]! + prot[cursor]!;
                if (sum !== sizes[i]) return { fits: false, reason: `senc subsamples do not cover sample ${i}` };
            }
        }
        const cenc = ivSize === 0 && !useSubsamples
            ? null
            : {
                perSampleIvSize: ivSize,
                ivs,
                subsampleCounts: useSubsamples ? counts : null,
                clearBytes: useSubsamples ? clear : null,
                protectedBytes: useSubsamples ? prot : null,
            };
        return { fits: true, ivSize, cenc };
    }
    throw new LocmafFormatError(S, senc.start, 'senc does not parse with any per-sample IV size');
}

/** Bytes of subsample data (count fields and entries) preceding sample i's IV. */
function offsetOfSample(counts: readonly number[], i: number): number {
    let bytes = 0;
    for (let k = 0; k < i; k++) bytes += 2 + 6 * counts[k]!;
    return bytes;
}

/**
 * Effective values of a source CMAF chunk (section 11.1).
 * @throws {LocmafFormatError} (section 11) when the chunk is malformed or falls
 *   outside the LOCMAF field model.
 */
export function extractEffectiveSamples(chunk: Uint8Array, context: LocmafTrackContext): LocmafEffectiveSamples {
    const parsed = parseCmafChunk(chunk, context);
    if (!parsed.fits) throw new LocmafFormatError(S, 0, parsed.reason);
    return parsed.effective;
}
