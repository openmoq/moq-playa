/**
 * Independent CMAF chunk inspector for the LOCMAF tests. Deliberately separate
 * from the package's own chunk reader, so reconstruction output is checked by
 * code that does not share its assumptions.
 *
 * @module
 */

export interface InspectedTrunSample {
    readonly duration: number | undefined;
    readonly size: number | undefined;
    readonly flags: number | undefined;
    readonly cto: number | undefined;
}

export interface InspectedChunk {
    readonly boxes: readonly string[];
    readonly preMoof: ReadonlyArray<{ readonly type: string; readonly bytes: Uint8Array }>;
    readonly moof: Uint8Array;
    readonly mfhdSequence: number;
    readonly trafOrder: readonly string[];
    readonly tfhd: {
        readonly flags: number;
        readonly trackId: number;
        readonly sampleDescriptionIndex: number | undefined;
        readonly defaultSampleDuration: number | undefined;
        readonly defaultSampleSize: number | undefined;
        readonly defaultSampleFlags: number | undefined;
    };
    readonly tfdt: { readonly version: number; readonly bmdt: bigint };
    readonly trun: {
        readonly version: number;
        readonly flags: number;
        readonly sampleCount: number;
        readonly dataOffset: number;
        readonly firstSampleFlags: number | undefined;
        readonly samples: readonly InspectedTrunSample[];
    };
    readonly saiz: { readonly defaultSize: number; readonly sampleCount: number; readonly sizes: readonly number[] } | undefined;
    readonly saio: { readonly offsets: readonly number[] } | undefined;
    readonly senc: {
        readonly flags: number;
        readonly samples: ReadonlyArray<{ readonly iv: Uint8Array; readonly subsamples: ReadonlyArray<readonly [number, number]> }>;
    } | undefined;
    readonly mdatHeaderSize: number;
    readonly mdat: Uint8Array;
}

function type(b: Uint8Array, at: number): string {
    return String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
}

function children(b: Uint8Array, start: number, end: number): Array<{ type: string; start: number; end: number }> {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: Array<{ type: string; start: number; end: number }> = [];
    for (let pos = start; pos < end;) {
        const size = v.getUint32(pos);
        if (size < 8 || pos + size > end) throw new Error(`bad box size ${size} at ${pos}`);
        out.push({ type: type(b, pos + 4), start: pos, end: pos + size });
        pos += size;
    }
    return out;
}

