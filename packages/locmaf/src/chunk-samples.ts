/**
 * Lenient sample reader for a verbatim CMAF chunk on the frame path.
 *
 * {@link parseCmafChunk} answers an encoder question: does this chunk fit the
 * LOCMAF field model? A rawBoxes Object (section 9) carries a chunk precisely
 * because it may not, yet its samples are still decodable. This reader answers
 * the frame interface's question instead (section 16): which samples does the
 * chunk carry, where are their bytes, and when do they decode. It accepts
 * base-data-offset and default-base-is-moof, several truns, truns without a
 * data_offset, traf children outside the field model, several trafs (the one
 * whose tfhd.track_ID is the CMAF Header's track is used), boxes after the
 * mdat, and any 32-bit or largesize pre-moof box as a genBox.
 *
 * It still binds the chunk to the track and the samples to the mdat: the traf
 * must carry the CMAF Header's track_ID even when it is the only traf (section
 * 6: a LOCMAF track carries one CMAF track), and every nonempty sample must lie
 * wholly within the payload of an mdat that follows the moof (ISO 8.8.8: the
 * data_offset points at sample data; MSE ISOBMFF byte stream format, media
 * segments). Sample runs may not total more bytes than the mdat payloads carry,
 * which bounds the gathered copy by the chunk size. FullBox versions the
 * reader does not implement (tfhd other than 0; tfdt or trun other than 0/1)
 * are rejected rather than read with another version's layout.
 *
 * @see ISO/IEC 14496-12 sections 8.8.7 (tfhd), 8.8.8 (trun), 8.8.12 (tfdt)
 * @module
 */

import type { LocmafEffectiveSamples } from './effective.js';
import { LocmafFormatError } from './errors.js';
import { childBoxes, viewOf, type IsoBoxHeader } from './iso-box.js';
import type { GenBox } from './model.js';
import { MAX_SAMPLE_COUNT } from './reconstruct.js';
import type { LocmafTrackContext } from './track-context.js';

/** The samples of a verbatim chunk, in the shape the frame slicer consumes. */
export interface CmafChunkSamples {
    /** Boxes before the moof, as genBoxes (payload is a subarray of the chunk). */
    readonly genBoxes: readonly GenBox[];
    /** Per-sample values; `cenc` is always null (the frame path does not decrypt). */
    readonly effective: LocmafEffectiveSamples;
    /** The bytes of every sample in trun order, tiling `effective.sizes`. */
    readonly mdat: Uint8Array;
}

const S = '16';

/**
 * Read the samples of a verbatim CMAF chunk.
 * @throws {LocmafFormatError} when the chunk has no single moof, no mdat after
 *   it, no traf whose tfhd.track_ID is the CMAF Header's track, more than one
 *   tfhd or tfdt in that traf, no tfdt, a truncated box, a nonempty sample
 *   outside every mdat payload, or sample runs totalling more bytes than the
 *   mdat payloads carry, or a tfhd, tfdt or trun of an unimplemented version.
 */
