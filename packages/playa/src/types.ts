/**
 * Public types for @playa/player.
 *
 * UI-friendly types that abstract away protocol internals.
 * Designed for developer ergonomics — no bigints, no spec jargon.
 *
 * @module
 */

import type { MoqtPlayerConfig } from '@moqt/player';

/** Player state machine values. */
export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

/**
 * Options for the Player constructor.
 *
 * Simple, flat config with sensible defaults. Power users can pass
 * `moqtPlayerConfig` for full control over the underlying @moqt/player instance.
 */
export interface PlayerOptions {
  /** WebTransport relay URL (e.g., `https://relay.example.com/moq`). */
  readonly url: string;
  /** Track namespace for the broadcast (e.g., `live/stream`). */
  readonly namespace: string;

  // ── Connection ──

  /** SHA-256 cert hash for self-signed certs (local dev). */
  readonly certHash?: ArrayBuffer;
  /** MOQT draft version. Default: 16. */
  readonly draftVersion?: 14 | 16 | 18;
  /** Auth tokens for CLIENT_SETUP. */
  readonly authTokens?: Uint8Array[];

  // ── Playback ──

  /** Auto-start playback after load(). Default: false. */
  readonly autoplay?: boolean;
  /** Initial volume (0–1). Default: 1. */
  readonly volume?: number;
  /** Start muted. Default: false. */
  readonly muted?: boolean;
  /**
   * Audio activation policy.
   * - `'auto'`: AudioContext created eagerly during load (current behavior).
   * - `'gesture'`: AudioContext deferred until prepareAudio()/unmute() — no
   *   autoplay policy violations. Audio data is dropped until activated.
   * Default: `'auto'`.
   */
  readonly audioActivation?: 'auto' | 'gesture';
  /** Target latency in ms for live edge. */
  readonly targetLatencyMs?: number;

  // ── Quality ──

  /** Enable ABR quality switching. Default: true. */
  readonly autoQuality?: boolean;
  /** Initial quality level: 'auto' | 'lowest' | level index. Default: 'auto'. */
  readonly startLevel?: number | 'lowest' | 'auto';
  /** Cap quality to a maximum resolution. */
  readonly maxResolution?: { readonly width: number; readonly height: number };

  // ── Media Elements ──

  /**
   * Canvas element to render into for WebCodecs (LOC) playback.
   *
   * Provide this when the DOM is managed externally — for example in a React
   * component where `<canvas ref={canvasRef} />` is declared in JSX.  When
   * supplied, the Player uses it as-is: no styles, no `hidden` toggling, and
   * no DOM insertion or removal are performed on the element.
   *
   * If omitted and `container` is provided, the Player creates a `<canvas>`
   * automatically and appends it to `container` (classic behaviour).
   */
  readonly canvas?: HTMLCanvasElement;

  /**
   * Video element to render into for MSE (CMAF) playback.
   *
   * Provide this when the DOM is managed externally — for example in a React
   * component where `<video ref={videoRef} playsInline />` is declared in
   * JSX.  When supplied, the Player uses it as-is: no styles, no `hidden`
   * toggling, and no DOM insertion or removal are performed on the element.
   *
   * If omitted and `container` is provided, the Player creates a `<video>`
   * automatically and appends it to `container` (classic behaviour).
   */
  readonly video?: HTMLVideoElement;

  // ── Advanced ──

  /** Pass-through overrides for the underlying @moqt/player config. */
  readonly moqtPlayerConfig?: Partial<MoqtPlayerConfig>;
}

/** Quality level exposed to UI (e.g., for a quality selector menu). */
export interface Level {
  /** Index in the levels array (0-based, sorted by bitrate descending). */
  readonly index: number;
  /** MoQ track name — used by selectVideoTrack for switching. */
  readonly trackName: string;
  /** Human-readable label (e.g., "1080p", "720p", "4K"). */
  readonly label: string;
  /** Codec string (e.g., "avc1.640028"). */
  readonly codec: string;
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
  /** Bitrate in bits/sec. */
  readonly bitrate: number;
}

/** Audio track exposed to UI (e.g., for a language selector). */
export interface AudioTrack {
  /** Index in the audioTracks array. */
  readonly index: number;
  /** Human-readable label (e.g., "English", "Audio 1"). */
  readonly label: string;
  /** BCP 47 language tag (e.g., "en", "es"). */
  readonly language?: string | undefined;
  /** Codec string (e.g., "mp4a.40.2", "opus"). */
  readonly codec: string;
}

/** Simplified stats for UI display. */
export interface PlayerStats {
  readonly framesDecoded: number;
  readonly framesRendered: number;
  readonly framesDropped: number;
  readonly bitrate: number;
  readonly latencyMs: number;
  readonly stallCount: number;
  readonly timeToFirstFrameMs: number | null;
  readonly resolution: { readonly width: number; readonly height: number } | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly sessionAgeMs: number;
}
