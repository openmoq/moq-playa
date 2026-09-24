import { describe, expect, it, vi } from 'vitest';
import { SessionError, SessionState } from '@moqt/transport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';

async function boot(packaging: 'loc' | 'cmaf') {
  const pair = await connectedPair(18);
  const { client, server } = pair;
  const ids = new Map<string, bigint>();
  server.onSubscribe = (id, _namespace, name) => { ids.set(new TextDecoder().decode(name), id); };
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq', namespace: 'live/test', connection: client,
    createTransport: async () => ({}) as never, draftVersion: 18, catalogBootstrap: 'subscribe',
    createMediaSource: () => ({
      initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(),
      mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null,
    }),
    createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() }),
  });
  const received: Array<{ track: string; marker: number | undefined }> = [];
  player.on('media_object', (e) => received.push({ track: e.trackName, marker: e.payload?.[0] }));
  const send = async (alias: bigint, payload: Uint8Array) => {
    const stream = await server.openSubgroup(alias, 1n, 0n, { publisherPriority: 128 });
    await server.sendObject(stream, 0n, payload);
    await server.closeSubgroup(stream);
    await flush();
  };
  await player.load();
  await vi.waitFor(() => expect(ids.get('catalog')).toBe(0n));
  await server.acceptSubscribe(0n, 100n);
  await send(100n, new TextEncoder().encode(JSON.stringify({
    version: 1,
    tracks: [
      { name: 'vide_1', packaging, isLive: true, role: 'video', renderGroup: 1, codec: 'avc1.640029', width: 1920, height: 1080, bitrate: 1_500_000 },
      { name: 'soun_2', packaging, isLive: true, role: 'audio', renderGroup: 1, codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 128000 },
    ],
  })));
  await vi.waitFor(() => expect(ids.get('soun_2')).toBe(4n));
  expect(ids.get('vide_1')).toBe(2n);
  return { ...pair, player, received, send, async destroy() {
    await player.destroy();
    await client.close();
    await server.close();
  } };
}

describe.each(['loc', 'cmaf'] as const)('%s alias routing over draft-18 streams', (packaging) => {
  it.each(['video-first', 'audio-first'])('accepts an alias equal to another request ID: %s', async (order) => {
    const h = await boot(packaging);
    try {
      const replies = order === 'video-first' ? [[2n, 4n], [4n, 5n]] : [[4n, 5n], [2n, 4n]];
      for (const [request, alias] of replies) await h.server.acceptSubscribe(request!, alias!);
      await h.send(4n, Uint8Array.of(1));
      await h.send(5n, Uint8Array.of(2));
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1 }, { track: 'soun_2', marker: 2 }]);
      expect(h.errors).toEqual([]);
      expect(h.client.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await h.destroy(); }
  });

  it('replays objects and FIN that beat SUBSCRIBE_OK without sending video to audio', async () => {
    const h = await boot(packaging);
    try {
      const response = h.a.bidiOut[1]!.in;
      response.faults.hold = true;
      let earlyObjects = 0;
      const original = h.client.onObject!;
      h.client.onObject = (sid, object) => { earlyObjects++; original(sid, object); };
      await h.server.acceptSubscribe(2n, 4n);
      await h.send(4n, Uint8Array.of(1));
      await vi.waitFor(() => expect(earlyObjects).toBe(1));
      expect(h.received).toEqual([]);
      response.releaseHeld();
      await h.server.acceptSubscribe(4n, 5n);
      await h.send(5n, Uint8Array.of(2));
      expect(h.received).toEqual([{ track: 'vide_1', marker: 1 }, { track: 'soun_2', marker: 2 }]);
      expect(h.errors).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('still closes on an actual duplicate alias for different tracks', async () => {
    const h = await boot(packaging);
    try {
      await h.server.acceptSubscribe(2n, 4n);
      await flush();
      await h.server.acceptSubscribe(4n, 4n);
      await vi.waitFor(() => expect(h.client.session.state).toBe(SessionState.CLOSED));
      expect(h.a.closeInfo?.closeCode).toBe(Number(SessionError.DUPLICATE_TRACK_ALIAS));
      expect(h.received).toEqual([]);
    } finally { await h.destroy(); }
  });
});
