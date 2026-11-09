import { describe, expect, it } from 'vitest';
import type { MoqtObjectData } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';
import type { PlaybackSample } from '@openmoq/playback';
import { LocSeekInput, type LocSeekInputOptions } from './loc-seek-input.js';

const options = (extra: Partial<LocSeekInputOptions> = {}): LocSeekInputOptions => ({ role: 'video', codec: 'avc1.640028',
  location: { groupId: 3n, objectId: 0n }, mediaPts: 4000, targetMs: 4000, timestampRounding: 'floor',
  maxObjects: 4, maxSamples: 8, maxBytes: 8000, ...extra });
const wire = (objectId: bigint, groupId = 3n): MoqtObjectData => ({ kind: 'data', groupId, objectId,
  subgroupId: 0n, trackAlias: 100n, publisherPriority: 128, payload: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88) });
const headers = () => ({ captureTimestamp: 4_000_000n, timestamp: 4000n, timescale: 1000n,
  timestampIsWallClock: false, videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
    discardable: false, baseLayerSync: false, temporalId: 0 } });
const sample = (): PlaybackSample => ({ sampleIndex: 0, headers: headers(), chunk: { type: 'key', timestamp: 4_000_000,
  data: Uint8Array.of(0xf8, 0xff, 0xfe), sourceTimestamp: { ticks: 4000n, ticksPerSecond: 1000n, domain: 'media' } } });

describe('carrier repair keeps transfer and raw identity contracts', () => {
  it('preserves raw LOC entry identity before a header getter mutates the wire Location', () => {
    const input = new LocSeekInput(options()), object = wire(1n), plain = headers();
    const observed: LocHeaders = { ...plain, get timestamp() { Reflect.set(object, 'objectId', 0n); return plain.timestamp; } };
    expect(() => input.push(object, observed)).toThrow(/exact indexed Object/);
  });

  it('accepts stable raw LOC indexed identity with the same metadata getter', () => {
    const input = new LocSeekInput(options()), plain = headers();
    input.push(wire(0n), { ...plain, get timestamp() { return plain.timestamp; } });
    expect(input.finishGroup(3n).kind).toBe('ready');
  });

  it('transfers empty and media audio carriers without cancelling caller-owned receipts on continuation', () => {
    const discarded: object[] = [], headerToken = {}, mediaToken = {};
    const input = new LocSeekInput(options({ role: 'audio', codec: 'opus', location: { groupId: 3n, objectId: 1n },
      onDiscard: token => { discarded.push(token); } }));
    input.pushSamples(wire(0n), [], headerToken);
    input.pushSamples(wire(1n), [sample()], mediaToken);
    const result = input.finishAudioGroup(3n);
    expect(result.sampleObjects?.map(value => [value.object.objectId, value.samples.length])).toEqual([[0n, 0], [1n, 1]]);
    expect(result.sampleObjects?.[0]?.input).toBe(headerToken);
    expect(result.sampleObjects?.[1]?.samples[0]?.chunk).toBe(result.items[0]!.chunk);
    const next = input.continueAt(4n); input.cancel(); next.cancel();
    expect(discarded).toEqual([]); expect(input.retainedObjectCount).toBe(0); expect(input.retainedBytes).toBe(0);
  });

  it('charges empty carrier storage exactly before admission and discards a shared receipt once', () => {
    const probe = new LocSeekInput(options()); probe.pushSamples(wire(0n), []);
    const exact = probe.retainedBytes; probe.cancel();
    expect(exact).toBe(262);
    const receipt = {}, discarded: object[] = [];
    const input = new LocSeekInput(options({ maxBytes: exact, onDiscard: token => { discarded.push(token); } }));
    input.pushSamples(wire(0n), [], receipt);
    expect(input.retainedObjectCount).toBe(1); expect(input.retainedSampleCount).toBe(0);
    expect(() => input.pushSamples(wire(1n), [], receipt)).toThrow(/byte\/proof budget/);
    expect(discarded).toEqual([receipt]); input.cancel(); expect(discarded).toEqual([receipt]);
    expect(input.retainedObjectCount).toBe(0); expect(input.retainedBytes).toBe(0);
  });

  it('does not retain a carrier after the sample-array length getter cancels admission', () => {
    const receipt = {}, discarded: object[] = [];
    const input = new LocSeekInput(options({ onDiscard: token => { discarded.push(token); } }));
    const array: readonly PlaybackSample[] = new Proxy([], { get(target, key, receiver) {
      if (key === 'length') input.cancel(); return Reflect.get(target, key, receiver);
    } });
    expect(() => input.pushSamples(wire(0n), array, receipt)).toThrow(/retired/);
    expect(discarded).toEqual([receipt]); expect(input.retainedObjectCount).toBe(0); expect(input.retainedBytes).toBe(0);
  });
});