/** Parse a single-traf CMAF chunk. `ivSize` is needed to split senc IVs. */
export function inspectChunk(bytes: Uint8Array, ivSize = 0): InspectedChunk {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const top = children(bytes, 0, bytes.length);
    const moofIndex = top.findIndex((x) => x.type === 'moof');
    if (moofIndex < 0) throw new Error('no moof');
    const moofBox = top[moofIndex]!;
    const mdatBox = top[moofIndex + 1];
    if (mdatBox?.type !== 'mdat') throw new Error('mdat does not follow moof');
    const moofKids = children(bytes, moofBox.start + 8, moofBox.end);
    const mfhd = moofKids.find((x) => x.type === 'mfhd')!;
    const traf = moofKids.find((x) => x.type === 'traf')!;
    const trafKids = children(bytes, traf.start + 8, traf.end);
    const box = (t: string) => trafKids.find((x) => x.type === t);

    const tfhdBox = box('tfhd')!;
    const tfFlags = v.getUint32(tfhdBox.start + 8) & 0xffffff;
    let p = tfhdBox.start + 12;
    const trackId = v.getUint32(p);
    p += 4;
    if (tfFlags & 0x01) p += 8;
    const opt = (bit: number): number | undefined => {
        if (!(tfFlags & bit)) return undefined;
        const value = v.getUint32(p);
        p += 4;
        return value;
    };
    const sampleDescriptionIndex = opt(0x02);
    const defaultSampleDuration = opt(0x08);
    const defaultSampleSize = opt(0x10);
    const defaultSampleFlags = opt(0x20);

    const tfdtBox = box('tfdt')!;
    const tfdtVersion = bytes[tfdtBox.start + 8]!;
    const bmdt = tfdtVersion === 1 ? v.getBigUint64(tfdtBox.start + 12) : BigInt(v.getUint32(tfdtBox.start + 12));

    const trunBox = box('trun')!;
    const trVersion = bytes[trunBox.start + 8]!;
    const trFlags = v.getUint32(trunBox.start + 8) & 0xffffff;
    let q = trunBox.start + 12;
    const sampleCount = v.getUint32(q);
    q += 4;
    let dataOffset = 0;
    if (trFlags & 0x01) { dataOffset = v.getInt32(q); q += 4; }
    let firstSampleFlags: number | undefined;
    if (trFlags & 0x04) { firstSampleFlags = v.getUint32(q); q += 4; }
    const samples: InspectedTrunSample[] = [];
    for (let i = 0; i < sampleCount; i++) {
        const read = (bit: number, signed = false): number | undefined => {
            if (!(trFlags & bit)) return undefined;
            const value = signed ? v.getInt32(q) : v.getUint32(q);
            q += 4;
            return value;
        };
        const duration = read(0x100);
        const size = read(0x200);
        const flags = read(0x400);
        const cto = read(0x800, trVersion === 1);
        samples.push({ duration, size, flags, cto });
    }

    const saizBox = box('saiz');
    let saiz: InspectedChunk['saiz'];
    if (saizBox) {
        const flags = v.getUint32(saizBox.start + 8) & 0xffffff;
        let r = saizBox.start + 12 + (flags & 1 ? 8 : 0);
        const defaultSize = bytes[r]!;
        const count = v.getUint32(r + 1);
        r += 5;
        saiz = { defaultSize, sampleCount: count, sizes: defaultSize === 0 ? [...bytes.subarray(r, r + count)] : [] };
    }
    const saioBox = box('saio');
    let saio: InspectedChunk['saio'];
    if (saioBox) {
        const version = bytes[saioBox.start + 8]!;
        const flags = v.getUint32(saioBox.start + 8) & 0xffffff;
        let r = saioBox.start + 12 + (flags & 1 ? 8 : 0);
        const count = v.getUint32(r);
        r += 4;
        const offsets: number[] = [];
        for (let i = 0; i < count; i++) {
            offsets.push(version === 1 ? Number(v.getBigUint64(r)) : v.getUint32(r));
            r += version === 1 ? 8 : 4;
        }
        saio = { offsets };
    }
    const sencBox = box('senc');
    let senc: InspectedChunk['senc'];
    if (sencBox) {
        const flags = v.getUint32(sencBox.start + 8) & 0xffffff;
        const count = v.getUint32(sencBox.start + 12);
        let r = sencBox.start + 16;
        const sencSamples: Array<{ iv: Uint8Array; subsamples: Array<readonly [number, number]> }> = [];
        for (let i = 0; i < count; i++) {
            const iv = bytes.slice(r, r + ivSize);
            r += ivSize;
            const subsamples: Array<readonly [number, number]> = [];
            if (flags & 2) {
                const n = v.getUint16(r);
                r += 2;
                for (let j = 0; j < n; j++) {
                    subsamples.push([v.getUint16(r), v.getUint32(r + 2)]);
                    r += 6;
                }
            }
            sencSamples.push({ iv, subsamples });
        }
        senc = { flags, samples: sencSamples };
    }

    return {
        boxes: top.map((x) => x.type),
        preMoof: top.slice(0, moofIndex).map((x) => ({ type: x.type, bytes: bytes.slice(x.start, x.end) })),
        moof: bytes.slice(moofBox.start, moofBox.end),
        mfhdSequence: v.getUint32(mfhd.start + 12),
        trafOrder: trafKids.map((x) => x.type),
        tfhd: { flags: tfFlags, trackId, sampleDescriptionIndex, defaultSampleDuration, defaultSampleSize, defaultSampleFlags },
        tfdt: { version: tfdtVersion, bmdt },
        trun: { version: trVersion, flags: trFlags, sampleCount, dataOffset, firstSampleFlags, samples },
        saiz,
        saio,
        senc,
        mdatHeaderSize: 8,
        mdat: bytes.slice(mdatBox.start + 8, mdatBox.end),
    };
}
