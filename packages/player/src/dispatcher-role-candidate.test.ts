import { expect,it,vi } from 'vitest';
import { CommandDispatcher } from './command-dispatcher.js';
import type { VideoDecoderLike, AudioDecoderLike,VideoRendererLike,AudioOutputLike } from './interfaces.js';
it('retiring video fences late video while preserving the exact already issued audio context and destroys video once',()=>{
 const video:VideoDecoderLike={configure:vi.fn(),decode:vi.fn(),reset:vi.fn(),destroy:vi.fn(),flush:async()=>{},queueDepth:0,onFrame:null,onError:null};
 const audio:AudioDecoderLike={supportsOutputTiming:true,configure:vi.fn(),decode:vi.fn(),reset:vi.fn(),destroy:vi.fn(),flush:async()=>{},queueDepth:0,onData:null,onError:null};
 const renderer:VideoRendererLike={onFirstFrame:null,onFrameRendered:null,onStall:null,enqueue:vi.fn(),flush:vi.fn(),destroy:vi.fn()};
 const output:AudioOutputLike={supportsOutputTiming:true,schedule:vi.fn(),flush:vi.fn(),destroy:vi.fn(),currentPlayoutTimeUs:0};
 const dispatcher=new CommandDispatcher({videoDecoder:video,audioDecoder:audio,renderer,audioOutput:output});
 const context={epoch:{},sourceTimestampUs:100n,presentFromSourceUs:0n,recomputeRenderTimeUs:()=>1000};
 dispatcher.dispatch({type:'decode_audio',chunk:{type:'key',timestamp:100,data:Uint8Array.of(1)},renderTimeUs:1000,renderTiming:context});
 const late=video.onFrame!,audioCallback=audio.onData!;
 expect(dispatcher.retireVideo,'role-specific retirement is required').toBeTypeOf('function');dispatcher.retireVideo();
 const frame={timestamp:100,close:vi.fn()};late(frame,1000);expect(frame.close).toHaveBeenCalledOnce();expect(renderer.enqueue).not.toHaveBeenCalled();
 const data={close:vi.fn()},witness={context,sourceOffsetUs:0};audioCallback(data,1000,undefined,witness);
 expect(output.schedule).toHaveBeenCalledExactlyOnceWith(data,1000,undefined,witness);expect(data.close).not.toHaveBeenCalled();
 expect(audio.destroy).not.toHaveBeenCalled();expect(output.flush).not.toHaveBeenCalled();expect(audio.reset).not.toHaveBeenCalled();
 dispatcher.destroy();expect(video.destroy).toHaveBeenCalledOnce();expect(renderer.destroy).toHaveBeenCalledOnce();expect(audio.destroy).toHaveBeenCalledOnce();expect(output.destroy).toHaveBeenCalledOnce();
});
