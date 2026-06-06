/**
 * UniPairTopology — draft-18 control + request streams, exercised with the
 * deterministic stream simulator (no timers, no races).
 */
import { describe, it, expect } from 'vitest';
import { createUniPairTopology, RequestGoawayError } from './uni-pair.js';
import { TransportSim, flush } from '../testkit/stream-sim.js';
import {
  Session, EndpointRole, SessionState, SubscriptionState, createControlCodec, varint,
} from '@moqt/transport';
import type { Setup, SubscribeOk, RequestOk, RequestErrorMsg, Subscribe, FetchOk, Namespace, NamespaceDone, Goaway, ControlMessage, DecodedControlMessage, SendControlAction, OpenNamespaceStreamAction, RequestResult } from '@moqt/transport';

const codec18 = createControlCodec(18);
const setupBytes = (): Uint8Array => codec18.encode({ type: 'SETUP', setupOptions: new Map() });
const okBytes = (alias: bigint): Uint8Array =>
  codec18.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: alias, parameters: new Map(), trackExtensions: new Map() } as SubscribeOk);
const reqOkBytes = (): Uint8Array => codec18.encode({ type: 'REQUEST_OK', requestId: 0n, parameters: new Map() } as RequestOk);
function updateMessage(session: Session, existingRequestId: bigint): ControlMessage {
  const r = session.requestUpdate(existingRequestId, { forward: false });
  return (r.actions.find((a) => a.type === 'send_control') as SendControlAction).message;
}
const errBytes = (): Uint8Array =>
  codec18.encode({ type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(1n), retryInterval: varint(0n), errorReason: 'no' } as RequestErrorMsg);
const reqUpdateBytes = (updateId: bigint): Uint8Array =>
  codec18.encode({ type: 'REQUEST_UPDATE', requestId: updateId, parameters: new Map() } as never);
const subBytes = (): Uint8Array =>
  codec18.encode({ type: 'SUBSCRIBE', requestId: 0n, trackNamespace: [new Uint8Array([1])], trackName: new Uint8Array([2]), parameters: new Map() } as Subscribe);
const fetchOkBytes = (): Uint8Array =>
  codec18.encode({ type: 'FETCH_OK', requestId: 0n, endOfTrack: 0, endLocation: { group: 9n, object: 0n }, parameters: new Map(), trackExtensions: new Map() } as FetchOk);
const fetchRange = { startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n) };

function established(): Session {
  const s = new Session(EndpointRole.CLIENT, 18);
  s.initiateSetup();
  s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
  return s;
}
const nsBytes = (suffix: string): Uint8Array =>
  codec18.encode({ type: 'NAMESPACE', trackNamespaceSuffix: [new TextEncoder().encode(suffix)] } as Namespace);
const nsDoneBytes = (suffix: string): Uint8Array =>
  codec18.encode({ type: 'NAMESPACE_DONE', trackNamespaceSuffix: [new TextEncoder().encode(suffix)] } as NamespaceDone);
function nsRequestMessage(r: RequestResult): ControlMessage {
  return (r.actions.find((a) => a.type === 'open_namespace_stream') as OpenNamespaceStreamAction).message;
}
function reqMessage(r: RequestResult): ControlMessage {
  return (r.actions.find((a) => a.type === 'send_control') as SendControlAction).message;
}
const ns = (s: string) => [new TextEncoder().encode(s)];
const nm = (s: string) => new TextEncoder().encode(s);

describe('UniPairTopology — control handshake', () => {
  it('sends SETUP on the uni control stream, reads peer SETUP, reaches ESTABLISHED', async () => {
    const client = new Session(EndpointRole.CLIENT, 18);
    const topo = createUniPairTopology(client);
    const transport = new TransportSim();
    transport.openIncomingUni().push(setupBytes()); // control stream stays open (§3.3)

    await topo.establish(transport);

    expect(client.state).toBe(SessionState.ESTABLISHED);
    expect(transport.uniOut[0]!.writtenBytes()[0]).toBe(0xaf); // vi64(0x2F00)
    expect(transport.uniOut[0]!.writeClosed).toBe(false); // control stream stays open
  });

  it('rejects a non-SETUP first message on the control stream', async () => {
    const client = new Session(EndpointRole.CLIENT, 18);
    const topo = createUniPairTopology(client);
    const transport = new TransportSim();
    transport.pushIncomingUni(subBytes());
    await expect(topo.establish(transport)).rejects.toThrow(/expected SETUP/i);
  });
});

