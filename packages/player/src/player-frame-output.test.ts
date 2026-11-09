import { describe, expect, it, vi } from 'vitest';
import type { FrameOutput, FrameOutputAdapters, FrameOutputContext, MoqtPlayerConfig } from './config.js';
import { createFramePipelines } from './player-frame-output.js';
import type { AudioDecoderLike, AudioOutputLike, VideoDecoderLike, VideoRendererLike } from './interfaces.js';
import type { PipelineCallbacks, TrackInfo } from './player-pipeline.js';

const clock = { now: () => 0 };
const videoInfo: TrackInfo = { video: { codec: 'vp09.00.10.08', packaging: 'loc' }, audio: undefined };
const avInfo: TrackInfo = { ...videoInfo, audio: { codec: 'opus', packaging: 'loc', samplerate: 48000, channels: 2 } };
const callbacks = (): PipelineCallbacks => ({ onFirstFrame: vi.fn(), onStall: vi.fn(), onDecodeError: vi.fn(),
  onFrameRendered: vi.fn(), onFeedback: vi.fn(), onCommand: vi.fn(), onEvent: vi.fn() });
function video() {
  const decoder: VideoDecoderLike = { supportsOutputTiming: true, configure: vi.fn(), decode: vi.fn(),
    flush: vi.fn(async () => {}), reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onFrame: null, onError: null };
  const renderer: VideoRendererLike = { supportsOutputTiming: true, enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
    observeFrames: vi.fn(() => () => {}), onFirstFrame: null, onFrameRendered: null, onStall: null };
  return { videoDecoder: decoder, renderer };
}
function audio() {
  const decoder: AudioDecoderLike = { supportsOutputTiming: true, configure: vi.fn(), decode: vi.fn(),
    flush: vi.fn(async () => {}), reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onData: null, onError: null };
  const output: AudioOutputLike = { supportsOutputTiming: true, schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(),
    observeSchedules: vi.fn(() => () => {}), sampleSourcePosition: vi.fn(() => null), currentPlayoutTimeUs: 0 };
  return { audioDecoder: decoder, audioOutput: output };
}
function config(factory?: MoqtPlayerConfig['createFrameOutput']): MoqtPlayerConfig {
  return { url: 'https://relay.example/moq', namespace: ['vod'], gapTimeoutMs: 500, driftThresholdMs: 30,
    maxBufferDepth: 60, lateFrameThresholdMs: 100, maxConsecutiveGaps: 5, maxDecodeErrors: 10,
    ...(factory ? { createFrameOutput: factory } : {}) };
}
function prepare(output: FrameOutput, options: Partial<MoqtPlayerConfig> = {}, borrowed: FrameOutputAdapters | readonly object[] = {}, info = videoInfo) {
  return createFramePipelines({ ...config(() => output), ...options }, clock, info, callbacks(), borrowed);
}

