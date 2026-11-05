import { describe, expect, it, vi } from 'vitest';
import { createControlCodec } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback } from './testkit/loopback.js';
import { TransportSim } from './testkit/stream-sim.js';

describe.each([18, 22, 23] as const)('draft %i initial SETUP observations', draft => {
  it('observes the actual outgoing and incoming SETUP once on both endpoints', async () => {
    const { a, b } = createLoopback(); const client = new MoqtConnection(draft), server = new MoqtConnection(draft, {role:'server'});
    const left = vi.fn(), right = vi.fn();const removeLeft=client.observeQlogEvents(left), removeRight=server.observeQlogEvents(right);
    try {
      await Promise.all([client.connect(a),server.connect(b)]);
      for (const observer of [left,right]) for(const type of ['control_message_created','control_message_parsed']) {
        expect(observer.mock.calls.filter(([event])=>event.type===type&&event.message.type==='SETUP')).toHaveLength(1);
      }
    }finally{removeLeft();removeRight();await client.close();await server.close();}
  });
  it('isolates app-observer mutation from the message validated by the session',async()=>{
    const {a,b}=createLoopback();const client=new MoqtConnection(draft),server=new MoqtConnection(draft,{role:'server'});const mutated=vi.fn();
    client.onQlogEvent=event=>{if(event.type==='control_message_parsed'&&event.message.type==='SETUP'){mutated();(event.message as {type:string}).type='SUBSCRIBE';}};
    try{await Promise.all([client.connect(a),server.connect(b)]);expect(mutated).toHaveBeenCalledOnce();expect(client.session.state).toBe('established');}
    finally{await client.close();await server.close();}
  });
  it('does not write SETUP when its observation reentrantly closes the connection',async()=>{
    const client=new MoqtConnection(draft),transport=new TransportSim(), observed=vi.fn();
    client.onQlogEvent=event=>{if(event.type==='control_message_created'&&event.message.type==='SETUP'){observed();void client.close().catch(()=>{});}};
    transport.openIncomingUni().push(createControlCodec(draft).encode({type:'SETUP',setupOptions:new Map()}));
    await expect(client.connect(transport)).rejects.toThrow();
    expect(observed).toHaveBeenCalledOnce();expect(transport.uniOut[0]!.writtenBytes()).toHaveLength(0);
  });
});