describe('UniPairTopology — request streams (SUBSCRIBE)', () => {
  it('openRequest derives requestId from the message and resolves after the SUBSCRIBE is sent', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const a = session.subscribe(ns('a'), nm('1'));
    const handle = await topo.openRequest(transport, reqMessage(a)); // resolves BEFORE any response

    expect(handle.requestId).toBe(a.requestId); // single source of truth
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x03); // SUBSCRIBE written
    expect(transport.bidi[0]!.writeClosed).toBe(false); // request stream kept open
  });

  it('response resolves with the stamped SUBSCRIBE_OK; the caller drives session handling', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const a = session.subscribe(ns('a'), nm('1'));
    const handle = await topo.openRequest(transport, reqMessage(a));
    transport.bidi[0]!.push(okBytes(10n)).closeReadable();

    const response = await handle.response;
    expect(response.type).toBe('SUBSCRIBE_OK');
    // The topology does NOT swallow the response — the caller routes it.
    session.handleControlMessage(response, { requestId: handle.requestId });
    expect(session.getSubscription(a.requestId)?.state).toBe(SubscriptionState.ESTABLISHED);
    expect(session.getSubscription(a.requestId)?.trackAlias).toBe(10n);
  });

  it('two concurrent SUBSCRIBEs open two streams; reverse-order responses resolve the right pending request', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const a = session.subscribe(ns('a'), nm('1')); // requestId 0
    const b = session.subscribe(ns('b'), nm('2')); // requestId 2
    const hA = await topo.openRequest(transport, reqMessage(a));
    const hB = await topo.openRequest(transport, reqMessage(b));
    expect(transport.bidi.length).toBe(2);

    // Respond in REVERSE order: B first, then A.
    transport.bidi[1]!.push(okBytes(20n)).closeReadable();
    transport.bidi[0]!.push(okBytes(10n)).closeReadable();
    const [rA, rB] = await Promise.all([hA.response, hB.response]);
    session.handleControlMessage(rA, { requestId: hA.requestId });
    session.handleControlMessage(rB, { requestId: hB.requestId });

    expect(session.getSubscription(a.requestId)?.trackAlias).toBe(10n);
    expect(session.getSubscription(b.requestId)?.trackAlias).toBe(20n);
  });

  it('handles a response fragmented across reads', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const a = session.subscribe(ns('a'), nm('1'));
    const handle = await topo.openRequest(transport, reqMessage(a));

    const ok = okBytes(7n);
    transport.bidi[0]!.push(ok.subarray(0, 1)); // first byte only
    await flush();
    transport.bidi[0]!.push(ok.subarray(1)).closeReadable(); // remainder
    const response = await handle.response;

    session.handleControlMessage(response, { requestId: handle.requestId });
    expect(session.getSubscription(a.requestId)?.trackAlias).toBe(7n);
  });

  it('REQUEST_ERROR resolves its own response; routed to the session it fails only that request', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const a = session.subscribe(ns('a'), nm('1'));
    const b = session.subscribe(ns('b'), nm('2'));
    const hA = await topo.openRequest(transport, reqMessage(a));
    const hB = await topo.openRequest(transport, reqMessage(b));

    transport.bidi[0]!.push(errBytes()).closeReadable(); // A errors
    transport.bidi[1]!.push(okBytes(20n)).closeReadable(); // B ok
    const [rA, rB] = await Promise.all([hA.response, hB.response]);
    expect(rA.type).toBe('REQUEST_ERROR');
    expect(rB.type).toBe('SUBSCRIBE_OK');
    session.handleControlMessage(rA, { requestId: hA.requestId });
    session.handleControlMessage(rB, { requestId: hB.requestId });

    expect(session.getSubscription(a.requestId)?.state).not.toBe(SubscriptionState.ESTABLISHED);
    expect(session.getSubscription(b.requestId)?.state).toBe(SubscriptionState.ESTABLISHED);
  });

  it('enforces SUBSCRIBE_OK / REQUEST_ERROR as the SUBSCRIBE response', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const a = session.subscribe(ns('a'), nm('1'));
    const handle = await topo.openRequest(transport, reqMessage(a));
    transport.bidi[0]!.push(subBytes()).closeReadable(); // wrong: SUBSCRIBE, not a response
    await expect(handle.response).rejects.toThrow(/expected SUBSCRIBE_OK/i);
  });

  it('rejects a REQUEST_OK as the response to SUBSCRIBE', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const a = session.subscribe(ns('a'), nm('1'));
    const handle = await topo.openRequest(transport, reqMessage(a));
    transport.bidi[0]!.push(reqOkBytes()).closeReadable(); // REQUEST_OK is not valid for SUBSCRIBE
    await expect(handle.response).rejects.toThrow(/expected SUBSCRIBE_OK/i);
  });

  it('rejects a SUBSCRIBE_OK as the response to REQUEST_UPDATE', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const a = session.subscribe(ns('a'), nm('1'));
    const sh = await topo.openRequest(transport, reqMessage(a));
    transport.bidi[0]!.push(okBytes(10n)); // resolve the SUBSCRIBE (keep stream open)
    session.handleControlMessage(await sh.response, { requestId: a.requestId }); // establish
    const uh = await topo.sendUpdate(a.requestId, updateMessage(session, a.requestId));
    transport.bidi[0]!.push(okBytes(20n)).closeReadable(); // SUBSCRIBE_OK is wrong for an update
    await expect(uh.response).rejects.toThrow(/expected REQUEST_OK/i);
  });

  it('overlapping updates: two REQUEST_UPDATEs queued, two REQUEST_OKs resolve them in order', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const a = session.subscribe(ns('a'), nm('1'));
    const sh = await topo.openRequest(transport, reqMessage(a));
    transport.bidi[0]!.push(okBytes(10n));
    session.handleControlMessage(await sh.response, { requestId: a.requestId }); // establish

    const u1 = await topo.sendUpdate(a.requestId, updateMessage(session, a.requestId)); // id 2
    const u2 = await topo.sendUpdate(a.requestId, updateMessage(session, a.requestId)); // id 4
    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(reqOkBytes()).closeReadable();
    await Promise.all([u1.response, u2.response]); // both REQUEST_OK, resolved FIFO
    expect(u1.requestId).toBe(2n);
    expect(u2.requestId).toBe(4n);
  });

  it('a stale unsolicited response is surfaced via onStreamError and reclaims the stream', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const errors: Error[] = [];
    topo.onStreamError = (e) => errors.push(e);
    const a = session.subscribe(ns('a'), nm('1'));
    const sh = await topo.openRequest(transport, reqMessage(a));
    transport.bidi[0]!.push(okBytes(10n));
    session.handleControlMessage(await sh.response, { requestId: a.requestId }); // establish
    await flush();

    // Peer sends an EXTRA response with no pending request → unsolicited → stream fails.
    transport.bidi[0]!.push(reqOkBytes());
    await flush();

    // The failure is surfaced immediately, and the failed stream is reclaimed (no leak),
    // so a later update finds no open stream — it never picks up the stale response.
    expect(errors.some((e) => /unsolicited/i.test(e.message))).toBe(true);
    expect(topo.hasRequestStream(a.requestId)).toBe(false);
    await expect(topo.sendUpdate(a.requestId, updateMessage(session, a.requestId))).rejects.toThrow(/no open request stream/i);
  });

  it('rejects a request type that cannot open a stream (e.g. REQUEST_UPDATE)', async () => {
    const topo = createUniPairTopology(established());
    // REQUEST_UPDATE rides an EXISTING stream (sendUpdate), not a new one.
    const update = { type: 'REQUEST_UPDATE', requestId: 0n } as unknown as ControlMessage;
    await expect(topo.openRequest(new TransportSim(), update)).rejects.toThrow(/SUBSCRIBE\/FETCH/i);
  });
});

