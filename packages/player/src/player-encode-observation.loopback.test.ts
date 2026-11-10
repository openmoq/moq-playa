/** Exact declared encode anchors at original receipt through the real SDK route. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { videoInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { audioPeer, identity } from '../test-support/audio-selection.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { createControlCodec } from '@openmoq/transport';
import { MoqtPlayer } from './player.js';
import type { MediaSourceLike } from './interfaces.js';
import type { MoqtPlayerConfig } from './config.js';
const W=1759924160000, namespace=['live','pr59'];
const ref=(name:string)=>({namespace,name});
type Entries = Array<[number,[number,number],number]>;
beforeEach(()=>vi.useFakeTimers({toFake:['setInterval','clearInterval']}));
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function fixture(options: {entries?: Entries; finite?:boolean; multiple?:boolean; version?:number|string; holdVideo?:boolean;  offset?:number; alternative?:boolean; videoAlias?:bigint}={}) {
 const wire=audioPeer(18), errors:string[]=[], appends:number[]=[], fetches:bigint[]=[];
 let wall=W+75, timelineObject=0n, clockHook:(()=>void)|undefined, appendHook:(()=>void)|undefined;
 let transform:NonNullable<MoqtPlayerConfig['objectTransform']>|undefined;
 let assembler:CmafAssembler|undefined;
 wire.server.onFetch=id=>{fetches.push(id);};
 const source:MediaSourceLike={attached:true,initialize:()=>true,appendChunk(_kind,bytes){appends.push(bytes.length);const cb=appendHook;appendHook=undefined;cb?.();},
 getTimestampOffset:()=>options.offset??0,changeType:async()=>{},reset(){},endOfStream(){},destroy(){},mediaElement:null,onFirstFrame:null,onError:null,onStall:null};
 const catalog=new TextEncoder().encode(JSON.stringify({version:options.version??1,initDataList:[{id:'header',type:'inline',data:Buffer.from(videoInit()).toString('base64')}],tracks:[
 {name:'video',namespace:namespace.join('/'),role:'video',packaging:'cmaf',codec:'avc1.640028',isLive:!options.finite,initRef:'header',bitrate:600000,...(options.alternative?{altGroup:1}:{})},
 ...(options.alternative?[{name:'video2',namespace:namespace.join('/'),role:'video',packaging:'cmaf',codec:'avc1.640028',isLive:true,initRef:'header',bitrate:300000,altGroup:1}]:[]),
 ...['timeline',...(options.multiple?['other-timeline']:[])].map(name=>({name,namespace:namespace.join('/'),packaging:'mediatimeline',type:'mediatimeline',isLive:true,mimeType:'application/json',depends:['video',...(options.alternative?['video2']:[])]}))]}));
 const player=new MoqtPlayer({url:'https://pr59.invalid/moq',namespace,draftVersion:18,catalogBootstrap:'subscribe',reconnectAttempts:0,connectionTimeoutMs:5000,cmafBootstrapTimeoutMs:0,livenessTimeoutMs:0,disableAudio:true,autoQuality:false,selection:{videoTrack:{name:'video'}},
 clock:{now:()=>{const cb=clockHook;clockHook=undefined;cb?.();return 1000000;}},createConnection:()=>wire.client,createTransport:async()=>wire.start(),createMediaSource:()=>source,
 objectTransform:object=>transform?transform(object):object,
 createCmafAssembler:callbacks=>{assembler=new CmafAssembler(callbacks);return assembler;}});
 player.on('error',e=>errors.push(e.error.message));
 vi.spyOn(Date,'now').mockImplementation(()=>wall);
 const timeline=async(entries:Entries)=>wire.send(ref('timeline'),new TextEncoder().encode(JSON.stringify(entries)),0n,timelineObject++);
 const chunk=(pts=1000,flags=SYNC_FLAGS)=>buildChunk({trackId:1,bmdt:BigInt(pts)*90n,samples:[{duration:3600,size:4,flags}],mdat:Uint8Array.of(0,0,0,0)});
 try{
 await player.load();await wire.accept(ref('catalog'),100n);await wire.send(ref('catalog'),catalog,1n);
 let release:(()=>Promise<void>)|undefined;
 if(options.holdVideo)release=await wire.holdAck(ref('video'));
 await wire.accept(ref('video'),options.videoAlias??200n);await wire.accept(ref('timeline'),300n);
 if(!options.holdVideo)expect(player.selection.video).toEqual(identity(ref('video')));
 await timeline(options.entries??[[1000,[1,0],W]]);player.play();
 return {player,wire,errors,appends,fetches,source,chunk,timeline,release,
 observation:()=>player.stats.videoEncodeObservation,
 setWall:(n:number)=>{wall=n;},clockHook:(cb:()=>void)=>{clockHook=cb;},appendHook:(cb:()=>void)=>{appendHook=cb;},
 setTransform:(cb:typeof transform)=>{transform=cb;},
 get assembler(){return assembler!;},
 send:(pts=1000,group=1n,object=0n)=>wire.send(ref('video'),chunk(pts),group,object),
 async close(){await player.destroy();await wire.close();expect(errors).toEqual([]);expect(wire.errors).toEqual([]);}};
 }catch(e){await player.destroy();await wire.close();throw e;}
}
it.each([0,12])('exact known anchor records signed original receipt, independent of native offset %s',async offset=>{
 const f=await fixture({offset});try{
 expect(f.observation()).toBeNull();await f.send();expect(f.appends).toHaveLength(1);
 expect(f.observation()).toEqual({source:identity(ref('video')),timeline:identity(ref('timeline')),location:{groupId:'1',objectId:'0'},mediaPtsMs:1000,encodedWallclockMs:W,receivedWallclockMs:W+75,encodeToReceiptMs:75});
 expect(f.player.stats.captureTimestampAgeMs).toBeNull();expect(f.player.stats.currentLatencyMs).toBe(0);
 const old=f.observation();f.setWall(W+5000);expect(f.observation()).toEqual(old);
 await f.timeline([[2000,[2,0],W+6000]]);expect(f.observation()).toEqual(old);
 await f.send(2000,2n);expect(f.observation()?.encodeToReceiptMs).toBe(-1000);
 expect(Object.isFrozen(f.observation()?.source.namespaceFields)).toBe(true);
 }finally{await f.close();}
});
it.each(['explicit-unknown','unindexed'] as const)('%s never invents a fresh observation or capture age',async name=>{
 const f=await fixture({entries:[[1000,[1,0],W],[2000,[2,0],name==='explicit-unknown'?0:W+1400]]});try{
 await f.send(name==='explicit-unknown'?2000:1500,name==='explicit-unknown'?2n:1n,name==='explicit-unknown'?0n:1n);
 expect(f.appends).toHaveLength(1);expect(f.observation()).toBeNull();expect(f.player.stats.captureTimestampAgeMs).toBeNull();expect(f.player.stats.currentLatencyMs).toBe(0);
 }finally{await f.close();}
});
it('unknown/unindexed receipts leave an older qualified record historical, without refresh',async()=>{
 const f=await fixture({entries:[[1000,[1,0],W],[2000,[2,0],0]]});try{await f.send();const old=f.observation();expect(old).not.toBeNull();
 f.setWall(W+2075);await f.send(1500,1n,1n);await f.send(2000,2n);expect(f.observation()).toEqual(old);
 }finally{await f.close();}
});
it('timeline arriving during transform does not retrospectively date the object',async()=>{
 const f=await fixture({entries:[]});try{
 f.setTransform(async object=>{if(object.trackAlias===200n){f.setTransform(undefined);await f.timeline([[1000,[1,0],W]]);}return object;});
 await f.send();await flush(512);expect(f.appends).toHaveLength(1);expect(f.observation()).toBeNull();
 }finally{await f.close();}
});
it('transform delay retains original receipt wallclock',async()=>{
 const f=await fixture();try{f.setTransform(object=>{f.setWall(W+9999);return object;});await f.send();expect(f.observation()?.receivedWallclockMs).toBe(W+75);expect(f.observation()?.encodeToReceiptMs).toBe(75);}finally{await f.close();}
});
it('source retirement reentered from receipt clock cannot publish its pending observation',async()=>{
 const f=await fixture();let stack='';try{f.clockHook(()=>{stack=new Error().stack??'';void f.player.destroy();});await f.send();expect(stack).toContain('captureVideoPayload');expect(f.observation()).toBeNull();}finally{await f.close();}
});
it('output callback retirement clears the just-received record',async()=>{
 const f=await fixture();try{f.appendHook(()=>{void f.player.destroy();});await f.send();expect(f.appends).toHaveLength(1);expect(f.observation()).toBeNull();}finally{await f.close();}
});
it('timeline retirement through request GOAWAY clears a prior observation',async()=>{
 const f=await fixture();try{await f.send();expect(f.observation()).not.toBeNull();const index=f.wire.requests.indexOf(f.wire.request(ref('timeline')));f.wire.transport.bidiOut[index]!.in.injectRead(createControlCodec(18).encode({type:'GOAWAY',newSessionUri:'',timeout:0n}));await flush(512);expect(f.observation()).toBeNull();}finally{await f.close();}
});
it.each([{finite:true},{multiple:true}])('unsupported ownership stays unknown: %j',async options=>{
 const f=await fixture(options);try{await f.send();expect(f.appends).toHaveLength(1);expect(f.observation()).toBeNull();}finally{await f.close();}
});
it('pre-ACK local replay is not a new receipt',async()=>{
 const f=await fixture({holdVideo:true});try{await f.send();expect(f.observation()).toBeNull();await f.release!();await flush(512);expect(f.appends).toHaveLength(1);expect(f.observation()).toBeNull();}finally{await f.close();}
});
it.each([200n,0n])('actual FETCH bytes never seed an observation, including wire alias collision %s',async videoAlias=>{
 const f=await fixture({videoAlias});try{
 const transformed:bigint[]=[];f.setTransform(object=>{transformed.push(BigInt(object.objectId));return object;});
 await f.player.fetch('video',{startGroup:1,startObject:0,endGroup:1,endObject:1});await flush(256);
 expect(f.fetches).toHaveLength(1);const id=f.fetches[0]!;
 await f.wire.server.acceptFetch(id,{endLocation:{group:1n,object:1n}});
 const stream=await f.wire.server.openFetchStream(id);
 await f.wire.server.sendFetchObject(stream,{groupId:1n,subgroupId:0n,objectId:0n,publisherPriority:128,payload:f.chunk()});await flush(512);
 expect(f.observation()).toBeNull();await f.wire.server.closeFetchStream(stream);await flush(512);expect(transformed).toContain(0n);expect(f.appends).toHaveLength(1);await f.send(2000,2n);expect(f.observation()).toBeNull();
 }finally{await f.close();}
});

it('timeline callback retirement cannot leave a predecessor observation readable',async()=>{
 const f=await fixture();try{await f.send();expect(f.observation()).not.toBeNull();
 f.player.on('timeline_updated',()=>{void f.player.destroy();});
 await f.timeline([[2000,[2,0],W+1000]]);expect(f.observation()).toBeNull();
 }finally{await f.close();}
});
it('receipt wallclock reentry cannot repopulate a destroyed source',async()=>{
 const f=await fixture();let reached=false;try{vi.spyOn(Date,'now').mockImplementation(()=>{if(!reached&&(new Error().stack??'').includes('captureVideoEncodeObservation')){reached=true;void f.player.destroy();}return W+75;});await f.send();expect(reached).toBe(true);expect(f.observation()).toBeNull();}finally{await f.close();}
});

it('public rendition switch retires the old record; staged candidate receipt cannot seed its successor',async()=>{
 const f=await fixture({alternative:true,entries:[[1000,[1,0],W],[2000,[2,0],W+1000],[3000,[3,0],W+2000]]});
 try{await f.send();expect(f.observation()?.source.name).toBe('video');
 let switched:Promise<void>|undefined;
 f.appendHook(()=>{switched=f.player.selectVideoTrack({name:'video2',namespace});});
 await f.send(1040,1n,1n);await flush(512);
 expect(switched).toBeDefined();await f.wire.accept(ref('video2'),201n);
 f.setWall(W+1075);await f.wire.send(ref('video2'),f.chunk(2000),2n);await switched;await flush(512);
 expect(f.player.selection.video).toEqual(identity(ref('video2')));expect(f.observation()).toBeNull();
 f.setWall(W+2075);await f.wire.send(ref('video2'),f.chunk(3000),3n);
 expect(f.observation()?.source.name).toBe('video2');expect(f.observation()?.location).toEqual({groupId:'3',objectId:'0'});expect(f.observation()?.encodeToReceiptMs).toBe(75);
 }finally{await f.close();}
});

it('fresh original receipts on a stream opened before ACK qualify after binding; parked replay does not',async()=>{
 const f=await fixture({holdVideo:true,entries:[[1000,[1,0],W],[1040,[1,1],W+40]]});try{
 await f.send();await f.release!();await flush(512);expect(f.observation()).toBeNull();
 f.setWall(W+115);await f.send(1040,1n,1n);expect(f.observation()?.location).toEqual({groupId:'1',objectId:'1'});expect(f.observation()?.encodeToReceiptMs).toBe(75);
 }finally{await f.close();}
});

it('public stats JSON baseline remains serializable before an encode observation',async()=>{
 const f=await fixture();try{
 expect(f.observation()).toBeNull();
 const serialized=JSON.stringify(f.player.stats);
 expect(JSON.parse(serialized).videoEncodeObservation).toBeNull();
 }finally{await f.close();}
});
it.each([[1n,0n],[9007199254740991n,0n]])('populated public stats JSON preserves exact decimal Location %s/%s',async(groupId,objectId)=>{
 // These explicit JSON Locations are safe integers; lookup still uses bigint.
 const f=await fixture({entries:[[1000,[Number(groupId),Number(objectId)],W]]});try{
 await f.send(1000,groupId,objectId);expect(f.appends).toHaveLength(1);
 expect(f.observation()).not.toBeNull();
 const serialized=JSON.stringify(f.player.stats);
 const observation=JSON.parse(serialized).videoEncodeObservation;
 expect(observation.location).toEqual({groupId:groupId.toString(),objectId:objectId.toString()});
 expect(observation.encodeToReceiptMs).toBe(75);
 expect(JSON.parse(serialized).captureTimestampAgeMs).toBeNull();
 expect(JSON.parse(serialized).currentLatencyMs).toBe(0);
 }finally{await f.close();}
});
