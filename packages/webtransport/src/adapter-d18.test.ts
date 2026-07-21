/**
 * MoqtConnection draft-18 subscribe path, exercised with the deterministic
 * stream simulator: SUBSCRIBE travels on a per-request bidi stream, and the
 * stamped SUBSCRIBE_OK / REQUEST_ERROR flows through the adapter's normal
 * pipeline (qlog, raw subscribeTrack resolution, onMessage, session handling).
 */
import { describe, it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { createControlCodec, varint, writeVi64, SessionState } from '@moqt/transport';
import { SetupOption18 } from '@moqt/transport';
import type { SubscribeOk, RequestErrorMsg, RequestOk, Fetch, FetchOk, ControlMessage, QlogEvent, Setup, MoqtObject } from '@moqt/transport';

const codec18 = createControlCodec(18);
const setupBytes = (): Uint8Array => codec18.encode({ type: 'SETUP', setupOptions: new Map() });
const okBytes = (alias: bigint): Uint8Array =>
  codec18.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: alias, parameters: new Map(), trackExtensions: new Map() } as SubscribeOk);
const errBytes = (): Uint8Array =>
  codec18.encode({ type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(1n), retryInterval: varint(0n), errorReason: 'denied' } as RequestErrorMsg);
const reqOkBytes = (): Uint8Array =>
  codec18.encode({ type: 'REQUEST_OK', requestId: 0n, parameters: new Map() } as RequestOk);
const fetchOkBytes = (endGroup: bigint, endObject: bigint): Uint8Array =>
  codec18.encode({ type: 'FETCH_OK', requestId: 0n, endOfTrack: 0, endLocation: { group: endGroup, object: endObject }, parameters: new Map(), trackExtensions: new Map() } as FetchOk);
const nsBytes = (suffix: string): Uint8Array =>
  codec18.encode({ type: 'NAMESPACE', trackNamespaceSuffix: [new TextEncoder().encode(suffix)] } as never);
const nsDoneBytes = (suffix: string): Uint8Array =>
  codec18.encode({ type: 'NAMESPACE_DONE', trackNamespaceSuffix: [new TextEncoder().encode(suffix)] } as never);

const fetchRange = { startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n) };

const ns = (s: string) => [new TextEncoder().encode(s)];
const nm = (s: string) => new TextEncoder().encode(s);

async function connected(): Promise<{ conn: MoqtConnection; transport: TransportSim }> {
  const conn = new MoqtConnection(18);
  const transport = new TransportSim();
  // The control stream carries the peer SETUP and MUST stay open for the session
  // (§3.3) — a FIN after SETUP is now a protocol violation, so use openIncomingUni
  // (no auto-FIN) rather than pushIncomingUni (which FINs the stream).
  transport.openIncomingUni().push(setupBytes());
  await conn.connect(transport);
  return { conn, transport };
}

describe('MoqtConnection(18) construction + connect', () => {
  it('constructs with draft-18 (uses the uni-pair topology, not bidi-control)', () => {
    expect(() => new MoqtConnection(18)).not.toThrow();
  });

  it('connect() performs the draft-18 uni control-pair handshake', async () => {
    const { transport } = await connected();
    // our SETUP went out on a uni stream, framed as vi64(0x2F00)
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
    expect(transport.uniOut[0]!.writeClosed).toBe(false); // control stream stays open
  });

  it('forwards setup options into SETUP, strips path, and preserves explicit authority', async () => {
    const conn = new MoqtConnection(18);
    const transport = new TransportSim();
    transport.openIncomingUni().push(setupBytes()); // control stream stays open (§3.3)
    await conn.connect(transport, { implementation: 'playa', path: '/x', authority: 'host' });

    const setup = codec18.decode(transport.uniOut[0]!.writtenBytes(), 0).message as Setup;
    expect(setup.setupOptions.has(BigInt(SetupOption18.MOQT_IMPLEMENTATION))).toBe(true);
    expect(setup.setupOptions.has(BigInt(SetupOption18.PATH))).toBe(false);
    const authority = setup.setupOptions.get(BigInt(SetupOption18.AUTHORITY))?.[0];
    expect(new TextDecoder().decode(authority as Uint8Array)).toBe('host');
  });
});