describe('UniPairTopology — request streams (FETCH)', () => {
  it('FETCH opens its own bidi stream and resolves on the stamped FETCH_OK', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const f = session.fetch(ns('a'), nm('1'), fetchRange);
    const handle = await topo.openRequest(transport, reqMessage(f));
    expect(handle.requestId).toBe(f.requestId);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x16); // FETCH written

    transport.bidi[0]!.push(fetchOkBytes()).closeReadable();
    const response = await handle.response;
    expect(response.type).toBe('FETCH_OK');
    // Response omits the Request ID on the wire (caller stamps from stream ctx).
    expect((response as { requestId?: bigint }).requestId).toBeUndefined();
  });

  it('rejects a SUBSCRIBE_OK as the response to a FETCH', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const errors: Error[] = [];
    topo.onStreamError = (e) => errors.push(e);

    const f = session.fetch(ns('a'), nm('1'), fetchRange);
    const handle = await topo.openRequest(transport, reqMessage(f));
    transport.bidi[0]!.push(okBytes(1n)).closeReadable();

    await expect(handle.response).rejects.toThrow(/FETCH_OK\/REQUEST_ERROR/i);
    await flush();
    expect(errors.some((e) => /FETCH_OK\/REQUEST_ERROR/i.test(e.message))).toBe(true);
  });
});

