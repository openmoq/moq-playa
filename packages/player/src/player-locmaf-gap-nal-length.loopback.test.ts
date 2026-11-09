import { expect, it, vi } from 'vitest';
import type { PlaybackPipeline } from '@openmoq/playback';
import { LocmafEncoder, LocmafGroupState, codecDescriptionFromInit, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { fixture, sequence, headers } from '../test-support/locmaf-gap-length-fixture.js';

function headerWithLength(size: number): Uint8Array {
  const init = headers.video.slice();
  for(let i=0;i<init.length-8;i++) if(init[i]===0x61&&init[i+1]===0x76&&init[i+2]===0x63&&init[i+3]===0x43){
    init[i+8]=(init[i+8]!&0xfc)|(size-1);break;
  }
  expect(codecDescriptionFromInit(init)![4]!&3).toBe(size-1);return init;
}
function nal(size:number,key:boolean):Uint8Array {
  const bytes=new Uint8Array(size+8);bytes[size-1]=8;bytes[size]=key?0x65:0x41;bytes[size+1]=0x80;return bytes;
}
it.each([{size:1,contradiction:false},{size:2,contradiction:false},{size:4,contradiction:false},{size:4,contradiction:true}])(
  'parsed AVC recovery uses its declared $size-byte NAL lengths, contradiction=$contradiction',async({size,contradiction})=>{
  const init=headerWithLength(size),h=await fixture(true,false,false,init);
  const pipeline=(h.player as unknown as {videoPipeline:PlaybackPipeline}).videoPipeline;
  const admitted=vi.spyOn(pipeline,'pushSampleObject');
  try{
    h.player.play();const [audio]=sequence('audio');await h.send('audio',0n,audio!.payload,7n);
    const state=new LocmafGroupState(),encoder=new LocmafEncoder(),context=parseLocmafTrackContext(init);
    const packets=[0n,2n,3n].map((id,index)=>{
      const declaredKey=index<2,bytes=nal(size,declaredKey&&!(contradiction&&index===1));
      const encoded=encoder.encode(buildChunk({trackId:11,bmdt:90000n+id*3000n,
        samples:[{duration:3000,size:bytes.length,flags:declaredKey?SYNC_FLAGS:NON_SYNC_FLAGS}],mdat:bytes}),state,context,index===1,id);
      return {id,bytes,payload:serializeLocmafObject(encoded)};
    });
    await h.send('video',0n,packets[0]!.payload,7n);
    for(let i=0;i<10&&h.decoded.length===0;i++)h.advance(10_000);
    expect(h.decoded).toHaveLength(1);
    await h.send('video',2n,packets[1]!.payload,7n);await h.send('video',3n,packets[2]!.payload,7n);
    for(let i=0;i<80;i++)h.advance(25_000);
    if(contradiction){
      expect(admitted.mock.calls.map(([object])=>object.objectId)).toEqual([0n,3n]);
      expect(h.decoded,'supported 4-byte contradiction cannot authorize codec recovery').toHaveLength(1);
    }else{
      expect(admitted.mock.calls.map(([object])=>object.objectId)).toEqual([0n,2n,3n]);
      expect(admitted.mock.calls.map(([,samples])=>samples[0]!.chunk.data)).toEqual(packets.map(packet=>packet.bytes));
      expect(h.decoded.map(chunk=>chunk.type)).toEqual(['key','key','delta']);
    }
    expect(h.errors).toEqual([]);
  }finally{admitted.mockRestore();await h.destroy();}
});
