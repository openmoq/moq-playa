import { expect, it, vi } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush, type PipeFaults } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const outcome of ['accept', 'deny', 'reentrant-deny', 'expire'] as const) {
  it(`shared22 pending replay does not block the established member: ${outcome}`, async () => {
    const faults: PipeFaults = {};
    const f = await connectedPair(22, { faults: { a: faults }, serverOptions: { joiningFetchTimeoutMs: outcome === 'expire' ? 20 : 10000 } });
    if (outcome === 'expire') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const firstObjects: bigint[] = [], secondObjects: bigint[] = [];
    const firstClosed: bigint[] = [], secondClosed: bigint[] = [];
    let first = -1n, second = -1n;
    let secondAccepted: Promise<void> | undefined;
    let rejection: Promise<void> | undefined;
    f.server.onPublish = pub => {
      if (pub.requestId === first) {
        pub.onObject = o => firstObjects.push(o.objectId);
        pub.onSubgroupClosed = h => firstClosed.push(h.groupId);
      }
      else {
        second = pub.requestId;
        secondAccepted = (async () => {
          await f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
          pub.onSubgroupClosed = h => secondClosed.push(h.groupId);
          pub.onObject = o => {
            secondObjects.push(o.objectId);
            if (outcome === 'reentrant-deny' && o.objectId === 3n) rejection = f.server.rejectSubscribe(first, 1n, 'declined');
          };
        })();
      }
    };
    try {
      faults.hold = true;
      first = await f.client.publish(ns('shared-replay'), nm('video'), 41n); faults.hold = false;
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(22, { trackAlias: 41n, groupId: 7n }));
      await writer.write(object(22, 2n, new Uint8Array([2]), null)); await flush(128);
      f.a.bidiOut[0]!.out.releaseHeld(); await flush(128);
      await f.client.publish(ns('shared-replay'), nm('video'), 41n); await flush(128);
      expect(secondAccepted).toBeDefined(); await secondAccepted;
      expect(f.server.session.getIncomingSubscription(second)?.isActive).toBe(true);
      expect(firstObjects).toEqual([]);
      await writer.write(object(22, 3n, new Uint8Array([3]), 2n)); await flush(128);
      expect(secondObjects, 'established sibling receives actual bytes before first acceptance').toEqual([3n]);
      if (outcome === 'accept') await f.server.acceptSubscribe(first, 41n);
      else if (outcome === 'deny') await f.server.rejectSubscribe(first, 1n, 'declined');
      else if (outcome === 'reentrant-deny') { expect(rejection).toBeDefined(); await rejection; }
      else { await vi.advanceTimersByTimeAsync(21); await f.server.acceptSubscribe(first, 41n); }
      if (outcome === 'expire') await vi.advanceTimersByTimeAsync(0);
      else await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(firstObjects).toEqual(outcome === 'accept' || outcome === 'expire' ? [2n, 3n] : []);
      await writer.write(object(22, 4n, new Uint8Array([4]), 3n)); await flush(128);
      expect(secondObjects).toEqual([3n, 4n]);
      expect(firstObjects).toEqual(outcome === 'accept' || outcome === 'expire' ? [2n, 3n, 4n] : []);
      if (outcome === 'expire') {
        const fresh = (await f.a.createUnidirectionalStream()).getWriter();
        await fresh.write(streamHeader(22, { trackAlias: 41n, groupId: 8n }));
        await fresh.write(object(22, 0n, new Uint8Array([9]), null)); await flush(128);
        expect(firstObjects).toEqual([2n, 3n, 4n, 0n]);
        expect(secondObjects).toEqual([3n, 4n, 0n]);
        await fresh.close(); await flush(128);
        expect(firstClosed).toEqual([8n]);
        expect(secondClosed).toEqual([8n]);
      }
      await writer.close(); writer = undefined; await flush(128);
      expect(secondClosed).toEqual(outcome === 'expire' ? [8n, 7n] : [7n]);
      expect(firstClosed).toEqual(outcome === 'accept' ? [7n] : outcome === 'expire' ? [8n, 7n] : []);
      expect(f.server.session.state).toBe('established');
    } finally {
      if (outcome === 'expire') vi.useRealTimers();
      faults.hold = false;
      if (writer) await writer.abort(new Error('done')).catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
}