describe('MoqtConnection(18) subscribe', () => {
  it('subscribe() routes SUBSCRIBE onto a request bidi stream and returns after the write', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.subscribe(ns('a'), nm('1')); // returns BEFORE any response
    expect(typeof requestId).toBe('bigint');
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x03); // SUBSCRIBE on the request stream
  });

  it('subscribeTrack() resolves on the stamped SUBSCRIBE_OK', async () => {
    const { conn, transport } = await connected();
    const seen: string[] = [];
    conn.onMessage = (m) => seen.push(m.type);

    const p = conn.subscribeTrack(ns('a'), nm('1'));
    await flush();
    transport.bidi[0]!.push(okBytes(42n)).closeReadable();

    const sub = await p;
    expect(sub.trackAlias).toBe(42n);
    // SUBSCRIBE_OK was consumed by raw subscription resolution → suppressed from onMessage.
    expect(seen).not.toContain('SUBSCRIBE_OK');
  });

  it('plain subscribe() routes SUBSCRIBE_OK to onMessage + qlog with a stamped requestId', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const qlog: QlogEvent[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onQlogEvent = (e) => qlog.push(e);

    const requestId = await conn.subscribe(ns('a'), nm('1')); // plain subscribe — no subscribeTrack suppression
    transport.bidi[0]!.push(okBytes(10n)).closeReadable();
    await flush();

    const ok = seen.find((m) => m.type === 'SUBSCRIBE_OK') as (SubscribeOk | undefined);
    expect(ok).toBeDefined();
    expect(ok!.requestId).toBe(requestId); // stamped from stream context
    expect(qlog.some((e) => e.type === 'control_message_parsed')).toBe(true);
  });

  it('SUBSCRIBE receiving a REDIRECT surfaces msg.redirect via onMessage; no uni-control bytes, no new stream', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;

    const requestId = await conn.subscribe(ns('a'), nm('1'));
    const redirectErr = codec18.encode({
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x34n), retryInterval: varint(0n), errorReason: 'moved',
      redirect: { connectUri: new TextEncoder().encode('https://r.example/moq'), trackNamespace: ns('a'), trackName: nm('1') },
    } as never);
    transport.bidi[0]!.push(redirectErr).closeReadable();
    await flush();

    const err = seen.find((m) => m.type === 'REQUEST_ERROR') as (RequestErrorMsg | undefined);
    expect(err?.redirect).toBeDefined();
    expect(err!.redirect!.trackName).toEqual(nm('1'));
    expect(err!.requestId).toBe(requestId); // stamped from the request stream
    // Correlation/topology unchanged: response rode the bidi stream — no uni-control, no new stream.
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
    expect(transport.bidi.length).toBe(1);
    expect(transport.closeInfo).toBeUndefined(); // SUBSCRIBE is a valid REDIRECT context
  });

  it('REQUEST_UPDATE reuses the request stream; each REQUEST_OK correlates to the update id, not the subscription', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    const subP = conn.subscribeTrack(ns('a'), nm('1')); // original requestId 0
    await flush();
    transport.bidi[0]!.push(okBytes(10n)); // SUBSCRIBE_OK — do NOT close: stream stays open for updates
    const sub = await subP;
    expect(sub.requestId).toBe(0n);

    // Two overlapping updates: BOTH sent (written) before either response.
    const u1 = await conn.requestUpdate(0n, { forward: false }); // id 2
    const u2 = await conn.requestUpdate(0n, { forward: true }); // id 4
    expect([u1, u2]).toEqual([2n, 4n]);
    await flush();
    expect(transport.bidi.length).toBe(1); // both reused the existing request stream

    // Then two REQUEST_OKs arrive in order.
    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(reqOkBytes()).closeReadable();
    await flush();

    // Each REQUEST_OK was stamped with the UPDATE's own id (2, then 4), never the subscription (0).
    const ids = seen.filter((m) => m.type === 'REQUEST_OK').map((m) => (m as RequestOk).requestId);
    expect(ids).toEqual([2n, 4n]);
  });

  it('surfaces onError immediately when a request stream receives an unsolicited response', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    const subP = conn.subscribeTrack(ns('a'), nm('1'));
    await flush();
    transport.bidi[0]!.push(okBytes(10n)); // SUBSCRIBE_OK (stream stays open)
    await subP;
    await flush();

    // Peer sends an EXTRA, unsolicited response — no later operation is queued.
    transport.bidi[0]!.push(reqOkBytes());
    await flush();

    expect(errors.some((e) => /unsolicited/i.test(e.message))).toBe(true);
  });

  it('requestUpdate for an unknown request stream errors clearly', async () => {
    const { conn } = await connected();
    await expect(conn.requestUpdate(999n, { forward: false })).rejects.toThrow(/no open .*request stream/i);
  });

  it('REQUEST_ERROR rejects only the matching subscribeTrack', async () => {
    const { conn, transport } = await connected();
    const pA = conn.subscribeTrack(ns('a'), nm('1'));
    const pB = conn.subscribeTrack(ns('b'), nm('2'));
    await flush();

    // A errors, B succeeds (reverse order).
    transport.bidi[1]!.push(okBytes(20n)).closeReadable();
    transport.bidi[0]!.push(errBytes()).closeReadable();

    await expect(pA).rejects.toThrow(/denied|Subscribe failed/i);
    const subB = await pB;
    expect(subB.trackAlias).toBe(20n);
  });
});

