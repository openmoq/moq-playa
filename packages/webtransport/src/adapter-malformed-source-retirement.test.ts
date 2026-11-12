import { expect, it, vi } from 'vitest';
import type { IncomingPublish } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { streamHeader } from './testkit/object-reception.js';

// Real endpoints over loopback: late bytes use the binding directly to bypass
// the cancelled publisher's local send fence. Timers control guard expiry.
for (const draft of [18, 22] as const) {
  it(`draft ${draft} malformed cancellation guards late streams without retaining alias history`, async () => {
    const f = await connectedPair(draft, { serverOptions: { terminatedAliasTtlMs: 20 } });
    const publications: IncomingPublish[] = [];
    const delivered: bigint[] = [];
    f.server.onPublish = pub => {
      publications.push(pub);
      pub.onObject = object => delivered.push(object.objectId);
      void f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
    };
    Object.assign(f.b, { createStreamError: (code: number) => Object.assign(new Error('loopback reset'), { streamErrorCode: code }) });
    let late: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      const id = await f.client.publish(ns('retirement'), nm('video'), 41n);
      await flush(128);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await expect(f.server.cancelMalformedIncomingPublish(publications[0]!)).resolves.toEqual({ status: 'cancel-issued' });
      expect(f.server.session.getIncomingSubscription(id)).toBeUndefined();
      late = (await f.a.createUnidirectionalStream()).getWriter();
      const pipe = f.a.uniOut.at(-1)!;
      await late.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      await flush(128);
      expect(pipe.readCancelled).toBe(true);
      expect(delivered).toEqual([]);
      await vi.advanceTimersByTimeAsync(21);
      await f.client.publish(ns('retirement'), nm('video'), 41n);
      await flush(128);
      const sid = await f.client.openSubgroup(41n, 8n, 0n);
      await f.client.sendObject(sid, 0n, Uint8Array.of(7));
      await f.client.closeSubgroup(sid);
      await flush(128);
      expect(delivered).toEqual([0n]);
      expect(f.server.session.state).toBe('established');
    } finally {
      vi.useRealTimers();
      if (late) await late.abort().catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
}
