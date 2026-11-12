import { it, expect } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
for (const draft of [16,18,22] as const) {
 it(`draft${draft} invalid FETCH priority is not-sent and preserves fetch`, async () => {
  const f=await connectedPair(draft);
  f.server.onFetch=id=>{void f.server.acceptFetch(id,{endLocation:{group:3n,object:5n}})};
  f.server.setFetchLargestLocationProvider?.(()=>null);
  try {
   const id=await f.client.fetch(ns('probe'),nm('v'),{startGroup:3n,startObject:0n,endGroup:3n,endObject:5n});
   await flush(128);
   const admitted: bigint[] = [];
   const updates: bigint[] = [];
   f.server.onMessage = message => { if (message.type === 'REQUEST_UPDATE') updates.push(message.requestId); };
   await expect(f.client.requestUpdateConfirmed(id,{subscriberPriority:varint(256n),timeoutMs:1000,onRequestId: id => admitted.push(id)})).rejects.toMatchObject({disposition:'not-sent'});
   expect(f.client.session.getFetch(id)?.isCompleted).toBe(false);
   expect(admitted).toEqual([]); expect(updates).toEqual([]);
   const next = await f.client.requestUpdateConfirmed(id, { subscriberPriority: 7n, timeoutMs: 1000 });
   expect(next.requestId).toBe(id + 2n);
  } finally {await f.client.close();await f.server.close();}
 });
}
