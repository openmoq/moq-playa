/**
 * Player event types — typed events covering the full player lifecycle.
 *
 * Each event is grounded in a spec section. Events bridge the gap
 * between the sans-I/O core (which returns actions/commands) and
 * application code (which listens for events).
 *
 * @see draft-ietf-moq-transport-16 §3 (Session)
 * @see draft-ietf-moq-transport-16 §5 (Subscriptions)
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @see draft-ietf-moq-loc-01 §2.3 (LOC Headers)
 * @module
 */

import type { PlayerStateValue } from './state.js';
import type { RecoveryAction, DecoderCommand } from '@moqt/playback';
import type { CatalogState, SapTimelineEntry, EventTimelineRecord } from '@moqt/msf';
import type { PlayerError } from './errors.js';

// ─── Session Events ──────────────────────────────────────────────────

/**
 * Session is connecting to the relay.
 * @see draft-ietf-moq-transport-16 §3.3 (CLIENT_SETUP)
 */
export interface SessionConnectingEvent {
  readonly type: 'session_connecting';
  readonly url: string;
}

/**
 * Session handshake complete (SERVER_SETUP received).
 * @see draft-ietf-moq-transport-16 §3.4 (SERVER_SETUP)
 */
export interface SessionEstablishedEvent {
  readonly type: 'session_established';
  readonly selectedVersion: bigint;
}

/**
 * GOAWAY received — server is draining.
 * Player SHOULD connect to newSessionUri in background and migrate subscriptions.
 * @see draft-ietf-moq-transport-16 §3.7 (GOAWAY)
 */
export interface SessionGoawayEvent {
  readonly type: 'session_goaway';
  readonly newSessionUri?: string;
}

/**
 * Session migrated to a new relay after GOAWAY.
 * @see draft-ietf-moq-transport-16 §3.5 (Migration)
 * @see draft-ietf-moq-transport-16 §8.4.1 (Graceful Subscriber Relay Switchover)
 */
export interface SessionMigratedEvent {
  readonly type: 'session_migrated';
}

/**
 * Session closed (clean or with error).
 * @see draft-ietf-moq-transport-16 §3.6 (Session Termination)
 */
export interface SessionClosedEvent {
  readonly type: 'session_closed';
  readonly error?: number;
  readonly reason?: string;
}

/**
 * Session error (protocol violation, transport error).
 * @deprecated Use `error` event with structured PlayerError instead.
 * Retained for backward compatibility — fires alongside `error`.
 * @see draft-ietf-moq-transport-16 §13.4 (Error Codes)
 */
export interface SessionErrorEvent {
  readonly type: 'session_error';
  readonly error: Error;
}

/**
 * Structured error event — replaces session_error for new code.
 *
 * Provides severity, source, numeric code, and optional context
 * for programmatic error handling and recovery.
 */
export interface PlayerErrorEvent {
  readonly type: 'error';
  readonly error: PlayerError;
}

// ─── Catalog Events ──────────────────────────────────────────────────

/**
 * Raw catalog object received — fires before parsing.
 *
 * Useful for debugging catalog format issues, logging what the server
 * actually sent, or implementing custom catalog parsers.
 *
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 */
export interface CatalogRawEvent {
  readonly type: 'catalog_raw';
  /** Raw payload bytes from the catalog track object. */
  readonly payload: Uint8Array;
  /** Payload decoded as UTF-8 text (null if not valid UTF-8). */
  readonly text: string | null;
}

/**
 * Initial catalog received and parsed.
 * @see draft-ietf-moq-msf-00 §5.1 (Catalog)
 */
export interface CatalogReceivedEvent {
  readonly type: 'catalog_received';
  readonly catalog: CatalogState;
}

/**
 * Delta catalog update applied.
 * @see draft-ietf-moq-msf-00 §5.2 (Delta Updates)
 */
export interface CatalogUpdatedEvent {
  readonly type: 'catalog_updated';
  readonly catalog: CatalogState;
}

// ─── Subscription Events ─────────────────────────────────────────────

