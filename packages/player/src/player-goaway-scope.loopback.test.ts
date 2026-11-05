/**
 * A request-stream GOAWAY must affect only the request it names.
 *
 * draft-18 §10.4 and draft-22 §9.2: "A GOAWAY MAY also be sent on a request
 * stream to initiate migration of that individual request." draft-22 §6.6.1 is
 * explicit that this "migrates only that request, leaving the rest of the
 * session in place."
 *
 * The player and connection are both real, driven over the in-memory loopback
 * with two Established media subscriptions. A topology-level test cannot
 * reproduce this: the defect was in how an unscoped notification reached the
 * player's message dispatch, so both halves have to be exercised together.
 *
 * Re-issuing the migrated request is application policy; nothing here asserts
 * an automatic re-issue, because none is performed.
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */

import { describe, expect, it, vi } from 'vitest';
import { SessionState } from '@openmoq/transport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import type { MoqtConnection } from '@openmoq/webtransport';

const td = new TextDecoder();

const CATALOG = {
  version: 1,
  tracks: [
    { name: 'vide_1', packaging: 'loc', isLive: true, role: 'video', renderGroup: 1,
      codec: 'avc1.640029', width: 1920, height: 1080, bitrate: 1_500_000 },
    { name: 'soun_2', packaging: 'loc', isLive: true, role: 'audio', renderGroup: 1,
      codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 128_000 },
  ],
};

/**
 * Reach the server's inbound request-stream context for `requestId` so the test
 * can write a GOAWAY onto that exact stream. There is no public publisher API
 * for a request-stream GOAWAY (`sendGoaway` targets the control stream only),
 * and a send API added only to serve a test would not earn its place in the
 * published surface. Asserting the context exists keeps this honest if the
 * internal name moves.
 */
function requestStream(server: unknown, requestId: bigint): { writeMessage(m: unknown): Promise<void> } {
  const contexts = (server as { inboundRequestContexts?: Map<bigint, unknown> }).inboundRequestContexts;
  expect(contexts, 'server inboundRequestContexts should be reachable').toBeInstanceOf(Map);
  const ctx = contexts!.get(requestId);
  expect(ctx, `server should hold an inbound request stream for request ${requestId}`).toBeDefined();
  return ctx as { writeMessage(m: unknown): Promise<void> };
}

async function boot(draft: 18 | 22 | 23) {
  const pair = await connectedPair(draft);
  const { client, server } = pair;
  const ids = new Map<string, bigint>();
  server.onSubscribe = (id, _namespace, name) => { ids.set(td.decode(name), id); };

  const player = new MoqtPlayer({
    url: 'https://unused.example/moq', namespace: 'live/test', connection: client as unknown as MoqtConnection,
    createTransport: async () => ({}) as never, draftVersion: draft,
    catalogBootstrap: 'subscribe',
    createMediaSource: () => ({
      initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(),
      mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null,
    }),
    createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() }),
  });

  const requestGoaways: Array<{ requestId: bigint; newSessionUri: string; trackName?: string }> = [];
  player.on('request_goaway', (e) => requestGoaways.push({
    requestId: e.requestId, newSessionUri: e.newSessionUri,
    ...(e.trackName !== undefined ? { trackName: e.trackName } : {}),
  }));
  const received: Array<{ track: string; marker: number | undefined }> = [];
  player.on('media_object', (e) => received.push({ track: e.trackName, marker: e.payload?.[0] }));
  const sessionEvents: string[] = [];
  player.on('session_goaway', () => sessionEvents.push('session_goaway'));
  player.on('session_migrated', () => sessionEvents.push('session_migrated'));
  /** Requests the CLIENT told the publisher to stop serving. */
  const closedByClient: bigint[] = [];
  server.onSubscribeClosed = (requestId) => { closedByClient.push(requestId); };

  const send = async (alias: bigint, payload: Uint8Array, group = 1n) => {
    const stream = await server.openSubgroup(alias, group, 0n, { publisherPriority: 128 });
    await server.sendObject(stream, 0n, payload);
    await server.closeSubgroup(stream);
    await flush();
  };

  await player.load();
  await vi.waitFor(() => expect(ids.get('catalog')).toBeDefined());
  const catalogReq = ids.get('catalog')!;
  await server.acceptSubscribe(catalogReq, 100n);
  await send(100n, new TextEncoder().encode(JSON.stringify(CATALOG)));

  await vi.waitFor(() => expect(ids.get('soun_2')).toBeDefined());
  const videoReq = ids.get('vide_1')!;
  const audioReq = ids.get('soun_2')!;
  const videoAlias = 201n;
  const audioAlias = 202n;
  await server.acceptSubscribe(videoReq, videoAlias);
  await server.acceptSubscribe(audioReq, audioAlias);
  await flush();

  return {
    ...pair, player, received, sessionEvents, closedByClient, requestGoaways, send,
    catalogReq, videoReq, audioReq, videoAlias, audioAlias,
    async destroy() {
      await player.destroy();
      await client.close();
      await server.close();
    },
  };
}

