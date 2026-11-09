import { describe, expect, it, vi } from 'vitest';
import type { AudioRenderTiming } from '@openmoq/playback';
import type { AudioOutputLike, AudioProducedTiming, AudioScheduleObservation, AudioScheduleObserver } from './interfaces.js';
import { FrameAudioOutput } from './frame-audio-output.js';

// PCM carriers and target events are explicit unit fakes, not native playout.
function pcm(frames = 480, channels = 2, rate = 48_000) {
  return { numberOfFrames: frames, numberOfChannels: channels, sampleRate: rate,
    timestamp: 123456, close: vi.fn() };
}
function timing(sourceTimestampUs = 0n): AudioProducedTiming {
  const context: AudioRenderTiming = { epoch: {}, sourceTimestampUs,
    presentFromSourceUs: 500n, recomputeRenderTimeUs: vi.fn(() => 10_000) };
  return { context, sourceOffsetUs: 0 };
}
function fixture(maxChunks = 3, maxBytes = 20_000, options: { retainDeferred?: boolean; onPrepared?: () => void } = {}) {
  const listeners = new Set<AudioScheduleObserver>();
  const target: AudioOutputLike = {
    supportsOutputTiming: true,
    schedule: vi.fn((data: unknown) => { (data as ReturnType<typeof pcm>).close(); }),
    flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 123_000,
    playheadCaptureUs: vi.fn(() => 321_000), setPlaybackRate: vi.fn(),
    sampleSourcePosition: vi.fn(epoch => ({ epoch, sourceTimestampUs: 9n, sourceOffsetUs: 0.5 })),
    observeSchedules: vi.fn(observer => {
      listeners.add(observer);
      return () => { listeners.delete(observer); };
    }),
  };
  const output = new FrameAudioOutput({ target, maxChunks, maxBytes, ...options });
  const events: AudioScheduleObservation[] = [];
  const observe = () => output.observeSchedules(event => { events.push(event); });
  const emit = (token: object, state: AudioScheduleObservation['state'], reason: AudioScheduleObservation['reason'] = null) => {
    for (const listener of [...listeners]) void listener({ token, state, reason });
  };
  return { target, output, events, observe, emit, listeners };
}

