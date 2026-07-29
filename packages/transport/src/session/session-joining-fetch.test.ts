/**
 * Joining FETCH session behavior (§9.16.2 / draft-18 §10.12.2).
 *
 * Outbound: `session.joiningFetch()` builds a FETCH whose fetch structure is
 * a Joining Fetch {Joining Request ID, Joining Start} referencing one of OUR
 * subscriptions in PENDING or ESTABLISHED state.
 *
 * Inbound: the session enforces every MUST decidable from protocol state —
 * unknown joining request IDs (INVALID_JOINING_REQUEST_ID), the draft-14/16
 * Largest-Object-filter gate (PROTOCOL_VIOLATION), and the draft-18 forward-
 * state gate (INVALID_RANGE) — and resolves the joining range from the
 * app-supplied Largest Location via `resolveIncomingJoiningFetch()`.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Session, SessionError as SessionErr } from './session.js';
import { SessionState, EndpointRole, FetchState, type CloseConnectionAction, type SendControlAction } from './types.js';
import { varint } from '../primitives/varint.js';
import { SetupParam, MessageParam } from '../control/parameters.js';
import { SessionError as SessionErrorCode, RequestError } from '../errors.js';
import { encodeSubscriptionFilter } from '../control/subscription-filter.js';
import { createControlCodec } from '../control/codec.js';
import { writeLocation, locationEncodingLength } from '../primitives/location.js';
import type { ServerSetup, ClientSetup, Subscribe, SubscribeOk, Fetch, JoiningFetch, FetchOk, RequestErrorMsg, Parameters } from '../control/messages.js';

const NS = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
const NAME = new Uint8Array([0x76, 0x69, 0x64]);

/** Established CLIENT session (subscriber side, outbound tests). */
function clientSession(draft: 14 | 16 | 18 = 16): Session {
  const session = new Session(EndpointRole.CLIENT, draft);
  session.initiateSetup({ maxRequestId: varint(100n) });
  if (draft === 18) {
    // draft-18 unified SETUP reply (§10.3)
    session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
  } else {
    const serverSetup: ServerSetup = {
      type: 'SERVER_SETUP',
      parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
    };
    session.handleControlMessage(serverSetup);
  }
  return session;
}

/** Established SERVER session (publisher side, inbound tests). */
function serverSession(draft: 14 | 16 | 18 = 16): Session {
  const session = new Session(EndpointRole.SERVER, draft);
  if (draft === 18) {
    // draft-18 unified SETUP (§10.3)
    session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
  } else {
    const clientSetup: ClientSetup = {
      type: 'CLIENT_SETUP',
      versions: [],
      parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
    } as unknown as ClientSetup;
    session.handleControlMessage(clientSetup);
  }
  session.completeSetup({ maxRequestId: varint(100n) });
  return session;
}

function establishOutboundSubscription(session: Session): bigint {
  const { requestId } = session.subscribe(NS, NAME);
  const ok: SubscribeOk = {
    type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(42n),
    parameters: new Map(), trackExtensions: [],
  };
  session.handleControlMessage(ok);
  return requestId;
}

function incomingSubscribe(requestId: bigint, parameters: Parameters = new Map()): Subscribe {
  return { type: 'SUBSCRIBE', requestId: varint(requestId), trackNamespace: NS, trackName: NAME, parameters };
}

function incomingJoiningFetch(requestId: bigint, joiningRequestId: bigint, fetchType: 0x2 | 0x3 = 0x2): Fetch {
  return {
    type: 'FETCH',
    requestId: varint(requestId),
    fetch: { fetchType, joiningRequestId: varint(joiningRequestId), joiningStart: 0n },
    parameters: new Map(),
  };
}

// ─── Outbound (subscriber side) ──────────────────────────────────────

