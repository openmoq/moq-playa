import { describe, expect, it } from 'vitest';
import { Session } from './session.js';
import { EndpointRole, type SessionOutboundAction } from './types.js';
import { MessageParam, SetupParam } from '../control/parameters.js';
import type { Parameters } from '../control/messages.js';
import { MAX_VARINT, varint } from '../primitives/varint.js';
import { MAX_VI64 } from '../primitives/vi64.js';
import { locationEncodingLength, writeLocation } from '../primitives/location.js';
import { subscriptionWindow, windowContains } from '../control/subscription-filter.js';
import { resolveFillWindow } from '../control/fill-parameters.js';
import type { DraftVersion } from '../versions.js';

const ns = [Uint8Array.of(110)], name = Uint8Array.of(116);
function parameters(draft: DraftVersion, group: bigint | undefined): Parameters {
  if (group === undefined) return new Map();
  if (draft >= 18) return new Map([[MessageParam.LARGEST_OBJECT, [{ group, object: 5n }]]]);
  const location = { group: varint(group), object: varint(5n) };
  const bytes = new Uint8Array(locationEncodingLength(location)); writeLocation(location, bytes, 0);
  return new Map([[MessageParam.LARGEST_OBJECT, [bytes]]]);
}
function deliver(actions: readonly SessionOutboundAction[], peer: Session): SessionOutboundAction[] {
  expect(actions.filter(a => a.type === 'close_connection')).toEqual([]);
  const result = actions.flatMap(a => a.type === 'send_control' ? peer.handleControlMessage(a.message) : []);
  expect(result.filter(a => a.type === 'close_connection')).toEqual([]);
  return result;
}
function pair(draft: DraftVersion) {
  const client = new Session(EndpointRole.CLIENT, draft), server = new Session(EndpointRole.SERVER, draft);
  client.initiateSetup({ maxRequestId: varint(1000n) });
  server.handleControlMessage(draft >= 18 ? { type: 'SETUP', setupOptions: new Map() }
    : { type: 'CLIENT_SETUP', parameters: new Map([[SetupParam.MAX_REQUEST_ID, [varint(1000n)]]]) });
  const setup = server.completeSetup({ maxRequestId: varint(1000n) });
  deliver(setup, client);
  expect(client.state).toBe('established'); expect(server.state).toBe('established');
  return { client, server };
}

for (const draft of [14, 16, 18, 22] as const) describe(`draft${draft} Session NextGroupStart`, () => {
  const ceiling = draft >= 18 ? MAX_VI64 : MAX_VARINT;
  for (const head of [undefined, 5n, ceiling - 1n, ceiling]) {
    it(`${draft !== 22 ? 'establishment' : 'establishment and confirmed update'} use the correct boundary at ${head ?? 'empty'}`, () => {
      const { client, server } = pair(draft);
      const opened = client.subscribe(ns, name, { subscriptionFilter: { type: 'NextGroupStart' } });
      deliver(opened.actions, server);
      const responses = server.acceptSubscribe(opened.requestId, varint(7n), { parameters: parameters(draft, head) });
      deliver(responses, client);
      const incoming = server.getIncomingSubscription(opened.requestId)!;
      const outgoing = client.getSubscription(opened.requestId)!;
      expect(incoming.state).toBe('established'); expect(outgoing.state).toBe('established');
      const expected = head === undefined ? 0n : draft === 22 && head === MAX_VI64 ? MAX_VI64 : head + 1n;
      for (const owner of [outgoing]) {
        expect(owner.locationWindow?.start).toEqual({ group: expected, object: 0n });
        expect(windowContains(owner.locationWindow!, ceiling, 0n)).toBe(expected <= ceiling);
      }
      if (draft !== 22) return; // Only draft22 resolves the publisher head on filter-only updates.
      // Change away, then confirm NextGroupStart from the actual source head.
      server.setLargestLocationProvider(() => head === undefined ? null : { group: head, object: 5n });
      const absolute = client.requestUpdate(opened.requestId, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n } });
      deliver(deliver(absolute.actions, server), client);
      const update = client.requestUpdate(opened.requestId, { subscriptionFilter: { type: 'NextGroupStart' } });
      deliver(deliver(update.actions, server), client);
      expect(server.getIncomingSubscription(opened.requestId)).toBe(incoming);
      expect(client.getSubscription(opened.requestId)).toBe(outgoing);
      expect(outgoing.locationWindow?.start).toEqual({ group: expected, object: 0n });
    });
  }
});

it('two-argument helper preserves documented draft22 saturation', () => {
  const window = subscriptionWindow({ type: 'NextGroupStart' }, { group: MAX_VI64, object: 5n });
  expect(window.start).toEqual({ group: MAX_VI64, object: 0n });
  expect(windowContains(window, MAX_VI64, 0n)).toBe(true);
});
it('draft22 finite fill at MAX retains the clamped current Group', () => {
  expect(resolveFillWindow({ type: 'NextGroupStart' }, { group: MAX_VI64, object: 5n }))
    .toEqual({ start: { group: MAX_VI64, object: 0n }, end: { group: MAX_VI64, object: 5n } });
});
it('draft22 next-Group fill below MAX and empty-track fill have no finite content', () => {
  expect(resolveFillWindow({ type: 'NextGroupStart' }, { group: 5n, object: 5n })).toBeNull();
  expect(resolveFillWindow({ type: 'NextGroupStart' }, undefined)).toBeNull();
});

it('draft18 confirmed update at MAX preserves exact request and excludes the previous Group', () => {
  const { client, server } = pair(18);
  const opened = client.subscribe(ns, name, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n } });
  deliver(opened.actions, server);
  deliver(server.acceptSubscribe(opened.requestId, varint(7n), { parameters: parameters(18, MAX_VI64) }), client);
  const incoming = server.getIncomingSubscription(opened.requestId)!;
  const outgoing = client.getSubscription(opened.requestId)!;
  const update = client.requestUpdate(opened.requestId, { subscriptionFilter: { type: 'NextGroupStart' } });
  client.handleControlMessage({ type: 'REQUEST_OK', requestId: update.requestId, parameters: parameters(18, MAX_VI64) });
  expect(server.getIncomingSubscription(opened.requestId)).toBe(incoming);
  expect(client.getSubscription(opened.requestId)).toBe(outgoing);
  for (const owner of [outgoing]) {
    expect(owner.locationWindow?.start).toEqual({ group: MAX_VI64 + 1n, object: 0n });
    expect(windowContains(owner.locationWindow!, MAX_VI64, 6n)).toBe(false);
  }
});
