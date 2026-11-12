import { expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush, type PipeFaults } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const mode of ['healthy', 'bytes', 'events', 'close-capacity', 'reentrant'] as const) {
  it(`releases overflowing shared replay without duplicate delivery: ${mode}`, async () => {
    const faults: PipeFaults = {};
    const f = await connectedPair(22, { faults: { a: faults }, serverOptions: { joiningFetchTimeoutMs: 10000 } });
    const firstObjects: string[] = [], siblingObjects: string[] = [];
    const firstClosed: bigint[] = [], siblingClosed: bigint[] = [], physicalFin: bigint[] = [];
    let first = -1n;
    let siblingAccepted: Promise<void> | undefined;
    let reentrantAccept: Promise<void> | undefined;
    let triggerReentry = false;
    const writers: WritableStreamDefaultWriter<Uint8Array>[] = [];
    f.server.onSubgroupFin = (_id, header) => physicalFin.push(header.groupId);
    f.server.onPublish = pub => {
      if (pub.requestId === first) {
        pub.onObject = o => firstObjects.push(`${o.groupId}/${o.objectId}`);
        pub.onSubgroupClosed = h => firstClosed.push(h.groupId);
      } else {
        siblingAccepted = (async () => {
          await f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
          pub.onSubgroupClosed = h => siblingClosed.push(h.groupId);
          pub.onObject = o => {
            siblingObjects.push(`${o.groupId}/${o.objectId}`);
            if (triggerReentry) {
              triggerReentry = false;
              reentrantAccept = f.server.acceptSubscribe(first, 41n);
            }
          };
        })();
      }
    };
    const open = async (groupId: bigint) => {
      const writer = (await f.a.createUnidirectionalStream()).getWriter();
      writers.push(writer);
      await writer.write(streamHeader(22, { trackAlias: 41n, groupId }));
      return writer;
    };
    try {
      faults.hold = true;
      first = await f.client.publish(ns('withdraw-shared'), nm('video'), 41n);
      faults.hold = false;
      const original = await open(7n);
      await original.write(object(22, 0n, new Uint8Array([0]), null));
      await flush(128);
      f.a.bidiOut[0]!.out.releaseHeld(); await flush(128);
      await f.client.publish(ns('withdraw-shared'), nm('video'), 41n); await flush(128);
      expect(siblingAccepted).toBeDefined(); await siblingAccepted;
      // One early payload occupies a slot; heads do not consume replay capacity.
      const current = await open(9n);
      let previous: bigint | null = null;
      if (mode === 'events' || mode === 'close-capacity') {
        for (let i = 0; i < 255; i++) {
          await current.write(object(22, BigInt(i), new Uint8Array([1]), previous));
          previous = BigInt(i);
        }
        await flush(128);
      }
      if (mode === 'close-capacity') {
        await current.close();
      } else {
        triggerReentry = mode === 'reentrant';
        await current.write(object(22, previous === null ? 0n : previous + 1n,
          new Uint8Array(mode === 'bytes' || mode === 'reentrant' ? 8 * 1024 * 1024 + 1 : 1), previous));
      }
      await flush(128);
      if (mode === 'reentrant') { expect(reentrantAccept).toBeDefined(); await reentrantAccept; }
      else await f.server.acceptSubscribe(first, 41n);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const currentObjects = Array.from({ length: mode === 'events' ? 256 : mode === 'close-capacity' ? 255 : 1 }, (_, i) => `9/${i}`);
      expect(firstObjects).toEqual(['7/0', ...currentObjects]);
      expect(siblingObjects).toEqual(currentObjects);
      if (mode !== 'close-capacity') { await current.close(); }
      await original.close(); await flush(128);
      expect(siblingClosed).toEqual([9n, 7n]);
      expect(firstClosed).toEqual([9n, 7n]);
      expect(physicalFin).toEqual([9n, 7n]);
      expect(siblingObjects.length).toBe(mode === 'events' ? 256 : mode === 'close-capacity' ? 255 : 1);
      const fresh = await open(10n);
      await fresh.write(object(22, 0n, new Uint8Array([9]), null));
      await fresh.close(); await flush(128);
      expect(firstObjects.at(-1)).toBe('10/0');
      expect(siblingObjects.at(-1)).toBe('10/0');
      expect(firstClosed.at(-1)).toBe(10n);
      expect(siblingClosed.at(-1)).toBe(10n);
      expect(physicalFin.at(-1)).toBe(10n);
      expect(f.errors).toEqual([]);
      expect(f.server.session.state).toBe('established');
    } finally {
      faults.hold = false;
      for (const writer of writers) await writer.abort(new Error('done')).catch(() => {});
      await f.client.close(); await f.server.close();
    }
  });
}
