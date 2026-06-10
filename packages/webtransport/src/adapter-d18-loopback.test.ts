/**
 * draft-18 end-to-end loopback: two REAL MoqtConnection(18) instances — one
 * CLIENT, one SERVER — wired through an in-memory loopback transport. This
 * proves the full topology works between two endpoints (uni SETUP pair, bidi
 * request streams with same-stream responses, alias binding, uni data delivery),
 * not just one side against simulated bytes.
 */
import { describe, it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { connectedPair, withProtocol, ns, nm } from './testkit/pair.js';
import { SessionState, ForwardState, varint, SessionError, decodeSubgroupHeader18 } from '@moqt/transport';
import type { MoqtObject, ControlMessage, Goaway } from '@moqt/transport';

describe('MoqtConnection(18) loopback — SETUP handshake', () => {
  it('client and server both reach ESTABLISHED via the uni SETUP pair', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
    // Each opened exactly one uni control stream, carrying the 0x2F00 SETUP.
    expect(a.uniOut.length).toBe(1);
    expect(b.uniOut.length).toBe(1);
    expect(a.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
    expect(b.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — subscriber happy path', () => {
  it('subscribe → onSubscribe → acceptSubscribe → SUBSCRIBE_OK → subgroup data → onObject; no control leak, no onError', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const controlB = b.uniOut[0]!.writtenBytes().length;

    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };

    const recv: MoqtObject[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flush();

    // Server received the inbound SUBSCRIBE on its own bidi request stream.
    expect(subReqId).toBe(0n); // client (even parity) first request
    await server.acceptSubscribe(subReqId, 9n);
    const sub = await subP;
    expect(sub.trackAlias).toBe(9n);

    // Server publishes a subgroup object on the accepted alias.
    const sid = await server.openSubgroup(9n, 7n, 0n, { publisherPriority: 3 });
    await server.sendObject(sid, 0n, new Uint8Array([0xaa, 0xbb]));
    await server.closeSubgroup(sid);
    await flush();

    // Client receives it through the per-subscription callback, fully decoded.
    expect(recv.length).toBe(1);
    expect(recv[0]!.trackAlias).toBe(9n);
    expect(recv[0]!.groupId).toBe(7n);
    expect(recv[0]!.objectId).toBe(0n);
    if (recv[0]!.kind === 'data') {
      expect(recv[0]!.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
      // draft-18 vocabulary: the delivered object exposes `properties` (canonical),
      // mirroring the deprecated `extensions` alias.
      expect(recv[0]!.properties).toBe(recv[0]!.extensions);
    }

    // Cross-stream invariant: no request/response leaked onto either uni control
    // stream after SETUP — they ride bidi request streams and uni data streams.
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(controlB);

    // No onError / unhandled rejection on the happy path.
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection() loopback — draft-18 via WT protocol negotiation', () => {
  it('auto-negotiates moqt-18 (no explicit version): uni SETUP, no bidi control stream, client draftVersion=18, subscriber path works', async () => {
    const { a, b } = createLoopback();
    // Client constructed with NO explicit version — it must pick up draft-18 from
    // the negotiated transport.protocol. Server is explicit 18.
    const client = new MoqtConnection();
    const server = new MoqtConnection(18, { role: 'server' });
    const errors: Error[] = [];
    client.onError = (e) => errors.push(e);
    server.onError = (e) => errors.push(e);

    await Promise.all([
      client.connect(withProtocol(a, 'moqt-18')),
      server.connect(b),
    ]);

    // Negotiation selected draft-18 and both endpoints completed the uni SETUP.
    expect(client.draftVersion).toBe(18);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
    // SETUP rode a uni control stream (0x2F00 → first byte 0xAF), and NO legacy
    // bidi control stream was opened for setup.
    expect(a.uniOut.length).toBe(1);
    expect(a.uniOut[0]!.writtenBytes()[0]).toBe(0xaf);
    expect(a.bidiOut.length).toBe(0);
    expect(errors).toEqual([]);

    // The existing subscriber happy path still works through the negotiated client.
    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };
    const recv: MoqtObject[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flush();
    expect(subReqId).toBe(0n);
    await server.acceptSubscribe(subReqId, 9n);
    const sub = await subP;
    expect(sub.trackAlias).toBe(9n);

    const sid = await server.openSubgroup(9n, 7n, 0n, { publisherPriority: 3 });
    await server.sendObject(sid, 0n, new Uint8Array([0xaa, 0xbb]));
    await server.closeSubgroup(sid);
    await flush();

    expect(recv.length).toBe(1);
    expect(recv[0]!.trackAlias).toBe(9n);
    if (recv[0]!.kind === 'data') {
      expect(recv[0]!.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
    }
    // The subscribe opened exactly one bidi REQUEST stream (not a control stream).
    expect(a.bidiOut.length).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — peer REQUEST_UPDATE on outbound PUBLISH (§10.9)', () => {
  it('publisher PUBLISH → peer REQUEST_OK → peer REQUEST_UPDATE answered REQUEST_OK on the same stream; FORWARD applied, no control leak, no onError', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const controlB = b.uniOut[0]!.writtenBytes().length;
    const bidiCountBefore = a.bidiOut.length;

    // Publisher (client) PUBLISHes a track; the peer (server) receives inbound PUBLISH.
    let pubReqId = -1n;
    server.onPublish = (p) => { pubReqId = p.requestId; };
    const requestId = await client.publish(ns('live'), nm('vid'), 21n);
    await flush();
    expect(pubReqId).toBe(0n); // client (even parity) first request

    // Peer accepts the publish (REQUEST_OK shorthand) on the same stream.
    await server.acceptSubscribe(pubReqId, 21n);
    await flush();
    const outPub = client.session.getOutgoingPublish(requestId);
    expect(outPub?.forwardState).toBe(ForwardState.ACTIVE); // established, forwarding

    // Peer sends REQUEST_UPDATE (FORWARD=0 → pause) on the SAME PUBLISH stream.
    const updates: ControlMessage[] = [];
    client.onMessage = (m) => updates.push(m);
    await server.requestUpdate(pubReqId, { forward: false });
    await flush();

    // Publisher applied the update to its outbound publish state (FORWARD paused).
    expect(outPub?.forwardState).toBe(ForwardState.PAUSED);
    // And it was surfaced stamped with the original PUBLISH id as existingRequestId.
    const upd = updates.find((m) => m.type === 'REQUEST_UPDATE') as { existingRequestId?: bigint } | undefined;
    expect(upd?.existingRequestId).toBe(requestId);

    // No NEW bidi stream was opened by the publisher to answer; no uni-control bytes.
    expect(a.bidiOut.length).toBe(bidiCountBefore + 1); // only the PUBLISH stream
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(controlB);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — outbound PUBLISH lifecycle (data + PUBLISH_DONE)', () => {
  it('publish → accept → object delivered to the peer → PUBLISH_DONE seen by the peer; no onError', async () => {
    const { client, server, errors } = await connectedPair();
    let pubReqId = -1n;
    const recv: MoqtObject[] = [];
    const serverMsgs: ControlMessage[] = [];
    server.onPublish = (p) => { pubReqId = p.requestId; p.onObject = (o) => recv.push(o); };
    server.onMessage = (m) => serverMsgs.push(m);

    const requestId = await client.publish(ns('live'), nm('vid'), 33n);
    await flush();
    await server.acceptSubscribe(pubReqId, 33n); // PUBLISH_OK shorthand
    await flush();

    // Publisher streams an object on the advertised alias, then ends the publication.
    const sid = await client.openSubgroup(33n, 1n, 0n, { publisherPriority: 4 });
    await client.sendObject(sid, 0n, new Uint8Array([0x01]));
    await client.closeSubgroup(sid);
    await flush();
    await client.publishDone(requestId, varint(0n), 'done');
    await flush();

    expect(recv.length).toBe(1); // peer received the published object via publish.onObject
    if (recv[0]!.kind === 'data') expect(recv[0]!.payload).toEqual(new Uint8Array([0x01]));
    expect(serverMsgs.some((m) => m.type === 'PUBLISH_DONE')).toBe(true); // PUBLISH_DONE on the same stream
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — FETCH happy path + cancel (§10.12)', () => {
  it('client FETCH → server onFetch → acceptFetch → fetch data → client onObject (objects + EOR gap); then cancel', async () => {
    const { client, server, a, errors } = await connectedPair();
    let fetchReqId = -1n;
    server.onFetch = (rid) => { fetchReqId = rid; };
    const recv: MoqtObject[] = [];
    client.onObject = (_sid, o) => recv.push(o);

    const requestId = await client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    await flush();
    expect(fetchReqId).toBe(0n); // client (even parity) first request

    await server.acceptFetch(fetchReqId); // FETCH_OK on the same bidi stream
    await flush();

    const sid = await server.openFetchStream(fetchReqId);
    await server.sendFetchObject(sid, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: new Uint8Array([0xaa]) });
    await server.sendFetchObject(sid, { groupId: 1n, subgroupId: 0n, objectId: 1n, publisherPriority: 5, payload: new Uint8Array([0xbb]) });
    await server.sendFetchEndOfRange(sid, true, 2n, 0n);
    await server.closeFetchStream(sid);
    await flush();

    // Client received both fetch objects in order, plus the End-of-Range gap.
    const data = recv.filter((o) => o.kind === 'data');
    expect(data.map((o) => [o.groupId, o.objectId])).toEqual([[1n, 0n], [1n, 1n]]);
    expect(recv.some((o) => o.kind === 'gap')).toBe(true);
    expect(errors).toEqual([]);

    // Local cancel/close: RESET the fetch request stream, no error surfaced.
    await client.fetchCancel(requestId);
    await flush();
    expect(a.bidiOut[0]!.out.writeAborted).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — §10.9.2 prefix REQUEST_UPDATE on continuing streams', () => {
  it('SUBSCRIBE_NAMESPACE: client requestUpdate writes on the same stream; both sides apply the new prefix', async () => {
    const { client, server, a, errors } = await connectedPair();
    let snReqId = -1n;
    server.onSubscribeNamespace = (rid) => { snReqId = rid; };

    const reqId = await client.subscribeNamespace(ns('a'));
    await flush();
    expect(snReqId).toBe(0n);
    await server.acceptSubscribeNamespace(snReqId); // REQUEST_OK → client ns sub ACTIVE
    await flush();
    expect(client.session.getNamespaceSubscription(reqId)!.namespacePrefix).toEqual([nm('a')]);

    const bidiBefore = a.bidiOut.length; // the continuing SUBSCRIBE_NAMESPACE stream
    await client.requestUpdate(reqId, { trackNamespacePrefix: [nm('a'), nm('b')] });
    await flush();

    // No NEW bidi stream opened — the update rode the existing continuing stream.
    expect(a.bidiOut.length).toBe(bidiBefore);
    // Subscriber applied the new prefix on the matched REQUEST_OK.
    expect(client.session.getNamespaceSubscription(reqId)!.namespacePrefix).toEqual([nm('a'), nm('b')]);
    // Publisher (peer) stamped + applied the update on the same stream.
    expect(server.session.getIncomingNamespaceSubscription(snReqId)!.namespacePrefix).toEqual([nm('a'), nm('b')]);
    expect(errors).toEqual([]);
  });

  it('SUBSCRIBE_TRACKS: client requestUpdate prefix is applied on both sides', async () => {
    const { client, server, a, errors } = await connectedPair();
    let stReqId = -1n;
    server.onSubscribeTracks = (rid) => { stReqId = rid; };

    const reqId = await client.subscribeTracks(ns('a'));
    await flush();
    expect(stReqId).toBe(0n);
    await server.acceptSubscribeTracks(stReqId);
    await flush();

    const bidiBefore = a.bidiOut.length;
    await client.requestUpdate(reqId, { trackNamespacePrefix: [nm('c')] });
    await flush();

    expect(a.bidiOut.length).toBe(bidiBefore); // same stream
    expect(client.session.getTrackSubscription(reqId)!.trackNamespacePrefix).toEqual([nm('c')]);
    expect(server.session.getIncomingTrackSubscription(stReqId)!.trackNamespacePrefix).toEqual([nm('c')]);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — §10.9.1 failed SUBSCRIBE_NAMESPACE prefix update closes the stream', () => {
  it('an overlapping prefix update is rejected (PREFIX_OVERLAP); the responder drops that subscription and closes its stream', async () => {
    const { client, server, errors } = await connectedPair();
    const snIds: bigint[] = [];
    server.onSubscribeNamespace = (rid) => { snIds.push(rid); };

    const r1 = await client.subscribeNamespace(ns('x'));
    await flush();
    await server.acceptSubscribeNamespace(snIds[0]!);
    await client.subscribeNamespace(ns('y'));
    await flush();
    await server.acceptSubscribeNamespace(snIds[1]!);
    await flush();
    expect(server.session.getIncomingNamespaceSubscription(snIds[0]!)).toBeDefined();

    // Update sub#1's prefix to overlap sub#2 → REQUEST_ERROR / PREFIX_OVERLAP and,
    // per §10.9.1, the responder closes sub#1's bidi stream.
    await client.requestUpdate(r1, { trackNamespacePrefix: [nm('y')] });
    await flush();

    // Responder dropped the overlapping subscription; the other is untouched.
    expect(server.session.getIncomingNamespaceSubscription(snIds[0]!)).toBeUndefined();
    expect(server.session.getIncomingNamespaceSubscription(snIds[1]!)).toBeDefined();
    // The responder closed sub#1's bidi stream (§10.9.1); the subscriber side
    // terminated that namespace subscription on the FIN (prefix was never updated).
    expect(client.session.getNamespaceSubscription(r1)).toBeUndefined();
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — TRACK_STATUS_OK Track Properties (§10.14)', () => {
  it('client trackStatus → server accepts with Track Properties → client onMessage sees them; no onError/close', async () => {
    const { client, server, errors } = await connectedPair();
    let tsReqId = -1n;
    server.onTrackStatus = (rid) => { tsReqId = rid; };
    const clientMsgs: ControlMessage[] = [];
    client.onMessage = (m) => clientMsgs.push(m);

    await client.trackStatus(ns('live'), nm('vid'));
    await flush();
    expect(tsReqId).toBe(0n);

    // DEFAULT_PUBLISHER_PRIORITY (0x0E) = 7.
    const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [7n]]]);
    await server.acceptTrackStatus(tsReqId, { trackProperties });
    await flush();

    const ok = clientMsgs.find((m) => m.type === 'REQUEST_OK') as { trackProperties?: Map<bigint, unknown> } | undefined;
    expect(ok).toBeDefined();
    expect(ok!.trackProperties).toEqual(trackProperties);
    expect(client.session.state).toBe(SessionState.ESTABLISHED); // not closed
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — UNSUBSCRIBE (request-stream teardown, §3.3.2)', () => {
  it('cancels the subscribe request stream, frees the alias, and stops delivery — no UNSUBSCRIBE message, no onError/close', async () => {
    const { client, server, a, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;

    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const delivered: string[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), {
      onObject: (o) => delivered.push(`${o.groupId}:${o.objectId}`),
    });
    await flush();
    await server.acceptSubscribe(rid, 5n);
    const sub = await subP;
    expect(sub.trackAlias).toBe(5n);

    // The subscribe rode the first client-opened bidi request stream.
    const subStream = a.bidiOut[0]!;
    // One object on the active subscription is delivered.
    let sid = await server.openSubgroup(5n, 1n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([1]));
    await server.closeSubgroup(sid);
    await flush();
    expect(delivered).toEqual(['1:0']);
    expect(client.session.getTrackByAlias(5n)).toBeDefined(); // alias registered while active

    // UNSUBSCRIBE: draft-18 has no UNSUBSCRIBE message — this must reset the
    // request stream and clean local state, not throw.
    await sub.unsubscribe();
    await flush();

    expect(subStream.out.writeAborted).toBe(true);                  // request stream RESET
    expect(client.session.getSubscription(rid)).toBeUndefined();    // local sub state cleaned
    expect(client.session.getTrackByAlias(5n)).toBeUndefined();     // alias unregistered

    // Late data on the freed alias must NOT reach the subscription callback.
    sid = await server.openSubgroup(5n, 2n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([2]));
    await server.closeSubgroup(sid);
    await flush();
    expect(delivered).toEqual(['1:0']); // '2:0' NOT delivered

    // No uni-control leak, no error, no session close on a local unsubscribe.
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('the server drops its incoming subscription when the request stream is reset', async () => {
    const { client, server, errors } = await connectedPair();
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    await server.acceptSubscribe(rid, 7n);
    const sub = await subP;
    expect(server.session.getIncomingSubscription(rid)).toBeDefined();

    await sub.unsubscribe();
    await flush();
    expect(server.session.getIncomingSubscription(rid)).toBeUndefined();
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — §3.2 reserved .session SUBSCRIBE auto-rejected on the same stream', () => {
  it('subscribeTrack(.session) REJECTS with DOES_NOT_EXIST (answered on its own bidi stream); no onSubscribe, no incoming state, no control leak / onError', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const controlB = b.uniOut[0]!.writtenBytes().length;

    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };

    // A client may subscribe to a session-level track; the publisher (server)
    // recognizes none, so it MUST answer with DOES_NOT_EXIST (§3.2.2) on the
    // request's own bidi stream — and the convenience promise MUST reject (even
    // under zero-latency loopback delivery — the response resolver is registered
    // before the SUBSCRIBE bytes go out).
    const rejects = expect(
      client.subscribeTrack(ns('.session'), nm('vid'), { onObject: () => {} }),
    ).rejects.toThrow(/does not exist/i);
    for (let i = 0; i < 4; i++) await flush();
    await rejects;

    // Auto-rejected at the session layer — never surfaced to the application and
    // left no dangling request state (client's first request id is 0).
    expect(subReqId).toBe(-1n);
    expect(server.session.getIncomingSubscription(0n)).toBeUndefined();

    // The REQUEST_ERROR rode the request's OWN bidi stream: nothing leaked onto the
    // uni control streams, and it was a per-request error (no onError / no close).
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(controlB);
    expect(errors).toEqual([]);
  });

  it('a non-reserved subscribeTrack still RESOLVES on SUBSCRIBE_OK (refactor regression)', async () => {
    const { client, server, errors } = await connectedPair();
    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };

    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => {} });
    await flush();
    expect(subReqId).toBe(0n); // surfaced to the application as usual
    await server.acceptSubscribe(subReqId, 9n);
    const sub = await subP;
    expect(sub.trackAlias).toBe(9n); // SUBSCRIBE_OK still resolves the promise
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — GOAWAY on the control stream (§10.4)', () => {
  it('server GOAWAY → client DRAINING; onMessage sees it; no client control leak; no session close', async () => {
    const { client, server, a, errors } = await connectedPair();
    const controlA = a.uniOut[0]!.writtenBytes().length;
    const msgs: ControlMessage[] = [];
    client.onMessage = (m) => msgs.push(m);
    let closed = false;
    client.onClose = () => { closed = true; };

    // Server→client GOAWAY. The Request ID refers to the client's (receiver's)
    // request IDs, which are even — so 0 is the correct "nothing processed" value.
    await server.sendGoaway({ newSessionUri: 'https://relay.example/moq', timeout: 5000n, requestId: 0n });
    for (let i = 0; i < 4; i++) await flush();

    expect(client.session.state).toBe(SessionState.DRAINING);
    expect(client.session.newSessionUri).toBe('https://relay.example/moq');
    const g = msgs.find((m) => m.type === 'GOAWAY') as Goaway | undefined;
    expect(g?.newSessionUri).toBe('https://relay.example/moq');
    expect(g?.timeout).toBe(5000n);
    expect(g?.requestId).toBe(0n);
    expect(closed).toBe(false); // §10.4: GOAWAY does NOT auto-close the session
    expect(a.uniOut[0]!.writtenBytes().length).toBe(controlA); // client wrote nothing in response
    expect(errors).toEqual([]);
  });

  it('a second control-stream GOAWAY closes the receiver with PROTOCOL_VIOLATION', async () => {
    const { client, server } = await connectedPair();
    let closeCode = -1;
    client.onClose = (code) => { closeCode = code; };
    await server.sendGoaway({ requestId: 0n });
    await flush();
    await server.sendGoaway({ requestId: 2n }); // duplicate on the control stream
    for (let i = 0; i < 4; i++) await flush();
    expect(closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION)); // 0x3
  });

  // §10.4 sender-side local guards: sendGoaway() must REFUSE to emit an invalid
  // control-stream GOAWAY (the receiver-side rejections are covered in session.test).
  it('sendGoaway without a Request ID throws locally and writes nothing on the control stream', async () => {
    const { server, b } = await connectedPair();
    const before = b.uniOut[0]!.writtenBytes().length;
    await expect(server.sendGoaway({ timeout: 0n })).rejects.toThrow(/Request ID/i);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(before); // no bytes emitted
  });
  it('a client sendGoaway with a non-empty New Session URI throws locally and writes nothing', async () => {
    const { client, a } = await connectedPair();
    const before = a.uniOut[0]!.writtenBytes().length;
    await expect(client.sendGoaway({ newSessionUri: 'https://x', requestId: 1n })).rejects.toThrow(/zero-length New Session URI/i);
    expect(a.uniOut[0]!.writtenBytes().length).toBe(before);
  });
  it('a server sendGoaway with a wrong-parity Request ID (odd) throws locally and writes nothing', async () => {
    const { server, b } = await connectedPair();
    const before = b.uniOut[0]!.writtenBytes().length;
    // server→client must be EVEN; an odd Request ID is wrong.
    await expect(server.sendGoaway({ requestId: 1n })).rejects.toThrow(/parity/i);
    expect(b.uniOut[0]!.writtenBytes().length).toBe(before);
  });

  // §3.3: the control stream MUST stay open for the session lifetime — a peer that
  // tears it down mid-session is a fatal PROTOCOL_VIOLATION (mapped via the adapter).
  it('a peer tearing down the control stream after SETUP closes the receiver with PROTOCOL_VIOLATION', async () => {
    const { client, b } = await connectedPair();
    let closeCode = -1;
    client.onClose = (code) => { closeCode = code; };
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    // The server's control stream is b.uniOut[0]; its readable feeds the client.
    b.uniOut[0]!.reset(); // peer RESETs/closes the control stream mid-session
    for (let i = 0; i < 4; i++) await flush();
    expect(closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION));
    expect(client.session.state).toBe(SessionState.CLOSED);
  });

  it('a control-stream teardown REJECTS a still-pending subscribeTrack() (no hang) and closes PROTOCOL_VIOLATION', async () => {
    const { client, b } = await connectedPair();
    let closeCode = -1;
    client.onClose = (code) => { closeCode = code; };
    // Start a subscribe the server never answers — it stays pending.
    const rejects = expect(client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => {} })).rejects.toThrow();
    await flush();
    b.uniOut[0]!.reset(); // peer tears down the control stream mid-session
    for (let i = 0; i < 4; i++) await flush();
    await rejects; // the pending subscribeTrack rejected — it did NOT hang
    expect(closeCode).toBe(Number(SessionError.PROTOCOL_VIOLATION));
    expect(client.session.state).toBe(SessionState.CLOSED);
  });

  it('a valid post-SETUP GOAWAY still reaches DRAINING (no control-stream violation close)', async () => {
    const { client, server, errors } = await connectedPair();
    let closeCode = -1;
    client.onClose = (code) => { closeCode = code; };
    await server.sendGoaway({ requestId: 0n });
    for (let i = 0; i < 4; i++) await flush();
    expect(client.session.state).toBe(SessionState.DRAINING);
    expect(closeCode).toBe(-1); // GOAWAY is NOT a violation — no close
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — openSubgroup FIRST_OBJECT (§9.4.2)', () => {
  it('openSubgroup({ firstObject: true }) emits FIRST_OBJECT and the peer decodes + delivers the object', async () => {
    const { client, server, b, errors } = await connectedPair();
    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };
    const recv: MoqtObject[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flush();
    await server.acceptSubscribe(subReqId, 9n);
    await subP;

    const sid = await server.openSubgroup(9n, 7n, 0n, { publisherPriority: 3, firstObject: true });
    await server.sendObject(sid, 0n, new Uint8Array([0xaa]));
    await server.closeSubgroup(sid);
    await flush();

    // The server's emitted subgroup header (b.uniOut[0] = control, [1] = this data stream).
    const { header } = decodeSubgroupHeader18(b.uniOut[1]!.writtenBytes(), 0);
    expect(header.isFirstObjectInSubgroup).toBe(true);
    // The peer decoded the FIRST_OBJECT header and delivered the object.
    expect(recv.length).toBe(1);
    expect(recv[0]!.trackAlias).toBe(9n);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — onSubscribeClosed (§3.3.2 unsubscribe)', () => {
  it('fires onSubscribeClosed when the subscriber resets its SUBSCRIBE stream; cleans state, no error/close', async () => {
    const { client, server, errors } = await connectedPair();

    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };
    let closedReqId = -1n;
    server.onSubscribeClosed = (rid) => { closedReqId = rid; };
    let serverClosed = false;
    server.onClose = () => { serverClosed = true; };

    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => {} });
    await flush();
    await server.acceptSubscribe(subReqId, 9n);
    const sub = await subP;
    expect(server.session.getIncomingSubscription(subReqId)).toBeDefined();

    // draft-18 unsubscribe = reset the SUBSCRIBE request stream.
    await sub.unsubscribe();
    for (let i = 0; i < 4; i++) await flush();

    expect(closedReqId).toBe(subReqId);                                   // publisher notified of THIS subscription
    expect(server.session.getIncomingSubscription(subReqId)).toBeUndefined(); // session state cleaned
    expect(serverClosed).toBe(false);                                     // connection stays open
    expect(errors).toEqual([]);                                           // not surfaced as an error
  });
});
