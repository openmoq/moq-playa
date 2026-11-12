import { expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

async function partial(f: Awaited<ReturnType<typeof connectedPair>>, alias = 41n, group = 7n) {
  const writer = (await f.b.createUnidirectionalStream()).getWriter();
  await writer.write(streamHeader(18, { trackAlias: alias, groupId: group }));
  const bytes = object(18, 2n, new Uint8Array(100).fill(42), null);
  await writer.write(bytes.subarray(0, bytes.length - 99));
  await flush(128);
  return { writer, remaining: bytes.subarray(bytes.length - 99) };
}
for (const beforeBinding of [false, true]) {
  it(`outgoing SUBSCRIBE partial head; beforeBinding=${beforeBinding}`, async () => {
    const f = await connectedPair(18); let id = -1n; let objects = 0;
    f.server.onSubscribe = () => {};
    const subscribing = f.client.subscribeTrack(ns('head'), nm('video'), { onRequestId: n => { id = n; }, onObject: () => { objects++; } });
    void subscribing.catch(() => {});
    let wire: Awaited<ReturnType<typeof partial>> | undefined;
    try {
      await flush(128);
      if (!beforeBinding) { await f.server.acceptSubscribe(id, 41n); await subscribing; }
      wire = await partial(f);
      expect(objects).toBe(0);
      if (beforeBinding) {
        expect(f.client.session.getSubscription(id)?.isPending).toBe(true);
        await f.server.acceptSubscribe(id, 41n); await subscribing; await flush(128);
      }
      expect(objects).toBe(0);
      expect(f.client.session.getSubscription(id)?.largestLocation).toEqual(beforeBinding ? undefined : { groupId: 7n, objectId: 2n });
    } finally { if (wire) await wire.writer.abort(new Error('test teardown')); await f.client.close(); await f.server.close(); }
  });
}
it('a partial header from a cancelled pending generation cannot claim a later request', async () => {
  const f = await connectedPair(18); f.server.onSubscribe = () => {};
  let a = -1n, b = -1n;
  const first = f.client.subscribeTrack(ns('head'), nm('old'), { onRequestId: id => { a = id; } }); void first.catch(() => {});
  let wire: Awaited<ReturnType<typeof partial>> | undefined;
  try {
    await flush(128); wire = await partial(f);
    await f.client.unsubscribe(a); await flush(128);
    const second = f.client.subscribeTrack(ns('head'), nm('new'), { onRequestId: id => { b = id; } }); void second.catch(() => {});
    await flush(128); await f.server.acceptSubscribe(b, 41n); await second; await flush(128);
    expect(f.client.session.getSubscription(b)?.largestLocation).toBeUndefined();
    await wire.writer.write(wire.remaining); await flush(128);
    expect(f.client.session.getSubscription(b)?.largestLocation).toBeUndefined();
  } finally { if (wire) await wire.writer.abort(new Error('test teardown')); await f.client.close(); await f.server.close(); }
});
it('tombstoned alias cannot advance retired owner; a new alias still receives its own head', async () => {
  const f = await connectedPair(18); f.server.onSubscribe = () => {};
  let id = -1n; const first = f.client.subscribeTrack(ns('head'), nm('old'), { onRequestId: n => { id = n; } }); void first.catch(() => {});
  let oldWire: Awaited<ReturnType<typeof partial>> | undefined, late: Awaited<ReturnType<typeof partial>> | undefined, fresh: Awaited<ReturnType<typeof partial>> | undefined;
  try {
    await flush(128); await f.server.acceptSubscribe(id, 41n); await first;
    oldWire = await partial(f);
    const owner = f.client.session.getSubscription(id)!; const prior = owner.largestLocation;
    await f.client.unsubscribe(id); await flush(128);
    late = await partial(f, 41n, 99n);
    expect(owner.largestLocation).toEqual(prior);
    let newId = -1n; const second = f.client.subscribeTrack(ns('head'), nm('new'), { onRequestId: n => { newId = n; } }); void second.catch(() => {});
    await flush(128); await f.server.acceptSubscribe(newId, 43n); await second;
    fresh = await partial(f, 43n, 8n);
    expect(f.client.session.getSubscription(newId)?.largestLocation).toEqual({ groupId: 8n, objectId: 2n });
    expect(owner.largestLocation).toEqual(prior);
  } finally { for (const w of [oldWire, late, fresh]) if (w) await w.writer.abort(new Error('test teardown')).catch(() => {}); await f.client.close(); await f.server.close(); }
});

it('held SUBSCRIBE_OK does not attribute a previously parsed partial head', async () => {
  const f = await connectedPair(18); f.server.onSubscribe = () => {};
  let id = -1n; let delivered = 0;
  const subscribing = f.client.subscribeTrack(ns('held'), nm('video'), { onRequestId: n => { id = n; }, onObject: () => { delivered++; } });
  void subscribing.catch(() => {});
  let wire: Awaited<ReturnType<typeof partial>> | undefined;
  try {
    await flush(128);
    const responsePipe = f.a.bidiOut[0]!.in;
    responsePipe.faults.hold = true;
    await f.server.acceptSubscribe(id, 41n);
    wire = await partial(f);
    expect(f.client.session.getSubscription(id)?.isPending).toBe(true);
    expect(delivered).toBe(0);
    responsePipe.faults.hold = false; responsePipe.releaseHeld();
    await subscribing; await flush(128);
    expect(delivered).toBe(0);
    expect(f.client.session.getSubscription(id)?.largestLocation).toBeUndefined();
  } finally { if (wire) await wire.writer.abort(new Error('test teardown')); await f.client.close(); await f.server.close(); }
});

it('generic SUBSCRIBE does not attribute an unknown-first stream', async () => {
  const f = await connectedPair(18); f.server.onSubscribe = () => {};
  const writer = (await f.b.createUnidirectionalStream()).getWriter();
  try {
    const id = await f.client.subscribe(ns('generic'), nm('video'));
    await flush(128);
    await writer.write(streamHeader(18, { trackAlias: 41n, groupId: 7n })); await flush(128);
    await f.server.acceptSubscribe(id, 41n); await flush(128);
    expect(f.client.session.getSubscription(id)?.largestLocation).toBeUndefined();
    const bytes = object(18, 2n, new Uint8Array(100), null);
    await writer.write(bytes.subarray(0, bytes.length - 99)); await flush(128);
    expect(f.client.session.getSubscription(id)?.largestLocation).toBeUndefined();
  } finally { await writer.abort(new Error('test teardown')); await f.client.close(); await f.server.close(); }
});

it('incoming PUBLISH acquires head while application acceptance is held', async () => {
  const f = await connectedPair(18); let id = -1n; let delivered = 0;
  f.server.onPublish = pub => { id = pub.requestId; pub.onObject = () => { delivered++; }; };
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    await f.client.publish(ns('held'), nm('video'), 41n); await flush(128);
    expect(f.server.session.getIncomingSubscription(id)?.isPending).toBe(true);
    writer = (await f.a.createUnidirectionalStream()).getWriter();
    await writer.write(streamHeader(18, { trackAlias: 41n, groupId: 7n }));
    const bytes = object(18, 2n, new Uint8Array(100), null);
    await writer.write(bytes.subarray(0, bytes.length - 99)); await flush(128);
    expect(delivered).toBe(0);
    expect(f.server.session.getIncomingSubscription(id)?.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    await f.server.acceptSubscribe(id, 41n); await flush(128);
    expect(f.server.session.getIncomingSubscription(id)?.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
  } finally { if (writer) await writer.abort(new Error('test teardown')); await f.client.close(); await f.server.close(); }
});
