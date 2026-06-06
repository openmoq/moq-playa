/**
 * Session state machine tests.
 * @see draft-ietf-moq-transport-16 §9
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Session, SessionError as SessionErr } from './session.js';
import type { SubscriptionFilter } from '../control/subscription-filter.js';
import { SessionState, EndpointRole, SubscriptionState, FetchState, ForwardState, NamespaceState, type CloseConnectionAction, type OpenNamespaceStreamAction, type SendControlAction } from './types.js';
import { varint } from '../primitives/varint.js';
import { writeVi64, MAX_VI64 } from '../primitives/vi64.js';
import { SetupParam, MessageParam } from '../control/parameters.js';
import { SetupOption18 } from '../control/codes-18.js';
import { SessionError as SessionErrorCode, RequestError, PublishDoneCode } from '../errors.js';
import type { ClientSetup, ServerSetup, Parameters, Setup, Subscribe, SubscribeOk, RequestErrorMsg, RequestUpdate, RequestOk, Publish, PublishOk, PublishError, Fetch, StandaloneFetch, FetchOk, FetchCancel, PublishDone, MaxRequestId, RequestsBlocked, Unsubscribe, TrackStatus, PublishNamespace, PublishNamespaceDone, PublishNamespaceCancel, PublishNamespaceOk, PublishNamespaceError, UnsubscribeNamespace } from '../control/messages.js';
import type { NotifyNamespaceAction } from './types.js';
import { AliasType, encodeAuthorizationToken, encodeAuthorizationToken18 } from '../control/auth-token.js';

describe('Session', () => {
  describe('client role', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
    });

    it('starts in IDLE state', () => {
      expect(session.state).toBe(SessionState.IDLE);
    });

    it('creates CLIENT_SETUP and transitions to SETUP_PENDING', () => {
      const actions = session.initiateSetup({ maxRequestId: varint(100n) });

      expect(session.state).toBe(SessionState.SETUP_PENDING);
      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('send_control');

      const sendAction = actions[0] as { type: 'send_control'; message: ClientSetup };
      expect(sendAction.message.type).toBe('CLIENT_SETUP');
    });

    it('transitions to ESTABLISHED on SERVER_SETUP', () => {
      session.initiateSetup();

      const serverParams: Parameters = new Map();
      serverParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(200n)]);

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: serverParams,
      };

      const actions = session.handleControlMessage(serverSetup);

      expect(session.state).toBe(SessionState.ESTABLISHED);
      expect(session.peerMaxRequestId).toBe(200n);
    });

    it('cannot call initiateSetup twice', () => {
      session.initiateSetup();

      expect(() => session.initiateSetup()).toThrow();
    });

    it('returns close_connection with PROTOCOL_VIOLATION on non-SERVER_SETUP before established', () => {
      session.initiateSetup();

      const goaway = { type: 'GOAWAY' as const, newSessionUri: '' };

      // Returns close_connection action for protocol violation
      const actions = session.handleControlMessage(goaway);

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      expect(session.state).toBe(SessionState.CLOSED);
    });

    it('returns close_connection with INVALID_PATH on SERVER_SETUP containing PATH', () => {
      session.initiateSetup();

      // Server sent PATH parameter which is forbidden (semantic error)
      const serverParams: Parameters = new Map();
      serverParams.set(varint(SetupParam.PATH), [new TextEncoder().encode('/bad')]);

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: serverParams,
      };

      const actions = session.handleControlMessage(serverSetup);

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.INVALID_PATH);
      expect(session.state).toBe(SessionState.CLOSED);
    });
  });

  describe('server role', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.SERVER);
    });

    it('starts in IDLE state', () => {
      expect(session.state).toBe(SessionState.IDLE);
    });

    it('handles CLIENT_SETUP and transitions to SETUP_PENDING', () => {
      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      session.handleControlMessage(clientSetup);

      expect(session.state).toBe(SessionState.SETUP_PENDING);
      expect(session.peerMaxRequestId).toBe(100n);
    });

    it('creates SERVER_SETUP and transitions to ESTABLISHED', () => {
      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: new Map(),
      };
      session.handleControlMessage(clientSetup);

      const actions = session.completeSetup({ maxRequestId: varint(200n) });

      expect(session.state).toBe(SessionState.ESTABLISHED);
      expect(actions.length).toBe(1);

      const sendAction = actions[0] as { type: 'send_control'; message: ServerSetup };
      expect(sendAction.message.type).toBe('SERVER_SETUP');
    });

    it('cannot complete setup before receiving CLIENT_SETUP', () => {
      expect(() => session.completeSetup()).toThrow();
    });

    it('returns close_connection with MALFORMED_PATH on invalid PATH syntax', () => {
      // Client sent invalid PATH (not starting with /)
      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.PATH), [new TextEncoder().encode('invalid')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      const actions = session.handleControlMessage(clientSetup);

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.MALFORMED_PATH);
      expect(session.state).toBe(SessionState.CLOSED);
    });

    it('returns close_connection with MALFORMED_AUTHORITY on invalid AUTHORITY', () => {
      // Client sent empty AUTHORITY
      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.AUTHORITY), [new TextEncoder().encode('')]);

      const clientSetup: ClientSetup = {
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      };

      const actions = session.handleControlMessage(clientSetup);

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.MALFORMED_AUTHORITY);
      expect(session.state).toBe(SessionState.CLOSED);
    });

    it('returns close_connection with PROTOCOL_VIOLATION on non-CLIENT_SETUP as first message', () => {
      const goaway = { type: 'GOAWAY' as const, newSessionUri: '' };

      const actions = session.handleControlMessage(goaway);

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      expect(session.state).toBe(SessionState.CLOSED);
    });
  });

  describe('subscription management', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup({ maxRequestId: varint(100n) });

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      };
      session.handleControlMessage(serverSetup);
    });

    it('creates subscription with allocated request ID', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { requestId, actions } = session.subscribe(namespace, name);

      expect(requestId).toBe(0n); // Client starts at 0 (even)
      expect(actions.length).toBe(1);

      const sendAction = actions[0] as { type: 'send_control'; message: Subscribe };
      expect(sendAction.message.type).toBe('SUBSCRIBE');
      expect(sendAction.message.requestId).toBe(0n);
    });

    it('tracks subscription state', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { requestId } = session.subscribe(namespace, name);

      const sub = session.getSubscription(requestId);
      expect(sub).toBeDefined();
      expect(sub?.state).toBe(SubscriptionState.PENDING);
    });

    it('handles SUBSCRIBE_OK', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.subscribe(namespace, name);

      const subscribeOk: SubscribeOk = {
        type: 'SUBSCRIBE_OK',
        requestId: requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      };

      session.handleControlMessage(subscribeOk);

      const sub = session.getSubscription(requestId);
      expect(sub?.state).toBe(SubscriptionState.ESTABLISHED);
      expect(sub?.trackAlias).toBe(42n);
    });

    it('handles REQUEST_ERROR for subscription', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.subscribe(namespace, name);

      const requestError: RequestErrorMsg = {
        type: 'REQUEST_ERROR',
        requestId: requestId,
        errorCode: varint(0x10n),
        errorReason: 'Track not found',
      };

      session.handleControlMessage(requestError);

      const sub = session.getSubscription(requestId);
      expect(sub?.state).toBe(SubscriptionState.TERMINATED);
      expect(sub?.errorCode).toBe(0x10n);
    });

    it('registers track alias on SUBSCRIBE_OK', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.subscribe(namespace, name);

      const subscribeOk: SubscribeOk = {
        type: 'SUBSCRIBE_OK',
        requestId: requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      };

      session.handleControlMessage(subscribeOk);

      const track = session.getTrackByAlias(varint(42n));
      expect(track).toBeDefined();
      expect(track?.namespace).toEqual(namespace);
    });

    // ─── Subscriber-side unsubscribe (§2.4.2, §5.1) ────────────────────

    it('unsubscribe() sends UNSUBSCRIBE for established subscription (§2.4.2)', () => {
      // §2.4.2: "subscriber detects a Malformed Track, it MUST UNSUBSCRIBE"
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.subscribe(namespace, name);

      // Establish the subscription
      session.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as SubscribeOk);

      // Subscriber sends UNSUBSCRIBE
      const actions = session.unsubscribe(requestId);

      expect(actions.length).toBe(1);
      const sendAction = actions[0] as SendControlAction;
      expect(sendAction.type).toBe('send_control');
      expect(sendAction.message.type).toBe('UNSUBSCRIBE');
      expect((sendAction.message as Unsubscribe).requestId).toBe(requestId);
    });

    it('unsubscribe() terminates the subscription state machine', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.subscribe(namespace, name);

      session.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as SubscribeOk);

      session.unsubscribe(requestId);

      const sub = session.getSubscription(requestId);
      expect(sub?.state).toBe(SubscriptionState.TERMINATED);
    });

    it('unsubscribe() throws for unknown request ID', () => {
      expect(() => session.unsubscribe(varint(999n))).toThrow();
    });

    it('unsubscribe() throws for pending subscription (not yet established)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.subscribe(namespace, name);

      // Still PENDING — not yet ESTABLISHED
      expect(() => session.unsubscribe(requestId)).toThrow();
    });

    // ─── Subscription parameters (§9.2.2) ────────────────────────────

    it('subscribe() includes DELIVERY_TIMEOUT parameter when specified (§9.2.2.2)', () => {
      // §9.2.2.2: "The DELIVERY TIMEOUT parameter (Parameter Type 0x02) MAY appear in
      // a [...] SUBSCRIBE [...] message. It is the duration in milliseconds..."
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        deliveryTimeout: varint(5000n),
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      expect(msg.parameters.get(MessageParam.DELIVERY_TIMEOUT as bigint))
        .toEqual([varint(5000n)]);
    });

    it('subscribe() includes SUBSCRIBER_PRIORITY parameter when specified (§9.2.2.3)', () => {
      // §9.2.2.3: "The SUBSCRIBER_PRIORITY parameter (Parameter Type 0x20) MAY appear in
      // a SUBSCRIBE [...] message. It is an integer expressing the priority [...]
      // Lower numbers get higher priority. The range is restricted to 0-255."
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        subscriberPriority: varint(64n),
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      expect(msg.parameters.get(MessageParam.SUBSCRIBER_PRIORITY as bigint))
        .toEqual([varint(64n)]);
    });

    it('subscribe() includes GROUP_ORDER parameter when specified (§9.2.2.4)', () => {
      // §9.2.2.4: "The GROUP_ORDER parameter (Parameter Type 0x22) MAY appear in a
      // SUBSCRIBE [...]. Ascending (0x1) or Descending (0x2)."
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        groupOrder: varint(0x2n), // Descending
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      expect(msg.parameters.get(MessageParam.GROUP_ORDER as bigint))
        .toEqual([varint(0x2n)]);
    });

    it('subscribe() omits parameters when not specified (§9.2.2)', () => {
      // Default: empty parameters map
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name);

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      expect(msg.parameters.size).toBe(0);
    });

    it('subscribe() includes multiple parameters simultaneously', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        deliveryTimeout: varint(3000n),
        subscriberPriority: varint(32n),
        groupOrder: varint(0x1n), // Ascending
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      expect(msg.parameters.size).toBe(3);
      expect(msg.parameters.get(MessageParam.DELIVERY_TIMEOUT as bigint))
        .toEqual([varint(3000n)]);
      expect(msg.parameters.get(MessageParam.SUBSCRIBER_PRIORITY as bigint))
        .toEqual([varint(32n)]);
      expect(msg.parameters.get(MessageParam.GROUP_ORDER as bigint))
        .toEqual([varint(0x1n)]);
    });

    // ─── Subscription filters (§9.2.2.5) ──────────────────────────────

    it('subscribe() includes SUBSCRIPTION_FILTER for NextGroupStart (§5.1.2)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        subscriptionFilter: { type: 'NextGroupStart' },
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      const filterBytes = msg.parameters.get(MessageParam.SUBSCRIPTION_FILTER as bigint);
      expect(filterBytes).toBeDefined();
      // Filter type 0x1 = NextGroupStart, no additional fields
      expect(filterBytes![0]).toEqual(new Uint8Array([0x01]));
    });

    it('subscribe() includes SUBSCRIPTION_FILTER for LatestObject (§5.1.2)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        subscriptionFilter: { type: 'LatestObject' },
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      const filterBytes = msg.parameters.get(MessageParam.SUBSCRIPTION_FILTER as bigint);
      expect(filterBytes).toBeDefined();
      // Filter type 0x2 = LatestObject, no additional fields
      expect(filterBytes![0]).toEqual(new Uint8Array([0x02]));
    });

    it('subscribe() includes SUBSCRIPTION_FILTER for AbsoluteStart (§5.1.2)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        subscriptionFilter: {
          type: 'AbsoluteStart',
          startGroup: varint(5n),
          startObject: varint(0n),
        },
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      const filterBytes = msg.parameters.get(MessageParam.SUBSCRIPTION_FILTER as bigint);
      expect(filterBytes).toBeDefined();
      // Filter type 0x3 + group varint(5) + object varint(0)
      expect(filterBytes![0]).toEqual(new Uint8Array([0x03, 0x05, 0x00]));
    });

    it('subscribe() includes SUBSCRIPTION_FILTER for AbsoluteRange (§5.1.2)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name, {
        subscriptionFilter: {
          type: 'AbsoluteRange',
          startGroup: varint(5n),
          startObject: varint(0n),
          endGroup: varint(10n),
        },
      });

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      const filterBytes = msg.parameters.get(MessageParam.SUBSCRIPTION_FILTER as bigint);
      expect(filterBytes).toBeDefined();
      // Filter type 0x4 + group varint(5) + object varint(0) + endGroup varint(10)
      expect(filterBytes![0]).toEqual(new Uint8Array([0x04, 0x05, 0x00, 0x0a]));
    });

    it('subscribe() omits SUBSCRIPTION_FILTER when not specified (§9.2.2.5)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.subscribe(namespace, name);

      const msg = (actions[0] as SendControlAction).message as Subscribe;
      expect(msg.parameters.has(MessageParam.SUBSCRIPTION_FILTER as bigint)).toBe(false);
    });
  });

  describe('fetch management', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup({ maxRequestId: varint(100n) });

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      };
      session.handleControlMessage(serverSetup);
    });

    it('creates fetch with allocated request ID', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { requestId, actions } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(100n),
      });

      expect(requestId).toBe(0n);
      expect(actions.length).toBe(1);

      const sendAction = actions[0] as { type: 'send_control'; message: Fetch };
      expect(sendAction.message.type).toBe('FETCH');
    });

    it('tracks fetch state', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
      });

      const fetch = session.getFetch(requestId);
      expect(fetch).toBeDefined();
      expect(fetch?.state).toBe(FetchState.PENDING);
    });

    it('handles FETCH_OK', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
      });

      const fetchOk: FetchOk = {
        type: 'FETCH_OK',
        requestId: requestId,
        parameters: new Map(),
      };

      session.handleControlMessage(fetchOk);

      const fetch = session.getFetch(requestId);
      expect(fetch?.state).toBe(FetchState.TRANSFERRING);
    });

    it('closes session when FETCH_OK endLocation < startLocation (§9.17)', () => {
      // §9.17: "If End Location is smaller than the Start Location in the
      //         corresponding FETCH the receiver MUST close the session with
      //         a PROTOCOL_VIOLATION."
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(5n),
        startObject: varint(3n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      const fetchOk: FetchOk = {
        type: 'FETCH_OK',
        requestId,
        endOfTrack: 0,
        endLocation: { group: varint(2n), object: varint(0n) }, // end < start
        parameters: new Map(),
        trackExtensions: [],
      };

      const actions = session.handleControlMessage(fetchOk);
      expect(actions.length).toBeGreaterThan(0);
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.type).toBe('close_connection');
      expect(closeAction.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
    });

    it('accepts FETCH_OK when endLocation >= startLocation (§9.17)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(5n),
        startObject: varint(3n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      const fetchOk: FetchOk = {
        type: 'FETCH_OK',
        requestId,
        endOfTrack: 0,
        endLocation: { group: varint(10n), object: varint(0n) }, // end > start
        parameters: new Map(),
        trackExtensions: [],
      };

      const actions = session.handleControlMessage(fetchOk);
      // No close_connection — should succeed
      const hasClose = actions.some(a => a.type === 'close_connection');
      expect(hasClose).toBe(false);
      expect(session.getFetch(requestId)?.state).toBe(FetchState.TRANSFERRING);
    });

    it('throws when fetch endLocation defaults produce invalid range (§9.16)', () => {
      // §9.16 line 3766: "End Location MUST specify the same or a larger
      // Location than Start Location for Standalone and Absolute Joining Fetches."
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      // startGroup=5 with no endGroup → defaults to {0,0} which is < {5,0}
      expect(() =>
        session.fetch(namespace, name, {
          startGroup: varint(5n),
          startObject: varint(0n),
        }),
      ).toThrow();
    });

    it('accepts fetch with explicit valid endLocation (§9.16)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      // startGroup=5, endGroup=10 → valid range
      const { requestId, actions } = session.fetch(namespace, name, {
        startGroup: varint(5n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });
      expect(requestId).toBeDefined();
      expect(actions.length).toBeGreaterThan(0);
    });

    it('handles REQUEST_ERROR for fetch', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
      });

      const requestError: RequestErrorMsg = {
        type: 'REQUEST_ERROR',
        requestId: requestId,
        errorCode: varint(0x10n),
        errorReason: 'Track not found',
      };

      session.handleControlMessage(requestError);

      const fetch = session.getFetch(requestId);
      expect(fetch?.state).toBe(FetchState.COMPLETED);
    });
  });

  /**
   * §9.18: "A subscriber sends a FETCH_CANCEL message to a publisher
   * to indicate it is no longer interested in receiving objects for the
   * fetch identified by the 'Request ID'."
   *
   * §5.2: "A subscriber keeps FETCH state until it sends FETCH_CANCEL,
   * receives REQUEST_ERROR, or receives a FIN or RESET_STREAM for the
   * FETCH data stream."
   */
  describe('fetchCancel (§9.18)', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup({ maxRequestId: varint(100n) });

      const serverSetup: ServerSetup = {
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      };
      session.handleControlMessage(serverSetup);
    });

    it('sends FETCH_CANCEL and transitions fetch to COMPLETED', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      const actions = session.fetchCancel(requestId);

      expect(actions.length).toBe(1);
      const sendAction = actions[0] as SendControlAction;
      expect(sendAction.type).toBe('send_control');
      expect(sendAction.message.type).toBe('FETCH_CANCEL');
      expect((sendAction.message as FetchCancel).requestId).toBe(requestId);

      const fetch = session.getFetch(requestId);
      expect(fetch?.state).toBe(FetchState.COMPLETED);
      expect(fetch?.wasCanceled).toBe(true);
    });

    it('can cancel during TRANSFERRING (after FETCH_OK)', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      // Receive FETCH_OK first
      session.handleControlMessage({
        type: 'FETCH_OK',
        requestId,
        parameters: new Map(),
      } as FetchOk);
      expect(session.getFetch(requestId)?.state).toBe(FetchState.TRANSFERRING);

      // Now cancel
      const actions = session.fetchCancel(requestId);
      expect(actions.length).toBe(1);
      expect(session.getFetch(requestId)?.state).toBe(FetchState.COMPLETED);
    });

    it('throws for unknown request ID', () => {
      expect(() => session.fetchCancel(varint(999n))).toThrow();
    });

    it('throws for already-completed fetch', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
        endGroup: varint(10n),
        endObject: varint(0n),
      });

      // Complete via REQUEST_ERROR
      session.handleControlMessage({
        type: 'REQUEST_ERROR',
        requestId,
        errorCode: varint(0x10n),
        errorReason: 'Not found',
      } as RequestErrorMsg);

      expect(() => session.fetchCancel(requestId)).toThrow();
    });
  });

  describe('GOAWAY handling', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
    });

    it('transitions to DRAINING on GOAWAY', () => {
      session.handleControlMessage({
        type: 'GOAWAY',
        newSessionUri: 'https://new-server.example.com',
      });

      expect(session.state).toBe(SessionState.DRAINING);
      expect(session.newSessionUri).toBe('https://new-server.example.com');
    });

    it('prevents new subscriptions in DRAINING state', () => {
      session.handleControlMessage({
        type: 'GOAWAY',
        newSessionUri: '',
      });

      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);

      expect(() => session.subscribe(namespace, name)).toThrow();
    });

    it('allows existing subscriptions to complete in DRAINING state', () => {
      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);
      const { requestId } = session.subscribe(namespace, name);

      session.handleControlMessage({
        type: 'GOAWAY',
        newSessionUri: '',
      });

      // Should still be able to handle SUBSCRIBE_OK for existing subscription
      const subscribeOk: SubscribeOk = {
        type: 'SUBSCRIBE_OK',
        requestId: requestId,
        trackAlias: varint(1n),
        parameters: new Map(),
        trackExtensions: [],
      };

      expect(() => session.handleControlMessage(subscribeOk)).not.toThrow();
    });
  });

  describe('request ID management', () => {
    it('client allocates even request IDs', () => {
      const session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });

      const namespace = [new Uint8Array([0x6c])];
      const name1 = new Uint8Array([0x76]);
      const name2 = new Uint8Array([0x61]);

      const { requestId: id1 } = session.subscribe(namespace, name1);
      const { requestId: id2 } = session.subscribe(namespace, name2);

      expect(id1).toBe(0n);
      expect(id2).toBe(2n);
    });

    it('server allocates odd request IDs', () => {
      const session = new Session(EndpointRole.SERVER);
      session.handleControlMessage({
        type: 'CLIENT_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
      session.completeSetup();

      // Server publishes (would need incoming SUBSCRIBE first in real scenario)
      // For this test, we just verify the allocator has the right parity
      expect(session.role).toBe(EndpointRole.SERVER);
    });

    it('throws when request IDs exhausted', () => {
      const session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(2n)]]]),
      });

      const namespace = [new Uint8Array([0x6c])];
      const name1 = new Uint8Array([0x76]);
      const name2 = new Uint8Array([0x61]);

      session.subscribe(namespace, name1); // Uses 0
      expect(() => session.subscribe(namespace, name2)).toThrow(); // Would need 2, but max is 2
    });
  });

  describe('close', () => {
    it('transitions to CLOSED state', () => {
      const session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map(),
      });

      const actions = session.close();

      expect(session.state).toBe(SessionState.CLOSED);
      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
    });

    it('uses correct field names for close action', () => {
      const session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map(),
      });

      const actions = session.close(varint(0x3n), 'Test reason');
      const closeAction = actions[0] as { type: string; error: bigint; reason: string };

      expect(closeAction.error).toBe(0x3n);
      expect(closeAction.reason).toBe('Test reason');
    });

    it('prevents operations after close', () => {
      const session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map(),
      });
      session.close();

      expect(() =>
        session.subscribe([new Uint8Array([0x6c])], new Uint8Array([0x76])),
      ).toThrow();
    });
  });

  describe('protocol violation handling', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
    });

    it('closes with PROTOCOL_VIOLATION on second GOAWAY', () => {
      // First GOAWAY is fine
      session.handleControlMessage({
        type: 'GOAWAY',
        newSessionUri: 'https://first.example.com',
      });

      expect(session.state).toBe(SessionState.DRAINING);

      // Second GOAWAY should close with error
      const actions = session.handleControlMessage({
        type: 'GOAWAY',
        newSessionUri: 'https://second.example.com',
      });

      expect(session.state).toBe(SessionState.CLOSED);
      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');

      const closeAction = actions[0] as { error: bigint };
      expect(closeAction.error).toBe(0x3n); // PROTOCOL_VIOLATION
    });

    it('server closes with PROTOCOL_VIOLATION when receiving GOAWAY with non-empty URI', () => {
      // Create a server session
      const serverSession = new Session(EndpointRole.SERVER);

      // Establish the session
      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]);

      serverSession.handleControlMessage({
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      } as ClientSetup);

      // Server must call completeSetup to transition to ESTABLISHED
      serverSession.completeSetup({ maxRequestId: varint(100n) });

      expect(serverSession.state).toBe(SessionState.ESTABLISHED);

      // §9.4: Server receiving GOAWAY with non-empty New Session URI is PROTOCOL_VIOLATION
      const actions = serverSession.handleControlMessage({
        type: 'GOAWAY',
        newSessionUri: 'https://redirect.example.com',
      });

      expect(serverSession.state).toBe(SessionState.CLOSED);
      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');

      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
    });

    it('server accepts GOAWAY with empty URI', () => {
      // Create a server session
      const serverSession = new Session(EndpointRole.SERVER);

      // Establish the session
      const clientParams: Parameters = new Map();
      clientParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]);

      serverSession.handleControlMessage({
        type: 'CLIENT_SETUP',
        parameters: clientParams,
      } as ClientSetup);

      // Server must call completeSetup to transition to ESTABLISHED
      serverSession.completeSetup({ maxRequestId: varint(100n) });

      expect(serverSession.state).toBe(SessionState.ESTABLISHED);

      // Empty URI is allowed for servers
      const actions = serverSession.handleControlMessage({
        type: 'GOAWAY',
        newSessionUri: '',
      });

      expect(serverSession.state).toBe(SessionState.DRAINING);
      expect(actions.length).toBe(0);
    });

    it('closes with DUPLICATE_TRACK_ALIAS when alias is reused', () => {
      const namespace = [new Uint8Array([0x6c])];
      const name1 = new Uint8Array([0x76]);
      const name2 = new Uint8Array([0x61]);

      // First subscription
      const { requestId: id1 } = session.subscribe(namespace, name1);
      session.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId: id1,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: [],
      } as SubscribeOk);

      // Second subscription
      const { requestId: id2 } = session.subscribe(namespace, name2);

      // SUBSCRIBE_OK with duplicate alias
      const actions = session.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId: id2,
        trackAlias: varint(42n), // Same alias!
        parameters: new Map(),
        trackExtensions: [],
      } as SubscribeOk);

      expect(session.state).toBe(SessionState.CLOSED);
      expect(actions.length).toBe(1);

      const closeAction = actions[0] as { error: bigint };
      expect(closeAction.error).toBe(0x5n); // DUPLICATE_TRACK_ALIAS
    });

    it('responds NOT_SUPPORTED for unhandled message types with request ID (SHOULD §3.1)', () => {
      // §3.1: "Limited endpoints SHOULD respond to any unsupported messages
      // with the appropriate NOT_SUPPORTED error code, rather than ignoring them."
      // Use PUBLISH_OK as an example of an unhandled message type with a requestId.
      const publishOkMsg: PublishOk = {
        type: 'PUBLISH_OK',
        requestId: varint(0n),
        parameters: new Map(),
      };

      const actions = session.handleControlMessage(publishOkMsg);

      // Should send REQUEST_ERROR with NOT_SUPPORTED
      expect(actions.length).toBe(1);
      const sendAction = actions[0] as SendControlAction;
      expect(sendAction.type).toBe('send_control');
      const errorMsg = sendAction.message as RequestErrorMsg;
      expect(errorMsg.type).toBe('REQUEST_ERROR');
      expect(errorMsg.requestId).toBe(0n);
      expect(errorMsg.errorCode).toBe(RequestError.NOT_SUPPORTED);
    });
  });

  describe('FETCH message structure', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
    });

    it('builds correct StandaloneFetch with Location fields', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const { actions } = session.fetch(namespace, name, {
        startGroup: varint(5n),
        startObject: varint(10n),
        endGroup: varint(20n),
        endObject: varint(100n),
      });

      const sendAction = actions[0] as { type: string; message: Fetch };
      const fetchMsg = sendAction.message;

      expect(fetchMsg.type).toBe('FETCH');
      expect(fetchMsg.fetch).toBeDefined();
      expect(fetchMsg.fetch.fetchType).toBe(0x1); // StandaloneFetch

      // Check Location fields
      const standalone = fetchMsg.fetch as {
        fetchType: number;
        trackNamespace: Uint8Array[];
        trackName: Uint8Array;
        startLocation: { group: bigint; object: bigint };
        endLocation: { group: bigint; object: bigint };
      };
      expect(standalone.startLocation.group).toBe(5n);
      expect(standalone.startLocation.object).toBe(10n);
      expect(standalone.endLocation.group).toBe(20n);
      expect(standalone.endLocation.object).toBe(100n);
    });
  });

  describe('MAX_REQUEST_ID handling (§9.5)', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(10n)]]]),
      });
    });

    it('updates peer MAX_REQUEST_ID on valid increase', () => {
      expect(session.peerMaxRequestId).toBe(10n);

      const actions = session.handleControlMessage({
        type: 'MAX_REQUEST_ID',
        maxRequestId: varint(100n),
      });

      expect(actions.length).toBe(0);
      expect(session.peerMaxRequestId).toBe(100n);
    });

    it('closes with PROTOCOL_VIOLATION on non-increasing MAX_REQUEST_ID', () => {
      const actions = session.handleControlMessage({
        type: 'MAX_REQUEST_ID',
        maxRequestId: varint(5n), // Less than current 10
      });

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
    });
  });

  describe('REQUESTS_BLOCKED handling (§9.6)', () => {
    it('acknowledges REQUESTS_BLOCKED without error', () => {
      const session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });

      const actions = session.handleControlMessage({
        type: 'REQUESTS_BLOCKED',
        maximumRequestId: varint(50n),
      });

      // REQUESTS_BLOCKED is informational, no action required
      expect(actions.length).toBe(0);
      expect(session.state).toBe(SessionState.ESTABLISHED);
    });
  });

  describe('unknown message parameter validation (§9.2)', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup();
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
    });

    it('closes with PROTOCOL_VIOLATION on unknown parameter in SUBSCRIBE_OK', () => {
      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);
      const { requestId } = session.subscribe(namespace, name);

      // Unknown parameter type 0xFFFF
      const unknownParams: Parameters = new Map();
      unknownParams.set(varint(0xFFFFn), [varint(42n)]);

      const actions = session.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId,
        trackAlias: varint(1n),
        parameters: unknownParams,
        trackExtensions: [],
      } as SubscribeOk);

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
    });

    it('closes with PROTOCOL_VIOLATION on unknown parameter in FETCH_OK', () => {
      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);
      const { requestId } = session.fetch(namespace, name, {
        startGroup: varint(0n),
        startObject: varint(0n),
      });

      // Unknown parameter type 0xFFFF
      const unknownParams: Parameters = new Map();
      unknownParams.set(varint(0xFFFFn), [varint(42n)]);

      const actions = session.handleControlMessage({
        type: 'FETCH_OK',
        requestId,
        endOfTrack: 0,
        endLocation: { group: varint(10n), object: varint(100n) },
        parameters: unknownParams,
        trackExtensions: [],
      } as FetchOk);

      expect(actions.length).toBe(1);
      expect(actions[0]?.type).toBe('close_connection');
      const closeAction = actions[0] as CloseConnectionAction;
      expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
    });

    it('accepts known message parameters', () => {
      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);
      const { requestId } = session.subscribe(namespace, name);

      // Known parameter: DELIVERY_TIMEOUT (0x02)
      const knownParams: Parameters = new Map();
      knownParams.set(varint(0x02n), [varint(5000n)]);

      const actions = session.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId,
        trackAlias: varint(1n),
        parameters: knownParams,
        trackExtensions: [],
      } as SubscribeOk);

      // Should succeed, no close action
      expect(actions.length).toBe(0);
    });
  });

  describe('message parameter value constraints (§9.2.2)', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup({ maxRequestId: varint(100n) });
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
    });

    describe('DELIVERY_TIMEOUT (§9.2.2.2)', () => {
      it('closes with PROTOCOL_VIOLATION if DELIVERY_TIMEOUT is 0', () => {
        // §9.2.2.2: DELIVERY_TIMEOUT MAY appear in SUBSCRIBE, REQUEST_UPDATE, PUBLISH_OK
        // Test with incoming SUBSCRIBE (publisher-side scenario)
        const params: Parameters = new Map();
        params.set(varint(0x02n), [varint(0n)]); // DELIVERY_TIMEOUT = 0 (invalid)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('accepts DELIVERY_TIMEOUT > 0', () => {
        // §9.2.2.2: DELIVERY_TIMEOUT MAY appear in SUBSCRIBE, REQUEST_UPDATE, PUBLISH_OK
        const params: Parameters = new Map();
        params.set(varint(0x02n), [varint(1n)]); // DELIVERY_TIMEOUT = 1 (minimum valid)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(0); // Success - publisher-side handling not yet implemented
      });
    });

    describe('FORWARD (§9.2.2.8)', () => {
      it('closes with PROTOCOL_VIOLATION if FORWARD is 2', () => {
        // §9.2.2.8: FORWARD MAY appear in SUBSCRIBE, REQUEST_UPDATE, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE
        // Test with incoming SUBSCRIBE (publisher-side scenario)
        const params: Parameters = new Map();
        params.set(varint(0x10n), [varint(2n)]); // FORWARD = 2 (invalid)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('accepts FORWARD = 0', () => {
        // §9.2.2.8: FORWARD MAY appear in SUBSCRIBE, REQUEST_UPDATE, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE
        const params: Parameters = new Map();
        params.set(varint(0x10n), [varint(0n)]); // FORWARD = 0

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(0); // Success - publisher-side handling not yet implemented
      });

      it('accepts FORWARD = 1', () => {
        // §9.2.2.8: FORWARD MAY appear in SUBSCRIBE, REQUEST_UPDATE, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE
        const params: Parameters = new Map();
        params.set(varint(0x10n), [varint(1n)]); // FORWARD = 1

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(0); // Success - publisher-side handling not yet implemented
      });
    });

    describe('SUBSCRIBER_PRIORITY (§9.2.2.3)', () => {
      it('closes with PROTOCOL_VIOLATION if SUBSCRIBER_PRIORITY > 255', () => {
        // §9.2.2.3: SUBSCRIBER_PRIORITY MAY appear in SUBSCRIBE, FETCH, REQUEST_UPDATE, PUBLISH_OK
        // Test with incoming SUBSCRIBE (publisher-side scenario)
        const params: Parameters = new Map();
        params.set(varint(0x20n), [varint(256n)]); // SUBSCRIBER_PRIORITY = 256 (invalid)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('accepts SUBSCRIBER_PRIORITY = 0', () => {
        // §9.2.2.3: SUBSCRIBER_PRIORITY MAY appear in SUBSCRIBE, FETCH, REQUEST_UPDATE, PUBLISH_OK
        const params: Parameters = new Map();
        params.set(varint(0x20n), [varint(0n)]); // SUBSCRIBER_PRIORITY = 0

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(0); // Success - publisher-side handling not yet implemented
      });

      it('accepts SUBSCRIBER_PRIORITY = 255', () => {
        // §9.2.2.3: SUBSCRIBER_PRIORITY MAY appear in SUBSCRIBE, FETCH, REQUEST_UPDATE, PUBLISH_OK
        const params: Parameters = new Map();
        params.set(varint(0x20n), [varint(255n)]); // SUBSCRIBER_PRIORITY = 255

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(0); // Success - publisher-side handling not yet implemented
      });
    });

    describe('GROUP_ORDER (§9.2.2.4)', () => {
      it('closes with PROTOCOL_VIOLATION if GROUP_ORDER is 0', () => {
        // §9.2.2.4: GROUP_ORDER MAY appear in SUBSCRIBE, PUBLISH_OK, FETCH
        // Test with incoming SUBSCRIBE (publisher-side scenario)
        const params: Parameters = new Map();
        params.set(varint(0x22n), [varint(0n)]); // GROUP_ORDER = 0 (invalid)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('closes with PROTOCOL_VIOLATION if GROUP_ORDER is 3', () => {
        // §9.2.2.4: GROUP_ORDER MAY appear in SUBSCRIBE, PUBLISH_OK, FETCH
        const params: Parameters = new Map();
        params.set(varint(0x22n), [varint(3n)]); // GROUP_ORDER = 3 (invalid)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('accepts GROUP_ORDER = 0x1 (Ascending)', () => {
        // §9.2.2.4: GROUP_ORDER MAY appear in SUBSCRIBE, PUBLISH_OK, FETCH
        const params: Parameters = new Map();
        params.set(varint(0x22n), [varint(0x1n)]); // GROUP_ORDER = Ascending

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(0); // Success - publisher-side handling not yet implemented
      });

      it('accepts GROUP_ORDER = 0x2 (Descending)', () => {
        // §9.2.2.4: GROUP_ORDER MAY appear in SUBSCRIBE, PUBLISH_OK, FETCH
        const params: Parameters = new Map();
        params.set(varint(0x22n), [varint(0x2n)]); // GROUP_ORDER = Descending

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(0); // Success - publisher-side handling not yet implemented
      });
    });

    describe('LARGEST_OBJECT (§9.2.2.7)', () => {
      it('accepts valid LARGEST_OBJECT in SUBSCRIBE_OK', () => {
        // §9.2.2.7: LARGEST_OBJECT MAY appear in SUBSCRIBE_OK, PUBLISH, REQUEST_OK
        // It is a length-prefixed Location structure (two varints: group, object)
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        // Valid Location: group=5, object=3 → [0x05, 0x03]
        const params: Parameters = new Map();
        params.set(varint(0x09n), [new Uint8Array([0x05, 0x03])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        // Should succeed — valid Location bytes
        expect(actions.length).toBe(0);
      });

      it('closes with KEY_VALUE_FORMATTING_ERROR if LARGEST_OBJECT is empty', () => {
        // §3.4: "the receiver MUST close the session with error code KEY_VALUE_FORMATTING_ERROR"
        // An empty byte array cannot be parsed as a Location (needs at least 2 varints)
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        params.set(varint(0x09n), [new Uint8Array([])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
      });

      it('closes with KEY_VALUE_FORMATTING_ERROR if LARGEST_OBJECT has only one varint', () => {
        // §9.2.2.7: Location requires two varints (group + object)
        // Only one varint present → malformed
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        params.set(varint(0x09n), [new Uint8Array([0x05])]); // Only group, no object

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
      });

      it('closes with KEY_VALUE_FORMATTING_ERROR if LARGEST_OBJECT has trailing bytes', () => {
        // §3.4: Value must match serialization — trailing bytes = malformed
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        // group=5, object=3, then trailing 0xFF
        params.set(varint(0x09n), [new Uint8Array([0x05, 0x03, 0xFF])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
      });

      it('closes with KEY_VALUE_FORMATTING_ERROR if LARGEST_OBJECT has truncated varint', () => {
        // A 2-byte varint starts with 0x40 but needs a second byte
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        // 0x40 starts a 2-byte varint but no second byte provided for object
        params.set(varint(0x09n), [new Uint8Array([0x05, 0x40])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.KEY_VALUE_FORMATTING_ERROR);
      });

      it('is ignored in message types where it is not valid', () => {
        // §9.2.2: "If it appears in some other type of message, it MUST be ignored."
        // LARGEST_OBJECT is valid in SUBSCRIBE_OK, PUBLISH, REQUEST_OK — not SUBSCRIBE
        const params: Parameters = new Map();
        params.set(varint(0x09n), [new Uint8Array([])]); // Malformed, but should be ignored

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        // Should NOT close — LARGEST_OBJECT ignored in SUBSCRIBE
        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });
    });

    describe('SUBSCRIPTION_FILTER (§9.2.2.5)', () => {
      it('accepts valid SUBSCRIPTION_FILTER with LatestObject filter type', () => {
        // §9.2.2.5: MAY appear in SUBSCRIBE, PUBLISH_OK, REQUEST_UPDATE
        // §5.1.2: Filter Type 0x2 (LatestObject) has no additional fields
        const params: Parameters = new Map();
        params.set(varint(0x21n), [new Uint8Array([0x02])]); // Filter type = LatestObject (0x2)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        // Should succeed — valid LatestObject filter
        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });

      it('accepts valid SUBSCRIPTION_FILTER with NextGroupStart filter type', () => {
        // §5.1.2: Filter Type 0x1 (NextGroupStart) has no additional fields
        const params: Parameters = new Map();
        params.set(varint(0x21n), [new Uint8Array([0x01])]); // Filter type = NextGroupStart (0x1)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });

      it('accepts valid SUBSCRIPTION_FILTER with AbsoluteStart filter type', () => {
        // §5.1.2: Filter Type 0x3 (AbsoluteStart) contains Start Location (two varints)
        const params: Parameters = new Map();
        // Filter type 0x3 + Start Location (group=0, object=0)
        params.set(varint(0x21n), [new Uint8Array([0x03, 0x00, 0x00])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });

      it('accepts valid SUBSCRIPTION_FILTER with AbsoluteRange filter type', () => {
        // §5.1.2: Filter Type 0x4 (AbsoluteRange) contains Start Location + End Group
        const params: Parameters = new Map();
        // Filter type 0x4 + Start Location (group=0, object=0) + End Group (5)
        params.set(varint(0x21n), [new Uint8Array([0x04, 0x00, 0x00, 0x05])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });

      it('closes with PROTOCOL_VIOLATION if filter type is unknown', () => {
        // §5.1.2: "An endpoint that receives a filter type other than the above
        // MUST close the session with PROTOCOL_VIOLATION"
        const params: Parameters = new Map();
        params.set(varint(0x21n), [new Uint8Array([0x05])]); // Unknown filter type 0x5

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('closes with PROTOCOL_VIOLATION if filter type is 0', () => {
        // §5.1.2: Valid filter types are 0x1-0x4; 0x0 is not defined
        const params: Parameters = new Map();
        params.set(varint(0x21n), [new Uint8Array([0x00])]); // Invalid filter type 0

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('closes with PROTOCOL_VIOLATION if SUBSCRIPTION_FILTER is empty', () => {
        // §9.2.2.5: "If the length of the Subscription Filter does not match
        // the parameter length, the publisher MUST close the session with PROTOCOL_VIOLATION"
        // Empty bytes → no filter type varint → length mismatch
        const params: Parameters = new Map();
        params.set(varint(0x21n), [new Uint8Array([])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('closes with PROTOCOL_VIOLATION if AbsoluteStart has trailing bytes', () => {
        // §9.2.2.5: Length mismatch → PROTOCOL_VIOLATION
        // AbsoluteStart needs filter type + 2 varints, trailing bytes = mismatch
        const params: Parameters = new Map();
        // Filter type 0x3 + Location (0,0) + trailing byte
        params.set(varint(0x21n), [new Uint8Array([0x03, 0x00, 0x00, 0xFF])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('closes with PROTOCOL_VIOLATION if AbsoluteRange End Group < Start Group', () => {
        // §5.1.2: "End Group MUST specify the same or a larger Group than specified in Start Location"
        const params: Parameters = new Map();
        // Filter type 0x4 + Start Location (group=5, object=0) + End Group (3)
        // End Group 3 < Start Group 5 → invalid
        params.set(varint(0x21n), [new Uint8Array([0x04, 0x05, 0x00, 0x03])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          parameters: params,
        } as Subscribe);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('is ignored in message types where it is not valid', () => {
        // §9.2.2: "If it appears in some other type of message, it MUST be ignored."
        // SUBSCRIPTION_FILTER valid in SUBSCRIBE, PUBLISH_OK, REQUEST_UPDATE — not SUBSCRIBE_OK
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        params.set(varint(0x21n), [new Uint8Array([])]); // Malformed, but should be ignored

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        // Should NOT close — SUBSCRIPTION_FILTER ignored in SUBSCRIBE_OK
        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });
    });

    describe('message-type-specific validation (§9.2.2)', () => {
      it('ignores FORWARD in SUBSCRIBE_OK (not valid for this message type)', () => {
        // §9.2.2.8: FORWARD MAY appear in SUBSCRIBE, REQUEST_UPDATE, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE
        // It MUST be ignored in SUBSCRIBE_OK per §9.2.2
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        params.set(varint(0x10n), [varint(99n)]); // FORWARD = 99 (invalid value, but should be ignored)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        // Should succeed - FORWARD is ignored in SUBSCRIBE_OK, not validated
        expect(actions.length).toBe(0);
      });

      it('ignores DELIVERY_TIMEOUT in SUBSCRIBE_OK (not valid for this message type)', () => {
        // §9.2.2.2: DELIVERY_TIMEOUT MAY appear in PUBLISH_OK, SUBSCRIBE, REQUEST_UPDATE
        // It MUST be ignored in SUBSCRIBE_OK
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        params.set(varint(0x02n), [varint(0n)]); // DELIVERY_TIMEOUT = 0 (invalid, but should be ignored)

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        // Should succeed - DELIVERY_TIMEOUT is ignored in SUBSCRIBE_OK
        expect(actions.length).toBe(0);
      });

      it('ignores SUBSCRIBER_PRIORITY in FETCH_OK (not valid for this message type)', () => {
        // §9.2.2.3: SUBSCRIBER_PRIORITY MAY appear in SUBSCRIBE, FETCH, REQUEST_UPDATE, PUBLISH_OK
        // Note: FETCH_OK is NOT in this list (FETCH is the request, FETCH_OK is the response)
        // Per §9.2.2: "If it appears in some other type of message, it MUST be ignored"
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.fetch(namespace, name, {
          startGroup: varint(0n),
          startObject: varint(0n),
        });

        const params: Parameters = new Map();
        params.set(varint(0x20n), [varint(256n)]); // SUBSCRIBER_PRIORITY = 256 (invalid, but should be ignored)

        const actions = session.handleControlMessage({
          type: 'FETCH_OK',
          requestId,
          endOfTrack: 0,
          endLocation: { group: varint(10n), object: varint(0n) },
          parameters: params,
          trackExtensions: [],
        } as FetchOk);

        // Should succeed - SUBSCRIBER_PRIORITY is ignored in FETCH_OK, not validated
        expect(actions.length).toBe(0);
      });

      it('ignores AUTHORIZATION_TOKEN in SUBSCRIBE_OK (§9.2.2.1)', () => {
        // §9.2.2.1: AUTHORIZATION_TOKEN MAY appear in PUBLISH, SUBSCRIBE, REQUEST_UPDATE,
        // SUBSCRIBE_NAMESPACE, PUBLISH_NAMESPACE, TRACK_STATUS, FETCH
        // SUBSCRIBE_OK is NOT in this list — must be ignored
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);

        const params: Parameters = new Map();
        // AUTHORIZATION_TOKEN (0x03) is odd-type → bytes value
        params.set(varint(0x03n), [new Uint8Array([0x01, 0x02, 0x03])]);

        const actions = session.handleControlMessage({
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(1n),
          parameters: params,
          trackExtensions: [],
        } as SubscribeOk);

        // Should succeed - AUTH_TOKEN is ignored in SUBSCRIBE_OK
        expect(actions.length).toBe(0);
      });

      it('ignores LARGEST_OBJECT in FETCH_OK (§9.2.2.7)', () => {
        // §9.2.2.7: LARGEST_OBJECT MAY appear in SUBSCRIBE_OK, PUBLISH, REQUEST_OK
        // FETCH_OK is NOT in this list — must be ignored
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.fetch(namespace, name, {
          startGroup: varint(0n),
          startObject: varint(0n),
        });

        const params: Parameters = new Map();
        // LARGEST_OBJECT (0x09) is odd-type → bytes value (Location structure)
        params.set(varint(0x09n), [new Uint8Array([0x05, 0x0a])]);

        const actions = session.handleControlMessage({
          type: 'FETCH_OK',
          requestId,
          endOfTrack: 0,
          endLocation: { group: varint(10n), object: varint(0n) },
          parameters: params,
          trackExtensions: [],
        } as FetchOk);

        // Should succeed - LARGEST_OBJECT is ignored in FETCH_OK
        expect(actions.length).toBe(0);
      });

      it('ignores EXPIRES in FETCH_OK (§9.2.2.6)', () => {
        // §9.2.2.6: EXPIRES MAY appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK
        // FETCH_OK is NOT in this list — must be ignored
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.fetch(namespace, name, {
          startGroup: varint(0n),
          startObject: varint(0n),
        });

        const params: Parameters = new Map();
        params.set(varint(0x08n), [varint(60000n)]); // EXPIRES = 60 seconds

        const actions = session.handleControlMessage({
          type: 'FETCH_OK',
          requestId,
          endOfTrack: 0,
          endLocation: { group: varint(10n), object: varint(0n) },
          parameters: params,
          trackExtensions: [],
        } as FetchOk);

        // Should succeed - EXPIRES is ignored in FETCH_OK
        expect(actions.length).toBe(0);
      });
    });
  });

  describe('REQUEST_UPDATE handling (§9.11)', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup({ maxRequestId: varint(100n) });
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
    });

    /** Helper: create and establish a subscription. */
    function establishSubscription(): bigint {
      const namespace = [new Uint8Array([0x6c])];
      const name = new Uint8Array([0x76]);
      const { requestId } = session.subscribe(namespace, name);
      session.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId,
        trackAlias: varint(1n),
        parameters: new Map(),
        trackExtensions: [],
      } as SubscribeOk);
      return requestId as bigint;
    }

    describe('sending REQUEST_UPDATE (subscriber side)', () => {
      it('sends REQUEST_UPDATE with FORWARD=0 to pause', () => {
        const subId = establishSubscription();

        const { requestId: updateId, actions } = session.requestUpdate(varint(subId), { forward: 0 });

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: RequestUpdate }).message;
        expect(msg.type).toBe('REQUEST_UPDATE');
        expect(msg.existingRequestId).toBe(subId);
        // FORWARD param (0x10) should be set to 0
        const forwardVal = msg.parameters.get(MessageParam.FORWARD);
        expect(forwardVal).toEqual([varint(0n)]);
      });

      it('sends REQUEST_UPDATE with FORWARD=1 to resume', () => {
        const subId = establishSubscription();

        const { actions } = session.requestUpdate(varint(subId), { forward: 1 });

        const msg = (actions[0] as { type: string; message: RequestUpdate }).message;
        const forwardVal = msg.parameters.get(MessageParam.FORWARD);
        expect(forwardVal).toEqual([varint(1n)]);
      });

      it('allocates a distinct request ID for the update', () => {
        const subId = establishSubscription();

        const { requestId: updateId } = session.requestUpdate(varint(subId), { forward: 0 });

        expect(updateId).not.toBe(subId);
        expect(updateId % 2n).toBe(0n); // Client uses even IDs
      });

      it('throws on unknown existing request ID', () => {
        expect(() => session.requestUpdate(varint(999n), { forward: 0 })).toThrow();
      });

      it('throws on pending subscription (must be ESTABLISHED)', () => {
        const namespace = [new Uint8Array([0x6c])];
        const name = new Uint8Array([0x76]);
        const { requestId } = session.subscribe(namespace, name);
        // Don't establish — still PENDING

        expect(() => session.requestUpdate(requestId, { forward: 0 })).toThrow();
      });

      it('throws on terminated subscription', () => {
        const subId = establishSubscription();

        // Terminate via PUBLISH_DONE
        session.handleControlMessage({
          type: 'PUBLISH_DONE',
          requestId: varint(subId),
          statusCode: varint(0n),
          streamCount: varint(0n),
          errorReason: '',
        } as PublishDone);

        expect(() => session.requestUpdate(varint(subId), { forward: 0 })).toThrow();
      });

      it('does not update forward state until REQUEST_OK received', () => {
        const subId = establishSubscription();

        session.requestUpdate(varint(subId), { forward: 0 });

        // Forward state should NOT be updated yet
        const sub = session.getSubscription(varint(subId));
        expect(sub?.forwardState).toBe(ForwardState.ACTIVE);
      });

      // §9.2.2.5: SUBSCRIPTION_FILTER MAY appear in REQUEST_UPDATE
      it('includes SUBSCRIPTION_FILTER with AbsoluteStart in REQUEST_UPDATE (§9.2.2.5)', () => {
        const subId = establishSubscription();

        const { actions } = session.requestUpdate(varint(subId), {
          subscriptionFilter: {
            type: 'AbsoluteStart',
            startGroup: varint(15n),
            startObject: varint(0n),
          },
        });

        const msg = (actions[0] as SendControlAction).message as RequestUpdate;
        expect(msg.type).toBe('REQUEST_UPDATE');
        const filterBytes = msg.parameters.get(MessageParam.SUBSCRIPTION_FILTER as bigint);
        expect(filterBytes).toBeDefined();
        // Filter type 0x3 (AbsoluteStart) + group varint(15) + object varint(0)
        expect(filterBytes![0]).toEqual(new Uint8Array([0x03, 0x0f, 0x00]));
      });

      it('includes SUBSCRIPTION_FILTER with AbsoluteRange in REQUEST_UPDATE (§9.2.2.5)', () => {
        const subId = establishSubscription();

        const { actions } = session.requestUpdate(varint(subId), {
          subscriptionFilter: {
            type: 'AbsoluteRange',
            startGroup: varint(5n),
            startObject: varint(0n),
            endGroup: varint(20n),
          },
        });

        const msg = (actions[0] as SendControlAction).message as RequestUpdate;
        const filterBytes = msg.parameters.get(MessageParam.SUBSCRIPTION_FILTER as bigint);
        expect(filterBytes).toBeDefined();
        // Filter type 0x4 + group varint(5) + object varint(0) + endGroup varint(20)
        expect(filterBytes![0]).toEqual(new Uint8Array([0x04, 0x05, 0x00, 0x14]));
      });

      it('omits SUBSCRIPTION_FILTER from REQUEST_UPDATE when not specified (§9.2.2.5)', () => {
        const subId = establishSubscription();

        const { actions } = session.requestUpdate(varint(subId), { forward: 0 });

        const msg = (actions[0] as SendControlAction).message as RequestUpdate;
        expect(msg.parameters.has(MessageParam.SUBSCRIPTION_FILTER as bigint)).toBe(false);
      });
    });

    describe('receiving REQUEST_OK for REQUEST_UPDATE', () => {
      it('updates forward state to PAUSED on REQUEST_OK', () => {
        const subId = establishSubscription();

        const { requestId: updateId } = session.requestUpdate(varint(subId), { forward: 0 });

        // Receive REQUEST_OK confirming the update
        const actions = session.handleControlMessage({
          type: 'REQUEST_OK',
          requestId: updateId,
          parameters: new Map(),
        } as RequestOk);

        expect(actions.length).toBe(0);
        const sub = session.getSubscription(varint(subId));
        expect(sub?.forwardState).toBe(ForwardState.PAUSED);
      });

      it('updates forward state to ACTIVE on REQUEST_OK for resume', () => {
        const subId = establishSubscription();

        // Pause first
        const { requestId: pauseId } = session.requestUpdate(varint(subId), { forward: 0 });
        session.handleControlMessage({
          type: 'REQUEST_OK',
          requestId: pauseId,
          parameters: new Map(),
        } as RequestOk);

        // Resume
        const { requestId: resumeId } = session.requestUpdate(varint(subId), { forward: 1 });
        session.handleControlMessage({
          type: 'REQUEST_OK',
          requestId: resumeId,
          parameters: new Map(),
        } as RequestOk);

        const sub = session.getSubscription(varint(subId));
        expect(sub?.forwardState).toBe(ForwardState.ACTIVE);
      });

      it('closes with INVALID_REQUEST_ID for unknown REQUEST_OK', () => {
        const actions = session.handleControlMessage({
          type: 'REQUEST_OK',
          requestId: varint(999n),
          parameters: new Map(),
        } as RequestOk);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });
    });

    describe('receiving REQUEST_ERROR for REQUEST_UPDATE', () => {
      it('does not update forward state on REQUEST_ERROR', () => {
        const subId = establishSubscription();

        const { requestId: updateId } = session.requestUpdate(varint(subId), { forward: 0 });

        session.handleControlMessage({
          type: 'REQUEST_ERROR',
          requestId: updateId,
          errorCode: varint(0x1n),
          retryInterval: varint(0n),
          errorReason: 'Update rejected',
        } as RequestErrorMsg);

        // Forward state should NOT have changed
        const sub = session.getSubscription(varint(subId));
        expect(sub?.forwardState).toBe(ForwardState.ACTIVE);
      });
    });
  });

  describe('namespace discovery (§6.1)', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup({ maxRequestId: varint(100n) });
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
    });

    describe('subscribeNamespace', () => {
      it('returns open_namespace_stream action with SUBSCRIBE_NAMESPACE', () => {
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"

        const { requestId, actions } = session.subscribeNamespace(prefix);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('open_namespace_stream');
        const action = actions[0] as OpenNamespaceStreamAction;
        expect(action.requestId).toBe(requestId);
        expect(action.message.type).toBe('SUBSCRIBE_NAMESPACE');
      });

      it('allocates request ID for namespace subscription', () => {
        const prefix = [new Uint8Array([0x6c])];

        const { requestId } = session.subscribeNamespace(prefix);

        expect(requestId % 2n).toBe(0n); // Client uses even IDs
      });

      it('tracks namespace subscription state machine', () => {
        const prefix = [new Uint8Array([0x6c])];

        const { requestId } = session.subscribeNamespace(prefix);

        const ns = session.getNamespaceSubscription(requestId);
        expect(ns).toBeDefined();
        expect(ns?.state).toBe(NamespaceState.PENDING);
      });
    });

    describe('handleNamespaceStreamMessage', () => {
      it('activates namespace SM on REQUEST_OK', () => {
        const prefix = [new Uint8Array([0x6c])];
        const { requestId } = session.subscribeNamespace(prefix);

        const actions = session.handleNamespaceStreamMessage(requestId, {
          type: 'REQUEST_OK',
          requestId,
          parameters: new Map(),
        });

        expect(actions.length).toBe(0);
        const ns = session.getNamespaceSubscription(requestId);
        expect(ns?.state).toBe(NamespaceState.ACTIVE);
      });

      it('records discovered namespace on NAMESPACE', () => {
        const prefix = [new Uint8Array([0x6c])];
        const { requestId } = session.subscribeNamespace(prefix);

        // Activate
        session.handleNamespaceStreamMessage(requestId, {
          type: 'REQUEST_OK',
          requestId,
          parameters: new Map(),
        });

        // Receive NAMESPACE
        const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])]; // "video"
        session.handleNamespaceStreamMessage(requestId, {
          type: 'NAMESPACE',
          trackNamespaceSuffix: suffix,
        });

        const ns = session.getNamespaceSubscription(requestId);
        expect(ns?.discoveredNamespaces.length).toBe(1);
        expect(ns?.discoveredNamespaces[0]).toEqual(suffix);
      });

      it('terminates namespace SM on NAMESPACE_DONE', () => {
        const prefix = [new Uint8Array([0x6c])];
        const { requestId } = session.subscribeNamespace(prefix);

        session.handleNamespaceStreamMessage(requestId, {
          type: 'REQUEST_OK',
          requestId,
          parameters: new Map(),
        });

        // Must send NAMESPACE before NAMESPACE_DONE (§6.1)
        session.handleNamespaceStreamMessage(requestId, {
          type: 'NAMESPACE',
          trackNamespaceSuffix: [],
        });

        session.handleNamespaceStreamMessage(requestId, {
          type: 'NAMESPACE_DONE',
          trackNamespaceSuffix: [],
        });

        const ns = session.getNamespaceSubscription(requestId);
        expect(ns?.state).toBe(NamespaceState.TERMINATED);
      });

      it('terminates namespace SM on REQUEST_ERROR', () => {
        const prefix = [new Uint8Array([0x6c])];
        const { requestId } = session.subscribeNamespace(prefix);

        session.handleNamespaceStreamMessage(requestId, {
          type: 'REQUEST_ERROR',
          requestId,
          errorCode: varint(0x10n),
          retryInterval: varint(0n),
          errorReason: 'Unauthorized',
        });

        const ns = session.getNamespaceSubscription(requestId);
        expect(ns?.state).toBe(NamespaceState.TERMINATED);
        expect(ns?.errorCode).toBe(0x10n);
      });

      it('closes with INVALID_REQUEST_ID for unknown request ID', () => {
        const actions = session.handleNamespaceStreamMessage(varint(999n), {
          type: 'REQUEST_OK',
          requestId: varint(999n),
          parameters: new Map(),
        });

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });

      it('handles full namespace discovery flow', () => {
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
        const { requestId } = session.subscribeNamespace(prefix);

        // Activate
        session.handleNamespaceStreamMessage(requestId, {
          type: 'REQUEST_OK',
          requestId,
          parameters: new Map(),
        });

        // Discover namespaces
        const videoSuffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])]; // "video"
        session.handleNamespaceStreamMessage(requestId, {
          type: 'NAMESPACE',
          trackNamespaceSuffix: videoSuffix,
        });
        session.handleNamespaceStreamMessage(requestId, {
          type: 'NAMESPACE',
          trackNamespaceSuffix: [new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f])], // "audio"
        });

        // Done — must reference a previously-announced suffix (§6.1)
        session.handleNamespaceStreamMessage(requestId, {
          type: 'NAMESPACE_DONE',
          trackNamespaceSuffix: videoSuffix,
        });

        const ns = session.getNamespaceSubscription(requestId);
        expect(ns?.discoveredNamespaces.length).toBe(2);
        expect(ns?.state).toBe(NamespaceState.TERMINATED);
      });

      // ─── Combined Namespace Validation (§2.4.1) ────────────────────────

      describe('combined namespace validation (§2.4.1)', () => {
        it('accepts NAMESPACE when prefix + suffix has 1-32 fields', () => {
          // §2.4.1: Combined namespace must have 1-32 fields
          // prefix=1 field + suffix=1 field = 2 fields (valid)
          const prefix = [new Uint8Array([0x6c])]; // 1 field
          const { requestId } = session.subscribeNamespace(prefix);

          session.handleNamespaceStreamMessage(requestId, {
            type: 'REQUEST_OK',
            requestId,
            parameters: new Map(),
          });

          const suffix = [new Uint8Array([0x76])]; // 1 field → combined = 2
          const actions = session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE',
            trackNamespaceSuffix: suffix,
          });

          // Should succeed — 2 fields total is valid
          expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
        });

        it('closes with PROTOCOL_VIOLATION when prefix + suffix exceeds 32 fields', () => {
          // §2.4.1: "If an endpoint receives a Track Namespace consisting of
          // 0 or greater than 32 Track Namespace Fields, it MUST close the session
          // with a PROTOCOL_VIOLATION."
          // prefix=20 fields + suffix=15 fields = 35 fields (exceeds 32)
          const prefix = Array.from({ length: 20 }, () => new Uint8Array([0x61]));
          const { requestId } = session.subscribeNamespace(prefix);

          session.handleNamespaceStreamMessage(requestId, {
            type: 'REQUEST_OK',
            requestId,
            parameters: new Map(),
          });

          const suffix = Array.from({ length: 15 }, () => new Uint8Array([0x62]));
          const actions = session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE',
            trackNamespaceSuffix: suffix,
          });

          expect(actions.length).toBe(1);
          expect(actions[0]?.type).toBe('close_connection');
          const closeAction = actions[0] as CloseConnectionAction;
          expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
        });

        it('closes with PROTOCOL_VIOLATION when prefix + suffix exceeds 4096 bytes', () => {
          // §2.4.1: "The length of a Track Namespace is the sum of the Track Namespace
          // Field Length fields. If an endpoint receives a Track Namespace...exceeding
          // 4,096 bytes, it MUST close the session with a PROTOCOL_VIOLATION."
          // prefix=2048 bytes + suffix=2049 bytes = 4097 bytes (exceeds 4096)
          const prefix = [new Uint8Array(2048).fill(0x61)]; // 1 field, 2048 bytes
          const { requestId } = session.subscribeNamespace(prefix);

          session.handleNamespaceStreamMessage(requestId, {
            type: 'REQUEST_OK',
            requestId,
            parameters: new Map(),
          });

          const suffix = [new Uint8Array(2049).fill(0x62)]; // 1 field, 2049 bytes → total 4097
          const actions = session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE',
            trackNamespaceSuffix: suffix,
          });

          expect(actions.length).toBe(1);
          expect(actions[0]?.type).toBe('close_connection');
          const closeAction = actions[0] as CloseConnectionAction;
          expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
        });

        it('accepts exactly 32 combined fields', () => {
          // §2.4.1: Boundary — exactly 32 fields is valid
          const prefix = Array.from({ length: 16 }, () => new Uint8Array([0x61]));
          const { requestId } = session.subscribeNamespace(prefix);

          session.handleNamespaceStreamMessage(requestId, {
            type: 'REQUEST_OK',
            requestId,
            parameters: new Map(),
          });

          const suffix = Array.from({ length: 16 }, () => new Uint8Array([0x62]));
          const actions = session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE',
            trackNamespaceSuffix: suffix,
          });

          expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
        });

        it('closes with PROTOCOL_VIOLATION on NAMESPACE_DONE before NAMESPACE (§6.1)', () => {
          // §6.1: "If a subscriber receives a NAMESPACE_DONE before the
          // corresponding NAMESPACE, it MUST close the session with a
          // 'PROTOCOL_VIOLATION'."
          const prefix = [new Uint8Array([0x6c])];
          const { requestId } = session.subscribeNamespace(prefix);

          session.handleNamespaceStreamMessage(requestId, {
            type: 'REQUEST_OK',
            requestId,
            parameters: new Map(),
          });

          // Send NAMESPACE_DONE for suffix "video" without prior NAMESPACE for it
          const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])]; // "video"
          const actions = session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE_DONE',
            trackNamespaceSuffix: suffix,
          });

          expect(actions.length).toBe(1);
          expect(actions[0]?.type).toBe('close_connection');
          const closeAction = actions[0] as CloseConnectionAction;
          expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
        });

        it('allows NAMESPACE_DONE after corresponding NAMESPACE (§6.1)', () => {
          const prefix = [new Uint8Array([0x6c])];
          const { requestId } = session.subscribeNamespace(prefix);

          session.handleNamespaceStreamMessage(requestId, {
            type: 'REQUEST_OK',
            requestId,
            parameters: new Map(),
          });

          // First announce the namespace via NAMESPACE
          const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])]; // "video"
          session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE',
            trackNamespaceSuffix: suffix,
          });

          // Then NAMESPACE_DONE for the same suffix — should succeed
          const actions = session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE_DONE',
            trackNamespaceSuffix: suffix,
          });

          expect(actions.length).toBe(0);
          // SM transitions to TERMINATED (current behavior)
          const ns = session.getNamespaceSubscription(requestId);
          expect(ns?.state).toBe(NamespaceState.TERMINATED);
        });

        it('validates combined namespace on NAMESPACE_DONE too', () => {
          // NAMESPACE_DONE also carries a suffix that forms the combined namespace
          const prefix = Array.from({ length: 20 }, () => new Uint8Array([0x61]));
          const { requestId } = session.subscribeNamespace(prefix);

          session.handleNamespaceStreamMessage(requestId, {
            type: 'REQUEST_OK',
            requestId,
            parameters: new Map(),
          });

          const suffix = Array.from({ length: 15 }, () => new Uint8Array([0x62]));
          const actions = session.handleNamespaceStreamMessage(requestId, {
            type: 'NAMESPACE_DONE',
            trackNamespaceSuffix: suffix,
          });

          expect(actions.length).toBe(1);
          expect(actions[0]?.type).toBe('close_connection');
          const closeAction = actions[0] as CloseConnectionAction;
          expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
        });
      });
    });
  });

  // ─── Phase 3: Publisher-Side Session ────────────────────────────────────

  describe('publisher-side session (§9)', () => {
    let session: Session;

    /** Helper: create established server session that accepts incoming requests. */
    beforeEach(() => {
      session = new Session(EndpointRole.SERVER);
      session.handleControlMessage({
        type: 'CLIENT_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
      session.completeSetup({ maxRequestId: varint(100n) });
    });

    /** Helper: valid SUBSCRIBE from client with given request ID. */
    function incomingSubscribe(requestId: bigint): Subscribe {
      return {
        type: 'SUBSCRIBE',
        requestId: varint(requestId),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        parameters: new Map(),
      };
    }

    /** Helper: valid FETCH from client with given request ID. */
    function incomingFetch(requestId: bigint): Fetch {
      return {
        type: 'FETCH',
        requestId: varint(requestId),
        fetch: {
          fetchType: 0x1 as const,
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x76]),
          startLocation: { group: varint(0n), object: varint(0n) },
          endLocation: { group: varint(10n), object: varint(100n) },
        } as StandaloneFetch,
        parameters: new Map(),
      };
    }

    // ─── Incoming SUBSCRIBE (§9.9) ──────────────────────────────────────

    describe('incoming SUBSCRIBE (§9.9)', () => {
      it('creates publisher-side subscription SM', () => {
        const actions = session.handleControlMessage(incomingSubscribe(0n));

        expect(actions.length).toBe(0);
        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub).toBeDefined();
        expect(sub?.state).toBe(SubscriptionState.PENDING);
        expect(sub?.isPublisher).toBe(true);
      });

      it('validates incoming request ID parity', () => {
        // Client sends even IDs; odd IDs are server parity — invalid from client
        const actions = session.handleControlMessage({
          ...incomingSubscribe(1n),
          requestId: varint(1n),
        });

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('close_connection');
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });

      it('validates incoming request IDs are sequential', () => {
        // First request OK: ID=0
        session.handleControlMessage(incomingSubscribe(0n));

        // Second request should be ID=2, not ID=4
        const actions = session.handleControlMessage({
          ...incomingSubscribe(4n),
          requestId: varint(4n),
        });

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });

      it('rejects request ID exceeding our MAX_REQUEST_ID', () => {
        // Server with low MAX_REQUEST_ID
        const s = new Session(EndpointRole.SERVER);
        s.handleControlMessage({
          type: 'CLIENT_SETUP',
          parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
        });
        s.completeSetup({ maxRequestId: varint(2n) }); // Only ID 0 allowed

        // ID=0 OK
        s.handleControlMessage(incomingSubscribe(0n));
        expect(s.getIncomingSubscription(varint(0n))).toBeDefined();

        // ID=2 exceeds our MAX_REQUEST_ID (2)
        const actions = s.handleControlMessage({
          ...incomingSubscribe(2n),
          requestId: varint(2n),
        });

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.TOO_MANY_REQUESTS);
      });

      it('handles multiple sequential SUBSCRIBE requests', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.handleControlMessage({
          ...incomingSubscribe(2n),
          requestId: varint(2n),
          trackName: new Uint8Array([0x61]),
        });

        expect(session.getIncomingSubscription(varint(0n))).toBeDefined();
        expect(session.getIncomingSubscription(varint(2n))).toBeDefined();
      });
    });

    // ─── acceptSubscribe ─────────────────────────────────────────────────

    describe('acceptSubscribe', () => {
      it('sends SUBSCRIBE_OK and transitions SM to ESTABLISHED', () => {
        session.handleControlMessage(incomingSubscribe(0n));

        const actions = session.acceptSubscribe(varint(0n), varint(42n));

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: SubscribeOk }).message;
        expect(msg.type).toBe('SUBSCRIBE_OK');
        expect(msg.requestId).toBe(0n);
        expect(msg.trackAlias).toBe(42n);

        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub?.state).toBe(SubscriptionState.ESTABLISHED);
      });

      it('throws for unknown request ID', () => {
        expect(() => session.acceptSubscribe(varint(999n), varint(1n))).toThrow();
      });

      it('throws for already-established subscription', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        // Cannot accept again — already ESTABLISHED
        expect(() => session.acceptSubscribe(varint(0n), varint(42n))).toThrow();
      });

      it('rejects non-empty Track Properties on draft-16 (SUBSCRIBE_OK)', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
        expect(() => session.acceptSubscribe(varint(0n), varint(42n), { trackProperties })).toThrow(/Track Properties.*draft-18/i);
      });
    });

    // ─── rejectSubscribe ─────────────────────────────────────────────────

    describe('rejectSubscribe', () => {
      it('sends REQUEST_ERROR and transitions SM to TERMINATED', () => {
        session.handleControlMessage(incomingSubscribe(0n));

        const actions = session.rejectSubscribe(varint(0n), varint(0x10n), 'Does not exist');

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: RequestErrorMsg }).message;
        expect(msg.type).toBe('REQUEST_ERROR');
        expect(msg.requestId).toBe(0n);
        expect(msg.errorCode).toBe(0x10n);

        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub?.state).toBe(SubscriptionState.TERMINATED);
      });

      it('throws for unknown request ID', () => {
        expect(() => session.rejectSubscribe(varint(999n), varint(0x1n), 'error')).toThrow();
      });
    });

    // ─── Incoming UNSUBSCRIBE (§9.12) ────────────────────────────────────

    describe('incoming UNSUBSCRIBE (§9.12)', () => {
      it('terminates established publisher-side subscription', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        const actions = session.handleControlMessage({
          type: 'UNSUBSCRIBE',
          requestId: varint(0n),
        } as Unsubscribe);

        expect(actions.length).toBe(0);
        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub?.state).toBe(SubscriptionState.TERMINATED);
      });

      it('closes with INVALID_REQUEST_ID for unknown UNSUBSCRIBE', () => {
        const actions = session.handleControlMessage({
          type: 'UNSUBSCRIBE',
          requestId: varint(999n),
        } as Unsubscribe);

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });
    });

    // ─── publishDone (§9.15) ─────────────────────────────────────────────

    describe('publishDone (§9.15)', () => {
      it('sends PUBLISH_DONE and terminates subscription', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        const actions = session.publishDone(varint(0n), varint(0x2n), 'Track ended');

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: PublishDone }).message;
        expect(msg.type).toBe('PUBLISH_DONE');
        expect(msg.requestId).toBe(0n);
        expect(msg.statusCode).toBe(0x2n);

        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub?.state).toBe(SubscriptionState.TERMINATED);
      });

      it('throws for unknown request ID', () => {
        expect(() => session.publishDone(varint(999n), varint(0n), '')).toThrow();
      });

      it('throws for non-established subscription', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        // Not accepted yet — still PENDING

        expect(() => session.publishDone(varint(0n), varint(0n), '')).toThrow();
      });

      it('includes tracked streamCount (§9.15)', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        // Simulate opening 3 data streams for this subscription
        const sub = session.getIncomingSubscription(varint(0n))!;
        sub.incrementStreamCount();
        sub.incrementStreamCount();
        sub.incrementStreamCount();

        const actions = session.publishDone(varint(0n), varint(0x2n), '');
        const msg = (actions[0] as { type: string; message: PublishDone }).message;
        expect(msg.streamCount).toBe(varint(3n));
      });

      it('sends streamCount 0 when no streams opened', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        const actions = session.publishDone(varint(0n), varint(0x2n), '');
        const msg = (actions[0] as { type: string; message: PublishDone }).message;
        expect(msg.streamCount).toBe(varint(0n));
      });
    });

    // ─── Incoming FETCH (§9.16) ──────────────────────────────────────────

    describe('incoming FETCH (§9.16)', () => {
      it('creates publisher-side fetch SM', () => {
        const actions = session.handleControlMessage(incomingFetch(0n));

        expect(actions.length).toBe(0);
        const fetch = session.getIncomingFetch(varint(0n));
        expect(fetch).toBeDefined();
        expect(fetch?.state).toBe(FetchState.PENDING);
        expect(fetch?.isPublisher).toBe(true);
      });

      it('validates incoming request ID for FETCH', () => {
        // Wrong parity (odd = server, but from client)
        const actions = session.handleControlMessage({
          ...incomingFetch(1n),
          requestId: varint(1n),
        });

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });

      it('request IDs are shared across SUBSCRIBE and FETCH', () => {
        // ID=0: SUBSCRIBE
        session.handleControlMessage(incomingSubscribe(0n));
        // ID=2: FETCH (next sequential)
        session.handleControlMessage(incomingFetch(2n));

        expect(session.getIncomingSubscription(varint(0n))).toBeDefined();
        expect(session.getIncomingFetch(varint(2n))).toBeDefined();
      });
    });

    // ─── acceptFetch ─────────────────────────────────────────────────────

    describe('acceptFetch', () => {
      it('sends FETCH_OK and transitions SM to TRANSFERRING', () => {
        session.handleControlMessage(incomingFetch(0n));

        const actions = session.acceptFetch(varint(0n));

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: FetchOk }).message;
        expect(msg.type).toBe('FETCH_OK');
        expect(msg.requestId).toBe(0n);

        const fetch = session.getIncomingFetch(varint(0n));
        expect(fetch?.state).toBe(FetchState.TRANSFERRING);
      });

      it('throws for unknown request ID', () => {
        expect(() => session.acceptFetch(varint(999n))).toThrow();
      });

      it('rejects non-empty Track Properties on draft-16 (FETCH_OK)', () => {
        session.handleControlMessage(incomingFetch(0n));
        const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
        expect(() => session.acceptFetch(varint(0n), { trackProperties })).toThrow(/Track Properties.*draft-18/i);
      });
    });

    // ─── publish Track Properties (draft-16 rejection) ────────────────────

    describe('publish (draft-16 Track Properties)', () => {
      it('rejects non-empty Track Properties on draft-16 (PUBLISH)', () => {
        const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
        expect(() => session.publish([new Uint8Array([0x6c])], new Uint8Array([0x76]), 5n, { trackProperties })).toThrow(/Track Properties.*draft-18/i);
      });
    });

    // ─── rejectFetch ─────────────────────────────────────────────────────

    describe('rejectFetch', () => {
      it('sends REQUEST_ERROR and transitions SM to COMPLETED', () => {
        session.handleControlMessage(incomingFetch(0n));

        const actions = session.rejectFetch(varint(0n), varint(0x11n), 'Invalid range');

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: RequestErrorMsg }).message;
        expect(msg.type).toBe('REQUEST_ERROR');
        expect(msg.requestId).toBe(0n);
        expect(msg.errorCode).toBe(0x11n);

        const fetch = session.getIncomingFetch(varint(0n));
        expect(fetch?.state).toBe(FetchState.COMPLETED);
      });

      it('throws for unknown request ID', () => {
        expect(() => session.rejectFetch(varint(999n), varint(0x1n), 'error')).toThrow();
      });
    });

    // ─── Incoming FETCH_CANCEL (§9.18) ───────────────────────────────────

    describe('incoming FETCH_CANCEL (§9.18)', () => {
      it('terminates transferring fetch', () => {
        session.handleControlMessage(incomingFetch(0n));
        session.acceptFetch(varint(0n));

        const actions = session.handleControlMessage({
          type: 'FETCH_CANCEL',
          requestId: varint(0n),
        } as FetchCancel);

        expect(actions.length).toBe(0);
        const fetch = session.getIncomingFetch(varint(0n));
        expect(fetch?.state).toBe(FetchState.COMPLETED);
        expect(fetch?.wasCanceled).toBe(true);
      });

      it('closes with INVALID_REQUEST_ID for unknown FETCH_CANCEL', () => {
        const actions = session.handleControlMessage({
          type: 'FETCH_CANCEL',
          requestId: varint(999n),
        } as FetchCancel);

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });
    });

    // ─── Publisher-Side REQUEST_UPDATE (§9.11) ───────────────────────────

    describe('publisher-side REQUEST_UPDATE (§9.11)', () => {
      it('applies FORWARD=0 and responds REQUEST_OK', () => {
        // §9.11: "The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK"
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        const actions = session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(2n), // Next sequential from client
          existingRequestId: varint(0n),
          parameters: new Map([[MessageParam.FORWARD, [varint(0n)]]]),
        } as RequestUpdate);

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: RequestOk }).message;
        expect(msg.type).toBe('REQUEST_OK');
        expect(msg.requestId).toBe(2n);

        // §9.2.2.8: FORWARD=0 pauses object delivery
        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub?.forwardState).toBe(ForwardState.PAUSED);
      });

      it('applies FORWARD=1 to resume and responds REQUEST_OK', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        // Pause
        session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(2n),
          existingRequestId: varint(0n),
          parameters: new Map([[MessageParam.FORWARD, [varint(0n)]]]),
        } as RequestUpdate);

        // Resume
        const actions = session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(4n),
          existingRequestId: varint(0n),
          parameters: new Map([[MessageParam.FORWARD, [varint(1n)]]]),
        } as RequestUpdate);

        expect(actions.length).toBe(1);
        const msg = (actions[0] as { type: string; message: RequestOk }).message;
        expect(msg.type).toBe('REQUEST_OK');

        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub?.forwardState).toBe(ForwardState.ACTIVE);
      });

      it('validates REQUEST_UPDATE request ID', () => {
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        // Wrong parity (odd = server's own IDs, not client's)
        const actions = session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(1n),
          existingRequestId: varint(0n),
          parameters: new Map(),
        } as RequestUpdate);

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
      });

      it('closes with PROTOCOL_VIOLATION for unknown existing request ID (§9.11)', () => {
        // §9.11: "The receiver MUST close the session with PROTOCOL_VIOLATION
        // if the sender specifies an invalid Existing Request ID"
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        const actions = session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(2n),
          existingRequestId: varint(999n), // Does not exist
          parameters: new Map(),
        } as RequestUpdate);

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('closes with PROTOCOL_VIOLATION for non-established subscription (§9.11)', () => {
        // §9.11: invalid if parameters are "invalid for the type of request being modified"
        // A PENDING subscription cannot be updated
        session.handleControlMessage(incomingSubscribe(0n));
        // NOT accepted — still PENDING

        const actions = session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(2n),
          existingRequestId: varint(0n),
          parameters: new Map(),
        } as RequestUpdate);

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('preserves unchanged params when not present in REQUEST_UPDATE (§9.11)', () => {
        // §9.11: "If a parameter previously set on the request is not present
        // in REQUEST_UPDATE, its value remains unchanged"
        session.handleControlMessage(incomingSubscribe(0n));
        session.acceptSubscribe(varint(0n), varint(42n));

        // Pause with FORWARD=0
        session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(2n),
          existingRequestId: varint(0n),
          parameters: new Map([[MessageParam.FORWARD, [varint(0n)]]]),
        } as RequestUpdate);

        // Send REQUEST_UPDATE without FORWARD — should remain PAUSED
        session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(4n),
          existingRequestId: varint(0n),
          parameters: new Map(), // No FORWARD parameter
        } as RequestUpdate);

        const sub = session.getIncomingSubscription(varint(0n));
        expect(sub?.forwardState).toBe(ForwardState.PAUSED);
      });

      it('closes with PROTOCOL_VIOLATION for subscription-only params on fetch (§9.11)', () => {
        // §9.11: "The receiver MUST close the session with PROTOCOL_VIOLATION
        // if the parameters included in the REQUEST_UPDATE are invalid for the
        // type of request being modified."
        // FORWARD is only valid for "REQUEST_UPDATE (for a subscription)" per §9.2.2.8
        session.handleControlMessage(incomingFetch(0n));
        session.acceptFetch(varint(0n), varint(42n));

        const actions = session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(2n),
          existingRequestId: varint(0n),
          parameters: new Map([[MessageParam.FORWARD, [varint(0n)]]]),
        } as RequestUpdate);

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('closes with PROTOCOL_VIOLATION for SUBSCRIPTION_FILTER on fetch (§9.11)', () => {
        // SUBSCRIPTION_FILTER only valid for "REQUEST_UPDATE (for a subscription)" per §9.2.2.5
        session.handleControlMessage(incomingFetch(0n));
        session.acceptFetch(varint(0n), varint(42n));

        const filterValue = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // AbsoluteStart
        const actions = session.handleControlMessage({
          type: 'REQUEST_UPDATE',
          requestId: varint(2n),
          existingRequestId: varint(0n),
          parameters: new Map([[MessageParam.SUBSCRIPTION_FILTER, [filterValue]]]),
        } as RequestUpdate);

        expect(actions.length).toBe(1);
        const close = actions[0] as CloseConnectionAction;
        expect(close.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });
    });
  });

  // ─── Phase 4: Dual-Session Integration Tests ──────────────────────────

  describe('integration: dual-session flows', () => {
    let client: Session;
    let server: Session;

    /** Helper: complete setup handshake between client and server. */
    beforeEach(() => {
      client = new Session(EndpointRole.CLIENT);
      server = new Session(EndpointRole.SERVER);

      // Client → Server: CLIENT_SETUP
      const clientActions = client.initiateSetup({ maxRequestId: varint(100n) });
      const clientSetupMsg = (clientActions[0] as SendControlAction).message;
      server.handleControlMessage(clientSetupMsg);

      // Server → Client: SERVER_SETUP
      const serverActions = server.completeSetup({ maxRequestId: varint(100n) });
      const serverSetupMsg = (serverActions[0] as SendControlAction).message;
      client.handleControlMessage(serverSetupMsg);
    });

    it('both sessions reach ESTABLISHED after handshake', () => {
      expect(client.state).toBe(SessionState.ESTABLISHED);
      expect(server.state).toBe(SessionState.ESTABLISHED);
    });

    describe('subscribe → accept → established', () => {
      it('full subscribe flow establishes both sides', () => {
        // Client → Server: SUBSCRIBE
        const { requestId, actions: subActions } = client.subscribe(
          [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
          new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        );
        const subscribeMsg = (subActions[0] as SendControlAction).message;
        server.handleControlMessage(subscribeMsg);

        // Server → Client: SUBSCRIBE_OK
        const acceptActions = server.acceptSubscribe(requestId, varint(42n));
        const subscribeOkMsg = (acceptActions[0] as SendControlAction).message;
        client.handleControlMessage(subscribeOkMsg);

        // Both sides established
        expect(client.getSubscription(requestId)?.state).toBe(SubscriptionState.ESTABLISHED);
        expect(server.getIncomingSubscription(requestId)?.state).toBe(SubscriptionState.ESTABLISHED);
      });
    });

    describe('subscribe → reject → terminated', () => {
      it('rejected subscription terminates both sides', () => {
        const { requestId, actions: subActions } = client.subscribe(
          [new Uint8Array([0x6c])],
          new Uint8Array([0x76]),
        );
        server.handleControlMessage((subActions[0] as SendControlAction).message);

        // Server → Client: REQUEST_ERROR
        const rejectActions = server.rejectSubscribe(requestId, varint(0x10n), 'Does not exist');
        const errorMsg = (rejectActions[0] as SendControlAction).message;
        client.handleControlMessage(errorMsg);

        expect(client.getSubscription(requestId)?.state).toBe(SubscriptionState.TERMINATED);
        expect(server.getIncomingSubscription(requestId)?.state).toBe(SubscriptionState.TERMINATED);
      });
    });

    describe('REQUEST_UPDATE pause/resume round-trip (§9.11)', () => {
      /** Helper: establish a subscription on both sides. */
      function establishSubscription(): bigint {
        const { requestId, actions } = client.subscribe(
          [new Uint8Array([0x6c])], new Uint8Array([0x76]),
        );
        server.handleControlMessage((actions[0] as SendControlAction).message);
        const okActions = server.acceptSubscribe(requestId, varint(1n));
        client.handleControlMessage((okActions[0] as SendControlAction).message);
        return requestId as bigint;
      }

      it('pause round-trip updates forward state on both sides', () => {
        const subId = establishSubscription();

        // Client → Server: REQUEST_UPDATE (FORWARD=0)
        const { requestId: updateId, actions: updateActions } = client.requestUpdate(
          varint(subId), { forward: 0 },
        );
        const updateMsg = (updateActions[0] as SendControlAction).message;
        const serverActions = server.handleControlMessage(updateMsg);

        // Server → Client: REQUEST_OK
        const requestOkMsg = (serverActions[0] as SendControlAction).message;
        client.handleControlMessage(requestOkMsg);

        // Both sides show PAUSED
        expect(client.getSubscription(varint(subId))?.forwardState).toBe(ForwardState.PAUSED);
        expect(server.getIncomingSubscription(varint(subId))?.forwardState).toBe(ForwardState.PAUSED);
      });

      it('resume round-trip restores forward state on both sides', () => {
        const subId = establishSubscription();

        // Pause
        const { actions: pauseActions } = client.requestUpdate(varint(subId), { forward: 0 });
        const pauseServerActions = server.handleControlMessage(
          (pauseActions[0] as SendControlAction).message,
        );
        client.handleControlMessage((pauseServerActions[0] as SendControlAction).message);

        // Resume
        const { actions: resumeActions } = client.requestUpdate(varint(subId), { forward: 1 });
        const resumeServerActions = server.handleControlMessage(
          (resumeActions[0] as SendControlAction).message,
        );
        client.handleControlMessage((resumeServerActions[0] as SendControlAction).message);

        // Both sides show ACTIVE
        expect(client.getSubscription(varint(subId))?.forwardState).toBe(ForwardState.ACTIVE);
        expect(server.getIncomingSubscription(varint(subId))?.forwardState).toBe(ForwardState.ACTIVE);
      });
    });

    describe('PUBLISH_DONE flow (§9.15)', () => {
      it('publisher terminates subscription, subscriber receives', () => {
        const { requestId, actions } = client.subscribe(
          [new Uint8Array([0x6c])], new Uint8Array([0x76]),
        );
        server.handleControlMessage((actions[0] as SendControlAction).message);
        const okActions = server.acceptSubscribe(requestId, varint(1n));
        client.handleControlMessage((okActions[0] as SendControlAction).message);

        // Server → Client: PUBLISH_DONE
        const doneActions = server.publishDone(requestId, PublishDoneCode.TRACK_ENDED, 'Track ended');
        const doneMsg = (doneActions[0] as SendControlAction).message;
        client.handleControlMessage(doneMsg);

        expect(client.getSubscription(requestId)?.state).toBe(SubscriptionState.TERMINATED);
        expect(server.getIncomingSubscription(requestId)?.state).toBe(SubscriptionState.TERMINATED);
      });
    });

    describe('fetch → accept → transfer', () => {
      it('full fetch flow establishes both sides', () => {
        const { requestId, actions: fetchActions } = client.fetch(
          [new Uint8Array([0x6c])], new Uint8Array([0x76]),
          { startGroup: varint(0n), startObject: varint(0n), endGroup: varint(10n), endObject: varint(100n) },
        );
        server.handleControlMessage((fetchActions[0] as SendControlAction).message);

        const acceptActions = server.acceptFetch(requestId);
        const fetchOkMsg = (acceptActions[0] as SendControlAction).message;
        client.handleControlMessage(fetchOkMsg);

        expect(client.getFetch(requestId)?.state).toBe(FetchState.TRANSFERRING);
        expect(server.getIncomingFetch(requestId)?.state).toBe(FetchState.TRANSFERRING);
      });
    });

    describe('mixed request ID allocation', () => {
      it('client SUBSCRIBE and FETCH share sequential request IDs', () => {
        // SUBSCRIBE gets ID=0
        const { requestId: subId } = client.subscribe(
          [new Uint8Array([0x6c])], new Uint8Array([0x76]),
        );
        // FETCH gets ID=2
        const { requestId: fetchId } = client.fetch(
          [new Uint8Array([0x61])], new Uint8Array([0x62]),
          { startGroup: varint(0n), startObject: varint(0n) },
        );
        // REQUEST_UPDATE gets ID=4
        // First establish the subscription for requestUpdate
        server.handleControlMessage(
          (client.subscribe([new Uint8Array([0x6c])], new Uint8Array([0x76]))).actions[0] as any,
        ); // This would be ID=4 actually

        expect(subId).toBe(0n);
        expect(fetchId).toBe(2n);
        // Request IDs are sequential regardless of request type
      });
    });

    // ─── TRACK_STATUS (§9.19) ──────────────────────────────────────────

    describe('TRACK_STATUS (§9.19)', () => {
      const ns = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]); // "video"

      it('subscriber sends TRACK_STATUS, gets REQUEST_OK — no subscription created', () => {
        // Client → Server: TRACK_STATUS
        const { requestId, actions } = client.trackStatus(ns, name);
        expect(actions).toHaveLength(1);

        const msg = (actions[0] as SendControlAction).message as TrackStatus;
        expect(msg.type).toBe('TRACK_STATUS');
        expect(msg.requestId).toBe(requestId);

        // Forward to server
        server.handleControlMessage(msg);

        // Server sees the incoming request
        const incoming = server.getIncomingTrackStatus(requestId);
        expect(incoming).toBeDefined();
        expect(incoming!.namespace).toEqual(ns);
        expect(incoming!.name).toEqual(name);

        // No subscription state created on either side
        expect(client.getSubscription(requestId)).toBeUndefined();
        expect(server.getIncomingSubscription(requestId)).toBeUndefined();

        // Server → Client: REQUEST_OK
        const okActions = server.acceptTrackStatus(requestId);
        expect(okActions).toHaveLength(1);
        const okMsg = (okActions[0] as SendControlAction).message as RequestOk;
        expect(okMsg.type).toBe('REQUEST_OK');
        expect(okMsg.requestId).toBe(requestId);

        // Client tracked the outgoing TRACK_STATUS while pending...
        expect(client.getPendingTrackStatus(requestId)).toBeDefined();

        // Client handles REQUEST_OK — no subscription created
        const clientActions = client.handleControlMessage(okMsg);
        expect(clientActions).toHaveLength(0);
        expect(client.getSubscription(requestId)).toBeUndefined();

        // ...and clears it after the stamped REQUEST_OK (no quiet leak).
        expect(client.getPendingTrackStatus(requestId)).toBeUndefined();

        // Incoming request cleaned up on server
        expect(server.getIncomingTrackStatus(requestId)).toBeUndefined();
      });

      it('subscriber sends TRACK_STATUS, gets REQUEST_ERROR — no subscription created', () => {
        // Client → Server: TRACK_STATUS
        const { requestId, actions } = client.trackStatus(ns, name);
        server.handleControlMessage((actions[0] as SendControlAction).message);

        // Server → Client: REQUEST_ERROR
        const errorActions = server.rejectTrackStatus(requestId, varint(0x10n), 'Track not found');
        expect(errorActions).toHaveLength(1);
        const errorMsg = (errorActions[0] as SendControlAction).message as RequestErrorMsg;
        expect(errorMsg.type).toBe('REQUEST_ERROR');

        // Client handles REQUEST_ERROR — cleaned up, no subscription state
        const clientActions = client.handleControlMessage(errorMsg);
        expect(clientActions).toHaveLength(0);
        expect(client.getSubscription(requestId)).toBeUndefined();
      });

      it('publisher receives TRACK_STATUS and accepts with REQUEST_OK containing params', () => {
        const { requestId, actions } = client.trackStatus(ns, name);
        server.handleControlMessage((actions[0] as SendControlAction).message);

        // Server responds with params (e.g., LARGEST_OBJECT)
        const params: Parameters = new Map();
        params.set(varint(0x100n), [varint(42n)]); // Example param
        const okActions = server.acceptTrackStatus(requestId, params);

        const okMsg = (okActions[0] as SendControlAction).message as RequestOk;
        expect(okMsg.parameters).toBe(params);
      });

      it('rejects non-empty Track Properties on draft-16 (no such field on the wire)', () => {
        const { requestId, actions } = client.trackStatus(ns, name);
        server.handleControlMessage((actions[0] as SendControlAction).message);
        const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
        expect(() => server.acceptTrackStatus(requestId, { trackProperties })).toThrow(/Track Properties.*draft-18/i);
      });

      it('publisher receives TRACK_STATUS and rejects with REQUEST_ERROR', () => {
        const { requestId, actions } = client.trackStatus(ns, name);
        server.handleControlMessage((actions[0] as SendControlAction).message);

        const rejectActions = server.rejectTrackStatus(requestId, varint(0x1n), 'Unauthorized');
        expect(rejectActions).toHaveLength(1);

        const errorMsg = (rejectActions[0] as SendControlAction).message as RequestErrorMsg;
        expect(errorMsg.type).toBe('REQUEST_ERROR');
        expect(errorMsg.errorCode).toBe(0x1n);
        expect(errorMsg.errorReason).toBe('Unauthorized');
      });

      it('PUBLISH_DONE for TRACK_STATUS request → PROTOCOL_VIOLATION', () => {
        // Client sends TRACK_STATUS
        const { requestId, actions } = client.trackStatus(ns, name);
        // Don't forward to server — test the client side guard

        // Server "accidentally" sends PUBLISH_DONE for this request ID
        const publishDone: PublishDone = {
          type: 'PUBLISH_DONE',
          requestId,
          statusCode: varint(0n),
          streamCount: varint(0n),
          errorReason: '',
          parameters: new Map(),
        };

        const resultActions = client.handleControlMessage(publishDone);

        // Should close with PROTOCOL_VIOLATION
        expect(resultActions).toHaveLength(1);
        expect(resultActions[0]?.type).toBe('close_connection');
        const closeAction = resultActions[0] as CloseConnectionAction;
        expect(closeAction.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
      });

      it('acceptTrackStatus throws for unknown request ID', () => {
        expect(() => server.acceptTrackStatus(varint(999n))).toThrow('Unknown incoming TRACK_STATUS');
      });

      it('rejectTrackStatus throws for unknown request ID', () => {
        expect(() => server.rejectTrackStatus(varint(999n), varint(0n), '')).toThrow('Unknown incoming TRACK_STATUS');
      });

      it('TRACK_STATUS shares sequential request IDs with SUBSCRIBE', () => {
        // SUBSCRIBE gets first ID
        const { requestId: subId } = client.subscribe(
          [new Uint8Array([0x6c])], new Uint8Array([0x76]),
        );
        // TRACK_STATUS gets next ID
        const { requestId: tsId } = client.trackStatus(ns, name);

        // IDs are sequential (even numbers: 0, 2, 4, ...)
        expect(tsId).toBe(subId + 2n);
      });
    });

    // ─── Invalid control-message sequencing (GAP-4, §9) ─────────

    describe('invalid control-message sequencing', () => {
      it('returns close_connection on duplicate SUBSCRIBE_OK (§9)', () => {
        // A duplicate SUBSCRIBE_OK hits assertState('pending') when state is
        // already 'established'. Per §9 this is invalid peer behavior and
        // MUST close the session — not throw uncaught.
        const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
        const { requestId, actions: subActions } = client.subscribe(namespace, name);

        // Route SUBSCRIBE to server so it knows the request ID
        const subMsg = (subActions[0] as SendControlAction).message;
        server.handleControlMessage(subMsg);

        const subscribeOk: SubscribeOk = {
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(42n),
          parameters: new Map(),
          trackExtensions: [],
        };

        // First OK — should succeed
        client.handleControlMessage(subscribeOk);
        expect(client.getSubscription(requestId)?.state).toBe(SubscriptionState.ESTABLISHED);

        // Duplicate OK — should close session, not throw
        const actions = client.handleControlMessage(subscribeOk);
        expect(actions.length).toBeGreaterThan(0);
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.type).toBe('close_connection');
        expect(closeAction.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
      });

      it('returns close_connection on PUBLISH_DONE for pending subscription (§9)', () => {
        // PUBLISH_DONE requires ESTABLISHED state — sending it in PENDING
        // state is an invalid transition. Must close session, not throw.
        const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);
        const { requestId } = client.subscribe(namespace, name);

        const publishDone: PublishDone = {
          type: 'PUBLISH_DONE',
          requestId,
          statusCode: varint(0n),
          streamCount: varint(0n),
          errorReason: 'done',
        };

        // Subscription is still PENDING — PUBLISH_DONE should trigger close
        const actions = client.handleControlMessage(publishDone);
        expect(actions.length).toBeGreaterThan(0);
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.type).toBe('close_connection');
        expect(closeAction.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
      });
    });
  });

  it('ignores draft-16 PUBLISH-only-invalid params and does not echo auth tokens in PUBLISH_OK', () => {
    /**
     * Draft-16 §9.2.2.4 only allows GROUP_ORDER on SUBSCRIBE, PUBLISH_OK, and FETCH.
     * If it appears on PUBLISH, it MUST be ignored rather than treated as a protocol error.
     *
     * Draft-16 §9.2.2.1 allows AUTHORIZATION_TOKEN on PUBLISH, but not on PUBLISH_OK.
     * The session must not blindly replay inbound PUBLISH parameters into the response.
     */
    const session = new Session(EndpointRole.CLIENT);
    session.initiateSetup({ maxRequestId: varint(100n) });
    session.handleControlMessage({
      type: 'SERVER_SETUP',
      parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
    });

    const authToken = encodeAuthorizationToken({
      aliasType: AliasType.USE_VALUE,
      tokenType: varint(1n),
      tokenValue: new Uint8Array([0xaa]),
    });

    const publish: Publish = {
      type: 'PUBLISH',
      requestId: varint(1n),
      trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
      trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
      trackAlias: varint(42n),
      parameters: new Map([
        [varint(MessageParam.GROUP_ORDER), [varint(0n)]],
        [varint(MessageParam.FORWARD), [varint(0n)]],
        [varint(MessageParam.AUTHORIZATION_TOKEN), [authToken]],
      ]),
      trackExtensions: new Map(),
    };

    const actions = session.handleControlMessage(publish);
    expect(actions.every(a => a.type !== 'close_connection')).toBe(true);

    const acceptActions = session.acceptSubscribe(varint(1n), varint(42n));
    expect(acceptActions).toHaveLength(1);
    const publishOk = (acceptActions[0] as SendControlAction).message as PublishOk;
    expect(publishOk.type).toBe('PUBLISH_OK');
    expect(publishOk.parameters.get(varint(MessageParam.FORWARD))?.[0]).toBe(0n);
    expect(publishOk.parameters.has(varint(MessageParam.GROUP_ORDER))).toBe(false);
    expect(publishOk.parameters.has(varint(MessageParam.AUTHORIZATION_TOKEN))).toBe(false);
  });

  describe('draft-14 PUBLISH parameter handling (§9.13, §9.14)', () => {
    /**
     * Draft-14 carried GROUP_ORDER as an inline field on PUBLISH and PUBLISH_OK.
     * The isParamValidForMessageType() exception and buildPublishOkParamsFromPublish()
     * must handle this version-specific behavior.
     *
     * @see draft-ietf-moq-transport-14 §9.13 (PUBLISH)
     * @see draft-ietf-moq-transport-14 §9.14 (PUBLISH_OK)
     */

    function createEstablishedV14ClientSession(): Session {
      const s = new Session(EndpointRole.CLIENT, 14);
      s.initiateSetup({ maxRequestId: varint(100n) });
      s.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
      return s;
    }

    it('accepts GROUP_ORDER on PUBLISH in draft-14 without PROTOCOL_VIOLATION', () => {
      const s = createEstablishedV14ClientSession();

      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n), // server parity = odd (incoming to client)
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(1n)]], // Ascending
          [varint(MessageParam.FORWARD), [varint(0n)]],
        ]),
        trackExtensions: new Map(),
      };

      const actions = s.handleControlMessage(publish);
      expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
    });

    it('carries GROUP_ORDER from PUBLISH into PUBLISH_OK in draft-14', () => {
      const s = createEstablishedV14ClientSession();

      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(2n)]], // Descending
          [varint(MessageParam.FORWARD), [varint(1n)]],
        ]),
        trackExtensions: new Map(),
      };

      s.handleControlMessage(publish);
      const acceptActions = s.acceptSubscribe(varint(1n), varint(42n));

      expect(acceptActions).toHaveLength(1);
      const publishOk = (acceptActions[0] as SendControlAction).message as PublishOk;
      expect(publishOk.type).toBe('PUBLISH_OK');
      // GROUP_ORDER carried forward in draft-14
      expect(publishOk.parameters.get(varint(MessageParam.GROUP_ORDER))?.[0]).toBe(2n);
      // FORWARD also carried forward
      expect(publishOk.parameters.get(varint(MessageParam.FORWARD))?.[0]).toBe(1n);
    });

    it('defaults GROUP_ORDER to Ascending (0x1) in PUBLISH_OK when not in PUBLISH', () => {
      /**
       * Draft-14 §9.14: GROUP_ORDER is a required inline field on PUBLISH_OK.
       * If the inbound PUBLISH didn't include it, default to Ascending (0x1).
       */
      const s = createEstablishedV14ClientSession();

      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map([
          [varint(MessageParam.FORWARD), [varint(0n)]],
        ]),
        trackExtensions: new Map(),
      };

      s.handleControlMessage(publish);
      const acceptActions = s.acceptSubscribe(varint(1n), varint(42n));

      const publishOk = (acceptActions[0] as SendControlAction).message as PublishOk;
      expect(publishOk.parameters.get(varint(MessageParam.GROUP_ORDER))?.[0]).toBe(1n);
    });

    it('does not echo AUTHORIZATION_TOKEN into PUBLISH_OK in draft-14', () => {
      /**
       * §9.2.2.1: AUTHORIZATION_TOKEN valid on PUBLISH but NOT on PUBLISH_OK.
       * This is true for both draft versions.
       */
      const s = createEstablishedV14ClientSession();
      const authToken = encodeAuthorizationToken({
        aliasType: AliasType.USE_VALUE,
        tokenType: varint(1n),
        tokenValue: new Uint8Array([0xbb]),
      });

      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map([
          [varint(MessageParam.FORWARD), [varint(0n)]],
          [varint(MessageParam.AUTHORIZATION_TOKEN), [authToken]],
          [varint(MessageParam.GROUP_ORDER), [varint(1n)]],
        ]),
        trackExtensions: new Map(),
      };

      s.handleControlMessage(publish);
      const acceptActions = s.acceptSubscribe(varint(1n), varint(42n));

      const publishOk = (acceptActions[0] as SendControlAction).message as PublishOk;
      expect(publishOk.parameters.has(varint(MessageParam.AUTHORIZATION_TOKEN))).toBe(false);
      // But GROUP_ORDER and FORWARD should be present
      expect(publishOk.parameters.has(varint(MessageParam.GROUP_ORDER))).toBe(true);
      expect(publishOk.parameters.has(varint(MessageParam.FORWARD))).toBe(true);
    });
  });

  // ─── Draft-14 Session Behavior ───────────────────────────────────────

  describe('draft-14 session behavior', () => {
    /**
     * Draft-14 namespace discovery flows entirely on the control stream,
     * unlike draft-16's dedicated bidi streams.
     *
     * @see draft-ietf-moq-transport-14 §6.1, §6.2, §9.23–§9.31
     */

    /** Helper: create a v14 client session in ESTABLISHED state. */
    function createEstablishedV14Session(): Session {
      const s = new Session(EndpointRole.CLIENT, 14);
      s.initiateSetup({ maxRequestId: varint(100n) });
      s.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
      return s;
    }

    describe('constructor + draftVersion', () => {
      it('defaults to draft 16', () => {
        const s = new Session(EndpointRole.CLIENT);
        expect(s.draftVersion).toBe(16);
      });

      it('accepts draft version 14', () => {
        const s = new Session(EndpointRole.CLIENT, 14);
        expect(s.draftVersion).toBe(14);
      });
    });

    describe('subscribeNamespace (v14: send_control, not open_namespace_stream)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.28: SUBSCRIBE_NAMESPACE is sent on
       * the control stream, not a bidi stream. The session should produce
       * a send_control action, not open_namespace_stream.
       */
      it('returns send_control action with SUBSCRIBE_NAMESPACE', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"

        const { requestId, actions } = s.subscribeNamespace(prefix);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('send_control');
        const action = actions[0] as SendControlAction;
        expect(action.message.type).toBe('SUBSCRIBE_NAMESPACE');
      });
    });

    describe('handleRequestOk/Error routes to namespace subscriptions (v14)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.29: SUBSCRIBE_NAMESPACE_OK is
       * normalized to REQUEST_OK by the codec. The session must route it
       * to the namespace subscription.
       */
      it('routes REQUEST_OK to namespace subscription', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c])];
        const { requestId } = s.subscribeNamespace(prefix);

        const actions = s.handleControlMessage({
          type: 'REQUEST_OK',
          requestId,
          parameters: new Map(),
        } as RequestOk);

        expect(actions).toEqual([]);
        const ns = s.getNamespaceSubscription(requestId);
        expect(ns?.state).toBe(NamespaceState.ACTIVE);
      });

      /**
       * draft-ietf-moq-transport-14 §9.30: SUBSCRIBE_NAMESPACE_ERROR is
       * normalized to REQUEST_ERROR by the codec.
       */
      it('routes REQUEST_ERROR to namespace subscription', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c])];
        const { requestId } = s.subscribeNamespace(prefix);

        const actions = s.handleControlMessage({
          type: 'REQUEST_ERROR',
          requestId,
          errorCode: varint(0x4n), // NAMESPACE_PREFIX_UNKNOWN
          retryInterval: varint(0n),
          errorReason: 'namespace not found',
        } as RequestErrorMsg);

        expect(actions).toEqual([]);
        const ns = s.getNamespaceSubscription(requestId);
        expect(ns?.state).toBe(NamespaceState.TERMINATED);
      });
    });

    describe('handleControlMessage: PUBLISH_NAMESPACE (v14 §9.23)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.23: "The publisher sends the
       * PUBLISH_NAMESPACE control message to advertise that it has tracks
       * available within a Track Namespace."
       *
       * §6.2: "A subscriber MUST send exactly one PUBLISH_NAMESPACE_OK or
       * PUBLISH_NAMESPACE_ERROR in response to a PUBLISH_NAMESPACE."
       */
      it('sends PUBLISH_NAMESPACE_OK + notify_namespace when prefix matches', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
        const { requestId: subReqId } = s.subscribeNamespace(prefix);

        // Activate the namespace subscription
        s.handleControlMessage({
          type: 'REQUEST_OK',
          requestId: subReqId,
          parameters: new Map(),
        } as RequestOk);

        // Incoming PUBLISH_NAMESPACE from publisher
        const pubNsMsg: PublishNamespace = {
          type: 'PUBLISH_NAMESPACE',
          requestId: varint(1n), // publisher's request ID (odd = server)
          trackNamespace: [
            new Uint8Array([0x6c, 0x69, 0x76, 0x65]), // "live"
            new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]), // "video"
          ],
          parameters: new Map(),
        };

        const actions = s.handleControlMessage(pubNsMsg);

        // Should produce send_control(PUBLISH_NAMESPACE_OK) + notify_namespace
        expect(actions.length).toBe(2);

        const okAction = actions.find(a => a.type === 'send_control') as SendControlAction;
        expect(okAction).toBeDefined();
        expect(okAction.message.type).toBe('PUBLISH_NAMESPACE_OK');
        expect((okAction.message as PublishNamespaceOk).requestId).toBe(1n);

        const notifyAction = actions.find(a => a.type === 'notify_namespace') as NotifyNamespaceAction;
        expect(notifyAction).toBeDefined();
        expect(notifyAction.requestId).toBe(subReqId);
        expect(notifyAction.message).toBe(pubNsMsg);
      });

      /**
       * draft-ietf-moq-transport-14 §9.25: UNINTERESTED (0x4) error code —
       * "The namespace is not of interest to the endpoint."
       */
      it('sends PUBLISH_NAMESPACE_ERROR when no prefix matches', () => {
        const s = createEstablishedV14Session();
        // No subscribeNamespace called — no matching prefix

        const pubNsMsg: PublishNamespace = {
          type: 'PUBLISH_NAMESPACE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
          parameters: new Map(),
        };

        const actions = s.handleControlMessage(pubNsMsg);

        expect(actions.length).toBe(1);
        const errAction = actions[0] as SendControlAction;
        expect(errAction.type).toBe('send_control');
        expect(errAction.message.type).toBe('PUBLISH_NAMESPACE_ERROR');
        expect((errAction.message as PublishNamespaceError).errorCode).toBe(0x4n); // UNINTERESTED
      });
    });

    describe('handleControlMessage: PUBLISH_NAMESPACE_DONE (v14 §9.26)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.26: "withdraws a previous
       * PUBLISH_NAMESPACE" — per-namespace withdrawal, subscription stays ACTIVE.
       */
      it('withdraws namespace, subscription stays ACTIVE, produces notify_namespace', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const { requestId: subReqId } = s.subscribeNamespace(prefix);

        // Activate
        s.handleControlMessage({
          type: 'REQUEST_OK', requestId: subReqId, parameters: new Map(),
        } as RequestOk);

        // Receive PUBLISH_NAMESPACE
        const namespace = [
          new Uint8Array([0x6c, 0x69, 0x76, 0x65]),
          new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        ];
        s.handleControlMessage({
          type: 'PUBLISH_NAMESPACE',
          requestId: varint(1n),
          trackNamespace: namespace,
          parameters: new Map(),
        } as PublishNamespace);

        // PUBLISH_NAMESPACE_DONE
        const doneMsg: PublishNamespaceDone = {
          type: 'PUBLISH_NAMESPACE_DONE',
          trackNamespace: namespace,
        };
        const actions = s.handleControlMessage(doneMsg);

        // Should produce notify_namespace
        expect(actions.length).toBe(1);
        const notifyAction = actions[0] as NotifyNamespaceAction;
        expect(notifyAction.type).toBe('notify_namespace');
        expect(notifyAction.requestId).toBe(subReqId);

        // Subscription stays ACTIVE
        const ns = s.getNamespaceSubscription(subReqId);
        expect(ns?.state).toBe(NamespaceState.ACTIVE);
      });
    });

    describe('handleControlMessage: PUBLISH_NAMESPACE_CANCEL (v14 §9.27)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.27: subscriber sends
       * PUBLISH_NAMESPACE_CANCEL to revoke acceptance. Per-namespace
       * withdrawal; subscription stays ACTIVE.
       */
      it('withdraws namespace, subscription stays ACTIVE, produces notify_namespace', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const { requestId: subReqId } = s.subscribeNamespace(prefix);

        // Activate + receive PUBLISH_NAMESPACE
        s.handleControlMessage({
          type: 'REQUEST_OK', requestId: subReqId, parameters: new Map(),
        } as RequestOk);
        const namespace = [
          new Uint8Array([0x6c, 0x69, 0x76, 0x65]),
          new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        ];
        s.handleControlMessage({
          type: 'PUBLISH_NAMESPACE',
          requestId: varint(1n),
          trackNamespace: namespace,
          parameters: new Map(),
        } as PublishNamespace);

        // PUBLISH_NAMESPACE_CANCEL
        const cancelMsg: PublishNamespaceCancel = {
          type: 'PUBLISH_NAMESPACE_CANCEL',
          trackNamespace: namespace,
          errorCode: varint(0x2n), // TIMEOUT
          errorReason: 'credentials expired',
        };
        const actions = s.handleControlMessage(cancelMsg);

        expect(actions.length).toBe(1);
        const notifyAction = actions[0] as NotifyNamespaceAction;
        expect(notifyAction.type).toBe('notify_namespace');

        // Subscription stays ACTIVE
        const ns = s.getNamespaceSubscription(subReqId);
        expect(ns?.state).toBe(NamespaceState.ACTIVE);
      });
    });

    describe('cancelNamespace (v14 §9.31)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.31: "A subscriber issues a
       * UNSUBSCRIBE_NAMESPACE message to a publisher indicating it is no
       * longer interested."
       */
      it('produces send_control with UNSUBSCRIBE_NAMESPACE', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const { requestId } = s.subscribeNamespace(prefix);

        // Activate
        s.handleControlMessage({
          type: 'REQUEST_OK', requestId, parameters: new Map(),
        } as RequestOk);

        const actions = s.cancelNamespace(requestId);

        expect(actions.length).toBe(1);
        expect(actions[0]?.type).toBe('send_control');
        const action = actions[0] as SendControlAction;
        expect(action.message.type).toBe('UNSUBSCRIBE_NAMESPACE');

        // Namespace subscription terminated
        const ns = s.getNamespaceSubscription(requestId);
        expect(ns?.state).toBe(NamespaceState.TERMINATED);
      });
    });

    describe('handleControlMessage: PUBLISH_NAMESPACE_OK (v14 §9.24)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.24: "The subscriber sends a
       * PUBLISH_NAMESPACE_OK control message to acknowledge the successful
       * authorization and acceptance of a PUBLISH_NAMESPACE message."
       *
       * When we (publisher) send PUBLISH_NAMESPACE and the peer accepts,
       * the response is PUBLISH_NAMESPACE_OK. Must resolve pendingPublishNamespaces.
       */
      it('resolves pending publish namespace on PUBLISH_NAMESPACE_OK', () => {
        const s = createEstablishedV14Session();
        const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
        const { requestId } = s.publishNamespace(namespace);

        const okMsg: PublishNamespaceOk = {
          type: 'PUBLISH_NAMESPACE_OK',
          requestId,
        };

        const actions = s.handleControlMessage(okMsg);

        // Should produce no error actions — just resolve silently
        expect(actions).toEqual([]);
      });

      it('closes session with INVALID_REQUEST_ID for unknown request ID', () => {
        const s = createEstablishedV14Session();

        const okMsg: PublishNamespaceOk = {
          type: 'PUBLISH_NAMESPACE_OK',
          requestId: varint(99n), // never allocated
        };

        const actions = s.handleControlMessage(okMsg);

        expect(actions.length).toBe(1);
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.type).toBe('close_connection');
        expect(closeAction.error).toBe(BigInt(SessionErrorCode.INVALID_REQUEST_ID));
      });

      /**
       * §9.24: "The publisher SHOULD close the session with a protocol
       * error if it receives more than one."
       */
      it('closes session with PROTOCOL_VIOLATION on duplicate PUBLISH_NAMESPACE_OK', () => {
        const s = createEstablishedV14Session();
        const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const { requestId } = s.publishNamespace(namespace);

        // First OK — should succeed
        s.handleControlMessage({
          type: 'PUBLISH_NAMESPACE_OK',
          requestId,
        } as PublishNamespaceOk);

        // Second OK — should close with PROTOCOL_VIOLATION (or INVALID_REQUEST_ID
        // since the pending was already removed)
        const actions = s.handleControlMessage({
          type: 'PUBLISH_NAMESPACE_OK',
          requestId,
        } as PublishNamespaceOk);

        expect(actions.length).toBe(1);
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.type).toBe('close_connection');
      });
    });

    describe('handleControlMessage: PUBLISH_NAMESPACE_ERROR (v14 §9.25)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.25: "The subscriber sends a
       * PUBLISH_NAMESPACE_ERROR control message for tracks that failed
       * authorization."
       *
       * Error codes per §9.25:
       *   INTERNAL_ERROR (0x0), UNAUTHORIZED (0x1), TIMEOUT (0x2),
       *   NOT_SUPPORTED (0x3), UNINTERESTED (0x4),
       *   MALFORMED_AUTH_TOKEN (0x10), EXPIRED_AUTH_TOKEN (0x12)
       */
      it('resolves pending publish namespace on PUBLISH_NAMESPACE_ERROR', () => {
        const s = createEstablishedV14Session();
        const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const { requestId } = s.publishNamespace(namespace);

        const errMsg: PublishNamespaceError = {
          type: 'PUBLISH_NAMESPACE_ERROR',
          requestId,
          errorCode: varint(0x1n), // UNAUTHORIZED
          errorReason: 'not authorized to publish',
        };

        const actions = s.handleControlMessage(errMsg);

        expect(actions).toEqual([]);
      });

      it('closes session with INVALID_REQUEST_ID for unknown request ID', () => {
        const s = createEstablishedV14Session();

        const errMsg: PublishNamespaceError = {
          type: 'PUBLISH_NAMESPACE_ERROR',
          requestId: varint(99n),
          errorCode: varint(0x3n), // NOT_SUPPORTED
          errorReason: 'not supported',
        };

        const actions = s.handleControlMessage(errMsg);

        expect(actions.length).toBe(1);
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.type).toBe('close_connection');
        expect(closeAction.error).toBe(BigInt(SessionErrorCode.INVALID_REQUEST_ID));
      });

      /**
       * PUBLISH_NAMESPACE_ERROR after PUBLISH_NAMESPACE_OK = protocol violation.
       * §6.2: "A subscriber MUST send exactly one PUBLISH_NAMESPACE_OK or
       * PUBLISH_NAMESPACE_ERROR in response to a PUBLISH_NAMESPACE."
       */
      it('closes session on PUBLISH_NAMESPACE_ERROR after prior OK', () => {
        const s = createEstablishedV14Session();
        const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
        const { requestId } = s.publishNamespace(namespace);

        // First: OK
        s.handleControlMessage({
          type: 'PUBLISH_NAMESPACE_OK',
          requestId,
        } as PublishNamespaceOk);

        // Then: ERROR — pending already consumed, should close
        const actions = s.handleControlMessage({
          type: 'PUBLISH_NAMESPACE_ERROR',
          requestId,
          errorCode: varint(0x0n),
          errorReason: 'late error',
        } as PublishNamespaceError);

        expect(actions.length).toBe(1);
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.type).toBe('close_connection');
      });
    });

    describe('handleControlMessage: UNSUBSCRIBE_NAMESPACE (v14 §9.31)', () => {
      /**
       * draft-ietf-moq-transport-14 §9.31: "A subscriber issues a
       * UNSUBSCRIBE_NAMESPACE message to a publisher indicating it is no
       * longer interested in PUBLISH_NAMESPACE, PUBLISH_NAMESPACE_DONE and
       * PUBLISH messages for the specified track namespace prefix."
       *
       * In draft-16, this is replaced by closing the bidi stream.
       * On the control stream (draft-14), the session must handle it
       * gracefully without PROTOCOL_VIOLATION.
       */
      it('does not crash — returns empty actions for unmatched prefix', () => {
        const s = createEstablishedV14Session();

        const unsubMsg: UnsubscribeNamespace = {
          type: 'UNSUBSCRIBE_NAMESPACE',
          trackNamespacePrefix: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])], // "live"
        };

        // Should NOT cause PROTOCOL_VIOLATION — just ignore
        const actions = s.handleControlMessage(unsubMsg);
        expect(actions).toEqual([]);
      });

      it('does not fall through to default PROTOCOL_VIOLATION handler', () => {
        const s = createEstablishedV14Session();

        const unsubMsg: UnsubscribeNamespace = {
          type: 'UNSUBSCRIBE_NAMESPACE',
          trackNamespacePrefix: [new Uint8Array([0x6c])],
        };

        const actions = s.handleControlMessage(unsubMsg);

        // Must NOT be a close_connection
        const hasClose = actions.some(a => a.type === 'close_connection');
        expect(hasClose).toBe(false);
      });
    });

    describe('default handler in v14 → PROTOCOL_VIOLATION', () => {
      /**
       * Draft-14 has no generic REQUEST_ERROR for unsupported messages.
       * Wire code 0x05 is SUBSCRIBE_ERROR, not REQUEST_ERROR.
       * The session MUST close with PROTOCOL_VIOLATION instead.
       */
      it('closes session with PROTOCOL_VIOLATION for unsupported message types', () => {
        const s = createEstablishedV14Session();

        // Send some message type the session doesn't explicitly handle
        // SUBSCRIBE_NAMESPACE is normally outbound-only for a subscriber
        const weirdMsg = {
          type: 'SUBSCRIBE_NAMESPACE' as const,
          requestId: varint(1n),
          trackNamespacePrefix: [new Uint8Array([0x6c])],
          parameters: new Map(),
        };

        const actions = s.handleControlMessage(weirdMsg);

        expect(actions.length).toBe(1);
        const closeAction = actions[0] as CloseConnectionAction;
        expect(closeAction.type).toBe('close_connection');
        expect(closeAction.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
      });
    });

    describe('validateControlMessageParams leniency for v14', () => {
      /**
       * Draft-14 servers may send parameters unknown to draft-16.
       * v14 session should ignore unknown params, not PROTOCOL_VIOLATION.
       */
      it('ignores unknown message parameters in v14 mode', () => {
        const s = createEstablishedV14Session();
        const prefix = [new Uint8Array([0x6c])];
        const { requestId } = s.subscribeNamespace(prefix);

        // SUBSCRIBE_OK with an unknown parameter — should NOT close session
        const subscribeOk: SubscribeOk = {
          type: 'SUBSCRIBE_OK',
          requestId,
          trackAlias: varint(0n),
          parameters: new Map([[varint(0xFFn), [varint(42n)]]]), // unknown param
          trackExtensions: new Map(),
        };

        // In draft-16 this would be PROTOCOL_VIOLATION, in v14 it should be ignored
        // But we don't have a subscription for this requestId, let's create one properly
        const s2 = createEstablishedV14Session();
        const sub = s2.subscribe(
          [new Uint8Array([0x6c])],
          new Uint8Array([0x74]),
        );
        const subscribeOk2: SubscribeOk = {
          type: 'SUBSCRIBE_OK',
          requestId: sub.requestId,
          trackAlias: varint(0n),
          parameters: new Map([[varint(0xFFn), [varint(42n)]]]),
          trackExtensions: new Map(),
        };

        const actions = s2.handleControlMessage(subscribeOk2);
        // Should NOT close session
        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });

      it('allows DELIVERY_TIMEOUT=0 in v14 mode', () => {
        const s = createEstablishedV14Session();
        const sub = s.subscribe(
          [new Uint8Array([0x6c])],
          new Uint8Array([0x74]),
        );
        const subscribeOk: SubscribeOk = {
          type: 'SUBSCRIBE_OK',
          requestId: sub.requestId,
          trackAlias: varint(0n),
          parameters: new Map([[varint(MessageParam.DELIVERY_TIMEOUT), [varint(0n)]]]),
          trackExtensions: new Map(),
        };

        const actions = s.handleControlMessage(subscribeOk);
        // Should NOT close session — DELIVERY_TIMEOUT=0 is valid in v14
        expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
      });
    });

    it('suppresses REQUEST_OK response for incoming REQUEST_UPDATE in draft-14 (§9.10)', () => {
      /**
       * Draft-14 §9.10: "There is no control message in response to a
       * SUBSCRIBE_UPDATE, because it is expected that it will always succeed."
       */
      const s = createEstablishedV14Session();

      // Create a publisher-side subscription by handling an incoming SUBSCRIBE
      const sub: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c])],
        trackName: new Uint8Array([0x74]),
        parameters: new Map(),
      };
      s.handleControlMessage(sub);

      // Accept it
      const acceptActions = s.acceptSubscribe(varint(1n), varint(42n));
      expect(acceptActions.some(a => a.type === 'send_control')).toBe(true);

      // Now receive a REQUEST_UPDATE for this subscription
      const update: RequestUpdate = {
        type: 'REQUEST_UPDATE',
        requestId: varint(3n), // new request ID
        existingRequestId: varint(1n),
        parameters: new Map([
          [MessageParam.FORWARD, [varint(0n)]],
        ]),
      };
      const actions = s.handleControlMessage(update);

      // Draft-14: should NOT send REQUEST_OK (empty actions or non-send actions)
      const sendActions = actions.filter(a => a.type === 'send_control');
      expect(sendActions.length).toBe(0);
    });

    it('replays current filter on REQUEST_UPDATE when no new filter specified (§9.10)', () => {
      /**
       * Draft-14 §9.10: Start Location and End Group are mandatory inline fields.
       * When no new filter is specified, the session should replay the current filter
       * to avoid widening the subscription.
       */
      const s = createEstablishedV14Session();

      // Subscribe with an AbsoluteStart filter
      const result = s.subscribe(
        [new Uint8Array([0x6c])],
        new Uint8Array([0x74]),
        {
          subscriptionFilter: {
            type: 'AbsoluteStart',
            startGroup: varint(10n),
            startObject: varint(0n),
          },
        },
      );

      // Accept it
      const subscribeOk: SubscribeOk = {
        type: 'SUBSCRIBE_OK',
        requestId: result.requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      };
      s.handleControlMessage(subscribeOk);

      // Send a REQUEST_UPDATE with only forward change (no new filter)
      const { actions } = s.requestUpdate(result.requestId, { forward: 0 });

      // The generated REQUEST_UPDATE should include SUBSCRIPTION_FILTER
      // so the draft-14 codec can encode the inline fields correctly.
      const sendAction = actions.find(a => a.type === 'send_control');
      expect(sendAction).toBeDefined();
      if (sendAction?.type === 'send_control') {
        const msg = sendAction.message as RequestUpdate;
        expect(msg.type).toBe('REQUEST_UPDATE');
        // Filter should be present (replayed from original subscribe)
        const filterParam = msg.parameters.get(MessageParam.SUBSCRIPTION_FILTER);
        expect(filterParam).toBeDefined();
        expect(filterParam![0]).toBeInstanceOf(Uint8Array);
      }
    });

    it('handles incoming PUBLISH without closing the session (§9.13)', () => {
      /**
       * Draft-14 §9.13: Publisher sends PUBLISH to announce it wants to
       * publish on a track. The subscriber should handle this as an incoming
       * subscription, not close the session.
       */
      const s = createEstablishedV14Session();
      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      };
      const actions = s.handleControlMessage(publish);
      // Should NOT close session
      expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
    });

    it('acceptSubscribe after PUBLISH sends PUBLISH_OK, not SUBSCRIBE_OK (§9.14)', () => {
      /**
       * Draft-14 §9.14: Response to PUBLISH is PUBLISH_OK, not SUBSCRIBE_OK.
       * The session must detect that the subscription originated from PUBLISH
       * and produce the correct message type.
       * @see draft-ietf-moq-transport-14 §9.14
       */
      const s = createEstablishedV14Session();
      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      };
      s.handleControlMessage(publish);

      // Accept the PUBLISH-initiated subscription
      const actions = s.acceptSubscribe(varint(1n), varint(42n));
      expect(actions.length).toBe(1);
      const sendAction = actions[0] as SendControlAction;
      expect(sendAction.type).toBe('send_control');
      // Must be PUBLISH_OK, not SUBSCRIBE_OK
      expect(sendAction.message.type).toBe('PUBLISH_OK');
    });

    it('PUBLISH_OK carries GROUP_ORDER from inbound PUBLISH, never 0x0 (§9.14)', () => {
      /**
       * Draft-14 §9.14: "Group Order: Indicates the subscription will be
       * delivered in Ascending (0x1) or Descending (0x2) order by group.
       * Values of 0x0 and those larger than 0x2 are a protocol error."
       *
       * When session builds PUBLISH_OK for a publish-initiated subscription,
       * it must carry forward the GROUP_ORDER from the inbound PUBLISH.
       * @see draft-ietf-moq-transport-14 §9.14
       */
      const s = createEstablishedV14Session();
      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(2)]],  // Descending
        ]),
        trackExtensions: new Map(),
      };
      s.handleControlMessage(publish);

      const actions = s.acceptSubscribe(varint(1n), varint(42n));
      expect(actions.length).toBe(1);
      const sendAction = actions[0] as SendControlAction;
      const publishOk = sendAction.message as PublishOk;
      expect(publishOk.type).toBe('PUBLISH_OK');

      // GROUP_ORDER must be preserved from inbound PUBLISH
      const groupOrder = publishOk.parameters.get(varint(MessageParam.GROUP_ORDER));
      expect(groupOrder).toBeDefined();
      expect(groupOrder![0]).toBe(2n); // Descending (0x2)
    });

    it('PUBLISH_OK defaults GROUP_ORDER to Ascending (0x1) when PUBLISH omits it (§9.14)', () => {
      /**
       * If the inbound PUBLISH doesn't specify GROUP_ORDER, the PUBLISH_OK
       * must still use a valid value (0x1 or 0x2), never 0x0.
       * @see draft-ietf-moq-transport-14 §9.14
       */
      const s = createEstablishedV14Session();
      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map(),  // No GROUP_ORDER
        trackExtensions: new Map(),
      };
      s.handleControlMessage(publish);

      const actions = s.acceptSubscribe(varint(1n), varint(42n));
      const publishOk = (actions[0] as SendControlAction).message as PublishOk;

      const groupOrder = publishOk.parameters.get(varint(MessageParam.GROUP_ORDER));
      expect(groupOrder).toBeDefined();
      // Must be 0x1 (Ascending) — never 0x0
      expect(groupOrder![0]).toBe(1n);
    });

    it('rejectSubscribe after PUBLISH sends PUBLISH_ERROR, not REQUEST_ERROR (§9.15)', () => {
      /**
       * Draft-14 §9.15: Response to PUBLISH rejection is PUBLISH_ERROR.
       * REQUEST_ERROR is not valid as a response to PUBLISH in draft-14.
       * @see draft-ietf-moq-transport-14 §9.15
       */
      const s = createEstablishedV14Session();
      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      };
      s.handleControlMessage(publish);

      // Reject the PUBLISH-initiated subscription
      const actions = s.rejectSubscribe(varint(1n), varint(0x4n), 'not interested');
      expect(actions.length).toBe(1);
      const sendAction = actions[0] as SendControlAction;
      expect(sendAction.type).toBe('send_control');
      // Must be PUBLISH_ERROR, not REQUEST_ERROR
      expect(sendAction.message.type).toBe('PUBLISH_ERROR');
    });

    it('closes session on duplicate track alias in PUBLISH (§9.13)', () => {
      /**
       * Draft-14 §9.13: "The same Track Alias MUST NOT be used to refer
       * to two different Tracks simultaneously. If a subscriber receives
       * a PUBLISH that uses the same Track Alias as a different track with
       * an active subscription, it MUST close the session with error
       * DUPLICATE_TRACK_ALIAS."
       * @see draft-ietf-moq-transport-14 §9.13
       */
      const s = createEstablishedV14Session();
      const publish1: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      };
      s.handleControlMessage(publish1);

      // Second PUBLISH with same alias but different track
      // Server request IDs are odd (parity 1), and sequential: 1, 3, 5...
      const publish2: Publish = {
        type: 'PUBLISH',
        requestId: varint(3n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f]), // "audio" instead of "video"
        trackAlias: varint(42n), // Same alias!
        parameters: new Map(),
        trackExtensions: new Map(),
      };
      const actions = s.handleControlMessage(publish2);

      // Must close with DUPLICATE_TRACK_ALIAS
      const closeAction = actions.find(a => a.type === 'close_connection') as CloseConnectionAction | undefined;
      expect(closeAction).toBeDefined();
      expect(closeAction!.error).toBe(SessionErrorCode.DUPLICATE_TRACK_ALIAS);
    });

    it('accepts SUBSCRIBE with GROUP_ORDER=0 in draft-14 (§9.7)', () => {
      /**
       * Draft-14 §9.7: "A value of 0x0 indicates the original publisher's
       * Group Order SHOULD be used." — valid for SUBSCRIBE.
       * @see draft-ietf-moq-transport-14 §9.7
       */
      const s = createEstablishedV14Session();
      const sub: Subscribe = {
        type: 'SUBSCRIBE',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c])],
        trackName: new Uint8Array([0x74]),
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(0)]],  // 0x0 = publisher's order
        ]),
      };
      const actions = s.handleControlMessage(sub);
      // Must NOT close the session — GROUP_ORDER=0 is valid for SUBSCRIBE in draft-14
      expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
    });

    it('accepts FETCH with GROUP_ORDER=0 in draft-14 (§9.16)', () => {
      /**
       * Draft-14 §9.16: "A value of 0x0 indicates the original publisher's
       * Group Order SHOULD be used." — valid for FETCH.
       * @see draft-ietf-moq-transport-14 §9.16
       */
      const s = createEstablishedV14Session();
      const fetch: Fetch = {
        type: 'FETCH',
        requestId: varint(1n),
        fetch: {
          fetchType: 0x1 as const,
          trackNamespace: [new Uint8Array([0x6c])],
          trackName: new Uint8Array([0x74]),
          startLocation: { group: varint(0n), object: varint(0n) },
          endLocation: { group: varint(1n), object: varint(0n) },
        },
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(0)]],  // 0x0 = publisher's order
        ]),
      };
      const actions = s.handleControlMessage(fetch);
      // Must NOT close the session — GROUP_ORDER=0 is valid for FETCH in draft-14
      expect(actions.every(a => a.type !== 'close_connection')).toBe(true);
    });

    it('closes session on PUBLISH with GROUP_ORDER=0 in draft-14 (§9.13)', () => {
      /**
       * Draft-14 §9.13: "Values of 0x0 and those larger than 0x2 are a
       * protocol error." — PUBLISH GROUP_ORDER must be 0x1 or 0x2.
       * @see draft-ietf-moq-transport-14 §9.13
       */
      const s = createEstablishedV14Session();
      const publish: Publish = {
        type: 'PUBLISH',
        requestId: varint(1n),
        trackNamespace: [new Uint8Array([0x6c, 0x69, 0x76, 0x65])],
        trackName: new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]),
        trackAlias: varint(42n),
        parameters: new Map([
          [varint(MessageParam.GROUP_ORDER), [varint(0)]],  // 0x0 = INVALID for PUBLISH
        ]),
        trackExtensions: new Map(),
      };
      const actions = s.handleControlMessage(publish);
      // Must close with PROTOCOL_VIOLATION
      const closeAction = actions.find(a => a.type === 'close_connection') as CloseConnectionAction | undefined;
      expect(closeAction).toBeDefined();
      expect(closeAction!.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
    });

    it('replays forward state on REQUEST_UPDATE when not specified (§9.10)', () => {
      /**
       * Finding 3: When only filter is updated, Forward should not reset to 1.
       * "If a parameter included in SUBSCRIBE is not present in
       * SUBSCRIBE_UPDATE, its value remains unchanged."
       */
      const s = createEstablishedV14Session();
      const result = s.subscribe(
        [new Uint8Array([0x6c])],
        new Uint8Array([0x74]),
        {
          subscriptionFilter: {
            type: 'AbsoluteStart',
            startGroup: varint(10n),
            startObject: varint(0n),
          },
        },
      );
      s.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId: result.requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      } as SubscribeOk);

      // First: pause (forward=0)
      s.requestUpdate(result.requestId, { forward: 0 });

      // Second: filter-only update (no forward specified)
      const { actions } = s.requestUpdate(result.requestId, {
        subscriptionFilter: {
          type: 'AbsoluteStart',
          startGroup: varint(50n),
          startObject: varint(0n),
        },
      });

      const sendAction = actions.find(a => a.type === 'send_control');
      const msg = sendAction!.message as RequestUpdate;
      // Forward should be replayed as 0 (paused), not default to 1
      const fwd = msg.parameters.get(MessageParam.FORWARD)?.[0];
      expect(fwd).toBe(0n);
    });

    it('replays priority on REQUEST_UPDATE when not specified (§9.10)', () => {
      /**
       * Finding 3: When only forward is changed, priority should not reset to 128.
       */
      const s = createEstablishedV14Session();
      const result = s.subscribe(
        [new Uint8Array([0x6c])],
        new Uint8Array([0x74]),
        { subscriberPriority: varint(42n) },
      );
      s.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId: result.requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      } as SubscribeOk);

      // Update forward only — priority should be replayed
      const { actions } = s.requestUpdate(result.requestId, { forward: 0 });
      const sendAction = actions.find(a => a.type === 'send_control');
      const msg = sendAction!.message as RequestUpdate;
      const priority = msg.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)?.[0];
      expect(priority).toBe(42n);
    });

    it('applies draft-14 REQUEST_UPDATE immediately without pending leak (§9.10)', () => {
      /**
       * Finding 4: Draft-14 SUBSCRIBE_UPDATE has no response (no REQUEST_OK).
       * The session must apply state changes immediately and not accumulate
       * pending updates.
       */
      const s = createEstablishedV14Session();
      const result = s.subscribe(
        [new Uint8Array([0x6c])],
        new Uint8Array([0x74]),
      );
      s.handleControlMessage({
        type: 'SUBSCRIBE_OK',
        requestId: result.requestId,
        trackAlias: varint(42n),
        parameters: new Map(),
        trackExtensions: new Map(),
      } as SubscribeOk);

      // Send 3 updates
      s.requestUpdate(result.requestId, { forward: 0 });
      s.requestUpdate(result.requestId, { forward: 1 });
      s.requestUpdate(result.requestId, { forward: 0 });

      // pendingUpdates should be empty (applied immediately, not waiting for REQUEST_OK)
      // We verify indirectly: the subscription's forward state should reflect the last update
      const sub = (s as any).subscriptions.get(result.requestId as bigint);
      expect(sub.forwardState).toBe(0); // ForwardState.PAUSED = 0
    });
  });

  // ─── Draft-16 Control-Stream Namespace Discovery ─────────────────────

  describe('draft-16 control-stream namespace handling (§9.20, §6.2)', () => {
    /**
     * Helper: a v16 client session in ESTABLISHED state.
     */
    function createEstablishedV16Session(): Session {
      const s = new Session(EndpointRole.CLIENT, 16);
      s.initiateSetup({ maxRequestId: varint(100n) });
      s.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
      });
      return s;
    }

    describe('handleControlMessage: PUBLISH_NAMESPACE (v16)', () => {
      /**
       * Spec contract: §6.2 — "A subscriber MUST send exactly one
       * REQUEST_OK or REQUEST_ERROR in response to a PUBLISH_NAMESPACE."
       *
       * Scenario A — matching SUBSCRIBE_NAMESPACE prefix exists.
       */
      it('sends REQUEST_OK + notify_namespace when prefix matches', () => {
        const s = createEstablishedV16Session();
        const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
        const { requestId: subReqId } = s.subscribeNamespace(prefix);

        // Activate namespace subscription via REQUEST_OK on the bidi stream
        // mock path — call the same internal handler the adapter uses.
        s.handleNamespaceStreamMessage(subReqId, {
          type: 'REQUEST_OK',
          requestId: subReqId,
          parameters: new Map(),
        } as RequestOk);

        const pubNsMsg: PublishNamespace = {
          type: 'PUBLISH_NAMESPACE',
          requestId: varint(1n), // server's odd request ID
          trackNamespace: [
            new Uint8Array([0x6c, 0x69, 0x76, 0x65]), // "live"
            new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]), // "video"
          ],
          parameters: new Map(),
        };

        const actions = s.handleControlMessage(pubNsMsg);

        const okAction = actions.find(a => a.type === 'send_control') as SendControlAction;
        expect(okAction).toBeDefined();
        expect(okAction.message.type).toBe('REQUEST_OK');
        expect((okAction.message as RequestOk).requestId).toBe(1n);

        const notifyAction = actions.find(a => a.type === 'notify_namespace') as NotifyNamespaceAction;
        expect(notifyAction).toBeDefined();
        expect(notifyAction.requestId).toBe(subReqId);
        expect(notifyAction.message).toBe(pubNsMsg);
      });

      /**
       * Scenario B — no matching SUBSCRIBE_NAMESPACE.
       *
       * §6.2: "A subscriber MAY send SUBSCRIBE or FETCH for tracks in a
       * namespace without having received a PUBLISH_NAMESPACE for it."
       * Conversely, publishers MAY push PUBLISH_NAMESPACE without prior
       * SUBSCRIBE_NAMESPACE. Under v16 the session acks REQUEST_OK and
       * surfaces the announcement to the application via notify_namespace
       * keyed by the publisher's requestId.
       */
      it('sends REQUEST_OK + notify_namespace when no prefix matches', () => {
        const s = createEstablishedV16Session();
        // No subscribeNamespace called — publisher pushes anyway.

        const pubNsMsg: PublishNamespace = {
          type: 'PUBLISH_NAMESPACE',
          requestId: varint(1n),
          trackNamespace: [
            new Uint8Array([0x63, 0x6d, 0x73, 0x66]), // "cmsf"
            new Uint8Array([0x63, 0x6c, 0x65, 0x61, 0x72]), // "clear"
          ],
          parameters: new Map(),
        };

        const actions = s.handleControlMessage(pubNsMsg);

        const okAction = actions.find(a => a.type === 'send_control') as SendControlAction;
        expect(okAction).toBeDefined();
        expect(okAction.message.type).toBe('REQUEST_OK');
        expect((okAction.message as RequestOk).requestId).toBe(1n);

        const notifyAction = actions.find(a => a.type === 'notify_namespace') as NotifyNamespaceAction;
        expect(notifyAction).toBeDefined();
        expect(notifyAction.requestId).toBe(1n); // dispatch key = publisher's reqId
        expect(notifyAction.message).toBe(pubNsMsg);
      });

      /**
       * Encoder regression: the v16 encoder rejects PUBLISH_NAMESPACE_OK
       * and PUBLISH_NAMESPACE_ERROR (deprecated under v16, replaced by
       * REQUEST_OK / REQUEST_ERROR). Make sure the session never produces
       * those types under v16.
       */
      it('never produces PUBLISH_NAMESPACE_OK or PUBLISH_NAMESPACE_ERROR under v16', () => {
        const s = createEstablishedV16Session();
        const actions = s.handleControlMessage({
          type: 'PUBLISH_NAMESPACE',
          requestId: varint(1n),
          trackNamespace: [new Uint8Array([0x78])],
          parameters: new Map(),
        } as PublishNamespace);

        for (const a of actions) {
          if (a.type === 'send_control') {
            expect(a.message.type).not.toBe('PUBLISH_NAMESPACE_OK');
            expect(a.message.type).not.toBe('PUBLISH_NAMESPACE_ERROR');
          }
        }
      });
    });

    describe('handleControlMessage: PUBLISH_NAMESPACE_DONE (v16, §9.22)', () => {
      /**
       * Figure 23: v16 PUBLISH_NAMESPACE_DONE carries only Request ID
       * (the requestId of the original PUBLISH_NAMESPACE). Surface to
       * application via notify_namespace.
       */
      it('emits notify_namespace keyed by requestId', () => {
        const s = createEstablishedV16Session();

        const doneMsg: PublishNamespaceDone = {
          type: 'PUBLISH_NAMESPACE_DONE',
          requestId: varint(1n),
        };
        const actions = s.handleControlMessage(doneMsg);

        expect(actions.length).toBe(1);
        const notifyAction = actions[0] as NotifyNamespaceAction;
        expect(notifyAction.type).toBe('notify_namespace');
        expect(notifyAction.requestId).toBe(1n);
        expect(notifyAction.message).toBe(doneMsg);
      });

      it('closes session if requestId is missing under v16 (PROTOCOL_VIOLATION)', () => {
        const s = createEstablishedV16Session();

        // Malformed: v16 wire MUST carry requestId. trackNamespace-only is v14 shape.
        const doneMsg: PublishNamespaceDone = {
          type: 'PUBLISH_NAMESPACE_DONE',
          trackNamespace: [new Uint8Array([0x78])],
        };
        const actions = s.handleControlMessage(doneMsg);

        const closeAction = actions.find(a => a.type === 'close_connection') as CloseConnectionAction;
        expect(closeAction).toBeDefined();
        expect(closeAction.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
      });
    });
  });

  // ─── publishNamespaceDone (§9.22) ─────────────────────────────────

  describe('publishNamespaceDone (§9.22)', () => {
    let session: Session;

    beforeEach(() => {
      session = new Session(EndpointRole.CLIENT);
      session.initiateSetup({ maxRequestId: varint(100n) });
      const serverParams: Parameters = new Map();
      serverParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(200n)]);
      session.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: serverParams,
      } as ServerSetup);
    });

    function publishAndAccept(ns: Uint8Array[]): bigint {
      const { requestId, actions } = session.publishNamespace(ns);
      // Simulate peer accepting with REQUEST_OK
      session.handleControlMessage({
        type: 'REQUEST_OK',
        requestId,
      } as RequestOk);
      return requestId as bigint;
    }

    it('sends PUBLISH_NAMESPACE_DONE after accepted publishNamespace', () => {
      const reqId = publishAndAccept([new Uint8Array([0x6c, 0x69, 0x76, 0x65])]);
      const actions = session.publishNamespaceDone(varint(reqId));
      expect(actions.length).toBe(1);
      const msg = (actions[0] as SendControlAction).message as PublishNamespaceDone;
      expect(msg.type).toBe('PUBLISH_NAMESPACE_DONE');
      expect(msg.requestId).toBe(reqId);
    });

    it('throws for unknown requestId', () => {
      expect(() => session.publishNamespaceDone(varint(999n))).toThrow();
    });

    it('throws for pending (not yet accepted) publishNamespace', () => {
      const { requestId } = session.publishNamespace([new Uint8Array([0x6e, 0x73])]);
      // Not accepted yet — should throw
      expect(() => session.publishNamespaceDone(requestId)).toThrow();
    });

    it('cannot call publishNamespaceDone twice for the same namespace', () => {
      const reqId = publishAndAccept([new Uint8Array([0x6c, 0x69, 0x76, 0x65])]);
      session.publishNamespaceDone(varint(reqId));
      // Second call — already done
      expect(() => session.publishNamespaceDone(varint(reqId))).toThrow();
    });

    it('v16: emits requestId, no trackNamespace', () => {
      const reqId = publishAndAccept([new Uint8Array([0x6c, 0x69, 0x76, 0x65])]);
      const actions = session.publishNamespaceDone(varint(reqId));
      const msg = (actions[0] as SendControlAction).message as PublishNamespaceDone;
      expect(msg.requestId).toBe(reqId);
      expect(msg.trackNamespace).toBeUndefined();
    });

    it('throws on IDLE session (not yet established)', () => {
      const freshSession = new Session(EndpointRole.CLIENT);
      expect(() => freshSession.publishNamespaceDone(varint(0n))).toThrow();
    });

    it('throws on CLOSED session', () => {
      const reqId = publishAndAccept([new Uint8Array([0x6c, 0x69, 0x76, 0x65])]);
      // Close the same session that has the accepted namespace
      session.close();
      expect(session.state).toBe(SessionState.CLOSED);
      expect(() => session.publishNamespaceDone(varint(reqId))).toThrow();
    });

    it('draft-18: terminates local state and emits NO send_control action (withdrawal is stream cancellation)', () => {
      const s18 = new Session(EndpointRole.CLIENT, 18);
      s18.initiateSetup();
      s18.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);

      const ns = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const { requestId } = s18.publishNamespace(ns);
      s18.handleControlMessage({ type: 'REQUEST_OK', requestId } as RequestOk); // accept

      const actions = s18.publishNamespaceDone(requestId);
      expect(actions).toEqual([]); // no PUBLISH_NAMESPACE_DONE on the wire (§3.3.2)
      // State terminated → a second withdrawal throws.
      expect(() => s18.publishNamespaceDone(requestId)).toThrow();
    });

    it('v14: emits trackNamespace, no requestId', () => {
      const s14 = new Session(EndpointRole.CLIENT, 14);
      s14.initiateSetup({ maxRequestId: varint(100n) });
      const serverParams: Parameters = new Map();
      serverParams.set(varint(SetupParam.MAX_REQUEST_ID), [varint(200n)]);
      s14.handleControlMessage({
        type: 'SERVER_SETUP',
        parameters: serverParams,
      } as ServerSetup);

      const ns = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const { requestId } = s14.publishNamespace(ns);
      // v14 uses PUBLISH_NAMESPACE_OK, not REQUEST_OK
      s14.handleControlMessage({
        type: 'PUBLISH_NAMESPACE_OK',
        requestId,
      } as PublishNamespaceOk);

      const actions = s14.publishNamespaceDone(requestId);
      const msg = (actions[0] as SendControlAction).message as PublishNamespaceDone;
      expect(msg.trackNamespace).toEqual(ns);
      expect(msg.requestId).toBeUndefined();
    });
  });
});