describe.each([18, 22, 23] as const)('draft-%i request-stream GOAWAY scope', (draft) => {
  it('preserves unrelated delivery and does not drain the session', async () => {
    const h = await boot(draft);
    try {
      // Both Established requests deliver before the GOAWAY.
      await h.send(h.videoAlias, Uint8Array.of(1));
      await h.send(h.audioAlias, Uint8Array.of(2));
      expect(h.received).toEqual([
        { track: 'vide_1', marker: 1 },
        { track: 'soun_2', marker: 2 },
      ]);

      // A GOAWAY on the video request stream only. §10.4: a request-stream
      // GOAWAY carries no control-only Request ID, and draft-22 has no such
      // field at all.
      await requestStream(h.server, h.videoReq)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush();
      await flush();

      // The unaddressed request must not be cancelled. §6.6.1 (22) / §10.4
      // (18): request migration "leaves the rest of the session in place".
      expect(h.closedByClient, 'client must not unsubscribe the unaddressed request')
        .not.toContain(h.audioReq);

      // And it must still deliver objects, not merely remain present in a map.
      // A terminated publisher-side subscription cannot open a subgroup at all,
      // so a throw here is the same defect surfacing one layer down.
      let delivery: unknown;
      await h.send(h.audioAlias, Uint8Array.of(3), 2n).catch((err) => { delivery = err; });
      expect(delivery, 'unaddressed subscription should still accept objects').toBeUndefined();
      await vi.waitFor(() => expect(h.received).toContainEqual({ track: 'soun_2', marker: 3 }));

      // The session is untouched: no drain, and no session-scope events that
      // would tell an application to reconnect the whole player.
      expect(h.client.session.state).toBe(SessionState.ESTABLISHED);
      expect(h.sessionEvents).toEqual([]);
    } finally { await h.destroy(); }
  });

  it('retires the catalog request and its alias when the catalog is the addressed request', async () => {
    // The catalog tracks its own request identity and alias, separately from the
    // media subscription owners. Leaving them set would keep an authoritative
    // routing identity for a subscription the peer is migrating away. The PARSED
    // catalog is kept — only the dead wire route is cleared.
    const h = await boot(draft);
    try {
      const player = h.player as unknown as { _catalogState?: unknown; catalogSlots: { catalogRequestId: bigint | null; catalogTrackAlias: bigint | null } };
      expect(player.catalogSlots.catalogRequestId).not.toBeNull();

      await requestStream(h.server, h.catalogReq)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush();
      await flush();

      expect(player.catalogSlots.catalogRequestId).toBeNull();
      expect(player.catalogSlots.catalogTrackAlias).toBeNull();
      // Unrelated media is untouched and still delivering.
      expect(h.closedByClient).not.toContain(h.audioReq);
      await h.send(h.audioAlias, Uint8Array.of(9), 3n);
      await vi.waitFor(() => expect(h.received).toContainEqual({ track: 'soun_2', marker: 9 }));
      expect(h.sessionEvents).toEqual([]);
      expect(h.client.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await h.destroy(); }
  });

  it('reports the addressed request and retires only its bookkeeping', async () => {
    const h = await boot(draft);
    try {
      await h.send(h.videoAlias, Uint8Array.of(1));
      await h.send(h.audioAlias, Uint8Array.of(2));

      await requestStream(h.server, h.videoReq)
        .writeMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 0n });
      await flush();
      await flush();

      // One request-scoped report naming the request, its track, and where to
      // re-issue it. An empty URI means the current session (§10.4).
      expect(h.requestGoaways).toEqual([
        { requestId: h.videoReq, newSessionUri: '', trackName: 'vide_1' },
      ]);
      // The addressed subscription is retired so no apparently-active track is
      // left behind; the untouched one is still registered.
      const active = (h.player as unknown as { activeSubscriptions: Map<bigint, unknown> })
        .activeSubscriptions;
      expect(active.has(h.videoReq)).toBe(false);
      expect(active.has(h.audioReq)).toBe(true);
    } finally { await h.destroy(); }
  });
});