describe('session.joiningFetch (outbound)', () => {
  let session: Session;

  beforeEach(() => { session = clientSession(); });

  it('emits FETCH with a relative Joining Fetch structure (0x2) referencing our SUBSCRIBE', () => {
    const subReqId = establishOutboundSubscription(session);

    const { requestId, actions } = session.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 2n,
    });

    expect(requestId).not.toBe(subReqId);
    const send = actions[0] as SendControlAction;
    const msg = send.message as Fetch;
    expect(msg.type).toBe('FETCH');
    const jf = msg.fetch as JoiningFetch;
    expect(jf.fetchType).toBe(0x2);
    expect(jf.joiningRequestId).toBe(subReqId);
    expect(jf.joiningStart).toBe(2n);
  });

  it('emits fetchType 0x3 for absolute', () => {
    const subReqId = establishOutboundSubscription(session);
    const { actions } = session.joiningFetch({
      joiningFetchType: 'absolute', joiningRequestId: subReqId, joiningStart: 7n,
    });
    const msg = (actions[0] as SendControlAction).message as Fetch;
    expect((msg.fetch as JoiningFetch).fetchType).toBe(0x3);
    expect((msg.fetch as JoiningFetch).joiningStart).toBe(7n);
  });

  it('sets the GROUP_ORDER parameter when requested', () => {
    const subReqId = establishOutboundSubscription(session);
    const { actions } = session.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
      groupOrder: 'descending',
    });
    const msg = (actions[0] as SendControlAction).message as Fetch;
    expect(msg.parameters.get(MessageParam.GROUP_ORDER)?.[0]).toBe(2n);
  });

  it('permits joining a PENDING subscription (SUBSCRIBE_OK not yet received)', () => {
    // §9.16.2: "a subscription in the Established or Pending (subscriber) state".
    const { requestId: subReqId } = session.subscribe(NS, NAME);
    const { actions } = session.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    });
    expect(((actions[0] as SendControlAction).message as Fetch).type).toBe('FETCH');
  });

  it('throws INVALID_STATE for a joiningRequestId that is not one of our subscriptions', () => {
    expect(() => session.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: 998n, joiningStart: 0n,
    })).toThrow(SessionErr);
    try {
      session.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: 998n, joiningStart: 0n });
    } catch (e) {
      expect((e as SessionErr).code).toBe('INVALID_STATE');
    }
  });

  it('throws INVALID_STATE for a terminated subscription', () => {
    const { requestId: subReqId } = session.subscribe(NS, NAME);
    const err: RequestErrorMsg = {
      type: 'REQUEST_ERROR', requestId: subReqId,
      errorCode: RequestError.DOES_NOT_EXIST as bigint, retryInterval: 0n, errorReason: 'nope',
    };
    session.handleControlMessage(err);
    expect(() => session.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 0n,
    })).toThrow(SessionErr);
  });

  it('relative joining fetch skips FETCH_OK end/start validation (start unknown to subscriber)', () => {
    const subReqId = establishOutboundSubscription(session);
    const { requestId } = session.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: subReqId, joiningStart: 5n,
    });
    const ok: FetchOk = {
      type: 'FETCH_OK', requestId, endOfTrack: 0,
      endLocation: { group: 0n, object: 0n }, // would violate any stored start
      parameters: new Map(), trackExtensions: [],
    } as unknown as FetchOk;
    const actions = session.handleControlMessage(ok);
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
    expect(session.getFetch(requestId)?.state).toBe(FetchState.TRANSFERRING);
  });

  it('absolute joining fetch enforces FETCH_OK end >= {joiningStart, 0} (§9.16.3 MUST)', () => {
    const subReqId = establishOutboundSubscription(session);
    const { requestId } = session.joiningFetch({
      joiningFetchType: 'absolute', joiningRequestId: subReqId, joiningStart: 6n,
    });
    const ok: FetchOk = {
      type: 'FETCH_OK', requestId, endOfTrack: 0,
      endLocation: { group: 5n, object: 0n }, // < start {6, 0}
      parameters: new Map(), trackExtensions: [],
    } as unknown as FetchOk;
    const actions = session.handleControlMessage(ok);
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction;
    expect(close).toBeDefined();
    expect(close.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });
});

