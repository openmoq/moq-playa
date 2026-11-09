/**
 * Object reception through the player's own FETCH replay. The publisher serves
 * a Joining FETCH only after accepting its SUBSCRIBE, but SUBSCRIBE_OK travels
 * on the SUBSCRIBE's request stream and FETCH data on its own unidirectional
 * stream, so the data can arrive before the player learns the alias (the race
 * `pendingFetchStreams` exists for). The test holds SUBSCRIBE_OK in transit to
 * make that reordering deterministic. Parked Objects are replayed on binding
 * as remapped copies routed with the original Object alongside. Reception
 * identity belongs to the original arrival: replay creates no attempt, keeps
 * the original times, and a remapped copy has no identity. Real SDK loopback,
 * draft 18.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import type { ObjectReceptionEvent } from '@openmoq/webtransport';
import type { MoqtObject } from '@openmoq/transport';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import type { VideoDecoderLike, VideoRendererLike } from './interfaces.js';

let now = 0;
beforeEach(() => { now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); });

describe('player FETCH replay keeps the original reception', () => {
  it('a Joining FETCH parked until SUBSCRIBE_OK is replayed once, with original times, as copies routed beside the originals', async () => {
    const { a, b } = createLoopback(), client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
    const subscribes: bigint[] = [];
    let served: Promise<void> | undefined;
    server.onSubscribe = id => { subscribes.push(id); }; // accepted by the test below
    server.onFetch = id => {
      served = (async () => {
        const stream = await server.openFetchStream(id);
        for (const objectId of [0n, 1n]) {
          const extensions = encodeLocHeaders({ captureTimestamp: 1_000_000n + objectId * 20_000n,
            videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: objectId === 0n, discardable: false, baseLayerSync: false, temporalId: 0 } },
            { wireProfile: locWireProfileForDraft(18) });
          await server.sendFetchObject(stream, { groupId: 0n, subgroupId: 0n, objectId, publisherPriority: 128, extensions,
            payload: Uint8Array.of(0, 0, 0, 1, objectId === 0n ? 0x65 : 0x41) });
        }
        await server.closeFetchStream(stream);
      })();
    };
    let serving: Promise<void> | undefined;
    const video: VideoDecoderLike = { configure: vi.fn(), flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null,
      decode: vi.fn((chunk, time, input) => { video.onFrame?.({ timestamp: chunk.timestamp, close() {} }, time, null, input); }) };
    const renderer: VideoRendererLike = { flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null, enqueue: vi.fn() };
    const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: ['live'], draftVersion: 18, clock: { now: () => 1_000_000 },
      createConnection: () => client,
      createTransport: async () => { serving = server.connect(b, {}); void serving.catch(() => {}); return a; },
      createVideoDecoder: () => video, createRenderer: () => renderer, disableAudio: true, autoQuality: false,
      warmStartCurrentGroup: true, selection: { videoTrack: { name: 'v' } },
      catalog: { tracks: [{ name: 'v', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1.4D4028' }] },
    });
    const events: ObjectReceptionEvent[] = [];
    client.observeObjectReception(e => { events.push(e); });
    const routed: Array<{ copy: MoqtObject; original: unknown; at: number }> = [];
    const internals = player as unknown as {
      routeMediaObject(streamId: bigint, obj: MoqtObject, draft?: unknown, conn?: unknown, original?: unknown, info?: unknown): Promise<void>;
      pendingFetchStreams: Map<bigint, { objects: MoqtObject[] }>;
    };
    const route = internals.routeMediaObject.bind(player);
    vi.spyOn(internals, 'routeMediaObject').mockImplementation((streamId, obj, draft, conn, original, info) => {
      if (obj.objectId <= 1n && original !== obj) routed.push({ copy: obj, original, at: now });
      return route(streamId, obj, draft, conn, original, info);
    });
    try {
      now = 10;
      const loading = player.load(); await flush(256);
      expect(subscribes, 'one SUBSCRIBE, with its Joining FETCH parked by the publisher').toHaveLength(1);
      const subscribeStream = a.bidiOut[0]!; // the player's first request: the video SUBSCRIBE
      subscribeStream.in.faults.hold = true;   // SUBSCRIBE_OK stays in transit
      now = 20;
      await server.acceptSubscribe(subscribes[0]!, 77n); await flush(256); await served; await flush(256);
      const parked = [...internals.pendingFetchStreams.values()].flatMap(p => p.objects);
      expect(parked.map(o => o.objectId), 'FETCH data waits for the player\'s alias binding').toEqual([0n, 1n]);
      const arrivals = events.filter(e => e.type === 'end');
      expect(arrivals.map(e => [e.origin, e.objectId, e.outcome, e.observedAt])).toEqual([
        ['fetch', 0n, 'complete', 20], ['fetch', 1n, 'complete', 20],
      ]);
      const tokens = parked.map(o => client.objectReceptionFor(o));
      expect(tokens).toEqual(arrivals.map(e => e.reception));

      now = 50;
      subscribeStream.in.releaseHeld(); await loading; await flush(256);
      expect(routed.map(r => [r.copy.objectId, r.at]), 'replayed on binding').toEqual([[0n, 50], [1n, 50]]);
      for (const [i, r] of routed.entries()) {
        expect(r.original, 'the original object travels beside its copy').toBe(parked[i]);
        expect(client.objectReceptionFor(r.original as object)).toBe(tokens[i]);
        expect(client.objectReceptionFor(r.copy), 'a remapped copy has no reception identity').toBeUndefined();
      }
      expect(events.filter(e => e.type === 'end'), 'replay is delivery, not another arrival').toHaveLength(2);
    } finally { await player.destroy(); await server.close(); await serving?.catch(() => {}); }
  });
});
