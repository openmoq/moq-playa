/**
 * Retiring a request must retire what it was DRIVING, not only its identity.
 *
 * The catalog's retrieval owns an inactivity timer and a legacy-resubscribe
 * fallback. Left running after its request is migrated away, it reissues the
 * catalog SUBSCRIBE on the OLD session — which is neither the migration the peer
 * asked for (draft-18 §10.4 and draft-22 §9.2 point the client at the supplied
 * URI, and require it when provided) nor the no-automatic-reissue policy this
 * path promises. The parsed catalog is kept; only the dead route and its
 * machinery go.
 *
 * Also covers the ownership race: a peer that sends GOAWAY straight from its
 * TRACK_STATUS handler can be answered before the caller's `await` continuation
 * runs, so the waiter has to be registered before any bytes reach the peer.
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
import { CATALOG_BOOTSTRAP_INACTIVITY_MS } from './catalog-bootstrap.js';

async function boot(draft: 18 | 22 | 23, bootstrap: 'auto' | 'subscribe' = 'auto') {
  const pair = await connectedPair(draft);
  const catalogIds: bigint[] = [];
  pair.server.onSubscribe = (id) => { catalogIds.push(id); };
  const fetchIds: bigint[] = [];
  pair.server.onFetch = (id) => { fetchIds.push(id); };
  const player = new MoqtPlayer({
    url: 'https://old.example/moq', namespace: 'live/test', draftVersion: draft,
    connection: pair.client as unknown as MoqtConnection,
    createTransport: async () => ({}) as never, catalogBootstrap: bootstrap,
  });
  const notices: bigint[] = [];
  player.on('request_goaway', (event) => { notices.push(event.requestId); });
  await player.load();
  await flush(64);
  expect(catalogIds).toHaveLength(1);
  const goaway = async (id: bigint) => {
    const contexts = (pair.server as unknown as {
      inboundRequestContexts: Map<bigint, { writeMessage(message: unknown): Promise<void> }>;
    }).inboundRequestContexts;
    expect(contexts.has(id)).toBe(true);
    await contexts.get(id)!.writeMessage({
      type: 'GOAWAY', newSessionUri: 'https://new.example/moq', timeout: 0n,
    });
    await flush(64);
  };
  return { ...pair, player, catalogIds, fetchIds, notices, goaway, async destroy() {
    await player.destroy(); await pair.client.close(); await pair.server.close();
  } };
}

describe.each([18, 22, 23] as const)('draft-%i catalog retirement boundaries', (draft) => {
  it('does not reissue a redirected catalog on the old session after its bootstrap timeout', async () => {
    vi.useFakeTimers();
    const h = await boot(draft);
    try {
      const id = h.catalogIds[0]!;
      await h.server.acceptSubscribe(id, 100n);
      await flush(64);
      await h.goaway(id);
      expect(h.notices).toEqual([id]);
      expect(h.client.session.state).toBe(SessionState.ESTABLISHED);
      await vi.advanceTimersByTimeAsync(CATALOG_BOOTSTRAP_INACTIVITY_MS + 1);
      await flush(64);
      const state = h.player as unknown as { catalogSlots: { catalogRequestId: bigint | null; catalogBootstrapCoord: { phase: string } | null; bootstrapFetch: unknown } };
      expect(h.catalogIds).toEqual([id]);
      expect(state.catalogSlots.catalogRequestId).toBeNull();
      expect(state.catalogSlots.bootstrapFetch === null).toBe(true);
      expect(state.catalogSlots.catalogBootstrapCoord === null || state.catalogSlots.catalogBootstrapCoord.phase === 'aborted').toBe(true);
    } finally { await h.destroy(); vi.useRealTimers(); }
  });

  // draft-18 only: the draft-22 bootstrap feeds the catalog with a FILL rather
  // than a joining FETCH, so there is no separate FETCH request to address
  // there. The draft-22 FILL owner is covered by the test above, which asserts
  // `bootstrapFetch` is cleared when the SUBSCRIBE is the addressed request.
  it.runIf(draft === 18)('retires the retrieval when the GOAWAY addresses the bootstrap FETCH instead', async () => {
    // The catalog's retrieval is reachable through its SUBSCRIBE or through the
    // joining FETCH that feeds it. Either address must retire the whole thing;
    // otherwise the coordinator keeps its timer and reissues on the old session.
    vi.useFakeTimers();
    const h = await boot(draft);
    try {
      const subId = h.catalogIds[0]!;
      // The Largest Location in SUBSCRIBE_OK (§5.1) anchors the joining FETCH,
      // so accepting with it is what makes the bootstrap issue one.
      await h.server.acceptSubscribe(subId, 100n, {
        parameters: new Map([[0x09n, [{ group: 5n, object: 1n }]]]) as never,
      });
      await flush(64);
      expect(h.fetchIds).toHaveLength(1);
      const fetchId = h.fetchIds[0]!;

      await h.goaway(fetchId);
      expect(h.notices).toEqual([fetchId]);

      await vi.advanceTimersByTimeAsync(CATALOG_BOOTSTRAP_INACTIVITY_MS + 1);
      await flush(64);

      const state = h.player as unknown as { catalogSlots: { catalogBootstrapCoord: { phase: string } | null; bootstrapFetch: unknown } };
      // No reissue on the old session, and the retrieval machinery is gone.
      expect(h.catalogIds).toEqual([subId]);
      expect(state.catalogSlots.catalogBootstrapCoord).toBeNull();
      expect(state.catalogSlots.bootstrapFetch).toBeNull();
      expect(h.client.session.state).toBe(SessionState.ESTABLISHED);
    } finally { vi.useRealTimers(); await h.destroy(); }
  });

  it('settles a status query when GOAWAY is sent immediately by the peer', async () => {
    const h = await boot(draft, 'subscribe');
    try {
      let id: bigint | undefined;
      h.server.onTrackStatus = (requestId) => {
        id = requestId;
        void h.goaway(requestId);
      };
      let outcome = 'pending';
      void h.player.queryTrackStatus('video').then(
        () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
      );
      await flush(128);
      expect(id).toBeDefined();
      expect(h.notices).toContain(id);
      expect(outcome).toBe('rejected');
    } finally { await h.destroy(); }
  });
});
