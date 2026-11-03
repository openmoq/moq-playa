import { describe, expect, it } from 'vitest';
import { rewriteTrackIds } from './track-ids.js';
import { parseLocmafTrackContext, parseCmafChunk } from '../../packages/locmaf/src/index.js';
import { childBoxes, viewOf } from '../../packages/locmaf/src/iso-box.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';
import { concat, fullBox, u32 } from '../../packages/locmaf/test-support/bytes.js';

function fixture(version: 0 | 1 = 0) {
  const init = buildInit({ trackId: 1, timescale: 60000, handler: 'vide', headerVersion: version });
  const sidx = fullBox('sidx', 0, 0, u32(1), u32(60000), u32(0), u32(0), u32(0));
  const mdat = Uint8Array.of(0, 0, 0, 1, 0x74, 0x66, 0x68, 0x64); // includes the old ID and a box-like name
  const chunk = concat(sidx, buildChunk({ trackId: 1, bmdt: 180000,
    samples: [{ duration: 2500, size: mdat.length, flags: SYNC_FLAGS }], mdat }));
  return { init, chunk, mdat };
}

describe('acceptance fixture track IDs', () => {
  it.each([0, 1] as const)('rewrites version %s init and media consistently without touching source or mdat', (version) => {
    const { init, chunk, mdat } = fixture(version);
    const before = [Uint8Array.from(init), Uint8Array.from(chunk)];
    const inputInit = Buffer.from(init), inputChunk = Buffer.from(chunk);
    const result = rewriteTrackIds(inputInit, [inputChunk], 4);
    expect(result.context).toEqual({ trackId: 4, timescale: 60000 });
    const context = parseLocmafTrackContext(result.initData);
    expect(context.trackId).toBe(4); // also requires the matching trex
    const parsed = parseCmafChunk(result.chunks[0]!, context);
    expect(parsed.fits).toBe(true); // also checks tfhd against tkhd/trex
    if (parsed.fits) {
      expect(parsed.mdat).toEqual(mdat);
      expect(parsed.effective.baseMediaDecodeTime).toBe(180000n);
    }
    const sidx = childBoxes(result.chunks[0]!, 0, chunk.length, 'test').find(box => box.type === 'sidx')!;
    expect(viewOf(result.chunks[0]!).getUint32(sidx.contentStart + 4)).toBe(4);
    expect([Uint8Array.from(inputInit), Uint8Array.from(inputChunk)]).toEqual(before);
    const moov = childBoxes(result.initData, 0, init.length, 'test').find(box => box.type === 'moov')!;
    const mvhd = childBoxes(result.initData, moov.contentStart, moov.end, 'test').find(box => box.type === 'mvhd')!;
    expect(viewOf(result.initData).getUint32(mvhd.contentStart + 96)).toBe(5);
  });

  it('rejects a structurally valid fragment for a different track', () => {
    const { init } = fixture();
    const wrongTrack = buildChunk({ trackId: 3, bmdt: 0,
      samples: [{ duration: 2500, size: 4, flags: SYNC_FLAGS }], mdat: new Uint8Array(4) });
    expect(() => rewriteTrackIds(init, [wrongTrack], 4)).toThrow(/original fixture chunk/);
  });

  it('rejects a valid init whose trex does not match tkhd', () => {
    const { init, chunk } = fixture();
    const moov = childBoxes(init, 0, init.length, 'test').find(box => box.type === 'moov')!;
    const mvex = childBoxes(init, moov.contentStart, moov.end, 'test').find(box => box.type === 'mvex')!;
    const trex = childBoxes(init, mvex.contentStart, mvex.end, 'test')[0]!;
    viewOf(init).setUint32(trex.contentStart + 4, 9);
    expect(() => rewriteTrackIds(init, [chunk], 4)).toThrow(/trex/);
  });

  it('rejects a mismatched sidx and malformed boxes', () => {
    const { init, chunk } = fixture();
    viewOf(chunk).setUint32(12, 8);
    expect(() => rewriteTrackIds(init, [chunk], 4)).toThrow(/inconsistent fixture track ID/);
    expect(() => rewriteTrackIds(init.subarray(0, 20), [chunk], 4)).toThrow();
  });

  it.each([0, -1, 1.5, 0xffffffff])('rejects invalid output ID %s', (id) => {
    const { init, chunk } = fixture();
    expect(() => rewriteTrackIds(init, [chunk], id)).toThrow(/invalid fixture track ID/);
  });
});