export function readCmafChunkSamples(chunk: Uint8Array, context: LocmafTrackContext): CmafChunkSamples {
    const view = viewOf(chunk);
    const top = childBoxes(chunk, 0, chunk.length, S);
    const moofs = top.filter((b) => b.type === 'moof');
    if (moofs.length !== 1) throw new LocmafFormatError(S, 0, `chunk has ${moofs.length} moof boxes`);
    const moof = moofs[0]!;
    const moofIndex = top.indexOf(moof);
    // Sample data lives in an mdat after the moof: those payloads are the only
    // byte ranges a sample may occupy. Top-level boxes tile the chunk, so the
    // list is in ascending order and disjoint, which `within` relies on.
    const mdatPayloads = top.slice(moofIndex + 1).filter((b) => b.type === 'mdat').map((b) => [b.contentStart, b.end] as const);
    if (mdatPayloads.length === 0) throw new LocmafFormatError(S, moof.end, 'no mdat follows the moof');
    const mdatBytes = mdatPayloads.reduce((n, [s, e]) => n + (e - s), 0);

    const genBoxes: GenBox[] = [];
    for (const box of top.slice(0, moofIndex)) {
        // Section 8.1: the payload is what follows the size + type header, so a
        // uuid box's usertype leads its payload. A largesize header is 16 bytes.
        const headerBytes = view.getUint32(box.start) === 1 ? 16 : 8;
        genBoxes.push({ type: box.type, payload: chunk.subarray(box.start + headerBytes, box.end) });
    }

    const traf = selectTraf(chunk, moof, context);
    const children = childBoxes(chunk, traf.contentStart, traf.end, S);
    const tfhds = children.filter((b) => b.type === 'tfhd');
    const tfdts = children.filter((b) => b.type === 'tfdt');
    const truns = children.filter((b) => b.type === 'trun');
    // CMAF needs a tfhd and tfdt to place the samples. Reject duplicate headers
    // rather than choosing which one governs the run.
    if (tfhds.length !== 1) throw new LocmafFormatError(S, traf.start, `traf has ${tfhds.length} tfhd boxes`);
    if (tfdts.length === 0) throw new LocmafFormatError(S, traf.start, 'traf has no tfdt: samples cannot be placed in time');
    if (tfdts.length > 1) throw new LocmafFormatError(S, traf.start, `traf has ${tfdts.length} tfdt boxes`);
    const tfhd = tfhds[0]!;
    const tfdt = tfdts[0]!;

    const need = (box: IsoBoxHeader, bytes: number): void => {
        if (box.end - box.contentStart < bytes) throw new LocmafFormatError(S, box.start, `'${box.type}' box too short for its fields`);
    };
    const supportedVersion = (box: IsoBoxHeader, supported: readonly number[]): number => {
        const version = chunk[box.contentStart]!;
        if (!supported.includes(version)) {
            throw new LocmafFormatError(S, box.start, `'${box.type}' version ${version} is not implemented by this reader`);
        }
        return version;
    };

    // tfhd (ISO 8.8.7)
    need(tfhd, 8);
    supportedVersion(tfhd, [0]);
    const tfFlags = view.getUint32(tfhd.contentStart) & 0xffffff;
    let p = tfhd.contentStart + 8;
    let base = moof.start;
    if (tfFlags & 0x000001) {
        need(tfhd, 16);
        const bdo = view.getBigUint64(p);
        p += 8;
        if (bdo > BigInt(chunk.length)) throw new LocmafFormatError(S, tfhd.start, 'base_data_offset lies outside the chunk');
        base = Number(bdo);
    }
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

    // tfdt (ISO 8.8.12)
    need(tfdt, 8);
    const tfdtV1 = supportedVersion(tfdt, [0, 1]) === 1;
    if (tfdtV1) need(tfdt, 12);
    const baseMediaDecodeTime = tfdtV1 ? view.getBigUint64(tfdt.contentStart + 4) : BigInt(view.getUint32(tfdt.contentStart + 4));

    // truns (ISO 8.8.8), concatenated in order
    const durations: number[] = [];
    const sizes: number[] = [];
    const flags: number[] = [];
    const compositionTimeOffsets: number[] = [];
    const ranges: Array<readonly [number, number]> = [];
    let cursor = base;
    let sampleBytes = 0;
    for (const trun of truns) {
        need(trun, 8);
        const version = supportedVersion(trun, [0, 1]);
        const trFlags = view.getUint32(trun.contentStart) & 0xffffff;
        const n = view.getUint32(trun.contentStart + 4);
        if (durations.length + n > MAX_SAMPLE_COUNT) {
            throw new LocmafFormatError(S, trun.start, `trun sample_count ${n} exceeds the implementation limit`);
        }
        const perSample = [0x100, 0x200, 0x400, 0x800].filter((bit) => trFlags & bit).length * 4;
        const fixed = 8 + (trFlags & 0x001 ? 4 : 0) + (trFlags & 0x004 ? 4 : 0);
        if (fixed + n * perSample > trun.end - trun.contentStart) {
            throw new LocmafFormatError(S, trun.start, `trun declares ${n} samples but is too short to carry them`);
        }
        let q = trun.contentStart + 8;
        if (trFlags & 0x001) {
            cursor = base + view.getInt32(q);
            q += 4;
        }
        let firstFlags: number | undefined;
        if (trFlags & 0x004) {
            firstFlags = view.getUint32(q);
            q += 4;
        }
        for (let i = 0; i < n; i++) {
            const duration = trFlags & 0x100 ? view.getUint32((q += 4) - 4) : defaultDuration;
            const size = trFlags & 0x200 ? view.getUint32((q += 4) - 4) : defaultSize;
            const f = trFlags & 0x400 ? view.getUint32((q += 4) - 4) : i === 0 && firstFlags !== undefined ? firstFlags : defaultFlags;
            const cto = trFlags & 0x800 ? (version === 0 ? view.getUint32((q += 4) - 4) : view.getInt32((q += 4) - 4)) : 0;
            // A nonempty sample must lie wholly within one mdat payload: not in
            // the moof, an mdat header, a trailing box, or across the mdat's end.
            // An empty sample occupies no bytes and has no position to check.
            if (size > 0 && !within(mdatPayloads, cursor, cursor + size)) {
                throw new LocmafFormatError(S, trun.start, `sample ${durations.length} lies outside the mdat payload`);
            }
            // Runs that revisit the same bytes would make the gathered copy
            // larger than the chunk; bound it by what the mdat payloads carry.
            sampleBytes += size;
            if (sampleBytes > mdatBytes) {
                throw new LocmafFormatError(S, trun.start, `samples total more than the ${mdatBytes} bytes the mdat payload carries`);
            }
            durations.push(duration);
            sizes.push(size);
            flags.push(f);
            compositionTimeOffsets.push(cto);
            ranges.push([cursor, cursor + size]);
            cursor += size;
        }
    }

    return {
        genBoxes,
        effective: { baseMediaDecodeTime, sampleDescriptionIndex, durations, sizes, flags, compositionTimeOffsets, cenc: null },
        mdat: gather(chunk, ranges),
    };
}

