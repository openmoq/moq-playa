import {it,expect} from 'vitest';
import {varint,SessionState,type ControlMessage} from '@openmoq/transport';
import {connectedPair,ns,nm} from './testkit/pair.js';import {flush} from './testkit/loopback.js';
for(const draft of [18,22] as const) for(const poison of [false,true]) it(`d${draft} poison=${poison} rejected unknown DONE cannot suppress a later required UPDATE_FAILED terminal`,async()=>{
 const f=await connectedPair(draft);const messages:ControlMessage[]=[];f.client.onMessage=m=>messages.push(m);
 let id=-1n;f.server.onSubscribe=v=>{id=v};
 try{
  if(poison) await expect(f.server.publishDone(0n,varint(2n),'unknown')).rejects.toThrow();
  const requestId=await f.client.subscribe(ns('proof'),nm('later'));await flush(64);expect(id).toBe(0n);
  await f.server.acceptSubscribe(id,7n);await flush(64);
  f.server.setLargestLocationProvider(()=>({group:5n,object:1n}));
  await f.client.requestUpdate(requestId,{forward:0});await flush(64);
  f.server.setLargestLocationProvider(()=>{throw new Error('source unavailable')});
  await f.client.requestUpdate(requestId,{forward:1});await flush(128);
  const done=messages.filter(m=>m.type==='PUBLISH_DONE');expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({statusCode:varint(8n)});expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
 }finally{await f.client.close();await f.server.close();}
});
