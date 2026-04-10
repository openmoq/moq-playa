/**
 * Tests for the ISOBMFF helpers in mp4-box.ts.
 *
 * Focuses on the helpers added for the timeline-owned append path:
 *   - readSegmentTimeRanges — tri-state contract + diagnostics
 *   - readTrexDefaults — init segment parsing for trex defaults
 *
 * Other helpers (findTfdtOffset, readBaseMediaDecodeTime,
 * patchBaseMediaDecodeTime, peekSegmentMetadata) have existing
 * coverage via cmaf-assembler.test.ts.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
    readSegmentTimeRanges,
    readTrexDefaults,
    type DiagnosticKind,
    type SegmentTimeRange,
    type TrexDefaults,
    getHevcNalType,
    isHevcVclNalType,
    isHevcRaslNalType,
    isHevcCraNalType,
    firstHevcVclNalType,
    parseTfhdDefaults,
    iterateTrunSamples,
    rewriteFragmentDropSamples,
    boxType,
    boxSize,
    type TrunSample,
} from './mp4-box.js';

// ─── Byte-building primitives ─────────────────────────────────────

/** Concatenate byte arrays. */
function cat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.byteLength;
    }
    return out;
}

/** 32-bit big-endian unsigned integer. */
function u32(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n);
    return out;
}

/** 64-bit big-endian unsigned integer. */
function u64(n: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, n);
    return out;
}

/** ASCII-encoded 4-char box type. */
function fourcc(type: string): Uint8Array {
    if (type.length !== 4) throw new Error(`fourcc must be 4 chars: "${type}"`);
    return new TextEncoder().encode(type);
}

/**
 * Build a generic ISOBMFF box: size(4) + type(4) + body.
 * Size includes the 8-byte header.
 */
function box(type: string, body: Uint8Array): Uint8Array {
    const size = 8 + body.byteLength;
    return cat(u32(size), fourcc(type), body);
}

/**
 * Build a FullBox: size(4) + type(4) + version(1) + flags(3) + body.
 */
function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
    const vf = new Uint8Array(4);
    vf[0] = version & 0xff;
    vf[1] = (flags >> 16) & 0xff;
    vf[2] = (flags >> 8) & 0xff;
    vf[3] = flags & 0xff;
    return box(type, cat(vf, body));
}

// ─── Box-specific builders ────────────────────────────────────────

/** tfdt v0: 32-bit bmd. */
function tfdtV0(bmd: number): Uint8Array {
    return fullBox('tfdt', 0, 0, u32(bmd));
}

/** tfdt v1: 64-bit bmd. */
function tfdtV1(bmd: bigint): Uint8Array {
    return fullBox('tfdt', 1, 0, u64(bmd));
}

/**
 * tfhd with specific flags + (trackId, optional default_sample_duration).
 * We only write the fields actually indicated by the flags — matches
 * how real encoders emit.
 */
function tfhd(opts: {
    trackId: number;
    defaultSampleDuration?: number;
}): Uint8Array {
    let flags = 0;
    const parts: Uint8Array[] = [u32(opts.trackId)];
    if (opts.defaultSampleDuration !== undefined) {
        flags |= 0x000008;
        parts.push(u32(opts.defaultSampleDuration));
    }
    return fullBox('tfhd', 0, flags, cat(...parts));
}

/**
 * trun with per-sample durations (optionally also sizes/flags/ctos, to
 * exercise the record-stride math).
 */
function trunPerSampleDuration(opts: {
    sampleDurations: readonly number[];
    includeSize?: boolean;
    includeFlags?: boolean;
    includeCto?: boolean;
}): Uint8Array {
    let flags = 0x000100; // sample_duration present
    if (opts.includeSize) flags |= 0x000200;
    if (opts.includeFlags) flags |= 0x000400;
    if (opts.includeCto) flags |= 0x000800;

    const sampleCount = opts.sampleDurations.length;
    const perSample: Uint8Array[] = [];
    for (const d of opts.sampleDurations) {
        perSample.push(u32(d));
        if (opts.includeSize) perSample.push(u32(0));
        if (opts.includeFlags) perSample.push(u32(0));
        if (opts.includeCto) perSample.push(u32(0));
    }

    return fullBox('trun', 0, flags, cat(u32(sampleCount), ...perSample));
}

/** trun without per-sample duration — relies on tfhd/trex default. */
function trunNoPerSampleDuration(sampleCount: number): Uint8Array {
    return fullBox('trun', 0, 0, u32(sampleCount));
}

function traf(children: readonly Uint8Array[]): Uint8Array {
    return box('traf', cat(...children));
}

function moof(children: readonly Uint8Array[]): Uint8Array {
    return box('moof', cat(...children));
}

/** Minimal mdat with the specified number of bytes of zeroed payload. */
function mdat(size: number): Uint8Array {
    return box('mdat', new Uint8Array(size));
}

/** styp(sidx?) prefix for CMAF segments. */
function styp(): Uint8Array {
    return box('styp', fourcc('cmfc'));
}

/** Build a trex box (fixed-layout). */
function trex(opts: {
    trackId: number;
    defaultSampleDuration: number;
}): Uint8Array {
    return fullBox(
        'trex',
        0,
        0,
        cat(
            u32(opts.trackId),
            u32(1),                              // default_sample_description_index
            u32(opts.defaultSampleDuration),     // default_sample_duration
            u32(0),                              // default_sample_size
            u32(0),                              // default_sample_flags
        ),
    );
}

