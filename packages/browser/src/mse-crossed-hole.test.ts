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

it.each([false, true])('recovers a frozen crossed wide hole in place after observation (sample inside: %s)', async inside => {
  const f = await ready();
  try {
    await f.cross(inside);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBe(3.9);
    expect(f.rungs).toEqual([1]); expect(f.jumps).toEqual([]); expect(f.errors).toEqual([]);
  } finally { f.adapter.destroy(); }
});

it('never seeks into or over an untraversed wide hole', async () => {
  const f = await ready();
  try {
    f.hole(); f.video.advancePlayback(1.4); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toEqual([]);
    expect(f.errors.map(error => error.name)).toEqual(['MediaGapUnrecoverableError']);
  } finally { f.adapter.destroy(); }
});

it('preserves narrow post-hole recovery through the existing wedge ladder', async () => {
  const f = await ready();
  try {
    f.hole(2); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.6); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBeCloseTo(2.7);
    expect(f.rungs).toEqual([1]); expect(f.jumps).toEqual([]);
  } finally { f.adapter.destroy(); }
});

it.each([true, false])('bounds an unsuccessful same-position seek without a forward retry (settles: %s)', async settles => {
  const f = await ready();
  try {
    await f.cross(); f.video.autoFireSeeked = settles;
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBe(3.9);
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.rungs).toEqual([1]); expect(f.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.rungs).toEqual([1, 4]); expect(f.video.seekCount).toBe(1);
    expect(f.errors.map(error => error.name)).toEqual(['PlayheadWedgeError']);
    expect(f.errors[0]!.message).toContain('same-position seek');
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.errors).toHaveLength(1); expect(f.video.currentTime).toBe(3.9);
    expect(f.video.pauseCalls).toBe(0); expect(f.jumps).toEqual([]);
  } finally { f.adapter.destroy(); }
});

it('shares the five-second seek spacing with the ordinary gap jump', async () => {
  const f = await ready();
  try {
    await f.cross(); await vi.advanceTimersByTimeAsync(4000);
    expect(f.video.seekCount).toBe(1);
    source.videoBuffer.buffered = makeTimeRanges([[0, 1], [3.5, 6], [7, 12]]);
    source.audioBuffer.buffered = makeTimeRanges([[0, 6], [7, 12]]);
    f.video.buffered = source.videoBuffer.buffered;
    f.video.advancePlayback(5.95);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.video.seekCount).toBe(1); expect(f.jumps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.video.seekCount).toBe(2); expect(f.jumps).toHaveLength(1);
    expect(f.video.currentTime).toBeCloseTo(7.01);
  } finally { f.adapter.destroy(); }
});

it.each(['frames', 'clock', 'seek', 'pause', 'filled', 'changed', 'quality unavailable', 'ended', 'error'] as const)(
  '%s invalidates or vetoes a wide-hole freeze', async boundary => {
    const f = await ready();
    try {
      await f.cross();
      if (boundary === 'seek') { f.video.currentTime = 4; await settle(); f.video.seekCount = 0; }
      else if (boundary === 'pause') { f.adapter.setPlaybackIntent(false); f.adapter.setPlaybackIntent(true); await settle(); }
      else if (boundary === 'filled') { source.videoBuffer.buffered = makeTimeRanges([[0, 12]]); f.video.buffered = source.videoBuffer.buffered; }
      else if (boundary === 'changed') { source.videoBuffer.buffered = makeTimeRanges([[0, 1.5], [3.5, 12]]); f.video.buffered = source.videoBuffer.buffered; }
      else if (boundary === 'quality unavailable') vi.spyOn(f.adapter, 'getVideoPlaybackQuality').mockReturnValue(null);
      else if (boundary === 'ended') Object.defineProperty(f.video, 'ended', { value: true });
      else if (boundary === 'error') f.video.error = { code: 3, message: 'decode error' };
      for (let i = 0; i < 8; i++) {
        if (boundary === 'frames') f.video.frames += 5;
        if (boundary === 'clock') f.video.advancePlayback(4 + i * 0.1);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]); expect(f.errors).toEqual([]);
    } finally { f.adapter.destroy(); }
  });

it.each(['absent', 'not covered', 'short ahead'] as const)('requires native audio at the target: %s', async audio => {
  const f = await ready({}, audio !== 'absent');
  try {
    await f.cross();
    if (audio === 'not covered') source.audioBuffer.buffered = makeTimeRanges([[0, 3.8], [5, 12]]);
    if (audio === 'short ahead') source.audioBuffer.buffered = makeTimeRanges([[0, 4]]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]);
  } finally { f.adapter.destroy(); }
});

it.each([0, 1, 3])('respects native readiness %s without using a forward nudge for a wide crossing', async readiness => {
  const f = await ready();
  try {
    await f.cross(); f.video.readyState = readiness;
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.video.seekCount).toBe(readiness === 3 ? 1 : 0);
    expect(f.video.currentTime).toBe(3.9);
  } finally { f.adapter.destroy(); }
});

it('does not inherit an unobserved wide crossing or recover with gap recovery disabled', async () => {
  for (const mode of ['unobserved', 'disabled'] as const) {
    const f = await ready(mode === 'disabled' ? { gapJumpMs: 0 } : {});
    try {
      if (mode === 'disabled') await f.cross();
      else { f.hole(); f.video.advancePlayback(3.9); f.video.readyState = 2; }
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]);
    } finally { f.adapter.destroy(); }
  }
});

