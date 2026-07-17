/**
 * Player configuration — connection, playback tuning, extension points.
 *
 * Flat namespace (like HLS.js): `config.targetLatencyMs`, not `config.latency.targetMs`.
 * Type composition for documentation grouping — IDE autocomplete stays flat.
 * Validate at merge time — bad values throw immediately.
 * Sensible defaults — most users pass only `url` + `namespace`.
 *
 * @see draft-ietf-moq-transport-16 §9.2.2.2 (DELIVERY_TIMEOUT)
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup for ABR)
 * @module
 */

import type { MoqtConnection, WebTransportLike } from '@moqt/webtransport';
import type { QlogEvent, MoqtObject, DraftVersion } from '@moqt/transport';
import type { TrackConstraints, CatalogTrack } from '@moqt/msf';
import type { ClockSource, DecoderCommand, RecoveryController } from '@moqt/playback';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike, MediaSourceLike, CmafAssemblerLike } from './interfaces.js';
import type { PlayerError } from './errors.js';
import type { LogLevel, LoggerLike } from './logger.js';

// ─── Known Track Metadata (TTFF optimization) ────────────────────────

/**
 * Pre-known track metadata for TTFF optimization.
 *
 * When provided via `knownTracks`, the player subscribes to media tracks
 * in parallel with the catalog subscription — saving one full RTT.
 * Includes enough metadata to pre-create decoders and pipelines before
 * the catalog arrives.
 *
 * @see draft-ietf-moq-transport-16 §9.5 (MAX_REQUEST_ID — parallel subscriptions)
 * @see draft-ietf-moq-msf-00 §5.1.20 (initData)
 * @see DESIGN-production-readiness.md §2 (TTFF optimization)
 */
export interface KnownTrackConfig {
  /** Track name (must match the catalog track name exactly). */
  readonly name: string;

  /** Codec string (e.g., 'avc1.64001f', 'opus'). */
  readonly codec: string;

  /** Video width in pixels. */
  readonly width?: number;

  /** Video height in pixels. */
  readonly height?: number;

  /** Audio sample rate in Hz. */
  readonly samplerate?: number;

  /** Audio channel count. */
  readonly channels?: number;

  /**
   * Base64-encoded codec-specific initialization data (SPS/PPS, ConfigOBU).
   * Enables eager decoder configuration before the catalog arrives.
   * @see draft-ietf-moq-msf-00 §5.1.20 (initData)
   */
  readonly initData?: string;
}

// ─── Category Interfaces (documentation grouping — type stays flat) ───

/** Connection options. */
export interface ConnectionConfig {
  /** WebTransport URL to the relay (e.g., "https://relay.example.com/moq"). */
  readonly url: string;

  /**
   * Externally owned connection — use an existing connected MoqtConnection.
   *
   * When set, the player uses this connection directly without calling connect().
   * The connection must already be connected (session state ESTABLISHED).
   * `createTransport` and `createConnection` are ignored.
   *
   * On destroy(), the player detaches (unsubscribes its own tracks, nulls its
   * callbacks) but does NOT close the connection — the caller owns its lifecycle.
   *
   * Enables shared connections: thumbnails, scoreboards, and other raw
   * subscriptions on the same QUIC connection via connection.subscribeTrack().
   *
   * @see draft-ietf-moq-transport-16 §3 (Session)
   */
  readonly connection?: MoqtConnection;

  /**
   * Track namespace for the broadcast.
   * @see draft-ietf-moq-msf-00 §5.1.10 (Track Namespace)
   */
  /**
   * Track Namespace — the publisher's namespace this player subscribes
   * under (spec §2.4.1: an ordered set of 1-32 byte-string fields).
   *
   * Accepts either form:
   * - `string`: split on `/` into fields.
   *   `"live/broadcast"` → `["live", "broadcast"]` (2 fields).
   * - `readonly string[]`: each entry is one field, used verbatim.
   *   `["cmsf/clear"]` → one 10-byte field with the slash inside.
   *
   * Both forms are spec-compliant; the spec is silent on how a
   * user-facing string maps to fields. Pick the form that matches the
   * publisher you intend to subscribe to.
   */
  readonly namespace: string | readonly string[];

