/**
 * Tests for @openmoq/playa quality switching API.
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
import type { CatalogState } from '@openmoq/msf';

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

describe('late renderer creation', () => {
  for (const state of ['idle', 'playing', 'paused'] as const) {
    it(`creates a renderer matching the ${state} playback state`, async () => {
      const player = new Player(mockElement(), {
        url: 'https://relay.example.com/moq', namespace: 'test',
      });
      const engine = (player as any).engine;
      engine.play = vi.fn();
      engine.pause = vi.fn();
      engine.destroy = vi.fn(async () => {});
      if (state !== 'idle') player.play();
      if (state === 'paused') player.pause();

      const renderer = engine.config.createRenderer();
      expect((renderer as any).running).toBe(state === 'playing');
      await player.destroy();
      expect((renderer as any).running).toBe(false);
    });
  }
});

describe('mapLevels', () => {
  const views = {
    version: 1,
    tracks: [
      { name: 'landscape-high', role: 'video', packaging: 'loc', codec: 'avc1.640028', altGroup: 7, bitrate: 2000 },
      { name: 'portrait', role: 'video', packaging: 'loc', codec: 'avc1.640028', altGroup: 0, bitrate: 3000 },
      { name: 'landscape-low', role: 'video', packaging: 'loc', codec: 'avc1.640028', altGroup: 7, bitrate: 1000 },
    ],
  } as CatalogState;

  it('does not mix different video views into the default quality menu', () => {
    expect(mapLevels(views).map(l => l.trackName)).toEqual(['landscape-high', 'landscape-low']);
  });

  it('maps the requested view to its own quality indices', () => {
    expect(mapLevels(views, 0).map(l => [l.index, l.trackName])).toEqual([[0, 'portrait']]);
  });

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

// ─── Render sink choice on catalog_received ───────────────────────────

describe('Player authorization options', () => {
  it('previews the injected catalog instead of an unused known-video hint', async () => {
    const catalog = { version: 1, tracks: [
      { name: 'landscape', role: 'video' as const, packaging: 'cmaf' as const, isLive: true, codec: 'avc1.640028', altGroup: 7 },
      { name: 'portrait', role: 'video' as const, packaging: 'loc' as const, isLive: true, codec: 'avc1.640028', altGroup: 0 },
    ] };
    const player = new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'views',
      moqtPlayerConfig: { catalog, knownTracks: { video: { name: 'portrait', codec: 'avc1.640028' } } },
    });
    try {
      (player as any).engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog });
      expect(player.levels.map(l => l.trackName)).toEqual(['landscape']);
      expect(player.activeMediaType).toBe('video');
    } finally { await player.destroy(); }
  });
  it('previews the actual known-video view rather than the default catalog group', async () => {
    const player = new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'views',
      moqtPlayerConfig: { knownTracks: { video: { name: 'portrait', codec: 'avc1.640028' } } },
    });
    try {
      (player as any).engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: { version: 1, tracks: [
        { name: 'landscape', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', altGroup: 7 },
        { name: 'portrait', role: 'video', packaging: 'loc', codec: 'avc1.640028', altGroup: 0 },
      ] } });
      expect(player.levels.map(l => l.trackName)).toEqual(['portrait']);
      expect(player.activeMediaType).toBe('canvas');
    } finally { await player.destroy(); }
  });
  it('passes the initial view to the engine and scopes the quality menu to that view', async () => {
    const player = new Player(mockElement(), {
      url: 'https://relay.example/moq', namespace: 'views', videoAltGroup: 0,
    });
    try {
      const engine = (player as any).engine;
      expect(engine.config.videoAltGroup).toBe(0);
      engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: { version: 1, tracks: [
        { name: 'landscape', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', altGroup: 7 },
        { name: 'portrait', role: 'video', packaging: 'loc', codec: 'avc1.640028', altGroup: 0 },
      ] } });
      expect(player.levels.map(l => l.trackName)).toEqual(['portrait']);
      expect(player.activeMediaType).toBe('canvas');
      expect((player as any).canvas.hidden).toBe(false);
    } finally { await player.destroy(); }
  });

  it('uses effective engine overrides for view, quality, resolution cap and render sink', async () => {
    const player = new Player(mockElement(), {
      url: 'https://relay.example/moq', namespace: 'views', videoAltGroup: 7,
      moqtPlayerConfig: { videoAltGroup: 0, startLevel: 'lowest', capLevelToResolution: { width: 640, height: 640 } },
    });
    try {
      const engine = (player as any).engine;
      engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: { version: 1, tracks: [
        { name: 'landscape', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', altGroup: 7 },
        { name: 'portrait-high', role: 'video', packaging: 'cmaf', codec: 'avc1.640028', altGroup: 0, width: 1080, height: 1920, bitrate: 3000 },
        { name: 'portrait-low', role: 'video', packaging: 'loc', codec: 'avc1.640028', altGroup: 0, width: 360, height: 640, bitrate: 500 },
      ] } });
      expect(player.levels.map(l => l.trackName)).toEqual(['portrait-low']);
      expect(player.activeMediaType).toBe('canvas');
    } finally { await player.destroy(); }
  });

  it('does not announce ready with an empty fallback menu for a missing requested group', async () => {
    const player = new Player(mockElement(), {
      url: 'https://relay.example/moq', namespace: 'views', videoAltGroup: 99,
    });
    try {
      const ready = vi.fn();
      player.on('ready', ready);
      expect(() => (player as any).engine.emitter.emit('catalog_received', {
        type: 'catalog_received', catalog: { version: 1, tracks: [
          { name: 'landscape', role: 'video', packaging: 'loc', codec: 'avc1.640028', altGroup: 7 },
        ] },
      })).not.toThrow();
      expect(player.levels).toEqual([]);
      expect(ready).not.toHaveBeenCalled();
    } finally { await player.destroy(); }
  });

  it('passes the credential provider and trust options to its engine', async () => {
    const authorization = { getTokens: vi.fn(async () => [{ tokenType: 1n, value: new Uint8Array([1]) }]),
      timeoutMs: 500, allowedRelayOrigins: ['https://trusted.example'] };
    const player = new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'live/test', authorization });
    try {
      expect((player as any).engine.config.authorization).toBe(authorization);
      expect(authorization.getTokens).not.toHaveBeenCalled();
    } finally { await player.destroy(); }
  });

  it('does not discard an explicitly invalid credential configuration', () => {
    expect(() => new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'live/test',
      authorization: null as unknown as import('./types.js').PlayerOptions['authorization'],
    })).toThrow('authorization');
  });
});

describe('Player sink choice (MSE <video> vs <canvas>)', () => {
  it('activates gesture LOC audio alongside CMAF video but not for an MSE-only selection', async () => {
    for (const packaging of ['loc', 'cmaf']) {
      const player = new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'mixed', audioActivation: 'gesture' });
      const p = player as any;
      try {
        p.engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: { version: 1, tracks: [
          { name: 'v', role: 'video', packaging: 'cmaf', codec: 'avc1.640028' },
          { name: 'a', role: 'audio', packaging, codec: packaging === 'loc' ? 'opus' : 'mp4a.40.2' },
        ] } });
        expect(p.audioCtx).toBeNull();
        await player.unmute();
        expect(p.audioCtx !== null).toBe(packaging === 'loc');
        expect(p.deferredAudio.isActive).toBe(packaging === 'loc');
      } finally { await player.destroy(); }
    }
  });
  it('controls existing WebAudio with CMAF video without eagerly activating gesture audio', async () => {
    const player = new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'mixed', audioActivation: 'gesture' });
    const p = player as any;
    try {
      p.engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: { version: 1, tracks: [
        { name: 'v', role: 'video', packaging: 'cmaf', codec: 'avc1.640028' },
        { name: 'a', role: 'audio', packaging: 'loc', codec: 'opus' },
      ] } });
      expect(player.activeMediaType).toBe('video');
      player.mute();
      player.setVolume(0.5);
      expect(p.audioCtx).toBeNull();
      const volume = { setVolume: vi.fn(), setMuted: vi.fn() };
      p.volumeCtrl = volume;
      player.setVolume(0.25);
      player.mute();
      expect(volume.setVolume).toHaveBeenLastCalledWith(0.25);
      expect(volume.setMuted).toHaveBeenLastCalledWith(true);
      expect(p.videoElement.muted).toBe(true);
      expect(p.videoElement.volume).toBe(0.25);
      expect(p.audioCtx).toBeNull();
    } finally { p.volumeCtrl = null; await player.destroy(); }
  });
  it('controls CMAF audio even when LOC video uses the canvas', async () => {
    const player = new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'mixed' });
    try {
      (player as any).engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog: { version: 1, tracks: [
        { name: 'v', role: 'video', packaging: 'loc', codec: 'avc1.640028' },
        { name: 'a', role: 'audio', packaging: 'cmaf', codec: 'mp4a.40.2' },
      ] } });
      expect(player.activeMediaType).toBe('canvas');
      player.mute();
      expect((player as any).videoElement.muted).toBe(true);
      player.setVolume(0.25);
      expect((player as any).videoElement.volume).toBe(0.25);
      await player.unmute();
      expect((player as any).videoElement.muted).toBe(false);
    } finally { await player.destroy(); }
  });
  it('keeps the canvas visible for LOCMAF frame decoding', async () => {
    const player = new Player(mockElement(), {
      url: 'https://relay.example.com/moq', namespace: 'test',
      moqtPlayerConfig: { locmafDecoding: 'frame' },
    });
    try {
      (player as any).engine.emitter.emit('catalog_received', {
        type: 'catalog_received',
        catalog: {
          tracks: [{
            name: 'v', packaging: 'locmaf', locmafVersion: '0.3',
            role: 'video', codec: 'avc1.640028', isLive: true,
          }],
        },
      });
      expect((player as any).canvas.hidden).toBe(false);
      expect((player as any)._activeMediaType).toBe('canvas');
    } finally {
      await player.destroy();
    }
  });

  function receiveCatalog(packaging: string, extra: Record<string, unknown> = {}): Player {
    const container = mockElement();
    container.parentNode = { removeChild: vi.fn() };
    const player = new Player(container, { url: 'https://relay.example.com/moq', namespace: 'test', autoplay: false });
    const catalog = {
      version: 1,
      tracks: [
        { name: 'video', packaging, isLive: true, role: 'video', codec: 'avc1.640028', width: 1280, height: 720, bitrate: 2_000_000, ...extra },
        { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', samplerate: 48000, channelConfig: '2' },
      ],
    } as unknown as CatalogState;
    (player as any).engine.emitter.emit('catalog_received', { type: 'catalog_received', catalog });
    return player;
  }

  it('a locmaf video track selects the <video> (MSE) sink, like cmaf', () => {
    expect((receiveCatalog('locmaf', { locmafVersion: '0.3' }) as any)._activeMediaType).toBe('video');
    expect((receiveCatalog('cmaf') as any)._activeMediaType).toBe('video');
  });

  it('a LOC-only catalog keeps the <canvas> sink', () => {
    expect((receiveCatalog('loc') as any)._activeMediaType).toBe('canvas');
  });
});
