/**
 * draft-18 Track Properties (§2.5) on outbound publisher messages: TRACK_STATUS_OK
 * (§10.14), SUBSCRIBE_OK (§10.4), FETCH_OK (§10.13), and PUBLISH (§10.10). The
 * `trackProperties` send API is draft-18-only — covered against the sans-I/O Session.
 */
import { describe, it, expect } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, SubscriptionState, type SendControlAction } from './types.js';
import { varint } from '../primitives/varint.js';
import type { Setup, RequestOk, TrackStatus, TrackProperties, Subscribe, SubscribeOk, Fetch, StandaloneFetch, FetchOk, Publish } from '../control/messages.js';

const f = (s: string) => new TextEncoder().encode(s);
const PRIORITY = 0x0en; // DEFAULT_PUBLISHER_PRIORITY (even type → bigint value, 0..255)
const props = (): TrackProperties => new Map([[PRIORITY, [3n]]]);

function server18(): Session {
  const s = new Session(EndpointRole.SERVER, 18);
  s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
  s.completeSetup();
  return s;
}

function client18(): Session {
  const s = new Session(EndpointRole.CLIENT, 18);
  s.initiateSetup();
  s.handleControlMessage({ type: 'SETUP', setupOptions: new Map() } as Setup);
  return s;
}

function inboundTrackStatus(s: Session, rid: bigint): void {
  s.handleControlMessage({ type: 'TRACK_STATUS', requestId: rid, trackNamespace: [f('live')], trackName: f('vid'), parameters: new Map() } as TrackStatus);
}

function inboundSubscribe(s: Session, rid: bigint): void {
  s.handleControlMessage({ type: 'SUBSCRIBE', requestId: rid, trackNamespace: [f('live')], trackName: f('vid'), parameters: new Map() } as Subscribe);
}

function inboundFetch(s: Session, rid: bigint): void {
  s.handleControlMessage({
    type: 'FETCH', requestId: rid,
    fetch: {
      fetchType: 0x1, trackNamespace: [f('live')], trackName: f('vid'),
      startLocation: { group: varint(0n), object: varint(0n) },
      endLocation: { group: varint(10n), object: varint(0n) },
    } as StandaloneFetch,
    parameters: new Map(),
  } as Fetch);
}

describe('acceptTrackStatus — draft-18 TRACK_STATUS_OK Track Properties', () => {
  it('produces a REQUEST_OK carrying the supplied Track Properties', () => {
    const s = server18();
    inboundTrackStatus(s, 0n);
    const trackProperties: TrackProperties = new Map([[PRIORITY, [3n]]]);
    const actions = s.acceptTrackStatus(0n, { trackProperties });
    const ok = (actions[0] as SendControlAction).message as RequestOk;
    expect(ok.type).toBe('REQUEST_OK');
    expect(ok.requestId).toBe(0n);
    expect(ok.trackProperties).toEqual(trackProperties);
  });

  it('still accepts the legacy Parameters-map second argument (backwards-compatible)', () => {
    const s = server18();
    inboundTrackStatus(s, 0n);
    const params = new Map([[0x100n, [42n]]]);
    const actions = s.acceptTrackStatus(0n, params);
    const ok = (actions[0] as SendControlAction).message as RequestOk;
    expect(ok.parameters).toBe(params);
    // No Track Properties were supplied, so none are attached.
    expect(ok.trackProperties).toBeUndefined();
  });

  it('supports both parameters and trackProperties via the options object', () => {
    const s = server18();
    inboundTrackStatus(s, 0n);
    const parameters = new Map([[0x100n, [42n]]]);
    const trackProperties: TrackProperties = new Map([[PRIORITY, [5n]]]);
    const actions = s.acceptTrackStatus(0n, { parameters, trackProperties });
    const ok = (actions[0] as SendControlAction).message as RequestOk;
    expect(ok.parameters).toBe(parameters);
    expect(ok.trackProperties).toEqual(trackProperties);
  });
});

describe('Track Properties on other draft-18 publisher send contexts', () => {
  it('acceptSubscribe carries Track Properties on the SUBSCRIBE_OK', () => {
    const s = server18();
    inboundSubscribe(s, 0n);
    const trackProperties = props();
    const actions = s.acceptSubscribe(0n, 9n, { trackProperties });
    const ok = (actions[0] as SendControlAction).message as SubscribeOk;
    expect(ok.type).toBe('SUBSCRIBE_OK');
    expect(ok.trackAlias).toBe(9n);
    expect(ok.trackProperties).toEqual(trackProperties);
  });

  it('acceptFetch carries Track Properties on the FETCH_OK', () => {
    const s = server18();
    inboundFetch(s, 0n);
    const trackProperties = props();
    const actions = s.acceptFetch(0n, { trackProperties });
    const ok = (actions[0] as SendControlAction).message as FetchOk;
    expect(ok.type).toBe('FETCH_OK');
    expect(ok.trackProperties).toEqual(trackProperties);
  });

  it('publish carries Track Properties on the PUBLISH', () => {
    const c = client18();
    const trackProperties = props();
    const { actions } = c.publish([f('live')], f('vid'), 21n, { trackProperties });
    const msg = (actions[0] as SendControlAction).message as Publish;
    expect(msg.type).toBe('PUBLISH');
    expect(msg.trackProperties).toEqual(trackProperties);
  });

  it('Track Properties on a PUBLISH acceptance throw WITHOUT mutating state; a plain accept still succeeds', () => {
    // An inbound PUBLISH (we are the subscriber) is accepted via acceptSubscribe;
    // its acceptance is a REQUEST_OK shorthand, not a SUBSCRIBE_OK — Track
    // Properties do not belong there. The rejection must NOT have already moved the
    // subscription to ESTABLISHED.
    const s = server18();
    s.handleControlMessage({
      type: 'PUBLISH', requestId: 0n, trackNamespace: [f('live')], trackName: f('vid'),
      trackAlias: 3n, parameters: new Map(), trackProperties: new Map(),
    } as Publish);

    expect(() => s.acceptSubscribe(0n, 3n, { trackProperties: props() })).toThrow(/not valid on a PUBLISH acceptance/i);
    // State was NOT mutated by the failed accept.
    expect(s.getIncomingSubscription(0n)!.state).not.toBe(SubscriptionState.ESTABLISHED);

    // A subsequent valid acceptance still works (proves it wasn't half-accepted).
    const actions = s.acceptSubscribe(0n, 3n);
    expect((actions[0] as SendControlAction).message.type).toBe('REQUEST_OK'); // PUBLISH_OK shorthand
    expect(s.getIncomingSubscription(0n)!.state).toBe(SubscriptionState.ESTABLISHED);
  });
});
