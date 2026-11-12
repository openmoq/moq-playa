import { it, expect } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import { object, streamHeader } from './testkit/object-reception.js';
import type { IncomingPublish } from './adapter.js';
it('shared22 retires the exact owner while its sibling keeps receiving', async () => {
 const f=await connectedPair(22); const pubs:IncomingPublish[]=[];
 f.server.onPublish=p=>{pubs.push(p);void f.server.acceptSubscribe(p.requestId,p.trackAlias);};
 let w:WritableStreamDefaultWriter<Uint8Array>|undefined;
 try {
  const first=await f.client.publish(ns('cold'),nm('video'),41n);
  await f.client.publish(ns('cold'),nm('video'),41n);await flush(128);
  w=(await f.a.createUnidirectionalStream()).getWriter();
  await w.write(streamHeader(22,{trackAlias:41n,groupId:7n}));
  await w.write(object(22,2n,new Uint8Array([1]),null));await flush(128);
  const output:bigint[]=[];pubs[0]!.onObject=o=>output.push(o.objectId);
  let a=0,b=0;void pubs[0]!.closed.then(()=>{a++;});void pubs[1]!.closed.then(()=>{b++;});
  await f.client.publishDone(first,varint(0n),'done');await flush(128);
  expect(f.server.session.getIncomingSubscription(first)).toBeUndefined();
  await w.write(object(22,3n,new Uint8Array([2]),2n));await flush(128);
  expect(pubs[1]!.largestLocation).toEqual({groupId:7n,objectId:3n});
  expect(b).toBe(0);expect(output).toEqual([]);
  expect(a, 'retired exact owner must settle').toBe(1);
 }finally{if(w)await w.abort().catch(()=>{});await f.client.close();await f.server.close();}
});