describe('FrameAudioOutput staging', () => {
  it('constructs without accessing the target and validates positive safe budgets', () => {
    const target = new Proxy({} as AudioOutputLike, { get() { throw Error('target accessed'); }, set() { throw Error('target mutated'); } });
    expect(() => new FrameAudioOutput({ target, maxChunks: 1, maxBytes: 4 })).not.toThrow();
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new FrameAudioOutput({ target, maxChunks: value, maxBytes: 4 })).toThrow(RangeError);
      expect(() => new FrameAudioOutput({ target, maxChunks: 1, maxBytes: value })).toThrow(RangeError);
    }
  });

  it('holds exact PCM and producing proof without clock, schedule, or synthetic evidence', () => {
    const f = fixture(); f.observe();
    const data = pcm(), proof = timing(), token = {};
    Object.defineProperty(data, 'timestamp', { get() { throw Error('native timestamp read'); } });
    Object.defineProperty(data, 'allocationSize', { get() { throw Error('native allocation read'); } });
    f.output.schedule(data, 42, token, proof);
    expect(f.output.supportsOutputTiming).toBe(true);
    expect(f.output.retainedChunkCount).toBe(1);
    expect(f.output.retainedBytes).toBe(480 * 2 * 4);
    const snapshot = f.output.snapshotPrepared();
    expect(snapshot).toEqual([{ timing: proof, numberOfFrames: 480, sampleRate: 48_000 }]);
    expect(snapshot[0]!.timing.context).toBe(proof.context);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(f.target.schedule).not.toHaveBeenCalled();
    expect(f.target.observeSchedules).not.toHaveBeenCalled();
    expect(proof.context.recomputeRenderTimeUs).not.toHaveBeenCalled();
    expect(data.close).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.output.sampleSourcePosition(proof.context.epoch)).toBeNull();
    expect(f.output.playheadCaptureUs()).toBeNull();
    expect(f.output.currentPlayoutTimeUs).toBeNaN();
    f.output.destroy();
    expect(data.close).toHaveBeenCalledOnce();
  });

  it('drains in order, removing each budget before target invocation and appending reentrant schedules last', () => {
    const f = fixture(), a = pcm(), b = pcm(), c = pcm(), proof = timing(), tokens = [{}, {}, {}];
    f.output.schedule(a, 1, tokens[0], proof); f.output.schedule(b, 2, tokens[1], proof);
    const retained: number[] = [];
    vi.mocked(f.target.schedule).mockImplementation((data, time) => {
      retained.push(f.output.retainedChunkCount);
      if (time === 1) f.output.schedule(c, 3, tokens[2], proof);
      (data as ReturnType<typeof pcm>).close();
    });
    f.output.activate();
    expect(vi.mocked(f.target.schedule).mock.calls).toEqual([[a, 1, tokens[0], proof], [b, 2, tokens[1], proof], [c, 3, tokens[2], proof]]);
    expect(retained).toEqual([1, 1, 0]);
    expect(f.output.retainedBytes).toBe(0);
    expect(f.output.snapshotPrepared()).toEqual([]);
    f.output.activate();
    expect(f.target.schedule).toHaveBeenCalledTimes(3);
    f.output.destroy();
    for (const data of [a, b, c]) expect(data.close).toHaveBeenCalledOnce();
  });

  it.each(['chunks', 'bytes'] as const)('refuses overflow without evicting retained PCM: %s', bound => {
    const f = fixture(bound === 'chunks' ? 1 : 3, bound === 'bytes' ? 3840 : 20_000), a = pcm(), b = pcm(), token = {};
    f.observe(); f.output.schedule(a, 1, {}, timing());
    expect(() => f.output.schedule(b, 2, token, timing())).toThrow(RangeError);
    expect(a.close).not.toHaveBeenCalled(); expect(b.close).toHaveBeenCalledOnce();
    expect(f.output.retainedChunkCount).toBe(1);
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'schedule failed' }]);
    f.output.destroy();
  });

  it.each(['frames', 'channels', 'rate', 'bytes'] as const)('rejects invalid or unsafe PCM dimensions: %s', field => {
    const f = fixture(), token = {};
    const data = field === 'frames' ? pcm(0) : field === 'channels' ? pcm(1, 0)
      : field === 'rate' ? pcm(1, 1, 48_000.5) : pcm(Number.MAX_SAFE_INTEGER, 2);
    f.observe();
    expect(() => f.output.schedule(data, 1, token, timing())).toThrow();
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'schedule failed' }]);
    expect(f.output.retainedBytes).toBe(0); f.output.destroy();
  });

  it.each(['missing', 'null', 'offset', 'context'] as const)('refuses unavailable producing proof: %s', kind => {
    const f = fixture(), data = pcm(), token = {};
    const proof = kind === 'missing' ? undefined : kind === 'null' ? null : kind === 'offset'
      ? { ...timing(), sourceOffsetUs: 0.5 }
      : { ...timing(), context: { ...timing().context, sourceTimestampUs: 0 as unknown as bigint } };
    f.observe();
    expect(() => f.output.schedule(data, 1, token, proof)).toThrow(TypeError);
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'timing unavailable' }]);
    expect(f.target.schedule).not.toHaveBeenCalled(); f.output.destroy();
  });

  it('checks changed target capability at activation and fails closed with no untrimmed fallback', () => {
    const f = fixture(), data = pcm(), token = {};
    f.observe(); f.output.schedule(data, 1, token, timing());
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined, configurable: true });
    expect(() => f.output.activate()).toThrow();
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'timing unavailable' }]);
    expect(f.target.schedule).not.toHaveBeenCalled();
    expect(f.output.retainedBytes).toBe(0); f.output.destroy();
  });

  it('does not double close transferred PCM when target throws, but cleans all still-retained entries', () => {
    const f = fixture(), data = [pcm(), pcm(), pcm()], tokens = [{}, {}, {}], failure = Error('native schedule');
    f.observe(); data.forEach((chunk, i) => f.output.schedule(chunk, i, tokens[i], timing()));
    data[1]!.close.mockImplementation(() => { throw Error('secondary close failure'); });
    vi.mocked(f.target.schedule).mockImplementation(chunk => { (chunk as ReturnType<typeof pcm>).close(); throw failure; });
    expect(() => f.output.activate()).toThrow(failure);
    expect(data.every(chunk => chunk.close.mock.calls.length === 1)).toBe(true);
    expect(f.events).toEqual(tokens.slice(1).map(token => ({ token, state: 'discarded', reason: 'schedule failed' })));
    f.emit(tokens[0]!, 'discarded', 'schedule failed');
    expect(f.events.at(-1)).toEqual({ token: tokens[0], state: 'discarded', reason: 'schedule failed' });
    expect(f.output.retainedChunkCount).toBe(0); f.output.destroy();
  });

  it('retires a schedule whose metadata getter flushes before admission', () => {
    const f = fixture(), data = pcm(), token = {};
    f.observe();
    Object.defineProperty(data, 'numberOfFrames', { get() { f.output.flush(); return 480; } });
    expect(() => f.output.schedule(data, 1, token, timing())).toThrow();
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.output.retainedChunkCount).toBe(0);
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'flushed' }]);
    f.output.destroy();
  });

  it('accepts an opaque function object as the producing epoch without inspecting it', () => {
    const f = fixture(), proof = timing();
    const withEpoch = { ...proof, context: { ...proof.context, epoch: () => {} } };
    f.output.schedule(pcm(), 1, {}, withEpoch);
    expect(f.output.snapshotPrepared()[0]!.timing.context).toBe(withEpoch.context);
    f.output.destroy();
  });

  it('rejects a non-object token before any native transfer, without leaking PCM', () => {
    const f = fixture(), data = pcm(); f.observe(); f.output.activate();
    expect(() => f.output.schedule(data, 1, 1 as unknown as object, timing())).toThrow(TypeError);
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.target.schedule).not.toHaveBeenCalled();
    expect(f.output.retainedBytes).toBe(0); f.output.destroy();
  });

  it('quietly discards for a declared deferred target, then forwards future PCM after real activation', () => {
    const f = fixture(), before = pcm(), muted = pcm(), after = pcm(), tokens = [{}, {}, {}];
    const proof = timing();
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined, configurable: true });
    Object.defineProperty(f.target, 'outputTimingDeferred', { value: true });
    vi.mocked(f.target.sampleSourcePosition!).mockReturnValue(null);
    f.observe(); f.output.schedule(before, 1, tokens[0], proof);
    expect(() => f.output.activate()).not.toThrow();
    expect(() => f.output.schedule(muted, 2, tokens[1], proof)).not.toThrow();
    expect(before.close).toHaveBeenCalledOnce(); expect(muted.close).toHaveBeenCalledOnce();
    expect(f.output.retainedChunkCount).toBe(0); expect(f.output.retainedBytes).toBe(0);
    expect(f.events).toEqual(tokens.slice(0, 2).map(token => ({ token, state: 'discarded', reason: 'timing unavailable' })));
    expect(f.target.schedule).not.toHaveBeenCalled();
    expect(f.output.sampleSourcePosition(proof.context.epoch)).toBeNull();
    expect(f.output.playheadCaptureUs()).toBeNull(); expect(f.output.currentPlayoutTimeUs).toBeNaN();

    Object.defineProperty(f.target, 'supportsOutputTiming', { value: true, configurable: true });
    expect(f.output.sampleSourcePosition(proof.context.epoch)).toBeNull();
    f.output.schedule(after, 3, tokens[2], proof);
    expect(f.target.schedule).toHaveBeenCalledExactlyOnceWith(after, 3, tokens[2], proof);
    expect(f.events).toHaveLength(2);
    const actual = { epoch: proof.context.epoch, sourceTimestampUs: 9n, sourceOffsetUs: 0.5 };
    vi.mocked(f.target.sampleSourcePosition!).mockReturnValue(actual);
    f.emit(tokens[2]!, 'scheduled');
    expect(f.events.at(-1)).toEqual({ token: tokens[2], state: 'scheduled', reason: null });
    expect(f.output.sampleSourcePosition(proof.context.epoch)).toBe(actual);
    expect(after.close).toHaveBeenCalledOnce(); f.output.destroy();
  });

  it.each(['flush', 'destroy'] as const)('fences a deferred-marker getter that reenters %s', action => {
    const f = fixture(), data = pcm(), token = {};
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined });
    Object.defineProperty(f.target, 'outputTimingDeferred', { get() {
      f.output[action](); return true;
    } });
    f.observe(); f.output.schedule(data, 1, token, timing());
    expect(() => f.output.activate()).not.toThrow();
    expect(data.close).toHaveBeenCalledOnce(); expect(f.target.schedule).not.toHaveBeenCalled();
    expect(f.events).toEqual([{ token, state: 'discarded', reason: action === 'flush' ? 'flushed' : 'destroyed' }]);
    expect(f.output.retainedBytes).toBe(0); f.output.destroy();
    expect(f.target.destroy).toHaveBeenCalledOnce();
  });

  it('does not hide a throwing deferred marker or PCM cleanup failure', () => {
    const f = fixture(), data = pcm(), failure = Error('broken marker');
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined });
    Object.defineProperty(f.target, 'outputTimingDeferred', { get() { throw failure; } });
    f.output.schedule(data, 1, {}, timing());
    expect(() => f.output.activate()).toThrow(failure);
    expect(data.close).toHaveBeenCalledOnce(); f.output.destroy();

    const g = fixture(), bad = pcm(), healthy = pcm(), closeFailure = Error('broken PCM close');
    Object.defineProperty(g.target, 'supportsOutputTiming', { value: undefined });
    Object.defineProperty(g.target, 'outputTimingDeferred', { value: true });
    bad.close.mockImplementation(() => { throw closeFailure; });
    g.output.schedule(bad, 1, {}, timing()); g.output.schedule(healthy, 2, {}, timing());
    expect(() => g.output.activate()).toThrow(closeFailure);
    expect(bad.close).toHaveBeenCalledOnce(); expect(healthy.close).toHaveBeenCalledOnce();
    expect(g.output.retainedChunkCount).toBe(0); g.output.destroy();
  });

  it('uses actual capability if deferred-marker access activates the real target', () => {
    const f = fixture(), data = pcm(), proof = timing(), token = {};
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined, configurable: true });
    Object.defineProperty(f.target, 'outputTimingDeferred', { get() {
      Object.defineProperty(f.target, 'supportsOutputTiming', { value: true, configurable: true }); return true;
    } });
    f.output.schedule(data, 1, token, proof); f.output.activate();
    expect(f.target.schedule).toHaveBeenCalledExactlyOnceWith(data, 1, token, proof);
    expect(data.close).toHaveBeenCalledOnce(); f.output.destroy();
  });

  it('snapshots validated producing fields while preserving the exact context identity', () => {
    const f = fixture(), data = pcm(), context = timing().context;
    const proof = { context, sourceOffsetUs: 7 };
    f.output.schedule(data, 1, {}, proof);
    proof.sourceOffsetUs = 999; proof.context = timing(50n).context;
    data.numberOfFrames = 1; data.sampleRate = 1;
    const prepared = f.output.snapshotPrepared()[0]!;
    expect(prepared.numberOfFrames).toBe(480); expect(prepared.sampleRate).toBe(48_000);
    expect(prepared.timing).toEqual({ context, sourceOffsetUs: 7 });
    expect(prepared.timing.context).toBe(context); expect(Object.isFrozen(prepared.timing)).toBe(true);
    expect(Reflect.set(prepared.timing, 'sourceOffsetUs', 888)).toBe(false);
    expect(f.output.snapshotPrepared()[0]!.timing.sourceOffsetUs).toBe(7);
    f.output.activate();
    const forwarded = vi.mocked(f.target.schedule).mock.calls[0]![3]!;
    expect(forwarded).toEqual({ context, sourceOffsetUs: 7 }); expect(forwarded.context).toBe(context);
    expect(f.output.retainedBytes).toBe(0); f.output.destroy();
  });

  it('reads a producing offset once rather than validating one value and retaining another', () => {
    const f = fixture(), context = timing().context;
    const readOffset = vi.fn(() => 8);
    const proof = { context, get sourceOffsetUs() { return readOffset(); } };
    f.output.schedule(pcm(), 1, {}, proof);
    expect(readOffset).toHaveBeenCalledOnce();
    expect(f.output.snapshotPrepared()[0]!.timing).toEqual({ context, sourceOffsetUs: 8 });
    f.output.activate(); expect(readOffset).toHaveBeenCalledOnce(); f.output.destroy();
  });
});

