/**
 * Sans-I/O playback core type definitions.
 *
 * These types define the boundary between the playback core (testable in
 * Node.js) and the browser adapter (WebCodecs, Canvas, AudioContext).
 *
 * @see draft-ietf-moq-loc-01 §4 (Application Mapping)
 * @see draft-ietf-moq-transport-16 §10 (Objects)
 * @module
 */

import type { VideoChunkInit, AudioChunkInit } from '@moqt/loc';
import type { RecoveryAction } from './recovery.js';

// ─── Clock ──────────────────────────────────────────────────────────

/**
 * Injectable clock source for testability.
 *
 * Browser adapter injects `performance.now() * 1000` (microseconds).
 * Tests inject a manual clock with deterministic time.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp uses microseconds)
 */
export interface ClockSource {
    /** Current time in microseconds (monotonic). */
    now(): number;
}

// ─── Decoder Commands ───────────────────────────────────────────────

/**
 * Commands emitted by the playback core to the browser decoder adapter.
 * The core never calls WebCodecs directly — it produces these commands.
 */
export type DecoderCommand =
    | ConfigureCommand
    | DecodeVideoCommand
    | DecodeAudioCommand
    | FlushCommand
    | ResetCommand
    | SetPlaybackRateCommand;

/** Configure the decoder with codec extradata. @see draft-ietf-moq-loc-01 §2.3.2.1 */
export interface ConfigureCommand {
    readonly type: 'configure';
    readonly mediaType: 'video' | 'audio';
    readonly config: Uint8Array;
}

/** Decode a video chunk at the specified render time. @see draft-ietf-moq-loc-01 §2.1 */
export interface DecodeVideoCommand {
    readonly type: 'decode_video';
    readonly chunk: VideoChunkInit;
    readonly renderTimeUs: number;
    /**
     * CaptureTimestamp in microseconds — for PTS-anchored render scheduling.
     * The renderer should use this (via RenderScheduler) instead of renderTimeUs
     * for correct frame pacing after async decode.
     * @see draft-ietf-moq-loc-01 §2.3.1.1
     */
    readonly captureTimestampUs?: bigint;
}

/** Decode an audio chunk at the specified render time. @see draft-ietf-moq-loc-01 §2 */
export interface DecodeAudioCommand {
    readonly type: 'decode_audio';
    readonly chunk: AudioChunkInit;
    readonly renderTimeUs: number;
}

/** Flush the decoder (drain pending frames). */
export interface FlushCommand {
    readonly type: 'flush';
    readonly mediaType: 'video' | 'audio';
}

/** Reset the decoder (e.g., after a gap). */
export interface ResetCommand {
    readonly type: 'reset';
    readonly mediaType: 'video' | 'audio';
    readonly reason: string;
}

/** Adjust audio playback rate for live catch-up. @see draft-ietf-moq-msf-00 §5.1.16 */
export interface SetPlaybackRateCommand {
    readonly type: 'set_playback_rate';
    readonly rate: number;
}

// ─── Playback Events ────────────────────────────────────────────────

/**
 * Observability events emitted by the playback core.
 */
export type PlaybackEvent =
    | GapDetectedEvent
    | SkipForwardEvent
    | SyncDriftEvent
    | KeyframeWaitingEvent
    | KeyframeValidationFailedEvent
    | TrackEndedEvent
    | RecoveryEvent
    | CatchUpChangedEvent
    | BacklogShedEvent
    | PartialGroupAbandonedEvent;

/** A partial video GOP was abandoned before END_OF_GROUP was received. */
export interface PartialGroupAbandonedEvent {
    readonly type: 'partial_group_abandoned';
    readonly fromGroupId: bigint;
    readonly toGroupId: bigint;
    readonly reason: string;
}

/** Old groups were dropped before decode to prevent backlog buildup. */
export interface BacklogShedEvent {
    readonly type: 'backlog_shed';
    readonly droppedGroups: number;
    readonly remainingGroups: number;
    readonly reason: string;
}

/** A group gap was detected. @see draft-ietf-moq-transport-16 §10.2.1.1 */
export interface GapDetectedEvent {
    readonly type: 'gap_detected';
    readonly groupId: bigint;
}

/** Skipped forward past a gap to a new group. */
export interface SkipForwardEvent {
    readonly type: 'skip_forward';
    readonly fromGroupId: bigint;
    readonly toGroupId: bigint;
}

/** A/V sync drift detected. @see draft-ietf-moq-loc-01 §2.3.1.1 */
export interface SyncDriftEvent {
    readonly type: 'sync_drift';
    readonly driftUs: number;
}

/** Waiting for a keyframe after a gap. @see draft-ietf-moq-loc-01 §2.3.2.2 */
export interface KeyframeWaitingEvent {
    readonly type: 'keyframe_waiting';
    readonly groupId: bigint;
}

