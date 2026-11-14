import { acceptTestPublication, publicationMetadata } from './relay-publisher-test-support.js';
/**
 * Causal reds for the example relay's subscription-filter LIFETIME (draft-ietf-moq-transport-18 §5.1.2, §10.9.1):
 * the admission window must follow accepted REQUEST_UPDATEs (narrow, widen, relative re-anchor at processing time,
 * omitted filter = unchanged), be re-read for objects still queued when a narrowing update applies, and never come
 * into force for a subscription cancelled while its acceptance is still pending. Plus the MAX_VI64 endpoint of the
 * SDK's NextGroupStart window helper. Real SDK on both ends of the loopback.
 */
import { describe, expect, it } from 'vitest';
import { MAX_VI64, MessageParam, locationEncodingLength, subscriptionWindow, varint, windowContains, writeLocation } from '@openmoq/transport';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import type { MoqtObjectData, SubgroupHeader } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { Relay, type RelayOptions } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import type { TrackSubscribeOptions } from '../../../packages/webtransport/src/adapter.js';

type Loc = readonly [bigint, bigint];
let FIRST_OBJECT_DRAFT = 18;   // set per scenario: draft-16 wire has no FIRST_OBJECT flag
const ALIAS = 9n;
const show = (rows: readonly Loc[]) => rows.map(([g, o]) => `${g}/${o}`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));   // independent streams: set semantics
function data(groupId: bigint, objectId: bigint, subgroupId = 0n): MoqtObjectData {
  return { kind: 'data', trackAlias: ALIAS, groupId, subgroupId, objectId, publisherPriority: 128,
    isFirstObjectInSubgroup: FIRST_OBJECT_DRAFT >= 18 && objectId === 0n, payload: new Uint8Array([Number(groupId), Number(objectId)]) };
}
const header = (groupId: bigint, subgroupId = 0n): SubgroupHeader => ({ typeByte: 0x10, trackAlias: ALIAS, groupId, subgroupId,
  publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true });

