import { afterEach, describe, expect, it, vi } from 'vitest';
import { CmafAssembler } from './cmaf-assembler.js';
import * as mp4 from './mp4-box.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
const init = buildInit({ trackId: 1, timescale: 1000, handler: 'soun' });
const chunk = (bmdt: bigint, cto = 20) => buildChunk({ bmdt, samples: [{ duration: 20, size: 1, flags: SYNC_FLAGS, cto }] });
afterEach(() => vi.restoreAllMocks());

describe('opt-in CMAF source timing receipt', () => {
  it('returns raw source presentation time only after actual assembler delivery', () => {
    const delivered = vi.fn(), assembler = new CmafAssembler({ onSegment: delivered });
    assembler.setInitSegment('audio', init);
    const receipt = assembler.push('audio', 'a', 1n, chunk(90_000n), undefined, true);
    expect(delivered).toHaveBeenCalledOnce();
    expect(receipt).toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
  });

  it('leaves default call arity and return behavior unchanged', () => {
    const delivered = vi.fn(), assembler = new CmafAssembler({ onSegment: delivered });
    const timingRead = vi.spyOn(mp4, 'readFirstSamplePresentationTime');
    assembler.setInitSegment('audio', init);
    expect(assembler.push('audio', 'a', 1n, chunk(90_000n))).toBeUndefined();
    expect(delivered.mock.calls[0]).toHaveLength(4);
    expect(timingRead).not.toHaveBeenCalled();
    expect(assembler.push('audio', 'a', 2n, chunk(90_020n), undefined, true)).toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_040_000n });
    expect(timingRead).toHaveBeenCalledOnce();
  });

  it('reports a partial pair instead of repeating a preceding source timestamp', () => {
    const assembler = new CmafAssembler({ onSegment: () => {} }); assembler.setInitSegment('audio', init);
    expect(assembler.push('audio', 'a', 1n, chunk(90_000n), undefined, true)).toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
    const bytes = chunk(90_020n), size = new DataView(bytes.buffer).getUint32(0);
    expect(assembler.push('audio', 'a', 2n, bytes.slice(0, size), undefined, true)).toEqual({ state: 'partial' });
    expect(assembler.push('audio', 'a', 2n, bytes.slice(size), undefined, true)).toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_040_000n });
  });

  it('does not publish a receipt from the first chunk of an ultimately refused multi-chunk object', () => {
    const delivered = vi.fn(), assembler = new CmafAssembler({ onSegment: delivered });
    assembler.setInitSegment('audio', init); assembler.push('audio', 'old', 1n, chunk(990_000n));
    assembler.selectTrack('audio', 'new'); assembler.setAudioPresentationOffsetUs(910_000_000n);
    const first = chunk(90_000n), second = chunk(0n), bytes = new Uint8Array(first.length + second.length);
    bytes.set(first); bytes.set(second, first.length);
    const before = delivered.mock.calls.length;
    expect(assembler.push('audio', 'new', 2n, bytes, undefined, true)).toEqual({ state: 'refused' });
    expect(delivered).toHaveBeenCalledTimes(before);
  });

  it('reports unavailable timing when the timescale is unknown', () => {
    const delivered = vi.fn(), assembler = new CmafAssembler({ onSegment: delivered });
    expect(assembler.push('audio', 'a', 1n, chunk(90_000n), undefined, true)).toEqual({ state: 'unavailable' });
    expect(delivered).toHaveBeenCalledOnce();
  });
});
