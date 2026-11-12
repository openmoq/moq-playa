import { it, expect } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
for (const kind of ['subscription','fetch'] as const) it(`d16 unencodable ${kind} provider head refuses update without session loss`,async()=>{
 const f=await connectedPair(16); const messages:string[]=[];
 f.client.onMessage=m=>{messages.push(m.type)};
 f.server.onSubscribe=id=>{void f.server.acceptSubscribe(id,41n)};
 f.server.onFetch=id=>{void f.server.acceptFetch(id,{endLocation:{group:3n,object:5n}})};
 f.server.setLargestLocationProvider(()=>({group:1n<<62n,object:0n}));
 f.server.setFetchLargestLocationProvider?.(()=>({group:1n<<62n,object:0n}));
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
