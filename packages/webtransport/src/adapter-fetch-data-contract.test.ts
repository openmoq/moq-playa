import { it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import type { WebTransportBidirectionalStream, WebTransportLike } from './types.js';
import { varint } from '@openmoq/transport';
import type { DraftVersion, MoqtObject, ControlMessage } from '@openmoq/transport';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map(x => parseInt(x, 16)));
const small = (n: bigint) => { if (n < 0n || n > 63n) throw Error('manual field width'); return n.toString(16).padStart(2, '0'); };
const request = { startGroup: 7n, startObject: 0n, endGroup: 7n, endObject: 4n, groupOrder: 'ascending' as const };
const first = (object: bigint, payload = 'aa') => '1f0700' + small(object) + '8001' + payload;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function client(transport = new TransportSim()) {
  const conn = new MoqtConnection(22);
  const objects: MoqtObject[] = [], errors: Error[] = [], messages: ControlMessage[] = [];
  conn.onObject = (_stream, value) => objects.push(value);
  conn.onError = value => errors.push(value);
  conn.onMessage = value => messages.push(value);
  transport.openIncomingUni().push(hex('af000000'));
  await conn.connect(transport);
  const fetch = async (namespace = 'N') => {
    const index = transport.bidi.length;
    const id = await conn.fetch(ns(namespace), nm('v'), request);
    return { id, control: transport.bidi[index]! };
  };
  const ok = async (r: Awaited<ReturnType<typeof fetch>>) => { r.control.push(hex('18000400070300')); await flush(512); };
  const data = (id: bigint, fields: string) => transport.openIncomingUni().push(hex('05' + small(id) + fields));
  return { conn, transport, objects, errors, messages, fetch, ok, data };
}

it('FETCH contract ownership: a held request abort fences the bad DATA reader before sibling delivery', async () => {
  const gate = deferred(), started = deferred();
  class Held extends TransportSim {
    override async createBidirectionalStream(): Promise<WebTransportBidirectionalStream> {
      const stream = await super.createBidirectionalStream();
      if (this.bidi.length !== 1) return stream;
      const writer = stream.writable.getWriter();
      return { readable: stream.readable, writable: new WritableStream<Uint8Array>({
        write: bytes => writer.write(bytes), close: () => writer.close(),
        abort: async reason => { started.resolve(); await gate.promise; await writer.abort(reason); },
      }) };
    }
  }
  const f = await client(new Held());
  try {
    const bad = await f.fetch(), same = await f.fetch(), other = await f.fetch('O');
    await f.ok(bad); await f.ok(same); await f.ok(other);
    f.data(bad.id, first(5n) + '1700018001d7');
    await started.promise;
    expect(f.conn.session.getFetch(bad.id)).toBeUndefined();
    expect(bad.control.writeAborted).toBe(false);
    f.data(same.id, first(3n, 'b1')); f.data(other.id, first(3n, 'c1'));
    await flush(1024);
    expect(f.objects.filter(x => x.kind === 'data').map(x => [...x.payload])).toEqual([[0xb1], [0xc1]]);
    expect(f.transport.closeInfo).toBeUndefined();
    expect(same.control.writeAborted).toBe(false); expect(other.control.writeAborted).toBe(false);
  } finally { gate.resolve(); await flush(1024); await f.conn.close(); }
});