/**
 * Subscribed to a media track.
 * @see draft-ietf-moq-transport-16 §5.1 (Subscription Lifecycle)
 */
export interface TrackSubscribedEvent {
  readonly type: 'track_subscribed';
  readonly trackName: string;
  readonly mediaType: 'video' | 'audio';
  readonly requestId: bigint;
}

/**
 * Unsubscribed from a media track (PUBLISH_DONE or UNSUBSCRIBE).
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
 */
export interface TrackUnsubscribedEvent {
  readonly type: 'track_unsubscribed';
  readonly trackName: string;
  readonly reason: string;
}

/** Media track subscription refused by the relay. @see draft-ietf-moq-transport-16 §9.8 */
export interface TrackSubscribeFailedEvent {
  readonly type: 'track_subscribe_failed';
  readonly trackName: string;
  readonly mediaType: 'video' | 'audio';
  readonly requestId: bigint;
  readonly errorCode: bigint;
  readonly reason: string;
}

// ─── Playback Events (bridged from @moqt/playback) ──────────────────

/**
 * Group gap detected — missing objects in sequence.
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 */
export interface GapDetectedEvent {
  readonly type: 'gap_detected';
  readonly mediaType: 'video' | 'audio';
  readonly groupId: bigint;
}

/**
 * Skipped forward past a gap to the next sync point.
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status: End of Group)
 */
export interface SkipForwardEvent {
  readonly type: 'skip_forward';
  readonly mediaType: 'video' | 'audio';
  readonly fromGroupId: bigint;
  readonly toGroupId: bigint;
}

/**
 * A/V sync drift detected.
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
 */
export interface SyncDriftEvent {
  readonly type: 'sync_drift';
  readonly driftMs: number;
}

/**
 * Measured A/V skew (LOC observability, throttled to ~1/s): the rendered
 * video frame's CaptureTimestamp minus the capture timestamp audibly playing
 * at that instant. Positive = video ahead of audio. Diagnostic only — unlike
 * sync_drift (expected-vs-actual video render time), this measures actual
 * audio playout against actual video render.
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for sync)
 */
export interface SyncSkewEvent {
  readonly type: 'sync_skew';
  readonly skewMs: number;
  readonly ewmaMs: number;
}

/**
 * Waiting for a keyframe after a gap (decoder cannot decode delta frames).
 * @see draft-ietf-moq-loc-01 §2.3.2.2 (VideoFrameMarking)
 */
export interface KeyframeWaitingEvent {
  readonly type: 'keyframe_waiting';
  readonly mediaType: 'video' | 'audio';
  readonly groupId: bigint;
}

/**
 * Track has ended (PUBLISH_DONE with TRACK_ENDED received).
 * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE status 0x2)
 */
export interface TrackEndedEvent {
  readonly type: 'track_ended';
  readonly mediaType: 'video' | 'audio';
}

/** A partial video GOP was abandoned before END_OF_GROUP was received. */
export interface PartialGroupAbandonedEvent {
  readonly type: 'partial_group_abandoned';
  readonly mediaType: 'video' | 'audio';
  readonly fromGroupId: bigint;
  readonly toGroupId: bigint;
  readonly reason: string;
}

// ─── Recovery Events ─────────────────────────────────────────────────

/**
 * Player-level recovery actions, layered on top of the pipeline's
 * {@link RecoveryAction} union:
 *
 * - `jump_to_live` — persistent stalls flushed the backlog and resubscribed
 *   from the live edge.
 * - `track_restart` — the media-liveness ladder restarted a starved track's
 *   delivery (REQUEST_UPDATE refresh or full resubscribe).
 */
export type PlayerRecoveryAction =
  | RecoveryAction
  | { readonly type: 'jump_to_live' }
  | {
    readonly type: 'track_restart';
    readonly mediaType: 'video' | 'audio';
    readonly trackName: string;
    readonly attempt: number;
  };

/**
 * Recovery controller recommends an action.
 * @see draft-ietf-moq-transport-16 §7 (Priorities)
 * @see draft-ietf-moq-transport-16 §13.4.3 (TOO_FAR_BEHIND)
 * @see draft-ietf-moq-transport-16 §13.4.4 (DELIVERY_TIMEOUT)
 */
