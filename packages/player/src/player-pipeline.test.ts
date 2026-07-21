/**
 * Tests for player-pipeline.ts — pipeline creation + event/command handling.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → VideoDecoderLike)
 * @see draft-ietf-moq-loc-01 §4.1 (audio → AudioDecoderLike)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { RENDER_CUSHION_MAX_US } from './render-cushion.js';
import {
  computePlaybackDelayUs,
  createPipelines,
  handlePipelineCommand,
  handlePipelineEvent,
  handleRecoveryAction,
  type PipelineCallbacks,
  type TrackInfo,
} from './player-pipeline.js';
import type { MoqtPlayerConfig } from './config.js';
import type { DecoderCommand, PlaybackEvent, RecoveryAction, ClockSource, DecoderFeedback } from '@moqt/playback';
import type { CommandDispatcher } from './command-dispatcher.js';
import type { MediaSourceLike } from './interfaces.js';
import type { LoggerLike } from './logger.js';
import type { QualityController } from './quality-controller.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const mockClock: ClockSource = { now: () => 0 };

const mockLog: LoggerLike = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
};

function minimalConfig(overrides: Partial<MoqtPlayerConfig> = {}): MoqtPlayerConfig {
  return {
    url: 'https://relay.example.com/moq',
    namespace: 'live/broadcast',
    createTransport: async () => ({}) as any,
    createConnection: () => ({}) as any,
    maxRequestId: 100,
    gapTimeoutMs: 500,
    driftThresholdMs: 30,
    maxBufferDepth: 60,
    lateFrameThresholdMs: 100,
    maxConsecutiveGaps: 5,
    maxDecodeErrors: 10,
    ...overrides,
  } as MoqtPlayerConfig;
}

function mockCallbacks(): PipelineCallbacks {
  return {
    onFirstFrame: vi.fn(),
    onStall: vi.fn(),
    onDecodeError: vi.fn(),
    onFrameRendered: vi.fn(),
    onFeedback: vi.fn(),
    onCommand: vi.fn(),
    onEvent: vi.fn(),
  };
}

// ─── createPipelines ─────────────────────────────────────────────────

describe('createPipelines', () => {
  it('creates video pipeline for LOC track', () => {
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', width: 1920, height: 1080, packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.videoPipeline).not.toBeNull();
    expect(result.audioPipeline).toBeNull();
  });

  it('creates audio pipeline for LOC track', () => {
    const trackInfo: TrackInfo = {
      video: undefined,
      audio: { codec: 'opus', samplerate: 48000, packaging: 'loc' },
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.audioPipeline).not.toBeNull();
    expect(result.videoPipeline).toBeNull();
  });

  it('creates SyncController', () => {
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.syncController).not.toBeNull();
  });

  it('creates CommandDispatcher when video decoder factory provided', () => {
    const config = minimalConfig({
      createVideoDecoder: () => ({
        configure: vi.fn(),
        decode: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        reset: vi.fn(),
        state: 'unconfigured',
        decodeQueueSize: 0,
        ondequeue: null,
      }) as any,
    });
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(config, mockClock, trackInfo, mockCallbacks());
    expect(result.commandDispatcher).not.toBeNull();
  });

  it('skips video pipeline for CMAF tracks — MSE handles it', () => {
    const config = minimalConfig({
      createMediaSource: () => ({
        initialize: vi.fn(),
        appendChunk: vi.fn(),
        destroy: vi.fn(),
        onFirstFrame: null,
        onStall: null,
        onError: null,
      }) as any,
    });
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'cmaf', initData: btoa('ftyp') },
      audio: undefined,
    };
    const result = createPipelines(config, mockClock, trackInfo, mockCallbacks());
    expect(result.videoPipeline).toBeNull();
    expect(result.mediaSource).not.toBeNull();
  });

  it('returns null CommandDispatcher when no decoder factories', () => {
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig(), mockClock, trackInfo, mockCallbacks());
    expect(result.commandDispatcher).toBeNull();
  });

  it('holds video frames until sync reference is established (sync gating)', () => {
    let nowUs = 0;
    const clock: ClockSource = { now: () => nowUs };

    const videoDecoder = {
      configure: vi.fn(),
      decode: vi.fn(),
      flush: vi.fn(),
      close: vi.fn(),
      reset: vi.fn(),
      state: 'configured',
      decodeQueueSize: 0,
      ondequeue: null,
      onFrame: null as ((frame: unknown, renderTimeUs: number) => void) | null,
      onError: null as ((error: Error) => void) | null,
    };
    const renderer = {
      enqueue: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onFirstFrame: null as (() => void) | null,
      onFrameRendered: null as ((captureTimestampUs: bigint, actualRenderUs: number) => void) | null,
      onStall: null as ((durationMs: number) => void) | null,
    };

    const config = minimalConfig({
      createVideoDecoder: () => videoDecoder as any,
      createRenderer: () => renderer as any,
    });
    const trackInfo: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'loc' },
      audio: undefined, // video-only
    };

    const result = createPipelines(config, clock, trackInfo, mockCallbacks());

    nowUs = 100_000;
    // Before sync reference: frame should be HELD, not enqueued
    videoDecoder.onFrame?.({ timestamp: 1_000_000, close: vi.fn() } as any, 0);
    expect(renderer.enqueue).not.toHaveBeenCalled();

    // Simulate audio setting the reference (or video-only pipeline doing it)
    result.syncController.setAudioReference(900_000n);

    // Next frame: should drain held frame + enqueue current
    nowUs = 200_000;
    videoDecoder.onFrame?.({ timestamp: 1_033_333, close: vi.fn() } as any, 0);
    // Both held + current should be enqueued
    expect(renderer.enqueue).toHaveBeenCalledTimes(2);
  });
});

// ─── handlePipelineCommand ───────────────────────────────────────────

describe('handlePipelineCommand', () => {
  it('dispatches command to CommandDispatcher', () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as CommandDispatcher;
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    handlePipelineCommand(cmd, undefined, dispatcher, null, emitEvent);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(cmd);
  });

  it('applies commandTransform before dispatch', () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as CommandDispatcher;
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    const transform = vi.fn((c: DecoderCommand) => ({ ...c, timestamp: 999 }));
    handlePipelineCommand(cmd, transform, dispatcher, null, emitEvent);
    expect(transform).toHaveBeenCalledWith(cmd);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ timestamp: 999 }));
  });

  it('suppresses command when transform returns null', () => {
    const dispatcher = { dispatch: vi.fn() } as unknown as CommandDispatcher;
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    handlePipelineCommand(cmd, () => null, dispatcher, null, emitEvent);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('emits decoder_command event', () => {
    const emitEvent = vi.fn();
    const cmd: DecoderCommand = { type: 'decode_video', data: new Uint8Array(10), timestamp: 0, duration: 33333, isKey: true };
    handlePipelineCommand(cmd, undefined, null, null, emitEvent);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'decoder_command',
      command: cmd,
    }));
  });
});

// ─── handlePipelineEvent ─────────────────────────────────────────────

describe('handlePipelineEvent', () => {
  it('emits gap_detected', () => {
    const emitEvent = vi.fn();
    const evt: PlaybackEvent = { type: 'gap_detected', groupId: 5n };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: null,
      syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'gap_detected', mediaType: 'video', groupId: 5n,
    }));
  });

  it('emits skip_forward and resets sync', () => {
    const emitEvent = vi.fn();
    const syncController = { reset: vi.fn() };
    const setSyncReset = vi.fn();
    const evt: PlaybackEvent = { type: 'skip_forward', fromGroupId: 3n, toGroupId: 7n };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: syncController as any,
      syncResetThisTick: false, setSyncResetThisTick: setSyncReset,
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(syncController.reset).toHaveBeenCalled();
    expect(setSyncReset).toHaveBeenCalledWith(true);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'skip_forward', mediaType: 'video',
    }));
  });

  it('does not double-reset sync within same tick', () => {
    const emitEvent = vi.fn();
    const syncController = { reset: vi.fn() };
    const evt: PlaybackEvent = { type: 'skip_forward', fromGroupId: 3n, toGroupId: 7n };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: syncController as any,
      syncResetThisTick: true, // already reset
      setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(syncController.reset).not.toHaveBeenCalled();
  });

  it('emits partial_group_abandoned with mediaType', () => {
    const emitEvent = vi.fn();
    const evt: PlaybackEvent = {
      type: 'partial_group_abandoned',
      fromGroupId: 5n,
      toGroupId: 6n,
      reason: 'intra-group timeout',
    };
    handlePipelineEvent('video', evt, {
      emitEvent, log: mockLog, syncController: null,
      syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'partial_group_abandoned',
      mediaType: 'video',
      fromGroupId: 5n,
      toGroupId: 6n,
      reason: 'intra-group timeout',
    }));
  });

  it('emits track_ended', () => {
    const emitEvent = vi.fn();
    const evt: PlaybackEvent = { type: 'track_ended' };
    handlePipelineEvent('audio', evt, {
      emitEvent, log: mockLog, syncController: null,
      syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
      recoveryHook: (a: RecoveryAction) => a,
    });
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'track_ended', mediaType: 'audio',
    }));
  });
});

// ─── handleRecoveryAction ────────────────────────────────────────────

describe('handleRecoveryAction', () => {
  it('peeks lower quality via QualityController (non-mutating)', () => {
    const qc = { peekLowerVideoQuality: vi.fn(() => ({ name: 'low', codec: 'avc1', bitrate: 500_000 })) };
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    const action: RecoveryAction = { type: 'reduce_quality' };
    handleRecoveryAction(action, 'video', qc as unknown as QualityController, mockLog, callbacks);
    expect(qc.peekLowerVideoQuality).toHaveBeenCalled();
    expect(callbacks.onQualityReduced).toHaveBeenCalled();
  });

  it('calls onResubscribe for recovery resubscribe action', () => {
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    const action: RecoveryAction = { type: 'resubscribe' };
    handleRecoveryAction(action, 'video', null, mockLog, callbacks);
    expect(callbacks.onResubscribe).toHaveBeenCalledWith('video', undefined);
  });

  it('calls onTerminate for fatal recovery', () => {
    const callbacks = { onQualityReduced: vi.fn(), onResubscribe: vi.fn(), onTerminate: vi.fn() };
    const action: RecoveryAction = { type: 'terminate', reason: 'too many errors' };
    handleRecoveryAction(action, 'video', null, mockLog, callbacks);
    expect(callbacks.onTerminate).toHaveBeenCalledWith('too many errors');
  });
});

describe('handlePipelineEvent — LOC diagnostics counting (observability only)', () => {
  const baseCtx = () => ({
    emitEvent: vi.fn(), log: mockLog, syncController: null,
    syncResetThisTick: false, setSyncResetThisTick: vi.fn(),
    recoveryHook: (a: RecoveryAction) => a,
    recordDiagnostic: vi.fn(),
  });

  it.each([
    ['gap_detected', { type: 'gap_detected', groupId: 5n }],
    ['keyframe_waiting', { type: 'keyframe_waiting', groupId: 5n }],
    ['partial_group_abandoned', { type: 'partial_group_abandoned', fromGroupId: 1n, toGroupId: 2n, reason: 'x' }],
    ['backlog_shed', { type: 'backlog_shed', droppedGroups: 2, remainingGroups: 3, reason: 'x' }],
  ] as const)('records %s', (kind, evt) => {
    const ctx = baseCtx();
    handlePipelineEvent('video', evt as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith(kind);
  });

  it('records skip_forward AND sync_reset when the reset actually runs', () => {
    const ctx = { ...baseCtx(), syncController: { reset: vi.fn() } as any };
    handlePipelineEvent('video', { type: 'skip_forward', fromGroupId: 1n, toGroupId: 2n } as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith('skip_forward');
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith('sync_reset');
  });

  it('does NOT record sync_reset when the same-tick guard suppresses the reset', () => {
    const ctx = { ...baseCtx(), syncController: { reset: vi.fn() } as any, syncResetThisTick: true };
    handlePipelineEvent('video', { type: 'skip_forward', fromGroupId: 1n, toGroupId: 2n } as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).toHaveBeenCalledWith('skip_forward');
    expect(ctx.recordDiagnostic).not.toHaveBeenCalledWith('sync_reset');
  });

  it('records recovery_action only when the hook passes the action through', () => {
    const ctx = { ...baseCtx(), recoveryHook: () => null };
    handlePipelineEvent('video', { type: 'recovery', action: { type: 'skip_forward' } } as unknown as PlaybackEvent, ctx);
    expect(ctx.recordDiagnostic).not.toHaveBeenCalledWith('recovery_action');

    const ctx2 = baseCtx();
    handlePipelineEvent('video', { type: 'recovery', action: { type: 'reduce_quality' } } as unknown as PlaybackEvent, ctx2);
    expect(ctx2.recordDiagnostic).toHaveBeenCalledWith('recovery_action');
  });

  it('is optional: absent recordDiagnostic changes nothing', () => {
    const { recordDiagnostic: _omit, ...ctx } = baseCtx();
    expect(() => handlePipelineEvent('video',
      { type: 'skip_forward', fromGroupId: 1n, toGroupId: 2n } as PlaybackEvent,
      { ...ctx, syncController: { reset: vi.fn() } as any })).not.toThrow();
  });
});

describe('computePlaybackDelayUs — the ONE shared playout cushion', () => {
  it('normal RTT: max(adaptive, 200ms) for BOTH media types', () => {
    expect(computePlaybackDelayUs(120_000, undefined)).toBe(200_000);
    expect(computePlaybackDelayUs(120_000, 40)).toBe(200_000);
  });

  it('RTT < 5ms: static floor drops to 50ms', () => {
    expect(computePlaybackDelayUs(0, 2)).toBe(50_000);
    expect(computePlaybackDelayUs(30_000, 2)).toBe(50_000);
  });

  it('adaptive gap timeout above the floor wins (propagates to both media)', () => {
    expect(computePlaybackDelayUs(400_000, 40)).toBe(400_000);
    expect(computePlaybackDelayUs(400_000, 2)).toBe(400_000);
  });

  it('no adaptive signal: pure static floor', () => {
    expect(computePlaybackDelayUs(undefined, undefined)).toBe(200_000);
    expect(computePlaybackDelayUs(undefined, 2)).toBe(50_000);
  });
});

describe('createPipelines — smoothed render cushion wiring (slice A)', () => {
  const LOC_AV: TrackInfo = {
    video: { codec: 'avc1.64001e', width: 1920, height: 1080, packaging: 'loc' },
    audio: { codec: 'opus', samplerate: 48000, packaging: 'loc' },
  };

  it('exposes getRenderCushionUs for LOC sessions (the smoothed value, floor at rest)', () => {
    const result = createPipelines(minimalConfig(), mockClock, LOC_AV, mockCallbacks());
    expect(result.getRenderCushionUs).toBeDefined();
    // Fresh session, no jitter: cushion sits at the 200ms static floor.
    expect(result.getRenderCushionUs!()).toBe(200_000);
  });

  it('getRenderCushionUs is a PURE PEEK: polling never advances the smoother (observability contract)', () => {
    const result = createPipelines(minimalConfig(), mockClock, LOC_AV, mockCallbacks());
    // Force the raw adaptive fuse high (simulates the 2000ms estimator spike).
    Object.defineProperty(result.videoPipeline, 'effectiveGapTimeoutUs', {
      get: () => 2_000_000, configurable: true,
    });
    // The smoother only moves when SCHEDULING calls update(); the getter must
    // not adopt the spike no matter how often telemetry polls it.
    expect(result.getRenderCushionUs!()).toBe(200_000);
    expect(result.getRenderCushionUs!()).toBe(200_000);
    expect(result.getRenderCushionUs!()).toBe(200_000);
    // (Clamp/slew behavior toward the cap is pinned in render-cushion.test.ts;
    // RENDER_CUSHION_MAX_US bounds any scheduled adoption of this spike.)
    expect(RENDER_CUSHION_MAX_US).toBeLessThan(2_000_000);
  });

  it('SEPARATION PIN: gap detector sees the raw 2000ms while the render cushion stays below it', () => {
    const result = createPipelines(minimalConfig(), mockClock, LOC_AV, mockCallbacks());
    Object.defineProperty(result.videoPipeline, 'effectiveGapTimeoutUs', {
      get: () => 2_000_000, configurable: true,
    });
    // The smoothed render cushion never mirrors the fuse: at rest it reads
    // the floor; even fully adopted it is clamped at RENDER_CUSHION_MAX_US…
    const cushionUs = result.getRenderCushionUs!();
    expect(cushionUs).toBeLessThanOrEqual(RENDER_CUSHION_MAX_US);
    expect(cushionUs).toBeLessThan(2_000_000);
    // …while the pipeline's OWN effective gap timeout — the value the gap
    // detector consumes — remains the raw adaptive 2000ms, untouched by
    // the smoother.
    expect(result.videoPipeline!.effectiveGapTimeoutUs).toBe(2_000_000);
  });

  it('CMAF sessions expose no LOC render cushion', () => {
    const cmaf: TrackInfo = {
      video: { codec: 'avc1.64001e', packaging: 'cmaf' },
      audio: undefined,
    };
    const result = createPipelines(minimalConfig({ createMediaSource: () => ({ initialize: vi.fn(), appendChunk: vi.fn(), endOfStream: vi.fn(), reset: vi.fn(), mediaElement: null, destroy: vi.fn(), onFirstFrame: null, onError: null, onStall: null }) as any }), mockClock, cmaf, mockCallbacks());
    expect(result.getRenderCushionUs).toBeUndefined();
  });
});
