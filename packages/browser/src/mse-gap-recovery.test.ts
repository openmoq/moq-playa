import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';
import { SubscriptionManager } from '../../player/src/subscription-manager.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';

let source: MockMediaSource;
beforeEach(() => {
  vi.useFakeTimers(); source = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return source; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:review', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const segment = (pts: number) => buildChunk({ trackId: 1, bmdt: BigInt(pts * 1000),
  samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });
async function ready(gapJumpMs = 2000, options: { reorderWindowMs?: number; maxQueuedChunks?: number } = {}) {
  const video = Object.assign(new MockVideoElement(), { duration: Infinity, ended: false }); video.buffered = makeTimeRanges([[0, 7]]);
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { gapJumpMs, maxAheadSec: Infinity, ...options });
  const reports: unknown[] = [], jumps: unknown[] = [];
  adapter.onStartupReport = report => { reports.push(report); };
  adapter.onGapJump = report => { jumps.push(report); };
  expect(adapter.initialize({ video: { codec: 'avc1.640028', initData: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }) },
    audio: { codec: 'mp4a.40.2', initData: buildInit({ trackId: 2, timescale: 1000, handler: 'soun' }) } })).toBe(true);
  source.open(); await settle();
  source.videoBuffer.buffered = makeTimeRanges([[0, 7]]); source.audioBuffer.buffered = makeTimeRanges([[0, 7]]);
  adapter.setPlaybackIntent(true); adapter.appendChunk('video', segment(0), 'video', 7n); await settle();
  expect(video.playCalls).toBe(1); expect(reports).toHaveLength(1);
  video.seekCount = 0;
  const setHole = () => {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1], [2, 7]]);
    source.audioBuffer.buffered = makeTimeRanges([[0, 7]]);
    video.buffered = makeTimeRanges([[0, 1], [2, 7]]);
  };
  return { adapter, video, jumps, setHole };
}

it('a frozen native video-only hole with audio coverage eventually seeks', async () => {
  const f = await ready();
  try {
    f.setHole(); f.video.advancePlayback(1.4); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.video.seekCount).toBeGreaterThan(0); expect(f.jumps.length).toBeGreaterThan(0);
  } finally { f.adapter.destroy(); }
});

it('preserves accepted finite gap-fill media while its native append is still in flight', async () => {
  const f = await ready();
  try {
    f.setHole(); f.video.advancePlayback(1.4); source.videoBuffer.autoComplete = false;
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(1), 'video', 7n);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1); expect(source.videoBuffer.updating).toBe(true);
    f.adapter.endOfStream();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
    source.videoBuffer.buffered = makeTimeRanges([[0, 7]]); f.video.buffered = makeTimeRanges([[0, 7]]);
    source.videoBuffer.updating = false; source.videoBuffer.fire('update'); source.videoBuffer.fire('updateend'); await settle();
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
  } finally { f.adapter.destroy(); }
});

