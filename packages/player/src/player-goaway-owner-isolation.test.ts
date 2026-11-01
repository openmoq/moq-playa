/**
 * A request-scoped GOAWAY must retire its own owner and nothing else.
 *
 * draft-18 §10.4 and draft-22 §9.2 scope the signal to the individual request,
 * so retiring the catalog must not reach unrelated pending work. The catalog's
 * bootstrap generation is a SHARED cancellation token — `subscribeToMediaTracks`
 * and `subscribeAuxTrackOwned` observe it too — so bumping it to fence stale
 * bootstrap continuations also aborted independent init-track operations. The
 * `catalog GOAWAY=false` cases are the controls: the same schedule without the
 * GOAWAY must preserve that waiter.
 *
 * Also covers the two identities the catalog can be addressed through beyond its
 * active SUBSCRIBE — a staged recovery candidate's own request, and the bootstrap
 * FETCH — and TRACK_STATUS waiter ownership, where request IDs are per-session
 * and a replacement connection may legitimately reuse one.
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MoqtConnection } from '@openmoq/webtransport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function mediaPair(draft: 18 | 22) {
  const pair = await connectedPair(draft, { clientOptions: { terminatedAliasTtlMs: 1 } });
  const requests: Array<{ id: bigint; name: string }> = [];
  pair.server.onSubscribe = (id, _ns, name) => {
    requests.push({ id, name: new TextDecoder().decode(name) });
  };
  pair.server.onFetch = () => {};
  const player = new MoqtPlayer({
    url: 'https://old.example/moq', namespace: 'review', draftVersion: draft,
    connection: pair.client as unknown as MoqtConnection,
    createTransport: async () => ({}) as never, catalogBootstrap: 'subscribe',
    createMediaSource: () => ({
      initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(),
      mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null,
    }),
    createCmafAssembler: () => ({ push: vi.fn(), getEpoch: () => null, reset: vi.fn(), destroy: vi.fn() }),
  });
  await player.load();
  await flush(64);
  const catalogId = requests.find(r => r.name === 'catalog')!.id;
  await pair.server.acceptSubscribe(catalogId, 100n);
  const stream = await pair.server.openSubgroup(100n, 1n, 0n, { publisherPriority: 128 });
  await pair.server.sendObject(stream, 0n, new TextEncoder().encode(JSON.stringify({
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
  await pair.server.closeSubgroup(stream);
  await flush(128);
  const videoId = requests.find(r => r.name === 'video_avc')!.id;
  await pair.server.acceptSubscribe(videoId, 200n);
  await flush(64);
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
  return { ...pair, player, requests, catalogId, videoId, goaway,
    async destroy() { await player.destroy(); await pair.client.close(); await pair.server.close(); },
  };
}

describe.each([18, 22] as const)('draft-%i remaining catalog ownership', (draft) => {
  it.each([false, true])('keeps an independent init send alive (catalog GOAWAY=%s)', async (redirect) => {
    const h = await mediaPair(draft);
    const gate = deferred<void>();
    const original = h.client.subscribe.bind(h.client);
    vi.spyOn(h.client, 'subscribe').mockImplementation(async (ns, name, options) => {
      const id = await original(ns, name, options);
      if (new TextDecoder().decode(name) === 'init-hevc') await gate.promise;
      return id;
    });
    let outcome = 'pending';
    const switching = h.player.selectVideoTrack('video_hevc');
    void switching.then(() => { outcome = 'resolved'; }, (e) => { outcome = `rejected: ${e.message}`; });
    try {
      await flush(128);
      const initId = h.requests.find(r => r.name === 'init-hevc')!.id;
      await h.server.acceptSubscribe(initId, 201n);
      await flush(64);
      if (redirect) await h.goaway(h.catalogId);
      gate.resolve();
      await flush(128);
      const state = h.player as unknown as { pendingInitTrackSubs: Map<string, unknown> };
      expect(outcome).toBe('pending');
      expect(state.pendingInitTrackSubs.has(JSON.stringify([['review'], 'init-hevc']))).toBe(true);
      expect(h.client.session.getSubscription(h.videoId)).toBeDefined();
      expect(h.client.session.getSubscription(initId)).toBeDefined();
    } finally {
      gate.resolve();
      await flush(64);
      await h.destroy();
    }
  });

  it('retires a recovery-candidate SUBSCRIBE when that request gets GOAWAY', async () => {
    const h = await mediaPair(draft);
    try {
      await h.server.publishDone(h.catalogId, 5n as never, 'too far behind');
      await flush(128);
      await vi.waitFor(() => expect(h.requests.filter(r => r.name === 'catalog')).toHaveLength(2));
      const catalogs = h.requests.filter(r => r.name === 'catalog');
      expect(catalogs).toHaveLength(2);
      const candidateId = catalogs[1]!.id;
      const state = h.player as unknown as { catalogSlots: { catalogRecovery: { reqId: bigint; coord: { phase: string } } | null } };
      expect(state.catalogSlots.catalogRecovery?.reqId).toBe(candidateId);
      await h.goaway(candidateId);
      expect(h.client.session.getSubscription(candidateId)).toBeUndefined();
      expect(state.catalogSlots.catalogRecovery === null).toBe(true);
      expect(h.client.session.getSubscription(h.videoId)).toBeDefined();
    } finally { await h.destroy(); }
  });
});

function statusAdapter() {
  let next = 0n;
  const adapter: any = {
    draftVersion: 18,
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    subscribe: vi.fn(async (_ns: unknown, _name: unknown, options: any) => {
      const id = next; next += 2n; options?.onRequestId?.(id); return id;
    }),
    unsubscribe: vi.fn(async () => {}), requestUpdate: vi.fn(async () => {}),
    fetchCancel: vi.fn(async () => {}),
    trackStatus: vi.fn(async (_ns: unknown, _name: unknown, options: any) => {
      const id = next; next += 2n; options?.onRequestId?.(id); return id;
    }),
  };
  return adapter;
}

/** A minimal LOC catalog, enough for a replacement to be adoptable. */
const STATUS_CATALOG = new TextEncoder().encode(JSON.stringify({
  version: 1,
  tracks: [
    { name: 'video', packaging: 'loc', role: 'video', renderGroup: 1, isLive: true,
      codec: 'av01.0.08M.10', width: 640, height: 360, bitrate: 500_000 },
    { name: 'audio', packaging: 'loc', role: 'audio', renderGroup: 1, isLive: true,
      codec: 'opus', samplerate: 48000, channelConfig: '2', bitrate: 32_000 },
  ],
}));

