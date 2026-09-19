/**
 * Encode, serialize, parse and reconstruct whole groups, comparing with the
 * canonical reconstruction of the source (draft-einarsson-moq-locmaf-01
 * section 15). Ported from the Java LocmafRoundTripTest.
 */
import { describe, it, expect } from 'vitest';
import { LocmafEncoder } from './encoder.js';
import { LocmafReconstructor } from './reconstruct.js';
import { LocmafGroupState } from './group-state.js';
import { deserializeLocmafObject } from './deserializer.js';
import { serializeLocmafObject } from './serializer.js';
import { parseLocmafTrackContext, type LocmafTrackContext } from './track-context.js';
import { NON_SYNC_FLAGS, SYNC_FLAGS, audioInit, buildChunk, cencVideoInit, stypBox, videoInit } from '../test-support/cmaf.js';
import { fullBox, prng, u32, u64 } from '../test-support/bytes.js';

const encoder = new LocmafEncoder();
const reconstructor = new LocmafReconstructor();

function rebuild(wire: Uint8Array, state: LocmafGroupState, context: LocmafTrackContext, objectId: bigint): Uint8Array {
    return reconstructor.reconstruct(deserializeLocmafObject(wire), state, context, objectId).bytes;
}

/** Canonical bytes of a source chunk: full-encode on a fresh state, then reconstruct. */
function canonical(source: Uint8Array, context: LocmafTrackContext): Uint8Array {
    const wire = serializeLocmafObject(encoder.encode(source, new LocmafGroupState(), context, true, 0n));
    return rebuild(wire, new LocmafGroupState(), context, 0n);
}

function roundTripGroup(group: Uint8Array[], context: LocmafTrackContext, expectedDeltas: number): void {
    const encodeState = new LocmafGroupState();
    const decodeState = new LocmafGroupState();
    let deltas = 0;
    let wireBytes = 0;
    group.forEach((source, i) => {
        const wire = serializeLocmafObject(encoder.encode(source, encodeState, context, i === 0, BigInt(i)));
        wireBytes += wire.length;
        const parsed = deserializeLocmafObject(wire);
        expect(serializeLocmafObject(parsed), 'canonical bytes survive re-serialization').toEqual(wire);
        if (parsed.kind === 'moof' && !parsed.header.full) deltas++;
        const rebuilt = reconstructor.reconstruct(parsed, decodeState, context, BigInt(i)).bytes;
        expect(rebuilt, `chunk ${i} canonical mismatch`).toEqual(canonical(source, context));
    });
    expect(deltas).toBe(expectedDeltas);
    const sourceBytes = group.reduce((n, c) => n + c.length, 0);
    expect(wireBytes, `LOCMAF must be smaller than CMAF: ${wireBytes} vs ${sourceBytes}`).toBeLessThan(sourceBytes);
}

function videoGroup(chunks: number, bframes: boolean): Uint8Array[] {
    const random = prng(7);
    const group: Uint8Array[] = [];
    let bmdt = 90000;
    for (let i = 0; i < chunks; i++) {
        const size = 500 + random.int(2000);
        const cto = bframes ? (i % 3 === 1 ? -3000 : i % 3 === 2 ? 6000 : 0) : 0;
        group.push(buildChunk({
            bmdt,
            preMoof: [stypBox()],
            samples: [{ duration: 3000, size, flags: i === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS, cto }],
            mdat: random.fill(new Uint8Array(size)),
        }));
        bmdt += 3000;
    }
    return group;
}

function audioGroup(chunks: number): Uint8Array[] {
    const group: Uint8Array[] = [];
    let bmdt = 48000;
    for (let i = 0; i < chunks; i++) {
        group.push(buildChunk({
            trackId: 2,
            bmdt,
            sequenceNumber: i,
            samples: Array.from({ length: 4 }, () => ({ duration: 1024, size: 300, flags: SYNC_FLAGS })),
        }));
        bmdt += 4096;
    }
    return group;
}

