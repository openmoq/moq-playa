import { describe, expect, it, vi } from 'vitest';
import { CmafAssembler, type CmafAssemblerOptions } from './cmaf-assembler.js';
import * as mp4 from './mp4-box.js';
import { mediaTrackIdentity } from './media-track-identity.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';

type MediaType = 'video' | 'audio';
const keyA = JSON.stringify([['publisher', 'a'], 'shared']);
const keyB = JSON.stringify([['publisher', 'b'], 'shared']);
const chunk = (dts = 10_000n) => buildChunk({ bmdt: dts,
  samples: [{ duration: 100, size: 1, flags: SYNC_FLAGS }] });
function halves() {
  const bytes = chunk(), size = new DataView(bytes.buffer).getUint32(0);
  return [bytes.slice(0, size), bytes.slice(size)] as const;
}
function fixture(options: Partial<CmafAssemblerOptions> = {}) {
  const onSegment = vi.fn(), onDiscard = vi.fn(), onDiscontinuity = vi.fn();
  const assembler = new CmafAssembler({ onSegment, onDiscard, onDiscontinuity, ...options });
  return { assembler, onSegment, onDiscard, onDiscontinuity };
}
function initialize(assembler: CmafAssembler, type: MediaType) {
  assembler.setInitSegment(type, buildInit({ trackId: 1, timescale: 1000, handler: type === 'video' ? 'vide' : 'soun' }));
}

