/**
 * Tests for player-pipeline.ts — pipeline creation + event/command handling.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream → VideoDecoderLike)
 * @see draft-ietf-moq-loc-01 §4.1 (audio → AudioDecoderLike)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status gaps)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import {
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