/** Keyframe payload validation failed — bitstream does not start with a keyframe. @see draft-ietf-moq-loc-01 §4.2 */
export interface KeyframeValidationFailedEvent {
    readonly type: 'keyframe_validation_failed';
    readonly groupId: bigint;
    readonly objectId: bigint;
    readonly codec: string;
}

/** Track has ended (END_OF_TRACK received). @see draft-ietf-moq-transport-16 §10.2.1.1 */
export interface TrackEndedEvent {
    readonly type: 'track_ended';
}

/** Recovery controller recommends an action (local policy). */
export interface RecoveryEvent {
    readonly type: 'recovery';
    readonly action: RecoveryAction;
}

/**
 * Catch-up state — latency measurement and rate adjustment.
 *
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for latency measurement)
 */
export interface CatchUpState {
    /** Whether catch-up is currently active. */
    readonly active: boolean;
    /** Current playback rate (1.0 = normal, >1.0 = catching up). */
    readonly currentRate: number;
    /** Current end-to-end latency in milliseconds. */
    readonly latencyMs: number;
    /** Target latency in milliseconds. */
    readonly targetMs: number;
}

/** Catch-up state changed (activated, rate adjusted, or deactivated). @see draft-ietf-moq-msf-00 §5.1.16 */
export interface CatchUpChangedEvent {
    readonly type: 'catch_up_changed';
    readonly state: CatchUpState;
}

// ─── Decoder Feedback ───────────────────────────────────────────────

/**
 * Feedback from browser adapters back to the pipeline.
 *
 * Flow: adapter → CommandDispatcher → player → pipeline.handleFeedback()
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp for drift detection)
 */
export type DecoderFeedback =
    | QueuePressureFeedback
    | DecodeErrorFeedback
    | FrameRenderedFeedback
    | FlushCompleteFeedback;

/** Decoder queue getting deep — signal to throttle draining. */
export interface QueuePressureFeedback {
    readonly type: 'queue_pressure';
    readonly mediaType: 'video' | 'audio';
    readonly depth: number;
    readonly maxRecommended: number;
}

/** A decode() call failed. */
export interface DecodeErrorFeedback {
    readonly type: 'decode_error';
    readonly mediaType: 'video' | 'audio';
    readonly message: string;
}

/** Actual render time for drift detection — video only. @see draft-ietf-moq-loc-01 §2.3.1.1 */
export interface FrameRenderedFeedback {
    readonly type: 'frame_rendered';
    readonly mediaType: 'video';
    readonly captureTimestampUs: bigint;
    readonly actualRenderUs: number;
}

/** Flush completed (forward compatibility — currently a no-op). */
export interface FlushCompleteFeedback {
    readonly type: 'flush_complete';
    readonly mediaType: 'video' | 'audio';
}

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Playback pipeline configuration.
 */
export interface PlaybackConfig {
    /** Maximum wait time in microseconds for a missing group before skip-forward. */
    readonly gapTimeoutUs: number;
    /** A/V sync drift threshold in microseconds before resync. */
    readonly driftThresholdUs: number;
    /** Maximum number of objects in the jitter buffer. */
    readonly maxBufferDepth: number;

    // ── Catch-up (Item 8) ───────────────────────────────────────
    /** Target end-to-end latency in milliseconds. @see draft-ietf-moq-msf-00 §5.1.16 */
    readonly targetLatencyMs?: number;
    /** Maximum playback rate for catch-up (e.g., 1.1 = 10% faster). Default: 1.0 (disabled). */
    readonly maxCatchUpRate?: number;
    /** Latency above target before catch-up activates (ms). Default: 500. */
    readonly catchUpThresholdMs?: number;
    /** Latency above target before catch-up deactivates (ms, hysteresis). Default: 50. */
    readonly catchUpRecoveryMs?: number;

    // ── Bounded release ───────────────────────────────────────────
    /**
     * Maximum objects to release from the jitter buffer per tick (video only).
     * Prevents greedy drain from flooding the decoder with backlog.
     * 0 = unlimited (greedy drain, legacy behavior). Default: 5.
     */
    readonly maxReleasePerTick?: number;
    /**
     * Maximum groups allowed in the jitter buffer before shedding old ones.
     * When exceeded, oldest groups are dropped before decode.
     * 0 = unlimited (no shedding). Default: 3.
     */
    readonly maxBacklogGroups?: number;

    // ── Adaptive tolerance ───────────────────────────────────────
    /** Enable adaptive jitter tolerance. Auto-calibrates gap timeout and drift threshold. */
    readonly adaptiveTolerance?: boolean;

    // ── Startup buffer ───────────────────────────────────────────
    /**
     * QUIC handshake RTT in milliseconds. Used to classify network conditions
     * and determine startup buffer depth. If not provided, defaults to
     * conservative WAN parameters (8 frames / 300ms).
     */
    readonly handshakeRttMs?: number;
}
