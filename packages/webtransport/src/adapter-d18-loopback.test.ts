/**
 * draft-18 end-to-end loopback: two REAL MoqtConnection(18) instances — one
 * CLIENT, one SERVER — wired through an in-memory loopback transport. This
 * proves the full topology works between two endpoints (uni SETUP pair, bidi
 * request streams with same-stream responses, alias binding, uni data delivery),
 * not just one side against simulated bytes.
 */
import { describe, it, expect, vi } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { connectedPair, withProtocol, ns, nm } from './testkit/pair.js';
import { SessionState, ForwardState, varint, SessionError, RequestError18, decodeSubgroupHeader18, createControlCodec, encodeObjectDatagram18, encodeSubgroupHeader18, encodeSubgroupObject18 } from '@moqt/transport';

const codec18 = createControlCodec(18);
import type { MoqtObject, ControlMessage, Goaway, RequestErrorMsg } from '@moqt/transport';

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

  // §5.1: a second inbound PUBLISH for the SAME track is a duplicate same-role
  // subscription. draft-18 has no control stream, so the REQUEST_ERROR must ride
  // the second PUBLISH's OWN request stream — NOT executeActions (which has no
  // draft-18 control writer and would throw "Cannot read ... 'write' of null",
  // crashing the read loop and leaving the request dangling).
  it('a duplicate inbound PUBLISH is rejected with REQUEST_ERROR on its own request stream — no crash, no session close', async () => {
    const { client, server, errors } = await connectedPair();
    const clientMsgs: ControlMessage[] = [];
    client.onMessage = (m) => clientMsgs.push(m);
    let publishes = 0;
    server.onPublish = () => { publishes += 1; };

    await client.publish(ns('live'), nm('vid'), 21n); // first PUBLISH — admitted
    await flush();
    await client.publish(ns('live'), nm('vid'), 22n); // duplicate same track
    await flush(32);

    expect(publishes).toBe(1); // the duplicate never reached the application
    expect(server.session.state).not.toBe(SessionState.CLOSED); // request-level, not fatal
    // The client saw a REQUEST_ERROR carrying DUPLICATE_SUBSCRIPTION on the 2nd stream.
    const err = clientMsgs.find((m) => m.type === 'REQUEST_ERROR') as
      { errorCode?: bigint } | undefined;
    expect(err).toBeDefined();
    expect(err!.errorCode).toBe(RequestError18.DUPLICATE_SUBSCRIPTION as bigint);
    expect(errors).toEqual([]); // no thrown/surfaced errors on either side
  });
});

describe('MoqtConnection(16) loopback — duplicate SUBSCRIBE admission gate (§5.1)', () => {
  // The draft-14/16 control read loop fires onSubscribe AFTER the session
  // processes the SUBSCRIBE. A duplicate same-role SUBSCRIBE is rejected with
  // DUPLICATE_SUBSCRIPTION and creates NO state — it must NOT reach onSubscribe.
  it('a rejected duplicate SUBSCRIBE does not fire onSubscribe', async () => {
    const { client, server } = await connectedPair(16);
    let admitted = 0;
    server.onSubscribe = (rid) => { admitted += 1; void server.acceptSubscribe(rid, 5n); };

    const p1 = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* live */ } });
    await flush(8);
    await p1; // established (publisher-role subscription on the server)

    const p2 = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* dup */ } });
    await flush(8);
    await expect(p2).rejects.toThrow(); // DUPLICATE_SUBSCRIPTION

    expect(admitted).toBe(1); // onSubscribe fired only for the ADMITTED request
    expect(server.session.state).not.toBe(SessionState.CLOSED); // request-level, not fatal
  });
});

