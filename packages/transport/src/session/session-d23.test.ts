/**
 * Draft-23 session rules: a FETCH answered with REQUEST_OK (§9.3), the
 * draft-23 parameter scope and INVALID_PARAMETER (§9.19), NAMESPACE Parameters
 * (§9.15), overlapping namespace subscriptions (§3.6, §4.2), SUBSCRIBE_TRACKS_ID
 * (§9.19.21) and MAX_CONTROL_MESSAGE_SIZE (§9.1.8).
 */
import { describe, expect, it } from 'vitest';
import { Session, SessionError } from './session.js';
import { EndpointRole, SessionState, type SessionOutboundAction } from './types.js';
import { varint } from '../primitives/varint.js';
import type { ControlMessage, Fetch, FetchOk, Parameters, RequestOk, StandaloneFetch } from '../control/messages.js';

const enc = (s: string) => new TextEncoder().encode(s);
const namespace = [enc('live')];
const name = enc('video');
const LARGEST_OBJECT = 0x09n;
const SUBSCRIBE_TRACKS_ID = 0x36n;

function established(draft: 22 | 23 = 23, role: 'client' | 'server' = 'client'): Session {
  const session = new Session(role === 'client' ? EndpointRole.CLIENT : EndpointRole.SERVER, draft);
  if (role === 'client') session.initiateSetup();
  session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
  if (role === 'server') session.completeSetup();
  expect(session.state).toBe(SessionState.ESTABLISHED);
  return session;
}

function sent(actions: SessionOutboundAction[]): ControlMessage[] {
  return actions.flatMap((a) => (a.type === 'send_control' ? [a.message] : []));
}

function closeCode(actions: SessionOutboundAction[]): bigint | undefined {
  const close = actions.find((a) => a.type === 'close_connection');
  return close?.type === 'close_connection' ? close.error : undefined;
}

/** An inbound standalone FETCH for groups 2..`endGroup` (End Object 0: the whole End Group). */
function inboundFetch(session: Session, requestId: bigint, endObject = 0n): void {
  session.handleControlMessage({
    type: 'FETCH', requestId,
    fetch: {
      fetchType: 0x1, trackNamespace: namespace, trackName: name,
      startLocation: { group: 2n, object: 0n }, endLocation: { group: 8n, object: endObject },
    } as StandaloneFetch,
    parameters: new Map(),
  } as Fetch);
}