describe('UniPairTopology — request streams (TRACK_STATUS, §10.14)', () => {
  it('opens its own stream, FINs our writable (one-shot), and resolves on REQUEST_OK', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const t = session.trackStatus(ns('a'), nm('1'));
    const handle = await topo.openRequest(transport, reqMessage(t));
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x0d); // TRACK_STATUS written
    expect(transport.bidi[0]!.writeClosed).toBe(true); // one-shot → writable FIN

    transport.bidi[0]!.push(reqOkBytes()).closeReadable();
    const response = await handle.response;
    expect(response.type).toBe('REQUEST_OK');
    expect((response as { requestId?: bigint }).requestId).toBeUndefined();
  });

  it('rejects a SUBSCRIBE_OK as the response to TRACK_STATUS', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const t = session.trackStatus(ns('a'), nm('1'));
    const handle = await topo.openRequest(transport, reqMessage(t));
    transport.bidi[0]!.push(okBytes(1n)).closeReadable();

    await expect(handle.response).rejects.toThrow(/REQUEST_OK\/REQUEST_ERROR/i);
  });
});

describe('UniPairTopology — request streams (PUBLISH_NAMESPACE, §10.15)', () => {
  it('opens its own stream and does NOT FIN our writable (not one-shot — §10.9/§3.3.2)', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const p = session.publishNamespace(ns('a'));
    const handle = await topo.openRequest(transport, reqMessage(p));
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x06); // PUBLISH_NAMESPACE
    expect(transport.bidi[0]!.writeClosed).toBe(false); // NOT one-shot → writable stays open

    transport.bidi[0]!.push(reqOkBytes());
    const response = await handle.response;
    expect(response.type).toBe('REQUEST_OK');
  });

  it('leaves the request stream context OPEN after REQUEST_OK (for REQUEST_UPDATE / withdrawal)', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const p = session.publishNamespace(ns('a'));
    const handle = await topo.openRequest(transport, reqMessage(p));
    transport.bidi[0]!.push(reqOkBytes());
    await handle.response;
    await flush();

    expect(topo.hasRequestStream(handle.requestId)).toBe(true); // still available
  });

  it('withdrawal cancels the request stream (RESET_STREAM + STOP_SENDING) and drops the context', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const p = session.publishNamespace(ns('a'));
    const handle = await topo.openRequest(transport, reqMessage(p));
    transport.bidi[0]!.push(reqOkBytes());
    await handle.response;

    await topo.cancelRequest(handle.requestId);
    expect(transport.bidi[0]!.readCancelled).toBe(true);  // STOP_SENDING
    expect(transport.bidi[0]!.writeAborted).toBe(true);   // RESET_STREAM
    expect(topo.hasRequestStream(handle.requestId)).toBe(false);
  });
});

describe('UniPairTopology — cancelRequest (§3.3.2)', () => {
  it('cancels the readable, aborts the writable, drops the context, and does not fire onStreamError', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const errors: Error[] = [];
    topo.onStreamError = (e) => errors.push(e);

    const f = session.fetch(ns('a'), nm('1'), fetchRange);
    const handle = await topo.openRequest(transport, reqMessage(f));
    void handle.response.catch(() => {}); // the owner (adapter) always handles this
    expect(topo.hasRequestStream(handle.requestId)).toBe(true);

    await topo.cancelRequest(handle.requestId);

    expect(transport.bidi[0]!.readCancelled).toBe(true);  // STOP_SENDING
    expect(transport.bidi[0]!.writeAborted).toBe(true);   // RESET_STREAM
    expect(topo.hasRequestStream(handle.requestId)).toBe(false);
    await flush();
    expect(errors).toEqual([]); // a local cancel is not a stream failure
  });

  it('rejects a pending response with RequestCancelledError', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();

    const f = session.fetch(ns('a'), nm('1'), fetchRange);
    const handle = await topo.openRequest(transport, reqMessage(f));
    const rejection = expect(handle.response).rejects.toThrow(/cancelled/i);
    await topo.cancelRequest(handle.requestId);
    await rejection;
  });

  it('cancelRequest for an unknown request is a no-op', async () => {
    const topo = createUniPairTopology(established());
    await expect(topo.cancelRequest(999n)).resolves.toBeUndefined();
  });
});

