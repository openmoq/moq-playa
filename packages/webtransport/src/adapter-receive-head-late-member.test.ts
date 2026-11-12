import { expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const retireOriginal of [false, true]) it(`draft22 late member learns next location; original retired=${retireOriginal}`, async () => {
  const f = await connectedPair(22);
  f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    const first = await f.client.subscribe(ns('late'), nm('video'));
    await flush(128);
    writer = (await f.b.createUnidirectionalStream()).getWriter();
    await writer.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
    await writer.write(object(22, 2n, new Uint8Array([1]), null)); await flush(128);
    expect(f.client.session.getSubscription(first)?.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    let received = 0;
    let second = -1n;
    await f.client.subscribeTrack(ns('late'), nm('video'), {
      onRequestId: id => { second = id; },
      onObject: o => { if (o.objectId === 3n) received++; },
    });
    if (retireOriginal) await f.client.unsubscribe(first);
    await writer.write(object(22, 3n, new Uint8Array([1]), 2n)); await flush(128);
    expect(received, 'actual newly joined owner receives the same-stream object').toBe(1);
    expect(f.client.session.getSubscription(second)?.largestLocation).toEqual({ groupId: 7n, objectId: 3n });
  } finally {
    if (writer) await writer.abort(new Error('done')).catch(() => {});
    await f.client.close(); await f.server.close();
  }
});
it('draft22 late incoming PUBLISH member joins the already-open shared reader', async () => {
  const f = await connectedPair(22);
  f.client.onPublish = pub => { void f.client.acceptSubscribe(pub.requestId, pub.trackAlias); };
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    await f.server.publish(ns('late-publish'), nm('video'), 41n); await flush(128);
    writer = (await f.b.createUnidirectionalStream()).getWriter();
    await writer.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
    await writer.write(object(22, 2n, new Uint8Array([1]), null)); await flush(128);
    const second = await f.server.publish(ns('late-publish'), nm('video'), 41n); await flush(128);
    await writer.write(object(22, 3n, new Uint8Array([1]), 2n)); await flush(128);
    expect(f.client.session.getIncomingSubscription(second)?.largestLocation).toEqual({ groupId: 7n, objectId: 3n });
  } finally {
    if (writer) await writer.abort(new Error('done')).catch(() => {});
    await f.client.close(); await f.server.close();
  }
});
it('draft22 alias reuse after all owners retire cannot inherit an old partial head', async () => {
  const f = await connectedPair(22);
  f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
  let oldWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let freshWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    const first = await f.client.subscribe(ns('reuse'), nm('video')); await flush(128);
    oldWriter = (await f.b.createUnidirectionalStream()).getWriter();
    await oldWriter.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
    const bytes = object(22, 2n, new Uint8Array(100), null);
    await oldWriter.write(bytes.subarray(0, bytes.length - 99)); await flush(128);
    expect(f.client.session.getSubscription(first)?.largestLocation).toEqual({ groupId: 7n, objectId: 2n });
    await f.client.unsubscribe(first);
    const second = await f.client.subscribe(ns('reuse'), nm('video')); await flush(128);
    expect(f.client.session.getSubscription(second)?.largestLocation).toBeUndefined();
    freshWriter = (await f.b.createUnidirectionalStream()).getWriter();
    await freshWriter.write(streamHeader(22, { trackAlias: 41n, groupId: 8n }));
    await freshWriter.write(object(22, 0n, new Uint8Array([1]), null)); await flush(128);
    expect(f.client.session.getSubscription(second)?.largestLocation).toEqual({ groupId: 8n, objectId: 0n });
  } finally {
    if (oldWriter) await oldWriter.abort(new Error('done')).catch(() => {});
    if (freshWriter) await freshWriter.abort(new Error('done')).catch(() => {});
    await f.client.close(); await f.server.close();
  }
});