describe('draft-23 FETCH response (§3.2, §9.3)', () => {
  it('accepts a FETCH with REQUEST_OK, carrying LARGEST_OBJECT where the response ends early', () => {
    const session = established(23, 'server');
    inboundFetch(session, 0n);
    const [ok] = sent(session.acceptFetch(0n, {
      largestObject: { group: 5n, object: 3n }, trackProperties: new Map([[0x0en, [3n]]]),
    }));
    expect(ok).toMatchObject({ type: 'REQUEST_OK', requestId: 0n, trackProperties: new Map([[0x0en, [3n]]]) });
    expect((ok as RequestOk).parameters.get(LARGEST_OBJECT)).toEqual([{ group: 5n, object: 3n }]);
  });

  it('never infers LARGEST_OBJECT from the End Location', () => {
    const session = established(23, 'server');
    inboundFetch(session, 0n, 5n); // End Object 5 → the last requested Object is 8/4
    const [ok] = sent(session.acceptFetch(0n, { endLocation: { group: 5n, object: 3n } }));
    expect((ok as RequestOk).parameters.has(LARGEST_OBJECT)).toBe(false);
  });

  it('refuses a Largest Object before the FETCH start', () => {
    const session = established(23, 'server');
    inboundFetch(session, 0n);
    expect(() => session.acceptFetch(0n, { largestObject: { group: 1n, object: 9n } })).toThrow(/before the FETCH start/);
  });

  it('sends an explicit Largest Object that falls inside the range', () => {
    const session = established(23, 'server');
    inboundFetch(session, 0n);
    const [ok] = sent(session.acceptFetch(0n, { largestObject: { group: 8n, object: 9n } }));
    expect((ok as RequestOk).parameters.get(LARGEST_OBJECT)).toEqual([{ group: 8n, object: 9n }]);
    const outside = established(23, 'server');
    inboundFetch(outside, 0n, 5n);
    const [ok2] = sent(outside.acceptFetch(0n, { largestObject: { group: 9n, object: 0n } }));
    expect((ok2 as RequestOk).parameters.has(LARGEST_OBJECT)).toBe(false);
  });

  it('refuses endOfTrack: draft 23 marks the end on the data stream', () => {
    const session = established(23, 'server');
    inboundFetch(session, 0n);
    expect(() => session.acceptFetch(0n, { endOfTrack: 1 })).toThrow(/sendFetchEndMarker/);
    expect(sent(session.acceptFetch(0n, { endOfTrack: 0 }))[0]).toMatchObject({ type: 'REQUEST_OK' });
  });

  it('draft 22 still answers with FETCH_OK', () => {
    const session = established(22, 'server');
    inboundFetch(session, 0n);
    const [ok] = sent(session.acceptFetch(0n, { endLocation: { group: 5n, object: 3n }, endOfTrack: 1 }));
    expect(ok).toMatchObject({ type: 'FETCH_OK', endOfTrack: 1, endLocation: { group: 5n, object: 3n } });
  });

  it('reads a REQUEST_OK answering our FETCH as its FETCH_OK', () => {
    const session = established();
    const { requestId } = session.fetch(namespace, name, {
      startGroup: varint(2n), startObject: varint(0n), endGroup: varint(8n), endObject: varint(5n),
    });
    const largest: RequestOk = {
      type: 'REQUEST_OK', requestId, parameters: new Map([[LARGEST_OBJECT, [{ group: 6n, object: 1n }]]]),
    };
    expect(session.fetchOkFromRequestOk(requestId, largest)).toMatchObject({
      type: 'FETCH_OK', endOfTrack: 0, endLocation: { group: 6n, object: 1n },
    });
    // Without LARGEST_OBJECT the response ends at the requested end (8/4, inclusive).
    const plain: RequestOk = { type: 'REQUEST_OK', requestId, parameters: new Map() };
    const fetchOk = session.fetchOkFromRequestOk(requestId, plain) as FetchOk;
    expect(fetchOk.endLocation).toEqual({ group: 8n, object: 4n });
    expect(session.handleControlMessage(plain)).toEqual([]);
    expect(session.getFetch(requestId)?.responseReceived).toBe(true);
    // A second answer is a duplicate FETCH_OK: UNEXPECTED_MESSAGE on draft 23.
    expect(closeCode(session.handleControlMessage(plain))).toBe(0x303n);
  });

  it('tolerates a REQUEST_OK that crosses our cancellation of a pending FETCH', () => {
    const session = established();
    const { requestId } = session.fetch(namespace, name, { startGroup: varint(0n), startObject: varint(0n) });
    session.fetchCancel(requestId);
    const ok: RequestOk = { type: 'REQUEST_OK', requestId, parameters: new Map() };
    expect(session.fetchOkFromRequestOk(requestId, ok)).toMatchObject({ type: 'FETCH_OK' });
    expect(closeCode(session.handleControlMessage(ok))).toBeUndefined();
  });

  it('leaves other REQUEST_OKs, and draft 22, alone', () => {
    const session = established();
    expect(session.fetchOkFromRequestOk(9n, { type: 'REQUEST_OK', requestId: 9n, parameters: new Map() })).toBeUndefined();
    const d22 = established(22);
    const { requestId } = d22.fetch(namespace, name, { startGroup: varint(0n), startObject: varint(0n) });
    expect(d22.fetchOkFromRequestOk(requestId, { type: 'REQUEST_OK', requestId, parameters: new Map() })).toBeUndefined();
  });
});

describe('draft-23 parameter scope (§9.19)', () => {
  it('a bad parameter is INVALID_PARAMETER (draft 22: PROTOCOL_VIOLATION)', () => {
    for (const [draft, code] of [[23, 0x305n], [22, 0x3n]] as const) {
      const session = established(draft, 'server');
      const actions = session.handleControlMessage({
        type: 'SUBSCRIBE', requestId: 0n, trackNamespace: namespace, trackName: name,
        parameters: new Map([[0x10n, [2n]]]), // FORWARD/PAUSED out of range
      });
      expect(closeCode(actions)).toBe(code);
    }
  });

  it('RENDEZVOUS_TIMEOUT cannot appear in SUBSCRIBE_TRACKS (§3.6.2)', () => {
    const session = established(23, 'server');
    const actions = session.handleControlMessage({
      type: 'SUBSCRIBE_TRACKS', requestId: 0n, trackNamespacePrefix: namespace,
      parameters: new Map([[0x04n, [100n]]]),
    });
    expect(closeCode(actions)).toBe(0x305n);
    const d22 = established(22, 'server');
    expect(closeCode(d22.handleControlMessage({
      type: 'SUBSCRIBE_TRACKS', requestId: 0n, trackNamespacePrefix: namespace,
      parameters: new Map([[0x04n, [100n]]]),
    }))).toBeUndefined();
  });

  it('EXPIRES may appear in TRACK_STATUS_OK', () => {
    const session = established();
    const { requestId } = session.trackStatus(namespace, name);
    const actions = session.handleControlMessage({
      type: 'REQUEST_OK', requestId, parameters: new Map([[0x08n, [1000n]]]),
    });
    expect(closeCode(actions)).toBeUndefined();
  });
});

