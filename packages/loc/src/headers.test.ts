/**
 * Tests for LOC header extension parsing and encoding.
 *
 * Extension wire format per draft-ietf-moq-transport-16 §1.4.2:
 * - Types are delta-encoded varints from previous
 * - Even type IDs → value is a single varint
 * - Odd type IDs → value is length-prefixed bytes
 * - No count field — parse until bytes exhausted
 *
 * @see draft-ietf-moq-loc-01 §2.3
 * @see draft-ietf-moq-transport-16 §2.5 (Extension Headers)
 */

import { describe, it, expect } from 'vitest';
import { varint, writeVarint, varintEncodingLength } from '@moqt/transport';
import type { Varint } from '@moqt/transport';
import {
    parseLocHeaders,
    encodeLocHeaders,
    toVideoChunkInit,
    toAudioChunkInit,
} from './headers.js';
import { LocExtensionId } from './types.js';
import type { LocHeaders } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

/** Build raw extension bytes with delta-encoded KVP entries. */
function buildExtensionBytes(
    entries: Array<{ id: number; value: bigint | Uint8Array }>,
): Uint8Array {
    const parts: Uint8Array[] = [];
    let prevId = 0;

    for (const entry of entries) {
        const delta = entry.id - prevId;
        prevId = entry.id;

        // Write delta as varint
        const deltaBuf = new Uint8Array(8);
        const deltaLen = writeVarint(varint(delta), deltaBuf, 0);
        parts.push(deltaBuf.subarray(0, deltaLen));

        if (entry.id % 2 === 0) {
            // Even → value is varint
            const valBuf = new Uint8Array(8);
            const valLen = writeVarint(varint(entry.value as bigint), valBuf, 0);
            parts.push(valBuf.subarray(0, valLen));
        } else {
            // Odd → length-prefixed bytes
            const bytes = entry.value as Uint8Array;
            const lenBuf = new Uint8Array(8);
            const lenLen = writeVarint(varint(bytes.length), lenBuf, 0);
            parts.push(lenBuf.subarray(0, lenLen));
            parts.push(bytes);
        }
    }

    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

// ─── parseLocHeaders ──────────────────────────────────────────────────

describe('parseLocHeaders', () => {
    it('returns empty headers for undefined extensions (§2.3)', () => {
        const headers = parseLocHeaders(undefined);
        expect(headers.captureTimestamp).toBeUndefined();
        expect(headers.videoFrameMarking).toBeUndefined();
        expect(headers.audioLevel).toBeUndefined();
        expect(headers.videoConfig).toBeUndefined();
        expect(headers.unknown).toBeUndefined();
    });

    it('returns empty headers for zero-length extensions (§2.3)', () => {
        const headers = parseLocHeaders(new Uint8Array(0));
        expect(headers.captureTimestamp).toBeUndefined();
        expect(headers.videoFrameMarking).toBeUndefined();
        expect(headers.audioLevel).toBeUndefined();
        expect(headers.videoConfig).toBeUndefined();
    });

    it('parses CaptureTimestamp (§2.3.1.1)', () => {
        const timestamp = 1746104600000000n; // microseconds
        const bytes = buildExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: timestamp },
        ]);
        const headers = parseLocHeaders(bytes);
        expect(headers.captureTimestamp).toBe(timestamp);
    });

    it('parses VideoFrameMarking — independent keyframe (§2.3.2.2)', () => {
        // S=1 E=1 I=1 D=0 B=0 TID=0 → 0xE0
        const bytes = buildExtensionBytes([
            { id: LocExtensionId.VIDEO_FRAME_MARKING, value: 0xE0n },
        ]);
        const headers = parseLocHeaders(bytes);
        expect(headers.videoFrameMarking).toBeDefined();
        expect(headers.videoFrameMarking!.independent).toBe(true);
        expect(headers.videoFrameMarking!.startOfFrame).toBe(true);
        expect(headers.videoFrameMarking!.endOfFrame).toBe(true);
    });

    it('parses AudioLevel — voice at -30 dBov (§2.3.3.1)', () => {
        // V=1 level=30 → 0x9E
        const bytes = buildExtensionBytes([
            { id: LocExtensionId.AUDIO_LEVEL, value: 0x9En },
        ]);
        const headers = parseLocHeaders(bytes);
        expect(headers.audioLevel).toBeDefined();
        expect(headers.audioLevel!.voiceActivity).toBe(true);
        expect(headers.audioLevel!.level).toBe(30);
    });

    it('parses VideoConfig — codec extradata (§2.3.2.1)', () => {
        const extradata = new Uint8Array([0x01, 0x64, 0x00, 0x1e, 0xff]);
        const bytes = buildExtensionBytes([
            { id: LocExtensionId.VIDEO_CONFIG, value: extradata },
        ]);
        const headers = parseLocHeaders(bytes);
        expect(headers.videoConfig).toBeDefined();
        expect(headers.videoConfig).toEqual(extradata);
    });

    it('parses all four extensions in a single buffer (§2.3)', () => {
        const timestamp = 1746104600000000n;
        const extradata = new Uint8Array([0xDE, 0xAD]);

        const bytes = buildExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: timestamp },
            { id: LocExtensionId.VIDEO_FRAME_MARKING, value: 0xE0n },
            { id: LocExtensionId.AUDIO_LEVEL, value: 0x9En },
            { id: LocExtensionId.VIDEO_CONFIG, value: extradata },
        ]);

        const headers = parseLocHeaders(bytes);
        expect(headers.captureTimestamp).toBe(timestamp);
        expect(headers.videoFrameMarking!.independent).toBe(true);
        expect(headers.audioLevel!.voiceActivity).toBe(true);
        expect(headers.audioLevel!.level).toBe(30);
        expect(headers.videoConfig).toEqual(extradata);
    });

    it('preserves unknown even extension IDs (§2.3)', () => {
        // Use ID 8 (even, unknown) with varint value
        const bytes = buildExtensionBytes([
            { id: 8, value: 42n },
        ]);
        const headers = parseLocHeaders(bytes);
        expect(headers.unknown).toBeDefined();
        expect(headers.unknown!.get(8)).toBe(42n);
    });

    it('preserves unknown odd extension IDs (§2.3)', () => {
        // Use ID 9 (odd, unknown) with byte value
        const data = new Uint8Array([0x01, 0x02, 0x03]);
        const bytes = buildExtensionBytes([
            { id: 9, value: data },
        ]);
        const headers = parseLocHeaders(bytes);
        expect(headers.unknown).toBeDefined();
        expect(headers.unknown!.get(9)).toEqual(data);
    });

    it('handles mix of known and unknown extensions (§2.3)', () => {
        const bytes = buildExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: 1000000n },
            { id: 8, value: 99n },  // unknown even
        ]);
        const headers = parseLocHeaders(bytes);
        expect(headers.captureTimestamp).toBe(1000000n);
        expect(headers.unknown).toBeDefined();
        expect(headers.unknown!.get(8)).toBe(99n);
    });
});

