import { describe, expect, it, vi } from 'vitest';
import type { AudioOutputLike, AudioScheduleObservation, AudioScheduleObserver } from '@openmoq/player';
import { DeferredAudioOutput } from './deferred-audio-output.js';

function backend() {
  let listener: AudioScheduleObserver | undefined;
  const off = vi.fn();
  const output: AudioOutputLike = {
    supportsOutputTiming: true,
    schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 0,
    sampleSourcePosition: vi.fn(() => null),
    observeSchedules: vi.fn(observer => { listener = observer; return off; }),
  };
  return { output, off, emit: (event: AudioScheduleObservation) => listener?.(event),
    captured: () => listener };
}

describe('deferred audio observation lifetime', () => {
  it('declares deferred proof without claiming that an inactive output is ready', () => {
    const proxy = new DeferredAudioOutput();
    expect(Reflect.get(proxy, 'outputTimingDeferred')).toBe(true);
    expect(proxy.supportsOutputTiming).toBeUndefined();
    expect(proxy.sampleSourcePosition({})).toBeNull();
  });

  it('closes inactive PCM and reports a discard, never a schedule or source position', () => {
    const proxy: AudioOutputLike = new DeferredAudioOutput(), events: AudioScheduleObservation[] = [], token = {};
    const close = vi.fn(); proxy.observeSchedules!(event => { events.push(event); });
    proxy.schedule({ close }, 1_000, token);
    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ token, state: 'discarded', reason: 'timing unavailable' }]);
    expect(proxy.sampleSourcePosition!({})).toBeNull();
  });

  it('binds lazily and forwards only actual backend scheduling evidence', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), token = {}, events: AudioScheduleObservation[] = [];
    proxy.observeSchedules!(event => { events.push(event); });
    expect(first.output.observeSchedules).not.toHaveBeenCalled();
    proxy.activate(first.output);
    expect(first.output.observeSchedules).toHaveBeenCalledTimes(1);
    proxy.schedule({}, 1_000, token); expect(events).toEqual([]);
    first.emit({ token, state: 'scheduled', reason: null });
    first.emit({ token, state: 'released', reason: null });
    expect(events.map(event => event.state)).toEqual(['scheduled', 'released']);
    proxy.destroy();
  });

  it('withdraws the last listener and rejects retained backend callbacks', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), observer = vi.fn(); proxy.activate(first.output);
    const off = proxy.observeSchedules!(observer), retained = first.captured(); off(); off();
    retained?.({ token: {}, state: 'released', reason: null });
    expect(first.off).toHaveBeenCalledTimes(1); expect(observer).not.toHaveBeenCalled();
    proxy.destroy();
  });

  it('isolates event copies and rechecks listener membership during publication', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), token = {};
    let removeSecond = () => {};
    proxy.observeSchedules!(event => { removeSecond(); Reflect.set(event, 'state', 'discarded'); });
    const second = vi.fn(), third = vi.fn(); removeSecond = proxy.observeSchedules!(second);
    proxy.observeSchedules!(third); proxy.activate(first.output);
    first.emit({ token, state: 'scheduled', reason: null });
    expect(second).not.toHaveBeenCalled(); expect(third).toHaveBeenCalledExactlyOnceWith({ token, state: 'scheduled', reason: null });
    proxy.destroy();
  });

  it('retires a replaced native output exactly once without touching a repeated activation', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), next = backend(); proxy.activate(first.output);
    proxy.activate(first.output);
    expect(first.output.destroy).not.toHaveBeenCalled(); expect(first.output.flush).not.toHaveBeenCalled();
    proxy.activate(next.output);
    expect(first.output.flush).toHaveBeenCalledTimes(1); expect(first.output.destroy).toHaveBeenCalledTimes(1);
    proxy.destroy(); expect(next.output.destroy).toHaveBeenCalledTimes(1);
  });

  it('relays old terminal cleanup before detaching it, then ignores stale callbacks', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), next = backend(), token = {}, events: AudioScheduleObservation[] = [];
    proxy.observeSchedules!(event => { events.push(event); }); proxy.activate(first.output);
    const retained = first.captured();
    vi.mocked(first.output.flush).mockImplementation(() => { first.emit({ token, state: 'discarded', reason: 'flushed' }); });
    proxy.activate(next.output);
    retained?.({ token, state: 'released', reason: null });
    next.emit({ token: {}, state: 'scheduled', reason: null });
    expect(events.map(event => event.state)).toEqual(['discarded', 'scheduled']); expect(first.off).toHaveBeenCalledTimes(1);
    proxy.destroy();
  });

  it('preserves a successor activated during old native cleanup', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), next = backend(), observer = vi.fn();
    proxy.observeSchedules!(observer); proxy.activate(first.output);
    vi.mocked(first.output.destroy).mockImplementationOnce(() => proxy.activate(next.output));
    proxy.destroy();
    expect(proxy.isActive).toBe(true); expect(next.output.destroy).not.toHaveBeenCalled();
    next.emit({ token: {}, state: 'scheduled', reason: null }); expect(observer).toHaveBeenCalledTimes(1);
    proxy.destroy(); expect(next.output.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps an observer installed when inline publication reactivates the same native target', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), token = {}, events: AudioScheduleObservation[] = [];
    let retained: AudioScheduleObserver | undefined;
    vi.mocked(first.output.observeSchedules!).mockImplementation(observer => {
      retained = observer; observer({ token, state: 'scheduled', reason: null }); return first.off;
    });
    proxy.observeSchedules(event => {
      events.push(event); if (event.state === 'scheduled') proxy.activate(first.output);
    });
    proxy.activate(first.output);
    expect(first.off).not.toHaveBeenCalled();
    retained?.({ token, state: 'released', reason: null });
    expect(events.map(event => event.state)).toEqual(['scheduled', 'released']);
    proxy.destroy(); expect(first.off).toHaveBeenCalledTimes(1);
  });

  it('settles old native cleanup and its listener even when teardown throws', () => {
    const proxy = new DeferredAudioOutput(), first = backend(), next = backend();
    proxy.observeSchedules!(() => {}); proxy.activate(first.output);
    vi.mocked(first.output.flush).mockImplementation(() => { throw new Error('flush failed'); });
    expect(() => proxy.activate(next.output)).toThrow('flush failed');
    expect(first.output.destroy).toHaveBeenCalledTimes(1); expect(first.off).toHaveBeenCalledTimes(1);
    expect(proxy.isActive).toBe(true); proxy.destroy(); expect(next.output.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('native observation acquisition', () => {
  it.each([false, true])('owns one native binding when the method getter registers another listener: %s', reenter => {
    const proxy = new DeferredAudioOutput();
    const listeners = new Set<AudioScheduleObserver>();
    const first = vi.fn(), second = vi.fn();
    let nestedOff: (() => void) | undefined;
    let armed = reenter;
    const observe = vi.fn((listener: AudioScheduleObserver) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    const target: AudioOutputLike = {
      supportsOutputTiming: true,
      schedule: vi.fn(), flush: vi.fn(), destroy: vi.fn(), currentPlayoutTimeUs: 0,
      get observeSchedules() {
        if (armed) { armed = false; nestedOff = proxy.observeSchedules(second); }
        return observe;
      },
    };
    proxy.activate(target);
    const firstOff = proxy.observeSchedules(first);
    nestedOff ??= proxy.observeSchedules(second);
    const token = {};
    for (const listener of listeners) listener({ token, state: 'scheduled', reason: null });
    firstOff(); nestedOff();
    const result = {
      nativeRegistrations: observe.mock.calls.length,
      firstNotifications: first.mock.calls.length,
      secondNotifications: second.mock.calls.length,
      nativeBindingsAfterLastOff: listeners.size,
    };
    proxy.destroy();
    expect(result).toEqual({
      nativeRegistrations: 1, firstNotifications: 1, secondNotifications: 1,
      nativeBindingsAfterLastOff: 0,
    });
  });
});