describe('UniPairTopology — continuing request stream (SUBSCRIBE_NAMESPACE, §10.18)', () => {
  type Seen = { kind: 'first' | 'continuation'; type: string };
  function open(session = established()) {
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const seen: Seen[] = [];
    const sn = session.subscribeNamespace([new Uint8Array([1])]);
    const p = topo.openContinuingRequest(transport, nsRequestMessage(sn), (_rid, msg: DecodedControlMessage, kind) => {
      seen.push({ kind, type: msg.type });
    });
    return { topo, transport, seen, p, requestId: sn.requestId };
  }

  it('dispatches the first REQUEST_OK then follow-up NAMESPACE/NAMESPACE_DONE in order', async () => {
    const { topo, transport, seen, p, requestId } = open();
    const handle = await p;
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x50); // SUBSCRIBE_NAMESPACE
    expect(topo.hasContinuingRequest(requestId)).toBe(true);

    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(nsBytes('s1'));
    transport.bidi[0]!.push(nsDoneBytes('s1')).closeReadable();
    await handle.closed;

    expect(seen).toEqual([
      { kind: 'first', type: 'REQUEST_OK' },
      { kind: 'continuation', type: 'NAMESPACE' },
      { kind: 'continuation', type: 'NAMESPACE_DONE' },
    ]);
    // Cleaned up after FIN (cleanup is chained on `closed`).
    await flush();
    expect(topo.hasContinuingRequest(requestId)).toBe(false);
  });

  it('a NAMESPACE before the first REQUEST_OK is a PROTOCOL_VIOLATION', async () => {
    const { transport, p } = open();
    const handle = await p;
    transport.bidi[0]!.push(nsBytes('s1')).closeReadable();
    await expect(handle.closed).rejects.toThrow(/first response must be REQUEST_OK/i);
  });

  it('an unsolicited REQUEST_OK after the first response (no pending update) fails the stream', async () => {
    const { transport, p } = open();
    const handle = await p;
    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(reqOkBytes()).closeReadable();
    await expect(handle.closed).rejects.toThrow(/unsolicited REQUEST_OK/i);
  });

  it('a message after REQUEST_ERROR fails the stream', async () => {
    const { transport, p } = open();
    const handle = await p;
    transport.bidi[0]!.push(errBytes());
    transport.bidi[0]!.push(nsBytes('s1')).closeReadable();
    await expect(handle.closed).rejects.toThrow(/after REQUEST_ERROR/i);
  });

  it('closeContinuingRequest FINs our writable and drops the context', async () => {
    const { topo, transport, p, requestId } = open();
    await p;
    await topo.closeContinuingRequest(requestId);
    expect(transport.bidi[0]!.writeClosed).toBe(true);
    expect(topo.hasContinuingRequest(requestId)).toBe(false);
  });

  it('a §10.9.2 prefix REQUEST_UPDATE response is matched (not misrouted as a continuation)', async () => {
    const { topo, transport, seen, p, requestId } = open();
    const handle = await p;
    transport.bidi[0]!.push(reqOkBytes()); // first response → ACTIVE
    await flush();
    expect(seen).toEqual([{ kind: 'first', type: 'REQUEST_OK' }]);

    // Send a prefix update on the SAME continuing stream; its REQUEST_OK correlates
    // to the update, FIFO — it must NOT be dispatched as a NAMESPACE continuation.
    const updateMsg = {
      type: 'REQUEST_UPDATE', requestId: 2n, existingRequestId: 0n,
      parameters: new Map([[0x34n, [[nm('a'), nm('b')]]]]),
    } as unknown as ControlMessage;
    const respP = topo.sendUpdateOnContinuing(requestId, updateMsg);
    await flush();
    transport.bidi[0]!.push(reqOkBytes()); // the update's REQUEST_OK
    const resp = await respP;
    expect(resp.type).toBe('REQUEST_OK');
    // Continuation messages still flow afterward, and the update response was NOT
    // recorded as a continuation.
    transport.bidi[0]!.push(nsBytes('s1')).closeReadable();
    await handle.closed;
    expect(seen).toEqual([
      { kind: 'first', type: 'REQUEST_OK' },
      { kind: 'continuation', type: 'NAMESPACE' },
    ]);
  });

  it('sendUpdateOnContinuing rejects a non-REQUEST_UPDATE message', async () => {
    const { topo, transport, p, requestId } = open();
    await p;
    transport.bidi[0]!.push(reqOkBytes());
    await flush();
    const notUpdate = { type: 'REQUEST_OK', requestId: 0n, parameters: new Map() } as ControlMessage;
    await expect(topo.sendUpdateOnContinuing(requestId, notUpdate)).rejects.toThrow(/expects REQUEST_UPDATE/i);
  });

  it('a write failure on sendUpdateOnContinuing does not leave a stale pending update', async () => {
    const { topo, transport, p, requestId } = open();
    const handle = await p;
    transport.bidi[0]!.push(reqOkBytes()); // first response
    await flush();

    transport.bidi[0]!.failWrites = true;
    const updateMsg = {
      type: 'REQUEST_UPDATE', requestId: 2n, existingRequestId: 0n,
      parameters: new Map([[0x34n, [[nm('a')]]]]),
    } as unknown as ControlMessage;
    await expect(topo.sendUpdateOnContinuing(requestId, updateMsg)).rejects.toThrow();

    // A later REQUEST_OK must be treated as UNSOLICITED — proving the failed
    // update's deferred was removed and cannot mis-correlate a response.
    transport.bidi[0]!.push(reqOkBytes()).closeReadable();
    await expect(handle.closed).rejects.toThrow(/unsolicited REQUEST_OK/i);
  });
});

