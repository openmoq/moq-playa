import { expect, it } from 'vitest';
import type { IncomingPublish } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const retained of [false]) {
  it(`shared22 reader survives exact-source cancellation, retained=${retained}`, async () => {
    const f = await connectedPair(22);
    const pubs: IncomingPublish[] = [];
    Object.assign(f.b, { createStreamError: (code: number) => Object.assign(new Error('malformed'), { streamErrorCode: code }) });
    f.server.onPublish = pub => {
      pubs.push(pub);
      void f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
    };
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      await f.client.publish(ns('shared-malformed'), nm('video'), 41n);
      await f.client.publish(ns('shared-malformed'), nm('video'), 41n);
      await flush(128);
      const output: bigint[][] = [[], []];
      pubs.forEach((pub, index) => { pub.onObject = item => output[index]!.push(item.objectId); });
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      const pipe = f.a.uniOut.at(-1)!;
      await writer.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
      await writer.write(object(22, 0n, new Uint8Array([1]), null));
      await flush(128);
      expect(output).toEqual([[0n], [0n]]);
      let closed = false;
      void pubs[0]!.closed.then(() => { closed = true; });
      expect(await f.server.cancelMalformedIncomingPublish(pubs[0]!)).toEqual({ status: 'cancel-issued' });
      expect(closed).toBe(true);
      expect(pipe.readCancelled).toBe(false);
      await writer.write(object(22, 1n, new Uint8Array([2]), 0n));
      await flush(128);
      expect(output).toEqual([[0n], [0n, 1n]]);
      expect(pubs[1]!.largestLocation).toEqual({ groupId: 7n, objectId: 1n });
    } finally {
      if (writer) await writer.abort().catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
}
