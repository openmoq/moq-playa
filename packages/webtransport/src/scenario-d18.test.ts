/**
 * draft-18 deterministic scenario suite (clean schedules).
 *
 * Drives the seeded {@link runScenario} runner over the full draft-18 op surface —
 * subscribe, FETCH, outbound PUBLISH, and continuing streams (SUBSCRIBE_NAMESPACE /
 * SUBSCRIBE_TRACKS) — asserting protocol + session invariants after every step and
 * at quiescence. Includes a same-seed determinism check and hand-authored preludes
 * (per family) for cases the random walk does not reliably hit.
 *
 * Default counts are bounded so `pnpm test` stays fast. A heavier soak is
 * env-gated: SCENARIO_SEEDS (count), SCENARIO_SEED_START (first seed),
 * SCENARIO_STEPS (steps per scenario), e.g.
 *   SCENARIO_SEEDS=2000 SCENARIO_STEPS=200 npx vitest run scenario-d18.test.ts
 */
import { describe, it, expect } from 'vitest';
import { SessionState, SubscriptionState, FetchState, NamespaceState, varint } from '@moqt/transport';
import type { MoqtObject, ControlMessage } from '@moqt/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { runScenario } from './testkit/scenario.js';

const SEEDS = Number(process.env.SCENARIO_SEEDS ?? 8);
const SEED_START = BigInt(process.env.SCENARIO_SEED_START ?? 1);
const STEPS = Number(process.env.SCENARIO_STEPS ?? 40);

describe('draft-18 scenario runner — clean schedules', () => {
  for (let i = 0; i < SEEDS; i++) {
    const seed = SEED_START + BigInt(i);
    it(`seed ${seed} holds all invariants over ${STEPS} steps`, async () => {
      const r = await runScenario({ seed, steps: STEPS }); // throws on any invariant violation
      expect(typeof r.hash).toBe('bigint');
      expect(r.log.length).toBeGreaterThan(0);
    });
  }

  it('the same seed produces the same trace hash (deterministic replay)', async () => {
    for (const seed of [SEED_START, SEED_START + 1n]) {
      const r1 = await runScenario({ seed, steps: STEPS });
      const r2 = await runScenario({ seed, steps: STEPS });
      expect(r2.hash).toBe(r1.hash);
      expect(r2.log.length).toBe(r1.log.length);
    }
  });
});