describe('LOCMAF round trip', () => {
    it('round-trips video with B-frames byte-identically', () => {
        roundTripGroup(videoGroup(30, true), parseLocmafTrackContext(videoInit()), 29);
    });

    it('round-trips uniform audio with default sizes', () => {
        roundTripGroup(audioGroup(20), parseLocmafTrackContext(audioInit()), 19);
    });

    it('round-trips protected video with subsamples', () => {
        const random = prng(3);
        const context = parseLocmafTrackContext(cencVideoInit(8));
        const group: Uint8Array[] = [];
        for (let i = 0; i < 10; i++) {
            const size = 500 + random.int(1000);
            const iv = new Uint8Array(8);
            iv[7] = i;
            group.push(buildChunk({
                bmdt: i * 3000,
                samples: [{ duration: 3000, size, flags: i === 0 ? SYNC_FLAGS : NON_SYNC_FLAGS }],
                senc: { ivSize: 8, useSubsamples: true, withSaizSaio: true, samples: [{ iv, subsamples: [[32, size - 32]] }] },
            }));
        }
        roundTripGroup(group, context, 9);
    });

    it('re-anchors the decoder on a mid-group full header', () => {
        const context = parseLocmafTrackContext(videoInit());
        const group = videoGroup(6, false);
        const encodeState = new LocmafGroupState();
        const decodeState = new LocmafGroupState();
        group.forEach((source, i) => {
            const object = encoder.encode(source, encodeState, context, i === 0 || i === 3, BigInt(i));
            expect(object.kind === 'moof' && object.header.full).toBe(i === 0 || i === 3);
            expect(rebuild(serializeLocmafObject(object), decodeState, context, BigInt(i))).toEqual(canonical(source, context));
        });
    });

    it('carries prft/styp genBoxes and a rawBoxes init through the same group', () => {
        const context = parseLocmafTrackContext(videoInit());
        const prft = fullBox('prft', 1, 0, u32(1), u64(0x0123456789n), u64(90000n));
        const encodeState = new LocmafGroupState();
        const decodeState = new LocmafGroupState();
        const objects = [
            videoInit(),
            buildChunk({ bmdt: 0, preMoof: [stypBox(), prft], samples: [{ duration: 3000, size: 9, flags: SYNC_FLAGS }] }),
            buildChunk({ bmdt: 3000, preMoof: [prft], samples: [{ duration: 3000, size: 7, flags: NON_SYNC_FLAGS }] }),
        ];
        const rebuilt = objects.map((source, i) =>
            rebuild(serializeLocmafObject(encoder.encode(source, encodeState, context, false, BigInt(i))), decodeState, context, BigInt(i)));
        expect(rebuilt[0]).toEqual(videoInit());
        expect(rebuilt[1]!.subarray(0, stypBox().length)).toEqual(stypBox());
        expect(rebuilt[2]!.subarray(0, prft.length)).toEqual(prft);
    });

    /**
     * Independent conformance check: this fragment is ALREADY canonical per the
     * draft (single traf and trun, data offset set, default-base-is-moof, tfdt
     * v1, mfhd sequence 0, no styp), so reconstruction must reproduce it exactly.
     */
    it('reproduces an already-canonical fragment byte for byte', () => {
        const context = parseLocmafTrackContext(videoInit());
        const sizes = [700, 450, 620];
        const source = buildChunk({
            bmdt: 90000,
            sequenceNumber: 0,
            tfhd: { duration: 3000, flags: NON_SYNC_FLAGS },
            trun: { size: true },
            samples: sizes.map((size) => ({ duration: 3000, size, flags: NON_SYNC_FLAGS })),
            mdat: prng(11).fill(new Uint8Array(1770)),
        });
        const wire = serializeLocmafObject(encoder.encode(source, new LocmafGroupState(), context, true, 0n));
        expect(rebuild(wire, new LocmafGroupState(), context, 0n)).toEqual(source);
    });
});
