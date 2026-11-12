import { acceptTestPublication, publicationMetadata } from './relay-publisher-test-support.js';
/**
 * Causal red for the example relay's subscription-filter forwarding (draft-ietf-moq-transport-18 §5.1.2).
 *
 * Real SDK on both ends of an in-memory loopback: a CLIENT MoqtConnection subscribes through a SERVER MoqtConnection
 * whose onSubscribe is the Relay. The relay sees the SDK's decoded filter (Subscription.remoteFilterType) and the
 * Largest Location it itself communicated in SUBSCRIBE_OK; the client observes exactly which objects are forwarded.
 *
 *   Next Group Start (0x1): Start Location {Largest.Group + 1, 0}            → nothing of the current group, ever
 *   Largest Object (0x2):   Start Location {Largest.Group, Largest.Object+1} → no cached replay, live tail passes
 *   AbsoluteStart (0x3):    explicit start, open ended
 *   AbsoluteRange (0x4):    explicit start, End Group Delta 0 = remainder of that group only
 *
 * A SUBSCRIBE carries only Objects published or received after it is processed (§10.7); Objects stored before it
 * are history for FETCH. Windows that start below Largest are exercised with Objects that arrive late, after the
 * SUBSCRIBE, at Locations below Largest (§5.1.2).
 */
import { describe, expect, it } from 'vitest';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import type { MoqtObjectData, SubgroupHeader } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { varint } from '@openmoq/transport';
import { Relay } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import type { TrackSubscribeOptions } from '../../../packages/webtransport/src/adapter.js';

type Loc = readonly [bigint, bigint];
let FIRST_OBJECT_DRAFT = 18;   // set per scenario: draft-16 wire has no FIRST_OBJECT flag
const ALIAS = 9n;
function data(groupId: bigint, objectId: bigint, extra: Partial<MoqtObjectData> = {}): MoqtObjectData {
  return { kind: 'data', trackAlias: ALIAS, groupId, subgroupId: 0n, objectId, publisherPriority: 128,
    isFirstObjectInSubgroup: FIRST_OBJECT_DRAFT >= 18 && objectId === 0n, payload: new Uint8Array([Number(groupId), Number(objectId)]), ...extra };
}
function header(groupId: bigint): SubgroupHeader {
  return { typeByte: 0x10, trackAlias: ALIAS, groupId, subgroupId: 0n, publisherPriority: 128, hasExtensions: false,
    isEndOfGroup: false, isFirstObjectInSubgroup: true };
}
type Draft = 16 | 18 | 22;
interface Arrivals {
  /** Stored before the SUBSCRIBE is processed. */
  readonly history?: readonly Loc[];
  /** Received after the SUBSCRIBE, before the live tail: late, reordered Objects (own subgroups). */
  readonly late?: readonly Loc[];
}
async function scenario(filter: TrackSubscribeOptions['filter'], draft: Draft = 18, arrivals: Arrivals = {}) {
  FIRST_OBJECT_DRAFT = draft;
  const { a, b } = createLoopback();
  // Incomplete eligible prefixes now reset; the loopback binding owns the code.
  Object.assign(b, { createStreamError: (code: number) => Object.assign(new Error('loopback reset'), { streamErrorCode: code }) });
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [];
  client.onError = server.onError = error => { errors.push(String(error)); };
  const relay = new Relay();
  let seenFilter: string | undefined;
  server.onSubscribe = (requestId, namespace, name) => {
    seenFilter = server.session.getIncomingSubscription(requestId)?.remoteFilterType;   // the SDK's decoded filter
    void relay.handleSubscribe(server, requestId, namespace, name);
  };
  server.onSubscribeClosed = requestId => relay.removeSubscription(server, requestId);
  server.setLargestLocationProvider(requestId => relay.currentLargestFor(server, requestId));   // as examples/node-relay/src/server.ts:147
  const received: Loc[] = [];
  try {
    await Promise.all([client.connect(a), server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
    const publish: IncomingPublish = { ...publicationMetadata(), requestId: 1n, trackNamespace: nsBytes([...DEMO_NAMESPACE]), trackName: te(DEMO_TRACK),
      trackAlias: ALIAS, onObject: null, onSubgroupClosed: null };
    await acceptTestPublication(relay, publish);
    // Current group 5 is OPEN: objects 0..2 published (cached) by default, its tail still to come.
    for (const [g, o] of arrivals.history ?? [[5n, 0n], [5n, 1n], [5n, 2n]]) publish.onObject?.(data(g, o));
    await flush();
    const sub = await client.subscribeTrack(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK), filter ? { filter } : undefined);
    sub.onObject = obj => { if (obj.kind === 'data') received.push([obj.groupId, obj.objectId]); };
    await flush(64);
    const afterSubscribe = received.slice();
    for (const [g, o] of arrivals.late ?? []) publish.onObject?.(data(g, o, { subgroupId: 100n + o }));
    await flush(64);
    // Live tail of the current group, then its close, then the next group.
    for (const o of [3n, 4n]) publish.onObject?.(data(5n, o));
    publish.onSubgroupClosed?.(header(5n));
    await flush(64);
    const afterTail = received.slice();
    for (const o of [0n, 1n]) publish.onObject?.(data(6n, o));
    await flush(64);
    for (const o of [0n]) publish.onObject?.(data(7n, o));
    await flush(64);
    return { largest: sub.initialLargestLocation, seenFilter, afterSubscribe, afterTail, all: received.slice(), errors };
  } finally { await client.close(); await server.close(); await flush(16); }
}
const show = (rows: readonly Loc[]) => rows.map(([g, o]) => `${g}/${o}`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));   // independent streams: set semantics

