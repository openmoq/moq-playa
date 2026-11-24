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

it.each(['frames', 'pause/resume', 'filled hole', 'changed hole', 'clear', 'reset'] as const)(
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
      else {
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

// Consecutive downshifts: the first switch leaves a narrow video-only hole
// that the audio clock carries the playhead through, video stays frozen just
// past it at readyState 2, and the next switch retypes to another H.264
// profile. The retype keeps the buffered frames, so the witnessed narrow hole
// still stands and the frozen playhead is still recovered.
it.each(['avc1.640028', 'avc1.4d401e'])('a video retype to %s keeps an observed narrow post-hole witness', async codec => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.6); f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
    await f.adapter.changeType('video', codec, buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(rungs[0]).toBe(1);
    expect(f.video.seekCount).toBeGreaterThan(0);
  } finally { f.adapter.destroy(); }
});

// The audio clock carries the playhead to the end of the buffered video before
// it freezes, so the first frozen sample sees less than a second ahead. Thin
// coverage holds recovery off without retiring the witness; recovery arms once
// the live range grows past the threshold.
it('a narrow post-hole witness survives a frozen sample with thin forward video', async () => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  const ranges = (videoEnd: number, audioEnd: number) => {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1], [2, videoEnd]]);
    source.audioBuffer.buffered = makeTimeRanges([[0, audioEnd]]);
    f.video.buffered = makeTimeRanges([[0, 1], [2, Math.min(videoEnd, audioEnd)]]);
  };
  try {
    f.setHole(); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.6); await vi.advanceTimersByTimeAsync(1000);
    ranges(6.6, 7); f.video.advancePlayback(6.3); await vi.advanceTimersByTimeAsync(1000);
    f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
    expect(rungs).toEqual([]);
    ranges(9, 9.5);
    await vi.advanceTimersByTimeAsync(6000);
    expect(rungs[0]).toBe(1);
    expect(f.video.seekCount).toBeGreaterThan(0);
    expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

// Two downshifts in quick succession leave two narrow video holes back to
// back. The audio clock carries the playhead across both at full readiness,
// and the short range between them can pass between two samples, so no
// sample sees the playhead in the range just below the later hole. The
// crossing is still witnessed from the last covered point before the first
// hole, when every hole crossed since is narrow and audio covered the span.
it.each([
  ['narrow then narrow', [[0, 1], [1.3, 1.9]], true],
  ['wide then narrow', [[0, 1], [3.3, 3.9]], false],
] as const)('a crossing of chained holes (%s) is witnessed from the last covered point', async (_name, lower, acts) => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  const top = lower[1][1] + 0.3;
  const ranges = (videoEnd: number) => {
    const video: Array<[number, number]> = [[lower[0][0], lower[0][1]], [lower[1][0], lower[1][1]], [top, videoEnd]];
    source.videoBuffer.buffered = makeTimeRanges(video);
    source.audioBuffer.buffered = makeTimeRanges([[0, videoEnd + 0.5]]);
    f.video.buffered = makeTimeRanges(video);
  };
  try {
    ranges(top + 1); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(lower[1][1] + 0.1); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(top + 0.6); await vi.advanceTimersByTimeAsync(1000);
    f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
    expect(rungs).toEqual([]);
    ranges(top + 4);
    await vi.advanceTimersByTimeAsync(6000);
    if (acts) { expect(rungs[0]).toBe(1); expect(f.video.seekCount).toBeGreaterThan(0); }
    else expect(rungs).toEqual([]);
    expect(f.jumps).toHaveLength(0);
  } finally { f.adapter.destroy(); }
});

// A switch during startup can leave one hole wider than the jump bound. The
// audio clock carries the playhead across it and on into the upper range,
// where it freezes with under a second of video ahead. Thin coverage holds
// recovery off without retiring the witness, as for a narrow hole.
it('a witnessed wide-hole crossing survives a frozen sample with thin forward video', async () => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  const ranges = (videoEnd: number) => {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1], [3.4, videoEnd]]);
    source.audioBuffer.buffered = makeTimeRanges([[0, videoEnd + 0.5]]);
    f.video.buffered = makeTimeRanges([[0, 1], [3.4, videoEnd]]);
  };
  try {
    ranges(4.4); f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(1.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(3.8); await vi.advanceTimersByTimeAsync(1000);
    f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
    expect(rungs).toEqual([]);
    ranges(9);
    await vi.advanceTimersByTimeAsync(8000);
    expect(rungs[0]).toBe(1);
    expect(f.video.seekCount).toBeGreaterThan(0);
  } finally { f.adapter.destroy(); }
});