// ─── encodeLocHeaders ──────────────────────────────────────────────────

describe('encodeLocHeaders', () => {
    it('returns undefined for empty headers (§2.3)', () => {
        const bytes = encodeLocHeaders({});
        expect(bytes).toBeUndefined();
    });

    it('encodes CaptureTimestamp only (§2.3.1.1)', () => {
        const headers: LocHeaders = { captureTimestamp: 1000000n };
        const bytes = encodeLocHeaders(headers);
        expect(bytes).toBeDefined();
        const parsed = parseLocHeaders(bytes!);
        expect(parsed.captureTimestamp).toBe(1000000n);
    });

    it('round-trips all four extensions (§2.3)', () => {
        const headers: LocHeaders = {
            captureTimestamp: 1746104600000000n,
            videoFrameMarking: {
                startOfFrame: true,
                endOfFrame: true,
                independent: true,
                discardable: false,
                baseLayerSync: false,
                temporalId: 0,
            },
            audioLevel: { voiceActivity: true, level: 30 },
            videoConfig: new Uint8Array([0x01, 0x64, 0x00, 0x1e]),
        };
        const bytes = encodeLocHeaders(headers);
        expect(bytes).toBeDefined();

        const parsed = parseLocHeaders(bytes!);
        expect(parsed.captureTimestamp).toBe(1746104600000000n);
        expect(parsed.videoFrameMarking!.independent).toBe(true);
        expect(parsed.audioLevel!.voiceActivity).toBe(true);
        expect(parsed.audioLevel!.level).toBe(30);
        expect(parsed.videoConfig).toEqual(new Uint8Array([0x01, 0x64, 0x00, 0x1e]));
    });

    it('encodes extensions in ascending ID order (§2.3)', () => {
        // Even if headers are provided with audio before video,
        // encoding must produce ascending delta-encoded IDs
        const headers: LocHeaders = {
            audioLevel: { voiceActivity: false, level: 0 },
            captureTimestamp: 500n,
        };
        const bytes = encodeLocHeaders(headers);
        const parsed = parseLocHeaders(bytes!);
        expect(parsed.captureTimestamp).toBe(500n);
        expect(parsed.audioLevel!.voiceActivity).toBe(false);
        expect(parsed.audioLevel!.level).toBe(0);
    });
});

