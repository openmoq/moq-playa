/**
 * Track constants from the CMAF Header (draft-einarsson-moq-locmaf-01 sections
 * 4.1, 6 step 3, 13). Ported from the Java LocmafTrackContextTest.
 */
import { describe, it, expect } from 'vitest';
import { parseLocmafTrackContext } from './track-context.js';
import { LocmafFormatError } from './errors.js';
import { audioInit, buildInit, cencVideoInit, videoInit } from '../test-support/cmaf.js';
import { ascii, concat, indexOfFourcc, isoBox, u32 } from '../test-support/bytes.js';

function sectionOf(init: Uint8Array): string {
    try {
        parseLocmafTrackContext(init);
    } catch (e) {
        expect(e).toBeInstanceOf(LocmafFormatError);
        return (e as LocmafFormatError).section;
    }
    throw new Error('expected a LocmafFormatError');
}

describe('parseLocmafTrackContext', () => {
    it('extracts track constants from a video init', () => {
        const ctx = parseLocmafTrackContext(videoInit());
        expect(ctx.trackId).toBe(1);
        expect(ctx.timescale).toBe(90000);
        expect(ctx.handlerType).toBe('vide');
        expect(ctx.sampleEntryType).toBe('avc1');
        expect(ctx.codecFourcc).toBe('avc1');
        expect(ctx.isProtected).toBe(false);
        expect(ctx.perSampleIvSize).toBe(0);
        expect(ctx.defaultSampleDescriptionIndex).toBe(1);
        expect(ctx.defaultSampleDuration).toBe(0);
        expect(ctx.defaultSampleSize).toBe(0);
        expect(ctx.defaultSampleFlags).toBe(0);
    });

    it('extracts an audio track and non-zero trex defaults', () => {
        expect(parseLocmafTrackContext(audioInit())).toMatchObject({ trackId: 2, timescale: 48000, handlerType: 'soun' });
        const ctx = parseLocmafTrackContext(buildInit({
            trackId: 3, timescale: 48000, handler: 'soun',
            trex: { sampleDescriptionIndex: 2, duration: 1024, size: 300, flags: 0x02000000 },
        }));
        expect(ctx).toMatchObject({ defaultSampleDescriptionIndex: 2, defaultSampleDuration: 1024, defaultSampleSize: 300, defaultSampleFlags: 0x02000000 });
    });

    it('reads version-1 tkhd/mdhd and a 64-bit largesize moov', () => {
        const ctx = parseLocmafTrackContext(buildInit({ trackId: 7, timescale: 60000, handler: 'vide', headerVersion: 1, largesizeMoov: true }));
        expect(ctx.trackId).toBe(7);
        expect(ctx.timescale).toBe(60000);
    });

    it('reads tenc for an encrypted cenc sample entry', () => {
        const kid = new Uint8Array(16);
        kid[15] = 1;
        const ctx = parseLocmafTrackContext(buildInit({
            trackId: 1, timescale: 90000, handler: 'vide', encryption: { scheme: 'cenc', perSampleIvSize: 8, kid },
        }));
        expect(ctx.isProtected).toBe(true);
        expect(ctx.perSampleIvSize).toBe(8);
        expect(ctx.schemeType).toBe('cenc');
        expect(ctx.sampleEntryType).toBe('encv');
        expect(ctx.codecFourcc).toBe('avc1');
        expect(ctx.defaultKid).toEqual(kid);
        expect(ctx.constantIv).toBeNull();
    });

    it('reads a cbcs constant IV and an encrypted audio entry', () => {
        const cbcs = parseLocmafTrackContext(cencVideoInit(0));
        expect(cbcs).toMatchObject({ isProtected: true, perSampleIvSize: 0, schemeType: 'cbcs' });
        expect(cbcs.constantIv).toEqual(new Uint8Array(16));
        const enca = parseLocmafTrackContext(buildInit({
            trackId: 2, timescale: 48000, handler: 'soun', encryption: { scheme: 'cenc', perSampleIvSize: 16 },
        }));
        expect(enca).toMatchObject({ isProtected: true, perSampleIvSize: 16, sampleEntryType: 'enca', codecFourcc: 'mp4a' });
    });

    it('rejects a multi-track init (section 4.1)', () => {
        expect(sectionOf(buildInit({ trackId: 1, timescale: 90000, handler: 'vide', extraTraks: 1 }))).toBe('4.1');
    });

    it('rejects a missing moov or trex (section 6)', () => {
        expect(sectionOf(isoBox('ftyp', ascii('iso6'), u32(0)))).toBe('6');
        expect(sectionOf(buildInit({ trackId: 1, timescale: 90000, handler: 'vide', omitTrex: true }))).toBe('6');
        expect(sectionOf(new Uint8Array(0))).toBe('6');
    });

    it('accepts a header without sample entries, which reconstruction does not need (section 6 step 3)', () => {
        // The Eyevinn golden vectors ship clear-track inits with an empty stsd;
        // the Java reference rejected them.
        const ctx = parseLocmafTrackContext(buildInit({ trackId: 1, timescale: 90000, handler: 'vide', emptyStsd: true }));
        expect(ctx.sampleEntryType).toBeNull();
        expect(ctx.codecFourcc).toBeNull();
        expect(ctx.isProtected).toBe(false);
        expect(ctx.timescale).toBe(90000);
    });

    it('rejects an init whose first box declares an oversized size', () => {
        const bytes = concat(u32(0x80000000), ascii('free'), u32(8), ascii('moov'));
        expect(sectionOf(bytes)).toBe('6');
    });

    it('rejects a truncated moov child instead of reading past it', () => {
        const init = videoInit();
        const at = indexOfFourcc(init, 'mdhd') - 4;
        new DataView(init.buffer).setUint32(at, 12); // mdhd too short for its timescale
        expect(sectionOf(init)).toBe('6');
    });
});
