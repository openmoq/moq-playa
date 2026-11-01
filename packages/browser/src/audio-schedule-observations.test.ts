import { describe, expect, it, vi } from 'vitest';
import type { AudioOutputLike, AudioScheduleObservation } from '@openmoq/player';
import { WebAudioOutput } from './webaudio-output.js';

function fixture() {
  const sources: Array<ReturnType<typeof makeSource>> = [];
  let onStart: (() => void) | undefined;
  let onStop: (() => void) | undefined;
  function makeSource() {
    return {
      buffer: null as AudioBuffer | null,
      playbackRate: { value: 1 },
      onended: null as (() => void) | null,
      connect: vi.fn(), disconnect: vi.fn(),
      start: vi.fn(() => onStart?.()), stop: vi.fn(() => onStop?.()),
    };
  }
  const ctx = {
    currentTime: 1,
    destination: {},
    createBuffer: vi.fn(() => ({ duration: 0.02, getChannelData: () => new Float32Array(960) })),
    createBufferSource: vi.fn(() => { const source = makeSource(); sources.push(source); return source; }),
  };
  const out = new WebAudioOutput(ctx as unknown as AudioContext, undefined, 0, { now: () => ctx.currentTime * 1e6 });
  const output: AudioOutputLike = out;
  const events: AudioScheduleObservation[] = [];
  function observe() { return output.observeSchedules!(event => { events.push(event); }); }
  function schedule(token?: object) {
    const data = { numberOfChannels: 1, numberOfFrames: 960, sampleRate: 48000, timestamp: 8e6, copyTo: vi.fn(), close: vi.fn() };
    output.schedule(data, 1e6, token);
    return data;
  }
  return { out, output, ctx, sources, events, observe, schedule,
    start(fn: () => void) { onStart = fn; }, stop(fn: () => void) { onStop = fn; } };
}