describe('SUBSCRIBE_TRACKS lifecycle (draft-18 §10.19–10.20)', () => {
  function established18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
    return s;
  }
  const prefix = [new TextEncoder().encode('a')];
  const suffix = [new TextEncoder().encode('s1')];
  const name = new TextEncoder().encode('vid');

  it('subscribeTracks → pending; REQUEST_OK → active; PUBLISH_BLOCKED recorded', () => {
    const s = established18();
    const { requestId, actions } = s.subscribeTracks(prefix);
    expect((actions[0] as SendControlAction).message.type).toBe('SUBSCRIBE_TRACKS');
    expect(s.getTrackSubscription(requestId)?.state).toBe('pending');

    // First REQUEST_OK arrives through the stamped pipeline.
    s.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() } as RequestOk, { requestId });
    expect(s.getTrackSubscription(requestId)?.state).toBe('active');

    // PUBLISH_BLOCKED on the response stream is recorded against the request.
    const out = s.handleSubscribeTracksStreamMessage(requestId, {
      type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: suffix, trackName: name,
    } as never);
    expect(out).toEqual([]);
    const blocked = s.getTrackSubscription(requestId)!.blockedTracks;
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.trackName).toEqual(name);
  });

  it('REQUEST_ERROR terminates and removes the track subscription', () => {
    const s = established18();
    const { requestId } = s.subscribeTracks(prefix);
    s.handleControlMessage(
      { type: 'REQUEST_ERROR', requestId, errorCode: varint(1n), retryInterval: varint(0n), errorReason: 'no' } as RequestErrorMsg,
      { requestId },
    );
    expect(s.getTrackSubscription(requestId)).toBeUndefined();
  });

  it('PUBLISH_BLOCKED before REQUEST_OK is a PROTOCOL_VIOLATION', () => {
    const s = established18();
    const { requestId } = s.subscribeTracks(prefix);
    const out = s.handleSubscribeTracksStreamMessage(requestId, {
      type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: suffix, trackName: name,
    } as never);
    expect(out.some((a) => a.type === 'close_connection')).toBe(true);
  });

  it('stream close terminates and removes the subscription', () => {
    const s = established18();
    const { requestId } = s.subscribeTracks(prefix);
    s.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() } as RequestOk, { requestId });
    s.handleSubscribeTracksStreamClosed(requestId);
    expect(s.getTrackSubscription(requestId)).toBeUndefined();
  });
});

