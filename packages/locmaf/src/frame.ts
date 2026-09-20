/**
 * Frame interface (section 16): slice a reconstructed chunk's mdat payload into
 * per-sample coded frames, and read the codec configuration a frame decoder
 * needs from the CMAF Header.
 *
 * A chunk interface (MSE) consumes the canonical chunk of section 15. A frame
 * interface (WebCodecs, or any decoder that takes individual coded frames)
 * consumes the same elementary samples one at a time, using the effective
 * per-sample values of section 15.1 for the byte ranges, timestamps, durations
 * and key/delta types. Both are equally valid consumption paths; neither is
 * privileged by the draft.
 *
 * @see draft-einarsson-moq-locmaf-01 section 15.1, section 16
 * @module
 */
import { LocmafFormatError } from './errors.js';
import { isSyncSampleFlags, type LocmafEffectiveSamples } from './effective.js';
import { childBoxes, findChild, readBoxHeader, viewOf, type IsoBoxHeader } from './iso-box.js';

/** One CENC subsample range of a protected frame (section 15.8). */
export interface LocmafFrameSubsample {
    readonly clearBytes: number;
    readonly protectedBytes: number;
}

/** Per-frame decryption parameters of a protected track (section 13, section 16). */
export interface LocmafFrameCenc {
    /** Per-sample IV, or empty under a constant-IV scheme (cbcs). */
    readonly iv: Uint8Array;
    /** Subsample map, or null when the whole frame is protected. */
    readonly subsamples: readonly LocmafFrameSubsample[] | null;
}

/** One coded sample of a chunk, with the timing a frame decoder needs. */
export interface LocmafFrame {
    /** Sample index within the chunk. */
    readonly index: number;
    /** The coded sample bytes, a view into the chunk's mdat payload. */
    readonly data: Uint8Array;
    /** Decode time in track timescale ticks (tfdt base plus preceding durations). */
    readonly decodeTime: bigint;
    /** Presentation time in ticks: decode time plus the composition time offset. */
    readonly presentationTime: bigint;
    /** Sample duration in ticks. */
    readonly duration: number;
    /** The full 32-bit sample_flags value (section 10.1). */
    readonly flags: number;
    /** sample_is_non_sync_sample is clear: the frame is independently decodable. */
    readonly isSync: boolean;
    /** CENC parameters, or null on a clear track. */
    readonly cenc: LocmafFrameCenc | null;
}

/**
 * Slice a chunk's mdat payload into frames using its effective values.
 *
 * The samples are laid out back to back in the payload in decode order
 * (section 11.2), so the byte ranges follow from the effective sizes. An
 * effective vector that does not fit the payload is a malformed chunk.
 *
 * @throws {LocmafFormatError} when the sizes do not cover exactly the payload.
 */