  /**
   * MAX_REQUEST_ID for the MOQT session. Default: 100.
   * Must be nonzero for subscriptions to work.
   * @see draft-ietf-moq-transport-16 §9.3.1.3
   */
  readonly maxRequestId?: number;

  /**
   * Connection timeout in milliseconds. Default: 10_000.
   * If the connection isn.t established within this time, load() rejects.
   */
  readonly connectionTimeoutMs?: number;

  /**
   * Number of reconnection attempts before giving up. Default: 3.
   * Set to 0 to disable automatic reconnection.
   */
  readonly reconnectAttempts?: number;

  /**
   * Base delay in milliseconds between reconnection attempts. Default: 1_000.
   */
  readonly reconnectDelayMs?: number;

  /**
   * Backoff strategy for reconnection delays. Default: 'exponential'.
   * - `'linear'`: delay = reconnectDelayMs * attempt
   * - `'exponential'`: delay = reconnectDelayMs * 2^(attempt-1)
   */
  readonly reconnectBackoff?: 'linear' | 'exponential';

  /**
   * CLIENT_SETUP AUTHORITY parameter.
   *
   * Most WebTransport deployments identify the authority in the connection
   * URL and should leave this unset. Sending AUTHORITY in SETUP over
   * WebTransport is a deliberate interop override for tenant-routed relays:
   * a spec-compliant relay MUST close the session with INVALID_AUTHORITY.
   *
   * @see draft-ietf-moq-transport-16 §9.3.1.1
   */
  readonly authority?: string;

  /**
   * Authorization tokens to include in CLIENT_SETUP.
   * Each Uint8Array is a serialized Token structure (Figure 4).
   * @see draft-ietf-moq-transport-16 §9.3.1.5
   */
  readonly authTokens?: Uint8Array[];

  /**
   * MOQT implementation identifier included in CLIENT_SETUP.
   * Default: 'proto-moq'.
   * @see draft-ietf-moq-transport-16 §9.3.1.6
   */
  readonly moqtImplementation?: string;

  /**
   * MOQT draft version for protocol wire format.
   * Default: 16 (default supported draft). Set to 14 for interop with draft-14 servers (moq-rs, etc.).
   *
   * Passed to `new MoqtConnection(draftVersion)` when using `createConnection`.
   * @see draft-ietf-moq-transport-16
   * @see draft-ietf-moq-transport-14
   */
  readonly draftVersion?: DraftVersion;

  /**
   * Pre-known track metadata for TTFF optimization.
   *
   * When set, the player subscribes to media tracks in parallel with the
   * catalog subscription and pre-creates decoders/pipelines — saving one
   * full RTT (~50-100ms). Track names and codecs must match the broadcast.
   *
   * @see draft-ietf-moq-transport-16 §9.5 (MAX_REQUEST_ID — parallel subscriptions)
   * @see DESIGN-production-readiness.md §2 (TTFF optimization)
   */
  readonly knownTracks?: {
    readonly video?: KnownTrackConfig;
    readonly audio?: KnownTrackConfig;
  };

  /**
   * External catalog injection — provide track metadata from any source.
   *
   * When set, the player skips the catalog subscription entirely and uses
   * these tracks directly. Useful when:
   * - The server doesn't support catalog (Red5 catalogs-mode, etc.)
   * - Track metadata comes from an external signaling plane (REST API, SDP)
   * - Testing with known content
   *
   * Accepts the same `CatalogTrack[]` that the MSF parser produces —
   * the player doesn't care where the catalog came from.
   *
   * @see draft-ietf-moq-msf-00 §5 (Catalog)
   */
  readonly catalog?: {
    readonly tracks: readonly CatalogTrack[];
  };
}

