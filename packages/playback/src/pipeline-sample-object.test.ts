// Logical samples retain the original wire Object ordering.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectStatus, varint } from '@openmoq/transport';
import type { MoqtObjectData } from '@openmoq/transport';
import type { PlaybackSample, DecoderCommand, PlaybackEvent } from './index.js';
import { PlaybackPipeline, SyncController } from './index.js';
import type { PipelineOptions } from './pipeline.js';

function wire(group = 7, object = 0, priority = 128): MoqtObjectData {
  return { kind: 'data', trackAlias: varint(1), groupId: varint(group), objectId: varint(object),
    subgroupId: varint(2), publisherPriority: priority, extensions: undefined,
    payload: Uint8Array.of(0, 0, 0, 2, 0x65, 0) };
}
function sample(index: number, key = index === 0, pts = BigInt(index)): PlaybackSample {
  return { sampleIndex: index, headers: { videoConfig: Uint8Array.of(1), audioConfig: Uint8Array.of(2),
    captureTimestamp: 1_000_000n + BigInt(index), timestampIsWallClock: false,
    videoFrameMarking: { independent: key, startOfFrame: true, endOfFrame: true,
      discardable: false, baseLayerSync: false, temporalId: 0 } },
    chunk: { type: key ? 'key' : 'delta', timestamp: Number(pts), duration: 11,
      sourceTimestamp: { ticks: pts, ticksPerSecond: 90_000n, domain: 'media' }, data: Uint8Array.of(index) } };
}
const fixtures: PlaybackPipeline[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const pipeline of fixtures.splice(0)) {
    pipeline.reset(); pipeline.inputObserver = undefined;
    const state = pipeline as unknown as { pendingSamples: number; sampleBatches?: unknown; pendingBatch?: unknown };
    expect(state.pendingSamples).toBe(0); expect(state.sampleBatches).toBeUndefined(); expect(state.pendingBatch).toBeUndefined();
  }
});
function fixture(options: Partial<PipelineOptions> = {}) {
  let now = 1_000_000;
  const clock = { now: () => now }, commands: DecoderCommand[] = [], events: PlaybackEvent[] = [];
  const sync = new SyncController({ clock, driftThresholdUs: 500_000 });
  const pipeline = new PlaybackPipeline({ mediaType: 'video', clock, sync, videoOnly: true,
    config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, maxReleasePerTick: 2 },
    onCommand: c => { commands.push(c); }, onEvent: e => { events.push(e); }, ...options });
  fixtures.push(pipeline);
  const observer = vi.fn(); pipeline.inputObserver = observer;
  return { pipeline, commands, events, sync, observer, advance: () => { now += 300_000; },
    decoded: () => commands.filter(c => c.type === 'decode_video' || c.type === 'decode_audio') };
}
function terminal(p: PlaybackPipeline) {
  p.pushObject({ kind: 'gap', trackAlias: varint(1), groupId: varint(7), objectId: varint(1),
    subgroupId: varint(2), status: ObjectStatus.END_OF_TRACK });
}

