import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { MessageParam } from '@openmoq/transport';
import { catToken } from '@openmoq/webtransport';
import type { MoqtPlayerConfig } from './config.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { locSeekFixture } from '../test-support/playing-frame-quality.js';

beforeEach(()=>vi.stubGlobal('document',{hidden:false,addEventListener(){},removeEventListener(){}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
type Fixture=Awaited<ReturnType<typeof locSeekFixture>>;
const ns=['live','show'];
function bytes(id:bigint,pts:bigint,audio=false,marker=0x88){return {
  payload:audio?Uint8Array.of(0xf8,0xff,0xfe):Uint8Array.of(0,0,0,2,id===0n?0x65:0x41,marker),
  extensions:encodeLocHeaders({timestamp:pts,timescale:1000n,...(audio?{}:{videoFrameMarking:{independent:id===0n,startOfFrame:true,endOfFrame:true,discardable:false,baseLayerSync:false,temporalId:0}})},
    {wireProfile:locWireProfileForDraft(18),locVersion:4})};}
async function fetched(f:Fixture,stream:bigint,group:bigint,id:bigint,pts:bigint,audio=false,marker=0x88){
  await f.server.sendFetchObject(stream,{groupId:group,subgroupId:0n,objectId:id,publisherPriority:128,...bytes(id,pts,audio,marker)});await flush(256);
}
async function live(f:Fixture,alias:bigint,group:bigint,id:bigint,pts:bigint,audio=false){
  const stream=await f.server.openSubgroup(alias,group,id,{publisherPriority:128,hasExtensions:true,endOfGroup:true});
  const value=bytes(id,pts,audio);await f.server.sendObject(stream,id,value.payload,value.extensions);await f.server.closeSubgroup(stream);await flush(512);
}
async function landed(audio:boolean,different:boolean,isLive:boolean, authorization?: MoqtPlayerConfig['authorization'], onVideoAdopt?: () => void){
  const f=await locSeekFixture(18,audio,true,{...(authorization ? {authorization} : {}),...(onVideoAdopt ? {onVideoAdopt} : {}),producingOutput:true,alternative:true,isLive,catalogVersion:'1',
    ...(different?{alternateSize:{width:1280,height:720}}:{}),timeline:[[1000,[3,0],0],[3000,[4,0],0],[3100,[4,1],0]]});
  try{
    await f.player.seek(2000);await flush(256);
    expect(f.fetches.map(r=>r.name)).toEqual(audio?['video','audio']:['video']);
    for(const [i,request] of [...f.fetches].entries()){
      await f.server.acceptFetch(f.fetchIds[i]!,{endOfTrack:isLive?0:1,endLocation:{group:4n,object:1n}});
      const stream=await f.server.openFetchStream(f.fetchIds[i]!);
      await fetched(f,stream,3n,0n,1000n,request.name==='audio');await fetched(f,stream,3n,1n,2100n,request.name==='audio');await fetched(f,stream,4n,0n,3000n,request.name==='audio');
      await f.server.closeFetchStream(stream);await flush(512);
    }
    expect(f.errors).toEqual([]);expect(f.seeked).toHaveBeenCalledOnce();expect(f.outputs).toHaveLength(1);
    expect(f.outputs[0]!.draw).toHaveBeenCalledOnce();expect(f.player.playbackPositionMs).toBe(2100);
    if(audio){expect(f.audioOutputs).toHaveLength(1);expect(f.audioOutputs[0]!.output.schedule).toHaveBeenCalled();}
    return f;
  }catch(e){await f.destroy();throw e;}
}
async function bridge(f:Fixture,role:'video'|'audio',alias:bigint){
  const requests=f.requests.filter(r=>r.name===role);expect(requests).toHaveLength(2);
  const sub=requests[1]!,head={group:4n,object:2n};f.publishHead(role,head);
  await f.server.acceptSubscribe(sub.id,alias,{parameters:new Map([[MessageParam.LARGEST_OBJECT,[head]]])});await flush(512);
  const join=f.joins.find(j=>j.message.fetch.fetchType===3&&j.message.fetch.joiningRequestId===sub.id);expect(join).toBeDefined();
  await f.server.acceptFetch(join!.id,{endOfTrack:0,endLocation:f.server.resolveJoiningFetch(join!.id).endLocation});
  const prefix=await f.server.openFetchStream(join!.id);
  for(const id of [0n,1n,2n])await fetched(f,prefix,4n,id,3000n+id*100n,role==='audio');
  await f.server.closeFetchStream(prefix);await flush(512);await live(f,alias,4n,3n,3300n,role==='audio');
}

it('playing live A/V after seek prepares a1280x720 alternate while retaining audio and old640x360 video until target proof',async()=>{
  const f=await landed(true,true,true);
  try{
    const video=f.outputs[0]!,audio=f.audioOutputs[0]!;
    const initialTiming=vi.mocked(audio.output.schedule).mock.calls[0]![3]!;
    audio.head.value={epoch:initialTiming.context.epoch,sourceTimestampUs:3_000_000n,sourceOffsetUs:0};
    f.advance(1_000_000);await flush(512);
    await f.updateTimeline([[1000,[3,0],0],[3000,[4,0],0],[3100,[4,1],0]]);
    await bridge(f,'video',401n);await bridge(f,'audio',402n);
    expect(vi.mocked(video.decoder.decode).mock.calls.map(([chunk])=>chunk.timestamp)).toContain(3_300_000);
    expect(vi.mocked(audio.decoder.decode).mock.calls.map(([chunk])=>chunk.timestamp)).toContain(3_300_000);
    const schedule=vi.mocked(audio.output.schedule).mock.calls[0]![3]!;
    expect(schedule.context.sourceTimestampUs).toBe(2_100_000n);
    audio.head.value={epoch:schedule.context.epoch,sourceTimestampUs:3_300_000n,sourceOffsetUs:0};
    f.advance(1_300_000);await flush(512);
    expect(f.player.playbackPositionMs).toBe(3300);expect(video.draw.mock.calls.at(-1)![0].timestamp).toBe(3_300_000);
    await f.updateTimeline([[1000,[3,0],0],[3000,[4,0],0],[3100,[4,1],0],[3500,[5,0],0],[4000,[6,0],0]]);
    const target=f.player.availableVideoTracks.find(t=>t.name==='alternate-video');
    expect(target).toMatchObject({width:1280,height:720});
    const oldSelection=f.player.selection.video,oldDraws=video.draw.mock.calls.length;
    const reset=vi.mocked(video.decoder.reset).mock.calls.length;
    const audioReset=vi.mocked(audio.decoder.reset).mock.calls.length;
    const switched=vi.fn();f.player.on('quality_switched',switched);
    const result:{error?:unknown;done:boolean}={done:false};
    const operation=f.player.selectVideoTrack({name:'alternate-video',namespace:ns}).then(()=>{result.done=true;},error=>{result.error=error;});
    await flush(512);
    // Retained A/V is a reached premise even on the rejecting baseline.
    expect(f.player.selection.video).toEqual(oldSelection);expect(f.audioOutputs).toHaveLength(1);
    expect(video.decoder.destroy).not.toHaveBeenCalled();expect(audio.decoder.destroy).not.toHaveBeenCalled();expect(audio.output.destroy).not.toHaveBeenCalled();
    expect(video.decoder.reset).toHaveBeenCalledTimes(reset);expect(audio.decoder.reset).toHaveBeenCalledTimes(audioReset);
    expect(switched).not.toHaveBeenCalled();expect(f.errors).toEqual([]);
    expect(result.error,'playing same-altGroup different-resolution video must enter role-local preparation, not paused-only refusal').toBeUndefined();
    expect(result.done).toBe(false);
    const index=f.fetches.findIndex(r=>r.name==='alternate-video');expect(index,'target is fetched from the validated common future index').toBeGreaterThanOrEqual(0);
    const request=f.fetches[index]!;expect(request).toEqual({namespace:ns,name:'alternate-video',group:5n,object:0n});
    await f.server.acceptFetch(f.fetchIds[index]!,{endOfTrack:0,endLocation:{group:5n,object:0n}});
    const stream=await f.server.openFetchStream(f.fetchIds[index]!);
    await fetched(f,stream,5n,0n,3500n,false,0x99);
    expect(f.audioOutputs).toHaveLength(1);expect(video.decoder.destroy).not.toHaveBeenCalled();expect(switched).not.toHaveBeenCalled();
    await fetched(f,stream,5n,1n,3600n,false,0x99);await f.server.closeFetchStream(stream);await flush(512);
    audio.head.value={...audio.head.value!,sourceTimestampUs:3_500_000n};f.advance(1_500_000);await flush(512);
    await operation;
    expect(result.error).toBeUndefined();expect(result.done).toBe(true);expect(f.outputs).toHaveLength(2);
    const replacement=f.outputs[1]!;expect(vi.mocked(replacement.decoder.configure).mock.calls[0]!.slice(1)).toEqual(['avc1.640028',1280,720]);
    expect(vi.mocked(replacement.decoder.decode).mock.calls.some(([chunk])=>chunk.timestamp===3_500_000&&chunk.data.at(-1)===0x99)).toBe(true);
    expect(replacement.draw.mock.calls.some(call=>call[0].timestamp===3_500_000)).toBe(true);
    expect(video.draw.mock.calls.length).toBeGreaterThanOrEqual(oldDraws);expect(f.audioOutputs).toHaveLength(1);expect(f.audioOutputs[0]).toBe(audio);
    expect(audio.decoder.destroy).not.toHaveBeenCalled();expect(audio.output.destroy).not.toHaveBeenCalled();expect(audio.decoder.reset).toHaveBeenCalledTimes(audioReset);
    expect(video.decoder.destroy).toHaveBeenCalledOnce();
    const audioCalls=vi.mocked(audio.decoder.decode).mock.calls.length;
    await live(f,402n,4n,4n,3500n,true);
    expect(vi.mocked(audio.decoder.decode).mock.calls.length).toBeGreaterThan(audioCalls);
    expect(vi.mocked(audio.decoder.decode).mock.calls.at(-1)![0].timestamp).toBe(3_500_000);
    expect(f.player.playbackPositionMs).toBeGreaterThanOrEqual(3500);expect(f.player.selection.video?.name).toBe('alternate-video');expect(switched).toHaveBeenCalledOnce();expect(f.seeked).toHaveBeenCalledOnce();
  }finally{await f.destroy();}
});

it('healthy paused same-configuration video-only public switch still replaces the complete graph at its held picture',async()=>{
  const f=await landed(false,false,false);
  try{
    f.player.pause();await flush(256);const old=f.outputs[0]!;
    const result:{error?:unknown}={};const operation=f.player.selectVideoTrack({name:'alternate-video',namespace:ns}).catch(error=>{result.error=error;});await flush(512);
    expect(result.error).toBeUndefined();expect(f.fetches.at(-1)!.name).toBe('alternate-video');expect(old.decoder.destroy).not.toHaveBeenCalled();
    const id=f.fetchIds.at(-1)!;await f.server.acceptFetch(id,{endOfTrack:1,endLocation:{group:3n,object:3n}});const stream=await f.server.openFetchStream(id);
    await fetched(f,stream,3n,0n,1000n,false,0x99);await fetched(f,stream,3n,1n,2100n,false,0x99);await fetched(f,stream,3n,2n,2600n,false,0x99);
    await f.server.closeFetchStream(stream);await flush(512);await operation;
    expect(result.error).toBeUndefined();expect(f.player.state).toBe('paused');expect(f.player.playbackPositionMs).toBe(2100);
    expect(f.outputs).toHaveLength(2);expect(f.outputs[1]!.draw.mock.calls[0]![0].timestamp).toBe(2_100_000);
    expect(old.decoder.destroy).toHaveBeenCalledOnce();expect(f.player.selection.video?.name).toBe('alternate-video');expect(f.errors).toEqual([]);
  }finally{await f.destroy();}
});

async function playingWithFutureCut(authorization?: MoqtPlayerConfig['authorization'], onVideoAdopt?: () => void) {
  const f=await landed(true,true,true,authorization,onVideoAdopt), video=f.outputs[0]!,audio=f.audioOutputs[0]!;
  try {
    const timing=vi.mocked(audio.output.schedule).mock.calls[0]![3]!;
    audio.head.value={epoch:timing.context.epoch,sourceTimestampUs:3_000_000n,sourceOffsetUs:0};
    f.advance(1_000_000);await flush(512);
    await f.updateTimeline([[1000,[3,0],0],[3000,[4,0],0],[3100,[4,1],0]]);
    await bridge(f,'video',401n);await bridge(f,'audio',402n);
    const current=vi.mocked(audio.output.schedule).mock.calls[0]![3]!;
    audio.head.value={epoch:current.context.epoch,sourceTimestampUs:3_300_000n,sourceOffsetUs:0};
    f.advance(1_300_000);await flush(512);
    expect(f.player.playbackPositionMs).toBe(3300);expect(video.draw.mock.calls.at(-1)![0].timestamp).toBe(3_300_000);
    await f.updateTimeline([[1000,[3,0],0],[3000,[4,0],0],[3100,[4,1],0],[3500,[5,0],0],[4000,[6,0],0]]);
    return {f,video,audio};
  } catch(error) {await f.destroy();throw error;}
}

it('pauses a promoted video role before its first draw without stranding quality or retiring audio',async()=>{
  const {f,video,audio}=await playingWithFutureCut();
  let settled=false,error:unknown;
  let operation:Promise<void>|undefined;
  try {
    const switched=vi.fn();f.player.on('quality_switched',switched);
    operation=f.player.selectVideoTrack({name:'alternate-video',namespace:ns}).then(()=>{settled=true;},cause=>{settled=true;error=cause;});
    await flush(512);
    const i=f.fetches.findIndex(request=>request.name==='alternate-video');expect(i).toBeGreaterThanOrEqual(0);
    await f.server.acceptFetch(f.fetchIds[i]!,{endOfTrack:0,endLocation:{group:5n,object:0n}});
    const stream=await f.server.openFetchStream(f.fetchIds[i]!);
    await fetched(f,stream,5n,0n,3500n,false,0x99);await fetched(f,stream,5n,1n,3600n,false,0x99);
    await f.server.closeFetchStream(stream);await flush(512);
    expect(f.outputs).toHaveLength(2);
    const replacement=f.outputs[1]!;
    expect(vi.mocked(replacement.decoder.decode).mock.calls.some(([chunk])=>chunk.timestamp===3_500_000)).toBe(true);
    expect(f.player.selection.video?.name).toBe('alternate-video');
    expect(replacement.draw).not.toHaveBeenCalled();expect(switched).not.toHaveBeenCalled();expect(settled).toBe(false);
    f.player.pause();await flush(512);
    expect(settled,'a normal pause must release the promoted quality operation without waiting for its deadline').toBe(true);
    if(error!==undefined)expect(error).toMatchObject({name:'AbortError'});
    expect(f.player.state).toBe('paused');expect(f.player.playbackPositionMs).toBe(3300);
    expect(f.player.selection.video?.name).toBe('alternate-video');expect(switched).not.toHaveBeenCalled();
    expect(replacement.draw).not.toHaveBeenCalled();expect(f.audioOutputs).toHaveLength(1);expect(f.audioOutputs[0]).toBe(audio);
    expect(audio.decoder.destroy).not.toHaveBeenCalled();expect(audio.output.destroy).not.toHaveBeenCalled();
    expect(replacement.decoder.destroy).not.toHaveBeenCalled();expect(video.decoder.destroy).not.toHaveBeenCalled();
    await expect(f.player.selectVideoTrack({name:'video',namespace:ns})).rejects.toThrow(/video-only/);
    expect(f.errors).toEqual([]);
  }finally{await f.destroy();await operation;}
});

async function supplyTarget(f:Fixture) {
  const i=f.fetches.findIndex(request=>request.name==='alternate-video');expect(i).toBeGreaterThanOrEqual(0);
  const request=f.wire.mock.calls.map(([message])=>message).find(message=>message.type==='FETCH'&&message.requestId===f.fetchIds[i]);
  expect(request).toMatchObject({fetch:{startLocation:{group:5n,object:0n},endLocation:{group:6n,object:1n}}});
  await f.server.acceptFetch(f.fetchIds[i]!,{endOfTrack:0,endLocation:{group:5n,object:0n}});
  const stream=await f.server.openFetchStream(f.fetchIds[i]!);
  await fetched(f,stream,5n,0n,3500n,false,0x99);await fetched(f,stream,5n,1n,3600n,false,0x99);
  await f.server.closeFetchStream(stream);await flush(512);
}
async function drawTarget(f:Fixture,audio:Fixture['audioOutputs'][number]) {
  audio.head.value={...audio.head.value!,sourceTimestampUs:3_500_000n};f.advance(1_500_000);await flush(512);
}
function noTarget(f:Fixture,old:Fixture['outputs'][number],audio:Fixture['audioOutputs'][number]) {
  expect(f.fetches.filter(request=>request.name==='alternate-video')).toEqual([]);
  expect(f.player.selection.video?.name).toBe('video');expect(f.audioOutputs).toHaveLength(1);expect(f.audioOutputs[0]).toBe(audio);
  expect(old.decoder.destroy).not.toHaveBeenCalled();expect(audio.decoder.destroy).not.toHaveBeenCalled();expect(audio.output.destroy).not.toHaveBeenCalled();
}

it('withdraws a playing-role automatic selection when beforeSubscribe disables automatic mode',async()=>{
  const {f,video,audio}=await playingWithFutureCut();
  try {
    f.player.setAutoQuality(true);let entered=false;
    f.player.hooks.beforeSubscribe.add(intent=>{if(intent.trackName==='alternate-video'){entered=true;f.player.setAutoQuality(false);}return intent;});
    await f.player.selectVideoTrack({name:'alternate-video',namespace:ns},'bandwidth','upshift');await flush(512);
    expect(entered).toBe(true);expect(f.player.selection.autoQuality).toBe(false);noTarget(f,video,audio);expect(f.outputs).toHaveLength(1);expect(f.errors).toEqual([]);
  }finally{await f.destroy();}
});

it.each([false,true])('checks target FETCH registration after credentials while preserving manual=%s',async manual=>{
  let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const {f,video,audio}=await playingWithFutureCut({getTokens:async context=>{
    if(context.operation==='FETCH'&&context.trackName&&new TextDecoder().decode(context.trackName)==='alternate-video'){entered=true;await gate;}
    return [catToken(Uint8Array.of(1))];
  }});
  let settled=false,error:unknown,operation:Promise<void>|undefined;
  try {
    f.player.setAutoQuality(true);
    operation=(manual?f.player.selectVideoTrack({name:'alternate-video',namespace:ns}):f.player.selectVideoTrack({name:'alternate-video',namespace:ns},'bandwidth','upshift'))
      .then(()=>{settled=true;},cause=>{settled=true;error=cause;});
    await flush(512);expect(entered).toBe(true);expect(settled).toBe(false);expect(f.fetches.filter(request=>request.name==='alternate-video')).toEqual([]);
    f.player.setAutoQuality(false);release();await flush(512);
    if(manual){await supplyTarget(f);await drawTarget(f,audio);await operation;
      expect(error).toBeUndefined();expect(f.player.selection.video?.name).toBe('alternate-video');expect(f.outputs[1]!.draw).toHaveBeenCalled();expect(f.audioOutputs[0]).toBe(audio);
    }else{await operation;expect(error).toBeUndefined();noTarget(f,video,audio);expect(f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();}
    expect(settled).toBe(true);expect(f.player.selection.autoQuality).toBe(false);expect(f.errors).toEqual([]);
  }finally{release();await f.destroy();await operation;}
});

it('keeps an issued playing-role automatic FETCH authoritative after automatic mode is disabled',async()=>{
  const {f,audio}=await playingWithFutureCut();let error:unknown;let operation:Promise<void>|undefined;
  try {
    f.player.setAutoQuality(true);
    operation=f.player.selectVideoTrack({name:'alternate-video',namespace:ns},'bandwidth','upshift').catch(cause=>{error=cause;});await flush(512);
    expect(f.fetches.filter(request=>request.name==='alternate-video')).toHaveLength(1);
    f.player.setAutoQuality(false);await supplyTarget(f);await drawTarget(f,audio);await operation;
    expect(error).toBeUndefined();expect(f.player.selection.video?.name).toBe('alternate-video');expect(f.player.selection.autoQuality).toBe(false);
    expect(f.outputs[1]!.draw).toHaveBeenCalled();expect(f.audioOutputs[0]).toBe(audio);expect(audio.decoder.destroy).not.toHaveBeenCalled();expect(f.errors).toEqual([]);
  }finally{await f.destroy();await operation;}
});

it('retains old A/V output when the target history is refused',async()=>{
  const {f,video,audio}=await playingWithFutureCut();let error:unknown;let operation:Promise<void>|undefined;
  try {
    operation=f.player.selectVideoTrack({name:'alternate-video',namespace:ns}).catch(cause=>{error=cause;});await flush(512);
    const id=f.fetchIds.at(-1)!,peerErrors:string[]=[];
    const original=f.client.onMessage;
    f.client.onMessage=message=>{if(message.type==='REQUEST_ERROR'&&message.requestId===id)peerErrors.push(message.errorReason);original?.(message);};
    await f.server.rejectFetch(id,1n,'target history unavailable');await flush(512);await operation;
    expect(error).toBeInstanceOf(Error);expect(f.player.state).toBe('playing');expect(f.player.selection.video?.name).toBe('video');
    expect(video.decoder.destroy).not.toHaveBeenCalled();expect(audio.decoder.destroy).not.toHaveBeenCalled();expect(audio.output.destroy).not.toHaveBeenCalled();
    expect(f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();expect(f.outputs[1]!.draw).not.toHaveBeenCalled();
    await live(f,401n,4n,4n,3400n);audio.head.value={...audio.head.value!,sourceTimestampUs:3_400_000n};f.advance(1_400_000);await flush(512);
    expect(video.draw.mock.calls.at(-1)![0].timestamp).toBe(3_400_000);expect(f.audioOutputs[0]).toBe(audio);
    expect(peerErrors).toEqual(['target history unavailable']);
    expect(f.errors).toEqual([expect.stringContaining('failed: Seek live stream ended with error')]);
  }finally{await f.destroy();await operation;}
});


it.each(['pause','throw'] as const)('classifies actual role publication when the scoped adoption callback performs %s',async action=>{
  let player:Fixture['player']|undefined,entered=false;
  const {f,audio}=await playingWithFutureCut(undefined,()=>{entered=true;if(action==='pause')player!.pause();else throw new Error('target adoption failed');});player=f.player;
  let settled=false,error:unknown,operation:Promise<void>|undefined;
  try{
    const switched=vi.fn();f.player.on('quality_switched',switched);
    operation=f.player.selectVideoTrack({name:'alternate-video',namespace:ns}).then(()=>{settled=true;},cause=>{settled=true;error=cause;});await flush(512);
    await supplyTarget(f);await flush(512);
    expect(entered).toBe(true);expect(settled).toBe(true);expect(switched).not.toHaveBeenCalled();
    if(action==='pause'){
      expect(error).toMatchObject({name:'AbortError'});expect(f.player.state).toBe('paused');expect(f.player.playbackPositionMs).toBe(3300);
      expect(f.player.selection.video?.name).toBe('alternate-video');expect(f.outputs[1]!.draw).not.toHaveBeenCalled();
      expect(audio.decoder.destroy).not.toHaveBeenCalled();expect(audio.output.destroy).not.toHaveBeenCalled();
      expect(f.outputs[1]!.decoder.destroy).not.toHaveBeenCalled();expect(f.audioOutputs[0]).toBe(audio);expect(f.errors).toEqual([]);
      await expect(f.player.selectVideoTrack({name:'video',namespace:ns})).rejects.toThrow(/video-only/);
    }else{
      expect(error).toBeInstanceOf(Error);expect(f.player.state).toBe('error');
      expect(audio.decoder.destroy).toHaveBeenCalledOnce();expect(audio.output.destroy).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([expect.stringContaining('failed after video adoption: target adoption failed')]);
    }
  }finally{await f.destroy();await operation;}
});