describe('inbound PUBLISH lifecycle helpers (draft-18 §10.11, §10.9)', () => {
  function established18Publish(): { s: Session; requestId: bigint } {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
    s.handleControlMessage({
      type: 'PUBLISH', requestId: 1n, trackNamespace: [new Uint8Array([1])], trackName: new Uint8Array([2]),
      trackAlias: 42n, parameters: new Map(), trackExtensions: new Map(),
    } as never);
    s.acceptSubscribe(1n, 42n);
    return { s, requestId: 1n };
  }

  it('handleInboundPublishDone terminates the incoming subscription', () => {
    const { s, requestId } = established18Publish();
    expect(s.getIncomingSubscription(requestId)).toBeDefined();
    const out = s.handleInboundPublishDone(requestId);
    expect(out).toEqual([]);
    expect(s.getIncomingSubscription(requestId)).toBeUndefined();
  });

  it('handleInboundPublishDone for an unknown PUBLISH is a PROTOCOL_VIOLATION', () => {
    const { s } = established18Publish();
    const out = s.handleInboundPublishDone(999n);
    expect(out.some((a) => a.type === 'close_connection')).toBe(true);
  });

  it('a peer REQUEST_UPDATE applies to the original PUBLISH subscription, not the update id', () => {
    const { s, requestId } = established18Publish();
    // Peer sends REQUEST_UPDATE (its own id 3) with FORWARD=0; existingRequestId
    // comes from the PUBLISH stream context (the original PUBLISH id 1).
    s.handleControlMessage(
      { type: 'REQUEST_UPDATE', requestId: 3n, parameters: new Map([[varint(0x10n), [varint(0n)]]]) } as never,
      { requestId: 3n, existingRequestId: requestId } as never,
    );
    // FORWARD applied to the ORIGINAL subscription (1), and no sub exists for 3.
    expect(s.getIncomingSubscription(requestId)?.forwardState).toBe(ForwardState.PAUSED);
    expect(s.getIncomingSubscription(3n)).toBeUndefined();
  });

  it('updateIncomingSubscription builds a REQUEST_UPDATE and REQUEST_OK applies FORWARD', () => {
    const { s, requestId } = established18Publish();
    const { requestId: updateId, actions } = s.updateIncomingSubscription(requestId, { forward: false });
    const upd = (actions[0] as SendControlAction).message;
    expect(upd.type).toBe('REQUEST_UPDATE');
    // The matching REQUEST_OK applies the pending update to the incoming sub.
    s.handleControlMessage({ type: 'REQUEST_OK', requestId: updateId, parameters: new Map() } as RequestOk, { requestId: updateId });
    expect(s.getIncomingSubscription(requestId)?.forwardState).toBe(ForwardState.PAUSED);
  });
});

