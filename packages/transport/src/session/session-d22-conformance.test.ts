import { describe, expect, it } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, SessionState } from './types.js';
import { varint } from '../primitives/varint.js';
import type { Parameters } from '../control/messages.js';
import { AliasType, encodeAuthorizationToken18 } from '../control/auth-token.js';
import { decodeSubscriptionFilter, subscriptionWindow } from '../control/subscription-filter.js';

const namespace = [new TextEncoder().encode('live')];
const name = new TextEncoder().encode('video');

describe('draft-22 SUBSCRIBE_TRACKS Forward updates (9.20.18)', () => {
  it('inherits Group Order without copying subscriber authorization (3.6.2, 9.20.2)', () => {
    const session = established();
    const token = encodeAuthorizationToken18({ aliasType: AliasType.USE_VALUE, tokenType: 1n, tokenValue: new Uint8Array([7]) });
    const parameters: Parameters = new Map([[0x22n, [2n]], [0x03n, [token]]]);
    session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: 1n, trackNamespacePrefix: namespace, parameters });
    session.acceptSubscribeTracks(1n);
    const pub = session.publish(namespace, name, 10n, { subscribeTracksRequestId: 1n,
      parameters: new Map([[0x22n, [1n]]]) });
    const action = pub.actions.find((a) => a.type === 'send_control')!;
    if (action.type !== 'send_control' || action.message.type !== 'PUBLISH') throw new Error('missing publish');
    expect(action.message.parameters.get(0x22n)).toEqual([2n]);
    expect(action.message.parameters.has(0x03n)).toBe(false);
    expect(session.getOutgoingPublish(pub.requestId)!.groupOrder).toBe('descending');
    const independent = session.publish(namespace, name, 11n, { parameters: new Map([[0x22n, [1n]]]) });
    expect(session.getOutgoingPublish(independent.requestId)!.groupOrder).toBe('ascending');
  });
  it.each(['unknown', 'pending', 'outside prefix', 'cancelled', 'older draft'] as const)(
    'refuses a PUBLISH association with %s before allocating a request', (condition) => {
      const session = established(condition === 'older draft' ? 18 : 22);
      if (condition !== 'unknown') {
        session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: 1n,
          trackNamespacePrefix: namespace, parameters: new Map() });
        if (condition !== 'pending') session.acceptSubscribeTracks(1n);
        if (condition === 'cancelled') session.handleInboundSubscribeTracksClosed(1n);
      }
      const prefix = condition === 'outside prefix' ? [new TextEncoder().encode('other')] : namespace;
      expect(() => session.publish(prefix, name, 10n, { subscribeTracksRequestId: 1n })).toThrow(/active matching draft-22/);
      expect(session.publish(prefix, name, 10n).requestId).toBe(0n);
    },
  );
  it.each([0n, 1n])('preserves independent PUBLISH Forward=%s inside a subscribed prefix', (forward) => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: 1n,
      trackNamespacePrefix: namespace, parameters: new Map([[0x10n, [1n - forward]]]) });
    session.acceptSubscribeTracks(1n);
    const pub = session.publish(namespace, name, 10n, { parameters: new Map([[0x10n, [forward]]]) });
    expect(session.getOutgoingPublish(pub.requestId)!.forwardState).toBe(Number(forward));
    const action = pub.actions.find((a) => a.type === 'send_control')!;
    if (action.type !== 'send_control' || action.message.type !== 'PUBLISH') throw new Error('missing publish');
    expect(action.message.parameters.get(0x10n)).toEqual([forward]);
  });
  it('leaves the previous Forward State intact when an outgoing update is rejected', () => {
    const session = established();
    const id = session.subscribeTracks(namespace).requestId;
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: id, parameters: new Map() });
    const update = session.requestUpdate(id, { forward: 0 });
    session.handleControlMessage({ type: 'REQUEST_ERROR', requestId: update.requestId,
      errorCode: 16n, retryInterval: 0n, errorReason: 'rejected' });
    expect(session.getTrackSubscription(id)).toHaveProperty('forward', 1);
  });

  it('does not apply Forward when a combined prefix update overlaps another request', () => {
    const session = established();
    const other = [new TextEncoder().encode('other')];
    for (const [id, prefix] of [[1n, namespace], [3n, other]] as const) {
      session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: id,
        trackNamespacePrefix: prefix, parameters: new Map() });
      session.acceptSubscribeTracks(id);
    }
    const actions = session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: 5n,
      existingRequestId: 1n, parameters: new Map([[0x34n, [other]], [0x10n, [0n]]]) });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'send_control',
      message: expect.objectContaining({ type: 'REQUEST_ERROR' }) }));
    expect(session.getIncomingTrackSubscription(1n)).toMatchObject({ trackNamespacePrefix: namespace, forward: 1 });
  });

  it.each([0n, 1n])('retains initial Forward=%s and omission leaves it unchanged', (forward) => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: 1n,
      trackNamespacePrefix: namespace, parameters: new Map([[0x10n, [forward]]]) });
    session.acceptSubscribeTracks(1n);
    session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: 3n, existingRequestId: 1n,
      parameters: new Map([[0x34n, [namespace]]]) });
    expect(session.getIncomingTrackSubscription(1n)).toHaveProperty('forward', Number(forward));
  });

  it('rejects an invalid incoming Forward before applying the prefix', () => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: 1n,
      trackNamespacePrefix: namespace, parameters: new Map() });
    session.acceptSubscribeTracks(1n);
    const actions = session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: 3n,
      existingRequestId: 1n, parameters: new Map([[0x34n, [[]]], [0x10n, [2n]]]) });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'close_connection', error: 3n }));
  });

  it('does not allocate a request for an out-of-scope draft-18 Forward update', () => {
    const session = established(18);
    const id = session.subscribeTracks(namespace).requestId;
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: id, parameters: new Map() });
    expect(() => session.requestUpdate(id, { forward: 0, trackNamespacePrefix: namespace })).toThrow(/draft-22/);
    expect(session.requestUpdate(id, { trackNamespacePrefix: namespace }).requestId).toBe(2n);
  });

  it.each([false, true])('emits Forward with a prefix change=%s and commits only on acknowledgment', (withPrefix) => {
    const session = established();
    const id = session.subscribeTracks(namespace).requestId;
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: id, parameters: new Map() });
    const update = session.requestUpdate(id, { forward: 0, ...(withPrefix ? { trackNamespacePrefix: namespace } : {}) });
    expect(update.actions).toContainEqual(expect.objectContaining({
      type: 'send_control', message: expect.objectContaining({ parameters: expect.any(Map) }),
    }));
    const action = update.actions.find((a) => a.type === 'send_control')!;
    if (action.type !== 'send_control' || action.message.type !== 'REQUEST_UPDATE') throw new Error('missing update');
    expect(action.message.parameters.get(0x10n)).toEqual([0n]);
    expect(session.getTrackSubscription(id)).toHaveProperty('forward', 1);
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: update.requestId, parameters: new Map() });
    expect(session.getTrackSubscription(id)).toHaveProperty('forward', 0);
  });

  it('applies Forward to future matching PUBLISHes, not existing or unrelated subscriptions', () => {
    const session = established();
    const id = varint(1n);
    session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: id, trackNamespacePrefix: namespace, parameters: new Map() });
    session.acceptSubscribeTracks(id);
    const first = session.publish(namespace, name, 10n, { subscribeTracksRequestId: id });
    session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: varint(3n), existingRequestId: id, parameters: new Map([[0x10n, [0n]]]) });
    expect(session.getIncomingTrackSubscription(id)).toHaveProperty('forward', 0);
    expect(session.getOutgoingPublish(first.requestId)!.forwardState).toBe(1);
    const next = session.publish(namespace, name, 11n, { subscribeTracksRequestId: id });
    expect(session.getOutgoingPublish(next.requestId)!.forwardState).toBe(0);
    const action = next.actions.find((a) => a.type === 'send_control')!;
    if (action.type !== 'send_control' || action.message.type !== 'PUBLISH') throw new Error('missing publish');
    expect(action.message.parameters.get(0x10n)).toEqual([0n]);
    const unrelated = session.publish([new TextEncoder().encode('other')], name, 12n);
    expect(session.getOutgoingPublish(unrelated.requestId)!.forwardState).toBe(1);
  });
});

