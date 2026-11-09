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
import type { LocmafReadBudget } from './read-budget.js';

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

// Entry allowances count logical records/slots, not exact JS heap bytes:
// ISO headers and child slots, moof indices, genBox records/slots, range
// endpoints/slots, four sample-vector slots, and chunk result records/slots.
// Only a noncontiguous gather claims bytes; borrowed sample views do not.

/**
 * Read successive complete CMAF chunks carried by one MOQT Object (CMSF §3.3).
 * All chunks and trailing boxes are validated before any result is returned.
 * Null means a single bounded moof, with optional prefix boxes, is awaiting its
 * legacy separately delivered mdat. Buffering that partial input is the caller's
 * responsibility. An incomplete later chunk is an error, never a partial success.
 */
export function readCmafObjectSamples(bytes: Uint8Array, context: LocmafTrackContext, budget?: LocmafReadBudget): readonly CmafChunkSamples[] | null {
    const top = childBoxes(bytes, 0, bytes.length, S, budget);
    const moofs: number[] = [];
    for (let i = 0; i < top.length; i++) if (top[i]!.type === 'moof') {
        budget?.claimEntries(1);
        moofs.push(i);
    }
    if (!moofs.length) throw new LocmafFormatError(S, 0, 'object has no moof');
    for (let i = 0; i < moofs[0]!; i++) if (top[i]!.type === 'mdat') {
        throw new LocmafFormatError(S, 0, 'mdat precedes the first moof');
    }
    if (moofs.length === 1 && !top.some(box => box.type === 'mdat')) return null;

    const reads: CmafChunkSamples[] = [];
    let start = 0;
    for (let i = 0; i < moofs.length; i++) {
        const next = moofs[i + 1] ?? top.length;
        let end = next;
        if (i + 1 < moofs.length) {
            // Boxes after this chunk's last mdat prefix the following chunk.
            // Keep all mdats of this chunk together; runs may use several.
            let lastMdat = -1;
            for (let j = moofs[i]! + 1; j < next; j++) if (top[j]!.type === 'mdat') lastMdat = j;
            if (lastMdat < 0) throw new LocmafFormatError(S, top[moofs[i]!]!.end, 'no mdat follows the moof');
            end = lastMdat + 1;
        }
        // Reuse the same sample reader on the ORIGINAL object coordinates.
        // This preserves explicit base_data_offset values while restricting
        // sample ranges to this chunk's own mdats, never a neighbour's media.
        const read = readCmafSamplesInBoxes(bytes, context, top, start, end, budget);
        budget?.claimEntries(1);
        reads.push(read);
        start = end;
    }
    return reads;
}

/**
 * Read the samples of a verbatim CMAF chunk.
 * @throws {LocmafFormatError} when the chunk has no single moof, no mdat after
 *   it, no traf whose tfhd.track_ID is the CMAF Header's track, more than one
 *   tfhd or tfdt in that traf, no tfdt, a truncated box, a nonempty sample
 *   outside every mdat payload, or sample runs totalling more bytes than the
 *   mdat payloads carry, or a tfhd, tfdt or trun of an unimplemented version.
 */
export function readCmafChunkSamples(chunk: Uint8Array, context: LocmafTrackContext, budget?: LocmafReadBudget): CmafChunkSamples {
    const top = childBoxes(chunk, 0, chunk.length, S, budget);
    return readCmafSamplesInBoxes(chunk, context, top, 0, top.length, budget);
}

