import {it,expect,vi} from 'vitest';
import {locSeekFixture} from '../test-support/loc-seek.js';
import {flush} from '../../webtransport/src/testkit/loopback.js';
import {encodeLocHeaders,locWireProfileForDraft} from '@openmoq/loc';
it.each([false,true].flatMap(zero => [false,true].map(aging => ({zero,aging}))))('refuses expired continuation; zero wallclock=$zero, ages while paging=$aging',async ({zero,aging})=>{
 const now=1800000000000;const clock=vi.spyOn(Date,'now').mockReturnValue(now);
 const catalogDocument={version:'draft-02',tracks:[{name:'video',packaging:'loc',role:'video',isLive:true,codec:'avc1.640028',bitrate:100,framerate:30,accessibleWindowTime:300000},
 {name:'timeline',packaging:'mediatimeline',isLive:true,depends:['video']}]};
 const timeline = aging ? [[200000,[3,0],zero?0:now-200000],[300000,[4,0],zero?0:now-100000],[400000,[5,0],zero?0:now]] as const
 : [[0,[4,0],zero?0:now-400000],[200000,[3,0],zero?0:now-200000],[400000,[5,0],zero?0:now]] as const;
 try{const f=await locSeekFixture(18,false,true,{catalogDocument,timeline,producingOutput:false});try{
 await f.player.seek(200000);await flush(256);expect(f.fetchIds).toHaveLength(1);
 if (aging) { if (zero) await f.updateTimeline([[800000,[6,0],0]]); else clock.mockReturnValue(now+300000); }
 await f.server.acceptFetch(f.fetchIds[0]!,{endOfTrack:0,endLocation:{group:3n,object:0n}});
 const stream=await f.server.openFetchStream(f.fetchIds[0]!);
 const extensions=encodeLocHeaders({timestamp:200000n,timescale:1000n,videoFrameMarking:{independent:true,startOfFrame:true,endOfFrame:true,discardable:false,baseLayerSync:false,temporalId:0}},{wireProfile:locWireProfileForDraft(18),locVersion:4});
 await f.server.sendFetchObject(stream,{groupId:3n,subgroupId:0n,objectId:0n,publisherPriority:128,extensions,payload:Uint8Array.of(0,0,0,2,0x65,0x88)});
 await f.server.closeFetchStream(stream);await flush(512);await new Promise(resolve=>setTimeout(resolve,0));await flush(512);
 expect(f.fetches.some(x=>x.group===4n)).toBe(false);expect(f.errors.some(error=>error.includes('accessibleWindowTime'))).toBe(true);
 }finally{await f.destroy();}}finally{clock.mockRestore();}
});
