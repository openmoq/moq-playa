import { expect, it } from 'vitest';
import type { MoqtObject } from '@openmoq/transport';
import type { ObjectReceiptObservation } from './object-receipts.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush, type PipeFaults } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';

for (const draft of [18, 22] as const) for (const reentrant of [false, true]) {
  it(`draft${draft} preserves generic receipt and exact owned replay; callback releases PUBLISH=${reentrant}`, async () => {
    const faults: PipeFaults = {};
    const f = await connectedPair(draft, { faults: { a: faults } });
    const generic: MoqtObject[] = [], owned: MoqtObject[] = [];
    const receipts: ObjectReceiptObservation[] = [], order: string[] = [];
    let accepted: Promise<void> | undefined;
    let id = -1n;
    const release = () => { faults.hold = false; f.a.bidiOut[0]!.out.releaseHeld(); };
    const off = f.server.observeObjectReceipts(r => { receipts.push(r); });
    f.server.onObject = (_sid, obj) => {
      generic.push(obj);
      expect(f.server.session.getIncomingSubscription(id), 'unbound receipt is not an owned head').toBeUndefined();
      if (reentrant) release();
    };
    f.server.onPublish = pub => {
      accepted = (async () => {
        await f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
        pub.onObject = obj => { owned.push(obj); order.push('object'); };
        pub.onSubgroupClosed = () => { order.push('fin'); };
      })();
    };
    try {
      faults.hold = true;
      id = await f.client.publish(ns('receipt'), nm('video'), 41n);
      faults.hold = false; // Keep only the already-written control bytes held.
      const writer = (await f.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
      await writer.write(object(draft, 2n, new Uint8Array([1, 2]), null));
      await flush(128);
      expect(generic).toHaveLength(1);
      const token = f.server.objectReceiptFor(generic[0]!);
      expect(token).toBeDefined();
      await writer.close(); await flush(128);
      if (!reentrant) { expect(owned).toEqual([]); release(); }
      await flush(128); expect(accepted).toBeDefined(); await accepted;
      await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(128);
      expect(generic).toHaveLength(1);
      expect(owned).toHaveLength(1);
      expect(owned[0]).toBe(generic[0]);
      expect(f.server.objectReceiptFor(owned[0]!)).toBe(token);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.receipt).toBe(token);
      expect(order).toEqual(['object', 'fin']);
      await genericBinding(draft);
      expect(f.server.session.getIncomingSubscription(id)?.largestLocation).toBeUndefined();
    } finally { off(); faults.hold = false; await f.client.close(); await f.server.close(); }
  });
}


// An unknown alias can instead be claimed by SUBSCRIBE_OK. Its old payload
// must not become a later PUBLISH's prefix when the alias is reused.
async function genericBinding(draft: 18 | 22) {
  const f = await connectedPair(draft);
  const owned: bigint[] = [];
  let accepted: Promise<void> | undefined;
  f.server.onPublish = pub => {
    accepted = f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
    pub.onObject = obj => owned.push(obj.objectId);
  };
  try {
    const id = await f.server.subscribe(ns('generic-binding'), nm('video'));
    await flush(128);
    const writer = (await f.a.createUnidirectionalStream()).getWriter();
    await writer.write(streamHeader(draft, { trackAlias: 41n, groupId: 7n }));
    await writer.write(object(draft, 2n, new Uint8Array([2]), null));
    await writer.close(); await flush(128);
    await f.client.acceptSubscribe(id, 41n); await flush(128);
    await f.server.unsubscribe(id); await flush(128);
    await f.client.publish(ns('generic-binding'), nm('video'), 41n); await flush(128);
    expect(accepted).toBeDefined(); await accepted;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(owned).toEqual([]);
    expect(f.errors).toEqual([]);
  } finally { await f.client.close(); await f.server.close(); }
}
