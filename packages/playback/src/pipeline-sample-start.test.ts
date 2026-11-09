import { afterEach, describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import type { MoqtObjectData } from '@openmoq/transport';
import { PlaybackPipeline } from './pipeline.js';
import type { PipelineOptions } from './pipeline.js';
import type { DecoderCommand, PlaybackEvent, PlaybackSample } from './types.js';
import { SyncController } from './sync.js';

function wire(object: number, group = 7): MoqtObjectData {
  return { kind: 'data', trackAlias: varint(1), groupId: varint(group), objectId: varint(object),
    subgroupId: varint(0), publisherPriority: 128, extensions: undefined, payload: Uint8Array.of(9) };
}
function sample(index: number, key: boolean): PlaybackSample {
  return { sampleIndex: index, headers: { videoConfig: Uint8Array.of(1), captureTimestamp: 1_000_000n + BigInt(index),
    timestampIsWallClock: false, videoFrameMarking: { independent: key, startOfFrame: true,
      endOfFrame: true, discardable: false, baseLayerSync: false, temporalId: 0 } },
    chunk: { type: key ? 'key' : 'delta', timestamp: index, data: Uint8Array.of(index),
      sourceTimestamp: { ticks: -9007199254740997n + BigInt(index), ticksPerSecond: 90_000n, domain: 'media' } } };
}
const pipelines: PlaybackPipeline[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const pipeline of pipelines.splice(0)) {
    pipeline.reset(); pipeline.inputObserver = undefined;
    expect(pipeline.pendingSampleCount).toBe(0); expect(pipeline.pendingSampleByteCount).toBe(0);
    expect(pipeline.bufferedGroupCount).toBe(0);
  }
});
function fixture(options: Partial<PipelineOptions> = {}) {
  let now = 1_000_000;
  const clock = { now: () => now }, commands: DecoderCommand[] = [], events: PlaybackEvent[] = [];
  const sync = new SyncController({ clock, driftThresholdUs: 500_000 });
  const pipeline = new PlaybackPipeline({ mediaType: 'video', clock, sync, videoOnly: true, isLive: false,
    config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100 },
    onCommand: command => { commands.push(command); }, onEvent: event => { events.push(event); }, ...options });
  pipelines.push(pipeline); const discarded = vi.fn(); pipeline.inputObserver = discarded;
  return { pipeline, commands, events, sync, discarded, advance: () => { now += 300_000; },
    decoded: () => commands.filter(command => command.type === 'decode_video') };
}

