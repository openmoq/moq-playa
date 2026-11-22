import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MseMediaSource, type MseMediaSourceOptions } from './mse-adapter.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';

let source: MockMediaSource;
beforeEach(() => {
  vi.useFakeTimers(); source = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return source; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:crossed-hole', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const init = (role: 'video' | 'audio') => buildInit({ trackId: role === 'video' ? 1 : 2,
  timescale: 1000, handler: role === 'video' ? 'vide' : 'soun' });
const segment = (pts: number, role: 'video' | 'audio' = 'video') => buildChunk({
  trackId: role === 'video' ? 1 : 2, bmdt: BigInt(pts * 1000),
  samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4),
});

async function ready(options: MseMediaSourceOptions = {}, audio = true) {
  const video = new MockVideoElement(); video.buffered = makeTimeRanges([[0, 12]]);
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { maxAheadSec: Infinity, ...options });
  const rungs: number[] = [], jumps: unknown[] = [], errors: Error[] = [];
  adapter.onWedge = info => { rungs.push(info.rung); };
  adapter.onGapJump = info => { jumps.push(info); };
  adapter.onError = error => { errors.push(error); };
  expect(adapter.initialize({ video: { codec: 'avc1.640028', initData: init('video') },
    ...(audio ? { audio: { codec: 'mp4a.40.2', initData: init('audio') } } : {}) })).toBe(true);
  source.open(); await settle();
  source.videoBuffer.buffered = makeTimeRanges([[0, 12]]);
  source.audioBuffer.buffered = makeTimeRanges([[0, 12]]);
  adapter.setPlaybackIntent(true); adapter.appendChunk('video', segment(0), 'video', 7n); await settle();
  expect(video.playCalls).toBe(1); video.seekCount = 0;
  video.modelSeekLifecycle = true;
  const hole = (start = 3.5) => {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1], [start, 12]]);
    video.buffered = makeTimeRanges([[0, 1], [start, 12]]);
  };
  const cross = async (sampleInside = false) => {
    hole(); video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    if (sampleInside) { video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000); }
    video.advancePlayback(3.9); video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
  };
  return { adapter, video, rungs, jumps, errors, hole, cross };
}


// Modeled native buffers: coverage returns after one thin sample.
it.each([true, false])('retains a crossed-hole witness through thin coverage only while work is pending=%s', async pendingDuringThin => {
  const f = await ready();
  try {
    await f.cross();
    let pending = false;
    (f.adapter as unknown as { hasPendingNativeWork(): boolean }).hasPendingNativeWork = () => pending;
    source.audioBuffer.buffered = makeTimeRanges([[0, 4.5]]);   // under 1 s of audio ahead of 3.9
    pending = pendingDuringThin;
    await vi.advanceTimersByTimeAsync(1000);                      // one check sees thin coverage
    pending = false;
    source.audioBuffer.buffered = makeTimeRanges([[0, 12]]);    // the in-flight append landed
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.rungs).toEqual(pendingDuringThin ? [1] : []);
    expect(f.video.seekCount).toBe(pendingDuringThin ? 1 : 0);
    expect(f.video.currentTime).toBe(3.9);
    expect(f.errors).toEqual([]);
  } finally { f.adapter.destroy(); }
});
