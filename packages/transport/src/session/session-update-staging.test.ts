/**
 * Accepted subscription state under REQUEST_UPDATE (draft-16 §9.11, draft-18 §10.9, draft-22): priority, filter and
 * Forward requested by an update are STAGED until the matching REQUEST_OK applies them; a REQUEST_ERROR or a send
 * rollback leaves the accepted state untouched; an omitted field stays unchanged; interleaved FIFO updates commit only
 * their own fields; PUBLISH-initiated subscriptions follow the same rule on the request-stream drafts. Draft 14 has no
 * acknowledgement and applies inline (control). These are locally confirmed fields, not a remote scheduling/data-cutoff witness.
 * Refusal checks leave field values intact; protocol-required terminal handling remains a separate responsibility.
 */
import { describe, expect, it } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, ForwardState } from './types.js';
import type { SubscriptionStateMachine } from './subscription.js';
import { varint } from '../primitives/varint.js';
import { SetupParam, MessageParam } from '../control/parameters.js';
import { encodeSubscriptionFilter, type SubscriptionFilter } from '../control/subscription-filter.js';
import type { Setup, ClientSetup, ServerSetup, SubscribeOk, Publish, RequestOk, RequestErrorMsg } from '../control/messages.js';

const NS = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])], NAME = new Uint8Array([0x76, 0x69, 0x64]);
type Draft = 14 | 16 | 18 | 22;
const request = (draft: Draft) => draft >= 18;
function clientSession(draft: Draft): Session {
  const session = new Session(EndpointRole.CLIENT, draft);
  session.initiateSetup({ maxRequestId: varint(100n) });
  if (request(draft)) session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } satisfies Setup);
  else session.handleControlMessage({ type: 'SERVER_SETUP', parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]) } satisfies ServerSetup);
  return session;
}
function serverSession(draft: Draft): Session {
  const session = new Session(EndpointRole.SERVER, draft);
  if (request(draft)) session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } satisfies Setup);
  else session.handleControlMessage({ type: 'CLIENT_SETUP', parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]) } satisfies ClientSetup);
  session.completeSetup({ maxRequestId: varint(100n) });
  return session;
}
const NGS: SubscriptionFilter = { type: 'NextGroupStart' };
const ABS: SubscriptionFilter = { type: 'AbsoluteStart', startGroup: 3n, startObject: 0n };
const bytes = (f: SubscriptionFilter, draft: Draft) => encodeSubscriptionFilter(f, draft);
/** Outbound subscription with known accepted priority 5, filter NextGroupStart, Forward ACTIVE. */
function outbound(draft: Draft) {
  const session = clientSession(draft);
  const { requestId } = session.subscribe(NS, NAME, { subscriberPriority: varint(5n), subscriptionFilter: NGS });
  session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(42n), parameters: new Map(), trackExtensions: new Map() } satisfies SubscribeOk);
  const sub = session.getSubscription(requestId)!;
  expect(sub.state).toBe('established');
  return { session, requestId, sub, accepted: snapshot(sub) };
}
function snapshot(sub: Pick<SubscriptionStateMachine, 'currentPriority' | 'currentFilter' | 'forwardState' | 'locationWindow'>) {
  return { priority: sub.currentPriority, filter: sub.currentFilter ? Buffer.from(sub.currentFilter).toString('hex') : undefined,
    forward: sub.forwardState, window: JSON.stringify(sub.locationWindow, (_k, v) => typeof v === 'bigint' ? String(v) : v) };
}
// Update acknowledgements are REQUEST_OK messages on every request-stream draft (draft 22 only names the parameter scope REQUEST_UPDATE_OK).
const ok = (_draft: Draft, requestId: bigint): RequestOk => ({ type: 'REQUEST_OK', requestId, parameters: new Map() });
const error = (requestId: bigint): RequestErrorMsg => ({ type: 'REQUEST_ERROR', requestId, errorCode: varint(0x1n), retryInterval: varint(0n), errorReason: 'refused' });

