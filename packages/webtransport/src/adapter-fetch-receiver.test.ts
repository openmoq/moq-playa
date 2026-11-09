import { afterEach, describe, expect, it, vi } from 'vitest';
import { varint, createControlCodec, encodeFetchHeader, encodeFetchObject, encodeFetchEndOfRange, FetchFlags, FetchSubgroupMode, type MoqtObject, type Parameters } from '@openmoq/transport';
import type { FetchReceiver, FetchReceiveContext, DataStreamTerminal } from './index.js';
import type { ObjectReceiptObservation } from './object-receipts.js';
import { MoqtConnection } from './adapter.js';
import { connectedPair, nm, ns, type ConnectedPair } from './testkit/pair.js';
import { createLoopback } from './testkit/loopback.js';
import { flush } from './testkit/stream-sim.js';

const drafts = [14, 16, 18, 22] as const;
const range = { startGroup: varint(7n), startObject: varint(0n), endGroup: varint(7n), endObject: varint(9n) };
const connections: MoqtConnection[] = [];
afterEach(async () => { for (const c of connections.splice(0)) await c.close(); });
function deferred() {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(draft: typeof drafts[number], requestGate?: ReturnType<typeof deferred>) {
  let p: ConnectedPair;
  if (requestGate) {
    const { a, b } = createLoopback();
    let armed = false;
    const create = a.createBidirectionalStream.bind(a);
    a.createBidirectionalStream = async () => {
      const stream = await create(), writer = stream.writable.getWriter();
      return { readable: stream.readable, writable: new WritableStream<Uint8Array>({
        async write(bytes) { await writer.write(bytes); if (armed) await requestGate.promise; },
        close: () => writer.close(), abort: reason => writer.abort(reason),
      }) };
    };
    const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' }), errors: Error[] = [];
    client.onError = server.onError = error => { errors.push(error); };
    await Promise.all([client.connect(a), server.connect(b, draft < 18 ? { maxRequestId: varint(1000n) } : {})]);
    armed = true; p = { client, server, a, b, errors };
  } else p = await connectedPair(draft);
  connections.push(p.client, p.server);
  p.server.onFetch = () => {};
  const generic: MoqtObject[] = [];
  p.client.onObject = (_sid, obj) => { generic.push(obj); };
  const legacy = new Map<bigint, WritableStreamDefaultWriter<Uint8Array>>();
  const respond = async (id: bigint, accept = true) => {
    let sid: bigint;
    if (draft === 14 || draft === 16) {
      // Legacy publisher convenience methods do not encode FETCH responses.
      // Use its real WebTransport endpoint and the negotiated data format.
      const writer = (await p.b.createUnidirectionalStream()).getWriter();
      await writer.write(encodeFetchHeader({ requestId: id }));
      sid = id; legacy.set(sid, writer);
    } else {
      if (accept) await p.server.acceptFetch(id, { endLocation: { group: 7n, object: 9n } });
      sid = await p.server.openFetchStream(id);
    }
    return { id, sid, pipe: p.b.uniOut.at(-1)! };
  };
  const open = async (receiver?: FetchReceiver, accept = true) => {
    const id = await p.client.fetch(ns('history'), nm('video'), { ...range, ...(receiver ? { receiver } : {}) });
    await flush(100);
    return respond(id, accept);
  };
  const send = (sid: bigint, object: bigint) => legacy.has(sid)
    ? legacy.get(sid)!.write(draft === 14
      ? Uint8Array.of(7, 0, Number(object), 128, 0, 1, Number(object))
      : encodeFetchObject({
      flags: varint(FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchSubgroupMode.EXPLICIT),
      groupId: 7n, subgroupId: 0n, objectId: object, publisherPriority: 128,
      isDatagram: false, extensions: undefined, payload: Uint8Array.of(Number(object)),
    }))
    : p.server.sendFetchObject(sid, {
    groupId: 7n, subgroupId: 0n, objectId: object, publisherPriority: 128, payload: Uint8Array.of(Number(object)),
  });
  const gap = async (sid: bigint) => {
    if (legacy.has(sid)) {
      await legacy.get(sid)!.write(draft === 14
        ? Uint8Array.of(7, 0, 2, 128, 0, 0, 1)
        : encodeFetchEndOfRange({ flags: varint(0x8c), groupId: 7n, objectId: 2n, nonExistent: true }));
    } else await p.server.sendFetchEndOfRange(sid, true, 7n, 2n);
  };
  const finish = (sid: bigint) => legacy.has(sid) ? legacy.get(sid)!.close() : p.server.closeFetchStream(sid);
  return { ...p, generic, open, respond, send, gap, finish };
}

describe.each(drafts)('request-owned FETCH receiver draft %i', draft => {
  it('owns data and FIN before FETCH_OK and before the outer fetch promise resolves', async () => {
    const gate = deferred(), p = await setup(draft, gate), receive = vi.fn(), closed = vi.fn();
    let allocated = -1n, resolved = false;
    const done = deferred();
    p.server.onFetch = id => { void (async () => {
      const h = await p.respond(id, false);
      await p.send(h.sid, 0n); await p.finish(h.sid); done.resolve();
    })().catch(done.reject); };
    const request = p.client.fetch(ns('history'), nm('video'), {
      ...range, onRequestId: id => { allocated = id; },
      receiver: { onObject: receive, onClosed: closed },
    }).then(id => { resolved = true; return id; });
    try {
      await done.promise; await flush(150);
      expect(resolved).toBe(false); expect(receive).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
      expect(receive.mock.calls[0]![1]).toMatchObject({ requestId: allocated, streamId: expect.any(BigInt) });
      expect(closed.mock.calls[0]![0]).toBe('fin'); expect(p.generic).toEqual([]);
    } finally { gate.resolve(); await request; }
    expect(p.errors).toEqual([]);
  });

  it('cancels before a data stream exists, retaining crossed late-stream cancellation ownership', async () => {
    const p = await setup(draft), receive = vi.fn(), closed = vi.fn();
    const id = await p.client.fetch(ns('history'), nm('video'), { ...range, receiver: { onObject: receive, onClosed: closed } });
    await p.client.fetchCancel(id); await p.client.fetchCancel(id);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed.mock.calls[0]).toEqual(['local-discard', { requestId: id, streamId: null, signal: expect.any(AbortSignal) }]);
    expect(closed.mock.calls[0]![1].signal.aborted).toBe(true);
    const writer = (await p.b.createUnidirectionalStream()).getWriter();
    await writer.write(encodeFetchHeader({ requestId: id })); await writer.write(Uint8Array.of(255)); await writer.close();
    await flush(150);
    expect(receive).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce(); expect(p.client.session.state).toBe('established');
  });

  it('rolls back receiver ownership before a throwing ownership callback can reuse its unsent request ID', async () => {
    const p = await setup(draft), old = vi.fn(), closed = vi.fn(), fresh = vi.fn();
    let allocated = -1n;
    await expect(p.client.fetch(ns('history'), nm('video'), {
      ...range, receiver: { onObject: old, onClosed: closed },
      onRequestId: id => { allocated = id; throw new Error('ownership failed'); },
    })).rejects.toThrow('ownership failed');
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('error');
    expect(closed.mock.calls[0]![1]).toMatchObject({ requestId: allocated, streamId: null });
    const next = await p.open({ onObject: fresh });
    expect(next.id).toBe(allocated);
    await p.send(next.sid, 0n); await p.finish(next.sid); await flush(150);
    expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
  });

  it('finalizes REQUEST_ERROR before a terminal observer reenters cancellation, preserving onMessage', async () => {
    const p = await setup(draft), receive = vi.fn(), messages: string[] = [];
    const closed = vi.fn((_terminal: DataStreamTerminal, context: FetchReceiveContext) => { void p.client.fetchCancel(context.requestId); });
    p.client.onMessage = message => { messages.push(message.type); };
    const id = await p.client.fetch(ns('history'), nm('video'), { ...range, receiver: { onObject: receive, onClosed: closed } });
    await flush(100); await p.server.rejectFetch(id, 0n, 'unavailable'); await flush(150);
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('error');
    expect(closed.mock.calls[0]![1]).toMatchObject({ requestId: id, streamId: null });
    expect(closed.mock.calls[0]![1].signal.aborted).toBe(true); expect(messages).toContain('REQUEST_ERROR');
    expect(receive).not.toHaveBeenCalled(); expect(p.client.session.state).toBe('established');
    expect(p.server.session.state).toBe('established');
  });

  it('can cancel reentrantly inside onRequestId before sending any request bytes', async () => {
    const p = await setup(draft), closed = vi.fn(), receive = vi.fn(), incoming = vi.fn();
    p.server.onFetch = incoming;
    let cancellation: Promise<void> | undefined;
    await p.client.fetch(ns('history'), nm('video'), {
      ...range, receiver: { onObject: receive, onClosed: closed },
      onRequestId: id => { cancellation = p.client.fetchCancel(id); },
    });
    await cancellation; await flush(100);
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('local-discard');
    expect(incoming).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
    expect(p.client.session.state).toBe('established'); expect(p.server.session.state).toBe('established');
  });

  it('cleans up receiver ownership when an outbound request write fails', async () => {
    const gate = deferred(), p = await setup(draft, gate), closed = vi.fn(), receive = vi.fn();
    const pending = p.client.fetch(ns('history'), nm('video'), { ...range, receiver: { onObject: receive, onClosed: closed } });
    const rejected = expect(pending).rejects.toThrow('outbound write failed');
    await flush(100); gate.reject(new Error('outbound write failed')); await rejected; await flush(150);
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(receive).not.toHaveBeenCalled();
    await p.client.close(); expect(closed).toHaveBeenCalledOnce();
  });

  it('protects a successor allocated reentrantly from a terminal observer at an unsent request ID', async () => {
    const p = await setup(draft), old = vi.fn(), fresh = vi.fn(), closed = vi.fn();
    let successor: Promise<bigint> | undefined;
    await expect(p.client.fetch(ns('history'), nm('video'), {
      ...range, onRequestId: () => { throw new Error('unsent'); },
      receiver: { onObject: old, onClosed: () => {
        closed(); successor = p.client.fetch(ns('history'), nm('video'), { ...range, receiver: { onObject: fresh } });
      } },
    })).rejects.toThrow('unsent');
    const next = await p.respond(await successor!);
    await p.send(next.sid, 0n); await p.finish(next.sid); await flush(150);
    expect(old).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
  });

  it('preserves the protocol violation for a simultaneous duplicate FETCH response stream', async () => {
    const p = await setup(draft), gate = deferred(), receive = vi.fn(() => gate.promise), closed = vi.fn();
    const h = await p.open({ onObject: receive, onClosed: closed });
    await p.send(h.sid, 0n); await flush(100); expect(receive).toHaveBeenCalledOnce();
    const writer = (await p.b.createUnidirectionalStream()).getWriter();
    await writer.write(encodeFetchHeader({ requestId: h.id })); await flush(150);
    expect(p.client.session.state).toBe('closed'); expect(closed).toHaveBeenCalledOnce();
    gate.reject(new Error('retired consumer')); await flush(100); expect(receive).toHaveBeenCalledOnce();
  });

  it('preserves malformed mid-object FIN as a peer protocol violation', async () => {
    const p = await setup(draft), receive = vi.fn(), closed = vi.fn();
    const h = await p.open({ onObject: receive, onClosed: closed });
    h.pipe.injectRead(Uint8Array.of(draft === 14 ? 7 : 0x1f));
    await p.finish(h.sid); await flush(150);
    expect(p.client.session.state).toBe('closed'); expect(receive).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it('applies the same backpressure to gap markers without losing later Objects', async () => {
    const p = await setup(draft), gate = deferred(), seen: MoqtObject[] = [], closed = vi.fn();
    const h = await p.open({ onObject: object => { seen.push(object); if (object.kind === 'gap') return gate.promise; }, onClosed: closed });
    await p.send(h.sid, 0n); await p.gap(h.sid); await p.send(h.sid, 3n); await p.finish(h.sid); await flush(150);
    expect(seen.map(o => [o.kind, o.objectId])).toEqual([['data', 0n], ['gap', 2n]]); expect(closed).not.toHaveBeenCalled();
    gate.resolve(); await flush(150);
    expect(seen.map(o => [o.kind, o.objectId])).toEqual([['data', 0n], ['gap', 2n], ['data', 3n]]);
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('fin'); expect(p.errors).toEqual([]);
  });

  it('owns REQUEST_ERROR during an uncooperative callback, including AbortSignal cancellation reentry', async () => {
    const p = await setup(draft), gate = deferred(), receive = vi.fn((_object: MoqtObject, context: FetchReceiveContext) => {
      context.signal.addEventListener('abort', () => { void p.client.fetchCancel(context.requestId); }, { once: true });
      return gate.promise;
    }), closed = vi.fn(), messages: string[] = [];
    p.client.onMessage = message => { messages.push(message.type); };
    const h = await p.open({ onObject: receive, onClosed: closed }, false);
    await p.send(h.sid, 0n); await flush(150); expect(receive).toHaveBeenCalledOnce();
    // A relay may send an error after cached Objects, independently of resetting
    // the data stream. Inject the negotiated response through the real endpoint.
    p.a.bidiOut.at(-1)!.in.injectRead(createControlCodec(draft).encode({
      type: 'REQUEST_ERROR', requestId: varint(h.id), errorCode: varint(0), retryInterval: varint(0), errorReason: 'upstream unavailable', requestKind: 'FETCH',
    }));
    await flush(150);
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('error');
    expect(messages).toContain('REQUEST_ERROR'); expect(p.client.session.getFetch(h.id)).toBeUndefined();
    gate.reject(new Error('retired callback')); await flush(100);
    expect(receive).toHaveBeenCalledOnce(); expect(p.client.session.state).toBe('established'); expect(p.generic).toEqual([]);
  });

  it('owns a late rejection when onObject cancels its own request synchronously', async () => {
    const p = await setup(draft), gate = deferred(), closed = vi.fn();
    const receive = vi.fn((_object: MoqtObject, context: FetchReceiveContext) => {
      void p.client.fetchCancel(context.requestId); return gate.promise;
    });
    const h = await p.open({ onObject: receive, onClosed: closed });
    await p.send(h.sid, 0n); await flush(150);
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('local-discard');
    gate.reject(new Error('cancelled callback')); await flush(100);
    expect(receive).toHaveBeenCalledOnce(); expect(p.client.session.state).toBe('established'); expect(p.generic).toEqual([]);
  });

  it('backpressures each object within one coalesced chunk and delays FIN until accepted work settles', async () => {
    const p = await setup(draft), first = deferred(), second = deferred();
    const seen: bigint[] = [], contexts: FetchReceiveContext[] = [], closed: DataStreamTerminal[] = [];
    let finalized = false;
    const streamTerminals: DataStreamTerminal[] = [];
    p.client.onStreamClosed = (_sid, _error, terminal) => { if (terminal) streamTerminals.push(terminal); };
    const h = await p.open({
      onObject: (obj, ctx) => { seen.push(obj.objectId); contexts.push(ctx); return seen.length === 1 ? first.promise : second.promise; },
      onClosed: (terminal, ctx) => {
        closed.push(terminal);
        finalized = p.client.session.getFetch(ctx.requestId)?.dataFinished ?? true;
      },
    });
    h.pipe.faults.hold = true;
    await p.send(h.sid, 0n); await p.send(h.sid, 1n); await p.finish(h.sid);
    h.pipe.releaseHeld(); await flush(100);
    expect(seen).toEqual([0n]); expect(closed).toEqual([]); expect(streamTerminals).toEqual([]); expect(p.generic).toEqual([]);
    expect(contexts[0]).toMatchObject({ requestId: h.id, streamId: expect.any(BigInt) });
    first.resolve(); await flush(100);
    expect(seen).toEqual([0n, 1n]); expect(closed).toEqual([]);
    second.resolve(); await flush(100);
    expect(closed).toEqual(['fin']); expect(streamTerminals).toEqual(['fin']); expect(finalized).toBe(true); expect(contexts[1]).toBe(contexts[0]); expect(contexts[0]!.signal.aborted).toBe(false); expect(p.errors).toEqual([]);
  });

  it.each(['cancel', 'disconnect', 'reset'] as const)('%s releases an uncooperative receiver and owns its late rejection', async mode => {
    const p = await setup(draft), gate = deferred(), receive = vi.fn((_object: MoqtObject, _context: FetchReceiveContext) => gate.promise), close = vi.fn();
    const h = await p.open({ onObject: receive, onClosed: close });
    await p.send(h.sid, 0n); await flush(100); expect(receive).toHaveBeenCalledOnce();
    const ctx = receive.mock.calls[0]![1] as FetchReceiveContext;
    if (mode === 'cancel') await p.client.fetchCancel(h.id);
    if (mode === 'disconnect') await p.client.close();
    if (mode === 'reset') h.pipe.reset(42);
    await flush(100);
    expect(ctx.signal.aborted).toBe(true); expect(close).toHaveBeenCalledOnce();
    expect(close.mock.calls[0]![0]).toBe(mode === 'reset' ? 'reset' : 'local-discard');
    gate.reject(new Error('late consumer failure')); await flush(100);
    expect(receive).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    if (mode !== 'disconnect') expect(p.client.session.state).toBe('established');
  });

  it.each(['throw', 'reject'] as const)('receiver %s cancels only its own FETCH, retaining unrelated alias-0 subscription delivery', async mode => {
    const p = await setup(draft), closed = vi.fn(), sub = vi.fn();
    p.server.onSubscribe = id => { void p.server.acceptSubscribe(id, 0n); };
    await p.client.subscribeTrack(ns('live'), nm('video'), { onObject: sub });
    const h = await p.open({ onObject: () => {
      if (mode === 'throw') throw new RangeError('local receiver failure');
      return Promise.reject(new Error('local receiver failure'));
    }, onClosed: closed });
    await p.send(h.sid, 0n); await flush(150);
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('error');
    expect(closed.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(p.client.session.getFetch(h.id)).toBeUndefined(); expect(p.client.session.state).toBe('established');
    const s = await p.server.openSubgroup(0n, 8n, 0n);
    await p.server.sendObject(s, 0n, Uint8Array.of(99)); await p.server.closeSubgroup(s); await flush(100);
    expect(sub).toHaveBeenCalledOnce(); expect(p.generic).toEqual([]); expect(p.errors).toEqual([]);
  });

  it('leaves ordinary no-receiver FETCH delivery unchanged', async () => {
    const p = await setup(draft), h = await p.open();
    await p.send(h.sid, 0n); await p.send(h.sid, 1n); await p.finish(h.sid); await flush(100);
    expect(p.generic.map(o => o.objectId)).toEqual([0n, 1n]); expect(p.errors).toEqual([]);
  });

  it('isolates simultaneous requests and finalizes before a reentrant terminal callback', async () => {
    const p = await setup(draft), gate = deferred(), a = vi.fn((_object: MoqtObject, _context: FetchReceiveContext) => gate.promise), b = vi.fn();
    const closed = vi.fn((_terminal: DataStreamTerminal, ctx: FetchReceiveContext) => {
      void p.client.fetchCancel(ctx.requestId);
      return Promise.reject(new Error('observer failure')) as unknown as void;
    });
    const old = await p.open({ onObject: a, onClosed: closed });
    await p.send(old.sid, 0n); await flush(100); await p.client.fetchCancel(old.id);
    const fresh = await p.open({ onObject: b });
    await p.send(fresh.sid, 0n); await p.finish(fresh.sid); await flush(100);
    gate.reject(new Error('old callback')); await flush(100);
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce();
    expect(p.client.session.state).toBe('established'); expect(p.generic).toEqual([]);
  });
});


describe.each(drafts)('FETCH receipt parity draft %i', draft => {
  it.each([false, true])('publishes exact original Object receipts before delivery (receiver=%s)', async owned => {
    const p = await setup(draft), observed: ObjectReceiptObservation[] = [], delivered: MoqtObject[] = [];
    let stream: bigint | undefined;
    p.client.onDataStream = (id, header) => { if (header.type === 'fetch') stream = id; };
    const receive = (object: MoqtObject) => {
      expect(observed).toHaveLength(delivered.length + 1);
      expect(p.client.objectReceiptFor(object)).toBe(observed.at(-1)!.receipt);
      expect(p.client.objectReceiptFor({ ...object })).toBeUndefined();
      delivered.push(object);
    };
    p.client.onObject = (_id, object) => receive(object);
    const off = p.client.observeObjectReceipts(event => { observed.push(event); });
    try {
      const h = await p.open(owned ? { onObject: receive } : undefined);
      await p.send(h.sid, 0n); await p.gap(h.sid); await p.send(h.sid, 3n); await p.finish(h.sid); await flush(150);
      expect(delivered.map(object => object.kind)).toEqual(['data', 'gap', 'data']);
      expect(observed).toHaveLength(3); expect(new Set(observed.map(event => event.receipt)).size).toBe(3);
      for (let i = 0; i < observed.length; i++) {
        expect(observed[i]).toMatchObject({ origin: 'fetch', trackAlias: null, requestId: h.id, streamId: stream,
          lastObjectId: null, groupId: delivered[i]!.groupId, objectId: delivered[i]!.objectId,
          payloadBytes: delivered[i]!.kind === 'data' ? 1 : 0 });
      }
      expect(p.errors).toEqual([]);
    } finally { off(); }
  });

  it.each([false, true])('receipt cancellation fences delivery and preserves a successor (receiver=%s)', async owned => {
    const p = await setup(draft), receive = vi.fn(), closed = vi.fn(), discarded = vi.fn();
    p.client.onObject = receive;
    let cancel: Promise<void> | undefined;
    const offDiscard = p.client.observeObjectDiscards(discarded);
    const seen: ObjectReceiptObservation[] = [];
    const off = p.client.observeObjectReceipts(event => {
      seen.push(event);
      if (event.origin === 'fetch') cancel = p.client.fetchCancel(event.requestId);
    });
    try {
      const h = await p.open(owned ? { onObject: receive, onClosed: closed } : undefined);
      await p.send(h.sid, 0n); await flush(100); await cancel;
      expect(seen).toHaveLength(1); expect(receive).not.toHaveBeenCalled();
      expect(discarded).toHaveBeenCalledExactlyOnceWith({ receipt: seen[0]!.receipt, reason: 'late' });
      if (owned) expect(closed).toHaveBeenCalledOnce();
      off();
      const fresh = await p.open(owned ? { onObject: receive } : undefined);
      await p.send(fresh.sid, 0n); await p.finish(fresh.sid); await flush(100);
      expect(receive).toHaveBeenCalledOnce(); expect(p.errors).toEqual([]);
    } finally { off(); offDiscard(); }
  });

  it('contains throwing/rejecting observers without delaying the receiver or duplicating its receipt', async () => {
    const p = await setup(draft), receive = vi.fn(), second = vi.fn();
    const off = [p.client.observeObjectReceipts(() => { throw new Error('sync receipt observer'); }),
      p.client.observeObjectReceipts(() => Promise.reject(new Error('async receipt observer'))),
      p.client.observeObjectReceipts(second)];
    try {
      const h = await p.open({ onObject: receive }); await p.send(h.sid, 0n); await p.finish(h.sid); await flush(100);
      expect(receive).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce(); expect(p.errors).toEqual([]);
      expect(p.client.objectReceiptFor(receive.mock.calls[0]![0])).toBe(second.mock.calls[0]![0].receipt);
    } finally { for (const remove of off) remove(); }
  });

  it('can allocate another FETCH from an observer without replacing the first request owner', async () => {
    const p = await setup(draft), receive = vi.fn(), other = vi.fn();
    let successor: Promise<bigint> | undefined;
    const seen: ObjectReceiptObservation[] = [];
    const off = p.client.observeObjectReceipts(event => {
      seen.push(event);
      successor ??= p.client.fetch(ns('history'), nm('other'), { ...range, receiver: { onObject: other } });
    });
    try {
      const h = await p.open({ onObject: receive }); await p.send(h.sid, 0n); await p.finish(h.sid); await flush(100);
      expect(receive).toHaveBeenCalledOnce();
      const next = await p.respond(await successor!); await p.send(next.sid, 0n); await p.finish(next.sid); await flush(100);
      expect(other).toHaveBeenCalledOnce(); expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ origin: 'fetch', requestId: h.id });
      expect(seen[1]).toMatchObject({ origin: 'fetch', requestId: next.id }); expect(p.errors).toEqual([]);
    } finally { off(); }
  });

  it('keeps receipt state absent without listeners and after their removal', async () => {
    const p = await setup(draft), receive = vi.fn();
    const state = p.client as unknown as { objectReceiptObservers: unknown };
    expect(state.objectReceiptObservers).toBeUndefined();
    const h = await p.open({ onObject: receive }); await p.send(h.sid, 0n); await p.finish(h.sid); await flush(100);
    expect(receive).toHaveBeenCalledOnce(); expect(state.objectReceiptObservers).toBeUndefined();
    expect(p.client.objectReceiptFor(receive.mock.calls[0]![0])).toBeUndefined();
    const off = p.client.observeObjectReceipts(() => {}); off();
    const next = await p.open(); await p.send(next.sid, 0n); await p.finish(next.sid); await flush(100);
    expect(p.generic).toHaveLength(1); expect(state.objectReceiptObservers).toBeUndefined();
  });

  it('a receipt observer closing the connection prevents a request-owned callback', async () => {
    const p = await setup(draft), receive = vi.fn(), closed = vi.fn();
    const off = p.client.observeObjectReceipts(() => { void p.client.close(); });
    try {
      const h = await p.open({ onObject: receive, onClosed: closed }); await p.send(h.sid, 0n); await flush(100);
      expect(receive).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce();
    } finally { off(); }
  });
});

it.each([14, 16, 18] as const)('Joining FETCH draft %i publishes its own request identity, not its associated SUB id', async draft => {
  const p = await setup(draft), seen: ObjectReceiptObservation[] = [], receive = vi.fn();
  p.server.onSubscribe = () => {};
  const associated = await p.client.subscribe(ns('history'), nm('video'), { subscriptionFilter: { type: 'LargestObject' } }); await flush(100);
  const parameters: Parameters = new Map([[0x09n, draft < 18 ? [Uint8Array.of(7, 8)] : [{ group: 7n, object: 8n }]]]);
  await p.server.acceptSubscribe(associated, 42n, { parameters }); await flush(100);
  const off = p.client.observeObjectReceipts(event => { seen.push(event); });
  try {
    const id = await p.client.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: associated, joiningStart: 7n, receiver: { onObject: receive } });
    await flush(100); p.server.resolveJoiningFetch(id);
    const h = await p.respond(id); await p.send(h.sid, 0n); await p.finish(h.sid); await flush(100);
    expect(receive).toHaveBeenCalledOnce(); expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ origin: 'fetch', trackAlias: null, requestId: id });
    expect(id).not.toBe(associated); expect(p.errors).toEqual([]);
  } finally { off(); }
});

