import type { VideoDecoderLike } from '../../packages/player/src/interfaces.js';
export function observeProgramDecodedSource(): {
  wrap(decoder: VideoDecoderLike): VideoDecoderLike;
  snapshot(): { inputs: number; outputs: number; matched: number; failures: string[] };
};