describe('MoqtConnection(18) fetch', () => {
  it('fetch() opens a new bidi request stream (not the control stream) and writes FETCH', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.fetch(ns('a'), nm('1'), fetchRange);
    expect(typeof requestId).toBe('bigint');
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x16); // FETCH on the request stream
    // The control uni stream carried only SETUP, not the FETCH.
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
  });

  it('joiningFetch() opens its own bidi request stream with a joining FETCH (0x2) payload', async () => {
    const { conn, transport } = await connected();
    const subReqId = await conn.subscribe(ns('a'), nm('1')); // request stream 0
    const requestId = await conn.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 2n,
    }); // request stream 1
    expect(requestId).not.toBe(subReqId);
    expect(transport.bidi.length).toBe(2);

    const { message } = codec18.decode(transport.bidi[1]!.writtenBytes(), 0);
    expect(message.type).toBe('FETCH');
    const jf = (message as Fetch).fetch as Extract<Fetch['fetch'], { fetchType: 0x2 | 0x3 }>;
    expect(jf.fetchType).toBe(0x2);
    expect(jf.joiningRequestId).toBe(subReqId);
    expect(jf.joiningStart).toBe(2n);
  });

  it('joiningFetch() throws INVALID_STATE for an unknown joiningRequestId (never emitted on the wire)', async () => {
    const { conn, transport } = await connected();
    await expect(conn.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: 998n, joiningStart: 0n,
    })).rejects.toThrow(/PENDING\/ESTABLISHED/);
    expect(transport.bidi.length).toBe(0); // nothing hit the wire
  });

  it('fetch() issues a standalone FETCH with a full-uint64 Location (above the QUIC range)', async () => {
    const { conn, transport } = await connected();
    const big = 1n << 63n;
    await conn.fetch(ns('a'), nm('1'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: big, endObject: 0n,
    });
    const written = transport.bidi[0]!.writtenBytes();
    const { message } = codec18.decode(written, 0);
    expect(message.type).toBe('FETCH');
    const f = (message as Fetch).fetch as Extract<Fetch['fetch'], { fetchType: 0x1 }>;
    expect(f.endLocation.group).toBe(big);
  });

  it('FETCH_OK routes to onMessage + qlog with a stamped fetch request ID', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const qlog: QlogEvent[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onQlogEvent = (e) => qlog.push(e);

    const requestId = await conn.fetch(ns('a'), nm('1'), fetchRange);
    transport.bidi[0]!.push(fetchOkBytes(9n, 4n)).closeReadable();
    await flush();

    const ok = seen.find((m) => m.type === 'FETCH_OK') as (FetchOk | undefined);
    expect(ok).toBeDefined();
    expect(ok!.requestId).toBe(requestId); // stamped from stream context
    expect(ok!.endLocation).toEqual({ group: 9n, object: 4n });
    expect(qlog.some((e) => e.type === 'control_message_parsed')).toBe(true);
  });

  it('concurrent SUBSCRIBE + FETCH resolve out of order on their own streams', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    const subReqId = await conn.subscribe(ns('a'), nm('1')); // request stream 0
    const fetchReqId = await conn.fetch(ns('b'), nm('2'), fetchRange); // request stream 1
    expect(transport.bidi.length).toBe(2);
    expect(subReqId).not.toBe(fetchReqId);

    // FETCH_OK arrives first (stream 1), then SUBSCRIBE_OK (stream 0).
    transport.bidi[1]!.push(fetchOkBytes(9n, 0n)).closeReadable();
    transport.bidi[0]!.push(okBytes(7n)).closeReadable();
    await flush();

    const fok = seen.find((m) => m.type === 'FETCH_OK') as FetchOk | undefined;
    const sok = seen.find((m) => m.type === 'SUBSCRIBE_OK') as SubscribeOk | undefined;
    expect(fok?.requestId).toBe(fetchReqId);
    expect(sok?.requestId).toBe(subReqId);
  });

  it('two FETCHes resolve correctly out of order, each stamped with its own id', async () => {
    const { conn, transport } = await connected();
    const seen: FetchOk[] = [];
    conn.onMessage = (m) => { if (m.type === 'FETCH_OK') seen.push(m as FetchOk); };

    const idA = await conn.fetch(ns('a'), nm('1'), fetchRange); // stream 0
    const idB = await conn.fetch(ns('b'), nm('2'), fetchRange); // stream 1

    // Reverse-order responses.
    transport.bidi[1]!.push(fetchOkBytes(2n, 0n)).closeReadable();
    transport.bidi[0]!.push(fetchOkBytes(1n, 0n)).closeReadable();
    await flush();

    const byId = new Map(seen.map((m) => [m.requestId, m.endLocation.group]));
    expect(byId.get(idA)).toBe(1n);
    expect(byId.get(idB)).toBe(2n);
  });

  it('REQUEST_ERROR correlates to only the matching fetch (stamped id); the other fetch still succeeds', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    const idA = await conn.fetch(ns('a'), nm('1'), fetchRange); // stream 0 → REQUEST_ERROR
    const idB = await conn.fetch(ns('b'), nm('2'), fetchRange); // stream 1 → FETCH_OK

    transport.bidi[1]!.push(fetchOkBytes(5n, 0n)).closeReadable();
    transport.bidi[0]!.push(errBytes()).closeReadable();
    await flush();

    // REQUEST_ERROR is a valid FETCH response — it routes through onMessage,
    // stamped with the errored fetch's id (A), leaving fetch B's OK intact.
    const err = seen.find((m) => m.type === 'REQUEST_ERROR') as { requestId?: bigint } | undefined;
    expect(err?.requestId).toBe(idA);
    const ok = seen.find((m) => m.type === 'FETCH_OK') as FetchOk | undefined;
    expect(ok?.requestId).toBe(idB);
    expect(ok?.endLocation.group).toBe(5n);
  });

});