describe('deferred update acks vs terminated subscriptions (§10.8 rejection path)', () => {
  it('an update REQUEST_OK arriving AFTER the subscribe was rejected settles without closing the session', () => {
    const session = clientSession(18 as never);
    const { requestId: subReqId } = session.subscribe(NS, NAME);
    const { requestId: updateReqId } = session.requestUpdate(subReqId, { forward: 1 as never });

    // Responder rejects the SUBSCRIBE first (its valid first response)…
    const rejectActions = session.handleControlMessage({
      type: 'REQUEST_ERROR', requestId: subReqId,
      errorCode: RequestError.DOES_NOT_EXIST as bigint, retryInterval: 0n, errorReason: 'nope',
    } as never);
    expect(rejectActions.every((a) => a.type !== 'close_connection')).toBe(true);

    // …then flushes the deferred update acknowledgement. It must settle
    // WITHOUT mutating the now-terminated subscription.
    const ackActions = session.handleControlMessage({
      type: 'REQUEST_OK', requestId: updateReqId, parameters: new Map(),
    } as never);
    expect(ackActions.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });
});

describe('pending REQUEST_UPDATE scope (§10.12.2 exception is SUBSCRIBE-only)', () => {
  it('a REQUEST_UPDATE against a PENDING publish-initiated subscription still closes (no ack before PUBLISH_OK)', () => {
    const session = clientSession(18 as never);
    // Peer PUBLISH creates a PENDING publish-initiated subscription on us.
    session.handleControlMessage({
      type: 'PUBLISH', requestId: varint(1n), trackNamespace: NS, trackName: NAME,
      trackAlias: varint(9n), parameters: new Map(),
    } as never);
    // An update racing PUBLISH_OK has ambiguous response correlation — the
    // pending exception must NOT cover it.
    const actions = session.handleControlMessage({
      type: 'REQUEST_UPDATE', requestId: varint(3n), existingRequestId: varint(1n),
      parameters: new Map([[MessageParam.FORWARD, [1n]]]),
    } as never);
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction;
    expect(close).toBeDefined();
  });
});

describe('SubscribeOptions.forward initializes BOTH peers (§9.2.2.8)', () => {
  it('the subscriber-side state machine starts PAUSED when forward: 0 is sent', () => {
    const session = clientSession(16);
    const { requestId } = session.subscribe(NS, NAME, { forward: 0 as never });
    const sub = session.getSubscription(requestId);
    expect(sub?.forwardState).toBe(0); // PAUSED locally, matching the wire
  });
});

// ─── Inbound (publisher side) ────────────────────────────────────────

describe('incoming joining FETCH validation', () => {
  it('unknown joiningRequestId → REQUEST_ERROR INVALID_JOINING_REQUEST_ID, no fetch state', () => {
    const session = serverSession();
    const actions = session.handleControlMessage(incomingJoiningFetch(0n, 776n));

    const send = actions.find((a) => a.type === 'send_control') as SendControlAction;
    expect(send).toBeDefined();
    const err = send.message as RequestErrorMsg;
    expect(err.type).toBe('REQUEST_ERROR');
    expect(err.requestId).toBe(0n);
    expect(err.errorCode).toBe(RequestError.INVALID_JOINING_REQUEST_ID);
    expect(session.getIncomingFetch(0n)).toBeUndefined();
    expect(session.state).toBe(SessionState.ESTABLISHED); // soft error, not a close
  });

  it('joining a subscription the peer has in PENDING (not yet accepted) is permitted', () => {
    const session = serverSession(18);
    session.handleControlMessage(incomingSubscribe(0n)); // not yet accepted → PENDING
    const actions = session.handleControlMessage(incomingJoiningFetch(2n, 0n));
    expect(actions.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(session.getIncomingFetch(2n)).toBeDefined();
  });

  it('d16: joining a subscription whose filter is not Largest Object closes with PROTOCOL_VIOLATION', () => {
    // §9.16.2: "only permitted when the associated Subscribe has the Filter
    // Type Largest Object; any other value results in closing the session
    // with a PROTOCOL_VIOLATION." An omitted filter = unfiltered (§9.2.2.5),
    // which is not Largest Object.
    const session = serverSession(16);
    session.handleControlMessage(incomingSubscribe(0n)); // no SUBSCRIPTION_FILTER param
    session.acceptSubscribe(0n, 9n);

    const actions = session.handleControlMessage(incomingJoiningFetch(2n, 0n));
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction;
    expect(close).toBeDefined();
    expect(close.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });

  it('d16: joining a Largest Object subscription is accepted', () => {
    const session = serverSession(16);
    const filterBytes = encodeSubscriptionFilter({ type: 'LargestObject' }, 16);
    const params: Parameters = new Map([[MessageParam.SUBSCRIPTION_FILTER, [filterBytes]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    session.acceptSubscribe(0n, 9n);

    const actions = session.handleControlMessage(incomingJoiningFetch(2n, 0n));
    expect(actions.every((a) => a.type !== 'close_connection')).toBe(true);
    const sm = session.getIncomingFetch(2n);
    expect(sm).toBeDefined();
  });

  it('d18: joining a Forward State 0 subscription → soft REQUEST_ERROR INVALID_RANGE (§10.12.2)', () => {
    const session = serverSession(18);
    const params: Parameters = new Map([[MessageParam.FORWARD, [0n]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    session.acceptSubscribe(0n, 9n);

    const actions = session.handleControlMessage(incomingJoiningFetch(2n, 0n));
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction;
    const err = send?.message as RequestErrorMsg;
    expect(err?.type).toBe('REQUEST_ERROR');
    expect(err?.errorCode).toBe(RequestError.INVALID_RANGE);
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });

  it('d18: joining a PENDING Forward=0 subscription is DEFERRED, not rejected (§10.12.2 buffering)', () => {
    // The forward-state gate cannot be evaluated while the subscription is
    // pending: the publisher must buffer the join and "process any pending
    // REQUEST_UPDATE messages ... before evaluating." The session admits the
    // fetch (the adapter parks it); the gate runs at establish time.
    const session = serverSession(18);
    const params: Parameters = new Map([[MessageParam.FORWARD, [0n]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    // NOT accepted — subscription stays PENDING.

    const actions = session.handleControlMessage(incomingJoiningFetch(2n, 0n));
    expect(actions.find((a) => a.type === 'send_control')).toBeUndefined(); // no REQUEST_ERROR
    expect(session.getIncomingFetch(2n)).toBeDefined();                     // admitted for parking
  });

  it('d18: joining a Forward State 1 subscription is accepted (default forward state)', () => {
    const session = serverSession(18);
    session.handleControlMessage(incomingSubscribe(0n));
    session.acceptSubscribe(0n, 9n);
    const actions = session.handleControlMessage(incomingJoiningFetch(2n, 0n));
    expect(actions.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(session.getIncomingFetch(2n)).toBeDefined();
  });
});

describe('REQUEST_UPDATE filter changes drive the joining gate (§9.2.2.5)', () => {
  function updateFilter(session: Session, existingRequestId: bigint, updateReqId: bigint, filter: Parameters extends never ? never : import('../control/subscription-filter.js').SubscriptionFilter): void {
    const params: Parameters = new Map([[
      MessageParam.SUBSCRIPTION_FILTER,
      [encodeSubscriptionFilter(filter, 16)],
    ]]);
    session.handleControlMessage({
      type: 'REQUEST_UPDATE', requestId: varint(updateReqId),
      existingRequestId: varint(existingRequestId), parameters: params,
    } as never);
  }

  it('NextGroupStart → LargestObject via REQUEST_UPDATE: joining fetch becomes PERMITTED', () => {
    const session = serverSession(16);
    const params: Parameters = new Map([[MessageParam.SUBSCRIPTION_FILTER,
      [encodeSubscriptionFilter({ type: 'NextGroupStart' }, 16)]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    session.acceptSubscribe(0n, 9n);

    updateFilter(session, 0n, 2n, { type: 'LargestObject' });

    const actions = session.handleControlMessage(incomingJoiningFetch(4n, 0n));
    expect(actions.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(session.getIncomingFetch(4n)).toBeDefined();
  });

  it('LargestObject → AbsoluteStart via REQUEST_UPDATE: joining fetch now closes with PROTOCOL_VIOLATION', () => {
    const session = serverSession(16);
    const params: Parameters = new Map([[MessageParam.SUBSCRIPTION_FILTER,
      [encodeSubscriptionFilter({ type: 'LargestObject' }, 16)]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    session.acceptSubscribe(0n, 9n);

    updateFilter(session, 0n, 2n, { type: 'AbsoluteStart', startGroup: 5n, startObject: 0n });

    const actions = session.handleControlMessage(incomingJoiningFetch(4n, 0n));
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction;
    expect(close).toBeDefined();
    expect(close.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });

  it('REQUEST_UPDATE without a filter parameter leaves the stored filter unchanged (§9.2.2.5)', () => {
    const session = serverSession(16);
    const params: Parameters = new Map([[MessageParam.SUBSCRIPTION_FILTER,
      [encodeSubscriptionFilter({ type: 'LargestObject' }, 16)]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    session.acceptSubscribe(0n, 9n);

    session.handleControlMessage({
      type: 'REQUEST_UPDATE', requestId: varint(2n),
      existingRequestId: varint(0n), parameters: new Map(),
    } as never);

    const actions = session.handleControlMessage(incomingJoiningFetch(4n, 0n));
    expect(actions.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(session.getIncomingFetch(4n)).toBeDefined();
  });
});

describe('resolveIncomingJoiningFetch', () => {
  function acceptedJoiningFetch(draft: 16 | 18 = 18): { session: Session; fetchReqId: bigint } {
    const session = serverSession(draft);
    const params: Parameters = draft === 16
      ? new Map([[MessageParam.SUBSCRIPTION_FILTER, [encodeSubscriptionFilter({ type: 'LargestObject' }, 16)]]])
      : new Map();
    session.handleControlMessage(incomingSubscribe(0n, params));
    // The Largest Location is COMMUNICATED in SUBSCRIBE_OK (and saved as the
    // Joining Location) — resolution takes no app-supplied head.
    session.acceptSubscribe(0n, 9n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 10n, object: 7n }]]]) as Parameters,
    });
    session.handleControlMessage(incomingJoiningFetch(2n, 0n, 0x2));
    return { session, fetchReqId: 2n };
  }

  it('back-fills the publisher fetch SM range from the SAVED Joining Location', () => {
    const { session, fetchReqId } = acceptedJoiningFetch();
    const range = session.resolveIncomingJoiningFetch(fetchReqId);

    expect(range.startLocation).toEqual({ group: 10n, object: 0n }); // joiningStart 0
    expect(range.endLocation).toEqual({ group: 10n, object: 8n });   // wire one-past

    const sm = session.getIncomingFetch(fetchReqId);
    expect(sm?.startGroup).toBe(10n);
    expect(sm?.startObject).toBe(0n);
    expect(sm?.endGroup).toBe(10n);
    expect(sm?.endObject).toBe(8n);
  });

  it('throws INVALID_STATE for a standalone fetch', () => {
    const session = serverSession(16);
    const standalone: Fetch = {
      type: 'FETCH', requestId: varint(0n),
      fetch: {
        fetchType: 0x1, trackNamespace: NS, trackName: NAME,
        startLocation: { group: 0n, object: 0n }, endLocation: { group: 1n, object: 0n },
      },
      parameters: new Map(),
    };
    session.handleControlMessage(standalone);
    expect(() => session.resolveIncomingJoiningFetch(0n, { group: 1n, object: 1n }))
      .toThrow(SessionErr);
  });
});

describe('saved Joining Location (§5.1: the publisher MUST save the SUBSCRIBE_OK snapshot)', () => {
  it('d18: the LARGEST_OBJECT communicated in SUBSCRIBE_OK anchors the join — never a later head', () => {
    const session = serverSession(18);
    session.handleControlMessage(incomingSubscribe(0n, new Map()));
    session.acceptSubscribe(0n, 9n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 5n, object: 1n }]]]) as Parameters,
    });
    session.handleControlMessage(incomingJoiningFetch(2n, 0n, 0x2));
    // Even if the track advanced since SUBSCRIBE_OK, resolution uses the
    // saved (5,1) snapshot — no other input exists.
    const range = session.resolveIncomingJoiningFetch(2n);
    expect(range.startLocation).toEqual({ group: 5n, object: 0n });
    expect(range.endLocation).toEqual({ group: 5n, object: 2n });
  });

  it('d16: the byte-blob LARGEST_OBJECT parameter is saved, and resolution needs NO app-supplied location', () => {
    const session = serverSession(16);
    const params: Parameters = new Map([[MessageParam.SUBSCRIPTION_FILTER,
      [encodeSubscriptionFilter({ type: 'LargestObject' }, 16)]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    const loc = { group: varint(5n), object: varint(1n) };
    const buf = new Uint8Array(locationEncodingLength(loc));
    writeLocation(loc, buf, 0);
    session.acceptSubscribe(0n, 9n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [buf]]]) as Parameters,
    });
    session.handleControlMessage(incomingJoiningFetch(2n, 0n, 0x2));
    const range = session.resolveIncomingJoiningFetch(2n);
    expect(range.startLocation).toEqual({ group: 5n, object: 0n });
    expect(range.endLocation).toEqual({ group: 5n, object: 2n });
  });

  it('with no saved snapshot, resolution ALWAYS throws — the join must be answered INVALID_RANGE', () => {
    const session = serverSession(16);
    const params: Parameters = new Map([[MessageParam.SUBSCRIPTION_FILTER,
      [encodeSubscriptionFilter({ type: 'LargestObject' }, 16)]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));
    session.acceptSubscribe(0n, 9n);                 // no LARGEST_OBJECT communicated
    session.handleControlMessage(incomingJoiningFetch(2n, 0n, 0x2));
    // No Joining Location exists — resolution ALWAYS throws; the compliant
    // answer to such a join is REQUEST_ERROR INVALID_RANGE.
    expect(() => session.resolveIncomingJoiningFetch(2n)).toThrow(SessionErr);
  });

  it('d18: a Forward 0→1 REQUEST_UPDATE_OK communicates AND saves the current head as the new Joining Location', () => {
    const session = serverSession(18);
    session.setLargestLocationProvider(() => ({ group: 7n, object: 3n }));
    // Subscribe with Forward 0 (paused), accept with the then-current largest.
    const sub = incomingSubscribe(0n, new Map([[MessageParam.FORWARD, [0n]]]) as Parameters);
    session.handleControlMessage(sub);
    session.acceptSubscribe(0n, 9n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 5n, object: 1n }]]]) as Parameters,
    });
    // The track advances while paused; the peer resumes: Forward 0→1.
    const actions = session.handleControlMessage({
      type: 'REQUEST_UPDATE', requestId: varint(2n), existingRequestId: varint(0n),
      parameters: new Map([[MessageParam.FORWARD, [1n]]]),
    } as never);
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction;
    const ok = send.message as { type: string; parameters: Parameters };
    expect(ok.type).toBe('REQUEST_OK');
    // §5.1: the REQUEST_UPDATE_OK carries the CURRENT Largest Location…
    expect(ok.parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0]).toEqual({ group: 7n, object: 3n });
    // …and the publisher SAVED it: a joining fetch now anchors at (7,3).
    session.handleControlMessage(incomingJoiningFetch(4n, 0n, 0x2));
    const range = session.resolveIncomingJoiningFetch(4n);
    expect(range.startLocation).toEqual({ group: 7n, object: 0n });
    expect(range.endLocation).toEqual({ group: 7n, object: 4n });
  });

  it('the saved snapshot is reclaimed with the subscription', () => {
    const session = serverSession(18);
    session.handleControlMessage(incomingSubscribe(0n, new Map()));
    session.acceptSubscribe(0n, 9n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 5n, object: 1n }]]]) as Parameters,
    });
    session.handleControlMessage({ type: 'UNSUBSCRIBE', requestId: varint(0n) } as never);
    const saved = (session as unknown as { incomingJoiningLocations: Map<bigint, unknown> }).incomingJoiningLocations;
    expect(saved.size).toBe(0);
  });
});

