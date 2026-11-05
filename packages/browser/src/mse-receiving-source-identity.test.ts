import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';

const name = 'video';
const keyA = JSON.stringify([['camera', 'a'], name]);
const keyB = JSON.stringify([['camera', 'b'], name]);
let source: MockMediaSource;
beforeEach(() => {
  vi.useFakeTimers(); source = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return source; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:identity', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
const segment = (seconds: number) => buildChunk({ trackId: 1, bmdt: BigInt(seconds * 1000),
  samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });
async function ready(key: string) {
  const video = new MockVideoElement(); video.buffered = makeTimeRanges([[0, 7]]);
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { maxAheadSec: Infinity });
  expect(adapter.initialize({ video: { codec: 'avc1.640028', initData: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }) } })).toBe(true);
  source.open(); await settle(); source.videoBuffer.buffered = makeTimeRanges([[0, 7]]);
  adapter.appendChunk('video', segment(0), name, 100n, undefined, key); await settle();
  expect(adapter.getCommittedGroupFloor('video', name, key)).toBe(100n);
  video.seekCount = 0;
  return { adapter, video, before: source.videoBuffer.appendedPayloads.length };
}

it('receiving evidence from the same bare name in another namespace cannot extend this source gap', async () => {
  const f = await ready(keyB);
  try {
    const release = f.adapter.retainReceivingGroup('video', name, 100n, () => true, keyA);
    f.adapter.appendChunk('video', segment(3), name, 101n, undefined, keyB);
    await vi.advanceTimersByTimeAsync(350);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(f.before + 1);
    expect(f.adapter.getCommittedGroupFloor('video', name, keyB)).toBe(101n);
    expect(f.adapter.getCommittedGroupFloor('video', name, keyA)).toBeUndefined();
    release();
  } finally { f.adapter.destroy(); }
});

it('clearing another namespace with the same bare name preserves this source receiving deadline and accepted queue', async () => {
  const f = await ready(keyA);
  try {
    const release = f.adapter.retainReceivingGroup('video', name, 100n, () => true, keyA);
    f.adapter.appendChunk('video', segment(3), name, 101n, undefined, keyA);
    await vi.advanceTimersByTimeAsync(300);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(f.before);
    f.adapter.clearTimeline('video', name, keyB); await settle();
    expect(source.videoBuffer.appendedPayloads).toHaveLength(f.before);
    expect(f.adapter.getCommittedGroupFloor('video', name, keyA)).toBe(100n);
    f.adapter.clearTimeline('video', name, keyA); await settle();
    expect(source.videoBuffer.appendedPayloads).toHaveLength(f.before + 1);
    expect(f.adapter.getCommittedGroupFloor('video', name, keyA)).toBe(101n);
    release();
  } finally { f.adapter.destroy(); }
});

it('accepted keyed gap fill in flight survives selection queue ownership and vetoes hole recovery', async () => {
  const f = await ready(keyA); const jumps: unknown[] = [];
  f.adapter.onGapJump = jump => { jumps.push(jump); };
  try {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1], [2, 7]]);
    f.video.buffered = makeTimeRanges([[0, 1], [2, 7]]); f.video.advancePlayback(1.4); f.video.readyState = 2;
    source.videoBuffer.autoComplete = false;
    f.adapter.appendChunk('video', segment(1), name, 100n, undefined, keyA);
    expect(source.videoBuffer.updating).toBe(true);
    const lease = f.adapter.holdQueuedAppends(['video']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(lease.current).toBe(true); expect(source.videoBuffer.appendedPayloads).toHaveLength(f.before + 1);
    expect(f.video.seekCount).toBe(0); expect(jumps).toEqual([]);
    expect(source.videoBuffer.updating).toBe(true);
    source.videoBuffer.buffered = makeTimeRanges([[0, 7]]); f.video.buffered = makeTimeRanges([[0, 7]]);
    source.videoBuffer.updating = false; source.videoBuffer.fire('update'); source.videoBuffer.fire('updateend'); await settle();
    expect(lease.current).toBe(true); lease.resume(); await settle();
    expect(source.videoBuffer.appendedPayloads).toHaveLength(f.before + 1);
    expect(f.video.seekCount).toBe(0);
  } finally { f.adapter.destroy(); }
});
