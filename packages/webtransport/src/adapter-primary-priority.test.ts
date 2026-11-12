import { varint } from '@openmoq/transport';
import { afterEach, describe, expect, it } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import type { WebTransportLike, WebTransportBidirectionalStream } from './types.js';

const ns = [new TextEncoder().encode('live')], name = new TextEncoder().encode('video');
const connections: MoqtConnection[] = [];
afterEach(async () => { for (const c of connections.splice(0)) await c.close(); await flush(32); });
type Witness = { rank: number; sets: number[]; writes: number[][]; ranks: number[]; group: object; aborts: number; gate?: Promise<void>; finGate?: Promise<void> };
type Mode = 'get-throw' | 'absent';
function instrument(w: WritableStream<Uint8Array>, rows: Witness[], mode: Mode = 'get-throw', reenter?: () => void) {
  const row: Witness = { rank: 0, sets: [], writes: [], ranks: [], group: {}, aborts: 0 }; rows.push(row);
  Object.defineProperty(w, 'sendGroup', { get: () => row.group, set: () => { throw new Error('group changed'); } });
  if (mode !== 'absent') {
    const prototype = Object.create(Object.getPrototypeOf(w));
    Object.defineProperty(prototype, 'sendOrder', {
    get() { throw new Error('Scheduling must not read back the hint'); },
    set(value: number) { row.sets.push(value); row.rank = value; reenter?.(); },
  });
    Object.setPrototypeOf(w, prototype);
  }
  const getWriter = w.getWriter.bind(w);
  w.getWriter = () => {
    const writer = getWriter(), write = writer.write.bind(writer), abort = writer.abort.bind(writer);
    writer.write = chunk => { if (mode === 'absent') expect('sendOrder' in w).toBe(false); if (!chunk) throw new Error('missing bytes'); row.ranks.push(row.rank); row.writes.push([...chunk]); return row.gate ? row.gate.then(() => write(chunk)) : write(chunk); };
    writer.abort = reason => { row.aborts++; return abort(reason); };
    const close = writer.close.bind(writer);
    writer.close = () => row.finGate ? row.finGate.then(() => close()) : close();
    return writer;
  };
  return row;
}
async function pair(draft: 14 | 16 | 18 | 22 = 18, mode: Mode = 'get-throw', onRank?: () => void) {
  const { a, b } = createLoopback();
  const rows = { uni: [] as Witness[], outgoing: [] as Witness[], incoming: [] as Witness[] };
  const incomingReader = b.incomingBidirectionalStreams.getReader();
  const transport: WebTransportLike = {
    incomingUnidirectionalStreams: b.incomingUnidirectionalStreams,
    incomingBidirectionalStreams: new ReadableStream<WebTransportBidirectionalStream>({ async pull(c) {
      const next = await incomingReader.read(); if (next.done) { c.close(); return; }
      instrument(next.value.writable, rows.incoming, mode, onRank); c.enqueue(next.value);
    } }),
    closed: b.closed, datagrams: b.datagrams, close: info => b.close(info),
    createUnidirectionalStream: async () => { const w = await b.createUnidirectionalStream(); instrument(w, rows.uni, mode, onRank); return w; },
    createBidirectionalStream: async () => { const s = await b.createBidirectionalStream(); instrument(s.writable, rows.outgoing, mode, onRank); return s; },
  };
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  connections.push(client, server);
  const errors: Error[] = []; client.onError = server.onError = e => errors.push(e);
  await Promise.all([client.connect(a, {maxRequestId: varint(1000n)}), server.connect(transport, {maxRequestId: varint(1000n)})]);
  server.setLargestLocationProvider(() => ({group: 1n, object: 0n}));
  return { client, server, a, b, transport, rows, errors };
}
async function subscription(p: Awaited<ReturnType<typeof pair>>) {
  p.server.onSubscribe = id => { void p.server.acceptSubscribe(id, 42n); };
  return p.client.subscribeTrack(ns, name, { filter: { type: 'NextGroupStart' } });
}
async function fetchOwner(p: Awaited<ReturnType<typeof pair>>) {
  let id = -1n; p.server.onFetch = value => { id = value; };
  await p.client.fetch(ns, name, { startGroup: 1n, startObject: 0n, endGroup: 1n, endObject: 2n });
  await flush(64); expect(id).not.toBe(-1n);
  await p.server.acceptFetch(id, { endLocation: { group: 1n, object: 2n } });
  return id;
}