export function sliceFrames(effective: LocmafEffectiveSamples, mdat: Uint8Array): LocmafFrame[] {
    const n = effective.durations.length;
    if (effective.sizes.length !== n || effective.flags.length !== n || effective.compositionTimeOffsets.length !== n) {
        throw new LocmafFormatError('15.1', 0, 'effective per-sample vectors disagree on the sample count');
    }
    const total = effective.sizes.reduce((a, b) => a + b, 0);
    if (total !== mdat.length) {
        throw new LocmafFormatError('11.2', 0, `sample sizes cover ${total} bytes but the mdat payload is ${mdat.length}`);
    }
    const c = effective.cenc;
    if (c !== null && c.subsampleCounts !== null && c.subsampleCounts.length !== n) {
        throw new LocmafFormatError('15.8', 0, 'subsample counts disagree with the sample count');
    }

    const frames: LocmafFrame[] = new Array<LocmafFrame>(n);
    let offset = 0;
    let decodeTime = effective.baseMediaDecodeTime;
    let subsampleIndex = 0;
    for (let i = 0; i < n; i++) {
        const size = effective.sizes[i]!;
        const duration = effective.durations[i]!;
        const flags = effective.flags[i]!;
        let cenc: LocmafFrameCenc | null = null;
        if (c !== null) {
            const iv = c.ivs.subarray(i * c.perSampleIvSize, (i + 1) * c.perSampleIvSize);
            let subsamples: LocmafFrameSubsample[] | null = null;
            if (c.subsampleCounts !== null) {
                const count = c.subsampleCounts[i]!;
                subsamples = new Array<LocmafFrameSubsample>(count);
                for (let s = 0; s < count; s++) {
                    subsamples[s] = {
                        clearBytes: c.clearBytes![subsampleIndex + s]!,
                        protectedBytes: c.protectedBytes![subsampleIndex + s]!,
                    };
                }
                subsampleIndex += count;
            }
            cenc = { iv, subsamples };
        }
        frames[i] = {
            index: i,
            data: mdat.subarray(offset, offset + size),
            decodeTime,
            presentationTime: decodeTime + BigInt(effective.compositionTimeOffsets[i]!),
            duration,
            flags,
            isSync: isSyncSampleFlags(flags),
            cenc,
        };
        offset += size;
        decodeTime += BigInt(duration);
    }
    return frames;
}

/** Convert track timescale ticks to microseconds, rounding to nearest. */
export function ticksToMicros(ticks: bigint, timescale: number): bigint {
    if (!Number.isInteger(timescale) || timescale <= 0) {
        throw new LocmafFormatError('6', 0, `timescale must be a positive integer, got ${timescale}`);
    }
    const scale = BigInt(timescale);
    const scaled = ticks * 1_000_000n;
    const half = scaled >= 0n ? scale / 2n : -(scale / 2n);
    return (scaled + half) / scale;
}

/**
 * Length of the fixed fields preceding the child boxes of a sample entry:
 * 78 for a VisualSampleEntry, 28 for an AudioSampleEntry (44 or 64 with the
 * QuickTime v1/v2 extensions), undefined for an entry this module does not
 * know how to walk.
 */
function sampleEntryFieldsLength(buf: Uint8Array, entry: IsoBoxHeader, handler: string): number | undefined {
    const video = handler === 'vide' || entry.type === 'encv';
    const audio = handler === 'soun' || entry.type === 'enca';
    if (video) return 78;
    if (!audio) return undefined;
    if (entry.end - entry.contentStart < 28) return undefined;
    const version = viewOf(buf).getUint16(entry.contentStart + 8);
    return version === 1 ? 44 : version === 2 ? 64 : 28;
}

/** Box types whose payload is the WebCodecs `description` verbatim. */
const DESCRIPTION_BOXES = new Set(['avcC', 'hvcC', 'av1C', 'vpcC', 'dOps', 'dfLa']);

/**
 * The decoder configuration of the CMAF Header's sample entry, as a frame
 * decoder expects it: the payload of the codec configuration box for video
 * (avcC, hvcC, av1C, vpcC), of dOps for Opus and dfLa for FLAC, or the
 * DecoderSpecificInfo (the AudioSpecificConfig) of an esds for MPEG-4 audio.
 * Returns null when the Header carries no sample entry or an unknown one.
 *
 * Maps to `VideoDecoderConfig.description` / `AudioDecoderConfig.description`
 * (section 16, "the CMAF Header supplies the codec configuration").
 *
 * @throws {LocmafFormatError} when the Header's box structure is unreadable.
 */