export interface RecoveryActionEvent {
  readonly type: 'recovery_action';
  readonly action: PlayerRecoveryAction;
}

// ─── Decoder Command Events ─────────────────────────────────────────

/**
 * Decoder command produced by the PlaybackPipeline.
 * The browser adapter consumes these to drive WebCodecs/Canvas/AudioContext.
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 */
export interface DecoderCommandEvent {
  readonly type: 'decoder_command';
  readonly command: DecoderCommand;
}

// ─── Object Delivery Events ─────────────────────────────────────────

/**
 * Media object received from a subscribed track.
 *
 * Emitted after object routing, LOC header parsing, and objectTransform.
 * Applications use this to feed objects into WebCodecs or other consumers.
 *
 * @see draft-ietf-moq-transport-16 §10.4 (Data Streams)
 * @see draft-ietf-moq-loc-01 §2.3 (LOC Header Extensions)
 */
export interface MediaObjectEvent {
  readonly type: 'media_object';
  readonly mediaType: 'video' | 'audio';
  readonly trackName: string;
  readonly groupId: bigint;
  readonly objectId: bigint;
  readonly kind: 'data' | 'gap';
  readonly payload?: Uint8Array;
  readonly extensions?: Uint8Array;
  readonly status?: bigint;
  readonly captureTimestamp?: bigint;
  readonly isKeyframe?: boolean;
}

// ─── Rendering Events ────────────────────────────────────────────────

/**
 * First video frame rendered to the display surface.
 */
export interface FirstFrameEvent {
  readonly type: 'first_frame';
}

/**
 * Playback stalled — no frames rendered for longer than threshold.
 */
export interface StallEvent {
  readonly type: 'stall';
  readonly durationMs: number;
}

/**
 * Quality switch initiated (ABR) — `selectVideoTrack` accepted the
 * request and started subscribing to the new track. The switch is NOT
 * yet committed; expect either `quality_switched` (success) or
 * `quality_switch_failed` (rollback) to follow.
 *
 * UI affordance: render a "switching to ..." spinner here.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 */
export interface QualitySwitchingEvent {
  readonly type: 'quality_switching';
  readonly fromTrackName: string;
  readonly toTrackName: string;
  readonly reason: string;
}

/**
 * Quality switch committed — the new track is now driving decode and
 * rendering. For CMAF codec changes this fires after
 * `mediaSource.changeType()` resolves and the staged keyframe is
 * appended; for same-codec/LOC switches it fires on the next-group
 * keyframe boundary.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 */
export interface QualitySwitchedEvent {
  readonly type: 'quality_switched';
  readonly fromTrackName: string;
  readonly toTrackName: string;
  readonly reason: string;
}

/**
 * Quality switch rolled back — the new track could not be committed
 * (e.g. `mediaSource.changeType()` rejected, init bytes missing). The
 * old track stayed subscribed and continues to play.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 */
export interface QualitySwitchFailedEvent {
  readonly type: 'quality_switch_failed';
  readonly fromTrackName: string;
  readonly toTrackName: string;
  readonly reason: string;
  readonly error: Error;
}

/**
 * Live catch-up state changed — activated, rate adjusted, or deactivated.
 *
 * Emitted when the player adjusts playback rate to catch up to the live
 * edge, or when catch-up deactivates after reaching the target latency.
 *
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for latency measurement)
 */
export interface CatchUpChangedEvent {
  readonly type: 'catch_up_changed';
  readonly active: boolean;
  readonly rate: number;
  readonly latencyMs: number;
  readonly targetMs: number;
}

// ─── Namespace Discovery Events ──────────────────────────────────────

/**
 * A namespace suffix was discovered on a namespace subscription.
 * @see draft-ietf-moq-transport-16 §6.1
 * @see draft-ietf-moq-transport-16 §9.25
 */
export interface NamespaceDiscoveredEvent {
  readonly type: 'namespace_discovered';
  readonly requestId: bigint;
  readonly namespaceSuffix: Uint8Array[];
}