/** Playback tuning options. */
export interface PlaybackTuningConfig {
  /**
   * Maximum wait time in milliseconds for a missing group before skip-forward.
   * Default: 500ms.
   * @see draft-ietf-moq-transport-16 §9.2.2.2 (DELIVERY_TIMEOUT)
   */
  readonly gapTimeoutMs?: number;

  /**
   * A/V sync drift threshold in milliseconds before resync.
   * Default: 30ms.
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
   */
  readonly driftThresholdMs?: number;

  /**
   * Maximum number of objects in the jitter buffer.
   * Default: 500.
   * @see draft-ietf-moq-transport-16 §7 (Priority-based dropping)
   */
  readonly maxBufferDepth?: number;

  /**
   * Delivery timeout in milliseconds to request from the publisher.
   * If set, included as DELIVERY_TIMEOUT parameter in SUBSCRIBE.
   * @see draft-ietf-moq-transport-16 §9.2.2.2 (DELIVERY_TIMEOUT)
   */
  readonly deliveryTimeoutMs?: number;

  /**
   * Subscriber priority for media subscriptions. Range 0-255, lower = higher priority.
   * Default: omitted (publisher uses 128).
   * @see draft-ietf-moq-transport-16 §9.2.2.3 (SUBSCRIBER_PRIORITY)
   */
  readonly subscriberPriority?: number;

  /**
   * Group ordering: 'ascending' (0x1) or 'descending' (0x2).
   * Default: omitted (publisher's preference from the Track is used).
   * @see draft-ietf-moq-transport-16 §9.2.2.4 (GROUP_ORDER)
   */
  readonly groupOrder?: 'ascending' | 'descending';

  /**
   * Subscription filter for media track subscriptions.
   * Default: omitted (unfiltered — publisher sends all objects).
   * @see draft-ietf-moq-transport-16 §5.1.2 (Subscription Filters)
   * @see draft-ietf-moq-transport-16 §9.2.2.5 (SUBSCRIPTION_FILTER parameter)
   */
  readonly subscriptionFilter?: {
    readonly type: 'NextGroupStart' | 'LargestObject' | 'LatestObject' | 'AbsoluteStart' | 'AbsoluteRange';
    readonly startGroup?: number;
    readonly startObject?: number;
    readonly endGroup?: number;
  };

  /**
   * Warm-start the current group at initial tune-in (§5.1.3 "Joining an
   * Ongoing Track"): live LOC media tracks subscribe with the Largest Object
   * filter and immediately issue a relative Joining FETCH (Joining Start 0,
   * §9.16.2 / draft-18 §10.12.2) referencing the SUBSCRIBE, so the current
   * group's head plays immediately instead of waiting for the next group
   * boundary. The FETCH and the live subscription are contiguous and
   * non-overlapping by construction (§9.16.2.1).
   *
   * Scope: initial tune-in only (never ABR switches), live LOC tracks only —
   * CMAF tracks keep their normal boundary start (MSE append ordering is not
   * warm-start safe yet) and non-live tracks already start from group 0. A
   * refused FETCH is non-fatal: playback continues live-only from the next
   * group boundary.
   *
   * Default: off. Incompatible with an explicit `subscriptionFilter` other
   * than `'LargestObject'` — draft-16 §9.16.2 closes the session when a
   * Joining Fetch references a subscription with any other filter.
   */
  readonly warmStartCurrentGroup?: boolean;
}

/** Latency and catch-up options. */
export interface LatencyConfig {
  /**
   * Target end-to-end latency in milliseconds.
   * When undefined, uses the catalog's targetLatency or disables catch-up.
   * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
   */
  readonly targetLatencyMs?: number;

  /**
   * Maximum playback rate for catch-up (e.g., 1.05 = 5% faster).
   * Default: 1.0 (catch-up disabled).
   * Must be >= 1.0.
   */
  readonly maxCatchUpRate?: number;

