/**
 * REQUEST_UPDATE response boundary under a re-entrant Largest Location provider (draft-16 §9.11 / draft-18 §10.9):
 * "The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR."
 *
 * A provider that re-enters the Session (here: applying a nested Forward=0 update to the same subscription) changes the
 * subscription under the outer relative-filter update. The outer update must still be answered — with REQUEST_ERROR,
 * without applying its stale window on top of the nested state. Only a request that no longer exists may be left
 * unanswered (control: the provider unsubscribes the request).
 */
import { describe, expect, it } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, ForwardState, type SendControlAction } from './types.js';
import { varint } from '../primitives/varint.js';
import { SetupParam, MessageParam } from '../control/parameters.js';
import { encodeSubscriptionFilter } from '../control/subscription-filter.js';
import { writeLocation, locationEncodingLength } from '../primitives/location.js';
import type { ClientSetup, Subscribe, Parameters } from '../control/messages.js';

const NS = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])], NAME = new Uint8Array([0x76, 0x69, 0x64]);
type Draft = 16 | 18;
function serverSession(draft: Draft): Session {
  const session = new Session(EndpointRole.SERVER, draft);
  if (draft === 18) session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as never);
  else session.handleControlMessage({ type: 'CLIENT_SETUP', versions: [], parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]) } as unknown as ClientSetup);
  session.completeSetup({ maxRequestId: varint(100n) });
  return session;
}
const subscribe = (requestId: bigint, parameters: Parameters): Subscribe => ({ type: 'SUBSCRIBE', requestId: varint(requestId), trackNamespace: NS, trackName: NAME, parameters });
const update = (requestId: bigint, existing: bigint, parameters: Parameters) => ({ type: 'REQUEST_UPDATE', requestId: varint(requestId), existingRequestId: varint(existing), parameters }) as never;
const largestParam = (draft: Draft, group: bigint, object: bigint) => {
  if (draft === 18) return { group, object };
  const loc = { group: varint(group), object: varint(object) }; const out = new Uint8Array(locationEncodingLength(loc)); writeLocation(loc, out, 0); return out;
};
const responses = (actions: readonly { type: string }[], requestId: bigint) => actions
  .filter((a): a is SendControlAction => a.type === 'send_control')
  .map(a => a.message as { type: string; requestId?: unknown })
  .filter(m => (m.type === 'REQUEST_OK' || m.type === 'REQUEST_ERROR' || m.type === 'REQUEST_UPDATE_OK') && BigInt(m.requestId as bigint) === requestId)
  .map(m => m.type);

describe.each([16, 18] as const)('draft-%i: re-entrant Largest Location provider during a relative-filter update', draft => {
  function established() {
    const session = serverSession(draft);
    session.handleControlMessage(subscribe(0n, new Map([[MessageParam.SUBSCRIPTION_FILTER, [encodeSubscriptionFilter({ type: 'NextGroupStart' }, draft)]]])));
    session.acceptSubscribe(0n, 9n, { parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [largestParam(draft, 5n, 2n)]]]) as Parameters });
    const sub = session.getIncomingSubscription(0n)!;
    expect(sub.state).toBe('established');
    return { session, sub };
  }
  it('a provider that pauses the same subscription re-entrantly: the outer update is answered with exactly one REQUEST_ERROR and the nested state survives', () => {
    const { session, sub } = established();
    let nested: string[] = [], nestedRaw: unknown = null;
    let reentered = false;
    session.setLargestLocationProvider(() => {
      if (reentered) return { group: 5n, object: 3n };
      reentered = true;
      const actions = session.handleControlMessage(update(4n, 0n, new Map([[MessageParam.FORWARD, [0n]]])));
      nestedRaw = JSON.parse(JSON.stringify(actions, (_k, v) => typeof v === 'bigint' ? String(v) : v instanceof Map ? [...v] : v));
      nested = responses(actions, 4n);
      return { group: 5n, object: 3n };
    });
    const outer = responses(session.handleControlMessage(update(2n, 0n, new Map([[MessageParam.SUBSCRIPTION_FILTER, [encodeSubscriptionFilter({ type: 'LargestObject' }, draft)]]]))), 2n);
    expect(nested, `the nested pause was accepted: ${JSON.stringify(nestedRaw)}`).toEqual(['REQUEST_OK']);
    expect(outer, 'the outer update must still be answered').toEqual(['REQUEST_ERROR']);
    expect(sub.forwardState, 'nested state kept').toBe(ForwardState.PAUSED);
    expect(sub.remoteFilterType).toBe('NextGroupStart');
    expect(session.getIncomingSubscription(0n)).toBe(sub);
  });
  it('control — a provider that terminates the request re-entrantly: no response is owed and nothing is resurrected', () => {
    const { session } = established();
    session.setLargestLocationProvider(() => { session.handleControlMessage({ type: 'UNSUBSCRIBE', requestId: varint(0n) } as never); return { group: 5n, object: 3n }; });
    const outer = responses(session.handleControlMessage(update(2n, 0n, new Map([[MessageParam.SUBSCRIPTION_FILTER, [encodeSubscriptionFilter({ type: 'LargestObject' }, draft)]]]))), 2n);
    expect(outer).toEqual([]);
    expect(session.getIncomingSubscription(0n)?.isTerminated ?? true).toBe(true);
  });
  it('control — a well-behaved provider: exactly one REQUEST_OK carrying the Largest it anchored to', () => {
    const { session, sub } = established();
    session.setLargestLocationProvider(() => ({ group: 5n, object: 3n }));
    const actions = session.handleControlMessage(update(2n, 0n, new Map([[MessageParam.SUBSCRIPTION_FILTER, [encodeSubscriptionFilter({ type: 'LargestObject' }, draft)]]])));
    expect(responses(actions, 2n)).toEqual(['REQUEST_OK']);
    const ok = (actions.find(a => a.type === 'send_control') as SendControlAction).message;
    expect((ok as { parameters: Parameters }).parameters.get(MessageParam.LARGEST_OBJECT)?.[0]).toEqual(largestParam(draft, 5n, 3n));
  });
});
