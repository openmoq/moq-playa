/**
 * A wide CMAF hole left when a subgroup stream is reset outside any switch.
 * Real MseMediaSource, modeled native
 * buffers (as mse-crossed-hole.test.ts). Not a browser claim.
 */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';

let source: MockMediaSource;
beforeEach(() => {
  vi.useFakeTimers(); source = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return source; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:probe', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const init = (role: 'video' | 'audio') => buildInit({ trackId: role === 'video' ? 1 : 2, timescale: 1000, handler: role === 'video' ? 'vide' : 'soun' });
const segment = (pts: number) => buildChunk({ trackId: 1, bmdt: BigInt(pts * 1000), samples: [{ duration: 1000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });

async function ready(audio = true) {
  const video = new MockVideoElement(); video.buffered = makeTimeRanges([[0, 12]]);
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { maxAheadSec: Infinity });
  const jumps: unknown[] = [], errors: Error[] = [];
  adapter.onGapJump = info => { jumps.push(info); };
  adapter.onError = error => { if (!adapter.tryRecoverBufferedGap?.(error)) errors.push(error); };
  expect(adapter.initialize({ video: { codec: 'avc1.640028', initData: init('video') }, ...(audio ? { audio: { codec: 'mp4a.40.2', initData: init('audio') } } : {}) })).toBe(true);
  source.open(); await settle();
  source.videoBuffer.buffered = makeTimeRanges([[0, 12]]);
  if (audio) source.audioBuffer.buffered = makeTimeRanges([[0, 12]]);
  adapter.setPlaybackIntent(true); adapter.appendChunk('video', segment(0), 'video', 7n); await settle();
  video.seekCount = 0; video.modelSeekLifecycle = true;
  return { adapter, video, jumps, errors };
}

/** Group 8 lands at [1, 2] s on one receiving subgroup stream. */
async function appendGroup8(f: Awaited<ReturnType<typeof ready>>) {
  const release = f.adapter.retainReceivingGroup('video', 'video', 8n, () => true);
  const vb = source.videoBuffer;
  vb.buffered = makeTimeRanges([[0, 1]]); vb.autoComplete = false;
  f.adapter.appendChunk('video', segment(1), 'video', 8n); await settle();
  vb.buffered = makeTimeRanges([[0, 2]]); vb.updating = false; vb.fire('update'); vb.fire('updateend'); await settle();
  vb.autoComplete = true;
  return release;
}
const holeAfterGroup8 = (f: Awaited<ReturnType<typeof ready>>) => {
  source.videoBuffer.buffered = makeTimeRanges([[0, 2], [4.5, 12]]);
  f.video.buffered = makeTimeRanges([[0, 2], [4.5, 12]]);
  f.video.advancePlayback(2.4); f.video.readyState = 2;
};

it('crosses a relay-shed tail only at the escalation bound', async () => {
  const f = await ready();
  try {
    const release = await appendGroup8(f);
    release(); // The ended stream does not establish permanent loss.
    holeAfterGroup8(f);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.jumps).toEqual([]);
    expect(f.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.errors).toEqual([]);
    expect(f.jumps).toHaveLength(1);
    expect(f.video.seekCount).toBe(1);
    expect(f.video.currentTime).toBeCloseTo(4.51, 5);
  } finally { f.adapter.destroy(); }
});

it('control (d18 §11.4.3 / d22 §11.3.2): the reset subgroup continues on a new stream and fills the hole; nothing may be skipped', async () => {
  const f = await ready();
  try {
    const first = await appendGroup8(f);
    first(); // the relay reset the stream ...
    const second = f.adapter.retainReceivingGroup('video', 'video', 8n, () => true); // ... and opened a new one for group 8
    holeAfterGroup8(f);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.video.seekCount).toBe(0);
    expect(f.errors.map(e => e.name)).toEqual(['MediaGapUnrecoverableError']);
    // The tail of group 8 arrives on the new stream and heals the hole.
    for (const b of [source.videoBuffer, source.audioBuffer]) b.buffered = makeTimeRanges([[0, 12]]);
    f.video.buffered = makeTimeRanges([[0, 12]]);
    second();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.jumps).toEqual([]);
    expect(f.video.seekCount).toBe(0);
    expect(f.errors.map(e => e.name)).toEqual(['MediaGapUnrecoverableError']);
  } finally { f.adapter.destroy(); }
});

