/**
 * Example-local browser helpers.
 *
 * Official playback adapters live in @moqt/browser. This file
 * re-exports thin example-specific wrappers around those adapters
 * plus publisher-only helpers (encoders, capture) that are not
 * part of the official playback surface.
 *
 * @module
 */

export { WebCodecsVideoDecoder } from './webcodecs-video-decoder.js';
export { WebCodecsAudioDecoder } from './webcodecs-audio-decoder.js';
export { CanvasRenderer } from './canvas-renderer.js';
export { WebAudioOutput } from './webaudio-output.js';
export { MseMediaSource } from './mse-adapter.js';
export { CmafAssembler } from '@moqt/browser';
export { createWebTransport } from './webtransport-factory.js';
export type { WebTransportFactoryOptions } from './webtransport-factory.js';

// ─── Publisher adapters ─────────────────────────────────────────────

export { WebCodecsVideoEncoder } from './webcodecs-video-encoder.js';
export { WebCodecsAudioEncoder } from './webcodecs-audio-encoder.js';
export { MediaCapture } from './media-capture.js';
