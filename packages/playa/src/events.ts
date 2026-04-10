/**
 * UI-friendly event map for @playa/player.
 *
 * Event names mirror HTMLMediaElement conventions where possible
 * (timeupdate, volumechange, durationchange) for familiarity.
 * Protocol-level events from @moqt/player are absorbed and re-emitted
 * as higher-level UI events.
 *
 * @module
 */

import type { Level, AudioTrack, PlayerStats, PlayerState } from './types.js';

/** Event map for Player.on() / Player.off(). */
export interface PlayerEventMap {
  /** Catalog loaded, tracks available, ready for play(). */
  'ready': ReadyEvent;
  /** play() was called. */
  'play': Record<string, never>;
  /** pause() was called. */
  'pause': Record<string, never>;
  /** First frame rendered — media is actually playing. */
  'playing': Record<string, never>;
  /** Stream ended (PUBLISH_DONE). */
  'ended': Record<string, never>;

  /** Periodic current time update (~4Hz). Wire to seek bar. */
  'timeupdate': TimeupdateEvent;
  /** Duration became available or changed. */
  'durationchange': DurationchangeEvent;
  /** Seek started. */
  'seeking': SeekingEvent;
  /** Seek completed. */
  'seeked': SeekedEvent;

  /** Volume or mute state changed. */
  'volumechange': VolumechangeEvent;

  /** Quality levels available from catalog. */
  'levelsloaded': LevelsloadedEvent;
  /** Quality level switched (ABR or manual). */
  'qualitychange': QualitychangeEvent;

  /** Playback stalled (buffering). */
  'stall': StallEvent;
  /** Playback resumed after stall. */
  'unstall': Record<string, never>;

  /** Periodic stats update (~1Hz). Wire to stats overlay. */
  'stats': PlayerStats;

  /** Error occurred. Check severity for recovery. */
  'error': ErrorEvent;

  /** Player state changed. */
  'statechange': StatechangeEvent;
}

export interface ReadyEvent {
  readonly levels: Level[];
  readonly audioTracks: AudioTrack[];
  readonly duration?: number | undefined;
}

export interface TimeupdateEvent {
  readonly currentTime: number;
}

export interface DurationchangeEvent {
  readonly duration: number;
}

export interface SeekingEvent {
  readonly targetTime: number;
}

export interface SeekedEvent {
  readonly currentTime: number;
}

export interface VolumechangeEvent {
  readonly volume: number;
  readonly muted: boolean;
}

export interface LevelsloadedEvent {
  readonly levels: Level[];
}

export interface QualitychangeEvent {
  readonly level: Level;
  readonly auto: boolean;
}

export interface StallEvent {
  readonly durationMs: number;
}

export interface ErrorEvent {
  readonly severity: 'fatal' | 'recoverable';
  readonly code: number;
  readonly message: string;
}

export interface StatechangeEvent {
  readonly state: PlayerState;
}
