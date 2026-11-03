import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncController } from '@openmoq/playback';
import { MoqtPlayer } from './player.js';
import type { MediaSourceLike } from './interfaces.js';
import type { StatsAccumulator } from './stats.js';

const players: MoqtPlayer[] = [];
afterEach(async () => { for (const player of players.splice(0)) await player.destroy(); });
function makePlayer() {
  const player = new MoqtPlayer({ url: 'https://relay.example.com/moq', namespace: 'stats', createTransport: vi.fn() });
  players.push(player);
  const state = player as unknown as { syncController: SyncController | null; mediaSource: MediaSourceLike | null; _stats: StatsAccumulator };
  return { player, state };
}
function source() {
  return { initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), destroy: vi.fn(),
    mediaElement: null, onFirstFrame: null, onError: null, onStall: null } satisfies MediaSourceLike;
}

describe('player stats measurement semantics', () => {
  it('reports latest capture age independently of catch-up events, including zero and negative age', () => {
    const { player, state } = makePlayer();
    const now = 1_000_000_000;
    state.syncController = new SyncController({ clock: { now: () => 0 }, wallClock: { now: () => now }, driftThresholdUs: 1000 });
    state._stats.recordLatency(999); // Old event receipt must not override current measurement state.
    expect(player.stats.captureTimestampAgeMs).toBeNull();
    expect(player.stats.currentLatencyMs).toBe(0);
    for (const age of [250, 0, -5]) {
      state.syncController.evaluateCatchUp(BigInt(now - age * 1000));
      expect(player.stats.captureTimestampAgeMs).toBe(age);
      expect(player.stats.currentLatencyMs).toBe(age);
    }
    state.syncController.reset();
    expect(player.stats.captureTimestampAgeMs).toBeNull();
    expect(player.stats.currentLatencyMs).toBe(0);
    state.syncController.evaluateCatchUp(BigInt(now - 100_000));
    state.syncController.evaluateCatchUp(500n, false);
    expect(player.stats.captureTimestampAgeMs).toBeNull();
  });

  it('adds media-element counters without replacing engine lifetime frame fields', () => {
    const { player, state } = makePlayer();
    state._stats.recordFrameDecoded(); state._stats.recordFrameDecoded(); state._stats.recordFrameRendered();
    const before = player.stats;
    const quality = { totalVideoFrames: 300, droppedVideoFrames: 3, displayedVideoFrames: 297, creationTimeMs: 12.5 };
    state.mediaSource = { ...source(), getVideoPlaybackQuality: () => quality };
    const stats = player.stats;
    expect(stats.videoPlaybackQuality).toEqual(quality);
    expect(stats).toMatchObject({ framesDecoded: before.framesDecoded, framesRendered: before.framesRendered,
      framesDropped: before.framesDropped, dropRatio: before.dropRatio });
    expect(Object.isFrozen(stats)).toBe(true);
    quality.totalVideoFrames = 2; quality.droppedVideoFrames = 0; quality.displayedVideoFrames = 2;
    expect(player.stats.videoPlaybackQuality?.totalVideoFrames).toBe(2); // Element load can reset its counters.
    expect(player.stats.framesDecoded).toBe(2);
  });

  it('reports unavailable as null for old adapters and getter failures', () => {
    const { player, state } = makePlayer();
    expect(player.stats.videoPlaybackQuality).toBeNull();
    state.mediaSource = source();
    expect(player.stats.videoPlaybackQuality).toBeNull();
    state.mediaSource = { ...source(), getVideoPlaybackQuality: () => { throw new Error('detached'); } };
    expect(() => player.stats).not.toThrow();
    expect(player.stats.videoPlaybackQuality).toBeNull();
  });
});


it('copies named playback-quality properties from a valid accessor adapter', () => {
  const { player, state } = makePlayer(); let total = 300;
  class Quality {
    get totalVideoFrames() { return total; }
    get droppedVideoFrames() { return 3; }
    get displayedVideoFrames() { return total - 3; }
    get creationTimeMs() { return 12.5; }
  }
  state.mediaSource = { ...source(), getVideoPlaybackQuality: () => new Quality() };
  const snapshot = player.stats.videoPlaybackQuality;
  expect(snapshot).toEqual({ totalVideoFrames: 300, droppedVideoFrames: 3, displayedVideoFrames: 297, creationTimeMs: 12.5 });
  expect(Object.isFrozen(snapshot)).toBe(true);
  total = 400;
  expect(snapshot?.totalVideoFrames).toBe(300);
  expect(player.stats.videoPlaybackQuality?.totalVideoFrames).toBe(400);
});