describe('FrameAudioOutput seek preparation', () => {
  it.each([
    { frames: 3, rate: 1000, deltaUs: 2000n, discarded: false },
    { frames: 3, rate: 1000, deltaUs: 2001n, discarded: true },
    { frames: 2, rate: 44_100, deltaUs: 22n, discarded: false },
    { frames: 2, rate: 44_100, deltaUs: 23n, discarded: true },
  ])('uses the exact sample grid before retaining PCM: $frames/$rate/$deltaUs', ({ frames, rate, deltaUs, discarded }) => {
    const f = fixture(), data = pcm(frames, 1, rate), token = {}, source = (1n << 200n) + 12345n;
    const proof: AudioProducedTiming = { context: { epoch: {}, sourceTimestampUs: source,
      presentFromSourceUs: source + 7n + deltaUs, recomputeRenderTimeUs: vi.fn(() => 1) }, sourceOffsetUs: 7 };
    f.observe(); f.output.schedule(data, 1, token, proof);
    expect(proof.context.recomputeRenderTimeUs).not.toHaveBeenCalled();
    expect(f.output.retainedChunkCount).toBe(discarded ? 0 : 1);
    expect(f.output.retainedBytes).toBe(discarded ? 0 : frames * 4);
    if (discarded) {
      expect(data.close).toHaveBeenCalledOnce();
      expect(f.events).toEqual([{ token, state: 'discarded', reason: 'preroll' }]);
      expect(f.target.schedule).not.toHaveBeenCalled();
    } else {
      expect(data.close).not.toHaveBeenCalled();
      expect(f.output.snapshotPrepared()[0]).toEqual({ timing: proof, numberOfFrames: frames, sampleRate: rate });
      f.output.activate();
      expect(f.target.schedule).toHaveBeenCalledExactlyOnceWith(data, 1, token, proof);
      expect(data.numberOfFrames).toBe(frames); expect(data.sampleRate).toBe(rate);
    }
    f.output.destroy(); expect(data.close).toHaveBeenCalledOnce();
  });

  it('discards fully pre-bound PCM before consulting either a full chunk budget or insufficient byte budget', () => {
    const f = fixture(1, 3840), retained = pcm(), incoming = pcm(10_000), token = {};
    f.observe(); f.output.schedule(retained, 1, {}, timing());
    const proof = { ...timing(), context: { ...timing().context, presentFromSourceUs: 1_000_000n } };
    expect(() => f.output.schedule(incoming, 2, token, proof)).not.toThrow();
    expect(incoming.close).toHaveBeenCalledOnce(); expect(retained.close).not.toHaveBeenCalled();
    expect(f.output.retainedChunkCount).toBe(1); expect(f.output.retainedBytes).toBe(3840);
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'preroll' }]); f.output.destroy();
  });

  it('reports preroll once and preserves a failed close without closing the PCM twice', () => {
    const f = fixture(), data = pcm(), token = {}, failure = Error('preroll close failed');
    data.close.mockImplementation(() => { throw failure; }); f.observe();
    const proof = { ...timing(), context: { ...timing().context, presentFromSourceUs: 1_000_000n } };
    expect(() => f.output.schedule(data, 1, token, proof)).toThrow(failure);
    expect(data.close).toHaveBeenCalledOnce(); expect(f.output.retainedBytes).toBe(0);
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'preroll' }]); f.output.destroy();
  });

  it('coalesces readiness after actual ownership without observing or activating an inactive target', async () => {
    const observed: number[] = [], prepared = vi.fn(() => { observed.push(f.output.retainedChunkCount); });
    const f = fixture(3, 20_000, { onPrepared: prepared });
    f.output.schedule(pcm(), 1, {}, timing()); f.output.schedule(pcm(), 2, {}, timing());
    expect(prepared).not.toHaveBeenCalled(); expect(f.output.retainedChunkCount).toBe(2);
    await Promise.resolve(); expect(prepared).toHaveBeenCalledOnce(); expect(observed).toEqual([2]);
    await Promise.resolve(); expect(prepared).toHaveBeenCalledOnce();
    expect(f.target.schedule).not.toHaveBeenCalled(); expect(f.target.observeSchedules).not.toHaveBeenCalled();
    expect(f.target.sampleSourcePosition).not.toHaveBeenCalled(); f.output.destroy();
  });

  it('does not queue a readiness microtask when no callback was supplied', () => {
    const f = fixture(), microtask = vi.spyOn(globalThis, 'queueMicrotask');
    try { f.output.schedule(pcm(), 1, {}, timing()); expect(microtask).not.toHaveBeenCalled(); }
    finally { microtask.mockRestore(); f.output.destroy(); }
  });

  it.each(['preroll', 'budget', 'timing'] as const)('does not notify for PCM that was never retained: %s', refusal => {
    const prepared = vi.fn(), f = fixture(1, refusal === 'budget' ? 4 : 3840, { onPrepared: prepared });
    const data = pcm(), proof = refusal === 'preroll'
      ? { ...timing(), context: { ...timing().context, presentFromSourceUs: 1_000_000n } }
      : refusal === 'timing' ? null : timing();
    if (refusal === 'preroll') f.output.schedule(data, 1, {}, proof);
    else expect(() => f.output.schedule(data, 1, {}, proof)).toThrow();
    return Promise.resolve().then(() => {
      expect(prepared).not.toHaveBeenCalled(); expect(f.output.retainedChunkCount).toBe(0);
      expect(data.close).toHaveBeenCalledOnce(); f.output.destroy();
    });
  });

  it.each(['flush', 'destroy'] as const)('withdraws queued readiness before the microtask: %s', action => {
    const prepared = vi.fn(), f = fixture(1, 3840, { onPrepared: prepared }), data = pcm();
    f.output.schedule(data, 1, {}, timing()); f.output[action]();
    return Promise.resolve().then(() => {
      expect(prepared).not.toHaveBeenCalled(); expect(data.close).toHaveBeenCalledOnce();
      expect(f.output.retainedBytes).toBe(0); f.output.destroy();
    });
  });

  it('notifies only the current retained queue when a flush is followed by new admission before notification', async () => {
    const seen: bigint[] = [], f = fixture(1, 3840, { onPrepared: () => {
      seen.push(f.output.snapshotPrepared()[0]!.timing.context.sourceTimestampUs);
    } });
    f.output.schedule(pcm(), 1, {}, timing(1n)); f.output.flush();
    f.output.schedule(pcm(), 2, {}, timing(2n)); await Promise.resolve();
    expect(seen).toEqual([2n]); f.output.destroy();
  });

  it('owns notification reentry that destroys the graph without forwarding any PCM', async () => {
    const prepared = vi.fn(() => { f.output.destroy(); }), f = fixture(1, 3840, { onPrepared: prepared }), data = pcm();
    f.output.schedule(data, 1, {}, timing()); expect(prepared).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve();
    expect(prepared).toHaveBeenCalledOnce(); expect(data.close).toHaveBeenCalledOnce();
    expect(f.target.destroy).toHaveBeenCalledOnce(); expect(f.target.schedule).not.toHaveBeenCalled();
    expect(f.output.retainedBytes).toBe(0);
  });

  it.each(['throw', 'reject'] as const)('contains a readiness observer %s while retaining PCM ownership', async kind => {
    const prepared = vi.fn(() => {
      if (kind === 'throw') throw Error('prepared observer');
      return Promise.reject(Error('prepared observer'));
    }), f = fixture(1, 3840, { onPrepared: prepared }), data = pcm();
    f.output.schedule(data, 1, {}, timing()); await Promise.resolve(); await Promise.resolve();
    expect(prepared).toHaveBeenCalledOnce(); expect(f.output.retainedChunkCount).toBe(1);
    expect(data.close).not.toHaveBeenCalled(); f.output.destroy(); expect(data.close).toHaveBeenCalledOnce();
  });

  it('retains bounded PCM for declared deferred output and retries the same queue after actual activation', async () => {
    const prepared = vi.fn(), f = fixture(2, 7680, { retainDeferred: true, onPrepared: prepared });
    const first = pcm(), second = pcm(), refused = pcm(), tokens = [{}, {}, {}];
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined, configurable: true });
    Object.defineProperty(f.target, 'outputTimingDeferred', { value: true }); f.observe();
    f.output.schedule(first, 1, tokens[0], timing()); f.output.activate(); f.output.activate();
    await Promise.resolve(); expect(prepared).toHaveBeenCalledOnce();
    expect(f.output.retainedChunkCount).toBe(1); expect(first.close).not.toHaveBeenCalled();
    expect(f.output.sampleSourcePosition({})).toBeNull(); expect(f.output.playheadCaptureUs()).toBeNull();
    expect(f.output.currentPlayoutTimeUs).toBeNaN(); expect(f.target.observeSchedules).not.toHaveBeenCalled();
    f.output.schedule(second, 2, tokens[1], timing());
    expect(() => f.output.schedule(refused, 3, tokens[2], timing())).toThrow(RangeError);
    await Promise.resolve(); expect(prepared).toHaveBeenCalledTimes(2);
    expect(f.output.retainedBytes).toBe(7680); expect(refused.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ token: tokens[2], state: 'discarded', reason: 'schedule failed' }]);
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: true, configurable: true });
    f.output.activate();
    expect(vi.mocked(f.target.schedule).mock.calls.map(call => [call[0], call[1]])).toEqual([[first, 1], [second, 2]]);
    expect(first.close).toHaveBeenCalledOnce(); expect(second.close).toHaveBeenCalledOnce();
    expect(f.output.retainedBytes).toBe(0); expect(f.events).toHaveLength(1);
    f.emit(tokens[0]!, 'scheduled'); expect(f.events.at(-1)?.state).toBe('scheduled'); f.output.destroy();
  });

  it('preserves default deferred discard and suppresses readiness after activation drains that queue', async () => {
    const prepared = vi.fn(), f = fixture(1, 3840, { onPrepared: prepared }), data = pcm();
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined });
    Object.defineProperty(f.target, 'outputTimingDeferred', { value: true });
    f.output.schedule(data, 1, {}, timing()); f.output.activate(); await Promise.resolve();
    expect(prepared).not.toHaveBeenCalled(); expect(data.close).toHaveBeenCalledOnce();
    expect(f.output.retainedBytes).toBe(0); f.output.destroy();
  });

  it('still refuses an unsupported target when deferred retention is enabled', async () => {
    const prepared = vi.fn(), f = fixture(1, 3840, { retainDeferred: true, onPrepared: prepared }), data = pcm();
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined });
    f.output.schedule(data, 1, {}, timing()); expect(() => f.output.activate()).toThrow(TypeError);
    await Promise.resolve(); expect(prepared).not.toHaveBeenCalled();
    expect(data.close).toHaveBeenCalledOnce(); expect(f.output.retainedBytes).toBe(0); f.output.destroy();
  });
});

