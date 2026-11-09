import { describe, expect, it, vi } from 'vitest';
import type { MoqtObjectData } from '@openmoq/transport';
import type { PlaybackSample } from '@openmoq/playback';
import { LocSeekInput, type LocSeekPreparation } from './loc-seek-input.js';

const wire = (objectId = 0n): MoqtObjectData => ({ kind: 'data', groupId: 3n, objectId,
  subgroupId: 0n, trackAlias: 100n, publisherPriority: 128, payload: new Uint8Array(4096) });
const marking = (independent: boolean) => ({ independent, startOfFrame: true, endOfFrame: true,
  discardable: false, baseLayerSync: false, temporalId: 0 });
const sample = (sampleIndex: number, pts: bigint, key = false): PlaybackSample => ({ sampleIndex,
  headers: { captureTimestamp: pts * 1000n, timestamp: pts, timescale: 1000n,
    timestampIsWallClock: false, videoFrameMarking: marking(key) },
  chunk: { type: key ? 'key' : 'delta', timestamp: Number(pts * 1000n), duration: 1000000,
    sourceTimestamp: { ticks: pts, ticksPerSecond: 1000n, domain: 'media' },
    data: Uint8Array.of(0, 0, 0, 2, key ? 0x65 : 0x41, 0x88) } });
const opts = { role: 'video' as const, codec: 'avc1.640028', location: { groupId: 3n, objectId: 0n },
  mediaPts: 4000, targetMs: 5000, timestampRounding: 'floor' as const, maxObjects: 4,
  maxSamples: 8, maxBytes: 8000 };
function ready(result: LocSeekPreparation) {
  if (result.kind !== 'ready') throw new Error('Expected ready');
  return result;
}

