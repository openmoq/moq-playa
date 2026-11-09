import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { MessageParam } from '@openmoq/transport';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { locSeekFixture } from '../test-support/video-role-fixture.js';

beforeEach(()=>vi.stubGlobal('document',{hidden:false,addEventListener(){},removeEventListener(){}}));
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
type Fixture=Awaited<ReturnType<typeof locSeekFixture>>;
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
async function landed(audio:boolean,different:boolean,isLive:boolean){
  const f=await locSeekFixture(18,audio,true,{producingOutput:true,alternative:true,isLive,catalogVersion:'1',
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


import { LocSeekPlayback, type LocVideoRolePreparation } from './loc-seek-playback.js';
import type { MoqtObject } from '@openmoq/transport';
async function active() {
  const f=await landed(true,true,true),audio=f.audioOutputs[0]!,video=f.outputs[0]!;
  const timing=vi.mocked(audio.output.schedule).mock.calls[0]![3]!;
  audio.head.value={epoch:timing.context.epoch,sourceTimestampUs:3_000_000n,sourceOffsetUs:0};
  f.advance(1_000_000);await flush(512);
  await f.updateTimeline([[1000,[3,0],0],[3000,[4,0],0],[3100,[4,1],0]]);
  await bridge(f,'video',401n);await bridge(f,'audio',402n);
  audio.head.value={...audio.head.value!,sourceTimestampUs:3_300_000n};f.advance(1_300_000);await flush(512);
  expect(f.player.playbackPositionMs).toBe(3300);expect(video.draw.mock.calls.at(-1)![0].timestamp).toBe(3_300_000);
  const entries=[{mediaPts:3500,location:[5,0] as [number,number],wallclockTime:0}];
  await f.updateTimeline([[1000,[3,0],0],[3000,[4,0],0],[3100,[4,1],0],[3500,[5,0],0]]);
  // Controlled engine integration seam: the initial actor is genuinely adopted
  // through public seek + SDK. Candidate APIs are the new actor public surface.
  const actor=(f.player as unknown as {activeLocSeek:{playback:LocSeekPlayback}}).activeLocSeek.playback;
  expect(actor.videoRoleOwner,'actor exposes exact video role ownership').toBeTypeOf('function');
  const errors:Error[]=[],onReady=vi.fn(),onPresented=vi.fn();
  const options:LocVideoRolePreparation={expectedOwner:actor.videoRoleOwner()!,track:{role:'video',info:{codec:'avc1.640028',width:1280,height:720,packaging:'loc'}},
    location:{groupId:5n,objectId:0n},mediaPts:3500,cutMs:3500,getTimelineEntries:()=>entries,isCurrent:()=>true,
    onReady,onPresented,onGraphCreated(){},onGraphRetiring(){},onGraphRetired(){},onCommand(){},onConfiguration(){},onPageDrained(){},onPageError:(_id,error)=>errors.push(error),onError:error=>errors.push(error)};
  return {f,actor,audio,video,timing,options,errors,onReady,onPresented};
}
async function fill(candidate:ReturnType<LocSeekPlayback['prepareVideoRole']>, sourceStart=8500n, group=5n) {
  const identity={},page=candidate.beginPage(identity);
  candidate.acceptPage(identity,false,{start:{groupId:group,objectId:0n},through:{kind:'after-group',groupId:group},endOfTrack:false,groupOrder:'ascending',rangeFilters:false});
  for(const id of [0n,1n]) {
    const value=bytes(id,sourceStart+id*100n);
    const object:MoqtObject={kind:'data',trackAlias:900n,groupId:group,subgroupId:0n,objectId:id,publisherPriority:128,...value};
    await page.onObject(object);
  }
  page.onClosed('fin');await flush(1024);
}
it('seedless different-resolution candidate proves output on the retained A/V clock and retires only old video',async()=>{
  const h=await active();try {
    expect(h.actor.prepareVideoRole,'actor exposes role preparation').toBeTypeOf('function');
    expect(h.actor.videoCutFrontier()).toEqual({owner:h.options.expectedOwner,positionMs:3300});
    const graph=h.actor.diagnosticGraph,audioConfiguration=h.actor.installedConfiguration('audio');
    const candidate=h.actor.prepareVideoRole(h.options);
    expect(h.f.audioOutputs).toHaveLength(1);expect(h.video.decoder.destroy).not.toHaveBeenCalled();
    await fill(candidate);expect(h.errors).toEqual([]);expect(candidate.ready).toBe(true);expect(h.onReady).toHaveBeenCalledOnce();
    expect(candidate.configuration?.format).toMatchObject({mediaType:'video',width:1280,height:720});
    expect(h.actor.diagnosticGraph).toBe(graph);expect(h.actor.installedConfiguration('audio')).toBe(audioConfiguration);
    expect(h.f.outputs[1]!.draw).not.toHaveBeenCalled();expect(h.f.player.playbackPositionMs).toBe(3300);
    candidate.commit();expect(candidate.current).toBe(true);expect(h.actor.videoRoleOwner()).toBe(candidate.owner);
    expect(h.actor.videoDiagnosticGraphs).toHaveLength(2);expect(h.video.decoder.destroy).not.toHaveBeenCalled();
    h.audio.head.value={...h.audio.head.value!,sourceTimestampUs:3_500_000n};h.f.advance(1_500_000);await flush(512);
    expect(h.f.outputs[1]!.draw.mock.calls.map(call=>call[0].timestamp)).toContain(8_500_000);
    expect(h.onPresented).toHaveBeenCalledExactlyOnceWith(3500);expect(h.video.decoder.destroy).toHaveBeenCalledOnce();
    expect(h.actor.diagnosticGraph).toBe(graph);expect(h.actor.videoDiagnosticGraphs).toEqual([candidate.graph]);
    expect(h.audio.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();
    expect(h.actor.installedConfiguration('audio')).toBe(audioConfiguration);expect(h.f.player.playbackPositionMs).toBe(3500);
    expect(h.errors).toEqual([]);
  }finally{await h.f.destroy();}
});
it('candidate cancellation retains old output/audio and releases the future cut',async()=>{
 const h=await active();try {
   expect(h.actor.prepareVideoRole).toBeTypeOf('function');const owner=h.actor.videoRoleOwner();
   const candidate=h.actor.prepareVideoRole(h.options);await fill(candidate);expect(candidate.ready).toBe(true);candidate.cancel();
   expect(candidate.current).toBe(false);expect(h.actor.videoRoleOwner()).toBe(owner);expect(h.f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();
   expect(h.video.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();
   await live(h.f,401n,5n,0n,3500n);h.audio.head.value={...h.audio.head.value!,sourceTimestampUs:3_500_000n};h.f.advance(1_500_000);await flush(512);
   expect(h.video.draw.mock.calls.map(call=>call[0].timestamp)).toContain(3_500_000);expect(h.errors).toEqual([]);
 }finally{await h.f.destroy();}
});
it.each(['prepare','commit'] as const)('isCurrent pause reentry refuses %s after callback returns true',async boundary=>{
 const h=await active();try {
   expect(h.actor.prepareVideoRole).toBeTypeOf('function');let armed=boundary==='prepare';
   const options={...h.options,isCurrent:()=>{if(armed){armed=false;h.f.player.pause();}return true;}};
   if(boundary==='prepare'){expect(()=>h.actor.prepareVideoRole(options)).toThrow();expect(h.f.outputs).toHaveLength(1);}
   else {const candidate=h.actor.prepareVideoRole(options);await fill(candidate);expect(candidate.ready).toBe(true);armed=true;expect(()=>candidate.commit()).toThrow();expect(h.onPresented).not.toHaveBeenCalled();}
   expect(h.f.player.state).toBe('paused');expect(h.audio.decoder.destroy).not.toHaveBeenCalled();
 }finally{await h.f.destroy();}
});

it.each(['expired','removed-anchor'] as const)('ready candidate cannot commit a %s cut',async reason=>{
 const h=await active();try {
   let entries=h.options.getTimelineEntries();
   const candidate=h.actor.prepareVideoRole({...h.options,getTimelineEntries:()=>entries});await fill(candidate);expect(candidate.ready).toBe(true);
   if(reason==='expired') h.f.advance(2_000_000);else entries=[];
   expect(()=>candidate.commit()).toThrow(/cannot commit/);expect(h.actor.videoRoleOwner()).toBe(h.options.expectedOwner);
   expect(h.video.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();candidate.cancel();
 }finally{await h.f.destroy();}
});
it('candidate input budget failure releases only its resources and hold',async()=>{
 const h=await active();try {
   const candidate=h.actor.prepareVideoRole(h.options),identity={},page=candidate.beginPage(identity);
   candidate.acceptPage(identity,false,{start:{groupId:5n,objectId:0n},through:{kind:'after-group',groupId:5n},endOfTrack:false,groupOrder:'ascending',rangeFilters:false});
   const value=bytes(0n,8500n),payload=new Uint8Array(9*1024*1024);payload.set(value.payload);
   await page.onObject({kind:'data',trackAlias:900n,groupId:5n,subgroupId:0n,objectId:0n,publisherPriority:128,...value,payload}).catch(()=>{});await flush(512);
   expect(h.errors.length).toBeGreaterThan(0);expect(candidate.current).toBe(false);expect(h.actor.videoRoleOwner()).toBe(h.options.expectedOwner);
   expect(h.f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();expect(h.video.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();
 }finally{await h.f.destroy();}
});
it('throwing old video destruction still releases renderer and settles the proved new picture without retiring audio',async()=>{
 const h=await active();try {
   const destroyRenderer=vi.spyOn(h.video.renderer,'destroy');
   const failure=new Error('old decoder cleanup');vi.mocked(h.video.decoder.destroy).mockImplementationOnce(()=>{throw failure;});
   const candidate=h.actor.prepareVideoRole(h.options);await fill(candidate);candidate.commit();
   h.audio.head.value={...h.audio.head.value!,sourceTimestampUs:3_500_000n};
   try {h.f.advance(1_500_000);}catch(error){expect(error).toBe(failure);}await flush(512);
   expect(h.onPresented).toHaveBeenCalledExactlyOnceWith(3500);expect(destroyRenderer).toHaveBeenCalledOnce();
   expect(h.errors).toContain(failure);
   expect(candidate.current).toBe(true);expect(h.audio.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();
 }finally{await h.f.destroy();}
});

it('a rejected target configuration never produces readiness or changes the audio owner',async()=>{
 const h=await active();try {
   const candidate=h.actor.prepareVideoRole(h.options);vi.mocked(h.f.outputs[1]!.decoder.configure).mockImplementation(()=>{throw new Error('target codec refused');});
   await fill(candidate);expect(candidate.ready).toBe(false);expect(h.onReady).not.toHaveBeenCalled();expect(candidate.configuration).toBeNull();
   expect(candidate.current).toBe(false);expect(h.errors.length).toBeGreaterThan(0);expect(h.video.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();
 }finally{await h.f.destroy();}
});
it('pausing a promoted role flushes its video without destroying the retained audio owner',async()=>{
 const h=await active();try {
   const candidate=h.actor.prepareVideoRole(h.options);await fill(candidate);candidate.commit();
   const renderer=h.f.outputs[1]!.renderer,flushVideo=vi.spyOn(renderer,'flush');
   h.f.player.pause();await flush(512);expect(flushVideo).toHaveBeenCalled();expect(h.onPresented).not.toHaveBeenCalled();
   expect(h.audio.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();expect(h.f.player.state).toBe('paused');
 }finally{await h.f.destroy();}
});

it('a second differing-resolution cut retires the displaced video child and preserves original audio',async()=>{
 const h=await active();try {
   const first=h.actor.prepareVideoRole(h.options);await fill(first);first.commit();
   h.audio.head.value={...h.audio.head.value!,sourceTimestampUs:3_500_000n};h.f.advance(1_500_000);await flush(512);
   const prior=h.f.outputs[1]!,second=h.actor.prepareVideoRole({...h.options,expectedOwner:first.owner,
     track:{role:'video',info:{codec:'avc1.640028',width:1920,height:1080,packaging:'loc'}},
     cutMs:4000,mediaPts:4000,location:{groupId:6n,objectId:0n},getTimelineEntries:()=>[{mediaPts:4000,location:[6,0],wallclockTime:0}]});
   await fill(second,12000n,6n);expect(second.ready).toBe(true);second.commit();expect(first.current).toBe(false);
   expect(prior.decoder.destroy).not.toHaveBeenCalled();expect(h.actor.videoDiagnosticGraphs).toHaveLength(2);
   h.audio.head.value={...h.audio.head.value!,sourceTimestampUs:4_000_000n};h.f.advance(2_000_000);await flush(512);
   expect(h.f.outputs[2]!.draw.mock.calls.map(call=>call[0].timestamp)).toContain(12_000_000);
   expect(prior.decoder.destroy).toHaveBeenCalledOnce();expect(h.actor.videoDiagnosticGraphs).toEqual([second.graph]);
   expect(h.f.audioOutputs).toHaveLength(1);expect(h.audio.decoder.destroy).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
 }finally{await h.f.destroy();}
});

it('never-ready candidate expires at the audio-led cut and releases old video without waiting for generic timeout',async()=>{
 const h=await active();try {
   const audioOwner=h.f.audioOutputs[0],candidate=h.actor.prepareVideoRole(h.options);
   await live(h.f,401n,5n,0n,3500n);expect(h.video.draw.mock.calls.map(call=>call[0].timestamp)).not.toContain(3_500_000);
   h.audio.head.value={...h.audio.head.value!,sourceTimestampUs:3_500_000n};h.f.advance(1_500_000);await flush(512);
   expect(candidate.current,'pending preparation must retire at its presentation cut').toBe(false);
   expect(h.errors).toHaveLength(1);expect(h.errors[0]!.message).toMatch(/cut.*reached|cut.*expired/i);
   expect(h.video.draw.mock.calls.map(call=>call[0].timestamp)).toContain(3_500_000);
   expect(h.f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();expect(h.f.audioOutputs[0]).toBe(audioOwner);
   expect(h.audio.decoder.destroy).not.toHaveBeenCalled();expect(h.audio.output.destroy).not.toHaveBeenCalled();
   h.f.advance(1_600_000);await flush(512);expect(h.errors).toHaveLength(1);expect(h.actor.videoRoleOwner()).toBe(h.options.expectedOwner);
 }finally{await h.f.destroy();}
});


it.each(['cancel-control', 'actor-pause', 'public-pause', 'public-pause-host-guard'] as const)(
  'releasing a video cut during %s preserves the preparation boundary', async action => {
    const h = await active();
    let restoreRenderer: { mockRestore(): void } | undefined;
    let successor: ReturnType<LocSeekPlayback['prepareVideoRole']> | undefined;
    const observed: {
      timestamp?: number;
      state?: string;
      firstCurrent?: boolean;
      admitted?: boolean;
      successorCurrent?: boolean;
    } = {};
    try {
      expect(h.actor).toBeInstanceOf(LocSeekPlayback);
      const first = h.actor.prepareVideoRole(h.options);
      await live(h.f, 401n, 5n, 0n, 3500n);
      expect(vi.mocked(h.video.decoder.decode).mock.calls.some(([chunk]) => chunk.timestamp === 3_500_000)).toBe(true);
      expect(h.video.draw.mock.calls.map(call => call[0].timestamp)).not.toContain(3_500_000);
      const enqueue = h.video.renderer.enqueue.bind(h.video.renderer);
      let entered = false;
      restoreRenderer = vi.spyOn(h.video.renderer, 'enqueue').mockImplementation((...args) => {
        if (!entered) {
          entered = true;
          observed.timestamp = (args[0] as { timestamp: number }).timestamp;
          observed.state = h.f.player.state;
          observed.firstCurrent = first.current;
          try {
            successor = h.actor.prepareVideoRole({
              ...h.options, expectedOwner: h.options.expectedOwner,
              cutMs: 4000, mediaPts: 4000, location: { groupId: 6n, objectId: 0n },
              getTimelineEntries: () => [{ mediaPts: 4000, location: [6, 0], wallclockTime: 0 }],
              isCurrent: action === 'public-pause-host-guard' ? () => h.f.player.state === 'playing' : h.options.isCurrent,
            });
            observed.admitted = true;
            observed.successorCurrent = successor.current;
          } catch {
            observed.admitted = false;
          }
        }
        return enqueue(...args);
      });
      if (action === 'cancel-control') first.cancel();
      else if (action === 'actor-pause') h.actor.setPlaying(false);
      else h.f.player.pause();
      expect(entered, 'the real held output must reach its renderer').toBe(true);
      expect(observed.timestamp).toBe(3_500_000);
      expect(observed.firstCurrent).toBe(false);
      expect(h.f.outputs[1]!.decoder.destroy).toHaveBeenCalledOnce();
      if (action === 'cancel-control') {
        expect(observed.state).toBe('playing');
        expect(observed.admitted).toBe(true);
        expect(observed.successorCurrent).toBe(true);
        expect(successor?.current).toBe(true);
        expect(h.f.outputs).toHaveLength(3);
      } else {
        expect(observed.state).toBe(action === 'actor-pause' ? 'playing' : 'paused');
        expect(observed.admitted, 'pause must fence preparation before releasing old output').toBe(false);
        expect(successor).toBeUndefined();
        expect(h.f.outputs).toHaveLength(2);
      }
      expect(h.audio.decoder.destroy).not.toHaveBeenCalled();
      expect(h.audio.output.destroy).not.toHaveBeenCalled();
      expect(h.errors).toEqual([]);
    } finally {
      restoreRenderer?.mockRestore();
      successor?.cancel();
      await h.f.destroy();
    }
  },
);
