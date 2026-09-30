import { afterEach, describe, expect, it } from 'vitest';
import {
  createControlCodec,
  SessionState,
  varint,
  type MoqtObject,
  type Parameters,
  type ControlMessage,
} from '@moqt/transport';
import { MoqtConnection } from './adapter.js';
import { connectedPair, nm, ns, type ConnectedPair } from './testkit/pair.js';
import { TransportSim, flush } from './testkit/stream-sim.js';

const connections: MoqtConnection[] = [];
const codec = createControlCodec(21);
const ALIAS = 50n;

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.close();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await flush();
}

async function pair(draft: 18 | 21 = 21): Promise<ConnectedPair> {
  const result = await connectedPair(draft);
  connections.push(result.client, result.server);
  return result;
}

function serveSubscriptions({ server, errors }: ConnectedPair): void {
  server.setLargestLocationProvider(() => ({ group: 5n, object: 0n }));
  server.onSubscribe = (requestId) => {
    const parameters: Parameters = new Map([[0x09n, [{ group: 5n, object: 0n }]]]);
    void server.acceptSubscribe(requestId, ALIAS, { parameters }).catch((err: Error) => errors.push(err));
  };
}

async function publish(server: MoqtConnection, group: bigint, requestId?: bigint): Promise<void> {
  const stream = await server.openSubgroup(ALIAS, group, 0n, { publisherPriority: 1, ...(requestId === undefined ? {} : { requestId }) });
  await server.sendObject(stream, 0n, new Uint8Array([1]));
  await server.closeSubgroup(stream);
  await settle();
}

describe('draft-21 GOAWAY through the public adapter', () => {
  it.each(['client', 'server'] as const)('%s sends GOAWAY without a Request ID (9.2)', async (role) => {
    const p = await pair();
    const sender = p[role];
    const receiver = role === 'client' ? p.server : p.client;

    await expect(sender.sendGoaway({ timeout: 1000n })).resolves.toBeUndefined();
    await settle();

    expect(receiver.session.state).toBe(SessionState.DRAINING);
    expect(p.errors).toEqual([]);
  });

  it('draft 18 still requires a Request ID with the peer parity', async () => {
    const { client, server, errors } = await pair(18);

    await expect(client.sendGoaway()).rejects.toThrow(/requires a Request ID/);
    await expect(client.sendGoaway({ requestId: 0n })).rejects.toThrow(/wrong parity/);
    await client.sendGoaway({ requestId: 1n });
    await settle();

    expect(server.session.state).toBe(SessionState.DRAINING);
    expect(errors).toEqual([]);
  });

  it('draft 21 still prohibits a client from redirecting the server', async () => {
    const { client, server } = await pair();
    await expect(client.sendGoaway({ newSessionUri: 'https://relay.example/moq', requestId: 1n }))
      .rejects.toThrow(/client MUST send a zero-length/);
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
  });
});

