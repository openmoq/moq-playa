import { expect, it, vi } from 'vitest';
import { SessionState, varint, type ControlMessage } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
for (const draft of [18,22] as const) {
 it(`d${draft} ordinary duplicate cannot replace the winning terminal promise`,async()=>{
  const f=await connectedPair(draft);const create=f.b.createBidirectionalStream.bind(f.b);let hold=false,release!:()=>void;
  const gate=new Promise<void>(r=>release=r);
  f.b.createBidirectionalStream=async()=>{const stream=await create();const w=stream.writable.getWriter();return {readable:stream.readable,writable:new WritableStream<Uint8Array>({async write(b){if(hold)await gate;await w.write(b)},close:()=>w.close(),abort:r=>w.abort(r)})}};
  f.client.onPublish=p=>{void f.client.acceptSubscribe(p.requestId,p.trackAlias)};
  try {const id=await f.server.publish(ns('proof'),nm('duplicate'),7n);await flush(64);hold=true;
   const first=f.server.publishDone(id,varint(2n),'first');await flush(32);
   await f.server.publishDone(id,varint(2n),'duplicate').catch(()=>{});
   let settled=false;const joined=f.server.terminateMalformedPublication(id).then(v=>{settled=true;return v},e=>{settled=true;return e});
   await flush(32);expect(settled).toBe(false);release();await first;expect(await joined).toEqual({status:'already-terminal'});
  }finally{release();await f.client.close();await f.server.close();}
 });
}
