/**
 * Capability detection for MoQ playback.
 *
 * Detects browser API availability and determines the best transport
 * and decoder strategy. Zero dependencies — purely globalThis checks.
 *
 * @see DESIGN-browser-adapter-gaps.md §6
 * @module
 */

// ─── SupportReport ───────────────────────────────────────────────────

/**
 * Detailed capability report for the current environment.
 *
 * Rollup logic:
 * - Transport: `webTransport && isSecureContext` → `'webtransport'` → `webSocket` → `'websocket'` → `'none'`
 * - Decoder: `videoDecoder` → `'webcodecs'` → `mediaSource` → `'mse'` → `'none'`
 * - Supported: `transport !== 'none' && decoder !== 'none'`
 */
export interface SupportReport {
  /** Overall: can this environment run MoQ playback? */
  readonly supported: boolean;

  /** WebTransport API available. */
  readonly webTransport: boolean;
  /** WebSocket API available (fallback transport). */
  readonly webSocket: boolean;
  /** WebCodecs VideoDecoder available. */
  readonly videoDecoder: boolean;
  /** WebCodecs AudioDecoder available. */
  readonly audioDecoder: boolean;
  /** MediaSource Extensions available (includes ManagedMediaSource for Safari). */
  readonly mediaSource: boolean;
  /** HTMLCanvasElement available. */
  readonly canvas: boolean;
  /** OffscreenCanvas available. */
  readonly offscreenCanvas: boolean;
  /** AudioContext available (includes webkitAudioContext for Safari). */
  readonly audioContext: boolean;
  /** Secure context (HTTPS) — required for WebTransport. */
  readonly isSecureContext: boolean;

  /** Best available transport strategy. */
  readonly transport: 'webtransport' | 'websocket' | 'none';
  /** Best available decoder strategy. */
  readonly decoder: 'webcodecs' | 'mse' | 'none';
  /** Human-readable reason if not supported. */
  readonly reason?: string;
}

// ─── checkSupport ────────────────────────────────────────────────────

/**
 * Detect browser capabilities and determine the best playback strategy.
 *
 * Pure function — no side effects, no caching. Performs ~10 `typeof`
 * checks against `globalThis` (~microseconds).
 *
 * @returns Frozen capability report.
 */
export function checkSupport(): SupportReport {
  const webTransport = typeof globalThis.WebTransport !== 'undefined';
  const webSocket = typeof globalThis.WebSocket !== 'undefined';
  const videoDecoder = typeof globalThis.VideoDecoder !== 'undefined';
  const audioDecoder = typeof globalThis.AudioDecoder !== 'undefined';
  const mediaSource = typeof globalThis.MediaSource !== 'undefined'
    || typeof (globalThis as any).ManagedMediaSource !== 'undefined';
  const canvas = typeof globalThis.HTMLCanvasElement !== 'undefined';
  const offscreenCanvas = typeof globalThis.OffscreenCanvas !== 'undefined';
  const audioContext = typeof globalThis.AudioContext !== 'undefined'
    || typeof (globalThis as any).webkitAudioContext !== 'undefined';
  const isSecureContext = typeof globalThis.isSecureContext === 'boolean'
    ? globalThis.isSecureContext
    : false;

  // Transport rollup: WebTransport requires secure context
  const transport: 'webtransport' | 'websocket' | 'none' =
    webTransport && isSecureContext ? 'webtransport' :
    webSocket ? 'websocket' :
    'none';

  // Decoder rollup: prefer WebCodecs, fall back to MSE
  const decoder: 'webcodecs' | 'mse' | 'none' =
    videoDecoder ? 'webcodecs' :
    mediaSource ? 'mse' :
    'none';

  const supported = transport !== 'none' && decoder !== 'none';

  let reason: string | undefined;
  if (transport === 'none') {
    reason = 'Neither WebTransport nor WebSocket is available';
  } else if (decoder === 'none') {
    reason = 'Neither WebCodecs nor MediaSource Extensions are available';
  }

  return {
    supported, webTransport, webSocket, videoDecoder, audioDecoder,
    mediaSource, canvas, offscreenCanvas, audioContext, isSecureContext,
    transport, decoder,
    ...(reason !== undefined ? { reason } : {}),
  };
}
