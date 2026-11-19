/**
 * A wide CMAF hole left when the live source restarts: the old media ends,
 * and a new run of groups (here on another rendition) lands seconds ahead
 * of the frozen playhead, one receiving group at a time as live media does.
 * Real MseMediaSource, modeled native buffers (as mse-exhausted-hole.test.ts).
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

async function ready() {
  const video = new MockVideoElement(); video.buffered = makeTimeRanges([[0, 2]]);
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { maxAheadSec: Infinity });
  const jumps: unknown[] = [], errors: Error[] = [];
  adapter.onGapJump = info => { jumps.push(info); };
  adapter.onError = error => { if (!adapter.tryRecoverBufferedGap?.(error)) errors.push(error); };
  expect(adapter.initialize({ video: { codec: 'avc1.640028', initData: init('video') }, audio: { codec: 'mp4a.40.2', initData: init('audio') } })).toBe(true);
  source.open(); await settle();
  adapter.setPlaybackIntent(true);
  // The old rendition's last group, [0, 2] s, fully received.
  const old = adapter.retainReceivingGroup('video', 'v1', 8n, () => true);
  adapter.appendChunk('video', segment(0), 'v1', 8n); await settle();
  old();
  video.seekCount = 0; video.modelSeekLifecycle = true;
  return { adapter, video, jumps, errors };
}

/** The restarted source: group n of rendition `track` covers [start + i, start + i + 1] s. */
function liveGroups(f: Awaited<ReturnType<typeof ready>>, track: string, firstGroup: bigint, start: number) {
  let i = 0, release: (() => void) | null = null;
  const next = async () => {
    release?.();
    const group = firstGroup + BigInt(i);
    release = f.adapter.retainReceivingGroup('video', track, group, () => true);
    f.adapter.appendChunk('video', segment(start + i), track, group); await settle();
    const ranges: Array<[number, number]> = [[0, 2], [start, start + i + 1]];
    for (const b of [source.videoBuffer, source.audioBuffer]) b.buffered = makeTimeRanges(ranges);
    f.video.buffered = makeTimeRanges(ranges);
    i++;
  };
  return { next, stop: () => release?.() };
}

it.each([['another rendition', 'v3'], ['the same rendition', 'v1']])(
  'crosses a source-restart hole on %s once the escalation bound passes', async (_label, track) => {
    const f = await ready();
    try {
      f.video.advancePlayback(2); f.video.readyState = 2; // frozen at the end of the old media
      const live = liveGroups(f, track, 1_000n, 15);
      for (let s = 0; s < 14; s++) { await live.next(); await vi.advanceTimersByTimeAsync(1_000); }
      expect(f.errors).toEqual([]);
      expect(f.jumps).toHaveLength(1);
      expect(f.video.currentTime).toBeGreaterThan(15);
      live.stop();
    } finally { f.adapter.destroy(); }
  });

// Live media appends many objects a second, so the 1 s check often finds an
// append in flight. That must hold the jump, not restart the wait: in a lab
// run each in-flight append reset the 10 s wait and a 13 s hole froze
// playback for 44 s.
it('keeps waiting out a wide hole across checks that find an append in flight', async () => {
  const f = await ready();
  try {
    f.video.advancePlayback(2); f.video.readyState = 2;
    const vb = source.videoBuffer;
    const ranges = (end: number): Array<[number, number]> => [[0, 2], [15, end]];
    for (const b of [vb, source.audioBuffer]) b.buffered = makeTimeRanges(ranges(16));
    f.video.buffered = makeTimeRanges(ranges(16));
    let release: (() => void) | null = null;
    // Checks run on whole seconds; each step starts half a second past one.
    // Two steps in three, the append is in flight across the next check.
    await vi.advanceTimersByTimeAsync(500);
    for (let s = 0; s < 16 && f.jumps.length === 0; s++) {
      const straddles = s % 3 !== 2;
      release?.();
      release = f.adapter.retainReceivingGroup('video', 'v1', 2_000n + BigInt(s), () => true);
      vb.autoComplete = false;
      f.adapter.appendChunk('video', segment(16 + s), 'v1', 2_000n + BigInt(s)); await settle();
      await vi.advanceTimersByTimeAsync(straddles ? 600 : 200);
      for (const b of [vb, source.audioBuffer]) b.buffered = makeTimeRanges(ranges(17 + s));
      f.video.buffered = makeTimeRanges(ranges(17 + s));
      vb.updating = false; vb.fire('update'); vb.fire('updateend'); await settle();
      vb.autoComplete = true;
      await vi.advanceTimersByTimeAsync(straddles ? 400 : 800);
    }
    release?.();
    expect(f.errors).toEqual([]);
    expect(f.jumps).toHaveLength(1);
    expect(f.video.currentTime).toBeGreaterThan(15);
  } finally { f.adapter.destroy(); }
});
