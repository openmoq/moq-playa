import { describe, expect, it } from 'vitest';
import { buildInit, buildChunk, videoInit, SYNC_FLAGS } from '../../../packages/locmaf/test-support/cmaf.js';
import { analyzeCmafTimeline, rebaseTfdtCopy } from './cmaf-loop-rebase.js';

const chunk = (bmdt: number, trackId = 1, duration = 45000) => buildChunk({ bmdt, trackId,
  samples: [{ duration, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8) });

describe('CMAF timestamp pacing', () => {
  it('rebases a Node Buffer without mutating the original or compounding later loops', () => {
    const original = Buffer.from(chunk(0));
    const before = new Uint8Array(original);
    const first = rebaseTfdtCopy(original, 45000n);
    expect(new Uint8Array(original)).toEqual(before);
    const second = rebaseTfdtCopy(original, 90000n);
    expect(first).toEqual(rebaseTfdtCopy(before, 45000n));
    expect(second).toEqual(rebaseTfdtCopy(before, 90000n));
    expect(new Uint8Array(original)).toEqual(before);
  });
  it('uses the header timescale and includes the final chunk duration', () => {
    expect(analyzeCmafTimeline(videoInit(), [chunk(90000), chunk(135000)])).toEqual({
      timescale: 90000, offsetsMs: [0, 500], durationsMs: [500, 500], durationMs: 1000,
    });
  });
  it('does not pace a different track with the selected header timescale', () => {
    expect(analyzeCmafTimeline(videoInit(), [chunk(0, 2)])).toBeNull();
  });
  it('rejects nonadvancing or overlapping fragments', () => {
    expect(analyzeCmafTimeline(videoInit(), [chunk(0), chunk(0)])).toBeNull();
    expect(analyzeCmafTimeline(videoInit(), [chunk(0, 1, 0)])).toBeNull();
  });
  it('retains timestamp holes instead of collapsing the send schedule', () => {
    expect(analyzeCmafTimeline(videoInit(), [chunk(0), chunk(90000)])?.offsetsMs).toEqual([0, 1000]);
  });
  it('validates rebasing support for intermediate chunks, not just both endpoints', () => {
    const init = buildInit({ trackId: 1, timescale: 90000, handler: 'vide', trex: { duration: 45000 } });
    const middle = buildChunk({ bmdt: 45000, samples: [{ duration: 45000, size: 8, flags: SYNC_FLAGS }],
      trun: { size: true, flags: true }, mdat: new Uint8Array(8) });
    expect(analyzeCmafTimeline(init, [chunk(0), middle, chunk(90000)])).toBeNull();
  });
});
