import {it,expect} from 'vitest';
import {MoqtConnection} from '@openmoq/webtransport';
import {MoqtPlayer} from './player.js';
import {createLoopback,flush} from '../../webtransport/src/testkit/loopback.js';
it.each(['draft-01', 'draft-02', '1'])('accepts a large uncompressed %s catalog before FETCH_OK arrives',async version=>{
 const {a,b}=createLoopback();const client=new MoqtConnection(18),server=new MoqtConnection(18,{role:'server'});
 const requests:bigint[]=[],fetches:bigint[]=[],errors:string[]=[];let serving:Promise<void>|undefined,ready=false;
 server.onSubscribe=id=>{requests.push(id)};server.onFetch=id=>{fetches.push(id)};
 server.setLargestLocationProvider(()=>({group:1n,object:0n}));
 const player=new MoqtPlayer({url:'https://example.invalid',namespace:['live'],draftVersion:18,catalogBootstrap:'joining-fetch',disableAudio:true,autoQuality:false,
 createConnection:()=>client,createTransport:async()=>{serving=server.connect(b);return a;}});
 player.on('catalog_received',()=>{ready=true});player.on('error',e=>errors.push(e.error.message));
 try{await player.load();await flush(256);await server.acceptSubscribe(requests[0]!,10n);await flush(256);
 const held=a.bidiOut[1]!.in;held.faults.hold=true;
 await server.acceptFetch(fetches[0]!,{endOfTrack:0,endLocation:{group:1n,object:1n}});
 const stream=await server.openFetchStream(fetches[0]!);
 const payload=new TextEncoder().encode(JSON.stringify({version,tracks:[{name:'v',packaging:'loc',role:'video',isLive:true,codec:'avc1',bitrate:100,framerate:30,label:'x'.repeat(4*1024*1024)}]}));
 await server.sendFetchObject(stream,{groupId:1n,subgroupId:0n,objectId:0n,publisherPriority:128,payload});await server.closeFetchStream(stream);await flush(256);
 held.releaseHeld();await flush(512);expect(errors).toEqual([]);expect(ready).toBe(true);
 }finally{await player.destroy();await server.close();await serving;}
});
