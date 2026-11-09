import { describe, expect, it } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, SessionState, SubscriptionState } from './types.js';
import { encodeSubscriptionFilter, decodeSubscriptionFilter, type SubscriptionFilter } from '../control/subscription-filter.js';
import type { ServerSetup, SubscribeOk } from '../control/messages.js';
import { SetupParam } from '../control/parameters.js';
import { varint } from '../primitives/varint.js';

// SUBSCRIBE_OK / REQUEST_OK resolve the window from the stored filter, so a
// locally sent filter must also be accepted by our decoder. Reject bad local
// ranges before creating a request (draft-14 §9.7; draft-16 §5.1.2).
describe('outbound legacy AbsoluteRange validation', () => {
  const NS = [new Uint8Array([0x6c])];
  const NAME = new Uint8Array([0x76]);
  const inverted: SubscriptionFilter = { type: 'AbsoluteRange', startGroup: 10n, startObject: 0n, endGroup: 5n };

  function established(draft: 14 | 16): Session {
    const s = new Session(EndpointRole.CLIENT, draft);
    s.initiateSetup({ maxRequestId: varint(100n) });
    const setup: ServerSetup = {
      type: 'SERVER_SETUP',
      parameters: new Map([[varint(SetupParam.MAX_REQUEST_ID), [varint(100n)]]]),
    };
    s.handleControlMessage(setup);
    return s;
  }

  for (const draft of [14, 16] as const) {
    it(`draft-${draft} subscribe() rejects an inverted range without allocating a request`, () => {
      const s = established(draft);
      expect(() => s.subscribe(NS, NAME, { subscriptionFilter: inverted })).toThrow(RangeError);
      expect(s.state).toBe(SessionState.ESTABLISHED);
      expect(s.getSubscription(0n)).toBeUndefined();
      expect(s.subscribe(NS, NAME).requestId).toBe(0n);
    });

    it(`draft-${draft} requestUpdate() rejects an inverted range without changing the window or allocating a request`, () => {
      const s = established(draft);
      const { requestId } = s.subscribe(NS, NAME, {
        subscriptionFilter: { type: 'AbsoluteRange', startGroup: 10n, startObject: 2n, endGroup: 10n },
      });
      const ok: SubscribeOk = {
        type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(1n), parameters: new Map(),
      };
      expect(s.handleControlMessage(ok).some(a => a.type === 'close_connection')).toBe(false);
      const window = s.getSubscription(requestId)!.locationWindow;
      expect(() => s.requestUpdate(requestId, { subscriptionFilter: inverted })).toThrow(RangeError);
      expect(s.state).toBe(SessionState.ESTABLISHED);
      expect(s.getSubscription(requestId)!.locationWindow).toEqual(window);
      expect(s.subscribe(NS, new Uint8Array([0x61])).requestId).toBe(2n);
    });

    it(`draft-${draft} accepts an equal end group with a nonzero start object and the peer's response`, () => {
      const s = established(draft);
      const { requestId, actions } = s.subscribe(NS, NAME, {
        subscriptionFilter: { type: 'AbsoluteRange', startGroup: 10n, startObject: 9n, endGroup: 10n },
      });
      expect(actions.some(a => a.type === 'send_control' && a.message.type === 'SUBSCRIBE')).toBe(true);
      const ok: SubscribeOk = {
        type: 'SUBSCRIBE_OK', requestId, trackAlias: varint(1n), parameters: new Map(),
      };
      expect(s.handleControlMessage(ok).some(a => a.type === 'close_connection')).toBe(false);
      expect(s.state).toBe(SessionState.ESTABLISHED);
      expect(s.getSubscription(requestId)!.state).toBe(SubscriptionState.ESTABLISHED);
      expect(s.getSubscription(requestId)!.locationWindow?.start).toEqual({ group: 10n, object: 9n });
    });
  }
});

// Isolated encoder boundary checks; d18/d22 controls preserve existing rejection.
describe('inverted-range encoder boundary', () => {
  it.each([14, 16, 18, 22])('draft-%s rejects an inverted range', draft => {
    expect(() => encodeSubscriptionFilter({ type: 'AbsoluteRange', startGroup: 10n, startObject: 0n, endGroup: 5n }, draft)).toThrow(RangeError);
  });
  it.each([14, 16, 18, 22])('draft-%s round-trips an equal Group with nonzero Start Object', draft => {
    const filter: SubscriptionFilter = { type: 'AbsoluteRange', startGroup: 10n, startObject: 9n, endGroup: 10n };
    expect(decodeSubscriptionFilter(encodeSubscriptionFilter(filter, draft), draft)).toEqual(filter);
  });
});