describe('draft-18 scenario preludes (hand-authored invariants)', () => {
  it('UNSUBSCRIBE: in-flight bytes may arrive, but the publisher\'s streams are reset and later sends reject (§5.1.1)', async () => {
    const { client, server, errors } = await connectedPair();
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const delivered: string[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), {
      onObject: (o) => delivered.push(`${o.groupId}:${o.objectId}`),
    });
    await flush();
    await server.acceptSubscribe(rid, 5n);
    const sub = await subP;

    let sid = await server.openSubgroup(5n, 1n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([1]));
    await server.closeSubgroup(sid);
    await flush();
    expect(delivered).toEqual(['1:0']);

    // Bytes written BEFORE cancellation are in flight — they may arrive.
    sid = await server.openSubgroup(5n, 2n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([2]));
    await flush();
    expect(delivered).toEqual(['1:0', '2:0']); // pre-cancel object delivered

    await sub.unsubscribe();
    await flush();
    expect(client.session.getSubscription(rid)).toBeUndefined(); // draft-18 deletes
    expect(client.session.getTrackByAlias(5n)).toBeUndefined();  // alias freed

    // §5.1.1: the publisher's open stream was RESET — a send on it now rejects,
    // and NEW data streams for the terminated subscription are refused too.
    await expect(server.sendObject(sid, 1n, new Uint8Array([3]))).rejects.toThrow(/Unknown outgoing stream/);
    await expect(server.openSubgroup(5n, 3n, 0n, { publisherPriority: 1 })).rejects.toThrow(/terminated/);
    expect(delivered).toEqual(['1:0', '2:0']); // nothing after cancel
    expect(errors).toEqual([]);
  });

  it('object delivered to an active subscription matches what was sent', async () => {
    const { client, server, errors } = await connectedPair();
    let rid = -1n;
    server.onSubscribe = (r) => { rid = r; };
    const delivered: string[] = [];
    const subP = client.subscribeTrack(ns('live'), nm('vid'), {
      onObject: (o) => delivered.push(`${o.groupId}:${o.objectId}`),
    });
    await flush();
    await server.acceptSubscribe(rid, 5n);
    await subP;

    const sid = await server.openSubgroup(5n, 1n, 0n, { publisherPriority: 1 });
    await server.sendObject(sid, 0n, new Uint8Array([1]));
    await server.closeSubgroup(sid);
    await flush();
    expect(delivered).toEqual(['1:0']);
    expect(client.session.getSubscription(rid)!.state).toBe(SubscriptionState.ESTABLISHED);
    expect(errors).toEqual([]);
  });

  it('request IDs are client-even and unique across many subscribes; reject leaves no ACTIVE state', async () => {
    const { client, server, errors } = await connectedPair();
    const seen: bigint[] = [];
    server.onSubscribe = (r) => { seen.push(r); };

    const promises = [0, 1, 2, 3, 4].map((i) =>
      client.subscribeTrack(ns(`n${i}`), nm(`t${i}`), { onObject: () => { /* none */ } }).catch(() => undefined),
    );
    await flush();
    // Client (even parity) allocates 0,2,4,6,8 in order; all distinct.
    expect(seen).toEqual([0n, 2n, 4n, 6n, 8n]);
    expect(new Set(seen).size).toBe(seen.length);

    // Reject one — neither side keeps it ESTABLISHED (the client promise rejects;
    // both may keep a TERMINATED tombstone rather than deleting).
    await server.rejectSubscribe(4n, 1n, 'no');
    await flush();
    const cReject = client.session.getSubscription(4n);
    const sReject = server.session.getIncomingSubscription(4n);
    expect(cReject === undefined || cReject.state !== SubscriptionState.ESTABLISHED).toBe(true);
    expect(sReject === undefined || sReject.state !== SubscriptionState.ESTABLISHED).toBe(true);

    // Accept the rest so the pending promises settle cleanly.
    for (const rid of [0n, 2n, 6n, 8n]) await server.acceptSubscribe(rid, rid + 100n);
    await Promise.all(promises);
    expect(errors).toEqual([]);
  });
});