function established(draft: 18 | 22 = 22): Session {
  const session = new Session(EndpointRole.CLIENT, draft);
  session.initiateSetup();
  session.handleControlMessage({ type: 'SETUP', setupOptions: new Map() });
  expect(session.state).toBe(SessionState.ESTABLISHED);
  return session;
}

describe('draft-22 fill parameter scope (9.20.15)', () => {
  it.each([0, 1] as const)('evaluates a pipelined fill after an earlier Forward=%s update', (forward) => {
    const session = established();
    const id = session.subscribe(namespace, name, { forward: forward === 0 ? 1 : 0 }).requestId;
    session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId: id, trackAlias: 4n, parameters: new Map(), trackProperties: new Map() });
    const first = session.requestUpdate(id, { forward });
    const second = session.requestUpdate(id, { fill: {} });
    const parameters: Parameters = new Map([[0x09n, [{ group: 5n, object: 0n }]]]);
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: first.requestId, parameters });
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: second.requestId, parameters });
    expect(session.expectedFillsOf(id)).toEqual(forward === 1 ? [second.requestId] : []);
  });

  it('a pipelined fill inherits the preceding accepted filter update', () => {
    const session = established();
    const id = session.subscribe(namespace, name).requestId;
    session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId: id, trackAlias: 4n, parameters: new Map(), trackProperties: new Map() });
    const first = session.requestUpdate(id, { subscriptionFilter: { type: 'NextGroupStart' } });
    const second = session.requestUpdate(id, { fill: {} });
    const parameters: Parameters = new Map([[0x09n, [{ group: 5n, object: 0n }]]]);
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: first.requestId, parameters });
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: second.requestId, parameters });
    expect(session.expectedFillsOf(id)).toEqual([]);
  });
  it.each(['empty track', 'empty range'] as const)('does not retain an expected fill for an %s', (kind) => {
    const session = established();
    const { requestId } = session.subscribe(namespace, name, { fill: {}, subscriptionFilter: { type: 'NextGroupStart' } });
    session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: 4n,
      parameters: kind === 'empty track' ? new Map() : new Map([[0x09n, [{ group: 5n, object: 0n }]]]),
      trackProperties: new Map(),
    });
    expect(session.expectedFillsOf(requestId)).toEqual([]);
    expect(session.getSubscription(requestId)!.state).toBe('established');
  });
  it.each(['rejected', 'cancelled', 'closed'] as const)('reclaims a %s subscription fill', (terminal) => {
    const session = established();
    const { requestId } = session.subscribe(namespace, name, { fill: {} });
    if (terminal === 'rejected') session.handleControlMessage({ type: 'REQUEST_ERROR', requestId, errorCode: 16n, retryInterval: 0n, errorReason: 'gone' });
    else if (terminal === 'cancelled') session.unsubscribe(requestId);
    else session.close();
    expect(session.fillSubscriptionFor(requestId)).toBeUndefined();
  });
  it.each([
    { description: 'FORWARD is not a fill parameter', bytes: [0x10, 1] },
    { description: 'recursive FILL_PARAMETERS is forbidden', bytes: [0x23, 0] },
    { description: 'GROUP_ORDER must be 1 or 2', bytes: [0x22, 3] },
    { description: 'duplicate GROUP_ORDER is forbidden', bytes: [0x22, 1, 0, 2] },
    { description: 'truncated GROUP_ORDER is malformed', bytes: [0x22] },
    { description: 'Next Object filter has no fields', bytes: [0x21, 5, 0, 0, 0, 0, 0] },
  ])('$description', ({ bytes }) => {
    const session = established();
    const actions = session.handleControlMessage({
      type: 'SUBSCRIBE', requestId: varint(1n), trackNamespace: namespace, trackName: name,
      parameters: new Map([[0x23n, [new Uint8Array(bytes)]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'close_connection', error: 3n }));
    expect(session.getIncomingSubscription(1n)).toBeUndefined();
  });

  it('allows an independent nested GROUP_ORDER and LOCATION_FILTER', () => {
    const session = established();
    const parameters: Parameters = new Map([
      [0x21n, [new Uint8Array([0])]],
      [0x22n, [1n]],
      [0x23n, [new Uint8Array([0x21, 0, 1, 2])]],
    ]);
    expect(session.handleControlMessage({
      type: 'SUBSCRIBE', requestId: varint(1n), trackNamespace: namespace, trackName: name, parameters,
    })).toEqual([]);
    expect(session.getIncomingSubscription(1n)).toBeDefined();
  });

  it('does not allocate a subscription when a local fill option is invalid', () => {
    const session = established(18);
    expect(() => session.subscribe(namespace, name, { fill: {} })).toThrow(/draft 22/);
    expect(session.getSubscription(0n)).toBeUndefined();
    expect(session.subscribe(namespace, name).requestId).toBe(0n);
  });
});

