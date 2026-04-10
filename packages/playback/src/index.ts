/**
 * @moqt/playback — Sans-I/O playback core.
 *
 * Jitter buffer, A/V sync, gap detection, decoder state machine,
 * and pipeline orchestrator — all testable in Node.js without browser APIs.
 *
 * @see draft-ietf-moq-loc-01 §4 (Application Mapping)
 * @see draft-ietf-moq-transport-16 §10 (Objects)
 * @module
 */

// ─── Types ───────────────────────────────────────────────────────────

export type {
    ClockSource,
    DecoderCommand,
    ConfigureCommand,
    DecodeVideoCommand,
    DecodeAudioCommand,
    FlushCommand,
    ResetCommand,
    SetPlaybackRateCommand,
    PlaybackEvent,
    GapDetectedEvent,
    SkipForwardEvent,
    SyncDriftEvent,
    KeyframeWaitingEvent,
    KeyframeValidationFailedEvent,
    TrackEndedEvent,
    RecoveryEvent,
    CatchUpState,
    CatchUpChangedEvent,
    BacklogShedEvent,
    PlaybackConfig,
    DecoderFeedback,
    QueuePressureFeedback,
    DecodeErrorFeedback,
    FrameRenderedFeedback,
    FlushCompleteFeedback,
} from './types.js';

// ─── Jitter Buffer ──────────────────────────────────────────────────

export { JitterBuffer } from './jitter-buffer.js';

// ─── Gap Detector ───────────────────────────────────────────────────

export { GapDetector, GapAction } from './gap-detector.js';
export type { GapActionValue, GapDecision } from './gap-detector.js';

// ─── Decoder State ──────────────────────────────────────────────────

export { DecoderStateMachine, DecoderState } from './decoder-state.js';
export type { DecoderStateValue, FrameDecision } from './decoder-state.js';

// ─── Sync Controller ───────────────────────────────────────────────

export { SyncController } from './sync.js';
export type { RenderTiming, WallClockSource, SyncControllerConfig } from './sync.js';

// ─── Recovery ───────────────────────────────────────────────────────

export { DefaultRecoveryController } from './recovery.js';
export type { DefaultRecoveryConfig, RecoveryController, RecoveryTrigger, RecoveryAction } from './recovery.js';

// ─── Adaptive Tolerance ─────────────────────────────────────────────

export { AdaptiveToleranceController, RecoveryPhase, DEFAULT_TOLERANCE_CONFIG } from './adaptive-tolerance.js';
export type { ToleranceConfig, TickResult } from './adaptive-tolerance.js';

// ─── Render Scheduler ───────────────────────────────────────────────

export { RenderScheduler } from './render-scheduler.js';
export type { RenderSchedulerOptions } from './render-scheduler.js';

// ─── Startup Buffer ─────────────────────────────────────────────────

export { StartupBuffer, classifyNetwork } from './startup-buffer.js';
export type { StartupParams } from './startup-buffer.js';

// ─── Keyframe Validator ─────────────────────────────────────────────

export { isKeyframePayload } from './keyframe-validator.js';

// ─── Pipeline ───────────────────────────────────────────────────────

export { PlaybackPipeline } from './pipeline.js';
export type { PipelineOptions } from './pipeline.js';

export { BandwidthEstimator } from './bandwidth-estimator.js';

export { BufferBasedController } from './buffer-based-controller.js';
export type { AbrTrack, AbrSignals, AbrDecision, BufferBasedConfig } from './buffer-based-controller.js';