describe.each([16, 18, 22] as const)('draft-%i: example relay forwards exactly what the subscription filter admits (§5.1.2)', draft => {
  it('Next Group Start: no object of the current group (cached or live tail); the first forwarded object is {Largest.Group+1, 0}', async () => {
    const r = await scenario({ type: 'NextGroupStart' }, draft);
    expect(r.errors).toEqual([]);
    expect(r.seenFilter).toBe('NextGroupStart');
    expect(r.largest).toEqual({ groupId: 5n, objectId: 2n });
    expect(show(r.afterSubscribe)).toEqual([]);
    expect(show(r.afterTail)).toEqual([]);
    expect(show(r.all)).toEqual(['6/0', '6/1', '7/0']);
  });
  it('control — Largest Object: nothing cached is replayed, the live tail after Largest passes, following groups pass', async () => {
    const r = await scenario({ type: 'LargestObject' }, draft);
    expect(r.errors).toEqual([]);
    expect(r.seenFilter).toBe('LargestObject');
    expect(show(r.afterSubscribe)).toEqual([]);
    expect(show(r.all)).toEqual(['5/3', '5/4', '6/0', '6/1', '7/0']);
  });
  // Stored history {5/0, 5/2} (Largest {5,2}); 5/1 and 4/9 then arrive late, after the SUBSCRIBE.
  const gapped: Arrivals = { history: [[5n, 0n], [5n, 2n]], late: [[5n, 1n], [4n, 9n]] };
  it('control — AbsoluteStart {5,1} below Largest: a late Object at the start passes, an earlier one does not, open ended; history is not replayed', async () => {
    const r = await scenario({ type: 'AbsoluteStart', startGroup: 5n, startObject: 1n }, draft, gapped);
    expect(r.errors).toEqual([]);
    expect(r.seenFilter).toBe('AbsoluteStart');
    expect(r.largest).toEqual({ groupId: 5n, objectId: 2n });
    expect(show(r.afterSubscribe)).toEqual([]);
    expect(show(r.all)).toEqual(['5/1', '5/3', '5/4', '6/0', '6/1', '7/0']);
  });
  it('control — AbsoluteRange {5,1} end group 5 (delta 0): the remainder of group 5 only, nothing from later groups; history is not replayed', async () => {
    const r = await scenario({ type: 'AbsoluteRange', startGroup: 5n, startObject: 1n, endGroup: 5n }, draft, gapped);
    expect(r.errors).toEqual([]);
    expect(r.seenFilter).toBe('AbsoluteRange');
    expect(show(r.afterSubscribe)).toEqual([]);
    expect(show(r.all)).toEqual(['5/1', '5/3', '5/4']);
  });
  it('control — unfiltered subscribe: every Object received after it passes, including late ones from earlier groups; history is not replayed', async () => {
    const r = await scenario(undefined, draft, gapped);
    expect(r.errors).toEqual([]);
    expect(show(r.afterSubscribe)).toEqual([]);
    expect(show(r.all)).toEqual(['4/9', '5/1', '5/3', '5/4', '6/0', '6/1', '7/0']);
  });
});
