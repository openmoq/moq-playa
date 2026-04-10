/**
 * Decode strategy detection — WebCodecs vs MSE.
 *
 * WebCodecs preferred (lower latency, GPU memory control, LOC direct path).
 * MSE fallback (broader browser support, required for CMAF packaging).
 *
 * @module
 */

/** Decode strategy. */
export type DecoderStrategy = 'webcodecs' | 'mse';

/**
 * Detect the best available decode strategy for the current browser.
 *
 * Checks for WebCodecs (VideoDecoder + OffscreenCanvas) first,
 * falls back to MSE (MediaSource).
 */
export function detectStrategy(): DecoderStrategy {
  if (
    typeof globalThis.VideoDecoder === 'function' &&
    typeof globalThis.AudioDecoder === 'function'
  ) {
    return 'webcodecs';
  }
  if (typeof globalThis.MediaSource === 'function') {
    return 'mse';
  }
  // Default to WebCodecs — will fail gracefully at decode time.
  return 'webcodecs';
}
