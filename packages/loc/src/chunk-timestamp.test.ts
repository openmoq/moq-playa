import { describe, expect, it } from 'vitest';
import { encodeLocHeaders, parseLocHeaders, toAudioChunkInit, toVideoChunkInit } from './headers.js';
import type { LocHeaders } from './types.js';

describe.each([toVideoChunkInit, toAudioChunkInit])('chunk source timestamp: %s', (convert) => {
    const payload = new Uint8Array([1, 2, 3]);

    it('does not turn the numeric timestamp default into source evidence', () => {
        const chunk = convert(payload, {});
        expect(chunk.timestamp).toBe(0);
        expect(chunk).not.toHaveProperty('sourceTimestamp');
        expect(convert(payload, { timestamp: 90000n, timescale: 90000n })).not.toHaveProperty('sourceTimestamp');
    });

    it.each([0n, 9_007_199_254_740_993n])('preserves parsed LOC-01 Unix microseconds exactly: %s', (ticks) => {
        const headers = parseLocHeaders(encodeLocHeaders({ captureTimestamp: ticks }, { wireProfile: 'd18-delta-vi64' }), { wireProfile: 'd18-delta-vi64' });
        const chunk = convert(payload, headers);
        expect(chunk.sourceTimestamp).toEqual({ ticks, ticksPerSecond: 1_000_000n, domain: 'unix' });
        expect(chunk.timestamp).toBe(Number(ticks));
        expect(chunk.data).toBe(payload);
    });

    it('keeps LOC-04 media ticks before microsecond truncation, including inherited timescale', () => {
        const bytes = encodeLocHeaders({ timestamp: 90_001n }, { locVersion: 4 });
        const headers = parseLocHeaders(bytes, { track: { timescale: 90_000n } });
        const chunk = convert(payload, headers);
        expect(chunk.sourceTimestamp).toEqual({ ticks: 90_001n, ticksPerSecond: 90_000n, domain: 'media' });
        expect(chunk.timestamp).toBe(1_000_011);
    });

    it('preserves distinct source ticks that normalize to the same decoder timestamp', () => {
        const chunks = [1n, 2n].map(timestamp => convert(payload, {
            timestamp, timescale: 10_000_000n, captureTimestamp: 0n, timestampIsWallClock: false,
        }));
        expect(chunks.map(c => c.timestamp)).toEqual([0, 0]);
        expect(chunks.map(c => c.sourceTimestamp?.ticks)).toEqual([1n, 2n]);
    });

    it('retains original ticks when container normalization rounded instead of truncating', () => {
        const chunk = convert(payload, { timestamp: 96_000n, timescale: 90_000n, captureTimestamp: 1_066_667n, timestampIsWallClock: false });
        expect(chunk.timestamp).toBe(1_066_667);
        expect(chunk.sourceTimestamp).toEqual({ ticks: 96_000n, ticksPerSecond: 90_000n, domain: 'media' });
    });

    it('keeps parsed LOC-04 without a timescale in the Unix domain', () => {
        const headers = parseLocHeaders(encodeLocHeaders({ timestamp: 0n }, { locVersion: 4 }));
        expect(convert(payload, headers).sourceTimestamp).toEqual({ ticks: 0n, ticksPerSecond: 1_000_000n, domain: 'unix' });
    });

    it('does not confuse a microsecond media timescale with Unix time', () => {
        const headers = parseLocHeaders(encodeLocHeaders({ timestamp: 42n, timescale: 1_000_000n }, { locVersion: 4 }));
        expect(convert(payload, headers).sourceTimestamp).toEqual({ ticks: 42n, ticksPerSecond: 1_000_000n, domain: 'media' });
    });

    it('preserves negative raw media ticks with either supported normalization', () => {
        for (const micros of [-1_066_666n, -1_066_667n]) {
            expect(convert(payload, {
                timestamp: -96_000n, timescale: 90_000n, captureTimestamp: micros, timestampIsWallClock: false,
            }).sourceTimestamp).toEqual({ ticks: -96_000n, ticksPerSecond: 90_000n, domain: 'media' });
        }
    });

    it('leaves source time unavailable when raw and normalized values contradict one another', () => {
        const chunk = convert(payload, { timestamp: 90_000n, timescale: 90_000n, captureTimestamp: 100n, timestampIsWallClock: false });
        expect(chunk.timestamp).toBe(100);
        expect(chunk).not.toHaveProperty('sourceTimestamp');
    });

    it('does not infer a Unix epoch from the magnitude of supplied normalized time', () => {
        const chunk = convert(payload, { captureTimestamp: 1_800_000_000_000_000n });
        expect(chunk.sourceTimestamp).toEqual({ ticks: 1_800_000_000_000_000n, ticksPerSecond: 1_000_000n, domain: 'unknown' });
    });

    it('retains explicitly declared normalized media time without treating it as raw ticks', () => {
        const chunk = convert(payload, { captureTimestamp: -1n, timescale: 90_000n, timestampIsWallClock: false });
        expect(chunk.sourceTimestamp).toEqual({ ticks: -1n, ticksPerSecond: 1_000_000n, domain: 'media' });
        expect(chunk.timestamp).toBe(-1);
    });

    it.each([
        { timestamp: 1n, timescale: 0n },
        { timestamp: 1n, timescale: -1n },
        { timestamp: 1n, timestampIsWallClock: false },
        { timestamp: 1n, timescale: 90_000n, timestampIsWallClock: true },
    ] satisfies LocHeaders[])('leaves evidence unavailable for inconsistent raw units (case %#)', (headers) => {
        const chunk = convert(payload, { captureTimestamp: 100n, ...headers });
        expect(chunk.timestamp).toBe(100);
        expect(chunk).not.toHaveProperty('sourceTimestamp');
    });

    it('snapshots source metadata without retaining mutable headers or track defaults', () => {
        const headers = { timestamp: 90_001n, timescale: 90_000n, captureTimestamp: 1_000_011n };
        const chunk = convert(payload, headers);
        headers.timestamp = 48_001n;
        headers.timescale = 48_000n;
        expect(chunk.sourceTimestamp).toEqual({ ticks: 90_001n, ticksPerSecond: 90_000n, domain: 'media' });
        expect(Object.isFrozen(chunk.sourceTimestamp)).toBe(true);
    });
});