describe('fresh frame output ownership', () => {
  it('shows an already prepared historical target without a live-network startup cushion', () => {
    const prepared = prepare(video());
    expect(prepared.pipelines.getRenderCushionUs?.()).toBe(0);
    prepared.retire();
  });
  it('stages decoded audio without scheduling the factory target before adoption', () => {
    const fresh = { ...video(), ...audio() }, prepared = prepare(fresh, {}, {}, avInfo);
    const pcm = { numberOfFrames: 480, numberOfChannels: 2, sampleRate: 48_000, close: vi.fn() };
    const timing = { context: { epoch: {}, sourceTimestampUs: 0n, presentFromSourceUs: 0n,
      recomputeRenderTimeUs: () => 0 }, sourceOffsetUs: 0 };
    expect(prepared.output.audioOutput).not.toBe(fresh.audioOutput);
    expect(prepared.resources).toContain(fresh.audioOutput); expect(prepared.resources).toContain(prepared.output.audioOutput);
    prepared.audioPreparation!.schedule(pcm, 0, {}, timing);
    expect(prepared.audioPreparation!.retainedChunkCount).toBe(1); expect(fresh.audioOutput.schedule).not.toHaveBeenCalled();
    prepared.retire(); expect(pcm.close).toHaveBeenCalledTimes(1); expect(fresh.audioOutput.destroy).toHaveBeenCalledTimes(1);
  });

  it('protects the underlying native audio target as well as its staging wrapper on a successor', () => {
    const first = { ...video(), ...audio() }, prepared = prepare(first, {}, {}, avInfo);
    const next = { ...video(), ...audio(), audioOutput: first.audioOutput };
    expect(() => prepare(next, {}, prepared.resources, avInfo)).toThrow(/reused current/);
    expect(first.audioOutput.destroy).not.toHaveBeenCalled();
    expect(next.videoDecoder.destroy).toHaveBeenCalledTimes(1); expect(next.audioDecoder.destroy).toHaveBeenCalledTimes(1);
    prepared.retire(); expect(first.audioOutput.destroy).toHaveBeenCalledTimes(1);
  });

  it('accepts explicit deferred activation without calling it producing readiness', () => {
    const raw: AudioOutputLike = { ...audio().audioOutput, outputTimingDeferred: true };
    Reflect.deleteProperty(raw, 'supportsOutputTiming');
    const prepared = prepare({ ...video(), ...audio(), audioOutput: raw }, {}, {}, avInfo);
    expect(prepared.audioPreparation!.sampleSourcePosition({})).toBeNull();
    expect(raw.schedule).not.toHaveBeenCalled(); prepared.retire(); expect(raw.destroy).toHaveBeenCalledTimes(1);
  });
  it('constructs only the returned pairs and exposes the actual owned adapter references', () => {
    const output = video(), createVideoDecoder = vi.fn(() => video().videoDecoder), createRenderer = vi.fn(() => video().renderer);
    const factory = vi.fn((_context: Readonly<FrameOutputContext>) => output);
    const prepared = createFramePipelines({ ...config(factory), createVideoDecoder, createRenderer }, clock, videoInfo, callbacks(), {});
    expect(factory).toHaveBeenCalledExactlyOnceWith({ video: true, audio: false, clock });
    expect(Object.isFrozen(factory.mock.calls[0]![0])).toBe(true);
    expect(createVideoDecoder).not.toHaveBeenCalled(); expect(createRenderer).not.toHaveBeenCalled();
    expect(prepared.pipelines.frameOutput?.videoDecoder).toBe(output.videoDecoder);
    expect(prepared.pipelines.frameOutput?.renderer).toBe(output.renderer);
    expect(output.videoDecoder.onFrame).toBeTypeOf('function');
    prepared.retire(); prepared.retire();
    expect(output.videoDecoder.destroy).toHaveBeenCalledTimes(1); expect(output.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing factory without calling legacy startup factories', () => {
    const createVideoDecoder = vi.fn(() => video().videoDecoder);
    expect(() => createFramePipelines({ ...config(), createVideoDecoder }, clock, videoInfo, callbacks(), {})).toThrow(/createFrameOutput/);
    expect(createVideoDecoder).not.toHaveBeenCalled();
  });

  it('refuses an MSE role before acquiring a frame graph', () => {
    const factory = vi.fn(() => video());
    expect(() => createFramePipelines(config(factory), clock, { video: { packaging: 'cmaf' }, audio: undefined }, callbacks(), {})).toThrow(/frame-decoded/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('refuses a borrowed decoder before overwriting its callbacks, and destroys only the fresh renderer', () => {
    const live = video(), fresh = video(); const onFrame = vi.fn(); live.videoDecoder.onFrame = onFrame;
    expect(() => prepare({ videoDecoder: live.videoDecoder, renderer: fresh.renderer }, {}, live)).toThrow(/reused current/);
    expect(live.videoDecoder.onFrame).toBe(onFrame);
    expect(live.videoDecoder.destroy).not.toHaveBeenCalled(); expect(live.renderer.destroy).not.toHaveBeenCalled();
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('protects borrowed resources even when returned under another role', () => {
    const live = video(), fresh = video();
    const output = { videoDecoder: fresh.videoDecoder, renderer: live.videoDecoder } as unknown as FrameOutput;
    expect(() => prepare(output, {}, live)).toThrow(/reused current/);
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1); expect(live.videoDecoder.destroy).not.toHaveBeenCalled();
  });

  it('deduplicates destruction when an invalid result shares one adapter across roles', () => {
    const output = video();
    expect(() => prepare({ videoDecoder: output.videoDecoder, renderer: output.videoDecoder } as unknown as FrameOutput)).toThrow(/across roles/);
    expect(output.videoDecoder.destroy).toHaveBeenCalledTimes(1);
  });

  it('collects all data resources before refusing an accessor without invoking it', () => {
    const fresh = { ...video(), ...audio() }, read = vi.fn(() => fresh.videoDecoder);
    const returned = { renderer: fresh.renderer, ...audio(), audioOutput: fresh.audioOutput };
    Object.defineProperty(returned, 'videoDecoder', { get: read });
    expect(() => prepare(returned, {}, {}, avInfo)).toThrow(/data property/); expect(read).not.toHaveBeenCalled();
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1); expect(fresh.audioOutput.destroy).toHaveBeenCalledTimes(1);
    expect(returned.audioDecoder.destroy).toHaveBeenCalledTimes(1); expect(fresh.videoDecoder.destroy).not.toHaveBeenCalled();
  });

  it('refuses missing role partners and retires every fresh returned resource', () => {
    const fresh = { ...video(), ...audio() };
    expect(() => prepare({ videoDecoder: fresh.videoDecoder, ...audio(), audioOutput: fresh.audioOutput }, {}, {}, avInfo)).toThrow(/missing renderer/);
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1); expect(fresh.audioOutput.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses unrequested adapters and cleans their resources', () => {
    const fresh = { ...video(), ...audio() };
    expect(() => prepare(fresh)).toThrow(/unrequested/);
    for (const adapter of Object.values(fresh)) expect(adapter.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses unobservable producing timing before any dispatcher rewiring', () => {
    const fresh = video(), onFrame = vi.fn(); fresh.videoDecoder.onFrame = onFrame;
    Object.defineProperty(fresh.renderer, 'supportsOutputTiming', { value: undefined });
    expect(() => prepare(fresh)).toThrow(/producing timing/);
    expect(fresh.videoDecoder.onFrame).toBe(onFrame); expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('cleans fresh resources if pipeline construction fails', () => {
    const fresh = video(), error = new Error('recovery factory failed');
    expect(() => prepare(fresh, { createRecoveryController: () => { throw error; } })).toThrow(error);
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1); expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('completes refusal cleanup even when one destroy throws', () => {
    const fresh = { ...video(), ...audio() };
    vi.mocked(fresh.videoDecoder.destroy).mockImplementation(() => { throw new Error('destroy failed'); });
    expect(() => prepare(fresh)).toThrow(AggregateError);
    for (const adapter of Object.values(fresh)) expect(adapter.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a prepared graph inactive and sends no embedding notification on refusal', () => {
    const fresh = video(), onAdopt = vi.fn(), onRetire = vi.fn();
    const prepared = prepare({ ...fresh, onAdopt, onRetire });
    expect(onAdopt).not.toHaveBeenCalled(); expect(fresh.renderer.enqueue).not.toHaveBeenCalled();
    prepared.retire(); expect(onRetire).not.toHaveBeenCalled();
    expect(() => prepared.adopt(true)).toThrow(/retired/);
  });

  it('records adoption before a reentrant retirement', () => {
    const fresh = video(), onRetire = vi.fn(); let prepared: ReturnType<typeof prepare>;
    const onAdopt = vi.fn(() => prepared.retire());
    prepared = prepare({ ...fresh, onAdopt, onRetire }); prepared.adopt(false); prepared.retire();
    expect(onAdopt).toHaveBeenCalledExactlyOnceWith({ playing: false }); expect(onRetire).toHaveBeenCalledTimes(1);
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1);
  });

  it('retains the single retirement owner after a throwing adoption notification', () => {
    const fresh = video(), onRetire = vi.fn(), failure = new Error('adoption notification failed');
    const prepared = prepare({ ...fresh, onAdopt: () => { throw failure; }, onRetire });
    expect(() => prepared.adopt(true)).toThrow(failure); prepared.retire(); prepared.retire();
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1); expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it('retires every owned adapter and the embedding pointer when native cleanup throws or reenters', () => {
    const fresh = { ...video(), ...audio() }, onRetire = vi.fn();
    const prepared = prepare({ ...fresh, onRetire }, {}, {}, avInfo); prepared.adopt(true);
    vi.mocked(fresh.videoDecoder.destroy).mockImplementation(() => { prepared.retire(); throw new Error('native destroy failed'); });
    expect(() => prepared.retire()).toThrow(AggregateError); prepared.retire();
    for (const adapter of Object.values(fresh)) expect(adapter.destroy).toHaveBeenCalledTimes(1);
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it('closes all held frames even if the first native close throws', () => {
    const fresh = video(), prepared = prepare(fresh);
    const frames = [0, 1, 2].map(timestamp => ({ timestamp, close: vi.fn() }));
    frames[0]!.close.mockImplementation(() => { throw new Error('native frame close failed'); });
    for (const frame of frames) fresh.videoDecoder.onFrame!(frame, 0);
    expect(fresh.renderer.enqueue).not.toHaveBeenCalled();
    expect(() => prepared.retire()).toThrow(AggregateError); prepared.retire();
    for (const frame of frames) expect(frame.close).toHaveBeenCalledTimes(1);
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('constructor output ownership', () => {
  it('retires lifecycle callbacks before cleaning adapters after failed wiring', () => {
    const fresh = video(), observed = callbacks();
    Object.defineProperty(fresh.renderer, 'onFrameRendered', { set() { throw new Error('wiring failed'); } });
    vi.mocked(fresh.renderer.destroy).mockImplementation(() => {
      fresh.renderer.onFirstFrame?.(); fresh.renderer.onStall?.(500); fresh.renderer.onStallRecovered?.(600);
    });
    expect(() => createFramePipelines(config(() => fresh), clock, videoInfo, observed, {})).toThrow('wiring failed');
    expect(observed.onFirstFrame).not.toHaveBeenCalled(); expect(observed.onStall).not.toHaveBeenCalled();
  });
  it.each([false, true])('settles frames transferred during callback wiring when a later setter throws=%s', throws => {
    const fresh = video(), failure = new Error('renderer callback setter failed');
    const frame = { timestamp: 0, close: vi.fn() };
    let onFrame: VideoDecoderLike['onFrame'] = null;
    let onRendered: VideoRendererLike['onFrameRendered'] = null;
    Object.defineProperty(fresh.videoDecoder, 'onFrame', {
      configurable: true,
      get() { return onFrame; },
      set(value: VideoDecoderLike['onFrame']) {
        onFrame = value;
        // Callback properties are external adapter code. A decoded output can
        // transfer to the dispatcher while it is still wiring other callbacks.
        value?.(frame, 0);
      },
    });
    Object.defineProperty(fresh.renderer, 'onFrameRendered', {
      configurable: true,
      get() { return onRendered; },
      set(value: VideoRendererLike['onFrameRendered']) {
        onRendered = value;
        if (throws) throw failure;
      },
    });
    if (throws) expect(() => prepare(fresh)).toThrow(failure);
    else {
      const prepared = prepare(fresh);
      expect(fresh.renderer.enqueue).not.toHaveBeenCalled();
      expect(frame.close).not.toHaveBeenCalled();
      prepared.retire();
    }
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1);
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
    expect(frame.close).toHaveBeenCalledTimes(1);
  });
});


describe('synchronous frame output boundaries', () => {
  for (const rejected of [false, true]) {
    it(`refuses a Promise factory result and owns its rejection: ${rejected}`, async () => {
      const cfg = config();
      Reflect.set(cfg, 'createFrameOutput', async () => {
        if (rejected) throw new Error('ASYNC_FACTORY_UNOWNED');
      });
      expect(() => createFramePipelines(cfg, clock, videoInfo, callbacks(), {})).toThrow(/plain record/);
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    it(`refuses an async adoption result and retains exactly one cleanup owner: ${rejected}`, async () => {
      const fresh = video(), prepared = prepare({ ...fresh, onAdopt: async () => {
        if (rejected) throw new Error('ASYNC_ADOPT_UNOWNED');
      } });
      expect(() => prepared.adopt(true)).toThrow(/synchronously/);
      prepared.retire(); prepared.retire();
      expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1);
      expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    it(`refuses an async retirement result after releasing native resources: ${rejected}`, async () => {
      const fresh = video(), prepared = prepare({ ...fresh, onRetire: async () => {
        if (rejected) throw new Error('ASYNC_RETIRE_UNOWNED');
      } });
      prepared.adopt(true);
      expect(() => prepared.retire()).toThrow(AggregateError);
      prepared.retire();
      expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1);
      expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
});

describe('retired decoder publication', () => {
  it.each([false, true])('decoder failure publication respects failed-construction retirement=%s', fails => {
    const fresh = video(), observed = callbacks(), failure = new Error('later wiring failed');
    if (fails) Object.defineProperty(fresh.renderer, 'onFrameRendered', { set() { throw failure; } });
    vi.mocked(fresh.videoDecoder.destroy).mockImplementation(() => {
      fresh.videoDecoder.onError?.(new Error('native decoder closing'));
    });
    if (fails) {
      expect(() => createFramePipelines(config(() => fresh), clock, videoInfo, observed, {})).toThrow(failure);
      expect(observed.onDecodeError).not.toHaveBeenCalled();
      expect(observed.onFeedback).not.toHaveBeenCalled();
    } else {
      const prepared = createFramePipelines(config(() => fresh), clock, videoInfo, observed, {});
      fresh.videoDecoder.onError?.(new Error('legitimate live failure'));
      expect(observed.onDecodeError).toHaveBeenCalledTimes(1);
      expect(observed.onFeedback).toHaveBeenCalledTimes(1);
      prepared.retire();
    }
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1);
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });
  it('collects returned data adapters before refusing and settling a rejecting thenable', async () => {
    const fresh = video(), rejected = vi.fn();
    const candidate = { ...fresh, then(_resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
      rejected(); reject(new Error('INVALID_FACTORY_THENABLE'));
    } };
    expect(() => prepare(candidate)).toThrow(/asynchronous result/);
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1);
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});


describe('decoder error callback reentry', () => {
  it.each(['video', 'audio'] as const)('does not publish feedback after %s error handling retires the graph', role => {
    const fresh = { ...video(), ...audio() }, observed = callbacks();
    const prepared = createFramePipelines(config(() => fresh), clock, avInfo, observed, {});
    vi.mocked(observed.onDecodeError).mockImplementation(() => prepared.retire());
    const decoder = role === 'video' ? fresh.videoDecoder : fresh.audioDecoder;
    decoder.onError?.(new Error('real decoder failure'));
    expect(observed.onDecodeError).toHaveBeenCalledExactlyOnceWith(role, expect.any(Error));
    expect(observed.onFeedback).not.toHaveBeenCalled();
    for (const adapter of Object.values(fresh)) expect(adapter.destroy).toHaveBeenCalledTimes(1);
  });
});


describe('video-only output adoption scope', () => {
  function scoped(factory: NonNullable<MoqtPlayerConfig['createFrameOutput']>, info = videoInfo) {
    return createFramePipelines(config(factory), clock, info, callbacks(), {}, undefined, undefined, 'video');
  }
  it('requires explicit factory acknowledgement before wiring or adoption', () => {
    const fresh = video(), onAdopt = vi.fn();
    expect(() => scoped(() => ({ ...fresh, onAdopt }))).toThrow(/scope/);
    expect(onAdopt).not.toHaveBeenCalled();
    expect(fresh.videoDecoder.onFrame).toBeNull();
    expect(fresh.videoDecoder.destroy).toHaveBeenCalledTimes(1);
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });
  it('passes the scope to an acknowledging factory and retires once', () => {
    const fresh = video(), factory = vi.fn(() => ({ ...fresh, scope: 'video' as const }));
    const prepared = scoped(factory);
    expect(factory).toHaveBeenCalledExactlyOnceWith({ video: true, audio: false, clock, scope: 'video' });
    prepared.adopt(false); prepared.retire(); prepared.retire();
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });
  it('refuses an audio role before calling a video-only factory', () => {
    const factory = vi.fn(() => ({ ...video(), ...audio(), scope: 'video' as const }));
    expect(() => scoped(factory, avInfo)).toThrow(/scope/);
    expect(factory).not.toHaveBeenCalled();
  });
  it('does not accept a scoped result for a whole-output request', () => {
    const fresh = video();
    expect(() => prepare(Object.assign(fresh, { scope: 'video' as const }))).toThrow(/scope/);
    expect(fresh.renderer.destroy).toHaveBeenCalledTimes(1);
  });
});