describe('sample Objects in the playback pipeline', () => {
  it('queues the actual Object once; orders wire Objects then samples and preserves signed B-frame PTS', () => {
    const f = fixture(), token = {}, object = wire();
    const source = { ...sample(0, true, -100n), chunk: { ...sample(0, true, -100n).chunk,
      sourceTimestamp: { ticks: -9007199254740999n, ticksPerSecond: 90_000n, domain: 'media' as const } } };
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false, -3n)]);
    f.pipeline.pushSampleObject(object, [source, sample(1, false, 9n), sample(2, false, -7n)], token);
    const buffer = (f.pipeline as unknown as { buffer: { size: number; peek(): unknown } }).buffer;
    expect(buffer.size).toBe(2); expect(buffer.peek()).toBe(object);
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(2);
    f.pipeline.tick(); expect(f.decoded().map(c => c.chunk.sourceTimestamp?.ticks)).toEqual([-9007199254740999n, 9n, -7n, -3n]);
    expect(f.decoded()[0]?.chunk.data).toBe(source.chunk.data);
    expect(f.decoded().slice(0, 3).every(c => c.inputToken === token)).toBe(true);
    expect(f.pipeline.currentGroupId).toBe(7n); f.pipeline.reset();
  });

  it('validates codec bytes on chunk.data and reports original wire IDs', () => {
    const f = fixture(); f.pipeline.setCodec('avc1');
    f.pipeline.pushSampleObject(wire(19), [{ ...sample(0), chunk: { ...sample(0).chunk, data: wire().payload } }]);
    f.pipeline.tick();
    const delta = { ...sample(0), chunk: { ...sample(0).chunk, data: Uint8Array.of(0, 0, 0, 2, 0x41, 0) } };
    f.pipeline.pushSampleObject(wire(19, 1), [delta]); f.pipeline.tick();
    expect(f.events).toContainEqual({ type: 'keyframe_validation_failed', groupId: 19n, objectId: 1n, codec: 'avc1' });
    expect(f.decoded()[1]?.chunk.data).toBe(delta.chunk.data); f.pipeline.reset();
  });

  it('does not hide a missing wire Object behind local sample indexes', () => {
    const f = fixture();
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1)]);
    f.pipeline.pushSampleObject(wire(7, 2), [sample(0, false)], {});
    f.pipeline.tick(); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(2); expect(f.observer).not.toHaveBeenCalled();
    expect(f.pipeline.pendingSampleCount).toBe(1); f.advance(); f.pipeline.tick();
    expect(f.observer).toHaveBeenCalledExactlyOnceWith({}, 'skipped');
    f.pipeline.pushSampleObject(wire(7, 3), [sample(0, false)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(2); f.pipeline.reset();
  });

  it('stops on native pressure inside one Object, drains before gaps and terminal completion', () => {
    const f = fixture();
    expect(f.pipeline.pendingSampleCount).toBe(0);
    const countsAtDecode: number[] = [];
    const output = vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand');
    output.mockImplementation(c => {
      f.commands.push(c);
      if (c.type === 'decode_video') {
        countsAtDecode.push(f.pipeline.pendingSampleCount);
        expect(f.pipeline.bufferedGroupCount).toBe(1);
      }
      if (c.type === 'decode_video' && f.decoded().length === 1) {
        f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 3, maxRecommended: 3 });
      }
    });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)]); terminal(f.pipeline);
    expect(f.pipeline.pendingSampleCount).toBe(3);
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(1); f.advance(); f.pipeline.tick();
    expect(countsAtDecode).toEqual([3]); expect(f.pipeline.pendingSampleCount).toBe(2);
    expect(f.pipeline.bufferedGroupCount).toBe(1);
    // Reading readiness must not drain or flush the retained suffix.
    expect(f.pipeline.pendingSampleCount).toBe(2); expect(f.decoded()).toHaveLength(1);
    expect(f.commands.some(c => c.type === 'flush')).toBe(false);
    expect(f.events.some(e => e.type === 'track_ended')).toBe(false);
    f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 3 });
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(3);
    expect(f.pipeline.pendingSampleCount).toBe(0); expect(countsAtDecode).toEqual([3, 2, 1]);
    expect(f.pipeline.bufferedGroupCount).toBe(0);
    f.pipeline.tick(); expect(f.commands.filter(c => c.type === 'flush')).toHaveLength(1);
    expect(f.events.filter(e => e.type === 'track_ended')).toHaveLength(1); f.pipeline.reset();
  });

  it('advances an empty wire batch without configure, sync or keyframe readiness', () => {
    const f = fixture(); f.pipeline.pushSampleObject(wire(), []); f.pipeline.tick();
    expect(f.commands).toEqual([]); expect(f.sync.hasReference).toBe(false);
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(0); expect(f.pipeline.currentGroupId).toBe(7n); f.pipeline.reset();
  });

  it('bounds total pending units across Objects including a partially drained batch', () => {
    const f = fixture({ maxPendingSamples: 3 }), refused = {};
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1)]);
    expect(f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false), sample(1, false)], refused)).toBeUndefined();
    expect(f.pipeline.pendingSampleCount).toBe(2);
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(refused, 'buffer full');
    f.pipeline.tick(); f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false), sample(1, false)]);
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(4); f.pipeline.reset();
  });

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid bound %s', maxPendingSamples => {
    expect(() => fixture({ maxPendingSamples })).toThrow();
  });

  it('validates the entire batch before admitting any unit', () => {
    const f = fixture();
    expect(() => f.pipeline.pushSampleObject(wire(), [sample(0), sample(2)])).toThrow();
    expect(() => f.pipeline.pushSampleObject(wire(), [sample(0), { ...sample(1), chunk: { ...sample(1).chunk, timestamp: NaN } }])).toThrow();
    f.pipeline.tick(); expect(f.commands).toEqual([]);
    f.pipeline.pushSampleObject(wire(), [sample(0)]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(1); f.pipeline.reset();
  });

  it.each(['headers', 'empty-data', 'scale', 'marking'] as const)('rejects malformed %s atomically before configuring any media', field => {
    const f = fixture(), good = sample(0), value = sample(1);
    const bad = field === 'headers' ? { ...value, headers: { videoConfig: 'invalid' } }
      : field === 'empty-data' ? { ...value, chunk: { ...value.chunk, data: new Uint8Array() } }
      : field === 'scale' ? { ...value, chunk: { ...value.chunk, sourceTimestamp: { ticks: -1n, ticksPerSecond: 0n, domain: 'media' } } }
      : { ...value, headers: { videoFrameMarking: { ...value.headers.videoFrameMarking, discardable: 1 } } };
    expect(() => f.pipeline.pushSampleObject(wire(), [good, bad as PlaybackSample])).toThrow();
    expect(f.pipeline.pendingSampleCount).toBe(0); expect(f.pipeline.bufferedGroupCount).toBe(0);
    f.pipeline.tick(); expect(f.commands).toEqual([]); expect(f.sync.hasReference).toBe(false);
  });

  it('snapshots record getters and indexes before admission, preserving exact source units', () => {
    const f = fixture(); const original = sample(0, true, -19n);
    const batch = [original]; f.pipeline.pushSampleObject(wire(), batch);
    batch[0] = sample(5); (original.headers as { captureTimestamp: bigint }).captureTimestamp = 99n;
    (original.chunk.sourceTimestamp as { ticks: bigint }).ticks = 9n;
    f.pipeline.tick(); expect(f.decoded()[0]?.chunk.sourceTimestamp?.ticks).toBe(-19n);
    expect(f.decoded()[0]?.chunk.timestamp).toBe(-19); f.pipeline.reset();
  });

  it('resets inside configure without stale keyframe admission or successor callbacks', () => {
    const f = fixture(), old = {};
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      f.commands.push(c);
      if (c.type === 'configure') f.pipeline.reset();
    });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1)], old); f.pipeline.tick();
    expect(f.decoded()).toEqual([]); expect(f.observer).toHaveBeenCalledExactlyOnceWith(old, 'decoder reset');
    expect(f.pipeline.currentGroupId).toBe(-1n);
    f.pipeline.pushSampleObject(wire(8), [sample(0, false)]); f.pipeline.tick(); expect(f.decoded()).toEqual([]); f.pipeline.reset();
  });

  it('observer reassignment forgets the pending receipt without dropping media', () => {
    const f = fixture(), next = vi.fn();
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)], {}); f.pipeline.tick();
    f.pipeline.inputObserver = next; f.pipeline.tick();
    expect(f.decoded()[2]).not.toHaveProperty('inputToken'); f.pipeline.reset();
    expect(f.observer).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  });

  it.each(['configure', 'decode_video'] as const)('cleans remaining ownership when %s throws without authorizing deltas', commandType => {
    const f = fixture(), token = {};
    const hook = vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand');
    hook.mockImplementation(c => { if (c.type === commandType) throw Error('native callback'); f.commands.push(c); });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)], token);
    expect(() => f.pipeline.tick()).toThrow('native callback');
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(token, 'decoder policy');
    hook.mockImplementation(c => { f.commands.push(c); });
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false)]); f.pipeline.tick();
    expect(f.decoded()).toEqual([]); f.pipeline.reset();
  });

  it('installs sidecars before eviction callbacks reenter tick or reset', () => {
    const f = fixture({ maxPendingSamples: 2, config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 1 } });
    f.pipeline.inputObserver = () => { f.pipeline.tick(); f.pipeline.reset(); };
    f.pipeline.pushSampleObject(wire(6, 0, 200), [sample(0)], {});
    f.pipeline.pushSampleObject(wire(7, 0, 100), [sample(0)], {});
    expect(f.decoded()).toHaveLength(1);
    f.pipeline.pushSampleObject(wire(8), [sample(0), sample(1)]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(3); f.pipeline.reset();
  });

  it('does not let reentrant ticks duplicate units or advance past the active Object', () => {
    const f = fixture();
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      f.commands.push(c); f.pipeline.tick();
    });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)]); f.pipeline.tick(); f.pipeline.tick();
    expect(f.decoded().map(c => c.chunk.data[0])).toEqual([0, 1, 2]); f.pipeline.reset();
  });

  it('counts a pending suffix together with queued Objects and frees capacity on reset', () => {
    const f = fixture({ maxPendingSamples: 4 }), refused = {};
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)]); f.pipeline.tick();
    expect(f.pipeline.pendingSampleCount).toBe(1);
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false), sample(1, false)]);
    expect(f.pipeline.pendingSampleCount).toBe(3);
    f.pipeline.pushSampleObject(wire(7, 2), [sample(0, false), sample(1, false)], refused);
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(refused, 'buffer full');
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(4);
    expect(f.pipeline.pendingSampleCount).toBe(1);
    f.pipeline.reset(); expect(f.pipeline.pendingSampleCount).toBe(0);
    f.pipeline.pushSampleObject(wire(8), [sample(0), sample(1), sample(2), sample(3)]);
    f.pipeline.tick(); f.pipeline.tick(); expect(f.decoded()).toHaveLength(8);
  });

  it('counts an extracted unfinished wire Group through endBufferedGroups and a queued successor', () => {
    const f = fixture();
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)]); f.pipeline.tick();
    expect(f.pipeline.pendingSampleCount).toBe(1); expect(f.pipeline.bufferedGroupCount).toBe(1);
    f.pipeline.pushSampleObject(wire(8), [sample(0)]); expect(f.pipeline.bufferedGroupCount).toBe(2);
    f.pipeline.endBufferedGroups(); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(4); expect(f.pipeline.pendingSampleCount).toBe(0);
    expect(f.pipeline.bufferedGroupCount).toBe(0);
  });

  it('defaults to 1024 pending samples, without changing ordinary LOC object capacity', () => {
    const f = fixture(), refused = {};
    f.pipeline.pushSampleObject(wire(), Array.from({ length: 1024 }, (_, i) => sample(i)));
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0)], refused);
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(refused, 'buffer full');
    f.pipeline.pushObject(wire(7, 2), sample(0).headers);
    expect(f.pipeline.bufferedGroupCount).toBe(1);
  });

  it.each(['reset', 'switch'] as const)('retires active and queued receipts exactly once on %s', action => {
    const f = fixture({ maxPendingSamples: 4 }), active = {}, queued = {};
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)], active); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false)], queued);
    if (action === 'reset') f.pipeline.reset(); else f.pipeline.resetForTrackSwitch(8n);
    expect(f.observer).toHaveBeenCalledTimes(2);
    for (const token of [active, queued]) expect(f.observer).toHaveBeenCalledWith(token, action === 'reset' ? 'decoder reset' : 'track superseded');
    f.pipeline.pushSampleObject(wire(8), [sample(0, false)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(2);
  });

  it('releases suffix before a reset command throws', () => {
    const f = fixture(), token = {};
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)], token); f.pipeline.tick();
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      if (c.type === 'reset') throw Error('reset callback');
    });
    expect(() => f.pipeline.reset()).toThrow('reset callback');
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(token, 'decoder reset');
  });

  it('allows reset inside decode to admit a successor without stale frontier writes', () => {
    const f = fixture({ maxPendingSamples: 3 }), old = {}, fresh = {};
    let reset = false;
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      f.commands.push(c);
      if (c.type === 'decode_video' && !reset) {
        reset = true; f.pipeline.reset(); f.pipeline.pushSampleObject(wire(8), [sample(0)], fresh); f.pipeline.tick();
      }
    });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)], old); f.pipeline.tick();
    expect(f.pipeline.currentGroupId).toBe(-1n); expect(f.observer).toHaveBeenCalledExactlyOnceWith(old, 'decoder reset');
    f.pipeline.tick(); expect(f.decoded().map(c => c.inputToken)).toEqual([old, fresh]); expect(f.pipeline.currentGroupId).toBe(8n);
  });

  it('refuses replay of the active original Object without replacing its receipt', () => {
    const f = fixture(), accepted = {}, replay = {};
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)], accepted); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(), [sample(0)], replay); f.pipeline.tick();
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(replay, 'treated as a replay');
    expect(f.decoded().map(c => c.inputToken)).toEqual([accepted, accepted, accepted]);
  });

  it('refuses an older wire Group reentering during the first active Object', () => {
    const f = fixture(), stale = {};
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      f.commands.push(c);
      if (c.type === 'decode_video' && f.decoded().length === 1) f.pipeline.pushSampleObject(wire(6), [sample(0)], stale);
    });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)]); f.pipeline.tick(); f.pipeline.tick();
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(stale, 'stale group');
    expect(f.decoded().map(c => c.chunk.data[0])).toEqual([0, 1, 2]);
  });

  it('releases pre-keyframe and backlog sidecars and permits subsequent admission', () => {
    const f = fixture({ maxPendingSamples: 3 }), early = {};
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0, false)], early); f.pipeline.tick();
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(early, 'awaiting keyframe');
    f.pipeline.endGroup(7n);
    f.pipeline.pushSampleObject(wire(8), [sample(0), sample(1), sample(2)]); f.pipeline.tick(); f.pipeline.reset();
    f.pipeline.pushSampleObject(wire(9), [sample(0)], early);
    for (let group = 10; group < 13; group++) f.pipeline.pushSampleObject(wire(group), [], {});
    f.pipeline.tick(); expect(f.observer).toHaveBeenCalledWith(early, 'backlog shed');
    f.pipeline.reset(); f.pipeline.pushSampleObject(wire(14), [sample(0), sample(1), sample(2)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(4);
  });

  it('returns sample capacity after priority eviction and preserves the actual missing Object', () => {
    const f = fixture({ maxPendingSamples: 4, config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 1 } });
    const old = {}; f.pipeline.pushSampleObject(wire(7, 0, 200), [sample(0), sample(1)], old);
    f.pipeline.pushSampleObject(wire(8, 0, 100), [sample(0), sample(1)]);
    expect(f.observer).toHaveBeenCalledExactlyOnceWith(old, 'buffer eviction');
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(2);
    f.pipeline.pushSampleObject(wire(8, 2), [sample(0, false), sample(1, false)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(2);
  });

  it('does not let a discard observer reset authorize stale keyframe events', () => {
    const f = fixture(); f.pipeline.inputObserver = () => { f.pipeline.reset(); };
    f.pipeline.pushSampleObject(wire(), [sample(0, false), sample(1, false)], {}); f.pipeline.tick();
    expect(f.events).toEqual([]); expect(f.decoded()).toEqual([]); expect(f.pipeline.currentGroupId).toBe(-1n);
  });

  it('does not admit a keyframe after its validation event reset the pipeline', () => {
    const f = fixture(); f.pipeline.setCodec('avc1');
    vi.spyOn(f.pipeline as unknown as { onEvent: (e: PlaybackEvent) => void }, 'onEvent').mockImplementation(e => {
      if (e.type === 'keyframe_validation_failed') f.pipeline.reset();
    });
    const value = sample(0);
    f.pipeline.pushSampleObject(wire(), [{ ...value, chunk: { ...value.chunk, data: Uint8Array.of(0, 0, 0, 2, 0x41, 0) } }, sample(1)], {});
    f.pipeline.tick(); f.pipeline.pushSampleObject(wire(8), [sample(0, false)]); f.pipeline.tick();
    expect(f.decoded()).toEqual([]);
  });

  it('stops gap handling when its event resets and admits a successor generation', () => {
    const f = fixture();
    f.pipeline.pushSampleObject(wire(), [sample(0)]); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(10), [sample(0)]); f.advance();
    vi.spyOn(f.pipeline as unknown as { onEvent: (e: PlaybackEvent) => void }, 'onEvent').mockImplementation(e => {
      if (e.type === 'skip_forward') {
        f.pipeline.reset(); f.pipeline.pushSampleObject(wire(20), [sample(0, false)]);
      }
    });
    f.pipeline.tick(); expect(f.pipeline.currentGroupId).toBe(-1n); expect(f.pipeline.pendingSampleCount).toBe(1);
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(1); expect(f.pipeline.currentGroupId).toBe(20n);
  });

  it('contains a throwing observer and releases a batch when its validation event throws', () => {
    const f = fixture({ maxPendingSamples: 2 }); f.pipeline.setCodec('avc1');
    f.pipeline.inputObserver = () => { throw Error('observer'); };
    const hook = vi.spyOn(f.pipeline as unknown as { onEvent: (e: PlaybackEvent) => void }, 'onEvent');
    hook.mockImplementation(() => { throw Error('validation callback'); });
    const value = sample(0);
    f.pipeline.pushSampleObject(wire(), [{ ...value, chunk: { ...value.chunk, data: Uint8Array.of(0, 0, 0, 2, 0x41, 0) } }, sample(1)], {});
    expect(() => f.pipeline.tick()).toThrow('validation callback'); hook.mockImplementation(() => {});
    f.pipeline.pushSampleObject(wire(7, 1), [sample(0), sample(1)]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(2);
  });

  it('reads accessor-backed indexes once and never installs an old batch after snapshot reentry', () => {
    const f = fixture(), value = sample(0), getIndex = vi.fn(() => 0);
    Object.defineProperty(value, 'sampleIndex', { get: getIndex });
    f.pipeline.pushSampleObject(wire(), [value]); expect(getIndex).toHaveBeenCalledOnce(); f.pipeline.reset();
    const old = { ...sample(0), get headers() {
      f.pipeline.reset(); f.pipeline.pushSampleObject(wire(8), [sample(0)]); return sample(0).headers;
    } };
    f.pipeline.pushSampleObject(wire(), [old]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(1); expect(f.pipeline.currentGroupId).toBe(8n);
  });

  it('forgets a receipt reassigned inside configure while preserving the current media batch', () => {
    const f = fixture(), next = vi.fn();
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      f.commands.push(c); if (c.type === 'configure') f.pipeline.inputObserver = next;
    });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1), sample(2)], {}); f.pipeline.tick(); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(3); expect(f.decoded().every(c => c.inputToken === undefined)).toBe(true);
    f.pipeline.reset(); expect(f.observer).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  });

  it('uses the same audio timing path with exact explicit chunks and no live video budget', () => {
    const f = fixture({ mediaType: 'audio' });
    const samples = Array.from({ length: 5 }, (_, index) => sample(index, true, -BigInt(index)));
    const compute = vi.fn(() => ({ renderTimeUs: 777, offsetUs: 0, shouldDrop: false }));
    f.pipeline.setAudioTimingSource({ computeAudioRenderTime: compute });
    f.pipeline.pushSampleObject(wire(), samples); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(5); expect(compute).toHaveBeenCalledTimes(5);
    expect(f.decoded().map(c => c.chunk.sourceTimestamp?.ticks)).toEqual([0n, -1n, -2n, -3n, -4n]);
    expect(f.decoded().every(c => c.renderTimeUs === 777)).toBe(true);
  });

  it('backfill excludes sample batches from join and capture-age diagnostics while keeping their source PTS', () => {
    const f = fixture(), join = vi.spyOn(f.sync, 'onVideoJoin'), captureAge = vi.spyOn(f.sync, 'observeCaptureTimestamp');
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1)], {}, { backfill: true }); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(2); expect(join).not.toHaveBeenCalled(); expect(captureAge).not.toHaveBeenCalled();
  });

  it('retains ordinary LOC admission and release policy without a sample sidecar', () => {
    const f = fixture();
    f.pipeline.pushObject(wire(), sample(0).headers); f.pipeline.pushObject(wire(7, 1), sample(1).headers);
    f.pipeline.tick(); expect(f.decoded()).toHaveLength(2);
    expect(f.decoded()[0]?.chunk.data).toEqual(wire().payload);
    expect((f.pipeline as unknown as { sampleBatches?: unknown }).sampleBatches).toBeUndefined(); f.pipeline.reset();
  });
});