function mvex(trexes: readonly Uint8Array[]): Uint8Array {
    return box('mvex', cat(...trexes));
}

function moov(children: readonly Uint8Array[]): Uint8Array {
    return box('moov', cat(...children));
}

// ─── Diagnostic spy ───────────────────────────────────────────────

function makeSpy() {
    const calls: Array<{ kind: DiagnosticKind; detail: string }> = [];
    const spy = (kind: DiagnosticKind, detail: string) => {
        calls.push({ kind, detail });
    };
    return { spy, calls };
}

// ─── readSegmentTimeRanges tests ──────────────────────────────────

describe('readSegmentTimeRanges', () => {
    it('case 1: tfdt v0 + tfhd default + trun without per-sample', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 100 }),
                tfdtV0(1000),
                trunNoPerSampleDuration(5),
            ])]),
            mdat(10),
        );
        const result = readSegmentTimeRanges(segment);
        expect(result).toEqual([{
            startTime: 1000n,
            endTime: 1500n,    // 1000 + 5 × 100
            sampleCount: 5,
        } satisfies SegmentTimeRange]);
    });

    it('case 2: tfdt v1 (uint64) + trun per-sample durations ignores tfhd default', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 999 }),  // should be ignored
                tfdtV1(2n ** 33n),                                  // large bmd
                trunPerSampleDuration({ sampleDurations: [100, 200, 300] }),
            ])]),
            mdat(10),
        );
        const result = readSegmentTimeRanges(segment);
        expect(result).toEqual([{
            startTime: 2n ** 33n,
            endTime: 2n ** 33n + 600n,  // 100+200+300, ignores tfhd default
            sampleCount: 3,
        }]);
    });

    it('case 3: no tfhd default + no per-sample + trex fallback', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1 }),     // no default_sample_duration
                tfdtV0(0),
                trunNoPerSampleDuration(4),
            ])]),
            mdat(10),
        );
        const trexDefault: TrexDefaults = { trackId: 1, defaultSampleDuration: 50 };
        const result = readSegmentTimeRanges(segment, trexDefault);
        expect(result).toEqual([{
            startTime: 0n,
            endTime: 200n,   // 4 × 50
            sampleCount: 4,
        }]);
    });

    it('case 4: no tfhd default + no per-sample + no trex → null + no-duration diagnostic', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1 }),
                tfdtV0(0),
                trunNoPerSampleDuration(4),
            ])]),
            mdat(10),
        );
        const { spy, calls } = makeSpy();
        const result = readSegmentTimeRanges(segment, undefined, spy);
        expect(result).toBeNull();
        expect(calls.map((c) => c.kind)).toEqual(['no-duration']);
    });

    it('case 5: multiple truns in one traf sum across truns', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 10 }),
                tfdtV0(500),
                trunNoPerSampleDuration(3),
                trunNoPerSampleDuration(2),
                trunPerSampleDuration({ sampleDurations: [7, 8] }),
            ])]),
            mdat(10),
        );
        const result = readSegmentTimeRanges(segment);
        // 3×10 + 2×10 + (7+8) = 30 + 20 + 15 = 65
        expect(result).toEqual([{
            startTime: 500n,
            endTime: 565n,
            sampleCount: 7,
        }]);
    });

    it('case 6: multiple moofs in one payload return one range per moof', () => {
        const moof1 = moof([traf([
            tfhd({ trackId: 1, defaultSampleDuration: 100 }),
            tfdtV0(0),
            trunNoPerSampleDuration(3),
        ])]);
        const moof2 = moof([traf([
            tfhd({ trackId: 1, defaultSampleDuration: 100 }),
            tfdtV0(300),
            trunNoPerSampleDuration(2),
        ])]);
        const segment = cat(moof1, mdat(10), moof2, mdat(10));
        const result = readSegmentTimeRanges(segment);
        expect(result).toEqual([
            { startTime: 0n, endTime: 300n, sampleCount: 3 },
            { startTime: 300n, endTime: 500n, sampleCount: 2 },
        ]);
    });

    it('case 7: missing tfdt on a moof → null + no-tfdt diagnostic', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 100 }),
                trunNoPerSampleDuration(3),
                // no tfdt
            ])]),
            mdat(10),
        );
        const { spy, calls } = makeSpy();
        const result = readSegmentTimeRanges(segment, undefined, spy);
        expect(result).toBeNull();
        expect(calls.map((c) => c.kind)).toEqual(['no-tfdt']);
    });

    it('case 8: styp prefix is walked past', () => {
        const segment = cat(
            styp(),
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 100 }),
                tfdtV0(0),
                trunNoPerSampleDuration(2),
            ])]),
            mdat(10),
        );
        const result = readSegmentTimeRanges(segment);
        expect(result).toEqual([{
            startTime: 0n,
            endTime: 200n,
            sampleCount: 2,
        }]);
    });

    it('case 9: large bmd near uint64 max preserved as bigint', () => {
        const largeBmd = 2n ** 62n;  // beyond Number.MAX_SAFE_INTEGER
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 1 }),
                tfdtV1(largeBmd),
                trunNoPerSampleDuration(1),
            ])]),
            mdat(10),
        );
        const result = readSegmentTimeRanges(segment);
        expect(result).not.toBeNull();
        expect(result![0]!.startTime).toBe(largeBmd);
        expect(result![0]!.endTime).toBe(largeBmd + 1n);
    });

    it('case 10: trun with sampleCount 0 yields startTime == endTime', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 100 }),
                tfdtV0(750),
                trunNoPerSampleDuration(0),
            ])]),
            mdat(10),
        );
        const result = readSegmentTimeRanges(segment);
        expect(result).toEqual([{
            startTime: 750n,
            endTime: 750n,
            sampleCount: 0,
        }]);
    });

    it('case 11: multi-traf → null + multi-traf diagnostic', () => {
        const t1 = traf([
            tfhd({ trackId: 1, defaultSampleDuration: 100 }),
            tfdtV0(0),
            trunNoPerSampleDuration(1),
        ]);
        const t2 = traf([
            tfhd({ trackId: 2, defaultSampleDuration: 100 }),
            tfdtV0(0),
            trunNoPerSampleDuration(1),
        ]);
        const segment = cat(moof([t1, t2]), mdat(10));
        const { spy, calls } = makeSpy();
        const result = readSegmentTimeRanges(segment, undefined, spy);
        expect(result).toBeNull();
        expect(calls.map((c) => c.kind)).toEqual(['multi-traf']);
    });

    it('case 12: traf with no trun → null + no-trun diagnostic', () => {
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 100 }),
                tfdtV0(0),
                // no trun
            ])]),
            mdat(10),
        );
        const { spy, calls } = makeSpy();
        const result = readSegmentTimeRanges(segment, undefined, spy);
        expect(result).toBeNull();
        expect(calls.map((c) => c.kind)).toEqual(['no-trun']);
    });

    it('case 13: per-moof failure drops whole multi-moof payload', () => {
        const healthy = moof([traf([
            tfhd({ trackId: 1, defaultSampleDuration: 100 }),
            tfdtV0(0),
            trunNoPerSampleDuration(2),
        ])]);
        const broken = moof([traf([
            tfhd({ trackId: 1 }),                // no default
            tfdtV0(500),
            trunNoPerSampleDuration(2),           // no per-sample either, no trex given
        ])]);
        const segment = cat(healthy, mdat(10), broken, mdat(10));
        const { spy, calls } = makeSpy();
        const result = readSegmentTimeRanges(segment, undefined, spy);
        expect(result).toBeNull();
        expect(calls.map((c) => c.kind)).toEqual(['no-duration']);
    });

    it('moof-less payload returns [] (fail open)', () => {
        const segment = cat(mdat(100));
        const result = readSegmentTimeRanges(segment);
        expect(result).toEqual([]);
    });

    it('trun with per-sample + size + flags + cto correctly strides', () => {
        // Verify record stride math when multiple per-sample fields are present.
        const segment = cat(
            moof([traf([
                tfhd({ trackId: 1, defaultSampleDuration: 999 }),
                tfdtV0(0),
                trunPerSampleDuration({
                    sampleDurations: [11, 22, 33],
                    includeSize: true,
                    includeFlags: true,
                    includeCto: true,
                }),
            ])]),
            mdat(10),
        );
        const result = readSegmentTimeRanges(segment);
        expect(result).toEqual([{
            startTime: 0n,
            endTime: 66n, // 11+22+33
            sampleCount: 3,
        }]);
    });
});

