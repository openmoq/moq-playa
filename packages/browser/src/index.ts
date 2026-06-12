/**
 * @moqt/browser — Browser adapter implementations.
 *
 * Concrete implementations of @moqt/player's swappable interfaces
 * (VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike,
 * MediaSourceLike) backed by browser APIs.
 *
 * Cherry-pickable: import only the adapters you need for your pipeline.
 *
 * @module
 */

export { WebCodecsVideoDecoder } from './webcodecs-video-decoder.js';
export type { WebCodecsVideoDecoderConfig } from './webcodecs-video-decoder.js';
export { WebCodecsAudioDecoder } from './webcodecs-audio-decoder.js';
export { AudioAlignedClock } from './audio-aligned-clock.js';
export { CanvasRenderer } from './canvas-renderer.js';
export { DeferredAudioOutput } from './deferred-audio-output.js';
export { WebAudioOutput } from './webaudio-output.js';
export { MseMediaSource } from './mse-adapter.js';
export type { MseMediaSourceOptions, PlayheadWedgeInfo } from './mse-adapter.js';
export { CmafAssembler } from './cmaf-assembler.js';
export type { CmafAssemblerOptions } from './cmaf-assembler.js';
export { createWebTransport } from './webtransport-factory.js';
export type { WebTransportFactoryOptions } from './webtransport-factory.js';
export { detectStrategy } from './detect.js';
export type { DecoderStrategy } from './detect.js';
