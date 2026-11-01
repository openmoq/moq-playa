import { describe, expect, it, vi } from 'vitest';
import { CommandDispatcher } from './command-dispatcher.js';
import type { DispatcherOutputObserver } from './command-dispatcher.js';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike } from './interfaces.js';

function fixture() {
  const video: VideoDecoderLike = { configure: vi.fn(), decode: vi.fn(), flush: async () => {}, reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onFrame: null, onError: null };
  const audio: AudioDecoderLike = { configure: vi.fn(), decode: vi.fn(), flush: async () => {}, reset: vi.fn(), destroy: vi.fn(), queueDepth: 0, onData: null, onError: null };
  const renderer: VideoRendererLike = { enqueue: vi.fn(), flush: vi.fn(), destroy: vi.fn(), onFirstFrame: null, onFrameRendered: null, onStall: null };
  const output: AudioOutputLike = { schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 0 };
  let sync = true;
  let syncHook: (() => boolean) | undefined;
  let cushionHook: (() => number) | undefined;
  const dispatcher = new CommandDispatcher({ videoDecoder: video, audioDecoder: audio, renderer, audioOutput: output, hasSyncReference: () => syncHook ? syncHook() : sync, getPlaybackDelayUs: () => cushionHook?.() ?? 0, recomputeVideoRenderTime: t => Number(t) + 10 });
  const observer: DispatcherOutputObserver = { decoded: vi.fn(() => ({})), discarded: vi.fn() };
  function frame(timestamp = 123) { return { timestamp, close: vi.fn() }; }
  return { video, audio, renderer, output, dispatcher, observer, frame, sync(ready: boolean) { sync = ready; }, syncHook(fn: () => boolean) { syncHook = fn; }, cushionHook(fn: () => number) { cushionHook = fn; } };
}