describe('draft-14 joining-fetch rejection encoding (§9.18 FETCH_ERROR)', () => {
  it('a NONCOMPLIANT pre-SUBSCRIBE_OK join from the peer is rejected on the wire: FETCH_ERROR 0x19, code 0x7', () => {
    // The receiver side: a peer that ignores draft-14's existing-subscription
    // rule and emits the join while its SUBSCRIBE is still pending. The
    // publisher must answer with an ENCODABLE FETCH_ERROR (never accept, park,
    // or crash the codec).
    const session = serverSession(14);
    const params: Parameters = new Map([[MessageParam.SUBSCRIPTION_FILTER,
      [encodeSubscriptionFilter({ type: 'LargestObject' }, 14)]]]);
    session.handleControlMessage(incomingSubscribe(0n, params));   // PENDING — not accepted
    const actions = session.handleControlMessage(incomingJoiningFetch(2n, 0n, 0x2));
    expect(actions.every((a) => a.type !== 'close_connection')).toBe(true);
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction;
    expect(send).toBeDefined();
    const msg = send.message as RequestErrorMsg;
    expect(msg.type).toBe('REQUEST_ERROR');
    expect(BigInt(msg.errorCode)).toBe(0x7n);                      // d14 INVALID_JOINING_REQUEST_ID
    const bytes = createControlCodec(14).encode(msg as never);
    expect(bytes[0]).toBe(0x19);                                   // FETCH_ERROR wire type
    // And no fetch state was created for the rejected join.
    expect(session.getIncomingFetch(2n)).toBeUndefined();
  });


  it('an invalid joining request id is answered with an ENCODABLE FETCH_ERROR: type 0x19, code 0x7', () => {
    const session = serverSession(14);
    // Joining fetch referencing a subscription that does not exist.
    const actions = session.handleControlMessage(incomingJoiningFetch(0n, 42n, 0x2));
    const send = actions.find((a) => a.type === 'send_control') as SendControlAction;
    expect(send).toBeDefined();
    const msg = send.message as RequestErrorMsg;
    expect(msg.type).toBe('REQUEST_ERROR');
    expect(BigInt(msg.errorCode)).toBe(0x7n);        // d14 INVALID_JOINING_REQUEST_ID
    // The d14 codec can actually put it on the wire (requires requestKind).
    const codec = createControlCodec(14);
    const bytes = codec.encode(msg as never);
    expect(bytes[0]).toBe(0x19);                     // FETCH_ERROR wire type
  });
});