// ─── parseLocHeaders with absolute type IDs (draft-14 §1.4.2) ──────────

/**
 * Build raw extension bytes with absolute (non-delta) KVP entries.
 *
 * Draft-14 §1.4.2 uses absolute Type values:
 *   Key-Value-Pair { Type (i), [Length (i),] Value (..) }
 *
 * @see draft-ietf-moq-transport-14 §1.4.2
 */
function buildAbsoluteExtensionBytes(
    entries: Array<{ id: number; value: bigint | Uint8Array }>,
): Uint8Array {
    const parts: Uint8Array[] = [];

    for (const entry of entries) {
        // Write absolute type as varint (NOT delta)
        const typeBuf = new Uint8Array(8);
        const typeLen = writeVarint(varint(entry.id), typeBuf, 0);
        parts.push(typeBuf.subarray(0, typeLen));

        if (entry.id % 2 === 0) {
            const valBuf = new Uint8Array(8);
            const valLen = writeVarint(varint(entry.value as bigint), valBuf, 0);
            parts.push(valBuf.subarray(0, valLen));
        } else {
            const bytes = entry.value as Uint8Array;
            const lenBuf = new Uint8Array(8);
            const lenLen = writeVarint(varint(bytes.length), lenBuf, 0);
            parts.push(lenBuf.subarray(0, lenLen));
            parts.push(bytes);
        }
    }

    const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

describe('parseLocHeaders with absolute type IDs (draft-14 §1.4.2)', () => {
    it('parses CaptureTimestamp from absolute-encoded wire bytes', () => {
        const timestamp = 1746104600000000n;
        const bytes = buildAbsoluteExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: timestamp },
        ]);
        // With a single extension, absolute and delta are the same (delta from 0 = absolute)
        // This is the baseline sanity check.
        const headers = parseLocHeaders(bytes, { deltaEncoded: false });
        expect(headers.captureTimestamp).toBe(timestamp);
    });

    it('parses two extensions with absolute type IDs — not deltas', () => {
        // CaptureTimestamp (ID=2) + VideoFrameMarking (ID=4)
        // Absolute wire: [type=2][value][type=4][value]
        // Delta wire:    [delta=2][value][delta=2][value]
        // If parsed with delta decoding, type=4 would be read as delta=4
        // and resolved to absolute type 2+4=6 (AudioLevel) — WRONG.
        const bytes = buildAbsoluteExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: 42n },
            { id: LocExtensionId.VIDEO_FRAME_MARKING, value: 0xE0n },
        ]);
        const headers = parseLocHeaders(bytes, { deltaEncoded: false });
        expect(headers.captureTimestamp).toBe(42n);
        expect(headers.videoFrameMarking).toBeDefined();
        expect(headers.videoFrameMarking!.independent).toBe(true);
    });

    it('parses three extensions with absolute type IDs', () => {
        const bytes = buildAbsoluteExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: 1000000n },
            { id: LocExtensionId.VIDEO_FRAME_MARKING, value: 0xE0n },
            { id: LocExtensionId.AUDIO_LEVEL, value: 0x9En },
        ]);
        const headers = parseLocHeaders(bytes, { deltaEncoded: false });
        expect(headers.captureTimestamp).toBe(1000000n);
        expect(headers.videoFrameMarking!.independent).toBe(true);
        expect(headers.audioLevel!.voiceActivity).toBe(true);
        expect(headers.audioLevel!.level).toBe(30);
    });

    it('parses all four extensions with absolute type IDs including odd type', () => {
        const extradata = new Uint8Array([0x01, 0x64, 0x00]);
        const bytes = buildAbsoluteExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: 5000n },
            { id: LocExtensionId.VIDEO_FRAME_MARKING, value: 0xE0n },
            { id: LocExtensionId.AUDIO_LEVEL, value: 0x9En },
            { id: LocExtensionId.VIDEO_CONFIG, value: extradata },
        ]);
        const headers = parseLocHeaders(bytes, { deltaEncoded: false });
        expect(headers.captureTimestamp).toBe(5000n);
        expect(headers.videoFrameMarking!.independent).toBe(true);
        expect(headers.audioLevel!.voiceActivity).toBe(true);
        expect(headers.audioLevel!.level).toBe(30);
        expect(headers.videoConfig).toEqual(extradata);
    });

    it('absolute-encoded wire differs from delta-encoded wire for multiple extensions', () => {
        // Verify the test helper produces different bytes
        const entries: Array<{ id: number; value: bigint | Uint8Array }> = [
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: 42n },
            { id: LocExtensionId.VIDEO_FRAME_MARKING, value: 0xE0n },
        ];
        const absoluteBytes = buildAbsoluteExtensionBytes(entries);
        const deltaBytes = buildExtensionBytes(entries);

        // Absolute: [0x02][0x2A][0x04][0x40,0xE0]
        // Delta:    [0x02][0x2A][0x02][0x40,0xE0]
        // Third byte differs: 0x04 (absolute) vs 0x02 (delta)
        expect(absoluteBytes).not.toEqual(deltaBytes);
    });

    it('delta-encoded parser misreads absolute-encoded wire (demonstrates the bug)', () => {
        // Parse absolute-encoded bytes WITH delta decoding (the default).
        // The delta parser reads type=4 as delta=4 from previous type=2,
        // resolving to absolute type 6 (AudioLevel), not 4 (VideoFrameMarking).
        const bytes = buildAbsoluteExtensionBytes([
            { id: LocExtensionId.CAPTURE_TIMESTAMP, value: 42n },
            { id: LocExtensionId.VIDEO_FRAME_MARKING, value: 0xE0n },
        ]);
        const headers = parseLocHeaders(bytes); // default = deltaEncoded: true
        // BUG: VideoFrameMarking (ID=4) misread as AudioLevel (ID=6)
        expect(headers.videoFrameMarking).toBeUndefined(); // wrong type!
        expect(headers.audioLevel).toBeDefined(); // mistakenly parsed as audio
    });
});