describe('UniPairTopology — continuing request stream (SUBSCRIBE_TRACKS, §10.19)', () => {
  const pubBlockedBytes = (suffix: string, name: string): Uint8Array =>
    codec18.encode({ type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: [new TextEncoder().encode(suffix)], trackName: new TextEncoder().encode(name) } as never);

  function open(session = established()) {
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const seen: { kind: string; type: string }[] = [];
    const st = session.subscribeTracks([new Uint8Array([1])]);
    const p = topo.openContinuingRequest(transport, reqMessage(st), (_rid, msg: DecodedControlMessage, kind) => {
      seen.push({ kind, type: msg.type });
    });
    return { topo, transport, seen, p };
  }

  it('dispatches REQUEST_OK then PUBLISH_BLOCKED (its only allowed continuation)', async () => {
    const { transport, seen, p } = open();
    const handle = await p;
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x51); // SUBSCRIBE_TRACKS

    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(pubBlockedBytes('s1', 'vid')).closeReadable();
    await handle.closed;

    expect(seen).toEqual([
      { kind: 'first', type: 'REQUEST_OK' },
      { kind: 'continuation', type: 'PUBLISH_BLOCKED' },
    ]);
  });

  it('a NAMESPACE after REQUEST_OK on a SUBSCRIBE_TRACKS stream is a PROTOCOL_VIOLATION', async () => {
    const { transport, p } = open();
    const handle = await p;
    transport.bidi[0]!.push(reqOkBytes());
    transport.bidi[0]!.push(nsBytes('s1')).closeReadable(); // NAMESPACE not allowed for tracks
    await expect(handle.closed).rejects.toThrow(/expected PUBLISH_BLOCKED/i);
  });
});

describe('UniPairTopology — peer REQUEST_UPDATE on an outbound PUBLISH stream (§10.9)', () => {
  it('routes a peer REQUEST_UPDATE (after REQUEST_OK) to onPeerRequestUpdate, NOT the FIFO response queue', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const seen: Array<{ id: bigint; type: string }> = [];
    const errors: Error[] = [];
    topo.onStreamError = (e) => errors.push(e);
    topo.onPeerRequestUpdate = (id, m) => { seen.push({ id, type: m.type }); };

    const handle = await topo.openRequest(transport, reqMessage(session.publish(ns('a'), nm('1'), 5n)));
    transport.bidi[0]!.push(reqOkBytes()); // initial PUBLISH response (PUBLISH_OK shorthand)
    await handle.response;

    transport.bidi[0]!.push(reqUpdateBytes(1n)); // peer REQUEST_UPDATE on the same stream
    await flush();

    expect(seen).toEqual([{ id: handle.requestId, type: 'REQUEST_UPDATE' }]);
    expect(errors).toEqual([]); // not mis-matched as an unsolicited response
  });

  it('a peer REQUEST_UPDATE BEFORE the initial response is a protocol violation', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const errors: Error[] = [];
    let routed = 0;
    topo.onStreamError = (e) => errors.push(e);
    topo.onPeerRequestUpdate = () => { routed++; };

    const handle = await topo.openRequest(transport, reqMessage(session.publish(ns('a'), nm('1'), 5n)));
    void handle.response.catch(() => {});
    transport.bidi[0]!.push(reqUpdateBytes(1n)); // before any REQUEST_OK / REQUEST_ERROR
    await flush();

    expect(routed).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toMatch(/before the initial PUBLISH response/i);
  });

  it('a peer REQUEST_UPDATE on a non-PUBLISH (SUBSCRIBE) outbound stream is rejected, not routed', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const errors: Error[] = [];
    let routed = 0;
    topo.onStreamError = (e) => errors.push(e);
    topo.onPeerRequestUpdate = () => { routed++; };

    const handle = await topo.openRequest(transport, reqMessage(session.subscribe(ns('a'), nm('1'))));
    void handle.response.catch(() => {});
    transport.bidi[0]!.push(okBytes(7n)); // SUBSCRIBE_OK (initial response)
    await handle.response;
    transport.bidi[0]!.push(reqUpdateBytes(1n)); // peer REQUEST_UPDATE on a SUBSCRIBE stream
    await flush();

    expect(routed).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toMatch(/not accepted on a SUBSCRIBE/i);
  });
});

