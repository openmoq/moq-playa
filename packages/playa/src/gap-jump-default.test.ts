/**
 * Playa behavior-change regression: Playa's REAL media-source factory
 * (buildMoqtPlayerConfig().createMediaSource — packages/playa/src/player.ts
 * `new MseMediaSource(video)`) constructs the adapter with defaults, which
 * means the buffered-hole gap-jump is ACTIVE in Playa with zero
 * configuration. The factory itself is executed here, so a change like
 * `new MseMediaSource(video, { gapJumpMs: 0 })` fails this test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MseMediaSource } from '@moqt/browser';
import { Player } from './player.js';

function makeTimeRanges(ranges: readonly [number, number][]): TimeRanges {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i]![0],
    end: (i: number) => ranges[i]![1],
  } as TimeRanges;
}

class StubVideo {
  buffered = makeTimeRanges([[5, 19.27], [19.78, 25]]);
  paused = false;
  seeking = false;
  error: MediaError | null = null;
  src = '';
  addEventListener(): void { /* not needed */ }
  removeEventListener(): void { /* not needed */ }
  removeAttribute(): void { /* not needed */ }
  load(): void { /* not needed */ }
  srcObject: unknown = null;
}

// Node has no MediaSource; stub the minimum the constructor touches
// (same approach as the @moqt/browser adapter suite).
beforeEach(() => {
  const ms = {
    readyState: 'closed',
    addEventListener() { /* sourceopen never fires — not needed here */ },
    removeEventListener() { /* noop */ },
    addSourceBuffer() { throw new Error('not used'); },
  };
  vi.stubGlobal('MediaSource', class { constructor() { return ms; } });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Playa default construction — gap-jump active with zero config', () => {
  it("Playa's real media-source factory constructs an adapter with the gap-jump ENABLED", () => {
    const video = new StubVideo();
    const playa = new Player(null, { url: 'https://relay.example/moq', namespace: 'ns', video: video as unknown as HTMLVideoElement });
    const config = (playa as any).buildMoqtPlayerConfig();
    const ms = config.createMediaSource();          // the REAL factory closure

    expect(ms).toBeInstanceOf(MseMediaSource);
    expect((ms as any).gapJumpMs).toBe(2_000);      // default wait — 0 would disable
    ms.destroy();
    void playa;
  });

  it('a default-constructed MseMediaSource jumps a bounded buffered hole', () => {
    const video = new StubVideo();
    // Track seeks through assignment (mirror of the adapter's usage).
    let seeks = 0;
    (video as any)._ct = 19.25;
    Object.defineProperty(video, 'currentTime', {
      get: () => (video as any)._ct,
      set: (v: number) => { (video as any)._ct = v; seeks++; },
    });

    const ms = new MseMediaSource(video as unknown as HTMLVideoElement); // Playa's exact construction
    (ms as any).playTriggered = true;

    (ms as any).checkGapJump(0);
    (ms as any).checkGapJump(1_000);
    (ms as any).checkGapJump(2_100);

    expect(seeks).toBe(1);
    expect((video as any)._ct).toBeCloseTo(19.79, 5);
    ms.destroy();
  });
});