describe('encodeLocHeaders with absolute type IDs (draft-14 §1.4.2)', () => {
    it('round-trips CaptureTimestamp through absolute encoding', () => {
        const headers: LocHeaders = { captureTimestamp: 1000000n };
        const bytes = encodeLocHeaders(headers, { deltaEncoded: false });
        expect(bytes).toBeDefined();
        const parsed = parseLocHeaders(bytes!, { deltaEncoded: false });
        expect(parsed.captureTimestamp).toBe(1000000n);
    });

    it('round-trips all four extensions through absolute encoding', () => {
        const headers: LocHeaders = {
            captureTimestamp: 1746104600000000n,
            videoFrameMarking: {
                startOfFrame: true,
                endOfFrame: true,
                independent: true,
                discardable: false,
                baseLayerSync: false,
                temporalId: 0,
            },
            audioLevel: { voiceActivity: true, level: 30 },
            videoConfig: new Uint8Array([0x01, 0x64, 0x00, 0x1e]),
        };
        const bytes = encodeLocHeaders(headers, { deltaEncoded: false });
        expect(bytes).toBeDefined();

        const parsed = parseLocHeaders(bytes!, { deltaEncoded: false });
        expect(parsed.captureTimestamp).toBe(1746104600000000n);
        expect(parsed.videoFrameMarking!.independent).toBe(true);
        expect(parsed.audioLevel!.voiceActivity).toBe(true);
        expect(parsed.audioLevel!.level).toBe(30);
        expect(parsed.videoConfig).toEqual(new Uint8Array([0x01, 0x64, 0x00, 0x1e]));
    });

    it('absolute encoding writes absolute type IDs on the wire', () => {
        const headers: LocHeaders = {
            captureTimestamp: 42n,
            videoFrameMarking: {
                startOfFrame: true,
                endOfFrame: true,
                independent: true,
                discardable: false,
                baseLayerSync: false,
                temporalId: 0,
            },
        };
        const bytes = encodeLocHeaders(headers, { deltaEncoded: false })!;
        // First extension: type=2 (0x02), value=42 (0x2A)
        expect(bytes[0]).toBe(0x02);
        expect(bytes[1]).toBe(0x2A);
        // Second extension: type=4 (0x04), NOT delta=2
        expect(bytes[2]).toBe(0x04);
    });
});

