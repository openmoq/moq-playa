/**
 * CMAF Header and chunk builders for the LOCMAF tests (the TypeScript
 * counterparts of the Java Fmp4InitSegmentBuilder / Fmp4FragmentBuilder /
 * TencSinfBoxTest helpers the reference tests used).
 *
 * @module
 */

import { ascii, concat, fullBox, i32, isoBox, u16, u32, u64, u8 } from './bytes.js';

/** Sync sample flags: sample_depends_on = 2. */
export const SYNC_FLAGS = 0x02000000;
/** Non-sync sample flags: sample_depends_on = 1, sample_is_non_sync_sample = 1. */
export const NON_SYNC_FLAGS = 0x01010000;

export interface TrexDefaults {
    readonly sampleDescriptionIndex?: number;
    readonly duration?: number;
    readonly size?: number;
    readonly flags?: number;
}

export interface EncryptionSpec {
    readonly scheme: string;
    readonly perSampleIvSize: number;
    readonly isProtected?: number;
    readonly kid?: Uint8Array;
    readonly constantIv?: Uint8Array;
    readonly tencVersion?: number;
    readonly cryptByteBlock?: number;
    readonly skipByteBlock?: number;
}

export interface InitSpec {
    readonly trackId: number;
    readonly timescale: number;
    readonly handler: 'vide' | 'soun' | string;
    readonly trex?: TrexDefaults;
    readonly encryption?: EncryptionSpec;
    /** Additional traks (to violate the single-trak rule). */
    readonly extraTraks?: number;
    readonly headerVersion?: 0 | 1;
    /** Write moov with a 64-bit largesize header. */
    readonly largesizeMoov?: boolean;
    /** Omit the mvex/trex box. */
    readonly omitTrex?: boolean;
    /** Emit an stsd with zero sample entries. */
    readonly emptyStsd?: boolean;
}

function tenc(spec: EncryptionSpec): Uint8Array {
    const version = spec.tencVersion ?? (spec.scheme === 'cbcs' ? 1 : 0);
    const pattern = version === 0 ? 0 : (((spec.cryptByteBlock ?? 1) << 4) | (spec.skipByteBlock ?? 9));
    const constant = spec.perSampleIvSize === 0 ? concat(u8(spec.constantIv?.length ?? 16), spec.constantIv ?? new Uint8Array(16)) : new Uint8Array(0);
    return fullBox('tenc', version, 0, u8(0), u8(pattern), u8(spec.isProtected ?? 1), u8(spec.perSampleIvSize),
        spec.kid ?? new Uint8Array(16), constant);
}

function sinf(original: string, spec: EncryptionSpec): Uint8Array {
    return isoBox('sinf',
        isoBox('frma', ascii(original)),
        fullBox('schm', 0, 0, ascii(spec.scheme), u32(0x00010000)),
        isoBox('schi', tenc(spec)));
}

function sampleEntry(handler: string, encryption: EncryptionSpec | undefined): Uint8Array {
    if (handler === 'soun') {
        const fields = concat(new Uint8Array(6), u16(1), u16(0), u16(0), u32(0), u16(2), u16(16), u16(0), u16(0), u32(48000 << 16));
        const esds = fullBox('esds', 0, 0, Uint8Array.of(0x03, 0x19, 0x00, 0x01, 0x00, 0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02));
        return encryption
            ? isoBox('enca', fields, esds, sinf('mp4a', encryption))
            : isoBox('mp4a', fields, esds);
    }
    const fields = concat(new Uint8Array(6), u16(1), new Uint8Array(16), u16(640), u16(360), u32(0x00480000), u32(0x00480000),
        u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff));
    const avcC = isoBox('avcC', Uint8Array.of(1, 100, 0, 40, 0xff, 0xe1, 0, 0, 1, 0));
    return encryption
        ? isoBox('encv', fields, avcC, sinf('avc1', encryption))
        : isoBox('avc1', fields, avcC);
}

function trak(spec: InitSpec, trackId: number): Uint8Array {
    const v = spec.headerVersion ?? 0;
    const times = v === 1 ? concat(u64(0n), u64(0n)) : concat(u32(0), u32(0));
    const duration = v === 1 ? u64(0n) : u32(0);
    const tkhd = fullBox('tkhd', v, 7, times, u32(trackId), u32(0), duration, new Uint8Array(8), u16(0), u16(0), u16(0), u16(0),
        new Uint8Array(36), u32(640 << 16), u32(360 << 16));
    const mdhd = fullBox('mdhd', v, 0, times, u32(spec.timescale), duration, u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii(spec.handler.padEnd(4, ' ').slice(0, 4)), new Uint8Array(12), u8(0));
    const stsd = spec.emptyStsd
        ? fullBox('stsd', 0, 0, u32(0))
        : fullBox('stsd', 0, 0, u32(1), sampleEntry(spec.handler, spec.encryption));
    const stbl = isoBox('stbl', stsd, fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)),
        fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)));
    const mediaHeader = spec.handler === 'soun' ? fullBox('smhd', 0, 0, u32(0)) : fullBox('vmhd', 0, 1, new Uint8Array(8));
    const dinf = isoBox('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    return isoBox('trak', tkhd, isoBox('mdia', mdhd, hdlr, isoBox('minf', mediaHeader, dinf, stbl)));
}

