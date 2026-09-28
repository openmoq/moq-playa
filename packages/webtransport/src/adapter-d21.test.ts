/**
 * MoqtConnection at draft 21: the draft-18 stream model (unified SETUP on a uni
 * control pair, one bidi stream per request) with the draft-21 message changes.
 */
import { describe, it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim } from './testkit/stream-sim.js';
import { createControlCodec } from '@moqt/transport';

const codec21 = createControlCodec(21);
const setupBytes = (): Uint8Array => codec21.encode({ type: 'SETUP', setupOptions: new Map() });

describe('MoqtConnection(21) negotiation', () => {
  it('connects with the unified SETUP on a uni control stream', async () => {
    const conn = new MoqtConnection(21);
    const transport = new TransportSim();
    transport.openIncomingUni().push(setupBytes());

    await conn.connect(transport);

    expect(conn.draftVersion).toBe(21);
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
  });

  it('a connection without an explicit draft adopts a negotiated moqt-21', async () => {
    const conn = new MoqtConnection();
    const transport = Object.assign(new TransportSim(), { protocol: 'moqt-21' });
    transport.openIncomingUni().push(setupBytes());

    await conn.connect(transport);

    expect(conn.draftVersion).toBe(21);
  });
});

// ─── fills (draft-21 §3.4) and PUBLISH_STATE_NOTIFY (§9.10) ────────────

import { writeVi64, vi64EncodingLength, varint, SessionState } from '@moqt/transport';
import type { ControlMessage, MoqtObject, DataStreamHeader, SubscribeOk } from '@moqt/transport';
import { flush } from './testkit/stream-sim.js';

const ns = (s: string) => [new TextEncoder().encode(s)];
const nm = (s: string) => new TextEncoder().encode(s);
const okBytes = (alias: bigint): Uint8Array =>
  codec21.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: alias, parameters: new Map(), trackExtensions: new Map() } as SubscribeOk);
const vi = (...values: bigint[]): Uint8Array => {
  const buf = new Uint8Array(values.reduce((n, v) => n + vi64EncodingLength(v), 0));
  let p = 0;
  for (const v of values) p += writeVi64(v, buf, p);
  return buf;
};
const concat = (...as: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(as.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of as) { out.set(a, p); p += a.length; }
  return out;
};
const fetchHeader = (requestId: bigint) => vi(0x05n, requestId);
// First fetch object: flags GROUP|OBJECT|PRIORITY (0x1C), group, object, priority, payload.
const firstFetchObj = (group: bigint, object: bigint, payload: number[]) =>
  concat(vi(0x1cn, group, object), new Uint8Array([3]), vi(BigInt(payload.length)), new Uint8Array(payload));

async function connected21(): Promise<{ conn: MoqtConnection; transport: TransportSim }> {
  const conn = new MoqtConnection(21);
  const transport = new TransportSim();
  transport.openIncomingUni().push(setupBytes());
  await conn.connect(transport);
  return { conn, transport };
}

async function subscribedWithFill(conn: MoqtConnection, transport: TransportSim) {
  const p = conn.subscribeTrack(ns('live'), nm('catalog'), {
    filter: { type: 'LargestObject' },
    fill: { filter: { type: 'RelativeStart', groups: 1n } },
  });
  await flush();
  transport.bidi[0]!.push(okBytes(7n)); // the subscription's request stream stays open
  return p;
}

describe('MoqtConnection(21) fill fetch streams', () => {
  it('routes the fill stream by the SUBSCRIBE Request ID and leaves the subscription open', async () => {
    const { conn, transport } = await connected21();
    const objects: MoqtObject[] = [];
    const streams: DataStreamHeader[] = [];
    const closed: string[] = [];
    conn.onObject = (_sid, o) => objects.push(o);
    conn.onDataStream = (_sid, h) => streams.push(h);
    conn.onStreamClosed = (_sid, _code, terminal) => closed.push(String(terminal));
    const sub = await subscribedWithFill(conn, transport);

    transport.pushIncomingUni(concat(fetchHeader(sub.requestId), firstFetchObj(4n, 0n, [0xaa])));
    await flush();

    expect(streams).toEqual([expect.objectContaining({ type: 'fetch', fill: true })]);
    expect(objects.map((o) => [o.groupId, o.objectId])).toEqual([[4n, 0n]]);
    expect(closed).toEqual(['fin']);
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
    expect(transport.bidi[0]!.writeClosed).toBe(false); // the SUBSCRIBE stream is not finished
  });

  it('accepts one fill stream per request', async () => {
    const { conn, transport } = await connected21();
    const sub = await subscribedWithFill(conn, transport);
    transport.pushIncomingUni(concat(fetchHeader(sub.requestId), firstFetchObj(4n, 0n, [0xaa])));
    await flush();

    transport.pushIncomingUni(concat(fetchHeader(sub.requestId), firstFetchObj(4n, 0n, [0xaa])));
    await flush();

    expect(conn.session.state).toBe(SessionState.CLOSED);
  });

  it('a FETCH_HEADER for a subscription that asked for no fill is still a protocol violation', async () => {
    const { conn, transport } = await connected21();
    const p = conn.subscribeTrack(ns('live'), nm('video'));
    await flush();
    transport.bidi[0]!.push(okBytes(8n));
    const sub = await p;

    transport.pushIncomingUni(concat(fetchHeader(sub.requestId), firstFetchObj(1n, 0n, [0x01])));
    await flush();

    expect(conn.session.state).toBe(SessionState.CLOSED);
  });

  it('cancelFill discards a fill stream that arrives later, keeping the session and subscription', async () => {
    const { conn, transport } = await connected21();
    const objects: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objects.push(o);
    const sub = await subscribedWithFill(conn, transport);

    await conn.cancelFill(sub.requestId);
    transport.pushIncomingUni(concat(fetchHeader(sub.requestId), firstFetchObj(4n, 0n, [0xaa])));
    await flush();

    expect(objects).toEqual([]);
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
    expect(transport.bidi[0]!.writeClosed).toBe(false);
  });
});

