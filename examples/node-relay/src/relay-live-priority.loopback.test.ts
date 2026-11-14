import {it,expect} from 'vitest';
import {MoqtConnection} from '@openmoq/webtransport';
import {createLoopback,flush} from '../../../packages/webtransport/src/testkit/loopback.js';
import {Relay} from './relay.js';
it.each(([18,22] as const).flatMap(draft => (['explicit', 'inherited', 'immutable', 'default'] as const).map(mode => ({draft, mode}))))('draft $draft $mode live and FETCH preserve publisher priority',async({draft, mode})=>{
 const up=createLoopback(),down=createLoopback();
 const origin=new MoqtConnection(draft),ingress=new MoqtConnection(draft,{role:'server'}),viewer=new MoqtConnection(draft),egress=new MoqtConnection(draft,{role:'server'});
 const relay=new Relay(),live:number[]=[],history:number[]=[];
 const ns=[new TextEncoder().encode('demo')],name=new TextEncoder().encode('objects');
 ingress.onPublish=p=>{void relay.handlePublish(ingress,p)};
 egress.onSubscribe=(id,ns,name)=>{void relay.handleSubscribe(egress,id,ns,name)};
 egress.onFetch=(id,f)=>{void relay.handleFetch(egress,id,f)};
 try{
 relay.setupConnection(ingress);
 relay.setupConnection(egress);
 await Promise.all([origin.connect(up.a),ingress.connect(up.b),viewer.connect(down.a),egress.connect(down.b)]);
 await origin.publish(ns,name,9n, mode === 'immutable' ? {trackProperties: new Map([[0x0bn, [Uint8Array.of(14, 7)]]])} : mode === 'inherited' ? {trackProperties: new Map([[0x0en, [7n]]])} : undefined);await flush(128);
 await viewer.subscribeTrack(ns,name,{onObject:o=>{if(o.kind==='data')live.push(o.publisherPriority!)},filter:{type:'AbsoluteStart',startGroup:4n,startObject:0n}});await flush(128);
 const sid=await origin.openSubgroup(9n,4n,0n,{...(mode === 'explicit' ? {publisherPriority: 7} : {defaultPriority: true}),endOfGroup:true});
 await origin.sendObject(sid,0n,Uint8Array.of(0));await origin.closeSubgroup(sid);await flush(128);
 await viewer.fetch(ns,name,{startGroup:4n,startObject:0n,endGroup:4n,endObject:1n,receiver:{onObject:o=>{if(o.kind==='data')history.push(o.publisherPriority!)}}});await flush(256);
 expect(live).toEqual([mode === 'default' ? 128 : 7]);
 expect(history).toEqual([mode === 'default' ? 128 : 7]);
 }finally{await Promise.all([origin.close(),ingress.close(),viewer.close(),egress.close()]);}
});

for (const priority of [42, 128]) for (const omittedFirst of [false, true]) {
 it(`inherited priority ${priority} matches an explicit duplicate omittedFirst=${omittedFirst}`, async () => {
  const up=createLoopback(), down=createLoopback(), relay=new Relay();
  const origin=new MoqtConnection(18), ingress=new MoqtConnection(18,{role:'server'}), viewer=new MoqtConnection(18), egress=new MoqtConnection(18,{role:'server'});
  const ns=[new TextEncoder().encode('demo')], name=new TextEncoder().encode('objects'), priorities:number[]=[];
  ingress.onPublish=p=>{void relay.handlePublish(ingress,p)}; egress.onFetch=(id,f)=>{void relay.handleFetch(egress,id,f)};
  try {
   relay.setupConnection(ingress);
   relay.setupConnection(egress);
   await Promise.all([origin.connect(up.a),ingress.connect(up.b),viewer.connect(down.a),egress.connect(down.b)]);
   const id=await origin.publish(ns,name,9n,{trackProperties:new Map([[0x0en,[BigInt(priority)]]])}); await flush(128);
   for (const omitted of [omittedFirst,!omittedFirst]) {
    const sid=await origin.openSubgroup(9n,3n,0n,{firstObject:true,defaultPriority:omitted,publisherPriority:priority});
    await origin.sendObject(sid,0n,Uint8Array.of(3,0)); await origin.closeSubgroup(sid); await flush(128);
   }
   expect(ingress.session.getIncomingSubscription(id)?.isTerminated).toBe(false);
   await viewer.fetch(ns,name,{startGroup:3n,startObject:0n,endGroup:3n,endObject:1n,receiver:{onObject:o=>{if(o.kind==='data')priorities.push(o.publisherPriority!)}}}); await flush(128);
   expect(priorities).toEqual([priority]);
  } finally {await Promise.all([origin.close(),ingress.close(),viewer.close(),egress.close()]);}
 });
}

it('a duplicate with a different resolved publisher priority retires the source', async () => {
 const up=createLoopback(), relay=new Relay(), origin=new MoqtConnection(18), ingress=new MoqtConnection(18,{role:'server'});
 Object.assign(up.b,{createStreamError:(streamErrorCode:number)=>Object.assign(new Error('reset'),{streamErrorCode})});
 ingress.onPublish=p=>{void relay.handlePublish(ingress,p)};
 try {
  relay.setupConnection(ingress);
  await Promise.all([origin.connect(up.a),ingress.connect(up.b)]);
  const id=await origin.publish([new TextEncoder().encode('demo')],new TextEncoder().encode('objects'),9n); await flush(128);
  for (const priority of [7,2]) {
   const sid=await origin.openSubgroup(9n,3n,0n,{publisherPriority:priority,firstObject:true});
   await origin.sendObject(sid,0n,Uint8Array.of(3,0)); await origin.closeSubgroup(sid); await flush(128);
  }
  expect(ingress.session.getIncomingSubscription(id)).toBeUndefined();
  expect(ingress.session.state).toBe('established');
 } finally {await Promise.all([origin.close(),ingress.close()]);}
});
