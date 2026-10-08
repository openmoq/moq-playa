import { describe, expect, it, vi } from 'vitest';
import type { CatalogState } from '@openmoq/msf';
import type { MoqtConnection } from '@openmoq/webtransport';
import { varint } from '@openmoq/transport';
import { MoqtPlayer } from './player.js';
import type { MoqtPlayerConfig } from './config.js';
import type { QualityController } from './quality-controller.js';

const catalog: CatalogState = {
  version: 1,
  tracks: [
    { name: 'landscape-high', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', altGroup: 7, bitrate: 2000 },
    { name: 'portrait', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', altGroup: 0, bitrate: 3000 },
    { name: 'landscape-low', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', altGroup: 7, bitrate: 1000 },
    { name: 'audio', role: 'audio', packaging: 'loc', isLive: true, codec: 'opus', samplerate: 48000, channelConfig: '2' },
  ],
};

function makePlayer(options: Partial<MoqtPlayerConfig> = {}, wireCatalog = false) {
  let nextId = 0n;
  const connection = {
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    subscribe: vi.fn(async (_namespace, _track, opts) => {
      const id = varint(nextId);
      nextId += 2n;
      opts?.onRequestId?.(id);
      return id;
    }),
    unsubscribe: vi.fn(async () => {}),
  };
  const player = new MoqtPlayer({
    url: 'https://relay.example/moq', namespace: 'views', ...(!wireCatalog ? { catalog } : {}),
    createTransport: async () => ({}) as never,
    createConnection: () => connection as unknown as MoqtConnection,
    ...options,
  });
  const subscribed = () => connection.subscribe.mock.calls.map(call => new TextDecoder().decode(call[1]));
  return { player, connection, subscribed };
}

describe('player video alternate groups', () => {
  it('reclaims a transport whose factory resolves after destruction', async () => {
    let release!: (transport: any) => void;
    const transport = { close: vi.fn() };
    const h = makePlayer({ createTransport: () => new Promise(resolve => { release = resolve; }) });
    const loading = h.player.load();
    const rejected = expect(loading).rejects.toThrow('destroyed');
    await h.player.destroy();
    release(transport);
    await rejected;
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(h.connection.connect).not.toHaveBeenCalled();
    await h.player.destroy();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
  it('selects the injected catalog view despite an unused knownTracks hint', async () => {
    const h = makePlayer({ videoAltGroup: 0, knownTracks: { video: { name: 'landscape-low', codec: 'avc1.640028' } } });
    try {
      await h.player.load();
      expect(h.subscribed()).toEqual(['portrait', 'audio']);
    } finally { await h.player.destroy(); }
  });

  const codecCatalog: CatalogState = { version: 1, tracks: [
    { name: 'hevc-high', role: 'video', packaging: 'loc', isLive: true, codec: 'hvc1.1.6.L93.B0', altGroup: 0, bitrate: 2_000_000 },
    { name: 'hevc-low', role: 'video', packaging: 'loc', isLive: true, codec: 'hvc1.1.6.L93.B0', altGroup: 0, bitrate: 1_000_000 },
    { name: 'avc-low', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028', altGroup: 0, bitrate: 100_000 },
  ] };
  it('creates ABR for a committed codec family and removes it for a singleton family', async () => {
    const h = makePlayer({ catalog: codecCatalog, videoAltGroup: 0, startLevel: 2 });
    const p = h.player as any;
    try {
      await h.player.load();
      expect(p.bufferAbrController).toBeNull();
      await h.player.selectVideoTrack('hevc-high');
      expect(p.bufferAbrController).toBeNull(); // Staged, not committed.
      p.completePendingVideoSwitch();
      h.player.setAutoQuality(true);
      expect(p.bufferAbrController?.currentTrack.name).toBe('hevc-high');
      expect(p.bufferAbrController.evaluate({ bufferDepthUs: 0, bandwidthEstimateKbps: 0 })).toEqual({ action: 'downshift', targetIndex: 1 });
      await h.player.selectVideoTrack('hevc-low');
      p.completePendingVideoSwitch();
      expect(p.bufferAbrController.currentTrack.name).toBe('hevc-low');
      await h.player.selectVideoTrack('avc-low');
      p.completePendingVideoSwitch();
      expect(p.bufferAbrController).toBeNull();
    } finally { await h.player.destroy(); }
  });
  it('keeps ABR on the committed track when a codec switch fails', async () => {
    const h = makePlayer({ catalog: codecCatalog, videoAltGroup: 0, startLevel: 0 });
    const p = h.player as any;
    try {
      await h.player.load();
      const controller = p.bufferAbrController;
      h.connection.subscribe.mockRejectedValueOnce(new Error('rejected switch'));
      await expect(h.player.selectVideoTrack('avc-low')).rejects.toThrow('rejected switch');
      expect(p.bufferAbrController).toBe(controller);
      expect(controller.currentTrack.name).toBe('hevc-high');
    } finally { await h.player.destroy(); }
  });
  it('commits an ABR downshift exactly once', async () => {
    const h = makePlayer({ catalog: codecCatalog, videoAltGroup: 0, startLevel: 0 });
    const p = h.player as any;
    try {
      await h.player.load();
      await h.player.selectVideoTrack('hevc-low', 'abr', 'downshift');
      expect(p.bufferAbrController.currentTrack.name).toBe('hevc-high');
      p.completePendingVideoSwitch();
      expect(p.bufferAbrController.currentTrack.name).toBe('hevc-low');
      expect(p.bufferAbrController.index).toBe(1);
      p.completePendingVideoSwitch();
      expect(p.bufferAbrController.index).toBe(1);
    } finally { await h.player.destroy(); }
  });
  it('selects a negative integer alternate-group label', async () => {
    const signedCatalog: CatalogState = { ...catalog,
      tracks: catalog.tracks.map(track => track.altGroup === 0 ? { ...track, altGroup: -1 } : track),
    };
    const h = makePlayer({ catalog: signedCatalog, videoAltGroup: -1 });
    try {
      await h.player.load();
      expect(h.subscribed()).toEqual(['portrait', 'audio']);
    } finally { await h.player.destroy(); }
  });
  it('adopts the known-video group when registration follows catalog arrival', async () => {
    const h = makePlayer({ catalogBootstrap: 'subscribe', knownTracks: {
      video: { name: 'portrait', codec: 'avc1.640028' },
    } }, true);
    let release!: () => void;
    const registration = new Promise<void>(resolve => { release = resolve; });
    const subscribe = h.connection.subscribe.getMockImplementation()!;
    h.connection.subscribe.mockImplementation(async (...args) => {
      if (new TextDecoder().decode(args[1]) === 'portrait') await registration;
      return subscribe(...args);
    });
    const loading = h.player.load();
    const knownCatalog: CatalogState = { ...catalog, tracks: [...catalog.tracks,
      { name: 'portrait-av1', role: 'video', packaging: 'loc', isLive: true,
        codec: 'av01.0.08M.08', altGroup: 0, bitrate: 1000 },
    ] };
    try {
      await vi.waitFor(() => expect(h.connection.subscribe).toHaveBeenCalledTimes(2));
      const requestId = await h.connection.subscribe.mock.results[0]!.value;
      (h.connection as any).onMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(100), parameters: new Map() });
      (h.connection as any).onObject(0n, { kind: 'data', trackAlias: varint(100),
        groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        payload: new TextEncoder().encode(JSON.stringify(knownCatalog)),
      });
      release();
      await loading;
      const quality = (h.player as unknown as { qualityController: QualityController }).qualityController;
      expect(quality.currentVideoTrack?.name).toBe('portrait');
      expect(quality.currentVideoTrack?.codec).toBe('avc1.640028');
      expect(quality.alternatives.map(t => t.name)).toEqual(['portrait']);
      expect(h.player.availableVideoTracks.map(t => t.name)).toEqual(['portrait', 'portrait-av1']);
    } finally {
      release();
      await loading.catch(() => {});
      await h.player.destroy();
    }
  });
  it('keeps injected-catalog selection authoritative when the knownTracks fast path was not used', async () => {
    const h = makePlayer({ knownTracks: { video: { name: 'portrait', codec: 'avc1.640028' } } });
    try {
      await h.player.load();
      expect(h.subscribed()).toEqual(['landscape-low', 'audio']);
      expect((h.player as any).qualityController.currentVideoTrack.name).toBe('landscape-low');
    } finally { await h.player.destroy(); }
  });
  it('passes the explicit group to actual subscription selection', async () => {
    const h = makePlayer({ videoAltGroup: 0 });
    try {
      await h.player.load();
      expect(h.subscribed()).toEqual(['portrait', 'audio']);
      expect(h.player.availableVideoTracks.map(t => t.name)).toEqual(['portrait']);
      expect(h.player.availableVideoGroups.map(g => [g.altGroup, g.tracks.map(t => t.name)])).toEqual([
        [7, ['landscape-high', 'landscape-low']], [0, ['portrait']],
      ]);
    } finally { await h.player.destroy(); }
  });

  it('returns catalog group snapshots rather than mutable selection state', async () => {
    const h = makePlayer({ videoAltGroup: 0 });
    try {
      await h.player.load();
      const groups = h.player.availableVideoGroups;
      groups[0]!.tracks.length = 0;
      expect(h.player.availableVideoGroups[0]!.tracks.map(t => t.name)).toEqual(['landscape-high', 'landscape-low']);
      expect(h.player.availableVideoTracks.map(t => t.name)).toEqual(['portrait']);
    } finally { await h.player.destroy(); }
  });

  it('preserves first-group tune-in when no group is requested', async () => {
    const h = makePlayer();
    try {
      await h.player.load();
      expect(h.subscribed()).toEqual(['landscape-low', 'audio']);
    } finally { await h.player.destroy(); }
  });

  it('fails an unknown group before sending any media subscription', async () => {
    const h = makePlayer({ videoAltGroup: 99 });
    try {
      await expect(h.player.load()).rejects.toThrow('Unknown video altGroup: 99');
      expect(h.subscribed()).toEqual([]);
    } finally { await h.player.destroy(); }
  });

  it('does not treat a different view as an aligned quality switch or disable ABR on rejection', async () => {
    const h = makePlayer();
    try {
      await h.player.load();
      const quality = (h.player as any).qualityController;
      await expect(h.player.selectVideoTrack('portrait')).rejects.toThrow('different video altGroup');
      expect(h.subscribed()).toEqual(['landscape-low', 'audio']);
      expect(h.connection.unsubscribe).not.toHaveBeenCalled();
      expect(quality.isAutoQuality).toBe(true);
      expect(quality.currentVideoTrack.name).toBe('landscape-low');
    } finally { await h.player.destroy(); }
  });

  it('keeps two player instances in independently selected groups', async () => {
    const left = makePlayer();
    const right = makePlayer({ videoAltGroup: 0 });
    try {
      await Promise.all([left.player.load(), right.player.load()]);
      expect(left.subscribed()).toEqual(['landscape-low', 'audio']);
      expect(right.subscribed()).toEqual(['portrait', 'audio']);
      expect(left.player.availableVideoTracks.map(t => t.name)).toEqual(['landscape-high', 'landscape-low']);
      expect(right.player.availableVideoTracks.map(t => t.name)).toEqual(['portrait']);
    } finally { await Promise.all([left.player.destroy(), right.player.destroy()]); }
  });

  it('cannot bypass view selection from a catalog callback', async () => {
    const h = makePlayer({ videoAltGroup: 0 });
    let callbackSwitch: Promise<void> | undefined;
    h.player.on('catalog_received', () => {
      callbackSwitch = h.player.selectVideoTrack('landscape-high');
      void callbackSwitch.catch(() => {});
    });
    try {
      await h.player.load();
      await expect(callbackSwitch).rejects.toThrow('video selection not ready');
      expect(h.subscribed()).toEqual(['portrait', 'audio']);
    } finally { await h.player.destroy(); }
  });

  it('does not send a callback subscription when the requested initial group is missing', async () => {
    const h = makePlayer({ videoAltGroup: 99 });
    let callbackSwitch: Promise<void> | undefined;
    h.player.on('catalog_received', () => {
      callbackSwitch = h.player.selectVideoTrack('landscape-high');
      void callbackSwitch.catch(() => {});
    });
    try {
      await expect(h.player.load()).rejects.toThrow('Unknown video altGroup');
      await expect(callbackSwitch).rejects.toThrow('video selection not ready');
      expect(h.subscribed()).toEqual([]);
    } finally { await h.player.destroy(); }
  });

  it('guards the actual pre-known track group rather than the controller default', async () => {
    const h = makePlayer({ catalogBootstrap: 'subscribe', knownTracks: {
      video: { name: 'portrait', codec: 'avc1.640028' },
    } }, true);
    try {
      await h.player.load();
      const catalogRequest = h.connection.subscribe.mock.results[0]!;
      const requestId = await catalogRequest.value;
      (h.connection as any).onMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(100), parameters: new Map() });
      (h.connection as any).onObject(0n, { kind: 'data', trackAlias: varint(100),
        groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
        payload: new TextEncoder().encode(JSON.stringify(catalog)),
      });
      expect(h.player.availableVideoTracks.map(t => t.name)).toEqual(['portrait']);
      expect((h.player as any).qualityController.currentVideoTrack.name).toBe('portrait');
      // Inject stale controller bookkeeping: the live subscription remains
      // authoritative even if a future catalog path rebuilds the wrong ladder.
      (h.player as any).qualityController.selectInitialTracks(catalog);
      await expect(h.player.selectVideoTrack('portrait')).resolves.toBeUndefined();
      h.player.setAutoQuality(true);
      await expect(h.player.selectVideoTrack('landscape-high')).rejects.toThrow('different video altGroup');
      expect(h.subscribed()).toEqual(['catalog', 'portrait']);
      expect((h.player as any).qualityController.isAutoQuality).toBe(true);
    } finally { await h.player.destroy(); }
  });
});
