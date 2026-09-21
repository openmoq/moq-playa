import { describe, expect, it, vi } from 'vitest';
import { varint } from '@moqt/transport';
import type { MoqtObject } from '@moqt/transport';
import type { MoqtConnection } from '@moqt/webtransport';
import { MoqtPlayer } from './player.js';
import { audioInit, videoInit } from '../../locmaf/test-support/cmaf.js';

async function boot(options: {
  warmStart?: boolean; acceptVideoInline?: boolean; draft?: 14 | 16 | 18;
  failAudio?: 'before-ok' | 'after-ok'; knownTracks?: boolean; initTracks?: boolean;
} = {}) {
  let next = 0n;
  const ids = new Map<string, bigint>();
  const joins = new Map<bigint, bigint>();
  const alloc = () => { const id = next; next += 2n; return varint(id); };
  const adapter: any = {
    draftVersion: options.draft ?? 18,
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}), requestUpdate: vi.fn(async () => alloc()),
    fetchCancel: vi.fn(async () => {}),
    subscribe: vi.fn(async (_ns, bytes, opts) => {
      const name = new TextDecoder().decode(bytes);
      const id = alloc();
      ids.set(name, id);
      opts?.onRequestId?.(id);
      if (options.acceptVideoInline && name === 'vide_1') ack(id, 4n);
      if (options.failAudio && name === 'soun_2') {
        if (options.failAudio === 'after-ok') ack(id, 8n);
        throw new Error('subscription write failed');
      }
      return id;
    }),
    fetch: vi.fn(async (_ns, _name, opts) => {
      const id = alloc();
      opts?.onRequestId?.(id);
      return id;
    }),
    joiningFetch: vi.fn(async (opts) => {
      const id = alloc();
      joins.set(opts.joiningRequestId, id);
      opts?.onRequestId?.(id);
      return id;
    }),
  };
  const ack = (requestId: bigint, trackAlias: bigint) => adapter.onMessage?.({
    type: 'SUBSCRIBE_OK', requestId: varint(requestId), trackAlias: varint(trackAlias), parameters: new Map(),
  });
  const reject = (requestId: bigint) => adapter.onMessage?.({
    type: 'REQUEST_ERROR', requestId: varint(requestId), errorCode: varint(16), errorReason: 'not found',
  });
  const mediaSource = {
    initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(),
    mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null,
  };
  const player = new MoqtPlayer({
    url: 'https://relay.example/moq', namespace: 'live/test',
    createTransport: async () => ({}) as any,
    createConnection: () => adapter as MoqtConnection,
    catalogBootstrap: 'subscribe', warmStartCurrentGroup: options.warmStart ?? false,
    ...(options.knownTracks ? { knownTracks: {
      video: { name: 'vide_1', codec: 'avc1.640029', width: 1920, height: 1080 },
      audio: { name: 'soun_2', codec: 'opus', samplerate: 48000, channels: 2 },
    } } : {}),
    createMediaSource: () => mediaSource,
    createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() }),
  });
  const received: Array<{ track: string; marker: number | undefined; alias: bigint }> = [];
  const catalogs: unknown[] = [];
  player.on('catalog_received', (event) => catalogs.push(event.catalog));
  player.on('media_object', (event) => received.push({
    track: event.trackName, marker: event.payload?.[8],
    alias: (player as any).activeSubscriptions.get(ids.get(event.trackName))?.trackAlias,
  }));
  const data = (alias: bigint, marker: number): MoqtObject => ({
    kind: 'data', trackAlias: varint(alias), groupId: varint(0), subgroupId: varint(0), objectId: varint(0),
    payload: Uint8Array.of(0, 0, 0, 9, 109, 100, 97, 116, marker),
  });
  const send = (alias: bigint, marker: number, stream = 100n) => adapter.onObject?.(stream, data(alias, marker));
  const header = (requestId: bigint, stream = 200n) => adapter.onDataStream?.(stream, {
    type: 'fetch', header: { requestId: varint(requestId) },
  });
  await player.load();
  const catalogAlias = options.knownTracks ? 2n : 100n;
  if (!options.knownTracks) ack(ids.get('catalog')!, catalogAlias);
  const packaging = options.warmStart || options.knownTracks ? 'loc' : 'cmaf';
  adapter.onObject?.(0n, {
    ...data(catalogAlias, 0), payload: new TextEncoder().encode(JSON.stringify({
      version: 1,
      tracks: [
        { name: 'vide_1', packaging, isLive: true, role: 'video', renderGroup: 1, codec: 'avc1.640029', width: 1920, height: 1080, bitrate: 1_500_000, ...(options.initTracks ? { initTrack: 'init-v' } : {}) },
        { name: 'soun_2', packaging, isLive: true, role: 'audio', renderGroup: 1, codec: options.initTracks ? 'mp4a.40.2' : 'opus', samplerate: 48000, channelConfig: '2', bitrate: 128000, ...(options.initTracks ? { initTrack: 'init-a' } : {}) },
      ],
    })),
  });
  if (options.knownTracks) ack(ids.get('catalog')!, catalogAlias);
  await vi.waitFor(() => expect(ids.has('soun_2')).toBe(true));
  if (options.warmStart) await vi.waitFor(() => expect(joins.size).toBe(2));
  return { player, adapter, ids, joins, ack, reject, send, data, header, received, catalogs, mediaSource };
}

