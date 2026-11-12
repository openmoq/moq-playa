import {it,expect,vi} from 'vitest';
import { SessionState } from '@openmoq/transport';
import {connectedPair,ns,nm} from './testkit/pair.js';
import {flush} from './testkit/loopback.js';
for(const draft of [18,22] as const) for(const mode of ['reject', 'hold']) it(`d${draft} ${mode} publisher FETCH receive-only failure must remain local`,async()=>{
 const f=await connectedPair(draft);f.server.onFetch=()=>{};
 Object.assign(f.b,{createStreamError:()=>new Error('abort'),resetSendStream:(w:WritableStreamDefaultWriter<Uint8Array>,r:Error)=>w.abort(r)});
 try{
  const id=await f.client.fetch(ns('test'),nm('target'),{startGroup:0n,startObject:0n,endGroup:0n,endObject:1n});await flush(64);
  await f.server.acceptFetch(id,{endLocation:{group:0n,object:1n}});await f.server.openFetchStream(id);
  const contexts=(f.server as unknown as {inboundRequestContexts:Map<bigint,{reader:ReadableStreamDefaultReader<Uint8Array>}>}).inboundRequestContexts;
  const cancel=vi.spyOn(contexts.get(id)!.reader,'cancel').mockImplementation(() => mode === 'hold' ? new Promise<void>(() => {}) : Promise.reject(new Error('receive cancellation refused')));
  const data=f.b.uniOut.at(-1)!;const request=f.a.bidiOut.at(-1)!;
  vi.useFakeTimers(); const aborted = f.server.abortIncomingFetch(id).catch(e => e);
  await vi.advanceTimersByTimeAsync(1100); expect(await aborted).toBeInstanceOf(Error); vi.useRealTimers();
  expect(data.writeAborted).toBe(true);expect(request.in.writeAborted || request.in.writeClosed).toBe(true);
  expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
  cancel.mockRestore();
  const received: bigint[] = []; f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 7n); };
  await f.client.subscribeTrack(ns('sibling'), nm('video'), { onObject: o => received.push(o.objectId) });
  const sid = await f.server.openSubgroup(7n, 0n, 0n); await f.server.sendObject(sid, 0n, Uint8Array.of(1));
  await flush(64); expect(received).toEqual([0n]);
 }finally{vi.useRealTimers();await f.client.close();await f.server.close();}
});
