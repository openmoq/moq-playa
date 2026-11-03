import { describe, expect, it } from 'vitest';
import { CmafAssembler } from './cmaf-assembler.js';
import { readBaseMediaDecodeTime } from './mp4-box.js';
import { parseLocmafTrackContext, readCmafChunkSamples } from '../../locmaf/src/index.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';

const chunk = (ticks: bigint, duration = 1000, cto = 0) => buildChunk({ bmdt: ticks,
  samples: [{ duration, size: 1, flags: SYNC_FLAGS, cto }] });
const init = (timescale: number, audio = true) => buildInit({ trackId: 1, timescale, handler: audio ? 'soun' : 'vide' });
function fixture() {
  const emitted: Array<{ type: 'video' | 'audio'; bytes: Uint8Array; name: string }> = [];
  const assembler = new CmafAssembler({ onSegment: (type, bytes, name) => emitted.push({ type, bytes, name }) });
  assembler.setInitSegment('video', init(1000, false));
  assembler.setInitSegment('audio', init(1000));
  assembler.push('video', 'video', 100n, chunk(990_000n));
  assembler.push('audio', 'old', 100n, chunk(990_000n));
  const last = () => readBaseMediaDecodeTime(emitted.at(-1)!.bytes)!;
  return { assembler, emitted, last };
}

describe('CMAF audio source-to-reference mapping', () => {
  it('maps source90 to reference1000 before subtracting retained origin990', () => {
    const f = fixture();
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.selectTrack('audio', 'new');
    const source = chunk(90_000n);
    f.assembler.push('audio', 'new', 2n, source);
    expect(f.last()).toBe(10_000n);
    expect(readBaseMediaDecodeTime(source)).toBe(90_000n);
    expect(f.assembler.getEpoch('video')).toBe(990_000n);
    f.assembler.push('video', 'video', 101n, chunk(1_001_000n));
    expect(f.last()).toBe(11_000n);
  });

  it('does not shift an explicit map to the old buffered audio end', () => {
    const f = fixture();
    f.assembler.push('audio', 'old', 101n, chunk(1_002_000n));
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.selectTrack('audio', 'new');
    f.assembler.push('audio', 'new', 2n, chunk(90_000n));
    expect(f.last()).toBe(10_000n);
  });

  it('keeps composition offsets and rescales the retained epoch on a new init', () => {
    const f = fixture(), next = init(44_100);
    f.assembler.setInitSegment('audio', next);
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.selectTrack('audio', 'new');
    f.assembler.push('audio', 'new', 2n, chunk(90n * 44_100n, 441, 441));
    const output = readCmafChunkSamples(f.emitted.at(-1)!.bytes, parseLocmafTrackContext(next));
    expect(output.effective.baseMediaDecodeTime).toBe(441_000n);
    expect(output.effective.compositionTimeOffsets).toEqual([441]);
    expect(f.assembler.getEpoch('video')).toBe(990_000n);
  });

  it('keeps exact arithmetic beyond Number precision', () => {
    const f = fixture(), raw = 9_007_199_254_740_993n;
    f.assembler.setInitSegment('audio', init(1_000_000));
    f.assembler.setAudioPresentationOffsetUs(1_000_000_000n - raw);
    f.assembler.selectTrack('audio', 'new');
    f.assembler.push('audio', 'new', 2n, chunk(raw));
    expect(f.last()).toBe(10_000_000n);
  });

  it('allows an explicit zero map when returning to the reference domain', () => {
    const f = fixture();
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.selectTrack('audio', 'new');
    f.assembler.push('audio', 'new', 2n, chunk(90_000n));
    f.assembler.setAudioPresentationOffsetUs(0n);
    f.assembler.selectTrack('audio', 'old');
    f.assembler.push('audio', 'old', 105n, chunk(1_000_500n));
    expect(f.last()).toBe(10_500n);
  });

  it('does not use Group IDs or a bare-name coincidence as a clock relationship', () => {
    const f = fixture();
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.selectTrack('audio', 'old');
    f.assembler.push('audio', 'old', 0n, chunk(90_000n));
    expect(f.last()).toBe(10_000n);
    f.assembler.push('audio', 'old', 1n, chunk(91_000n));
    expect(f.last()).toBe(11_000n);
  });

  it('refuses a mapped source restart without moving the shared video epoch', () => {
    const f = fixture();
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    const witness = f.assembler.getAudioPresentationMappingWitness();
    expect(witness).not.toBeNull();
    f.assembler.selectTrack('audio', 'new');
    f.assembler.push('audio', 'new', 0n, chunk(90_000n));
    expect(f.assembler.getAudioPresentationMappingWitness()).toBe(witness);
    const count = f.emitted.length;
    f.assembler.push('audio', 'new', 1n, chunk(0n));
    expect(f.emitted).toHaveLength(count);
    expect(f.assembler.getAudioPresentationMappingWitness()).toBeNull();
    expect(f.assembler.getEpoch('video')).toBe(990_000n);
    f.assembler.push('video', 'video', 101n, chunk(1_001_000n));
    expect(f.last()).toBe(11_000n);
  });

  it('restores default behavior when a prepared map is abandoned before media admission', () => {
    const f = fixture();
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.setAudioPresentationOffsetUs(null);
    expect(f.assembler.getAudioPresentationMappingWitness()).toBeNull();
    f.assembler.push('audio', 'old', 101n, chunk(991_000n));
    expect(f.last()).toBe(1000n);
  });

  it('requires an existing audio epoch and timescale instead of inventing a rebase', () => {
    const assembler = new CmafAssembler({ onSegment: () => {} });
    expect(() => assembler.setAudioPresentationOffsetUs(10n)).toThrow(/audio.*epoch/i);
    assembler.push('audio', 'a', 1n, chunk(0n));
    expect(() => assembler.setAudioPresentationOffsetUs(10n)).toThrow(/timescale/i);
  });

  it('clears the mapping on reset without changing the default rebase', () => {
    const f = fixture();
    f.assembler.setAudioPresentationOffsetUs(910_000_000n);
    f.assembler.reset();
    f.assembler.setInitSegment('video', init(1000, false));
    f.assembler.setInitSegment('audio', init(1000));
    f.assembler.push('video', 'video', 0n, chunk(0n));
    f.assembler.push('audio', 'audio', 0n, chunk(100n));
    expect(f.last()).toBe(100n);
  });
});
