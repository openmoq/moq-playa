import { describe, expect, it } from 'vitest';
import { sliceFrames } from './frame.js';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import type { LocmafEffectiveSamples } from './effective.js';

const clear: LocmafEffectiveSamples = { baseMediaDecodeTime: 0n, sampleDescriptionIndex: 1,
  durations: [1000, 1000], sizes: [1, 1], flags: [0x02000000, 0x01010000], compositionTimeOffsets: [0, 0], cenc: null };
const protectedSamples: LocmafEffectiveSamples = { baseMediaDecodeTime: 0n, sampleDescriptionIndex: 1,
  durations: [1000], sizes: [2], flags: [0x02000000], compositionTimeOffsets: [0],
  cenc: { perSampleIvSize: 8, ivs: new Uint8Array(8), subsampleCounts: [2], clearBytes: [0, 0], protectedBytes: [1, 1] } };
const budget = (maxEntries: number) => new LocmafReadBudget({ maxEntries, maxSamples: 2, maxBytes: 1 });
const read = (effective: LocmafEffectiveSamples, mdat: Uint8Array, allowance: LocmafReadBudget) =>
  sliceFrames(effective, mdat, allowance);

describe('LOCMAF frame record allowances', () => {
  it('keeps default clear-frame timing and byte views unchanged', () => {
    const bytes = Uint8Array.of(1, 2), frames = sliceFrames(clear, bytes);
    expect(frames.map(frame => frame.decodeTime)).toEqual([0n, 1000n]);
    expect(frames.map(frame => frame.isSync)).toEqual([true, false]);
    expect(frames.map(frame => [...frame.data])).toEqual([[1], [2]]);
    expect(frames.every(frame => frame.data.buffer === bytes.buffer)).toBe(true);
  });
  it('keeps default per-frame encryption metadata unchanged', () => {
    const frames = sliceFrames(protectedSamples, Uint8Array.of(1, 2));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.cenc?.iv).toHaveLength(8);
    expect(frames[0]!.cenc?.subsamples).toEqual([{ clearBytes: 0, protectedBytes: 1 }, { clearBytes: 0, protectedBytes: 1 }]);
  });

  it('refuses frame records before creating a partial batch', () => {
    const allowance = budget(1);
    expect(() => read(clear, Uint8Array.of(1, 2), allowance)).toThrow(LocmafReadLimitError);
    expect(allowance.usage.entries).toBe(0);
  });
  it('bounds the extra protected-frame record independently of frame count', () => {
    expect(() => read(protectedSamples, Uint8Array.of(1, 2), budget(1))).toThrow(LocmafReadLimitError);
  });
  it('bounds per-frame subsample records before their array allocation', () => {
    expect(() => read(protectedSamples, Uint8Array.of(1, 2), budget(3))).toThrow(LocmafReadLimitError);
  });
  it('counts frames once, borrows bytes and never charges samples a second time', () => {
    const allowance = budget(2), mdat = Uint8Array.of(1, 2);
    allowance.claimSamples(2);
    const frames = read(clear, mdat, allowance);
    expect(frames).toEqual(sliceFrames(clear, mdat));
    expect(frames.every(frame => frame.data.buffer === mdat.buffer)).toBe(true);
    expect(allowance.usage).toEqual({ samples: 2, entries: 2, bytes: 0 });
  });
  it('accepts the exact protected-frame and subsample allowance', () => {
    const allowance = budget(4), mdat = Uint8Array.of(1, 2);
    expect(read(protectedSamples, mdat, allowance)).toEqual(sliceFrames(protectedSamples, mdat));
    expect(allowance.usage).toEqual({ samples: 0, entries: 4, bytes: 0 });
  });
});