/**
 * Namespace discovery completed (NAMESPACE_DONE received).
 * @see draft-ietf-moq-transport-16 §9.25
 */
export interface NamespaceDoneEvent {
  readonly type: 'namespace_done';
  readonly requestId: bigint;
  readonly namespaceSuffix: Uint8Array[];
}

/**
 * The peer has announced a full Track Namespace via control-stream
 * PUBLISH_NAMESPACE. Fires for both v14 and v16 control-stream
 * announcements (regardless of whether the player issued a matching
 * SUBSCRIBE_NAMESPACE first).
 *
 * @see draft-ietf-moq-transport-16 §9.20, §6.2
 * @see draft-ietf-moq-transport-14 §9.23, §6.2
 */
export interface NamespaceAnnouncedEvent {
  readonly type: 'namespace_announced';
  /** Publisher's PUBLISH_NAMESPACE request ID. */
  readonly requestId: bigint;
  /** Full track namespace tuple. */
  readonly trackNamespace: Uint8Array[];
}

/**
 * The peer has withdrawn a previously announced Track Namespace via
 * control-stream PUBLISH_NAMESPACE_DONE.
 *
 * @see draft-ietf-moq-transport-16 §9.22
 * @see draft-ietf-moq-transport-14 §9.26
 */
export interface NamespaceAnnouncementDoneEvent {
  readonly type: 'namespace_announcement_done';
  /** Publisher's PUBLISH_NAMESPACE request ID. */
  readonly requestId: bigint;
  /** Full track namespace tuple, when carried (v14 only). */
  readonly trackNamespace?: Uint8Array[];
}

// ─── Timeline Events ────────────────────────────────────────────────

/**
 * First media timeline payload received and parsed.
 * Duration may be known from catalog trackDuration or from timeline entries.
 * @see draft-ietf-moq-msf-00 §7 (Media Timeline track)
 */
export interface TimelineLoadedEvent {
  readonly type: 'timeline_loaded';
  readonly trackName: string;
  readonly entryCount: number;
  readonly duration?: number;
}

/**
 * Media timeline entries updated (incremental update received).
 * @see draft-ietf-moq-msf-00 §7.3 (Media Timeline track updating)
 */
export interface TimelineUpdatedEvent {
  readonly type: 'timeline_updated';
  readonly trackName: string;
  readonly entryCount: number;
  readonly duration?: number;
}

/**
 * Duration became known or changed.
 * For VOD: known from catalog trackDuration (§5.1.37).
 * For live: derived from timeline extent, grows over time.
 */
export interface DurationChangedEvent {
  readonly type: 'duration_changed';
  readonly durationMs: number;
}

// ─── SAP / Event Timeline Events ────────────────────────────────────

/**
 * SAP (Stream Access Point) events received from a CMSF SAP timeline track.
 *
 * Emitted when a CMSF SAP timeline object (eventType "org.ietf.moq.cmsf.sap")
 * is received. Each SAP entry identifies the MOQT location and earliest
 * presentation time of a random access point in the media track.
 *
 * Applications may use this to implement keyframe-accurate seeking,
 * adaptive bitrate switching, and start-of-group synchronization.
 *
 * @see draft-ietf-moq-cmsf-00 §3.6.1 (SAP Type Timeline)
 * @see draft-ietf-moq-msf-00 §8 (Event Timeline track)
 */
export interface SapEventReceivedEvent {
  readonly type: 'sap_event';
  /** Name of the SAP timeline track in the catalog. */
  readonly trackName: string;
  /** The SAP timeline entries parsed from this object. */
  readonly entries: SapTimelineEntry[];
}

/**
 * Generic event timeline object received from an eventtimeline track.
 *
 * Emitted for eventtimeline tracks that are NOT CMSF SAP tracks
 * (i.e., eventType is not "org.ietf.moq.cmsf.sap"). The raw parsed
 * records are provided for application-level handling.
 *
 * @see draft-ietf-moq-msf-00 §8 (Event Timeline track)
 */