describe('joining fetch against an outbound PUBLISH subscription', () => {
  const pubParams = (forward: bigint): Parameters => new Map([
    [MessageParam.LARGEST_OBJECT as bigint, [{ group: 4n, object: 2n }]],
    [MessageParam.FORWARD as bigint, [forward]],
  ]) as Parameters;

  it('is ELIGIBLE once ESTABLISHED and anchors at the PUBLISH-communicated Largest Location (§5.1)', () => {
    const session = serverSession(18);
    const { requestId } = session.publish(NS, NAME, 77n, { parameters: pubParams(1n) });
    // PENDING publisher-initiated is INVALID until PUBLISH_OK (eligibility
    // matrix: only a pending outbound SUBSCRIBE is joinable pre-establishment).
    const pendingActions = session.handleControlMessage(incomingJoiningFetch(0n, requestId as bigint, 0x2));
    const pendingErr = pendingActions.find((a) => a.type === 'send_control'
      && (a as SendControlAction).message.type === 'REQUEST_ERROR');
    expect(pendingErr).toBeDefined();
    // Establish, then the join is eligible.
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: varint(requestId as bigint), parameters: new Map() } as never);
    const actions = session.handleControlMessage(incomingJoiningFetch(2n, requestId as bigint, 0x2));
    // NOT rejected with INVALID_JOINING_REQUEST_ID.
    const err = actions.find((a) => a.type === 'send_control'
      && (a as SendControlAction).message.type === 'REQUEST_ERROR');
    expect(err).toBeUndefined();
    const range = session.resolveIncomingJoiningFetch(2n);
    expect(range.startLocation).toEqual({ group: 4n, object: 0n });
    expect(range.endLocation).toEqual({ group: 4n, object: 3n });
  });

  it('applies the PUBLISH FORWARD parameter — an established Forward-0 publish rejects the join with INVALID_RANGE (§10.12.2)', () => {
    const session = serverSession(18);
    const { requestId } = session.publish(NS, NAME, 77n, { parameters: pubParams(0n) });
    // The peer accepts: REQUEST_OK establishes the publish-initiated subscription.
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: varint(requestId as bigint), parameters: new Map() } as never);
    const actions = session.handleControlMessage(incomingJoiningFetch(0n, requestId as bigint, 0x2));
    const err = actions.find((a) => a.type === 'send_control'
      && (a as SendControlAction).message.type === 'REQUEST_ERROR') as SendControlAction | undefined;
    expect(err).toBeDefined();
    expect(BigInt((err!.message as RequestErrorMsg).errorCode)).toBe(BigInt(RequestError.INVALID_RANGE as bigint));
  });
});