// ─── toVideoChunkInit ──────────────────────────────────────────────────

describe('toVideoChunkInit', () => {
    it('creates key chunk for independent frame (§2.3.2.2)', () => {
        const payload = new Uint8Array([0x00, 0x00, 0x01, 0x67]);
        const headers: LocHeaders = {
            captureTimestamp: 1000000n,
            videoFrameMarking: {
                startOfFrame: true,
                endOfFrame: true,
                independent: true,
                discardable: false,
                baseLayerSync: false,
                temporalId: 0,
            },
        };
        const init = toVideoChunkInit(payload, headers);
        expect(init.type).toBe('key');
        expect(init.timestamp).toBe(1000000);
        expect(init.data).toBe(payload); // zero-copy
    });

    it('creates delta chunk for non-independent frame (§2.3.2.2)', () => {
        const payload = new Uint8Array([0x00, 0x00, 0x01, 0x41]);
        const headers: LocHeaders = {
            captureTimestamp: 1033333n,
            videoFrameMarking: {
                startOfFrame: true,
                endOfFrame: true,
                independent: false,
                discardable: false,
                baseLayerSync: false,
                temporalId: 0,
            },
        };
        const init = toVideoChunkInit(payload, headers);
        expect(init.type).toBe('delta');
        expect(init.timestamp).toBe(1033333);
        expect(init.data).toBe(payload);
    });

    it('defaults to delta when no VideoFrameMarking (implementation default)', () => {
        const payload = new Uint8Array([0xCA, 0xFE]);
        const headers: LocHeaders = { captureTimestamp: 500n };
        const init = toVideoChunkInit(payload, headers);
        expect(init.type).toBe('delta');
        expect(init.timestamp).toBe(500);
    });

    it('uses timestamp 0 when no CaptureTimestamp (implementation default)', () => {
        const payload = new Uint8Array([0x01]);
        const headers: LocHeaders = {};
        const init = toVideoChunkInit(payload, headers);
        expect(init.timestamp).toBe(0);
        expect(init.type).toBe('delta');
    });
});

// ─── toAudioChunkInit ──────────────────────────────────────────────────

describe('toAudioChunkInit', () => {
    it('creates key chunk with timestamp (§2, §2.3.1.1)', () => {
        const payload = new Uint8Array([0x4F, 0x70, 0x75, 0x73]);
        const headers: LocHeaders = { captureTimestamp: 2000000n };
        const init = toAudioChunkInit(payload, headers);
        expect(init.type).toBe('key');
        expect(init.timestamp).toBe(2000000);
        expect(init.data).toBe(payload); // zero-copy
    });

    it('always produces key type — audio chunks are independently decodable', () => {
        const payload = new Uint8Array([0x01]);
        const headers: LocHeaders = {};
        const init = toAudioChunkInit(payload, headers);
        expect(init.type).toBe('key');
        expect(init.timestamp).toBe(0);
    });
});