// ─── readTrexDefaults tests ───────────────────────────────────────

describe('readTrexDefaults', () => {
    it('returns a single trex entry keyed by track_id', () => {
        const init = moov([mvex([trex({ trackId: 1, defaultSampleDuration: 100 })])]);
        const result = readTrexDefaults(init);
        expect(result.size).toBe(1);
        expect(result.get(1)).toEqual({
            trackId: 1,
            defaultSampleDuration: 100,
            defaultSampleSize: 0,
            defaultSampleFlags: 0,
        });
    });

    it('returns multiple trex entries for multi-track inits', () => {
        const init = moov([
            mvex([
                trex({ trackId: 1, defaultSampleDuration: 100 }),
                trex({ trackId: 2, defaultSampleDuration: 50 }),
            ]),
        ]);
        const result = readTrexDefaults(init);
        expect(result.size).toBe(2);
        expect(result.get(1)!.defaultSampleDuration).toBe(100);
        expect(result.get(2)!.defaultSampleDuration).toBe(50);
    });

    it('returns empty map when no mvex is present', () => {
        const init = moov([]);
        const result = readTrexDefaults(init);
        expect(result.size).toBe(0);
    });

    it('returns trex with defaultSampleDuration 0 as-is (caller handles the sentinel)', () => {
        const init = moov([mvex([trex({ trackId: 1, defaultSampleDuration: 0 })])]);
        const result = readTrexDefaults(init);
        expect(result.get(1)).toEqual({
            trackId: 1,
            defaultSampleDuration: 0,
            defaultSampleSize: 0,
            defaultSampleFlags: 0,
        });
    });

    it('returns empty map for an init with no moov', () => {
        const init = cat(styp());
        const result = readTrexDefaults(init);
        expect(result.size).toBe(0);
    });
});

// ─── HEVC NAL helpers ────────────────────────────────────────────────