describe('Forward 0→1 resume provider semantics', () => {
  function establishedPaused(provider?: (() => { group: bigint; object: bigint } | null) | 'throwing' | 'invalid'): Session {
    const session = serverSession(18);
    if (provider === 'throwing') session.setLargestLocationProvider(() => { throw new Error('boom'); });
    else if (provider === 'invalid') session.setLargestLocationProvider(() => ({ group: 1, object: 2 }) as never);
    else if (provider) session.setLargestLocationProvider(provider);
    session.handleControlMessage(incomingSubscribe(0n, new Map([[MessageParam.FORWARD, [0n]]]) as Parameters));
    session.acceptSubscribe(0n, 9n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 5n, object: 1n }]]]) as Parameters,
    });
    return session;
  }
  const resume = (session: Session) => session.handleControlMessage({
    type: 'REQUEST_UPDATE', requestId: varint(2n), existingRequestId: varint(0n),
    parameters: new Map([[MessageParam.FORWARD, [1n]]]),
  } as never);
  const sent = (actions: ReturnType<Session['handleControlMessage']>) =>
    (actions.find((a) => a.type === 'send_control') as SendControlAction).message;

  /** The SESSION's half of a failed resume: REQUEST_ERROR only, Forward
   *  unchanged, subscription intact — the ADAPTER owns the §10.11
   *  PUBLISH_DONE(UPDATE_FAILED) termination transaction (stream count,
   *  alias retirement, sealing); see the paired loopback tests. */
  function expectFailedResume(session: Session): void {
    const actions = resume(session);
    const sends = actions.filter((a) => a.type === 'send_control') as SendControlAction[];
    expect(sends[0]!.message.type).toBe('REQUEST_ERROR');
    expect(sends.some((a) => a.message.type === 'PUBLISH_DONE')).toBe(false);   // adapter-owned
    expect(session.getIncomingSubscription(0n)?.forwardState).toBe(0);          // still PAUSED
  }

  it('MISSING provider fails CLOSED: REQUEST_ERROR, Forward unchanged (termination is adapter-owned)', () => {
    expectFailedResume(establishedPaused());
  });

  it('a THROWING provider fails CLOSED the same way', () => {
    expectFailedResume(establishedPaused('throwing'));
  });

  it('an INVALID provider result fails CLOSED the same way', () => {
    expectFailedResume(establishedPaused('invalid'));
  });

  it('a provider result above the vi64 ceiling fails CLOSED the same way (unencodable)', () => {
    const session = establishedPaused(() => ({ group: 2n ** 64n, object: 0n }));
    expectFailedResume(session);
  });

  it('a NULL provider result is compliant: empty OK, and the STALE Joining Location is cleared', () => {
    const session = establishedPaused(() => null);
    const reply = sent(resume(session));
    expect(reply.type).toBe('REQUEST_OK');
    expect((reply as { parameters: Parameters }).parameters.size).toBe(0);
    expect(session.getIncomingSubscription(0n)?.forwardState).toBe(1); // resumed
    // The stale (5,1) snapshot must NOT anchor a later join.
    session.handleControlMessage(incomingJoiningFetch(4n, 0n, 0x2));
    expect(() => session.resolveIncomingJoiningFetch(4n)).toThrow(SessionErr);
  });
});