export interface EventTimelineReceivedEvent {
  readonly type: 'event_timeline';
  /** Name of the eventtimeline track in the catalog. */
  readonly trackName: string;
  /** EventType URI from the catalog (§5.1.13). */
  readonly eventType: string;
  /** The event records parsed from this object. */
  readonly records: EventTimelineRecord[];
}

// ─── Seek Events ────────────────────────────────────────────────────

/**
 * Seek operation initiated — pipelines being reset, REQUEST_UPDATE being sent.
 * @see draft-ietf-moq-transport-16 §9.2.2.5 (SUBSCRIPTION_FILTER in REQUEST_UPDATE)
 * @see draft-ietf-moq-msf-00 §7 (Media Timeline for PTS→location lookup)
 */
export interface SeekingEvent {
  readonly type: 'seeking';
  readonly targetTimeMs: number;
}

/**
 * Seek operation complete — REQUEST_UPDATE sent, awaiting objects at new position.
 * @see draft-ietf-moq-transport-16 §9.2.2.5 (SUBSCRIPTION_FILTER)
 */
export interface SeekedEvent {
  readonly type: 'seeked';
  readonly actualTimeMs: number;
  readonly groupId: number;
  readonly objectId: number;
}

// ─── Lifecycle Events ────────────────────────────────────────────────

/**
 * Player state changed.
 */
export interface StateChangedEvent {
  readonly type: 'state_changed';
  readonly from: PlayerStateValue;
  readonly to: PlayerStateValue;
}

// ─── Event Map ───────────────────────────────────────────────────────

/**
 * All player events. Keys are event names, values are event data types.
 * Used as the type parameter for TypedEmitter<PlayerEventMap>.
 */
export interface PlayerEventMap {
  // Session
  session_connecting: SessionConnectingEvent;
  session_established: SessionEstablishedEvent;
  session_goaway: SessionGoawayEvent;
  session_migrated: SessionMigratedEvent;
  session_closed: SessionClosedEvent;
  session_error: SessionErrorEvent;

  // Errors (structured)
  error: PlayerErrorEvent;

  // Catalog
  catalog_raw: CatalogRawEvent;
  catalog_received: CatalogReceivedEvent;
  catalog_updated: CatalogUpdatedEvent;

  // Subscription
  track_subscribed: TrackSubscribedEvent;
  track_unsubscribed: TrackUnsubscribedEvent;
  track_subscribe_failed: TrackSubscribeFailedEvent;

  // Decoder commands
  decoder_command: DecoderCommandEvent;

  // Object delivery
  media_object: MediaObjectEvent;

  // Playback
  gap_detected: GapDetectedEvent;
  skip_forward: SkipForwardEvent;
  sync_drift: SyncDriftEvent;
  sync_skew: SyncSkewEvent;
  keyframe_waiting: KeyframeWaitingEvent;
  track_ended: TrackEndedEvent;
  partial_group_abandoned: PartialGroupAbandonedEvent;

  // Recovery
  recovery_action: RecoveryActionEvent;

  // Rendering
  first_frame: FirstFrameEvent;
  stall: StallEvent;
  quality_switching: QualitySwitchingEvent;
  quality_switched: QualitySwitchedEvent;
  quality_switch_failed: QualitySwitchFailedEvent;
  catch_up_changed: CatchUpChangedEvent;

  // Namespace discovery
  namespace_discovered: NamespaceDiscoveredEvent;
  namespace_done: NamespaceDoneEvent;
  namespace_announced: NamespaceAnnouncedEvent;
  namespace_announcement_done: NamespaceAnnouncementDoneEvent;

  // Timeline
  timeline_loaded: TimelineLoadedEvent;
  timeline_updated: TimelineUpdatedEvent;
  duration_changed: DurationChangedEvent;

  // SAP / Event Timeline
  sap_event: SapEventReceivedEvent;
  event_timeline: EventTimelineReceivedEvent;

  // Seek
  seeking: SeekingEvent;
  seeked: SeekedEvent;

  // Lifecycle
  state_changed: StateChangedEvent;
}

/** Union of all player event types. */
export type PlayerEvent = PlayerEventMap[keyof PlayerEventMap];
