import { acceptTestPublication, publicationMetadata } from './relay-publisher-test-support.js';
import { expect, it, vi } from 'vitest';
import { varint, type ControlMessage, type MoqtObjectData } from '@openmoq/transport';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { Relay } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';

it.each(([14, 16, 18] as const).flatMap(draft => (['standalone', 'joining'] as const).map(kind => ({ draft, kind }))))('draft $draft $kind FETCH honors relay serving capability', async ({ draft, kind }) => {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const relay = new Relay();
  const errors: Error[] = [], messages: ControlMessage[] = [], tasks: Promise<void>[] = [];
  const received: number[] = [], fetchObjects: number[] = [], fetchStreams: bigint[] = [];
  const seenRequests: bigint[] = [];
  client.onError = server.onError = error => errors.push(error);
  client.onMessage = message => messages.push(message);
  client.onDataStream = (id, message) => { if (message.type === 'fetch') fetchStreams.push(id); };
  client.onObject = (id, object) => {
    if (fetchStreams.includes(id) && object.kind === 'data') fetchObjects.push(...object.payload);
  };
  server.onSubscribe = (id, namespace, name) => { tasks.push(relay.handleSubscribe(server, id, namespace, name)); };
  server.onFetch = (id, fetch) => { seenRequests.push(id); tasks.push(relay.handleFetch(server, id, fetch)); };
  server.onSubscribeClosed = id => relay.removeSubscription(server, id);
  server.setLargestLocationProvider(id => relay.currentLargestFor(server, id));
  const publish: IncomingPublish = { ...publicationMetadata(),
    requestId: 1n, trackAlias: 9n, trackNamespace: nsBytes(DEMO_NAMESPACE), trackName: te(DEMO_TRACK),
    onObject: null, onSubgroupClosed: null,
  };
  // Seed only the cache ingestion boundary; all requests, responses and data use real peers.
  await acceptTestPublication(relay, publish);
  const object = (group: bigint): MoqtObjectData => ({
    kind: 'data', trackAlias: 9n, groupId: group, subgroupId: 0n, objectId: 0n,
    publisherPriority: 128, isFirstObjectInSubgroup: draft === 18, properties: undefined,
    extensions: undefined, payload: Uint8Array.of(Number(group)),
  });
  publish.onObject?.(object(5n));
  const accept = vi.spyOn(server, 'acceptFetch');
  const open = vi.spyOn(server, 'openFetchStream');
  try {
    relay.setupConnection(server);
    await Promise.all([client.connect(a), server.connect(b, { maxRequestId: varint(1000n) })]);
    const sub = await client.subscribeTrack(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK), {
      filter: { type: 'LargestObject' },
      onObject: object => { if (object.kind === 'data') received.push(...object.payload); },
    });
    await flush(256); await Promise.all(tasks);
    expect(server.session.getIncomingSubscription(sub.requestId)?.state).toBe('established');
    const priorLive = [...received];
    {
      const before = b.uniOut.length;
      const wire = a.bidiOut[0]?.in;
      const wireStart = wire?.written.length ?? 0;
      const id = kind === 'standalone'
        ? await client.fetch(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK), {
          startGroup: varint(5n), startObject: varint(0n), endGroup: varint(5n), endObject: varint(1n),
        })
        : await client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub.requestId, joiningStart: 0n });
      await flush(256); await Promise.all(tasks); await flush(256);
      expect(seenRequests).toContain(id); // A valid joining reference reached the relay, not an SDK rejection.
      const responses = messages.filter(m => 'requestId' in m && m.requestId === id);
      if (draft === 18) {
        expect(responses.map(m => m.type)).toEqual(['FETCH_OK']);
        expect(b.uniOut.length).toBe(before + 1);
        expect(b.uniOut.at(-1)?.writeClosed).toBe(true);
      } else {
        expect(responses.map(m => m.type)).toEqual(['REQUEST_ERROR']);
        expect(responses[0]).toMatchObject({ errorCode: 3n, retryInterval: 0n });
        expect(wire?.written.slice(wireStart).map(bytes => bytes[0])).toEqual([draft === 14 ? 0x19 : 0x05]);
        expect(accept).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(b.uniOut.length).toBe(before);
      }
      expect(server.session.getIncomingFetch(id)).toBeUndefined();
      expect(received).toEqual(priorLive); // FETCH must not substitute cached SUBSCRIBE replay.
    }
    expect(fetchObjects).toEqual(draft === 18 ? [5] : []);
    expect(fetchStreams).toHaveLength(draft === 18 ? 1 : 0);
    publish.onObject?.(object(6n));
    await flush(512);
    expect(received).toEqual([...priorLive, 6]);
    expect(client.session.state).toBe('established');
    expect(server.session.state).toBe('established');
    expect(client.session.getSubscription(sub.requestId)?.state).toBe('established');
    expect(server.session.getIncomingSubscription(sub.requestId)?.state).toBe('established');
    expect(errors).toEqual([]);
    await sub.unsubscribe(); await flush(128);
  } finally { await client.close(); await server.close(); }
});