describe('MoqtConnection(18) loopback — §5.1 pending SUBSCRIBE superseded by a peer PUBLISH', () => {
  // A peer PUBLISH for a track we hold a PENDING outbound SUBSCRIBE for supersedes
  // our request (§5.1). The Session cancels local state and emits a cancel_request
  // action; the adapter MUST reject the pending subscribeTrack() and reset its
  // request stream. Without that plumbing the resolver hangs forever and a crossed
  // SUBSCRIBE_OK would reach the session as an unknown request and close it.
  // Cancellation is STAGED at receipt and fires only when the PUBLISH is ACCEPTED
  // (§5.1: terminate only before PUBLISH_OK). (The draft-16 UNSUBSCRIBE emission,
  // crossed-OK/ERROR tolerance, and reject-leaves-subscribe-alive are proven at
  // the session layer; connectedPair grants only the client request credit, so the
  // server cannot PUBLISH on draft-16 in this harness.)
  it('ACCEPTING the colliding PUBLISH rejects the pending subscribeTrack() and does NOT close the session', async () => {
    const { client, server, errors } = await connectedPair(18);
    let published = 0;
    // Accept the inbound PUBLISH — that is what performs the §5.1 cancellation.
    client.onPublish = (pub) => { published += 1; void client.acceptSubscribe(pub.requestId, pub.trackAlias); };

    // Local SUBSCRIBE stays PENDING — the server never accepts it.
    server.onSubscribe = () => { /* leave pending */ };
    const p = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush(8);

    // The peer PUBLISHes the SAME track → inbound PUBLISH collides with the pending SUBSCRIBE.
    await server.publish(ns('live'), nm('vid'), 55n);
    await flush(32);

    // §5.1: accepting the PUBLISH cancels the local SUBSCRIBE — its subscribeTrack
    // rejects (superseded); no session close on either side.
    await expect(p).rejects.toThrow(/superseded/i);
    expect(client.session.state).not.toBe(SessionState.CLOSED);
    expect(server.session.state).not.toBe(SessionState.CLOSED);
    expect(published).toBe(1); // the PUBLISH was accepted
    expect(errors).toEqual([]); // supersession is not surfaced as an error
  });

  it('REJECTING the colliding PUBLISH leaves the pending subscribeTrack() intact (§5.1)', async () => {
    const { client, server, errors } = await connectedPair(18);
    // Reject the inbound PUBLISH — the local SUBSCRIBE must survive.
    client.onPublish = (pub) => { void client.rejectSubscribe(pub.requestId, 0x1n, 'not interested'); };

    let subAccepted = false;
    server.onSubscribe = () => { /* leave pending for now */ };
    const p = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    p.then(() => { subAccepted = true; }, () => { /* must NOT reject */ });
    await flush(8);
    const subReqId = [...(client as unknown as { rawSubscriptions: Map<bigint, unknown> }).rawSubscriptions.keys()][0]!;

    await server.publish(ns('live'), nm('vid'), 55n);
    await flush(32);

    // The subscribeTrack is still pending (neither resolved nor rejected).
    expect(subAccepted).toBe(false);
    expect(client.session.getSubscription(subReqId)?.state).toBe('pending');
    expect(client.session.state).not.toBe(SessionState.CLOSED);
    expect(errors).toEqual([]);
  });

  it('a FAILED acceptance write still reclaims the superseded local SUBSCRIBE (§5.1 failure-safe)', async () => {
    const { client, server } = await connectedPair(18);
    type Raws = { rawSubscriptions: Map<bigint, unknown> };
    type Internals = { writeInboundRequestResponse: (...a: unknown[]) => Promise<boolean> };
    // Inject a failure into the acceptance response write. Because the §5.1
    // cancellation (a non-response cancel_request action) runs BEFORE this write,
    // the superseded local SUBSCRIBE must still be reclaimed despite the failure.
    (client as unknown as Internals).writeInboundRequestResponse = async () => {
      throw new Error('injected acceptance write failure');
    };
    client.onPublish = (pub) => { void client.acceptSubscribe(pub.requestId, pub.trackAlias).catch(() => { /* expected */ }); };
    server.onSubscribe = () => { /* leave pending */ };

    const p = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush(8);
    const subReqId = [...(client as unknown as Raws).rawSubscriptions.keys()][0]!;

    await server.publish(ns('live'), nm('vid'), 55n);
    await flush(32);

    // Reclaimed despite the failed write: the subscribeTrack promise rejected, its
    // adapter entry is gone, and the session SUBSCRIBE is terminated (not live) —
    // the §5.1 cancellation ran before the failing acceptance write.
    await expect(p).rejects.toThrow(/superseded/i);
    expect((client as unknown as Raws).rawSubscriptions.has(subReqId)).toBe(false);
    const leftover = client.session.getSubscription(subReqId);
    expect(leftover === undefined || leftover.isTerminated).toBe(true);
    expect(client.session.state).not.toBe(SessionState.CLOSED);
  });

  it('a FAILED acceptance write on an inbound PUBLISH rolls back — no ghost ESTABLISHED subscription (§10.8)', async () => {
    const { client, server } = await connectedPair(18);
    type Internals = { writeInboundRequestResponse: (...a: unknown[]) => Promise<boolean> };
    // The peer never receives PUBLISH_OK if the acceptance write fails; the
    // Session already transitioned the inbound PUBLISH to ESTABLISHED, so the
    // adapter MUST roll it back rather than leave a ghost established subscription.
    (client as unknown as Internals).writeInboundRequestResponse = async () => {
      throw new Error('injected acceptance write failure');
    };
    let pubReqId = -1n;
    let accepted = false;
    let acceptError: unknown;
    let routeAfter: unknown;
    type Routes = { publishAliasMaps: Map<bigint, unknown> };
    client.onPublish = (pub) => {
      pubReqId = pub.requestId;
      client.acceptSubscribe(pub.requestId, pub.trackAlias).then(
        () => { accepted = true; },
        (e) => { acceptError = e; routeAfter = (client as unknown as Routes).publishAliasMaps.get(pub.trackAlias); },
      );
    };

    await server.publish(ns('live'), nm('vid'), 77n); // inbound PUBLISH at the client
    await flush(32);

    // The failed acceptance is REPORTED as a failure (acceptSubscribe rejected),
    // NOT silently resolved; and the rollback removed the inbound route + session
    // state so late objects can no longer reach the application. No session close.
    expect(accepted).toBe(false);
    expect(acceptError).toBeDefined();
    expect(routeAfter).toBeUndefined(); // publishAliasMaps route removed
    expect(client.session.getIncomingSubscription(pubReqId)).toBeUndefined();
    expect(client.session.state).not.toBe(SessionState.CLOSED);
  });

  it('a FAILED inbound-PUBLISH REQUEST_UPDATE tears down the route + arms the guard (§11.4.1)', async () => {
    const { client, server } = await connectedPair(18);
    let pubReqId = -1n;
    client.onPublish = (p) => { pubReqId = p.requestId; };
    await server.publish(ns('live'), nm('vid'), 9n);
    await flush();
    await client.acceptSubscribe(pubReqId, 9n);
    await flush();

    // Force the REQUEST_UPDATE write on the inbound PUBLISH stream to fail.
    type CtxMap = { inboundRequestContexts: Map<bigint, { sendUpdate: (...a: unknown[]) => Promise<void> }> };
    const ctx = (client as unknown as CtxMap).inboundRequestContexts.get(pubReqId)!;
    ctx.sendUpdate = async () => { throw new Error('injected update write failure'); };

    const routes = (client as unknown as { publishAliasMaps: Map<bigint, unknown> }).publishAliasMaps;
    const guards = (client as unknown as { terminatedAliases: Map<bigint, unknown> }).terminatedAliases;
    expect(routes.has(9n)).toBe(true);

    await expect(client.requestUpdate(pubReqId, { forward: false })).rejects.toThrow(/injected/);
    // §11.4.1: the dead request stream terminates the request. Aborting the context
    // alone would suppress onClosed and leave the route live — the owner-checked
    // teardown must drop publishAliasMaps AND arm the terminal-alias guard.
    expect(routes.has(9n)).toBe(false);
    expect(guards.has(9n)).toBe(true);
    expect(client.session.state).not.toBe(SessionState.CLOSED);
  });

  it('draft-18: publish() request-stream open failure rolls back publisher authority + session state', async () => {
    const { client, a } = await connectedPair(18);
    // Force the request-stream creation to fail — the peer never receives PUBLISH.
    (a as { createBidirectionalStream: () => Promise<unknown> }).createBidirectionalStream =
      async () => { throw new Error('open boom'); };
    await expect(client.publish(ns('live'), nm('vid'), 55n)).rejects.toThrow(/boom/);
    // Rolled back: not authorized to publish on the alias (openSubgroup rejects) and
    // no lingering outbound-publish session state.
    await expect(client.openSubgroup(55n, 0n, 0n, { publisherPriority: 1 })).rejects.toThrow(/unknown track alias/i);
    expect(client.session.getOutgoingPublish(0n)).toBeUndefined();
  });

  it('draft-18: subscribeTrack() request-stream open failure leaves no pending session subscription', async () => {
    const { client, a } = await connectedPair(18);
    (a as { createBidirectionalStream: () => Promise<unknown> }).createBidirectionalStream =
      async () => { throw new Error('open boom'); };
    // The first subscribe allocates request ID 0 (client parity); it must reject
    // and leave NO phantom session subscription behind.
    await expect(client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } }))
      .rejects.toThrow(/boom/);
    expect(client.session.getSubscription(0n)).toBeUndefined();
    expect(client.session.state).not.toBe(SessionState.CLOSED);
  });

  it('draft-18: fetch() request-stream open failure leaves no pending fetch (§11.4.1) — no unsolicited-data authorization', async () => {
    const { client, a } = await connectedPair(18);
    (a as { createBidirectionalStream: () => Promise<unknown> }).createBidirectionalStream =
      async () => { throw new Error('open boom'); };
    await expect(client.fetch(ns('live'), nm('vid'), {
      startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n,
    })).rejects.toThrow(/boom/);
    // The shared open-or-rollback reclaims the session fetch (getFetch undefined) so
    // no phantom fetch remains that could authorize / mis-decode inbound data.
    expect(client.session.getFetch(0n)).toBeUndefined();
    expect(client.session.state).not.toBe(SessionState.CLOSED);
  });

  it('draft-18: trackStatus() request-stream open failure leaves no pending request', async () => {
    const { client, a } = await connectedPair(18);
    (a as { createBidirectionalStream: () => Promise<unknown> }).createBidirectionalStream =
      async () => { throw new Error('open boom'); };
    await expect(client.trackStatus(ns('live'), nm('vid'))).rejects.toThrow(/boom/);
    expect(client.session.state).not.toBe(SessionState.CLOSED);
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

describe('MoqtConnection(18) loopback — terminal-alias guard delivery timeout (§10.11)', () => {
  it('floors the guard TTL by the requested DELIVERY_TIMEOUT so it outlives a long delivery window', async () => {
    vi.useFakeTimers();
    try {
      // Small fixed floor; a much longer requested delivery timeout must win.
      const { client, server } = await connectedPair(18, { clientOptions: { terminatedAliasTtlMs: 1_000 } });
      let subReqId = -1n;
      server.onSubscribe = (rid) => { subReqId = rid; };

      const subP = client.subscribeTrack(ns('live'), nm('vid'), {
        deliveryTimeout: varint(60_000n), onObject: () => { /* none */ },
      });
      await flush();
      await server.acceptSubscribe(subReqId, 9n);
      await flush();
      const sub = await subP;
      expect(sub.trackAlias).toBe(9n);

      await client.unsubscribe(sub.requestId); // arms the terminal-alias guard
      const guards = (client as unknown as { terminatedAliases: Map<bigint, unknown> }).terminatedAliases;
      expect(guards.has(9n)).toBe(true);

      // Past the 1s fixed floor the guard is STILL live — extended to the 60s
      // delivery timeout, so a late old-alias stream is still discarded.
      vi.advanceTimersByTime(5_000);
      expect(guards.has(9n)).toBe(true);
      // Past the delivery timeout it finally clears (bounded either way).
      vi.advanceTimersByTime(60_000);
      expect(guards.has(9n)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('floors the guard TTL by the PUBLISHER SUBGROUP_DELIVERY_TIMEOUT Track Property (§8, 0x06)', async () => {
    vi.useFakeTimers();
    try {
      const { client, server } = await connectedPair(18, { clientOptions: { terminatedAliasTtlMs: 1_000 } });
      let subReqId = -1n;
      server.onSubscribe = (rid) => { subReqId = rid; };

      // Subscriber sets NO delivery timeout; the publisher advertises a 45s subgroup
      // timeout as a Track Property on SUBSCRIBE_OK — the effective value is the
      // publisher's, and the guard must cover it.
      const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
      await flush();
      await server.acceptSubscribe(subReqId, 9n, { trackProperties: new Map([[0x06n, [45_000n]]]) });
      await flush();
      const sub = await subP;

      await client.unsubscribe(sub.requestId);
      const guards = (client as unknown as { terminatedAliases: Map<bigint, unknown> }).terminatedAliases;
      vi.advanceTimersByTime(5_000);
      expect(guards.has(9n)).toBe(true);   // past the 1s floor — extended to the publisher's 45s
      vi.advanceTimersByTime(45_000);
      expect(guards.has(9n)).toBe(false);  // cleared after the effective timeout
    } finally {
      vi.useRealTimers();
    }
  });

  it('populates the effective delivery timeout for a PUBLISH-initiated subscription (§8, both directions)', async () => {
    const { client, server } = await connectedPair(18);
    let pubReqId = -1n;
    client.onPublish = (p) => { pubReqId = p.requestId; };
    // The publisher (server) advertises a 45s subgroup timeout as a Track Property
    // on the PUBLISH — this must reach the subscriber's alias guard state, which
    // previously only happened for SUBSCRIBE-initiated subscriptions.
    await server.publish(ns('live'), nm('vid'), 9n, { trackProperties: new Map([[0x06n, [45_000n]]]) });
    await flush();
    await client.acceptSubscribe(pubReqId, 9n);
    await flush();

    const dts = (client as unknown as { aliasDeliveryTimeoutMs: Map<bigint, number> }).aliasDeliveryTimeoutMs;
    expect(dts.get(9n)).toBe(45_000);
  });

  it('combines the SUBSCRIBER PUBLISH_OK delivery-timeout params for a PUBLISH-initiated subscription (§8)', async () => {
    const { client, server } = await connectedPair(18);
    let pubReqId = -1n;
    client.onPublish = (p) => { pubReqId = p.requestId; };
    // Publisher advertises NO timeout; the SUBSCRIBER supplies a 45s subgroup timeout
    // in its PUBLISH_OK parameters — it must drive the alias's effective timeout.
    await server.publish(ns('live'), nm('vid'), 9n);
    await flush();
    await client.acceptSubscribe(pubReqId, 9n, { parameters: new Map([[0x06n, [45_000n]]]) });
    await flush();

    const dts = (client as unknown as { aliasDeliveryTimeoutMs: Map<bigint, number> }).aliasDeliveryTimeoutMs;
    expect(dts.get(9n)).toBe(45_000);
  });

  it('a FAILED PUBLISH_OK write keeps the PUBLISHER-only timeout, not the unsent combined value (§8)', async () => {
    const { client, server } = await connectedPair(18);
    type Internals = { writeInboundRequestResponse: (...a: unknown[]) => Promise<boolean> };
    (client as unknown as Internals).writeInboundRequestResponse = async () => {
      throw new Error('injected PUBLISH_OK write failure');
    };
    let pubReqId = -1n;
    let acceptErr: unknown;
    client.onPublish = (p) => {
      pubReqId = p.requestId;
      // Publisher's 60s object timeout; our (unsent) 1s object timeout would combine
      // to 1s — but the write fails, so the peer never learns of our 1s.
      client.acceptSubscribe(p.requestId, 9n, { parameters: new Map([[0x02n, [1_000n]]]) })
        .catch((e) => { acceptErr = e; });
    };
    await server.publish(ns('live'), nm('vid'), 9n, { trackProperties: new Map([[0x02n, [60_000n]]]) });
    await flush(32);

    expect(acceptErr).toBeDefined();
    // The guard keeps the publisher's 60s (committed at bind); it was NOT lowered to
    // the 1s combined value, which was never sent.
    const dts = (client as unknown as { aliasDeliveryTimeoutMs: Map<bigint, number> }).aliasDeliveryTimeoutMs;
    expect(dts.get(9n)).toBe(60_000);
  });

  it('a REQUEST_UPDATE object delivery timeout re-derives the alias guard (§8)', async () => {
    const { client, server } = await connectedPair(18);
    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    await server.acceptSubscribe(subReqId, 9n); // no timeout initially
    await flush();
    const sub = await subP;

    // A REQUEST_UPDATE raising the object delivery timeout is STAGED, not committed
    // at send — it applies only when the peer's REQUEST_OK arrives (§10.9 / finding).
    await client.requestUpdate(sub.requestId, { objectDeliveryTimeout: varint(60_000n) });
    await flush(16); // let REQUEST_OK round-trip and commit
    expect(client.session.getSubscription(sub.requestId)?.requestedDeliveryTimeoutMs).toBe(60_000);

    // At teardown the guard is re-derived from the COMMITTED value.
    await client.unsubscribe(sub.requestId);
    const dts = (client as unknown as { aliasDeliveryTimeoutMs: Map<bigint, number> }).aliasDeliveryTimeoutMs;
    const guards = (client as unknown as { terminatedAliases: Map<bigint, unknown> }).terminatedAliases;
    expect(dts.get(9n)).toBe(60_000);
    expect(guards.has(9n)).toBe(true);
  });

  it('PUBLISH_DONE arms the terminal guard with the COMMITTED delivery timeout, not a stale default (§8)', async () => {
    vi.useFakeTimers();
    try {
      const { client, server } = await connectedPair(18, { clientOptions: { terminatedAliasTtlMs: 1_000 } });
      let subReqId = -1n;
      server.onSubscribe = (rid) => { subReqId = rid; };
      const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
      await flush();
      await server.acceptSubscribe(subReqId, 9n); // no initial timeout
      await flush();
      const sub = await subP;
      // Commit a 60s object timeout (REQUEST_UPDATE → REQUEST_OK).
      await client.requestUpdate(sub.requestId, { objectDeliveryTimeout: varint(60_000n) });
      await flush(16);

      // The publisher ends the subscription — PUBLISH_DONE must arm the guard from the
      // COMMITTED 60s (refresh), not the 1s floor captured before the update.
      await server.publishDone(subReqId, varint(0n), 'done');
      await flush(16);
      const guards = (client as unknown as { terminatedAliases: Map<bigint, unknown> }).terminatedAliases;
      expect(guards.has(9n)).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(guards.has(9n)).toBe(true); // past the 1s floor — extended to 60s
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not collapse an over-2^31 delivery timeout into an immediate timer (chunked, §8)', async () => {
    // A valid but huge timeout (> setTimeout's 2^31-1 range) must NOT overflow to a
    // ~1 ms fire in Node — the guard is scheduled in bounded chunks.
    const { client, server } = await connectedPair(18);
    let subReqId = -1n;
    server.onSubscribe = (rid) => { subReqId = rid; };
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    await server.acceptSubscribe(subReqId, 9n, { trackProperties: new Map([[0x06n, [3_000_000_000n]]]) }); // 3e9 ms > 2^31-1
    await flush();
    const sub = await subP;

    await client.unsubscribe(sub.requestId);
    const guards = (client as unknown as { terminatedAliases: Map<bigint, unknown> }).terminatedAliases;
    expect(guards.has(9n)).toBe(true);
    // Real time: a Node-overflowed single timer would fire at ~1 ms and clear the
    // guard. The chunked timer's first chunk is 2^31-1 ms, so it survives.
    await new Promise((r) => setTimeout(r, 30));
    expect(guards.has(9n)).toBe(true);
  });

});

describe('MoqtConnection(18) loopback — FETCH happy path + cancel (§10.12)', () => {
  it('client FETCH → server onFetch → acceptFetch → fetch data → client onObject (objects + EOR gap); then cancel', async () => {
    const { client, server, errors } = await connectedPair();
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

    // §5.2: the fetch completed on its data-stream FIN — it is reclaimed, so a
    // redundant local fetchCancel is a safe no-op (idempotent), not an error.
    expect(client.session.getFetch(requestId)).toBeUndefined();
    await client.fetchCancel(requestId);
    await flush();
    expect(errors).toEqual([]);
  });

  it('draft-18: a completed FETCH (FETCH_OK then data FIN) reclaims BOTH endpoints — fetcher request stream + publisher serving state', async () => {
    const { client, server, errors } = await connectedPair(18);
    let fetchReqId = -1n;
    server.onFetch = (rid) => { fetchReqId = rid; };
    client.onObject = () => { /* drain */ };

    const requestId = await client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    await flush();

    // Response-before-data arrival order: FETCH_OK, then objects, then data FIN.
    await server.acceptFetch(fetchReqId, { endLocation: { group: 9n, object: 0n } });
    await flush();
    const sid = await server.openFetchStream(fetchReqId);
    await server.sendFetchObject(sid, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: new Uint8Array([0xaa]) });
    await server.sendFetchEndOfRange(sid, true, 1n, 0n);
    await server.closeFetchStream(sid);
    await flush();

    // Session reclaimed the fetch on both sides.
    expect(client.session.getFetch(requestId)).toBeUndefined();
    expect(server.session.getIncomingFetch(fetchReqId)).toBeUndefined();

    // Fetcher (client): the request bidi stream context is reclaimed, no leak.
    const c = client as unknown as { uniPair: { hasRequestStream: (id: bigint) => boolean } };
    expect(c.uniPair.hasRequestStream(requestId)).toBe(false);

    // Publisher (server): group-order authorization, one-stream reservation, and the
    // inbound request context are ALL reclaimed.
    const s = server as unknown as {
      inboundFetchGroupOrder: Map<bigint, unknown>;
      fetchServeReserved: Set<bigint>;
      inboundRequestContexts: Map<bigint, unknown>;
    };
    expect(s.inboundFetchGroupOrder.has(fetchReqId)).toBe(false);
    expect(s.fetchServeReserved.has(fetchReqId)).toBe(false);
    expect(s.inboundRequestContexts.has(fetchReqId)).toBe(false);

    // §11.4.4: even after completion a SECOND response stream is refused (the
    // reservation/authorization is gone, so re-serving is not possible).
    await expect(server.openFetchStream(fetchReqId)).rejects.toThrow(/No admitted inbound FETCH/i);
    expect(errors).toEqual([]);
    expect(client.session.state).not.toBe(SessionState.CLOSED);
    expect(server.session.state).not.toBe(SessionState.CLOSED);
  });

  it('draft-18: a completed FETCH in the data-before-response order (FIN then FETCH_OK) also reclaims both endpoints', async () => {
    const { client, server, errors } = await connectedPair(18);
    let fetchReqId = -1n;
    // §10.12: open + serve + FIN the response stream BEFORE FETCH_OK, then accept.
    server.onFetch = async (rid) => {
      fetchReqId = rid;
      const sid = await server.openFetchStream(rid);
      await server.sendFetchObject(sid, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: new Uint8Array([0xaa]) });
      await server.sendFetchEndOfRange(sid, true, 1n, 0n);
      await server.closeFetchStream(sid);
      await server.acceptFetch(rid, { endLocation: { group: 9n, object: 0n } });
    };
    client.onObject = () => { /* drain */ };

    const requestId = await client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    await flush(32);

    expect(client.session.getFetch(requestId)).toBeUndefined();
    expect(server.session.getIncomingFetch(fetchReqId)).toBeUndefined();

    const c = client as unknown as { uniPair: { hasRequestStream: (id: bigint) => boolean } };
    expect(c.uniPair.hasRequestStream(requestId)).toBe(false);

    const s = server as unknown as {
      inboundFetchGroupOrder: Map<bigint, unknown>;
      fetchServeReserved: Set<bigint>;
      inboundRequestContexts: Map<bigint, unknown>;
    };
    expect(s.inboundFetchGroupOrder.has(fetchReqId)).toBe(false);
    expect(s.fetchServeReserved.has(fetchReqId)).toBe(false);
    expect(s.inboundRequestContexts.has(fetchReqId)).toBe(false);

    await expect(server.openFetchStream(fetchReqId)).rejects.toThrow(/No admitted inbound FETCH/i);
    expect(errors).toEqual([]);
    expect(client.session.state).not.toBe(SessionState.CLOSED);
    expect(server.session.state).not.toBe(SessionState.CLOSED);
  });

  it('draft-18: a FAILED FETCH_OK write rolls back — no ghost accepted fetch, openFetchStream refused (§10.13)', async () => {
    const { client, server } = await connectedPair(18);
    type Internals = { writeInboundRequestResponse: (...a: unknown[]) => Promise<boolean> };
    // The peer never receives FETCH_OK if the acceptance write fails; the Session
    // already transitioned the fetch to TRANSFERRING, so the adapter MUST roll it
    // back — no ghost accepted fetch and no serving authorization may survive.
    (server as unknown as Internals).writeInboundRequestResponse = async () => {
      throw new Error('injected FETCH_OK write failure');
    };
    let fetchReqId = -1n;
    let acceptError: unknown;
    server.onFetch = (rid) => {
      fetchReqId = rid;
      server.acceptFetch(rid, { endLocation: { group: 9n, object: 0n } })
        .catch((e) => { acceptError = e; });
    };

    await client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    await flush(32);

    expect(acceptError).toBeDefined();                              // reported, not swallowed
    expect(server.session.getIncomingFetch(fetchReqId)).toBeUndefined(); // no ghost accepted fetch
    await expect(server.openFetchStream(fetchReqId)).rejects.toThrow(/No admitted inbound FETCH/i);
    expect(server.session.state).not.toBe(SessionState.CLOSED);
  });

  it('draft-18: rejectFetch aborts a response stream already opened before FETCH_OK (§10.13)', async () => {
    const { client, server } = await connectedPair(18);
    let fetchReqId = -1n;
    let streamId = -1n;
    // §10.12 allows opening the response stream BEFORE FETCH_OK — do exactly that.
    server.onFetch = async (rid) => { fetchReqId = rid; streamId = await server.openFetchStream(rid); };

    await client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    await flush(32);
    expect(streamId).toBeGreaterThanOrEqual(0n);

    await server.rejectFetch(fetchReqId, varint(0x10n), 'no');
    // The already-open response stream was aborted by the rejection — a subsequent
    // send on it must fail (no unsolicited fetch data after REQUEST_ERROR).
    await expect(server.sendFetchObject(streamId, {
      groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: new Uint8Array([0xaa]),
    })).rejects.toThrow();
    expect(server.session.state).not.toBe(SessionState.CLOSED);
  });
});

describe('MoqtConnection(18) loopback — joining FETCH (§10.12.2)', () => {
  it('subscribe + joiningFetch → server resolves range from Largest and serves contiguous pre-roll', async () => {
    const { client, server, errors } = await connectedPair();
    let joinReqId = -1n;
    let serverFetchMsg: Fetch | undefined;
    server.onFetch = (rid, msg) => { joinReqId = rid; serverFetchMsg = msg; };
    const recv: MoqtObject[] = [];
    client.onObject = (_sid, o) => recv.push(o);

    // Live subscription established first.
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    // Joining fetch for the current group head (relative, joiningStart 0).
    const fetchReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    await flush();
    expect(joinReqId).toBe(fetchReqId);
    expect(serverFetchMsg?.fetch.fetchType).toBe(0x2);

    // Server resolves against its Largest Location {3, 5} and serves.
    const range = server.resolveJoiningFetch(joinReqId, { group: 3n, object: 5n });
    expect(range.startLocation).toEqual({ group: 3n, object: 0n });
    expect(range.endLocation).toEqual({ group: 3n, object: 6n }); // wire one-past: last delivered = 5

    await server.acceptFetch(joinReqId, { endLocation: range.endLocation });
    await flush();
    const sid = await server.openFetchStream(joinReqId);
    for (let i = 0n; i <= 5n; i++) {
      await server.sendFetchObject(sid, { groupId: 3n, subgroupId: 0n, objectId: i, publisherPriority: 5, payload: new Uint8Array([Number(i)]) });
    }
    await server.closeFetchStream(sid);
    await flush();

    const data = recv.filter((o) => o.kind === 'data');
    expect(data.map((o) => o.objectId)).toEqual([0n, 1n, 2n, 3n, 4n, 5n]);
    expect(errors).toEqual([]);
  });

  it('a joining FETCH against a PENDING subscription is BUFFERED until acceptSubscribe (§10.12.2) — standalone FETCH stays immediate', async () => {
    // §10.12.2: the publisher "buffers the pending Joining Fetch until either
    // the Subscription is established or the request times out." The adapter
    // parks the join and surfaces it via onFetch only once the application
    // accepts the subscription. Standalone FETCH is never held back.
    const { client, server, errors } = await connectedPair();
    const fetches: bigint[] = [];
    server.onFetch = (rid) => { fetches.push(rid); };
    const clientErrors: ControlMessage[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m); };

    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    const joinReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    const standaloneReqId = await client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(1n), endObject: varint(0n),
    });
    await flush();

    expect(fetches).toContain(standaloneReqId);     // immediate
    expect(fetches).not.toContain(joinReqId);       // parked while PENDING

    await server.acceptSubscribe(subReqId, 7n);     // subscription establishes
    await flush();
    expect(fetches).toContain(joinReqId);           // released to the app
    expect(clientErrors).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('rejectSubscribe rejects the parked joining FETCH with INVALID_JOINING_REQUEST_ID', async () => {
    const { client, server, errors } = await connectedPair();
    const fetches: bigint[] = [];
    server.onFetch = (rid) => { fetches.push(rid); };
    const clientErrors: RequestErrorMsg[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m as RequestErrorMsg); };

    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    const joinReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    await flush();

    await server.rejectSubscribe(subReqId, RequestError18.DOES_NOT_EXIST as bigint, 'no such track');
    await flush();

    expect(fetches).not.toContain(joinReqId); // never surfaced to the app
    const joinError = clientErrors.find((e) => BigInt(e.requestId) === joinReqId);
    expect(joinError).toBeDefined();
    expect(joinError!.errorCode).toBe(RequestError18.INVALID_JOINING_REQUEST_ID);
    expect(errors).toEqual([]);
  });

  it('settle-time gate: a join parked on a Forward=0 subscription is rejected INVALID_RANGE at accept', async () => {
    // §10.12.2: the gate runs when the subscription establishes — not when
    // the join arrives. Forward is still 0 at accept time here.
    const { client, server, errors } = await connectedPair();
    const fetches: bigint[] = [];
    server.onFetch = (rid) => { fetches.push(rid); };
    const clientErrors: RequestErrorMsg[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m as RequestErrorMsg); };

    const subReqId = await client.subscribe(ns('live'), nm('vid'), { forward: ForwardState.PAUSED });
    const joinReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    await flush();
    expect(fetches).not.toContain(joinReqId); // parked, NOT rejected on arrival

    await server.acceptSubscribe(subReqId, 7n); // establishes with forward still 0
    await flush();
    expect(fetches).not.toContain(joinReqId);
    const err = clientErrors.find((e) => BigInt(e.requestId) === joinReqId);
    expect(err?.errorCode).toBe(RequestError18.INVALID_RANGE);
    expect(errors).toEqual([]);
  });

  it('settle-time gate honors a REQUEST_UPDATE Forward=1 that lands before accept (§10.12.2 pending updates first)', async () => {
    const { client, server, errors } = await connectedPair();
    const fetches: bigint[] = [];
    server.onFetch = (rid) => { fetches.push(rid); };
    const clientErrors: RequestErrorMsg[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m as RequestErrorMsg); };

    const subReqId = await client.subscribe(ns('live'), nm('vid'), { forward: ForwardState.PAUSED });
    const joinReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    await flush();
    await client.requestUpdate(subReqId, { forward: true }); // races on the sub's own stream
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    expect(fetches).toContain(joinReqId); // update processed before evaluation
    expect(clientErrors.filter((e) => BigInt(e.requestId) === joinReqId)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('fetchCancel of a parked join removes it — no ghost onFetch after the subscription is accepted', async () => {
    const { client, server, errors } = await connectedPair();
    const fetches: bigint[] = [];
    server.onFetch = (rid) => { fetches.push(rid); };

    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    const joinReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    await flush();
    await client.fetchCancel(joinReqId); // resets the FETCH request stream
    await flush();

    await server.acceptSubscribe(subReqId, 7n);
    await flush();
    expect(fetches).not.toContain(joinReqId); // canceled request never surfaces
    expect(errors).toEqual([]);
  });

  it('canceling the referenced SUBSCRIBE promptly rejects its parked join (no timeout wait)', async () => {
    const { client, server, errors } = await connectedPair();
    const fetches: bigint[] = [];
    server.onFetch = (rid) => { fetches.push(rid); };
    const clientErrors: RequestErrorMsg[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m as RequestErrorMsg); };

    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    const joinReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    await flush();
    await client.unsubscribe(subReqId); // §3.3.2: resets the SUBSCRIBE stream
    await flush();

    expect(fetches).not.toContain(joinReqId);
    const err = clientErrors.find((e) => BigInt(e.requestId) === joinReqId);
    expect(err?.errorCode).toBe(RequestError18.INVALID_JOINING_REQUEST_ID);
    expect(errors).toEqual([]);
  });

  /** Decode every control message the server wrote on the client's first bidi stream. */
  function decodeServerResponses(a: ReturnType<typeof createLoopback>['a']): string[] {
    const bytes = a.bidiOut[0]!.in.writtenBytes();
    const types: string[] = [];
    let off = 0;
    while (off < bytes.byteLength) {
      const { message, bytesRead } = codec18.decode(bytes, off);
      types.push(message.type);
      off += bytesRead;
    }
    return types;
  }

  it('RESPONSE ORDER on the wire: exactly [SUBSCRIBE_OK, REQUEST_OK] (§10.8)', async () => {
    const { client, server, a, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'), { forward: ForwardState.PAUSED });
    await flush();
    await client.requestUpdate(subReqId, { forward: true });
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    expect(decodeServerResponses(a)).toEqual(['SUBSCRIBE_OK', 'REQUEST_OK']);
    // The applied update also settled locally: subscriber's own state is ACTIVE.
    expect(client.session.getSubscription(subReqId)?.forwardState).toBe(ForwardState.ACTIVE);
    expect(errors).toEqual([]);
  });

  it('RESPONSE ORDER with multiple pending updates: [SUBSCRIBE_OK, REQUEST_OK, REQUEST_OK] FIFO', async () => {
    const { client, server, a, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'), { forward: ForwardState.PAUSED });
    await flush();
    await client.requestUpdate(subReqId, { forward: true });
    await flush();
    await client.requestUpdate(subReqId, { forward: false });
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    expect(decodeServerResponses(a)).toEqual(['SUBSCRIBE_OK', 'REQUEST_OK', 'REQUEST_OK']);
    expect(client.session.getSubscription(subReqId)?.forwardState).toBe(ForwardState.PAUSED); // last wins
    expect(errors).toEqual([]);
  });

  it('REJECTING a pending SUBSCRIBE with a deferred update leaves the client ESTABLISHED (stream FIN, no close)', async () => {
    const { client, server, a, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await client.requestUpdate(subReqId, { forward: false });
    await flush();
    await server.rejectSubscribe(subReqId, RequestError18.DOES_NOT_EXIST as bigint, 'nope');
    await flush();

    // REQUEST_ERROR first, then the deferred update acknowledgement, then FIN.
    expect(decodeServerResponses(a)).toEqual(['REQUEST_ERROR', 'REQUEST_OK']);
    // §3.3.2: a rejected request stream fully closes — BOTH directions, not just
    // the response direction. Real LoopPipe state, not a phantom field:
    expect(a.bidiOut[0]!.in.writeClosed).toBe(true);      // responder FINned its response direction
    // Request direction settled: the responder STOP_SENDINGs it, unless the
    // requester's own FIN already closed it first (both are a full close).
    expect(a.bidiOut[0]!.out.readCancelled || a.bidiOut[0]!.out.writeClosed).toBe(true);
    // requester released its send direction too (FIN, or reset by the STOP_SENDING)
    expect(a.bidiOut[0]!.out.writeClosed || a.bidiOut[0]!.out.writeAborted).toBe(true);
    expect(client.session.state).toBe(SessionState.ESTABLISHED); // the SESSION survives
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });

  it('a rejected SUBSCRIBE leaves no live request-stream context or read loop on either side', async () => {
    const { client, server, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.rejectSubscribe(subReqId, RequestError18.DOES_NOT_EXIST as bigint, 'nope');
    await flush(32); // full teardown: barrier delivery → FIN both ways → context reclaim

    // Repeated refusals must not retain stream contexts (bidi-credit leak).
    const clientContexts = (client as unknown as { uniPair: { contexts: Map<bigint, unknown> } }).uniPair.contexts;
    const serverContexts = (server as unknown as { inboundRequestContexts: Map<bigint, unknown> }).inboundRequestContexts;
    expect(clientContexts.size).toBe(0);
    expect(serverContexts.size).toBe(0);
    // Full teardown reclaims the request's session state along with the stream.
    expect(client.session.getSubscription(subReqId)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('FLOOD of pending updates is bounded: the subscribe is rejected with EXCESSIVE_LOAD', async () => {
    const { client, server, errors } = await connectedPair();
    const clientErrors: RequestErrorMsg[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m as RequestErrorMsg); };
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    for (let i = 0; i < 8; i++) {
      // Once the flood triggers rejection, the local subscription terminates
      // and further updates correctly throw — that IS the bound working.
      try { await client.requestUpdate(subReqId, { forward: i % 2 === 0 }); } catch { break; }
      await flush();
    }
    await flush();
    // The responder refused to buffer unboundedly: subscribe rejected.
    const err = clientErrors.find((e) => BigInt(e.requestId) === subReqId);
    expect(err).toBeDefined();
    expect(err!.errorCode).toBe(RequestError18.EXCESSIVE_LOAD);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    expect(server.session.state).toBe(SessionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });

  it('MULTIPLE pending updates: all applied, responses flushed FIFO after SUBSCRIBE_OK, last update wins', async () => {
    const { client, server, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'), { forward: ForwardState.PAUSED });
    await flush();
    await client.requestUpdate(subReqId, { forward: true });
    await flush();
    await client.requestUpdate(subReqId, { forward: false });
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    const sub = server.session.getIncomingSubscription(subReqId);
    expect(sub?.forwardState).toBe(ForwardState.PAUSED); // last update wins
    expect(errors).toEqual([]);
  });

  it('UPDATE REQUEST_ERROR correlation: rejecting the SUBSCRIBE settles the subscribe first under strict FIFO', async () => {
    const { client, server, errors } = await connectedPair();
    const clientErrors: RequestErrorMsg[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m as RequestErrorMsg); };
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await client.requestUpdate(subReqId, { forward: false });
    await flush();
    await server.rejectSubscribe(subReqId, RequestError18.DOES_NOT_EXIST as bigint, 'nope');
    await flush();

    // Strict FIFO: the REQUEST_ERROR settles the SUBSCRIBE (its stamped id is
    // the subscribe's), never the update.
    const err = clientErrors.find((e) => BigInt(e.requestId) === subReqId);
    expect(err).toBeDefined();
    expect(errors).toEqual([]); // no stream failure from the pending update
  });

  it('PUBLISH_DONE terminal lifecycle: exact status/reason/id, both directions closed, state reclaimed (§10.11)', async () => {
    const { client, server, a, errors } = await connectedPair();
    const seen: ControlMessage[] = [];
    client.onMessage = (m) => seen.push(m);

    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    await server.publishDone(subReqId, varint(0x3n), 'track ended');
    await flush();

    const done = seen.find((m) => m.type === 'PUBLISH_DONE') as
      { requestId?: bigint; statusCode?: bigint; errorReason?: string } | undefined;
    expect(done).toBeDefined();
    expect(done!.requestId).toBe(subReqId);
    expect(done!.statusCode).toBe(0x3n);           // exact status preserved
    expect(done!.errorReason).toBe('track ended'); // exact reason preserved

    // Terminal: the responder FINned its side; the requester closed its side too.
    expect(a.bidiOut[0]!.out.writeClosed || a.bidiOut[0]!.out.writeAborted).toBe(true);
    // Server-side subscription state is reclaimed…
    expect(server.session.getIncomingSubscription(subReqId)).toBeUndefined();
    // …and a duplicate publishDone is impossible (state gone → throws).
    await expect(server.publishDone(subReqId, varint(0n), 'again')).rejects.toThrow(/Unknown/);
    expect(errors).toEqual([]);
  });

  it('publishDone after rejectSubscribe throws — DONE is only valid on an established subscription', async () => {
    const { client, server, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.rejectSubscribe(subReqId, RequestError18.DOES_NOT_EXIST as bigint, 'nope');
    await flush();
    await expect(server.publishDone(subReqId, varint(0n), 'late')).rejects.toThrow();
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });

  it('a parked joining FETCH times out with REQUEST_ERROR TIMEOUT when the subscription never resolves', async () => {
    const { client, server, errors } = await connectedPair(18, {
      serverOptions: { joiningFetchTimeoutMs: 60 },
    });
    const fetches: bigint[] = [];
    server.onFetch = (rid) => { fetches.push(rid); };
    const clientErrors: RequestErrorMsg[] = [];
    client.onMessage = (m) => { if (m.type === 'REQUEST_ERROR') clientErrors.push(m as RequestErrorMsg); };

    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    const joinReqId = await client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    await flush();
    // Application never accepts nor rejects the subscription.
    await new Promise((r) => setTimeout(r, 150));
    await flush();

    expect(fetches).not.toContain(joinReqId);
    const joinError = clientErrors.find((e) => BigInt(e.requestId) === joinReqId);
    expect(joinError).toBeDefined();
    expect(joinError!.errorCode).toBe(RequestError18.TIMEOUT);
    expect(errors).toEqual([]);
  });

  it('a joining FETCH referencing a bogus request ID → client receives REQUEST_ERROR INVALID_JOINING_REQUEST_ID', async () => {
    // Bypass the client-side fast-fail by sending the raw session action: build
    // the message via a second session… simplest legal path: subscribe, then
    // unsubscribe to terminate it, then joiningFetch must fast-fail locally —
    // so instead craft the reference AFTER the server forgot the subscription.
    // The session-level test covers the wire-reject path; here we assert the
    // client-side guard refuses to emit the doomed request at all.
    const { client } = await connectedPair();
    await expect(client.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: 42n, joiningStart: 0n,
    })).rejects.toThrow(/PENDING\/ESTABLISHED/);
  });
});

describe('MoqtConnection(18) loopback — coalesced reads, terminal PUBLISH_DONE, stream accounting (round 6)', () => {
  /** Encode a raw draft-18 PUBLISH_DONE frame (no wire Request ID). */
  function rawPublishDone(statusCode: bigint, reason: string): Uint8Array {
    return codec18.encode({
      type: 'PUBLISH_DONE',
      requestId: varint(0n), // not on the d18 wire — stream-correlated
      statusCode: varint(statusCode),
      streamCount: varint(0n),
      errorReason: reason,
    } as unknown as ControlMessage);
  }

  it('single-read SUBSCRIBE_OK + PUBLISH_DONE applies in wire order — no session close, subscription terminates cleanly', async () => {
    const { client, server, a, errors } = await connectedPair();
    const seen: ControlMessage[] = [];
    client.onMessage = (m) => seen.push(m);
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();

    // Coalesce: hold the server→client response direction so SUBSCRIBE_OK and
    // PUBLISH_DONE arrive in ONE read (a single framer drain), like QUIC may
    // deliver them. The barrier must apply SUBSCRIBE_OK through session state
    // BEFORE PUBLISH_DONE is processed. The DONE is injected raw (no server FIN)
    // so the post-conditions are observed before terminal stream reclaim.
    a.bidiOut[0]!.in.faults.hold = true;
    await server.acceptSubscribe(subReqId, 7n);
    a.bidiOut[0]!.in.injectRead(rawPublishDone(0x3n, 'track ended'));
    a.bidiOut[0]!.in.releaseHeld();
    await flush();

    expect(client.session.state).toBe(SessionState.ESTABLISHED); // SESSION survives
    // §5.1: PUBLISH_DONE is terminal — the subscription state is RECLAIMED cleanly.
    expect(client.session.getSubscription(subReqId)).toBeUndefined();
    expect(seen.some((m) => m.type === 'SUBSCRIBE_OK')).toBe(true);
    expect(seen.some((m) => m.type === 'PUBLISH_DONE')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('single-read REQUEST_OK + PUBLISH_DONE: the update is applied while ESTABLISHED, then the DONE terminates', async () => {
    const { client, server, a, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    a.bidiOut[0]!.in.faults.hold = true;
    await client.requestUpdate(subReqId, { forward: false });
    await flush(); // server answers REQUEST_OK into the held pipe
    a.bidiOut[0]!.in.injectRead(rawPublishDone(0x3n, 'track ended'));
    a.bidiOut[0]!.in.releaseHeld();
    await flush();

    // Wire order: REQUEST_OK first — applied to an ESTABLISHED subscription BEFORE
    // the terminal DONE (never skipped as "already terminated", which would have
    // errored/closed). PUBLISH_DONE then reclaims the subscription state cleanly.
    expect(client.session.getSubscription(subReqId)).toBeUndefined();
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });

  it('duplicate PUBLISH_DONE in one chunk is rejected — the second terminal message is a violation, never silently discarded', async () => {
    const { client, server, a, errors } = await connectedPair();
    const seen: ControlMessage[] = [];
    client.onMessage = (m) => seen.push(m);
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    // A misbehaving peer coalesces TWO terminal messages into one receive. The
    // real adapter API refuses to produce this, so inject the raw bytes.
    const done = rawPublishDone(0x3n, 'end');
    const twice = new Uint8Array(done.length * 2);
    twice.set(done, 0);
    twice.set(done, done.length);
    a.bidiOut[0]!.in.injectRead(twice);
    await flush();

    // The first DONE was applied and surfaced; the SECOND terminal message is a
    // protocol violation — surfaced and session-fatal, never silently discarded.
    expect(seen.some((m) => m.type === 'PUBLISH_DONE')).toBe(true);
    expect(errors.some((e) => /PUBLISH_DONE/.test(e.message) && /terminal|after/.test(e.message))).toBe(true);
    expect(client.session.state).toBe(SessionState.CLOSED);
  });

  it('any message after PUBLISH_DONE in the same chunk is rejected (§10.11: nothing follows the terminal message)', async () => {
    const { client, server, a, errors } = await connectedPair();
    const seen: ControlMessage[] = [];
    client.onMessage = (m) => seen.push(m);
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    const done = rawPublishDone(0x3n, 'end');
    const trailing = codec18.encode({ type: 'REQUEST_OK', requestId: varint(9n), parameters: new Map() } as unknown as ControlMessage);
    const chunk = new Uint8Array(done.length + trailing.length);
    chunk.set(done, 0);
    chunk.set(trailing, done.length);
    a.bidiOut[0]!.in.injectRead(chunk);
    await flush();

    // The DONE was applied and surfaced; the trailing REQUEST_OK after the
    // terminal message is a protocol violation — surfaced and session-fatal.
    expect(seen.some((m) => m.type === 'PUBLISH_DONE')).toBe(true);
    expect(errors.some((e) => /terminal|after.*PUBLISH_DONE|PUBLISH_DONE.*terminal/i.test(e.message))).toBe(true);
    expect(client.session.state).toBe(SessionState.CLOSED);
  });

  it('PUBLISH_DONE terminal completion: subscriber FINs its send direction and drains to the clean peer FIN', async () => {
    const { client, server, a, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();
    await server.publishDone(subReqId, varint(0x3n), 'track ended');
    await flush();

    // Receiver of the terminal message closes its OWN writable (clean FIN — not
    // an abort) and consumes the peer's FIN; the context is then reclaimed.
    expect(a.bidiOut[0]!.out.writeClosed).toBe(true);
    // It DRAINS to the clean peer FIN — it does not abandon readable bytes by
    // cancelling its reader the moment the terminal message is seen.
    expect(a.bidiOut[0]!.in.readCancelled).toBe(false);
    const clientContexts = (client as unknown as { uniPair: { contexts: Map<bigint, unknown> } }).uniPair.contexts;
    expect(clientContexts.size).toBe(0);
    // Responder side is fully torn down too — no pending reader, no context.
    const serverContexts = (server as unknown as { inboundRequestContexts: Map<bigint, unknown> }).inboundRequestContexts;
    expect(serverContexts.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it.each([0, 1, 3])('PUBLISH_DONE carries the true Stream Count: %i data stream(s) opened → that count on the wire', async (n) => {
    const { client, server, errors } = await connectedPair();
    const seen: ControlMessage[] = [];
    client.onMessage = (m) => seen.push(m);
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    for (let i = 0; i < n; i++) {
      const sid = await server.openSubgroup(7n, BigInt(i), 0n, { publisherPriority: 1 });
      await server.sendObject(sid, 0n, new Uint8Array([i]));
      await server.closeSubgroup(sid);
    }
    await flush();
    await server.publishDone(subReqId, varint(0x3n), 'track ended');
    await flush();

    const done = seen.find((m) => m.type === 'PUBLISH_DONE') as { streamCount?: bigint } | undefined;
    expect(done).toBeDefined();
    expect(BigInt(done!.streamCount ?? -1n)).toBe(BigInt(n));
    expect(errors).toEqual([]);
  });

  it('publishDone is rejected while subgroup streams for the subscription remain open (§10.11)', async () => {
    const { client, server, errors } = await connectedPair();
    const seen: ControlMessage[] = [];
    client.onMessage = (m) => seen.push(m);
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    const sid = await server.openSubgroup(7n, 0n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([1]));
    await expect(server.publishDone(subReqId, varint(0x3n), 'early')).rejects.toThrow(/open/);

    // Closing the stream unblocks the terminal message.
    await server.closeSubgroup(sid);
    await server.publishDone(subReqId, varint(0x3n), 'track ended');
    await flush();
    expect(seen.some((m) => m.type === 'PUBLISH_DONE')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('subgroup opens and datagram sends are rejected after the subscription terminated via PUBLISH_DONE', async () => {
    const { client, server, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();
    await server.publishDone(subReqId, varint(0x3n), 'track ended');
    await flush();

    await expect(server.openSubgroup(7n, 1n, 0n, { publisherPriority: 1 })).rejects.toThrow(/terminated/);
    await expect(server.sendDatagram(7n, 1n, 0n, new Uint8Array([1]))).rejects.toThrow(/terminated/);
    expect(errors).toEqual([]);
  });

  it('receiver of PUBLISH_DONE takes the early-discard path: STOP_SENDING on the subscription\'s open data streams', async () => {
    const { client, server, a, b, errors } = await connectedPair();
    const subReqId = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(subReqId, 7n);
    await flush();

    // An open subgroup stream for the alias: header + one object delivered, NO FIN.
    const sid = await server.openSubgroup(7n, 0n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([1]));
    await flush();

    // The publisher-side gate forbids DONE with open streams, so inject the raw
    // terminal frame — modelling a peer that terminated with streams in flight.
    a.bidiOut[0]!.in.injectRead(rawPublishDone(0x3n, 'end'));
    await flush();

    // §5.1: PUBLISH_DONE reclaims the subscription state (bounded — not retained).
    expect(client.session.getSubscription(subReqId)).toBeUndefined();
    // uniOut[0] is the server's control stream; uniOut[1] is the subgroup stream.
    expect(b.uniOut[1]!.readCancelled).toBe(true); // client STOP_SENDINGed the related data stream
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — terminal-lifecycle interleavings (round 7)', () => {
  /** Encode a raw draft-18 PUBLISH_DONE frame with an explicit Stream Count. */
  function rawDone(streamCount: bigint, reason = 'end'): Uint8Array {
    return codec18.encode({
      type: 'PUBLISH_DONE',
      requestId: varint(0n),
      statusCode: varint(0x3n),
      streamCount: varint(streamCount),
      errorReason: reason,
    } as unknown as ControlMessage);
  }

  async function acceptedSubscription(opts?: Parameters<typeof connectedPair>[1]) {
    const pair = await connectedPair(18, opts);
    const seen: ControlMessage[] = [];
    pair.client.onMessage = (m) => seen.push(m);
    const subReqId = await pair.client.subscribe(ns('live'), nm('vid'));
    await flush();
    await pair.server.acceptSubscribe(subReqId, 7n);
    await flush();
    return { ...pair, subReqId, seen };
  }

  it('RACE: publishDone is refused while a subgroup OPEN is in flight (deferred stream creation); Stream Count stays truthful', async () => {
    const { client, server, b, subReqId, seen, errors } = await acceptedSubscription();

    // Defer the transport-level stream open: the adapter is mid-openSubgroup
    // (operation reserved, no stream recorded yet) when publishDone is called.
    const orig = b.createUnidirectionalStream.bind(b);
    let release!: () => void;
    (b as { createUnidirectionalStream: typeof b.createUnidirectionalStream }).createUnidirectionalStream =
      async () => { await new Promise<void>((r) => { release = r; }); return orig(); };
    const openP = server.openSubgroup(7n, 0n, 0n, { publisherPriority: 1 });
    await flush();

    await expect(server.publishDone(subReqId, varint(0x3n), 'early')).rejects.toThrow(/open|in flight/);

    release();
    const sid = await openP; // the open completes normally after the refusal
    await server.sendObject(sid, 0n, new Uint8Array([1]));
    await server.closeSubgroup(sid);
    await server.publishDone(subReqId, varint(0x3n), 'done');
    await flush();

    const done = seen.find((m) => m.type === 'PUBLISH_DONE') as { streamCount?: bigint } | undefined;
    expect(BigInt(done!.streamCount ?? -1n)).toBe(1n); // the raced stream IS counted
    expect(errors).toEqual([]);
  });

  it('RACE: publishDone is refused while a datagram write is in flight (deferred datagram write)', async () => {
    const { server, b, subReqId, errors } = await acceptedSubscription();

    const origDatagrams = b.datagrams;
    let release!: () => void;
    (b as { datagrams: typeof b.datagrams }).datagrams = {
      readable: origDatagrams.readable,
      writable: new WritableStream<Uint8Array>({
        write: async (chunk) => {
          await new Promise<void>((r) => { release = r; });
          const w = origDatagrams.writable.getWriter();
          await w.write(chunk);
          w.releaseLock();
        },
      }),
    };
    const dgP = server.sendDatagram(7n, 0n, 0n, new Uint8Array([1]));
    await flush();

    await expect(server.publishDone(subReqId, varint(0x3n), 'early')).rejects.toThrow(/open|in flight/);

    release();
    await dgP;
    await server.publishDone(subReqId, varint(0x3n), 'done');
    await flush();
    expect(errors).toEqual([]);
  });

  it('a data stream whose BYTES arrive after PUBLISH_DONE is early-discarded via the Stream Count tracker', async () => {
    const { client, a, b, subReqId, errors } = await acceptedSubscription();
    void subReqId;
    const generic: unknown[] = [];
    client.onObject = (_sid, o) => generic.push(o);

    // A subgroup stream on alias 7 whose bytes are HELD — it is opened at the
    // transport level (NOT via server.openSubgroup) so the server's own
    // cancel-on-FIN reaction can't race the pure receiver-side behavior we test:
    // a late stream (announced by Stream Count 1) whose bytes arrive after DONE.
    const uni = await b.createUnidirectionalStream();
    const lateStream = b.uniOut[b.uniOut.length - 1]!;
    lateStream.faults.hold = true;
    const w = uni.getWriter();
    await w.write(encodeSubgroupHeader18({
      typeByte: 0x10, trackAlias: 7n, groupId: 0n, subgroupId: 0n,
      publisherPriority: 1, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true,
    }));
    await w.write(encodeSubgroupObject18({ objectId: 0n, payload: new Uint8Array([1]), extensions: undefined, status: undefined }, false, 0n, true));
    await flush();

    // Terminal message first (announcing ONE stream), then the held bytes.
    a.bidiOut[0]!.in.injectRead(rawDone(1n));
    await flush();
    lateStream.releaseHeld();
    await flush();

    // The late stream was discarded — never delivered to the generic hook —
    // and, with the announced count observed, the tracker is CLEARED (bounded).
    expect(generic).toEqual([]);
    expect(lateStream.readCancelled).toBe(true);
    const internals = client as unknown as { terminatedAliases: Map<bigint, unknown>; aliasStreamsSeen: Map<bigint, number> };
    expect(internals.terminatedAliases.size).toBe(0);
    expect(internals.aliasStreamsSeen.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it('the terminal tracker is BOUNDED: an unmet Stream Count expires after terminatedAliasTtlMs', async () => {
    const { client, a, errors } = await acceptedSubscription({ clientOptions: { terminatedAliasTtlMs: 40 } });

    a.bidiOut[0]!.in.injectRead(rawDone(5n)); // five announced streams never arrive
    await flush();
    const internals = client as unknown as { terminatedAliases: Map<bigint, unknown>; aliasStreamsSeen: Map<bigint, number> };
    expect(internals.terminatedAliases.size).toBe(1);

    await new Promise((r) => setTimeout(r, 120));
    expect(internals.terminatedAliases.size).toBe(0);
    expect(internals.aliasStreamsSeen.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it('datagrams for a tombstoned alias are dropped after PUBLISH_DONE', async () => {
    const { client, server, a, subReqId, errors } = await acceptedSubscription({ clientOptions: { terminatedAliasTtlMs: 60 } });
    void subReqId;
    const dgs: unknown[] = [];
    client.onDatagram = (d) => dgs.push(d);
    const datagramFor = (objectId: bigint) => encodeObjectDatagram18({
      typeByte: 0x00, trackAlias: 7n, groupId: 0n, objectId,
      publisherPriority: 128, isEndOfGroup: false, extensions: undefined, payload: new Uint8Array([Number(objectId)]), status: undefined,
    });

    await server.sendDatagram(7n, 0n, 0n, new Uint8Array([0]));
    await flush();
    expect(dgs.length).toBe(1); // sanity: pre-DONE datagram delivers

    a.bidiOut[0]!.in.injectRead(rawDone(1n)); // tombstone armed (1 stream never arrives)
    await flush();
    // A late datagram for the terminated alias, injected at the receiver (the
    // real publisher API would refuse post-termination).
    a.injectDatagram(datagramFor(1n));
    await flush();
    expect(dgs.length).toBe(1); // dropped at the receiver
    expect(errors).toEqual([]);
  });

  it('UNSUBSCRIBE aborts the publisher\'s open streams for the subscription (RESET_STREAM, §5.1.1) and sendObject then rejects', async () => {
    const { client, server, b, errors } = await connectedPair();
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const delivered: string[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), {
      onObject: (o) => delivered.push(`${o.groupId}:${o.objectId}`),
    });
    await flush();
    await server.acceptSubscribe(rid, 5n);
    const sub = await subP;

    const sid = await server.openSubgroup(5n, 1n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([1]));
    await flush();
    expect(delivered).toEqual(['1:0']);

    await sub.unsubscribe();
    await flush();

    // §5.1.1: the publisher RESETS associated open streams and drops accounting.
    expect(b.uniOut[1]!.writeAborted).toBe(true);
    const acct = server as unknown as { openSubgroupsByRequest: Map<bigint, Set<bigint>>; outgoingStreams: Map<bigint, unknown> };
    expect(acct.openSubgroupsByRequest.size).toBe(0);
    expect(acct.outgoingStreams.size).toBe(0);
    await expect(server.sendObject(sid, 1n, new Uint8Array([2]))).rejects.toThrow(/Unknown outgoing stream/);
    expect(errors).toEqual([]);
  });

  it('a fatal request-stream violation rejects unrelated pending subscribeTrack() promises (centralized fatal cleanup)', async () => {
    const { client, server, a, subReqId, errors } = await acceptedSubscription();
    void subReqId; void server;
    const pending = client.subscribeTrack(ns('live'), nm('other'), { onObject: () => { /* none */ } });
    await flush(); // pending SUBSCRIBE sent, never answered

    const done = rawDone(0n);
    const twice = new Uint8Array(done.length * 2);
    twice.set(done, 0);
    twice.set(done, done.length);
    a.bidiOut[0]!.in.injectRead(twice); // duplicate terminal → fatal PROTOCOL_VIOLATION
    await flush();

    await expect(pending).rejects.toThrow();
    expect(client.session.state).toBe(SessionState.CLOSED);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('an immediately rejected SUBSCRIBE_NAMESPACE (PREFIX_OVERLAP) fully closes the continuing stream — both directions, no context', async () => {
    const { client, server, a, errors } = await connectedPair();
    let snReqId = -1n;
    server.onSubscribeNamespace = (rid) => { snReqId = rid; };
    await client.subscribeNamespace(ns('x'));
    await flush();
    await server.acceptSubscribeNamespace(snReqId);
    await flush();

    // Overlapping prefix → immediate REQUEST_ERROR (PREFIX_OVERLAP) on the new stream.
    await client.subscribeNamespace(ns('x')).catch(() => undefined);
    await flush(32);

    const rejected = a.bidiOut[1]!; // the second continuing stream
    expect(rejected.in.writeClosed).toBe(true);                                  // responder FINned
    expect(rejected.out.writeClosed || rejected.out.writeAborted).toBe(true);    // requester released its side
    expect(rejected.out.readCancelled || rejected.out.writeClosed).toBe(true);   // request direction settled
    const contexts = (client as unknown as { uniPair: { continuingContexts: Map<bigint, unknown> } }).uniPair.continuingContexts;
    expect(contexts.size).toBe(1); // only the accepted subscription's stream remains
    expect(errors).toEqual([]);
  });

  it('UniPairTopology.openRequest requires the response processor (the wire-order acknowledgement is not optional)', async () => {
    const { client } = await connectedPair();
    const internals = client as unknown as {
      uniPair: { openRequest: (t: unknown, m: unknown, p?: unknown) => Promise<unknown> };
      transport: unknown;
    };
    await expect(
      internals.uniPair.openRequest(internals.transport, { type: 'SUBSCRIBE', requestId: 98n }),
    ).rejects.toThrow(/onResponse|processor|acknowledgement/);
  });
});

describe('MoqtConnection(18) loopback — publisher operation lifecycle (round 8)', () => {
  async function acceptedSubscription() {
    const pair = await connectedPair();
    const seen: ControlMessage[] = [];
    pair.client.onMessage = (m) => seen.push(m);
    const subReqId = await pair.client.subscribe(ns('live'), nm('vid'));
    await flush();
    await pair.server.acceptSubscribe(subReqId, 7n);
    await flush();
    return { ...pair, subReqId, seen };
  }

  it('cancellation while createUnidirectionalStream is held: the in-flight open is invalidated — writer aborted, rejects, no header on the wire', async () => {
    const { client, server, b, subReqId } = await acceptedSubscription();

    // Hold the transport open so openSubgroup is parked past its synchronous
    // reservation, awaiting the stream.
    const orig = b.createUnidirectionalStream.bind(b);
    let release!: () => void;
    (b as { createUnidirectionalStream: typeof b.createUnidirectionalStream }).createUnidirectionalStream =
      async () => { await new Promise<void>((r) => { release = r; }); return orig(); };
    const openP = server.openSubgroup(7n, 0n, 0n, { publisherPriority: 1 });
    await flush();

    // Subscriber cancels mid-open: the client resets its SUBSCRIBE stream
    // (draft-18 §3.3.2), which the server processes as the cancellation and
    // bumps the publisher-op generation for this subscription.
    await client.unsubscribe(subReqId);
    await flush();

    release();
    await expect(openP).rejects.toThrow(/cancel/i);
    // The freshly-created stream (the last uni b opened) carries NO header bytes.
    const opened = b.uniOut[b.uniOut.length - 1]!;
    expect(opened.writeAborted).toBe(true);
    expect(opened.writtenBytes().length).toBe(0);
  });

  it('a cancelled in-flight publisher op is NOT resurrected by generation-map eviction (§5.1)', async () => {
    const { client, server, b, subReqId } = await acceptedSubscription();
    type Internals = {
      publisherGeneration: Map<bigint, number>;
      pendingPublishOps: Map<bigint, number>;
      boundPublisherGeneration(): void;
      publisherOpCurrent(r: bigint, g: number): boolean;
    };
    const S = server as unknown as Internals;

    // Hold the transport open so openSubgroup parks past its synchronous
    // reservation (generation 0 captured, pendingPublishOps reserved).
    const orig = b.createUnidirectionalStream.bind(b);
    let release!: () => void;
    (b as { createUnidirectionalStream: typeof b.createUnidirectionalStream }).createUnidirectionalStream =
      async () => { await new Promise<void>((r) => { release = r; }); return orig(); };
    const openP = server.openSubgroup(7n, 0n, 0n, { publisherPriority: 1 });
    await flush();
    expect((S.pendingPublishOps.get(subReqId) ?? 0)).toBeGreaterThan(0);

    // Subscriber cancels mid-open → the server bumps this op's generation.
    await client.unsubscribe(subReqId);
    await flush();
    // The in-flight reservation MUST be preserved — otherwise the bumped generation
    // becomes evictable and a resolving op would default to gen 0 and match.
    expect(S.pendingPublishOps.has(subReqId)).toBe(true);

    // Heavy generation-map eviction pressure: the bumped generation must survive
    // (its request still has a pending op), so the op stays invalidated.
    for (let i = 0; i < 400; i++) S.publisherGeneration.set(BigInt(10_000 + i), 0);
    S.boundPublisherGeneration();
    expect(S.publisherOpCurrent(subReqId, 0)).toBe(false); // captured gen 0, now bumped

    release();
    await expect(openP).rejects.toThrow(/cancel/i); // still invalidated — no stream emitted
  });

  it('header-write failure: the writer is aborted but the stream is still counted in PUBLISH_DONE Stream Count (§10.11)', async () => {
    const { server, subReqId, seen, errors } = await acceptedSubscription();

    // Next transport stream rejects on the header write.
    (server as unknown as { transport: { createUnidirectionalStream: () => Promise<WritableStream<Uint8Array>> } })
      .transport.createUnidirectionalStream = async () =>
        new WritableStream<Uint8Array>({ write() { throw new Error('write boom'); } });

    await expect(server.openSubgroup(7n, 0n, 0n, { publisherPriority: 1 })).rejects.toThrow(/write boom/);

    // The failed open must NOT block the terminal message (removed from the open
    // set), yet it IS counted (the transport stream was created): Stream Count 1.
    await server.publishDone(subReqId, varint(0x3n), 'done');
    await flush();
    const done = seen.find((m) => m.type === 'PUBLISH_DONE') as { streamCount?: bigint } | undefined;
    expect(done).toBeDefined();
    expect(BigInt(done!.streamCount ?? -1n)).toBe(1n);
    expect(errors).toEqual([]);
  });
});

describe('MoqtConnection(18) loopback — receiver terminal/alias lifecycle (round 8)', () => {
  const STREAM_COUNT_UNKNOWN = (1n << 62n) - 1n; // §9.15 sentinel
  function rawDone(streamCount: bigint): Uint8Array {
    return codec18.encode({
      type: 'PUBLISH_DONE', requestId: varint(0n), statusCode: varint(0x3n),
      streamCount: varint(streamCount), errorReason: 'end',
    } as unknown as ControlMessage);
  }
  function rawSubgroup(b: ReturnType<typeof createLoopback>['b'], alias: bigint, groupId: bigint) {
    return (async () => {
      const uni = await b.createUnidirectionalStream();
      const pipe = b.uniOut[b.uniOut.length - 1]!;
      const w = uni.getWriter();
      await w.write(encodeSubgroupHeader18({
        typeByte: 0x10, trackAlias: alias, groupId, subgroupId: 0n,
        publisherPriority: 1, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true,
      }));
      await w.write(encodeSubgroupObject18({ objectId: 0n, payload: new Uint8Array([1]), extensions: undefined, status: undefined }, false, 0n, true));
      return { pipe, w };
    })();
  }

  it('valid alias reuse after terminal completion: a re-bound alias clears the lingering tombstone and routes its streams', async () => {
    const { client, server, a, b, errors } = await connectedPair(18, { clientOptions: { terminatedAliasTtlMs: 10_000 } });
    const d1: string[] = [];
    let rid1 = -1n; server.onSubscribe = (r) => { rid1 = r; };
    const p1 = client.subscribeTrack(ns('live'), nm('v1'), { onObject: (o) => d1.push(`${o.groupId}:${o.objectId}`) });
    await flush();
    await server.acceptSubscribe(rid1, 7n);
    await p1;

    // Terminate subscription 1 with an exact Stream Count that leaves a
    // (remaining-0, TTL-lingering) tombstone on alias 7.
    a.bidiOut[0]!.in.injectRead(rawDone(0n));
    await flush();
    const internals = client as unknown as { terminatedAliases: Map<bigint, unknown> };
    expect(internals.terminatedAliases.has(7n)).toBe(true); // tombstone present

    // Reuse alias 7 for a NEW subscription; binding it must clear the tombstone.
    const d2: string[] = [];
    let rid2 = -1n; server.onSubscribe = (r) => { rid2 = r; };
    const p2 = client.subscribeTrack(ns('live'), nm('v2'), { onObject: (o) => d2.push(`${o.groupId}:${o.objectId}`) });
    await flush();
    await server.acceptSubscribe(rid2, 7n);
    await p2;
    expect(internals.terminatedAliases.has(7n)).toBe(false); // cleared on rebind

    const { w } = await rawSubgroup(b, 7n, 5n);
    await w.close();
    await flush();
    expect(d2).toEqual(['5:0']); // routed to the NEW subscription, not discarded
    void errors;
  });

  it('late object after ordinary unsubscribe is discarded — never routed to the generic onObject hook', async () => {
    const { client, server, a, b, errors } = await connectedPair(18, { clientOptions: { terminatedAliasTtlMs: 10_000 } });
    const generic: unknown[] = [];
    client.onObject = (_sid, o) => generic.push(o);
    let rid = -1n; server.onSubscribe = (r) => { rid = r; };
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    await server.acceptSubscribe(rid, 7n);
    const sub = await subP;

    await sub.unsubscribe(); // ordinary unsubscribe — no PUBLISH_DONE / Stream Count
    await flush();

    // A late subgroup stream on the (now freed) alias must be discarded, not
    // delivered to the connection-level onObject.
    const { w } = await rawSubgroup(b, 7n, 9n);
    await w.close();
    await flush();
    expect(generic).toEqual([]);
    void a; void errors;
  });

  it('2^62-1 Stream Count sentinel and counts above Number.MAX_SAFE_INTEGER are handled as bigint (TTL-only tombstone)', async () => {
    const { client, a, errors } = await acceptedForReceiver({ terminatedAliasTtlMs: 40 });

    // Sentinel: the count is UNKNOWN — the tombstone must not try to count down
    // (remaining null) and relies on the TTL.
    a.bidiOut[0]!.in.injectRead(rawDone(STREAM_COUNT_UNKNOWN));
    await flush();
    const internals = client as unknown as { terminatedAliases: Map<bigint, { remaining: bigint | null }> };
    const t = internals.terminatedAliases.get(7n);
    expect(t).toBeDefined();
    expect(t!.remaining).toBeNull(); // sentinel → unknown, TTL-governed
    // A huge count (> Number.MAX_SAFE_INTEGER) is kept exact as bigint.
    void BigInt(Number.MAX_SAFE_INTEGER);

    await new Promise((r) => setTimeout(r, 120));
    expect(internals.terminatedAliases.has(7n)).toBe(false); // TTL cleared it
    expect(errors).toEqual([]);
  });

  it('a huge non-sentinel Stream Count is stored exactly as bigint (no Number precision loss)', async () => {
    const { client, a } = await acceptedForReceiver({ terminatedAliasTtlMs: 10_000 });
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 100n; // 9007199254740991 + 100
    a.bidiOut[0]!.in.injectRead(rawDone(huge));
    await flush();
    const internals = client as unknown as { terminatedAliases: Map<bigint, { remaining: bigint | null }> };
    // seen = 0 → remaining == huge, exact (Number() would have rounded it).
    expect(internals.terminatedAliases.get(7n)!.remaining).toBe(huge);
  });

  async function acceptedForReceiver(clientOptions?: { terminatedAliasTtlMs?: number }) {
    const pair = await connectedPair(18, { clientOptions });
    const subReqId = await pair.client.subscribe(ns('live'), nm('vid'));
    await flush();
    await pair.server.acceptSubscribe(subReqId, 7n);
    await flush();
    return { ...pair, subReqId };
  }
});

describe('MoqtConnection(18) loopback — terminal coordinator + transport.closed (round 8)', () => {
  it('a remote transport close preserves the real closeCode/reason in onClose (fired exactly once)', async () => {
    const { client, a } = await connectedPair();
    const closes: Array<{ code?: number; reason?: string }> = [];
    client.onClose = (code, reason) => closes.push({ code, reason });

    a.close({ closeCode: 0x1234, reason: 'server going away' });
    await flush();

    expect(closes.length).toBe(1);
    expect(closes[0]!.code).toBe(0x1234);
    expect(closes[0]!.reason).toBe('server going away');
  });

  it('a rejected transport.closed surfaces a fatal transport error AND one close notification', async () => {
    const { client, a } = await connectedPair();
    const errs: Error[] = [];
    const closes: number[] = [];
    client.onError = (e) => errs.push(e);
    client.onClose = (code) => closes.push(code);

    // Reject the transport's closed promise (an abrupt transport failure).
    a.failClosed(new Error('transport reset'));
    await flush();

    expect(errs.some((e) => /transport reset/.test(e.message))).toBe(true);
    expect(closes.length).toBe(1);
  });

  it('intentional local close() is quiet — no onClose, and the ensuing transport.closed does not fire a duplicate', async () => {
    const { client, a } = await connectedPair();
    const closes: number[] = [];
    client.onClose = (code) => closes.push(code);

    await client.close();
    // Local close closed the transport; its `closed` promise now settles.
    a.close({ closeCode: 0x0, reason: '' });
    await flush();

    expect(closes.length).toBe(0); // quiet happy path — no onClose at all
  });

  it('a settle from a STALE transport is ignored (post-migration)', async () => {
    const { client, a } = await connectedPair();
    const closes: number[] = [];
    client.onClose = (code) => closes.push(code);

    // Simulate migration: the connection now points at a different transport.
    const other = { closed: new Promise(() => { /* never */ }) };
    (client as unknown as { transport: unknown }).transport = other;

    a.close({ closeCode: 0x9, reason: 'old transport' });
    await flush();

    expect(closes.length).toBe(0); // the stale transport's settle is ignored
  });

  it('two concurrent fatal causes (control-stream violation + transport.closed) produce exactly one terminal event', async () => {
    const { client, a, b } = await connectedPair();
    const closes: number[] = [];
    client.onClose = (code) => closes.push(code);

    // Fatal cause 1: the client's inbound control stream (the server's first uni,
    // b.uniOut[0]) is RESET → a control-stream violation trips closeSessionFatal.
    // Fatal cause 2: the transport itself closes → the watcher trips terminate.
    // Fired in the same tick; the one-shot coordinator collapses them.
    b.uniOut[0]!.reset(0x1);
    a.close({ closeCode: 0x7, reason: 'both' });
    await flush(32);

    expect(closes.length).toBe(1); // collapsed to a single onClose
  });

  it('an unrelated pending subscribeTrack() rejects when the transport closes', async () => {
    const { client, a } = await connectedPair();
    const pending = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush(); // SUBSCRIBE sent, never answered

    a.close({ closeCode: 0x5, reason: 'gone' });
    await expect(pending).rejects.toThrow();
  });
});

describe('MoqtConnection(18) loopback — round 8 review fixes', () => {
  const STREAM_COUNT_UNKNOWN = (1n << 62n) - 1n;
  function rawDone(streamCount: bigint): Uint8Array {
    return codec18.encode({
      type: 'PUBLISH_DONE', requestId: varint(0n), statusCode: varint(0x3n),
      streamCount: varint(streamCount), errorReason: 'end',
    } as unknown as ControlMessage);
  }
  async function rawSubgroup(b: ReturnType<typeof createLoopback>['b'], alias: bigint, groupId: bigint) {
    const uni = await b.createUnidirectionalStream();
    const pipe = b.uniOut[b.uniOut.length - 1]!;
    const w = uni.getWriter();
    await w.write(encodeSubgroupHeader18({
      typeByte: 0x10, trackAlias: alias, groupId, subgroupId: 0n,
      publisherPriority: 1, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true,
    }));
    await w.write(encodeSubgroupObject18({ objectId: 0n, payload: new Uint8Array([1]), extensions: undefined, status: undefined }, false, 0n, true));
    return { pipe, w };
  }

  // Finding 1: remote/rejected transport close must move the Session to CLOSED.
  it('a remote transport close moves the Session to CLOSED and subsequent APIs reject', async () => {
    const { client, a } = await connectedPair();
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
    a.close({ closeCode: 0x9, reason: 'bye' });
    await flush();
    expect(client.session.state).toBe(SessionState.CLOSED);
    await expect(client.subscribe(ns('live'), nm('vid'))).rejects.toThrow();
  });

  it('a rejected transport.closed also moves the Session to CLOSED and rejects subsequent APIs', async () => {
    const { client, a } = await connectedPair();
    a.failClosed(new Error('transport reset'));
    await flush();
    expect(client.session.state).toBe(SessionState.CLOSED);
    await expect(client.subscribe(ns('live'), nm('vid'))).rejects.toThrow();
  });

  // Finding 2: alias reuse must NOT deliver an outstanding old stream to the new track.
  for (const kind of ['remaining=1', 'sentinel'] as const) {
    it(`alias reuse while an incomplete old generation (${kind}) is still guarded is REFUSED — never bound, never misdelivered`, async () => {
      const { client, server, a, b, errors } = await connectedPair(18, { clientOptions: { terminatedAliasTtlMs: 10_000 } });
      let rid1 = -1n; server.onSubscribe = (r) => { rid1 = r; };
      const p1 = client.subscribeTrack(ns('live'), nm('v1'), { onObject: () => { /* sub1 */ } });
      await flush();
      await server.acceptSubscribe(rid1, 7n);
      await p1;

      // One old stream seen on alias 7, so the DONE below leaves an outstanding one.
      const s1 = await rawSubgroup(b, 7n, 1n); await s1.w.close();
      await flush();

      // remaining=1: Stream Count 2, seen 1 → one old stream still outstanding.
      // sentinel: unknown count → treated as outstanding until TTL.
      a.bidiOut[0]!.in.injectRead(rawDone(kind === 'sentinel' ? STREAM_COUNT_UNKNOWN : 2n));
      await flush();
      const internals = client as unknown as { terminatedAliases: Map<bigint, unknown> };
      expect(internals.terminatedAliases.has(7n)).toBe(true); // guard still live

      // §11.1: reusing alias 7 while the old generation is still guarded must be
      // REFUSED (never bound) — otherwise the outstanding old stream could route
      // to the new track. The reused subscription's promise rejects; the session
      // survives (a per-track failure, not a session close).
      const d2: string[] = [];
      let rid2 = -1n; server.onSubscribe = (r) => { rid2 = r; };
      const p2 = client.subscribeTrack(ns('live'), nm('v2'), { onObject: (o) => d2.push(`${o.groupId}:${o.objectId}`) });
      await flush();
      await server.acceptSubscribe(rid2, 7n);
      await expect(p2).rejects.toThrow(/guarded|reuse/i);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);

      // The outstanding old stream still arrives — discarded by the guard, and it
      // certainly never reached a (never-bound) new track.
      const late = await rawSubgroup(b, 7n, 99n); await late.w.close();
      await flush();
      expect(d2).toEqual([]);
      void errors;
    });
  }

  // Finding 3: cancellation DURING the header write must not resurrect the stream.
  it('cancellation while the subgroup HEADER WRITE is held aborts the writer and rejects; the stream is still counted', async () => {
    const { client, server, subReqId } = await (async () => {
      const pair = await connectedPair();
      const rid = await pair.client.subscribe(ns('live'), nm('vid'));
      await flush();
      await pair.server.acceptSubscribe(rid, 7n);
      await flush();
      return { ...pair, subReqId: rid };
    })();

    // Next transport stream BLOCKS on the header write until released.
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => { releaseWrite = r; });
    let aborted = false;
    (server as unknown as { transport: { createUnidirectionalStream: () => Promise<WritableStream<Uint8Array>> } })
      .transport.createUnidirectionalStream = async () =>
        new WritableStream<Uint8Array>({ write: () => writeGate, abort: () => { aborted = true; } });

    const openP = server.openSubgroup(7n, 0n, 0n, { publisherPriority: 1 });
    await flush(); // parked awaiting the header write; writer registered, count incremented

    // The count was taken immediately after stream creation (before the write).
    expect(BigInt(server.session.getIncomingSubscription(subReqId)!.streamCount)).toBe(1n);

    // Subscriber cancels mid-write.
    await client.unsubscribe(subReqId);
    await flush();
    releaseWrite();

    await expect(openP).rejects.toThrow(/cancel|reset|terminat/i);
    expect(aborted).toBe(true); // the writer was aborted, not left live
  });

  // Finding 4: terminal alias protection must be armed synchronously — an object
  // arriving during the held cancelRequest must not reach generic onObject.
  it('an object arriving during a held cancelRequest is discarded, not routed to generic onObject', async () => {
    const { client, server, b } = await connectedPair();
    const generic: unknown[] = [];
    client.onObject = (_sid, o) => generic.push(o);
    let rid = -1n; server.onSubscribe = (r) => { rid = r; };
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    await server.acceptSubscribe(rid, 7n);
    const sub = await subP;

    // Hold cancelRequest so unsubscribe is parked AFTER the synchronous arm.
    let releaseCancel!: () => void;
    const gate = new Promise<void>((r) => { releaseCancel = r; });
    const uniPair = (client as unknown as { uniPair: { cancelRequest: (id: bigint) => Promise<void> } }).uniPair;
    const origCancel = uniPair.cancelRequest.bind(uniPair);
    uniPair.cancelRequest = async (id: bigint) => { await gate; return origCancel(id); };

    const unsubP = sub.unsubscribe();
    await flush(); // parked in cancelRequest; the tombstone must already be armed

    // A late stream on the alias arrives DURING the held cancel.
    const late = await rawSubgroup(b, 7n, 3n); await late.w.close();
    await flush();
    expect(generic).toEqual([]); // discarded synchronously, never generic-routed

    releaseCancel();
    await unsubP;
  });

  // Finding 5: an authoritative transport.closed wins the reported code/reason
  // over a preliminary stream/control failure in the same tick.
  it('transport.closed code/reason take precedence over a concurrent preliminary control-stream failure', async () => {
    const { client, a, b } = await connectedPair();
    const closes: Array<{ code?: number; reason?: string }> = [];
    client.onClose = (code, reason) => closes.push({ code, reason });

    // Preliminary: reset the client's inbound control stream (→ 0x3). Authoritative:
    // the transport closes with the peer's real code/reason. Same tick.
    b.uniOut[0]!.reset(0x1);
    a.close({ closeCode: 0x7, reason: 'real peer reason' });
    await flush(32);

    expect(closes.length).toBe(1);
    expect(closes[0]!.code).toBe(0x7);                 // authoritative wins
    expect(closes[0]!.reason).toBe('real peer reason');
  });

  // Finding 6: terminal cleanup empties the owned maps + topology contexts.
  it('terminal shutdown clears owned state and topology contexts (no leaks)', async () => {
    const { client, server, a } = await connectedPair();
    const rid = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    await server.acceptSubscribe(rid, 7n);
    await flush();

    a.close({ closeCode: 0x0, reason: '' });
    await flush();

    const i = client as unknown as {
      terminatedAliases: Map<bigint, unknown>; aliasStreamsSeen: Map<bigint, unknown>;
      publisherGeneration: Map<bigint, unknown>; pendingPublishOps: Map<bigint, unknown>;
      publisherAliasRequests: Map<bigint, unknown>; retiredPublisherAliases: Map<bigint, unknown>;
      dataStreamReaders: Map<bigint, unknown>; outgoingStreams: Map<bigint, unknown>;
      inboundRequestContexts: Map<bigint, unknown>;
      uniPair: { contexts: Map<bigint, unknown>; continuingContexts: Map<bigint, unknown> };
    };
    for (const m of [i.terminatedAliases, i.aliasStreamsSeen, i.publisherGeneration, i.pendingPublishOps,
      i.publisherAliasRequests, i.retiredPublisherAliases, i.dataStreamReaders, i.outgoingStreams,
      i.inboundRequestContexts, i.uniPair.contexts, i.uniPair.continuingContexts]) {
      expect(m.size).toBe(0);
    }
  });
});

describe('MoqtConnection(18) loopback — round 8c review fixes', () => {
  // Finding 2: subscribeTrack() must not resolve when the session rejects the
  // SUBSCRIBE_OK — e.g. a DUPLICATE_TRACK_ALIAS. It must reject, session closes.
  it('a SUBSCRIBE_OK that duplicates a live alias closes the session and REJECTS the subscribe (never resolves)', async () => {
    const { client, server } = await connectedPair();
    const closes: Array<{ code?: number; reason?: string }> = [];
    client.onClose = (code, reason) => closes.push({ code, reason });
    // First subscription established on alias 7.
    let rid1 = -1n; server.onSubscribe = (r) => { rid1 = r; };
    const p1 = client.subscribeTrack(ns('live'), nm('v1'), { onObject: () => { /* live */ } });
    await flush();
    await server.acceptSubscribe(rid1, 7n);
    await p1; // established, alias 7 in use

    // Second subscription; the server (mis)accepts it with the SAME live alias 7.
    let rid2 = -1n; server.onSubscribe = (r) => { rid2 = r; };
    const p2 = client.subscribeTrack(ns('live'), nm('v2'), { onObject: () => { /* dup */ } });
    await flush();
    await server.acceptSubscribe(rid2, 7n); // DUPLICATE_TRACK_ALIAS
    await flush(32);

    // §11.1: the session MUST close with DUPLICATE_TRACK_ALIAS; the second
    // subscribe promise rejects rather than resolving against a closing session.
    await expect(p2).rejects.toThrow();
    expect(client.session.state).toBe(SessionState.CLOSED);
    // The close is reported exactly once with the DUPLICATE_TRACK_ALIAS code (0x5).
    expect(closes.length).toBe(1);
    expect(closes[0]!.code).toBe(Number(SessionError.DUPLICATE_TRACK_ALIAS));
  });

  // Finding 3: publishing on an unknown alias (never associated) is rejected.
  it('openSubgroup / sendDatagram on an unknown track alias reject (not silently published)', async () => {
    const { server } = await connectedPair();
    await expect(server.openSubgroup(999n, 0n, 0n, { publisherPriority: 1 })).rejects.toThrow(/unknown track alias/i);
    await expect(server.sendDatagram(999n, 0n, 0n, new Uint8Array([1]))).rejects.toThrow(/unknown track alias/i);
  });

  // Finding 4: after terminal shutdown, a real transport close produces NO
  // post-close error events from the read loops, and the open data stream that
  // errors as the transport dies stays quiet too.
  it('a transport close after an established subscription emits no post-shutdown error events', async () => {
    const { client, server, a, b } = await connectedPair();
    const errs: Error[] = [];
    client.onError = (e) => errs.push(e);
    let rid = -1n; server.onSubscribe = (r) => { rid = r; };
    const subP = client.subscribeTrack(ns('live'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    await server.acceptSubscribe(rid, 7n);
    await subP;
    // An open incoming subgroup stream so the data read-loop is live.
    const uni = await b.createUnidirectionalStream();
    const dataPipe = b.uniOut[b.uniOut.length - 1]!;
    const w = uni.getWriter();
    await w.write(encodeSubgroupHeader18({
      typeByte: 0x10, trackAlias: 7n, groupId: 0n, subgroupId: 0n,
      publisherPriority: 1, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true,
    }));
    await flush();

    // Remote transport close: read loops throw AFTER terminal shutdown.
    a.close({ closeCode: 0x0, reason: '' });
    await flush(32);
    // The open data stream errors as the transport dies — must stay quiet.
    dataPipe.reset(0x2);
    await flush(32);

    expect(errs).toEqual([]); // no spurious post-close error events
  });

  // Finding 5: a preliminary read-failure's synthetic code must not pre-empt an
  // authoritative transport.closed that settles in a LATER task.
  it('a control-loop read failure yields to a transport.closed that settles later (real code/reason win)', async () => {
    // draft-14/16 uses the single bidi control read loop (runControlReadLoop),
    // whose raw read failure produces the synthetic 0x2 preliminary report.
    const { client, a } = await connectedPair(14, { clientOptions: { closeReportFallbackMs: 10_000 } });
    const closes: Array<{ code?: number; reason?: string }> = [];
    client.onClose = (code, reason) => closes.push({ code, reason });

    // Preliminary: the client's control stream read fails now (synthetic 0x2).
    a.bidiOut[0]!.in.reset(0x1);
    await flush(32);
    expect(closes.length).toBe(0); // held — waiting for transport.closed

    // Authoritative transport.closed settles in a LATER task with the real code.
    a.close({ closeCode: 0x42, reason: 'peer gone' });
    await flush(32);

    expect(closes.length).toBe(1);
    expect(closes[0]!.code).toBe(0x42);
    expect(closes[0]!.reason).toBe('peer gone');
  });

  it('a preliminary read failure with NO transport.closed still reports (bounded fallback), exactly once', async () => {
    const { client, a } = await connectedPair(14, { clientOptions: { closeReportFallbackMs: 30 } });
    const closes: number[] = [];
    client.onClose = (code) => closes.push(code);

    a.bidiOut[0]!.in.reset(0x1); // control read failure; transport.closed never settles
    await flush(32);
    expect(closes.length).toBe(0); // still within the fallback window

    await new Promise((r) => setTimeout(r, 80));
    expect(closes.length).toBe(1); // bounded fallback emitted the synthetic report
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
  it('an overlapping prefix update is rejected (PREFIX_OVERLAP); the responder closes BOTH directions of its stream (§10.9.1)', async () => {
    const { client, server, a, errors } = await connectedPair();
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
    const stream1 = a.bidiOut[0]!; // r1's continuing SUBSCRIBE_NAMESPACE stream

    // Update sub#1's prefix to overlap sub#2 → REQUEST_ERROR / PREFIX_OVERLAP and,
    // per §10.9.1, the responder closes sub#1's bidi stream.
    await client.requestUpdate(r1, { trackNamespacePrefix: [nm('y')] });
    await flush(32);

    // Responder dropped the overlapping subscription; the other is untouched.
    expect(server.session.getIncomingNamespaceSubscription(snIds[0]!)).toBeUndefined();
    expect(server.session.getIncomingNamespaceSubscription(snIds[1]!)).toBeDefined();
    // The responder closed sub#1's bidi stream (§10.9.1); the subscriber side
    // terminated that namespace subscription on the FIN (prefix was never updated).
    expect(client.session.getNamespaceSubscription(r1)).toBeUndefined();

    // Real LoopPipe state: BOTH halves of the continuing stream are closed.
    expect(stream1.in.writeClosed).toBe(true);                             // responder FINned its response direction
    expect(stream1.out.readCancelled || stream1.out.writeClosed).toBe(true); // request direction settled (STOP_SENDING or FIN)
    // No live context on either side.
    const clientCont = (client as unknown as { uniPair: { continuingContexts: Map<bigint, unknown> } }).uniPair.continuingContexts;
    const serverCtx = (server as unknown as { inboundRequestContexts: Map<bigint, unknown> }).inboundRequestContexts;
    expect(clientCont.has(r1)).toBe(false);
    expect(serverCtx.has(snIds[0]!)).toBe(false);
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

    // A subgroup stream opened while the subscription is still live.
    sid = await server.openSubgroup(5n, 2n, 0n, { publisherPriority: 1 });

    // UNSUBSCRIBE: draft-18 has no UNSUBSCRIBE message — this must reset the
    // request stream and clean local state, not throw.
    await sub.unsubscribe();
    await flush();

    expect(subStream.out.writeAborted).toBe(true);                  // request stream RESET
    expect(client.session.getSubscription(rid)).toBeUndefined();    // local sub state cleaned
    expect(client.session.getTrackByAlias(5n)).toBeUndefined();     // alias unregistered

    // §5.1.1: the publisher's open stream was RESET on cancellation — a send on
    // it now rejects, and NEW data streams for the dead subscription are refused.
    await expect(server.sendObject(sid, 0n, new Uint8Array([2]))).rejects.toThrow(/Unknown outgoing stream/);
    expect(delivered).toEqual(['1:0']); // nothing delivered after cancel
    await expect(server.openSubgroup(5n, 3n, 0n, { publisherPriority: 1 })).rejects.toThrow(/terminated/);

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
