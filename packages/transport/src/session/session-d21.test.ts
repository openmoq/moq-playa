/**
 * Session rules for draft 21: the draft-18 stream model with draft-21 parameter
 * scopes, FILL_PARAMETERS on SUBSCRIBE, GOAWAY without a Request ID and
 * PUBLISH_STATE_NOTIFY.
 */
import { describe, it, expect } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, SessionState, type SendControlAction, type CloseConnectionAction } from './types.js';
import { varint } from '../primitives/varint.js';
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
