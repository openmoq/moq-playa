import { it, expect } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
for (const draft of [16,18,22] as const) for (const kind of ['subscription'] as const) it(`d${draft} long ordinary ${kind} provider exception refuses update without session loss`,async()=>{
 const f=await connectedPair(draft); const messages:string[]=[];
 f.client.onMessage=m=>{messages.push(m.type)};
 f.server.onSubscribe=id=>{void f.server.acceptSubscribe(id,41n)};
 f.server.onFetch=id=>{void f.server.acceptFetch(id,{endLocation:{group:3n,object:5n}})};
 f.server.setLargestLocationProvider(()=>{throw new Error('x'.repeat(1100))});
 f.server.setFetchLargestLocationProvider?.(()=>{throw new Error('x'.repeat(1100))});
 try {
  const id= kind==='subscription'? await f.client.subscribe(ns('probe'),nm('v')) : await f.client.fetch(ns('probe'),nm('v'),{startGroup:3n,startObject:0n,endGroup:3n,endObject:5n});
  await flush(128);messages.length=0;
  await f.client.requestUpdate(id,{subscriberPriority:varint(7n)}).catch(()=>{});await flush(256);
  expect(messages).toContain('REQUEST_ERROR');
  expect(messages).not.toContain('REQUEST_OK');
  expect(f.server.session.state).toBe('established');
  expect(f.client.session.state).toBe('established');
 }finally{await f.client.close();await f.server.close();}
});