describe('MoqtConnection(18) trackStatus (§10.14)', () => {
  it('opens a bidi request stream, writes TRACK_STATUS, and FINs the writable', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.trackStatus(ns('a'), nm('1'));
    expect(typeof requestId).toBe('bigint');
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x0d); // TRACK_STATUS
    expect(transport.bidi[0]!.writeClosed).toBe(true); // one-shot → FIN
    // The control uni stream carried only SETUP.
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
  });

  it('routes REQUEST_OK (TRACK_STATUS_OK) to onMessage with a stamped request ID', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    const requestId = await conn.trackStatus(ns('a'), nm('1'));
    transport.bidi[0]!.push(reqOkBytes()).closeReadable();
    await flush();

    const ok = seen.find((m) => m.type === 'REQUEST_OK') as (RequestOk | undefined);
    expect(ok).toBeDefined();
    expect(ok!.requestId).toBe(requestId); // stamped from stream context
  });

  it('REQUEST_ERROR surfaces via onError for the track-status request', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    const seen: ControlMessage[] = [];
    conn.onError = (e) => errors.push(e);
    conn.onMessage = (m) => seen.push(m);

    await conn.trackStatus(ns('a'), nm('1'));
    transport.bidi[0]!.push(errBytes()).closeReadable();
    await flush();

    // REQUEST_ERROR is a valid TRACK_STATUS response → routed via onMessage.
    expect(seen.some((m) => m.type === 'REQUEST_ERROR')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('TRACK_STATUS_OK carrying Track Properties is accepted and surfaces them (valid for this context)', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    await conn.trackStatus(ns('a'), nm('1'));
    // REQUEST_OK (TRACK_STATUS_OK) WITH Track Properties — valid here.
    const ok = codec18.encode({
      type: 'REQUEST_OK', requestId: 0n, parameters: new Map(),
      trackExtensions: new Map([[0x02n, [5n]]]) as never,
    } as RequestOk);
    transport.bidi[0]!.push(ok).closeReadable();
    await flush();

    expect(transport.closeInfo).toBeUndefined(); // NOT a protocol violation here
    const reqOk = seen.find((m) => m.type === 'REQUEST_OK') as (RequestOk | undefined);
    expect(reqOk?.trackExtensions?.get(0x02n as never)).toEqual([5n]); // surfaced to the app
  });
});

describe('MoqtConnection(18) publishNamespace (§10.15)', () => {
  it('opens a bidi request stream, writes PUBLISH_NAMESPACE, and KEEPS the writable open', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.publishNamespace(ns('a'));
    expect(typeof requestId).toBe('bigint');
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x06); // PUBLISH_NAMESPACE
    // NOT one-shot (§10.9/§3.3.2): the stream stays open for REQUEST_UPDATE / withdrawal.
    expect(transport.bidi[0]!.writeClosed).toBe(false);
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf); // control stream only carried SETUP
  });

  it('leaves the request stream open after REQUEST_OK (no FIN on the initial accept)', async () => {
    const { conn, transport } = await connected();
    await conn.publishNamespace(ns('a'));
    transport.bidi[0]!.push(reqOkBytes()); // accept, but do NOT close the peer side
    await flush();
    expect(transport.bidi[0]!.writeClosed).toBe(false); // still open after acceptance
  });

  it('routes REQUEST_OK (PUBLISH_NAMESPACE_OK) to onMessage with a stamped request ID', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    const requestId = await conn.publishNamespace(ns('a'));
    transport.bidi[0]!.push(reqOkBytes()).closeReadable();
    await flush();

    const ok = seen.find((m) => m.type === 'REQUEST_OK') as (RequestOk | undefined);
    expect(ok).toBeDefined();
    expect(ok!.requestId).toBe(requestId);
  });

  it('routes REQUEST_ERROR to onMessage without firing onError', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const errors: Error[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onError = (e) => errors.push(e);

    await conn.publishNamespace(ns('a'));
    transport.bidi[0]!.push(errBytes()).closeReadable();
    await flush();

    expect(seen.some((m) => m.type === 'REQUEST_ERROR')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('a REQUEST_OK carrying Track Properties closes the session (invalid for PUBLISH_NAMESPACE context)', async () => {
    const { conn, transport } = await connected();
    await conn.publishNamespace(ns('a'));

    // A WELL-FORMED REQUEST_OK with Track Properties — but PUBLISH_NAMESPACE
    // responses MUST NOT carry them. The codec decodes them; the session rejects
    // them by request-stream context → PROTOCOL_VIOLATION (session close).
    const ok = codec18.encode({
      type: 'REQUEST_OK', requestId: 0n, parameters: new Map(),
      trackExtensions: new Map([[0x02n, [5n]]]) as never,
    } as RequestOk);
    transport.bidi[0]!.push(ok).closeReadable();
    await flush();

    expect(transport.closeInfo?.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
  });
});

describe('MoqtConnection(18) publishNamespace withdrawal (§3.3.2)', () => {
  it('withdraws by cancelling the request stream — no PUBLISH_NAMESPACE_DONE, no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.publishNamespace(ns('a'));
    transport.bidi[0]!.push(reqOkBytes()); // accept → namespace active
    await flush();

    await conn.publishNamespaceDone(requestId);

    // Withdrawal == request-stream cancellation (RESET_STREAM + STOP_SENDING).
    expect(transport.bidi[0]!.writeAborted).toBe(true);
    expect(transport.bidi[0]!.readCancelled).toBe(true);
    // Nothing more was written on the request stream (only the original PUBLISH_NAMESPACE).
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x06);
    // The control (uni) stream carried ONLY SETUP — no PUBLISH_NAMESPACE_DONE.
    expect(transport.uniOut.length).toBe(1);
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
  });

  it('after withdrawal the request stream context is gone (cannot withdraw twice)', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.publishNamespace(ns('a'));
    transport.bidi[0]!.push(reqOkBytes());
    await flush();

    await conn.publishNamespaceDone(requestId);
    // Local namespace state is terminated → a second withdrawal is rejected by the session.
    await expect(conn.publishNamespaceDone(requestId)).rejects.toThrow();
  });
});

