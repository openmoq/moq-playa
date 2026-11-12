import { describe, expect, it } from 'vitest';
import { createControlCodec } from '../control/codec.js';
import { Session } from './session.js';
import { EndpointRole, type SessionOutboundAction } from './types.js';
import { MessageParam, SetupParam } from '../control/parameters.js';
import type { Parameters } from '../control/messages.js';
import { varint } from '../primitives/varint.js';
import { locationEncodingLength, writeLocation } from '../primitives/location.js';

const ns = [Uint8Array.of(110)], name = Uint8Array.of(116);
function largest(draft: 16 | 18, group: bigint, object: bigint): Parameters {
  if (draft >= 18) return new Map([[MessageParam.LARGEST_OBJECT, [{ group, object }]]]);
  const location = { group: varint(group), object: varint(object) };
  const bytes = new Uint8Array(locationEncodingLength(location)); writeLocation(location, bytes, 0);
  return new Map([[MessageParam.LARGEST_OBJECT, [bytes]]]);
}
function deliver(actions: readonly SessionOutboundAction[], peer: Session): SessionOutboundAction[] {
  return actions.flatMap(a => a.type === 'send_control' ? peer.handleControlMessage(a.message) : []);
}
function sent(actions: readonly SessionOutboundAction[]): string[] {
  return actions.flatMap(a => a.type === 'send_control' ? [a.message.type] : a.type === 'close_connection' ? ['CLOSE'] : []);
}
function pair(draft: 16 | 18) {
  const client = new Session(EndpointRole.CLIENT, draft), server = new Session(EndpointRole.SERVER, draft);
  client.initiateSetup({ maxRequestId: varint(1000n) });
  server.handleControlMessage(draft >= 18 ? { type: 'SETUP', setupOptions: new Map() }
    : { type: 'CLIENT_SETUP', parameters: new Map([[SetupParam.MAX_REQUEST_ID, [varint(1000n)]]]) });
  deliver(server.completeSetup({ maxRequestId: varint(1000n) }), client);
  return { client, server };
}

describe.each([16, 18] as const)('draft %i', draft => {
  it('Joining FETCH after a NextGroupStart filter update ends at the SUBSCRIBE_OK Joining Location', () => {
    const { client, server } = pair(draft);
    const opened = client.subscribe(ns, name, { subscriptionFilter: { type: 'LargestObject' } });
    deliver(opened.actions, server);
    deliver(server.acceptSubscribe(opened.requestId, varint(7n), { parameters: largest(draft, 3n, 5n) }), client);
    server.setLargestLocationProvider(() => ({ group: 10n, object: 2n }));
    const update = client.requestUpdate(opened.requestId, { subscriptionFilter: { type: 'NextGroupStart' } });
    const okActions = deliver(update.actions, server);
    deliver(okActions, client);
    if (draft === 16) { // d16 §9.16.2: Joining FETCH needs a Largest Object filter; restore it first.
      const back = client.requestUpdate(opened.requestId, { subscriptionFilter: { type: 'LargestObject' } });
      deliver(deliver(back.actions, server), client);
    }
    const join = client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: opened.requestId, joiningStart: 0n });
    const joinResult = deliver(join.actions, server);
    expect(sent(joinResult)).not.toContain('CLOSE');
    const range = server.resolveIncomingJoiningFetch(join.requestId);
    // d16 §5.1 / d18 §5.1 + §10.12.2.1: end = {Joining Location.Group, Joining Location.Object + 1} = {3, 6}.
    expect(range.endLocation).toEqual({ group: 3n, object: 6n });
  });

  it('a publisher without a Largest Location provider refuses a NextGroupStart filter update', () => {
    const { client, server } = pair(draft);
    const opened = client.subscribe(ns, name, { subscriptionFilter: { type: 'LargestObject' } });
    deliver(opened.actions, server);
    deliver(server.acceptSubscribe(opened.requestId, varint(7n), { parameters: largest(draft, 3n, 5n) }), client);
    const update = client.requestUpdate(opened.requestId, { subscriptionFilter: { type: 'NextGroupStart' } });
    const response = sent(deliver(update.actions, server));
    expect(response).toEqual(['REQUEST_ERROR']);
  });
});

for (const draft of [16, 18] as const) describe(`draft${draft} filter update wire response`, () => {
  it.each([false, true])('reports a known head or refuses unknown head with provider=%s', provider => {
    const { client, server } = pair(draft);
    const opened = client.subscribe(ns, name, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n } });
    deliver(opened.actions, server);
    deliver(server.acceptSubscribe(opened.requestId, varint(7n)), client);
    if (provider) server.setLargestLocationProvider(() => ({ group: 5n, object: 0n }));
    const update = client.requestUpdate(opened.requestId, { subscriptionFilter: { type: 'NextGroupStart' } });
    const response = deliver(update.actions, server);
    expect(sent(response)).toEqual([provider ? 'REQUEST_OK' : 'REQUEST_ERROR']);
    for (const action of response) if (action.type === 'send_control') {
      expect(() => createControlCodec(draft).encode(action.message)).not.toThrow();
    }
    deliver(response, client);
    expect(client.getSubscription(opened.requestId)?.state).toBe('established');
  });
});
