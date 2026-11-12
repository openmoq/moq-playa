import { expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush, type PipeFaults } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const draft of [16, 18, 22] as const) {
for (const exceedsQuota of [false, true]) {
  it(`S2 byte quota refusal leaves subsequent payload routable: draft${draft}/${exceedsQuota}`, async () => {
    const faults: PipeFaults = {};
    const f = await connectedPair(draft, {
      faults: { a: faults },
      serverOptions: { joiningFetchTimeoutMs: 10000 },
    });
    const objects: bigint[] = [];
    const closed: bigint[] = [];
    let id = -1n;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let admitted = false;
    f.server.onPublish = pub => {
      admitted = true;
      pub.onObject = o => objects.push(o.objectId);
      pub.onSubgroupClosed = h => closed.push(h.groupId);
    };
    try {
      faults.hold = true;
      if (draft === 16) f.a.bidiOut[0]!.out.faults.hold = true;
      id = await f.client.publish(ns('quota-replay'), nm('video'), 41n);
      faults.hold = false;
      await flush(128);
      expect(admitted).toBe(false);
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      await writer.write(object(draft, 0n, new Uint8Array([0]), null));
      await flush(128);
      f.a.bidiOut[0]!.out.releaseHeld();
      await flush(128);
      expect(admitted).toBe(true);
      await writer.write(object(draft, 1n, new Uint8Array(exceedsQuota ? 8 * 1024 * 1024 + 1 : 1), 0n));
      await flush(128);
      await writer.write(object(draft, 2n, new Uint8Array([2]), 1n)).catch(() => {});
      await writer.close().catch(() => {});
      writer = undefined;
      await flush(128);
      expect(objects.filter(id => id !== 0n)).toEqual(exceedsQuota ? [1n, 2n] : []);
      expect(objects).toEqual(exceedsQuota ? [0n, 1n, 2n] : []);
      expect(closed).toEqual(exceedsQuota ? [7n] : []);
      await f.server.acceptSubscribe(id, 41n);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await flush(128);
      // Overflow releases the retained prefix as well as the live suffix main delivers.
      expect(objects).toEqual([0n, 1n, 2n]);
      expect(closed).toEqual([7n]);
      const fresh = (await f.a.createUnidirectionalStream()).getWriter();
      await fresh.write(streamHeader(draft, { trackAlias: 41n, groupId: 8n }));
      await fresh.write(object(draft, 9n, new Uint8Array([9]), null));
      await fresh.close(); await flush(128);
      expect(objects.at(-1)).toBe(9n);
      expect(closed.at(-1)).toBe(8n);
      expect(f.errors).toEqual([]);
    } finally {
      faults.hold = false;
      if (writer) await writer.abort(new Error('done')).catch(() => {});
      await f.client.close();
      await f.server.close();
    }
  });
}
}

// Real endpoints over deterministic loopback, with data overtaking PUBLISH.
for (const draft of [16, 18, 22] as const) for (const mode of ['bytes', 'events', 'healthy'] as const) {
  it(`draft${draft} held PUBLISH replay delivery: ${mode}`, async () => {
    const faults: PipeFaults = {};
    const f = await connectedPair(draft, { faults: { a: faults }, serverOptions: { joiningFetchTimeoutMs: 10000 } });
    const objects: number[] = []; const closed: number[] = [];
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    f.server.onPublish = pub => { pub.onObject = o => objects.push(Number(o.objectId)); pub.onSubgroupClosed = h => closed.push(Number(h.groupId)); };
    try {
      faults.hold = true;
      if (draft === 16) f.a.bidiOut[0]!.out.faults.hold = true;
      const id = await f.client.publish(ns('replay-overflow'), nm('video'), 41n);
      faults.hold = false; await flush(128);
      writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      await writer.write(object(draft, 0n, new Uint8Array([0]), null)); await flush(128);
      f.a.bidiOut[0]!.out.releaseHeld(); await flush(128);
      const sizes = mode === 'events' ? Array.from({ length: 300 }, () => 1)
        : mode === 'bytes' ? [1, 1, 1, 8 * 1024 * 1024 + 1, 1] : [1, 1, 1, 1, 1];
      for (let i = 0; i < sizes.length; i++) {
        await writer.write(object(draft, BigInt(i + 1), new Uint8Array(sizes[i]!), BigInt(i))).catch(() => {});
        if (i % 16 === 0) await flush(16);
      }
      await writer.close().catch(() => {}); writer = undefined; await flush(256);
      expect(objects).toEqual(mode === 'healthy' ? [] : Array.from({ length: sizes.length + 1 }, (_, i) => i));
      await f.server.acceptSubscribe(id, 41n);
      await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(256);
      expect(objects).toEqual(Array.from({ length: sizes.length + 1 }, (_, i) => i));
      expect(closed).toEqual([7]);
      expect(f.server.session.getIncomingSubscription(id)?.largestLocation).toBeUndefined();
      expect(f.server.session.state).toBe('established');
      expect(f.errors).toEqual([]);
    } finally {
      faults.hold = false;
      if (writer) await writer.abort(new Error('done')).catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
}
