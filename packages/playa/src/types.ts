/**
 * Public types for @openmoq/playa.
 *
 * UI-friendly types that abstract away protocol internals.
 * Playback menus use stable string identities; advanced timeline maps retain
 * exact microsecond values from the engine.
 *
 * @module
 */

import type { MoqtPlayerConfig, VideoPlaybackQualityStats } from '@openmoq/player';

/** Player state machine values. */
export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

/**
 * Options for the Player constructor.
 *
 * Simple, flat config with sensible defaults. Power users can pass
 * `moqtPlayerConfig` for full control over the underlying @openmoq/player instance.
 */
export interface PlayerOptions {
  /** WebTransport relay URL (e.g., `https://relay.example.com/moq`). */
  readonly url: string;
  /** Track namespace for the broadcast (e.g., `live/stream`). */
  readonly namespace: string;
  /** Compatibility override for nonstandard catalog names. Default: `catalog` (MSF-01 §5). */
  readonly catalogTrackName?: string;

  // ── Connection ──

  /** SHA-256 cert hash for self-signed certs (local dev). */
  readonly certHash?: ArrayBuffer;
  /** MOQT draft version. Default: 16. */
  readonly draftVersion?: 14 | 16 | 18 | 22 | 23;
  /** Auth tokens for CLIENT_SETUP. */
  readonly authTokens?: Uint8Array[];
  /** Issuer-supplied credentials for SETUP and subsequent requests. */
  readonly authorization?: MoqtPlayerConfig['authorization'];

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
  /** Initial video view (catalog altGroup). Omitted: first video group. */
  readonly videoAltGroup?: number;
  /** Initial catalog scope, alternate sets, and exact track identities. */
  readonly selection?: MoqtPlayerConfig['selection'];
  /** Ordered preferred audio languages within the chosen program; omitted keeps catalog order. */
  readonly audioLanguages?: readonly string[];
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

  /** Pass-through overrides for the underlying @openmoq/player config. */
  readonly moqtPlayerConfig?: Partial<MoqtPlayerConfig>;
}

/** Quality level exposed to UI (e.g., for a quality selector menu). */
export interface Level {
  /** Index in the levels array (0-based, sorted by bitrate descending). */
  readonly index: number;
  /** MoQ track name — used by selectVideoTrack for switching. */
  readonly trackName: string;
  /** Stable track identity, available when the catalog namespace is resolved. */
  readonly id?: string;
  /** Ordered namespace fields; never a flattened display string. */
  readonly namespace?: readonly string[];
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
  /** Stable track identity for selectAudioTrack(), independent of menu order. */
  readonly id?: string;
  /** MoQ track name, available with a resolved identity. */
  readonly trackName?: string;
  /** Ordered namespace fields; never a flattened display string. */
  readonly namespace?: readonly string[];
  /** Human-readable label (e.g., "English", "Audio 1"). */
  readonly label: string;
  /** BCP 47 language tag (e.g., "en", "es"). */
  readonly language?: string | undefined;
  /** Codec string (e.g., "mp4a.40.2", "opus"). */
  readonly codec: string;
}

/** A video alternate set, or one track that declares no alternate group. */
export interface View {
  readonly id: string;
  readonly label: string;
  /** Absent for a singleton; zero is a valid declared group. */
  readonly altGroup?: number;
  readonly levels: readonly Level[];
}

/** A declared render group, or the separate pool of unassigned tracks. */
export interface Program {
  readonly id: string;
  readonly label: string;
  /** Null means no render group was declared. */
  readonly renderGroup: number | null;
  readonly views: readonly View[];
  readonly audioTracks: readonly AudioTrack[];
}

/** Simplified stats for UI display. */
export interface PlayerStats {
  readonly framesDecoded: number;
  readonly framesRendered: number;
  readonly framesDropped: number;
  readonly bitrate: number;
  /** Legacy numeric capture age; zero also represents unavailable. */
  readonly latencyMs: number;
  /** Latest uncorrected wall-clock capture age; null when unmeasurable.
   * May be zero/negative. Not a synchronized end-to-end latency measurement.
   */
  readonly captureTimestampAgeMs?: number | null;
  /** Native media-element-load counters, separate from legacy engine fields. */
  readonly videoPlaybackQuality?: Readonly<VideoPlaybackQualityStats> | null;
  readonly stallCount: number;
  readonly timeToFirstFrameMs: number | null;
  readonly resolution: { readonly width: number; readonly height: number } | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly sessionAgeMs: number;
}
