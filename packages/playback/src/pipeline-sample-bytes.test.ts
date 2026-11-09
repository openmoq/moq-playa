import { afterEach, describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import type { MoqtObjectData } from '@openmoq/transport';
import { PlaybackPipeline } from './pipeline.js';
import type { PipelineOptions } from './pipeline.js';
import type { DecoderCommand, PlaybackSample } from './types.js';
import { SyncController } from './sync.js';

function wire(object = 0, payload: Uint8Array = new Uint8Array(3), group = 7, priority = 128): MoqtObjectData {
  return { kind: 'data', trackAlias: varint(1), groupId: varint(group), objectId: varint(object),
    subgroupId: varint(0), publisherPriority: priority, extensions: undefined, payload };
}
function sample(index = 0, data: Uint8Array = new Uint8Array(4), key = true): PlaybackSample {
  return { sampleIndex: index, headers: { videoConfig: Uint8Array.of(1),
    videoFrameMarking: { independent: key, startOfFrame: true, endOfFrame: true,
      discardable: false, baseLayerSync: false, temporalId: 0 } },
    chunk: { type: key ? 'key' : 'delta', timestamp: index, data } };
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
  let nowUs = 0;
  const clock = { now: () => nowUs }, commands: DecoderCommand[] = [];
  const pipeline = new PlaybackPipeline({ mediaType: 'video', clock, isLive: false,
    sync: new SyncController({ clock, driftThresholdUs: 500_000 }),
    config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100 },
    onCommand: command => { commands.push(command); }, onEvent() {}, ...options });
  pipelines.push(pipeline); const discarded = vi.fn(); pipeline.inputObserver = discarded;
  return { pipeline, commands, discarded, advance: () => { nowUs += 300_000; }, decoded: () => commands.filter(command => command.type === 'decode_video') };
}