describe('HEVC NAL helpers', () => {
    function nalHeader(nalType: number): Uint8Array {
        // forbidden_zero_bit(1) | nal_unit_type(6) | nuh_layer_id high (1)
        // followed by nuh_layer_id low(5) | nuh_temporal_id_plus1(3)
        return new Uint8Array([(nalType & 0x3f) << 1, 0x01]);
    }

    /** Build a sample's bytes from a sequence of NAL units (length-prefixed). */
    function lpSample(...nals: Uint8Array[]): Uint8Array {
        const parts: Uint8Array[] = [];
        for (const n of nals) {
            parts.push(u32(n.byteLength));
            parts.push(n);
        }
        return cat(...parts);
    }

    it('getHevcNalType extracts the 6-bit type from the first byte', () => {
        expect(getHevcNalType(nalHeader(21))).toBe(21); // CRA
        expect(getHevcNalType(nalHeader(20))).toBe(20); // IDR_N_LP
        expect(getHevcNalType(nalHeader(9))).toBe(9);   // RASL_R
        expect(getHevcNalType(nalHeader(8))).toBe(8);   // RASL_N
        expect(getHevcNalType(nalHeader(0))).toBe(0);
        expect(getHevcNalType(nalHeader(63))).toBe(63);
    });

    it('getHevcNalType returns -1 for empty input', () => {
        expect(getHevcNalType(new Uint8Array(0))).toBe(-1);
    });

    it('isHevcVclNalType distinguishes VCL (0..31) from non-VCL (32+)', () => {
        for (let t = 0; t <= 31; t++) expect(isHevcVclNalType(t)).toBe(true);
        for (const t of [32, 33, 34, 35, 39, 40, 63]) {
            expect(isHevcVclNalType(t)).toBe(false);
        }
    });

    it('isHevcRaslNalType matches only 8 and 9', () => {
        expect(isHevcRaslNalType(8)).toBe(true);
        expect(isHevcRaslNalType(9)).toBe(true);
        for (const t of [0, 1, 7, 10, 19, 20, 21]) {
            expect(isHevcRaslNalType(t)).toBe(false);
        }
    });

    it('isHevcCraNalType matches only 21', () => {
        expect(isHevcCraNalType(21)).toBe(true);
        for (const t of [19, 20, 22, 0, 9]) {
            expect(isHevcCraNalType(t)).toBe(false);
        }
    });

    it('firstHevcVclNalType skips parameter-set/SEI/AUD NALs', () => {
        // AUD(35) + VPS(32) + SPS(33) + PPS(34) + SEI(39) + CRA(21) + TRAIL(1)
        const sample = lpSample(
            nalHeader(35), nalHeader(32), nalHeader(33), nalHeader(34),
            nalHeader(39), nalHeader(21), nalHeader(1),
        );
        expect(firstHevcVclNalType(sample)).toBe(21);
    });

    it('firstHevcVclNalType returns null when no VCL NAL is present', () => {
        // Only AUD + VPS + SPS + PPS — no VCL
        const sample = lpSample(
            nalHeader(35), nalHeader(32), nalHeader(33), nalHeader(34),
        );
        expect(firstHevcVclNalType(sample)).toBeNull();
    });

    it('firstHevcVclNalType returns null on length-zero NAL (defends against malformed)', () => {
        // length-prefix says 0 → return null instead of looping
        const malformed = u32(0);
        expect(firstHevcVclNalType(malformed)).toBeNull();
    });

    it('firstHevcVclNalType returns null on length-overflow (defends against malformed)', () => {
        // length-prefix says 100 but only 5 bytes follow
        const malformed = cat(u32(100), nalHeader(21), new Uint8Array([0, 0, 0]));
        expect(firstHevcVclNalType(malformed)).toBeNull();
    });
});

// ─── parseTfhdDefaults / iterateTrunSamples / rewriteFragmentDropSamples ───

describe('parseTfhdDefaults', () => {
    /**
     * Build a tfhd with arbitrary flag combinations. Body layout:
     *   track_ID + [base_data_offset 8b] + [sample_desc_idx 4b] +
     *   [default_sample_duration 4b] + [default_sample_size 4b] +
     *   [default_sample_flags 4b]
     */
    function tfhdRich(opts: {
        trackId: number;
        baseDataOffset?: bigint;
        sampleDescIdx?: number;
        defaultSampleDuration?: number;
        defaultSampleSize?: number;
        defaultSampleFlags?: number;
    }): Uint8Array {
        let flags = 0;
        const parts: Uint8Array[] = [u32(opts.trackId)];
        if (opts.baseDataOffset !== undefined) {
            flags |= 0x000001;
            parts.push(u64(opts.baseDataOffset));
        }
        if (opts.sampleDescIdx !== undefined) {
            flags |= 0x000002;
            parts.push(u32(opts.sampleDescIdx));
        }
        if (opts.defaultSampleDuration !== undefined) {
            flags |= 0x000008;
            parts.push(u32(opts.defaultSampleDuration));
        }
        if (opts.defaultSampleSize !== undefined) {
            flags |= 0x000010;
            parts.push(u32(opts.defaultSampleSize));
        }
        if (opts.defaultSampleFlags !== undefined) {
            flags |= 0x000020;
            parts.push(u32(opts.defaultSampleFlags));
        }
        return fullBox('tfhd', 0, flags, cat(...parts));
    }

    it('reads all three defaults when their flags are set', () => {
        const box = tfhdRich({
            trackId: 1,
            defaultSampleDuration: 3000,
            defaultSampleSize: 8192,
            defaultSampleFlags: 0x01010000,
        });
        const out = parseTfhdDefaults(box);
        expect(out.defaultSampleDuration).toBe(3000);
        expect(out.defaultSampleSize).toBe(8192);
        expect(out.defaultSampleFlags).toBe(0x01010000);
    });

    it('skips fields whose flags are not set', () => {
        const box = tfhdRich({ trackId: 1, defaultSampleSize: 100 });
        const out = parseTfhdDefaults(box);
        expect(out.defaultSampleDuration).toBeUndefined();
        expect(out.defaultSampleSize).toBe(100);
        expect(out.defaultSampleFlags).toBeUndefined();
    });

    it('honors leading base_data_offset / sample_description_index advances', () => {
        // All five fields present — confirm offset arithmetic skips the first two
        const box = tfhdRich({
            trackId: 1,
            baseDataOffset: 0xABCDn,
            sampleDescIdx: 2,
            defaultSampleDuration: 1500,
            defaultSampleSize: 256,
            defaultSampleFlags: 0xDEADBEEF,
        });
        const out = parseTfhdDefaults(box);
        expect(out.defaultSampleDuration).toBe(1500);
        expect(out.defaultSampleSize).toBe(256);
        expect(out.defaultSampleFlags).toBe(0xDEADBEEF);
    });
});

