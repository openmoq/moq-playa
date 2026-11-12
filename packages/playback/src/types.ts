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

import type { VideoChunkInit, AudioChunkInit, LocHeaders } from '@openmoq/loc';
import type { RecoveryAction } from './recovery.js';
import type { RenderTiming } from './sync.js';

/**
 * Host-parsed coded unit in one actual wire Object, in decode order.
 * sampleIndex is local to this batch (0..length-1), never a wire Object ID.
 * Records are snapshotted on admission. Bytes (including config and chunk.data)
 * are borrowed immutable, including backing sizes, until batch retirement.
 * The pipeline bounds retained backing bytes; hosts bound other storage/native
 * ownership separately. sourceTimestamp retains the exact signed PTS and scale.
 */
export interface PlaybackSample {
    readonly sampleIndex: number;
    readonly headers: LocHeaders;
    readonly chunk: VideoChunkInit | AudioChunkInit;
}

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

/** Mapped input timing; queries never establish a clock or rewrite raw metadata. */
export interface AudioTimingSource {
    /** Capture the immutable producing context before timing computation.
     * Null refuses this armed input; omission retains ordinary scheduling. */
    captureOutputTiming?(rawSourceUs: bigint): AudioRenderTiming | null;
    computeAudioRenderTime(sourceTimeUs: bigint): RenderTiming | null;
    /** Called only for a current input when the shared reference is absent. */
    establishReference?(sourceTimeUs: bigint): void;
}

export interface VideoTimingSource {
    /** Capture a producing input context before timing computation.
     * Null refuses this armed input; omission preserves mapped scheduling.
     * The context is not itself proof that a decoded frame was presented. */
    captureVideoOutputTiming?(rawSourceUs: bigint): VideoRenderTiming | null;
    computeVideoRenderTime(sourceTimeUs: bigint): RenderTiming | null;
    /** Output-time recomputation never calls this input-only hook. */
    establishReference?(sourceTimeUs: bigint): void;
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
    | ResetCommand;

/** Configure the decoder with codec extradata. @see draft-ietf-moq-loc-01 §2.3.2.1 */
export interface ConfigureCommand {
    readonly type: 'configure';
    readonly mediaType: 'video' | 'audio';
    readonly config: Uint8Array;
}

/** Producing input's nominal output schedule, before the renderer's playout cushion. */
export interface VideoRenderTiming {
    /** Null means this producing context no longer supplies a proven schedule. */
    readonly recomputeRenderTimeUs: () => number | null;
}

/** Producing audio input context; raw encoded bytes/timestamps stay unchanged. */
export interface AudioRenderTiming {
    readonly epoch: object;
    readonly sourceTimestampUs: bigint;
    /** Decoded PCM before this raw source boundary must not be presented. */
    readonly presentFromSourceUs: bigint;
    /** Output-stage schedule, including the engine's intended playout cushion.
     * Offset from this input's source point. Null retires the context.
     * Pure query, parallel to VideoRenderTiming; never establishes a clock. */
    readonly recomputeRenderTimeUs: (sourceOffsetUs: number) => number | null;
}

/** Decode a video chunk at the specified render time. @see draft-ietf-moq-loc-01 §2.1 */
export interface DecodeVideoCommand {
    readonly type: 'decode_video';
    readonly chunk: VideoChunkInit;
    readonly renderTimeUs: number;
    /** Optional application-local identity; never a wire field or payload. */
    readonly inputToken?: object;
    /** Immutable producing context for mapped output; raw chunk timestamps stay unchanged. */
    readonly renderTiming?: VideoRenderTiming;
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
    /** Optional application-local identity; never a wire field or payload. */
    readonly inputToken?: object;
    /** Captured producing context; distinct from optional diagnostic identity. */
    readonly renderTiming?: AudioRenderTiming;
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

/**
 * Video PRESENTATION SCHEDULE drift: the renderer presented a frame later (or
 * earlier) than the exact time it was queued to present. This is NOT audio/video
 * skew — see `sync_skew` for that.
 */
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
    | FlushCompleteFeedback
    | {
        readonly type: 'audio_timing_unavailable';
        readonly mediaType: 'audio';
        readonly reason: 'decoder unsupported' | 'output unsupported' | 'output unproven' | 'context retired';
    };

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
    /**
     * The exact time this frame was scheduled to present. Absent when the
     * renderer cannot report it, in which case presentation-schedule drift is
     * suppressed rather than fabricated.
     */
    readonly scheduledRenderUs?: number;
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
    /** Video presentation-schedule drift threshold in microseconds. */
    readonly driftThresholdUs: number;
    /** Maximum number of objects in the jitter buffer. */
    readonly maxBufferDepth: number;

    // ── Bounded release ───────────────────────────────────────────
    /**
     * Maximum objects to release from the jitter buffer per tick (video only).
     * Optional sample batches count each coded sample as one release unit.
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

/** Actual local pipeline rejection; no publisher age or missing-object inference. */
export type PlaybackInputDiscardReason = 'treated as a replay' | 'stale group' | 'decoder reset' | 'skipped'
    | 'track superseded' | 'buffer full' | 'buffer eviction' | 'backlog shed' | 'awaiting keyframe' | 'late frame' | 'decoder policy';
export type PlaybackInputObserver = (input: object, reason: PlaybackInputDiscardReason) => void | Promise<void>;