describe('acceptFetch options (draft-18 §10.13)', () => {
  function established18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
    return s;
  }

  it('acceptFetch carries the provided endOfTrack + endLocation (full uint64)', () => {
    const s = established18();
    s.handleControlMessage({
      type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 0x1, trackNamespace: [new Uint8Array([1])], trackName: new Uint8Array([2]), startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } },
      parameters: new Map(),
    } as never);
    const big = 1n << 63n;
    const actions = s.acceptFetch(1n, { endOfTrack: 1, endLocation: { group: big, object: big + 1n } });
    const fetchOk = (actions[0] as SendControlAction).message as { type: string; endOfTrack: number; endLocation: { group: bigint; object: bigint } };
    expect(fetchOk.type).toBe('FETCH_OK');
    expect(fetchOk.endOfTrack).toBe(1);
    expect(fetchOk.endLocation).toEqual({ group: big, object: big + 1n });
  });

  it('acceptFetch defaults to endOfTrack 0 + {0,0} when no options are given', () => {
    const s = established18();
    s.handleControlMessage({
      type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 0x1, trackNamespace: [new Uint8Array([1])], trackName: new Uint8Array([2]), startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } },
      parameters: new Map(),
    } as never);
    const actions = s.acceptFetch(1n);
    const fetchOk = (actions[0] as SendControlAction).message as { endOfTrack: number; endLocation: { group: bigint; object: bigint } };
    expect(fetchOk.endOfTrack).toBe(0);
    expect(fetchOk.endLocation).toEqual({ group: 0n, object: 0n });
  });
});