/**
 * The traf whose tfhd.track_ID is the CMAF Header's track. A lone traf for
 * another track is not reinterpreted as this track's: its samples belong to a
 * track the Header did not initialize. ISO 8.8.4 allows several trafs per
 * track in one moof; this reader represents one tfdt origin per chunk and
 * fails explicitly on two trafs for the track rather than guessing how to
 * combine their decode times.
 */
function selectTraf(chunk: Uint8Array, moof: IsoBoxHeader, context: LocmafTrackContext): IsoBoxHeader {
    const view = viewOf(chunk);
    const trafs = childBoxes(chunk, moof.contentStart, moof.end, S).filter((b) => b.type === 'traf');
    if (trafs.length === 0) throw new LocmafFormatError(S, moof.start, 'moof has no traf');
    const matching: IsoBoxHeader[] = [];
    const ids: number[] = [];
    for (const traf of trafs) {
        const tfhds = childBoxes(chunk, traf.contentStart, traf.end, S).filter((b) => b.type === 'tfhd');
        if (tfhds.length !== 1) throw new LocmafFormatError(S, traf.start, `traf has ${tfhds.length} tfhd boxes`);
        const tfhd = tfhds[0]!;
        if (tfhd.end - tfhd.contentStart < 8) throw new LocmafFormatError(S, tfhd.start, `'tfhd' box too short for its fields`);
        const id = view.getUint32(tfhd.contentStart + 4);
        ids.push(id);
        if (id === context.trackId) matching.push(traf);
    }
    if (matching.length === 1) return matching[0]!;
    if (matching.length === 0) {
        throw new LocmafFormatError(S, moof.start,
            `no traf carries track_ID ${context.trackId} of the CMAF Header (moof has track_ID ${ids.join(', ')})`);
    }
    throw new LocmafFormatError(S, moof.start, `moof has ${matching.length} trafs for track_ID ${context.trackId}`);
}

/**
 * Whether `[start, end)` lies within one of `intervals`, which are ascending
 * and disjoint. Binary search on the interval containing `start`, so the cost
 * per sample is logarithmic in the number of mdats. Exact end boundaries are
 * inside; an empty interval contains nothing.
 */
function within(intervals: ReadonlyArray<readonly [number, number]>, start: number, end: number): boolean {
    let lo = 0;
    let hi = intervals.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const [s, e] = intervals[mid]!;
        if (start < s) hi = mid - 1;
        else if (start >= e) lo = mid + 1;
        else return end <= e;
    }
    return false;
}

/** The sample bytes in order: a subarray when contiguous, otherwise a copy. */
function gather(chunk: Uint8Array, ranges: ReadonlyArray<readonly [number, number]>): Uint8Array {
    if (ranges.length === 0) return chunk.subarray(0, 0);
    let contiguous = true;
    for (let i = 1; i < ranges.length && contiguous; i++) contiguous = ranges[i]![0] === ranges[i - 1]![1];
    if (contiguous) return chunk.subarray(ranges[0]![0], ranges[ranges.length - 1]![1]);
    const out = new Uint8Array(ranges.reduce((n, [s, e]) => n + (e - s), 0));
    let pos = 0;
    for (const [s, e] of ranges) {
        out.set(chunk.subarray(s, e), pos);
        pos += e - s;
    }
    return out;
}
