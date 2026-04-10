/**
 * Tests for AudioLevel parsing and encoding.
 *
 * Test vectors derived from RFC 6464 §3 bit layout:
 * ```
 * Bit 7: V — Voice activity (1 = speech detected)
 * Bits 6-0: level — Audio magnitude in -dBov (0 = loudest, 127 = silence)
 * ```
 *
 * @see draft-ietf-moq-loc-01 §2.3.3.1
 * @see RFC 6464 §3
 */

import { describe, it, expect } from 'vitest';
import { parseAudioLevel, encodeAudioLevel } from './audio.js';
import type { AudioLevel } from './types.js';

describe('parseAudioLevel', () => {
    it('parses voice active at -30 dBov (§2.3.3.1)', () => {
        // V=1 level=30 → 0b10011110 = 0x9E
        const al = parseAudioLevel(0x9En);
        expect(al.voiceActivity).toBe(true);
        expect(al.level).toBe(30);
    });

    it('parses silence — V=0 level=127 (§2.3.3.1)', () => {
        // V=0 level=127 → 0b01111111 = 0x7F
        const al = parseAudioLevel(0x7Fn);
        expect(al.voiceActivity).toBe(false);
        expect(al.level).toBe(127);
    });

    it('parses loudest with voice — V=1 level=0 (§2.3.3.1)', () => {
        // V=1 level=0 → 0b10000000 = 0x80
        const al = parseAudioLevel(0x80n);
        expect(al.voiceActivity).toBe(true);
        expect(al.level).toBe(0);
    });

    it('parses no voice, moderate level — V=0 level=50 (§2.3.3.1)', () => {
        // V=0 level=50 → 0b00110010 = 0x32
        const al = parseAudioLevel(0x32n);
        expect(al.voiceActivity).toBe(false);
        expect(al.level).toBe(50);
    });

    it('parses zero value — V=0 level=0 (§2.3.3.1)', () => {
        const al = parseAudioLevel(0n);
        expect(al.voiceActivity).toBe(false);
        expect(al.level).toBe(0);
    });

    it('uses only least significant 8 bits of varint (§2.3.3.1)', () => {
        // If varint is > 255, only LSB 8 bits matter per spec
        // V=1 level=30 = 0x9E, with high bits = 0x019E
        const al = parseAudioLevel(0x019En);
        expect(al.voiceActivity).toBe(true);
        expect(al.level).toBe(30);
    });
});

describe('encodeAudioLevel', () => {
    it('encodes voice active at -30 dBov (§2.3.3.1)', () => {
        const al: AudioLevel = { voiceActivity: true, level: 30 };
        expect(encodeAudioLevel(al)).toBe(0x9En);
    });

    it('encodes silence (§2.3.3.1)', () => {
        const al: AudioLevel = { voiceActivity: false, level: 127 };
        expect(encodeAudioLevel(al)).toBe(0x7Fn);
    });

    it('encodes loudest with voice (§2.3.3.1)', () => {
        const al: AudioLevel = { voiceActivity: true, level: 0 };
        expect(encodeAudioLevel(al)).toBe(0x80n);
    });

    it('round-trips all combinations (§2.3.3.1)', () => {
        for (const voiceActivity of [true, false]) {
            for (const level of [0, 1, 63, 64, 126, 127]) {
                const encoded = encodeAudioLevel({ voiceActivity, level });
                const decoded = parseAudioLevel(encoded);
                expect(decoded.voiceActivity).toBe(voiceActivity);
                expect(decoded.level).toBe(level);
            }
        }
    });
});