/** Build a CMAF Header (ftyp + moov). */
export function buildInit(spec: InitSpec): Uint8Array {
    const ftyp = isoBox('ftyp', ascii('iso6'), u32(0), ascii('iso6'), ascii('cmfc'));
    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), new Uint8Array(10),
        new Uint8Array(36), new Uint8Array(24), u32(spec.trackId + 1 + (spec.extraTraks ?? 0)));
    const traks: Uint8Array[] = [trak(spec, spec.trackId)];
    for (let i = 0; i < (spec.extraTraks ?? 0); i++) traks.push(trak(spec, spec.trackId + 1 + i));
    const t = spec.trex ?? {};
    const trexBox = fullBox('trex', 0, 0, u32(spec.trackId), u32(t.sampleDescriptionIndex ?? 1), u32(t.duration ?? 0),
        u32(t.size ?? 0), u32(t.flags ?? 0));
    const children = concat(mvhd, ...traks, spec.omitTrex ? new Uint8Array(0) : isoBox('mvex', trexBox));
    const moov = spec.largesizeMoov
        ? concat(u32(1), ascii('moov'), u64(BigInt(16 + children.length)), children)
        : isoBox('moov', children);
    return concat(ftyp, moov);
}

/** Java LocmafTrackContextTest.videoInit(): track 1, 90 kHz, avc1, trex defaults zero. */
export function videoInit(): Uint8Array {
    return buildInit({ trackId: 1, timescale: 90000, handler: 'vide' });
}

/** Java LocmafTrackContextTest.audioInit(): track 2, 48 kHz, mp4a. */
export function audioInit(): Uint8Array {
    return buildInit({ trackId: 2, timescale: 48000, handler: 'soun' });
}

/**
 * Java LocmafReconstructorCencTest.cencContext(ivSize): encv with 'cenc' and a
 * per-sample IV size, or 'cbcs' with a 16-byte constant IV when ivSize is 0.
 */
export function cencVideoInit(ivSize: number): Uint8Array {
    return buildInit({
        trackId: 1,
        timescale: 90000,
        handler: 'vide',
        encryption: ivSize === 0
            ? { scheme: 'cbcs', perSampleIvSize: 0, constantIv: new Uint8Array(16), cryptByteBlock: 1, skipByteBlock: 9 }
            : { scheme: 'cenc', perSampleIvSize: ivSize },
    });
}

export interface SampleSpec {
    readonly duration: number;
    readonly size: number;
    readonly flags: number;
    readonly cto?: number;
}

export interface SencSpec {
    readonly ivSize: number;
    readonly useSubsamples: boolean;
    readonly samples: ReadonlyArray<{ readonly iv: Uint8Array; readonly subsamples: ReadonlyArray<readonly [number, number]> }>;
    /** Also write saiz/saio (recomputed by the receiver, never carried). */
    readonly withSaizSaio?: boolean;
}

export interface ChunkSpec {
    readonly trackId?: number;
    readonly bmdt: bigint | number;
    readonly samples: readonly SampleSpec[];
    readonly mdat?: Uint8Array;
    /** Complete ISO boxes placed before the moof. */
    readonly preMoof?: readonly Uint8Array[];
    readonly sequenceNumber?: number;
    /** tfhd defaults to write (each sets its tf_flags bit). */
    readonly tfhd?: TrexDefaults;
    /**
     * Per-sample trun fields to write. Defaults to duration, size and flags,
     * plus composition offsets when any is non-zero.
     */
    readonly trun?: { readonly duration?: boolean; readonly size?: boolean; readonly flags?: boolean; readonly cto?: boolean; readonly firstSampleFlags?: number };
    readonly tfdtVersion?: 0 | 1;
    readonly omitTfdt?: boolean;
    readonly senc?: SencSpec;
    readonly extraTrafBoxes?: readonly Uint8Array[];
    readonly extraTrun?: boolean;
    readonly baseDataOffset?: boolean;
    readonly trailing?: readonly Uint8Array[];
    /** Override trun sample_count (to build a truncated trun). */
    readonly declaredSampleCount?: number;
}