describe('primary scheduling integration', () => {
  it.each([14, 16, 18, 22] as const)('draft %s: server control, applicable inbound request hint, and initial media rank', async draft => {
    const p = await pair(draft);
    const sub = await subscription(p);
    await p.server.openSubgroup(42n, 1n, 0n, { requestId: sub.requestId });
    const control = draft < 18 ? p.rows.incoming[0]! : p.rows.uni[0]!;
    expect(control.ranks[0]).toBe(1024);
    if (draft >= 18) expect(p.rows.incoming[0]!.ranks[0]).toBe(512);
    expect(p.rows.uni.at(-1)!.ranks[0]).toBe(127);
    await p.client.requestUpdate(sub.requestId, { subscriberPriority: varint(7n) });
    await flush(128);
    expect(p.rows.uni.at(-1)!.rank).toBe(248);
    expect(p.errors).toEqual([]);
  });
  it.each(['subscribe', 'publish', 'fetch'] as const)('updates %s pending FIN before ACK can settle', async kind => {
    const p = await pair();
    p.server.setLargestLocationProvider(() => ({group: 1n, object: 0n}));
    p.server.setFetchLargestLocationProvider(() => ({group: 1n, object: 2n}));
    let id: bigint;
    if (kind === 'fetch') id = await fetchOwner(p);
    else if (kind === 'subscribe') id = (await subscription(p)).requestId;
    else {
      p.client.onPublish = pub => { void p.client.acceptSubscribe(pub.requestId, pub.trackAlias); };
      id = await p.server.publish(ns, name, 42n); await flush(128);
      expect(p.rows.outgoing[0]!.ranks[0]).toBe(512);
    }
    const sid = kind === 'fetch' ? await p.server.openFetchStream(id)
      : await p.server.openSubgroup(42n, 1n, 0n, {requestId: id});
    const row = p.rows.uni.at(-1)!;
    let release!: () => void;
    row.finGate = new Promise<void>(resolve => { release = resolve; });
    const fin = kind === 'fetch' ? p.server.closeFetchStream(sid) : p.server.closeSubgroup(sid);
    const ack = kind === 'publish' ? p.b.bidiOut[0]!.out : p.a.bidiOut[0]!.in;
    ack.faults.hold = true;
    let confirmed = false;
    const update = p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(7n), timeoutMs: 2000}).then(() => { confirmed = true; });
    try {
      await flush(128); expect(row.rank).toBe(248); expect(confirmed).toBe(false);
      ack.releaseHeld(); await update; expect(p.errors).toEqual([]);
    } finally { ack.releaseHeld(); release(); await fin; }
  });
  it.each([128n, 7n, 255n])('PUBLISH acceptance refreshes already-open data to %s', async priority => {
    const p = await pair();
    p.client.onPublish = () => {};
    const id = await p.server.publish(ns, name, 42n); await flush(64);
    await p.server.openSubgroup(42n, 1n, 0n, {requestId: id});
    const row = p.rows.uni.at(-1)!; expect(row.rank).toBe(127);
    await p.client.acceptSubscribe(id, 42n, {parameters: new Map([[0x20n, [varint(priority)]]])});
    await flush(128); expect(row.rank).toBe(255 - Number(priority)); expect(p.errors).toEqual([]);
  });
  it('pending FETCH data stays legal with supported or absent capability', async () => {
    for (const mode of ['get-throw', 'absent'] as const) {
    const p = await pair(18, mode);
    let id = -1n; p.server.onFetch = value => { id = value; };
    await p.client.fetch(ns, name, {startGroup: 1n, startObject: 0n, endGroup: 1n, endObject: 2n});
    await flush(64); expect(p.server.session.getIncomingFetch(id)!.state).toBe('pending');
    const sid = await p.server.openFetchStream(id);
    await p.server.sendFetchObject(sid, {groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: Uint8Array.of(1)});
    expect(p.rows.uni.at(-1)!.rank).toBe(mode === 'absent' ? 0 : 127);
    await p.server.acceptFetch(id, {endLocation: {group: 1n, object: 1n}});
    await p.server.closeFetchStream(sid); expect(p.errors).toEqual([]);
    }
  });
  it('a failing setter leaves accepted update and media lifetime intact, contains hostile thrown values', async () => {
    let armed = false;
    const hostile = new Proxy({}, {get() { throw new Error('thrown value inspected'); }});
    const p = await pair(18, 'get-throw', () => { if (armed) throw hostile; });
    const id = (await subscription(p)).requestId;
    const sid = await p.server.openSubgroup(42n, 1n, 0n, {requestId: id});
    armed = true;
    await p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(7n), timeoutMs: 2000});
    await p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(9n), timeoutMs: 2000});
    await p.server.sendObject(sid, 0n, Uint8Array.of(1));
    expect(p.errors).toEqual([]); expect(p.rows.uni.at(-1)!.rank).toBe(246);
    expect(p.rows.uni.at(-1)!.aborts).toBe(0);
    expect(p.server.session.getIncomingSubscription(id)!.currentPriority).toBe(9n);
  });
  it('FETCH cancellation in setter rejects open before first header', async () => {
    let reenter: (() => void) | undefined;
    const p = await pair(18, 'get-throw', () => { const f = reenter; reenter = undefined; f?.(); });
    let id = -1n; p.server.onFetch = value => { id = value; };
    await p.client.fetch(ns, name, {startGroup: 1n, startObject: 0n, endGroup: 1n, endObject: 2n});
    await flush(64);
    reenter = () => void p.server.rejectFetch(id, varint(1n), 'cancelled');
    await expect(p.server.openFetchStream(id)).rejects.toThrow();
    expect(p.rows.uni.at(-1)!.writes).toEqual([]);
  });
});