it('does not seek a healthy advancing video merely because it crosses an old buffered hole', async () => {
  const f = await ready();
  try {
    f.setHole(); f.video.advancePlayback(0.9); f.video.frames = 100; await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.6); f.video.frames = 130; f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.video.getVideoPlaybackQuality().totalVideoFrames).toBe(130);
    f.video.advancePlayback(3.1); f.video.frames = 135; await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['continuous', 'paused', 'disabled'] as const)('does not recover an ineligible hole: %s', async mode => {
  const f = await ready(mode === 'disabled' ? 0 : 2000);
  try {
    if (mode !== 'continuous') f.setHole();
    f.video.advancePlayback(1.4); if (mode === 'paused') f.adapter.setPlaybackIntent(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it('advancing native quality counters veto a video-hole recovery even if the playhead sample is frozen', async () => {
  const f = await ready();
  try {
    f.setHole(); f.video.advancePlayback(1.4); f.video.readyState = 2;
    expect(f.adapter.getVideoPlaybackQuality()?.totalVideoFrames).toBe(100);
    for (let i = 0; i < 8; i++) { f.video.frames += 5; await vi.advanceTimersByTimeAsync(1000); }
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each([true, false])('symmetric holes use combined recovery only with a shared successor: %s', async shared => {
  const f = await ready();
  try {
    f.setHole(); source.audioBuffer.buffered = makeTimeRanges(shared ? [[0, 1], [2, 7]] : [[0, 1]]);
    f.video.advancePlayback(1.4); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.video.seekCount).toBe(shared ? 1 : 0); expect(f.jumps).toHaveLength(shared ? 1 : 0);
  } finally { f.adapter.destroy(); }
});

it('a receiving predecessor uses one bounded append deadline then rejects late old media', async () => {
  const f = await ready();
  try {
    const release = f.adapter.retainReceivingGroup('video', 'video', 7n, () => true);
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(3), 'video', 8n);
    await vi.advanceTimersByTimeAsync(1500);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before);
    f.adapter.endOfStream();
    await vi.advanceTimersByTimeAsync(501);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
    expect(f.adapter.getCommittedGroupFloor('video', 'video')).toBe(8n);
    expect(source.readyState).toBe('ended');
    f.adapter.appendChunk('video', segment(1), 'video', 7n);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
    release(); release();
  } finally { f.adapter.destroy(); }
});

it.each(['release', 'retired'] as const)('%s predecessor evidence returns to the original gap deadline', async mode => {
  const f = await ready();
  try {
    let current = true;
    const release = f.adapter.retainReceivingGroup('video', 'video', 7n, () => current);
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(3), 'video', 8n);
    await vi.advanceTimersByTimeAsync(300);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before);
    if (mode === 'release') release();
    else { current = false; f.adapter.appendChunk('video', segment(4), 'video', 9n); }
    await settle();
    expect(source.videoBuffer.appendedPayloads.length).toBeGreaterThan(before);
    expect(f.adapter.getCommittedGroupFloor('video', 'video')).toBeGreaterThanOrEqual(8n);
  } finally { f.adapter.destroy(); }
});

it('clearing a timeline keeps accepted media and floors but cancels old receiving evidence', async () => {
  const f = await ready();
  try {
    const release = f.adapter.retainReceivingGroup('video', 'video', 7n, () => true);
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(3), 'video', 8n);
    await vi.advanceTimersByTimeAsync(300);
    f.adapter.clearTimeline('video', 'video'); await settle();
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
    expect(f.adapter.getCommittedGroupFloor('video', 'video')).toBe(8n);
    release();
    await vi.advanceTimersByTimeAsync(2500);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
  } finally { f.adapter.destroy(); }
});

it('accepted finite gap fill still queued for timestamp order prevents hole recovery', async () => {
  const f = await ready(2000, { reorderWindowMs: 6000 });
  try {
    f.setHole(); f.video.advancePlayback(1.4); f.video.readyState = 2;
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(2), 'video', 8n);
    f.adapter.endOfStream();
    await vi.advanceTimersByTimeAsync(5000);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before);
    expect(source.readyState).toBe('open');
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['reset', 'retype', 'destroy'] as const)('%s retires receiving evidence and the held timer before late releases', async mode => {
  const f = await ready();
  try {
    const release = f.adapter.retainReceivingGroup('video', 'video', 7n, () => true);
    f.adapter.appendChunk('video', segment(3), 'video', 8n);
    await vi.advanceTimersByTimeAsync(300);
    const before = source.videoBuffer.appendedPayloads.length;
    if (mode === 'destroy') f.adapter.destroy();
    else if (mode === 'retype') await f.adapter.changeType('video', 'avc1.640028', buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }));
    else f.adapter.reset();
    const after = source.videoBuffer.appendedPayloads.length;
    expect(after).toBe(before + (mode === 'retype' ? 1 : 0));
    release(); release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(after);
  } finally { f.adapter.destroy(); }
});

it('receiving metadata admission is bounded independently of accepted native media', async () => {
  const f = await ready(2000, { maxQueuedChunks: 1 });
  try {
    const irrelevant = f.adapter.retainReceivingGroup('video', 'other', 1n, () => true);
    const declined = f.adapter.retainReceivingGroup('video', 'video', 7n, () => true);
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(3), 'video', 8n);
    await vi.advanceTimersByTimeAsync(300);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
    irrelevant(); declined();
  } finally { f.adapter.destroy(); }
});

