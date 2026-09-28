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