it('a refused FETCH update leaves existing stream hint unchanged', async () => {
  const p = await pair(); const id = await fetchOwner(p);
  await p.server.openFetchStream(id); const row = p.rows.uni.at(-1)!;
  expect(row.rank).toBe(127);
  const before = row.sets.slice();
  // No FETCH Largest Location provider: an accepted response cannot be constructed.
  await expect(p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(7n), timeoutMs: 1000})).rejects.toThrow();
  expect(row.sets).toEqual(before);
});

it.each(['probe', 'setter'] as const)('session close during %s cannot resurrect an initial subgroup', async phase => {
  let action: (() => void) | undefined;
  const p = await pair(18, 'get-throw', () => { if (phase === 'setter') { const fn = action; action = undefined; fn?.(); } });
  const id = (await subscription(p)).requestId;
  let closed: Promise<void> | undefined;
  action = () => { closed = p.server.close(); };
  if (phase === 'probe') {
    const create = p.transport.createUnidirectionalStream!;
    p.transport.createUnidirectionalStream = async () => {
      const target = await create();
      return new Proxy(target, {
        has(t, key) { const fn = action; action = undefined; fn?.(); return Reflect.has(t, key); },
        get(t, key) { if (key === 'getWriter') return t.getWriter.bind(t); return Reflect.get(t, key, t); },
      });
    };
  }
  await expect(p.server.openSubgroup(42n, 1n, 0n, {requestId: id})).rejects.toThrow();
  await closed; expect(p.rows.uni.at(-1)!.writes).toEqual([]);
});