// A later downshift can leave a second narrow video hole just under a second
// past where the clock stopped. The capped range must not hold recovery off
// for good: media past a hole within the jump bound counts as coverage, as
// long as the playhead stays outside the gap-jump edge window. Inside that
// window the gap-jump owns recovery. A wider later hole does not count.
it.each(['narrow', 'no nudge room', 'wide'] as const)('a frozen playhead before a later %s hole', async mode => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  const capEnd = mode === 'no nudge room' ? 3.6 : 4.5, nextStart = mode === 'wide' ? 7 : capEnd + 0.5;
  const ranges: Array<[number, number]> = [[0, 1], [2, capEnd], [nextStart, 14]];
  source.videoBuffer.buffered = makeTimeRanges(ranges);
  source.audioBuffer.buffered = makeTimeRanges([[0, 14]]);
  f.video.buffered = makeTimeRanges(ranges);
  try {
    f.video.advancePlayback(0.9); f.video.frames += 30; await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(2.1); f.video.frames += 30; await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(3.508); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(6000);
    if (mode === 'narrow') {
      expect(rungs[0]).toBe(1); expect(f.video.seekCount).toBeGreaterThan(0);
      expect(f.video.currentTime).toBeLessThan(capEnd); expect(f.jumps).toHaveLength(0);
    } else if (mode === 'no nudge room') {
      expect(rungs).toEqual([]); expect(f.jumps).toHaveLength(1);
    } else {
      expect(rungs).toEqual([]); expect(f.video.seekCount).toBe(0); expect(f.jumps).toHaveLength(0);
    }
  } finally { f.adapter.destroy(); }
});

// A frozen playhead inside the edge window belongs to the gap-jump even
// when media beyond a narrow hole would otherwise qualify it for a wedge.
it.each([5000, 8000])('a frozen playhead before a combined hole waits for the %d ms gap-jump', async gapJumpMs => {
  const f = await ready(gapJumpMs), rungs: number[] = [], errors: Error[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  f.adapter.onError = error => { errors.push(error); };
  try {
    const ranges: Array<[number, number]> = [[0, 4.3], [4.8, 14]];
    source.videoBuffer.buffered = makeTimeRanges(ranges);
    source.audioBuffer.buffered = makeTimeRanges(ranges);
    f.video.buffered = makeTimeRanges(ranges); f.video.modelSeekLifecycle = true;
    f.video.advancePlayback(3); f.video.frames += 30; await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(4); f.video.frames += 30; await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 16 && f.jumps.length === 0 && errors.length === 0; i++) await vi.advanceTimersByTimeAsync(1000);
    expect.soft(rungs).toEqual([]); expect.soft(errors).toEqual([]); expect(f.jumps).toHaveLength(1);
  } finally { f.adapter.destroy(); }
});

it('a witnessed post-hole freeze before a later hole waits for the gap-jump', async () => {
  const f = await ready(4000), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    const ranges: Array<[number, number]> = [[0, 1], [2, 4.3], [4.8, 14]];
    source.videoBuffer.buffered = makeTimeRanges(ranges);
    source.audioBuffer.buffered = makeTimeRanges([[0, 14]]);
    f.video.buffered = makeTimeRanges(ranges); f.video.modelSeekLifecycle = true;
    f.video.advancePlayback(0.9); f.video.frames += 30; await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(4); f.video.readyState = 2; await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 12 && f.jumps.length === 0; i++) await vi.advanceTimersByTimeAsync(1000);
    expect.soft(rungs).toEqual([]); expect(f.jumps).toHaveLength(1);
  } finally { f.adapter.destroy(); }
});

// A switch commit can retype (a prefetched init is applied even for the same
// codec) after the playhead has run past the old video but before the new
// rendition's first range lands. The retype keeps the coded frames, so the
// covered position observed before the hole still anchors the late witness.
it.each(['avc1.640028', 'avc1.4d401e'])('a retype to %s before the upper range lands keeps the covered position', async codec => {
  const f = await ready(), rungs: number[] = [];
  f.adapter.onWedge = info => { rungs.push(info.rung); };
  try {
    source.videoBuffer.buffered = makeTimeRanges([[0, 1]]);
    source.audioBuffer.buffered = makeTimeRanges([[0, 7]]);
    f.video.buffered = makeTimeRanges([[0, 1]]);
    f.video.advancePlayback(0.9); await vi.advanceTimersByTimeAsync(1000);
    f.video.advancePlayback(1.4); await vi.advanceTimersByTimeAsync(1000);
    await f.adapter.changeType('video', codec, buildInit({ trackId: 1, timescale: 1000, handler: 'vide' }));
    f.setHole(); f.video.advancePlayback(2.6); await vi.advanceTimersByTimeAsync(1000);
    f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(6000);
    expect(rungs[0]).toBe(1);
    expect(f.video.seekCount).toBeGreaterThan(0);
    expect(f.jumps).toHaveLength(0);
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
