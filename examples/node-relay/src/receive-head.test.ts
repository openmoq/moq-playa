import { expect, it, vi } from 'vitest';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import { MessageParam, varint, locationEncodingLength, writeLocation, readLocation, type Parameters } from '@openmoq/transport';
import { Relay } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { streamHeader, object } from '../../../packages/webtransport/src/testkit/object-reception.js';
function headParameters(draft: 16 | 18 | 22, head: { group: bigint; object: bigint }): Parameters {
  if (draft !== 16) return new Map([[MessageParam.LARGEST_OBJECT, [head]]]);
  const encoded = new Uint8Array(locationEncodingLength(head));
  writeLocation(head, encoded, 0);
  return new Map([[MessageParam.LARGEST_OBJECT, [encoded]]]);
}
function confirmedHead(parameters: Parameters) {
  const value = parameters.get(MessageParam.LARGEST_OBJECT)?.[0];
  return value instanceof Uint8Array ? readLocation(value, 0).value : value;
}
async function pair(draft: 16 | 18 | 22, relay: Relay) {
  const {a,b}=createLoopback(); const client=new MoqtConnection(draft),server=new MoqtConnection(draft,{role:'server'});
  relay.setupConnection(server);
  await Promise.all([client.connect(a, { maxRequestId: varint(1000n) }),server.connect(b, { maxRequestId: varint(1000n) })]);return {a,b,client,server};
}
for (const draft of [16,18,22] as const) for (const mode of ['advertised','partial','wire-status','wire-eot','lower-data','complete','retired-owner'] as const) {
  it(`draft${draft} exact relay current head: ${mode}`,async()=>{
    const relay=new Relay(),up=await pair(draft, relay),down=await pair(draft, relay);
    let accepted!:()=>void;const ready=new Promise<void>(r=>{accepted=r;});
    let request=-1n;let completeData=0;
    up.server.onPublish=pub=>{request=pub.requestId;void relay.handlePublish(up.server,pub).then(()=>{
      const forward=pub.onObject;pub.onObject=o=>{if(o.kind==='data')completeData++;forward?.(o);};accepted();
    });};
    down.server.onSubscribe=(id,ns,name)=>{void relay.handleSubscribe(down.server,id,ns,name);};
    const ns=nsBytes(DEMO_NAMESPACE),name=te(DEMO_TRACK),head={group:8n,object:2n};
    let writer:WritableStreamDefaultWriter<Uint8Array>|undefined;
    try {
      const advertised=mode==='advertised'||mode==='lower-data';
      await up.client.publish(ns,name,9n,advertised?{parameters:headParameters(draft,head)}:undefined);await ready;
      const owner=up.server.session.getIncomingSubscription(request)!;
      if(advertised)expect(owner.largestLocation).toEqual({groupId:8n,objectId:2n});
      if(mode==='retired-owner') {
        const sid=await up.client.openSubgroup(9n,8n,0n);
        await up.client.sendObject(sid,2n,Uint8Array.of(1,2,3,4));
        await up.client.closeSubgroup(sid);await flush(128);expect(completeData).toBe(1);
      } else if(mode!=='advertised') {
        writer=(await up.a.createUnidirectionalStream()).getWriter();
        await writer.write(streamHeader(draft,{trackAlias:9n,groupId:mode==='lower-data'?7n:8n}));
        const bytes=object(draft,mode==='lower-data'?1n:2n,(mode==='wire-status'||mode==='wire-eot')?new Uint8Array(0):Uint8Array.of(1,2,3,4),null,mode==='wire-status'?{status:3n}:mode==='wire-eot'?{status:4n}:{});
        await writer.write(mode==='partial'?bytes.subarray(0,bytes.length-3):bytes);await flush(128);
        expect(completeData).toBe(mode==='partial'||mode==='wire-status'||mode==='wire-eot'?0:1);
        if(mode!=='partial'){await writer.close();writer=undefined;await flush(64);}
      }
      if(mode==='retired-owner'){
        await up.client.publishDone(request,varint(0n),'finished');await flush(128);await new Promise<void>(resolve=>setImmediate(resolve));await flush(128);
        expect(up.server.session.getIncomingSubscription(request)).toBeUndefined();
        writer=(await up.a.createUnidirectionalStream()).getWriter();
        await writer.write(streamHeader(draft,{trackAlias:9n,groupId:99n}));
        await writer.write(object(draft,0n,Uint8Array.of(9),null));await flush(128);
        expect(completeData).toBe(1);
      }
      const sub=await down.client.subscribeTrack(ns,name);
      const ack=await down.client.requestUpdateConfirmed(sub.requestId,{subscriberPriority:varint(1n),timeoutMs:1000});
      expect(confirmedHead(ack.parameters)).toEqual(head);
    }finally{
      if(writer)await writer.abort(new Error('test cleanup')).catch(()=>{});
      await Promise.all([up.client.close(),up.server.close(),down.client.close(),down.server.close()]);
    }
  });
}

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} immediate relay query merges unpolled final head before closed reactions`, async () => {
    const relay = new Relay(), up = await pair(draft, relay), down = await pair(draft, relay);
    let pub: IncomingPublish | undefined;
    let handling: Promise<void> | undefined;
    up.server.onPublish = incoming => { pub = incoming; handling = relay.handlePublish(up.server, incoming); };
    down.server.onSubscribe = (id, namespace, name) => { void relay.handleSubscribe(down.server, id, namespace, name); };
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    try {
      await up.client.publish(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK), 9n); await flush(128); await handling;
      const sub = await down.client.subscribeTrack(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
      writer = (await up.a.createUnidirectionalStream()).getWriter();
      await writer.write(streamHeader(draft, { trackAlias: 9n, groupId: 8n }));
      const bytes = object(draft, 2n, Uint8Array.of(1, 2, 3, 4), null);
      await writer.write(bytes.subarray(0, bytes.length - 3)); await flush(128);
      let reacted = false;
      void pub!.closed.then(() => { reacted = true; });
      const closing = up.server.close();
      expect(reacted).toBe(false);
      expect(relay.currentLargestFor(down.server, sub.requestId)).toEqual({ group: 8n, object: 2n });
      await closing; await flush(128);
      expect(reacted).toBe(true);
      expect(relay.currentLargestFor(down.server, sub.requestId)).toEqual({ group: 8n, object: 2n });
      const ack = await down.client.requestUpdateConfirmed(sub.requestId, { subscriberPriority: varint(2n), timeoutMs: 1000 });
      expect(confirmedHead(ack.parameters)).toEqual({ group: 8n, object: 2n });
    } finally {
      if (writer) await writer.abort().catch(() => {});
      await Promise.all([up.client.close(), up.server.close(), down.client.close(), down.server.close()]);
    }
  });
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} repeated exact publication retirement leaves only the scalar track maximum`, async () => {
    const relay = new Relay(), up = await pair(draft, relay), down = await pair(draft, relay);
    let handling: Promise<void> | undefined;
    up.server.onPublish = pub => { handling = relay.handlePublish(up.server, pub); };
    down.server.onSubscribe = (id, namespace, name) => { void relay.handleSubscribe(down.server, id, namespace, name); };
    // Inspection only: no public dead-owner registry or diagnostics dependency.
    const tracks = (relay as unknown as { tracks: Map<string, { publication: { receivedSources: Set<unknown> } }> }).tracks;
    try {
      const namespace = nsBytes(DEMO_NAMESPACE), name = te(DEMO_TRACK);
      const sub = await down.client.subscribeTrack(namespace, name);
      for (let i = 0; i < 24; i++) {
        const id = await up.client.publish(namespace, name, BigInt(i + 9), {
          parameters: headParameters(draft, { group: BigInt(i), object: 0n }),
        });
        await flush(128); await handling;
        await up.client.publishDone(id, varint(0n), 'finished'); await flush(128);
        expect(relay.currentLargestFor(down.server, sub.requestId)).toEqual({ group: BigInt(i), object: 0n });
      }
    } finally { await Promise.all([up.client.close(), up.server.close(), down.client.close(), down.server.close()]); }
  });
}