it.each([16, 18, 22] as const)('draft %s continuing namespace request assigns both writable halves', async draft => {
  const p = await pair(draft);
  p.client.onSubscribeNamespace = id => { void p.client.acceptSubscribeNamespace(id); };
  await p.server.subscribeNamespace(ns);
  await flush(128);
  expect(p.rows.outgoing[0]!.ranks[0]).toBe(512);
  expect(p.errors).toEqual([]);
});

it('draft22 SUBSCRIBE_TRACKS continuing request has request rank', async () => {
  const p = await pair(22);
  p.client.onSubscribeTracks = id => { void p.client.acceptSubscribeTracks(id); };
  await p.server.subscribeTracks(ns); await flush(128);
  expect(p.rows.outgoing[0]!.ranks[0]).toBe(512); expect(p.errors).toEqual([]);
});

it('hostile probe failure is advisory and cannot fail an accepted update', async () => {
  const p = await pair(); const id = (await subscription(p)).requestId;
  let probes = 0;
  const hostile = new Proxy({}, {get() { throw new Error('thrown value inspected'); }});
  const create = p.transport.createUnidirectionalStream!;
  p.transport.createUnidirectionalStream = async () => {
    const target = await create();
    return new Proxy(target, {
      has() { probes++; throw hostile; },
      get(t, key) { if (key === 'getWriter') return t.getWriter.bind(t); return Reflect.get(t, key, t); },
    });
  };
  const sid = await p.server.openSubgroup(42n, 1n, 0n, {requestId: id});
  await p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(7n), timeoutMs: 1000});
  await p.server.sendObject(sid, 0n, Uint8Array.of(1));
  expect(probes).toBe(1); expect(p.errors).toEqual([]);
  expect(p.server.session.getIncomingSubscription(id)!.currentPriority).toBe(7n);
});

it.each(['subscribe', 'update', 'publish'] as const)('draft22 %s fill carries its own subscriber priority on actual stream opens', async direction => {
  const p = await pair(22);
  let id: bigint;
  if (direction === 'publish') {
    p.client.onPublish = pub => { void p.client.acceptSubscribe(pub.requestId, pub.trackAlias); };
    id = await p.server.publish(ns, name, 42n, {parameters: new Map([[0x20n, [varint(99n)]]])});
    await flush(128);
  } else {
    p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 42n, {parameters: new Map([[0x09n, [{group: 1n, object: 0n}]]])}); };
    id = await p.client.subscribe(ns, name, {subscriberPriority: varint(99n),
      ...(direction === 'subscribe' ? {fill: {subscriberPriority: 0}} : {})});
    await flush(128);
  }
  const rows: Witness[] = [];
  for (const priority of [0, 42, 255]) {
    const fillId = direction === 'subscribe' && priority === 0 ? id
      : (await p.client.requestUpdateConfirmed(id, {fill: {subscriberPriority: priority}, timeoutMs: 1000})).requestId;
    await p.server.openFillStream(fillId);
    const row = p.rows.uni.at(-1)!; rows.push(row);
    expect(row.ranks[0]).toBe(255 - priority);
    expect((p.server.session.getIncomingSubscription(id) ?? p.server.session.getOutgoingPublish(id))!.currentPriority).toBe(99n);
  }
  const inherited = await p.client.requestUpdateConfirmed(id, {fill: {}, timeoutMs: 1000});
  await p.server.openFillStream(inherited.requestId);
  const inheritedRow = p.rows.uni.at(-1)!;
  expect(inheritedRow.rank).toBe(156); // Explicit priority on a prior fill is not sticky.
  await p.server.openSubgroup(42n, 2n, 0n, {requestId: id});
  const live = p.rows.uni.at(-1)!; expect(live.rank).toBe(156);
  await p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(101n), timeoutMs: 1000});
  expect(live.rank).toBe(154);
  expect(rows.map(row => row.rank)).toEqual([255, 213, 0]); // Separate scopes retain explicit overrides.
  expect(inheritedRow.rank).toBe(156); // Policy: effective priority was snapshotted at this fill request acceptance.
  expect(p.errors).toEqual([]);
});