describe('draft-23 NAMESPACE (§9.15)', () => {
  function subscribed(): { session: Session; requestId: bigint } {
    const session = established();
    const { requestId } = session.subscribeNamespace(namespace);
    session.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() });
    return { session, requestId };
  }

  it('accepts an empty Parameters block', () => {
    const { session, requestId } = subscribed();
    const actions = session.handleNamespaceStreamMessage(
      requestId, { type: 'NAMESPACE', trackNamespaceSuffix: [enc('a')], parameters: new Map() },
    );
    expect(closeCode(actions)).toBeUndefined();
  });

  it('any parameter is INVALID_PARAMETER: none is defined for NAMESPACE', () => {
    const { session, requestId } = subscribed();
    const parameters: Parameters = new Map([[0x08n, [1n]]]);
    const actions = session.handleNamespaceStreamMessage(
      requestId, { type: 'NAMESPACE', trackNamespaceSuffix: [enc('a')], parameters },
    );
    expect(closeCode(actions)).toBe(0x305n);
  });

  it('NAMESPACE_DONE before NAMESPACE is UNEXPECTED_MESSAGE', () => {
    const { session, requestId } = subscribed();
    const actions = session.handleNamespaceStreamMessage(requestId, { type: 'NAMESPACE_DONE', trackNamespaceSuffix: [enc('a')] });
    expect(closeCode(actions)).toBe(0x303n);
  });
});

describe('draft-23 overlapping namespace subscriptions (§3.6, §4.2)', () => {
  const wider = [enc('live')];
  const narrower = [enc('live'), enc('sports')];

  it.each(['SUBSCRIBE_NAMESPACE', 'SUBSCRIBE_TRACKS'] as const)('accepts an overlapping %s', (type) => {
    const session = established(23, 'server');
    session.handleControlMessage({ type, requestId: 0n, trackNamespacePrefix: wider, parameters: new Map() });
    const actions = session.handleControlMessage({ type, requestId: 2n, trackNamespacePrefix: narrower, parameters: new Map() });
    expect(sent(actions).some((m) => m.type === 'REQUEST_ERROR')).toBe(false);
  });

  it('draft 22 still refuses the overlap with PREFIX_OVERLAP', () => {
    const session = established(22, 'server');
    session.handleControlMessage({ type: 'SUBSCRIBE_NAMESPACE', requestId: 0n, trackNamespacePrefix: wider, parameters: new Map() });
    const actions = session.handleControlMessage({
      type: 'SUBSCRIBE_NAMESPACE', requestId: 2n, trackNamespacePrefix: narrower, parameters: new Map(),
    });
    expect(sent(actions)).toContainEqual(expect.objectContaining({ type: 'REQUEST_ERROR', errorCode: 0x30n }));
  });

  it('an inbound PUBLISH_NAMESPACE reaches every matching namespace subscription', () => {
    const session = established();
    const a = session.subscribeNamespace(wider).requestId;
    const b = session.subscribeNamespace(narrower).requestId;
    for (const requestId of [a, b]) session.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() });
    const actions = session.handleControlMessage({
      type: 'PUBLISH_NAMESPACE', requestId: 1n, trackNamespace: [...narrower, enc('hd')], parameters: new Map(),
    });
    const notified = actions.flatMap((x) => (x.type === 'notify_namespace' ? [x.requestId] : []));
    expect(notified.sort()).toEqual([a, b].sort());
  });
});

describe('draft-23 SUBSCRIBE_TRACKS_ID (§9.19.21)', () => {
  it('a PUBLISH answering a SUBSCRIBE_TRACKS names it', () => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: 1n, trackNamespacePrefix: namespace, parameters: new Map() });
    session.acceptSubscribeTracks(1n);
    const pub = session.publish(namespace, name, 10n, { subscribeTracksRequestId: 1n });
    const [msg] = sent(pub.actions);
    expect(msg).toMatchObject({ type: 'PUBLISH' });
    expect((msg as { parameters: Parameters }).parameters.get(SUBSCRIBE_TRACKS_ID)).toEqual([1n]);
    // An independent PUBLISH carries none.
    const [own] = sent(session.publish(namespace, enc('other'), 11n).actions);
    expect((own as { parameters: Parameters }).parameters.has(SUBSCRIBE_TRACKS_ID)).toBe(false);
  });
});

describe('draft-23 MAX_CONTROL_MESSAGE_SIZE (§9.1.8)', () => {
  const sizeOption = (bytes: number[]) => new Map([[0x09n, [new Uint8Array(bytes)]]]);

  function peerSetup(setupOptions: Map<bigint, Uint8Array[]>): Session {
    const session = new Session(EndpointRole.CLIENT, 23);
    session.initiateSetup();
    session.handleControlMessage({ type: 'SETUP', setupOptions });
    return session;
  }

  it('accepts a peer limit of at least 65535', () => {
    const session = peerSetup(sizeOption([0xc1, 0x11, 0x70])); // 70000 as a 3-byte vi64
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });

  it('refuses a limit below 65535 or a malformed value', () => {
    expect(peerSetup(sizeOption([0x80, 0xff])).state).toBe(SessionState.CLOSED); // 255
    expect(peerSetup(sizeOption([0xc1, 0x11])).state).toBe(SessionState.CLOSED); // truncated
  });

  it('is an unknown option before draft 23', () => {
    const session = new Session(EndpointRole.CLIENT, 22);
    session.initiateSetup();
    session.handleControlMessage({ type: 'SETUP', setupOptions: sizeOption([0x80, 0xff]) });
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });
});

it('SessionError is still exported for fetch acceptance misuse', () => {
  expect(() => established(23, 'server').acceptFetch(5n)).toThrow(SessionError);
});