it('draft-22 FILL receipt reports the actual header request and stream without projecting a SUB alias', async () => {
  const p = await setup(22), seen: ObjectReceiptObservation[] = [];
  p.server.onSubscribe = id => { void p.server.acceptSubscribe(id, 42n, { parameters: new Map([[0x09n, [{ group: 7n, object: 0n }]]]) }); };
  const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} }); await flush(100);
  let observedStream: bigint | undefined;
  p.client.onDataStream = (stream, header) => { if (header.type === 'fetch') observedStream = stream; };
  const off = p.client.observeObjectReceipts(event => { seen.push(event); });
  try {
    const stream = await p.server.openFillStream(id); await p.send(stream, 0n); await p.finish(stream); await flush(100);
    expect(p.generic).toHaveLength(1); expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ origin: 'fetch', requestId: id, streamId: observedStream, trackAlias: null });
    expect(p.errors).toEqual([]);
  } finally { off(); }
});

it.each([14, 16, 18] as const)('Joining FETCH draft %i owns its request identity independently of the associated subscription', async draft => {
  const p = await setup(draft), receive = vi.fn(), closed = vi.fn();
  p.server.onSubscribe = () => {};
  const associated = await p.client.subscribe(ns('history'), nm('video'), { subscriptionFilter: { type: 'LargestObject' } });
  await flush(100);
  const parameters: Parameters = new Map([[0x09n, draft < 18 ? [Uint8Array.of(7, 8)] : [{ group: 7n, object: 8n }]]]);
  await p.server.acceptSubscribe(associated, 42n, { parameters }); await flush(100);
  const id = await p.client.joiningFetch({ joiningFetchType: 'absolute', joiningRequestId: associated, joiningStart: 7n, receiver: { onObject: receive, onClosed: closed } });
  await flush(100); p.server.resolveJoiningFetch(id);
  const h = await p.respond(id); await p.send(h.sid, 0n); await p.finish(h.sid); await flush(100);
  expect(id).not.toBe(associated);
  expect(receive).toHaveBeenCalledOnce();
  expect(receive.mock.calls[0]![1]).toMatchObject({ requestId: id, streamId: expect.any(BigInt) });
  expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('fin');
  expect(p.generic).toEqual([]); expect(p.client.session.getSubscription(associated)).toBeDefined();
  expect(p.errors).toEqual([]);
});

