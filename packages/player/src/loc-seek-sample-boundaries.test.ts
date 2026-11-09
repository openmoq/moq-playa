import { describe, expect, it } from 'vitest';
import type { MoqtObjectData } from '@openmoq/transport';
import type { PlaybackSample } from '@openmoq/playback';
import { LocSeekInput } from './loc-seek-input.js';

const options = { role: 'video' as const, codec: 'avc1.640028', location: { groupId: 3n, objectId: 0n },
  mediaPts: 4000, targetMs: 4000, timestampRounding: 'floor' as const, maxObjects: 4, maxSamples: 8, maxBytes: 8000 };
const wire = (objectId: bigint): MoqtObjectData => ({ kind: 'data', groupId: 3n, objectId,
  subgroupId: 0n, trackAlias: 100n, publisherPriority: 128, payload: Uint8Array.of(1, 2) });
const coded = (): PlaybackSample => ({ sampleIndex: 0,
  headers: { captureTimestamp: 4_000_000n, timestamp: 4000n, timescale: 1000n, timestampIsWallClock: false,
    videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true, discardable: false,
      baseLayerSync: false, temporalId: 0 } },
  chunk: { type: 'key', timestamp: 4_000_000, data: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88),
    sourceTimestamp: { ticks: 4000n, ticksPerSecond: 1000n, domain: 'media' } } });

describe('sample acquisition identity and retirement', () => {
  it('keeps the entry wire Location when a sample header getter mutates the caller Object', () => {
    const input = new LocSeekInput(options), object = wire(1n), first = coded();
    const observed: PlaybackSample = { sampleIndex: 0,
      get headers() { Reflect.set(object, 'objectId', 0n); return first.headers; }, chunk: first.chunk };
    expect(() => input.pushSamples(object, [observed])).toThrow(/exact indexed Object/);
    expect(() => input.finishGroup(3n)).toThrow(/retired/);
  });

  it('refuses a stable non-indexed Object rather than borrowing its first sample as anchor', () => {
    const input = new LocSeekInput(options);
    expect(() => input.pushSamples(wire(1n), [coded()])).toThrow(/exact indexed Object/);
  });

  it('accepts an unmodified exact indexed Object with the same sample', () => {
    const input = new LocSeekInput(options);
    input.pushSamples(wire(0n), [coded()]);
    const result = input.finishGroup(3n);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('expected ready');
    expect(result.indexedLocation.objectId).toBe(0n);
    expect(result.items[0]!.object.objectId).toBe(0n);
  });

  it('does not transfer or double-discard when coded-data acquisition cancels its owner', () => {
    const receipt = {}, discarded: object[] = [];
    const input = new LocSeekInput({ ...options, onDiscard: (token: object) => { discarded.push(token); } });
    const first = coded();
    const observed: PlaybackSample = { ...first, chunk: { ...first.chunk,
      get data() { input.cancel(); return first.chunk.data; } } };
    expect(() => input.pushSamples(wire(0n), [observed], receipt)).toThrow(/retired/);
    expect(input.retainedBytes).toBe(0); expect(input.retainedSampleCount).toBe(0);
    expect(discarded).toEqual([receipt]); input.cancel(); expect(discarded).toEqual([receipt]);
    expect(() => input.finishGroup(3n)).toThrow(/retired/);
  });
});
