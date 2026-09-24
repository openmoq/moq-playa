import { describe, expect, it } from 'vitest';
import { decodePropertyBlock } from '@moqt/transport';
import { encodeLocHeaders, parseLocHeaders } from './headers.js';
import { locHeadersToPropertyMap, resolveLocHeaders } from './property-map.js';
import { LocEncodeError, LocHeaderError } from './errors.js';
import type { LocVersion } from './types.js';

describe('LOC version compatibility', () => {
    it.each(['d14-absolute-varint', 'd16-delta-varint', 'd18-delta-vi64'] as const)(
        'keeps existing callers on LOC-01 over %s', (wireProfile) => {
            const headers = {
                captureTimestamp: 1_800_000_000_000_000n,
                videoFrameMarking: {
                    startOfFrame: true, endOfFrame: true, independent: true,
                    discardable: false, baseLayerSync: false, temporalId: 0,
                },
            };
            const bytes = encodeLocHeaders(headers, { wireProfile })!;
            expect(decodePropertyBlock(bytes, 0, { profile: wireProfile }).entries.map(e => e.id))
                .toEqual([0x02n, 0x04n]);
            expect(bytes).toEqual(encodeLocHeaders(headers, { wireProfile, locVersion: 1 }));
            expect(locHeadersToPropertyMap(headers).map(e => e.id)).toEqual([0x02n, 0x04n]);
        },
    );

    it('does not interpret a LOC-04 key id as a legacy capture timestamp', () => {
        const headers = resolveLocHeaders([
            { id: 0x02n, value: 7n },
            { id: 0x09n, value: Uint8Array.of(0xe0) },
        ]);
        expect(headers.version).toBe(4);
        expect(headers.captureTimestamp).toBeUndefined();
        expect(headers.unknown?.get(0x02n)).toBe(7n);
    });

    it('refuses to relabel media time as LOC-01 wall-clock time', () => {
        const headers = parseLocHeaders(encodeLocHeaders({ timestamp: 90_000n, timescale: 90_000n }, { locVersion: 4 }));
        expect(headers.captureTimestamp).toBe(1_000_000n);
        expect(() => encodeLocHeaders(headers, { locVersion: 1 })).toThrow(LocEncodeError);
    });

    it('refuses an unanchored normalized media timestamp in LOC-01', () => {
        expect(() => encodeLocHeaders({ captureTimestamp: 1_000_000n, timestampIsWallClock: false }))
            .toThrow(LocEncodeError);
    });

    it('rejects a zero timescale before emitting LOC-04 bytes', () => {
        expect(() => encodeLocHeaders({ timestamp: 42n, timescale: 0n }, { locVersion: 4 }))
            .toThrow(LocEncodeError);
    });

    it('rejects a negative track timescale rather than producing negative media time', () => {
        expect(() => resolveLocHeaders([{ id: 0x10n, value: 90_000n }], { timescale: -90_000n }))
            .toThrow(LocHeaderError);
    });

    it.each([0, 2, 3, 5, NaN, Infinity])('rejects unsupported LOC version %s', (version) => {
        expect(() => encodeLocHeaders({ captureTimestamp: 42n }, { locVersion: version as LocVersion }))
            .toThrow(LocEncodeError);
    });
});