describe('UniPairTopology — outbound request-stream cleanup (lifecycle)', () => {
  it('a clean FIN of an open request stream reclaims the context (no leak)', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const a = session.subscribe(ns('a'), nm('1'));
    const sh = await topo.openRequest(transport, reqMessage(a));
    transport.bidi[0]!.push(okBytes(10n));
    await sh.response;
    expect(topo.hasRequestStream(a.requestId)).toBe(true);

    transport.bidi[0]!.closeReadable(); // peer FINs the request stream
    await flush();
    expect(topo.hasRequestStream(a.requestId)).toBe(false); // context reclaimed
  });

  it('a PEER close of a persistent PUBLISH stream fires onRequestClosed', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const closed: bigint[] = [];
    topo.onRequestClosed = (rid) => closed.push(rid);

    const p = session.publish(ns('a'), nm('1'), 5n);
    const handle = await topo.openRequest(transport, reqMessage(p));
    transport.bidi[0]!.push(reqOkBytes()); // accept
    await handle.response;

    transport.bidi[0]!.closeReadable(); // peer ends the PUBLISH stream
    await flush();
    expect(closed).toEqual([handle.requestId]);
    expect(topo.hasRequestStream(handle.requestId)).toBe(false);
  });

  it('a LOCAL finishRequest does NOT fire onRequestClosed (owner-driven, not peer)', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    const closed: bigint[] = [];
    topo.onRequestClosed = (rid) => closed.push(rid);

    const p = session.publish(ns('a'), nm('1'), 5n);
    const handle = await topo.openRequest(transport, reqMessage(p));
    transport.bidi[0]!.push(reqOkBytes());
    await handle.response;

    await topo.finishRequest(handle.requestId); // local PUBLISH_DONE-style finish
    await flush();
    expect(closed).toEqual([]); // owner-driven close → not surfaced as a peer close
    expect(topo.hasRequestStream(handle.requestId)).toBe(false);
  });
});

