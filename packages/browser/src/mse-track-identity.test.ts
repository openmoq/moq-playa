import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAppendObservation } from '@openmoq/player';
import { MseMediaSource, type MseMediaSourceOptions } from './mse-adapter.js';

function cat(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = cat(...parts);
  return cat(u32(body.length + 8), new TextEncoder().encode(type), body);
}
function fullBox(type: string, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u32(flags), ...parts);
}
function segment(start: number): Uint8Array {
  return cat(box('moof', box('traf',
    fullBox('tfhd', 8, u32(1), u32(100)),
    fullBox('tfdt', 0, u32(start)), fullBox('trun', 0, u32(1)),
  )), box('mdat', new Uint8Array(16)));
}
function timeRanges(ranges: readonly (readonly [number, number])[]): TimeRanges {
  return { length: ranges.length, start: i => ranges[i]![0], end: i => ranges[i]![1] };
}

class MockSourceBuffer extends EventTarget {
  updating = false;
  mode = 'segments';
  timestampOffset = 0;
  buffered = timeRanges([]);
  autoComplete = true;
  throwNextAppend: Error | undefined;
  readonly appended: Uint8Array[] = [];
  readonly removes: [number, number][] = [];
  appendBuffer(data: ArrayBuffer): void {
    if (this.throwNextAppend) {
      const error = this.throwNextAppend;
      this.throwNextAppend = undefined;
      throw error;
    }
    this.appended.push(new Uint8Array(data).slice());
    this.updating = true;
    if (this.autoComplete) queueMicrotask(() => this.complete());
  }
  remove(start: number, end: number): void {
    this.removes.push([start, end]);
    this.buffered = timeRanges([]);
    this.updating = true;
    if (this.autoComplete) queueMicrotask(() => this.complete());
  }
  complete(): void {
    this.updating = false;
    this.dispatchEvent(new Event('update'));
    this.dispatchEvent(new Event('updateend'));
  }
}
class MockMediaSource extends EventTarget {
  readyState = 'closed';
  readonly buffers: MockSourceBuffer[] = [];
  addSourceBuffer(): MockSourceBuffer {
    const buffer = new MockSourceBuffer();
    this.buffers.push(buffer);
    return buffer;
  }
  removeSourceBuffer(): void {}
  endOfStream(): void { this.readyState = 'ended'; }
  open(): void { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
}
class MockVideo extends EventTarget {
  src = '';
  srcObject: unknown = null;
  currentTime = 0;
  paused = true;
  buffered = timeRanges([]);
  pause(): void { this.paused = true; }
  load(): void {}
  removeAttribute(): void {}
}

let native: MockMediaSource;
const adapters: MseMediaSource[] = [];
beforeEach(() => {
  native = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return native; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:identity-test', revokeObjectURL: () => {} });
});
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}
async function ready(type: 'video' | 'audio', options: MseMediaSourceOptions = {}) {
  const video = new MockVideo();
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, options);
  adapters.push(adapter);
  adapter.setPlaybackIntent(false);
  // Explicit tfhd durations in every media segment make trex unnecessary here.
  adapter.initialize({ [type]: { codec: type === 'video' ? 'avc1.42c01e' : 'mp4a.40.2',
    initData: box('ftyp', new TextEncoder().encode('iso6'), u32(0)) } });
  native.open();
  await flush();
  const buffer = native.buffers[0]!;
  buffer.appended.length = 0;
  const events: MediaAppendObservation[] = [];
  adapter.observeAppends(event => { events.push(event); });
  return { adapter, buffer, video, events };
}

interface Track { name: string; key?: string }
const pairs: { label: string; a: Track; b: Track }[] = [
  { label: 'distinct legacy names (control)', a: { name: 'left' }, b: { name: 'right' } },
  { label: 'same basename, distinct source keys', a: { name: 'track', key: 'left' }, b: { name: 'track', key: 'right' } },
  { label: 'legacy name equals provided key', a: { name: 'track' }, b: { name: 'track', key: 'track' } },
  { label: 'legacy name looks like a tagged key', a: { name: 'source:track' }, b: { name: 'source:track', key: 'track' } },
  { label: 'empty provided key differs from legacy', a: { name: 'track', key: '' }, b: { name: 'track' } },
];