describe('MoqtConnection(18) fetch cancellation (§3.3.2)', () => {
  const fetchRangeC = { startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n) };
  const fetchHeaderBytes = (reqId: bigint): Uint8Array => {
    const out = new Uint8Array(9);
    let p = writeVi64(0x05n, out, 0); // FETCH_HEADER type
    p += writeVi64(reqId, out, p);
    return out.subarray(0, p);
  };
  // A first FETCH object (type 0x1c): group, object, priority, payload-len, payload.
  const firstFetchObjBytes = (group: bigint, obj: bigint, prio: number, payload: number[]): Uint8Array => {
    const out = new Uint8Array(64);
    let p = writeVi64(0x1cn, out, 0);
    p += writeVi64(group, out, p);
    p += writeVi64(obj, out, p);
    out[p++] = prio;
    p += writeVi64(BigInt(payload.length), out, p);
    out.set(payload, p); p += payload.length;
    return out.subarray(0, p);
  };
  const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
    let p = 0;
    for (const a of parts) { out.set(a, p); p += a.length; }
    return out;
  };

  it('sends no control-stream bytes and no FETCH_CANCEL; cancels the request stream both directions', async () => {
    const { conn, transport } = await connected();
    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    const reqStream = transport.bidi[0]!;
    const controlBytesBefore = transport.uniOut[0]!.writtenBytes().length;
    const reqBytesBefore = reqStream.writtenBytes().length;

    await conn.fetchCancel(reqId);

    // No FETCH_CANCEL on the control stream, and nothing new written anywhere.
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBytesBefore);
    expect(reqStream.writtenBytes().length).toBe(reqBytesBefore);
    // Request bidi: readable cancelled (STOP_SENDING) + writable aborted (RESET).
    expect(reqStream.readCancelled).toBe(true);
    expect(reqStream.writeAborted).toBe(true);
  });

  it('does not fire onError or leave an unhandled rejection for a local cancel', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    await conn.fetchCancel(reqId);
    await flush();

    expect(errors).toEqual([]);
  });

  it('cancel BEFORE FETCH_OK: the pending response is dropped — no FETCH_OK, no error', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const errors: Error[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onError = (e) => errors.push(e);

    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC); // FETCH_OK still pending
    await conn.fetchCancel(reqId);
    await flush();

    // The pending response promise was rejected with the cancellation marker,
    // which the request-stream handler swallows: no FETCH_OK, no onError.
    expect(seen.some((m) => m.type === 'FETCH_OK')).toBe(false);
    expect(errors).toEqual([]);
    // The readable is cancelled, so the peer can no longer deliver on it.
    expect(transport.bidi[0]!.readCancelled).toBe(true);
  });

  it('cancel AFTER FETCH_OK still tears down the request stream', async () => {
    const { conn, transport } = await connected();
    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    transport.bidi[0]!.push(fetchOkBytes(9n, 0n));
    await flush();

    await conn.fetchCancel(reqId);
    expect(transport.bidi[0]!.readCancelled).toBe(true);
    expect(transport.bidi[0]!.writeAborted).toBe(true);
  });

  it('cancels an open fetch DATA stream reader and cleans up state', async () => {
    const { conn, transport } = await connected();
    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    // Open a fetch data stream for this request (controlled, not auto-closed).
    const dataStream = transport.openIncomingUni();
    dataStream.push(fetchHeaderBytes(reqId));
    await flush();

    await conn.fetchCancel(reqId);
    await flush();

    expect(dataStream.readCancelled).toBe(true); // data stream got STOP_SENDING
    // A second cancel is a clean no-op — §5.2: the fetch is already reclaimed, so
    // fetchCancel is idempotent (resolves without throwing), not an error.
    await expect(conn.fetchCancel(reqId)).resolves.toBeUndefined();
  });

  it('a data stream arriving AFTER fetchCancel is DISCARDED, not delivered to onDataStream (§10.13)', async () => {
    const { conn, transport } = await connected();
    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    const fetchStreams: unknown[] = [];
    conn.onDataStream = (_sid, h) => { if (h.type === 'fetch') fetchStreams.push(h); };

    await conn.fetchCancel(reqId); // installs the late-stream marker SYNCHRONOUSLY
    await flush();

    // A response stream the peer already had in flight arrives after the cancel — the
    // marker must DISCARD it (STOP_SENDING), never surface it as a fetch data stream.
    const late = transport.openIncomingUni();
    late.push(fetchHeaderBytes(reqId));
    await flush();
    expect(late.readCancelled).toBe(true);
    expect(fetchStreams.length).toBe(0);
  });

  it('cancel with NO data stream yet only tears down the request stream', async () => {
    const { conn, transport } = await connected();
    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    await conn.fetchCancel(reqId); // no fetch data stream was ever opened
    expect(transport.bidi[0]!.readCancelled).toBe(true);
  });

  it('a SECOND FETCH response stream for the same request is a PROTOCOL_VIOLATION (§11.4.4)', async () => {
    const { conn, transport } = await connected();
    const errs: MoqtConnectionError[] = [];
    conn.onError = (e) => errs.push(e);
    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);

    transport.openIncomingUni().push(fetchHeaderBytes(reqId));
    await flush();
    // A second response stream for the SAME fetch — one is the §11.4.4 maximum.
    transport.openIncomingUni().push(fetchHeaderBytes(reqId));
    await flush();

    expect(conn.session.state).toBe(SessionState.CLOSED);
  });

  it('§5.2: a FETCH data stream arriving AFTER the request-stream FIN is still delivered (independent streams)', async () => {
    const { conn, transport } = await connected();
    const objs: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objs.push(o);
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC); // request stream 0
    // FETCH_OK arrives AND the peer FINs the request stream (a publisher that finished
    // serving on the request stream). §5.2/§10.12: the object data rides an INDEPENDENT
    // stream with no ordering relative to the request stream, so the fetch MUST survive
    // the request-stream close — the fetcher owns final closure once it has seen both
    // FETCH_OK and the data FIN.
    transport.bidi[0]!.push(fetchOkBytes(9n, 0n)).closeReadable();
    await flush();
    expect(conn.session.state).not.toBe(SessionState.CLOSED);
    // §3.3.2: the peer FIN'd their half, so the topology FINs ours (clean CLOSE, not a
    // RESET) — no half-open write side lingers even though the owner retains the fetch.
    expect(transport.bidi[0]!.writeClosed).toBe(true);
    expect(transport.bidi[0]!.writeAborted).toBe(false);
    expect(conn.session.getFetch(reqId)).not.toBeUndefined(); // retained until data FIN

    // The object data stream arrives afterward on its own uni stream — delivered, not
    // discarded as a stale/unknown request.
    transport.openIncomingUni().push(concatBytes(fetchHeaderBytes(reqId), firstFetchObjBytes(1n, 0n, 3, [0xaa])));
    await flush();

    expect(objs.map((o) => [o.groupId, o.objectId])).toEqual([[1n, 0n]]);
    expect(closeCode).toBeUndefined();
    expect(conn.session.state).not.toBe(SessionState.CLOSED);
  });

  it('§11.4.1: a clean FIN of the request stream BEFORE FETCH_OK reclaims the fetch (no permanently-pending leak)', async () => {
    const { conn, transport } = await connected();
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    expect(conn.session.getFetch(reqId)).not.toBeUndefined(); // pending

    // Peer FINs the request stream with no FETCH_OK — no response can arrive on a
    // closed stream, so the fetch is dead and MUST be reclaimed, not left pending.
    transport.bidi[0]!.closeReadable();
    await flush();

    expect(conn.session.getFetch(reqId)).toBeUndefined(); // reclaimed
    // §3.3.2: an early FIN with the response still pending is a FAILURE — our writable
    // half is RESET (aborted), not left half-open, before the context is dropped.
    expect(transport.bidi[0]!.writeAborted).toBe(true);
    expect(closeCode).toBeUndefined();
    expect(conn.session.state).not.toBe(SessionState.CLOSED);
  });

  it('§11.4.1: a RESET of the request stream AFTER FETCH_OK reclaims the fetch (no permanently-transferring leak)', async () => {
    const { conn, transport } = await connected();
    conn.onError = () => { /* a peer reset may surface as a stream error — tolerated */ };
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    const reqId = await conn.fetch(ns('a'), nm('1'), fetchRangeC);
    transport.bidi[0]!.push(fetchOkBytes(9n, 0n));
    await flush();
    expect(conn.session.getFetch(reqId)).not.toBeUndefined(); // transferring

    // Peer RESETs the request stream — a terminal stream error. The transferring fetch
    // MUST be reclaimed, not left forever.
    transport.bidi[0]!.resetReadable('peer reset');
    await flush();

    expect(conn.session.getFetch(reqId)).toBeUndefined(); // reclaimed
    // §3.3.2: a peer RESET is a failure — our writable half is RESET too, not leaked.
    expect(transport.bidi[0]!.writeAborted).toBe(true);
    expect(closeCode).toBeUndefined();
    expect(conn.session.state).not.toBe(SessionState.CLOSED);
  });
});