describe('confirmed alias ownership', () => {
  it('parks a catalog whose alias equals a pending known-track request ID', async () => {
    const h = await boot({ knownTracks: true });
    try {
      expect(h.catalogs).toHaveLength(1);
      expect(h.received).toEqual([]);
      h.ack(2n, 0n);
      h.ack(4n, 5n);
      h.send(0n, 1);
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 0n }]);
    } finally { await h.player.destroy(); }
  });

  it.each(['before-ok', 'after-ok'] as const)('send failure %s retires only that request', async (failAudio) => {
    const h = await boot({ acceptVideoInline: true, failAudio });
    try {
      await vi.waitFor(() => expect((h.player as any).activeSubscriptions.has(4n)).toBe(false));
      h.send(4n, 1);
      h.send(8n, 2);
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 4n }]);
    } finally { await h.player.destroy(); }
  });

  it('separate init tracks bind and retire without deleting media aliases equal to their request IDs', async () => {
    const h = await boot({ initTracks: true });
    try {
      await vi.waitFor(() => expect(h.ids.has('init-a')).toBe(true));
      const videoInitId = h.ids.get('init-v')!;
      const audioInitId = h.ids.get('init-a')!;
      h.ack(2n, videoInitId);
      h.ack(4n, audioInitId);
      h.ack(videoInitId, 2n);
      h.ack(audioInitId, 4n);
      const video = videoInit();
      const audio = audioInit();
      h.adapter.onObject(101n, { ...h.data(2n, 0), payload: video });
      h.adapter.onObject(102n, { ...h.data(4n, 0), payload: audio });
      expect(h.mediaSource.initialize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        video: expect.objectContaining({ initData: video }), audio: expect.objectContaining({ initData: audio }),
      }));
      h.send(videoInitId, 1);
      h.send(audioInitId, 2);
      expect(h.received).toEqual([
        { track: 'vide_1', marker: 1, alias: videoInitId }, { track: 'soun_2', marker: 2, alias: audioInitId },
      ]);
    } finally { await h.player.destroy(); }
  });

  it.each([14, 16, 18] as const)('a new request cannot overwrite an established alias (draft %i)', async (draft) => {
    const h = await boot({ acceptVideoInline: true, draft });
    try {
      expect(h.ids.get('soun_2')).toBe(4n);
      h.send(4n, 1);
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 4n }]);
    } finally { await h.player.destroy(); }
  });

  it.each(['audio-first', 'video-first'])('swapped numeric IDs remain independent: %s', async (order) => {
    const h = await boot();
    try {
      const replies = order === 'audio-first' ? [[4n, 2n], [2n, 4n]] : [[2n, 4n], [4n, 2n]];
      for (const [request, alias] of replies) h.ack(request!, alias!);
      h.send(4n, 1);
      h.send(2n, 2);
      expect(h.received).toEqual([
        { track: 'vide_1', marker: 1, alias: 4n }, { track: 'soun_2', marker: 2, alias: 2n },
      ]);
    } finally { await h.player.destroy(); }
  });

  it('rejecting a pending request does not unregister another track with that alias', async () => {
    const h = await boot({ acceptVideoInline: true });
    try {
      h.reject(4n);
      h.send(4n, 1);
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 4n }]);
    } finally { await h.player.destroy(); }
  });

  it('an early datagram cannot be guessed from a pending request ID', async () => {
    const h = await boot();
    try {
      const object = h.data(4n, 1);
      h.adapter.onDatagram({ ...object, typeByte: 0, publisherPriority: 128, isEndOfGroup: false });
      expect(h.received).toEqual([]);
      h.ack(2n, 4n);
      h.ack(4n, 5n);
      h.adapter.onDatagram({ ...object, typeByte: 0, publisherPriority: 128, isEndOfGroup: false });
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 4n }]);
    } finally { await h.player.destroy(); }
  });

  it('a rejected request cannot later bind an alias or replay its parked objects', async () => {
    const h = await boot();
    try {
      h.send(40n, 1);
      h.reject(2n);
      h.reject(4n);
      h.ack(2n, 40n);
      h.send(40n, 2);
      expect(h.received).toEqual([]);
    } finally { await h.player.destroy(); }
  });

  it('accepts zero and aliases above Number.MAX_SAFE_INTEGER', async () => {
    const h = await boot();
    try {
      const large = 2n ** 54n + 1n;
      h.ack(2n, 0n);
      h.ack(4n, large);
      h.send(0n, 1);
      h.send(large, 2);
      expect(h.received).toEqual([
        { track: 'vide_1', marker: 1, alias: 0n }, { track: 'soun_2', marker: 2, alias: large },
      ]);
    } finally { await h.player.destroy(); }
  });
});