describe('draft-22 filter updates', () => {
  it.each([{ type: 'NextGroupStart' as const }, { type: 'RelativeStart' as const, groups: 0n }])('clamps a relative group above uint64: $type', (filter) => {
    const max = 0xffffffffffffffffn;
    expect(subscriptionWindow(filter, { group: max, object: 0n }).start).toEqual({ group: max, object: 0n });
  });

  it('does not consume a Request ID for an invalid local update filter', () => {
    const session = established();
    const { requestId } = session.subscribe(namespace, name);
    session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: 4n, parameters: new Map(), trackProperties: new Map() });
    expect(() => session.requestUpdate(requestId, {
      subscriptionFilter: { type: 'AbsoluteStart', startGroup: -1n, startObject: 0n },
    })).toThrow();
    expect(session.requestUpdate(requestId, { forward: 0 }).requestId).toBe(2n);
  });

  it('rejects Track Property Filter on an individual subscription update', () => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: namespace, trackName: name, parameters: new Map() });
    session.acceptSubscribe(1n, 4n);
    const actions = session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: 3n, existingRequestId: 1n,
      parameters: new Map([[0x29n, [new Uint8Array([0, 2, 0, 0])]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'close_connection', error: 3n }));
  });

  it('rejects FILL_PARAMETERS on a namespace publication update', () => {
    const session = established();
    session.handleControlMessage({ type: 'PUBLISH_NAMESPACE', requestId: 1n, trackNamespace: namespace, parameters: new Map() });
    const actions = session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: 3n, existingRequestId: 1n,
      parameters: new Map([[0x23n, [new Uint8Array()]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'close_connection', error: 3n }));
  });
  it.each([0x25n, 0x26n, 0x27n, 0x28n])('rejects unadvertised range filter %s with INVALID_FILTER', (type) => {
    const session = established();
    const actions = session.handleControlMessage({
      type: 'SUBSCRIBE', requestId: varint(1n), trackNamespace: namespace, trackName: name,
      parameters: new Map([[type, [new Uint8Array([0, 0])]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'send_control', message: expect.objectContaining({
      type: 'REQUEST_ERROR', requestId: 1n, errorCode: 0x36n,
    }) }));
    expect(session.state).toBe(SessionState.ESTABLISHED);
    expect(session.getIncomingSubscription(1n)).toBeUndefined();
  });

  it('rejects an unadvertised Track Property Filter on SUBSCRIBE_TRACKS', () => {
    const session = established();
    const actions = session.handleControlMessage({ type: 'SUBSCRIBE_TRACKS', requestId: varint(1n),
      trackNamespacePrefix: namespace, parameters: new Map([[0x29n, [new Uint8Array([0, 2, 0, 0])]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'send_control', message: expect.objectContaining({
      type: 'REQUEST_ERROR', errorCode: 0x36n,
    }) }));
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });

  it('enforces MAX_FILTER_RANGES inside a fill without changing the subscription on rejection', () => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE', requestId: varint(1n), trackNamespace: namespace, trackName: name, parameters: new Map() });
    session.acceptSubscribe(1n, 4n);
    session.setLargestLocationProvider(() => null);
    const actions = session.handleControlMessage({
      type: 'REQUEST_UPDATE', requestId: varint(3n), existingRequestId: 1n,
      parameters: new Map([[0x10n, [0n]], [0x23n, [new Uint8Array([0x25, 2, 0, 0])]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'send_control', message: expect.objectContaining({
      type: 'REQUEST_ERROR', requestId: 3n, errorCode: 0x36n,
    }) }));
    expect(session.getIncomingSubscription(1n)!.forwardState).toBe(1);
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });

  it('reports the current Largest Object on a filter-only update', () => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE', requestId: varint(1n), trackNamespace: namespace, trackName: name, parameters: new Map() });
    session.acceptSubscribe(1n, 4n, { parameters: new Map([[0x09n, [{ group: 1n, object: 0n }]]]) });
    session.setLargestLocationProvider(() => ({ group: 7n, object: 2n }));
    const actions = session.handleControlMessage({
      type: 'REQUEST_UPDATE', requestId: varint(3n), existingRequestId: 1n,
      parameters: new Map([[0x21n, [new Uint8Array([1, 0])]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'send_control', message: expect.objectContaining({
      type: 'REQUEST_OK', parameters: new Map([[0x09n, [{ group: 7n, object: 2n }]]]),
    }) }));
    expect(session.getIncomingSubscription(1n)!.locationWindow).toEqual({ start: { group: 8n, object: 0n } });
  });
  it('keeps the committed filter until REQUEST_OK and ignores a rejected replacement', () => {
    const session = established();
    const initial = { type: 'AbsoluteRange' as const, startGroup: 1n, startObject: 0n, endGroup: 2n };
    const replacement = { ...initial, endGroup: 9n };
    const { requestId } = session.subscribe(namespace, name, { subscriptionFilter: initial });
    session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: 4n, parameters: new Map(), trackExtensions: new Map() });
    const update = session.requestUpdate(requestId, { subscriptionFilter: replacement });
    expect(decodeSubscriptionFilter(session.getSubscription(requestId)!.currentFilter!, 22)).toEqual(initial);
    session.handleControlMessage({ type: 'REQUEST_ERROR', requestId: update.requestId, errorCode: 0n, errorReason: 'no', retryInterval: varint(0n) });
    expect(decodeSubscriptionFilter(session.getSubscription(requestId)!.currentFilter!, 22)).toEqual(initial);
    const retry = session.requestUpdate(requestId, { subscriptionFilter: replacement });
    session.handleControlMessage({ type: 'REQUEST_OK', requestId: retry.requestId, parameters: new Map() });
    expect(decodeSubscriptionFilter(session.getSubscription(requestId)!.currentFilter!, 22)).toEqual(replacement);
  });

  it('does not move an existing relative filter when an update omits it', () => {
    const session = established();
    session.handleControlMessage({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: namespace, trackName: name,
      parameters: new Map([[0x21n, [new Uint8Array([1, 0])]]]),
    });
    session.acceptSubscribe(1n, 4n, { parameters: new Map([[0x09n, [{ group: 5n, object: 0n }]]]) });
    session.setLargestLocationProvider(() => ({ group: 9n, object: 0n }));
    session.handleControlMessage({ type: 'REQUEST_UPDATE', requestId: 3n, existingRequestId: 1n,
      parameters: new Map([[0x10n, [0n]]]),
    });
    expect(session.getIncomingSubscription(1n)!.locationWindow).toEqual({ start: { group: 6n, object: 0n } });
  });
});

describe('draft-22 PUBLISH_STATE_NOTIFY', () => {
  it.each(['subscribe', 'publish'] as const)('preserves full-width Locations for %s-initiated subscriptions', (origin) => {
    const session = established();
    let requestId: bigint;
    if (origin === 'subscribe') {
      requestId = session.subscribe(namespace, name).requestId;
      session.handleControlMessage({ type: 'SUBSCRIBE_OK', requestId, trackAlias: 4n, parameters: new Map(), trackExtensions: new Map() });
    } else {
      requestId = 1n;
      session.handleControlMessage({ type: 'PUBLISH', requestId, trackAlias: 4n,
        trackNamespace: namespace, trackName: name, parameters: new Map(), trackProperties: new Map(),
      });
      session.acceptSubscribe(requestId, 4n);
    }
    const largest = { group: 0xffffffffffffffffn, object: 0xfffffffffffffffen };
    expect(session.handleControlMessage({ type: 'PUBLISH_STATE_NOTIFY', requestId, parameters: new Map([[0x09n, [largest]]]) })).toEqual([]);
    const sub = session.getSubscription(requestId) ?? session.getIncomingSubscription(requestId);
    expect(sub!.largestLocation).toEqual({ groupId: largest.group, objectId: largest.object });
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });
});

describe('draft-22 parameter contracts', () => {
  it('retains the initial PUBLISH Location Filter and requested Group Order', () => {
    const session = established();
    session.handleControlMessage({ type: 'PUBLISH', requestId: 1n, trackAlias: 4n,
      trackNamespace: namespace, trackName: name,
      parameters: new Map([[0x21n, [new Uint8Array([2, 2, 1])]], [0x22n, [2n]]]), trackProperties: new Map(),
    });
    session.acceptSubscribe(1n, 4n);
    const sub = session.getIncomingSubscription(1n)!;
    expect(sub.locationWindow).toEqual({ start: { group: 2n, object: 1n } });
    expect(sub.groupOrder).toBe('descending');
  });

  it('refuses to publish two different tracks on the same alias before allocating a request', () => {
    const session = established();
    session.publish(namespace, name, 4n);
    const other = new TextEncoder().encode('audio');
    expect(() => session.publish(namespace, other, 4n)).toThrow(/different track/);
    expect(session.publish(namespace, other, 5n).requestId).toBe(2n);
  });

  it('refuses acceptance on another live track alias without establishing the request', () => {
    const session = established();
    session.publish(namespace, name, 4n);
    session.handleControlMessage({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: namespace,
      trackName: new TextEncoder().encode('audio'), parameters: new Map(),
    });
    expect(() => session.acceptSubscribe(1n, 4n)).toThrow(/different track/);
    expect(session.getIncomingSubscription(1n)!.state).toBe('pending');
  });
  it('keeps PUBLISH Forward=0 on both sides of its parameterless acceptance', () => {
    const publisher = established();
    const { requestId } = publisher.publish(namespace, name, 4n, { parameters: new Map([[0x10n, [0n]]]) });
    publisher.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map() });
    expect(publisher.getOutgoingPublish(requestId)!.forwardState).toBe(0);

    const subscriber = established();
    subscriber.handleControlMessage({ type: 'PUBLISH', requestId: 1n, trackAlias: 4n,
      trackNamespace: namespace, trackName: name, parameters: new Map([[0x10n, [0n]]]), trackProperties: new Map(),
    });
    subscriber.acceptSubscribe(1n, 4n);
    expect(subscriber.getIncomingSubscription(1n)!.forwardState).toBe(0);
  });

  it('rejects an invalid INCLUDE_PROPERTIES value', () => {
    const session = established();
    const actions = session.handleControlMessage({ type: 'SUBSCRIBE', requestId: 1n,
      trackNamespace: namespace, trackName: name, parameters: new Map([[0x35n, [2n]]]),
    });
    expect(actions).toContainEqual(expect.objectContaining({ type: 'close_connection', error: 3n }));
  });

  it('accepts EXPIRES on PUBLISH_NAMESPACE_OK', () => {
    const session = established();
    const { requestId } = session.publishNamespace(namespace);
    expect(session.handleControlMessage({ type: 'REQUEST_OK', requestId, parameters: new Map([[0x08n, [1000n]]]) })).toEqual([]);
    expect(session.state).toBe(SessionState.ESTABLISHED);
  });
});
