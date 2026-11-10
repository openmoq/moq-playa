import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import dgram from 'node:dgram';
import { MseMediaSource } from './mse-adapter.js';
import { MockMediaSource, MockVideoElement, makeTimeRanges } from '../test-support/mse-native.js';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
const CT=11.029333, EDGE=10.99, END=10.999999, NEXT=12.021333, LAND=NEXT+0.01;
let native: MockMediaSource;
const evidence: unknown[]=[];
beforeEach(()=>{
 vi.useFakeTimers(); native=new MockMediaSource();
 vi.stubGlobal('MediaSource',class {constructor(){return native;}});
 vi.stubGlobal('URL',{createObjectURL:()=> 'blob:crossed-gap',revokeObjectURL(){}});
 vi.spyOn(dgram,'createSocket').mockImplementation(()=>{throw Error('Native UDP prohibited');});
});
afterEach(()=>{expect(dgram.createSocket).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const init=(kind:'video'|'audio')=>buildInit({trackId:kind==='video'?1:2,timescale:1000,handler:kind==='video'?'vide':'soun'});
const segment=(kind:'video'|'audio',pts=20)=>buildChunk({trackId:kind==='video'?1:2,bmdt:BigInt(pts*1000),samples:[{duration:1000,size:4,flags:SYNC_FLAGS}],mdat:Uint8Array.of(1,2,3,4)});
async function fixture(ct=CT, reorderWindowMs=250, mseAttachment: 'object-url' | 'src-object' = 'object-url'){
 const video=Object.assign(new MockVideoElement(), { duration: Infinity, ended: false, currentSrc: '' });video.buffered=makeTimeRanges([[0,7]]);
 video.removeAttribute=(name:string)=>{if(name==='src')video.src='';};
 const adapter=new MseMediaSource(video as unknown as HTMLVideoElement,{maxAheadSec:Infinity, reorderWindowMs, mseAttachment});
 const jumps:any[]=[],errors:string[]=[];adapter.onGapJump=x=>jumps.push(x);adapter.onError=e=>errors.push(e.message);
 expect(adapter.initialize({video:{codec:'avc1.640028',initData:init('video')},audio:{codec:'mp4a.40.2',initData:init('audio')}})).toBe(true);
 native.open();await settle();native.videoBuffer.buffered=makeTimeRanges([[0,7]]);native.audioBuffer.buffered=makeTimeRanges([[0,7]]);
 adapter.setPlaybackIntent(true);adapter.appendChunk('video',segment('video',0),'video',7n);await settle();
 expect(video.playCalls).toBe(1);expect(native.videoBuffer.updating).toBe(false);expect(native.audioBuffer.updating).toBe(false);
 native.videoBuffer.buffered=makeTimeRanges([[1.5,END],[12,131.499999]]);
 native.audioBuffer.buffered=makeTimeRanges([[1.045333,11.013333],[NEXT,131.930666]]);
 video.buffered=makeTimeRanges([[1.5,END],[NEXT,131.499999]]);
 video.advancePlayback(ct);video.frames=264;video.readyState=2;video.seekCount=0;
 const pending:Promise<unknown>[]=[];
 return {video,adapter,jumps,errors,pending,
 record(name:string){evidence.push({name,currentTime:video.currentTime,seekCount:video.seekCount,jumps:[...jumps],errors:[...errors],quality:video.getVideoPlaybackQuality().totalVideoFrames,videoUpdating:native.videoBuffer.updating,audioUpdating:native.audioBuffer.updating});},
 async close(){adapter.destroy();await settle();await Promise.allSettled(pending);}};
}
it('measured crossed BOTH-track narrow gap seeks into the shared future range after the existing wait',async()=>{
 const f=await fixture();try{
 expect(f.video.paused).toBe(false);expect(f.video.seeking).toBe(false);
 await vi.advanceTimersByTimeAsync(2000);expect(f.video.seekCount).toBe(0);
 await vi.advanceTimersByTimeAsync(2000);f.record('measured-crossed-both-track');
 expect(f.jumps).toHaveLength(1);expect(f.video.seekCount).toBe(1);expect(f.video.currentTime).toBeCloseTo(LAND,6);
 expect(f.jumps[0].holeSec).toBeCloseTo(NEXT-END,6);expect(f.jumps[0].waitedMs).toBeGreaterThanOrEqual(2000);
 }finally{await f.close();}
});
it('CONTROL: inside previous combined range recovers to the safe combined landing',async()=>{
 const f=await fixture(EDGE);try{await vi.advanceTimersByTimeAsync(4000);f.record('inside-previous');expect(f.jumps).toHaveLength(1);expect(f.video.currentTime).toBeCloseTo(LAND,6);}finally{await f.close();}
});
it('CONTROL: continuous audio retains the existing crossed video-only recovery',async()=>{
 const f=await fixture();try{native.audioBuffer.buffered=makeTimeRanges([[1.045333,131.930666]]);f.video.buffered=makeTimeRanges([[1.5,END],[12,131.499999]]);
 await vi.advanceTimersByTimeAsync(4000);f.record('continuous-audio');expect(f.jumps).toHaveLength(1);expect(f.video.currentTime).toBeCloseTo(12.01,6);}finally{await f.close();}
});
for(const position of ['crossed','inside'] as const) for(const mode of ['video-append','audio-append','retype','paused','seeking','intent-withdrawn'] as const){
 it(`CONTROL: ${mode} vetoes ${position} gap recovery`,async()=>{
  const f=await fixture(position==='crossed'?CT:EDGE);try{
   if(mode.endsWith('append')){const kind=mode==='video-append'?'video':'audio';const sb=kind==='video'?native.videoBuffer:native.audioBuffer;sb.autoComplete=false;const calls=sb.appendedPayloads.length;
    // New current group, strictly beyond both measured native tails. Let the existing 250ms reorder wait expire.
    expect(132).toBeGreaterThan(sb.buffered.end(sb.buffered.length-1));
    f.adapter.appendChunk(kind,segment(kind,132),kind,8n);await vi.advanceTimersByTimeAsync(300);
    expect(sb.appendedPayloads).toHaveLength(calls+1);expect(sb.updating).toBe(true);}
   if(mode==='retype'){native.videoBuffer.autoComplete=false;const p=f.adapter.changeType('video','avc1.640029',init('video'));f.pending.push(p);p.catch(()=>{});await settle();expect(native.videoBuffer.updating).toBe(true);expect(native.videoBuffer.changeTypeCalls).toHaveLength(1);}
   if(mode==='paused')f.video.paused=true;
   if(mode==='seeking')f.video.seeking=true;
   if(mode==='intent-withdrawn')f.adapter.setPlaybackIntent(false);
   await vi.advanceTimersByTimeAsync(4000);f.record(mode+'-'+position);expect(f.video.seekCount).toBe(0);expect(f.jumps).toHaveLength(0);
   if(position==='inside' && (mode.endsWith('append') || mode==='retype')){
    const sb=mode==='audio-append'?native.audioBuffer:native.videoBuffer;
    if(mode.endsWith('append')){
     const ranges=Array.from({length:sb.buffered.length},(_,i)=>[sb.buffered.start(i),sb.buffered.end(i)] as [number,number]);
     sb.buffered=makeTimeRanges([...ranges,[132,133]]); // Far new island; the adjacent old gap is unchanged.
    }
    sb.updating=false;sb.fire('update');sb.fire('updateend');await settle();await Promise.all(f.pending);
    expect(sb.updating).toBe(false);await vi.advanceTimersByTimeAsync(4000);f.record(mode+'-inside-after-completion');
    expect(f.jumps).toHaveLength(1);expect(f.video.seekCount).toBe(1);expect(f.video.currentTime).toBeCloseTo(LAND,6);
   }
  }finally{await f.close();}
 });
}
for(const mode of ['no-future-audio','wide-gap','unrelated-video-island','unrelated-audio-island','no-predecessor','deep-gap','high-readiness'] as const){
 it(`CONTROL: ${mode} cannot authorize the proposed crossed-both-track recovery`,async()=>{
 const f=await fixture();try{
  if(mode==='no-future-audio'){native.audioBuffer.buffered=makeTimeRanges([[1.045333,11.013333]]);f.video.buffered=makeTimeRanges([[1.5,END]]);}
  if(mode==='wide-gap'){native.videoBuffer.buffered=makeTimeRanges([[1.5,END],[13.2,131.499999]]);native.audioBuffer.buffered=makeTimeRanges([[1.045333,11.013333],[13.221333,131.930666]]);f.video.buffered=makeTimeRanges([[1.5,END],[13.221333,131.499999]]);}
  if(mode==='unrelated-video-island')native.videoBuffer.buffered=makeTimeRanges([[1.5,END],[11.5,11.6],[12,131.499999]]);
  if(mode==='unrelated-audio-island')native.audioBuffer.buffered=makeTimeRanges([[1.045333,11.013333],[11.5,11.6],[NEXT,131.930666]]);
  if(mode==='no-predecessor'){native.videoBuffer.buffered=makeTimeRanges([[12,131.499999]]);native.audioBuffer.buffered=makeTimeRanges([[NEXT,131.930666]]);f.video.buffered=makeTimeRanges([[NEXT,131.499999]]);}
  if(mode==='deep-gap')f.video.advancePlayback(11.8);
  if(mode==='high-readiness')f.video.readyState=4;
  await vi.advanceTimersByTimeAsync(4000);f.record(mode);expect(f.video.seekCount).toBe(0);expect(f.jumps).toHaveLength(0);
 }finally{await f.close();}
 });
}
it('CONTROL: the existing edge path refuses a width strictly above 2s',async()=>{
 const f=await fixture(EDGE);try{native.videoBuffer.buffered=makeTimeRanges([[1.5,END],[13.2,131.499999]]);native.audioBuffer.buffered=makeTimeRanges([[1.045333,11.013333],[13.221333,131.930666]]);f.video.buffered=makeTimeRanges([[1.5,END],[13.221333,131.499999]]);
 await vi.advanceTimersByTimeAsync(4000);f.record('wide-inside');expect(f.video.seekCount).toBe(0);expect(f.jumps).toHaveLength(0);}finally{await f.close();}
});
it('CONTROL: advancing native-quality counters veto recovery on the otherwise recoverable edge',async()=>{
 const f=await fixture(EDGE);try{for(let i=0;i<4;i++){f.video.frames++;await vi.advanceTimersByTimeAsync(1000);}f.record('advancing-quality');expect(f.video.seekCount).toBe(0);expect(f.jumps).toHaveLength(0);}finally{await f.close();}
});

function shape(f: Awaited<ReturnType<typeof fixture>>, start=13, tail=30, ct=11.1) {
 const ranges=makeTimeRanges([[1,11],[start,tail]]);
 f.video.buffered=ranges; native.videoBuffer.buffered=ranges; native.audioBuffer.buffered=ranges;
 f.video.advancePlayback(ct);
}
it.each([
 ['exact two seconds',13,11.1,1], ['just over two seconds',13.000001,11.1,0],
 ['just below overshoot edge',12,11.499999,1], ['exact overshoot edge',12,11.5,0],
 ['beyond overshoot edge',12,11.500001,0],
] as const)('boundary: %s',async(_name,start,ct,count)=>{
 const f=await fixture();try{shape(f,start,30,ct);await vi.advanceTimersByTimeAsync(4000);
 expect(f.jumps).toHaveLength(count);expect(f.video.seekCount).toBe(count);
 }finally{await f.close();}
});
it.each([0,1,2,3,4])('crossed combined readiness %s',async readiness=>{
 const f=await fixture();try{f.video.readyState=readiness;await vi.advanceTimersByTimeAsync(4000);
 expect(f.jumps).toHaveLength(readiness===1||readiness===2?1:0);
 }finally{await f.close();}
});
it.each(['interior','at-duration','before-landing','nan-duration','terminal','short','ended-interior','ended-synthetic-tail','element-ended'] as const)('finite landing: %s',async mode=>{
 const f=await fixture();try{
 shape(f,12,mode==='short'?12.004:30);f.video.duration=40;
 if(mode==='at-duration')f.video.duration=12.01;
 if(mode==='before-landing')f.video.duration=12.005;
 if(mode==='nan-duration')f.video.duration=NaN;
 if(mode==='terminal')f.video.buffered=makeTimeRanges([[1,11]]);
 if(mode.startsWith('ended-'))native.readyState='ended';
 if(mode==='ended-synthetic-tail')native.audioBuffer.buffered=makeTimeRanges([[1,11],[12,12.005]]);
 if(mode==='element-ended')f.video.ended=true;
 await vi.advanceTimersByTimeAsync(4000);
 const eligible=['interior','short','ended-interior'].includes(mode);
 expect(f.jumps).toHaveLength(eligible?1:0);expect(f.video.seekCount).toBe(eligible?1:0);
 if(eligible)expect(f.video.currentTime).toBeCloseTo(mode==='short'?12.002:12.01,8);
 }finally{await f.close();}
});
it('queued accepted work vetoes recovery while neither SourceBuffer is updating, then completion permits recovery',async()=>{
 const f=await fixture(CT,6000);try{
 const before=native.videoBuffer.appendedPayloads.length;
 f.adapter.appendChunk('video',segment('video',132),'video',8n);await settle();
 expect(native.videoBuffer.updating).toBe(false);expect(native.audioBuffer.updating).toBe(false);
 expect(native.videoBuffer.appendedPayloads).toHaveLength(before);
 await vi.advanceTimersByTimeAsync(4000);expect(f.jumps).toHaveLength(0);
 expect(native.videoBuffer.appendedPayloads).toHaveLength(before);expect(native.videoBuffer.updating).toBe(false);
 await vi.advanceTimersByTimeAsync(6000);
 expect(native.videoBuffer.appendedPayloads).toHaveLength(before+1);expect(f.jumps).toHaveLength(1);
 }finally{await f.close();}
});
it.each(['reset','withdraw-intent','pending-append','detach','evict'] as const)('native getter reentry cannot commit stale authority: %s',async mode=>{
 const f=await fixture();try{
 await vi.advanceTimersByTimeAsync(2000);expect(f.jumps).toHaveLength(0);
 const sb=native.audioBuffer, old=sb.buffered;let fired=false;
 Object.defineProperty(sb,'buffered',{configurable:true,get(){
  if(!fired){fired=true;
   if(mode==='reset')f.adapter.reset();
   if(mode==='withdraw-intent')f.adapter.setPlaybackIntent(false);
   if(mode==='pending-append'){native.videoBuffer.autoComplete=false;f.adapter.appendChunk('video',segment('video',132),'video',8n);}
   if(mode==='detach')native.removeSourceBuffer(sb);
   if(mode==='evict')f.video.buffered=makeTimeRanges([[1.5,END]]);
  }
  return old;
 },set(value){Object.defineProperty(sb,'buffered',{configurable:true,writable:true,value});}});
 await vi.advanceTimersByTimeAsync(1000);expect(fired).toBe(true);expect(f.video.seekCount).toBe(0);expect(f.jumps).toHaveLength(0);
 }finally{await f.close();}
});
it('successor eviction during the wait disarms and restored coverage must wait afresh',async()=>{
 const f=await fixture();try{
 await vi.advanceTimersByTimeAsync(2000);const ranges=f.video.buffered;
 f.video.buffered=makeTimeRanges([[1.5,END]]);await vi.advanceTimersByTimeAsync(1000);
 f.video.buffered=ranges;await vi.advanceTimersByTimeAsync(2000);expect(f.jumps).toHaveLength(0);
 await vi.advanceTimersByTimeAsync(1000);expect(f.jumps).toHaveLength(1);
 }finally{await f.close();}
});
it('growing successor tails preserve the original edge wait',async()=>{
 const f=await fixture();try{await vi.advanceTimersByTimeAsync(2000);
 f.video.buffered=makeTimeRanges([[1.5,END],[NEXT,140]]);
 native.videoBuffer.buffered=makeTimeRanges([[1.5,END],[12,140]]);
 native.audioBuffer.buffered=makeTimeRanges([[1.045333,11.013333],[NEXT,141]]);
 await vi.advanceTimersByTimeAsync(1000);expect(f.jumps).toHaveLength(1);
 }finally{await f.close();}
});

it.each(['none','reset','begin-seek','pending-append','withdraw-intent'] as const)('commit-time reentry on an otherwise-positive candidate: %s',async mode=>{
 const f=await fixture();try{
 await vi.advanceTimersByTimeAsync(2000);expect(f.jumps).toHaveLength(0);
 const sb=native.audioBuffer, ranges=sb.buffered;let reads=0,acted=false,seekOwned=false;
 Object.defineProperty(sb,'buffered',{configurable:true,get(){
  // First read discovers the eligible hole; second is the commit-time re-read.
  if(++reads===2){acted=true;
   if(mode==='reset')f.adapter.reset();
   if(mode==='begin-seek'){
    native=new MockMediaSource();
    seekOwned=f.adapter.beginSeek({}).current;
   }
   if(mode==='pending-append'){native.videoBuffer.autoComplete=false;f.adapter.appendChunk('video',segment('video',132),'video',8n);}
   if(mode==='withdraw-intent')f.adapter.setPlaybackIntent(false);
  }
  return ranges;
 },set(value){Object.defineProperty(sb,'buffered',{configurable:true,writable:true,value});}});
 await vi.advanceTimersByTimeAsync(1000);expect(acted).toBe(true);
 if(mode==='begin-seek')expect(seekOwned).toBe(true);
 expect(f.jumps).toHaveLength(mode==='none'?1:0);expect(f.video.seekCount).toBe(mode==='none'?1:0);
 }finally{await f.close();}
});
it('an unreleased positioned seek owns the same eligible gap until explicitly released',async()=>{
 const f=await fixture();try{
 await vi.advanceTimersByTimeAsync(2000);
 native=new MockMediaSource();
 const resource=f.adapter.beginSeek({});
 expect(resource.initialize({video:{codec:'avc1.640028',initData:init('video')},audio:{codec:'mp4a.40.2',initData:init('audio')}})).toBe(true);
 native.open();await settle();shape(f,12,30,10.9);
 const positioned=resource.position(10.9);f.video.fire('seeked');await positioned;await settle();expect(resource.current).toBe(true);
 f.video.advancePlayback(11.1);f.video.readyState=2;f.video.paused=false;f.video.seekCount=0;
 await vi.advanceTimersByTimeAsync(4000);expect(f.jumps).toHaveLength(0);expect(f.video.seekCount).toBe(0);
 // Position/sample ownership is retained; only explicit release grants playback recovery.
 f.video.advancePlayback(10.9);resource.setPlaybackIntent(true);await settle();
 f.video.advancePlayback(11.1);await vi.advanceTimersByTimeAsync(4000);
 expect(f.jumps).toHaveLength(1);expect(f.video.currentTime).toBeCloseTo(12.01,8);
 }finally{await f.close();}
});


// Cold-review schedules: all mutate only at the otherwise-positive commit read.
it.each(['none', 'intent-cycle', 'settled-user-seek', 'duration', 'readiness', 'source-closed'] as const)(
  'final native read preserves episode and media bounds: %s', async mode => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(2000);
      const sb = native.audioBuffer, ranges = sb.buffered;
      let reads = 0, acted = false;
      Object.defineProperty(sb, 'buffered', { configurable: true, get() {
        if (++reads === 2) {
          acted = true;
          if (mode === 'intent-cycle') {
            f.adapter.setPlaybackIntent(false);
            f.adapter.setPlaybackIntent(true);
          }
          if (mode === 'settled-user-seek') {
            f.video.seeking = true;
            f.video.fire('seeking');
            f.video.seeking = false;
            f.video.fire('seeked');
          }
          if (mode === 'duration') f.video.duration = NEXT;
          if (mode === 'readiness') f.video.readyState = 4;
          if (mode === 'source-closed') native.readyState = 'closed';
        }
        return ranges;
      } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(acted).toBe(true);
      expect(f.video.seekCount).toBe(mode === 'none' ? 1 : 0);
      expect(f.jumps).toHaveLength(mode === 'none' ? 1 : 0);
      if (mode === 'intent-cycle' || mode === 'settled-user-seek') {
        // A canceled wait cannot be borrowed after intent/seek flags settle.
        await vi.advanceTimersByTimeAsync(2000);
        expect(f.jumps).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.jumps).toHaveLength(1);
        expect(f.jumps[0].waitedMs).toBeGreaterThanOrEqual(2000);
      }
    } finally { await f.close(); }
  },
);

for (const attachment of ['object-url', 'src-object'] as const) {
  const modes = attachment === 'object-url'
    ? ['none', 'unsupported-quality', 'foreign-srcObject', 'foreign-url', 'foreign-currentSrc'] as const
    : ['none', 'unsupported-quality', 'foreign-srcObject'] as const;
  it.each(modes)('final native read validates '+attachment+' attachment: %s', async mode => {
    const f = await fixture(CT, 250, attachment);
    try {
      if (mode === 'unsupported-quality') {
        Object.defineProperty(f.video, 'getVideoPlaybackQuality', { value: undefined, configurable: true });
        expect(f.adapter.getVideoPlaybackQuality()).toBeNull();
      }
      await vi.advanceTimersByTimeAsync(2000);
      const sb = native.audioBuffer, ranges = sb.buffered;
      let reads = 0, acted = false;
      Object.defineProperty(sb, 'buffered', { configurable: true, get() {
        if (++reads === 2) {
          acted = true;
          if (mode === 'foreign-srcObject') f.video.srcObject = {};
          if (mode === 'foreign-url') f.video.src = 'blob:foreign';
          if (mode === 'foreign-currentSrc') f.video.currentSrc = 'blob:foreign';
        }
        return ranges;
      } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(acted).toBe(true);
      const eligible = mode === 'none' || mode === 'unsupported-quality';
      expect(f.video.seekCount).toBe(eligible ? 1 : 0);
      expect(f.jumps).toHaveLength(eligible ? 1 : 0);
    } finally { await f.close(); }
  });
}


for (const attachment of ['object-url', 'src-object'] as const) {
  it.each(['none', 'intent-cycle'] as const)(
    'attachment getter reentry preserves '+attachment+' candidate ownership: %s', async mode => {
      const f = await fixture(CT, 250, attachment);
      try {
        await vi.advanceTimersByTimeAsync(2000);
        const sb = native.audioBuffer, ranges = sb.buffered;
        let reads = 0, acted = false;
        Object.defineProperty(sb, 'buffered', { configurable: true, get() {
          if (++reads === 2) {
            const key = attachment === 'src-object' ? 'srcObject' : 'src';
            let value: unknown = f.video[key];
            Object.defineProperty(f.video, key, { configurable: true, get() {
              if (!acted) {
                acted = true;
                if (mode === 'intent-cycle') {
                  f.adapter.setPlaybackIntent(false);
                  f.adapter.setPlaybackIntent(true);
                }
              }
              return value;
            }, set(next: unknown) { value = next; } });
          }
          return ranges;
        } });
        await vi.advanceTimersByTimeAsync(1000);
        expect(acted).toBe(true);
        expect(f.jumps).toHaveLength(mode === 'none' ? 1 : 0);
        if (mode === 'intent-cycle') {
          await vi.advanceTimersByTimeAsync(2000);
          expect(f.jumps).toHaveLength(0);
          await vi.advanceTimersByTimeAsync(1000);
          expect(f.jumps).toHaveLength(1);
        }
      } finally { await f.close(); }
    },
  );
}
