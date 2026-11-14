import { acceptTestPublication, publicationMetadata } from './relay-publisher-test-support.js';
/**
 * Objects that arrive while a SUBSCRIBE's acceptance is pending (after handleSubscribe began, before the
 * subscriber is registered) are newly received for that subscription (draft-18 §10.7, §5.1.2) and must reach it,
 * with their subgroup FIN after their Objects, unless the acceptance is rejected or cancelled.
 * The example relay recovers them from its latest-group cache, which loses them once the cache rotates to a new group.
 */
import { describe, expect, it } from 'vitest';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import type { MoqtObjectData, SubgroupHeader } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { varint } from '@openmoq/transport';
import { Relay } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';

const ALIAS = 9n;
type Draft = 16 | 18 | 22;
const data = (draft: Draft, g: bigint, s: bigint, o: bigint): MoqtObjectData => ({ kind: 'data', trackAlias: ALIAS, groupId: g,
  subgroupId: s, objectId: o, publisherPriority: 128, isFirstObjectInSubgroup: draft >= 18, payload: new Uint8Array([Number(g), Number(o)]) });
const header = (g: bigint, s: bigint): SubgroupHeader => ({ typeByte: 0x10, trackAlias: ALIAS, groupId: g, subgroupId: s, publisherPriority: 128,
  hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true });

type Held = (publish: IncomingPublish, draft: Draft) => void;
async function scenario(draft: Draft, held: Held, mode: 'accept' | 'reject' | 'cancel' | 'cancel-after-ok' = 'accept') {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [];
  client.onError = server.onError = e => { errors.push(String(e)); };
  const relay = new Relay();
  server.onSubscribe = (r, n, t) => { void relay.handleSubscribe(server, r, n, t); };
  server.onSubscribeClosed = r => relay.removeSubscription(server, r);
  server.setLargestLocationProvider(r => relay.currentLargestFor(server, r));
  const publish: IncomingPublish = { ...publicationMetadata(), requestId: 1n, trackNamespace: nsBytes([...DEMO_NAMESPACE]), trackName: te(DEMO_TRACK), trackAlias: ALIAS,
    onObject: null, onSubgroupClosed: null };
  // Server-side evidence: what the relay actually sent on this connection.
  const sent: string[] = [];
  const open = server.openSubgroup.bind(server), send = server.sendObject.bind(server), close = server.closeSubgroup.bind(server);
  const lanes = new Map<bigint, string>();
  server.openSubgroup = (async (alias: bigint, g: bigint, s: bigint, o?: never) => { const id = await open(alias, g, s, o); lanes.set(id, `${g}/${s}`); return id; }) as never;
  server.sendObject = (async (id: bigint, o: bigint, p: Uint8Array, e?: Uint8Array) => { sent.push(`obj ${lanes.get(id)?.split('/')[0]}/${o}`); return send(id, o, p, e); }) as never;
  server.closeSubgroup = (async (id: bigint) => { sent.push(`fin ${lanes.get(id)}`); return close(id); }) as never;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let requestId: bigint | null = null, entered = false;
  const accept = server.acceptSubscribe.bind(server);
  server.acceptSubscribe = (async (...args: Parameters<typeof accept>) => {
    entered = true;
    await gate;   // acceptance held: Largest was already computed by handleSubscribe
    if (mode === 'reject') throw new Error('acceptance rejected by test');
    const result = await accept(...args);
    // SUBSCRIBE_OK is written; the subscriber cancels before the relay's continuation registers it.
    if (mode === 'cancel-after-ok') { await client.unsubscribe(requestId!).catch(() => undefined); await flush(32); }
    return result;
  }) as typeof server.acceptSubscribe;
  try {
    relay.setupConnection(server);
    await Promise.all([client.connect(a), server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
    await acceptTestPublication(relay, publish);
    publish.onObject?.(data(draft, 5n, 0n, 0n)); publish.onObject?.(data(draft, 5n, 2n, 2n));   // history; Largest {5,2}
    await flush();
    const pending = client.subscribeTrack(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK),
      { filter: { type: 'AbsoluteStart', startGroup: 5n, startObject: 0n }, onRequestId: id => { requestId = id; } });
    pending.catch(() => undefined);
    for (let i = 0; i < 50 && !entered; i++) await flush(4);
    expect(entered, 'relay reached acceptSubscribe').toBe(true);
    held(publish, draft);                            // arrivals while acceptance is pending
    if (mode === 'cancel') { await client.unsubscribe(requestId!).catch(() => undefined); await flush(32); }
    release();
    await flush(64);
    publish.onObject?.(data(draft, 6n, 1n, 1n));     // live after registration
    await flush(64);
    return { sent, errors };
  } finally { await client.close(); await server.close(); await flush(16); }
}
const objs = (sent: readonly string[]) => sent.filter(s => s.startsWith('obj ')).map(s => s.slice(4)).sort();

describe.each([18, 16, 22] as const)('draft-%i: arrivals during a pending SUBSCRIBE acceptance', draft => {
  it('RED: a tail Object, its FIN and a following group all arriving during acceptance reach the subscriber (cache rotation)', async () => {
    const r = await scenario(draft, (p, d) => {
      p.onObject?.(data(d, 5n, 3n, 3n)); p.onSubgroupClosed?.(header(5n, 3n));   // new tail of group 5, then its FIN
      p.onObject?.(data(d, 6n, 0n, 0n));                                         // the cache rotates to group 6
    });
    expect(r.errors).toEqual([]);
    expect(objs(r.sent)).toEqual(expect.arrayContaining(['5/3', '6/0', '6/1']));
    const i = r.sent.indexOf('obj 5/3'), f = r.sent.indexOf('fin 5/3');
    expect(f, 'FIN of the 5/3 subgroup forwarded').toBeGreaterThan(-1);
    expect(f, 'FIN after its Object').toBeGreaterThan(i);
  });
  it('control: without rotation, arrivals during acceptance (5/3 with FIN, 5/1 below Largest) reach the subscriber', async () => {
    const r = await scenario(draft, (p, d) => {
      p.onObject?.(data(d, 5n, 3n, 3n)); p.onSubgroupClosed?.(header(5n, 3n)); p.onObject?.(data(d, 5n, 1n, 1n));
    });
    expect(r.errors).toEqual([]);
    expect(objs(r.sent)).toEqual(expect.arrayContaining(['5/1', '5/3', '6/1']));
    expect(r.sent.indexOf('fin 5/3')).toBeGreaterThan(r.sent.indexOf('obj 5/3'));
  });
  it('control: a rejected acceptance sends nothing, before or after, and registers no subscriber', async () => {
    const r = await scenario(draft, (p, d) => { p.onObject?.(data(d, 5n, 3n, 3n)); p.onObject?.(data(d, 6n, 0n, 0n)); }, 'reject');
    expect(r.sent).toEqual([]);
  });
  it('control: a subscription cancelled while its acceptance is pending receives nothing (acceptSubscribe then fails)', async () => {
    const r = await scenario(draft, (p, d) => { p.onObject?.(data(d, 5n, 3n, 3n)); p.onObject?.(data(d, 6n, 0n, 0n)); }, 'cancel');
    expect(r.sent).toEqual([]);
  });
  it('control: cancelled after SUBSCRIBE_OK is written but before registration: not registered, nothing sent', async () => {
    const r = await scenario(draft, (p, d) => { p.onObject?.(data(d, 5n, 3n, 3n)); p.onObject?.(data(d, 6n, 0n, 0n)); }, 'cancel-after-ok');
    expect(r.sent).toEqual([]);
  });
});