describe('draft-21 fill group order (3.4 and 9.20.9)', () => {
  it('inherits the publisher Group Order advertised in SUBSCRIBE_OK', async () => {
    const p = await pair();
    p.server.onSubscribe = (id) => { void p.server.acceptSubscribe(id, ALIAS, {
      parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]), trackProperties: new Map([[0x22n, [2n]]]),
    }); };
    const groups: bigint[] = [];
    p.client.onObject = (_sid, o) => groups.push(o.groupId);
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    const stream = await p.server.openFillStream(id);
    for (const groupId of [5n, 4n]) await p.server.sendFetchObject(stream, {
      groupId, subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([1]),
    });
    await p.server.closeFetchStream(stream);
    await settle();
    expect(groups).toEqual([5n, 4n]);
    expect(p.errors).toEqual([]);
  });
  it('a fill override takes precedence over the subscription order', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const objects: MoqtObject[] = [];
    p.client.onObject = (_stream, object) => objects.push(object);
    const id = await p.client.subscribe(ns('live'), nm('video'), {
      groupOrder: varint(1n), fill: { groupOrder: 'descending' },
    });
    await settle();
    const stream = await p.server.openFillStream(id);
    const fields = { subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([1]) };
    await p.server.sendFetchObject(stream, { ...fields, groupId: 5n });
    await expect(p.server.sendFetchObject(stream, { ...fields, groupId: 4n })).resolves.toBeUndefined();
    await p.server.closeFetchStream(stream);
    await settle();
    expect(objects.map((o) => o.groupId)).toEqual([5n, 4n]);
    expect(p.errors).toEqual([]);
  });

  it('Forward=0 does not authorize a fill, even after a later resume', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { forward: 0, fill: {} });
    await settle();
    expect(p.client.session.fillSubscriptionFor(id)).toBeUndefined();
    await p.client.requestUpdate(id, { forward: 1 });
    await settle();
    await expect(p.server.openFillStream(id)).rejects.toThrow(/No pending fill/);
    expect(p.errors).toEqual([]);
  });

  it.each([
    { order: 1n, groups: [5n, 6n] },
    { order: 2n, groups: [5n, 4n] },
  ])('decodes a fill with inherited GROUP_ORDER=$order', async ({ order, groups }) => {
    const conn = new MoqtConnection(21);
    connections.push(conn);
    const transport = new TransportSim();
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    const objects: MoqtObject[] = [];
    const errors: Error[] = [];
    conn.onObject = (_stream, object) => objects.push(object);
    conn.onError = (err) => errors.push(err);
    await conn.connect(transport);

    const requestId = await conn.subscribe(ns('live'), nm('video'), { groupOrder: varint(order), fill: {} });
    expect(requestId).toBe(0n);
    await settle();
    transport.bidi[0]!.push(codec.encode({
      type: 'SUBSCRIBE_OK', requestId, trackAlias: ALIAS,
      parameters: new Map([[0x09n, [{ group: 6n, object: 0n }]]]), trackExtensions: new Map(),
    }));
    await settle();

    // 11.4.1: a literal FETCH_HEADER followed by groups 5 and delta 0.
    // The second group is 6 ascending, 4 descending. This fixture does not
    // use our object encoder, so matching encoder/decoder mistakes cannot pass.
    transport.pushIncomingUni(new Uint8Array([
      0x05, 0x00,
      0x1c, 0x05, 0x00, 0x03, 0x01, 0xa5,
      0x0c, 0x00, 0x00, 0x01, 0xa4,
    ]));
    await settle();

    expect(errors).toEqual([]);
    expect(objects.map((o) => o.groupId)).toEqual(groups);
  });

  it('publishes consecutive descending groups on a fill', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const objects: MoqtObject[] = [];
    p.client.onObject = (_stream, object) => objects.push(object);
    const requestId = await p.client.subscribe(ns('live'), nm('video'), { groupOrder: varint(2n), fill: {} });
    await settle();
    const stream = await p.server.openFillStream(requestId);
    const fields = { subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([1]) };

    await p.server.sendFetchObject(stream, { ...fields, groupId: 5n });
    await expect(p.server.sendFetchObject(stream, { ...fields, groupId: 4n })).resolves.toBeUndefined();
    await p.server.closeFetchStream(stream);
    await settle();

    expect(objects.map((o) => o.groupId)).toEqual([5n, 4n]);
    expect(p.errors).toEqual([]);
  });
});

