/**
 * Decode strategy auto-detection.
 *
 * Selects between WebCodecs+Canvas and MSE+<video> based on
 * browser capabilities. WebCodecs preferred for lower latency
 * and direct GPU memory control.
 *
 * @module
 */

/** Available decode strategies. */
export type DecoderStrategy = 'webcodecs' | 'mse';

/**
 * Detect the best decode strategy for the current browser.
 *
 * WebCodecs preferred (LOC direct path, lower latency).
 * MSE fallback (broader compatibility, required for CMAF).
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
  return 'webcodecs';
}
