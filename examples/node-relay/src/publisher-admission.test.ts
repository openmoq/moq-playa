import {it,expect,vi} from 'vitest';
import {MoqtConnection} from '@openmoq/webtransport';
import {varint} from '@openmoq/transport';
import {createLoopback,flush} from '../../../packages/webtransport/src/testkit/loopback.js';
vi.mock('./client.js',()=>({connectClient:()=>{throw new Error('not used')}}));
import {establishTrack} from '../../node-publisher/src/publisher.js';
import {publishTrack} from './publisher.js';
for (const source of ['node-relay', 'node-publisher']) for(const draft of [18,22] as const) it(`${source} draft${draft} update accepted before PUBLISH write completion gets known-empty head`,async()=>{
 const {a,b}=createLoopback();
 const producer=new MoqtConnection(draft),receiver=new MoqtConnection(draft,{role:'server'});
 const publish = producer.publish.bind(producer);
 const calls: Parameters<MoqtConnection['publish']>[] = [];
 producer.publish = (...args) => { calls.push(args); return publish(...args); };
 const errors:unknown[]=[];producer.onError=receiver.onError=e=>errors.push(e);
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 let update:Promise<unknown>|undefined; const messages:string[]=[]; receiver.onMessage=m=>messages.push(m.type);
 receiver.onPublish=pub=>{void (async()=>{await receiver.acceptSubscribe(pub.requestId,pub.trackAlias);update=receiver.requestUpdate(pub.requestId,{subscriberPriority:varint(7n)}).then(x=>x,e=>e);})();};
 await Promise.all([producer.connect(a),receiver.connect(b)]);
 const create=a.createBidirectionalStream.bind(a);
 a.createBidirectionalStream=async()=>{const s=await create();const w=s.writable.getWriter();let first=true;
  return {readable:s.readable,writable:new WritableStream<Uint8Array>({async write(bytes){await w.write(bytes);if(first){first=false;await gate;}},close:()=>w.close(),abort:e=>w.abort(e)})};};
 vi.useFakeTimers();
 const publishing=(source === 'node-relay' ? publishTrack(producer,'objects',9n,['one']) : establishTrack(producer,['demo'],'objects',9n)).catch(e=>e);
 try{
  await flush(256);expect(update).toBeDefined();release();await flush(256);
  const result=await update;
  expect(calls[0]?.[3] ?? {}).not.toHaveProperty('onRequestId');
  expect(messages).toContain('REQUEST_OK'); expect(messages).not.toContain('REQUEST_ERROR'); expect(messages).not.toContain('PUBLISH_DONE');
 }finally{release();await vi.advanceTimersByTimeAsync(10001);await publishing;vi.useRealTimers();await producer.close();await receiver.close();}
});