  /**
   * Latency threshold in ms before catch-up activates. Default: 500.
   * Catch-up only kicks in when current latency exceeds
   * targetLatencyMs + catchUpThresholdMs.
   */
  readonly catchUpThresholdMs?: number;

  /**
   * Threshold in ms for considering a frame "late" for drop decisions.
   * Default: 100ms.
   * Frames arriving later than this behind their render time may be dropped.
   */
  readonly lateFrameThresholdMs?: number;

  /**
   * Maximum A/V drift in milliseconds before corrective action.
   * Default: 500ms.
   */
  readonly maxDriftMs?: number;

  /**
   * Latency threshold for deactivating catch-up (hysteresis).
   * Catch-up deactivates when latency drops to targetLatencyMs + catchUpRecoveryMs.
   * Default: 50ms.
   * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
   */
  readonly catchUpRecoveryMs?: number;
}

/** Quality / ABR options. */
export interface QualityConfig {
  /**
   * Enable automatic quality selection from altGroup alternatives.
   * Default: true.
   * When false, the player stays at the initially selected level.
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
   */
  readonly autoQuality?: boolean;

  /**
   * Initial quality level selection.
   * - `'auto'`: highest quality matching constraints (default)
   * - `'lowest'`: start at lowest bitrate (conservative)
   * - number: index into sorted alternatives (0 = highest bitrate)
   */
  readonly startLevel?: number | 'lowest' | 'auto';

  /**
   * Cap video quality to a maximum resolution.
   * Tracks exceeding this resolution are excluded from selection.
   * Useful for mobile devices or bandwidth-constrained environments.
   */
  readonly capLevelToResolution?: { readonly width: number; readonly height: number };

  /**
   * Minimum time in ms between quality switches. Default: 5_000.
   * Prevents oscillation in unstable network conditions.
   */
  readonly qualitySwitchCooldownMs?: number;


  /**
   * Constraints for initial video track selection from altGroup.
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
   */
  readonly videoConstraints?: TrackConstraints;

  /**
   * Constraints for initial audio track selection from altGroup.
   * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
   */
  readonly audioConstraints?: TrackConstraints;

  /** Never select a video track, regardless of catalog contents. Default: false. */
  readonly disableVideo?: boolean;
  /** Never select an audio track, regardless of catalog contents. Default: false. */
  readonly disableAudio?: boolean;
}

/** Recovery options. */
export interface RecoveryConfig {
  /**
   * Number of consecutive gaps within the escalation window that triggers
   * quality reduction. Default: 5.
   */
  readonly maxConsecutiveGaps?: number;

  /**
   * Maximum decode errors before terminating playback. Default: 10.
   */
  readonly maxDecodeErrors?: number;

  /**
   * @deprecated No longer used — gap escalation is now event-driven
   * (consecutive count) rather than time-windowed. Kept for backward compat.
   */
  readonly gapEscalationWindowMs?: number;

  /**
   * CMAF bootstrap deadline: once CMAF media objects are arriving, an init
   * segment must materialize (inline initData, initTrack delivery, or an
   * in-band ftyp+moov object) — and after MSE initialization, a first frame
   * must render — within this window, or playback fails with a specific
   * fatal error instead of a silent black player.
   * Default: 10_000. Set 0 to disable both bootstrap deadlines.
   */
  readonly cmafBootstrapTimeoutMs?: number;

  /**
   * Media-liveness starvation threshold: while PLAYING, a track with no
   * object arrivals for this long triggers the restart ladder.
   * The gap detector handles gaps BETWEEN arrivals; this handles NO
   * arrivals (transport stream death, relay restart).
   * Default: 10_000. Set 0 to disable liveness monitoring entirely.
   */
  readonly livenessTimeoutMs?: number;

  /**
   * Shortened liveness fuse after a data-stream reset on a delivering
   * track: a healthy track re-stamps via its successor stream within this
   * window; a dead one starves fast instead of waiting the full timeout.
   * Default: 2_000.
   */
  readonly livenessResetProbeMs?: number;

