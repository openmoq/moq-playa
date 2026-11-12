import { acceptTestPublication, publicationMetadata } from './relay-publisher-test-support.js';
/**
 * Causal red: the example relay replays its stored cache onto a new SUBSCRIBE.
 *
 * draft-ietf-moq-transport-18 §10.7: "Subscribe only requests newly published or received Objects. Objects from the
 * past are retrieved using FETCH (Section 10.12)." §5.1.2: a filter selects among Objects "published or received via a
 * subscription"; AbsoluteStart's Start MAY be below Largest Object (late, reordered Objects below Largest can still be
 * newly received and pass). §5.1.3: to join a past Group the subscriber sends SUBSCRIBE followed by a Joining FETCH.
 * draft-16 §9.7 carries the same two sentences. No MUST NOT forbids the extra send (the only MUST NOT is "outside the
 * requested range"), so this is a semantics red, not a session-violation claim.
 *
 * Real SDK on both ends of an in-memory loopback (as relay-filter-window.test.ts). Objects stored BEFORE the SUBSCRIBE is
 * processed are history. Objects received after it (even below Largest, or while SUBSCRIBE_OK is being written) are new.
 */
import { describe, expect, it } from 'vitest';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import type { MoqtObject, MoqtObjectData } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { varint } from '@openmoq/transport';
import { Relay } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import type { TrackSubscribeOptions } from '../../../packages/webtransport/src/adapter.js';

const ALIAS = 9n;
type Draft = 16 | 18;
const data = (draft: Draft, groupId: bigint, subgroupId: bigint, objectId: bigint): MoqtObjectData => ({
  kind: 'data', trackAlias: ALIAS, groupId, subgroupId, objectId, publisherPriority: 128,
  isFirstObjectInSubgroup: draft >= 18, payload: new Uint8Array([Number(groupId), Number(objectId)]) });
const loc = (o: { groupId: bigint; objectId: bigint }) => `${o.groupId}/${o.objectId}`;
const sorted = (rows: readonly string[]) => [...rows].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

interface Options {
  readonly filter?: TrackSubscribeOptions['filter'];
  /** Published synchronously when the relay calls acceptSubscribe: after it computed Largest, before registration. */
  readonly duringAccept?: readonly [bigint, bigint, bigint][];
  readonly joiningFetch?: boolean;
}
async function scenario(draft: Draft, options: Options) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [];
  client.onError = server.onError = error => { errors.push(String(error)); };
  const relay = new Relay();
  server.onSubscribe = (requestId, namespace, name) => { void relay.handleSubscribe(server, requestId, namespace, name); };
  server.onSubscribeClosed = requestId => relay.removeSubscription(server, requestId);
  server.onFetch = (requestId, fetch) => { void relay.handleFetch(server, requestId, fetch); };
  server.setLargestLocationProvider(requestId => relay.currentLargestFor(server, requestId));
  const publish: IncomingPublish = { ...publicationMetadata(), requestId: 1n, trackNamespace: nsBytes([...DEMO_NAMESPACE]), trackName: te(DEMO_TRACK),
    trackAlias: ALIAS, onObject: null, onSubgroupClosed: null };
  const accept = server.acceptSubscribe.bind(server);
  let injected = false;
  server.acceptSubscribe = (async (...args: Parameters<typeof accept>) => {
    if (!injected) { injected = true; for (const [g, s, o] of options.duringAccept ?? []) publish.onObject?.(data(draft, g, s, o)); }
    return accept(...args);
  }) as typeof server.acceptSubscribe;
  const subscribed: string[] = [], fetched: string[] = [];
  try {
    await Promise.all([client.connect(a), server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
    await acceptTestPublication(relay, publish);
    // History: group 5 Objects 0 and 2 (separate subgroups) are stored before the SUBSCRIBE exists. Largest = {5,2}.
    publish.onObject?.(data(draft, 5n, 0n, 0n));
    publish.onObject?.(data(draft, 5n, 2n, 2n));
    // Cache-only FETCH cannot certify a missing Object; make this positive
    // history control contiguous, leaving sparse SUBSCRIBE cases unchanged.
    if (options.joiningFetch) publish.onObject?.(data(draft, 5n, 1n, 1n));
    await flush();
    const sub = await client.subscribeTrack(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK), options.filter ? { filter: options.filter } : undefined);
    sub.onObject = obj => { if (obj.kind === 'data') subscribed.push(loc(obj)); };
    await flush(64);
    const afterSubscribe = subscribed.slice();
    if (options.joiningFetch) {
      await client.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: sub.requestId, joiningStart: 5n,
        receiver: { onObject: (obj: MoqtObject) => { if (obj.kind === 'data') fetched.push(loc(obj)); } } });
      await flush(64);
    }
    // New after the SUBSCRIBE: a late Object BELOW Largest (5/1 on its own subgroup), the next Object, the next Group.
    publish.onObject?.(data(draft, 5n, 1n, 1n));
    publish.onObject?.(data(draft, 5n, 3n, 3n));
    publish.onObject?.(data(draft, 6n, 0n, 0n));
    await flush(64);
    return { largest: sub.initialLargestLocation, afterSubscribe: sorted(afterSubscribe), all: sorted(subscribed), fetched: sorted(fetched), errors };
  } finally { await client.close(); await server.close(); await flush(16); }
}

describe.each([18, 16] as const)('draft-%i: SUBSCRIBE carries newly published or received Objects only (§10.7)', draft => {
  it('RED: Objects stored before an AbsoluteStart{5,0} SUBSCRIBE is processed are not delivered by that SUBSCRIBE', async () => {
    const r = await scenario(draft, { filter: { type: 'AbsoluteStart', startGroup: 5n, startObject: 0n } });
    expect(r.errors).toEqual([]);
    expect(r.largest).toEqual({ groupId: 5n, objectId: 2n });   // the SUBSCRIBE_OK snapshot
    expect(r.afterSubscribe, 'history arrived on the subscription').toEqual([]);
    expect(r.all).toEqual(['5/1', '5/3', '6/0']);
  });
  it('RED: an unfiltered SUBSCRIBE likewise does not replay stored history', async () => {
    const r = await scenario(draft, {});
    expect(r.errors).toEqual([]);
    expect(r.afterSubscribe).toEqual([]);
    expect(r.all).toEqual(['5/1', '5/3', '6/0']);
  });
  it('control: a newly received Object below Largest inside the explicit window is forwarded (5/1 < Largest 5/2)', async () => {
    const r = await scenario(draft, { filter: { type: 'AbsoluteStart', startGroup: 5n, startObject: 0n } });
    expect(r.all).toContain('5/1');
  });
  it('control: Objects received while SUBSCRIBE_OK is being written are not lost, above or below Largest', async () => {
    const r = await scenario(draft, { filter: { type: 'AbsoluteStart', startGroup: 5n, startObject: 0n }, duringAccept: [[5n, 4n, 4n], [5n, 1n, 1n]] });
    expect(r.errors).toEqual([]);
    expect(r.largest).toEqual({ groupId: 5n, objectId: 2n });   // computed before the injection
    expect(r.all).toEqual(expect.arrayContaining(['5/4', '5/1']));
  });
});