describe('publish-acceptance parameter application', () => {
  it('d18 REQUEST_OK applies FORWARD to the outbound publish — a Forward-0 acceptance pauses it', () => {
    const session = serverSession(18);
    const { requestId } = session.publish(NS, NAME, 77n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 4n, object: 2n }]]]) as Parameters,
    });
    session.handleControlMessage({
      type: 'REQUEST_OK', requestId: varint(requestId as bigint),
      parameters: new Map([[MessageParam.FORWARD, [0n]]]),
    } as never);
    expect(session.getOutgoingPublish(requestId as bigint)?.forwardState).toBe(0);   // PAUSED
    // …and the d18 joining gate honors it: an established Forward-0 publish
    // rejects the join with INVALID_RANGE.
    const actions = session.handleControlMessage(incomingJoiningFetch(0n, requestId as bigint, 0x2));
    const err = actions.find((a) => a.type === 'send_control'
      && (a as SendControlAction).message.type === 'REQUEST_ERROR') as SendControlAction;
    expect(err).toBeDefined();
  });

  it('d16: the subscriber PUBLISH_OK filter governs the joining gate — LargestObject admits, unfiltered closes', () => {
    // LargestObject filter communicated in PUBLISH_OK → the join is admitted.
    const ok = serverSession(16);
    const { requestId: r1 } = ok.publish(NS, NAME, 77n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 4n, object: 2n }]]]) as Parameters,
    });
    ok.handleControlMessage({
      type: 'PUBLISH_OK', requestId: varint(r1 as bigint),
      parameters: new Map([[MessageParam.SUBSCRIPTION_FILTER,
        [encodeSubscriptionFilter({ type: 'LargestObject' }, 16)]]]),
    } as never);
    const okActions = ok.handleControlMessage(incomingJoiningFetch(0n, r1 as bigint, 0x2));
    expect(okActions.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(ok.resolveIncomingJoiningFetch(0n).startLocation).toEqual({ group: 4n, object: 0n });

    // No filter communicated → §9.16.2's Largest Object rule fails → close.
    const bad = serverSession(16);
    const { requestId: r2 } = bad.publish(NS, NAME, 77n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 4n, object: 2n }]]]) as Parameters,
    });
    bad.handleControlMessage({ type: 'PUBLISH_OK', requestId: varint(r2 as bigint), parameters: new Map() } as never);
    const badActions = bad.handleControlMessage(incomingJoiningFetch(0n, r2 as bigint, 0x2));
    expect(badActions.some((a) => a.type === 'close_connection')).toBe(true);
  });

  it('accepting an inbound PUBLISH honors caller response parameters (d18 REQUEST_OK carries them; FORWARD applies locally)', () => {
    const session = serverSession(18);
    session.handleControlMessage({
      type: 'PUBLISH', requestId: varint(0n), trackNamespace: NS, trackName: NAME,
      trackAlias: varint(50n), parameters: new Map(), trackProperties: new Map(),
    } as never);
    const actions = session.acceptSubscribe(0n, 50n, {
      parameters: new Map([[MessageParam.FORWARD as bigint, [0n]]]) as Parameters,
    });
    const okMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message as { type: string; parameters: Parameters };
    expect(okMsg.type).toBe('REQUEST_OK');
    expect(okMsg.parameters.get(MessageParam.FORWARD as bigint)?.[0]).toBe(0n);   // carried
    expect(session.getIncomingSubscription(0n)?.forwardState).toBe(0);            // applied locally
  });

  it('an outbound publish REJECTED with REQUEST_ERROR reclaims its saved Joining Location', () => {
    const session = serverSession(18);
    const { requestId } = session.publish(NS, NAME, 77n, {
      parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 4n, object: 2n }]]]) as Parameters,
    });
    session.handleControlMessage({
      type: 'REQUEST_ERROR', requestId: varint(requestId as bigint), errorCode: varint(0x1n),
      retryInterval: varint(0n), errorReason: 'no thanks',
    } as never);
    const saved = (session as unknown as { incomingJoiningLocations: Map<bigint, unknown> }).incomingJoiningLocations;
    expect(saved.size).toBe(0);
  });
});

describe('inbound PUBLISH initial Forward State', () => {
  for (const draft of [14, 16, 18] as const) {
    it(`d${draft}: FORWARD=0 stores PAUSED, FORWARD=1/absent stores ACTIVE — before any acceptance`, () => {
      for (const [fwd, expected] of [[0n, 0], [1n, 1], [null, 1]] as const) {
        const session = serverSession(draft);
        const params: Parameters = fwd === null ? new Map() : new Map([[MessageParam.FORWARD as bigint, [fwd]]]) as Parameters;
        session.handleControlMessage({
          type: 'PUBLISH', requestId: varint(0n), trackNamespace: NS, trackName: NAME,
          trackAlias: varint(50n), parameters: params, trackProperties: new Map(),
        } as never);
        expect(session.getIncomingSubscription(0n)?.forwardState, `d${draft} FORWARD=${fwd}`).toBe(expected);
      }
    });
  }

  it('an explicit acceptance FORWARD overrides the PUBLISH initial state', () => {
    const session = serverSession(18);
    session.handleControlMessage({
      type: 'PUBLISH', requestId: varint(0n), trackNamespace: NS, trackName: NAME,
      trackAlias: varint(50n), parameters: new Map([[MessageParam.FORWARD as bigint, [0n]]]), trackProperties: new Map(),
    } as never);
    expect(session.getIncomingSubscription(0n)?.forwardState).toBe(0);
    session.acceptSubscribe(0n, 50n, {
      parameters: new Map([[MessageParam.FORWARD as bigint, [1n]]]) as Parameters,
    });
    expect(session.getIncomingSubscription(0n)?.forwardState).toBe(1);   // override applied
  });

  it('with NO acceptance override the PUBLISH state persists through acceptance', () => {
    const session = serverSession(18);
    session.handleControlMessage({
      type: 'PUBLISH', requestId: varint(0n), trackNamespace: NS, trackName: NAME,
      trackAlias: varint(50n), parameters: new Map([[MessageParam.FORWARD as bigint, [0n]]]), trackProperties: new Map(),
    } as never);
    session.acceptSubscribe(0n, 50n);
    expect(session.getIncomingSubscription(0n)?.forwardState).toBe(0);   // still PAUSED
  });
});

