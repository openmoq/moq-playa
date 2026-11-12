import { acceptTestPublication, publicationMetadata } from './relay-publisher-test-support.js';
/**
 * Bounded ownership of arrivals while a SUBSCRIBE is being accepted (draft-18 §10.7, §5.1.2, §10.11).
 * Arrivals after the Largest Location is fixed are new to the subscription: delivered exactly once, in arrival
 * order with FIN behind its Objects, never stored history; bounded by the per-subscription object and byte limits
 * (payload plus extension bytes); released at once on overflow, cancellation or connection
 * removal; and an overflow ends only that subscription (PUBLISH_DONE TOO_FAR_BEHIND), not the connection.
 */
import { describe, expect, it } from 'vitest';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import type { MoqtObjectData, SubgroupHeader } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { varint } from '@openmoq/transport';
import { Relay, type RelayOptions } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';

const ALIAS = 9n;
type Draft = 14 | 16 | 18 | 22;
const data = (draft: Draft, g: bigint, s: bigint, o: bigint, properties?: Uint8Array): MoqtObjectData => ({ kind: 'data', trackAlias: ALIAS,
  groupId: g, subgroupId: s, objectId: o, publisherPriority: 128, isFirstObjectInSubgroup: draft >= 18,
  payload: new Uint8Array([Number(g), Number(o)]), ...(properties ? { properties } : {}) });
const header = (g: bigint, s: bigint): SubgroupHeader => ({ typeByte: 0x10, trackAlias: ALIAS, groupId: g, subgroupId: s, publisherPriority: 128,
  hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true });
interface Hooks {
  readonly options?: RelayOptions;
  /** Arrivals while the acceptance is held. */
  readonly held?: (publish: IncomingPublish, relay: Relay, server: MoqtConnection) => void | Promise<void>;
  /** Runs synchronously inside the relay's openSubgroup call number `n` (1-based). */
  readonly onOpen?: (n: number, publish: IncomingPublish, relay: Relay, server: MoqtConnection) => void;
  readonly cancel?: boolean;
  /** Publish one more Object after the cancellation, before the acceptance settles. */
  readonly afterCancelArrival?: boolean;
}
async function scenario(draft: Draft, hooks: Hooks) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [], messages: { type: string; statusCode?: bigint | undefined }[] = [];
  client.onError = server.onError = e => { errors.push(String(e)); };
  client.onMessage = m => { messages.push({ type: m.type, statusCode: (m as { statusCode?: bigint }).statusCode }); };
  const relay = new Relay(hooks.options);
  server.onSubscribe = (r, n, t) => { void relay.handleSubscribe(server, r, n, t); };
  server.onSubscribeClosed = r => relay.removeSubscription(server, r);
  server.setLargestLocationProvider(r => relay.currentLargestFor(server, r));
  const publish: IncomingPublish = { ...publicationMetadata(), requestId: 1n, trackNamespace: nsBytes([...DEMO_NAMESPACE]), trackName: te(DEMO_TRACK), trackAlias: ALIAS,
    onObject: null, onSubgroupClosed: null };
  const sent: string[] = [];
  const open = server.openSubgroup.bind(server), send = server.sendObject.bind(server), close = server.closeSubgroup.bind(server);
  const lanes = new Map<bigint, string>();
  let opens = 0;
  server.openSubgroup = ((alias: bigint, g: bigint, s: bigint, o?: never) => {
    const n = ++opens; const p = open(alias, g, s, o);
    hooks.onOpen?.(n, publish, relay, server);   // synchronous, inside the relay's hand-over
    return p.then(id => { lanes.set(id, `${g}/${s}`); return id; });
  }) as never;
  server.sendObject = (async (id: bigint, o: bigint, p: Uint8Array, e?: Uint8Array) => { sent.push(`obj ${lanes.get(id)?.split('/')[0]}/${o}@${lanes.get(id)}`); return send(id, o, p, e); }) as never;
  server.closeSubgroup = (async (id: bigint) => { sent.push(`fin ${lanes.get(id)}`); return close(id); }) as never;
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let requestId: bigint | null = null, entered = false;
  const accept = server.acceptSubscribe.bind(server);
  server.acceptSubscribe = (async (...args: Parameters<typeof accept>) => { entered = true; await gate; return accept(...args); }) as typeof server.acceptSubscribe;
  try {
    await Promise.all([client.connect(a), server.connect(b, draft <= 16 ? { maxRequestId: varint(1000n) } : {})]);
    await acceptTestPublication(relay, publish);
    publish.onObject?.(data(draft, 5n, 0n, 0n)); publish.onObject?.(data(draft, 5n, 2n, 2n));   // stored history; Largest {5,2}
    await flush();
    const pendingSub = client.subscribeTrack(nsBytes([...DEMO_NAMESPACE]), te(DEMO_TRACK),
      { filter: { type: 'AbsoluteStart', startGroup: 5n, startObject: 0n }, onRequestId: id => { requestId = id; } });
    pendingSub.catch(() => undefined);
    for (let i = 0; i < 50 && !entered; i++) await flush(4);
    expect(entered).toBe(true);
    await hooks.held?.(publish, relay, server);
    if (hooks.cancel) { await client.unsubscribe(requestId!).catch(() => undefined); await flush(32); }
    if (hooks.afterCancelArrival) { publish.onObject?.(data(draft, 5n, 9n, 9n)); }
    const stateBefore = client.session.state;
    release();
    await flush(64);
    publish.onObject?.(data(draft, 6n, 1n, 1n));   // live after the acceptance settled
    await flush(64);
    return { sent, errors, messages,
      sessionUnchanged: client.session.state === stateBefore };
  } finally { await client.close(); await server.close(); await flush(16); }
}
const objs = (sent: readonly string[]) => sent.filter(s => s.startsWith('obj ')).map(s => s.slice(4, s.indexOf('@')));
const done = (r: { messages: { type: string; statusCode?: bigint | undefined }[] }) => r.messages.filter(m => m.type === 'PUBLISH_DONE');
const tooFarBehind = (draft: Draft) => draft <= 16 ? 0x6n : 0x5n;