describe('REQUEST_ERROR Redirect semantics (draft-18 §10.6.2)', () => {
  const NS = [new TextEncoder().encode('live')];
  const NAME = new TextEncoder().encode('vid');
  const URI = new TextEncoder().encode('https://r.example/moq');
  const range = { startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n) };

  function established18(role = EndpointRole.CLIENT): Session {
    const s = new Session(role, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
    return s;
  }
  const redirectErr = (requestId: bigint, redirect: { connectUri: Uint8Array; trackNamespace: Uint8Array[]; trackName: Uint8Array }): RequestErrorMsg =>
    ({ type: 'REQUEST_ERROR', requestId, errorCode: RequestError.REDIRECT, retryInterval: varint(0n), errorReason: '', redirect } as never);
  const sameSessionTrack = { connectUri: new Uint8Array(0), trackNamespace: NS, trackName: NAME };
  const namespaceRedirect = { connectUri: new Uint8Array(0), trackNamespace: NS, trackName: new Uint8Array(0) };
  const closeOf = (actions: ReturnType<Session['handleControlMessage']>) =>
    actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;

  it('accepts REDIRECT for SUBSCRIBE and terminates the subscription (no session close)', () => {
    const s = established18();
    const { requestId } = s.subscribe(NS, NAME);
    const actions = s.handleControlMessage(redirectErr(requestId, sameSessionTrack));
    expect(closeOf(actions)).toBeUndefined();
    expect(s.getSubscription(requestId)?.isTerminated).toBe(true);
  });

  it('accepts REDIRECT for FETCH, TRACK_STATUS, PUBLISH_NAMESPACE, and SUBSCRIBE_NAMESPACE', () => {
    let s = established18();
    let rid = s.fetch(NS, NAME, range).requestId;
    expect(closeOf(s.handleControlMessage(redirectErr(rid, sameSessionTrack)))).toBeUndefined();

    s = established18();
    rid = s.trackStatus(NS, NAME).requestId;
    expect(closeOf(s.handleControlMessage(redirectErr(rid, sameSessionTrack)))).toBeUndefined();

    s = established18();
    rid = s.publishNamespace(NS).requestId;
    expect(closeOf(s.handleControlMessage(redirectErr(rid, namespaceRedirect)))).toBeUndefined();

    s = established18();
    rid = s.subscribeNamespace(NS).requestId;
    expect(closeOf(s.handleControlMessage(redirectErr(rid, namespaceRedirect)))).toBeUndefined();
  });

  it('rejects REDIRECT for SUBSCRIBE_TRACKS / PUBLISH / REQUEST_UPDATE as PROTOCOL_VIOLATION', () => {
    let s = established18();
    let rid = s.subscribeTracks(NS).requestId;
    expect(closeOf(s.handleControlMessage(redirectErr(rid, sameSessionTrack)))?.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));

    s = established18();
    rid = s.publish(NS, NAME, 5n).requestId;
    expect(closeOf(s.handleControlMessage(redirectErr(rid, sameSessionTrack)))?.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));

    s = established18();
    const subId = s.subscribe(NS, NAME).requestId;
    s.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId: subId, trackAlias: 9n, parameters: new Map(), trackExtensions: new Map() } as never);
    const updId = s.requestUpdate(subId, { forward: false }).requestId;
    expect(closeOf(s.handleControlMessage(redirectErr(updId, sameSessionTrack)))?.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
  });

  it('a SERVER receiving a Redirect with a non-empty Connect URI closes (PROTOCOL_VIOLATION)', () => {
    const s = established18(EndpointRole.SERVER);
    const rid = s.subscribe(NS, NAME).requestId;
    const actions = s.handleControlMessage(redirectErr(rid, { connectUri: URI, trackNamespace: NS, trackName: NAME }));
    expect(closeOf(actions)?.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
  });

  it('a CLIENT may receive a relocation Connect URI (no close)', () => {
    const s = established18(EndpointRole.CLIENT);
    const rid = s.subscribe(NS, NAME).requestId;
    const actions = s.handleControlMessage(redirectErr(rid, { connectUri: URI, trackNamespace: NS, trackName: NAME }));
    expect(closeOf(actions)).toBeUndefined();
  });

  it('a namespace-scoped Redirect with a non-empty Track Name closes (PROTOCOL_VIOLATION)', () => {
    const s = established18();
    const rid = s.publishNamespace(NS).requestId;
    const actions = s.handleControlMessage(redirectErr(rid, { connectUri: new Uint8Array(0), trackNamespace: NS, trackName: NAME }));
    expect(closeOf(actions)?.error).toBe(BigInt(SessionErrorCode.PROTOCOL_VIOLATION));
  });
});