  /**
   * Maximum delivery-restart attempts per starvation incident before
   * escalating to a fatal MEDIA_STARVED error. Default: 3.
   */
  readonly livenessMaxRestarts?: number;

  /**
   * Base backoff before restart attempt N≥2 (doubles per attempt).
   * Default: 1_000.
   */
  readonly livenessRestartBackoffMs?: number;

  /**
   * Uninterrupted healthy delivery for this long resets the restart
   * budget. Default: 30_000.
   */
  readonly livenessHealthyResetMs?: number;
}

/** Audio options. */
export interface AudioSpecificConfig {
  /**
   * How far ahead (in ms) to schedule audio samples. Default: 200.
   * Higher values improve smoothness, lower values reduce latency.
   */
  readonly audioScheduleAheadMs?: number;
}

/** Clock injection. */
export interface ClockConfig {
  /**
   * Injectable clock source for playback timing.
   * Must return monotonic microseconds in the same domain as the renderer.
   * Default: performance.now() * 1000.
   * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp uses microseconds)
   */
  readonly clock?: ClockSource;
}

/** Factory functions for swappable layers. */
export interface FactoryConfig {
  /**
   * Factory to create a WebTransport connection from a URL.
   *
   * The player calls this with the constructed connect URL (base URL + namespace).
   * The factory returns a ready `WebTransportLike` which is passed to `connection.connect()`.
   *
   * This cleanly separates transport creation (browser concern) from protocol logic.
   * Browser usage: `createTransport: createWebTransport({ certHash })` from @moqt/browser.
   */
  readonly createTransport?: (url: string) => Promise<WebTransportLike>;

  /** Factory for the network connection. */
  readonly createConnection?: () => MoqtConnection;

  /** Factory for the video decoder backend. */
  readonly createVideoDecoder?: () => VideoDecoderLike;

  /** Factory for the audio decoder backend. */
  readonly createAudioDecoder?: () => AudioDecoderLike;

  /** Factory for the video renderer. */
  readonly createRenderer?: () => VideoRendererLike;

  /** Factory for the audio output. */
  readonly createAudioOutput?: () => AudioOutputLike;

  /**
   * Factory for the MseMediaSource (CMAF/MSE fallback).
   * When provided, CMAF-packaged tracks are routed directly to the
   * MseMediaSource instead of through the PlaybackPipeline.
   * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
   */
  readonly createMediaSource?: () => MediaSourceLike;

  /**
   * Factory for the CMAF segment assembler.
   * Pairs moof+mdat objects, patches tfdt to zero-based timestamps.
   * Required when using CMAF packaging with MSE.
   * @see draft-ietf-moq-cmsf-00 §3.3 (Object Packaging)
   */
  readonly createCmafAssembler?: (options: {
    onSegment: (mediaType: 'video' | 'audio', segment: Uint8Array, trackName: string, groupId: bigint) => void;
    onDiscontinuity?: (mediaType: 'video' | 'audio', trackName: string) => void;
  }) => CmafAssemblerLike;

  /**
   * Factory for the recovery controller.
   * If not provided, DefaultRecoveryController is used with config values.
   * @see draft-ietf-moq-transport-16 §13.4.3 (TOO_FAR_BEHIND)
   */
  readonly createRecoveryController?: (clock: ClockSource) => RecoveryController;
}

/** Transform/interception insertion points. */
export interface TransformConfig {
  /**
   * Object transform: runs on every MoqtObject before pipeline processing.
   * Return null to drop the object. May be async (e.g., crypto.subtle.decrypt()).
   * @see draft-jennings-moq-secure-objects-03 (Secure Objects)
   */
  readonly objectTransform?: (obj: MoqtObject) => MoqtObject | null | Promise<MoqtObject | null>;