describe('sample batches retain actual seek Object identity', () => {
  it('uses the FIRST decoded sample as index anchor, then chooses the least eligible reordered PTS', () => {
    const input = new LocSeekInput(opts), object = wire(), receipt = {};
    input.pushSamples(object, [sample(0, 4000n, true), sample(1, 6000n), sample(2, 5250n)], receipt);
    expect(input.retainedObjectCount).toBe(1); expect(input.retainedSampleCount).toBe(3);
    const result = ready(input.finishGroup(3n));
    expect(result.anchor.ticks).toBe(4000n);
    expect(result.selected).toMatchObject({ location: { groupId: 3n, objectId: 0n }, sampleIndex: 2,
      sourceTimestamp: { ticks: 5250n, ticksPerSecond: 1000n, domain: 'media' } });
    expect(result.items.map(item => [item.object.objectId, item.sampleIndex, item.chunk.timestamp])).toEqual([
      [0n, 0, 4000000], [0n, 1, 6000000], [0n, 2, 5250000],
    ]);
    expect(new Set(result.items.map(item => item.object)).size).toBe(1);
    expect(result.items.every(item => item.input === receipt)).toBe(true);
    expect(result.items[0]!.object).not.toBe(object);
    expect(input.retainedObjectCount).toBe(0); expect(input.retainedSampleCount).toBe(0);
  });
  it('does not allow a later matching sample to stand in for the indexed first sample', () => {
    const input = new LocSeekInput(opts);
    expect(() => input.pushSamples(wire(), [sample(0, 3000n, true), sample(1, 4000n)])).toThrow(/media timeline index/);
  });
  it('does not overwrite the first-sample anchor with a later smaller PTS in the same Object', () => {
    const input = new LocSeekInput({ ...opts, placementMode: 'indexed-relative' });
    input.pushSamples(wire(), [sample(0, 8000n, true), sample(1, 7000n), sample(2, 9500n)]);
    const result = ready(input.finishGroup(3n));
    expect(result.anchor.ticks).toBe(8000n); expect(result.placement!.sourceAnchor.ticks).toBe(8000n);
    expect(result.selected.sampleIndex).toBe(2); // lower bound must exceed the target
  });
  it('uses actual sample independence and payload, never wire Object zero or compressed bytes', () => {
    expect(() => new LocSeekInput(opts).pushSamples(wire(), [sample(0, 4000n)])).toThrow(/independently coded/);
    const bad = sample(0, 4000n, true);
    expect(() => new LocSeekInput(opts).pushSamples(wire(), [{ ...bad, chunk: { ...bad.chunk,
      data: Uint8Array.of(0, 0, 0, 2, 0x41, 0x88) } }])).toThrow(/independently coded/);
  });
  it('retains a Header-only Object frontier without granting it a sample anchor', () => {
    const input = new LocSeekInput({ ...opts, location: { groupId: 3n, objectId: 1n }, targetMs: 4000, maxBytes: 16000 });
    input.pushSamples(wire(), []); input.pushSamples(wire(1n), [sample(0, 4000n, true)]);
    expect(ready(input.finishGroup(3n)).indexedLocation.objectId).toBe(1n);
    const missing = new LocSeekInput({ ...opts, maxBytes: 16000 }); missing.pushSamples(wire(), []);
    expect(() => missing.pushSamples(wire(1n), [sample(0, 4000n, true)])).toThrow(/exact indexed Object/);
  });
  it('counts coded sample storage and proof records but copies a wire Object only once', () => {
    const input = new LocSeekInput(opts);
    input.pushSamples(wire(), [sample(0, 4000n, true), sample(1, 5250n), sample(2, 6000n)]);
    expect(input.retainedBytes).toBeLessThan(8000); expect(input.retainedBytes).toBeGreaterThan(4096 + 18);
    expect(ready(input.finishGroup(3n)).items).toHaveLength(3);
  });
  it('refuses aggregate sample admission atomically and releases one original receipt exactly once', () => {
    const onDiscard = vi.fn(), receipt = {}, input = new LocSeekInput({ ...opts, maxSamples: 2, onDiscard });
    expect(() => input.pushSamples(wire(), [sample(0, 4000n, true), sample(1, 5250n), sample(2, 6000n)], receipt)).toThrow(/sample budget/);
    expect(input.retainedObjectCount).toBe(0); expect(input.retainedBytes).toBe(0);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith(receipt, 'invalid media'); input.cancel();
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
  it.each([{ indexes: [1] }, { indexes: [0, 2] }, { indexes: [0, 0] }])('refuses non-flat or sparse sample indexes $indexes', ({ indexes }) => {
    const input = new LocSeekInput(opts);
    expect(() => input.pushSamples(wire(), indexes.map(index => sample(index, 4000n, true)))).toThrow(/sample index/);
  });
  it('keeps whole-Object replay refusal distinct from samples within an accepted Object', () => {
    const input = new LocSeekInput(opts);
    input.pushSamples(wire(), [sample(0, 4000n, true), sample(1, 5000n)]);
    expect(() => input.pushSamples(wire(), [sample(0, 6000n, true)])).toThrow(/Object order/);
  });
  it('copies caller-owned sample data/configuration before retention', () => {
    const input = new LocSeekInput(opts), first = sample(0, 4000n, true), config = Uint8Array.of(1, 2);
    input.pushSamples(wire(), [{ ...first, headers: { ...first.headers, videoConfig: config } }, sample(1, 5250n)]);
    first.chunk.data.fill(0); config.fill(0);
    const result = ready(input.finishGroup(3n));
    expect([...result.items[0]!.chunk.data]).toEqual([0, 0, 0, 2, 0x65, 0x88]);
    expect(result.items[0]!.headers.videoConfig).toEqual(Uint8Array.of(1, 2));
  });
  it('preserves signed source PTS on a sample before the indexed Object', () => {
    const input = new LocSeekInput({ ...opts, location: { groupId: 3n, objectId: 1n }, targetMs: 4000, maxBytes: 16000 });
    input.pushSamples(wire(), [sample(0, -1n, true)]);
    input.pushSamples(wire(1n), [sample(0, 4000n), sample(1, 5000n)]);
    const result = ready(input.finishGroup(3n)); expect(result.items[0]!.sourceTimestamp.ticks).toBe(-1n);
    expect(result.items[0]!.chunk.timestamp).toBe(-1000);
  });
  it('transfers the ordered Header carrier before its media without giving it a sample index', () => {
    const input = new LocSeekInput({ ...opts, location: { groupId: 3n, objectId: 1n }, targetMs: 4000, maxBytes: 16000 });
    const headerReceipt = {}, mediaReceipt = {};
    input.pushSamples(wire(), [], headerReceipt);
    input.pushSamples(wire(1n), [sample(0, 4000n, true), sample(1, 5000n)], mediaReceipt);
    expect(input.retainedObjectCount).toBe(2); expect(input.retainedSampleCount).toBe(2);
    const result = ready(input.finishGroup(3n));
    expect(result.sampleObjects!.map(carrier => [carrier.object.objectId, carrier.samples.length])).toEqual([[0n, 0], [1n, 2]]);
    expect(result.sampleObjects![0]!.input).toBe(headerReceipt);
    expect(result.sampleObjects![1]!.input).toBe(mediaReceipt);
    expect(result.sampleObjects![1]!.object).toBe(result.items[0]!.object);
    expect(result.sampleObjects![1]!.samples[0]!.chunk).toBe(result.items[0]!.chunk);
  });
  it('bounds and releases Header-only carrier retention even when it contains no samples', () => {
    const discarded = vi.fn(), first = {}, second = {}, third = {};
    const input = new LocSeekInput({ ...opts, maxObjects: 2, maxBytes: 16000, onDiscard: discarded });
    input.pushSamples(wire(), [], first); input.pushSamples(wire(1n), [], second);
    expect(input.retainedSampleCount).toBe(0); expect(input.retainedObjectCount).toBe(2);
    expect(input.retainedBytes).toBeGreaterThan(8192);
    expect(() => input.pushSamples(wire(2n), [], third)).toThrow(/object budget/);
    expect(discarded.mock.calls.map(([token]) => token)).toEqual([first, second, third]);
    expect(input.retainedBytes).toBe(0); expect(input.retainedObjectCount).toBe(0);
  });
});
