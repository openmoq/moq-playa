import { describe, expect, it } from 'vitest';
import type { LocmafFrameUnit } from '@openmoq/locmaf';
import { LocmafEncoder, LocmafFrameReader, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { varint } from '@openmoq/transport';
import { buildChunk, SYNC_FLAGS, videoInit } from '../../locmaf/test-support/cmaf.js';
import { locmafPlaybackSamples } from './locmaf-playback-samples.js';
import { LocSeekInput } from './loc-seek-input.js';

const unit: LocmafFrameUnit = { sampleIndex: 0, data: Uint8Array.of(1, 2), decodeTime: 6000n,
  presentationTime: -1n, duration: 3000, timescale: 90000, flags: 0x02000000, isSync: true };
describe('LOCMAF sample decoder descriptors', () => {
  it('retains exact signed sample PTS separately from the native microsecond projection', () => {
    const [sample] = locmafPlaybackSamples('video', [unit], Uint8Array.of(1));
    expect(sample!.chunk.timestamp).toBe(-11);
    expect(sample!.chunk.sourceTimestamp).toEqual({ ticks: -1n, ticksPerSecond: 90000n, domain: 'media' });
    expect(sample!.headers).toMatchObject({ timestamp: -1n, timescale: 90000n, captureTimestamp: -11n,
      timestampIsWallClock: false, videoFrameMarking: { independent: true } });
    expect(sample!.chunk.data).toBe(unit.data); expect(sample!.chunk.type).toBe('key');
  });
  it('keeps decode order, explicit dependency and the flat per-Object sample index', () => {
    const samples = locmafPlaybackSamples('video', [{ ...unit, presentationTime: 6000n },
      { ...unit, sampleIndex: 1, decodeTime: 9000n, presentationTime: 0n, isSync: false }], Uint8Array.of(1));
    expect(samples.map(sample => [sample.sampleIndex, sample.chunk.timestamp, sample.chunk.type])).toEqual([[0, 66666, 'key'], [1, 0, 'delta']]);
    expect(samples[1]!.headers.videoConfig).toBeUndefined();
    expect(samples[1]!.headers.videoFrameMarking!.independent).toBe(false);
  });
  it('uses Audio Config and key audio without claiming video independence', () => {
    const description = Uint8Array.of(0x12, 0x10), [sample] = locmafPlaybackSamples('audio', [{ ...unit, isSync: false }], description);
    expect(sample!.headers.audioConfig).toBe(description); expect(sample!.headers.videoFrameMarking).toBeUndefined();
    expect(sample!.chunk.type).toBe('key');
  });
  it('refuses a native timestamp that would round away a source microsecond', () => {
    expect(() => locmafPlaybackSamples('video', [{ ...unit, timescale: 1, presentationTime: BigInt(Number.MAX_SAFE_INTEGER) }], null)).toThrow(/native integer range/);
  });
  it('does not invent a positive microsecond duration for a smaller positive tick interval', () => {
    const [sample] = locmafPlaybackSamples('video', [{ ...unit, timescale: 2000000, duration: 1 }], null);
    expect(sample!.chunk.duration).toBeUndefined(); expect(sample!.headers.duration).toBeUndefined();
  });
  it('keeps Header-only batches empty and refuses a changed sample index or invalid scale', () => {
    expect(locmafPlaybackSamples('video', [], null)).toEqual([]);
    expect(() => locmafPlaybackSamples('video', [{ ...unit, sampleIndex: 1 }], null)).toThrow(/sample timing/);
    expect(() => locmafPlaybackSamples('video', [{ ...unit, timescale: 0 }], null)).toThrow(/sample timing/);
  });
  it.each([90005n, 90000n])('keeps native projection and indexed source evidence consistent at %s ticks', pts => {
    const init = videoInit(), context = parseLocmafTrackContext(init);
    const reader = new LocmafFrameReader(init, { maxGroups: 8, maxSamples: 512, maxEntries: 65536, maxBytes: 8 * 1024 * 1024 });
    const bytes = buildChunk({ bmdt: pts, samples: [{ duration: 9000, size: 6, flags: SYNC_FLAGS }],
      mdat: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88) });
    const payload = serializeLocmafObject(new LocmafEncoder().encode(bytes, new LocmafGroupState(), context, false, 0n));
    const batch = reader.push(3n, 0n, payload);
    if (batch.kind !== 'batch') throw new Error('Expected frame-reader samples');
    const samples = locmafPlaybackSamples('video', batch.units, null);
    const input = new LocSeekInput({ role: 'video', codec: 'avc1.640028', location: { groupId: 3n, objectId: 0n },
      mediaPts: 1000, targetMs: 1000, timestampRounding: 'floor', placementMode: 'indexed-relative', maxObjects: 4, maxSamples: 8, maxBytes: 8000 });
    try {
      input.pushSamples({ kind: 'data', trackAlias: varint(200n), groupId: varint(3n), objectId: varint(0n),
        subgroupId: varint(0n), publisherPriority: 128, payload }, samples);
      const result = input.finishGroup(3n);
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') throw new Error('Expected indexed readiness');
      expect(result.anchor.ticks).toBe(pts); expect(result.items[0]!.sampleIndex).toBe(0);
    } finally { input.cancel(); reader.retire(); }
  });
});