// ─── rollbackRequest provenance (pre-send ownership transaction) ─────

describe('Session.rollbackRequest', () => {
  const establishedClient = (): Session => clientSession(16);

  it('ordinary rollback drops the request and retains no provenance', () => {
    const session = establishedClient();
    const { requestId } = session.subscribe([new TextEncoder().encode('ns')], new TextEncoder().encode('t'));
    session.rollbackRequest(requestId);
    // A crossed SUBSCRIBE_OK for the rolled-back request is UNKNOWN → violation.
    const actions = session.handleControlMessage({
      type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(9n), parameters: new Map(), trackExtensions: [],
    } as never);
    expect(actions.some((a) => a.type === 'close_connection')).toBe(true);
  });

  it('retained provenance tolerates a crossed SUBSCRIBE_OK', () => {
    const session = establishedClient();
    const { requestId } = session.subscribe([new TextEncoder().encode('ns')], new TextEncoder().encode('t'));
    session.rollbackRequest(requestId, { retainCancellationProvenance: true });
    // The crossed OK is known-cancelled — no session close.
    const actions = session.handleControlMessage({
      type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(9n), parameters: new Map(), trackExtensions: [],
    } as never);
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
  });

  it('retained provenance tolerates a crossed REQUEST_ERROR for a fetch', () => {
    const session = establishedClient();
    const { requestId } = session.fetch(
      [new TextEncoder().encode('ns')], new TextEncoder().encode('t'),
      { startGroup: varint(0n), startObject: varint(0n), endGroup: varint(0n), endObject: varint(1n) },
    );
    session.rollbackRequest(requestId, { retainCancellationProvenance: true });
    const actions = session.handleControlMessage({
      type: 'REQUEST_ERROR', requestId, errorCode: varint(0x11n), retryInterval: varint(0n), errorReason: 'x',
    } as never);
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
  });
});

// ─── Joining Request ID width follows the negotiated draft ───────────

describe('JoiningFetch.joiningRequestId width (d18 vi64 vs d14/16 QUIC varint)', () => {
  // Above the QUIC-varint ceiling (2^62-1) but a valid draft-18 vi64 Request
  // ID. Peer-allocated PUBLISH request IDs are the reachable source of such
  // values on our subscriber side. 2^62 keeps client parity (even).
  const HUGE_REQUEST_ID = 2n ** 62n;

  function subscriberWithEstablishedHugePublish(): Session {
    const session = new Session(EndpointRole.SERVER, 18);
    session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
    // Credit must admit the peer's huge Request ID — pass the raw vi64 value.
    session.completeSetup({ maxRequestId: (HUGE_REQUEST_ID + 2n) as never });
    session.handleControlMessage({
      type: 'PUBLISH', requestId: HUGE_REQUEST_ID, trackNamespace: NS, trackName: NAME,
      trackAlias: varint(9n), parameters: new Map(), trackExtensions: [],
    } as never);
    // Accept: we are the subscriber; the acceptance establishes the
    // publish-initiated subscription (REQUEST_OK on d18).
    session.acceptSubscribe(HUGE_REQUEST_ID as never, varint(9n));
    return session;
  }

  it('d18: joins an accepted PUBLISH whose Request ID exceeds 2^62-1 and round-trips through the codec', () => {
    const session = subscriberWithEstablishedHugePublish();

    const { actions } = session.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: HUGE_REQUEST_ID, joiningStart: 0n,
    });
    const fetchMsg = (actions.find((a) => a.type === 'send_control') as SendControlAction).message as Fetch;
    expect((fetchMsg.fetch as JoiningFetch).joiningRequestId).toBe(HUGE_REQUEST_ID);

    // The selected draft codec enforces its own width: vi64 carries the value.
    const codec = createControlCodec(18);
    const encoded = codec.encode(fetchMsg);
    const decoded = codec.decode(encoded, 0).message as Fetch;
    expect((decoded.fetch as JoiningFetch).joiningRequestId).toBe(HUGE_REQUEST_ID);
    expect((decoded.fetch as JoiningFetch).joiningStart).toBe(0n);
  });

  it.each([14, 16] as const)('d%i: the codec boundary rejects a Joining Request ID above the QUIC-varint range', (draft) => {
    const codec = createControlCodec(draft);
    const fetchMsg: Fetch = {
      type: 'FETCH',
      requestId: varint(0n),
      fetch: { fetchType: 0x2, joiningRequestId: HUGE_REQUEST_ID, joiningStart: 0n },
      parameters: new Map(),
    };
    expect(() => codec.encode(fetchMsg)).toThrow(RangeError);
  });
});