describe('retained sample Object backing bytes', () => {
  it('refuses a small coded view backed by an oversized allocation before any media admission', () => {
    const f = fixture({ maxPendingSampleBytes: 64 }), input = {};
    f.pipeline.pushSampleObject(wire(), [sample(0, new Uint8Array(new ArrayBuffer(1024), 10, 1))], input);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full');
    expect(f.pipeline.pendingSampleCount).toBe(0); expect(f.pipeline.bufferedGroupCount).toBe(0);
    f.pipeline.tick(); expect(f.commands).toEqual([]);
  });

  it('refuses aggregate backing bytes across Objects atomically', () => {
    const f = fixture({ maxPendingSampleBytes: 12 }), input = {};
    f.pipeline.pushSampleObject(wire(), [sample()]);
    f.pipeline.pushSampleObject(wire(1), [sample(0, new Uint8Array(4), false)], input);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full');
    expect(f.pipeline.pendingSampleCount).toBe(1); f.pipeline.tick(); expect(f.decoded()).toHaveLength(1);
    f.pipeline.pushSampleObject(wire(1), [sample(0, new Uint8Array(4), false)]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(2);
  });

  it('accepts a healthy bounded batch through the existing media path', () => {
    const f = fixture({ maxPendingSampleBytes: 8 }), value = sample();
    f.pipeline.pushSampleObject(wire(), [value]); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(1); expect(f.decoded()[0]?.chunk.data).toBe(value.chunk.data);
    expect(f.discarded).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte limit %s', maxPendingSampleBytes => {
    expect(() => fixture({ maxPendingSampleBytes })).toThrow(/positive safe integer/);
  });

  it('defaults to an 8 MiB retained-backing limit', () => {
    const f = fixture(), input = {};
    f.pipeline.pushSampleObject(wire(0, new Uint8Array(new ArrayBuffer(8 * 1024 * 1024 + 1), 0, 1)), [], input);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full');
    expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.pipeline.bufferedGroupCount).toBe(0);
  });

  it('counts payload, extensions, coded bytes, both configs and unknown-header byte views', () => {
    const f = fixture({ maxPendingSampleBytes: 22 });
    const value = { ...sample(), headers: { ...sample().headers, audioConfig: new Uint8Array(2),
      unknown: new Map<bigint, bigint | Uint8Array>([[1n, new Uint8Array(7)], [2n, 999n]]) } };
    const object = { ...wire(), extensions: new Uint8Array(5) };
    f.pipeline.pushSampleObject(object, [value]); expect(f.pipeline.pendingSampleByteCount).toBe(22);
    f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.decoded()).toHaveLength(1);
    const refused = fixture({ maxPendingSampleBytes: 21 }), input = {};
    refused.pipeline.pushSampleObject(object, [value], input);
    expect(refused.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full');
  });

  it.each(['payload', 'extensions', 'videoConfig', 'audioConfig', 'unknown'] as const)('charges the entire backing of a tiny %s view', field => {
    const f = fixture({ maxPendingSampleBytes: 64 }), input = {}, tiny = new Uint8Array(new ArrayBuffer(128), 100, 1);
    const value = sample(), object = wire();
    const headers = field === 'unknown' ? { ...value.headers, unknown: new Map([[1n, tiny]]) }
      : field === 'videoConfig' || field === 'audioConfig' ? { ...value.headers, [field]: tiny } : value.headers;
    const carrier = field === 'payload' || field === 'extensions' ? { ...object, [field]: tiny } : object;
    f.pipeline.pushSampleObject(carrier, [{ ...value, headers }], input);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full');
    expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.commands).toEqual([]);
  });

  it('deduplicates one backing within a batch and keeps its entire charge through a pending suffix', () => {
    const f = fixture({ maxPendingSampleBytes: 64, isLive: true,
      config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, maxReleasePerTick: 1 } });
    const backing = new ArrayBuffer(64), view = (offset: number) => new Uint8Array(backing, offset, 1);
    const headers = { ...sample().headers, videoConfig: view(2), audioConfig: view(3), unknown: new Map([[1n, view(4)]]) };
    const values = [sample(0, view(5)), sample(1, view(6), false)].map(s => ({ ...s, headers: {
      ...headers, videoFrameMarking: { ...headers.videoFrameMarking!, independent: s.chunk.type === 'key' } } }));
    const object = { ...wire(0, view(0)), extensions: view(1) };
    f.pipeline.pushSampleObject(object, values); expect(f.pipeline.pendingSampleByteCount).toBe(64);
    f.pipeline.tick(); expect(f.pipeline.pendingSampleCount).toBe(1); expect(f.pipeline.pendingSampleByteCount).toBe(64);
    expect(f.pipeline.pendingSampleByteCount).toBe(64); expect(f.decoded()).toHaveLength(1);
    const input = {}; f.pipeline.pushSampleObject({ ...object, objectId: varint(1) }, [{ ...values[0]!, sampleIndex: 0 }], input);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full');
    f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.decoded()).toHaveLength(2);
    f.pipeline.pushSampleObject({ ...object, objectId: varint(1) }, [{ ...values[0]!, sampleIndex: 0 }]);
    expect(f.pipeline.pendingSampleByteCount).toBe(64); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0);
  });

  it('charges a SharedArrayBuffer backing once for aliased views', () => {
    const f = fixture({ maxPendingSampleBytes: 64 }), backing = new SharedArrayBuffer(64);
    const value = sample(0, new Uint8Array(backing, 2, 1));
    f.pipeline.pushSampleObject(wire(0, new Uint8Array(backing, 0, 1)), [
      { ...value, headers: { ...value.headers, videoConfig: new Uint8Array(backing, 1, 1) } },
    ]);
    expect(f.pipeline.pendingSampleByteCount).toBe(64); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0);
  });

  it('uses intrinsic backing lengths instead of shadowed view or buffer properties', () => {
    const f = fixture({ maxPendingSampleBytes: 64 }), input = {}, backing = new ArrayBuffer(128), data = new Uint8Array(backing, 1, 1);
    const getBuffer = vi.fn(() => new ArrayBuffer(1)), getLength = vi.fn(() => 1);
    Object.defineProperty(data, 'buffer', { get: getBuffer });
    Object.defineProperty(data, 'byteLength', { get: getLength });
    Object.defineProperty(backing, 'byteLength', { value: 1 });
    f.pipeline.pushSampleObject(wire(), [sample(0, data)], input);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full');
    expect(getBuffer).not.toHaveBeenCalled(); expect(getLength).not.toHaveBeenCalled();
  });

  it('reserves bytes before configure/decoder callbacks and holds them during native pressure', () => {
    const f = fixture({ maxPendingSampleBytes: 13 }), counts: number[] = [];
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      f.commands.push(c); counts.push(f.pipeline.pendingSampleByteCount);
      if (c.type === 'decode_video' && f.decoded().length === 1) {
        f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 8, maxRecommended: 8 });
      }
    });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1, new Uint8Array(4), false)]);
    f.pipeline.tick(); expect(f.pipeline.pendingSampleCount).toBe(1); expect(f.pipeline.pendingSampleByteCount).toBe(13);
    expect(counts).toEqual([13, 13]); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(13);
    f.pipeline.handleFeedback({ type: 'queue_pressure', mediaType: 'video', depth: 0, maxRecommended: 8 });
    f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(counts).toEqual([13, 13, 13]);
  });

  it('charges an empty carrier until wire retirement without configuring media', () => {
    const f = fixture({ maxPendingSampleBytes: 12 });
    f.pipeline.pushSampleObject(wire(0, new Uint8Array(12)), []);
    expect(f.pipeline.pendingSampleCount).toBe(0); expect(f.pipeline.pendingSampleByteCount).toBe(12);
    expect(f.pipeline.bufferedGroupCount).toBe(1); f.pipeline.tick();
    expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.pipeline.bufferedGroupCount).toBe(0);
    expect(f.commands).toEqual([]);
  });

  it.each(['reset', 'switch'] as const)('releases active and queued backing charges exactly once on %s', operation => {
    const f = fixture({ maxPendingSampleBytes: 21, isLive: true,
      config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, maxReleasePerTick: 1 } });
    const active = {}, queued = {};
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1, new Uint8Array(4), false)], active); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(1), [sample(0, new Uint8Array(4), false)], queued);
    expect(f.pipeline.pendingSampleByteCount).toBe(21);
    if (operation === 'reset') f.pipeline.reset(); else f.pipeline.resetForTrackSwitch(9n);
    expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.discarded).toHaveBeenCalledTimes(2);
    f.pipeline.reset(); expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.discarded).toHaveBeenCalledTimes(2);
    f.pipeline.pushSampleObject(wire(37, new Uint8Array(3), 9), [sample()]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(2);
  });

  it.each(['configure', 'decode_video'] as const)('releases only the failing batch when %s throws', commandType => {
    const f = fixture({ maxPendingSampleBytes: 21 }), input = {};
    const hook = vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand');
    hook.mockImplementation(c => { if (c.type === commandType) throw Error('native callback'); f.commands.push(c); });
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1, new Uint8Array(4), false)], input);
    f.pipeline.pushSampleObject(wire(1), [sample()]);
    expect(() => f.pipeline.tick()).toThrow('native callback');
    expect(f.pipeline.pendingSampleByteCount).toBe(8); expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'decoder policy');
    hook.mockImplementation(c => { f.commands.push(c); }); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0);
  });

  it('releases bytes before a reset notification throws', () => {
    const f = fixture(), input = {}; f.pipeline.pushSampleObject(wire(), [sample()], input);
    vi.spyOn(f.pipeline as unknown as { onCommand: (c: DecoderCommand) => void }, 'onCommand').mockImplementation(c => {
      if (c.type === 'reset') { expect(f.pipeline.pendingSampleByteCount).toBe(0); throw Error('reset callback'); }
    });
    expect(() => f.pipeline.reset()).toThrow('reset callback'); expect(f.pipeline.pendingSampleByteCount).toBe(0);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'decoder reset');
  });

  it('releases skipped wire-gap suffix bytes without rescuing a later independent sample', () => {
    const f = fixture(), input = {}; f.pipeline.pushSampleObject(wire(), [sample()]); f.pipeline.tick();
    f.pipeline.pushSampleObject(wire(2), [sample(0), sample(1, new Uint8Array(4), false)], input);
    expect(f.pipeline.pendingSampleByteCount).toBe(13); f.pipeline.tick();
    expect(f.pipeline.pendingSampleByteCount).toBe(13); expect(f.discarded).not.toHaveBeenCalled();
    f.advance(); f.pipeline.tick();
    expect(f.pipeline.pendingSampleByteCount).toBe(0); expect(f.decoded()).toHaveLength(1);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'skipped');
  });

  it('releases priority-evicted bytes before a discard observer resets and admits a successor', () => {
    const f = fixture({ maxPendingSampleBytes: 21,
      config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 1 } }), old = {}, fresh = {};
    const observed = vi.fn((input: object) => {
      if (input === old) {
        expect(f.pipeline.pendingSampleByteCount).toBe(8); f.pipeline.reset();
        f.pipeline.pushSampleObject(wire(37, new Uint8Array(3), 9), [sample()], fresh);
      }
    });
    f.pipeline.inputObserver = observed;
    f.pipeline.pushSampleObject(wire(0, new Uint8Array(3), 7, 200), [sample(0), sample(1, new Uint8Array(4), false)], old);
    f.pipeline.pushSampleObject(wire(0, new Uint8Array(3), 8, 100), [sample()], {});
    expect(f.pipeline.pendingSampleByteCount).toBe(8); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0);
    expect(observed.mock.calls.filter(call => call[0] === old)).toHaveLength(1);
    expect(f.decoded()[0]?.inputToken).toBe(fresh);
  });

  it('refunds backlog-shed batches and consumed batches while retaining the rest', () => {
    const f = fixture({ isLive: true, maxPendingSampleBytes: 32,
      config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, maxReleasePerTick: 1 } }), oldest = {};
    for (let group = 7; group < 11; group++) f.pipeline.pushSampleObject(wire(0, new Uint8Array(3), group), [sample()], group === 7 ? oldest : {});
    expect(f.pipeline.pendingSampleByteCount).toBe(32); f.pipeline.tick();
    expect(f.pipeline.pendingSampleByteCount).toBe(24); expect(f.discarded).toHaveBeenCalledExactlyOnceWith(oldest, 'backlog shed');
    expect(f.pipeline.pendingSampleCount).toBe(3); expect(f.pipeline.bufferedGroupCount).toBe(3); expect(f.decoded()).toHaveLength(0);
    f.pipeline.endGroup(7n); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(16);
    expect(f.pipeline.pendingSampleCount).toBe(2); expect(f.pipeline.bufferedGroupCount).toBe(2); expect(f.decoded()).toHaveLength(1);
  });

  it('retains byte ownership across observer reassignment while forgetting old identities', () => {
    const f = fixture({ isLive: true,
      config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100, maxReleasePerTick: 1 } }), next = vi.fn();
    f.pipeline.pushSampleObject(wire(), [sample(0), sample(1, new Uint8Array(4), false)], {}); f.pipeline.tick();
    expect(f.pipeline.pendingSampleByteCount).toBe(13); f.pipeline.inputObserver = next;
    expect(f.pipeline.pendingSampleByteCount).toBe(13); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0);
    expect(f.decoded()[1]).not.toHaveProperty('inputToken'); expect(next).not.toHaveBeenCalled(); expect(f.discarded).not.toHaveBeenCalled();
  });

  it('leaves initial-cursor eligibility intact after an oversized first carrier refusal', () => {
    const f = fixture({ maxPendingSampleBytes: 8 }), input = {};
    f.pipeline.pushSampleObject(wire(0, new Uint8Array(9)), [], input);
    expect(f.discarded).toHaveBeenCalledExactlyOnceWith(input, 'buffer full'); expect(f.pipeline.pendingSampleByteCount).toBe(0);
    f.pipeline.pushSampleObject(wire(37), [sample()]); f.pipeline.tick(); expect(f.decoded()).toHaveLength(1);
  });

  it('does not install measured bytes after a wire getter resets and admits a successor', () => {
    const f = fixture({ maxPendingSampleBytes: 8 }), fresh = {}, old = {};
    const carrier = { ...wire(), get extensions() {
      f.pipeline.reset(); f.pipeline.pushSampleObject(wire(37, new Uint8Array(3), 9), [sample()], fresh); return undefined;
    } };
    f.pipeline.pushSampleObject(carrier, [sample()], old);
    expect(f.pipeline.pendingSampleByteCount).toBe(8); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0);
    expect(f.decoded()).toHaveLength(1); expect(f.decoded()[0]?.inputToken).toBe(fresh); expect(f.discarded).not.toHaveBeenCalled();
  });

  it('preserves successor byte accounting when a capacity-refusal observer reenters reset', () => {
    const f = fixture({ maxPendingSampleBytes: 8 }), refused = {}, fresh = {};
    const observed = vi.fn((input: object) => {
      if (input === refused) { f.pipeline.reset(); f.pipeline.pushSampleObject(wire(37, new Uint8Array(3), 9), [sample()], fresh); }
    });
    f.pipeline.inputObserver = observed; f.pipeline.pushSampleObject(wire(), [sample()], {});
    f.pipeline.pushSampleObject(wire(1), [sample()], refused);
    expect(f.pipeline.pendingSampleByteCount).toBe(8); f.pipeline.tick(); expect(f.pipeline.pendingSampleByteCount).toBe(0);
    expect(f.decoded()[0]?.inputToken).toBe(fresh); expect(observed.mock.calls.filter(call => call[0] === refused)).toHaveLength(1);
  });

  it('preserves ordinary LOC buffering regardless of the optional batch byte limit', () => {
    const f = fixture({ maxPendingSampleBytes: 1 }), object = wire(0, new Uint8Array(1024));
    f.pipeline.pushObject(object, sample().headers); f.pipeline.tick();
    expect(f.decoded()).toHaveLength(1); expect(f.decoded()[0]?.chunk.data).toBe(object.payload);
    expect(f.discarded).not.toHaveBeenCalled();
  });
});
