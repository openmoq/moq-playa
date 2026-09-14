/**
 * Per-track constants a LOCMAF receiver takes from the CMAF Header.
 *
 * @see draft-einarsson-moq-locmaf-01 section 4.1 (single trak), section 6
 *   step 3 (track_ID, mdhd.timescale, trex defaults, tenc defaults), section 13
 * @module
 */

import { LocmafFormatError } from './errors.js';
import { childBoxes, findChild, readBoxHeader, viewOf, fourccAt, type IsoBoxHeader } from './iso-box.js';

/** Reconstruction inputs from the CMAF Header (section 15.1, last paragraph). */
export interface LocmafTrackContext {
    /** track_ID of the single trak. */
    readonly trackId: number;
    /** mdhd.timescale. */
    readonly timescale: number;
    /** trex.default_sample_description_index. */
    readonly defaultSampleDescriptionIndex: number;
    /** trex.default_sample_duration. */
    readonly defaultSampleDuration: number;
    /** trex.default_sample_size. */
    readonly defaultSampleSize: number;
    /** trex.default_sample_flags. */
    readonly defaultSampleFlags: number;
    /** hdlr.handler_type, e.g. `vide` or `soun` (empty without hdlr). */
    readonly handlerType: string;
    /** Type of the first sample entry, e.g. `avc1` or `encv`, or null when stsd has none. */
    readonly sampleEntryType: string | null;
    /** Sample entry type, or the frma original format for encv/enca; null without a sample entry. */
    readonly codecFourcc: string | null;
    /** tenc.default_isProtected == 1. */
    readonly isProtected: boolean;
    /** tenc.default_Per_Sample_IV_Size (0 without tenc). */
    readonly perSampleIvSize: number;
    /** tenc.default_KID, or null without tenc. */
    readonly defaultKid: Uint8Array | null;
    /** tenc.default_constant_IV, or null when absent. */
    readonly constantIv: Uint8Array | null;
    /** schm.scheme_type, or null without schm. */
    readonly schemeType: string | null;
}

const SECTION = '6';

function need(box: IsoBoxHeader | undefined, what: string, at: number): IsoBoxHeader {
    if (box === undefined) {
        throw new LocmafFormatError(SECTION, at, `${what} missing`);
    }
    return box;
}

function requireContent(box: IsoBoxHeader, bytes: number): void {
    if (box.end - box.contentStart < bytes) {
        throw new LocmafFormatError(SECTION, box.start, `'${box.type}' box too short (${box.end - box.contentStart} < ${bytes} bytes)`);
    }
}

/**
 * Parse a CMAF Header (ftyp + moov) into the LOCMAF track context.
 *
 * The sample entry is not a reconstruction input (section 6 step 3 names
 * track_ID, timescale, trex and tenc only), so a Header whose stsd carries no
 * entry is accepted with no protection information.
 *
 * @throws {LocmafFormatError} section 4.1 unless exactly one trak; section 6 for
 *   a missing or malformed moov, trak, tkhd, mdhd or matching trex; section 13
 *   for a malformed protection scheme box.
 */
