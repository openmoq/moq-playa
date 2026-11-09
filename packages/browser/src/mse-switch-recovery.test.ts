/**
 * One-use recovery for a live switch whose history retrieval failed. A
 * reservation alone permits nothing; adoption arms it on the first native
 * append submitted afterwards, and only the buffered hole between the old
 * output's end and the range that append created may be crossed, once.
 * Buffered ranges are set by the test; the mock element does not play.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';

type Ranges = Array<[number, number]>;
let source: MockMediaSource;
beforeEach(() => {
  vi.useFakeTimers(); source = new MockMediaSource();
  vi.stubGlobal('MediaSource', class { constructor() { return source; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:review', revokeObjectURL() {} });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const VIDEO_INIT = buildInit({ trackId: 1, timescale: 1000, handler: 'vide' });
/** Decode times only order appends within a track here (contiguous ones are not held for reordering); native ranges are set separately. */
const segment = (sec: number) => buildChunk({ trackId: 1, bmdt: BigInt(Math.round(sec * 1000)),
  samples: [{ duration: 500, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, 4) });
const intersect = (a: Ranges, b: Ranges): Ranges => a.flatMap(([s, e]) => b
  .map(([t, f]) => [Math.max(s, t), Math.min(e, f)] as [number, number]).filter(([x, y]) => y > x));
const OLD: Ranges = [[0, 3.5]], HOLE: Ranges = [[0, 3.5], [6, 6.5]], AUDIO: Ranges = [[0, 9]];
const TARGET = { mediaType: 'video' as const, trackName: 'next', sourceKey: 'next-key' };

async function ready(options: { gapJumpMs?: number; audio?: boolean } = {}) {
  const video = new MockVideoElement();
  const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { gapJumpMs: options.gapJumpMs ?? 2000, maxAheadSec: Infinity });
  const jumps: Array<{ from: number; to: number }> = [], errors: string[] = [];
  adapter.onGapJump = info => { jumps.push({ from: info.from, to: info.to }); };
  adapter.onError = error => { errors.push(error.message); };
  const withAudio = options.audio !== false;
  expect(adapter.initialize({ video: { codec: 'avc1.640028', initData: VIDEO_INIT },
    ...(withAudio ? { audio: { codec: 'mp4a.40.2', initData: buildInit({ trackId: 2, timescale: 1000, handler: 'soun' }) } } : {}) })).toBe(true);
  source.open(); await settle();
  let audio: Ranges = withAudio ? AUDIO : [];
  /** Set the native ranges; the element reports their intersection. */
  const ranges = (next: Ranges, nextAudio: Ranges = audio) => {
    audio = nextAudio;
    source.videoBuffer.buffered = makeTimeRanges(next);
    if (withAudio) source.audioBuffer.buffered = makeTimeRanges(audio);
    video.buffered = makeTimeRanges(withAudio ? intersect(next, audio) : next);
  };
  ranges(OLD);
  adapter.setPlaybackIntent(true); adapter.appendChunk('video', segment(0), 'video', 1n, undefined, 'old-key'); await settle();
  expect(video.playCalls).toBe(1);
  video.advancePlayback(2); video.seekCount = 0; source.videoBuffer.autoComplete = false;
  /** Submit one video append and hold it in flight. */
  const submit = (sec: number, track: 'old' | 'next' = 'next') => {
    adapter.appendChunk('video', segment(sec), track === 'old' ? 'video' : 'next', 9n, undefined, track === 'old' ? 'old-key' : 'next-key');
  };
  /** Complete the in-flight native append with the ranges it leaves behind. */
  const complete = async (after: Ranges, outcome: 'ok' | 'error' = 'ok') => {
    expect(source.videoBuffer.updating, 'an append is in flight').toBe(true);
    ranges(after); // a failed append can still leave coded frames behind
    source.videoBuffer.updating = false;
    source.videoBuffer.fire(outcome === 'ok' ? 'update' : 'error'); source.videoBuffer.fire('updateend'); await settle();
  };
  const append = async (sec: number, after: Ranges, track: 'old' | 'next' = 'next') => { submit(sec, track); await complete(after); };
  /** The playhead rests at `sec` with nothing to play, for `ms`, one watchdog second at a time. */
  const stall = async (sec: number, ms = 5_000) => {
    video.advancePlayback(sec); video.readyState = 2;
    for (let t = 0; t < ms; t += 1000) await vi.advanceTimersByTimeAsync(1000);
  };
  const reserve = () => adapter.reserveSwitchRecovery(TARGET);
  /** Reserve, activate, and bind to an append that creates the target range at 6 s behind a 2.5 s hole. */
  const armed = async () => {
    const recovery = reserve(); expect(recovery).not.toBeNull();
    recovery!.activate(); await append(6, HOLE);
    return recovery!;
  };
  return { adapter, video, jumps, errors, ranges, submit, complete, append, stall, reserve, armed };
}
type F = Awaited<ReturnType<typeof ready>>;
const uncrossed = (f: F, at = 3.5) => {
  expect(f.video.seekCount, 'no crossing').toBe(0); expect(f.jumps).toEqual([]); expect(f.video.currentTime).toBe(at);
};
const fatal = (f: F) => f.errors.filter(m => m.includes('unrecoverable buffered hole'));

