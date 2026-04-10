/**
 * Tests for VideoFrameMarking parsing and encoding.
 *
 * Test vectors derived from RFC 9626 §3.1 bit layout:
 * - First byte: S(1) E(1) I(1) D(1) B(1) TID(3)
 * - Second byte (optional): LID(8)
 *
 * Presence of second byte is determined by varint value >= 256 (LOC
 * encodes RFC 9626 flags in the least significant bits of a varint).
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.2
 * @see RFC 9626 §3.1
 */

import { describe, it, expect } from 'vitest';
import {
    parseVideoFrameMarking,
    encodeVideoFrameMarking,
} from './video.js';
import type { VideoFrameMarking } from './types.js';

describe('parseVideoFrameMarking', () => {
    // ─── Single-byte markings (no spatial layer) ──────────────────────

    it('parses independent keyframe — S=1 E=1 I=1 (§2.3.2.2)', () => {
        // S=1 E=1 I=1 D=0 B=0 TID=0 → 0b11100000 = 0xE0
        const marking = parseVideoFrameMarking(0xE0n);
        expect(marking.startOfFrame).toBe(true);
        expect(marking.endOfFrame).toBe(true);
        expect(marking.independent).toBe(true);
        expect(marking.discardable).toBe(false);
        expect(marking.baseLayerSync).toBe(false);
        expect(marking.temporalId).toBe(0);
        expect(marking.layerId).toBeUndefined();
    });

    it('parses discardable delta frame — D=1 (§2.3.2.2)', () => {
        // S=1 E=1 I=0 D=1 B=0 TID=0 → 0b11010000 = 0xD0
        const marking = parseVideoFrameMarking(0xD0n);
        expect(marking.startOfFrame).toBe(true);
        expect(marking.endOfFrame).toBe(true);
        expect(marking.independent).toBe(false);
        expect(marking.discardable).toBe(true);
        expect(marking.baseLayerSync).toBe(false);
        expect(marking.temporalId).toBe(0);
    });

    it('parses temporal layer 3 — TID=3 (§2.3.2.2)', () => {
        // S=1 E=1 I=0 D=0 B=0 TID=3 → 0b11000011 = 0xC3
        const marking = parseVideoFrameMarking(0xC3n);
        expect(marking.startOfFrame).toBe(true);
        expect(marking.endOfFrame).toBe(true);
        expect(marking.independent).toBe(false);
        expect(marking.discardable).toBe(false);
        expect(marking.temporalId).toBe(3);
    });

    it('parses maximum temporal layer — TID=7 (§2.3.2.2)', () => {
        // S=0 E=0 I=0 D=0 B=0 TID=7 → 0b00000111 = 0x07
        const marking = parseVideoFrameMarking(0x07n);
        expect(marking.startOfFrame).toBe(false);
        expect(marking.endOfFrame).toBe(false);
        expect(marking.independent).toBe(false);
        expect(marking.discardable).toBe(false);
        expect(marking.temporalId).toBe(7);
    });

    it('parses zero value — all flags clear (§2.3.2.2)', () => {
        const marking = parseVideoFrameMarking(0n);
        expect(marking.startOfFrame).toBe(false);
        expect(marking.endOfFrame).toBe(false);
        expect(marking.independent).toBe(false);
        expect(marking.discardable).toBe(false);
        expect(marking.baseLayerSync).toBe(false);
        expect(marking.temporalId).toBe(0);
        expect(marking.layerId).toBeUndefined();
    });

    // ─── Two-byte markings (with LID) ────────────────────────────────

    it('parses LID=0 with B=1 TID=1 (RFC 9626 §3.1)', () => {
        // RFC 9626: B MUST be 0 when TID is 0, so use TID=1 for B=1 tests
        // Byte 0: S=1 E=1 I=1 D=0 B=1 TID=1 → 0b11101001 = 0xE9
        // Byte 1: LID=0 → 0x00
        // Value = (0xE9 << 8) | 0x00 = 0xE900
        const marking = parseVideoFrameMarking(0xE900n);
        expect(marking.startOfFrame).toBe(true);
        expect(marking.endOfFrame).toBe(true);
        expect(marking.independent).toBe(true);
        expect(marking.baseLayerSync).toBe(true);
        expect(marking.temporalId).toBe(1);
        expect(marking.layerId).toBe(0);
    });

    it('parses LID=2 with B=1 TID=1 (RFC 9626 §3.1)', () => {
        // Byte 0: S=1 E=1 I=0 D=0 B=1 TID=1 → 0b11001001 = 0xC9
        // Byte 1: LID=2 → 0x02
        // Value = (0xC9 << 8) | 0x02 = 0xC902
        const marking = parseVideoFrameMarking(0xC902n);
        expect(marking.startOfFrame).toBe(true);
        expect(marking.endOfFrame).toBe(true);
        expect(marking.independent).toBe(false);
        expect(marking.baseLayerSync).toBe(true);
        expect(marking.temporalId).toBe(1);
        expect(marking.layerId).toBe(2);
    });

    it('parses maximum LID=255 (RFC 9626 §3.1: LID is 8 bits)', () => {
        // Byte 0: S=0 E=0 I=0 D=0 B=1 TID=2 → 0b00001010 = 0x0A
        // Byte 1: LID=255 → 0xFF
        // Value = (0x0A << 8) | 0xFF = 0x0AFF
        const marking = parseVideoFrameMarking(0x0AFFn);
        expect(marking.startOfFrame).toBe(false);
        expect(marking.endOfFrame).toBe(false);
        expect(marking.baseLayerSync).toBe(true);
        expect(marking.temporalId).toBe(2);
        expect(marking.layerId).toBe(255);
    });

    it('parses LID without B flag — B is not a presence indicator (RFC 9626 §3.1)', () => {
        // LID presence is determined by byte count, not B flag.
        // B=0 with TID=0, but LID present (value >= 256).
        // Byte 0: S=1 E=1 I=0 D=0 B=0 TID=0 → 0b11000000 = 0xC0
        // Byte 1: LID=5 → 0x05
        // Value = (0xC0 << 8) | 0x05 = 0xC005
        const marking = parseVideoFrameMarking(0xC005n);
        expect(marking.startOfFrame).toBe(true);
        expect(marking.endOfFrame).toBe(true);
        expect(marking.independent).toBe(false);
        expect(marking.baseLayerSync).toBe(false);
        expect(marking.temporalId).toBe(0);
        expect(marking.layerId).toBe(5);
    });
});