export function codecDescriptionFromInit(init: Uint8Array): Uint8Array | null {
    const SECTION = '6';
    const view = viewOf(init);
    const top = childBoxes(init, 0, init.length, SECTION);
    const moov = top.find((b) => b.type === 'moov');
    if (moov === undefined) return null;
    const trak = findChild(init, moov.contentStart, moov.end, 'trak', SECTION);
    const mdia = trak && findChild(init, trak.contentStart, trak.end, 'mdia', SECTION);
    if (mdia === undefined) return null;
    const mdiaChildren = childBoxes(init, mdia.contentStart, mdia.end, SECTION);
    const hdlr = mdiaChildren.find((b) => b.type === 'hdlr');
    const handler = hdlr !== undefined && hdlr.end - hdlr.contentStart >= 12
        ? String.fromCharCode(...init.subarray(hdlr.contentStart + 8, hdlr.contentStart + 12))
        : '';
    const minf = mdiaChildren.find((b) => b.type === 'minf');
    const stbl = minf && findChild(init, minf.contentStart, minf.end, 'stbl', SECTION);
    const stsd = stbl && findChild(init, stbl.contentStart, stbl.end, 'stsd', SECTION);
    if (stsd === undefined || stsd.end - stsd.contentStart < 8 || view.getUint32(stsd.contentStart + 4) === 0) return null;
    const entry = childBoxes(init, stsd.contentStart + 8, stsd.end, SECTION)[0];
    if (entry === undefined) return null;
    const fixed = sampleEntryFieldsLength(init, entry, handler);
    if (fixed === undefined || entry.contentStart + fixed > entry.end) return null;

    for (const child of childBoxes(init, entry.contentStart + fixed, entry.end, SECTION)) {
        if (DESCRIPTION_BOXES.has(child.type)) return init.slice(child.contentStart, child.end);
        if (child.type === 'esds') return decoderSpecificInfo(init, child);
    }
    return null;
}

/**
 * The DecoderSpecificInfo of an esds box: ES_Descriptor (tag 3) contains a
 * DecoderConfigDescriptor (tag 4), which contains the DecoderSpecificInfo
 * (tag 5). Descriptor lengths use the expandable 1 to 4 byte form
 * (ISO 14496-1 section 8.3.3).
 */
function decoderSpecificInfo(buf: Uint8Array, esds: IsoBoxHeader): Uint8Array | null {
    let pos = esds.contentStart + 4; // full box version and flags
    const end = esds.end;
    const readDescriptor = (): { tag: number; start: number; end: number } | null => {
        if (pos >= end) return null;
        const tag = buf[pos++]!;
        let length = 0;
        for (let i = 0; i < 4 && pos < end; i++) {
            const b = buf[pos++]!;
            length = (length << 7) | (b & 0x7f);
            if ((b & 0x80) === 0) break;
        }
        const start = pos;
        return { tag, start, end: Math.min(end, start + length) };
    };
    const es = readDescriptor();
    if (es === null || es.tag !== 0x03) return null;
    // ES_ID (2), flags (1) plus optional dependsOn (2), URL (1 + n), OCR (2).
    pos = es.start + 2;
    const flags = buf[pos++] ?? 0;
    if (flags & 0x80) pos += 2;
    if (flags & 0x40) pos += 1 + (buf[pos] ?? 0);
    if (flags & 0x20) pos += 2;
    while (pos < es.end) {
        const d = readDescriptor();
        if (d === null) return null;
        if (d.tag === 0x04) {
            // objectTypeIndication (1), streamType (1), bufferSizeDB (3), maxBitrate (4), avgBitrate (4).
            pos = d.start + 13;
            while (pos < d.end) {
                const inner = readDescriptor();
                if (inner === null) return null;
                if (inner.tag === 0x05) return buf.slice(inner.start, inner.end);
                pos = inner.end;
            }
            return null;
        }
        pos = d.end;
    }
    return null;
}

/** Whether the bytes are a CMAF Header (ftyp then moov) rather than a chunk. */
export function isCmafHeader(bytes: Uint8Array): boolean {
    try {
        const first = readBoxHeader(bytes, 0, bytes.length, '6');
        if (first.type !== 'ftyp') return false;
        if (first.end >= bytes.length) return false;
        return readBoxHeader(bytes, first.end, bytes.length, '6').type === 'moov';
    } catch {
        return false;
    }
}