  /**
   * Custom extension parser for non-LOC packaging formats.
   *
   * When set, called instead of parseLocHeaders() for LOC-packaged tracks.
   * Return LocHeaders with whatever fields could be extracted.
   * Default: undefined (uses standard LOC parser per draft-ietf-moq-loc-01 §2.3).
   *
   * Use case: relays that use non-standard extension encoding (e.g., absolute
   * type IDs instead of delta-encoded KVPs per MoQT §1.4.2).
   *
   * @see draft-ietf-moq-loc-01 §2.3 (LOC Header Extensions)
   * @see draft-ietf-moq-transport-16 §1.4.2 (KVP encoding)
   */
  readonly extensionParser?: (extensions: Uint8Array | undefined) => import('@moqt/loc').LocHeaders;

  /**
   * Command transform: runs on every DecoderCommand before browser adapter execution.
   * Return null to suppress the command.
   */
  readonly commandTransform?: (cmd: DecoderCommand) => DecoderCommand | null;

  /**
   * Error filter: runs on every PlayerError before emission.
   * Return null to suppress.
   */
  readonly errorFilter?: (error: PlayerError) => PlayerError | null;
}

/** Debug and tracing options. */
export interface DebugConfig {
  /**
   * qlog event callback.
   * @see draft-pardue-moq-qlog-moq-events-04
   */
  readonly onQlogEvent?: (event: QlogEvent) => void;

  /**
   * Log verbosity level. Default: 'none'.
   * @see DESIGN-production-readiness.md §6
   */
  readonly logLevel?: LogLevel;

  /**
   * Custom logger backend.
   * @see DESIGN-production-readiness.md §6
   */
  readonly logger?: LoggerLike;
}

// ─── MoqtPlayerConfig ─────────────────────────────────────────────────────

/**
 * Full player configuration.
 *
 * Type intersection of category interfaces — flat namespace for IDE autocomplete.
 * Only `url` and `namespace` are required. Everything else has defaults.
 */
export interface MoqtPlayerConfig extends
  ConnectionConfig,
  PlaybackTuningConfig,
  LatencyConfig,
  QualityConfig,
  RecoveryConfig,
  AudioSpecificConfig,
  ClockConfig,
  FactoryConfig,
  TransformConfig,
  DebugConfig {}

// ─── Defaults ────────────────────────────────────────────────────────

/** @deprecated Use DEFAULT_PLAYER_CONFIG.gapTimeoutMs instead. */
export const DEFAULT_GAP_TIMEOUT_MS = 500;

/** @deprecated Use DEFAULT_PLAYER_CONFIG.driftThresholdMs instead. */
export const DEFAULT_DRIFT_THRESHOLD_MS = 30;

/**
 * @deprecated Use DEFAULT_PLAYER_CONFIG.maxBufferDepth instead.
 *
 * Default max jitter buffer depth: 500 objects.
 */
export const DEFAULT_MAX_BUFFER_DEPTH = 500;

/** @deprecated Use DEFAULT_PLAYER_CONFIG.deliveryTimeoutMs instead. */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 500;

/**
 * @deprecated Use DEFAULT_PLAYER_CONFIG.maxRequestId instead.
 * @see draft-ietf-moq-transport-16 §9.3.1.3
 */
export const DEFAULT_MAX_REQUEST_ID = 10_000;

/**
 * Default values for all player configuration options.
 *
 * Spread over user config: `{ ...DEFAULT_PLAYER_CONFIG, ...userConfig }`.
 * All numeric fields validated by `validateConfig()`.
 */