describe('draft-21 shared-alias subscription ownership (3.1)', () => {
  it.each(['stream', 'datagram'] as const)('does not send %s objects outside the accepted Location Filter', async (delivery) => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), {
      subscriptionFilter: { type: 'AbsoluteRange', startGroup: 2n, startObject: 1n, endGroup: 2n, endObject: 3n },
    });
    await settle();
    if (delivery === 'stream') {
      const stream = await p.server.openSubgroup(ALIAS, 2n, 0n);
      await expect(p.server.sendObject(stream, 0n, new Uint8Array([1]))).rejects.toThrow(/Location Filter/);
      await p.server.sendObject(stream, 1n, new Uint8Array([1]));
      await p.server.closeSubgroup(stream);
    } else {
      await expect(p.server.sendDatagram(ALIAS, 2n, 0n, new Uint8Array([1]))).rejects.toThrow(/Location Filter/);
      await p.server.sendDatagram(ALIAS, 2n, 1n, new Uint8Array([1]));
    }
    expect(p.server.session.getIncomingSubscription(id)).toBeDefined();
    expect(p.errors).toEqual([]);
  });
  it('drains each shared subscription and sums their terminal stream counts', async () => {
    const conn = new MoqtConnection(21);
    connections.push(conn);
    const transport = new TransportSim();
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    await conn.connect(transport);
    const objects: bigint[] = [];
    conn.onObject = (_sid, o) => objects.push(o.groupId);
    const drained: bigint[] = [];
    for (let i = 0; i < 2; i++) {
      const requestId = await conn.subscribe(ns('live'), nm('video'), {
        subscriptionFilter: { type: 'AbsoluteRange', startGroup: BigInt(i + 1), startObject: 0n, endGroup: BigInt(i + 1) },
        terminalDelivery: 'drain', onDrained: (id) => drained.push(id),
      });
      await settle();
      transport.bidi[i]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId, trackAlias: ALIAS,
        parameters: new Map(), trackProperties: new Map(),
      }));
      await settle();
    }
    for (let i = 0; i < 2; i++) {
      transport.bidi[i]!.push(codec.encode({ type: 'PUBLISH_DONE', requestId: BigInt(i * 2), statusCode: 2n, streamCount: 1n, errorReason: 'done' }));
      await settle();
      expect(drained).toEqual([]);
      transport.pushIncomingUni(new Uint8Array([0x10, Number(ALIAS), i + 1, 1, 0, 1, 1]));
      await settle();
    }
    expect(objects).toEqual([1n, 2n]);
  });
  it('delivers subgroup FIN to both SUBSCRIBE and PUBLISH owners', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const closed: string[] = [];
    const sub = await p.client.subscribeTrack(ns('live'), nm('video'), {
      onSubgroupClosed: () => closed.push('subscribe'),
    });
    p.client.onPublish = (pub) => {
      pub.onSubgroupClosed = () => closed.push('publish');
      void p.client.acceptSubscribe(pub.requestId, pub.trackAlias).catch((e: Error) => p.errors.push(e));
    };
    await p.server.publish(ns('live'), nm('video'), ALIAS);
    await settle();
    await publish(p.server, 6n, sub.requestId);
    expect(closed).toEqual(['subscribe', 'publish']);
    expect(p.errors).toEqual([]);
  });

  it('does not call another alias owner after a callback closes the connection', async () => {
    const p = await pair();
    const objects: bigint[] = [];
    let count = 0;
    p.client.onPublish = (pub) => {
      const first = count++ === 0;
      pub.onObject = () => {
        objects.push(pub.requestId);
        if (first) void p.client.close();
      };
      void p.client.acceptSubscribe(pub.requestId, pub.trackAlias).catch((e: Error) => p.errors.push(e));
    };
    const first = await p.server.publish(ns('live'), nm('video'), ALIAS);
    const second = await p.server.publish(ns('live'), nm('video'), ALIAS);
    await settle();
    const stream = await p.server.openSubgroup(ALIAS, 6n, 0n, { requestId: second });
    await p.server.sendObject(stream, 0n, new Uint8Array([1]));
    await settle();
    expect(objects).toEqual([first]);
  });

  it('honors a reentrant cancellation before calling the next shared owner', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const first = await p.client.subscribeTrack(ns('live'), nm('video'));
    const objects: bigint[] = [];
    const second = await p.client.subscribeTrack(ns('live'), nm('video'), { onObject: (o) => objects.push(o.objectId) });
    first.onObject = () => { void second.unsubscribe(); };
    await publish(p.server, 6n, first.requestId);
    expect(objects).toEqual([]);
  });
  it('keeps each inbound PUBLISH owner when its peer on the same alias ends', async () => {
    const p = await pair();
    const delivered: bigint[][] = [];
    p.client.onPublish = (pub) => {
      const objects: bigint[] = [];
      delivered.push(objects);
      pub.onObject = (o) => objects.push(o.objectId);
      void p.client.acceptSubscribe(pub.requestId, pub.trackAlias).catch((e: Error) => p.errors.push(e));
    };
    const first = await p.server.publish(ns('live'), nm('video'), ALIAS);
    const second = await p.server.publish(ns('live'), nm('video'), ALIAS);
    await settle();
    const stream = await p.server.openSubgroup(ALIAS, 6n, 0n, { requestId: second });
    await p.server.sendObject(stream, 0n, new Uint8Array([1]));
    await settle();
    expect(delivered).toEqual([[0n], [0n]]);
    await publish(p.server, 6n, first);
    expect(delivered).toEqual([[0n], [0n]]);
    await p.server.publishDone(first, varint(2n), 'done');
    await settle();
    await p.server.sendObject(stream, 1n, new Uint8Array([1]));
    await p.server.closeSubgroup(stream);
    await settle();
    expect(delivered).toEqual([[0n], [0n, 1n]]);
    expect(p.errors).toEqual([]);
  });

  it.each(['raw', 'generic'] as const)('ending the %s member preserves a mixed shared alias', async (retired) => {
    const p = await pair();
    serveSubscriptions(p);
    const rawObjects: bigint[] = [];
    const genericObjects: bigint[] = [];
    p.client.onObject = (_sid, object) => genericObjects.push(object.objectId);
    const raw = await p.client.subscribeTrack(ns('live'), nm('video'), { onObject: (o) => rawObjects.push(o.objectId) });
    const generic = await p.client.subscribe(ns('live'), nm('video'));
    await settle();
    const survivor = retired === 'raw' ? generic : raw.requestId;
    const stream = await p.server.openSubgroup(ALIAS, 6n, 0n, { requestId: survivor });
    await p.server.sendObject(stream, 0n, new Uint8Array([1]));
    await settle();
    expect(rawObjects).toEqual([0n]);
    expect(genericObjects).toEqual([0n]);
    await p.client.unsubscribe(retired === 'raw' ? raw.requestId : generic);
    await p.server.sendObject(stream, 1n, new Uint8Array([1]));
    await p.server.closeSubgroup(stream);
    await settle();
    expect(retired === 'raw' ? genericObjects : rawObjects).toEqual([0n, 1n]);
    expect(retired === 'raw' ? rawObjects : genericObjects).toEqual([0n]);
    expect(p.errors).toEqual([]);
  });

  it.each([0, 1])('cancelling member %i resets only its already-open streams', async (retired) => {
    const p = await pair();
    serveSubscriptions(p);
    const delivered: bigint[][] = [[], []];
    const first = await p.client.subscribeTrack(ns('live'), nm('video'), { onObject: (o) => delivered[0]!.push(o.objectId) });
    const second = await p.client.subscribeTrack(ns('live'), nm('video'), { onObject: (o) => delivered[1]!.push(o.objectId) });
    const subscribers = [first, second];
    const streams: bigint[] = [];
    for (const sub of subscribers) {
      streams.push(await p.server.openSubgroup(ALIAS, 6n, 0n, { requestId: sub.requestId }));
    }
    for (const stream of streams) await p.server.sendObject(stream, 0n, new Uint8Array([1]));
    await settle();
    expect(p.server.session.getIncomingSubscription(first.requestId)!.streamCount).toBe(1n);
    expect(p.server.session.getIncomingSubscription(second.requestId)!.streamCount).toBe(1n);
    await subscribers[retired]!.unsubscribe();
    await settle();
    await expect(p.server.sendObject(streams[retired]!, 0n, new Uint8Array([1]))).rejects.toThrow();
    await expect(p.server.sendObject(streams[1 - retired]!, 1n, new Uint8Array([1]))).resolves.toBeUndefined();
    await p.server.closeSubgroup(streams[1 - retired]!);
    await settle();
    expect(delivered[retired]).toEqual([0n]);
    expect(delivered[1 - retired]).toEqual([0n, 1n]);
    expect(p.errors).toEqual([]);
  });

  it('requires an explicit request when publisher stream ownership is ambiguous', async () => {
    const p = await pair();
    serveSubscriptions(p);
    await p.client.subscribeTrack(ns('live'), nm('video'));
    await p.client.subscribeTrack(ns('live'), nm('video'));
    await expect(p.server.openSubgroup(ALIAS, 6n, 0n)).rejects.toThrow(/requestId/);
  });

  it('uses the accepted updated Location Filter for attribution', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const a: MoqtObject[] = [];
    const b: MoqtObject[] = [];
    const first = await p.client.subscribeTrack(ns('live'), nm('video'), {
      filter: { type: 'AbsoluteRange', startGroup: 0n, startObject: 0n, endGroup: 1n },
      onObject: (object) => a.push(object),
    });
    const second = await p.client.subscribeTrack(ns('live'), nm('video'), {
      filter: { type: 'AbsoluteStart', startGroup: 2n, startObject: 0n },
      onObject: (object) => b.push(object),
    });
    await publish(p.server, 1n, first.requestId);
    expect(a.map((o) => o.groupId)).toEqual([1n]);
    expect(b).toEqual([]);

    const responses: string[] = [];
    p.client.onMessage = (message) => responses.push(message.type);
    await p.client.requestUpdate(first.requestId, {
      subscriptionFilter: { type: 'AbsoluteRange', startGroup: 0n, startObject: 0n, endGroup: 2n },
    });
    await settle();
    expect(responses).toContain('REQUEST_OK');
    await publish(p.server, 2n, first.requestId);
    await publish(p.server, 2n, second.requestId);

    expect(p.errors).toEqual([]);
    expect(b.map((o) => o.groupId)).toEqual([2n]);
    expect(a.map((o) => o.groupId)).toEqual([1n, 2n]);
  });

  it.each([0, 1])('unsubscribing member %i preserves the other member', async (retired) => {
    const p = await pair();
    serveSubscriptions(p);
    const delivered: MoqtObject[][] = [[], []];
    const first = await p.client.subscribeTrack(ns('live'), nm('video'), {
      onObject: (object) => delivered[0]!.push(object),
    });
    const second = await p.client.subscribeTrack(ns('live'), nm('video'), {
      onObject: (object) => delivered[1]!.push(object),
    });

    await [first, second][retired]!.unsubscribe();
    await settle();
    await publish(p.server, 6n);

    expect(p.errors).toEqual([]);
    expect(delivered[retired]).toEqual([]);
    expect(delivered[1 - retired]!.map((o) => o.groupId)).toEqual([6n]);
  });
});