type Draft = 16 | 18 | 22;
type Provider = ((requestId: bigint) => { group: bigint; object: bigint } | null) | 'none';
async function setup(options: RelayOptions = {}, draft: Draft = 18, provider?: Provider) {
  FIRST_OBJECT_DRAFT = draft;
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [];
  client.onError = server.onError = error => { errors.push(String(error)); };
  const relay = new Relay(options);
  server.onSubscribe = (requestId, namespace, name) => { void relay.handleSubscribe(server, requestId, namespace, name); };
  server.onSubscribeClosed = requestId => relay.removeSubscription(server, requestId);
  if (provider === undefined) server.setLargestLocationProvider(requestId => relay.currentLargestFor(server, requestId));   // as examples/node-relay/src/server.ts:147
  else if (provider !== 'none') server.setLargestLocationProvider(provider);
  const control: Array<Record<string, unknown>> = [];
  client.onMessage = m => { control.push(m as unknown as Record<string, unknown>); };
  relay.setupConnection(server);
  await Promise.all([client.connect(a), server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
  const publish: IncomingPublish = { ...publicationMetadata(), requestId: 1n, trackNamespace: nsBytes([...DEMO_NAMESPACE]), trackName: te(DEMO_TRACK),
    trackAlias: ALIAS, onObject: null, onSubgroupClosed: null };
  await acceptTestPublication(relay, publish);
  const received: Loc[] = [];
  const close = async () => { await client.close(); await server.close(); await flush(16); };
  const subscribe = async (filter?: TrackSubscribeOptions['filter']) => {
    const sub = await client.subscribeTrack(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK), filter ? { filter } : undefined);
    sub.onObject = obj => { if (obj.kind === 'data') received.push([obj.groupId, obj.objectId]); };
    await flush(64);
    if (typeof provider === 'function') server.setLargestLocationProvider(provider);
    return sub;
  };
  const publishAll = async (...objects: MoqtObjectData[]) => { for (const o of objects) publish.onObject?.(o); await flush(64); };
  const since = (mark: number) => received.slice(mark);
  return { a, b, client, server, relay, publish, received, errors, close, subscribe, publishAll, since, control };
}

describe.each([16, 18, 22] as const)('draft-%i: relay admission window follows the subscription lifetime (§5.1.2, §10.9.1)', draft => {
  it('NARROW: after an accepted REQUEST_UPDATE raising the start, objects below the new start published afterwards are not forwarded', async () => {
    const f = await setup({}, draft);
    try {
      const sub = await f.subscribe();                                   // unfiltered: window {0,0}
      await f.publishAll(data(5n, 0n), data(5n, 1n), data(5n, 2n));     // received after the SUBSCRIBE (§10.7)
      expect(show(f.received)).toEqual(['5/0', '5/1', '5/2']);
      await f.client.requestUpdate(sub.requestId, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 7n, startObject: 0n } });
      await flush(64);
      const mark = f.received.length;
      await f.publishAll(data(5n, 3n), data(6n, 0n), data(7n, 0n));
      expect(show(f.since(mark))).toEqual(['7/0']);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('WIDEN: after an accepted REQUEST_UPDATE raising the end group, groups up to the new end are forwarded and the one past it is not', async () => {
    const f = await setup({}, draft);
    try {
      const sub = await f.subscribe({ type: 'AbsoluteRange', startGroup: 5n, startObject: 1n, endGroup: 5n });
      await f.publishAll(data(5n, 0n), data(5n, 1n), data(5n, 2n));     // received after the SUBSCRIBE; 5/0 is below the start
      expect(show(f.received)).toEqual(['5/1', '5/2']);
      await f.client.requestUpdate(sub.requestId, { subscriptionFilter: { type: 'AbsoluteRange', startGroup: 5n, startObject: 1n, endGroup: 7n } });
      await flush(64);
      const mark = f.received.length;
      await f.publishAll(data(5n, 3n), data(6n, 0n), data(7n, 0n), data(8n, 0n));
      expect(show(f.since(mark))).toEqual(['5/3', '6/0', '7/0']);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('control — an update that omits the filter leaves a relative window where it was anchored (not re-anchored, not widened)', async () => {
    const f = await setup({}, draft);
    try {
      await f.publishAll(data(5n, 0n), data(5n, 1n), data(5n, 2n));
      const sub = await f.subscribe({ type: 'NextGroupStart' });          // anchored at Largest {5,2} → start {6,0}
      await f.publishAll(data(5n, 3n));                                   // Largest advances to {5,3}
      await f.client.requestUpdate(sub.requestId, { subscriberPriority: 3n as never });
      await flush(64);
      await f.publishAll(data(5n, 4n), data(6n, 0n));
      expect(show(f.received)).toEqual(['6/0']);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('RELATIVE RE-ANCHOR: an update carrying a relative filter is resolved against the Largest Location at processing time', async () => {
    const f = await setup({}, draft);
    try {
      await f.publishAll(data(5n, 0n), data(5n, 1n), data(5n, 2n));
      const sub = await f.subscribe({ type: 'NextGroupStart' });          // start {6,0}
      await f.publishAll(data(5n, 3n));                                   // Largest {5,3}
      await f.client.requestUpdate(sub.requestId, { subscriptionFilter: { type: 'LargestObject' } });   // → start {5,4}
      await flush(64);
      await f.publishAll(data(5n, 4n), data(5n, 5n), data(6n, 0n));
      expect(show(f.received)).toEqual(['5/4', '5/5', '6/0']);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('QUEUED BEFORE NARROW: an object admitted but still queued behind the subgroup budget is re-checked against the window in force when it is sent', async () => {
    const f = await setup({ maxConcurrentSubgroupsPerSubscription: 1 }, draft);
    try {
      const sub = await f.subscribe();                                   // unfiltered
      // Three subgroups, one allowed open at a time: 7/0 and 8/0 queue behind subgroup 6/0 until it closes.
      await f.publishAll(data(6n, 0n, 0n), data(7n, 0n, 0n), data(8n, 0n, 0n));
      expect(show(f.received)).toEqual(['6/0']);
      await f.client.requestUpdate(sub.requestId, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 8n, startObject: 0n } });
      await flush(64);
      f.publish.onSubgroupClosed?.(header(6n)); await flush(64);
      f.publish.onSubgroupClosed?.(header(7n)); await flush(64);
      f.publish.onSubgroupClosed?.(header(8n)); await flush(64);
      expect(show(f.received)).toEqual(['6/0', '8/0']);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
  it('PENDING-ACCEPT CANCELLATION: a subscription unsubscribed while the relay is still accepting it never becomes a forwarding subscriber', async () => {
    const f = await setup({}, draft);
    try {
      await f.publishAll(data(5n, 0n));
      let requestId: bigint | null = null;
      const pending = f.client.subscribe(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK), { onRequestId: (id: bigint) => { requestId = id; } } as never);
      void pending.catch(() => {});
      expect(requestId).not.toBeNull();
      await f.client.unsubscribe(requestId!);                             // before the relay's acceptSubscribe await settles
      await flush(128);
      const streamsBefore = f.b.uniOut.length;
      await f.publishAll(data(6n, 0n), data(7n, 0n));
      expect(f.b.uniOut.length, 'no data stream opened towards a cancelled subscriber').toBe(streamsBefore);
      expect(f.received).toEqual([]);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});


describe('draft-22 RelativeStart', () => {
  it('control — RelativeStart one group back starts at the current group head (0 is refused by the SDK as NextGroupStart)', async () => {
    const f = await setup({}, 22);
    try {
      // Stored history {5/1, 5/2} (Largest {5,2}). The head 5/0 and an Object of the previous group then arrive late.
      await f.publishAll(data(5n, 1n, 1n), data(5n, 2n, 2n));
      // The SDK encoder refuses RelativeStart 0 ("0 is NextGroupStart"); 1 group back = the current group from its start.
      await f.subscribe({ type: 'RelativeStart', groups: 1n } as never);
      expect(show(f.received)).toEqual([]);                              // history is not replayed (§10.7)
      await f.publishAll(data(5n, 0n, 0n), data(4n, 9n, 9n), data(5n, 3n, 3n), data(6n, 0n));
      expect(show(f.received)).toEqual(['5/0', '5/3', '6/0']);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});