describe('MoqtConnection(18) subscribeNamespace (continuing stream, §10.18)', () => {
  it('opens a bidi request stream and writes SUBSCRIBE_NAMESPACE (kept open)', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.subscribeNamespace(ns('a'));
    expect(typeof requestId).toBe('bigint');
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x50); // SUBSCRIBE_NAMESPACE
    expect(transport.bidi[0]!.writeClosed).toBe(false); // continuing — not a one-shot FIN
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf); // control stream only carried SETUP
  });

  it('routes the first REQUEST_OK to onMessage, then NAMESPACE/NAMESPACE_DONE to onNamespaceMessage', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const nsMsgs: { requestId: bigint; type: string }[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onNamespaceMessage = (rid, m) => nsMsgs.push({ requestId: rid, type: m.type });

    const requestId = await conn.subscribeNamespace(ns('a'));
    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(nsBytes('s1'));
    transport.bidi[0]!.push(nsDoneBytes('s1'));
    await flush();

    const ok = seen.find((m) => m.type === 'REQUEST_OK') as (RequestOk | undefined);
    expect(ok?.requestId).toBe(requestId);
    expect(nsMsgs).toEqual([
      { requestId, type: 'NAMESPACE' },
      { requestId, type: 'NAMESPACE_DONE' },
    ]);
  });

  it('a NAMESPACE_DONE before the corresponding NAMESPACE closes the session (PROTOCOL_VIOLATION)', async () => {
    const { conn, transport } = await connected();

    await conn.subscribeNamespace(ns('a'));
    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(nsDoneBytes('s1')); // no prior NAMESPACE for s1
    await flush();

    // The session-level violation closes the WebTransport session (§6.1).
    expect(transport.closeInfo?.closeCode).toBe(0x3);
  });

  it('a NAMESPACE before the first REQUEST_OK closes the session (PROTOCOL_VIOLATION)', async () => {
    const { conn, transport } = await connected();
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    await conn.subscribeNamespace(ns('a'));
    transport.bidi[0]!.push(nsBytes('s1')); // before any REQUEST_OK
    await flush();

    expect(closeCode).toBe(0x3);
  });

  it('cancelNamespace gracefully closes the continuing stream', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.subscribeNamespace(ns('a'));
    transport.bidi[0]!.push(reqOkBytes());
    await flush();

    await conn.cancelNamespace(requestId);
    expect(transport.bidi[0]!.writeClosed).toBe(true);
  });
});