describe('UniPairTopology — draft-18 GOAWAY (§10.4)', () => {
  const goawayBytes = (uri = 'https://r.example'): Uint8Array =>
    codec18.encode({ type: 'GOAWAY', newSessionUri: uri, timeout: 0n, requestId: 0n } as ControlMessage);

  it('delivers a post-SETUP GOAWAY via onControlMessage on a control stream that STAYS OPEN; no violation; establish() does not block', async () => {
    const client = new Session(EndpointRole.CLIENT, 18);
    const topo = createUniPairTopology(client);
    const received: DecodedControlMessage[] = [];
    const violations: string[] = [];
    topo.onControlMessage = (m) => { received.push(m); };
    topo.onControlStreamViolation = (r) => { violations.push(r); };
    const transport = new TransportSim();
    // Control stream stays OPEN (openIncomingUni does not auto-FIN): SETUP first,
    // then a later GOAWAY — the §3.3 "must stay open" lifetime is honoured.
    const ctrl = transport.openIncomingUni();
    ctrl.push(setupBytes());
    await topo.establish(transport); // resolves once SETUP is processed
    ctrl.push(goawayBytes());        // later GOAWAY on the still-open stream
    await flush();

    expect(client.state).toBe(SessionState.ESTABLISHED);
    const g = received.find((m) => m.type === 'GOAWAY') as Goaway | undefined;
    expect(g?.newSessionUri).toBe('https://r.example');
    expect(violations).toEqual([]); // no FIN → no lifecycle violation
  });

  it('a control-stream FIN after SETUP is a violation (§3.3 — control stream must stay open)', async () => {
    const topo = createUniPairTopology(new Session(EndpointRole.CLIENT, 18));
    const violations: string[] = [];
    topo.onControlStreamViolation = (r) => { violations.push(r); };
    const transport = new TransportSim();
    transport.pushIncomingUni(setupBytes()); // SETUP then FIN
    await topo.establish(transport);
    await flush();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/FIN|closed.*during the session/i);
  });

  it('a post-SETUP non-GOAWAY message (SUBSCRIBE) is a violation and is NOT routed to onControlMessage', async () => {
    const topo = createUniPairTopology(new Session(EndpointRole.CLIENT, 18));
    const received: DecodedControlMessage[] = [];
    const violations: string[] = [];
    topo.onControlMessage = (m) => { received.push(m); };
    topo.onControlStreamViolation = (r) => { violations.push(r); };
    const transport = new TransportSim();
    const ctrl = transport.openIncomingUni();
    ctrl.push(setupBytes());
    await topo.establish(transport);
    ctrl.push(subBytes()); // a SUBSCRIBE on the control stream after SETUP
    await flush();
    expect(received).toEqual([]);            // never handed to the owner
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/SUBSCRIBE.*only GOAWAY/i);
  });

  it('malformed post-SETUP control bytes are a violation (decode failure)', async () => {
    const topo = createUniPairTopology(new Session(EndpointRole.CLIENT, 18));
    const violations: string[] = [];
    topo.onControlStreamViolation = (r) => { violations.push(r); };
    const transport = new TransportSim();
    const ctrl = transport.openIncomingUni();
    ctrl.push(setupBytes());
    await topo.establish(transport);
    // An unknown control type 0x7F with a 1-byte payload: decodes to "not implemented".
    ctrl.push(new Uint8Array([0x7f, 0x00, 0x01, 0xaa]));
    await flush();
    expect(violations).toHaveLength(1);
  });

  it('a GOAWAY on a REQUEST stream rejects that request with a typed RequestGoawayError (carrying request id + GOAWAY), not FIFO-matched, no onStreamError', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    let streamError: Error | undefined;
    topo.onStreamError = (e) => { streamError = e; };

    const a = session.subscribe(ns('live'), nm('vid'));
    const handle = await topo.openRequest(transport, reqMessage(a));
    // Request-stream GOAWAY form (no Request ID). It must NOT be matched as the
    // SUBSCRIBE's response — it is a per-request MIGRATION signal: the request fails
    // with a typed RequestGoawayError and the stream is torn down GRACEFULLY (no
    // onStreamError, which is reserved for genuine stream failures).
    transport.bidi[0]!.push(codec18.encode({ type: 'GOAWAY', newSessionUri: '', timeout: 0n } as ControlMessage));
    await flush();

    const reason = await handle.response.then(
      () => { throw new Error('expected rejection'); },
      (e) => e as unknown,
    );
    expect(reason).toBeInstanceOf(RequestGoawayError);
    expect((reason as RequestGoawayError).requestId).toBe(handle.requestId);
    expect((reason as RequestGoawayError).goaway.type).toBe('GOAWAY');
    // Graceful per-request teardown — NOT surfaced as a stream failure.
    expect(streamError).toBeUndefined();
  });

  it('a GOAWAY AFTER the first response (established stream, empty FIFO queue) still invokes onRequestGoaway, is not FIFO-matched, no onStreamError', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    let streamError: Error | undefined;
    let goaway: RequestGoawayError | undefined;
    topo.onStreamError = (e) => { streamError = e; };
    topo.onRequestGoaway = (e) => { goaway = e; };

    const a = session.subscribe(ns('live'), nm('vid'));
    const handle = await topo.openRequest(transport, reqMessage(a));
    // First response resolves and DRAINS the FIFO queue; the stream stays open.
    transport.bidi[0]!.push(okBytes(7n));
    const first = await handle.response;
    expect(first.type).toBe('SUBSCRIBE_OK');

    // A later request-stream GOAWAY arrives with NO pending response queued — it must
    // still reach onRequestGoaway (this is the established-stream case).
    transport.bidi[0]!.push(codec18.encode({ type: 'GOAWAY', newSessionUri: '', timeout: 0n } as ControlMessage));
    await flush();

    expect(goaway).toBeInstanceOf(RequestGoawayError);
    expect(goaway!.requestId).toBe(handle.requestId);
    expect(goaway!.goaway.type).toBe('GOAWAY');
    expect(streamError).toBeUndefined();
  });

  it('a GOAWAY on one REQUEST stream leaves an unrelated request stream free to match its own response', async () => {
    const session = established();
    const topo = createUniPairTopology(session);
    const transport = new TransportSim();
    let streamError: Error | undefined;
    topo.onStreamError = (e) => { streamError = e; };

    const a = session.subscribe(ns('a'), nm('1')); // requestId 0 → bidi[0]
    const b = session.subscribe(ns('b'), nm('2')); // requestId 2 → bidi[1]
    const hA = await topo.openRequest(transport, reqMessage(a));
    const hB = await topo.openRequest(transport, reqMessage(b));

    // GOAWAY migrates ONLY request A; request B still resolves normally.
    transport.bidi[0]!.push(codec18.encode({ type: 'GOAWAY', newSessionUri: '', timeout: 0n } as ControlMessage));
    transport.bidi[1]!.push(okBytes(20n)).closeReadable();
    await flush();

    await expect(hA.response).rejects.toBeInstanceOf(RequestGoawayError);
    const rB = await hB.response;
    session.handleControlMessage(rB, { requestId: hB.requestId });
    expect(session.getSubscription(b.requestId)?.trackAlias).toBe(20n);
    expect(streamError).toBeUndefined();
  });
});