describe('draft-21 fill lifecycle (3.4 and 9.9)', () => {
  it('reclaims empty publisher fills across repeated updates', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { subscriptionFilter: { type: 'NextGroupStart' }, fill: {} });
    await settle();
    for (let i = 0; i < 3; i++) {
      await p.client.requestUpdate(id, { fill: {} });
      await settle();
    }
    const state = p.server as unknown as { inboundFillRequests: Map<bigint, unknown> };
    expect(state.inboundFillRequests.size).toBe(0);
    expect(p.client.session.expectedFillsOf(id)).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it('bounds unserved publisher fills across sequential updates', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    for (let i = 0; i < 255; i++) {
      await p.client.requestUpdate(id, { fill: {} });
      await settle();
      expect(p.server.session.state).toBe(SessionState.ESTABLISHED);
    }
    await p.client.requestUpdate(id, { fill: {} });
    await settle();
    expect(p.server.session.state).toBe(SessionState.CLOSED);
  });
  it('keeps a draining fill when a shared inbound PUBLISH is cancelled', async () => {
    const conn = new MoqtConnection(21);
    connections.push(conn);
    const transport = new TransportSim();
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    const groups: bigint[] = [];
    const errors: Error[] = [];
    conn.onObject = (_sid, o) => groups.push(o.groupId);
    conn.onError = (e) => errors.push(e);
    conn.onPublish = (pub) => { void conn.acceptSubscribe(pub.requestId, pub.trackAlias).catch((e: Error) => errors.push(e)); };
    await conn.connect(transport);
    const id = await conn.subscribe(ns('live'), nm('video'), { fill: {}, terminalDelivery: 'drain' });
    transport.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: id, trackAlias: ALIAS,
      parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]), trackProperties: new Map(),
    }));
    const pub = transport.pushIncomingBidi();
    pub.push(codec.encode({ type: 'PUBLISH', requestId: 1n, trackAlias: ALIAS,
      trackNamespace: ns('live'), trackName: nm('video'), parameters: new Map(), trackProperties: new Map(),
    }));
    await settle();
    transport.bidi[0]!.push(codec.encode({ type: 'PUBLISH_DONE', requestId: id, statusCode: 2n, streamCount: 1n, errorReason: 'done' }));
    await settle();
    pub.closeReadable();
    await settle();
    transport.pushIncomingUni(new Uint8Array([5, 0, 0x1c, 5, 0, 3, 1, 0xa5]));
    await settle();
    expect(groups).toEqual([5n]);
    expect(errors).toEqual([]);
  });
  it('counts late fills against the terminal drain cap', async () => {
    const conn = new MoqtConnection(21);
    connections.push(conn);
    const transport = new TransportSim();
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    await conn.connect(transport);
    const objects: bigint[] = [];
    conn.onObject = (_sid, o) => objects.push(o.groupId);
    const requestId = await conn.subscribe(ns('live'), nm('video'), { fill: {}, terminalDelivery: 'drain' });
    transport.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId, trackAlias: ALIAS,
      parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]), trackProperties: new Map(),
    }));
    await settle();
    const update = await conn.requestUpdate(requestId, { fill: {} });
    expect(update).toBe(2n);
    transport.bidi[0]!.push(codec.encode({ type: 'REQUEST_OK', requestId: update, parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]) }));
    await settle();
    transport.bidi[0]!.push(codec.encode({ type: 'PUBLISH_DONE', requestId, statusCode: 2n, streamCount: 1n, errorReason: 'done' }));
    await settle();
    transport.pushIncomingUni(new Uint8Array([5, 0, 0x1c, 5, 0, 3, 1, 0xa5]));
    transport.pushIncomingUni(new Uint8Array([5, 2, 0x1c, 4, 0, 3, 1, 0xa4]));
    await settle();
    expect(objects).toEqual([5n]);
  });
  it.each(['discard', 'drain'] as const)('handles a fill crossing PUBLISH_DONE with %s delivery', async (terminalDelivery) => {
    const conn = new MoqtConnection(21);
    connections.push(conn);
    const transport = new TransportSim();
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    const objects: MoqtObject[] = [];
    const errors: Error[] = [];
    conn.onObject = (_sid, o) => objects.push(o);
    conn.onError = (e) => errors.push(e);
    await conn.connect(transport);
    const id = await conn.subscribe(ns('live'), nm('video'), { fill: {}, ...(terminalDelivery === 'drain' ? { terminalDelivery } : {}) });
    transport.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: id, trackAlias: ALIAS,
      parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]), trackExtensions: new Map(),
    }));
    await settle();
    transport.bidi[0]!.push(codec.encode({ type: 'PUBLISH_DONE', requestId: id, statusCode: varint(2n), streamCount: 1n, errorReason: 'done' }));
    await settle();
    transport.pushIncomingUni(new Uint8Array([0x05, 0, 0x1c, 5, 0, 3, 1, 0xa5]));
    await settle();
    expect(errors).toEqual([]);
    expect(objects.map((o) => o.groupId)).toEqual(terminalDelivery === 'drain' ? [5n] : []);
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('revokes a pending fill open when an update terminates its subscription', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create = p.b.createUnidirectionalStream.bind(p.b);
    p.b.createUnidirectionalStream = async () => { await gate; return create(); };
    const opening = p.server.openFillStream(id).then(() => 'opened', () => 'rejected');
    p.server.setLargestLocationProvider(() => { throw new Error('unavailable'); });
    await p.client.requestUpdate(id, { forward: 0 });
    await settle();
    release();
    expect(await opening).toBe('rejected');
    await settle();
    expect(p.server.session.getIncomingSubscription(id)).toBeUndefined();
    expect(p.server.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('serves a REQUEST_UPDATE fill on a publisher-initiated subscription', async () => {
    const p = await pair();
    p.server.setLargestLocationProvider(() => ({ group: 5n, object: 0n }));
    p.client.onPublish = (pub) => { void p.client.acceptSubscribe(pub.requestId, pub.trackAlias).catch((e: Error) => p.errors.push(e)); };
    const sub = await p.server.publish(ns('live'), nm('video'), ALIAS);
    await settle();
    const delivered: bigint[] = [];
    p.client.onObject = (_sid, o) => delivered.push(o.groupId);
    const update = await p.client.requestUpdate(sub, { fill: { groupOrder: 'descending' } });
    await settle();
    const stream = await p.server.openFillStream(update);
    for (const groupId of [5n, 4n]) {
      await p.server.sendFetchObject(stream, { groupId, subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([1]) });
    }
    await p.server.closeFetchStream(stream);
    await settle();
    expect(delivered).toEqual([5n, 4n]);
    expect(p.errors).toEqual([]);
  });

  it.each(['no objects', 'inherited Next Group'] as const)('does not open an empty fill: %s', async (shape) => {
    const p = await pair();
    serveSubscriptions(p);
    if (shape === 'no objects') p.server.onSubscribe = (id) => { void p.server.acceptSubscribe(id, ALIAS); };
    const id = await p.client.subscribe(ns('live'), nm('video'), { subscriptionFilter: { type: 'NextGroupStart' }, fill: {} });
    await settle();
    await expect(p.server.openFillStream(id)).rejects.toThrow(/No pending fill/);
    expect(p.errors).toEqual([]);
  });

  it('an explicit unfiltered fill overrides Next Group, but cannot exceed Largest Object', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), {
      subscriptionFilter: { type: 'NextGroupStart' },
      fill: { filter: { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n } },
    });
    await settle();
    const stream = await p.server.openFillStream(id);
    const fields = { subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([1]) };
    await expect(p.server.sendFetchObject(stream, { ...fields, groupId: 6n })).rejects.toThrow(/fill range/);
    await p.server.sendFetchObject(stream, { ...fields, groupId: 5n });
    await p.server.closeFetchStream(stream);
    expect(p.errors).toEqual([]);
  });
  it('counts a fill and prevents PUBLISH_DONE while its stream is open', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    const stream = await p.server.openFillStream(id);
    const responses: ControlMessage[] = [];
    p.client.onMessage = (message) => responses.push(message);
    await expect(p.server.publishDone(id, varint(2n), 'done')).rejects.toThrow(/open/);
    await p.server.closeFetchStream(stream);
    await p.server.publishDone(id, varint(2n), 'done');
    await settle();
    expect(responses).toContainEqual(expect.objectContaining({ type: 'PUBLISH_DONE', streamCount: 1n }));
    expect(p.errors).toEqual([]);
  });

  it('does not write an End-of-Range marker outside the fill snapshot', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    const stream = await p.server.openFillStream(id);
    await expect(p.server.sendFetchEndOfRange(stream, false, 6n, 0n)).rejects.toThrow(/fill range/);
    await p.server.sendFetchEndOfRange(stream, false, 5n, 0n);
    await p.server.closeFetchStream(stream);
    await settle();
    expect(p.errors).toEqual([]);
  });

  it.each(['rejects', 'hangs'] as const)('fails closed if a failed fill header reset %s', async (outcome) => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    p.b.createUnidirectionalStream = async () => ({ getWriter: () => ({
      write: async () => { throw new Error('header failed'); },
      abort: async () => {
        if (outcome === 'hangs') return new Promise<void>(() => {});
        throw new Error('reset failed');
      },
    }) }) as unknown as WritableStream<Uint8Array>;
    await expect(p.server.openFillStream(id)).rejects.toThrow(/header failed/);
    expect(p.server.session.state).toBe(SessionState.CLOSED);
  }, 3000);

  it('counts a completed fill even after its writer is reclaimed', async () => {
    const p = await pair();
    serveSubscriptions(p);
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    const stream = await p.server.openFillStream(id);
    await p.server.closeFetchStream(stream);
    expect(p.server.session.getIncomingSubscription(id)!.streamCount).toBe(1n);
    const state = p.server as unknown as {
      servedFills: Map<bigint, bigint>; inboundFetchGroupOrder: Map<bigint, unknown>; fetchServeReserved: Set<bigint>;
    };
    expect(state.servedFills.has(id)).toBe(false);
    expect(state.inboundFetchGroupOrder.has(id)).toBe(false);
    expect(state.fetchServeReserved.has(id)).toBe(false);
    await expect(p.server.openFillStream(id)).rejects.toThrow();
    await expect(p.server.openFetchStream(id)).rejects.toThrow();
  });

  it('waits for the response before interpreting an early fill with publisher-preferred order', async () => {
    const conn = new MoqtConnection(21);
    connections.push(conn);
    const transport = new TransportSim();
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    const objects: MoqtObject[] = [];
    const errors: Error[] = [];
    conn.onObject = (_stream, object) => objects.push(object);
    conn.onError = (error) => errors.push(error);
    await conn.connect(transport);
    const requestId = await conn.subscribe(ns('live'), nm('video'), { fill: {} });
    transport.pushIncomingUni(new Uint8Array([
      0x05, 0x00, 0x1c, 0x05, 0x00, 0x03, 0x01, 0xa5, 0x0c, 0x00, 0x00, 0x01, 0xa4,
    ]));
    await settle();
    expect(objects).toEqual([]);
    transport.bidi[0]!.push(codec.encode({
      type: 'SUBSCRIBE_OK', requestId, trackAlias: ALIAS,
      parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]),
      trackProperties: new Map([[0x22n, [2n]]]),
    }));
    await settle();
    expect(objects.map((object) => object.groupId)).toEqual([5n, 4n]);
    expect(errors).toEqual([]);
  });
});

describe('draft-21 inbound publication notifications', () => {
  it('accepts PUBLISH_STATE_NOTIFY on an established inbound PUBLISH stream', async () => {
    const conn = new MoqtConnection(21);
    connections.push(conn);
    const transport = new TransportSim();
    transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
    const errors: Error[] = [];
    conn.onError = (error) => errors.push(error);
    conn.onPublish = (pub) => { void conn.acceptSubscribe(pub.requestId, pub.trackAlias).catch((e: Error) => errors.push(e)); };
    await conn.connect(transport);
    const request = transport.pushIncomingBidi();
    request.push(codec.encode({ type: 'PUBLISH', requestId: 1n, trackAlias: ALIAS,
      trackNamespace: ns('live'), trackName: nm('video'), parameters: new Map(), trackProperties: new Map(),
    }));
    await settle();
    request.push(codec.encode({ type: 'PUBLISH_STATE_NOTIFY', parameters: new Map([[0x09n, [{ group: 8n, object: 2n }]]]) }));
    await settle();
    expect(conn.session.getIncomingSubscription(1n)?.largestLocation).toEqual({ groupId: 8n, objectId: 2n });
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });
});