export function parseLocmafTrackContext(init: Uint8Array): LocmafTrackContext {
    if (init.length < 8) {
        throw new LocmafFormatError(SECTION, 0, 'empty initialization segment');
    }
    let moov: IsoBoxHeader | undefined;
    for (let pos = 0; pos < init.length && moov === undefined;) {
        const box = readBoxHeader(init, pos, init.length, SECTION);
        if (box.type === 'moov') moov = box;
        pos = box.end;
    }
    if (moov === undefined) {
        throw new LocmafFormatError(SECTION, 0, 'no moov box in initialization segment');
    }
    const view = viewOf(init);
    const moovChildren = childBoxes(init, moov.contentStart, moov.end, SECTION);
    const traks = moovChildren.filter((b) => b.type === 'trak');
    if (traks.length !== 1) {
        throw new LocmafFormatError('4.1', moov.start, `LOCMAF requires exactly one trak, found ${traks.length}`);
    }
    const trak = traks[0]!;

    const tkhd = need(findChild(init, trak.contentStart, trak.end, 'tkhd', SECTION), 'tkhd', trak.start);
    const tkhdV1 = init[tkhd.contentStart] === 1;
    requireContent(tkhd, tkhdV1 ? 24 : 16);
    const trackId = view.getUint32(tkhd.contentStart + (tkhdV1 ? 20 : 12));

    const mdia = need(findChild(init, trak.contentStart, trak.end, 'mdia', SECTION), 'mdia', trak.start);
    const mdiaChildren = childBoxes(init, mdia.contentStart, mdia.end, SECTION);
    const mdhd = need(mdiaChildren.find((b) => b.type === 'mdhd'), 'mdhd', mdia.start);
    const mdhdV1 = init[mdhd.contentStart] === 1;
    requireContent(mdhd, mdhdV1 ? 24 : 16);
    const timescale = view.getUint32(mdhd.contentStart + (mdhdV1 ? 20 : 12));
    const hdlr = mdiaChildren.find((b) => b.type === 'hdlr');
    let handlerType = '';
    if (hdlr !== undefined) {
        requireContent(hdlr, 12);
        handlerType = fourccAt(init, hdlr.contentStart + 8);
    }

    const minf = mdiaChildren.find((b) => b.type === 'minf');
    const stbl = minf && findChild(init, minf.contentStart, minf.end, 'stbl', SECTION);
    const stsd = stbl && findChild(init, stbl.contentStart, stbl.end, 'stsd', SECTION);
    let entry: IsoBoxHeader | undefined;
    if (stsd !== undefined) {
        requireContent(stsd, 8);
        if (view.getUint32(stsd.contentStart + 4) !== 0) {
            entry = childBoxes(init, stsd.contentStart + 8, stsd.end, SECTION)[0];
        }
    }

    let codecFourcc = entry?.type ?? null;
    let isProtected = false;
    let perSampleIvSize = 0;
    let defaultKid: Uint8Array | null = null;
    let constantIv: Uint8Array | null = null;
    let schemeType: string | null = null;
    const fixed = entry === undefined ? undefined : protectedEntryFieldsLength(init, entry);
    if (entry !== undefined && fixed !== undefined) {
        const sinf = childBoxes(init, entry.contentStart + fixed, entry.end, '13').find((b) => b.type === 'sinf');
        if (sinf !== undefined) {
            const sinfChildren = childBoxes(init, sinf.contentStart, sinf.end, '13');
            const frma = sinfChildren.find((b) => b.type === 'frma');
            if (frma !== undefined && frma.end - frma.contentStart >= 4) codecFourcc = fourccAt(init, frma.contentStart);
            const schm = sinfChildren.find((b) => b.type === 'schm');
            if (schm !== undefined && schm.end - schm.contentStart >= 8) schemeType = fourccAt(init, schm.contentStart + 4);
            const schi = sinfChildren.find((b) => b.type === 'schi');
            const tenc = schi && findChild(init, schi.contentStart, schi.end, 'tenc', '13');
            if (tenc !== undefined) {
                const c = tenc.contentStart;
                if (tenc.end - c < 24) {
                    throw new LocmafFormatError('13', tenc.start, 'tenc box too short');
                }
                isProtected = init[c + 6] === 1;
                perSampleIvSize = init[c + 7]!;
                defaultKid = init.slice(c + 8, c + 24);
                if (isProtected && perSampleIvSize === 0) {
                    if (tenc.end - c < 25 || tenc.end - c < 25 + init[c + 24]!) {
                        throw new LocmafFormatError('13', tenc.start, 'tenc constant IV truncated');
                    }
                    constantIv = init.slice(c + 25, c + 25 + init[c + 24]!);
                }
            }
        }
    }

    const mvex = need(moovChildren.find((b) => b.type === 'mvex'), 'mvex', moov.start);
    const trex = childBoxes(init, mvex.contentStart, mvex.end, SECTION)
        .filter((b) => b.type === 'trex' && b.end - b.contentStart >= 24)
        .find((b) => view.getUint32(b.contentStart + 4) === trackId);
    if (trex === undefined) {
        throw new LocmafFormatError(SECTION, mvex.start, `no trex for track ${trackId}`);
    }
    return {
        trackId,
        timescale,
        defaultSampleDescriptionIndex: view.getUint32(trex.contentStart + 8),
        defaultSampleDuration: view.getUint32(trex.contentStart + 12),
        defaultSampleSize: view.getUint32(trex.contentStart + 16),
        defaultSampleFlags: view.getUint32(trex.contentStart + 20),
        handlerType,
        sampleEntryType: entry?.type ?? null,
        codecFourcc,
        isProtected,
        perSampleIvSize,
        defaultKid,
        constantIv,
        schemeType,
    };
}

/**
 * Length of the fixed fields preceding the child boxes of a protected sample
 * entry (encv: VisualSampleEntry, enca: AudioSampleEntry including the
 * QuickTime v1/v2 extensions), or undefined for any other entry.
 */
function protectedEntryFieldsLength(buf: Uint8Array, entry: IsoBoxHeader): number | undefined {
    if (entry.type === 'encv') return 78;
    if (entry.type !== 'enca') return undefined;
    if (entry.end - entry.contentStart < 28) {
        throw new LocmafFormatError('13', entry.start, 'enca sample entry too short');
    }
    const version = viewOf(buf).getUint16(entry.contentStart + 8);
    return version === 1 ? 44 : version === 2 ? 64 : 28;
}