it('FETCH contract reentry: cancellation from raw DATA qlog suppresses that DATA before application delivery', async () => {
  const f = await client();
  try {
    const r = await f.fetch(); await f.ok(r);
    let cancellation: Promise<void> | undefined;
    f.conn.onQlogEvent = event => { if (event.type === 'fetch_object_parsed') cancellation ??= f.conn.fetchCancel(r.id); };
    f.data(r.id, first(3n)); await flush(1024); await cancellation;
    expect(cancellation).toBeDefined(); expect(f.objects).toEqual([]);
    expect(r.control.writeAborted).toBe(true); expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

it('FETCH contract core: pending range refusal admits one crossed OK and rejects its duplicate', async () => {
  const f = await client();
  try {
    const r = await f.fetch();
    const refusal = f.conn.session.admitFetchData(r.id, 7n, 5n);
    expect(refusal.accepted).toBe(false);
    expect(refusal.actions.some(a => a.type === 'cancel_request')).toBe(true);
    const response = { type: 'FETCH_OK' as const, requestId: r.id, endOfTrack: 0, endLocation: { group: 7n, object: 3n }, parameters: new Map() };
    expect(f.conn.session.handleControlMessage(response, { requestId: r.id })).toEqual([]);
    expect(f.conn.session.handleControlMessage(response, { requestId: r.id }).some(a => a.type === 'close_connection')).toBe(true);
  } finally { await f.conn.close(); }
});

it('FETCH contract core: FIN then smaller OK consumes the current response without a fresh cancellation shadow', async () => {
  const f = await client();
  try {
    const r = await f.fetch();
    expect(f.conn.session.admitFetchData(r.id, 7n, 3n).accepted).toBe(true);
    f.conn.session.handleFetchStreamFinished(r.id);
    const response = { type: 'FETCH_OK' as const, requestId: r.id, endOfTrack: 0, endLocation: { group: 7n, object: 1n }, parameters: new Map() };
    const actions = f.conn.session.handleControlMessage(response, { requestId: r.id });
    expect(actions.some(a => a.type === 'cancel_request' && a.fetchDataFinished === true)).toBe(true);
    expect(f.conn.session.isCancelledRequest(r.id)).toBe(false);
    expect(f.conn.session.handleControlMessage(response, { requestId: r.id }).some(a => a.type === 'close_connection')).toBe(true);
  } finally { await f.conn.close(); }
});

async function serveOne(draft: DraftVersion, explicit: boolean) {
  const p = await connectedPair(draft);
  const got: MoqtObject[] = [], messages: ControlMessage[] = [];
  p.client.onObject = (_id, value) => got.push(value);
  p.client.onMessage = value => messages.push(value);
  const done = deferred();
  let sendError: unknown;
  p.server.onFetch = id => { void (async () => {
    await p.server.acceptFetch(id, explicit ? { endLocation: { group: 0n, object: 3n } } : undefined);
    const stream = await p.server.openFetchStream(id);
    await p.server.sendFetchObject(stream, { groupId: varint(0), subgroupId: varint(0), objectId: varint(1), publisherPriority: 128, payload: hex('bb') });
  })().catch(error => { sendError = error; }).finally(done.resolve); };
  try {
    await p.client.fetch(ns('N'), nm('v'), { startGroup: 0n, startObject: 0n, endGroup: 0n, endObject: 4n, groupOrder: 'ascending' });
    await done.promise; await flush(1024);
    return { got, messages, errors: p.errors, sendError };
  } finally { await p.client.close(); await p.server.close(); }
}

it('FETCH contract publisher default: draft22 bare acceptFetch must not contradict the accepted requested range', async () => {
  const r = await serveOne(22, false);
  expect(r.messages.find(x => x.type === 'FETCH_OK')).toMatchObject({ endLocation: { group: 0n, object: 3n } });
  expect(r.got.filter(x => x.kind === 'data').map(x => x.objectId)).toEqual([1n]);
});

it('FETCH contract publisher control: draft22 explicit inclusive response end preserves the same in-range DATA', async () => {
  const r = await serveOne(22, true);
  expect(r.got.filter(x => x.kind === 'data').map(x => x.objectId)).toEqual([1n]);
  expect(r.errors).toEqual([]); expect(r.sendError).toBeUndefined();
});


for (const reenter of [false, true]) it(`FETCH cancellation reentry: ${reenter ? 'nested fetchCancel from backend cancel stays idempotent' : 'ordinary backend cancel is healthy'}`, async () => {
  const base = new TransportSim();
  let incoming!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  const incomingUni = new ReadableStream<ReadableStream<Uint8Array>>({ start(c) { incoming = c; } });
  const transport: WebTransportLike = {
    createBidirectionalStream: () => base.createBidirectionalStream(),
    createUnidirectionalStream: () => base.createUnidirectionalStream(),
    incomingUnidirectionalStreams: incomingUni,
    incomingBidirectionalStreams: base.incomingBidirectionalStreams,
    datagrams: base.datagrams, closed: base.closed, close: info => base.close(info),
  };
  const conn = new MoqtConnection(22);
  const objects: MoqtObject[] = [], errors: Error[] = [];
  conn.onObject = (_id, value) => objects.push(value); conn.onError = value => errors.push(value);
  incoming.enqueue(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(hex('af000000')); } }));
  await conn.connect(transport);
  let nested: Promise<void> | undefined;
  let backendCancels = 0;
  try {
    const id = await conn.fetch(ns('N'), nm('v'), request);
    base.bidi[0]!.push(hex('18000400070300')); await flush(512);
    incoming.enqueue(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(hex('05' + small(id) + first(0n))); },
      cancel() {
        backendCancels++;
        if (reenter) { nested = conn.fetchCancel(id); void nested.catch(() => {}); }
      },
    }));
    await flush(1024);
    expect(objects.filter(x => x.kind === 'data').map(x => x.objectId)).toEqual([0n]);
    const outer = conn.fetchCancel(id);
    const [a, b] = await Promise.allSettled([outer, nested ?? Promise.resolve()]);
    expect(a.status).toBe('fulfilled'); expect(b.status).toBe('fulfilled');
    expect(backendCancels).toBe(1); expect(base.bidi[0]!.writeAborted).toBe(true);
    expect(errors).toEqual([]);
  } finally { await conn.close(); }
});
