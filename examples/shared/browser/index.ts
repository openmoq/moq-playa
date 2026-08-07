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
// Re-export the package factory so examples use the same protocol negotiation
// and fallback behavior as applications.
export { createWebTransport } from '@moqt/browser';
export type { WebTransportFactoryOptions } from '@moqt/browser';

// ─── Publisher adapters ─────────────────────────────────────────────

export { WebCodecsVideoEncoder } from './webcodecs-video-encoder.js';
export { WebCodecsAudioEncoder } from './webcodecs-audio-encoder.js';
export { MediaCapture } from './media-capture.js';