describe('encodeVideoFrameMarking', () => {
    it('encodes independent keyframe to 0xE0 (§2.3.2.2)', () => {
        const marking: VideoFrameMarking = {
            startOfFrame: true,
            endOfFrame: true,
            independent: true,
            discardable: false,
            baseLayerSync: false,
            temporalId: 0,
        };
        expect(encodeVideoFrameMarking(marking)).toBe(0xE0n);
    });

    it('encodes with LID to 2-byte value (§2.3.2.2, RFC 9626 §3.1)', () => {
        // B=1, TID=1 (RFC 9626: B MUST be 0 when TID=0), LID=0
        const marking: VideoFrameMarking = {
            startOfFrame: true,
            endOfFrame: true,
            independent: true,
            discardable: false,
            baseLayerSync: true,
            temporalId: 1,
            layerId: 0,
        };
        expect(encodeVideoFrameMarking(marking)).toBe(0xE900n);
    });

    it('encodes LID=255 — full 8-bit range (RFC 9626 §3.1)', () => {
        const marking: VideoFrameMarking = {
            startOfFrame: false,
            endOfFrame: false,
            independent: false,
            discardable: false,
            baseLayerSync: true,
            temporalId: 2,
            layerId: 255,
        };
        expect(encodeVideoFrameMarking(marking)).toBe(0x0AFFn);
    });

    it('round-trips all single-byte values (§2.3.2.2)', () => {
        const marking: VideoFrameMarking = {
            startOfFrame: false,
            endOfFrame: true,
            independent: false,
            discardable: true,
            baseLayerSync: false,
            temporalId: 5,
        };
        const encoded = encodeVideoFrameMarking(marking);
        const decoded = parseVideoFrameMarking(encoded);
        expect(decoded.startOfFrame).toBe(false);
        expect(decoded.endOfFrame).toBe(true);
        expect(decoded.independent).toBe(false);
        expect(decoded.discardable).toBe(true);
        expect(decoded.temporalId).toBe(5);
    });

    it('round-trips two-byte values with LID (§2.3.2.2, RFC 9626 §3.1)', () => {
        const marking: VideoFrameMarking = {
            startOfFrame: true,
            endOfFrame: true,
            independent: false,
            discardable: false,
            baseLayerSync: true,
            temporalId: 2,
            layerId: 15,
        };
        const encoded = encodeVideoFrameMarking(marking);
        const decoded = parseVideoFrameMarking(encoded);
        expect(decoded.startOfFrame).toBe(true);
        expect(decoded.endOfFrame).toBe(true);
        expect(decoded.independent).toBe(false);
        expect(decoded.baseLayerSync).toBe(true);
        expect(decoded.temporalId).toBe(2);
        expect(decoded.layerId).toBe(15);
    });

    it('round-trips LID without B flag (RFC 9626 §3.1)', () => {
        // LID present but B=0 — valid per RFC 9626
        const marking: VideoFrameMarking = {
            startOfFrame: true,
            endOfFrame: true,
            independent: true,
            discardable: false,
            baseLayerSync: false,
            temporalId: 0,
            layerId: 42,
        };
        const encoded = encodeVideoFrameMarking(marking);
        const decoded = parseVideoFrameMarking(encoded);
        expect(decoded.layerId).toBe(42);
        expect(decoded.baseLayerSync).toBe(false);
    });
});
