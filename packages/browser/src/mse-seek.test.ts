import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAppendObservation, MediaSeekResource } from '@openmoq/player';
import { MseMediaSource } from './mse-adapter.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';

// Native lifecycle controls, not a decoder or a model of seek landing policy.
class SeekVideo extends MockVideoElement {
  override load(): void {
    this.advancePlayback(0); this.seeking = false; this.readyState = 0;
    this.buffered = makeTimeRanges([]); this.error = null;
  }
  override removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
}

const config = { video: { codec: 'avc1.640028', initData: buildInit({
  trackId: 1, timescale: 1000, handler: 'vide',
}) } };
const chunk = (time: number) => buildChunk({ trackId: 1, bmdt: BigInt(time * 1000),
  samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let sources: MockMediaSource[], attachments: Map<object, string>, revoked: string[];
const adapters: MseMediaSource[] = [];
beforeEach(() => {
  vi.useFakeTimers(); sources = []; attachments = new Map(); revoked = [];
  vi.stubGlobal('MediaSource', class extends MockMediaSource {
    constructor() { super(); sources.push(this); }
    override addSourceBuffer(type: string) {
      if (this.readyState !== 'open') throw new DOMException('MediaSource is closed', 'InvalidStateError');
      return super.addSourceBuffer(type);
    }
  });
  vi.stubGlobal('URL', {
    createObjectURL: (source: object) => {
      const url = `blob:seek-${attachments.size}`; attachments.set(source, url); return url;
    },
    revokeObjectURL: (url: string) => { revoked.push(url); },
  });
});
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.destroy();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

function fixture(options: { stallThresholdMs?: number } = {}) {
  const video = new SeekVideo(); video.paused = true;
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement,
    { reorderWindowMs: 0, maxAheadSec: Infinity, ...options });
  adapters.push(adapter);
  return { video, adapter };
}
async function initialized(resource: MediaSeekResource) {
  const source = sources.at(-1)!;
  expect(resource.initialize(config)).toBe(true);
  source.open(); await settle();
  return source;
}
function coverage(video: SeekVideo, source: MockMediaSource, start = 0, end = 10) {
  video.buffered = source.videoBuffer.buffered = makeTimeRanges([[start, end]]);
  video.readyState = 2;
}
async function playing(adapter: MseMediaSource, video: SeekVideo) {
  const resource = adapter.beginSeek({}); const source = await initialized(resource);
  coverage(video, source); await resource.position(0);
  resource.setPlaybackIntent(true); await settle();
  expect(video.paused).toBe(false); video.fire('playing');
  return resource;
}

describe('owned native MSE seek resource', () => {
  it('waits for the owned SourceBuffers instead of treating initialize acceptance as attachment', async () => {
    const { adapter } = fixture(), resource = adapter.beginSeek({});
    await expect(resource.whenAttached()).rejects.toMatchObject({ name: 'InvalidStateError' });
    expect(resource.initialize(config)).toBe(true);
    const ready = vi.fn(); const waiting = resource.whenAttached().then(ready);
    await settle(); expect(ready).not.toHaveBeenCalled();
    const native = sources.at(-1)!; native.open(); await waiting;
    expect(native.videoBuffer).toBeDefined(); expect(ready).toHaveBeenCalledOnce();
    await expect(resource.whenAttached()).resolves.toBeUndefined();
  });

  it.each(['cancel', 'reset', 'destroy', 'successor'] as const)('rejects a pending attachment on %s and ignores late sourceopen', async action => {
    const { adapter } = fixture(), resource = adapter.beginSeek({});
    resource.initialize(config); const native = sources.at(-1)!;
    const waiting = expect(resource.whenAttached()).rejects.toMatchObject({ name: 'AbortError' });
    if (action === 'cancel') resource.cancel();
    else if (action === 'reset') adapter.reset();
    else if (action === 'destroy') adapter.destroy();
    else adapter.beginSeek({});
    await waiting; native.open();
    expect(native.addSourceBufferCalls).toEqual([]);
    await expect(resource.whenAttached()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a pending attachment when an external DOM owner replaces the source before sourceopen', async () => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    resource.initialize(config); const native = sources.at(-1)!;
    const waiting = expect(resource.whenAttached()).rejects.toMatchObject({ name: 'AbortError' });
    video.src = 'https://application.example/replacement.mp4'; native.open(); await waiting;
    expect(resource.current).toBe(false);
    expect(video.src).toBe('https://application.example/replacement.mp4');
  });

  it('accepts corrected initialization after validation refusal without inheriting its readiness failure', async () => {
    const { adapter } = fixture(), resource = adapter.beginSeek({}); adapter.onError = vi.fn();
    expect(resource.initialize({ video: { codec: config.video.codec, initData: new Uint8Array() } })).toBe(false);
    await expect(resource.whenAttached()).rejects.toThrow(/refused/);
    expect(resource.initialize(config)).toBe(true);
    const waiting = resource.whenAttached(); sources.at(-1)!.open();
    await expect(waiting).resolves.toBeUndefined(); expect(resource.current).toBe(true);
  });

  it('does not let an outer validation refusal poison corrected initialization started inside its error callback', async () => {
    const { adapter } = fixture(), resource = adapter.beginSeek({});
    adapter.onError = () => { expect(resource.initialize(config)).toBe(true); };
    expect(resource.initialize({ video: { codec: config.video.codec, initData: new Uint8Array() } })).toBe(false);
    const waiting = resource.whenAttached(); sources.at(-1)!.open();
    await expect(waiting).resolves.toBeUndefined();
  });

  it('rejects a detached queued sourceopen before native work or obsolete error publication', async () => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    adapter.onError = vi.fn(); adapter.onAttached = vi.fn(); resource.initialize(config);
    const native = sources.at(-1)!, create = vi.spyOn(native, 'addSourceBuffer');
    const waiting = expect(resource.whenAttached()).rejects.toMatchObject({ name: 'AbortError' });
    native.readyState = 'open'; video.src = 'blob:external'; native.readyState = 'closed'; native.fire('sourceopen');
    await waiting; expect(create).not.toHaveBeenCalled();
    expect(adapter.onError).not.toHaveBeenCalled(); expect(adapter.onAttached).not.toHaveBeenCalled();
    expect(video.src).toBe('blob:external');
  });

  it('does not strand attachment readiness when an onAttached observer throws after the buffers exist', async () => {
    const { adapter } = fixture(), resource = adapter.beginSeek({});
    adapter.onError = vi.fn(); adapter.onAttached = () => { throw new Error('observer failed'); };
    resource.initialize(config); const waiting = resource.whenAttached(); sources.at(-1)!.open();
    await expect(waiting).resolves.toBeUndefined(); await expect(resource.whenAttached()).resolves.toBeUndefined();
    expect(adapter.onError).toHaveBeenCalledOnce();
  });

  it('rejects attachment when native initialization fails rather than stranding the accepted FETCH input', async () => {
    const { adapter } = fixture(), resource = adapter.beginSeek({});
    const errors: Error[] = []; adapter.onError = error => { errors.push(error); };
    resource.initialize(config); const native = sources.at(-1)!;
    vi.spyOn(native, 'addSourceBuffer').mockImplementation(() => { throw new Error('native codec initialization failed'); });
    const waiting = expect(resource.whenAttached()).rejects.toThrow(/native codec initialization failed/);
    native.open(); await waiting;
    expect(errors).toHaveLength(1);
    await expect(resource.whenAttached()).rejects.toThrow(/native codec initialization failed/);
  });

  it('replaces an updating resource and retires queued/in-flight append tokens once', async () => {
    const { adapter, video } = fixture();
    adapter.setPlaybackIntent(false);
    adapter.initialize(config); const old = sources[0]!; old.open(); await settle();
    const outcomes: MediaAppendObservation[] = [];
    adapter.observeAppends(event => { outcomes.push(event); });
    const first = {}, second = {};
    old.videoBuffer.autoComplete = false;
    adapter.appendChunk('video', chunk(0), 'v', 1n, first);
    adapter.appendChunk('video', chunk(1), 'v', 2n, second);
    expect(old.videoBuffer.updating).toBe(true);
    const oldUrl = video.src;
    const resource = adapter.beginSeek({});
    expect(sources).toHaveLength(2);
    expect(video.src).not.toBe(oldUrl);
    expect(revoked).toContain(oldUrl);
    expect(outcomes).toEqual([first, second].map(token => ({ token, state: 'discarded', reason: 'decoder reset' })));
    const native = await initialized(resource);
    old.videoBuffer.fire('error'); old.videoBuffer.fire('abort');
    old.videoBuffer.updating = false; old.videoBuffer.fire('update'); old.videoBuffer.fire('updateend');
    expect(outcomes).toHaveLength(2);
    expect(native.videoBuffer.appendedPayloads).toHaveLength(1);
    expect(video.playCalls).toBe(0);
  });

  it('ignores old sourceopen and does not autoplay from new initialization/appends', async () => {
    const { adapter, video } = fixture();
    adapter.initialize(config); const old = sources[0]!;
    const resource = adapter.beginSeek({});
    old.open(); expect(old.addSourceBufferCalls).toEqual([]);
    const native = await initialized(resource);
    coverage(video, native);
    resource.appendChunk('video', chunk(0), 'v', 1n); await settle();
    expect(video.playCalls).toBe(0);
    expect(video.paused).toBe(true);
    expect(() => resource.setPlaybackIntent(true)).toThrow();
  });

  it('positions an already-ready fresh zero without a native seeked event', async () => {
    const { adapter, video } = fixture();
    const epoch = {}, resource = adapter.beginSeek(epoch);
    const native = await initialized(resource); coverage(video, native);
    expect(resource.sample()).toBeNull();
    expect(await resource.position(0)).toEqual({ epoch, resource: resource.resource,
      currentTime: 0, buffered: { start: 0, end: 10 }, paused: true });
    expect(video.seekCount).toBe(0); expect(video.playCalls).toBe(0);
    resource.setPlaybackIntent(true); await settle();
    expect(video.playCalls).toBe(1);
    resource.setPlaybackIntent(false); expect(video.paused).toBe(true);
  });

  it('requires native seek completion, not official-time assignment or ordinary clock movement', async () => {
    const { adapter, video } = fixture();
    const resource = adapter.beginSeek({}); const native = await initialized(resource); coverage(video, native);
    video.modelSeekLifecycle = true; video.autoFireSeeked = false;
    const firstFrame = vi.fn(); adapter.onFirstFrame = firstFrame;
    const result = resource.position(5); const settled = vi.fn(); void result.then(settled);
    expect(video.currentTime).toBe(5); expect(resource.sample()).toBeNull();
    video.seeking = false; video.advancePlayback(5.01); video.fire('timeupdate'); await settle();
    expect(settled).not.toHaveBeenCalled(); expect(resource.sample()).toBeNull();
    expect(firstFrame).not.toHaveBeenCalled();
    video.fire('seeked');
    expect((await result).currentTime).toBe(5.01);
    expect(resource.sample()?.currentTime).toBe(5.01);
    expect(video.playCalls).toBe(0);
  });

  it('returns an actual supported fractional position and an in-buffer native clamp', async () => {
    const { adapter, video } = fixture();
    const resource = adapter.beginSeek({}); const native = await initialized(resource); coverage(video, native);
    video.modelSeekLifecycle = true; video.autoFireSeeked = false;
    const fractional = resource.position(1 / 3);
    video.advancePlayback(0.333); video.seeking = false; video.fire('seeked');
    expect((await fractional).currentTime).toBe(0.333);
    const clamped = resource.position(100);
    video.advancePlayback(10); video.seeking = false; video.fire('seeked');
    expect((await clamped).currentTime).toBe(10); // Engine decides target acceptability.
  });

  it('fails an uncovered native landing on the bounded policy deadline', async () => {
    const { adapter, video } = fixture();
    const resource = adapter.beginSeek({}); const native = await initialized(resource); coverage(video, native, 0, 1);
    video.modelSeekLifecycle = true; video.autoFireSeeked = false;
    const result = resource.position(5); const rejection = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    video.advancePlayback(20); video.seeking = false; video.fire('seeked');
    await vi.advanceTimersByTimeAsync(2000); await rejection;
    expect(resource.sample()).toBeNull(); expect(video.playCalls).toBe(0);
  });

  it('supersedes positioning within one resource and rejects late work from a replaced resource', async () => {
    const { adapter, video } = fixture();
    const first = adapter.beginSeek({}); let native = await initialized(first); coverage(video, native);
    video.modelSeekLifecycle = true; video.autoFireSeeked = false;
    const oldPosition = first.position(2); const oldRejection = expect(oldPosition).rejects.toMatchObject({ name: 'AbortError' });
    const nextPosition = first.position(3); const nextRejection = expect(nextPosition).rejects.toMatchObject({ name: 'AbortError' });
    await oldRejection;
    const second = adapter.beginSeek({}); await nextRejection;
    native = await initialized(second); coverage(video, native);
    await second.position(0);
    const url = video.src;
    first.cancel(); video.fire('seeked');
    expect(first.current).toBe(false); expect(first.sample()).toBeNull();
    expect(second.current).toBe(true); expect(video.src).toBe(url);
    expect(second.sample()?.currentTime).toBe(0);
    expect(() => first.initialize(config)).toThrowError(expect.objectContaining({ name: 'AbortError' }));
  });

  it('cancel and reset retire owned appends and positioning without affecting a successor', async () => {
    const { adapter, video } = fixture(); const first = adapter.beginSeek({});
    const native = await initialized(first); coverage(video, native);
    const outcomes: MediaAppendObservation[] = []; first.observeAppends(event => { outcomes.push(event); });
    native.videoBuffer.autoComplete = false;
    const token = {}; first.appendChunk('video', chunk(0), 'v', 1n, token);
    video.modelSeekLifecycle = true; video.autoFireSeeked = false;
    const pending = first.position(2); const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    adapter.reset(); await rejection;
    expect(first.current).toBe(false);
    expect(outcomes).toEqual([{ token, state: 'discarded', reason: 'decoder reset' }]);
    const second = adapter.beginSeek({}); await initialized(second);
    const url = video.src; first.cancel(); expect(video.src).toBe(url); expect(second.current).toBe(true);
    second.cancel(); second.cancel(); expect(second.current).toBe(false);
    expect(video.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['setter', 'native error', 'read error'] as const)('fails closed on %s', async failure => {
    const { adapter, video } = fixture(); const resource = adapter.beginSeek({});
    const native = await initialized(resource); coverage(video, native);
    video.modelSeekLifecycle = true; video.autoFireSeeked = false;
    if (failure === 'setter') video.throwOnSeek = new Error('native setter failed');
    const pending = resource.position(2);
    const rejection = expect(pending).rejects.toBeInstanceOf(Error);
    if (failure === 'native error') video.setError(3, 'decode failed');
    if (failure === 'read error') {
      Object.defineProperty(video, 'buffered', { configurable: true,
        get: () => { throw new Error('detached'); }, set: () => {} });
      video.seeking = false; video.fire('seeked');
      await vi.advanceTimersByTimeAsync(2000);
    }
    await rejection; expect(resource.sample()).toBeNull(); expect(video.playCalls).toBe(0);
  });

  it('lets a callback replace the resource during retirement without clobbering its successor', async () => {
    const { adapter, video } = fixture(); adapter.setPlaybackIntent(false);
    adapter.initialize(config); sources[0]!.open(); await settle();
    sources[0]!.videoBuffer.autoComplete = false;
    let successor: MediaSeekResource | undefined;
    adapter.observeAppends(() => { successor ??= adapter.beginSeek({}); });
    adapter.appendChunk('video', chunk(0), 'v', 1n, {});
    expect(() => adapter.beginSeek({})).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(successor?.current).toBe(true);
    expect(video.src).toBe(attachments.get(sources.at(-1)!));
    await initialized(successor!);
    expect(successor?.current).toBe(true);
  });

  it('refuses resource samples after an external attachment change or reentrant native read', async () => {
    const { adapter, video } = fixture(); const resource = adapter.beginSeek({});
    const native = await initialized(resource); coverage(video, native); await resource.position(0);
    video.src = 'blob:someone-else'; expect(resource.current).toBe(false); expect(resource.sample()).toBeNull();
    video.src = attachments.get(native)!;
    let successor: MediaSeekResource | undefined;
    Object.defineProperty(video, 'buffered', { configurable: true, get: () => {
      successor ??= adapter.beginSeek({}); return makeTimeRanges([[0, 10]]);
    }, set: () => {} });
    expect(resource.sample()).toBeNull(); expect(successor?.current).toBe(true);
  });

  it('ignores a stale native error event without an error on the current resource', async () => {
    const { adapter, video } = fixture(); const first = adapter.beginSeek({});
    await initialized(first); const errors = vi.fn(); adapter.onError = errors;
    const successor = adapter.beginSeek({}); const native = await initialized(successor); coverage(video, native);
    video.fire('error');
    expect(errors).not.toHaveBeenCalled();
    await successor.position(0);
    expect(successor.sample()?.currentTime).toBe(0);
  });

  it('preserves managed attachment, media element and element-scoped DRM configuration', async () => {
    vi.stubGlobal('ManagedMediaSource', class extends MockMediaSource {
      constructor() { super(); sources.push(this); }
    });
    const { adapter, video } = fixture(); adapter.setPlaybackIntent(false);
    const keys = {}; Object.assign(video, { mediaKeys: keys });
    const resource = adapter.beginSeek({}); const native = await initialized(resource); coverage(video, native);
    await resource.position(0);
    expect(adapter.selectedImplementation).toBe('managed'); expect(adapter.selectedAttachment).toBe('src-object');
    expect(adapter.mediaElement).toBe(video); expect(video.srcObject).toBe(native);
    expect((video as unknown as { mediaKeys: object }).mediaKeys).toBe(keys);
    expect(video.paused).toBe(true); expect(video.playCalls).toBe(0);
  });

  it('preserves an external attachment installed by a terminal append observer during cancel', async () => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    const native = await initialized(resource), ownedUrl = video.src;
    const outcome = vi.fn(() => { video.src = 'blob:external'; video.advancePlayback(7); });
    const detach = resource.observeAppends(outcome);
    native.videoBuffer.autoComplete = false;
    const token = {}; resource.appendChunk('video', chunk(0), 'v', 1n, token);
    expect(native.videoBuffer.updating).toBe(true);
    const pause = vi.spyOn(video, 'pause'), load = vi.spyOn(video, 'load');
    resource.cancel();
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ token, state: 'discarded', reason: 'decoder reset' });
    detach();
    expect(video.src).toBe('blob:external'); expect(video.currentTime).toBe(7);
    expect(pause).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    expect(revoked).toContain(ownedUrl); expect(revoked).not.toContain('blob:external');
  });

  it('preserves an external attachment installed before cancel', async () => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    await initialized(resource); video.src = 'blob:external';
    const pause = vi.spyOn(video, 'pause'), load = vi.spyOn(video, 'load');
    expect(resource.current).toBe(false); resource.cancel();
    expect(video.src).toBe('blob:external');
    expect(pause).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
  });

  it('aborts beginSeek when an old append observer installs an external attachment', async () => {
    const { adapter, video } = fixture(); adapter.setPlaybackIntent(false);
    adapter.initialize(config); const native = sources[0]!; native.open(); await settle();
    const ownedUrl = video.src;
    native.videoBuffer.autoComplete = false;
    const outcome = vi.fn(() => { video.src = 'blob:external'; video.advancePlayback(7); });
    const detach = adapter.observeAppends(outcome);
    const token = {}; adapter.appendChunk('video', chunk(0), 'v', 1n, token);
    const pause = vi.spyOn(video, 'pause'), load = vi.spyOn(video, 'load');
    expect(() => adapter.beginSeek({})).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ token, state: 'discarded', reason: 'decoder reset' });
    detach();
    expect(video.src).toBe('blob:external'); expect(video.currentTime).toBe(7);
    expect(pause).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    expect(revoked).toContain(ownedUrl); expect(revoked).not.toContain('blob:external');
  });

  it('still begins a fresh resource when terminal append observation leaves the attachment intact', async () => {
    const { adapter, video } = fixture(); adapter.setPlaybackIntent(false);
    adapter.initialize(config); const native = sources[0]!; native.open(); await settle();
    native.videoBuffer.autoComplete = false;
    const outcome = vi.fn(), detach = adapter.observeAppends(outcome);
    const token = {}; adapter.appendChunk('video', chunk(0), 'v', 1n, token);
    const resource = adapter.beginSeek({});
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ token, state: 'discarded', reason: 'decoder reset' });
    detach();
    expect(resource.current).toBe(true); expect(video.paused).toBe(true);
    await initialized(resource); expect(resource.current).toBe(true);
  });

  it('retires an old stall timer before preparing a new paused seek resource', async () => {
    const { adapter, video } = fixture({ stallThresholdMs: 100 });
    const stalled = vi.fn(); adapter.onStall = stalled;
    await playing(adapter, video); video.fire('waiting');
    await vi.advanceTimersByTimeAsync(50);
    const resource = adapter.beginSeek({});
    expect(resource.current).toBe(true); expect(video.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(51);
    expect(stalled).not.toHaveBeenCalled();
  });

  it('does not recover an already-detected old stall when the new seek resource plays', async () => {
    const { adapter, video } = fixture({ stallThresholdMs: 100 });
    const stalled = vi.fn(), recovered = vi.fn();
    adapter.onStall = stalled; adapter.onStallRecovered = recovered;
    await playing(adapter, video); video.fire('waiting');
    await vi.advanceTimersByTimeAsync(101);
    expect(stalled).toHaveBeenCalledExactlyOnceWith(100);
    await playing(adapter, video);
    expect(stalled).toHaveBeenCalledOnce(); expect(recovered).not.toHaveBeenCalled();
  });

  it('still detects and recovers one uninterrupted native stall', async () => {
    const { adapter, video } = fixture({ stallThresholdMs: 100 });
    const stalled = vi.fn(), recovered = vi.fn();
    adapter.onStall = stalled; adapter.onStallRecovered = recovered;
    await playing(adapter, video); video.fire('waiting');
    await vi.advanceTimersByTimeAsync(101);
    expect(stalled).toHaveBeenCalledExactlyOnceWith(100);
    await vi.advanceTimersByTimeAsync(300); video.fire('playing');
    expect(stalled).toHaveBeenCalledOnce(); expect(recovered).toHaveBeenCalledExactlyOnceWith(401);
  });
});


