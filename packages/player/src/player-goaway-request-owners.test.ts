/**
 * Every player-owned operation keyed by a request ID must be settled when that
 * request receives a GOAWAY.
 *
 * Retiring the subscription is not enough: a FETCH, a one-shot catalog FETCH, a
 * codec switch's init track, and a TRACK_STATUS query each own a promise, a
 * timer, or late-data routing of their own. Left live, they wait for a peer that
 * has stopped serving the request. Only the addressed request is touched, and
 * nothing is re-issued — that remains application policy
 * (draft-18 §10.4, draft-22 §9.2).
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionState } from '@openmoq/transport';
import type { MoqtConnection } from '@openmoq/webtransport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';

async function boot(draft: 18 | 22 | 23) {
  const pair = await connectedPair(draft);
  const { client, server } = pair;
  const requests = new Map<string, bigint>();
  server.onSubscribe = (id, _namespace, name) => requests.set(new TextDecoder().decode(name), id);
  server.onFetch = () => {};
  const player = new MoqtPlayer({
    url: 'https://unused.example/moq', namespace: 'review', connection: client as unknown as MoqtConnection,
    createTransport: async () => ({}) as never, draftVersion: draft, catalogBootstrap: 'subscribe',
    createMediaSource: () => ({
      initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(),
      mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null,
    }),
    createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() }),
  });
  await player.load();
  await vi.waitFor(() => expect(requests.has('catalog')).toBe(true));
  await server.acceptSubscribe(requests.get('catalog')!, 100n);
  const stream = await server.openSubgroup(100n, 1n, 0n, { publisherPriority: 128 });
  await server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify({
    version: 1,
    tracks: [
      { name: 'video_hevc', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1,
        altGroup: 1, codec: 'hvc1.1.6.L93.90', width: 1280, height: 720, bitrate: 800_000,
        initTrack: 'init-hevc' },
      { name: 'video_avc', packaging: 'cmaf', isLive: true, role: 'video', renderGroup: 1,
        altGroup: 1, codec: 'avc1.4D401F', width: 1280, height: 720, bitrate: 600_000,
        initData: 'AAAA' },
    ],
  })));
  await server.closeSubgroup(stream);
  await vi.waitFor(() => expect(requests.has('video_avc')).toBe(true));
  await server.acceptSubscribe(requests.get('video_avc')!, 200n);
  await flush(32);
  const goaway = async (id: bigint) => {
    const contexts = (server as unknown as {
      inboundRequestContexts: Map<bigint, { writeMessage(m: unknown): Promise<void> }>;
    }).inboundRequestContexts;
    expect(contexts.has(id)).toBe(true);
    await contexts.get(id)!.writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
    await flush(32);
  };
  return { ...pair, player, requests, goaway, async destroy() {
    await player.destroy(); await client.close(); await server.close();
  } };
}

describe.each([18, 22, 23] as const)('draft-%i request owner cleanup', (draft) => {
  it('retires a media FETCH when that FETCH gets GOAWAY', async () => {
    const h = await boot(draft);
    try {
      const id = await h.player.fetch('video_avc', { startGroup: 0, startObject: 0, endGroup: 1, endObject: 0 });
      const state = h.player as unknown as { activeFetches: Map<bigint, unknown>; quarantinedFetchRequests: Set<bigint> };
      expect(state.activeFetches.has(id)).toBe(true);
      await h.goaway(id);
      expect(h.client.session.getFetch(id)).toBeUndefined();
      expect(h.client.session.state).toBe(SessionState.ESTABLISHED);
      expect(state.activeFetches.has(id)).toBe(false);
      expect(state.quarantinedFetchRequests.has(id)).toBe(true);
    } finally { await h.destroy(); }
  });

  it('rejects an independent catalog FETCH immediately when it gets GOAWAY', async () => {
    const h = await boot(draft);
    try {
      let id: bigint | undefined;
      h.server.onFetch = (requestId) => { id = requestId; };
      let result = 'pending';
      const pending = h.player.fetchCatalog({ timeoutMs: 60_000 });
      void pending.then(() => { result = 'resolved'; }, () => { result = 'rejected'; });
      await vi.waitFor(() => expect(id).toBeDefined());
      await h.goaway(id!);
      expect(h.client.session.getFetch(id!)).toBeUndefined();
      expect(result).toBe('rejected');
    } finally { await h.destroy(); }
  });

  it('settles a codec-switch init request when its stream gets GOAWAY', async () => {
    const h = await boot(draft);
    try {
      let result = 'pending';
      const pending = h.player.selectVideoTrack('video_hevc');
      void pending.then(() => { result = 'resolved'; }, () => { result = 'rejected'; });
      await vi.waitFor(() => expect(h.requests.has('init-hevc')).toBe(true));
      const id = h.requests.get('init-hevc')!;
      await h.server.acceptSubscribe(id, 201n);
      await flush(32);
      await h.goaway(id);
      expect(h.client.session.getSubscription(id)).toBeUndefined();
      expect(result).toBe('rejected');
    } finally { await h.destroy(); }
  });

  it('rejects a track-status query when its request gets GOAWAY', async () => {
    const h = await boot(draft);
    try {
      let id: bigint | undefined;
      h.server.onTrackStatus = (requestId) => { id = requestId; };
      let result = 'pending';
      const pending = h.player.queryTrackStatus('video_avc');
      void pending.then(() => { result = 'resolved'; }, () => { result = 'rejected'; });
      await vi.waitFor(() => expect(id).toBeDefined());
      await h.goaway(id!);
      expect(result).toBe('rejected');
    } finally { await h.destroy(); }
  });
});