it('the wedge ladder also preserves an accepted finite append still updating', async () => {
  const f = await ready();
  try {
    f.video.advancePlayback(1.4);
    source.videoBuffer.autoComplete = false;
    f.adapter.appendChunk('video', segment(1), 'video', 7n);
    expect(source.videoBuffer.updating).toBe(true);
    f.adapter.endOfStream();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it('an expired older stream cannot hold later gaps after its group is below the committed floor', async () => {
  const f = await ready();
  try {
    const release = f.adapter.retainReceivingGroup('video', 'video', 7n, () => true);
    f.adapter.appendChunk('video', segment(3), 'video', 8n);
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.adapter.getCommittedGroupFloor('video', 'video')).toBe(8n);
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(5), 'video', 9n);
    await vi.advanceTimersByTimeAsync(300);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
    release();
  } finally { f.adapter.destroy(); }
});

it.each(['single hop', 'sampled inside hole', 'advances after crossing', 'healthy output', 'disabled', 'disabled ordinary wedge'] as const)(
  'observed post-hole freeze recovery: %s', async mode => {
    const f = await ready(mode.startsWith('disabled') ? 0 : 2000);
    const rungs: number[] = [];
    f.adapter.onWedge = info => { rungs.push(info.rung); };
    try {
      f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
      if (mode === 'sampled inside hole') {
        f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
      }
      f.video.advancePlayback(2.6); f.video.readyState = mode === 'disabled ordinary wedge' ? 3 : 2;
      await vi.advanceTimersByTimeAsync(1000);
      if (mode === 'advances after crossing' || mode === 'healthy output') {
        if (mode === 'healthy output') f.video.frames += 8;
        f.video.advancePlayback(3.1); await vi.advanceTimersByTimeAsync(1000);
      }
      await vi.advanceTimersByTimeAsync(5000);
      expect(rungs).toEqual(mode === 'healthy output' || mode === 'disabled' ? [] : [1]);
      expect(f.jumps).toHaveLength(0);
    } finally { f.adapter.destroy(); }
  });

it.each(['entry only', 'entry and crossing', 'later successor progress'] as const)(
  'counter progress during entry/crossing stays potential until a later successor interval: %s', async progress => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.frames += 5; f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
    expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0);
    if (progress !== 'entry only') f.video.frames += 5;
    f.video.advancePlayback(2.6); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0);
    if (progress === 'later successor progress') {
      f.video.frames += 5; f.video.advancePlayback(3.1); await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(rungs).toEqual(progress === 'later successor progress' ? [] : [1]); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['one-hop', 'inside-then-cross', 'healthy-upper-progress', 'retired-remains-retired'] as const)(
  'crossing-interval counter progress keeps only potential traversal: %s', async mode => {
    const f = await ready(), rungs: number[] = [];
    f.adapter.onWedge = info => { rungs.push(info.rung); };
    try {
      f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
      if (mode === 'inside-then-cross') {
        f.video.frames = 102; f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
      }
      f.video.frames = 105; f.video.advancePlayback(2.6); f.video.readyState = 2;
      await vi.advanceTimersByTimeAsync(1000);
      expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0);
      if (mode === 'healthy-upper-progress' || mode === 'retired-remains-retired') f.video.frames = 110;
      f.video.advancePlayback(3.1); await vi.advanceTimersByTimeAsync(1000);
      if (mode === 'retired-remains-retired') {
        f.video.advancePlayback(3.5); await vi.advanceTimersByTimeAsync(1000);
      }
      await vi.advanceTimersByTimeAsync(5000);
      expect(rungs).toEqual(mode === 'one-hop' || mode === 'inside-then-cross' ? [1] : []);
      expect(f.jumps).toHaveLength(0);
    } finally { f.adapter.destroy(); }
  });

