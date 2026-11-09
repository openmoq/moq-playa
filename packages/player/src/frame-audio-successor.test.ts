import {expect,it,vi} from 'vitest';
import {FrameAudioOutput} from './frame-audio-output.js';
import type {AudioOutputLike} from './interfaces.js';
it.each([false,true])('old drain preserves PCM admitted after explicit flush; throws=%s', throws => {
  const pcm=()=>({numberOfFrames:480,numberOfChannels:2,sampleRate:48000,close:vi.fn()});
  const first=pcm(), next=pcm();
  const timing={context:{epoch:{},sourceTimestampUs:0n,presentFromSourceUs:0n,recomputeRenderTimeUs:()=>0},sourceOffsetUs:0};
  let output:FrameAudioOutput;
  const failure=new Error('old schedule failed');
  const target:AudioOutputLike={supportsOutputTiming:true,currentPlayoutTimeUs:0,flush:vi.fn(),destroy:vi.fn(),schedule(data){
    if(data!==first)return;
    first.close();
    output.flush();
    output.schedule(next,0,{},timing);
    if(throws)throw failure;
  }};
  output=new FrameAudioOutput({target,maxChunks:3,maxBytes:20000});
  output.schedule(first,0,{},timing);
  if(throws)expect(()=>output.activate()).toThrow(failure);else output.activate();
  expect(next.close,'old drain failure must not close PCM admitted after reset').not.toHaveBeenCalled();
  expect(output.retainedChunkCount).toBe(1);
  output.destroy();
});
