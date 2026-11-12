// Loopback probe with injected binding abort failures.
import { expect, it } from 'vitest';
import { SessionState } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
for (const draft of [14,16,18,22] as const) for (const mode of ['healthy','already-errored','abort-reject']) {
 it(`draft ${draft} cancelled allocation backend=${mode} preserves sibling`, async () => {
 const f = await connectedPair(draft);
 let count=0;
 f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, ++count === 1 ? 7n : 8n); };
 const target=await f.client.subscribeTrack(ns('probe'), nm('target'));
 const sibling=await f.client.subscribeTrack(ns('probe'), nm('sibling'));
 const create=f.b.createUnidirectionalStream.bind(f.b);
 let release!: () => void;
 f.b.createUnidirectionalStream = () => new Promise(resolve => {
   release = () => resolve(new WritableStream<Uint8Array>({ start(c) { if (mode === 'already-errored') c.error(new Error('stream reset by transport')); }, abort() { if (mode === 'abort-reject') throw new Error('binding abort refused'); } }));
 });
 try {
   const opening=f.server.openSubgroup(7n,0n,0n).catch(error=>error);
   await flush(64);
   await target.unsubscribe(); await flush(128);
   release(); expect(await opening).toBeInstanceOf(Error);
   f.b.createUnidirectionalStream=create;
   expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
   const received:number[]=[];
   sibling.onObject=o=>{ if(o.kind==='data') received.push(...o.payload); };
   const sid=await f.server.openSubgroup(8n,0n,0n);
   await f.server.sendObject(sid,0n,Uint8Array.of(71)); await f.server.closeSubgroup(sid); await flush(64);
   expect(received).toEqual([71]);
 } finally { await f.client.close(); await f.server.close(); }
 });
}