export const DEFAULT_PLAYER_CONFIG = {
  // Connection
  maxRequestId: 10_000,
  connectionTimeoutMs: 10_000,
  reconnectAttempts: 3,
  reconnectDelayMs: 1_000,
  reconnectBackoff: 'exponential' as const,
  moqtImplementation: 'proto-moq',

  // Playback tuning
  gapTimeoutMs: 500,
  driftThresholdMs: 200,
  maxBufferDepth: 500,

  // Latency / catch-up
  maxCatchUpRate: 1.0,
  catchUpThresholdMs: 500,
  catchUpRecoveryMs: 50,
  lateFrameThresholdMs: 100,
  maxDriftMs: 500,

  // Quality / ABR
  autoQuality: true,
  startLevel: 'auto' as const,
  qualitySwitchCooldownMs: 5_000,

  // Recovery
  maxConsecutiveGaps: 5,
  maxDecodeErrors: 10,
  gapEscalationWindowMs: 10_000,

  // CMAF bootstrap (0 disables)
  cmafBootstrapTimeoutMs: 10_000,

  // Media liveness (0 disables)
  livenessTimeoutMs: 10_000,
  livenessResetProbeMs: 2_000,
  livenessMaxRestarts: 3,
  livenessRestartBackoffMs: 1_000,
  livenessHealthyResetMs: 30_000,

  // Audio
  audioScheduleAheadMs: 200,

  // Debug
  logLevel: 'none' as LogLevel,
} as const;

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate player configuration. Throws on invalid values.
 *
 * Called at construction time — bad config fails fast, not 30 seconds
 * into a stream.
 */
