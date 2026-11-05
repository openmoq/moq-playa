import { expect, it } from 'vitest';
import { Session } from './session.js';
import { varint } from '../primitives/varint.js';
import { EndpointRole, SubscriptionState } from './types.js';
import type { ControlMessage } from '../control/messages.js';
const namespace = [Uint8Array.of(0x4e)], name = Uint8Array.of(0x76);
for (const draft of [18, 22] as const) for (const response of ['fetch', 'subscribe'] as const) it(`draft${draft} malformed cancellation shadow admits exactly one crossed ${response} OK`, () => {
  const session = new Session(EndpointRole.CLIENT, draft);
  session.initiateSetup({ maxRequestId: varint(100n) });
  session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
  const sub = session.subscribe(namespace, name).requestId;
  const fetch = session.fetch(namespace.map(x => x.slice()), name.slice(), { startGroup: 0n, startObject: 0n, endGroup: 9n, endObject: 0n }).requestId;
  const actions = session.handleMalformedTrack(fetch);
  expect(actions.filter(action => action.type === 'cancel_request')).toHaveLength(2);
  const message: ControlMessage = response === 'fetch'
    ? { type: 'FETCH_OK', requestId: fetch, endOfTrack: 0, endLocation: { group: 9n, object: 0n }, parameters: new Map() }
    : { type: 'SUBSCRIBE_OK', requestId: sub, trackAlias: 16n, parameters: new Map() };
  expect(session.handleControlMessage(message).filter(action => action.type === 'close_connection')).toEqual([]);
  expect(session.getSubscription(sub)?.state).toBe(SubscriptionState.TERMINATED);
  expect(session.getFetch(fetch)?.isCompleted).toBe(true);
  expect(session.handleControlMessage(message)).toEqual([expect.objectContaining({ type: 'close_connection', error: 3n })]);
});

for (const draft of [18, 22] as const) it(`draft${draft} Track Status error stays ordinary while malformed response cancels resolved owners`, () => {
  const session = new Session(EndpointRole.CLIENT, draft);
  session.initiateSetup({ maxRequestId: varint(100n) }); session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
  const sub = session.subscribe(namespace, name).requestId;
  const failed = session.trackStatus(namespace, name).requestId;
  expect(session.handleControlMessage({ type: 'REQUEST_ERROR', requestId: failed, errorCode: 0x10n, errorReason: 'unavailable', retryInterval: 0n })).toEqual([]);
  expect(session.getPendingTrackStatus(failed)).toBeUndefined(); expect(session.getSubscription(sub)?.isPending).toBe(true);
  const accepted = session.trackStatus(namespace, name).requestId;
  expect(session.handleControlMessage({ type: 'REQUEST_OK', requestId: accepted, parameters: new Map() })).toEqual([]);
  expect(session.getPendingTrackStatus(accepted)).toBeUndefined(); expect(session.getSubscription(sub)?.isPending).toBe(true);
  const malformed = session.trackStatus(namespace.map(x => x.slice()), name.slice()).requestId;
  const actions = session.handleControlMessage({ type: 'REQUEST_OK', requestId: malformed, parameters: new Map(), trackProperties: new Map([[0x3en, [1n]]]) });
  expect(actions.filter(action => action.type === 'cancel_request').map(action => action.requestId).sort()).toEqual([sub, malformed].sort());
  expect(session.getSubscription(sub)?.isTerminated).toBe(true); expect(session.getPendingTrackStatus(malformed)).toBeUndefined();
});

for (const draft of [18, 22] as const) it(`draft${draft} local malformed Track Status releases its own identity and cancels once`, () => {
  const session = new Session(EndpointRole.CLIENT, draft);
  session.initiateSetup({ maxRequestId: varint(100n) }); session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
  const sub = session.subscribe(namespace, name).requestId;
  const status = session.trackStatus(namespace.map(bytes => bytes.slice()), name.slice()).requestId;
  const actions = session.handleMalformedTrack(status);
  expect(session.getSubscription(sub)?.isTerminated).toBe(true);
  expect(session.getPendingTrackStatus(status)).toBeUndefined();
  expect(actions.filter(action => action.type === 'cancel_request').map(action => action.requestId).sort()).toEqual([sub, status].sort());
  expect(actions).toContainEqual({ type: 'cancel_request', requestId: status, reason: 'malformed track', malformedTrack: true });
  expect(session.handleMalformedTrack(status)).toEqual([]);
});
