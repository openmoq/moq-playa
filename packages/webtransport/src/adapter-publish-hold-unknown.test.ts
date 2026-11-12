import { expect, it } from 'vitest';
import { encodeObjectDatagram, encodeObjectDatagram18 } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush, type PipeFaults } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';
function dg(draft: 16 | 18 | 22) {
  return (draft === 16 ? encodeObjectDatagram : encodeObjectDatagram18)({
    typeByte: 0, trackAlias: 41n, groupId: 7n, objectId: 2n,
    publisherPriority: 128, isEndOfGroup: false, extensions: undefined,
    status: undefined, payload: new Uint8Array([42]),
  });
}
async function overtaken(draft: 16 | 18 | 22, delivery: 'partial' | 'complete' | 'datagram') {
  const faults: PipeFaults = {};
  const f = await connectedPair(draft, { faults: { a: faults } });
  let published = 0;
  const payloads: number[][] = [];
  f.server.onPublish = pub => {
    published++;
    void (async () => {
      await f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
      pub.onObject = o => { if (o.kind === 'data') payloads.push([...o.payload]); };
    })();
  };
  f.server.onDatagram = d => { payloads.push([...d.payload]); };
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    faults.hold = true;
    if (draft === 16) f.a.bidiOut[0]!.out.faults.hold = true;
    const id = await f.client.publish(ns('overtake'), nm('video'), 41n);
    faults.hold = false;
    await flush(128);
    expect(published).toBe(0);
    expect(f.server.session.getIncomingSubscription(id)).toBeUndefined();
    const bytes = object(draft, 2n, new Uint8Array([42, 43, 44]), null);
    if (delivery === 'datagram') {
      const dw = f.a.datagrams.writable.getWriter();
      try { await dw.write(dg(draft)); } finally { dw.releaseLock(); }
    } else {
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      await writer.write(delivery === 'partial' ? bytes.subarray(0, bytes.length - 2) : bytes);
    }
    await flush(128);
    expect(published).toBe(0);
    f.a.bidiOut[0]!.out.releaseHeld(); await flush(128);
    expect(published).toBe(1);
    const owner = f.server.session.getIncomingSubscription(id)!;
    expect(owner.isActive).toBe(true);
    if (delivery === 'partial') { await writer!.write(bytes.subarray(bytes.length - 2)); await flush(128); }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(payloads, 'no payload loss or duplicate delivery').toEqual(delivery === 'datagram' ? [[42]] : [[42, 43, 44]]);
    expect(owner.largestLocation).toBeUndefined();
  } finally {
    faults.hold = false;
    if (writer) await writer.abort(new Error('done')).catch(() => {});
    await f.client.close(); await f.server.close();
  }
}
for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} first PUBLISH overtaken by complete retains payload without attributing an unknown-first head`, async () => {
    await overtaken(draft, 'complete');
    await overtaken(draft, 'partial');
    await overtaken(draft, 'datagram');
  });
}