describe('FETCH subscription ownership', () => {
  it('retires the oldest FETCH on pending-stream overflow without touching live alias zero', async () => {
    const h = await boot();
    try {
      h.ack(4n, 0n);
      const fetches: bigint[] = [];
      for (let i = 0; i < 9; i++) {
        const id = await h.player.fetch('vide_1', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
        fetches.push(id);
        h.header(id, BigInt(200 + i));
        h.send(0n, i, BigInt(200 + i));
      }
      expect((h.player as any).activeFetches.has(fetches[0])).toBe(false);
      expect((h.player as any).pendingFetchStreams.size).toBe(8);
      h.ack(2n, 40n);
      expect(h.received.map((e) => e.marker)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      h.send(0n, 9, 200n);
      expect(h.received).toHaveLength(8);
      h.send(0n, 10, 300n);
      expect(h.received.at(-1)).toEqual({ track: 'soun_2', marker: 10, alias: 0n });
    } finally { await h.player.destroy(); }
  });

  it.each(['objects', 'bytes'] as const)('discards the whole pending FETCH on %s overflow without alias-zero fallback', async (limit) => {
    const h = await boot();
    try {
      h.ack(4n, 0n);
      const fetchId = await h.player.fetch('vide_1', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
      h.header(fetchId);
      if (limit === 'objects') {
        for (let i = 0; i < 257; i++) h.send(0n, 1, 200n);
      } else {
        h.adapter.onObject(200n, { ...h.data(0n, 1), payload: new Uint8Array(4 * 1024 * 1024 + 1) });
      }
      h.ack(2n, 40n);
      h.send(0n, 2, 200n);
      expect(h.received).toEqual([]);
      h.send(0n, 3, 300n);
      expect(h.received).toEqual([{ track: 'soun_2', marker: 3, alias: 0n }]);
    } finally { await h.player.destroy(); }
  });

  it.each(['cancel', 'destroy'] as const)('stops a pending FETCH replay on reentrant %s', async (action) => {
    const h = await boot();
    let teardown: Promise<void> | undefined;
    try {
      const fetchId = await h.player.fetch('vide_1', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
      h.header(fetchId);
      h.send(0n, 1, 200n);
      h.send(0n, 2, 200n);
      h.player.on('media_object', () => {
        teardown = action === 'cancel' ? h.player.fetchCancel(fetchId) : h.player.destroy();
      });
      h.ack(2n, 40n);
      await teardown;
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 40n }]);
    } finally { await h.player.destroy(); }
  });

  it.each(['public', 'joining'] as const)('holds %s FETCH data and FIN until the alias is confirmed', async (kind) => {
    const h = await boot({ warmStart: kind === 'joining' });
    try {
      const videoId = h.ids.get('vide_1')!;
      const fetchId = kind === 'joining' ? h.joins.get(videoId)! : await h.player.fetch('vide_1', {
        startGroup: 0, startObject: 0, endGroup: 1, endObject: 0,
      });
      h.header(fetchId);
      h.send(0n, 1, 200n);
      h.adapter.onStreamClosed(200n, undefined, 'fin');
      expect(h.received).toEqual([]);
      h.ack(videoId, 40n);
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 40n }]);
      h.ack(h.ids.get('soun_2')!, 50n);
      expect(h.received).toHaveLength(1);
    } finally { await h.player.destroy(); }
  });

  it('another request sharing the numeric alias cannot retarget an established FETCH', async () => {
    const h = await boot({ acceptVideoInline: true });
    try {
      const fetchId = await h.player.fetch('vide_1', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
      h.header(fetchId);
      h.ack(4n, 5n);
      h.send(0n, 1, 200n);
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1, alias: 4n }]);
    } finally { await h.player.destroy(); }
  });

  it.each(['cancel', 'reject', 'destroy'] as const)('does not replay FETCH data after %s', async (terminal) => {
    const h = await boot();
    try {
      const fetchId = await h.player.fetch('vide_1', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
      h.header(fetchId);
      h.send(0n, 1, 200n);
      if (terminal === 'cancel') await h.player.fetchCancel(fetchId);
      else if (terminal === 'reject') h.reject(fetchId);
      else await h.player.destroy();
      h.ack(2n, 40n);
      h.send(0n, 2, 200n);
      expect(h.received).toEqual([]);
    } finally { await h.player.destroy(); }
  });
});