it.each(['counter reset', 'no observed entry'] as const)('%s cannot inherit a crossing-interval witness', async boundary => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(boundary === 'counter reset' ? 0.9 : 2.4);
    await vi.advanceTimersByTimeAsync(1000);
    f.video.frames = 105; f.video.advancePlayback(2.6); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(1000);
    if (boundary === 'counter reset') f.video.frames = 95;
    f.video.advancePlayback(3.1); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(3.5); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['on entry', 'before entry'] as const)('a quality-counter reset %s invalidates the prior crossing sample', async when => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.frames = 95;
    if (when === 'on entry') f.video.advancePlayback(1.4);
    await vi.advanceTimersByTimeAsync(1000);
    if (when === 'before entry') {
      f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
    }
    f.video.advancePlayback(2.6); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(6000);
    expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['none', 'audio', 'video'] as const)('completed %s appends preserve an unchanged post-hole witness', async role => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.6); f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
    if (role !== 'none') {
      const buffer = role === 'audio' ? source.audioBuffer : source.videoBuffer;
      const before = buffer.appendedPayloads.length;
      const chunk = role === 'video' ? segment(7) : buildChunk({ trackId: 2, bmdt: 3000n,
        samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });
      f.adapter.appendChunk(role, chunk, role, 7n);
      await vi.advanceTimersByTimeAsync(300); await settle();
      expect(buffer.appendedPayloads).toHaveLength(before + 1);
      expect(buffer.updating).toBe(false);
      if (role === 'video') {
        source.videoBuffer.buffered = makeTimeRanges([[0, 1], [2, 8]]);
        f.video.buffered = makeTimeRanges([[0, 1], [2, 8]]);
      }
    }
    f.video.advancePlayback(3.1); await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(rungs).toEqual([1]); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['audio', 'video'] as const)('pending %s appends veto recovery until settlement without erasing an unchanged hole', async role => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.6); f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
    const buffer = role === 'audio' ? source.audioBuffer : source.videoBuffer;
    buffer.autoComplete = false;
    const before = buffer.appendedPayloads.length;
    const chunk = role === 'video' ? segment(7) : buildChunk({ trackId: 2, bmdt: 3000n,
      samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });
    f.adapter.appendChunk(role, chunk, role, 7n);
    await vi.advanceTimersByTimeAsync(300);
    expect(buffer.appendedPayloads).toHaveLength(before + 1); expect(buffer.updating).toBe(true);
    f.video.advancePlayback(3.1); await vi.advanceTimersByTimeAsync(6000);
    expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0);
    if (role === 'video') {
      source.videoBuffer.buffered = makeTimeRanges([[0, 1], [2, 8]]);
      f.video.buffered = makeTimeRanges([[0, 1], [2, 8]]);
    }
    buffer.updating = false; buffer.fire('update'); buffer.fire('updateend'); await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rungs).toEqual([1]); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['frames', 'pause/resume', 'filled hole', 'changed hole', 'clear', 'retype', 'reset'] as const)(
  '%s retires an observed post-hole witness before a later freeze', async boundary => {
    const f = await ready(), rungs: number[] = [];
    f.adapter.onWedge = info => { rungs.push(info.rung); };
    try {
      f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
      f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
      f.video.advancePlayback(2.6); f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
      if (boundary === 'frames') {
        f.video.frames += 5;
        f.video.advancePlayback(3.1); await vi.advanceTimersByTimeAsync(1000);
      } else if (boundary === 'pause/resume') {
        const before = f.video.playCalls;
        f.adapter.setPlaybackIntent(false); expect(f.video.paused).toBe(true);
        f.adapter.setPlaybackIntent(true); await settle();
        expect(f.video.playCalls).toBe(before + 1); expect(f.video.paused).toBe(false);
      } else if (boundary === 'filled hole') {
        const before = source.videoBuffer.appendedPayloads.length;
        f.adapter.appendChunk('video', segment(1), 'video', 7n); await settle();
        expect(source.videoBuffer.appendedPayloads).toHaveLength(before + 1);
        expect(source.videoBuffer.updating).toBe(false);
        source.videoBuffer.buffered = makeTimeRanges([[0, 7]]);
        f.video.buffered = makeTimeRanges([[0, 7]]);
      } else if (boundary === 'changed hole') {
        source.videoBuffer.buffered = makeTimeRanges([[0, 1.5], [2, 7]]);
        f.video.buffered = makeTimeRanges([[0, 1.5], [2, 7]]);
      } else if (boundary === 'clear') f.adapter.clearTimeline('video', 'video');
      else if (boundary === 'retype') {
        await f.adapter.changeType('video', 'avc1.640028', buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }));
      } else {
        const oldBuffer = source.videoBuffer;
        f.adapter.reset();
        expect(f.adapter.initialize({
          video: { codec: 'avc1.640028', initData: buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }) },
          audio: { codec: 'mp4a.40.2', initData: buildInit({ trackId: 2, timescale: 1000, handler: 'soun' }) },
        })).toBe(true);
        await settle(); expect(source.videoBuffer).not.toBe(oldBuffer);
        f.setHole();
      }
      await vi.advanceTimersByTimeAsync(6000);
      expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
    } finally { f.adapter.destroy(); }
  });

