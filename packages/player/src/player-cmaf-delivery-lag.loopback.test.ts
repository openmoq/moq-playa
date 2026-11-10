/** SDK wire + real CMAF assembly with explicit buffer witnesses, not native rendering. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CmafAssembler } from '../../browser/src/cmaf-assembler.js';
import { videoInit, buildInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { parseLocmafTrackContext, readCmafObjectSamples } from '@openmoq/locmaf';
import { DeliveryLagDetector } from '@openmoq/playback';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { audioPeer, identity } from '../test-support/audio-selection.js';
import { MoqtPlayer } from './player.js';
import type { MediaSourceLike } from './interfaces.js';
import type { PlayerError } from './errors.js';

const namespace = ['live', 'cmaf-trend'];
const refs = { catalog: {namespace, name:'catalog'}, high: {namespace, name:'video-high'}, low: {namespace, name:'video-low'} };
const scale = 90_000n, origin = 9_000_000n, step = 40_000;

async function fixture(options: { bufferUs?: number; manual?: boolean; finite?: boolean; unknownTiming?: boolean; draft?:16|18|22; originTicks?:bigint } = {}) {
  const wire = audioPeer(options.draft ?? 18), errors: PlayerError[] = [], appends: Array<{name:string|undefined; dts:bigint}> = [];
  const published = new Map<string,{group:bigint;object:bigint}>();
  wire.server.setLargestLocationProvider(id => {
    const request=wire.requests.find(row=>row.id===id); return request ? published.get(request.name) ?? null : null;
  });
  const sourceOrigin=options.originTicks ?? origin;
  const init = videoInit(), context = parseLocmafTrackContext(init);
  let now=1_000_000, next=0, fed=false, firstFrame=false, buffer:number|null=options.bufferUs ?? 300_000;
  let assembler:CmafAssembler, appendEffect:(()=>void)|undefined;
  const source: MediaSourceLike = {
    attached:true, initialize(){},
    appendChunk(_kind, bytes, name) {
      const chunks=readCmafObjectSamples(bytes,context);
      if(!chunks?.length)throw new Error('Expected complete assembled chunks');
      for(const chunk of chunks)appends.push({name,dts:chunk.effective.baseMediaDecodeTime});
      fed=true;appendEffect?.();
      if(!firstFrame){firstFrame=true;source.onFirstFrame?.();}
    },
    getBufferAheadUs(){return fed ? buffer : null;},
    reset(){},endOfStream(){},destroy(){},mediaElement:null,
    onFirstFrame:null,onError:null,onStall:null,
  };
  const catalog = new TextEncoder().encode(JSON.stringify({version:'1',
    initDataList:[{id:'header',type:'inline',data:Buffer.from(init).toString('base64')}],
    tracks:[{name:refs.high.name,bitrate:600_000},{name:refs.low.name,bitrate:150_000}].map(track=>({
      ...track,namespace:namespace.join('/'),role:'video',packaging:'cmaf',codec:'avc1.640028',
      width:640,height:360,renderGroup:1,altGroup:7,isLive:!options.finite,initRef:'header',
    }))}));
  const player = new MoqtPlayer({url:'https://cmaf-trend.invalid/moq',namespace,draftVersion:options.draft ?? 18,
    clock:{now:()=>now},catalogBootstrap:'subscribe',reconnectAttempts:0,
    connectionTimeoutMs:5000,cmafBootstrapTimeoutMs:0,livenessTimeoutMs:0,
    startLevel:0,qualitySwitchCooldownMs:100,disableAudio:true,autoQuality:!options.manual,
    selection:{renderGroup:1,videoAltGroup:7},
    createConnection:()=>wire.client,createTransport:async()=>wire.start(),createMediaSource:()=>source,
    createCmafAssembler: callbacks => {
      assembler=new CmafAssembler(callbacks);
      if(options.unknownTiming){const push=assembler.push.bind(assembler);assembler.push=(...args)=>{push(...args);};}
      return assembler;
    },
  });
  player.on('error', event=>errors.push(event.error));
  const chunk = (index:number, low=false, ctoUs=0n) => buildChunk({trackId:1,
    bmdt:sourceOrigin+BigInt(index)*scale*BigInt(step)/1_000_000n,
    samples:[{duration:Number(scale*BigInt(step)/1_000_000n),size:low?750:3000,
      flags:index%25===0?SYNC_FLAGS:NON_SYNC_FLAGS,cto:Number(ctoUs*scale/1_000_000n)}],
    mdat:new Uint8Array(low?750:3000).fill(low?22:11)});
  try {
    await player.load();await wire.accept(refs.catalog,100n);await wire.send(refs.catalog,catalog,1n);
    published.set('catalog',{group:1n,object:0n});await wire.accept(refs.high,200n);
    expect(player.selection.video).toEqual(identity(refs.high));
    expect(player.selection.autoQuality).toBe(!options.manual);player.play();
  } catch(error){await player.destroy();await wire.close();throw error;}
  async function send(lagUs=20_000,ctoUs=0n,tick=true){
    now=Math.max(now,1_000_000+next*step+lagUs);
    const group=70n+BigInt(Math.floor(next/25)),object=BigInt(next%25);
    await wire.send(refs.high,chunk(next,false,ctoUs),group,object);published.set(refs.high.name,{group,object});next++;
    if(tick)player.tick();await flush(128);
  }
  async function feed(count:number,lag:(index:number)=>number=()=>20_000,tick=true){for(let i=0;i<count;i++)await send(lag(next),0n,tick);}
  return {player,wire,errors,appends,source,feed,send,
    lowerRequests:()=>wire.requests.filter(row=>row.name===refs.low.name),
    setBuffer(value:number|null){buffer=value;},
    get assembler(){return assembler;},
    onAppend(effect:()=>void){appendEffect=effect;},
    async tick(){player.tick();await flush(128);},
    async sendWholeGroup(){
      expect(next%25).toBe(0);
      const group=70n+BigInt(next/25);
      now=1_000_000+next*step+20_000;
      const bytes=buildChunk({trackId:1,bmdt:sourceOrigin+BigInt(next)*3600n,
        samples:Array.from({length:25},(_,i)=>({duration:3600,size:3000,flags:i===0?SYNC_FLAGS:NON_SYNC_FLAGS})),
        mdat:new Uint8Array(75_000).fill(11)});
      await wire.send(refs.high,bytes,group,0n);published.set(refs.high.name,{group,object:0n});next+=25;
      await flush(128);
    },
    async elapse(us:number){now+=us;player.tick();await flush(128);},
    async commitLower(){
      expect(player.selection.video).toEqual(identity(refs.high));
      const old=wire.request(refs.high).id;
      expect(wire.stopped).not.toContain(old);
      while(next%25!==0)await send();
      await wire.accept(refs.low,201n);
      expect(player.selection.video).toEqual(identity(refs.high));
      now=Math.max(now+step,1_000_000+next*step+20_000);
      await wire.send(refs.low,chunk(next,true),70n+BigInt(next/25),0n);await flush(256);
      expect(player.selection.video).toEqual(identity(refs.low));
      expect(appends.at(-1)?.name).toBe(refs.low.name);expect(wire.stopped).toContain(old);
    },
    async destroy(){await player.destroy();await wire.close();},
  };
}

beforeEach(()=>{vi.useFakeTimers({toFake:['setInterval','clearInterval']});});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

describe('source-paced CMAF adaptation',()=>{
  it('holds a thin positive live buffer with steady delivered media',async()=>{
    const f=await fixture();try{
      await f.feed(100);expect(f.appends).toHaveLength(100);expect(f.errors).toEqual([]);
      expect(f.lowerRequests(),'a healthy thin live buffer must not ratchet down').toEqual([]);
      expect(f.player.selection.video).toEqual(identity(refs.high));
    }finally{await f.destroy();}
  });
  it('requests the lower rung on rising media-time delivery delay even with a healthy buffer',async()=>{
    const f=await fixture({bufferUs:2_000_000});try{
      await f.feed(40);expect(f.lowerRequests()).toEqual([]);
      await f.feed(50,i=>20_000+(i-40)*20_000);
      expect(f.lowerRequests().map(({name,namespace})=>({name,namespace}))).toEqual([refs.low]);
      await f.commitLower();expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('keeps the existing genuinely empty-buffer emergency and real target commit',async()=>{
    const f=await fixture({bufferUs:0});try{
      await f.feed(100);expect(f.appends).toHaveLength(100);expect(f.lowerRequests()).toHaveLength(1);
      await f.commitLower();expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('holds a healthy two-second buffer without requiring the delivery signal',async()=>{
    const f=await fixture({bufferUs:2_000_000});try{
      await f.feed(100);expect(f.appends).toHaveLength(100);expect(f.lowerRequests()).toEqual([]);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it.each([{manual:true,finite:false},{manual:false,finite:true}])('does not collect delivery measurements for manual=$manual finite=$finite',async opts=>{
    const record=vi.spyOn(DeliveryLagDetector.prototype,'record');
    const f=await fixture({...opts,bufferUs:2_000_000});try{
      await f.feed(100);expect(f.appends).toHaveLength(100);expect(record).not.toHaveBeenCalled();expect(f.lowerRequests()).toEqual([]);
      expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('holds a positive live buffer when custom timing is unavailable, without inventing measurements',async()=>{
    const record=vi.spyOn(DeliveryLagDetector.prototype,'record');
    const f=await fixture({unknownTiming:true});try{
      await f.feed(100);expect(f.appends).toHaveLength(100);expect(f.lowerRequests()).toEqual([]);
      expect(record).not.toHaveBeenCalled();expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('holds contiguous live coverage between valid one-second chunks after the trend sample expires',async()=>{
    const f=await fixture({bufferUs:1_000_000});try{
      await f.sendWholeGroup();expect(f.appends).toHaveLength(1);
      f.setBuffer(300_000);await f.elapse(700_000);
      expect(f.lowerRequests()).toEqual([]);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('preserves the finite-presentation thin-buffer bandwidth policy',async()=>{
    const f=await fixture({finite:true});try{
      await f.feed(100);expect(f.appends).toHaveLength(100);expect(f.lowerRequests()).toHaveLength(1);
      await f.commitLower();expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
});


describe('CMAF delivery evidence boundaries',()=>{
  it.each([16,22] as const)('uses the same selected media-time signal on draft %s',async draft=>{
    const f=await fixture({draft,bufferUs:2_000_000});try{
      await f.feed(40);await f.feed(50,i=>20_000+(i-40)*20_000);
      expect(f.lowerRequests().map(({name,namespace})=>({name,namespace}))).toEqual([refs.low]);
      await f.commitLower();expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('rebases a large v1 tfdt before converting its delta to Number',async()=>{
    const record=vi.spyOn(DeliveryLagDetector.prototype,'record');
    const f=await fixture({originTicks:2n**60n,bufferUs:2_000_000});try{
      await f.feed(40);expect(record.mock.calls.slice(0,3)).toEqual([[0,0],[40_000,40_000],[80_000,80_000]]);
      await f.feed(50,i=>20_000+(i-40)*20_000);expect(f.lowerRequests()).toHaveLength(1);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('does not mistake changing composition offsets for rising delivery delay',async()=>{
    const record=vi.spyOn(DeliveryLagDetector.prototype,'record');
    const f=await fixture();try{
      for(let i=0;i<100;i++)await f.send(20_000,BigInt(2_000_000-i*20_000));
      expect(record.mock.calls.slice(0,3)).toEqual([[0,0],[40_000,40_000],[80_000,80_000]]);
      expect(f.appends).toHaveLength(100);expect(f.lowerRequests()).toEqual([]);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it.each([null,NaN,Infinity,-1])('holds without a valid buffer witness: %s',async value=>{
    const f=await fixture();try{
      f.setBuffer(value);await f.feed(100);expect(f.appends).toHaveLength(100);
      expect(f.lowerRequests()).toEqual([]);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it.each([false,true])('uses a continuous configuration only (changed init=%s)',async changed=>{
    const f=await fixture({bufferUs:2_000_000});try{
      await f.feed(40);await f.feed(50,i=>20_000+(i-40)*20_000,false);
      const token=f.assembler.capturePresentationPlacement('video')!.token;
      f.assembler.setInitSegment('video',changed?buildInit({trackId:1,timescale:90_000,handler:'vide',trex:{duration:3600}}):videoInit());
      if(changed)expect(f.assembler.capturePresentationPlacement('video')).toBeNull();
      else expect(f.assembler.capturePresentationPlacement('video')!.token).toBe(token);
      await f.tick();expect(f.lowerRequests()).toHaveLength(changed?0:1);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('cannot publish a measurement after append callbacks retire automatic authority',async()=>{
    const record=vi.spyOn(DeliveryLagDetector.prototype,'record');
    const f=await fixture();try{
      await f.feed(40);record.mockClear();f.onAppend(()=>f.player.setAutoQuality(false));
      await f.send();expect(f.appends).toHaveLength(41);expect(record).not.toHaveBeenCalled();
      expect(f.lowerRequests()).toEqual([]);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('rechecks authority after the custom placement getter used at measurement admission',async()=>{
    const record=vi.spyOn(DeliveryLagDetector.prototype,'record');
    const f=await fixture();try{
      await f.feed(40);record.mockClear();
      const capture=f.assembler.capturePresentationPlacement.bind(f.assembler);let calls=0;
      vi.spyOn(f.assembler,'capturePresentationPlacement').mockImplementation(type=>{
        const placement=capture(type);
        // Actual assembler receipt, engine receipt check, then final admission.
        if(++calls===3)f.player.setAutoQuality(false);
        return placement;
      });
      await f.send();expect(calls).toBeGreaterThanOrEqual(3);expect(f.appends).toHaveLength(41);
      expect(f.player.selection.autoQuality).toBe(false);expect(record).not.toHaveBeenCalled();
      expect(f.lowerRequests()).toEqual([]);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
  it('drops queued evidence when automatic mode is disabled and enabled again',async()=>{
    const f=await fixture({bufferUs:2_000_000});try{
      await f.feed(40);await f.feed(50,i=>20_000+(i-40)*20_000,false);
      f.player.setAutoQuality(false);f.player.setAutoQuality(true);await f.tick();
      expect(f.lowerRequests()).toEqual([]);expect(f.errors).toEqual([]);
    }finally{await f.destroy();}
  });
});


describe('CMAF placement callback ownership', () => {
  it.each([2, 3])('does not record after placement capture %i pauses the owner', async pauseAt => {
    const f = await fixture();
    try {
      const record = vi.spyOn(DeliveryLagDetector.prototype, 'record');
      const original = CmafAssembler.prototype.capturePresentationPlacement;
      let captures = 0;
      vi.spyOn(CmafAssembler.prototype, 'capturePresentationPlacement').mockImplementation(function (this: CmafAssembler, mediaType) {
        const placement = original.call(this, mediaType);
        if (++captures === pauseAt) f.player.pause();
        return placement;
      });
      await f.send();
      expect(captures).toBeGreaterThanOrEqual(pauseAt);
      expect(f.player.state).toBe('paused');
      expect(f.appends).toHaveLength(1);
      expect(f.errors).toEqual([]);
      expect(record).not.toHaveBeenCalled();
    } finally {
      await f.destroy();
    }
  });
});