describe.each([14, 18, 16, 22] as const)('draft-%i: pending SUBSCRIBE acceptance owns its arrivals', draft => {
  it('accepted arrivals are delivered exactly once, in lane order with FIN last, and no stored history is sent', async () => {
    const r = await scenario(draft, { held: p => {
      p.onObject?.(data(draft, 5n, 3n, 3n)); p.onObject?.(data(draft, 5n, 1n, 1n)); p.onSubgroupClosed?.(header(5n, 3n));
      p.onObject?.(data(draft, 6n, 0n, 0n));
    } });
    expect(r.errors).toEqual([]);
    expect(objs(r.sent).sort()).toEqual(['5/1', '5/3', '6/0', '6/1']);   // each once; 5/1 is below Largest and new
    expect(r.sent.indexOf('fin 5/3')).toBeGreaterThan(r.sent.indexOf('obj 5/3@5/3'));
  });
  it('object-count overflow releases the queue at once and ends only that subscription with TOO_FAR_BEHIND', async () => {
    const r = await scenario(draft, { options: { maxPendingObjectsPerSubscription: 2 }, held: p => {
      for (const o of [3n, 4n, 5n]) p.onObject?.(data(draft, 5n, o, o));
    } });
    expect(r.sent).toEqual([]);
    expect(done(r).map(m => m.statusCode)).toEqual([tooFarBehind(draft)]);
    expect(r.sessionUnchanged, 'the connection is not punished').toBe(true);
    expect(r.errors).toEqual([]);
  });
  it('byte overflow counts extension bytes: the same Objects fit without properties and overflow with them', async () => {
    const plain = await scenario(draft, { options: { maxPendingBytesPerSubscription: 10 }, held: p => {
      for (const o of [3n, 4n, 5n]) p.onObject?.(data(draft, 5n, o, o));   // 3 x 2 payload bytes
    } });
    expect(done(plain)).toEqual([]);
    const withProps = await scenario(draft, { options: { maxPendingBytesPerSubscription: 10 }, held: p => {
      for (const o of [3n, 4n, 5n]) p.onObject?.(data(draft, 5n, o, o, new Uint8Array(4)));   // 3 x (2 + 4)
    } });
    expect(withProps.sent).toEqual([]);
    expect(done(withProps).map(m => m.statusCode)).toEqual([tooFarBehind(draft)]);
  });
  it('connection removal during acceptance releases at once; the late acceptance cannot resurrect it', async () => {
    const r = await scenario(draft, { held: (p, relay, server) => {
      p.onObject?.(data(draft, 5n, 3n, 3n)); relay.removeConn(server); p.onObject?.(data(draft, 6n, 0n, 0n));
    } });
    expect(r.sent).toEqual([]);
    expect(done(r)).toEqual([]);
  });
  it('cancellation during acceptance releases the queue before acceptance settles', async () => {
    const r = await scenario(draft, { held: p => { p.onObject?.(data(draft, 5n, 3n, 3n)); }, cancel: true, afterCancelArrival: true });
    expect(r.sent).toEqual([]);
  });
  it('an arrival during the hand-over joins behind the queued arrivals of its lane, exactly once', async () => {
    const r = await scenario(draft, {
      held: p => { p.onObject?.(data(draft, 5n, 3n, 3n)); p.onObject?.(data(draft, 5n, 3n, 4n)); },
      onOpen: (n, p) => { if (n === 1) p.onObject?.(data(draft, 5n, 3n, 5n)); },
    });
    expect(r.errors).toEqual([]);
    expect(r.sent.filter(s => s.endsWith('@5/3'))).toEqual(['obj 5/3@5/3', 'obj 5/4@5/3', 'obj 5/5@5/3']);
  });
  it('a removal during the hand-over stops it: nothing queued after the fence is dispatched', async () => {
    const r = await scenario(draft, {
      held: p => { p.onObject?.(data(draft, 5n, 3n, 3n)); p.onObject?.(data(draft, 6n, 0n, 0n)); },
      onOpen: (n, _p, relay, server) => { if (n === 1) relay.removeConn(server); },
    });
    expect(objs(r.sent)).not.toContain('6/0');
    expect(objs(r.sent)).not.toContain('6/1');
  });
});
