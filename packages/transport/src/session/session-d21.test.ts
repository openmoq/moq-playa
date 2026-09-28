/**
 * Session rules for draft 21: the draft-18 stream model with draft-21 parameter
 * scopes, FILL_PARAMETERS on SUBSCRIBE, GOAWAY without a Request ID and
 * PUBLISH_STATE_NOTIFY.
 */
import { describe, it, expect } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, SessionState, type SendControlAction, type CloseConnectionAction } from './types.js';
import { varint } from '../primitives/varint.js';
import { SessionError as SessionErrorCode } from '../errors.js';
import { bytesToHex } from '../vectors/load-vectors.js';
import type { ControlMessage, Goaway, PublishStateNotify, Setup, Subscribe, SubscribeOk } from '../control/messages.js';

const NS = [new TextEncoder().encode('live')];
const NAME = new TextEncoder().encode('catalog');
const FILL_PARAMETERS = 0x23n;

function established(version: 18 | 21): Session {
  const session = new Session(EndpointRole.CLIENT, version);
  session.initiateSetup();
  session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
  expect(session.state).toBe(SessionState.ESTABLISHED);
  return session;
}

function closeOf(actions: ReturnType<Session['handleControlMessage']>): CloseConnectionAction | undefined {
  return actions.find((a) => a.type === 'close_connection') as CloseConnectionAction | undefined;
}

function subscribed(session: Session): bigint {
  const { requestId } = session.subscribe(NS, NAME);
  session.handleControlMessage({
    type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(4n), parameters: new Map(), trackExtensions: [],
  } as SubscribeOk);
  return requestId;
}

describe('draft-21 SUBSCRIBE with a fill', () => {
  it('sends FILL_PARAMETERS with the fill Location filter and marks the subscription', () => {
    const session = established(21);
    const { requestId, actions } = session.subscribe(NS, NAME, {
      subscriptionFilter: { type: 'LargestObject' },
      fill: { filter: { type: 'RelativeStart', groups: 1n } },
    });
    const msg = (actions[0] as SendControlAction).message as Subscribe;
    expect(bytesToHex(msg.parameters.get(FILL_PARAMETERS)![0] as Uint8Array)).toBe('210101');
    expect(bytesToHex(msg.parameters.get(0x21n)![0] as Uint8Array)).toBe('0000');
    expect(session.getSubscription(requestId)!.fillRequested).toBe(true);
  });

  it('is refused before draft 21', () => {
    const session = established(18);
    expect(() => session.subscribe(NS, NAME, { fill: {} })).toThrow(/draft 21/);
  });
});

describe('draft-21 GOAWAY', () => {
  it('needs no Request ID', () => {
    const session = established(21);
    const actions = session.handleControlMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 5000n } as Goaway);
    expect(closeOf(actions)).toBeUndefined();
    expect(session.state).toBe(SessionState.DRAINING);
  });

  it('draft 18 still requires one', () => {
    const session = established(18);
    const actions = session.handleControlMessage({ type: 'GOAWAY', newSessionUri: '', timeout: 5000n } as Goaway);
    expect(closeOf(actions)?.reason).toMatch(/missing the Request ID/);
  });
});

describe('draft-21 PUBLISH_STATE_NOTIFY', () => {
  it('advances the subscription Largest Location', () => {
    const session = established(21);
    const requestId = subscribed(session);
    const notify: PublishStateNotify = {
      type: 'PUBLISH_STATE_NOTIFY', requestId,
      parameters: new Map([[0x09n, [{ group: 3n, object: 7n }]], [0x10n, [0n]]]),
    };
    const actions = session.handleControlMessage(notify as ControlMessage);
    expect(closeOf(actions)).toBeUndefined();
    expect(session.getSubscription(requestId)!.largestLocation).toEqual({ groupId: 3n, objectId: 7n });
  });

  it('a parameter out of its scope is a PROTOCOL_VIOLATION', () => {
    const session = established(21);
    const requestId = subscribed(session);
    const notify: PublishStateNotify = {
      type: 'PUBLISH_STATE_NOTIFY', requestId, parameters: new Map([[0x08n, [10n]]]), // EXPIRES
    };
    expect(closeOf(session.handleControlMessage(notify as ControlMessage))?.reason).toMatch(/out of scope/);
  });

  it('one that crosses our cancellation is ignored', () => {
    const session = established(21);
    const notify: PublishStateNotify = { type: 'PUBLISH_STATE_NOTIFY', requestId: 99n, parameters: new Map() };
    expect(session.handleControlMessage(notify as ControlMessage)).toEqual([]);
  });
});

describe('draft-21 parameter scopes', () => {
  it('SUBSCRIBE_OK may carry EXPIRES and LARGEST_OBJECT', () => {
    const session = established(21);
    const { requestId } = session.subscribe(NS, NAME);
    const actions = session.handleControlMessage({
      type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(4n),
      parameters: new Map([[0x08n, [0n]], [0x09n, [{ group: 1n, object: 2n }]]]),
      trackExtensions: [],
    } as SubscribeOk);
    expect(closeOf(actions)).toBeUndefined();
  });
});