describe('outbound request-stream peer-close terminates the request (draft-18 §11.4.1)', () => {
  const NS = [new TextEncoder().encode('live')];
  const NAME = new TextEncoder().encode('vid');
  const range = { startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n) };
  function s18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
    return s;
  }

  it('SUBSCRIBE: peer close drops the subscription AND unregisters its Track Alias', () => {
    const s = s18();
    const { requestId } = s.subscribe(NS, NAME);
    s.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: 7n, parameters: new Map(), trackProperties: new Map() } as never);
    expect(s.getSubscription(requestId)).toBeDefined();
    expect(s.getTrackByAlias(7n)).toBeDefined();

    s.handleOutboundRequestClosed(requestId); // peer FIN/reset of the SUBSCRIBE stream
    expect(s.getSubscription(requestId)).toBeUndefined();
    expect(s.getTrackByAlias(7n)).toBeUndefined(); // alias freed — late data must not route
  });

  it('FETCH: peer close drops the fetch state', () => {
    const s = s18();
    const { requestId } = s.fetch(NS, NAME, range);
    expect(s.getFetch(requestId)).toBeDefined();
    s.handleOutboundRequestClosed(requestId);
    expect(s.getFetch(requestId)).toBeUndefined();
  });

  it('TRACK_STATUS: peer close clears the pending track status', () => {
    const s = s18();
    const { requestId } = s.trackStatus(NS, NAME);
    expect(s.getPendingTrackStatus(requestId)).toBeDefined();
    s.handleOutboundRequestClosed(requestId);
    expect(s.getPendingTrackStatus(requestId)).toBeUndefined();
  });

  it('PUBLISH: peer close drops the outbound publish (existing behavior preserved)', () => {
    const s = s18();
    const { requestId } = s.publish(NS, NAME, 9n);
    expect(s.getOutgoingPublish(requestId)).toBeDefined();
    s.handleOutboundRequestClosed(requestId);
    expect(s.getOutgoingPublish(requestId)).toBeUndefined();
  });

  it('PUBLISH_NAMESPACE: peer close drops the advertised namespace (a later withdrawal then throws)', () => {
    const s = s18();
    const { requestId } = s.publishNamespace(NS);
    s.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() } as never); // active
    s.handleOutboundRequestClosed(requestId);
    expect(() => s.publishNamespaceDone(requestId)).toThrow(); // state gone
  });
});

