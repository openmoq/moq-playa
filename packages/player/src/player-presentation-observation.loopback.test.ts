/** Exact declared encode anchors at presentation of the received Object's first sample. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { videoInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { audioPeer, identity } from '../test-support/audio-selection.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import type { MediaSourceLike } from './interfaces.js';
const W=1759924160000, namespace=['live','presented'];
const ref=(name:string)=>({namespace,name});
type Entries = Array<[number,[number,number],number]>;
type Frame=(now:number,metadata:{mediaTime:number})=>void;
beforeEach(()=>vi.useFakeTimers({toFake:['setInterval','clearInterval']}));
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function fixture(options: {entries?: Entries; offset?:number; element?:boolean}={}) {
 const wire=audioPeer(18), errors:string[]=[], fetches:bigint[]=[], frames=new Map<number,Frame>();
 let wall=W+75, offset=options.offset??0, timelineObject=0n, handles=0, assembler:CmafAssembler|undefined;
 wire.server.onFetch=id=>{fetches.push(id);};
 const element={requestVideoFrameCallback(cb:Frame){frames.set(++handles,cb);return handles;},cancelVideoFrameCallback(h:number){frames.delete(h);}};
 const source:MediaSourceLike={attached:true,initialize:()=>true,appendChunk(){},
 getTimestampOffset:()=>offset,changeType:async()=>{},reset(){},endOfStream(){},destroy(){},mediaElement:options.element===false?null:element,onFirstFrame:null,onError:null,onStall:null};
 const catalog=new TextEncoder().encode(JSON.stringify({version:1,initDataList:[{id:'header',type:'inline',data:Buffer.from(videoInit()).toString('base64')}],tracks:[
 {name:'video',namespace:namespace.join('/'),role:'video',packaging:'cmaf',codec:'avc1.640028',isLive:true,initRef:'header',bitrate:600000},
 {name:'timeline',namespace:namespace.join('/'),packaging:'mediatimeline',type:'mediatimeline',isLive:true,mimeType:'application/json',depends:['video']}]}));
 const player=new MoqtPlayer({url:'https://presented.invalid/moq',namespace,draftVersion:18,catalogBootstrap:'subscribe',reconnectAttempts:0,connectionTimeoutMs:5000,cmafBootstrapTimeoutMs:0,livenessTimeoutMs:0,disableAudio:true,autoQuality:false,selection:{videoTrack:{name:'video'}},
 clock:{now:()=>1000000},createConnection:()=>wire.client,createTransport:async()=>wire.start(),createMediaSource:()=>source,
 createCmafAssembler:callbacks=>{assembler=new CmafAssembler(callbacks);return assembler;}});
 player.on('error',e=>errors.push(e.error.message));
 vi.spyOn(Date,'now').mockImplementation(()=>wall);
 const timeline=async(entries:Entries)=>wire.send(ref('timeline'),new TextEncoder().encode(JSON.stringify(entries)),0n,timelineObject++);
 const chunk=(pts=1000)=>buildChunk({trackId:1,bmdt:BigInt(pts*90),samples:[{duration:3600,size:4,flags:SYNC_FLAGS}],mdat:Uint8Array.of(0,0,0,0)});
 try{
 await player.load();await wire.accept(ref('catalog'),100n);await wire.send(ref('catalog'),catalog,1n);
 await wire.accept(ref('video'),200n);await wire.accept(ref('timeline'),300n);
 expect(player.selection.video).toEqual(identity(ref('video')));
 await timeline(options.entries??[[1000,[1,0],W],[1040,[1,1],W+40],[2000,[2,0],W+1000]]);player.play();
 return {player,wire,errors,fetches,chunk,frames,
 observation:()=>player.stats.videoPresentationObservation,
 setWall:(n:number)=>{wall=n;},
 /** Element time of a source PTS: the assembler's own placement plus the native offset. */
 at(ptsMs:number){const f=assembler!.capturePresentationPlacement('video')!.toRebasedTimeUs(BigInt(ptsMs*1000))!;return Number(f.numerator)/Number(f.denominator)/1e6+offset;},
 setOffset:(n:number)=>{offset=n;},
 present(mediaTime:number){const pending=[...frames.values()];frames.clear();for(const cb of pending)cb(0,{mediaTime});},
 send:(pts=1000,group=1n,object=0n)=>wire.send(ref('video'),chunk(pts),group,object),
 async close(){await player.destroy();await wire.close();expect(errors).toEqual([]);expect(wire.errors).toEqual([]);}};
 }catch(e){await player.destroy();await wire.close();throw e;}
}
it.each([0,12.345])('presented first sample of an anchored receipt records encode-to-presentation at native offset %s',async offset=>{
 const f=await fixture({offset});try{
 await f.send();expect(f.player.stats.videoEncodeObservation?.encodeToReceiptMs).toBe(75);expect(f.observation()).toBeNull();
 expect(f.frames.size).toBe(1);const t=f.at(1000);
 f.setWall(W+310);f.present(t);
 expect(f.observation()).toEqual({source:identity(ref('video')),timeline:identity(ref('timeline')),location:{groupId:'1',objectId:'0'},mediaPtsMs:1000,encodedWallclockMs:W,presentedMediaTime:t,presentedWallclockMs:W+310,encodeToPresentationMs:310});
 expect(f.player.stats.videoEncodeObservation?.receivedWallclockMs).toBe(W+75);
 expect(f.frames.size).toBe(0); // Nothing left to match: the frame watch stops.
 const old=f.observation();f.setWall(W+5000);expect(f.observation()).toEqual(old);
 }finally{await f.close();}
});
it('only an anchored sample matches; other frames leave the older record historical',async()=>{
 const f=await fixture();try{
 await f.send();await f.send(1040,1n,1n);await f.send(1080,1n,2n);
 f.present(f.at(1000)-0.04);expect(f.observation()).toBeNull(); // Earlier (e.g. leading) frame: candidates stay pending.
 f.setWall(W+300);f.present(f.at(1000));expect(f.observation()?.location).toEqual({groupId:'1',objectId:'0'});
 const old=f.observation();
 f.setWall(W+400);f.present(f.at(1080));expect(f.observation()).toEqual(old); // Unindexed Object, and [1,1] was passed.
 }finally{await f.close();}
});
it.each([[0.000001,true],[-0.000001,true],[0.000003,false],[0.02,false]])('engine microsecond quantization %s matches: %s',async(delta,matches)=>{
 const f=await fixture();try{await f.send();f.present(f.at(1000)+delta);expect(f.observation()!==null).toBe(matches);}finally{await f.close();}
});
it('a native offset changed after append cannot date the frame at either mapping',async()=>{
 const f=await fixture();try{await f.send();const before=f.at(1000);f.setOffset(5);f.present(f.at(1000));f.present(before);expect(f.observation()).toBeNull();}finally{await f.close();}
});
it('declared mediaPtsMs that does not name the received sample supplies no anchor',async()=>{
 const f=await fixture({entries:[[1000,[1,0],W]]});try{
 await f.send(1040);expect(f.player.stats.videoEncodeObservation).not.toBeNull();expect(f.frames.size).toBe(0);
 f.present(f.at(1040));expect(f.observation()).toBeNull();
 }finally{await f.close();}
});
it('without requestVideoFrameCallback there is no presentation evidence',async()=>{
 const f=await fixture({element:false});try{await f.send();expect(f.player.stats.videoEncodeObservation).not.toBeNull();expect(f.observation()).toBeNull();}finally{await f.close();}
});
it('pause and destroy retire the record and pending candidates',async()=>{
 const f=await fixture();try{
 await f.send();await f.send(2000,2n);f.present(f.at(1000));expect(f.observation()).not.toBeNull();
 f.player.pause();expect(f.observation()).toBeNull();f.present(f.at(2000));expect(f.observation()).toBeNull();
 }finally{await f.close();}
 const g=await fixture();try{await g.send();const t=g.at(1000);await g.player.destroy();g.present(t);expect(g.observation()).toBeNull();}finally{await g.close();}
});
it('actual FETCH bytes never seed a presentation candidate',async()=>{
 const f=await fixture();try{
 await f.player.fetch('video',{startGroup:1,startObject:0,endGroup:1,endObject:1});await flush(256);
 const id=f.fetches[0]!;await f.wire.server.acceptFetch(id,{endLocation:{group:1n,object:1n}});
 const stream=await f.wire.server.openFetchStream(id);
 await f.wire.server.sendFetchObject(stream,{groupId:1n,subgroupId:0n,objectId:0n,publisherPriority:128,payload:f.chunk()});await flush(512);
 await f.wire.server.closeFetchStream(stream);await flush(512);
 expect(f.frames.size).toBe(0);expect(f.observation()).toBeNull();
 }finally{await f.close();}
});
it('public stats JSON stays serializable with a presentation observation',async()=>{
 const f=await fixture();try{
 expect(JSON.parse(JSON.stringify(f.player.stats)).videoPresentationObservation).toBeNull();
 await f.send();f.setWall(W+310);f.present(f.at(1000));
 const parsed=JSON.parse(JSON.stringify(f.player.stats)).videoPresentationObservation;
 expect(parsed.location).toEqual({groupId:'1',objectId:'0'});expect(parsed.encodeToPresentationMs).toBe(310);
 }finally{await f.close();}
});

it('matches the floor of the first sample PTS, including fractional milliseconds', async () => {
 for (const pts of [1000.5, 999.5]) {
  const f = await fixture({entries: [[1000, [1, 0], W]]});
  try {
   await f.send(pts);
   expect(f.player.stats.videoEncodeObservation).not.toBeNull();
   f.present(f.at(pts));
   expect(f.observation() !== null).toBe(pts === 1000.5);
  } finally { await f.close(); }
 }
});
