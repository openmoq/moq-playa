import { expect, it } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [18, 22] as const) {
  it(`draft ${draft}: malformed call joins an ordinary DONE whose actual write is still pending`, async () => {
    const f = await connectedPair(draft);
    const original = f.b.createBidirectionalStream.bind(f.b);
    let block = false;
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.b.createBidirectionalStream = async () => {
      const stream = await original();
      const writer = stream.writable.getWriter();
      return {
        readable: stream.readable,
        writable: new WritableStream<Uint8Array>({
          async write(bytes) { if (block) { entered = true; await held; } await writer.write(bytes); },
          close: () => writer.close(), abort: reason => writer.abort(reason),
        }),
      };
    };
    f.client.onPublish = p => { void f.client.acceptSubscribe(p.requestId, p.trackAlias); };
    try {
      const id = await f.server.publish(ns('ordinary-race'), nm('video'), 7n);
      await flush(128);
      block = true;
      const ordinary = f.server.publishDone(id, varint(2n), 'ordinary first');
      await flush(128);
      expect(entered).toBe(true);
      expect(f.server.session.getOutgoingPublish(id)).toBeUndefined();
      let settled = false;
      const pending = f.server.terminateMalformedPublication(id);
      expect(f.server.terminateMalformedPublication(id)).toBe(pending);
      const malformed = pending.then(result => { settled = true; return result; });
      await flush(128);
      expect(settled, 'logical owner removal is not evidence that the winning terminal write completed').toBe(false);
      release();
      await ordinary;
      expect(await malformed).toEqual({ status: 'already-terminal' });
    } finally { block = false; release(); await f.client.close(); await f.server.close(); }
  });
}