describe('iterateTrunSamples', () => {
    /**
     * Build a trun with explicit per-sample arrays. Each sample's record
     * is the concatenation of present fields in the standard order:
     *   [duration if 0x100] [size if 0x200] [flags if 0x400] [cto if 0x800]
     */
    function trunRich(opts: {
        version?: number;
        dataOffset?: number;
        firstSampleFlags?: number;
        samples: ReadonlyArray<{ duration?: number; size?: number; flags?: number; cto?: number }>;
    }): Uint8Array {
        let flags = 0;
        if (opts.dataOffset !== undefined) flags |= 0x000001;
        if (opts.firstSampleFlags !== undefined) flags |= 0x000004;
        const first = opts.samples[0];
        if (first?.duration !== undefined) flags |= 0x000100;
        if (first?.size !== undefined) flags |= 0x000200;
        if (first?.flags !== undefined) flags |= 0x000400;
        if (first?.cto !== undefined) flags |= 0x000800;

        const body: Uint8Array[] = [u32(opts.samples.length)];
        if (opts.dataOffset !== undefined) body.push(u32(opts.dataOffset));
        if (opts.firstSampleFlags !== undefined) body.push(u32(opts.firstSampleFlags));
        for (const s of opts.samples) {
            if ((flags & 0x000100) !== 0) body.push(u32(s.duration ?? 0));
            if ((flags & 0x000200) !== 0) body.push(u32(s.size ?? 0));
            if ((flags & 0x000400) !== 0) body.push(u32(s.flags ?? 0));
            if ((flags & 0x000800) !== 0) body.push(u32(s.cto ?? 0));
        }
        return fullBox('trun', opts.version ?? 0, flags, cat(...body));
    }

    it('yields per-sample fields when all flags are set', () => {
        const trun = trunRich({
            samples: [
                { duration: 3000, size: 100, flags: 0x01, cto: 0 },
                { duration: 3000, size: 200, flags: 0x02, cto: 50 },
                { duration: 3000, size: 50,  flags: 0x03, cto: 100 },
            ],
        });
        const out = iterateTrunSamples(trun, {});
        expect(out).not.toBeNull();
        expect(out!.length).toBe(3);
        expect(out![0]).toMatchObject({ index: 0, mdatOffset: 0, size: 100, duration: 3000, flags: 0x01 });
        expect(out![1]).toMatchObject({ index: 1, mdatOffset: 100, size: 200, duration: 3000, flags: 0x02, ctsOffset: 50 });
        expect(out![2]).toMatchObject({ index: 2, mdatOffset: 300, size: 50, duration: 3000, flags: 0x03, ctsOffset: 100 });
    });

    it('uses tfhd defaults when trun lacks per-sample fields', () => {
        const trun = trunRich({ samples: [{}, {}, {}] }); // sample_count=3, no per-sample
        const out = iterateTrunSamples(trun, {
            defaultSampleDuration: 1500,
            defaultSampleSize: 64,
            defaultSampleFlags: 0xCAFE,
        });
        expect(out).not.toBeNull();
        for (let i = 0; i < 3; i++) {
            expect(out![i]).toMatchObject({
                size: 64, duration: 1500, flags: 0xCAFE, mdatOffset: i * 64,
            });
        }
    });

    it('falls back to trex defaults when neither tfhd nor trun supply duration', () => {
        const trun = trunRich({ samples: [{ size: 10 }, { size: 20 }] }); // size only
        const out = iterateTrunSamples(trun, { defaultSampleSize: 0 }, {
            trackId: 1, defaultSampleDuration: 999,
        });
        expect(out![0]!.duration).toBe(999);
        expect(out![1]!.duration).toBe(999);
    });

    it('first_sample_flags overrides for sample 0 only', () => {
        const trun = trunRich({
            firstSampleFlags: 0xFFFF,
            samples: [{ flags: 0x0001 }, { flags: 0x0002 }],
        });
        const out = iterateTrunSamples(trun, {});
        expect(out![0]!.flags).toBe(0xFFFF); // overridden
        expect(out![1]!.flags).toBe(0x0002); // per-sample preserved
    });

    it('returns null when sample_count exceeds available bytes', () => {
        // Fake a trun that claims 100 samples but has bytes for 0
        const trun = fullBox('trun', 0, 0x000200, cat(u32(100))); // size flag + count, no records
        const out = iterateTrunSamples(trun, {});
        expect(out).toBeNull();
    });
});