describe('CMAF full track identity', () => {
  it.each(['', 'x', 'source:x', 'name:x', keyA, '\0:name:source:'])('separates keyed and legacy identity for %j', key => {
    expect(mediaTrackIdentity(key)).not.toBe(mediaTrackIdentity(key, key));
    expect(mediaTrackIdentity('display-a', key)).toBe(mediaTrackIdentity('display-b', key));
    expect(mediaTrackIdentity(key)).toBe(`name:${key}`);
    expect(mediaTrackIdentity('display', key)).toBe(`source:${key}`);
  });

  it.each(['video', 'audio'] as const)('does not pair same-name %s halves from different namespaces', type => {
    const { assembler, onSegment, onDiscard } = fixture(), [moof, mdat] = halves();
    const a = {}, b = {}, tail = {};
    assembler.push(type, 'shared', 1n, moof, a, undefined, keyA);
    assembler.push(type, 'shared', 1n, mdat, b, undefined, keyB);
    expect(onSegment).not.toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith(b, 'orphaned media');
    assembler.push(type, 'shared', 1n, mdat, tail, undefined, keyA);
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment.mock.calls[0]!.slice(2)).toEqual(['shared', 1n, [a, tail], keyA]);
  });

  it('does not pair a literal legacy name with an equal opaque source key', () => {
    const { assembler, onSegment, onDiscard } = fixture(), [moof, mdat] = halves(), rejected = {};
    assembler.push('video', keyA, 1n, moof);
    assembler.push('video', keyA, 1n, mdat, rejected, undefined, keyA);
    expect(onSegment).not.toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith(rejected, 'orphaned media');
    assembler.push('video', keyA, 1n, mdat);
    expect(onSegment.mock.calls[0]).toHaveLength(4);
    expect(onSegment.mock.calls[0]![2]).toBe(keyA);
  });

  it.each(['video', 'audio'] as const)('fences selected %s identity and late partial inputs independently of its label', type => {
    const { assembler, onSegment, onDiscard } = fixture(), [moof, mdat] = halves();
    const pending = {}, lateMoof = {}, lateMdat = {}, legacy = {}, current = {};
    assembler.push(type, 'shared', 1n, moof, pending, undefined, keyA);
    assembler.selectTrack(type, 'shared', keyB);
    assembler.push(type, 'shared', 1n, moof, lateMoof, undefined, keyA);
    assembler.push(type, 'shared', 1n, mdat, lateMdat, undefined, keyA);
    assembler.push(type, 'shared', 1n, chunk(), legacy);
    expect(onSegment).not.toHaveBeenCalled();
    expect(onDiscard.mock.calls).toEqual([
      [pending, 'decoder reset'], [lateMoof, 'track superseded'],
      [lateMdat, 'track superseded'], [legacy, 'track superseded'],
    ]);
    assembler.push(type, 'shared', 0n, chunk(), current, undefined, keyB);
    expect(onSegment.mock.calls[0]!.slice(2)).toEqual(['shared', 0n, [current], keyB]);
  });

  it('keeps keyed and legacy selection distinct even when key and label are equal', () => {
    const { assembler, onSegment, onDiscard } = fixture(), input = {};
    assembler.selectTrack('video', keyA, keyA);
    assembler.push('video', keyA, 0n, chunk(), input);
    expect(onSegment).not.toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith(input, 'track superseded');
    assembler.push('video', keyA, 0n, chunk(), undefined, undefined, keyA);
    expect(onSegment.mock.calls[0]!.slice(2)).toEqual([keyA, 0n, undefined, keyA]);
  });

  it.each(['video', 'audio'] as const)('invalidates selected %s placement for a new key with the same label', type => {
    const { assembler } = fixture(); initialize(assembler, type);
    assembler.push(type, 'shared', 1n, chunk(), undefined, undefined, keyA);
    const before = assembler.capturePresentationPlacement(type)!;
    expect(before).not.toBeNull();
    assembler.push(type, 'shared', 2n, chunk(11_000n), undefined, undefined, keyA);
    expect(assembler.capturePresentationPlacement(type)).toBe(before);
    assembler.selectTrack(type, 'shared', keyB);
    expect(assembler.capturePresentationPlacement(type)).toBeNull();
    assembler.push(type, 'shared', 0n, chunk(12_000n), undefined, undefined, keyB);
    expect(assembler.capturePresentationPlacement(type)?.token).not.toBe(before.token);
  });

  it.each(['video', 'audio'] as const)('scopes %s epoch floors by source key, without requiring selectTrack', type => {
    const { assembler, onSegment, onDiscontinuity } = fixture(); initialize(assembler, type);
    assembler.push(type, 'shared', 100n, chunk(), undefined, undefined, keyA);
    assembler.push(type, 'shared', 101n, chunk(12_000n), undefined, undefined, keyA);
    assembler.push(type, 'shared', 102n, chunk(), undefined, undefined, keyA);
    expect(onDiscontinuity).toHaveBeenCalledTimes(1);
    onDiscontinuity.mockClear();
    const before = assembler.capturePresentationPlacement(type)!;
    assembler.push(type, 'shared', 0n, chunk(11_000n), undefined, undefined, keyB);
    expect(onSegment).toHaveBeenCalledTimes(4);
    expect(assembler.capturePresentationPlacement(type)?.token).not.toBe(before.token);
    expect(onDiscontinuity).not.toHaveBeenCalled();
  });

  it('changes explicitly mapped placement ownership on source key alone', () => {
    const { assembler } = fixture(); initialize(assembler, 'video');
    assembler.setPresentationPlacement('video', { sourceTimeUs: 10_000_000n,
      rebasedTimeUs: { numerator: 1_000_000n, denominator: 1n } });
    assembler.push('video', 'shared', 100n, chunk(), undefined, undefined, keyA);
    const before = assembler.capturePresentationPlacement('video')!;
    assembler.push('video', 'shared', 0n, chunk(11_000n), undefined, undefined, keyB);
    const after = assembler.capturePresentationPlacement('video');
    expect(after).not.toBeNull(); expect(after!.token).not.toBe(before.token);
    expect(after!.toRebasedTimeUs(11_000_000n)).toEqual({ numerator: 2_000_000n, denominator: 1n });
  });

  it('retains labels and exact unkeyed callback arity, including observed inputs', () => {
    const { assembler, onSegment } = fixture(), input = {};
    expect(assembler.supportsTrackIdentity).toBe(true);
    assembler.push('video', 'raw-label', 0n, chunk());
    assembler.push('video', 'raw-label', 1n, chunk(11_000n), input);
    assembler.push('video', 'raw-label', 2n, chunk(12_000n), undefined, undefined, keyA);
    assembler.push('video', 'raw-label', 3n, chunk(13_000n), input, undefined, keyA);
    expect(onSegment.mock.calls.map(call => [call.length, call[2], call[4], call[5]]))
      .toEqual([[4, 'raw-label', undefined, undefined], [5, 'raw-label', [input], undefined],
        [6, 'raw-label', undefined, keyA], [6, 'raw-label', [input], keyA]]);
  });

  it.each([undefined, '', keyA])('reports the actual discontinuous source with key %j and preserves legacy arity', key => {
    const { assembler, onDiscontinuity } = fixture(); initialize(assembler, 'video');
    assembler.push('video', 'raw-label', 1n, chunk(), undefined, undefined, key);
    assembler.push('video', 'raw-label', 2n, chunk(12_000n), undefined, undefined, key);
    assembler.push('video', 'raw-label', 3n, chunk(), undefined, undefined, key);
    expect(onDiscontinuity.mock.calls).toEqual([key === undefined
      ? ['video', 'raw-label'] : ['video', 'raw-label', key]]);
  });

  it('retains discontinuity provenance when a segment callback adopts another source', () => {
    const onDiscontinuity = vi.fn();
    const assembler = new CmafAssembler({ onDiscontinuity, onSegment: (type, _bytes, name, group) => {
      if (group === 3n) {
        assembler.selectTrack(type, name, keyB);
        assembler.push(type, name, 0n, chunk(11_000n), undefined, undefined, keyB);
      }
    } });
    initialize(assembler, 'video');
    assembler.push('video', 'shared', 1n, chunk(), undefined, undefined, keyA);
    assembler.push('video', 'shared', 2n, chunk(12_000n), undefined, undefined, keyA);
    assembler.push('video', 'shared', 3n, chunk(), undefined, undefined, keyA);
    expect(onDiscontinuity.mock.calls).toEqual([['video', 'shared', keyA]]);
  });

  it('retains legacy audio-offset policy while changing source-key ownership', () => {
    const { assembler, onSegment } = fixture(); initialize(assembler, 'audio');
    assembler.push('audio', 'shared', 100n, chunk(), undefined, undefined, keyA);
    assembler.setAudioPresentationOffsetUs(0n);
    assembler.push('audio', 'shared', 101n, chunk(12_000n), undefined, undefined, keyA);
    const before = assembler.capturePresentationPlacement('audio')!;
    assembler.push('audio', 'shared', 0n, chunk(11_000n), undefined, undefined, keyB);
    expect(mp4.readBaseMediaDecodeTime(onSegment.mock.calls.at(-1)![1] as Uint8Array)).toBe(1000n);
    expect(assembler.capturePresentationPlacement('audio')?.token).not.toBe(before.token);
    expect(assembler.getAudioPresentationMappingWitness()).not.toBeNull();
  });

  it('does not enable source-timing reads for keyed delivery', () => {
    const read = vi.spyOn(mp4, 'readFirstSamplePresentationTime');
    try {
      const { assembler, onSegment } = fixture(); initialize(assembler, 'video');
      expect(assembler.push('video', 'raw-label', 1n, chunk(), undefined, undefined, keyA)).toBeUndefined();
      expect(onSegment).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
      expect(assembler.push('video', 'raw-label', 2n, chunk(11_000n), undefined, true, keyA))
        .toEqual({ state: 'emitted', sourcePresentationTimeUs: 11_000_000n,
          sourceDecodeTime: {timeUs:11_000_000n,timescale:1000,placementToken:assembler.capturePresentationPlacement('video')!.token} });
      expect(read).toHaveBeenCalledTimes(1);
    } finally { read.mockRestore(); }
  });
});