function readCmafSamplesInBoxes(chunk: Uint8Array, context: LocmafTrackContext,
    top: readonly IsoBoxHeader[], start: number, end: number, budget?: LocmafReadBudget): CmafChunkSamples {
    const view = viewOf(chunk);
    let moof: IsoBoxHeader | undefined;
    let moofIndex = -1;
    let moofCount = 0;
    for (let i = start; i < end; i++) if (top[i]!.type === 'moof') {
        moof = top[i]; moofIndex = i; moofCount++;
    }
    if (moofCount !== 1 || !moof) throw new LocmafFormatError(S, 0, `chunk has ${moofCount} moof boxes`);
    // Keep ranges in complete Object coordinates; never borrow a neighbour mdat.
    const mdatPayloads: Array<readonly [number, number]> = [];
    let mdatBytes = 0;
    for (let i = moofIndex + 1; i < end; i++) {
        const box = top[i]!;
        if (box.type !== 'mdat') continue;
        budget?.claimEntries(3); // two range endpoints and its collection slot
        mdatPayloads.push([box.contentStart, box.end]);
        mdatBytes += box.end - box.contentStart;
    }
    if (mdatPayloads.length === 0) throw new LocmafFormatError(S, moof.end, 'no mdat follows the moof');

    const genBoxes: GenBox[] = [];
    for (let i = start; i < moofIndex; i++) {
        const box = top[i]!;
        const headerBytes = view.getUint32(box.start) === 1 ? 16 : 8;
        budget?.claimEntries(2); // genBox record and collection slot
        genBoxes.push({ type: box.type, payload: chunk.subarray(box.start + headerBytes, box.end) });
    }

    const traf = selectTraf(chunk, moof, context, budget);
    const children = childBoxes(chunk, traf.contentStart, traf.end, S, budget);
    let tfhd: IsoBoxHeader | undefined, tfdt: IsoBoxHeader | undefined;
    let tfhdCount = 0, tfdtCount = 0;
    for (const box of children) {
        if (box.type === 'tfhd') { tfhd = box; tfhdCount++; }
        if (box.type === 'tfdt') { tfdt = box; tfdtCount++; }
    }
    if (tfhdCount !== 1 || !tfhd) throw new LocmafFormatError(S, traf.start, `traf has ${tfhdCount} tfhd boxes`);
    if (tfdtCount === 0 || !tfdt) throw new LocmafFormatError(S, traf.start, 'traf has no tfdt: samples cannot be placed in time');
    if (tfdtCount > 1) throw new LocmafFormatError(S, traf.start, `traf has ${tfdtCount} tfdt boxes`);

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
    for (const trun of children) {
        if (trun.type !== 'trun') continue;
        need(trun, 8);
        const version = supportedVersion(trun, [0, 1]);
        const trFlags = view.getUint32(trun.contentStart) & 0xffffff;
        const n = view.getUint32(trun.contentStart + 4);
        if (durations.length + n > MAX_SAMPLE_COUNT) {
            throw new LocmafFormatError(S, trun.start, `trun sample_count ${n} exceeds the implementation limit`);
        }
        const perSample = ((trFlags & 0x100 ? 1 : 0) + (trFlags & 0x200 ? 1 : 0)
            + (trFlags & 0x400 ? 1 : 0) + (trFlags & 0x800 ? 1 : 0)) * 4;
        const fixed = 8 + (trFlags & 0x001 ? 4 : 0) + (trFlags & 0x004 ? 4 : 0);
        if (fixed + n * perSample > trun.end - trun.contentStart) {
            throw new LocmafFormatError(S, trun.start, `trun declares ${n} samples but is too short to carry them`);
        }
        budget?.claimSamples(n);
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
            budget?.claimEntries(7); // four vector slots, two range endpoints and its slot
            durations.push(duration);
            sizes.push(size);
            flags.push(f);
            compositionTimeOffsets.push(cto);
            ranges.push([cursor, cursor + size]);
            cursor += size;
        }
    }

    budget?.claimEntries(1); // chunk result record
    return {
        genBoxes,
        effective: { baseMediaDecodeTime, sampleDescriptionIndex, durations, sizes, flags, compositionTimeOffsets, cenc: null },
        mdat: gather(chunk, ranges, budget),
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
function selectTraf(chunk: Uint8Array, moof: IsoBoxHeader, context: LocmafTrackContext, budget?: LocmafReadBudget): IsoBoxHeader {
    const view = viewOf(chunk);
    let trafCount = 0, matchingCount = 0;
    let matching: IsoBoxHeader | undefined;
    const ids: number[] = [];
    for (const traf of childBoxes(chunk, moof.contentStart, moof.end, S, budget)) {
        if (traf.type !== 'traf') continue;
        trafCount++;
        let tfhdCount = 0, tfhd: IsoBoxHeader | undefined;
        for (const box of childBoxes(chunk, traf.contentStart, traf.end, S, budget)) {
            if (box.type === 'tfhd') { tfhd = box; tfhdCount++; }
        }
        if (tfhdCount !== 1 || !tfhd) throw new LocmafFormatError(S, traf.start, `traf has ${tfhdCount} tfhd boxes`);
        if (tfhd.end - tfhd.contentStart < 8) throw new LocmafFormatError(S, tfhd.start, `'tfhd' box too short for its fields`);
        const id = view.getUint32(tfhd.contentStart + 4);
        budget?.claimEntries(1);
        ids.push(id);
        if (id === context.trackId) { matching = traf; matchingCount++; }
    }
    if (trafCount === 0) throw new LocmafFormatError(S, moof.start, 'moof has no traf');
    if (matchingCount === 1 && matching) return matching;
    if (matchingCount === 0) {
        throw new LocmafFormatError(S, moof.start,
            `no traf carries track_ID ${context.trackId} of the CMAF Header (moof has track_ID ${ids.join(', ')})`);
    }
    throw new LocmafFormatError(S, moof.start, `moof has ${matchingCount} trafs for track_ID ${context.trackId}`);
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
function gather(chunk: Uint8Array, ranges: ReadonlyArray<readonly [number, number]>, budget?: LocmafReadBudget): Uint8Array {
    if (ranges.length === 0) return chunk.subarray(0, 0);
    let contiguous = true;
    for (let i = 1; i < ranges.length && contiguous; i++) contiguous = ranges[i]![0] === ranges[i - 1]![1];
    if (contiguous) return chunk.subarray(ranges[0]![0], ranges[ranges.length - 1]![1]);
    const length = ranges.reduce((n, [s, e]) => n + (e - s), 0);
    budget?.claimBytes(length);
    const out = new Uint8Array(length);
    let pos = 0;
    for (const [s, e] of ranges) {
        out.set(chunk.subarray(s, e), pos);
        pos += e - s;
    }
    return out;
}