/** Build one CMAF chunk: preMoof boxes, moof (single traf), mdat. */
export function buildChunk(spec: ChunkSpec): Uint8Array {
    const trackId = spec.trackId ?? 1;
    const samples = spec.samples;
    const anyCto = samples.some((s) => (s.cto ?? 0) !== 0);
    const fields = spec.trun ?? { duration: true, size: true, flags: true, cto: anyCto };
    const negative = samples.some((s) => (s.cto ?? 0) < 0);

    let tfFlags = 0x020000 | (spec.baseDataOffset ? 0x000001 : 0);
    const tfhdFields: Uint8Array[] = [u32(trackId)];
    if (spec.baseDataOffset) tfhdFields.push(u64(0n));
    const d = spec.tfhd ?? {};
    if (d.sampleDescriptionIndex !== undefined) { tfFlags |= 0x02; tfhdFields.push(u32(d.sampleDescriptionIndex)); }
    if (d.duration !== undefined) { tfFlags |= 0x08; tfhdFields.push(u32(d.duration)); }
    if (d.size !== undefined) { tfFlags |= 0x10; tfhdFields.push(u32(d.size)); }
    if (d.flags !== undefined) { tfFlags |= 0x20; tfhdFields.push(u32(d.flags)); }
    const tfhd = fullBox('tfhd', 0, tfFlags, ...tfhdFields);

    const tfdt = spec.omitTfdt
        ? new Uint8Array(0)
        : (spec.tfdtVersion ?? 1) === 1
            ? fullBox('tfdt', 1, 0, u64(BigInt(spec.bmdt)))
            : fullBox('tfdt', 0, 0, u32(Number(spec.bmdt)));

    const makeTrun = (dataOffset: number): Uint8Array => {
        let trFlags = 0x000001;
        if (fields.firstSampleFlags !== undefined) trFlags |= 0x000004;
        if (fields.duration) trFlags |= 0x000100;
        if (fields.size) trFlags |= 0x000200;
        if (fields.flags) trFlags |= 0x000400;
        if (fields.cto) trFlags |= 0x000800;
        const parts: Uint8Array[] = [u32(spec.declaredSampleCount ?? samples.length), i32(dataOffset)];
        if (fields.firstSampleFlags !== undefined) parts.push(u32(fields.firstSampleFlags));
        for (const s of samples) {
            if (fields.duration) parts.push(u32(s.duration));
            if (fields.size) parts.push(u32(s.size));
            if (fields.flags) parts.push(u32(s.flags));
            if (fields.cto) parts.push(negative ? i32(s.cto ?? 0) : u32(s.cto ?? 0));
        }
        return fullBox('trun', negative ? 1 : 0, trFlags, ...parts);
    };

    const cencBoxes = (sencOffset: number): Uint8Array[] => {
        const s = spec.senc;
        if (!s) return [];
        const body: Uint8Array[] = [u32(s.samples.length)];
        const aux: number[] = [];
        for (const sample of s.samples) {
            body.push(sample.iv);
            let size = sample.iv.length;
            if (s.useSubsamples) {
                body.push(u16(sample.subsamples.length));
                for (const [clear, prot] of sample.subsamples) body.push(u16(clear), u32(prot));
                size += 2 + 6 * sample.subsamples.length;
            }
            aux.push(size);
        }
        const senc = fullBox('senc', 0, s.useSubsamples ? 2 : 0, ...body);
        if (!s.withSaizSaio) return [senc];
        const saiz = fullBox('saiz', 0, 0, u8(0), u32(aux.length), Uint8Array.from(aux));
        const saio = fullBox('saio', 0, 0, u32(1), u32(sencOffset + 16));
        return [saiz, saio, senc];
    };

    const extraTrun = spec.extraTrun ? fullBox('trun', 0, 0x000001, u32(0), i32(0)) : new Uint8Array(0);
    const assemble = (dataOffset: number, sencOffset: number): Uint8Array => {
        const traf = isoBox('traf', tfhd, tfdt, makeTrun(dataOffset), extraTrun, ...cencBoxes(sencOffset), ...(spec.extraTrafBoxes ?? []));
        return isoBox('moof', fullBox('mfhd', 0, 0, u32(spec.sequenceNumber ?? 1)), traf);
    };
    // Two passes: sizes do not depend on the offsets' values.
    const probe = assemble(0, 0);
    const trunLen = makeTrun(0).length;
    const saizLen = spec.senc?.withSaizSaio ? 8 + 4 + 1 + 4 + spec.senc.samples.length : 0;
    const sencOffset = 8 + 16 + 8 + tfhd.length + tfdt.length + trunLen + extraTrun.length + saizLen + (spec.senc?.withSaizSaio ? 20 : 0);
    const moof = assemble(probe.length + 8, sencOffset);

    const payloadLength = samples.reduce((n, s) => n + s.size, 0);
    const mdat = isoBox('mdat', spec.mdat ?? new Uint8Array(payloadLength));
    return concat(...(spec.preMoof ?? []), moof, mdat, ...(spec.trailing ?? []));
}

/** The styp box the Java Fmp4FragmentBuilder places ahead of every moof. */
export function stypBox(): Uint8Array {
    return isoBox('styp', ascii('cmfc'), u32(0), ascii('cmfc'));
}
