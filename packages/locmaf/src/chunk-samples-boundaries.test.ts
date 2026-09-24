import { describe, expect, it } from 'vitest';
import { readCmafChunkSamples } from './chunk-samples.js';
import { LocmafFormatError } from './errors.js';
import { childBoxes } from './iso-box.js';
import { parseLocmafTrackContext } from './track-context.js';
import { SYNC_FLAGS, buildChunk, videoInit } from '../test-support/cmaf.js';
import { isoBox } from '../test-support/bytes.js';

const context = parseLocmafTrackContext(videoInit());
const payload = Uint8Array.of(1, 2, 3, 4);

function fixture(trackId = context.trackId) {
    return buildChunk({
        trackId,
        bmdt: 90000,
        samples: [{ duration: 3000, size: payload.length, flags: SYNC_FLAGS }],
        mdat: payload,
        trailing: [isoBox('free', Uint8Array.of(11, 12, 13, 14))],
    });
}

describe('rawBoxes sample boundaries', () => {
    it('reads a sample within the mdat of the initialized track', () => {
        const read = readCmafChunkSamples(fixture(), context);
        expect(read.mdat).toEqual(payload);
        expect(read.effective.sizes).toEqual([4]);
    });

    it('rejects a lone traf whose track ID is absent from the initialization segment', () => {
        expect(() => readCmafChunkSamples(fixture(context.trackId + 1), context))
            .toThrow(LocmafFormatError);
    });

    it.each(['moof', 'mdat header', 'trailing free box', 'crossing the mdat end'])(
        'rejects a sample pointing into %s', (location) => {
            const chunk = fixture();
            const top = childBoxes(chunk, 0, chunk.length, '16');
            const moof = top.find((b) => b.type === 'moof')!;
            const mdat = top.find((b) => b.type === 'mdat')!;
            const free = top.find((b) => b.type === 'free')!;
            const traf = childBoxes(chunk, moof.contentStart, moof.end, '16').find((b) => b.type === 'traf')!;
            const trun = childBoxes(chunk, traf.contentStart, traf.end, '16').find((b) => b.type === 'trun')!;
            const target = location === 'moof' ? moof.contentStart
                : location === 'mdat header' ? mdat.start
                : location === 'trailing free box' ? free.contentStart
                : mdat.end - 2;
            new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                .setInt32(trun.contentStart + 8, target - moof.start);
            expect(() => readCmafChunkSamples(chunk, context)).toThrow(LocmafFormatError);
        },
    );
});
