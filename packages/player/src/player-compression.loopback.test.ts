// Real SDK loopback; these assertions concern metadata delivery, not native decoding.
import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { MoqtConnection } from '@openmoq/webtransport';
import { encodePropertyBlock } from '@openmoq/transport';
import { MoqtPlayer } from './player.js';
import { createLoopback, flush } from '../../webtransport/src/testkit/loopback.js';
import type { EventTimelineReceivedEvent } from './events.js';
const enc = new TextEncoder();
const zip = (value: unknown) => gzipSync(enc.encode(JSON.stringify(value)));
const objectCompression = encodePropertyBlock([{ id: 0x78n, value: 1n }], 'd18-delta-vi64');

it.each(['draft-02', 'draft-01', '1'].flatMap(version => (['subscribe', 'joining-fetch'] as const).map(mode => ({ version, mode }))))('decompresses $version catalog and timelines through $mode with response properties', async ({ version, mode }) => {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(18), server = new MoqtConnection(18, { role: 'server' });
  const requests: { id: bigint; name: string }[] = [], fetches: bigint[] = [];
  server.onSubscribe = (id, _ns, name) => { requests.push({ id, name: new TextDecoder().decode(name) }); };
  server.onFetch = id => { fetches.push(id); };
  server.setLargestLocationProvider(() => ({ group: 1n, object: 0n }));
  let serving: Promise<void> | undefined;
  const player = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: ['live'], draftVersion: 18,
    catalogBootstrap: mode, disableAudio: true, autoQuality: false,
    createConnection: () => client, createTransport: async () => { serving = server.connect(b); return a; } });
  let ready!: () => void, fail!: (error: Error) => void;
  const received = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  let catalogReady = false; void received.catch(() => {});
  player.on('catalog_received', () => { catalogReady = true; ready(); }); player.on('error', e => fail(new Error(e.error.message)));
  let event!: (e: EventTimelineReceivedEvent) => void, loaded!: () => void;
  const events = new Promise<EventTimelineReceivedEvent>(resolve => { event = resolve; });
  const timeline = new Promise<void>(resolve => { loaded = resolve; });
  player.on('event_timeline', event); player.on('timeline_loaded', loaded);
  const document = { version, tracks: [
    { name: 'v', packaging: 'loc', role: 'video', isLive: true, codec: 'avc1', bitrate: 100, framerate: 30 },
    { name: 'timeline', packaging: 'mediatimeline', isLive: true, mimeType: 'application/json', depends: ['v'] },
    { name: 'events', packaging: 'eventtimeline', isLive: true, eventType: 'example', depends: ['v'] },
  ] };
  try {
    await player.load(); await flush(128);
    const catalog = requests.find(r => r.name === 'catalog')!;
    const held = a.bidiOut[mode === 'subscribe' ? 0 : 1]!.in;
    held.faults.hold = true;
    await server.acceptSubscribe(catalog.id, 10n, { trackProperties: new Map([[0x78n, [1n]]]) }); await flush(128);
    if (mode === 'subscribe') {
      const stream = await server.openSubgroup(10n, 1n, 0n, { publisherPriority: 128 });
      await server.sendObject(stream, 0n, zip(document)); await server.closeSubgroup(stream);
    } else {
      expect(fetches).toHaveLength(1);
      await server.acceptFetch(fetches[0]!, { endOfTrack: 0, endLocation: { group: 1n, object: 1n }, trackProperties: new Map([[0x78n, [1n]]]) });
      const stream = await server.openFetchStream(fetches[0]!);
      await server.sendFetchObject(stream, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: zip(document) });
      await server.closeFetchStream(stream);
    }
    await flush(128); expect(catalogReady).toBe(false); held.releaseHeld();
    await received; await flush(128);
    const snapshot = player.fetchCatalog({ group: 1n });
    await flush(128);
    const request = fetches.at(-1)!;
    await server.acceptFetch(request, { endOfTrack: 0, endLocation: { group: 1n, object: 1n }, trackProperties: new Map([[0x78n, [1n]]]) });
    const snapshotStream = await server.openFetchStream(request);
    await server.sendFetchObject(snapshotStream, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: zip(document) });
    await server.closeFetchStream(snapshotStream);
    expect((await snapshot).tracks.map(track => track.name)).toEqual(['v', 'timeline', 'events']);
    const header = enc.encode('{"crs":"WGS84"}');
    for (const request of requests.filter(r => r.name !== 'catalog')) {
      const alias = request.name === 'v' ? 20n : request.name === 'timeline' ? 21n : 22n;
      await server.acceptSubscribe(request.id, alias, request.name === 'events'
        ? { trackProperties: new Map([[0x78n, [1n]], [0x7Bn, [header]]]) } : {});
    }
    await flush(128);
    for (const [alias, payload, properties] of [[21n, [[1000, [3, 0], 0]], objectCompression], [22n, [version === 'draft-02' ? { T: 123, data: null } : { t: 123, data: null }], undefined]] as const) {
      const stream = await server.openSubgroup(alias, 0n, 0n, { publisherPriority: 128, hasExtensions: properties !== undefined });
      await server.sendObject(stream, 0n, zip(payload), properties); await server.closeSubgroup(stream);
    }
    const result = await events; await timeline;
    expect(result.header).toEqual(version === 'draft-02' ? header : undefined); expect(result.records).toEqual([{ index: { t: 123 }, data: null }]);
    expect(player.duration).toBe(1000);
  } finally { await player.destroy(); await server.close(); await serving; }
});