describe.each(['video', 'audio'] as const)('MSE %s track identity', type => {
  it('advertises source identity support', async () => {
    const { adapter } = await ready(type);
    expect(adapter.supportsTrackIdentity).toBe(true);
  });

  it.each(pairs)('isolates replay history: $label', async ({ a, b }) => {
    const { adapter, buffer, events } = await ready(type);
    const first = {}, second = {}, replay = {};
    adapter.appendChunk(type, segment(0), a.name, 1n, first, a.key); await flush();
    adapter.appendChunk(type, segment(0), b.name, 1n, second, b.key); await flush();
    adapter.appendChunk(type, segment(0), a.name, 1n, replay, a.key); await flush();
    expect(buffer.appended).toHaveLength(2);
    expect(events).toEqual([
      { token: first, state: 'appended', reason: null },
      { token: second, state: 'appended', reason: null },
      { token: replay, state: 'discarded', reason: 'treated as a replay' },
    ]);
    [first, second, replay].forEach((token, index) => expect(events[index]!.token).toBe(token));
  });

  it.each(pairs)('isolates group floors on admission and drain: $label', async ({ a, b }) => {
    const { adapter, buffer, events } = await ready(type);
    const first = {}, second = {}, stale = {};
    buffer.autoComplete = false;
    adapter.appendChunk(type, segment(0), a.name, 20n, first, a.key);
    adapter.appendChunk(type, segment(100), b.name, 1n, second, b.key);
    buffer.autoComplete = true; buffer.complete(); await flush();
    adapter.appendChunk(type, segment(200), a.name, 19n, stale, a.key); await flush();
    expect(buffer.appended).toHaveLength(2);
    expect(adapter.getCommittedGroupFloor(type, a.name, a.key)).toBe(20n);
    expect(adapter.getCommittedGroupFloor(type, b.name, b.key)).toBe(1n);
    expect(events).toEqual([
      { token: first, state: 'appended', reason: null },
      { token: second, state: 'appended', reason: null },
      { token: stale, state: 'discarded', reason: 'stale group' },
    ]);
    const later = {};
    adapter.appendChunk(type, segment(200), b.name, 2n, later, b.key); await flush();
    expect(events.at(-1)).toEqual({ token: later, state: 'appended', reason: null });
  });

  it('keeps caller order across same-name source boundaries', async () => {
    const { adapter, buffer } = await ready(type);
    const prefix = segment(0), tail = segment(100), other = segment(0), end = segment(200);
    buffer.autoComplete = false;
    adapter.appendChunk(type, prefix, 'track', undefined, undefined, 'left');
    adapter.appendChunk(type, tail, 'track', undefined, undefined, 'left');
    adapter.appendChunk(type, other, 'track', undefined, undefined, 'right');
    adapter.appendChunk(type, end, 'track', undefined, undefined, 'left');
    buffer.autoComplete = true; buffer.complete(); await flush();
    expect(buffer.appended).toEqual([prefix, tail, other, end]);
  });

  it('reorders one source across display-name changes', async () => {
    const { adapter, buffer } = await ready(type);
    const prefix = segment(0), head = segment(200), tail = segment(100);
    buffer.autoComplete = false;
    adapter.appendChunk(type, prefix, 'before', undefined, undefined, 'stable');
    adapter.appendChunk(type, head, 'before', undefined, undefined, 'stable');
    adapter.appendChunk(type, tail, 'after', undefined, undefined, 'stable');
    buffer.autoComplete = true; buffer.complete(); await flush();
    expect(buffer.appended).toEqual([prefix, tail, head]);
  });

  it('clears only the requested source and preserves the other replay guard', async () => {
    const { adapter, events } = await ready(type);
    adapter.appendChunk(type, segment(0), 'track', 1n, {}, 'left'); await flush();
    adapter.appendChunk(type, segment(0), 'track', 1n, {}, 'right'); await flush();
    events.length = 0;
    adapter.clearTimeline(type, 'track', 'left');
    const other = {}, restarted = {};
    adapter.appendChunk(type, segment(0), 'track', 1n, other, 'right'); await flush();
    adapter.appendChunk(type, segment(0), 'track', 1n, restarted, 'left'); await flush();
    expect(events).toEqual([
      { token: other, state: 'discarded', reason: 'treated as a replay' },
      { token: restarted, state: 'appended', reason: null },
    ]);
    expect(adapter.getCommittedGroupFloor(type, 'track', 'left')).toBe(1n);
  });

  it('does not clear another same-name source pending native commit', async () => {
    const { adapter, buffer } = await ready(type);
    buffer.autoComplete = false;
    adapter.appendChunk(type, segment(0), 'track', 7n, {}, 'left');
    adapter.clearTimeline(type, 'track', 'right');
    buffer.complete(); await flush();
    expect(adapter.getCommittedGroupFloor(type, 'track', 'left')).toBe(7n);
    expect(adapter.getCommittedGroupFloor(type, 'track', 'right')).toBeUndefined();
  });

  it('isolates gap deadlines and late-segment floors', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { adapter, buffer, events } = await ready(type);
    adapter.appendChunk(type, segment(0), 'track', undefined, {}, 'left'); await flush();
    adapter.appendChunk(type, segment(0), 'track', undefined, {}, 'right'); await flush();
    const head = {};
    adapter.appendChunk(type, segment(200), 'track', undefined, head, 'left'); await flush();
    adapter.clearTimeline(type, 'track', 'right'); await flush();
    expect(buffer.appended).toHaveLength(2);
    expect(events.some(event => event.token === head)).toBe(false);
    await vi.advanceTimersByTimeAsync(250); await flush();
    const late = {}, other = {};
    adapter.appendChunk(type, segment(100), 'track', undefined, late, 'left'); await flush();
    adapter.appendChunk(type, segment(100), 'track', undefined, other, 'right'); await flush();
    expect(events.slice(-2)).toEqual([
      { token: late, state: 'discarded', reason: 'late segment' },
      { token: other, state: 'appended', reason: null },
    ]);
  });

  it.each(['resume', 'discard'] as const)('retains source keys and one terminal through queue hold %s', async action => {
    const { adapter, buffer, events } = await ready(type);
    const left = {}, right = {}, replay = {};
    buffer.updating = true;
    adapter.appendChunk(type, segment(0), 'track', 20n, left, 'left');
    adapter.appendChunk(type, segment(0), 'track', 1n, right, 'right');
    adapter.appendChunk(type, segment(0), 'track', 20n, replay, 'left');
    const lease = adapter.holdQueuedAppends([type]);
    buffer.updating = false;
    lease[action](); lease.resume(); lease.discard(); await flush();
    expect(events).toEqual(action === 'discard' ? [left, right, replay].map(token =>
      ({ token, state: 'discarded', reason: 'retype' })) : [
      { token: left, state: 'appended', reason: null },
      { token: right, state: 'appended', reason: null },
      { token: replay, state: 'discarded', reason: 'treated as a replay' },
    ]);
    [left, right, replay].forEach((token, index) => expect(events[index]!.token).toBe(token));
    expect(buffer.appended).toHaveLength(action === 'discard' ? 0 : 2);
  });

  it.each(['resume', 'discard'] as const)('retains the quota retry source and token through hold %s', async action => {
    const { adapter, buffer, video, events } = await ready(type);
    adapter.appendChunk(type, segment(0), 'track', 20n, {}, 'left'); await flush();
    events.length = 0;
    video.currentTime = 20;
    buffer.buffered = timeRanges([[0, 30]]);
    buffer.autoComplete = false;
    buffer.throwNextAppend = new DOMException('quota', 'QuotaExceededError');
    const retry = {};
    adapter.appendChunk(type, segment(0), 'track', 1n, retry, 'right');
    expect(buffer.removes).toEqual([[0, 19]]);
    const lease = adapter.holdQueuedAppends([type]);
    buffer.autoComplete = true; buffer.complete(); await flush();
    expect(events).toEqual([]);
    lease[action](); lease.resume(); lease.discard(); await flush();
    expect(events).toEqual([{ token: retry, state: action === 'resume' ? 'appended' : 'discarded',
      reason: action === 'resume' ? null : 'retype' }]);
    expect(events[0]!.token).toBe(retry);
    expect(adapter.getCommittedGroupFloor(type, 'track', 'left')).toBe(20n);
    expect(adapter.getCommittedGroupFloor(type, 'track', 'right')).toBe(action === 'resume' ? 1n : undefined);
  });

  it('keeps raw diagnostic labels while source identity survives a name change', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { adapter, events } = await ready(type);
    adapter.appendChunk(type, segment(0), 'original', 20n, {}, 'stable'); await flush();
    adapter.appendChunk(type, segment(50), 'raw display', 20n, {}, 'stable'); await flush();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('on track "raw display"'));
    const stale = {};
    adapter.appendChunk(type, segment(200), 'renamed', 19n, stale, 'stable'); await flush();
    expect(events.at(-1)).toEqual({ token: stale, state: 'discarded', reason: 'stale group' });
    expect(adapter.getCommittedGroupFloor(type, 'renamed', 'stable')).toBe(20n);
  });
});