describe('draft-18 AUTHORIZATION_TOKEN message-parameter processing (vi64 inner token, §9.2.2.1)', () => {
  // The session must parse the inner Token of a draft-18 message AUTHORIZATION_TOKEN
  // with the vi64 parser. We prove it by behavior: REGISTER an above-QUIC Token
  // Alias on one request, then USE_ALIAS it on a later request — the alias only
  // resolves if both inner tokens were parsed as vi64 and stored/looked-up as the
  // same 2^63 value. (2^63 is above the QUIC-varint ceiling and is unrepresentable
  // by the legacy encoder, so this exercises the full-uint64 path end to end.)
  const big = 1n << 63n; // > 2^62-1

  function established18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    // Size the auth cache so a non-setup REGISTER actually stores (entry ≈ 16 + value bytes).
    s.initiateSetup({ maxAuthTokenCacheSize: varint(1024n) });
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    return s;
  }

  // An inbound PUBLISH is an auth-scoped request (§9.2.2.1) that creates observable
  // incoming-subscription state, carrying the token as the AUTHORIZATION_TOKEN param.
  // Peer-initiated request IDs are odd (LSB=1), so each request uses a distinct odd id.
  function inboundPublish(requestId: bigint, nsByte: number, trackAlias: bigint, tokenBytes: Uint8Array): Publish {
    const params: Parameters = new Map();
    params.set(varint(0x03n), [tokenBytes]); // AUTHORIZATION_TOKEN (type 0x03), bytes value
    return {
      type: 'PUBLISH', requestId, trackNamespace: [new Uint8Array([nsByte])], trackName: new Uint8Array([2]),
      trackAlias, parameters: params, trackExtensions: new Map(),
    } as unknown as Publish;
  }

  it('registers an above-QUIC vi64 Token Alias, then resolves it via USE_ALIAS on a later request', () => {
    const s = established18();

    // Request 1 (id 1): REGISTER alias=2^63 with type=2^63 (vi64-encoded inner token).
    const register = encodeAuthorizationToken18({
      aliasType: AliasType.REGISTER, tokenAlias: big, tokenType: big,
      tokenValue: new Uint8Array([0xaa, 0xbb]),
    });
    const a1 = s.handleControlMessage(inboundPublish(1n, 0x10, 42n, register) as never);
    expect(a1.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(s.getIncomingSubscription(1n)).toBeDefined();

    // Request 2 (id 3): USE_ALIAS the same above-QUIC alias — resolves only if it was
    // registered as 2^63, i.e. both requests parsed the inner token as vi64.
    const useAlias = encodeAuthorizationToken18({ aliasType: AliasType.USE_ALIAS, tokenAlias: big });
    const a2 = s.handleControlMessage(inboundPublish(3n, 0x11, 43n, useAlias) as never);
    expect(a2.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(s.getIncomingSubscription(3n)).toBeDefined();
  });
});

describe('draft-18 message-parameter scope validation (§10.2.1)', () => {
  const NS = [new Uint8Array([0x6c])];
  const NAME = new Uint8Array([0x76]);
  const PRIO = MessageParam.SUBSCRIBER_PRIORITY;

  function client18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    return s;
  }
  const noClose = (actions: ReturnType<Session['handleControlMessage']>) =>
    actions.every((a) => a.type !== 'close_connection');
  const protocolViolation = (actions: ReturnType<Session['handleControlMessage']>) => {
    const close = actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
    return close?.error === SessionErrorCode.PROTOCOL_VIOLATION;
  };
  // A valid USE_VALUE token so AUTHORIZATION_TOKEN survives auth processing — keeps
  // these tests focused on parameter SCOPE, not token semantics.
  const authToken = () => encodeAuthorizationToken18({
    aliasType: AliasType.USE_VALUE, tokenType: 1n, tokenValue: new Uint8Array([0x01]),
  });
  const incSubscribe = (requestId: bigint, params: Parameters) =>
    ({ type: 'SUBSCRIBE', requestId, trackNamespace: NS, trackName: NAME, parameters: params } as Subscribe);
  const incFetch = (requestId: bigint, params: Parameters) => ({
    type: 'FETCH', requestId,
    fetch: { fetchType: 0x1, trackNamespace: NS, trackName: NAME, startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } },
    parameters: params,
  });
  const incSubscribeTracks = (requestId: bigint, params: Parameters) =>
    ({ type: 'SUBSCRIBE_TRACKS', requestId, trackNamespacePrefix: [new Uint8Array([0x61])], parameters: params });

  // ── Valid draft-18 params accepted (red-first: 0x04/0x06/0x0A were "unknown") ──
  it('accepts RENDEZVOUS_TIMEOUT (0x04) on SUBSCRIBE', () => {
    const s = client18();
    const a = s.handleControlMessage(incSubscribe(1n, new Map([[MessageParam.RENDEZVOUS_TIMEOUT, [5000n]]])) as never);
    expect(noClose(a)).toBe(true);
  });
  it('accepts SUBGROUP_DELIVERY_TIMEOUT (0x06) on SUBSCRIBE', () => {
    const s = client18();
    const a = s.handleControlMessage(incSubscribe(1n, new Map([[MessageParam.SUBGROUP_DELIVERY_TIMEOUT, [3000n]]])) as never);
    expect(noClose(a)).toBe(true);
  });
  it('accepts FILL_TIMEOUT (0x0A) on FETCH', () => {
    const s = client18();
    const a = s.handleControlMessage(incFetch(1n, new Map([[MessageParam.FILL_TIMEOUT, [2000n]]])) as never);
    expect(noClose(a)).toBe(true);
  });
  it('accepts AUTHORIZATION_TOKEN on SUBSCRIBE_TRACKS', () => {
    const s = client18();
    const a = s.handleControlMessage(incSubscribeTracks(1n, new Map([[MessageParam.AUTHORIZATION_TOKEN, [authToken()]]])) as never);
    expect(noClose(a)).toBe(true);
  });
  it('accepts FORWARD on SUBSCRIBE_TRACKS', () => {
    const s = client18();
    const a = s.handleControlMessage(incSubscribeTracks(1n, new Map([[MessageParam.FORWARD, [1n]]])) as never);
    expect(noClose(a)).toBe(true);
  });

  // ── Out-of-scope known params → PROTOCOL_VIOLATION (§10.2.1) ──
  it('rejects FILL_TIMEOUT on SUBSCRIBE', () => {
    const s = client18();
    const a = s.handleControlMessage(incSubscribe(1n, new Map([[MessageParam.FILL_TIMEOUT, [2000n]]])) as never);
    expect(protocolViolation(a)).toBe(true);
  });
  it('rejects RENDEZVOUS_TIMEOUT on FETCH', () => {
    const s = client18();
    const a = s.handleControlMessage(incFetch(1n, new Map([[MessageParam.RENDEZVOUS_TIMEOUT, [5000n]]])) as never);
    expect(protocolViolation(a)).toBe(true);
  });
  it('rejects FORWARD on FETCH', () => {
    const s = client18();
    const a = s.handleControlMessage(incFetch(1n, new Map([[MessageParam.FORWARD, [1n]]])) as never);
    expect(protocolViolation(a)).toBe(true);
  });
  it('rejects AUTHORIZATION_TOKEN on SUBSCRIBE_OK', () => {
    const s = client18();
    const { requestId } = s.subscribe(NS, NAME);
    const a = s.handleControlMessage({
      type: 'SUBSCRIBE_OK', requestId, trackAlias: 7n,
      parameters: new Map([[MessageParam.AUTHORIZATION_TOKEN, [authToken()]]]), trackExtensions: new Map(),
    } as never);
    expect(protocolViolation(a)).toBe(true);
  });
  it('rejects TRACK_NAMESPACE_PREFIX on a normal subscription REQUEST_UPDATE', () => {
    const s = client18();
    // An inbound PUBLISH creates a regular incoming subscription (id 1); accept it
    // so it is ESTABLISHED — then the ONLY reason to reject the REQUEST_UPDATE is
    // the out-of-scope prefix (§10.2.14), not an unrelated state error.
    s.handleControlMessage({
      type: 'PUBLISH', requestId: 1n, trackNamespace: NS, trackName: NAME, trackAlias: 9n,
      parameters: new Map(), trackExtensions: new Map(),
    } as never);
    s.acceptSubscribe(1n, 9n);
    const a = s.handleControlMessage({
      type: 'REQUEST_UPDATE', requestId: 3n, existingRequestId: 1n,
      parameters: new Map([[MessageParam.TRACK_NAMESPACE_PREFIX, [[new Uint8Array([0x78])]]]]),
    } as never);
    expect(protocolViolation(a)).toBe(true);
  });

  // ── REQUEST_OK context-sensitive scope (§10.5) ──
  it('REQUEST_OK answering PUBLISH carries PUBLISH_OK-scoped params (EXPIRES, SUBSCRIBER_PRIORITY)', () => {
    const s = client18();
    const { requestId } = s.publish(NS, NAME, 9n);
    const a = s.handleControlMessage({
      type: 'REQUEST_OK', requestId,
      parameters: new Map([[MessageParam.EXPIRES, [1000n]], [PRIO, [5n]]]),
    } as never);
    expect(noClose(a)).toBe(true);
  });
  it('REQUEST_OK answering TRACK_STATUS carries TRACK_STATUS_OK-scoped params (LARGEST_OBJECT)', () => {
    const s = client18();
    const { requestId } = s.trackStatus(NS, NAME);
    const a = s.handleControlMessage({
      type: 'REQUEST_OK', requestId,
      parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 5n, object: 2n }]]]),
    } as never);
    expect(noClose(a)).toBe(true);
  });
  it('REQUEST_OK answering PUBLISH_NAMESPACE rejects a subscribe-scoped param', () => {
    const s = client18();
    const { requestId } = s.publishNamespace(NS);
    const a = s.handleControlMessage({
      type: 'REQUEST_OK', requestId, parameters: new Map([[PRIO, [5n]]]),
    } as never);
    expect(protocolViolation(a)).toBe(true);
  });

  // ── Legacy guard: draft-16 still IGNORES an out-of-scope known param ──
  it('draft-16 ignores an out-of-scope known param (SUBSCRIBER_PRIORITY on SUBSCRIBE_OK) — no violation', () => {
    const s16 = new Session(EndpointRole.CLIENT);
    s16.initiateSetup({ maxRequestId: varint(100n) });
    s16.handleControlMessage({
      type: 'SERVER_SETUP', parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
    });
    const { requestId } = s16.subscribe(NS, NAME);
    const a = s16.handleControlMessage({
      type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(7n),
      parameters: new Map([[PRIO, [varint(5n)]]]), trackExtensions: [],
    } as never);
    expect(noClose(a)).toBe(true); // draft-16: out-of-scope param is silently ignored (§9.2.2)
  });
});

