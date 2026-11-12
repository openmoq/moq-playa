import {it,expect} from 'vitest';
import { varint } from '@openmoq/transport';
import {MoqtConnection} from '@openmoq/webtransport';
import {createLoopback,flush} from '../../../packages/webtransport/src/testkit/loopback.js';
import {Relay} from './relay.js';
it.each(([14,16,18,22] as const).flatMap(draft => (['missing-prefix', 'evicted-prefix', 'below-start', 'complete'] as const).map(mode => ({draft, mode}))))('draft $draft $mode subgroup coverage',async({draft, mode})=>{
 const up=createLoopback(),down=createLoopback();
 const origin=new MoqtConnection(draft),ingress=new MoqtConnection(draft,{role:'server'}),viewer=new MoqtConnection(draft),egress=new MoqtConnection(draft,{role:'server'});
 Object.assign(down.b, { createStreamError: (code: number) => Object.assign(new Error('loopback reset'), {streamErrorCode: code}) });
 const relay=new Relay(mode === 'evicted-prefix' ? {historyCache: {maxBytes: 1}} : {}),data:bigint[]=[],terms:string[]=[];
 const ns=[new TextEncoder().encode('demo')],name=new TextEncoder().encode('objects');
 ingress.onPublish=p=>{void relay.handlePublish(ingress,p)};
 egress.onSubscribe=(id,ns,name)=>{void relay.handleSubscribe(egress,id,ns,name)};
 viewer.onStreamClosed=(_id,_error,terminal)=>terms.push(terminal);
 try{
 await Promise.all([origin.connect(up.a,{maxRequestId:varint(1000n)}),ingress.connect(up.b,{maxRequestId:varint(1000n)}),viewer.connect(down.a,{maxRequestId:varint(1000n)}),egress.connect(down.b,{maxRequestId:varint(1000n)})]);
 await origin.publish(ns,name,9n);await flush(128);
 const sid=await origin.openSubgroup(9n,4n,0n,{endOfGroup:true});
 if (mode !== 'complete') { await origin.sendObject(sid,0n,(mode === 'evicted-prefix' ? Uint8Array.of(0, 0) : Uint8Array.of(0)));await flush(128); }
 const sub=await viewer.subscribeTrack(ns,name,{onObject:o=>{if(o.kind==='data')data.push(o.objectId)},filter:{type:'AbsoluteStart',startGroup:4n,startObject:mode === 'below-start' ? 1n : 0n}});
 sub.onObject=o=>{if(o.kind==='data')data.push(o.objectId)};await flush(128);
 if (mode === 'complete') { await origin.sendObject(sid,0n,Uint8Array.of(0));await flush(128); }
 await origin.sendObject(sid,1n,Uint8Array.of(1));await origin.closeSubgroup(sid);await flush(256);
 expect(data).toEqual(mode === 'complete' ? [0n, 1n] : [1n]);
 expect(terms).toEqual([mode === 'missing-prefix' || mode === 'evicted-prefix' ? 'reset' : 'fin']);
 expect(egress.session.state).toBe('established');
 }finally{await Promise.all([origin.close(),ingress.close(),viewer.close(),egress.close()]);}
});