describe.each(drafts)('cancel then ownership-throw successor draft %i', draft => {
  it.each([false, true])('protects same-ID successor after callback throws=%s', async throws => {
    const p = await setup(draft), fresh = vi.fn(), closed = vi.fn();
    let successor: Promise<bigint> | undefined, allocated = -1n;
    const old = p.client.fetch(ns('history'), nm('video'), {
      ...range,
      onRequestId: id => { allocated = id; void p.client.fetchCancel(id); if (throws) throw new Error('after cancel'); },
      receiver: { onObject: vi.fn(), onClosed: () => {
        closed(); successor = p.client.fetch(ns('history'), nm('video'), { ...range, receiver: { onObject: fresh } });
      } },
    });
    if (throws) await expect(old).rejects.toThrow('after cancel'); else await old;
    const nextId = await successor!;
    expect(nextId).toBe(allocated);
    expect(closed).toHaveBeenCalledOnce();
    expect(p.client.session.getFetch(nextId), 'old ownership rollback must not remove the same-ID successor').toBeDefined();
    const h = await p.respond(nextId); await p.send(h.sid, 0n); await p.finish(h.sid); await flush(150);
    expect(fresh).toHaveBeenCalledOnce(); expect(p.errors).toEqual([]);
  });
});

it.each(drafts)('cancel then throw without successor leaves draft %i usable', async draft => {
  const p = await setup(draft), closed = vi.fn(), incoming = vi.fn(), receive = vi.fn();
  p.server.onFetch = incoming;
  let allocated = -1n;
  await expect(p.client.fetch(ns('history'), nm('video'), {
    ...range, receiver: { onObject: receive, onClosed: closed },
    onRequestId: id => { allocated = id; void p.client.fetchCancel(id); throw new Error('cancelled then threw'); },
  })).rejects.toThrow('cancelled then threw');
  await flush(100);
  expect(closed).toHaveBeenCalledOnce();
  expect(closed.mock.calls[0]![0]).toBe('local-discard');
  expect(closed.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(p.client.session.getFetch(allocated)).toBeUndefined();
  expect(p.client.session.state).toBe('established'); expect(p.server.session.state).toBe('established');
  expect(incoming).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
  const fresh = vi.fn(), h = await p.open({ onObject: fresh });
  expect(h.id).toBe(allocated);
  await p.send(h.sid, 0n); await p.finish(h.sid); await flush(150);
  expect(fresh).toHaveBeenCalledOnce(); expect(p.errors).toEqual([]);
});

describe.each([14, 16, 18] as const)('Joining cancel-throw draft %i', draft => {
  it.each([false, true])('preserves subscription and successor when reentrant=%s', async reentrant => {
    const p = await setup(draft), receive = vi.fn(), closed = vi.fn();
    p.server.onSubscribe = () => {};
    const associated = await p.client.subscribe(ns('history'), nm('video'), { subscriptionFilter: { type: 'LargestObject' } });
    await flush(100);
    const parameters: Parameters = new Map([[0x09n, draft < 18 ? [Uint8Array.of(7, 8)] : [{ group: 7n, object: 8n }]]]);
    await p.server.acceptSubscribe(associated, 42n, { parameters }); await flush(100);
    const subscription = p.client.session.getSubscription(associated);
    const options = { joiningFetchType: 'absolute' as const, joiningRequestId: associated, joiningStart: 7n };
    let allocated = -1n, successor: Promise<bigint> | undefined;
    await expect(p.client.joiningFetch({ ...options,
      receiver: { onObject: vi.fn(), onClosed: (terminal: DataStreamTerminal, context: FetchReceiveContext) => {
        closed(terminal, context);
        if (reentrant) successor = p.client.joiningFetch({ ...options, receiver: { onObject: receive } });
      } },
      onRequestId: id => { allocated = id; void p.client.fetchCancel(id); throw new Error('joining cancelled then threw'); },
    })).rejects.toThrow('joining cancelled then threw');
    expect(closed).toHaveBeenCalledOnce(); expect(closed.mock.calls[0]![0]).toBe('local-discard');
    expect(p.client.session.getSubscription(associated)).toBe(subscription);
    expect(p.client.session.state).toBe('established');
    if (!reentrant) {
      expect(p.client.session.getFetch(allocated)).toBeUndefined();
      successor = p.client.joiningFetch({ ...options, receiver: { onObject: receive } });
    }
    const id = await successor!;
    expect(id).toBe(allocated); expect(id).not.toBe(associated);
    expect(p.client.session.getFetch(id)).toBeDefined();
    await flush(100); p.server.resolveJoiningFetch(id);
    const h = await p.respond(id); await p.send(h.sid, 0n); await p.finish(h.sid); await flush(150);
    expect(receive).toHaveBeenCalledOnce(); expect(p.generic).toEqual([]);
    expect(p.client.session.getSubscription(associated)).toBe(subscription); expect(p.errors).toEqual([]);
  });
});