describe('MoqtConnection(18) subscribeTracks (continuing stream, §10.19)', () => {
  const pubBlockedBytes = (suffix: string, name: string): Uint8Array =>
    codec18.encode({ type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: [new TextEncoder().encode(suffix)], trackName: new TextEncoder().encode(name) } as never);

  it('opens a bidi request stream and writes SUBSCRIBE_TRACKS (kept open)', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.subscribeTracks(ns('a'));
    expect(typeof requestId).toBe('bigint');
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x51); // SUBSCRIBE_TRACKS
    expect(transport.bidi[0]!.writeClosed).toBe(false); // continuing
  });

  it('routes the first REQUEST_OK to onMessage, then PUBLISH_BLOCKED to onPublishBlocked', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const blocked: { requestId: bigint; type: string }[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onPublishBlocked = (rid, m) => blocked.push({ requestId: rid, type: m.type });

    const requestId = await conn.subscribeTracks(ns('a'));
    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(pubBlockedBytes('s1', 'vid'));
    await flush();

    const ok = seen.find((m) => m.type === 'REQUEST_OK') as (RequestOk | undefined);
    expect(ok?.requestId).toBe(requestId);
    expect(blocked).toEqual([{ requestId, type: 'PUBLISH_BLOCKED' }]);
  });

  it('a PUBLISH_BLOCKED before the first REQUEST_OK closes the session (PROTOCOL_VIOLATION)', async () => {
    const { conn, transport } = await connected();

    await conn.subscribeTracks(ns('a'));
    transport.bidi[0]!.push(pubBlockedBytes('s1', 'vid')); // before any REQUEST_OK
    await flush();

    // Topology first-response enforcement closes the WebTransport session.
    expect(transport.closeInfo?.closeCode).toBe(0x3);
  });
});

