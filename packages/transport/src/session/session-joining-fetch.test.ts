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
    session.acceptSubscribe(0n, 9n);
    session.handleControlMessage(incomingJoiningFetch(2n, 0n, 0x2));
    return { session, fetchReqId: 2n };
  }

  it('back-fills the publisher fetch SM range from the app-supplied Largest Location', () => {
    const { session, fetchReqId } = acceptedJoiningFetch();
    const range = session.resolveIncomingJoiningFetch(fetchReqId, { group: 10n, object: 7n });

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