/**
 * Carry a replacement to adoptable: its catalog accepted and delivered, then
 * its required media accepted. A graceful handover retires the old session
 * only once the replacement is usable, so a migration cannot be awaited until
 * this has happened. This adapter numbers requests 0, 2, 4, … so the catalog
 * is 0 and the media that follows is 2 and 4.
 */
async function acceptStatusReplacement(adapter: ReturnType<typeof statusAdapter>): Promise<void> {
  await flush(64);
  adapter.onMessage({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 100n, parameters: new Map() });
  adapter.onObject?.(0n, {
    kind: 'data', trackAlias: 100n, groupId: 0n, subgroupId: 0n, objectId: 0n,
    publisherPriority: 128, extensions: undefined, payload: STATUS_CATALOG,
  });
  await flush(64);
  for (const [requestId, trackAlias] of [[2n, 102n], [4n, 104n]] as const) {
    adapter.onMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias, parameters: new Map() });
    await flush(64);
  }
}

async function statusPlayer(adapter: ReturnType<typeof statusAdapter>) {
  const player = new MoqtPlayer({
    url: 'https://old.example/moq', namespace: 'review', draftVersion: 18,
    connection: adapter, createTransport: async () => ({}) as never,
    catalogBootstrap: 'subscribe',
  });
  await player.load();
  return player;
}

describe('TRACK_STATUS settlement ownership', () => {
  it.each(['resolve', 'reject'] as const)('does not delete a successor waiter when an old send completes by %s', async (completion) => {
    const old = statusAdapter();
    const newer = statusAdapter();
    const gate = deferred<void>();
    const original = old.trackStatus;
    old.trackStatus = vi.fn(async (...args: any[]) => {
      const id = await original(...args);
      await gate.promise;
      return id;
    });
    const player = await statusPlayer(old);
    let oldOutcome = 'pending';
    let newOutcome = 'pending';
    void player.queryTrackStatus('old').then(
      () => { oldOutcome = 'resolved'; }, () => { oldOutcome = 'rejected'; },
    );
    try {
      await flush(64);
      const migrating = player.migrate(newer);
      await acceptStatusReplacement(newer);
      await migrating;
      // The replacement's own catalog and media consumed requests 0, 2 and 4,
      // so this query is the next id it allocates.
      const statusId = 6n;
      void player.queryTrackStatus('new').then(
        () => { newOutcome = 'resolved'; }, () => { newOutcome = 'rejected'; },
      );
      await flush(64);
      if (completion === 'resolve') gate.resolve();
      else gate.reject(new Error('old send failed'));
      await flush(64);
      expect(oldOutcome).toBe('rejected');
      newer.onMessage({ type: 'REQUEST_OK', requestId: statusId, parameters: new Map() });
      await flush(64);
      expect(newOutcome).toBe('resolved');
    } finally { gate.resolve(); await flush(64); await player.destroy(); }
  });

  it('settles the public promise when GOAWAY arrives before send completion', async () => {
    const adapter = statusAdapter();
    const gate = deferred<void>();
    const original = adapter.trackStatus;
    let id: bigint | undefined;
    adapter.trackStatus = vi.fn(async (...args: any[]) => {
      id = await original(...args);
      await gate.promise;
      return id;
    });
    const player = await statusPlayer(adapter);
    let outcome = 'pending';
    void player.queryTrackStatus('video').then(
      () => { outcome = 'resolved'; }, () => { outcome = 'rejected'; },
    );
    try {
      await flush(64);
      adapter.onGoawayNotice({ scope: 'request', requestId: id!, newSessionUri: '' }, adapter);
      await flush(64);
      expect(outcome).toBe('rejected');
    } finally { gate.resolve(); await flush(64); await player.destroy(); }
  });
});