describe('FrameAudioOutput observations and lifecycle', () => {
  it('relays only actual target evidence, including inline events and later terminals', () => {
    const f = fixture(), token = {}, proof = timing(), data = pcm();
    f.observe(); f.output.schedule(data, 1, token, proof);
    f.emit(token, 'scheduled'); expect(f.events).toEqual([]);
    vi.mocked(f.target.schedule).mockImplementation(chunk => {
      f.emit(token, 'scheduled'); (chunk as ReturnType<typeof pcm>).close();
    });
    f.output.activate();
    f.emit({}, 'scheduled'); f.emit(token, 'released'); f.emit(token, 'released');
    expect(f.events).toEqual([{ token, state: 'scheduled', reason: null }, { token, state: 'released', reason: null }]);
    f.output.destroy();
  });

  it('copies per listener, respects unsubscription/reentry and owns observer rejections', async () => {
    const f = fixture(), token = {}, later = vi.fn();
    let offLater = () => {};
    f.output.observeSchedules(event => {
      (event as { reason: string | null }).reason = 'changed'; offLater();
      return Promise.reject(Error('observer rejection'));
    });
    offLater = f.output.observeSchedules(later);
    f.observe(); f.output.schedule(pcm(), 1, token, timing()); f.output.activate();
    f.emit(token, 'scheduled'); f.emit(token, 'released'); await Promise.resolve();
    expect(later).not.toHaveBeenCalled();
    expect(f.events.map(event => event.reason)).toEqual([null, null]);
    f.output.destroy();
  });

  it('does not continue stale scheduled notification after its first observer flushes', () => {
    const f = fixture(), token = {};
    f.output.observeSchedules(event => { if (event.state === 'scheduled') f.output.flush(); });
    f.observe();
    vi.mocked(f.target.flush).mockImplementation(() => { f.emit(token, 'discarded', 'flushed'); });
    f.output.schedule(pcm(), 1, token, timing()); f.output.activate(); f.emit(token, 'scheduled');
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'flushed' }]); f.output.destroy();
  });

  it('flushes all queued data before the target and keeps exact timing for later schedules', () => {
    const f = fixture(), token = {}, data = pcm(), proof = timing();
    f.observe(); f.output.schedule(data, 1, token, proof);
    vi.mocked(f.target.flush).mockImplementation(() => {
      expect(data.close).toHaveBeenCalledOnce(); expect(f.output.retainedChunkCount).toBe(0);
    });
    f.output.flush();
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'flushed' }]);
    f.output.schedule(pcm(), 2, undefined, proof); f.output.activate();
    expect(vi.mocked(f.target.schedule).mock.calls[0]!.slice(1)).toEqual([2, undefined, proof]);
    f.output.destroy();
  });

  it('cleans every owned PCM and destroys the target once despite close/off/target errors and reentry', () => {
    const f = fixture(), first = pcm(), second = pcm(), failure = Error('close failed');
    const offFailure = Error('off failed');
    vi.mocked(f.target.observeSchedules!).mockImplementation(observer => {
      f.listeners.add(observer); return () => { f.listeners.delete(observer); throw offFailure; };
    });
    f.observe(); f.output.activate();
    // A target-owned source is never closed by wrapper cleanup.
    f.output.schedule(pcm(), 0, {}, timing());
    const g = fixture(); g.observe();
    first.close.mockImplementation(() => { g.output.destroy(); throw failure; });
    g.output.schedule(first, 1, {}, timing()); g.output.schedule(second, 2, {}, timing());
    expect(() => g.output.destroy()).toThrow(failure);
    expect(second.close).toHaveBeenCalledOnce(); expect(g.target.destroy).toHaveBeenCalledOnce();
    expect(g.output.retainedBytes).toBe(0); expect(() => g.output.destroy()).not.toThrow();
    const targetFailure = Error('target failed');
    vi.mocked(f.target.destroy).mockImplementation(() => { throw targetFailure; });
    expect(() => f.output.destroy()).toThrow(targetFailure);
    expect(f.target.destroy).toHaveBeenCalledOnce();
    expect(() => f.output.destroy()).not.toThrow();
  });

  it('prevents stale continuation after an inline target event destroys the wrapper', () => {
    const f = fixture(), a = pcm(), b = pcm(), first = {}, second = {};
    f.output.observeSchedules(event => { if (event.state === 'scheduled') f.output.destroy(); });
    f.observe(); f.output.schedule(a, 1, first, timing()); f.output.schedule(b, 2, second, timing());
    vi.mocked(f.target.schedule).mockImplementation(data => {
      f.emit(first, 'scheduled'); (data as ReturnType<typeof pcm>).close();
    });
    f.output.activate();
    expect(f.target.schedule).toHaveBeenCalledOnce();
    expect(a.close).toHaveBeenCalledOnce(); expect(b.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ token: second, state: 'discarded', reason: 'destroyed' }]);
    const late = pcm(); expect(() => f.output.schedule(late, 3, {}, timing())).toThrow();
    expect(late.close).toHaveBeenCalledOnce(); expect(f.target.destroy).toHaveBeenCalledOnce();
  });

  it('forwards native position identity/rate only when active and still explicitly capable', () => {
    const f = fixture(), epoch = {};
    f.output.setPlaybackRate(1.25); expect(f.target.setPlaybackRate).not.toHaveBeenCalled();
    expect(f.output.sampleSourcePosition(epoch)).toBeNull();
    f.output.activate(); expect(f.target.setPlaybackRate).toHaveBeenCalledExactlyOnceWith(1.25);
    const sample = f.output.sampleSourcePosition(epoch);
    expect(sample).toEqual({ epoch, sourceTimestampUs: 9n, sourceOffsetUs: 0.5 });
    expect(f.target.sampleSourcePosition).toHaveBeenCalledExactlyOnceWith(epoch);
    expect(f.output.currentPlayoutTimeUs).toBe(123_000); expect(f.output.playheadCaptureUs()).toBe(321_000);
    Object.defineProperty(f.target, 'supportsOutputTiming', { value: undefined });
    expect(f.output.sampleSourcePosition(epoch)).toBeNull(); expect(f.output.currentPlayoutTimeUs).toBeNaN();
    expect(f.output.playheadCaptureUs()).toBeNull(); f.output.destroy();
  });

  it('rejects native read results or schedule getters that retire the wrapper reentrantly', () => {
    const f = fixture(); f.output.activate();
    vi.mocked(f.target.sampleSourcePosition!).mockImplementation(epoch => {
      f.output.destroy(); return { epoch, sourceTimestampUs: 1n, sourceOffsetUs: 0 };
    });
    expect(f.output.sampleSourcePosition({})).toBeNull();
    const g = fixture(), data = pcm(); g.output.schedule(data, 1, {}, timing());
    Object.defineProperty(g.target, 'schedule', { get() { g.output.destroy(); return vi.fn(); } });
    g.output.activate();
    expect(data.close).toHaveBeenCalledOnce(); expect(g.target.destroy).toHaveBeenCalledOnce();
  });

  it('still closes queued PCM when target observer detachment throws during reentrant destruction', () => {
    const f = fixture(), chunks = [pcm(), pcm()], failure = Error('observer detach');
    vi.mocked(f.target.observeSchedules!).mockImplementation(() => () => { throw failure; });
    f.observe(); chunks.forEach(chunk => f.output.schedule(chunk, 1, {}, timing()));
    Object.defineProperty(f.target, 'schedule', { get() { f.output.destroy(); return vi.fn(); } });
    expect(() => f.output.activate()).toThrow(failure);
    expect(chunks.every(chunk => chunk.close.mock.calls.length === 1)).toBe(true);
    expect(f.events).toHaveLength(2);
    expect(f.output.retainedChunkCount).toBe(0); expect(f.target.destroy).toHaveBeenCalledOnce();
  });

  it('keeps repeated diagnostic tokens owned for each actual target schedule', () => {
    const f = fixture(), token = {};
    f.observe(); f.output.schedule(pcm(), 1, token, timing()); f.output.schedule(pcm(), 2, token, timing());
    f.output.activate();
    f.emit(token, 'scheduled'); f.emit(token, 'scheduled');
    f.emit(token, 'released'); f.emit(token, 'released'); f.emit(token, 'released');
    expect(f.events.map(event => event.state)).toEqual(['scheduled', 'scheduled', 'released', 'released']);
    f.output.destroy();
  });

  it('honors a reentrant flush of target-owned PCM during retained-entry failure cleanup', () => {
    const f = fixture(), first = {}, second = {}, failure = Error('native partial failure');
    f.output.observeSchedules(event => {
      if (event.token === second && event.state === 'discarded') f.output.flush();
    });
    f.observe(); f.output.schedule(pcm(), 1, first, timing()); f.output.schedule(pcm(), 2, second, timing());
    vi.mocked(f.target.schedule).mockImplementation(data => {
      (data as ReturnType<typeof pcm>).close(); f.emit(first, 'scheduled'); throw failure;
    });
    vi.mocked(f.target.flush).mockImplementation(() => { f.emit(first, 'discarded', 'flushed'); });
    expect(() => f.output.activate()).toThrow(failure);
    expect(f.target.flush).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual({ token: first, state: 'discarded', reason: 'flushed' });
    expect(f.output.retainedChunkCount).toBe(0); f.output.destroy();
  });

  it('does not call a stale flush method after its getter destroys the output', () => {
    const f = fixture(), staleFlush = vi.fn(), data = pcm();
    f.output.schedule(data, 1, {}, timing());
    Object.defineProperty(f.target, 'flush', { get() { f.output.destroy(); return staleFlush; } });
    f.output.flush();
    expect(staleFlush).not.toHaveBeenCalled();
    expect(data.close).toHaveBeenCalledOnce(); expect(f.target.destroy).toHaveBeenCalledOnce();
  });

  it('relays the actual native destroy terminal after retiring scheduling and head authority', () => {
    const f = fixture(), data = pcm(), token = {}, epoch = {};
    f.observe();
    vi.mocked(f.target.schedule).mockImplementation(chunk => {
      (chunk as ReturnType<typeof pcm>).close(); f.emit(token, 'scheduled');
    });
    f.output.schedule(data, 1, token, timing()); f.output.activate();
    expect(f.events).toEqual([{ token, state: 'scheduled', reason: null }]);
    vi.mocked(f.target.destroy).mockImplementation(() => {
      expect(f.output.retainedChunkCount).toBe(0);
      expect(f.output.sampleSourcePosition(epoch)).toBeNull();
      expect(f.output.playheadCaptureUs()).toBeNull(); expect(f.output.currentPlayoutTimeUs).toBeNaN();
      f.output.activate(); f.output.setPlaybackRate(1.25);
      const incoming = pcm();
      expect(() => f.output.schedule(incoming, 2, undefined, timing())).toThrow();
      expect(incoming.close).toHaveBeenCalledOnce();
      f.emit(token, 'scheduled');
      f.emit(token, 'discarded', 'destroyed'); f.emit(token, 'released');
    });
    f.output.destroy();
    expect(f.events).toEqual([{ token, state: 'scheduled', reason: null }, { token, state: 'discarded', reason: 'destroyed' }]);
    expect(f.target.schedule).toHaveBeenCalledOnce(); expect(f.target.setPlaybackRate).not.toHaveBeenCalled();
    expect(data.close).toHaveBeenCalledOnce(); expect(f.target.destroy).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0); f.output.destroy();
    expect(f.target.destroy).toHaveBeenCalledOnce();
  });

  it('relays the healthy native flush terminal and admits later PCM', () => {
    const f = fixture(), first = {}, second = {};
    f.observe();
    vi.mocked(f.target.schedule).mockImplementation((data, _time, token) => {
      (data as ReturnType<typeof pcm>).close(); if (token) f.emit(token, 'scheduled');
    });
    vi.mocked(f.target.flush).mockImplementation(() => { f.emit(first, 'discarded', 'flushed'); });
    f.output.schedule(pcm(), 1, first, timing()); f.output.activate(); f.output.flush();
    f.output.schedule(pcm(), 2, second, timing()); f.emit(second, 'released');
    expect(f.events).toEqual([
      { token: first, state: 'scheduled', reason: null }, { token: first, state: 'discarded', reason: 'flushed' },
      { token: second, state: 'scheduled', reason: null }, { token: second, state: 'released', reason: null },
    ]);
    expect(f.target.schedule).toHaveBeenCalledTimes(2); f.output.destroy();
  });

  it('releases observation once when native retirement callbacks reenter cleanup and unsubscribe', () => {
    const f = fixture(), token = {}, events: AudioScheduleObservation[] = [], detached = vi.fn();
    vi.mocked(f.target.observeSchedules!).mockImplementation(observer => {
      f.listeners.add(observer);
      return () => { detached(); f.listeners.delete(observer); };
    });
    let release = () => {};
    release = f.output.observeSchedules(event => {
      events.push(event);
      if (event.state === 'discarded') { f.output.destroy(); release(); }
    });
    vi.mocked(f.target.schedule).mockImplementation(data => {
      (data as ReturnType<typeof pcm>).close(); f.emit(token, 'scheduled');
    });
    vi.mocked(f.target.destroy).mockImplementation(() => { f.emit(token, 'discarded', 'destroyed'); });
    f.output.schedule(pcm(), 1, token, timing()); f.output.activate(); f.output.destroy();
    expect(events.map(event => event.state)).toEqual(['scheduled', 'discarded']);
    expect(detached).toHaveBeenCalledOnce(); expect(f.target.destroy).toHaveBeenCalledOnce();
    release(); expect(detached).toHaveBeenCalledOnce();
  });

  it('ignores saved target callbacks after destroy returns even for an outstanding forwarded token', async () => {
    const f = fixture(), token = {};
    f.observe(); f.output.schedule(pcm(), 1, token, timing()); f.output.activate();
    const saved = [...f.listeners][0]!;
    f.emit(token, 'scheduled'); f.output.destroy();
    saved({ token, state: 'discarded', reason: 'destroyed' });
    await Promise.resolve().then(() => saved({ token, state: 'released', reason: null }));
    expect(f.events).toEqual([{ token, state: 'scheduled', reason: null }]);
    expect(f.listeners.size).toBe(0); expect(f.target.destroy).toHaveBeenCalledOnce();
  });
});
