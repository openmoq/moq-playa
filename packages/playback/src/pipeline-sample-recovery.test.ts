import { expect, it } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { DecoderCommand, PlaybackSample } from './types.js';
import { varint } from '@openmoq/transport';

function fixture() {
  let now = 1_000_000;
  const clock = {now:()=>now}, commands: DecoderCommand[] = [];
  const sync = new SyncController({clock,driftThresholdUs:500_000});
  const pipeline = new PlaybackPipeline({mediaType:'video',clock,sync,videoOnly:true,
    config:{gapTimeoutUs:200_000,driftThresholdUs:500_000,maxBufferDepth:100,maxReleasePerTick:0,maxBacklogGroups:0},
    onCommand:command=>commands.push(command),onEvent:()=>{}});
  pipeline.setCodec('avc1');pipeline.configure(Uint8Array.of(1));
  function push(object:number,key=true,permission=false,group=7,token:object={object},payloadKey=key) {
    const sample:PlaybackSample={sampleIndex:0,headers:{captureTimestamp:1_000_000n+BigInt(object)*3000n,timestampIsWallClock:false,
      videoFrameMarking:{independent:key,startOfFrame:true,endOfFrame:true,discardable:false,baseLayerSync:false,temporalId:0}},
      chunk:{type:key?'key':'delta',timestamp:1_000_000+object*3000,duration:3000,data:Uint8Array.of(0,0,0,2,payloadKey?0x65:0x41,0x80)}};
    pipeline.pushSampleObject({kind:'data',trackAlias:varint(1),groupId:varint(group),objectId:varint(object),subgroupId:varint(0),
      publisherPriority:128,payload:Uint8Array.of(object)},[sample],token,{allowIndependentGap:permission});
  }
  return {pipeline,push,commands,advance:()=>{now+=300_000;},decoded:()=>commands.filter(c=>c.type==='decode_video')};
}

it('an opt-in independent sample resumes at its real Object ID and rejects later old copies',()=>{
  const f=fixture(), first={}, recovered={}, following={}, late={}, discards:{input:object;reason:string}[]=[];
  f.pipeline.inputObserver=(input,reason)=>{discards.push({input,reason});};
  f.push(0,true,false,7,first);f.pipeline.tick();
  f.push(2,true,true,7,recovered);f.push(3,false,false,7,following);f.pipeline.tick();
  expect(f.decoded().map(c=>c.inputToken)).toEqual([first,recovered,following]);
  f.push(1,true,true,7,late);f.pipeline.tick();
  expect(f.decoded()).toHaveLength(3);expect(discards).toContainEqual({input:late,reason:'treated as a replay'});
  expect(f.pipeline.pendingSampleCount).toBe(0);expect(f.pipeline.pendingSampleByteCount).toBe(0);f.pipeline.reset();
});

it('ordinary typed independent input without host permission keeps the existing missing-Object wait',()=>{
  const f=fixture();f.push(0);f.pipeline.tick();f.push(2,true,false);f.pipeline.tick();
  expect(f.decoded()).toHaveLength(1);f.advance();f.pipeline.tick();expect(f.decoded()).toHaveLength(1);f.pipeline.reset();
});

it('dependent data cannot earn recovery permission',()=>{
  const f=fixture();f.push(0);f.pipeline.tick();f.push(2,false,true,7,{},false);f.pipeline.tick();
  expect(f.decoded()).toHaveLength(1);f.advance();f.pipeline.tick();expect(f.decoded()).toHaveLength(1);f.pipeline.reset();
});

it('recovery drops only the blocked prefix and preserves earlier queued media plus later Groups',()=>{
  const f=fixture(), first={}, blocked={}, recovered={}, following={}, other={}, discards:object[]=[];
  f.pipeline.inputObserver=input=>{discards.push(input);};
  f.push(0,true,false,7,first);f.push(2,false,false,7,blocked);f.push(3,true,true,7,recovered);
  f.push(4,false,false,7,following);f.push(0,true,false,8,other);f.pipeline.endGroup(7n);f.pipeline.tick();
  expect(f.decoded().map(c=>c.inputToken)).toEqual([first,recovered,following,other]);
  expect(discards).toEqual([blocked]);expect(f.pipeline.pendingSampleCount).toBe(0);expect(f.pipeline.pendingSampleByteCount).toBe(0);
  expect(f.commands.filter(c=>c.type==='reset')).toHaveLength(0);f.pipeline.reset();
});

it('discard observer reset cannot let the old recovery continuation alter its successor',()=>{
  const f=fixture(), blocked={}, old={}, next={};
  f.push(0);f.pipeline.tick();
  f.pipeline.inputObserver=input=>{if(input===blocked){f.pipeline.resetForTrackSwitch(9n);f.push(0,true,false,9,next);}};
  f.push(2,false,false,7,blocked);f.push(3,true,true,7,old);f.pipeline.tick();
  expect(f.decoded().some(c=>c.inputToken===old)).toBe(false);
  expect(f.pipeline.pendingSampleCount).toBe(1);f.pipeline.tick();
  expect(f.decoded().at(-1)?.inputToken).toBe(next);expect(f.pipeline.pendingSampleCount).toBe(0);f.pipeline.reset();
});