describe('WebAudio scheduling observations', () => {
  it('reports scheduling only after start succeeds and releases once on actual ended', () => {
    const f = fixture(); f.observe(); const token = {};
    f.start(() => expect(f.events).toEqual([]));
    const data = f.schedule(token);
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ token, state: 'scheduled', reason: null }]);
    f.sources[0]!.onended!(); f.sources[0]!.onended!(); f.out.flush();
    expect(f.events).toEqual([{ token, state: 'scheduled', reason: null }, { token, state: 'released', reason: null }]);
  });
  it('does not claim audible presentation or completion while the context is suspended', () => {
    const f = fixture(); f.observe(); f.schedule({});
    expect(f.events.map(e => e.state)).toEqual(['scheduled']);
    expect(f.ctx.currentTime).toBe(1);
    f.out.flush();
    expect(f.events.map(e => [e.state, e.reason])).toEqual([['scheduled', null], ['discarded', 'flushed']]);
  });
  it('registers before an inline ended and still publishes scheduled before release', () => {
    const f = fixture(); f.observe();
    f.start(() => f.sources[0]!.onended!()); f.schedule({});
    expect(f.events.map(e => e.state)).toEqual(['scheduled', 'released']);
    f.out.flush(); expect(f.sources[0]!.stop).not.toHaveBeenCalled();
  });
  it('a throwing start discards once, closes the input, and leaves no chained timeline', () => {
    const f = fixture(); f.observe(); const token = {};
    f.start(() => { throw new Error('start refused'); });
    const data = { numberOfChannels: 1, numberOfFrames: 960, sampleRate: 48000, timestamp: 8e6, copyTo: vi.fn(), close: vi.fn() };
    expect(() => f.output.schedule(data, 1e6, token)).toThrow('start refused');
    expect(data.close).toHaveBeenCalledOnce();
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'schedule failed' }]);
    f.sources[0]!.onended!(); f.out.flush(); expect(f.events).toHaveLength(1);
    expect(f.out.playheadCaptureUs()).toBeNull();
    f.start(() => {}); f.schedule({}); expect(f.sources[1]!.start).toHaveBeenCalledWith(1);
  });
  it('flush forgets ownership before stop can fire ended synchronously or later', () => {
    const f = fixture(); f.observe(); f.schedule({}); f.schedule({});
    f.stop(() => { for (const source of f.sources) source.onended!(); });
    f.out.flush(); for (const source of f.sources) source.onended!();
    expect(f.events.filter(e => e.state !== 'scheduled').map(e => [e.state, e.reason])).toEqual([
      ['discarded', 'flushed'], ['discarded', 'flushed'],
    ]);
    expect(f.sources.map(s => s.stop.mock.calls.length)).toEqual([1, 1]);
  });
  it('destroy and subsequent submissions are terminal exactly once', () => {
    const f = fixture(); f.observe(); f.schedule({}); f.out.destroy(); f.out.destroy();
    f.sources[0]!.onended!(); const data = f.schedule({});
    expect(data.close).toHaveBeenCalledOnce(); expect(f.sources).toHaveLength(1);
    expect(f.events.filter(e => e.state !== 'scheduled').map(e => e.reason)).toEqual(['destroyed', 'destroyed']);
  });
  it('a flush during start cannot be followed by scheduled or restored timeline state', () => {
    const f = fixture(); f.observe(); f.start(() => f.out.flush()); f.schedule({});
    expect(f.events.map(e => [e.state, e.reason])).toEqual([['discarded', 'flushed']]);
    expect(f.out.playheadCaptureUs()).toBeNull();
    f.start(() => {}); f.schedule({}); expect(f.sources[1]!.start).toHaveBeenCalledWith(1);
  });
  it('a scheduled listener can flush and admit fresh audio without outer cleanup consuming it', () => {
    const f = fixture(); const old = {}, fresh = {}; let replaced = false;
    f.observe(); f.output.observeSchedules!(e => {
      if (e.token === old && e.state === 'discarded' && !replaced) { replaced = true; f.schedule(fresh); }
    });
    f.schedule(old); f.out.flush();
    expect(f.events.map(e => [e.token, e.state])).toEqual([[old, 'scheduled'], [old, 'discarded'], [fresh, 'scheduled']]);
    expect(f.sources[1]!.stop).not.toHaveBeenCalled();
    expect(f.out.playheadCaptureUs()).toBe(8e6);
    f.sources[1]!.onended!(); expect(f.events.at(-1)).toEqual({ token: fresh, state: 'released', reason: null });
  });
  it('has no pre-attachment history and detaching does not stop media', () => {
    const f = fixture(); f.schedule({}); const off = f.observe();
    f.sources[0]!.onended!(); expect(f.events).toEqual([]);
    f.schedule({}); off(); f.sources[1]!.onended!();
    expect(f.events.map(e => e.state)).toEqual(['scheduled']);
    expect(f.sources[1]!.stop).not.toHaveBeenCalled();
  });
  it('contains synchronous and async observer faults and copies observations', async () => {
    const f = fixture();
    f.output.observeSchedules!(e => { (e as { state: string }).state = 'corrupt'; throw new Error('listener'); });
    f.output.observeSchedules!(async () => { throw new Error('async listener'); });
    f.observe(); f.schedule({}); f.sources[0]!.onended!();
    await Promise.resolve(); await Promise.resolve();
    expect(f.events.map(e => e.state)).toEqual(['scheduled', 'released']);
  });
  it('copy failure closes native data and reports a failed schedule, not acceptance', () => {
    const f = fixture(); f.observe(); const token = {};
    const data = { numberOfChannels: 1, numberOfFrames: 960, sampleRate: 48000, timestamp: 8e6,
      copyTo() { throw new Error('copy refused'); }, close: vi.fn() };
    expect(() => f.output.schedule(data, 1e6, token)).toThrow('copy refused');
    expect(data.close).toHaveBeenCalledOnce(); expect(f.sources).toHaveLength(0);
    expect(f.events).toEqual([{ token, state: 'discarded', reason: 'schedule failed' }]);
  });
});