const MAX_REQUEST_UPDATES = 0x08n;
const TOO_MANY_REQUEST_UPDATES = 0x1bn;

function establishedWithPeerOptions(version: 18 | 21, setupOptions: Map<bigint, unknown[]>): Session {
  const session = new Session(EndpointRole.CLIENT, version);
  session.initiateSetup();
  session.handleControlMessage({ type: 'SETUP', setupOptions } as unknown as Setup);
  expect(session.state).toBe(SessionState.ESTABLISHED);
  return session;
}

describe('draft-21 MAX_REQUEST_UPDATES (§9.1.7)', () => {
  it('advertises our limit on draft 21 only', () => {
    const s21 = new Session(EndpointRole.CLIENT, 21);
    const setup21 = (s21.initiateSetup({ maxRequestUpdates: 2n })[0] as SendControlAction).message as Setup;
    expect(setup21.setupOptions.get(MAX_REQUEST_UPDATES)).toEqual([2n]);
    const s18 = new Session(EndpointRole.CLIENT, 18);
    const setup18 = (s18.initiateSetup({ maxRequestUpdates: 2n })[0] as SendControlAction).message as Setup;
    expect(setup18.setupOptions.has(MAX_REQUEST_UPDATES)).toBe(false);
  });

  it('never exceeds the peer limit of outstanding updates on one request', () => {
    const session = establishedWithPeerOptions(21, new Map([[MAX_REQUEST_UPDATES, [1n]]]));
    const requestId = subscribed(session);
    const first = session.requestUpdate(requestId, { forward: 0 });
    expect(() => session.requestUpdate(requestId, { forward: 1 })).toThrow(/MAX_REQUEST_UPDATES/);
    // The response restores the credit.
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: first.requestId, parameters: new Map() } as unknown as ControlMessage);
    expect(() => session.requestUpdate(requestId, { forward: 1 })).not.toThrow();
  });

  it('a limit of 0, or none, does not limit', () => {
    const session = establishedWithPeerOptions(21, new Map());
    const requestId = subscribed(session);
    for (let i = 0; i < 5; i++) session.requestUpdate(requestId, { forward: 0 });
  });

  it('reports our advertised limit so the receiver can enforce it', () => {
    const session = new Session(EndpointRole.CLIENT, 21);
    session.initiateSetup({ maxRequestUpdates: 3n });
    expect(session.ownMaxRequestUpdates).toBe(3n);
    expect(SessionErrorCode.TOO_MANY_REQUEST_UPDATES).toBe(TOO_MANY_REQUEST_UPDATES);
  });
});

describe('draft-21 fill on REQUEST_UPDATE (§3.4)', () => {
  it('carries FILL_PARAMETERS and expects a fill stream under the update Request ID', () => {
    const session = established(21);
    const requestId = subscribed(session);
    const { requestId: updateId, actions } = session.requestUpdate(requestId, {
      fill: { filter: { type: 'AbsoluteRange', startGroup: 0n, startObject: 0n, endGroup: 1n } },
    });
    const msg = (actions[0] as SendControlAction).message as ControlMessage & { parameters: Map<bigint, unknown[]> };
    expect(msg.parameters.has(FILL_PARAMETERS)).toBe(true);
    expect(session.fillSubscriptionFor(updateId)?.requestId).toBe(requestId);
    expect(session.takeFill(updateId)?.requestId).toBe(requestId);
    expect(session.fillSubscriptionFor(updateId)).toBeUndefined();
  });

  it('a refused update opens no fill', () => {
    const session = established(21);
    const requestId = subscribed(session);
    const { requestId: updateId } = session.requestUpdate(requestId, { fill: {} });
    session.handleControlMessage({
      type: 'REQUEST_ERROR', requestId: updateId, errorCode: 0x0n, errorReason: 'no', retryInterval: 0n,
    } as unknown as ControlMessage);
    expect(session.fillSubscriptionFor(updateId)).toBeUndefined();
  });

  it('is refused before draft 21', () => {
    const session = established(18);
    const requestId = subscribed(session);
    expect(() => session.requestUpdate(requestId, { fill: {} })).toThrow(/draft 21/);
  });

  it('the SUBSCRIBE fill is tracked the same way', () => {
    const session = established(21);
    const { requestId } = session.subscribe(NS, NAME, { fill: {} });
    expect(session.fillSubscriptionFor(requestId)?.requestId).toBe(requestId);
    expect(session.cancelFillRequest(requestId)).toBe(true);
    expect(session.getSubscription(requestId)!.fillRequested).toBe(false);
    expect(session.cancelFillRequest(requestId)).toBe(false);
  });
});
