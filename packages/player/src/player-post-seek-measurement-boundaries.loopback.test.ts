import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocmafEncoder, LocmafGroupState, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { parseLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { ReceivedPayloadRate } from './received-payload-rate.js';
import { fixture, retainedHandoff, exactRetainedOutput, init } from '../test-support/seek-live-mse.js';
import { MessageParam } from '@openmoq/transport';
import { setup, measurements, coded, properties } from '../test-support/post-seek-measurement.js';

beforeEach(() => vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each([18,22] as const)('adopted MSE receipt rate draft%i', draft => {
  it('counts only accepted live suffix at arrival and warms rate on the retained native resource', async () => {
    const f = await fixture(draft,true,undefined,{receiptClock:true});
    const observed = vi.spyOn(ReceivedPayloadRate.prototype,'observe');
    const receipts: Array<[number,number]> = []; let now = 100_000;
    const stop = f.client.observeObjectReceipts(event => {
      if(event.origin === 'subgroup' && event.trackAlias === 201n && event.objectStatus === 0n) receipts.push([event.payloadBytes,now]);
    });
    try {
      await retainedHandoff(f,false); f.complete(3); await flush(512); exactRetainedOutput(f);
      expect(observed.mock.calls, 'FETCH/JOIN/FILL never counted; first live suffix already counted').toEqual(receipts);
      expect(receipts).toHaveLength(1);
      for(let index=0;index<13;index++) {
        now=600_000+index*500_000; f.setNow(now); f.advance(10+index*0.5); f.player.tick(); await flush(512);
        const group=BigInt(4+index), encoder=new LocmafEncoder(), state=new LocmafGroupState();
        const chunk=buildChunk({trackId:1,bmdt:BigInt(12000+index*500),samples:[{duration:500,size:1000,flags:SYNC_FLAGS}],mdat:new Uint8Array(1000)});
        const payload=serializeLocmafObject(encoder.encode(chunk,state,parseLocmafTrackContext(init),false,0n));
        const stream=await f.server.openSubgroup(201n,group,0n,{publisherPriority:128,endOfGroup:true});
        await f.server.sendObject(stream,0n,payload); await f.server.closeSubgroup(stream); await flush(512);
        expect(f.errors).toEqual([]); expect(f.submissions).toHaveLength(5+index); f.complete(4+index); await flush(512); f.player.tick();
      }
      expect(receipts).toHaveLength(14); expect(observed.mock.calls).toEqual(receipts);
      expect(f.resources).toHaveLength(1); expect(f.resources[0]!.cancel).not.toHaveBeenCalled();
      expect(f.nativeBytes).toHaveLength(17); expect(f.errors).toEqual([]);
      expect(measurements(f.player).readVideoReceivedRate(), 'actual accepted suffix warms adopted MSE owner').toBeGreaterThan(0);
      expect(measurements(f.player).estimatedGopDurationUs, 'LOCMAF is not raw LOC cadence').toBe(2_000_000);
    } finally {stop();await f.destroy();}
  });
});

it.each([18,22] as const)('LOC04 draft%i inherits accepted SUB timescale when live Objects omit it', async draft => {
  const h=await setup(draft,{inherited:true});
  const raw: Array<ReturnType<typeof parseLocHeaders>>=[];
  const original=h.f.client.subscribeTrack.bind(h.f.client);
  const spy=vi.spyOn(h.f.client,'subscribeTrack').mockImplementation((ns,name,options)=>original(ns,name,{...options,onObject:object=>{
    if(object.kind==='data' && object.objectId===0n) raw.push(parseLocHeaders(object.properties??object.extensions,{wireProfile:locWireProfileForDraft(draft)}));
    options?.onObject?.(object);
  }}));
  try {
    await h.readyLive();
    h.advance(600_000); await h.sendLive(201n,5n,0n,3500n);
    expect(measurements(h.f.player).estimatedGopDurationUs).toBe(2_000_000);
    h.advance(1_100_000); await h.sendLive(201n,6n,0n,4000n);
    expect(raw).toHaveLength(2); expect(raw.every(headers=>headers.timescale===undefined)).toBe(true);
    expect(h.decodeTimes.map(row=>row.timestamp)).toContain(4_000_000);
    expect(h.f.errors).toEqual([]);
    expect(measurements(h.f.player).estimatedGopDurationUs, '500 ticks at inherited1000Hz is500ms, not500us').toBe(500_000);
  } finally {spy.mockRestore();await h.close();}
});

it.each([false,true])('held transform retains measurement owner across mode ABA=%s, preserving playback',async aba=>{
  let release!:()=>void, entered=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const h=await setup(18,{objectTransform:async object=>{
    if(object.kind==='data'&&object.groupId===5n){entered=true;await gate;} return object;
  }});
  try {
    await h.readyLive(); h.f.player.setAutoQuality(true);
    h.advance(600_000);await h.sendLive(201n,5n,0n,3500n);
    expect(entered).toBe(true);expect(h.decodeTimes.some(row=>row.timestamp===3_500_000)).toBe(false);
    if(aba){h.f.player.setAutoQuality(false);h.f.player.setAutoQuality(true);}
    release();await flush(512);
    expect(h.decodeTimes.some(row=>row.timestamp===3_500_000)).toBe(true);
    h.advance(1_100_000);await h.sendLive(201n,6n,0n,4000n);
    expect(measurements(h.f.player).estimatedGopDurationUs).toBe(aba?2_000_000:500_000);
    h.advance(1_600_000);await h.sendLive(201n,7n,0n,4500n);
    expect(measurements(h.f.player).estimatedGopDurationUs).toBe(500_000);expect(h.f.errors).toEqual([]);
  }finally{release();await h.close();}
});

it.each([false,true])('public media_object mode ABA=%s excludes initiating stale cadence but preserves decoding',async aba=>{
  const h=await setup(18);let called=0;
  try{
    await h.readyLive();h.f.player.setAutoQuality(true);
    const stop=h.f.player.on('media_object',event=>{
      if(event.mediaType==='video'&&event.groupId===5n&&event.kind==='data'){
        called++;if(aba){h.f.player.setAutoQuality(false);h.f.player.setAutoQuality(true);}
      }
    });
    h.advance(600_000);await h.sendLive(201n,5n,0n,3500n);stop();
    expect(called).toBe(1);expect(h.decodeTimes.some(row=>row.timestamp===3_500_000)).toBe(true);
    h.advance(1_100_000);await h.sendLive(201n,6n,0n,4000n);
    expect(measurements(h.f.player).estimatedGopDurationUs).toBe(aba?2_000_000:500_000);
    h.advance(1_600_000);await h.sendLive(201n,7n,0n,4500n);
    expect(measurements(h.f.player).estimatedGopDurationUs).toBe(500_000);expect(h.f.errors).toEqual([]);
  }finally{await h.close();}
});

it.each(['none','auto','pause'] as const)('receipt clock callback lifetime change=%s cannot seed retired rate/cadence',async change=>{
  const h=await setup(18);let called=0;
  try{
    await h.readyLive();h.f.player.setAutoQuality(true);h.observed.mockClear();
    h.f.setClockHook(()=>{called++;if(change==='auto'){h.f.player.setAutoQuality(false);h.f.player.setAutoQuality(true);}
      if(change==='pause'){h.f.player.pause();h.f.player.play();}});
    h.advance(600_000);await h.sendLive(201n,5n,0n,3500n);
    expect(called).toBe(1);
    expect(h.samples(), 'clock reentry must not seed the pre-callback owner').toEqual(change==='none'?[[1000,600_000]]:[]);
    if(change!=='pause'){
      expect(h.decodeTimes.some(row=>row.timestamp===3_500_000)).toBe(true);
      h.advance(1_100_000);await h.sendLive(201n,6n,0n,4000n);
      expect(measurements(h.f.player).estimatedGopDurationUs).toBe(change==='none'?500_000:2_000_000);
    }
    expect(h.f.errors).toEqual([]);
  }finally{await h.close();}
});

it('held old transform cannot seed cadence after a second public seek adopts a successor graph and bridge',async()=>{
  let release!:()=>void, held=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const h=await setup(18,{objectTransform:async object=>{
    if(!held&&object.kind==='data'&&object.groupId===5n){held=true;await gate;} return object;
  }});
  const {f}=h;
  try{
    await h.readyLive();h.advance(600_000);await h.sendLive(201n,5n,0n,3500n);
    expect(held).toBe(true);expect(h.decodeTimes.some(row=>row.timestamp===3_500_000)).toBe(false);
    await f.player.seek(2000);await flush(512);expect(f.fetchIds).toHaveLength(2);
    await f.server.acceptFetch(f.fetchIds[1]!,{endOfTrack:0,endLocation:{group:4n,object:1n}});
    const history=await f.server.openFetchStream(f.fetchIds[1]!);
    for(const [group,object,timestamp] of [[3n,0n,1000n],[3n,1n,2100n],[4n,0n,3000n]] as const){
      await f.server.sendFetchObject(history,{groupId:group,subgroupId:0n,objectId:object,publisherPriority:128,
        extensions:properties(18,object,timestamp),payload:coded(object===0n)});await flush(256);
    }
    await f.server.closeFetchStream(history);await flush(512);
    expect(f.outputs).toHaveLength(2);expect(f.outputs[0]!.decoder.destroy).toHaveBeenCalledOnce();expect(f.seeked).toHaveBeenCalledTimes(2);
    const sub=f.requests.filter(request=>request.name==='video').at(-1)!;
    expect(sub.id).not.toBe(f.requests.filter(request=>request.name==='video')[1]!.id);
    f.publishHead('video',{group:4n,object:2n});
    await f.server.acceptSubscribe(sub.id,202n,{parameters:new Map([[MessageParam.LARGEST_OBJECT,[{group:4n,object:2n}]]])});await flush(512);
    const join=f.joins.at(-1)!;expect(join.message.fetch).toMatchObject({joiningRequestId:sub.id});
    const range=f.server.resolveJoiningFetch(join.id);await f.server.acceptFetch(join.id,{endOfTrack:0,endLocation:range.endLocation});
    const prefix=await f.server.openFetchStream(join.id);
    for(const object of [0n,1n,2n]){
      await f.server.sendFetchObject(prefix,{groupId:4n,subgroupId:0n,objectId:object,publisherPriority:128,
        extensions:properties(18,object,3000n+object*100n),payload:coded(object===0n)});await flush(256);
    }
    await f.server.closeFetchStream(prefix);await flush(512);
    await h.sendLive(202n,4n,3n,3300n);
    release();await flush(512);
    expect(h.decodeTimes.some(row=>row.timestamp===3_500_000),'old graph never receives held work after successor adoption').toBe(false);
    expect(measurements(f.player).estimatedGopDurationUs).toBe(2_000_000);
    h.advance(1_100_000);await h.sendLive(202n,5n,0n,4000n);
    expect(measurements(f.player).estimatedGopDurationUs,'held old Group5 cannot seed same-numbered successor Group5').toBe(2_000_000);
    h.advance(1_600_000);await h.sendLive(202n,6n,0n,4500n);
    expect(measurements(f.player).estimatedGopDurationUs).toBe(500_000);expect(f.errors).toEqual([]);
  }finally{release();await h.close();}
});