describe('initial sample Object cursor', () => {
  it('starts at the actual nonzero wire Object and discards only its dependent prefix', () => {
    const f = fixture(), input = {}, object = wire(37);
    const samples = [sample(0, false), sample(1, false), sample(2, true), sample(3, false)];
    f.pipeline.pushSampleObject(object, samples, input); f.pipeline.tick();
    expect(f.decoded().map(command => command.chunk.data[0])).toEqual([2, 3]);
    expect(f.decoded().map(command => command.chunk.sourceTimestamp?.ticks)).toEqual(samples.slice(2).map(s => s.chunk.sourceTimestamp?.ticks));
    expect(f.decoded().every(command => command.inputToken === input)).toBe(true);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'awaiting keyframe');
    expect(object.objectId).toBe(37n); expect(samples.map(s => s.sampleIndex)).toEqual([0, 1, 2, 3]);
    expect(f.events.some(event => event.type === 'skip_forward')).toBe(false);
    f.pipeline.pushSampleObject(wire(38), [sample(0, false)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(3);
  });

  it('keeps the initial actual cursor through a throttled first tick and bounded release', () => {
    const f = fixture({ isLive: true, config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000,
      maxBufferDepth: 100, maxReleasePerTick: 1 } });
    f.pipeline.pushSampleObject(wire(51), [sample(0, false), sample(1, true), sample(2, false)]);
    f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 });
    f.pipeline.tick(); expect(f.pipeline.pendingSampleCount).toBe(3); expect(f.decoded()).toHaveLength(0);
    f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 });
    f.pipeline.tick(); expect(f.pipeline.pendingSampleCount).toBe(2); expect(f.decoded()).toHaveLength(0);
    f.pipeline.tick(); f.pipeline.tick(); expect(f.decoded().map(c => c.chunk.data[0])).toEqual([1, 2]);
  });

  it('lets an empty Header0 advance contiguity without configuring or establishing sync', () => {
    const f = fixture(); f.pipeline.pushSampleObject(wire(0), []); f.pipeline.tick();
    expect(f.commands).toEqual([]); expect(f.sync.hasReference).toBe(false);
    f.pipeline.pushSampleObject(wire(1), [sample(0, true)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(1); expect(f.discarded).not.toHaveBeenCalled();
  });

  it('rejects earlier wire arrivals after selecting a throttled initial carrier', () => {
    const f = fixture(), oldGroup = {}, oldObject = {};
    f.pipeline.pushSampleObject(wire(37), [sample(0, true)]);
    f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 }); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(100, 6), [sample(0, true)], oldGroup);
    f.pipeline.pushSampleObject(wire(2), [sample(0, true)], oldObject);
    expect(f.discarded).toHaveBeenCalledWith(oldGroup, 'stale group');
    expect(f.discarded).toHaveBeenCalledWith(oldObject, 'treated as a replay');
    f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 }); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(1); expect(f.pipeline.pendingSampleCount).toBe(0);
  });

  it('preserves the raw LOC Object0 startup rule even when a nonzero input claims independence', () => {
    const f = fixture(), old = {};
    f.pipeline.pushObject(wire(37), sample(0, true).headers, old); f.pipeline.tick();
    expect(f.commands).toEqual([]); expect(f.sync.hasReference).toBe(false);
    expect(f.discarded).not.toHaveBeenCalled(); expect(f.pipeline.bufferedGroupCount).toBe(1);
    f.pipeline.pushObject(wire(0), sample(0, true).headers); f.pipeline.tick(); expect(f.decoded()).toHaveLength(1);
    expect(f.discarded).not.toHaveBeenCalled(); f.advance(); f.pipeline.tick();
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(old, 'skipped'); expect(f.decoded()).toHaveLength(1);
  });

  it.each([
    { delivery: 'raw', objectId: 0 },
    { delivery: 'raw', objectId: 7 },
    { delivery: 'batch', objectId: 7 },
  ] as const)('continues same-config audio after a track switch: $delivery Object$objectId', ({ delivery, objectId }) => {
    const f = fixture({ mediaType: 'audio' }), input = {};
    f.pipeline.configure(Uint8Array.of(1));
    f.pipeline.pushObject(wire(0), { captureTimestamp: 10_000_000n }); f.pipeline.tick();
    f.pipeline.resetForTrackSwitch(80n); f.pipeline.configure(Uint8Array.of(1));
    if (delivery === 'raw') f.pipeline.pushObject(wire(objectId, 80), { captureTimestamp: 10_040_000n }, input);
    else {
      const value = sample(0, true);
      f.pipeline.pushSampleObject(wire(objectId, 80), [{ ...value,
        headers: { ...value.headers, audioConfig: Uint8Array.of(1), captureTimestamp: 10_040_000n },
        chunk: { ...value.chunk, timestamp: 10_040_000 },
      }], input);
    }
    f.pipeline.tick();
    const audio = f.commands.filter(command => command.type === 'decode_audio');
    expect(audio.map(command => command.chunk.timestamp)).toEqual([10_000_000, 10_040_000]);
    expect(audio[1]?.inputToken).toBe(input);
    expect(f.commands.filter(command => command.type === 'configure')).toHaveLength(1);
    expect(f.discarded).not.toHaveBeenCalled();
  });

  it('retains the raw LOC audio Object0 rule on a fresh pipeline', () => {
    const f = fixture({ mediaType: 'audio' }), input = {}; f.pipeline.configure(Uint8Array.of(1));
    f.pipeline.pushObject(wire(7), { captureTimestamp: 10_000_000n }, input); f.pipeline.tick();
    expect(f.commands.filter(command => command.type === 'decode_audio')).toHaveLength(0);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'awaiting keyframe');
  });

  it('preserves the initial raw audio Object0 gate when switching before any consumption', () => {
    const f = fixture({ mediaType: 'audio' }), input = {}; f.pipeline.configure(Uint8Array.of(1));
    f.pipeline.resetForTrackSwitch(80n);
    f.pipeline.pushObject(wire(7, 80), { captureTimestamp: 10_000_000n }, input); f.pipeline.tick();
    expect(f.commands.filter(command => command.type === 'decode_audio')).toHaveLength(0);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'awaiting keyframe');
    f.pipeline.pushObject(wire(0, 80), { captureTimestamp: 10_000_000n }); f.pipeline.tick();
    expect(f.commands.filter(command => command.type === 'decode_audio')).toHaveLength(1);
  });

  it.each([true, false])('consumes dependent-only initial work and requires a contiguous later key: contiguous=%s', contiguous => {
    const f = fixture(), initial = {}, next = {};
    f.pipeline.pushSampleObject(wire(37), [sample(0, false), sample(1, false)], initial); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(0); expect(f.pipeline.pendingSampleCount).toBe(0);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(initial, 'awaiting keyframe');
    f.pipeline.pushSampleObject(wire(contiguous ? 38 : 39), [sample(0, true)], next); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(contiguous ? 1 : 0);
    if (!contiguous) {
      expect(f.discarded).not.toHaveBeenCalledWith(next, 'skipped');
      expect(f.pipeline.pendingSampleCount).toBe(1); f.advance(); f.pipeline.tick();
      expect(f.discarded).toHaveBeenCalledWith(next, 'skipped'); expect(f.decoded()).toHaveLength(0);
    }
  });

  it('consumes an empty nonzero initial Header without media readiness', () => {
    const f = fixture(); f.pipeline.pushSampleObject(wire(37), []); f.pipeline.tick();
    expect(f.commands).toEqual([]); expect(f.sync.hasReference).toBe(false);
    f.pipeline.pushSampleObject(wire(38), [sample(0, true)]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(1);
  });

  it('keeps Header0 to media2 as a missing wire Object even when the sample is independent', () => {
    const f = fixture(), missing = {};
    f.pipeline.pushSampleObject(wire(0), []); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(2), [sample(0, true)], missing); f.pipeline.tick();
    expect(f.commands.filter(c => c.type === 'configure')).toHaveLength(0); expect(f.decoded()).toHaveLength(0);
    expect(f.sync.hasReference).toBe(false); expect(f.discarded).not.toHaveBeenCalled();
    expect(f.pipeline.pendingSampleCount).toBe(1); f.advance(); f.pipeline.tick();
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(missing, 'skipped');
    expect(f.sync.hasReference).toBe(false); expect(f.decoded()).toHaveLength(0);
  });

  it.each([0, 5])('restores ordinary new-group contiguity after startup: next Object=%s', objectId => {
    const f = fixture(), next = {};
    f.pipeline.pushSampleObject(wire(37), [sample(0, true)]); f.pipeline.tick(); f.pipeline.endGroup(7n);
    f.pipeline.pushSampleObject(wire(objectId, 8), [sample(0, true)], next); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(objectId === 0 ? 2 : 1);
    if (objectId !== 0) {
      expect(f.discarded).not.toHaveBeenCalled(); expect(f.pipeline.pendingSampleCount).toBe(1);
      f.advance(); f.pipeline.tick(); expect(f.discarded).toHaveBeenCalledExactlyOnceWith(next, 'skipped');
      expect(f.decoded()).toHaveLength(1);
    }
  });

  it('does not re-arm the initial privilege when gap recovery selects a nonzero Object', () => {
    const f = fixture(), gap = {};
    f.pipeline.pushSampleObject(wire(37), [sample(0, true)]); f.pipeline.tick(); f.pipeline.endGroup(7n);
    f.pipeline.pushSampleObject(wire(55, 10), [sample(0, true)], gap); f.advance(); f.pipeline.tick();
    expect(f.events.some(event => event.type === 'skip_forward')).toBe(true);
    expect(f.discarded).not.toHaveBeenCalled(); expect(f.pipeline.pendingSampleCount).toBe(1);
    f.advance(); f.pipeline.tick();
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(gap, 'skipped'); expect(f.decoded()).toHaveLength(1);
  });

  it.each(['reset', 'switch'] as const)('re-arms actual initial cursor and the keyframe gate on %s', operation => {
    const f = fixture(); f.pipeline.pushSampleObject(wire(37), [sample(0, true)]); f.pipeline.tick();
    if (operation === 'reset') f.pipeline.reset(9n); else f.pipeline.resetForTrackSwitch(9n);
    f.pipeline.pushSampleObject(wire(61, 9), [sample(0, false), sample(1, true), sample(2, false)], {}); f.pipeline.tick();
    expect(f.decoded().map(c => c.chunk.data[0])).toEqual([0, 1, 2]);
    expect(f.events.some(event => event.type === 'skip_forward')).toBe(false);
  });

  it('does not restore an initial cursor after configure resets and admits a successor', () => {
    const f = fixture(), old = {}, fresh = {}; let once = true;
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      f.commands.push(c);
      if (c.type === 'configure' && once) {
        once = false; f.pipeline.reset(); f.pipeline.pushSampleObject(wire(88, 9), [sample(0, true)], fresh);
      }
    });
    f.pipeline.pushSampleObject(wire(37), [sample(0, true), sample(1, false)], old); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(0); expect(f.pipeline.currentGroupId).toBe(-1n);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(old, 'decoder reset');
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(1); expect(f.decoded()[0]?.inputToken).toBe(fresh);
    f.pipeline.pushSampleObject(wire(89, 9), [sample(0, false)]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(2);
  });

  it('leaves startup available when snapshot validation throws', () => {
    const f = fixture(); expect(() => f.pipeline.pushSampleObject(wire(37), [sample(1, true)])).toThrow();
    expect(f.pipeline.bufferedGroupCount).toBe(0);
    f.pipeline.pushSampleObject(wire(55), [sample(0, true)]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(1);
  });

  it('cannot install a pre-reset initial carrier after snapshot callback reentry', () => {
    const f = fixture(), fresh = {}, old = {};
    const value = { ...sample(0, true), get headers() {
      f.pipeline.reset(); f.pipeline.pushSampleObject(wire(88, 9), [sample(0, true)], fresh); return sample(0, true).headers;
    } };
    f.pipeline.pushSampleObject(wire(37), [value], old); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(1); expect(f.decoded()[0]?.inputToken).toBe(fresh);
    expect(f.discarded).not.toHaveBeenCalled();
  });

  it('does not reinterpret a missing wire Object after the initial carrier as another startup', () => {
    const f = fixture(), missing = {};
    f.pipeline.pushSampleObject(wire(0), [sample(0, true)]); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(2), [sample(0, true)], missing); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(1); expect(f.discarded).not.toHaveBeenCalled();
    expect(f.pipeline.pendingSampleCount).toBe(1); f.advance(); f.pipeline.tick();
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(missing, 'skipped'); expect(f.decoded()).toHaveLength(1);
  });
});