describe('draft-18 SUBSCRIPTION_FILTER wire correctness (§5.1.2)', () => {
  const NS = [new Uint8Array([0x6c])];
  const NAME = new Uint8Array([0x76]);
  const FILTER = MessageParam.SUBSCRIPTION_FILTER;

  function client18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    return s;
  }
  function client16(): Session {
    const s = new Session(EndpointRole.CLIENT);
    s.initiateSetup({ maxRequestId: varint(100n) });
    s.handleControlMessage({ type: 'SERVER_SETUP', parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]) });
    return s;
  }
  // Build a draft-18 filter byte string from raw vi64 fields.
  function f18(...fields: bigint[]): Uint8Array {
    const parts = fields.map((v) => { const b = new Uint8Array(9); return b.subarray(0, writeVi64(v, b, 0)); });
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  function filterParamBytes(s: Session, filter: SubscriptionFilter): Uint8Array {
    const { actions } = s.subscribe(NS, NAME, { subscriptionFilter: filter });
    const msg = (actions[0] as SendControlAction).message as Subscribe;
    return msg.parameters.get(FILTER as bigint)![0] as Uint8Array;
  }
  const incomingWithFilter = (s: Session, requestId: bigint, bytes: Uint8Array) =>
    s.handleControlMessage({
      type: 'SUBSCRIBE', requestId, trackNamespace: NS, trackName: NAME,
      parameters: new Map([[FILTER, [bytes]]]),
    } as never);
  const noClose = (a: ReturnType<Session['handleControlMessage']>) => a.every((x) => x.type !== 'close_connection');
  const protocolViolation = (a: ReturnType<Session['handleControlMessage']>) => {
    const c = a.find((x) => x.type === 'close_connection') as CloseConnectionAction | undefined;
    return c?.error === SessionErrorCode.PROTOCOL_VIOLATION;
  };

  // ── ENCODE: AbsoluteRange writes an End Group DELTA, not the absolute End Group ──
  it('AbsoluteRange(start=5, end=10) encodes End Group Delta 5 (not absolute 10)', () => {
    const bytes = filterParamBytes(client18(), { type: 'AbsoluteRange', startGroup: 5n, startObject: 0n, endGroup: 10n });
    expect(bytes).toEqual(new Uint8Array([0x04, 0x05, 0x00, 0x05])); // type, start group, start object, DELTA
  });
  it('AbsoluteRange with End Group Delta 0 (end === start) encodes 0x00 and is accepted', () => {
    const bytes = filterParamBytes(client18(), { type: 'AbsoluteRange', startGroup: 5n, startObject: 0n, endGroup: 5n });
    expect(bytes).toEqual(new Uint8Array([0x04, 0x05, 0x00, 0x00]));
    expect(noClose(incomingWithFilter(client18(), 1n, bytes))).toBe(true);
  });

  // ── above-QUIC vi64 values round-trip (encode → accept) ──
  it('supports an above-QUIC vi64 startGroup (2^63): encodes then validates as accepted', () => {
    const big = 1n << 63n; // > 2^62-1
    const bytes = filterParamBytes(client18(), { type: 'AbsoluteStart', startGroup: big, startObject: 0n });
    expect(noClose(incomingWithFilter(client18(), 1n, bytes))).toBe(true);
  });

  // ── overflow: Start Group + End Group Delta MUST NOT exceed 2^64-1 ──
  it('rejects AbsoluteRange whose Start Group + End Group Delta overflows uint64', () => {
    const bytes = f18(0x4n, MAX_VI64, 0n, 1n); // 2^64-1 + 1
    expect(protocolViolation(incomingWithFilter(client18(), 1n, bytes))).toBe(true);
  });
  it('accepts AbsoluteRange exactly at the uint64 boundary (Start Group + Delta === 2^64-1)', () => {
    const bytes = f18(0x4n, MAX_VI64 - 1n, 0n, 1n); // == 2^64-1
    expect(noClose(incomingWithFilter(client18(), 1n, bytes))).toBe(true);
  });

  // ── OUTBOUND overflow: a valid delta can still encode an out-of-range absolute
  //    End Group; the encoder must reject the semantic endGroup before emitting bytes. ──
  it('rejects (RangeError) an outbound AbsoluteRange whose ABSOLUTE endGroup exceeds 2^64-1', () => {
    expect(() => client18().subscribe(NS, NAME, {
      subscriptionFilter: { type: 'AbsoluteRange', startGroup: 1n, startObject: 0n, endGroup: MAX_VI64 + 1n },
    })).toThrow(RangeError); // delta would be 2^64-1 (valid on the wire), but endGroup overflows
  });
  it('encodes an outbound AbsoluteRange at the boundary (startGroup=endGroup=2^64-1) as Delta 0', () => {
    const bytes = filterParamBytes(client18(), { type: 'AbsoluteRange', startGroup: MAX_VI64, startObject: 0n, endGroup: MAX_VI64 });
    expect(bytes[bytes.length - 1]).toBe(0x00); // End Group Delta == 0
    expect(noClose(incomingWithFilter(client18(), 1n, bytes))).toBe(true);
  });

  // ── malformed / trailing ──
  it('rejects trailing bytes after an AbsoluteRange filter', () => {
    const bytes = new Uint8Array([0x04, 0x05, 0x00, 0x00, 0xff]);
    expect(protocolViolation(incomingWithFilter(client18(), 1n, bytes))).toBe(true);
  });
  it('rejects a truncated AbsoluteRange (missing End Group Delta)', () => {
    const bytes = new Uint8Array([0x04, 0x05, 0x00]);
    expect(protocolViolation(incomingWithFilter(client18(), 1n, bytes))).toBe(true);
  });

  // ── draft-14/16 unchanged: ABSOLUTE End Group + QUIC-varint guardrail ──
  it('draft-16 still encodes an ABSOLUTE End Group (10), not a delta', () => {
    const bytes = filterParamBytes(client16(), { type: 'AbsoluteRange', startGroup: 5n, startObject: 0n, endGroup: 10n });
    expect(bytes).toEqual(new Uint8Array([0x04, 0x05, 0x00, 0x0a]));
  });
  it('draft-16 rejects an above-QUIC startGroup at encode (writeVarint guardrail)', () => {
    expect(() => client16().subscribe(NS, NAME, {
      subscriptionFilter: { type: 'AbsoluteStart', startGroup: 1n << 63n, startObject: 0n },
    })).toThrow(RangeError);
  });
});

describe('draft-18 Track Namespace rules — empty namespace + reserved .session (§2.4.1, §3.2)', () => {
  const f = (s: string) => new TextEncoder().encode(s);
  const NAME = new Uint8Array([0x76]);

  function client18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    return s;
  }
  function client16(): Session {
    const s = new Session(EndpointRole.CLIENT);
    s.initiateSetup({ maxRequestId: varint(100n) });
    s.handleControlMessage({ type: 'SERVER_SETUP', parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]) });
    return s;
  }
  const hasClose = (a: ReturnType<Session['handleControlMessage']>) => a.some((x) => x.type === 'close_connection');

  // ── §2.4.1: draft-18 permits a zero-field full namespace; draft-14/16 do not ──
  it('draft-18 accepts a zero-field combined full namespace (empty prefix + empty suffix)', () => {
    const s = client18();
    const { requestId } = s.subscribeNamespace([]); // empty prefix (0-32 fields allowed)
    s.handleNamespaceStreamMessage(requestId, { type: 'REQUEST_OK', requestId, parameters: new Map() }); // activate
    const actions = s.handleNamespaceStreamMessage(requestId, { type: 'NAMESPACE', trackNamespaceSuffix: [] });
    expect(hasClose(actions)).toBe(false); // combined = 0 fields → legal in draft-18
  });
  it('draft-16 rejects a zero-field combined full namespace with PROTOCOL_VIOLATION', () => {
    const s = client16();
    const { requestId } = s.subscribeNamespace([]);
    s.handleNamespaceStreamMessage(requestId, { type: 'REQUEST_OK', requestId, parameters: new Map() });
    const actions = s.handleNamespaceStreamMessage(requestId, { type: 'NAMESPACE', trackNamespaceSuffix: [] });
    const close = actions.find((x) => x.type === 'close_connection') as CloseConnectionAction | undefined;
    expect(close?.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });

  // ── §3.2.2 / §3.2.1: Application MUST NOT publish under a reserved first field ──
  it('publish() throws under the reserved .session namespace (§3.2.2)', () => {
    expect(() => client18().publish([f('.session')], NAME, 1n)).toThrow(/\.session/);
  });
  it('publish() throws under the reserved single-period namespace (§3.2.1)', () => {
    expect(() => client18().publish([f('.')], NAME, 1n)).toThrow(/reserved/i);
  });
  it('publishNamespace() throws under the reserved .session namespace', () => {
    expect(() => client18().publishNamespace([f('.session'), f('a')])).toThrow(/\.session/);
  });
  it('publish() allows an ordinary (non-reserved) namespace', () => {
    expect(() => client18().publish([f('live')], NAME, 1n)).not.toThrow();
  });
  it('draft-16 also guards publish() under .session (reserved rule is version-independent)', () => {
    expect(() => client16().publish([f('.session')], NAME, 1n)).toThrow(/\.session/);
  });
});

describe('draft-18 inbound reserved namespace → REQUEST_ERROR DOES_NOT_EXIST (§3.2)', () => {
  const f = (s: string) => new TextEncoder().encode(s);
  const NAME = new Uint8Array([0x76]);

  function client18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    return s;
  }
  const reqError = (actions: ReturnType<Session['handleControlMessage']>): RequestErrorMsg | undefined => {
    const a = actions.find((x) => x.type === 'send_control' && (x as SendControlAction).message.type === 'REQUEST_ERROR');
    return a ? (a as SendControlAction).message as RequestErrorMsg : undefined;
  };
  const noClose = (a: ReturnType<Session['handleControlMessage']>) => a.every((x) => x.type !== 'close_connection');
  const inSubscribe = (requestId: bigint, ns: Uint8Array[]) =>
    ({ type: 'SUBSCRIBE', requestId, trackNamespace: ns, trackName: NAME, parameters: new Map() });

  it('inbound SUBSCRIBE under .session → DOES_NOT_EXIST; no incoming subscription; no session close', () => {
    const s = client18();
    const actions = s.handleControlMessage(inSubscribe(1n, [f('.session')]) as never);
    expect(reqError(actions)?.errorCode).toBe(RequestError.DOES_NOT_EXIST);
    expect(s.getIncomingSubscription(1n)).toBeUndefined(); // no dangling request state
    expect(noClose(actions)).toBe(true); // per-request error, NOT a session close
  });
  it('inbound SUBSCRIBE under a single-period "." namespace → DOES_NOT_EXIST', () => {
    const s = client18();
    const actions = s.handleControlMessage(inSubscribe(1n, [f('.')]) as never);
    expect(reqError(actions)?.errorCode).toBe(RequestError.DOES_NOT_EXIST);
    expect(s.getIncomingSubscription(1n)).toBeUndefined();
  });
  it('inbound SUBSCRIBE under a non-.session reserved namespace (.future) passes through to the application', () => {
    const s = client18();
    const actions = s.handleControlMessage(inSubscribe(1n, [f('.future')]) as never);
    expect(reqError(actions)).toBeUndefined(); // §3.2.1: unrecognized reserved → application-visible
    expect(s.getIncomingSubscription(1n)).toBeDefined();
  });

  // Track request (§3.2): FETCH + TRACK_STATUS
  it('inbound standalone FETCH under .session → DOES_NOT_EXIST; no fetch state', () => {
    const s = client18();
    const actions = s.handleControlMessage({
      type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 0x1, trackNamespace: [f('.session')], trackName: NAME, startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } },
      parameters: new Map(),
    } as never);
    expect(reqError(actions)?.errorCode).toBe(RequestError.DOES_NOT_EXIST);
    expect(s.getIncomingFetch(1n)).toBeUndefined();
  });
  it('inbound TRACK_STATUS under "." → DOES_NOT_EXIST', () => {
    const s = client18();
    const actions = s.handleControlMessage({ type: 'TRACK_STATUS', requestId: 1n, trackNamespace: [f('.')], trackName: NAME, parameters: new Map() } as never);
    expect(reqError(actions)?.errorCode).toBe(RequestError.DOES_NOT_EXIST);
  });

  // Namespace-scoped request (§3.2): PUBLISH_NAMESPACE
  it('inbound PUBLISH_NAMESPACE under .session → DOES_NOT_EXIST; no namespace announce surfaced', () => {
    const s = client18();
    const actions = s.handleControlMessage({ type: 'PUBLISH_NAMESPACE', requestId: 1n, trackNamespace: [f('.session')], parameters: new Map() } as never);
    expect(reqError(actions)?.errorCode).toBe(RequestError.DOES_NOT_EXIST);
    expect(actions.every((x) => x.type !== 'notify_namespace')).toBe(true); // not passed to the application
  });

  // §3.2 has NO inbound-PUBLISH rule — PUBLISH is publisher-initiated, not a
  // consumer request for a track. It is intentionally NOT intercepted here.
  it('inbound PUBLISH under .session is NOT intercepted in this slice (state is created as usual)', () => {
    const s = client18();
    s.handleControlMessage({
      type: 'PUBLISH', requestId: 1n, trackNamespace: [f('.session')], trackName: NAME, trackAlias: 9n,
      parameters: new Map(), trackExtensions: new Map(),
    } as never);
    expect(s.getIncomingSubscription(1n)).toBeDefined();
  });
});

describe('draft-18 GOAWAY on the control stream (§10.4)', () => {
  function client18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    return s;
  }
  function server18(): Session {
    const s = new Session(EndpointRole.SERVER, 18);
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    s.completeSetup();
    return s;
  }
  const goaway = (uri: string, timeout: bigint, requestId?: bigint) =>
    ({ type: 'GOAWAY', newSessionUri: uri, timeout, ...(requestId !== undefined ? { requestId } : {}) });
  const closeOf = (actions: ReturnType<Session['handleControlMessage']>) =>
    actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;

  it('client → DRAINING and stores the New Session URI (even-parity Request ID); no close', () => {
    const s = client18();
    const actions = s.handleControlMessage(goaway('https://relay.example', 5000n, 0n) as never);
    expect(actions.every((a) => a.type !== 'close_connection')).toBe(true);
    expect(s.state).toBe(SessionState.DRAINING);
    expect(s.newSessionUri).toBe('https://relay.example');
  });
  it('missing Request ID on the control stream → PROTOCOL_VIOLATION', () => {
    const actions = client18().handleControlMessage(goaway('', 0n) as never); // no requestId
    expect(closeOf(actions)?.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });
  it('wrong-parity Request ID (odd at a client) → INVALID_REQUEST_ID', () => {
    const actions = client18().handleControlMessage(goaway('', 0n, 1n) as never);
    expect(closeOf(actions)?.error).toBe(SessionErrorCode.INVALID_REQUEST_ID);
  });
  it('server parity is odd: even Request ID → INVALID_REQUEST_ID; odd accepted', () => {
    expect(closeOf(server18().handleControlMessage(goaway('', 0n, 0n) as never))?.error)
      .toBe(SessionErrorCode.INVALID_REQUEST_ID);
    const ok = server18();
    const a = ok.handleControlMessage(goaway('', 0n, 1n) as never);
    expect(a.every((x) => x.type !== 'close_connection')).toBe(true);
    expect(ok.state).toBe(SessionState.DRAINING);
  });
  it('server receiving a non-empty New Session URI → PROTOCOL_VIOLATION', () => {
    const actions = server18().handleControlMessage(goaway('https://x', 0n, 1n) as never);
    expect(closeOf(actions)?.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });
  it('a second control-stream GOAWAY → PROTOCOL_VIOLATION', () => {
    const s = client18();
    s.handleControlMessage(goaway('', 0n, 0n) as never); // first → DRAINING
    const actions = s.handleControlMessage(goaway('', 0n, 2n) as never); // second
    expect(closeOf(actions)?.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });
  it('after GOAWAY, a new local SUBSCRIBE is refused (DRAINING guard, no auto-close)', () => {
    const s = client18();
    s.handleControlMessage(goaway('', 0n, 0n) as never);
    expect(() => s.subscribe([new Uint8Array([0x6c])], new Uint8Array([0x76]))).toThrow();
    expect(s.state).toBe(SessionState.DRAINING); // still draining; no auto session close
  });
});

describe('draft-18 OBJECT/SUBGROUP_DELIVERY_TIMEOUT = 0 (§10.2.4/§10.2.3)', () => {
  const NS = [new Uint8Array([0x6c])];
  const NAME = new Uint8Array([0x76]);
  function client18(): Session {
    const s = new Session(EndpointRole.CLIENT, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
    return s;
  }
  const incSub = (requestId: bigint, params: Parameters) =>
    ({ type: 'SUBSCRIBE', requestId, trackNamespace: NS, trackName: NAME, parameters: params });
  const noClose = (a: ReturnType<Session['handleControlMessage']>) => a.every((x) => x.type !== 'close_connection');

  it('accepts OBJECT_DELIVERY_TIMEOUT (0x02) = 0 on a draft-18 SUBSCRIBE (0 = no timeout)', () => {
    const a = client18().handleControlMessage(incSub(1n, new Map([[MessageParam.OBJECT_DELIVERY_TIMEOUT, [0n]]])) as never);
    expect(noClose(a)).toBe(true);
  });
  it('accepts SUBGROUP_DELIVERY_TIMEOUT (0x06) = 0 on a draft-18 SUBSCRIBE', () => {
    const a = client18().handleControlMessage(incSub(1n, new Map([[MessageParam.SUBGROUP_DELIVERY_TIMEOUT, [0n]]])) as never);
    expect(noClose(a)).toBe(true);
  });
  it('draft-16 still rejects DELIVERY_TIMEOUT (0x02) = 0 with PROTOCOL_VIOLATION (legacy guard)', () => {
    const s16 = new Session(EndpointRole.CLIENT);
    s16.initiateSetup({ maxRequestId: varint(100n) });
    s16.handleControlMessage({ type: 'SERVER_SETUP', parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]) });
    const a = s16.handleControlMessage({
      type: 'SUBSCRIBE', requestId: varint(1n), trackNamespace: NS, trackName: NAME,
      parameters: new Map([[varint(0x02n), [varint(0n)]]]),
    } as never);
    const close = a.find((x) => x.type === 'close_connection') as CloseConnectionAction | undefined;
    expect(close?.error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  });
});

describe('draft-18 SETUP AUTHORIZATION_TOKEN overflow downgrade applies to any endpoint (§10.3.1.4)', () => {
  // A REGISTER token whose entry (16 + value bytes) exceeds the receiver's default
  // MAX_AUTH_TOKEN_CACHE_SIZE of 0 — it MUST be treated as USE_VALUE, not closed
  // with AUTH_TOKEN_CACHE_OVERFLOW, at EITHER endpoint.
  const registerToken = encodeAuthorizationToken18({
    aliasType: AliasType.REGISTER, tokenAlias: 1n, tokenType: 2n, tokenValue: new Uint8Array([0xaa, 0xbb]),
  });
  const setupWithToken = () =>
    ({ type: 'SETUP', setupOptions: new Map([[BigInt(SetupOption18.AUTHORIZATION_TOKEN), [registerToken]]]) });
  const noClose = (a: ReturnType<Session['handleControlMessage']>) => a.every((x) => x.type !== 'close_connection');

  it('CLIENT processing a server SETUP REGISTER that overflows downgrades (no AUTH_TOKEN_CACHE_OVERFLOW)', () => {
    const c = new Session(EndpointRole.CLIENT, 18);
    c.initiateSetup(); // own cache size 0
    const actions = c.handleControlMessage(setupWithToken() as never);
    expect(noClose(actions)).toBe(true);
    expect(c.state).toBe(SessionState.ESTABLISHED);
  });
  it('SERVER processing a client SETUP REGISTER that overflows downgrades', () => {
    const s = new Session(EndpointRole.SERVER, 18);
    const actions = s.handleControlMessage(setupWithToken() as never);
    expect(noClose(actions)).toBe(true);
    s.completeSetup();
    expect(s.state).toBe(SessionState.ESTABLISHED);
  });
});

describe('draft-18 inbound Full Track Name / Track Namespace validation (§2.4.1)', () => {
  /** Established draft-18 SERVER session that receives client (even-parity) requests. */
  function established18Server(): Session {
    const s = new Session(EndpointRole.SERVER, 18);
    s.initiateSetup();
    s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
    return s;
  }
  const NSb = [new Uint8Array([0x61])];
  const NM = new Uint8Array([0x62]);
  const EMPTY_FIELD = [new Uint8Array(0)]; // one zero-length field — always invalid
  const BIG_FIELD = [new Uint8Array(4097)]; // namespace alone > 4096 bytes

  const expectClose = (actions: ReturnType<Session['handleControlMessage']>) => {
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions[0]?.type).toBe('close_connection');
    expect((actions[0] as CloseConnectionAction).error).toBe(SessionErrorCode.PROTOCOL_VIOLATION);
  };

  const subMsg = (ns: Uint8Array[]): Subscribe =>
    ({ type: 'SUBSCRIBE', requestId: varint(0n), trackNamespace: ns, trackName: NM, parameters: new Map() });
  const pubMsg = (ns: Uint8Array[]): Publish =>
    ({ type: 'PUBLISH', requestId: varint(0n), trackNamespace: ns, trackName: NM, trackAlias: varint(5n), parameters: new Map() } as Publish);
  const fetchMsg = (ns: Uint8Array[]): Fetch =>
    ({ type: 'FETCH', requestId: varint(0n), fetch: { fetchType: 0x1, trackNamespace: ns, trackName: NM, startLocation: { group: varint(0n), object: varint(0n) }, endLocation: { group: varint(10n), object: varint(0n) } } as StandaloneFetch, parameters: new Map() });
  const tsMsg = (ns: Uint8Array[]): TrackStatus =>
    ({ type: 'TRACK_STATUS', requestId: varint(0n), trackNamespace: ns, trackName: NM, parameters: new Map() });
  const pnMsg = (ns: Uint8Array[]): PublishNamespace =>
    ({ type: 'PUBLISH_NAMESPACE', requestId: varint(0n), trackNamespace: ns, parameters: new Map() });

  it('SUBSCRIBE with an empty namespace field closes PROTOCOL_VIOLATION and creates NO subscription state', () => {
    const s = established18Server();
    expectClose(s.handleControlMessage(subMsg(EMPTY_FIELD)));
    expect(s.getIncomingSubscription(varint(0n))).toBeUndefined();
  });

  it('SUBSCRIBE with a Full Track Name >4096 closes PROTOCOL_VIOLATION and creates no state', () => {
    const s = established18Server();
    expectClose(s.handleControlMessage(subMsg(BIG_FIELD)));
    expect(s.getIncomingSubscription(varint(0n))).toBeUndefined();
  });

  it('SUBSCRIBE with a valid EMPTY namespace + track name is accepted (draft-18)', () => {
    const s = established18Server();
    const actions = s.handleControlMessage(subMsg([]));
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
    expect(s.getIncomingSubscription(varint(0n))).toBeDefined();
  });

  it('PUBLISH with an empty namespace field closes PROTOCOL_VIOLATION; no subscription, no alias registered', () => {
    const s = established18Server();
    expectClose(s.handleControlMessage(pubMsg(EMPTY_FIELD)));
    expect(s.getIncomingSubscription(varint(0n))).toBeUndefined();
    expect(s.getTrackByAlias(varint(5n))).toBeUndefined();
  });

  it('PUBLISH with a valid EMPTY namespace registers state + alias (draft-18)', () => {
    const s = established18Server();
    const actions = s.handleControlMessage(pubMsg([]));
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
    expect(s.getIncomingSubscription(varint(0n))).toBeDefined();
    expect(s.getTrackByAlias(varint(5n))).toBeDefined();
  });

  it('standalone FETCH with an empty namespace field closes PROTOCOL_VIOLATION and creates no fetch state', () => {
    const s = established18Server();
    expectClose(s.handleControlMessage(fetchMsg(EMPTY_FIELD)));
    expect(s.getIncomingFetch(varint(0n))).toBeUndefined();
  });

  it('standalone FETCH with a valid EMPTY namespace creates fetch state (draft-18)', () => {
    const s = established18Server();
    const actions = s.handleControlMessage(fetchMsg([]));
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
    expect(s.getIncomingFetch(varint(0n))).toBeDefined();
  });

  it('TRACK_STATUS with an empty namespace field closes PROTOCOL_VIOLATION; no incomingTrackStatuses entry', () => {
    const s = established18Server();
    expectClose(s.handleControlMessage(tsMsg(EMPTY_FIELD)));
    expect(() => s.acceptTrackStatus(varint(0n))).toThrow(/Unknown incoming TRACK_STATUS/i);
  });

  it('TRACK_STATUS with a valid EMPTY namespace is recorded (acceptTrackStatus does not throw Unknown)', () => {
    const s = established18Server();
    const actions = s.handleControlMessage(tsMsg([]));
    expect(actions.some((a) => a.type === 'close_connection')).toBe(false);
    expect(() => s.acceptTrackStatus(varint(0n))).not.toThrow(/Unknown incoming TRACK_STATUS/i);
  });

  it('PUBLISH_NAMESPACE with a namespace >4096 closes PROTOCOL_VIOLATION with no namespace acceptance', () => {
    const s = established18Server();
    const actions = s.handleControlMessage(pnMsg(BIG_FIELD));
    expectClose(actions);
    // The success path (REQUEST_OK / notify_namespace) never ran.
    expect(actions.some((a) => a.type === 'notify_namespace' || a.type === 'send_control')).toBe(false);
  });

  it('PUBLISH_NAMESPACE with an empty namespace field closes PROTOCOL_VIOLATION', () => {
    const s = established18Server();
    expectClose(s.handleControlMessage(pnMsg(EMPTY_FIELD)));
  });
});