describe('dispatcher output ownership', () => {
  it('passes optional input tokens into both native decoders without changing unobserved arity', () => {
    const f = fixture(), token = {};
    const chunk = { type: 'key' as const, timestamp: 123, data: new Uint8Array([1]) };
    f.dispatcher.dispatch({ type: 'decode_video', chunk, renderTimeUs: 7, inputToken: token });
    f.dispatcher.dispatch({ type: 'decode_audio', chunk, renderTimeUs: 8, inputToken: token });
    expect(f.video.decode).toHaveBeenLastCalledWith(chunk, 7, token);
    expect(f.audio.decode).toHaveBeenLastCalledWith(chunk, 8, token);
    f.dispatcher.dispatch({ type: 'decode_video', chunk, renderTimeUs: 9 });
    f.dispatcher.dispatch({ type: 'decode_audio', chunk, renderTimeUs: 10 });
    expect(f.video.decode).toHaveBeenLastCalledWith(chunk, 9);
    expect(f.audio.decode).toHaveBeenLastCalledWith(chunk, 10);
  });
  it('creates a decoded unit before enqueue can synchronously complete it', () => {
    const f = fixture(), input = {}, unit = {}, frame = f.frame();
    f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockReturnValue(unit);
    vi.mocked(f.renderer.enqueue).mockImplementation((_frame, _time, token) => {
      expect(f.observer.decoded).toHaveBeenCalledWith('video', input, f.renderer);
      expect(token).toBe(unit);
    });
    f.video.onFrame!(frame, 4, null, input);
    expect(f.renderer.enqueue).toHaveBeenCalledWith(frame, 133, unit);
  });
  it('uses a fresh unit per actual audio output, not per input', () => {
    const f = fixture(), input = {}, one = {}, two = {};
    f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockReturnValueOnce(one).mockReturnValueOnce(two);
    f.audio.onData!({}, 10, input); f.audio.onData!({}, 20, input);
    expect(f.observer.decoded).toHaveBeenNthCalledWith(1, 'audio', input, f.output);
    expect(f.output.schedule).toHaveBeenNthCalledWith(1, {}, 10, one);
    expect(f.output.schedule).toHaveBeenNthCalledWith(2, {}, 20, two);
  });
  it('does not invent input identity when a custom decoder drops its token', () => {
    const f = fixture(); f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockReturnValue(undefined);
    const frame = f.frame(); f.video.onFrame!(frame, 4);
    expect(f.observer.decoded).toHaveBeenCalledWith('video', undefined, f.renderer);
    expect(f.renderer.enqueue).toHaveBeenCalledWith(frame, 133);
  });
  it('keeps the same decoded unit through the sync hold queue and drain', () => {
    const f = fixture(), held = f.frame(1), current = f.frame(2), one = {}, two = {};
    f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockReturnValueOnce(one).mockReturnValueOnce(two);
    f.sync(false); f.video.onFrame!(held, 0, null, {});
    expect(f.renderer.enqueue).not.toHaveBeenCalled();
    f.sync(true); f.video.onFrame!(current, 0, null, {});
    expect(f.observer.decoded).toHaveBeenCalledTimes(2);
    expect(f.renderer.enqueue).toHaveBeenNthCalledWith(1, held, 11, one);
    expect(f.renderer.enqueue).toHaveBeenNthCalledWith(2, current, 12, two);
    expect(f.observer.discarded).not.toHaveBeenCalled();
  });
  it('terminates exactly the held unit actually evicted at the hold bound', () => {
    const f = fixture(); f.dispatcher.outputObserver = f.observer; f.sync(false);
    const frames = Array.from({ length: 31 }, (_, i) => f.frame(i));
    const units = frames.map(() => ({}));
    for (let i = 0; i < frames.length; i++) {
      vi.mocked(f.observer.decoded).mockReturnValueOnce(units[i]); f.video.onFrame!(frames[i], 0, null, {});
    }
    expect(frames[0]!.close).toHaveBeenCalledOnce(); expect(frames[1]!.close).not.toHaveBeenCalled();
    expect(f.observer.discarded).toHaveBeenCalledExactlyOnceWith(units[0], 'hold queue overflow');
  });
  it.each(['flush', 'destroy', 'reset'] as const)('%s closes held frames and terminates their units once', action => {
    const f = fixture(), frame = f.frame(), unit = {};
    f.dispatcher.outputObserver = f.observer; f.sync(false); vi.mocked(f.observer.decoded).mockReturnValue(unit);
    f.video.onFrame!(frame, 0, null, {});
    if (action === 'reset') f.dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'test reset' }); else f.dispatcher[action]();
    f.dispatcher.destroy();
    expect(frame.close).toHaveBeenCalledOnce();
    expect(f.observer.discarded).toHaveBeenCalledExactlyOnceWith(unit, action === 'reset' ? 'decoder reset' : action === 'flush' ? 'flushed' : 'destroyed');
  });
  it('retirement during decoded observation closes the not-yet-enqueued frame', () => {
    const f = fixture(), frame = f.frame(), unit = {};
    f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockImplementation(() => { f.dispatcher.destroy(); return unit; });
    f.video.onFrame!(frame, 0, null, {});
    expect(f.renderer.enqueue).not.toHaveBeenCalled(); expect(frame.close).toHaveBeenCalledOnce();
    expect(f.observer.discarded).toHaveBeenCalledExactlyOnceWith(unit, 'destroyed');
  });
  it('retirement during a hold drain cannot enqueue the remaining frames or consume new queue entries', () => {
    const f = fixture(); f.dispatcher.outputObserver = f.observer; f.sync(false);
    const one = f.frame(1), two = f.frame(2), current = f.frame(3);
    f.video.onFrame!(one, 0, null, {}); f.video.onFrame!(two, 0, null, {});
    vi.mocked(f.renderer.enqueue).mockImplementationOnce(() => f.dispatcher.flush());
    f.sync(true); f.video.onFrame!(current, 0, null, {});
    expect(f.renderer.enqueue).toHaveBeenCalledTimes(1);
    expect(two.close).toHaveBeenCalledOnce(); expect(current.close).toHaveBeenCalledOnce();
    expect(f.observer.discarded).toHaveBeenCalledTimes(2);
  });
  it('detaching output observation does not discard held media or transfer its units', () => {
    const f = fixture(); f.dispatcher.outputObserver = f.observer; f.sync(false);
    const held = f.frame(); f.video.onFrame!(held, 0, null, {});
    f.dispatcher.outputObserver = undefined; f.sync(true); f.video.onFrame!(f.frame(), 0);
    expect(f.renderer.enqueue).toHaveBeenNthCalledWith(1, held, 133);
    expect(held.close).not.toHaveBeenCalled(); expect(f.observer.discarded).not.toHaveBeenCalled();
  });
  it('observer faults do not prevent media delivery', () => {
    const f = fixture(), frame = f.frame(); f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockImplementation(() => { throw new Error('optional metadata'); });
    f.video.onFrame!(frame, 0, null, {});
    expect(f.renderer.enqueue).toHaveBeenCalledWith(frame, 133);
  });
  it('destroyed dispatcher closes a late frame without manufacturing a unit', () => {
    const f = fixture(), frame = f.frame(); f.dispatcher.outputObserver = f.observer; f.dispatcher.destroy();
    f.video.onFrame!(frame, 0, null, {});
    expect(frame.close).toHaveBeenCalledOnce(); expect(f.observer.decoded).not.toHaveBeenCalled();
    expect(f.renderer.enqueue).not.toHaveBeenCalled();
  });
  it('an audio reset during video observation does not retire the unrelated video output', () => {
    const f = fixture(), frame = f.frame(), unit = {};
    f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockImplementation(() => {
      f.dispatcher.dispatch({ type: 'reset', mediaType: 'audio', reason: 'test reset' }); return unit;
    });
    f.video.onFrame!(frame, 0, null, {});
    expect(f.renderer.enqueue).toHaveBeenCalledExactlyOnceWith(frame, 133, unit);
    expect(frame.close).not.toHaveBeenCalled();
  });
  it('a video reset during audio observation does not retire the unrelated audio output', () => {
    const f = fixture(), data = { close: vi.fn() }, unit = {};
    f.dispatcher.outputObserver = f.observer;
    vi.mocked(f.observer.decoded).mockImplementation(() => {
      f.dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'test reset' }); return unit;
    });
    f.audio.onData!(data, 0, {});
    expect(f.output.schedule).toHaveBeenCalledExactlyOnceWith(data, 0, unit);
    expect(data.close).not.toHaveBeenCalled();
  });
  it('a hold-drain target exception also releases the newer unsubmitted frame', () => {
    const f = fixture(); f.dispatcher.outputObserver = f.observer; f.sync(false);
    const held = f.frame(1), current = f.frame(2);
    f.video.onFrame!(held, 0, null, {});
    vi.mocked(f.renderer.enqueue).mockImplementation(() => { throw new Error('target failure'); });
    f.sync(true); expect(() => f.video.onFrame!(current, 0, null, {})).toThrow('target failure');
    expect(current.close).toHaveBeenCalledOnce();
    expect(f.observer.discarded).toHaveBeenCalledTimes(2);
    expect(held.close).not.toHaveBeenCalled(); // enqueue transferred frame ownership to the target.
  });
  it('a throwing sync query releases the decoded frame and its unit', () => {
    const f = fixture(), frame = f.frame(); f.dispatcher.outputObserver = f.observer;
    f.syncHook(() => { throw new Error('sync failure'); });
    expect(() => f.video.onFrame!(frame, 0, null, {})).toThrow('sync failure');
    expect(frame.close).toHaveBeenCalledOnce();
    expect(f.observer.discarded).toHaveBeenCalledTimes(1);
  });
  it('a throwing delay query releases the decoded audio and its unit', () => {
    const f = fixture(), data = { close: vi.fn() }; f.dispatcher.outputObserver = f.observer;
    f.cushionHook(() => { throw new Error('delay failure'); });
    expect(() => f.audio.onData!(data, 0, {})).toThrow('delay failure');
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.observer.discarded).toHaveBeenCalledTimes(1);
  });

});