it.each(['audio', 'video'] as const)('preserves an accepted %s append until native completion before a fresh wait', async role => {
  const f = await ready();
  try {
    await f.cross();
    const buffer = role === 'audio' ? source.audioBuffer : source.videoBuffer;
    buffer.autoComplete = false;
    const before = buffer.appendedPayloads.length;
    f.adapter.appendChunk(role, segment(4, role), role, 7n); f.adapter.endOfStream();
    await vi.advanceTimersByTimeAsync(5000);
    expect(buffer.appendedPayloads).toHaveLength(before + 1); expect(buffer.updating).toBe(true);
    expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]);
    buffer.updating = false; buffer.fire('update'); buffer.fire('updateend'); await settle();
    expect(source.readyState).toBe('ended'); // Buffered finite media is still playable before element.ended.
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.video.seekCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBe(3.9);
  } finally { f.adapter.destroy(); }
});

it('does not recover while accepted media is retained for append ordering', async () => {
  const f = await ready({ reorderWindowMs: 20000 });
  try {
    await f.cross();
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(4), 'video', 8n); f.adapter.endOfStream();
    await vi.advanceTimersByTimeAsync(10000);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before);
    expect(source.readyState).toBe('open'); expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]);
  } finally { f.adapter.destroy(); }
});

it('a queue owner with no native work still blocks recovery and restarts observation on release', async () => {
  const f = await ready();
  try {
    await f.cross(); const held = f.adapter.holdQueuedAppends(['video', 'audio']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]);
    held.resume(); await vi.advanceTimersByTimeAsync(3000);
    expect(f.video.seekCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBe(3.9);
  } finally { f.adapter.destroy(); }
});

it.each(['video', 'audio'] as const)('a %s retype retires the old wide-hole witness', async role => {
  const f = await ready();
  try {
    await f.cross();
    await f.adapter.changeType(role, role === 'video' ? 'avc1.640028' : 'mp4a.40.2', init(role));
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]);
  } finally { f.adapter.destroy(); }
});

it.each(['frames', 'audio target', 'append', 'retype', 'ended'] as const)('revalidates %s after the diagnostic callback', async action => {
  const f = await ready();
  try {
    await f.cross();
    f.adapter.onWedge = () => {
      if (action === 'frames') f.video.frames += 5;
      else if (action === 'audio target') source.audioBuffer.buffered = makeTimeRanges([[0, 3.8]]);
      else if (action === 'ended') Object.defineProperty(f.video, 'ended', { value: true });
      else if (action === 'retype') void f.adapter.changeType('video', 'avc1.640028', init('video'));
      else { source.audioBuffer.autoComplete = false; f.adapter.appendChunk('audio', segment(0, 'audio'), 'audio', 7n); }
    };
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.video.seekCount).toBe(0); expect(f.errors).toEqual([]);
    if (action === 'append') {
      f.adapter.onWedge = info => { f.rungs.push(info.rung); };
      source.audioBuffer.updating = false; source.audioBuffer.fire('update'); source.audioBuffer.fire('updateend'); await settle();
      await vi.advanceTimersByTimeAsync(4000);
      expect(f.video.seekCount).toBe(1); expect(f.rungs).toEqual([1]);
    }
  } finally { f.adapter.destroy(); }
});

it.each([false, true])('recovers when the successor range arrives after leaving the earlier range (already frozen: %s)', async frozen => {
  const f = await ready();
  try {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1]]);
    f.video.buffered = source.videoBuffer.buffered;
    f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
    if (frozen) {
      f.video.advancePlayback(3.9); f.video.readyState = 2;
      await vi.advanceTimersByTimeAsync(1000);
    }
    f.hole();
    if (!frozen) {
      f.video.advancePlayback(2.4); await vi.advanceTimersByTimeAsync(1000);
      f.video.advancePlayback(3.9); f.video.readyState = 2;
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.video.seekCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.video.seekCount).toBe(1);
    expect(f.video.currentTime).toBe(3.9);
    expect(f.rungs).toEqual([1]); expect(f.jumps).toEqual([]); expect(f.errors).toEqual([]);
  } finally { f.adapter.destroy(); }
});

it.each(['seek', 'pause', 'native pause', 'healthy frames'] as const)('does not reuse late-range evidence across %s', async boundary => {
  const f = await ready();
  try {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1]]);
    f.video.buffered = source.videoBuffer.buffered;
    f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
    if (boundary === 'seek') { f.video.currentTime = 3.9; await settle(); f.video.seekCount = 0; }
    else if (boundary === 'pause') { f.adapter.setPlaybackIntent(false); f.adapter.setPlaybackIntent(true); await settle(); }
    else if (boundary === 'native pause') { f.video.pause(); f.video.fire('pause'); await f.video.play(); }
    f.hole();
    f.video.advancePlayback(3.9); f.video.readyState = 2;
    if (boundary === 'healthy frames') {
      f.video.frames++; await vi.advanceTimersByTimeAsync(1000);
      f.video.advancePlayback(4.9); f.video.frames++; await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(8000);
    expect(f.video.paused).toBe(false);
    expect(f.video.seekCount).toBe(0); expect(f.rungs).toEqual([]); expect(f.errors).toEqual([]);
  } finally { f.adapter.destroy(); }
});
