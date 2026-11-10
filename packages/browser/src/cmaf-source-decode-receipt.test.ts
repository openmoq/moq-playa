import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CmafSourceReceipt } from '../../player/src/interfaces.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { CmafAssembler } from './cmaf-assembler.js';
import * as mp4 from './mp4-box.js';

type MediaType = 'video' | 'audio';
const init = (type: MediaType, timescale = 1000) =>
  buildInit({ trackId: 1, timescale, handler: type === 'video' ? 'vide' : 'soun' });
const changedInit = (timescale: number) => buildInit({ trackId: 1, timescale,
  handler: 'vide', trex: { duration: 40 } });
const chunk = (dts: bigint, cto = 20) => buildChunk({ bmdt: dts,
  samples: [{ duration: 40, size: 1, flags: SYNC_FLAGS, cto }] });
function joined(...chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function halves(bytes: Uint8Array): readonly [Uint8Array, Uint8Array] {
  const end = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return [bytes.slice(0, end), bytes.slice(end)];
}
function emitted(receipt: void | CmafSourceReceipt): Extract<CmafSourceReceipt, { state: 'emitted' }> {
  expect(receipt?.state).toBe('emitted');
  if (!receipt || receipt.state !== 'emitted') throw new Error('No emitted receipt');
  return receipt;
}
function fixture(type: MediaType = 'video', timescale = 1000) {
  const outputs: Uint8Array[] = [];
  let onSegment: (() => void) | undefined;
  const assembler = new CmafAssembler({ onSegment: (_type, bytes) => {
    outputs.push(bytes); onSegment?.();
  } });
  const header = init(type, timescale);
  assembler.setInitSegment(type, header);
  return { assembler, outputs, header, duringEmit(callback: () => void) { onSegment = callback; } };
}
function expectDecode(assembler: CmafAssembler, type: MediaType, receipt: void | CmafSourceReceipt,
  timeUs: bigint, timescale: number) {
  const value = emitted(receipt);
  const placement = assembler.capturePresentationPlacement(type);
  expect(placement).not.toBeNull();
  expect(value.sourceDecodeTime).toEqual({ timeUs, timescale, placementToken: placement!.token });
  return value;
}

afterEach(() => vi.restoreAllMocks());

describe('CMAF source decode receipts', () => {
  it.each(['video', 'audio'] as const)('reports raw %s DTS separately from CTO-adjusted PTS and patched DTS', type => {
    const f = fixture(type), bytes = chunk(90_000n), original = bytes.slice();
    const value = expectDecode(f.assembler, type,
      f.assembler.push(type, 'track', 1n, bytes, undefined, true), 90_000_000n, 1000);
    expect(value.sourcePresentationTimeUs).toBe(90_020_000n);
    expect(mp4.readBaseMediaDecodeTime(f.outputs[0]!)).toBe(0n);
    expect(bytes).toEqual(original);
  });

  it('reports the first DTS of the last successive chunk, not the first chunk or last sample', () => {
    const f = fixture();
    const last = buildChunk({ bmdt: 90_040n, samples: [
      { duration: 40, size: 1, flags: SYNC_FLAGS, cto: -10 },
      { duration: 40, size: 1, flags: SYNC_FLAGS, cto: 0 },
    ] });
    const timingRead = vi.spyOn(mp4, 'readFirstSamplePresentationTime');
    const value = expectDecode(f.assembler, 'video', f.assembler.push('video', 'v', 1n,
      joined(chunk(90_000n), last), undefined, true), 90_040_000n, 1000);
    expect(value.sourcePresentationTimeUs).toBe(90_030_000n);
    expect(timingRead).toHaveBeenCalledTimes(2);
    expect(f.outputs).toHaveLength(1);
  });

  it.each([44_100, 90_000, 1_000_000])('normalizes large source ticks with BigInt at scale %s', timescale => {
    const f = fixture('video', timescale), ticks = 9_007_199_254_740_993n;
    const value = expectDecode(f.assembler, 'video',
      f.assembler.push('video', 'v', 1n, chunk(ticks, 0), undefined, true),
      ticks * 1_000_000n / BigInt(timescale), timescale);
    expect(value.sourcePresentationTimeUs).toBe(ticks * 1_000_000n / BigInt(timescale));
  });

  it('keeps the placement token for equal init bytes and continuing chunks', () => {
    const f = fixture();
    const first = expectDecode(f.assembler, 'video',
      f.assembler.push('video', 'v', 1n, chunk(90_000n), undefined, true), 90_000_000n, 1000);
    f.assembler.setInitSegment('video', f.header.slice());
    const second = expectDecode(f.assembler, 'video',
      f.assembler.push('video', 'v', 2n, chunk(90_040n), undefined, true), 90_040_000n, 1000);
    expect(second.sourceDecodeTime!.placementToken).toBe(first.sourceDecodeTime!.placementToken);
  });

  it.each(['init', 'reset', 'selection'] as const)('invalidates the token after %s and proves the new delivery', change => {
    const f = fixture();
    const first = expectDecode(f.assembler, 'video',
      f.assembler.push('video', 'v', 1n, chunk(90_000n), undefined, true), 90_000_000n, 1000);
    let track = 'v';
    if (change === 'init') f.assembler.setInitSegment('video', changedInit(1000));
    else if (change === 'reset') { f.assembler.reset(); f.assembler.setInitSegment('video', f.header); }
    else { track = 'next'; f.assembler.selectTrack('video', track); }
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    const second = expectDecode(f.assembler, 'video',
      f.assembler.push('video', track, 2n, chunk(90_040n), undefined, true), 90_040_000n, 1000);
    expect(second.sourceDecodeTime!.placementToken).not.toBe(first.sourceDecodeTime!.placementToken);
  });

  it.each(['reset', 'init', 'selection'] as const)('omits new metadata when onSegment changes %s', change => {
    const f = fixture();
    f.duringEmit(() => {
      if (change === 'reset') f.assembler.reset();
      else if (change === 'init') f.assembler.setInitSegment('video', init('video', 2000));
      else f.assembler.selectTrack('video', 'next');
    });
    expect(emitted(f.assembler.push('video', 'v', 1n, chunk(90_000n), undefined, true)))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
    expect(f.outputs).toHaveLength(1);
  });

  it('omits new metadata after startup geometry invalidates an already delivered placement', () => {
    const f = fixture('audio');
    f.assembler.setInitSegment('video', init('video'));
    f.assembler.push('video', 'v', 1n, chunk(90_000n));
    const geometry = vi.fn(() => f.assembler.reset());
    f.assembler.onStartupGeometry = geometry;
    expect(emitted(f.assembler.push('audio', 'a', 1n, chunk(90_000n), undefined, true)))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
    expect(geometry).toHaveBeenCalledOnce();
  });

  it('allows equal init reentry without invalidating the delivery token', () => {
    const f = fixture(); f.duringEmit(() => f.assembler.setInitSegment('video', f.header.slice()));
    expectDecode(f.assembler, 'video', f.assembler.push('video', 'v', 1n, chunk(90_000n), undefined, true),
      90_000_000n, 1000);
  });

  it('preserves the PTS-only receipt when presentation placement is unavailable', () => {
    const f = fixture(); vi.spyOn(f.assembler, 'capturePresentationPlacement').mockReturnValue(null);
    expect(f.assembler.push('video', 'v', 1n, chunk(90_000n), undefined, true))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
  });

  it('keeps default and explicitly false source timing inert', () => {
    const f = fixture(), capture = vi.spyOn(f.assembler, 'capturePresentationPlacement');
    const pts = vi.spyOn(mp4, 'readFirstSamplePresentationTime');
    expect(f.assembler.push('video', 'v', 1n, chunk(90_000n))).toBeUndefined();
    expect(Reflect.apply(f.assembler.push, f.assembler, ['video', 'v', 2n, chunk(90_040n), undefined, false]))
      .toBeUndefined();
    expect(capture).not.toHaveBeenCalled(); expect(pts).not.toHaveBeenCalled();
    expect(f.outputs).toHaveLength(2);
  });

  it('leaves unknown timescale timing unavailable while delivering the segment', () => {
    const outputs = vi.fn(), assembler = new CmafAssembler({ onSegment: outputs });
    expect(assembler.push('video', 'v', 1n, chunk(90_000n), undefined, true)).toEqual({ state: 'unavailable' });
    expect(outputs).toHaveBeenCalledOnce();
  });

  it('does not report the first chunk of a refused multi-chunk object', () => {
    const f = fixture('audio'); f.assembler.push('audio', 'old', 1n, chunk(990_000n));
    f.assembler.selectTrack('audio', 'next'); f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    expect(f.assembler.push('audio', 'next', 2n, joined(chunk(90_000n), chunk(0n)), undefined, true))
      .toEqual({ state: 'refused' });
    expect(f.outputs).toHaveLength(1);
  });
});

describe('legacy split source decode receipts', () => {
  it('compares pre-patch configuration even when the first patch establishes a new epoch', () => {
    const f = fixture(), [moof, mdat] = halves(chunk(90_000n));
    expect(f.assembler.push('video', 'v', 1n, moof, undefined, true)).toEqual({ state: 'partial' });
    expectDecode(f.assembler, 'video', f.assembler.push('video', 'v', 1n, mdat, undefined, true),
      90_000_000n, 1000);
  });

  it('preserves timing across equal init bytes between halves', () => {
    const f = fixture(), [moof, mdat] = halves(chunk(90_000n));
    f.assembler.push('video', 'v', 1n, moof, undefined, true);
    f.assembler.setInitSegment('video', f.header.slice());
    expectDecode(f.assembler, 'video', f.assembler.push('video', 'v', 1n, mdat, undefined, true),
      90_000_000n, 1000);
  });

  it.each([1000, 2000])('keeps assembly and the old PTS receipt but omits decode proof for changed init scale %s', timescale => {
    const f = fixture(), [moof, mdat] = halves(chunk(90_000n));
    f.assembler.push('video', 'v', 1n, moof, undefined, true);
    f.assembler.setInitSegment('video', changedInit(timescale));
    expect(f.assembler.push('video', 'v', 1n, mdat, undefined, true)).toEqual({
      state: 'emitted', sourcePresentationTimeUs: 90_020n * 1_000_000n / BigInt(timescale),
    });
    expect(f.outputs).toHaveLength(1);
  });

  it('does not infer moof configuration when only mdat requested source timing', () => {
    const f = fixture(), [moof, mdat] = halves(chunk(90_000n));
    f.assembler.push('video', 'v', 1n, moof);
    expect(f.assembler.push('video', 'v', 1n, mdat, undefined, true))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
    expect(f.outputs).toHaveLength(1);
  });

  it('does not infer a configuration that became known only after the moof', () => {
    const assembler = new CmafAssembler({ onSegment: () => {} }), [moof, mdat] = halves(chunk(90_000n));
    assembler.push('video', 'v', 1n, moof, undefined, true);
    assembler.setInitSegment('video', init('video'));
    expect(assembler.push('video', 'v', 1n, mdat, undefined, true))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
  });

  it('omits decode metadata if split delivery reenters reset', () => {
    const f = fixture(), [moof, mdat] = halves(chunk(90_000n));
    f.assembler.push('video', 'v', 1n, moof, undefined, true);
    f.duringEmit(() => f.assembler.reset());
    expect(f.assembler.push('video', 'v', 1n, mdat, undefined, true))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_020_000n });
  });

  it('uses only replacement moof ownership and clears stale pending timing', () => {
    const f = fixture(), [old] = halves(chunk(90_000n));
    f.assembler.push('video', 'v', 1n, old, undefined, true);
    f.assembler.clearPending('video');
    const [moof, mdat] = halves(chunk(90_040n));
    f.assembler.push('video', 'v', 1n, moof);
    expect(f.assembler.push('video', 'v', 1n, mdat, undefined, true))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_060_000n });
  });

  it('does not lend replaced moof timing to an unobserved replacement', () => {
    const f = fixture(), [old] = halves(chunk(90_000n)), [moof, mdat] = halves(chunk(90_040n));
    f.assembler.push('video', 'v', 1n, old, undefined, true);
    f.assembler.push('video', 'v', 1n, moof);
    expect(f.assembler.push('video', 'v', 1n, mdat, undefined, true))
      .toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_060_000n });
    expect(f.outputs).toHaveLength(1);
  });

  it('uses the observed replacement moof rather than the replaced source time', () => {
    const f = fixture(), [old] = halves(chunk(90_000n)), [moof, mdat] = halves(chunk(90_040n));
    f.assembler.push('video', 'v', 1n, old, undefined, true);
    f.assembler.push('video', 'v', 1n, moof, undefined, true);
    expectDecode(f.assembler, 'video', f.assembler.push('video', 'v', 1n, mdat, undefined, true),
      90_040_000n, 1000);
    expect(f.outputs).toHaveLength(1);
  });

  it('does not allocate pending source metadata for default callers and releases it on reset', () => {
    const f = fixture(), [moof] = halves(chunk(90_000n));
    f.assembler.push('video', 'v', 1n, moof);
    expect(Reflect.get(f.assembler, 'pendingSourceConfigurations')).toBeUndefined();
    f.assembler.push('video', 'v', 2n, moof, undefined, true);
    expect(Reflect.get(f.assembler, 'pendingSourceConfigurations')).toBeInstanceOf(WeakMap);
    f.assembler.reset();
    expect(Reflect.get(f.assembler, 'pendingSourceConfigurations')).toBeUndefined();
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
  });
});
