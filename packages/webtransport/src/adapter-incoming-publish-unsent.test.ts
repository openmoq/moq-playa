import { it, expect } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const draft of [18, 22] as const) {
  it(`draft${draft} withdrawing an unsent confirmed update preserves incoming PUBLISH`, async () => {
    const f = await connectedPair(draft);
    const received: bigint[] = [];
    f.server.onPublish = pub => {
      pub.onObject = o => received.push(o.objectId);
      void f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
    };
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      const id = await f.client.publish(ns('incoming'), nm('video'), 50n);
      await flush(128);
      const owner = f.server.session.getIncomingSubscription(id);
      await expect(f.server.requestUpdateConfirmed(id, {
        subscriberPriority: varint(9n), timeoutMs: 1000,
        onRequestId() { throw new Error('withdraw'); },
      })).rejects.toMatchObject({ disposition: 'not-sent' });
      await flush(128);
      expect(f.server.session.getIncomingSubscription(id)).toBe(owner);
      expect(owner?.state).toBe('established');
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 50n, groupId: 1n }));
      await writer.write(object(draft, 0n, Uint8Array.of(7), null));
      await flush(128);
      expect(received).toEqual([0n]);
      expect(f.errors).toEqual([]);
    } finally {
      if (writer) await writer.abort().catch(() => {});
      await f.client.close();
      await f.server.close();
    }
  });
}
