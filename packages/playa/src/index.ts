/**
 * @openmoq/playa — Batteries-included MoQ media player.
 *
 * ```ts
 * import { Player } from '@openmoq/playa';
 * const player = new Player(container, { url, namespace });
 * await player.load();
 * player.play();
 * ```
 *
 * @module
 */

export { Player } from './player.js';
export { catToken, AuthorizationError } from '@openmoq/player';
export type { PlayerAuthorization, AuthorizationToken, AuthorizationProvider, AuthorizationContext, AuthorizationOperation, VideoPresentation, VideoPlaybackQualityStats, VideoPresentationObservation, AudioSelectionOptions, AudioTimelineReference, MediaSelectionOptions, MediaTimelineAnchor, MediaTimelineReference } from '@openmoq/player';
export type { PlayerOptions, Level, AudioTrack, PlayerStats, PlayerState, Program, View } from './types.js';
export type {
  PlayerEventMap,
  ReadyEvent,
  TimeupdateEvent,
  DurationchangeEvent,
  SeekingEvent,
  SeekedEvent,
  VolumechangeEvent,
  LevelsloadedEvent,
  QualitychangeEvent,
  AudiochangeEvent,
  AudiochangefailedEvent,
  StallEvent,
  ErrorEvent,
  StatechangeEvent,
} from './events.js';
export { detectStrategy } from './auto-detect.js';
export type { DecoderStrategy } from './auto-detect.js';