describe('native playback state on an owned seek sample', () => {
  it.each([[true, 0.5], [false, 1.5], [false, 0], [false, -1]] as const)(
    'reports actual pause=%s and rate=%s without changing playback', async (paused, playbackRate) => {
      const { adapter, video } = fixture(), resource = adapter.beginSeek({});
      const native = await initialized(resource); coverage(video, native); await resource.position(0);
      Object.assign(video, { paused, playbackRate }); video.advancePlayback(2);
      expect(resource.sample()).toMatchObject({ currentTime: 2, paused, playbackRate });
      expect(video.playCalls).toBe(0); expect(resource.current).toBe(true);
    });

  it('resamples native playback changes on the same positioned resource', async () => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    const native = await initialized(resource); coverage(video, native); await resource.position(0);
    const sourceCount = sources.length;
    Object.assign(video, { paused: true, playbackRate: 0.75 });
    expect(resource.sample()).toMatchObject({ paused: true, playbackRate: 0.75 });
    Object.assign(video, { paused: false, playbackRate: 2 }); video.advancePlayback(3);
    expect(resource.sample()).toMatchObject({ currentTime: 3, paused: false, playbackRate: 2 });
    expect(sources).toHaveLength(sourceCount); expect(video.playCalls).toBe(0);
  });

  it.each(['paused', 'playbackRate'] as const)('keeps clock evidence when optional %s observation throws', async key => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    const native = await initialized(resource); coverage(video, native); await resource.position(0);
    Object.assign(video, { paused: true, playbackRate: 1.25 }); video.advancePlayback(2);
    Object.defineProperty(video, key, { configurable: true, get() { throw new Error('optional native getter unavailable'); }, set() {} });
    const sample = resource.sample();
    expect(sample).toMatchObject({ currentTime: 2, buffered: { start: 0, end: 10 } });
    expect(Object.hasOwn(sample!, key)).toBe(false);
    expect(sample).toMatchObject(key === 'paused' ? { playbackRate: 1.25 } : { paused: true });
  });

  it.each([NaN, Infinity, undefined, 'fast'])('omits an unobservable native rate %s without inventing 1x', async playbackRate => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    const native = await initialized(resource); coverage(video, native); await resource.position(0);
    Object.assign(video, { paused: false, playbackRate });
    const sample = resource.sample(); expect(sample).toMatchObject({ currentTime: 0, paused: false });
    expect(Object.hasOwn(sample!, 'playbackRate')).toBe(false);
  });

  it.each(['paused', 'playbackRate'] as const)('rejects a sample retired inside the native %s getter', async key => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({});
    const native = await initialized(resource); coverage(video, native); await resource.position(0);
    let successor: MediaSeekResource | undefined, once = false;
    let value: number | boolean = key === 'paused' ? true : 1;
    Object.defineProperty(video, key, { configurable: true,
      get() { if (!once) { once = true; successor = adapter.beginSeek({}); } return value; },
      set(next: number | boolean) { value = next; },
    });
    expect(resource.sample()).toBeNull(); expect(once).toBe(true); expect(resource.current).toBe(false);
    expect(successor!.current).toBe(true);
    const replacement = await initialized(successor!); coverage(video, replacement); await successor!.position(0);
    expect(successor!.sample()).toMatchObject({ currentTime: 0 });
  });
});

describe('switch recovery reservation and owned seeks', () => {
  const target = { mediaType: 'video' as const, trackName: 'next' };

  it('is refused while an owned seek has not been released to playback', async () => {
    const { adapter, video } = fixture(), resource = adapter.beginSeek({}), source = await initialized(resource);
    coverage(video, source);
    expect(adapter.reserveSwitchRecovery(target), 'attached, not positioned').toBeNull();
    await resource.position(0);
    expect(adapter.reserveSwitchRecovery(target), 'positioned, playback not released').toBeNull();
  });

  it('is available once a seek resource is released into live playback', async () => {
    const { adapter, video } = fixture();
    await playing(adapter, video);
    expect(adapter.reserveSwitchRecovery(target)).not.toBeNull();
  });

  it('a seek begun after the reservation ends it', async () => {
    const { adapter, video } = fixture();
    await playing(adapter, video);
    const recovery = adapter.reserveSwitchRecovery(target)!;
    const next = adapter.beginSeek({}); const source = await initialized(next); coverage(video, source);
    recovery.activate();
    expect((adapter as unknown as { switchRecovery: unknown }).switchRecovery, 'no reservation survives the replacement resource').toBeNull();
  });
});