describe('MoqtConnection(18) request-stream GOAWAY (§10.4 — per-request migration)', () => {
  // Request-stream GOAWAY form carries NO Request ID (the stream identifies the request).
  const reqGoawayBytes = (): Uint8Array =>
    codec18.encode({ type: 'GOAWAY', newSessionUri: '', timeout: 0n } as ControlMessage);

  it('settles a pending subscribeTrack() (rejects, does not hang), keeps the session ESTABLISHED, fires no onClose, surfaces the GOAWAY via onMessage', async () => {
    const { conn, transport } = await connected();
    let closeCode = -1;
    conn.onClose = (code) => { closeCode = code; };
    const seen: string[] = [];
    conn.onMessage = (m) => seen.push(m.type);

    const p = conn.subscribeTrack(ns('a'), nm('1'));
    await flush();
    // Peer sends GOAWAY on THIS request stream → per-request migration signal.
    transport.bidi[0]!.push(reqGoawayBytes());
    for (let i = 0; i < 4; i++) await flush();

    await expect(p).rejects.toThrow(/GOAWAY|migration/i);
    // NOT a session-level event: session stays up, no onClose.
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
    expect(closeCode).toBe(-1);
    // The GOAWAY is surfaced to the application (same channel as control-stream GOAWAY).
    expect(seen).toContain('GOAWAY');
  });

  it('an ESTABLISHED subscribe (after SUBSCRIBE_OK, empty queue) still surfaces a later request-stream GOAWAY via onMessage; session stays ESTABLISHED, no onClose, state cleaned up', async () => {
    const { conn, transport } = await connected();
    let closeCode = -1;
    conn.onClose = (code) => { closeCode = code; };
    const seen: string[] = [];
    conn.onMessage = (m) => seen.push(m.type);

    const p = conn.subscribeTrack(ns('a'), nm('1')); // requestId 0
    await flush();
    transport.bidi[0]!.push(okBytes(9n)); // SUBSCRIBE_OK — stream stays open, queue drains
    const sub = await p;
    expect(sub.trackAlias).toBe(9n);
    expect(conn.session.getSubscription(0n)).toBeDefined();

    // A GOAWAY arrives later on the now-established request stream (empty FIFO queue).
    transport.bidi[0]!.push(reqGoawayBytes());
    for (let i = 0; i < 4; i++) await flush();

    // It is surfaced (NOT lost) even though no response was pending.
    expect(seen).toContain('GOAWAY');
    // Not a session event: still ESTABLISHED, no onClose.
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
    expect(closeCode).toBe(-1);
    // Per-request cleanup ran through the stream-close handling.
    expect(conn.session.getSubscription(0n)).toBeUndefined();
  });

  it('a request-stream GOAWAY on one subscribe does not disturb an unrelated pending subscribe', async () => {
    const { conn, transport } = await connected();
    let closeCode = -1;
    conn.onClose = (code) => { closeCode = code; };

    const pA = conn.subscribeTrack(ns('a'), nm('1')); // bidi[0]
    const pB = conn.subscribeTrack(ns('b'), nm('2')); // bidi[1]
    await flush();

    transport.bidi[0]!.push(reqGoawayBytes());        // migrate A
    transport.bidi[1]!.push(okBytes(2n)).closeReadable(); // B resolves normally
    for (let i = 0; i < 4; i++) await flush();

    await expect(pA).rejects.toThrow(/GOAWAY|migration/i);
    const subB = await pB;
    expect(subB.trackAlias).toBe(2n);
    expect(conn.session.state).toBe(SessionState.ESTABLISHED);
    expect(closeCode).toBe(-1);
  });
});

describe('MoqtConnection(18) accept-loop failure classification', () => {
  it('a terminal incoming-UNI accept-loop failure on an ESTABLISHED session emits a FATAL transport error', async () => {
    const { conn, transport } = await connected();
    const errors: Array<{ message: string; isFatal?: boolean; errorSource?: string }> = [];
    conn.onError = (e) => errors.push(e as never);

    transport.errorIncomingUni('simulated WT network error');
    for (let i = 0; i < 4; i++) await flush();

    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('simulated WT network error');
    expect(errors[0]!.isFatal).toBe(true);
    expect(errors[0]!.errorSource).toBe('transport');
  });

  it('a terminal incoming-BIDI accept-loop failure on an ESTABLISHED session emits a FATAL transport error', async () => {
    const { conn, transport } = await connected();
    const errors: Array<{ message: string; isFatal?: boolean; errorSource?: string }> = [];
    conn.onError = (e) => errors.push(e as never);

    transport.errorIncomingBidi('simulated WT bidi failure');
    for (let i = 0; i < 4; i++) await flush();

    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain('simulated WT bidi failure');
    expect(errors[0]!.isFatal).toBe(true);
  });

  it('accept-loop failures during/after an intentional close() are SWALLOWED (no error events)', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    await conn.close(); // session → CLOSED before the transport teardown
    transport.errorIncomingUni('teardown-induced reader failure');
    transport.errorIncomingBidi('teardown-induced reader failure');
    for (let i = 0; i < 4; i++) await flush();

    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) teardown on an already failed/closed transport', () => {
  // WebTransport.close() is specified to return undefined, but on an already
  // failed or closed session a non-conforming implementation may throw or
  // return a rejected thenable (observed in practice: Safari 26 rejects with
  // NetworkError after the session's network path has failed). An
  // intentional close() must neither reject nor leak an unhandled rejection.

  it('close() does not leak an unhandled rejection when transport.close() returns a rejected thenable', async () => {
    const { conn, transport } = await connected();
    (transport as any).close = () =>
      Promise.reject(new Error('NetworkError: A network error occurred.'));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(conn.close()).resolves.toBeUndefined();
      // Unhandled-rejection notifications fire on a macrotask turn.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('close() does not throw when transport.close() throws synchronously', async () => {
    const { conn, transport } = await connected();
    (transport as any).close = () => { throw new Error('InvalidStateError: session is closed'); };

    await expect(conn.close()).resolves.toBeUndefined();
  });
});