describe('rewriteFragmentDropSamples', () => {
    /**
     * trun + tfhd + traf + moof + mdat where each sample has explicit
     * size AND duration. Per-sample durations are required by the
     * rewriter (so it can extend the last kept sample to absorb dropped
     * sample time) — real CMAF fragments include them.
     */
    function buildFragment(opts: {
        sampleSizes: readonly number[];
        sampleDuration?: number;
    }): Uint8Array {
        const totalBytes = opts.sampleSizes.reduce((a, b) => a + b, 0);
        const sampleDuration = opts.sampleDuration ?? 3000;
        // tfhd: default_sample_duration (kept for spec realism, even
        // though per-sample durations override it in trun)
        const tfhdBox = fullBox('tfhd', 0, 0x000008, cat(
            u32(1), // track_ID
            u32(sampleDuration),
        ));
        // trun: sample_duration (0x000100) + sample_size (0x000200) = 0x000300
        const trunBody: Uint8Array[] = [u32(opts.sampleSizes.length)];
        for (const sz of opts.sampleSizes) trunBody.push(u32(sampleDuration), u32(sz));
        const trunBox = fullBox('trun', 0, 0x000300, cat(...trunBody));
        const tfdt = fullBox('tfdt', 0, 0, u32(0));
        const trafBox = traf([tfhdBox, tfdt, trunBox]);
        const moofBox = moof([fullBox('mfhd', 0, 0, u32(1)), trafBox]);
        // mdat: all samples concatenated. Use bytes that encode the
        // sample index in every byte, so we can verify the right ranges
        // survive the rewrite.
        const mdatPayload = new Uint8Array(totalBytes);
        let p = 0;
        for (let i = 0; i < opts.sampleSizes.length; i++) {
            for (let k = 0; k < opts.sampleSizes[i]!; k++) {
                mdatPayload[p++] = i + 1; // sample 0 → byte value 1, etc.
            }
        }
        return cat(moofBox, box('mdat', mdatPayload));
    }

    function totalMdatPayload(segment: Uint8Array): Uint8Array {
        // Find mdat and return its payload (bytes after the 8-byte header).
        let pos = 0;
        while (pos + 8 <= segment.byteLength) {
            const t = boxType(segment, pos);
            const s = boxSize(segment, pos);
            if (t === 'mdat') return segment.subarray(pos + 8, pos + s);
            pos += s;
        }
        throw new Error('no mdat');
    }

    it('drops one sample and shrinks mdat + trun + traf + moof in lock-step', () => {
        const seg = buildFragment({ sampleSizes: [10, 20, 30, 40] });
        const dropMiddle = (s: TrunSample) => s.index === 1 || s.index === 2;
        const out = rewriteFragmentDropSamples(seg, dropMiddle);
        expect(out).not.toBeNull();

        // Box hierarchy size sanity: mdat now contains samples 0 + 3 = 50 bytes
        const newMdat = totalMdatPayload(out!);
        expect(newMdat.byteLength).toBe(10 + 40);
        // First 10 bytes should all be value 1 (sample 0); last 40 should be 4
        for (let i = 0; i < 10; i++) expect(newMdat[i]).toBe(1);
        for (let i = 10; i < 50; i++) expect(newMdat[i]).toBe(4);

        // The rewritten trun should declare 2 samples
        const trex = readSegmentTimeRanges(out!, undefined);
        expect(trex).not.toBeNull();
        expect(trex!.length).toBe(1);
        expect(trex![0]!.sampleCount).toBe(2);
    });

    it('returns null when nothing is dropped (caller can short-circuit)', () => {
        const seg = buildFragment({ sampleSizes: [10, 20, 30] });
        const out = rewriteFragmentDropSamples(seg, () => false);
        expect(out).toBeNull();
    });

    it('returns null on multi-traf moof', () => {
        const tfhdBox = fullBox('tfhd', 0, 0x000008, cat(u32(1), u32(3000)));
        const trunBox = fullBox('trun', 0, 0x000200, cat(u32(1), u32(10)));
        const trafA = traf([tfhdBox, trunBox]);
        const trafB = traf([tfhdBox, trunBox]);
        const moofBox = moof([fullBox('mfhd', 0, 0, u32(1)), trafA, trafB]);
        const seg = cat(moofBox, box('mdat', new Uint8Array(20)));
        expect(rewriteFragmentDropSamples(seg, () => true)).toBeNull();
    });

    it('returns null when tfhd uses base_data_offset (out of scope)', () => {
        // tfhd with base_data_offset (flag 0x1) + default_sample_duration
        const tfhdBox = fullBox('tfhd', 0, 0x000001 | 0x000008,
            cat(u32(1), u64(0x1000n), u32(3000)));
        const trunBox = fullBox('trun', 0, 0x000200, cat(u32(1), u32(10)));
        const trafBox = traf([tfhdBox, trunBox]);
        const moofBox = moof([fullBox('mfhd', 0, 0, u32(1)), trafBox]);
        const seg = cat(moofBox, box('mdat', new Uint8Array(10)));
        expect(rewriteFragmentDropSamples(seg, () => true)).toBeNull();
    });

    it('returns null on no-moof / no-mdat segment', () => {
        expect(rewriteFragmentDropSamples(cat(styp()), () => true)).toBeNull();
    });

    it('preserves a styp prefix verbatim', () => {
        const stypBox = styp();
        const seg = cat(stypBox, buildFragment({ sampleSizes: [10, 20] }));
        const out = rewriteFragmentDropSamples(seg, (s) => s.index === 0);
        expect(out).not.toBeNull();
        // styp is unchanged (same length, same bytes)
        expect(Array.from(out!.subarray(0, stypBox.byteLength)))
            .toEqual(Array.from(stypBox));
    });

    /**
     * Dropping samples in the middle (or end) of a fragment without
     * extending any kept sample's duration leaves a presentation-time
     * gap equal to the dropped samples' total duration. MSE-style
     * demuxers can't cross that gap and stall at the boundary. The
     * rewriter must extend the LAST kept sample so the fragment ends
     * at the publisher's intended decode-time end (next fragment's
     * bmd lines up).
     */
    it('extends the last kept sample\'s duration to absorb dropped sample time', () => {
        const sampleDuration = 3000;
        const seg = buildFragment({
            sampleSizes: [10, 20, 30, 40],
            sampleDuration,
        });
        // Drop samples 1 + 2 (middle) → last kept sample (index 3) must
        // gain 2 * sampleDuration of duration so the fragment still
        // covers 4 * sampleDuration ticks of decode time.
        const out = rewriteFragmentDropSamples(
            seg, (s) => s.index === 1 || s.index === 2,
        );
        expect(out).not.toBeNull();

        // Re-parse the rewritten trun, read per-sample durations.
        let newMoofOffset = -1;
        let pos = 0;
        while (pos + 8 <= out!.byteLength) {
            const t = boxType(out!, pos);
            const s = boxSize(out!, pos);
            if (t === 'moof') { newMoofOffset = pos; break; }
            pos += s;
        }
        const newMoof = out!.subarray(newMoofOffset, newMoofOffset + boxSize(out!, newMoofOffset));
        let q = 8; // skip moof header
        let firstDuration = -1;
        let lastDuration = -1;
        let sampleCount = -1;
        while (q + 8 <= newMoof.byteLength) {
            const tt = boxType(newMoof, q);
            const ss = boxSize(newMoof, q);
            if (tt === 'traf') {
                let r = q + 8;
                while (r + 8 <= q + ss) {
                    const ttt = boxType(newMoof, r);
                    const sss = boxSize(newMoof, r);
                    if (ttt === 'trun') {
                        const trunView = new DataView(
                            newMoof.buffer,
                            newMoof.byteOffset + r,
                            sss,
                        );
                        sampleCount = trunView.getUint32(12);
                        // No data_offset / first_sample_flags in this fixture →
                        // per-sample records start at offset 16.
                        // Each record = duration(4) + size(4) (flags 0x0300).
                        firstDuration = trunView.getUint32(16);
                        lastDuration = trunView.getUint32(16 + (sampleCount - 1) * 8);
                    }
                    r += sss;
                }
            }
            q += ss;
        }
        expect(sampleCount).toBe(2);
        expect(firstDuration).toBe(sampleDuration);              // unchanged
        expect(lastDuration).toBe(sampleDuration + 2 * sampleDuration); // bumped
    });

    /**
     * When the input trun uses `default_sample_duration` (no per-sample
     * durations) the rewriter must promote the trun to carry explicit
     * per-sample durations in the output, sourced from the defaults.
     * The output also gets `TRUN_FLAG_SAMPLE_DURATION` set and bumps
     * the last kept sample by the dropped samples' total duration.
     */
    it('promotes default_sample_duration to per-sample durations on output', () => {
        const defaultDuration = 3000;
        // tfhd: default_sample_duration only
        const tfhdBox = fullBox('tfhd', 0, 0x000008, cat(u32(1), u32(defaultDuration)));
        // trun: sample_size only (no per-sample duration)
        const trunBox = fullBox('trun', 0, 0x000200, cat(
            u32(3),
            u32(10), u32(20), u32(30),
        ));
        const trafBox = traf([tfhdBox, trunBox]);
        const moofBox = moof([fullBox('mfhd', 0, 0, u32(1)), trafBox]);
        const seg = cat(moofBox, box('mdat', new Uint8Array(60)));

        // Drop the middle sample → output trun must have flag 0x000300
        // (duration + size), and last kept sample's duration bumped by
        // 1 × defaultDuration.
        const out = rewriteFragmentDropSamples(seg, (s) => s.index === 1);
        expect(out).not.toBeNull();

        // Locate the new trun and read flags + per-sample durations.
        let pos = 0;
        let newMoofOffset = -1;
        while (pos + 8 <= out!.byteLength) {
            const t = boxType(out!, pos);
            const s = boxSize(out!, pos);
            if (t === 'moof') { newMoofOffset = pos; break; }
            pos += s;
        }
        const newMoof = out!.subarray(newMoofOffset, newMoofOffset + boxSize(out!, newMoofOffset));
        let q = 8;
        let flags = -1;
        let firstDuration = -1;
        let lastDuration = -1;
        let sampleCount = -1;
        while (q + 8 <= newMoof.byteLength) {
            const tt = boxType(newMoof, q);
            const ss = boxSize(newMoof, q);
            if (tt === 'traf') {
                let r = q + 8;
                while (r + 8 <= q + ss) {
                    const ttt = boxType(newMoof, r);
                    const sss = boxSize(newMoof, r);
                    if (ttt === 'trun') {
                        const trunView = new DataView(newMoof.buffer, newMoof.byteOffset + r, sss);
                        flags = (trunView.getUint8(9) << 16) | (trunView.getUint8(10) << 8) | trunView.getUint8(11);
                        sampleCount = trunView.getUint32(12);
                        // Per-sample records: [duration(4), size(4)] each.
                        firstDuration = trunView.getUint32(16);
                        lastDuration = trunView.getUint32(16 + (sampleCount - 1) * 8);
                    }
                    r += sss;
                }
            }
            q += ss;
        }
        expect(sampleCount).toBe(2);
        expect(flags & 0x000100).toBe(0x000100); // TRUN_FLAG_SAMPLE_DURATION set
        expect(flags & 0x000200).toBe(0x000200); // TRUN_FLAG_SAMPLE_SIZE preserved
        expect(firstDuration).toBe(defaultDuration);                // unchanged
        expect(lastDuration).toBe(defaultDuration + defaultDuration); // bumped by 1 dropped sample
    });

    /**
     * CMAF profile: tfhd has `default_base_is_moof` (0x020000) and trun
     * carries an explicit `data_offset` pointing at the start of the
     * mdat payload (= moofSize + 8 bytes from moof start). When the
     * rewriter shrinks the moof, the moof-relative data_offset MUST
     * shrink by the same amount or the demuxer reads sample bytes from
     * the wrong location ("Failed to prepare video sample for decode").
     */
    it('adjusts trun.data_offset when the moof shrinks (CMAF default_base_is_moof)', () => {
        const sampleSizes = [10, 20, 30];
        const totalBytes = sampleSizes.reduce((a, b) => a + b, 0);

        // tfhd: default_base_is_moof (0x020000) + default_sample_duration (0x000008)
        const tfhdBox = fullBox('tfhd', 0, 0x020000 | 0x000008, cat(
            u32(1), // track_ID
            u32(3000), // default_sample_duration
        ));
        const tfdt = fullBox('tfdt', 0, 0, u32(0));

        // We need to know moofSize before building trun (because data_offset
        // must point at moofSize + 8). Build with placeholder, measure, rebuild.
        const sampleDuration = 3000;
        const buildTrun = (dataOffset: number) => {
            // trun: data_offset (0x000001) + sample_duration (0x000100)
            //   + sample_size (0x000200) = 0x000301
            const body: Uint8Array[] = [
                u32(sampleSizes.length),
                // data_offset (signed int32, BE)
                (() => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, dataOffset); return b; })(),
            ];
            for (const sz of sampleSizes) body.push(u32(sampleDuration), u32(sz));
            return fullBox('trun', 0, 0x000301, cat(...body));
        };

        // First pass: dummy data_offset, measure moof
        const trunPlaceholder = buildTrun(0);
        const trafPlaceholder = traf([tfhdBox, tfdt, trunPlaceholder]);
        const moofPlaceholder = moof([fullBox('mfhd', 0, 0, u32(1)), trafPlaceholder]);
        const targetDataOffset = moofPlaceholder.byteLength + 8;

        // Second pass: real data_offset
        const trunBox = buildTrun(targetDataOffset);
        const trafBox = traf([tfhdBox, tfdt, trunBox]);
        const moofBox = moof([fullBox('mfhd', 0, 0, u32(1)), trafBox]);
        // Sanity: rebuilding with real offset didn't change moof size
        expect(moofBox.byteLength).toBe(moofPlaceholder.byteLength);

        // mdat: identifiable bytes per sample (sample i → byte value i+1)
        const mdatPayload = new Uint8Array(totalBytes);
        let p = 0;
        for (let i = 0; i < sampleSizes.length; i++) {
            for (let k = 0; k < sampleSizes[i]!; k++) mdatPayload[p++] = i + 1;
        }
        const seg = cat(moofBox, box('mdat', mdatPayload));

        const out = rewriteFragmentDropSamples(seg, (s) => s.index === 0);
        expect(out).not.toBeNull();

        // The rewritten trun must declare 2 samples and a data_offset that
        // still lands on the start of the (smaller) mdat payload.
        let newMoofOffset = -1;
        let newMdatOffset = -1;
        let pos = 0;
        while (pos + 8 <= out!.byteLength) {
            const t = boxType(out!, pos);
            const s = boxSize(out!, pos);
            if (t === 'moof') newMoofOffset = pos;
            if (t === 'mdat') newMdatOffset = pos;
            pos += s;
        }
        expect(newMoofOffset).toBeGreaterThanOrEqual(0);
        expect(newMdatOffset).toBeGreaterThan(newMoofOffset);

        // Walk into the new moof to find the new trun and read its
        // sample_count + data_offset.
        const newMoof = out!.subarray(newMoofOffset, newMoofOffset + boxSize(out!, newMoofOffset));
        let q = 8; // skip moof header
        let foundTrun = false;
        while (q + 8 <= newMoof.byteLength) {
            const t = boxType(newMoof, q);
            const s = boxSize(newMoof, q);
            if (t === 'traf') {
                let r = q + 8;
                while (r + 8 <= q + s) {
                    const tt = boxType(newMoof, r);
                    const ss = boxSize(newMoof, r);
                    if (tt === 'trun') {
                        const trunView = new DataView(
                            newMoof.buffer,
                            newMoof.byteOffset + r,
                            ss,
                        );
                        const sampleCount = trunView.getUint32(12);
                        const dataOffset = trunView.getInt32(16);
                        expect(sampleCount).toBe(2);
                        // data_offset, in moof-relative coordinates, should
                        // still equal newMoofSize + 8 (start of new mdat).
                        const expectedOffset = newMoof.byteLength + 8;
                        expect(dataOffset).toBe(expectedOffset);
                        foundTrun = true;
                    }
                    r += ss;
                }
            }
            q += s;
        }
        expect(foundTrun).toBe(true);

        // Sanity: walking samples via iterateTrunSamples on the rewritten
        // moof + mdat lands on the expected bytes (sample 1 → all 2s, etc.)
        const newMdat = totalMdatPayload(out!);
        expect(newMdat.byteLength).toBe(20 + 30);
        for (let i = 0; i < 20; i++) expect(newMdat[i]).toBe(2);
        for (let i = 20; i < 50; i++) expect(newMdat[i]).toBe(3);
    });
});
