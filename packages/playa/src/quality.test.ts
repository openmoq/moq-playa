/**
 * Tests for @playa/player quality switching API.
 *
 * Uses a real Player instance with stubbed engine to verify
 * setQuality() public behavior end-to-end.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Player } from './player.js';
import { mapLevels } from './level-mapper.js';
import type { Level } from './types.js';
import type { CatalogState } from '@moqt/msf';

// ─── DOM / global mocks ──────────────────────────────────────────────

function mockElement(): any {
  const style: Record<string, string> = {};
  return {
    style: new Proxy(style, { set: (t, k, v) => { t[k as string] = v; return true; } }),
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    addEventListener: vi.fn(),
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    width: 0, height: 0,
    hidden: false, muted: false, volume: 1, playsInline: false,
    parentNode: null as any,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
    disableRemotePlayback: false,
  };
}

beforeEach(() => {
  (globalThis as any).document = {
    createElement: (_tag: string) => mockElement(),
    hidden: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  (globalThis as any).HTMLElement = class {};
  (globalThis as any).HTMLCanvasElement = class {};
  (globalThis as any).HTMLVideoElement = class {};
  (globalThis as any).requestAnimationFrame = vi.fn(() => 0);
  (globalThis as any).cancelAnimationFrame = vi.fn();
  (globalThis as any).AudioContext = class {
    state = 'suspended';
    currentTime = 0;
    outputLatency = 0;
    destination = { maxChannelCount: 2 };
    resume = vi.fn(async () => {});
    close = vi.fn(async () => {});
    createGain = vi.fn(() => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }));
    getOutputTimestamp = vi.fn(() => ({ contextTime: 0, performanceTime: 0 }));
  };
});

// ─── mapLevels ───────────────────────────────────────────────────────

describe('mapLevels', () => {
  const catalog: CatalogState = {
    tracks: [
      { name: 'video-0', codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 3_000_000 } as any,
      { name: 'video-1', codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 1_500_000 } as any,
      { name: 'video-2', codec: 'avc1.64001e', width: 640, height: 480, bitrate: 500_000 } as any,
    ],
  } as CatalogState;

  it('populates Level.trackName from catalog track.name', () => {
    const levels = mapLevels(catalog);
    expect(levels).toHaveLength(3);
    expect(levels[0]!.trackName).toBe('video-0');
    expect(levels[1]!.trackName).toBe('video-1');
    expect(levels[2]!.trackName).toBe('video-2');
  });

  it('sorts by bitrate descending', () => {
    const levels = mapLevels(catalog);
    expect(levels[0]!.bitrate).toBeGreaterThan(levels[1]!.bitrate);
    expect(levels[1]!.bitrate).toBeGreaterThan(levels[2]!.bitrate);
  });
});

// ─── Player.setQuality (real instance, stubbed engine) ───────────────

describe('Player.setQuality', () => {
  function createPlayer(): Player {
    const container = mockElement();
    container.parentNode = { removeChild: vi.fn() };
    return new Player(container, {
      url: 'https://relay.example.com/moq',
      namespace: 'test',
    });
  }

  function stubEngine(player: Player) {
    const engine = (player as any).engine;
    engine.selectVideoTrack = vi.fn(async () => {});
    engine.setAutoQuality = vi.fn();
    // Populate levels as if catalog was received
    (player as any)._levels = [
      { index: 0, trackName: 'video-0', label: '1080p', codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 3_000_000 },
      { index: 1, trackName: 'video-1', label: '720p', codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 1_500_000 },
    ] as Level[];
    return engine;
  }

  it('setQuality(index) calls engine.setAutoQuality(false) and selectVideoTrack', async () => {
    const player = createPlayer();
    const engine = stubEngine(player);

    await player.setQuality(1);

    expect(engine.setAutoQuality).toHaveBeenCalledWith(false);
    expect(engine.selectVideoTrack).toHaveBeenCalledWith('video-1', 'manual');
  });

  it('setQuality("auto") calls engine.setAutoQuality(true), not selectVideoTrack', async () => {
    const player = createPlayer();
    const engine = stubEngine(player);

    await player.setQuality('auto');

    expect(engine.setAutoQuality).toHaveBeenCalledWith(true);
    expect(engine.selectVideoTrack).not.toHaveBeenCalled();
  });

  it('selectVideoTrack rejection propagates from setQuality', async () => {
    const player = createPlayer();
    const engine = stubEngine(player);
    engine.selectVideoTrack.mockRejectedValueOnce(new Error('track not found'));

    await expect(player.setQuality(0)).rejects.toThrow('track not found');
  });

  it('invalid index is a no-op and does not lock ABR', async () => {
    const player = createPlayer();
    const engine = stubEngine(player);

    await player.setQuality(99); // out of range

    expect(engine.setAutoQuality).not.toHaveBeenCalled();
    expect(engine.selectVideoTrack).not.toHaveBeenCalled();
    expect(player.autoQuality).toBe(true); // unchanged
  });

  it('currentLevel updates only on quality_switched, not on request', async () => {
    const player = createPlayer();
    const engine = stubEngine(player);

    await player.setQuality(1);
    expect(player.currentLevel).toBe(-1); // NOT updated yet

    // Simulate engine emitting quality_switched via its internal emitter
    (engine as any).emitter.emit('quality_switched', {
      type: 'quality_switched',
      fromTrackName: 'video-0',
      toTrackName: 'video-1',
      reason: 'manual',
    });

    expect(player.currentLevel).toBe(1); // NOW updated
  });
});