export function validateConfig(config: MoqtPlayerConfig): void {
  // subscriberPriority: 0–255 (§9.2.2.3)
  if (config.subscriberPriority !== undefined) {
    if (!Number.isInteger(config.subscriberPriority) || config.subscriberPriority < 0 || config.subscriberPriority > 255) {
      throw new RangeError(`subscriberPriority must be 0–255, got ${config.subscriberPriority}`);
    }
  }

  // maxCatchUpRate >= 1.0
  if (config.maxCatchUpRate !== undefined && config.maxCatchUpRate < 1.0) {
    throw new RangeError(`maxCatchUpRate must be >= 1.0, got ${config.maxCatchUpRate}`);
  }

  // reconnectAttempts >= 0
  if (config.reconnectAttempts !== undefined && (config.reconnectAttempts < 0 || !Number.isInteger(config.reconnectAttempts))) {
    throw new RangeError(`reconnectAttempts must be a non-negative integer, got ${config.reconnectAttempts}`);
  }

  // All *Ms timeouts > 0
  const msFields: Array<[string, number | undefined]> = [
    ['connectionTimeoutMs', config.connectionTimeoutMs],
    ['reconnectDelayMs', config.reconnectDelayMs],
    ['gapTimeoutMs', config.gapTimeoutMs],
    ['driftThresholdMs', config.driftThresholdMs],
    ['catchUpThresholdMs', config.catchUpThresholdMs],
    ['catchUpRecoveryMs', config.catchUpRecoveryMs],
    ['lateFrameThresholdMs', config.lateFrameThresholdMs],
    ['maxDriftMs', config.maxDriftMs],
    ['qualitySwitchCooldownMs', config.qualitySwitchCooldownMs],
    ['gapEscalationWindowMs', config.gapEscalationWindowMs],
    ['audioScheduleAheadMs', config.audioScheduleAheadMs],
    ['livenessResetProbeMs', config.livenessResetProbeMs],
    ['livenessRestartBackoffMs', config.livenessRestartBackoffMs],
    ['livenessHealthyResetMs', config.livenessHealthyResetMs],
  ];

  for (const [name, value] of msFields) {
    if (value !== undefined && value <= 0) {
      throw new RangeError(`${name} must be > 0, got ${value}`);
    }
  }

  // livenessTimeoutMs: >= 0 (0 disables the liveness monitor)
  if (config.livenessTimeoutMs !== undefined && config.livenessTimeoutMs < 0) {
    throw new RangeError(`livenessTimeoutMs must be >= 0 (0 disables), got ${config.livenessTimeoutMs}`);
  }

  // cmafBootstrapTimeoutMs: >= 0 (0 disables the bootstrap deadlines)
  if (config.cmafBootstrapTimeoutMs !== undefined && config.cmafBootstrapTimeoutMs < 0) {
    throw new RangeError(`cmafBootstrapTimeoutMs must be >= 0 (0 disables), got ${config.cmafBootstrapTimeoutMs}`);
  }

  if (config.authority !== undefined && config.authority.trim().length === 0) {
    throw new RangeError('authority must be non-empty when set');
  }

  // warmStartCurrentGroup requires the Largest Object filter: draft-16
  // §9.16.2 makes a Joining Fetch on any other filter a session-fatal
  // PROTOCOL_VIOLATION, so reject the combination at load time.
  // 'LatestObject' is the deprecated compatibility alias for 'LargestObject'
  // (same wire filter type 0x2) and is accepted.
  if (config.warmStartCurrentGroup
      && config.subscriptionFilter !== undefined
      && config.subscriptionFilter.type !== 'LargestObject'
      && config.subscriptionFilter.type !== 'LatestObject') {
    throw new RangeError(
      `warmStartCurrentGroup requires the LargestObject subscription filter (§9.16.2), got ${config.subscriptionFilter.type}`,
    );
  }

  // livenessMaxRestarts: positive integer
  if (config.livenessMaxRestarts !== undefined
      && (config.livenessMaxRestarts <= 0 || !Number.isInteger(config.livenessMaxRestarts))) {
    throw new RangeError(`livenessMaxRestarts must be a positive integer, got ${config.livenessMaxRestarts}`);
  }

  // deliveryTimeoutMs: > 0 if set
  if (config.deliveryTimeoutMs !== undefined && config.deliveryTimeoutMs <= 0) {
    throw new RangeError(`deliveryTimeoutMs must be > 0, got ${config.deliveryTimeoutMs}`);
  }

  // targetLatencyMs: > 0 if set
  if (config.targetLatencyMs !== undefined && config.targetLatencyMs <= 0) {
    throw new RangeError(`targetLatencyMs must be > 0, got ${config.targetLatencyMs}`);
  }

  // maxBufferDepth: > 0
  if (config.maxBufferDepth !== undefined && (config.maxBufferDepth <= 0 || !Number.isInteger(config.maxBufferDepth))) {
    throw new RangeError(`maxBufferDepth must be a positive integer, got ${config.maxBufferDepth}`);
  }

  // maxRequestId: > 0
  if (config.maxRequestId !== undefined && (config.maxRequestId <= 0 || !Number.isInteger(config.maxRequestId))) {
    throw new RangeError(`maxRequestId must be a positive integer, got ${config.maxRequestId}`);
  }

  // startLevel validation
  if (config.startLevel !== undefined) {
    if (typeof config.startLevel === 'number') {
      if (config.startLevel < 0 || !Number.isInteger(config.startLevel)) {
        throw new RangeError(`startLevel must be >= 0 (integer), 'lowest', or 'auto', got ${config.startLevel}`);
      }
    } else if (config.startLevel !== 'lowest' && config.startLevel !== 'auto') {
      throw new RangeError(`startLevel must be >= 0 (integer), 'lowest', or 'auto', got '${config.startLevel}'`);
    }
  }

  // maxConsecutiveGaps: > 0
  if (config.maxConsecutiveGaps !== undefined && (config.maxConsecutiveGaps <= 0 || !Number.isInteger(config.maxConsecutiveGaps))) {
    throw new RangeError(`maxConsecutiveGaps must be a positive integer, got ${config.maxConsecutiveGaps}`);
  }

  // maxDecodeErrors: > 0
  if (config.maxDecodeErrors !== undefined && (config.maxDecodeErrors <= 0 || !Number.isInteger(config.maxDecodeErrors))) {
    throw new RangeError(`maxDecodeErrors must be a positive integer, got ${config.maxDecodeErrors}`);
  }

  // capLevelToResolution: both dimensions > 0
  if (config.capLevelToResolution !== undefined) {
    if (config.capLevelToResolution.width <= 0 || config.capLevelToResolution.height <= 0) {
      throw new RangeError(`capLevelToResolution dimensions must be > 0, got ${config.capLevelToResolution.width}x${config.capLevelToResolution.height}`);
    }
  }
}