describe('crossing', () => {
  it('crosses the hole to the range the bound append created, once, and reports it as a gap jump', async () => {
    const f = await ready();
    try {
      await f.armed();
      await f.stall(3.5);
      expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBeCloseTo(6.01, 5);
      expect(f.jumps).toEqual([{ from: 3.5, to: f.video.currentTime }]); expect(f.errors).toEqual([]);
      // Used up: an identical hole later keeps the ordinary bound.
      f.video.readyState = 4; f.video.advancePlayback(6.4); await vi.advanceTimersByTimeAsync(2000);
      f.ranges([[0, 3.5], [6, 6.5], [9, 9.5]], [[0, 12]]);
      await f.stall(6.5, 13_000);
      expect(f.video.seekCount).toBe(1); expect(fatal(f)).toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it('a single video source crosses without an audio buffer', async () => {
    const f = await ready({ audio: false });
    try {
      await f.armed(); await f.stall(3.5);
      expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBeCloseTo(6.01, 5);
    } finally { f.adapter.destroy(); }
  });

  it('lands where audio and video are both buffered inside the bound range', async () => {
    const f = await ready();
    try {
      const recovery = f.reserve()!; recovery.activate();
      f.submit(6); await f.complete([[0, 3.5], [6, 9]]); f.ranges([[0, 3.5], [6, 9]], [[0, 3.5], [7, 9]]);
      await f.stall(3.5);
      expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBeCloseTo(7.01, 5);
    } finally { f.adapter.destroy(); }
  });

  it('does not cross while audio ends before the old video edge', async () => {
    const f = await ready();
    try {
      await f.armed(); f.ranges(HOLE, [[0, 3], [6, 9]]);
      await f.stall(3, 13_000);
      uncrossed(f, 3);
    } finally { f.adapter.destroy(); }
  });

  it('the adoption\'s own preparation before activation keeps the reservation', async () => {
    const f = await ready();
    try {
      const recovery = f.reserve()!;
      source.videoBuffer.autoComplete = true;
      await f.adapter.changeType('video', 'avc1.640028', VIDEO_INIT); await settle();
      source.videoBuffer.autoComplete = false; f.ranges(OLD);
      recovery.activate(); await f.append(6, HOLE);
      await f.stall(3.5);
      expect(f.video.seekCount).toBe(1); expect(f.errors).toEqual([]);
    } finally { f.adapter.destroy(); }
  });
});

describe('a reservation is not permission', () => {
  it('reserved but never activated: the wide hole keeps the ordinary bound', async () => {
    const f = await ready();
    try {
      expect(f.reserve()).not.toBeNull(); await f.append(6, HOLE);
      await f.stall(3.5, 13_000);
      uncrossed(f); expect(fatal(f)).toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it('without any reservation the wide hole keeps the ordinary bound', async () => {
    const f = await ready();
    try {
      await f.append(6, HOLE); await f.stall(3.5, 13_000);
      uncrossed(f); expect(fatal(f)).toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it('declines when it could not serve a crossing', async () => {
    const off = await ready({ gapJumpMs: 0 });
    try { expect(off.reserve(), 'gap recovery disabled').toBeNull(); } finally { off.adapter.destroy(); }
    const f = await ready();
    try {
      f.video.advancePlayback(20);
      expect(f.reserve(), 'old video output below a playhead that ran ahead').not.toBeNull();
      f.ranges([[5, 6]]); f.video.advancePlayback(2);
      expect(f.reserve(), 'playhead below every video range').toBeNull();
      f.ranges([[0, 3.5], [6, 9]]);
      expect(f.reserve(), 'video already buffered ahead of the old output').toBeNull();
      f.adapter.destroy();
      expect(f.reserve(), 'destroyed').toBeNull();
    } finally { f.adapter.destroy(); }
  });

  it('a second reservation replaces the first', async () => {
    const f = await ready();
    try {
      const first = f.reserve()!; const second = f.reserve()!;
      first.activate(); await f.append(6, HOLE); await f.stall(3.5, 13_000);
      uncrossed(f); expect(second).not.toBe(first);
    } finally { f.adapter.destroy(); }
  });
});

describe('binding', () => {
  it('an entry of the same track queued before activation cannot bind', async () => {
    const f = await ready();
    try {
      const recovery = f.reserve()!;
      f.submit(0.5, 'old'); f.submit(6); // the target entry waits behind an in-flight append
      recovery.activate();
      await f.complete(OLD); await f.complete(HOLE);
      await f.stall(3.5, 13_000);
      uncrossed(f); expect(fatal(f)).toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it('an entry of another track submitted after activation cannot bind', async () => {
    const f = await ready();
    try {
      f.reserve()!.activate(); await f.append(0.5, HOLE, 'old');
      await f.stall(3.5, 13_000);
      uncrossed(f);
    } finally { f.adapter.destroy(); }
  });

  it('nothing is crossed while the bound append is in flight', async () => {
    const f = await ready();
    try {
      f.reserve()!.activate(); f.submit(6); f.ranges(HOLE);
      await f.stall(3.5, 13_000);
      uncrossed(f); expect(f.errors).toEqual([]);
    } finally { f.adapter.destroy(); }
  });

  it('a failed bound append ends the reservation; a later append does not inherit it', async () => {
    const f = await ready();
    try {
      f.reserve()!.activate(); f.submit(6); await f.complete(HOLE, 'error');
      await f.stall(3.5, 3_000); uncrossed(f);
      await f.append(6.5, [[0, 3.5], [6, 7]]);
      await f.stall(3.5, 13_000);
      uncrossed(f);
    } finally { f.adapter.destroy(); }
  });

  it('a replacement inside an already buffered, disjoint range is not attributed and not treated as healed', async () => {
    const f = await ready();
    try {
      const recovery = f.reserve()!;
      f.ranges([[0, 3.5], [6, 9]]); // media that arrived ahead after the reservation
      recovery.activate(); await f.append(6, [[0, 3.5], [6, 9]]);
      await f.stall(3.5, 13_000);
      uncrossed(f); expect(fatal(f), 'the hole is still there and keeps the ordinary bound').toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it('a contiguous append leaves no hole: nothing is crossed and the reservation is used up', async () => {
    const f = await ready();
    try {
      f.reserve()!.activate(); await f.append(3.5, [[0, 4]]);
      await f.stall(3.9, 3_000); expect(f.video.seekCount).toBe(0); expect(f.errors).toEqual([]);
      await f.append(4, [[0, 4], [6.5, 7]]);
      await f.stall(4, 13_000);
      uncrossed(f, 4); expect(fatal(f)).toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it.each([
    ['two new ranges', OLD, OLD, [[0, 3.5], [6, 6.5], [8, 8.5]]],
    ['a range glued to earlier media ahead', OLD, [[0, 3.5], [5.5, 6]], [[0, 3.5], [5.5, 6.5]]],
    ['existing media evicted during the append', OLD, [[0, 3.5], [1e3, 1e3 + 1]], [[0, 3.5], [6, 6.5]]],
    ['a range behind the old output', [[2, 3.5]], [[2, 3.5]], [[0, 0.5], [2, 3.5]]],
  ] as Array<[string, Ranges, Ranges, Ranges]>)('ambiguous placement is not bound: %s', async (_name, reserved, before, after) => {
    const f = await ready();
    try {
      f.ranges(reserved); f.video.advancePlayback(3);
      const recovery = f.reserve()!; f.ranges(before);
      recovery.activate(); await f.append(6, after);
      f.ranges([[0, 3.5], [6, 6.5]]);
      await f.stall(3.5, 13_000);
      uncrossed(f);
    } finally { f.adapter.destroy(); }
  });
});

describe('ownership after binding', () => {
  it('the hole healing naturally uses the reservation up without a seek', async () => {
    const f = await ready();
    try {
      await f.armed(); await f.append(0.5, [[0, 6.5]], 'old');
      // The same hole reappearing later is not the one that was reserved for.
      f.ranges(HOLE); await f.stall(3.5, 3_000); uncrossed(f); f.ranges([[0, 6.5]]);
      f.video.readyState = 4; f.video.advancePlayback(6.4); await vi.advanceTimersByTimeAsync(2000);
      f.ranges([[0, 6.5], [9, 9.5]], [[0, 12]]); await f.stall(6.5, 13_000);
      uncrossed(f, 6.5); expect(fatal(f)).toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it('the element reporting a landing the native audio buffer does not hold is not crossed', async () => {
    const f = await ready();
    try {
      await f.armed(); f.ranges(HOLE, [[0, 3.5]]); f.video.buffered = makeTimeRanges(HOLE);
      await f.stall(3.5, 13_000);
      uncrossed(f);
    } finally { f.adapter.destroy(); }
  });

  it('the start of the bound range no longer being buffered ends it', async () => {
    const f = await ready();
    try {
      await f.armed(); f.ranges([[0, 3.5], [6.2, 6.5]]);
      await f.stall(3.5, 13_000);
      uncrossed(f);
    } finally { f.adapter.destroy(); }
  });

  it('old output that shrank between reservation and binding is not the reserved boundary', async () => {
    const f = await ready();
    try {
      const recovery = f.reserve()!; f.ranges([[0, 3]]); recovery.activate();
      await f.append(6, [[0, 3], [6, 6.5]]);
      await f.stall(3, 13_000);
      uncrossed(f, 3);
    } finally { f.adapter.destroy(); }
  });

  it('a different wide hole does not borrow it', async () => {
    const f = await ready();
    try {
      await f.armed(); f.ranges([[0, 2], [6, 6.5]]);
      await f.stall(2, 13_000);
      uncrossed(f, 2); expect(fatal(f)).toHaveLength(1);
    } finally { f.adapter.destroy(); }
  });

  it.each([
    ['revoke()', async (_f: F, recovery: { revoke(): void }) => { recovery.revoke(); }],
    ['a video retype', async (f: F) => {
      source.videoBuffer.autoComplete = true; await f.adapter.changeType('video', 'avc1.640028', VIDEO_INIT); await settle(); f.ranges(HOLE);
    }],
    ['a changed video timestamp offset', async (f: F) => { f.adapter.setTimestampOffset('video', 1); }],
    ['a seek', async (f: F) => { f.video.modelSeekLifecycle = true; f.video.currentTime = 1; await settle(); f.video.seekCount = 0; }],
  ] as Array<[string, (f: F, recovery: { revoke(): void }) => Promise<void>]>)('%s after binding revokes', async (_name, act) => {
    const f = await ready();
    try {
      const recovery = await f.armed(); await act(f, recovery);
      await f.stall(3.5, 13_000);
      uncrossed(f);
    } finally { f.adapter.destroy(); }
  });

  it('an unchanged timestamp offset and later tail appends keep it', async () => {
    const f = await ready();
    try {
      await f.armed(); f.adapter.setTimestampOffset('video', 0);
      await f.append(6.5, [[0, 3.5], [6, 7]]);
      await f.stall(3.5);
      expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBeCloseTo(6.01, 5);
    } finally { f.adapter.destroy(); }
  });

  it('pausing suspends it: nothing is crossed while paused, and the same hole is crossed after resuming', async () => {
    const f = await ready();
    try {
      await f.armed();
      f.adapter.setPlaybackIntent(false); f.video.paused = true;
      await f.stall(3.5, 13_000);
      uncrossed(f); expect(f.errors).toEqual([]);
      f.video.paused = false; f.adapter.setPlaybackIntent(true); await settle(); f.video.seekCount = 0;
      await f.stall(3.5);
      expect(f.video.seekCount).toBe(1); expect(f.video.currentTime).toBeCloseTo(6.01, 5);
    } finally { f.adapter.destroy(); }
  });

  it.each([
    ['a seek', async (f: F) => { f.video.modelSeekLifecycle = true; f.video.currentTime = 1; await settle(); f.video.modelSeekLifecycle = false; }],
    ['a newer reservation', async (f: F) => { f.ranges(OLD); expect(f.reserve()).not.toBeNull(); f.ranges(HOLE); }],
  ] as Array<[string, (f: F) => Promise<void>]>)('%s while paused ends it; resuming does not reuse it', async (_name, act) => {
    const f = await ready();
    try {
      await f.armed();
      f.adapter.setPlaybackIntent(false); f.video.paused = true; await act(f);
      f.video.paused = false; f.adapter.setPlaybackIntent(true); await settle(); f.video.seekCount = 0;
      await f.stall(3.5, 13_000);
      uncrossed(f);
    } finally { f.adapter.destroy(); }
  });

  it('a reset revokes, and the handle stays inert afterwards', async () => {
    const f = await ready();
    try {
      const recovery = await f.armed(); f.adapter.reset();
      expect(() => { recovery.activate(); recovery.revoke(); }).not.toThrow();
      expect(f.video.seekCount).toBe(0);
    } finally { f.adapter.destroy(); }
  });
});
