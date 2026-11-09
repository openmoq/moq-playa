import { describe, expect, it, vi } from 'vitest';
import { parseLocmafTrackContext } from './track-context.js';
import { codecDescriptionFromInit } from './frame.js';
import { LocmafReadBudget, LocmafReadLimitError } from './read-budget.js';
import { videoInit, audioInit, cencVideoInit } from '../test-support/cmaf.js';

const allowance = (maxEntries = 1000, maxBytes = 1000) =>
  new LocmafReadBudget({ maxSamples: 1, maxEntries, maxBytes });

describe('LOCMAF Header read allowances', () => {
  it('counts the valid AAC description copy exactly', () => {
    const budget = allowance(1000, 2);
    expect(codecDescriptionFromInit(audioInit(), budget)).toEqual(Uint8Array.of(0x12, 0x10));
    expect(budget.usage.bytes).toBe(2);
  });

  it('bounds context box records before traversing the whole Header', () => {
    expect(() => parseLocmafTrackContext(videoInit(), allowance(1)))
      .toThrow(LocmafReadLimitError);
  });
  it('bounds codec-description box records independently of copied bytes', () => {
    expect(() => codecDescriptionFromInit(videoInit(), allowance(1)))
      .toThrow(LocmafReadLimitError);
  });
  it('reserves description bytes before the actual copy', () => {
    const init = videoInit(), slices = vi.spyOn(Uint8Array.prototype, 'slice');
    try {
      expect(() => codecDescriptionFromInit(init, allowance(1000, 1)))
        .toThrow(LocmafReadLimitError);
      expect(slices).not.toHaveBeenCalled();
    } finally { slices.mockRestore(); }
  });
  it('bounds retained KID and constant-IV copies cumulatively', () => {
    const init = cencVideoInit(0), budget = allowance(1000, 16);
    expect(() => parseLocmafTrackContext(init, budget)).toThrow(LocmafReadLimitError);
    expect(budget.usage.bytes).toBe(16);
  });
  it('preserves the existing Header context and description without an allowance', () => {
    const context = parseLocmafTrackContext(videoInit());
    expect(context).toMatchObject({ trackId: 1, timescale: 90000, codecFourcc: 'avc1', isProtected: false });
    expect(codecDescriptionFromInit(videoInit())).toEqual(Uint8Array.of(1, 100, 0, 40, 0xff, 0xe1, 0, 0, 1, 0));
  });
});
