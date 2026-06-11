/**
 * @moqt/player — Convenience facade for MOQT playback.
 *
 * Wires together the sans-I/O core packages (@moqt/transport,
 * @moqt/webtransport, @moqt/msf, @moqt/loc, @moqt/playback)
 * into a simple load()/play()/pause()/destroy() API.
 *
 * @see draft-ietf-moq-transport-16 §3 (Session)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @see draft-ietf-moq-loc-01 §2 (LOC container)
 * @module
 */

// ─── Player ──────────────────────────────────────────────────────────

export { MoqtPlayer } from './player.js';
export type { SubscribeIntent, QualitySwitchIntent } from './player.js';

// ─── Capability Detection ─────────────────────────────────────────────

export { checkSupport } from './support.js';
export type { SupportReport } from './support.js';

// ─── Events ──────────────────────────────────────────────────────────

export type {
  PlayerEventMap,
  PlayerEvent,
  SessionConnectingEvent,
  SessionEstablishedEvent,
  SessionGoawayEvent,
  SessionClosedEvent,
  SessionErrorEvent,
  PlayerErrorEvent,
  CatalogRawEvent,
  CatalogReceivedEvent,
  CatalogUpdatedEvent,
  TrackSubscribedEvent,
  TrackUnsubscribedEvent,
  MediaObjectEvent,
  GapDetectedEvent,
  SkipForwardEvent,
  SyncDriftEvent,
  SyncSkewEvent,
  KeyframeWaitingEvent,
  TrackEndedEvent,
  RecoveryActionEvent,
  PlayerRecoveryAction,
  FirstFrameEvent,
  StallEvent,
  QualitySwitchedEvent,
  CatchUpChangedEvent,
  StateChangedEvent,
} from './events.js';

// ─── Errors ──────────────────────────────────────────────────────────

export { PlayerErrorCode, createPlayerError } from './errors.js';
export type {
  ErrorSeverity,
  ErrorSource,
  PlayerError,
  PlayerErrorCodeValue,
} from './errors.js';

// ─── Logger ──────────────────────────────────────────────────────────

export { ConsoleLogger, NULL_LOGGER, LOG_LEVELS, createLogger } from './logger.js';
export type { LogLevel, LoggerLike } from './logger.js';

// ─── Emitter ─────────────────────────────────────────────────────────

/** @experimental Advanced API — may change between minor versions. */
export { TypedEmitter } from './emitter.js';

// ─── Hooks ───────────────────────────────────────────────────────────

/** @experimental Advanced API — may change between minor versions. */
export { HookChain } from './hooks.js';
/** @experimental Advanced API — may change between minor versions. */
export type { HookFn } from './hooks.js';

// ─── State ───────────────────────────────────────────────────────────

export { PlayerState, PlayerStateMachine } from './state.js';
export type { PlayerStateValue } from './state.js';

// ─── Config ──────────────────────────────────────────────────────────

export type { MoqtPlayerConfig } from './config.js';
export {
  DEFAULT_GAP_TIMEOUT_MS,
  DEFAULT_DRIFT_THRESHOLD_MS,
  DEFAULT_MAX_BUFFER_DEPTH,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  DEFAULT_PLAYER_CONFIG,
  validateConfig,
} from './config.js';
export type {
  KnownTrackConfig,
  ConnectionConfig,
  PlaybackTuningConfig,
  LatencyConfig,
  QualityConfig,
  RecoveryConfig,
  AudioSpecificConfig,
  ClockConfig,
  FactoryConfig,
  TransformConfig,
  DebugConfig,
} from './config.js';

// ─── Interfaces ──────────────────────────────────────────────────────

export type {
  VideoDecoderLike,
  AudioDecoderLike,
  VideoRendererLike,
  AudioOutputLike,
  MediaSourceLike,
} from './interfaces.js';

// ─── Command Dispatcher ──────────────────────────────────────────────

/** @experimental Advanced API — may change between minor versions. */
export { CommandDispatcher } from './command-dispatcher.js';
/** @experimental Advanced API — may change between minor versions. */
export type { CommandDispatcherOptions } from './command-dispatcher.js';

// ─── Stats ────────────────────────────────────────────────────────────

/** @experimental Advanced API — may change between minor versions. */
export { StatsAccumulator } from './stats.js';
export type { PlayerStats, TTFFBreakdown } from './stats.js';

// ─── Internal managers (exported for advanced use / testing) ─────────

/** @experimental Advanced API — may change between minor versions. */
export { CatalogManager } from './catalog-manager.js';
/** @experimental Advanced API — may change between minor versions. */
export { QualityController } from './quality-controller.js';
/** @experimental Advanced API — may change between minor versions. */
export type { QualityControllerConfig, SelectionConstraints, SelectedTracks } from './quality-controller.js';
/** @experimental Advanced API — may change between minor versions. */
export { SubscriptionManager } from './subscription-manager.js';

// ─── Watchdog (diagnostics) ─────────────────────────────────────────

/** @experimental Advanced API — may change between minor versions. */
export { WatchdogController } from './watchdog.js';
/** @experimental Advanced API — may change between minor versions. */
export type { WatchdogOptions, WatchdogTimeout, WatchdogWarning } from './watchdog.js';