describe('draft-18 fetch preludes (hand-authored invariants)', () => {
  it('fetch → accept → two objects + End-of-Range → exact ordered delivery via the fetch path', async () => {
    const { client, server, errors } = await connectedPair();
    let fetchRid = -1n;
    server.onFetch = (rid) => { fetchRid = rid; };
    // Fetch data arrives on the connection-level onObject (no alias routing);
    // correlate it to the fetch via the FETCH_HEADER seen on onDataStream.
    const recv: MoqtObject[] = [];
    const streamToReq = new Map<bigint, bigint>();
    client.onDataStream = (sid, h) => { if (h.type === 'fetch') streamToReq.set(sid, h.header.requestId as bigint); };
    client.onObject = (sid, o) => { if (streamToReq.get(sid) === fetchRid) recv.push(o); };

    const requestId = await client.fetch(ns('live'), nm('vid'), { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n });
    await flush();
    expect(requestId).toBe(0n); // client (even parity) first request
    expect(fetchRid).toBe(0n);

    await server.acceptFetch(fetchRid); // FETCH_OK on the same bidi request stream
    await flush();
    expect(client.session.getFetch(requestId)!.state).toBe(FetchState.TRANSFERRING);

    const sid = await server.openFetchStream(fetchRid);
    await server.sendFetchObject(sid, { groupId: 7000n, subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([0xa0]) });
    await server.sendFetchObject(sid, { groupId: 7000n, subgroupId: 0n, objectId: 1n, publisherPriority: 1, payload: new Uint8Array([0xa1]) });
    await server.sendFetchEndOfRange(sid, true, 8000n, 0n);
    await server.closeFetchStream(sid);
    await flush();

    // Both fetch objects delivered, in order, via the fetch path — plus the gap.
    const data = recv.filter((o) => o.kind === 'data');
    expect(data.map((o) => [o.groupId, o.objectId])).toEqual([[7000n, 0n], [7000n, 1n]]);
    expect(recv.some((o) => o.kind === 'gap')).toBe(true);
    // None of this rode an alias-based subscription (there are none here).
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('fetch cancel BEFORE FETCH_OK resets the request stream and settles cleanly — no onError', async () => {
    const { client, server, a, errors } = await connectedPair();
    let fetchRid = -1n;
    server.onFetch = (rid) => { fetchRid = rid; };

    const requestId = await client.fetch(ns('live'), nm('vid'), { startGroup: 0n, startObject: 0n });
    await flush();
    expect(fetchRid).toBe(0n);

    // Cancel before the server responds — draft-18 has no FETCH_CANCEL; this is a
    // local STOP_SENDING + RESET_STREAM on the bidi request stream (§3.3.2), which
    // the response handler treats as a local cancel (no onError, no unhandled reject).
    await client.fetchCancel(requestId);
    await flush();
    expect(a.bidiOut[0]!.out.writeAborted).toBe(true); // fetch request stream RESET
    const cf = client.session.getFetch(requestId);
    expect(cf === undefined || cf.state !== FetchState.TRANSFERRING).toBe(true); // torn down
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED); // session unaffected
  });

  it('fetch cancel AFTER data starts suppresses late fetch data; no onError, no session close', async () => {
    const { client, server, a, errors } = await connectedPair();
    let fetchRid = -1n;
    server.onFetch = (rid) => { fetchRid = rid; };
    const recv: MoqtObject[] = [];
    const streamToReq = new Map<bigint, bigint>();
    client.onDataStream = (sid, h) => { if (h.type === 'fetch') streamToReq.set(sid, h.header.requestId as bigint); };
    client.onObject = (sid, o) => { if (streamToReq.get(sid) === fetchRid) recv.push(o); };

    const requestId = await client.fetch(ns('live'), nm('vid'), { startGroup: 0n, startObject: 0n });
    await flush();
    await server.acceptFetch(fetchRid);
    await flush();
    const sid = await server.openFetchStream(fetchRid);

    // One object is delivered through the fetch path.
    await server.sendFetchObject(sid, { groupId: 7000n, subgroupId: 0n, objectId: 0n, publisherPriority: 1, payload: new Uint8Array([0xa0]) });
    await flush();
    expect(recv.length).toBe(1);

    // Cancel mid-stream: draft-18 RESETs the bidi request stream and STOP_SENDINGs
    // the open fetch data stream (§3.3.2).
    await client.fetchCancel(requestId);
    await flush();
    expect(a.bidiOut[0]!.out.writeAborted).toBe(true);             // request stream RESET
    expect(errors).toEqual([]);                                    // local cancel — no onError
    expect(client.session.state).toBe(SessionState.ESTABLISHED);   // session unaffected

    // §10.13: the peer's FETCH request-stream reset reached the server, whose
    // inbound-close path ABORTED its open response stream. A further sendFetchObject
    // on it now rejects — the publisher can no longer push unsolicited fetch data —
    // and either way the late object MUST NOT reach the client.
    let sendThrew = false;
    try {
      await server.sendFetchObject(sid, { groupId: 7000n, subgroupId: 0n, objectId: 1n, publisherPriority: 1, payload: new Uint8Array([0xa1]) });
    } catch {
      sendThrew = true; // the response stream was aborted by the inbound FETCH close
    }
    await flush();

    expect(recv.length).toBe(1);                                   // late fetch data NOT delivered
    expect(sendThrew).toBe(true);                                  // server response stream aborted on cancel
    expect(errors).toEqual([]);                                    // still no onError
    expect(client.session.state).toBe(SessionState.ESTABLISHED);   // still no session close
    const cf = client.session.getFetch(requestId);
    expect(cf === undefined || cf.state !== FetchState.TRANSFERRING).toBe(true); // torn down
  });

  // Note: "fetch data on a FETCH_HEADER for an unknown Request ID → PROTOCOL_VIOLATION
  // close" is already covered by adapter-d18-data.test.ts ("raises a protocol violation
  // on a FETCH_HEADER for an unknown Request ID"); not duplicated here.
});

describe('draft-18 publish preludes (hand-authored invariants)', () => {
  it('publish → accept → object → peer receives via IncomingPublish.onObject (not generic onObject)', async () => {
    const { client, server, errors } = await connectedPair();
    let pubReqId = -1n;
    const recv: MoqtObject[] = [];
    const generic: MoqtObject[] = [];
    server.onPublish = (p) => { pubReqId = p.requestId; p.onObject = (o) => recv.push(o); };
    server.onObject = (_sid, o) => generic.push(o); // leak detector: must stay empty

    const requestId = await client.publish(ns('live'), nm('vid'), 500000n);
    await flush();
    expect(requestId).toBe(0n); // client (even parity) first request
    expect(pubReqId).toBe(0n);

    await server.acceptSubscribe(pubReqId, 500000n); // PUBLISH_OK shorthand (§10.10)
    await flush();
    expect(client.session.getOutgoingPublish(requestId)!.state).toBe(SubscriptionState.ESTABLISHED);

    const sid = await client.openSubgroup(500000n, 1n, 0n, { publisherPriority: 1 });
    await client.sendObject(sid, 0n, new Uint8Array([0xb0]));
    await client.closeSubgroup(sid);
    await flush();

    const data = recv.filter((o) => o.kind === 'data');
    expect(data.map((o) => [o.groupId, o.objectId])).toEqual([[1n, 0n]]); // delivered to the publish path
    expect(generic).toEqual([]);                                          // NOT to generic onObject
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('publish → reject → only that publish terminates; no session close', async () => {
    const { client, server, errors } = await connectedPair();
    let pubReqId = -1n;
    server.onPublish = (p) => { pubReqId = p.requestId; };
    const requestId = await client.publish(ns('live'), nm('vid'), 500001n);
    await flush();

    await server.rejectSubscribe(pubReqId, 1n, 'no'); // PUBLISH rejection (REQUEST_ERROR)
    await flush();
    expect(client.session.getOutgoingPublish(requestId)).toBeUndefined(); // this publish terminated
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED); // session unaffected
  });

  it('publishDone terminates the publisher state and the peer sees PUBLISH_DONE on the same stream', async () => {
    const { client, server, errors } = await connectedPair();
    let pubReqId = -1n;
    const recv: MoqtObject[] = [];
    const serverMsgs: ControlMessage[] = [];
    server.onPublish = (p) => { pubReqId = p.requestId; p.onObject = (o) => recv.push(o); };
    server.onMessage = (m) => serverMsgs.push(m);

    const requestId = await client.publish(ns('live'), nm('vid'), 500002n);
    await flush();
    await server.acceptSubscribe(pubReqId, 500002n);
    await flush();

    const sid = await client.openSubgroup(500002n, 1n, 0n, { publisherPriority: 1 });
    await client.sendObject(sid, 0n, new Uint8Array([0x01]));
    await client.closeSubgroup(sid);
    await flush();
    expect(recv.length).toBe(1);

    await client.publishDone(requestId, varint(0n), 'done');
    await flush();
    expect(serverMsgs.some((m) => m.type === 'PUBLISH_DONE')).toBe(true);          // peer saw PUBLISH_DONE
    expect(client.session.getOutgoingPublish(requestId)).toBeUndefined();          // publisher state removed
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('PUBLISH_DONE is terminal for the publish alias: refused while a stream is open, and no new streams after (§10.11)', async () => {
    const { client, server, errors } = await connectedPair();
    let pubReqId = -1n;
    const recv: MoqtObject[] = [];
    server.onPublish = (p) => { pubReqId = p.requestId; p.onObject = (o) => recv.push(o); };

    const requestId = await client.publish(ns('live'), nm('vid'), 500003n);
    await flush();
    await server.acceptSubscribe(pubReqId, 500003n);
    await flush();
    const sid = await client.openSubgroup(500003n, 1n, 0n, { publisherPriority: 1 });
    await client.sendObject(sid, 0n, new Uint8Array([0x01]));
    await flush();
    expect(recv.length).toBe(1);

    // §10.11: the terminal message carries the total Stream Count — it is
    // refused while this subscription's data streams remain open…
    await expect(client.publishDone(requestId, varint(0n), 'early')).rejects.toThrow(/open/);
    await client.closeSubgroup(sid);
    await client.publishDone(requestId, varint(0n), 'done');
    await flush();
    // …and after termination the alias accepts no further data streams.
    await expect(client.openSubgroup(500003n, 2n, 0n, { publisherPriority: 1 })).rejects.toThrow(/terminated/);
    expect(recv.length).toBe(1);
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  // Note: "peer REQUEST_UPDATE (FORWARD=0) on an accepted PUBLISH stream → publisher
  // applies it + answers REQUEST_OK on the same stream" is already covered by
  // adapter-d18-loopback.test.ts; not duplicated here.
});

describe('draft-18 continuing-stream preludes (hand-authored invariants)', () => {
  it('subscribeNamespace → accept → NAMESPACE → NAMESPACE_DONE terminates the subscription (§6.1)', async () => {
    const { client, server, errors } = await connectedPair();
    let snReqId = -1n;
    server.onSubscribeNamespace = (rid) => { snReqId = rid; };
    const recv: ControlMessage[] = [];
    client.onNamespaceMessage = (_rid, m) => recv.push(m);

    const reqId = await client.subscribeNamespace(ns('a'));
    await flush();
    expect(snReqId).toBe(0n);
    await server.acceptSubscribeNamespace(snReqId);
    await flush();
    expect(client.session.getNamespaceSubscription(reqId)!.state).toBe(NamespaceState.ACTIVE);

    await server.sendNamespace(snReqId, [nm('s1')]); // announce on the continuing stream
    await flush();
    expect(recv.filter((m) => m.type === 'NAMESPACE').length).toBe(1);

    // §6.1: NAMESPACE_DONE for an announced suffix TERMINATES the subscriber's
    // namespace subscription (it is not a per-suffix withdrawal at the sub level).
    await server.sendNamespaceDone(snReqId, [nm('s1')]);
    await flush();
    expect(recv.some((m) => m.type === 'NAMESPACE_DONE')).toBe(true);
    const cs = client.session.getNamespaceSubscription(reqId);
    expect(cs === undefined || cs.state === NamespaceState.TERMINATED).toBe(true);
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('subscribeNamespace prefix REQUEST_UPDATE applies on both sides; a later NAMESPACE rides the same stream', async () => {
    const { client, server, a, errors } = await connectedPair();
    let snReqId = -1n;
    server.onSubscribeNamespace = (rid) => { snReqId = rid; };
    const recv: ControlMessage[] = [];
    client.onNamespaceMessage = (_rid, m) => recv.push(m);

    const reqId = await client.subscribeNamespace(ns('a'));
    await flush();
    await server.acceptSubscribeNamespace(snReqId);
    await flush();
    expect(client.session.getNamespaceSubscription(reqId)!.namespacePrefix).toEqual([nm('a')]);

    const bidiBefore = a.bidiOut.length;
    await client.requestUpdate(reqId, { trackNamespacePrefix: [nm('a'), nm('b')] });
    await flush();
    expect(a.bidiOut.length).toBe(bidiBefore); // rode the existing continuing stream
    expect(client.session.getNamespaceSubscription(reqId)!.namespacePrefix).toEqual([nm('a'), nm('b')]);
    expect(server.session.getIncomingNamespaceSubscription(snReqId)!.namespacePrefix).toEqual([nm('a'), nm('b')]);

    // A NAMESPACE after the update still rides the same stream and is delivered.
    await server.sendNamespace(snReqId, [nm('s1')]);
    await flush();
    expect(recv.filter((m) => m.type === 'NAMESPACE').length).toBe(1);
    expect(errors).toEqual([]);
  });

  it('subscribeTracks → accept → PUBLISH_BLOCKED reaches the matching subscription', async () => {
    const { client, server, errors } = await connectedPair();
    let stReqId = -1n;
    server.onSubscribeTracks = (rid) => { stReqId = rid; };
    const blocked: ControlMessage[] = [];
    client.onPublishBlocked = (_rid, m) => blocked.push(m);

    const reqId = await client.subscribeTracks(ns('a'));
    await flush();
    expect(stReqId).toBe(0n);
    await server.acceptSubscribeTracks(stReqId);
    await flush();
    expect(client.session.getTrackSubscription(reqId)!.state).toBe('active');

    await server.sendPublishBlocked(stReqId, [nm('s1')], nm('t1'));
    await flush();
    expect(blocked.length).toBe(1);                                          // delivered to onPublishBlocked
    expect(client.session.getTrackSubscription(reqId)!.blockedTracks.length).toBe(1); // recorded on the sub
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('cancelNamespace closes the continuing stream and suppresses late NAMESPACE delivery', async () => {
    const { client, server, errors } = await connectedPair();
    let snReqId = -1n;
    server.onSubscribeNamespace = (rid) => { snReqId = rid; };
    const recv: ControlMessage[] = [];
    client.onNamespaceMessage = (_rid, m) => recv.push(m);

    const reqId = await client.subscribeNamespace(ns('a'));
    await flush();
    await server.acceptSubscribeNamespace(snReqId);
    await flush();
    await server.sendNamespace(snReqId, [nm('s1')]);
    await flush();
    expect(recv.length).toBe(1);

    await client.cancelNamespace(reqId); // close the continuing request stream
    await flush();
    const cs = client.session.getNamespaceSubscription(reqId);
    expect(cs === undefined || cs.state === NamespaceState.TERMINATED).toBe(true);

    // The peer attempts a late NAMESPACE on the cancelled stream — must NOT deliver.
    try { await server.sendNamespace(snReqId, [nm('s2')]); } catch { /* server may observe the close */ }
    await flush();
    expect(recv.length).toBe(1); // late continuation suppressed
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });

  it('cancelTracks closes the continuing stream and suppresses late PUBLISH_BLOCKED delivery', async () => {
    const { client, server, errors } = await connectedPair();
    let stReqId = -1n;
    server.onSubscribeTracks = (rid) => { stReqId = rid; };
    const blocked: ControlMessage[] = [];
    client.onPublishBlocked = (_rid, m) => blocked.push(m);

    const reqId = await client.subscribeTracks(ns('a'));
    await flush();
    await server.acceptSubscribeTracks(stReqId);
    await flush();
    await server.sendPublishBlocked(stReqId, [nm('s1')], nm('t1'));
    await flush();
    expect(blocked.length).toBe(1);

    await client.cancelTracks(reqId); // close the continuing request stream
    await flush();
    const ts = client.session.getTrackSubscription(reqId);
    expect(ts === undefined || ts.state === 'terminated').toBe(true); // session state cleaned

    try { await server.sendPublishBlocked(stReqId, [nm('s2')], nm('t2')); } catch { /* server may observe the close */ }
    await flush();
    expect(blocked.length).toBe(1); // late continuation suppressed
    expect(errors).toEqual([]);
    expect(client.session.state).toBe(SessionState.ESTABLISHED);
  });
});
