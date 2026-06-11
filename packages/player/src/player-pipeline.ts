/**
 * Pipeline creation and event/command handling — extracted from MoqtPlayer.
 *
 * Pure functions that take explicit parameters. No class state.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → VideoDecoderLike)
 * @see draft-ietf-moq-loc-01 §4.1 (audio → AudioDecoderLike)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps)
 * @module
 */

import { PlaybackPipeline, SyncController, DefaultRecoveryController } from '@moqt/playback';
import type {
  ClockSource,
  DecoderCommand,
  PlaybackEvent,
  PlaybackConfig,
  RecoveryAction,
  RecoveryController,
  DecoderFeedback,
} from '@moqt/playback';
import type { MoqtPlayerConfig } from './config.js';
import type { MediaSourceLike } from './interfaces.js';
import { CommandDispatcher } from './command-dispatcher.js';
import type { LoggerLike } from './logger.js';
import type { QualityController } from './quality-controller.js';
import type { TrackPackaging } from './subscription-manager.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Strip keys with `undefined` values from an object literal.
 * Required by `exactOptionalPropertyTypes`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defined(obj: Record<string, unknown>): any {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

// ─── Types ───────────────────────────────────────────────────────────

/** Track metadata for pipeline creation. */
export interface TrackInfo {
  video: {
    codec?: string;
    width?: number;
    height?: number;
    initData?: string;
    /** Separate init track name (catalogformat-01 §3.2.16). */
    initTrack?: string;
    packaging?: TrackPackaging;
  } | undefined;
  audio: {
    codec?: string;
    samplerate?: number;
    channels?: number;
    initData?: string;
    /** Separate init track name (catalogformat-01 §3.2.16). */
    initTrack?: string;
    packaging?: TrackPackaging;
  } | undefined;
  /** Whether the stream is live. Gates bounded release + backlog shedding. */
  isLive?: boolean;
}

/** Callbacks from pipeline to player. */
export interface PipelineCallbacks {
  onFirstFrame: () => void;
  onStall: (durationMs: number) => void;
  onDecodeError: (mediaType: 'video' | 'audio', error: Error) => void;
  onFrameRendered: (captureTimestampUs: number, actualRenderUs: number) => void;
  onFeedback: (fb: DecoderFeedback) => void;
  onCommand: (cmd: DecoderCommand) => void;
  onEvent: (mediaType: 'video' | 'audio', evt: PlaybackEvent) => void;
  /** Measured A/V skew at video render (µs, positive = video ahead). Optional observability. */
  onAvSkew?: (skewUs: number) => void;
}

/** Result of createPipelines — player stores these in its fields. */
export interface PipelineSet {
  videoPipeline: PlaybackPipeline | null;
  audioPipeline: PlaybackPipeline | null;
  syncController: SyncController;
  recoveryController: RecoveryController;
  commandDispatcher: CommandDispatcher | null;
  mediaSource: MediaSourceLike | null;
}

/** Context for handlePipelineEvent. */
export interface PipelineEventContext {
  emitEvent: (event: Record<string, unknown>) => void;
  log: LoggerLike;
  syncController: SyncController | null;
  syncResetThisTick: boolean;
  setSyncResetThisTick: (value: boolean) => void;
  recoveryHook: (action: RecoveryAction) => RecoveryAction | null;
}

/** Callbacks for handleRecoveryAction. */
export interface RecoveryCallbacks {
  onQualityReduced: (newTrack: { name: string; codec?: string; bitrate?: number; width?: number; height?: number }) => void;
  onResubscribe: (mediaType: 'video' | 'audio', startGroup?: bigint) => void;
  onTerminate: (reason: string) => void;
}

// ─── createPipelines ─────────────────────────────────────────────────

/**
 * Create PlaybackPipelines, SyncController, RecoveryController,
 * CommandDispatcher, and MediaSource from track info + config.
 *
 * Returns a PipelineSet struct — caller stores the fields.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → VideoDecoderLike)
 * @see draft-ietf-moq-loc-01 §4.1 (audio → AudioDecoderLike)
 * @see draft-ietf-moq-cmsf-00 §3 (CMAF Packaging)
 */
export function createPipelines(
  config: MoqtPlayerConfig,
  clock: ClockSource,
  trackInfo: TrackInfo,
  callbacks: PipelineCallbacks,
  handshakeRttMs?: number,
): PipelineSet {
  let mediaSource: MediaSourceLike | null = null;

  // ── Create MediaSource adapter for CMAF tracks ────────────────
  const hasCmafVideo = trackInfo.video?.packaging === 'cmaf';
  const hasCmafAudio = trackInfo.audio?.packaging === 'cmaf';
  const hasCmaf = hasCmafVideo || hasCmafAudio;

  if (hasCmaf && config.createMediaSource) {
    mediaSource = config.createMediaSource();

    // Defer initialize() when init data comes from a separate track (initTrack).
    // The player will call mediaSource.initialize() when the init track object arrives.
    // @see draft-ietf-moq-cmsf-00 §3.1 (Initialization headers)
    // @see draft-ietf-moq-catalogformat-01 §3.2.16 (initTrack)
    const needsDeferredInit =
      (hasCmafVideo && trackInfo.video?.initTrack && !trackInfo.video?.initData) ||
      (hasCmafAudio && trackInfo.audio?.initTrack && !trackInfo.audio?.initData);

    if (!needsDeferredInit) {
      // Inline initData — initialize immediately (existing path)
      const msConfig: {
        video?: { codec: string; initData: Uint8Array };
        audio?: { codec: string; initData: Uint8Array };
      } = {};

      if (hasCmafVideo && trackInfo.video?.codec) {
        msConfig.video = {
          codec: trackInfo.video.codec,
          initData: trackInfo.video.initData
            ? Uint8Array.from(atob(trackInfo.video.initData), c => c.charCodeAt(0))
            : new Uint8Array(0),
        };
      }
      if (hasCmafAudio && trackInfo.audio?.codec) {
        msConfig.audio = {
          codec: trackInfo.audio.codec,
          initData: trackInfo.audio.initData
            ? Uint8Array.from(atob(trackInfo.audio.initData), c => c.charCodeAt(0))
            : new Uint8Array(0),
        };
      }

      mediaSource.initialize(msConfig);
    }

    mediaSource.onFirstFrame = () => callbacks.onFirstFrame();
    mediaSource.onStall = (durationMs) => callbacks.onStall(durationMs);
    mediaSource.onError = (error) => callbacks.onDecodeError('video', error);
  }

  // ── PlaybackConfig ──────────────────────────────────────────────
  const playbackConfig: PlaybackConfig = {
    gapTimeoutUs: config.gapTimeoutMs! * 1000,
    driftThresholdUs: config.driftThresholdMs! * 1000,
    maxBufferDepth: config.maxBufferDepth!,
    adaptiveTolerance: true,
    ...(handshakeRttMs !== undefined ? { handshakeRttMs } : {}),
  };

  const syncController = new SyncController(defined({
    driftThresholdUs: playbackConfig.driftThresholdUs,
    dropThresholdUs: config.lateFrameThresholdMs! * 1000,
    clock,
    targetLatencyMs: config.targetLatencyMs,
    maxCatchUpRate: config.maxCatchUpRate,
    catchUpThresholdMs: config.catchUpThresholdMs,
    catchUpRecoveryMs: config.catchUpRecoveryMs,
  }));

  const recoveryController = config.createRecoveryController?.(clock)
    ?? new DefaultRecoveryController({
      gapEscalationThreshold: config.maxConsecutiveGaps!,
      maxDecodeErrors: config.maxDecodeErrors!,
    });

  // ── CommandDispatcher + browser adapters ────────────────────────
  // Only create WebCodecs adapters for LOC media types — CMAF goes through MSE.
  const videoDecoder = !hasCmafVideo ? config.createVideoDecoder?.() : undefined;
  const audioDecoder = !hasCmafAudio ? config.createAudioDecoder?.() : undefined;
  const renderer    = !hasCmafVideo ? config.createRenderer?.()     : undefined;
  const audioOutput = !hasCmafAudio ? config.createAudioOutput?.()  : undefined;

  let commandDispatcher: CommandDispatcher | null = null;

  if (videoDecoder || audioDecoder) {
    commandDispatcher = new CommandDispatcher(defined({
      videoDecoder,
      audioDecoder,
      renderer,
      audioOutput,
      videoCodec: trackInfo.video?.codec,
      videoWidth: trackInfo.video?.width,
      videoHeight: trackInfo.video?.height,
      audioCodec: trackInfo.audio?.codec,
      audioSampleRate: trackInfo.audio?.samplerate,
      audioChannels: trackInfo.audio?.channels,
      onFirstFrame: () => callbacks.onFirstFrame(),
      onStall: (durationMs: number) => callbacks.onStall(durationMs),
      onError: (mediaType: 'video' | 'audio', error: Error) => callbacks.onDecodeError(mediaType, error),
      onFrameRendered: (captureTimestampUs: number, actualRenderUs: number) => callbacks.onFrameRendered(captureTimestampUs, actualRenderUs),
      onFeedback: (fb: DecoderFeedback) => callbacks.onFeedback(fb),
      onAvSkew: callbacks.onAvSkew,
      // Recompute video render time at decode OUTPUT using the SyncController.
      // Eliminates startup stutter from async decode latency — render times
      // are fresh relative to the current clock, not stale from pipeline processing.
      // Adds a playback delay cushion to absorb network jitter — frames are
      // scheduled slightly into the future so delivery stalls don't cause stutter.
      recomputeVideoRenderTime: (captureTimestampUs: bigint) => {
        // Adaptive playback delay: absorbs network delivery jitter.
        const adaptiveDelayUs = videoPipeline?.effectiveGapTimeoutUs ?? 0;
        const staticDelayUs = (handshakeRttMs !== undefined && handshakeRttMs < 5)
          ? 50_000 : 200_000;
        const playbackDelayUs = Math.max(adaptiveDelayUs, staticDelayUs);

        // Sync reference is guaranteed here — CommandDispatcher holds frames
        // until hasSyncReference() returns true, so this callback only fires
        // after the reference is established. No speculative fallback needed.
        const timing = syncController.computeVideoRenderTime(captureTimestampUs);
        if (!timing) return clock.now() + playbackDelayUs; // safety: shouldn't happen
        if (timing.shouldDrop) return clock.now();

        // PTS-anchored render time + playback delay. No future cap — the
        // CaptureTimestamp spacing IS correct frame pacing. The maxFutureUs
        // cap was a band-aid for the pre-reference race that sync gating eliminates.
        return timing.renderTimeUs + playbackDelayUs;
      },
      hasSyncReference: () => syncController.hasReference,
      getPlaybackDelayUs: () => {
        const adaptiveDelayUs = videoPipeline?.effectiveGapTimeoutUs ?? 0;
        const staticDelayUs = (handshakeRttMs !== undefined && handshakeRttMs < 5)
          ? 50_000 : 200_000;
        return Math.max(adaptiveDelayUs, staticDelayUs);
      },
    }));
  }

  // ── LOC video pipeline ─────────────────────────────────────────
  let videoPipeline: PlaybackPipeline | null = null;
  if (trackInfo.video && !hasCmafVideo) {
    videoPipeline = new PlaybackPipeline({
      mediaType: 'video',
      config: playbackConfig,
      clock,
      sync: syncController,
      onCommand: (cmd) => callbacks.onCommand(cmd),
      onEvent: (evt) => callbacks.onEvent('video', evt),
      recovery: recoveryController,
      videoOnly: !trackInfo.audio,
      ...(trackInfo.isLive !== undefined ? { isLive: trackInfo.isLive } : {}),
    });
  }

  // ── LOC audio pipeline ─────────────────────────────────────────
  let audioPipeline: PlaybackPipeline | null = null;
  if (trackInfo.audio && !hasCmafAudio) {
    audioPipeline = new PlaybackPipeline({
      mediaType: 'audio',
      config: playbackConfig,
      clock,
      sync: syncController,
      onCommand: (cmd) => callbacks.onCommand(cmd),
      onEvent: (evt) => callbacks.onEvent('audio', evt),
      recovery: recoveryController,
    });
  }

  return {
    videoPipeline,
    audioPipeline,
    syncController,
    recoveryController,
    commandDispatcher,
    mediaSource,
  };
}

// ─── configurePipelines ─────────────────────────────────────────────

/**
 * Configure pipelines with initData/codec after they've been created.
 *
 * MUST be called after the caller has stored the PipelineSet fields
 * (especially commandDispatcher), because configure() triggers
 * onCommand callbacks synchronously.
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.1 (Video Config → VideoDecoderConfig.description)
 * @see draft-ietf-moq-loc-01 §4.1 (audio configuration)
 */
export function configurePipelines(
  pipelines: PipelineSet,
  trackInfo: TrackInfo,
): void {
  if (pipelines.videoPipeline && trackInfo.video) {
    // Set codec for keyframe payload validation before configure
    if (trackInfo.video.codec) {
      pipelines.videoPipeline.setCodec(trackInfo.video.codec);
    }

    if (trackInfo.video.initData || trackInfo.video.codec) {
      const configBytes = trackInfo.video.initData
        ? Uint8Array.from(atob(trackInfo.video.initData), c => c.charCodeAt(0))
        : new Uint8Array(0);
      pipelines.videoPipeline.configure(configBytes);
    }
  }

  if (pipelines.audioPipeline && trackInfo.audio) {
    if (trackInfo.audio.initData || trackInfo.audio.codec) {
      const configBytes = trackInfo.audio.initData
        ? Uint8Array.from(atob(trackInfo.audio.initData), c => c.charCodeAt(0))
        : new Uint8Array(0);
      pipelines.audioPipeline.configure(configBytes);
    }
  }
}

// ─── handlePipelineCommand ───────────────────────────────────────────

/**
 * Handle a DecoderCommand from the pipeline — apply transform, emit, dispatch.
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 */
export function handlePipelineCommand(
  cmd: DecoderCommand,
  commandTransform: ((cmd: DecoderCommand) => DecoderCommand | null) | undefined,
  dispatcher: CommandDispatcher | null,
  _mediaSource: MediaSourceLike | null,
  emitEvent: (event: Record<string, unknown>) => void,
): void {
  const transformed = commandTransform ? commandTransform(cmd) : cmd;
  if (transformed) {
    emitEvent({
      type: 'decoder_command',
      command: transformed,
    });
    dispatcher?.dispatch(transformed);
  }
}

// ─── handlePipelineEvent ─────────────────────────────────────────────

/**
 * Handle a PlaybackEvent from the pipeline — bridge to player events.
 *
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps)
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp drift)
 */
export function handlePipelineEvent(
  mediaType: 'video' | 'audio',
  evt: PlaybackEvent,
  ctx: PipelineEventContext,
): void {
  switch (evt.type) {
    case 'gap_detected':
      ctx.log.warn('Gap detected %s group=%s', mediaType, evt.groupId);
      ctx.emitEvent({
        type: 'gap_detected', mediaType, groupId: evt.groupId,
      });
      break;
    case 'skip_forward':
      ctx.log.warn('Skip forward %s group=%s→%s', mediaType, evt.fromGroupId, evt.toGroupId);
      if (!ctx.syncResetThisTick && ctx.syncController) {
        ctx.syncController.reset();
        ctx.setSyncResetThisTick(true);
      }
      ctx.emitEvent({
        type: 'skip_forward', mediaType,
        fromGroupId: evt.fromGroupId, toGroupId: evt.toGroupId,
      });
      break;
    case 'keyframe_waiting':
      ctx.emitEvent({
        type: 'keyframe_waiting', mediaType, groupId: evt.groupId,
      });
      break;
    case 'track_ended':
      ctx.emitEvent({ type: 'track_ended', mediaType });
      break;
    case 'sync_drift':
      ctx.log.warn('A/V sync drift: %dms', evt.driftUs / 1000);
      ctx.emitEvent({
        type: 'sync_drift', driftMs: evt.driftUs / 1000,
      });
      break;
    case 'recovery': {
      const action = ctx.recoveryHook(evt.action);
      if (action) {
        ctx.emitEvent({ type: 'recovery_action', action });
      }
      break;
    }
    case 'catch_up_changed':
      ctx.log.debug('Catch-up %s rate=%.2f latency=%dms target=%dms',
        evt.state.active ? 'active' : 'inactive',
        evt.state.currentRate, evt.state.latencyMs, evt.state.targetMs);
      ctx.emitEvent({
        type: 'catch_up_changed',
        active: evt.state.active,
        rate: evt.state.currentRate,
        latencyMs: evt.state.latencyMs,
        targetMs: evt.state.targetMs,
      });
      break;
    case 'keyframe_validation_failed':
      ctx.log.warn('Keyframe validation failed %s group=%s object=%s codec=%s',
        mediaType, evt.groupId, evt.objectId, evt.codec);
      ctx.emitEvent({
        type: 'keyframe_validation_failed',
        mediaType,
        groupId: evt.groupId,
        objectId: evt.objectId,
        codec: evt.codec,
      });
      break;
    case 'partial_group_abandoned':
      ctx.log.warn('Partial group abandoned %s group=%s→%s reason=%s',
        mediaType, evt.fromGroupId, evt.toGroupId, evt.reason);
      ctx.emitEvent({
        type: 'partial_group_abandoned',
        mediaType,
        fromGroupId: evt.fromGroupId,
        toGroupId: evt.toGroupId,
        reason: evt.reason,
      });
      break;
    case 'backlog_shed':
      ctx.log.warn('Backlog shed %s: dropped=%d remaining=%d reason=%s',
        mediaType, evt.droppedGroups, evt.remainingGroups, evt.reason);
      ctx.emitEvent({
        type: 'backlog_shed',
        mediaType,
        droppedGroups: evt.droppedGroups,
        remainingGroups: evt.remainingGroups,
        reason: evt.reason,
      });
      break;
  }
}

// ─── handleRecoveryAction ────────────────────────────────────────────

/**
 * Act on a recovery action — closes the feedback loop.
 *
 * reduce_quality → step down via QualityController
 * terminate → transition to error state
 */
export function handleRecoveryAction(
  action: RecoveryAction,
  mediaType: 'video' | 'audio',
  qualityController: QualityController | null,
  log: LoggerLike,
  callbacks: RecoveryCallbacks,
): void {
  switch (action.type) {
    case 'skip_forward':
      log.warn('Recovery: skip forward %s — flush pipeline and resubscribe from live edge', mediaType);
      callbacks.onResubscribe(mediaType);
      break;
    case 'reduce_quality':
      if (qualityController) {
        const newTrack = qualityController.peekLowerVideoQuality();
        if (newTrack) {
          callbacks.onQualityReduced(newTrack);
          log.warn('Quality reduced to %s (%dkbps)',
            newTrack.name, (newTrack.bitrate ?? 0) / 1000);
        } else {
          log.warn('Quality reduction requested but already at lowest');
        }
      }
      break;
    case 'resubscribe':
      log.warn('Recovery: request fresh %s subscription at next group boundary', mediaType);
      callbacks.onResubscribe(mediaType, action.startGroup);
      break;
    case 'terminate':
      log.error('Recovery: terminate — %s',
        'reason' in action ? action.reason : 'unknown');
      callbacks.onTerminate('reason' in action ? action.reason : 'unknown');
      break;
  }
}