// Retiring group 8 must not authorize skipping a later receiving group
// after the same track resumes. No permanent track abandonment is recorded.
it('a resumed track still receiving group 9 does not cross its new hole', async () => {
  const f = await ready();
  try {
    (await appendGroup8(f))();
    const resumed = f.adapter.retainReceivingGroup('video', 'video', 9n, () => true);
    f.adapter.appendChunk('video', segment(2), 'video', 9n); await settle();
    source.videoBuffer.buffered = makeTimeRanges([[0, 3], [5.5, 12]]);
    f.video.buffered = source.videoBuffer.buffered;
    f.video.advancePlayback(3.4); f.video.readyState = 2;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.jumps).toEqual([]); expect(f.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(f.video.seekCount).toBe(0);
    expect(f.errors.map(e => e.name)).toEqual(['MediaGapUnrecoverableError']);
    resumed();
  } finally { f.adapter.destroy(); }
});

it.each(['video', 'audio'] as const)('still escalates when the native %s landing is missing', async role => {
  const f = await ready();
  try {
    (await appendGroup8(f))();
    holeAfterGroup8(f);
    // An element range alone is insufficient evidence of a playable landing.
    f.video.advancePlayback(2);
    source[role === 'video' ? 'videoBuffer' : 'audioBuffer'].buffered = makeTimeRanges([[0, 2]]);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.video.seekCount).toBe(0); expect(f.jumps).toEqual([]);
    expect(f.errors.map(e => e.name)).toEqual(['MediaGapUnrecoverableError']);
  } finally { f.adapter.destroy(); }
});

it('rejects an error after its escalation callback returns', async () => {
  const f = await ready();
  try {
    f.adapter.onError = error => { f.errors.push(error); };
    (await appendGroup8(f))(); holeAfterGroup8(f);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.errors).toHaveLength(1);
    expect(f.adapter.tryRecoverBufferedGap(f.errors[0]!)).toBe(false);
    expect(f.video.seekCount).toBe(0);
  } finally { f.adapter.destroy(); }
});

it('cannot recover a failed landing or reuse the original hole error', async () => {
  const f = await ready();
  try {
    const attempts: boolean[] = [];
    f.adapter.onError = error => {
      expect(f.adapter.tryRecoverBufferedGap(new Error(error.message))).toBe(false);
      const recovered = f.adapter.tryRecoverBufferedGap(error);
      attempts.push(recovered);
      expect(f.adapter.tryRecoverBufferedGap(error)).toBe(false);
      if (!recovered) f.errors.push(error);
    };
    (await appendGroup8(f))(); holeAfterGroup8(f);
    await vi.advanceTimersByTimeAsync(23_000);
    expect(attempts).toEqual([true, false]);
    expect(f.video.seekCount).toBe(1);
    expect(f.errors[0]?.message).toContain('gap-jump landing failed');
  } finally { f.adapter.destroy(); }
});

it('audio still receiving vetoes exhausted combined-hole recovery', async () => {
  const f = await ready();
  try {
    (await appendGroup8(f))();
    const release = f.adapter.retainReceivingGroup('audio', 'audio', 8n, () => true);
    holeAfterGroup8(f);
    f.video.advancePlayback(2);
    source.audioBuffer.buffered = makeTimeRanges([[0, 2], [4.5, 12]]);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.video.seekCount).toBe(0);
    expect(f.errors.map(e => e.name)).toEqual(['MediaGapUnrecoverableError']);
    release();
  } finally { f.adapter.destroy(); }
});

it('crosses exhausted video-only CMAF without requiring an audio buffer', async () => {
  const f = await ready(false);
  try {
    (await appendGroup8(f))(); holeAfterGroup8(f);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.video.seekCount).toBe(1);
    expect(f.video.currentTime).toBeCloseTo(4.51, 5);
    expect(f.errors).toEqual([]);
  } finally { f.adapter.destroy(); }
});