describe('MoqtConnection(21) PUBLISH_STATE_NOTIFY', () => {
  it('is surfaced on the subscription stream and advances its Largest Location', async () => {
    const { conn, transport } = await connected21();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);
    const p = conn.subscribeTrack(ns('live'), nm('video'));
    await flush();
    transport.bidi[0]!.push(okBytes(9n));
    const sub = await p;

    transport.bidi[0]!.push(codec21.encode({
      type: 'PUBLISH_STATE_NOTIFY',
      parameters: new Map([[0x09n, [{ group: 3n, object: 7n }]], [0x10n, [varint(0n)]]]),
    } as ControlMessage));
    await flush();

    expect(seen).toContainEqual(expect.objectContaining({ type: 'PUBLISH_STATE_NOTIFY', requestId: sub.requestId }));
    expect(conn.session.getSubscription(sub.requestId)!.largestLocation).toEqual({ groupId: 3n, objectId: 7n });
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('before SUBSCRIBE_OK it is a protocol violation', async () => {
    const { conn, transport } = await connected21();
    void conn.subscribeTrack(ns('live'), nm('video')).catch(() => undefined);
    await flush();

    transport.bidi[0]!.push(codec21.encode({ type: 'PUBLISH_STATE_NOTIFY', parameters: new Map() } as ControlMessage));
    await flush();

    expect(conn.session.state).toBe(SessionState.CLOSED);
  });
});

describe('MoqtConnection(21) serving a fill (publisher side)', () => {
  it('openFillStream answers a SUBSCRIBE fill on one fetch stream and leaves the subscription up', async () => {
    const { connectedPair } = await import('./testkit/pair.js');
    const { client, server, errors } = await connectedPair(21);
    let fillRefusedWithoutRequest = false;
    let alias = 12n;
    server.onSubscribe = (requestId, _ns, trackName) => {
      void (async () => {
        await server.acceptSubscribe(requestId, alias++);
        if (new TextDecoder().decode(trackName) !== 'catalog') {
          await server.openFillStream(requestId).catch(() => { fillRefusedWithoutRequest = true; });
          return;
        }
        const sid = await server.openFillStream(requestId);
        await server.sendFetchObject(sid, { groupId: 4n, subgroupId: 0n, objectId: 0n, publisherPriority: 3, payload: new Uint8Array([1]) });
        await server.sendFetchObject(sid, { groupId: 4n, subgroupId: 0n, objectId: 1n, publisherPriority: 3, payload: new Uint8Array([2]) });
        await server.closeFetchStream(sid);
      })();
    };
    const objects: MoqtObject[] = [];
    const streams: DataStreamHeader[] = [];
    client.onObject = (_sid, o) => objects.push(o);
    client.onDataStream = (_sid, h) => streams.push(h);

    const sub = await client.subscribeTrack(ns('live'), nm('catalog'), {
      filter: { type: 'LargestObject' },
      fill: { filter: { type: 'RelativeStart', groups: 1n } },
    });
    await client.subscribeTrack(ns('live'), nm('video'));
    for (let i = 0; i < 10; i++) await flush();

    expect(streams).toEqual([expect.objectContaining({ fill: true })]);
    expect(objects.map((o) => o.objectId)).toEqual([0n, 1n]);
    expect(fillRefusedWithoutRequest).toBe(true);
    expect(client.session.getSubscription(sub.requestId)).toBeDefined();
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(21) fills on REQUEST_UPDATE (§3.4)', () => {
  it('routes the fill stream carrying the REQUEST_UPDATE Request ID to the subscription', async () => {
    const { client, server, errors } = await connectedPair21();
    let subReq = -1n;
    server.onSubscribe = (requestId) => { subReq = requestId; void server.acceptSubscribe(requestId, 30n); };
    const streams: DataStreamHeader[] = [];
    const objects: MoqtObject[] = [];
    client.onDataStream = (_sid, h) => streams.push(h);
    client.onObject = (_sid, o) => objects.push(o);
    const sub = await client.subscribeTrack(ns('live'), nm('video'), { filter: { type: 'LargestObject' } });

    const updateId = await client.requestUpdate(sub.requestId, {
      fill: { filter: { type: 'AbsoluteRange', startGroup: 1n, startObject: 0n, endGroup: 1n } },
    });
    await flushN();
    const sid = await server.openFillStream(updateId);
    await server.sendFetchObject(sid, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([9]) });
    await server.closeFetchStream(sid);
    await flushN();

    expect(subReq).toBe(sub.requestId);
    expect(streams).toEqual([expect.objectContaining({ fill: true, header: expect.objectContaining({ requestId: updateId }) })]);
    expect(objects.map((o) => [o.groupId, o.objectId])).toEqual([[1n, 0n]]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });

  it('cancelFill on the subscription also drops a fill its update asked for', async () => {
    const { client, server } = await connectedPair21();
    server.onSubscribe = (requestId) => { void server.acceptSubscribe(requestId, 31n); };
    const objects: MoqtObject[] = [];
    client.onObject = (_sid, o) => objects.push(o);
    const sub = await client.subscribeTrack(ns('live'), nm('video'));
    const updateId = await client.requestUpdate(sub.requestId, { fill: {} });
    await client.cancelFill(sub.requestId);

    const sid = await server.openFillStream(updateId);
    await server.sendFetchObject(sid, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([1]) });
    await server.closeFetchStream(sid);
    await flushN();

    expect(objects).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });
});

describe('MoqtConnection(21) MAX_REQUEST_UPDATES (§9.1.7)', () => {
  it('the client keeps within the limit the server advertised', async () => {
    const { client, server } = await connectedPair21({ serverSetup: { maxRequestUpdates: 1n } });
    server.onSubscribe = () => { /* leave it pending: updates stay unanswered */ };
    const pending = client.subscribeTrack(ns('live'), nm('video'));
    pending.catch(() => undefined);
    await flushN();
    const subId = [...(client.session as unknown as { subscriptions: Map<bigint, unknown> }).subscriptions.keys()][0]!;
    await client.requestUpdate(subId, { forward: 0 });
    await expect(client.requestUpdate(subId, { forward: 1 })).rejects.toThrow(/MAX_REQUEST_UPDATES/);
  });

  it('a peer exceeding our limit closes the session with TOO_MANY_REQUEST_UPDATES', async () => {
    const { client, server } = await connectedPair21({ serverSetup: { maxRequestUpdates: 1n } });
    server.onSubscribe = () => { /* pending: updates are queued, not answered */ };
    let closedWith: bigint | undefined;
    server.onClose = (code) => { closedWith = BigInt(code as never); };
    // A client that ignores the advertised limit.
    (client.session as unknown as { _peerMaxRequestUpdates: bigint })._peerMaxRequestUpdates = 0n;
    const pending = client.subscribeTrack(ns('live'), nm('video'));
    pending.catch(() => undefined);
    await flushN();
    const subId = [...(client.session as unknown as { subscriptions: Map<bigint, unknown> }).subscriptions.keys()][0]!;
    await client.requestUpdate(subId, { forward: 0 });
    await flushN();
    expect(server.session.state).toBe(SessionState.ESTABLISHED); // one outstanding is allowed
    await client.requestUpdate(subId, { forward: 1 }).catch(() => undefined);
    await flushN();
    expect(server.session.state).toBe(SessionState.CLOSED);
    expect(closedWith).toBe(0x1bn);
  });
});

async function connectedPair21(opts: Parameters<typeof import('./testkit/pair.js')['connectedPair']>[1] = {}) {
  const { connectedPair } = await import('./testkit/pair.js');
  return connectedPair(21, opts);
}

async function flushN(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}


describe('MoqtConnection native QUIC at draft 21', () => {
  const quicTransport = (protocol: string) => Object.assign(new TransportSim(), {
    kind: 'quic' as const,
    protocol,
    maxDatagramSize: 1200,
    setupOptions: { path: '/moq', authority: 'relay.example:443' },
  });

  it('a moqt-21 transport selects draft 21', async () => {
    const conn = new MoqtConnection();
    const transport = quicTransport('moqt-21');
    transport.openIncomingUni().push(setupBytes());
    await conn.connect(transport);
    expect(conn.draftVersion).toBe(21);
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('a connection made for draft 21 refuses a moqt-18 transport', async () => {
    const conn = new MoqtConnection(21);
    const transport = quicTransport('moqt-18');
    await expect(conn.connect(transport)).rejects.toThrow(/draft 18.*draft 21/);
    await conn.close();
  });
});