it.each(['progress', 'quality', 'historical', 'pending'] as const)('post-hole recovery refuses %s without a continuing frozen crossing witness', async mode => {
  const f = await ready();
  const rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(mode === 'historical' ? 2.4 : 0.9);
    await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.6); f.video.readyState = 2;
    if (mode === 'pending') {
      source.videoBuffer.autoComplete = false;
      f.adapter.appendChunk('video', segment(1), 'video', 7n);
    }
    for (let i = 0; i < 6; i++) {
      if (mode === 'progress') f.video.advancePlayback(2.6 + i * 0.1);
      if (mode === 'quality') f.video.frames += 5;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

it.each(['alias reuse', 'connection replacement'] as const)('%s cannot inherit the former receiving registration', async mode => {
  const f = await ready();
  try {
    const manager = new SubscriptionManager(), oldConnection = {}, nextConnection = {};
    manager.registerTrack(10n, 'video', 'video', 'cmaf', { sourceConnection: oldConnection, namespace: ['old', 'camera'] });
    const captured = manager.captureRoute(10n)!;
    const release = f.adapter.retainReceivingGroup('video', 'video', 7n, captured);
    const before = source.videoBuffer.appendedPayloads.length;
    f.adapter.appendChunk('video', segment(3), 'video', 8n);
    await vi.advanceTimersByTimeAsync(300);
    expect(source.videoBuffer.appendedPayloads).toHaveLength(before);
    manager.registerTrack(10n, 'video', 'video', 'cmaf', {
      sourceConnection: mode === 'alias reuse' ? oldConnection : nextConnection, namespace: ['new', 'camera'],
    });
    expect(captured()).toBe(false);
    f.adapter.appendChunk('video', segment(4), 'video', 9n); await settle();
    expect(source.videoBuffer.appendedPayloads.length).toBeGreaterThan(before);
    release();
  } finally { f.adapter.destroy(); }
});

it('a user seek settled between samples cannot fabricate a post-hole crossing', async () => {
  const f = await ready(); const rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.fire('seeking'); f.video.advancePlayback(2.6); f.video.readyState = 2; f.video.fire('seeked');
    await vi.advanceTimersByTimeAsync(6000);
    expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0);
  } finally { f.adapter.destroy(); }
});

it.each([true, false])('owned asynchronous seeks (settles: %s) retain the post-hole witness through all bounded wedge rungs', async settles => {
  const f = await ready(); const rungs: number[] = [], errors: Error[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  f.adapter.onError = error => { errors.push(error); };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.modelSeekLifecycle = true; f.video.autoFireSeeked = settles;
    f.video.advancePlayback(2.6); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(15000);
    expect(rungs).toEqual([1, 2, 3, 4]);
    expect(errors.map(error => error.name)).toEqual(['PlayheadWedgeError']);
  } finally { f.adapter.destroy(); }
});