it.each([42, 255])('initial SUBSCRIBE fill priority %s overrides outer99', async priority => {
  const p = await pair(22);
  p.server.onSubscribe = id => { void p.server.acceptSubscribe(id, 42n,
    {parameters: new Map([[0x09n, [{group: 1n, object: 0n}]]])}); };
  const id = await p.client.subscribe(ns, name, {subscriberPriority: varint(99n), fill: {subscriberPriority: priority}});
  await flush(128); await p.server.openFillStream(id);
  expect(p.rows.uni.at(-1)!.sets).toEqual([255 - priority]);
  expect(p.rows.uni.at(-1)!.ranks[0]).toBe(255 - priority); expect(p.errors).toEqual([]);
});

it('fill priority snapshot survives both delayed open and held transport allocation', async () => {
  const p = await pair(22);
  p.server.onSubscribe = id => { void p.server.acceptSubscribe(id, 42n); };
  const id = await p.client.subscribe(ns, name, {subscriberPriority: varint(99n)}); await flush(128);
  const first = await p.client.requestUpdateConfirmed(id, {fill: {}, timeoutMs: 1000});
  const second = await p.client.requestUpdateConfirmed(id, {fill: {}, timeoutMs: 1000});
  const create = p.transport.createUnidirectionalStream!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  p.transport.createUnidirectionalStream = async () => { await gate; return create(); };
  const opening = p.server.openFillStream(first.requestId);
  try {
    await p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(101n), timeoutMs: 1000});
  } finally { release(); }
  await opening; expect(p.rows.uni.at(-1)!.ranks[0]).toBe(156);
  p.transport.createUnidirectionalStream = create;
  await p.server.openFillStream(second.requestId); expect(p.rows.uni.at(-1)!.ranks[0]).toBe(156);
  const next = await p.client.requestUpdateConfirmed(id, {fill: {}, timeoutMs: 1000});
  await p.server.openFillStream(next.requestId); expect(p.rows.uni.at(-1)!.ranks[0]).toBe(154);
  expect(p.errors).toEqual([]);
});

it('pending SUBSCRIBE snapshots on acceptance while an accepted UPDATE fill snapshots before deferred ACK', async () => {
  const p = await pair(22); p.server.onSubscribe = () => {};
  const id = await p.client.subscribe(ns, name, {subscriberPriority: varint(99n), fill: {}}); await flush(128);
  const updateId = await p.client.requestUpdate(id, {subscriberPriority: varint(100n), fill: {}}); await flush(128);
  await p.client.requestUpdate(id, {subscriberPriority: varint(101n)}); await flush(128);
  await p.server.acceptSubscribe(id, 42n, {parameters: new Map([[0x09n, [{group: 1n, object: 0n}]]])});
  await flush(128);
  await p.server.openFillStream(id); expect(p.rows.uni.at(-1)!.ranks[0]).toBe(154);
  await p.server.openFillStream(updateId); expect(p.rows.uni.at(-1)!.ranks[0]).toBe(155);
  expect(p.errors).toEqual([]);
});

it('a rejected UPDATE commits no fill priority snapshot or stream admission', async () => {
  const p = await pair(22); const id = (await subscription(p)).requestId;
  await p.server.openSubgroup(42n, 1n, 0n, {requestId: id});
  expect(p.rows.uni.at(-1)!.rank).toBe(127);
  p.server.setLargestLocationProvider(() => {throw new Error('not available');});
  let updateId = -1n;
  await expect(p.client.requestUpdateConfirmed(id, {subscriberPriority: varint(7n), fill: {subscriberPriority: 0},
    timeoutMs: 1000, onRequestId: value => {updateId = value;}})).rejects.toThrow();
  await expect(p.server.openFillStream(updateId)).rejects.toThrow(/No pending fill/);
});
