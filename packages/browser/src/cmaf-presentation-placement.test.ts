import { describe, expect, it, vi } from 'vitest';
import { CmafAssembler } from './cmaf-assembler.js';
import * as mp4 from './mp4-box.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { parseLocmafTrackContext, readCmafChunkSamples } from '../../locmaf/src/index.js';

type MediaType = 'video' | 'audio';
const init = (type: MediaType, timescale: number, trackId = 1) =>
  buildInit({ trackId, timescale, handler: type === 'video' ? 'vide' : 'soun' });
const chunk = (dts: bigint, duration = 3600, cto = 0) => buildChunk({ bmdt: dts,
  samples: [{ duration, size: 1, flags: SYNC_FLAGS, cto }] });
function fixture() {
  const outputs: Array<{ type: MediaType; bytes: Uint8Array }> = [];
  const assembler = new CmafAssembler({ onSegment: (type, bytes) => outputs.push({ type, bytes }) });
  const last = (type: MediaType) => outputs.filter(output => output.type === type).at(-1)!.bytes;
  return { assembler, outputs, last };
}
function differentOrigins() {
  const f = fixture();
  // The documented no-timescale fallback establishes video epoch zero. A
  // later real init and fragment prove that placement, without private state.
  f.assembler.push('video', 'old-video', 0n, chunk(0n));
  f.assembler.setInitSegment('video', init('video', 90_000));
  f.assembler.push('video', 'old-video', 1n, chunk(540_000n));
  f.assembler.setInitSegment('audio', init('audio', 48_000));
  f.assembler.push('audio', 'audio', 1n, chunk(47_520_000n, 960));
  f.assembler.push('audio', 'audio', 2n, chunk(48_000_000n, 960));
  expect(f.assembler.getEpoch('video')).toBe(0n);
  expect(mp4.readBaseMediaDecodeTime(f.last('video'))).toBe(540_000n);
  expect(f.assembler.getEpoch('audio')).toBe(47_520_000n);
  expect(mp4.readBaseMediaDecodeTime(f.last('audio'))).toBe(480_000n);
  return f;
}
const atUs = (numerator: bigint, denominator = 1n) => ({ numerator, denominator });