describe.each([16, 18, 22] as const)('draft-%i: outbound subscription update staging', draft => {
  it('priority, filter and Forward requested by an update are not accepted state until the matching REQUEST_OK', () => {
    const { session, requestId, sub, accepted } = outbound(draft);
    session.requestUpdate(requestId, { subscriberPriority: varint(9n), subscriptionFilter: ABS, forward: ForwardState.PAUSED });
    expect(snapshot(sub), 'nothing applied at send').toEqual(accepted);
  });
  it('a REQUEST_ERROR leaves the accepted state exactly as it was', () => {
    const { session, requestId, sub, accepted } = outbound(draft);
    const { requestId: updateId } = session.requestUpdate(requestId, { subscriberPriority: varint(9n), subscriptionFilter: ABS, forward: ForwardState.PAUSED });
    session.handleControlMessage(error(updateId));
    expect(snapshot(sub)).toEqual(accepted);
  });
  it('a send failure rolled back with rollbackRequestUpdate leaves the accepted state exactly as it was', () => {
    const { session, requestId, sub, accepted } = outbound(draft);
    const { requestId: updateId } = session.requestUpdate(requestId, { subscriberPriority: varint(9n), subscriptionFilter: ABS, forward: ForwardState.PAUSED });
    session.rollbackRequestUpdate(updateId as bigint);
    expect(snapshot(sub)).toEqual(accepted);
    // A late acknowledgement for the rolled-back update must not resurrect it either.
    session.handleControlMessage(ok(draft, updateId));
    expect(snapshot(sub)).toEqual(accepted);
  });
  it('the matching REQUEST_OK commits exactly the requested fields; an omitted field stays unchanged', () => {
    const { session, requestId, sub, accepted } = outbound(draft);
    const { requestId: updateId } = session.requestUpdate(requestId, { subscriberPriority: varint(9n), subscriptionFilter: ABS });
    session.handleControlMessage(ok(draft, updateId));
    const after = snapshot(sub);
    expect(after.priority).toBe(9n);
    expect(after.filter).toBe(Buffer.from(bytes(ABS, draft)).toString('hex'));
    expect(after.forward, 'omitted Forward unchanged').toBe(accepted.forward);
    const { requestId: pauseId } = session.requestUpdate(requestId, { forward: ForwardState.PAUSED });
    session.handleControlMessage(ok(draft, pauseId));
    expect(snapshot(sub)).toEqual({ ...after, forward: ForwardState.PAUSED });
  });
  it('interleaved FIFO updates: an accepted priority update and a refused filter update commit only the accepted one', () => {
    const { session, requestId, sub, accepted } = outbound(draft);
    const { requestId: first } = session.requestUpdate(requestId, { subscriberPriority: varint(9n) });
    const { requestId: second } = session.requestUpdate(requestId, { subscriptionFilter: ABS });
    expect(snapshot(sub)).toEqual(accepted);
    session.handleControlMessage(ok(draft, first));
    expect(snapshot(sub)).toEqual({ ...accepted, priority: 9n });
    session.handleControlMessage(error(second));
    expect(snapshot(sub)).toEqual({ ...accepted, priority: 9n });
  });
});

describe.each([16, 18, 22] as const)('draft-%i: PUBLISH-initiated subscription update staging (subscriber side)', draft => {
  function inbound() {
    const session = serverSession(draft);
    // draft 16 carries Group Order/Forward as PUBLISH parameters; drafts 18/22 carry track properties instead.
    const publish: Publish = draft === 16
      ? { type: 'PUBLISH', requestId: varint(2n), trackNamespace: NS, trackName: NAME, trackAlias: varint(42n),
        parameters: new Map([[varint(MessageParam.GROUP_ORDER), [varint(1n)]], [varint(MessageParam.FORWARD), [varint(1n)]]]), trackExtensions: new Map() }
      : { type: 'PUBLISH', requestId: varint(2n), trackNamespace: NS, trackName: NAME, trackAlias: varint(42n), parameters: new Map(), trackProperties: new Map() };
    const actions = session.handleControlMessage(publish);
    expect(actions.some(action => action.type === 'close_connection')).toBe(false);
    session.acceptSubscribe(varint(2n), varint(42n));
    const sub = session.getIncomingSubscription(2n)!;
    expect(sub.state).toBe('established');
    return { session, sub, accepted: snapshot(sub) };
  }
  it('a requested filter is staged, then committed on REQUEST_OK', () => {
    const { session, sub, accepted } = inbound();
    const { requestId } = session.updateIncomingSubscription(2n, { subscriptionFilter: ABS });
    expect(snapshot(sub), 'nothing applied at send').toEqual(accepted);
    session.handleControlMessage(ok(draft, requestId));
    expect(snapshot(sub).filter, 'filter committed on acknowledgement').toBe(Buffer.from(bytes(ABS, draft)).toString('hex'));
  });
  it('a requested priority is staged, then committed on REQUEST_OK', () => {
    const { session, sub, accepted } = inbound();
    const { requestId } = session.updateIncomingSubscription(2n, { subscriberPriority: varint(9n) });
    expect(snapshot(sub), 'nothing applied at send').toEqual(accepted);
    session.handleControlMessage(ok(draft, requestId));
    expect(snapshot(sub).priority, 'priority committed on acknowledgement').toBe(9n);
  });
  it('a REQUEST_ERROR leaves the accepted state exactly as it was', () => {
    const { session, sub, accepted } = inbound();
    const { requestId } = session.updateIncomingSubscription(2n, { subscriberPriority: varint(9n), subscriptionFilter: ABS, forward: ForwardState.PAUSED });
    session.handleControlMessage(error(requestId));
    expect(snapshot(sub)).toEqual(accepted);
  });
});

describe('draft-14 control: SUBSCRIBE_UPDATE has no acknowledgement and applies inline', () => {
  it('Forward and filter take effect at send', () => {
    const { session, requestId, sub } = outbound(14);
    const absolute: SubscriptionFilter = { type: 'AbsoluteStart', startGroup: 3n, startObject: 0n };
    session.requestUpdate(requestId, { subscriberPriority: varint(9n), subscriptionFilter: absolute, forward: ForwardState.PAUSED });
    const after = snapshot(sub);
    expect(after.forward).toBe(ForwardState.PAUSED);
    expect(after.priority).toBe(9n);
    expect(after.filter).toBe(Buffer.from(bytes(absolute, 14)).toString('hex'));
  });
});
