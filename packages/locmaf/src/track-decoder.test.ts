/**
 * The stateful per-track decoder the player uses: one reference per MOQT group,
 * canonical CMAF chunks out, rejections reported rather than thrown.
 */
import { describe, it, expect } from 'vitest';
import { LocmafTrackDecoder } from './track-decoder.js';
import { LocmafEncoder } from './encoder.js';
import { LocmafGroupState } from './group-state.js';
import { LocmafFormatError } from './errors.js';
import { serializeLocmafObject } from './serializer.js';
import { parseLocmafTrackContext } from './track-context.js';
import { NON_SYNC_FLAGS, SYNC_FLAGS, buildChunk, buildInit, videoInit } from '../test-support/cmaf.js';
import { concat, isoBox, vi } from '../test-support/bytes.js';

const context = parseLocmafTrackContext(videoInit());

/** Wire objects for one group of single-sample video chunks starting at `bmdt`. */
function group(bmdt: number, count: number): Uint8Array[] {
    const encoder = new LocmafEncoder();
    const state = new LocmafGroupState();
    return Array.from({ length: count }, (_, i) => serializeLocmafObject(encoder.encode(
        buildChunk({ bmdt: bmdt + i * 3000, samples: [{ duration: 3000, size: 10 + i, flags: i === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS }] }),
        state, context, false, BigInt(i))));
}

describe('LocmafTrackDecoder', () => {
    it('exposes the track context and decodes a group into canonical chunks', () => {
        const decoder = new LocmafTrackDecoder(videoInit());
        expect(decoder.context.timescale).toBe(90000);
        const results = group(90000, 3).map((payload, i) => decoder.push(5n, BigInt(i), payload));
        expect(results.map((r) => r.kind)).toEqual(['chunk', 'chunk', 'chunk']);
        const [first, second] = results;
        if (first?.kind !== 'chunk' || second?.kind !== 'chunk') throw new Error('expected chunks');
        expect(first.startsWithSync).toBe(true);
        expect(second.startsWithSync).toBe(false);
        expect(first.baseMediaDecodeTime).toBe(90000n);
        expect(second.baseMediaDecodeTime).toBe(93000n);
        expect(first.timescale).toBe(90000);
        expect(first.sampleCount).toBe(1);
        expect(first.effective.sizes).toEqual([10]);
        expect(String.fromCharCode(...first.bytes.subarray(4, 8))).toBe('moof');
    });

    it('starts every group from a fresh reference', () => {
        const decoder = new LocmafTrackDecoder(videoInit());
        const [full0, delta1] = group(0, 2);
        expect(decoder.push(1n, 0n, full0!).kind).toBe('chunk');
        const crossGroup = decoder.push(2n, 1n, delta1!);
        expect(crossGroup.kind).toBe('rejected');
        if (crossGroup.kind === 'rejected') expect(crossGroup.error.section).toBe('3');
        expect(decoder.push(3n, 0n, full0!).kind).toBe('chunk');
        expect(decoder.push(3n, 1n, delta1!).kind).toBe('chunk');
    });

    it('rejects deltas after a gap or a malformed object until the next full header', () => {
        const decoder = new LocmafTrackDecoder(videoInit());
        const objects = group(0, 5);
        expect(decoder.push(1n, 0n, objects[0]!).kind).toBe('chunk');
        const gap = decoder.push(1n, 2n, objects[2]!);
        expect(gap.kind).toBe('rejected');
        expect(decoder.push(1n, 3n, objects[3]!).kind).toBe('rejected');

        expect(decoder.push(2n, 0n, objects[0]!).kind).toBe('chunk');
        const malformed = decoder.push(2n, 1n, vi(9));
        expect(malformed.kind).toBe('rejected');
        if (malformed.kind === 'rejected') {
            expect(malformed.error).toBeInstanceOf(LocmafFormatError);
            expect(malformed.error.section).toBe('7.1');
        }
        expect(decoder.push(2n, 2n, objects[2]!).kind).toBe('rejected');
    });

    it('keeps a reference per group, so interleaved groups decode (each MOQT group rides its own stream)', () => {
        const decoder = new LocmafTrackDecoder(videoInit());
        const g7 = group(0, 4);
        const g8 = group(12000, 3);
        const arrival: Array<[bigint, number, Uint8Array]> = [
            [7n, 0, g7[0]!], [7n, 1, g7[1]!], [8n, 0, g8[0]!], [7n, 2, g7[2]!], [8n, 1, g8[1]!], [7n, 3, g7[3]!], [8n, 2, g8[2]!],
        ];
        const results = arrival.map(([g, o, payload]) => decoder.push(g, BigInt(o), payload));
        expect(results.map((r) => r.kind)).toEqual(Array(arrival.length).fill('chunk'));
        const bmdt = results.map((r) => (r.kind === 'chunk' ? r.baseMediaDecodeTime : -1n));
        expect(bmdt).toEqual([0n, 3000n, 12000n, 6000n, 15000n, 9000n, 18000n]);
    });

    it('returns rawBoxes verbatim and requires a full header afterwards', () => {
        const decoder = new LocmafTrackDecoder(videoInit());
        const objects = group(0, 2);
        expect(decoder.push(1n, 0n, objects[0]!).kind).toBe('chunk');
        const boxes = isoBox('free', Uint8Array.of(1, 2, 3));
        expect(decoder.push(1n, 1n, concat(vi(4), boxes))).toEqual({ kind: 'raw', bytes: boxes });
        expect(decoder.push(1n, 2n, objects[1]!).kind).toBe('rejected');
    });

    it('reports an event-only chunk as not starting with a sync sample', () => {
        const decoder = new LocmafTrackDecoder(videoInit());
        const result = decoder.push(0n, 0n, concat(vi(2, 4, 10, 0, 14, 0)));
        expect(result.kind).toBe('chunk');
        if (result.kind === 'chunk') {
            expect(result.sampleCount).toBe(0);
            expect(result.startsWithSync).toBe(false);
        }
    });

    it('throws for an unusable CMAF Header', () => {
        expect(() => new LocmafTrackDecoder(buildInit({ trackId: 1, timescale: 90000, handler: 'vide', extraTraks: 1 }))).toThrow(LocmafFormatError);
    });
});