describe('CMAF presentation placement', () => {
  const boundaries = ([0, 1] as const).flatMap(version => {
    const max = version === 0 ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn;
    return [-1n, 0n, max - 1n, max, max + 1n].map(patched => ({ version, patched, accepted: patched >= 0n && patched <= max }));
  });
  it.each(boundaries)('bounds tfdt v$version mapped DTS $patched before write and delivery', ({ version, patched, accepted }) => {
    const f = fixture(); f.assembler.setInitSegment('video', init('video', 1_000_000));
    f.assembler.push('video', 'old', 1n, chunk(0n, 1));
    const old = f.assembler.capturePresentationPlacement('video')!;
    f.assembler.setPresentationPlacement('video', { sourceTimeUs: 0n, rebasedTimeUs: atUs(patched) });
    f.assembler.selectTrack('video', 'new');
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    const bytes = buildChunk({ bmdt: 0n, tfdtVersion: version,
      samples: [{ duration: 1, size: 1, flags: SYNC_FLAGS }] }), original = bytes.slice();
    const count = f.outputs.length;
    const receipt = f.assembler.push('video', 'new', 0n, bytes, undefined, true);
    expect(bytes).toEqual(original);
    if (accepted) {
      expect(receipt).toEqual({ state: 'emitted', sourcePresentationTimeUs: 0n });
      expect(f.outputs).toHaveLength(count + 1);
      expect(mp4.readBaseMediaDecodeTime(f.last('video'))).toBe(patched);
      const current = f.assembler.capturePresentationPlacement('video')!;
      expect(current.token).not.toBe(old.token);
      expect(current.toRebasedTimeUs(0n)).toEqual(atUs(patched));
    } else {
      expect(receipt).toEqual({ state: 'refused' });
      expect(f.outputs).toHaveLength(count);
      expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    }
    expect(old.toRebasedTimeUs(0n)).toEqual(atUs(0n));
  });

  it('maps video through the actual audio placement, not the canonical raw delta', () => {
    const f = differentOrigins();
    const audio = f.assembler.capturePresentationPlacement('audio')!;
    const video = f.assembler.capturePresentationPlacement('video')!;
    const target = audio.toRebasedTimeUs(1_000_000_000n)!;
    expect(target).toEqual(atUs(10_000_000n));
    expect(video.toRebasedTimeUs(90_000_000n + 910_000_000n)).toEqual(atUs(1_000_000_000n));
    const bytes = chunk(8_096_400n, 3600, 3600), original = bytes.slice();
    f.assembler.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n, rebasedTimeUs: target });
    f.assembler.selectTrack('video', 'new-video');
    const receipt = f.assembler.push('video', 'new-video', 0n, bytes, undefined, true);
    const output = readCmafChunkSamples(f.last('video'), parseLocmafTrackContext(init('video', 90_000))).effective;
    expect(output.baseMediaDecodeTime).toBe(896_400n);
    expect(output.compositionTimeOffsets).toEqual([3600]);
    expect(output.baseMediaDecodeTime + BigInt(output.compositionTimeOffsets[0]!)).toBe(900_000n);
    expect(bytes).toEqual(original);
    expect(receipt).toEqual({ state: 'emitted', sourcePresentationTimeUs: 90_000_000n });
    expect(f.assembler.capturePresentationPlacement('audio')?.token).toBe(audio.token);
    expect(video.toRebasedTimeUs(6_000_000n)).toEqual(atUs(6_000_000n));
  });

  it.each([1000, 44_100, 90_000])('preserves spacing and composition at target timescale %s', timescale => {
    const f = differentOrigins(), header = init('video', timescale);
    f.assembler.setInitSegment('video', header);
    f.assembler.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) });
    f.assembler.selectTrack('video', 'new');
    const cto = timescale / 100, duration = timescale / 10;
    f.assembler.push('video', 'new', 0n, chunk(90n * BigInt(timescale) - BigInt(cto), duration, cto));
    const first = readCmafChunkSamples(f.last('video'), parseLocmafTrackContext(header)).effective;
    f.assembler.push('video', 'new', 1n, chunk(91n * BigInt(timescale) - BigInt(cto), duration, cto));
    const next = readCmafChunkSamples(f.last('video'), parseLocmafTrackContext(header)).effective;
    expect(first.baseMediaDecodeTime + BigInt(cto)).toBe(10n * BigInt(timescale));
    expect(next.baseMediaDecodeTime - first.baseMediaDecodeTime).toBe(BigInt(timescale));
    expect(next.compositionTimeOffsets).toEqual([cto]);
  });

  it.each([5n, 7n])('rounds the rational translation down once in target ticks: numerator %s', numerator => {
    const f = fixture(); f.assembler.setInitSegment('video', init('video', 3));
    f.assembler.setPresentationPlacement('video', { sourceTimeUs: 1_000_000n, rebasedTimeUs: atUs(numerator * 1_000_000n, 6n) });
    f.assembler.push('video', 'new', 0n, chunk(3n, 1));
    const ticks = numerator === 5n ? 2n : 3n;
    expect(mp4.readBaseMediaDecodeTime(f.last('video'))).toBe(ticks);
    expect(f.assembler.capturePresentationPlacement('video')?.toRebasedTimeUs(1_000_000n))
      .toEqual(numerator === 5n ? atUs(2_000_000n, 3n) : atUs(1_000_000n));
  });

  it('allows negative source anchors and returns honest negative projections without clamping', () => {
    const f = fixture(); f.assembler.setInitSegment('audio', init('audio', 1_000_000));
    f.assembler.setPresentationPlacement('audio', { sourceTimeUs: -1n, rebasedTimeUs: atUs(0n) });
    f.assembler.push('audio', 'new', 0n, chunk(0n, 1));
    expect(mp4.readBaseMediaDecodeTime(f.last('audio'))).toBe(1n);
    const placement = f.assembler.capturePresentationPlacement('audio')!;
    expect(placement.toRebasedTimeUs(-1n)).toEqual(atUs(0n));
    expect(placement.toRebasedTimeUs(-2n)).toEqual(atUs(-1n));
  });

  it('refuses negative mapped decode time instead of clamping it to zero', () => {
    const f = fixture(); f.assembler.setInitSegment('video', init('video', 1000));
    f.assembler.setPresentationPlacement('video', { sourceTimeUs: 1_000_000n, rebasedTimeUs: atUs(0n) });
    expect(f.assembler.push('video', 'new', 0n, chunk(999n, 1), undefined, true)).toEqual({ state: 'refused' });
    expect(f.outputs).toEqual([]); expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
  });

  it('keeps tokens stable on progress and immutable captured contexts after reset', () => {
    const f = differentOrigins(), captured = f.assembler.capturePresentationPlacement('audio')!;
    f.assembler.push('audio', 'audio', 3n, chunk(48_048_000n, 960));
    expect(f.assembler.capturePresentationPlacement('audio')).toBe(captured);
    f.assembler.reset(); expect(f.assembler.capturePresentationPlacement('audio')).toBeNull();
    expect(captured.toRebasedTimeUs(1_000_000_000n)).toEqual(atUs(10_000_000n));
    f.assembler.setInitSegment('audio', init('audio', 48_000));
    f.assembler.push('audio', 'audio', 0n, chunk(47_520_000n, 960));
    expect(f.assembler.capturePresentationPlacement('audio')?.token).not.toBe(captured.token);
  });

  it('requires init and successful sink delivery before exposing a placement', () => {
    let fail = true;
    const a = new CmafAssembler({ onSegment() { if (fail) throw new Error('sink rejected'); } });
    expect(a.capturePresentationPlacement('video')).toBeNull();
    a.setInitSegment('video', init('video', 1000));
    expect(a.capturePresentationPlacement('video')).toBeNull();
    expect(() => a.push('video', 'v', 0n, chunk(0n))).toThrow('sink rejected');
    expect(a.capturePresentationPlacement('video')).toBeNull();
    fail = false; a.push('video', 'v', 1n, chunk(1000n));
    expect(a.capturePresentationPlacement('video')).not.toBeNull();
  });

  it.each([0n, -1n, 1, undefined])('rejects invalid fraction denominator %s without changing placement', denominator => {
    const f = differentOrigins(), before = f.assembler.capturePresentationPlacement('video');
    expect(() => f.assembler.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n,
      rebasedTimeUs: { numerator: 10_000_000n, denominator } } as never)).toThrow();
    expect(f.assembler.capturePresentationPlacement('video')).toBe(before);
  });

  it('snapshots scalar anchor inputs and changes tokens on config and map changes', () => {
    const f = differentOrigins(), old = f.assembler.capturePresentationPlacement('video')!;
    const anchor = { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) };
    f.assembler.setPresentationPlacement('video', anchor);
    anchor.sourceTimeUs = 0n; anchor.rebasedTimeUs.numerator = 0n;
    f.assembler.selectTrack('video', 'new'); f.assembler.push('video', 'new', 0n, chunk(8_100_000n));
    expect(mp4.readBaseMediaDecodeTime(f.last('video'))).toBe(900_000n);
    const mapped = f.assembler.capturePresentationPlacement('video')!;
    expect(mapped.token).not.toBe(old.token);
    f.assembler.setInitSegment('video', init('video', 90_000));
    expect(f.assembler.capturePresentationPlacement('video')).toBe(mapped);
    f.assembler.setInitSegment('video', init('video', 90_000, 2));
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    f.assembler.push('video', 'new', 1n, chunk(8_190_000n));
    expect(f.assembler.capturePresentationPlacement('video')?.token).not.toBe(mapped.token);
  });

  it('retains ordinary shared rebasing and legacy audio mapping without source-timing reads', () => {
    const read = vi.spyOn(mp4, 'readFirstSamplePresentationTime');
    try {
      const f = fixture();
      f.assembler.setInitSegment('audio', init('audio', 1000)); f.assembler.setInitSegment('video', init('video', 1000));
      f.assembler.push('audio', 'old', 1n, chunk(990_000n, 20));
      f.assembler.push('video', 'v', 1n, chunk(990_500n, 40));
      expect(mp4.readBaseMediaDecodeTime(f.last('video'))).toBe(500n);
      f.assembler.setAudioPresentationOffsetUs(910_000_000n); f.assembler.selectTrack('audio', 'new');
      f.assembler.push('audio', 'new', 0n, chunk(90_000n, 20));
      expect(mp4.readBaseMediaDecodeTime(f.last('audio'))).toBe(10_000n);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('captures the output-origin offset after a normal source restart', () => {
    const f = fixture(); f.assembler.setInitSegment('audio', init('audio', 1000));
    f.assembler.push('audio', 'a', 0n, chunk(10_000n, 1000));
    const first = f.assembler.capturePresentationPlacement('audio')!;
    f.assembler.push('audio', 'a', 1n, chunk(12_000n, 1000));
    f.assembler.push('audio', 'a', 2n, chunk(10_000n, 1000));
    expect(mp4.readBaseMediaDecodeTime(f.last('audio'))).toBe(3000n);
    const next = f.assembler.capturePresentationPlacement('audio')!;
    expect(next.token).not.toBe(first.token);
    expect(first.toRebasedTimeUs(10_000_000n)).toEqual(atUs(0n));
    expect(next.toRebasedTimeUs(10_000_000n)).toEqual(atUs(3_000_000n));
  });

  it.each(['video', 'audio'] as const)('invalidates a refused mapped %s source restart without changing the shared reference', type => {
    const f = differentOrigins(), reference = f.assembler.capturePresentationPlacement(type === 'video' ? 'audio' : 'video')!;
    f.assembler.setInitSegment(type, init(type, 1000));
    f.assembler.setPresentationPlacement(type, { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) });
    f.assembler.selectTrack(type, 'new');
    f.assembler.push(type, 'new', 0n, chunk(90_000n, 100));
    const mapped = f.assembler.capturePresentationPlacement(type)!;
    f.assembler.push(type, 'new', 1n, chunk(92_000n, 100));
    expect(f.assembler.capturePresentationPlacement(type)).toBe(mapped);
    const count = f.outputs.length;
    expect(f.assembler.push(type, 'new', 2n, chunk(0n, 100), undefined, true)).toEqual({ state: 'refused' });
    expect(f.outputs).toHaveLength(count); expect(f.assembler.capturePresentationPlacement(type)).toBeNull();
    expect(f.assembler.capturePresentationPlacement(type === 'video' ? 'audio' : 'video')?.token).toBe(reference.token);
    expect(mapped.toRebasedTimeUs(90_000_000n)).toEqual(atUs(10_000_000n));
    f.assembler.setPresentationPlacement(type, { sourceTimeUs: 0n, rebasedTimeUs: atUs(13_000_000n) });
    f.assembler.push(type, 'new', 0n, chunk(0n, 100));
    expect(mp4.readBaseMediaDecodeTime(f.last(type))).toBe(13_000n);
    expect(f.assembler.capturePresentationPlacement(type)?.token).not.toBe(mapped.token);
  });

  it('keeps exact anchors beyond Number precision', () => {
    const f = fixture(), source = 9_007_199_254_740_993n;
    f.assembler.setInitSegment('audio', init('audio', 1_000_000));
    f.assembler.setPresentationPlacement('audio', { sourceTimeUs: source, rebasedTimeUs: atUs(10_000_000n) });
    f.assembler.push('audio', 'a', 0n, chunk(source, 1000));
    expect(mp4.readBaseMediaDecodeTime(f.last('audio'))).toBe(10_000_000n);
    expect(f.assembler.capturePresentationPlacement('audio')?.toRebasedTimeUs(source + 1n)).toEqual(atUs(10_000_001n));
  });

  it('retains mapping through a later init timescale change and preserves signed composition offsets', () => {
    const f = differentOrigins();
    f.assembler.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) });
    f.assembler.selectTrack('video', 'new'); f.assembler.push('video', 'new', 0n, chunk(8_100_000n));
    const old = f.assembler.capturePresentationPlacement('video')!;
    const header = init('video', 44_100);
    f.assembler.setInitSegment('video', header);
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    f.assembler.push('video', 'new', 1n, chunk(91n * 44_100n + 441n, 441, -441));
    const output = readCmafChunkSamples(f.last('video'), parseLocmafTrackContext(header)).effective;
    expect(output.baseMediaDecodeTime).toBe(11n * 44_100n + 441n);
    expect(output.compositionTimeOffsets).toEqual([-441]);
    expect(f.assembler.capturePresentationPlacement('video')?.token).not.toBe(old.token);
    expect(old.toRebasedTimeUs(90_000_000n)).toEqual(atUs(10_000_000n));
  });

  it('keeps split fragments unavailable until the mdat is emitted and keeps progress tokens stable', () => {
    const f = fixture(); f.assembler.setInitSegment('video', init('video', 1000));
    f.assembler.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) });
    const bytes = chunk(90_000n, 100), size = mp4.boxSize(bytes, 0);
    f.assembler.push('video', 'v', 0n, bytes.subarray(0, size));
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    f.assembler.push('video', 'v', 0n, bytes.subarray(size));
    const captured = f.assembler.capturePresentationPlacement('video')!;
    expect(captured.toRebasedTimeUs(90_000_000n)).toEqual(atUs(10_000_000n));
    f.assembler.push('video', 'v', 1n, chunk(91_000n, 100));
    expect(f.assembler.capturePresentationPlacement('video')).toBe(captured);
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.token)).toBe(true);
    expect(captured.toRebasedTimeUs(90_000_000 as never)).toBeNull();
  });

  it('does not claim placement before init or after reentrant reset at segment delivery', () => {
    const f = fixture(); f.assembler.push('video', 'v', 0n, chunk(0n));
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    f.assembler.setInitSegment('video', init('video', 1000));
    expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
    f.assembler.push('video', 'v', 1n, chunk(1000n));
    expect(f.assembler.capturePresentationPlacement('video')).not.toBeNull();
    const a = new CmafAssembler({ onSegment() { a.reset(); } });
    a.setInitSegment('video', init('video', 1000)); a.push('video', 'v', 0n, chunk(0n));
    expect(a.capturePresentationPlacement('video')).toBeNull();
  });

  it.each([{ sourceTimeUs: 1, rebasedTimeUs: atUs(0n) },
    { sourceTimeUs: 1n, rebasedTimeUs: { numerator: 0, denominator: 1n } },
    { sourceTimeUs: 1n, rebasedTimeUs: null }, undefined])('rejects malformed scalar anchors %#', anchor => {
    const f = differentOrigins(), before = f.assembler.capturePresentationPlacement('video');
    expect(() => f.assembler.setPresentationPlacement('video', anchor as never)).toThrow();
    expect(f.assembler.capturePresentationPlacement('video')).toBe(before);
  });

  it('lets legacy audio setter and null retain their documented default semantics', () => {
    const f = differentOrigins();
    f.assembler.setPresentationPlacement('audio', { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) });
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.selectTrack('audio', 'new'); f.assembler.push('audio', 'new', 0n, chunk(90n * 48_000n, 960));
    expect(mp4.readBaseMediaDecodeTime(f.last('audio'))).toBe(10n * 48_000n);
    expect(f.assembler.capturePresentationPlacement('audio')?.toRebasedTimeUs(90_000_000n)).toEqual(atUs(10_000_000n));
    f.assembler.setPresentationPlacement('audio', null);
    f.assembler.selectTrack('audio', 'old'); f.assembler.push('audio', 'old', 5n, chunk(1001n * 48_000n, 960));
    expect(mp4.readBaseMediaDecodeTime(f.last('audio'))).toBe(11n * 48_000n);
    expect(f.assembler.getAudioPresentationMappingWitness()).toBeNull();
  });

  it('requests no source-PTS parse or receipt for opt-in mapping alone', () => {
    const read = vi.spyOn(mp4, 'readFirstSamplePresentationTime');
    try {
      const f = fixture(); f.assembler.setInitSegment('video', init('video', 1000));
      f.assembler.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) });
      expect(f.assembler.push('video', 'v', 0n, chunk(90_000n))).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it('does not prove an unapplied map through a later tfdt-less chunk after sink rejection', () => {
    let fail = true;
    const a = new CmafAssembler({ onSegment() { if (fail) throw new Error('sink rejected'); } });
    a.setInitSegment('video', init('video', 1000));
    a.setPresentationPlacement('video', { sourceTimeUs: 90_000_000n, rebasedTimeUs: atUs(10_000_000n) });
    expect(() => a.push('video', 'v', 0n, chunk(90_000n))).toThrow('sink rejected');
    expect(a.capturePresentationPlacement('video')).toBeNull();
    const missing = chunk(91_000n), tfdt = mp4.findTfdtOffset(missing)!;
    missing.set([0x66, 0x72, 0x65, 0x65], tfdt.offset + 4); // free box instead of tfdt
    fail = false; a.push('video', 'v', 1n, missing);
    expect(a.capturePresentationPlacement('video')).toBeNull();
    a.push('video', 'v', 2n, chunk(92_000n));
    expect(a.capturePresentationPlacement('video')?.toRebasedTimeUs(92_000_000n)).toEqual(atUs(12_000_000n));
  });
});
