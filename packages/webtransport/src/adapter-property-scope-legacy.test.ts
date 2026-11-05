import { expect, it } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import type { MoqtObject } from '@openmoq/transport';
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(x=>parseInt(x,16)));
async function fixture(draft: 18|22) {
 const conn=new MoqtConnection(draft), transport=new TransportSim(), objects:MoqtObject[]=[], errors:Error[]=[], messages:string[]=[];
 conn.onObject=(_stream,obj)=>{objects.push(obj);};conn.onError=e=>{errors.push(e);};conn.onMessage=m=>{messages.push(m.type);};
 transport.openIncomingUni().push(bytes('af000000')); await conn.connect(transport);
 await conn.fetch([],bytes('76'),{startGroup:0n,startObject:0n,endGroup:9n,endObject:0n});
 return{conn,transport,objects,errors,messages,request:transport.bidi[0]!};
}
for (const draft of [18,22] as const) {
 it(`draft${draft} genuine unsupported mandatory Track Property refuses only its request`,async()=>{
  const f=await fixture(draft);try{
   f.request.push(bytes('18000800020900c0400100'));await flush(512);
   expect(f.request.writeAborted).toBe(true);expect(f.transport.closeInfo).toBeUndefined();expect(f.messages).not.toContain('FETCH_OK');
  }finally{await f.conn.close();}
 });
 it(`draft${draft} preserves the version-specific Track Property GREASE policy`,async()=>{
  const f=await fixture(draft);try{
   // 0x401d = 0x7f*128 + 0x9d; odd Property has empty byte value.
   f.request.push(bytes('18000800020900c0401d00'));await flush(512);
   expect(f.request.writeAborted).toBe(true); // Every mandatory-range type retains the legacy unsupported policy.
   expect(f.transport.closeInfo).toBeUndefined();
  }finally{await f.conn.close();}
 });
 it(`draft${draft} a Mandatory Track Property in an Object cancels before data delivery`,async()=>{
  const f=await fixture(draft);try{
   f.request.push(bytes('18000400020900'));await flush(512);
   f.transport.openIncomingUni().push(bytes('05003f0200030704c040010001aa'));await flush(512);
   expect(f.transport.closeInfo).toBeUndefined();expect(f.objects).toEqual([]);expect(f.request.writeAborted).toBe(true);
  }finally{await f.conn.close();}
 });
}
