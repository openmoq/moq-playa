/**
 * CommandDispatcher tests — red/green TDD.
 *
 * The CommandDispatcher bridges the sans-I/O playback core (which emits
 * DecoderCommands) and the browser adapter layer (which drives WebCodecs,
 * Canvas, AudioContext).
 *
 * Tests use mock adapters implementing the *Like interfaces. No browser
 * APIs are needed — everything is tested through the typed contracts.
 *
 * @see draft-ietf-moq-loc-01 §2.1 (video bitstream format)
 * @see draft-ietf-moq-loc-01 §4.1 (audio independently decodable)
 * @see draft-ietf-moq-msf-00 §5.1.24 (codec string)
 * @see draft-ietf-moq-msf-00 §5.1.29 (width)
 * @see draft-ietf-moq-msf-00 §5.1.30 (height)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { CommandDispatcher } from './command-dispatcher.js';
import type { VideoDecoderLike, AudioDecoderLike, VideoRendererLike, AudioOutputLike } from './interfaces.js';
import type { DecoderCommand, DecoderFeedback } from '@moqt/playback';

// ─── Mock Factories ───────────────────────────────────────────────────

function createMockVideoDecoder(): VideoDecoderLike & {
  _triggerFrame: (frame: unknown, renderTimeUs: number) => void;
  _triggerError: (err: Error) => void;
} {
  const mock: any = {
    configure: vi.fn(),
    decode: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
    queueDepth: 0,
    onFrame: null,
    onError: null,
    destroy: vi.fn(),
    _triggerFrame(frame: unknown, renderTimeUs: number) {
      mock.onFrame?.(frame, renderTimeUs);
    },
    _triggerError(err: Error) {
      mock.onError?.(err);
    },
  };
  return mock;
}

function createMockAudioDecoder(): AudioDecoderLike & {
  _triggerData: (data: unknown, renderTimeUs: number) => void;
  _triggerError: (err: Error) => void;
} {
  const mock: any = {
    configure: vi.fn(),
    decode: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
    queueDepth: 0,
    onData: null,
    onError: null,
    destroy: vi.fn(),
    _triggerData(data: unknown, renderTimeUs: number) {
      mock.onData?.(data, renderTimeUs);
    },
    _triggerError(err: Error) {
      mock.onError?.(err);
    },
  };
  return mock;
}

function createMockRenderer(): VideoRendererLike & {
  _triggerFirstFrame: () => void;
  _triggerStall: (durationMs: number) => void;
  _triggerFrameRendered: (captureTimestampUs: bigint, actualRenderUs: number) => void;
} {
  const mock: any = {
    enqueue: vi.fn(),
    flush: vi.fn(),
    destroy: vi.fn(),
    onFirstFrame: null,
    onFrameRendered: null,
    onStall: null,
    _triggerFirstFrame() {
      mock.onFirstFrame?.();
    },
    _triggerStall(durationMs: number) {
      mock.onStall?.(durationMs);
    },
    _triggerFrameRendered(captureTimestampUs: bigint, actualRenderUs: number) {
      mock.onFrameRendered?.(captureTimestampUs, actualRenderUs);
    },
  };
  return mock;
}

function createMockAudioOutput(): AudioOutputLike {
  return {
    schedule: vi.fn(),
    flush: vi.fn(),
    currentPlayoutTimeUs: 0,
    destroy: vi.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('CommandDispatcher A/V skew observability', () => {
  it('reports skew = videoCaptureUs − audio playheadCaptureUs at frame render', () => {
    const renderer = createMockRenderer();
    const audioOutput = { ...createMockAudioOutput(), playheadCaptureUs: vi.fn(() => 5_000_000) };
    const onAvSkew = vi.fn();
    const onFrameRendered = vi.fn();
    new CommandDispatcher({
      videoDecoder: createMockVideoDecoder(),
      audioDecoder: createMockAudioDecoder(),
      renderer, audioOutput, onAvSkew, onFrameRendered,
    });

    renderer._triggerFrameRendered(5_120_000n, 1_000_000);

    // Behavior-neutral: the existing callback still fires unchanged…
    expect(onFrameRendered).toHaveBeenCalledWith(5_120_000n, 1_000_000);
    // …and skew is reported: video frame is 120ms ahead of audible audio.
    expect(onAvSkew).toHaveBeenCalledWith(120_000);
  });

  it('reports no skew when audio is silent (playhead null) or unsupported', () => {
    const renderer = createMockRenderer();
    const audioOutput = { ...createMockAudioOutput(), playheadCaptureUs: vi.fn(() => null) };
    const onAvSkew = vi.fn();
    new CommandDispatcher({
      videoDecoder: createMockVideoDecoder(),
      audioDecoder: createMockAudioDecoder(),
      renderer, audioOutput, onAvSkew,
    });
    renderer._triggerFrameRendered(5_120_000n, 1_000_000);
    expect(onAvSkew).not.toHaveBeenCalled();

    // Output without playheadCaptureUs (back-compat) — also quiet.
    const renderer2 = createMockRenderer();
    new CommandDispatcher({
      videoDecoder: createMockVideoDecoder(),
      audioDecoder: createMockAudioDecoder(),
      renderer: renderer2, audioOutput: createMockAudioOutput(), onAvSkew,
    });
    renderer2._triggerFrameRendered(5_120_000n, 1_000_000);
    expect(onAvSkew).not.toHaveBeenCalled();
  });
});

describe('CommandDispatcher', () => {
  // ─── Configure dispatch ──────────────────────────────────────

  it('dispatches configure to video decoder with codec and dimensions (§5.1.24, §5.1.29-30)', () => {
    const videoDecoder = createMockVideoDecoder();
    const dispatcher = new CommandDispatcher({
      videoDecoder,
      videoCodec: 'avc1.42001f',
      videoWidth: 1920,
      videoHeight: 1080,
    });

    const cmd: DecoderCommand = {
      type: 'configure',
      mediaType: 'video',
      config: new Uint8Array([0x01, 0x02]),
    };
    dispatcher.dispatch(cmd);

    expect(videoDecoder.configure).toHaveBeenCalledWith(
      new Uint8Array([0x01, 0x02]),
      'avc1.42001f',
      1920,
      1080,
    );
  });

  it('dispatches configure to audio decoder with codec and sample rate (§5.1.24-26)', () => {
    const audioDecoder = createMockAudioDecoder();
    const dispatcher = new CommandDispatcher({
      audioDecoder,
      audioCodec: 'opus',
      audioSampleRate: 48000,
      audioChannels: 2,
    });

    const cmd: DecoderCommand = {
      type: 'configure',
      mediaType: 'audio',
      config: new Uint8Array(0),
    };
    dispatcher.dispatch(cmd);

    expect(audioDecoder.configure).toHaveBeenCalledWith(
      new Uint8Array(0),
      'opus',
      48000,
      2,
    );
  });

  // ─── Decode dispatch ──────────────────────────────────────────

  it('dispatches decode_video to video decoder (LOC §2.1)', () => {
    const videoDecoder = createMockVideoDecoder();
    const dispatcher = new CommandDispatcher({ videoDecoder });

    const cmd: DecoderCommand = {
      type: 'decode_video',
      chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0xFF]) },
      renderTimeUs: 1000,
    };
    dispatcher.dispatch(cmd);

    expect(videoDecoder.decode).toHaveBeenCalledWith(
      { type: 'key', timestamp: 0, data: new Uint8Array([0xFF]) },
      1000,
    );
  });

  it('dispatches decode_audio to audio decoder (LOC §4.1)', () => {
    const audioDecoder = createMockAudioDecoder();
    const dispatcher = new CommandDispatcher({ audioDecoder });

    const cmd: DecoderCommand = {
      type: 'decode_audio',
      chunk: { type: 'key', timestamp: 500, data: new Uint8Array([0xAA]) },
      renderTimeUs: 2000,
    };
    dispatcher.dispatch(cmd);

    expect(audioDecoder.decode).toHaveBeenCalledWith(
      { type: 'key', timestamp: 500, data: new Uint8Array([0xAA]) },
      2000,
    );
  });

  // ─── Flush dispatch ──────────────────────────────────────────

  it('dispatches flush to video decoder', () => {
    const videoDecoder = createMockVideoDecoder();
    const dispatcher = new CommandDispatcher({ videoDecoder });

    dispatcher.dispatch({ type: 'flush', mediaType: 'video' });
    expect(videoDecoder.flush).toHaveBeenCalled();
  });

  it('dispatches flush to audio decoder', () => {
    const audioDecoder = createMockAudioDecoder();
    const dispatcher = new CommandDispatcher({ audioDecoder });

    dispatcher.dispatch({ type: 'flush', mediaType: 'audio' });
    expect(audioDecoder.flush).toHaveBeenCalled();
  });

  // ─── Reset dispatch ──────────────────────────────────────────

  it('dispatches reset to video decoder with reason (§10.2.1.1)', () => {
    const videoDecoder = createMockVideoDecoder();
    const dispatcher = new CommandDispatcher({ videoDecoder });

    dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'gap' });
    expect(videoDecoder.reset).toHaveBeenCalled();
  });

  it('dispatches reset to audio decoder with reason', () => {
    const audioDecoder = createMockAudioDecoder();
    const dispatcher = new CommandDispatcher({ audioDecoder });

    dispatcher.dispatch({ type: 'reset', mediaType: 'audio', reason: 'gap' });
    expect(audioDecoder.reset).toHaveBeenCalled();
  });

  // ─── Callback wiring ──────────────────────────────────────────

  it('routes video frames from decoder to renderer.enqueue()', () => {
    const videoDecoder = createMockVideoDecoder();
    const renderer = createMockRenderer();
    const _dispatcher = new CommandDispatcher({ videoDecoder, renderer });

    const fakeFrame = { width: 1920, height: 1080, timestamp: 1000000 };
    videoDecoder._triggerFrame(fakeFrame, 5000);

    expect(renderer.enqueue).toHaveBeenCalledWith(fakeFrame, 5000);
  });

  it('routes audio data from decoder to audioOutput.schedule()', () => {
    const audioDecoder = createMockAudioDecoder();
    const audioOutput = createMockAudioOutput();
    const _dispatcher = new CommandDispatcher({ audioDecoder, audioOutput });

    const fakeAudioData = { sampleRate: 48000 };
    audioDecoder._triggerData(fakeAudioData, 3000);

    expect(audioOutput.schedule).toHaveBeenCalledWith(fakeAudioData, 3000);
  });

  it('reports video decoder error via onError callback', () => {
    const videoDecoder = createMockVideoDecoder();
    const onError = vi.fn();
    const _dispatcher = new CommandDispatcher({ videoDecoder, onError });

    videoDecoder._triggerError(new Error('decode failed'));

    expect(onError).toHaveBeenCalledWith('video', expect.any(Error));
    expect(onError.mock.calls[0]![1].message).toBe('decode failed');
  });

  it('reports audio decoder error via onError callback', () => {
    const audioDecoder = createMockAudioDecoder();
    const onError = vi.fn();
    const _dispatcher = new CommandDispatcher({ audioDecoder, onError });

    audioDecoder._triggerError(new Error('audio decode failed'));

    expect(onError).toHaveBeenCalledWith('audio', expect.any(Error));
  });

  it('fires onFirstFrame from renderer callback', () => {
    const renderer = createMockRenderer();
    const onFirstFrame = vi.fn();
    const _dispatcher = new CommandDispatcher({ renderer, onFirstFrame });

    renderer._triggerFirstFrame();

    expect(onFirstFrame).toHaveBeenCalledOnce();
  });

  it('fires onStall from renderer callback', () => {
    const renderer = createMockRenderer();
    const onStall = vi.fn();
    const _dispatcher = new CommandDispatcher({ renderer, onStall });

    renderer._triggerStall(750);

    expect(onStall).toHaveBeenCalledWith(750);
  });

  // ─── Graceful degradation ──────────────────────────────────────

  it('handles video-only mode — no audio adapter', () => {
    const videoDecoder = createMockVideoDecoder();
    const renderer = createMockRenderer();
    const dispatcher = new CommandDispatcher({ videoDecoder, renderer });

    // Audio commands silently ignored
    dispatcher.dispatch({ type: 'configure', mediaType: 'audio', config: new Uint8Array(0) });
    dispatcher.dispatch({
      type: 'decode_audio',
      chunk: { type: 'key', timestamp: 0, data: new Uint8Array(0) },
      renderTimeUs: 0,
    });

    // Video commands still work
    dispatcher.dispatch({
      type: 'decode_video',
      chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0x01]) },
      renderTimeUs: 1000,
    });
    expect(videoDecoder.decode).toHaveBeenCalled();
  });

  it('handles audio-only mode — no video adapter', () => {
    const audioDecoder = createMockAudioDecoder();
    const audioOutput = createMockAudioOutput();
    const dispatcher = new CommandDispatcher({ audioDecoder, audioOutput });

    // Video commands silently ignored
    dispatcher.dispatch({ type: 'configure', mediaType: 'video', config: new Uint8Array(0) });
    dispatcher.dispatch({
      type: 'decode_video',
      chunk: { type: 'key', timestamp: 0, data: new Uint8Array(0) },
      renderTimeUs: 0,
    });

    // Audio commands still work
    dispatcher.dispatch({
      type: 'decode_audio',
      chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0x01]) },
      renderTimeUs: 2000,
    });
    expect(audioDecoder.decode).toHaveBeenCalled();
  });

  // ─── Decode error resilience ────────────────────────────────────

  it('catches synchronous throw from videoDecoder.decode() and routes to error callbacks', () => {
    const videoDecoder = createMockVideoDecoder();
    const onError = vi.fn();
    const feedbacks: DecoderFeedback[] = [];
    const dispatcher = new CommandDispatcher({
      videoDecoder,
      onError,
      onFeedback: (fb) => feedbacks.push(fb),
    });

    // Simulate decoder in bad state (closed/errored) — decode() throws synchronously
    (videoDecoder.decode as any).mockImplementation(() => {
      throw new Error('InvalidStateError: decoder is closed');
    });

    // dispatch should NOT throw
    dispatcher.dispatch({
      type: 'decode_video',
      chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0xFF]) },
      renderTimeUs: 1000,
    });

    // Error should be routed to callbacks
    expect(onError).toHaveBeenCalledWith('video', expect.any(Error));
    const errFb = feedbacks.find(f => f.type === 'decode_error');
    expect(errFb).toBeDefined();
    if (errFb?.type === 'decode_error') {
      expect(errFb.mediaType).toBe('video');
      expect(errFb.message).toMatch(/decoder is closed/);
    }
  });

  it('catches synchronous throw from audioDecoder.decode() and routes to error callbacks', () => {
    const audioDecoder = createMockAudioDecoder();
    const onError = vi.fn();
    const feedbacks: DecoderFeedback[] = [];
    const dispatcher = new CommandDispatcher({
      audioDecoder,
      onError,
      onFeedback: (fb) => feedbacks.push(fb),
    });

    (audioDecoder.decode as any).mockImplementation(() => {
      throw new Error('InvalidStateError: decoder is closed');
    });

    dispatcher.dispatch({
      type: 'decode_audio',
      chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0xAA]) },
      renderTimeUs: 2000,
    });

    expect(onError).toHaveBeenCalledWith('audio', expect.any(Error));
    const errFb = feedbacks.find(f => f.type === 'decode_error');
    expect(errFb).toBeDefined();
    if (errFb?.type === 'decode_error') {
      expect(errFb.mediaType).toBe('audio');
    }
  });

  // ─── Lifecycle ──────────────────────────────────────────────────

  it('destroy() calls destroy on all adapters', () => {
    const videoDecoder = createMockVideoDecoder();
    const audioDecoder = createMockAudioDecoder();
    const renderer = createMockRenderer();
    const audioOutput = createMockAudioOutput();
    const dispatcher = new CommandDispatcher({
      videoDecoder, audioDecoder, renderer, audioOutput,
    });

    dispatcher.destroy();

    expect(videoDecoder.destroy).toHaveBeenCalled();
    expect(audioDecoder.destroy).toHaveBeenCalled();
    expect(renderer.destroy).toHaveBeenCalled();
    expect(audioOutput.destroy).toHaveBeenCalled();
  });

  // ─── Decoder feedback (§7 backpressure) ──────────────────────────

  describe('decoder feedback', () => {
    it('emits queue_pressure on high video queue depth', () => {
      const videoDecoder = createMockVideoDecoder();
      const feedbacks: DecoderFeedback[] = [];
      const dispatcher = new CommandDispatcher({
        videoDecoder,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      // Set queueDepth to high threshold before decode
      (videoDecoder as any).queueDepth = 8;

      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0xFF]) },
        renderTimeUs: 1000,
      });

      const pressure = feedbacks.find(f => f.type === 'queue_pressure');
      expect(pressure).toBeDefined();
      expect(pressure?.mediaType).toBe('video');
      if (pressure?.type === 'queue_pressure') {
        expect(pressure.depth).toBe(8);
      }
    });

    it('emits queue_pressure when queue drops below low threshold', () => {
      const videoDecoder = createMockVideoDecoder();
      const feedbacks: DecoderFeedback[] = [];
      const dispatcher = new CommandDispatcher({
        videoDecoder,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      // First: cross high threshold
      (videoDecoder as any).queueDepth = 8;
      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0xFF]) },
        renderTimeUs: 1000,
      });
      feedbacks.length = 0;

      // Then: drop below low threshold
      (videoDecoder as any).queueDepth = 4;
      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 100, data: new Uint8Array([0xFF]) },
        renderTimeUs: 2000,
      });

      const pressure = feedbacks.find(f => f.type === 'queue_pressure');
      expect(pressure).toBeDefined();
      if (pressure?.type === 'queue_pressure') {
        expect(pressure.depth).toBe(4);
      }
    });

    it('no spam when depth stays above high threshold', () => {
      const videoDecoder = createMockVideoDecoder();
      const feedbacks: DecoderFeedback[] = [];
      const dispatcher = new CommandDispatcher({
        videoDecoder,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      // Cross high threshold — first pressure event
      (videoDecoder as any).queueDepth = 8;
      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0xFF]) },
        renderTimeUs: 1000,
      });
      expect(feedbacks.filter(f => f.type === 'queue_pressure')).toHaveLength(1);

      // Stay above — no additional event
      (videoDecoder as any).queueDepth = 10;
      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 100, data: new Uint8Array([0xFF]) },
        renderTimeUs: 2000,
      });
      expect(feedbacks.filter(f => f.type === 'queue_pressure')).toHaveLength(1);
    });

    it('resets video queue pressure hysteresis on decoder reset', () => {
      const videoDecoder = createMockVideoDecoder();
      const feedbacks: DecoderFeedback[] = [];
      const dispatcher = new CommandDispatcher({
        videoDecoder,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      // Drive queue depth above high threshold → pressure fires
      (videoDecoder as any).queueDepth = 8;
      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 0, data: new Uint8Array([0xFF]) },
        renderTimeUs: 0,
      });
      expect(feedbacks.filter(f => f.type === 'queue_pressure')).toHaveLength(1);

      // Reset the decoder (track switch / overflow recovery)
      dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'track switch' });

      // After reset, queue is empty. New decode should be able to trigger
      // a fresh high-pressure event when queue fills again.
      feedbacks.length = 0;
      (videoDecoder as any).queueDepth = 8;
      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 100, data: new Uint8Array([0xFF]) },
        renderTimeUs: 1000,
      });

      // Must fire a NEW queue_pressure — hysteresis should have been cleared by reset
      const pressure = feedbacks.find(f => f.type === 'queue_pressure');
      expect(pressure).toBeDefined();
    });

    it('emits decode_error feedback on video decoder error', () => {
      const videoDecoder = createMockVideoDecoder();
      const feedbacks: DecoderFeedback[] = [];
      const _dispatcher = new CommandDispatcher({
        videoDecoder,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      videoDecoder._triggerError(new Error('video decode failed'));

      const errFb = feedbacks.find(f => f.type === 'decode_error');
      expect(errFb).toBeDefined();
      if (errFb?.type === 'decode_error') {
        expect(errFb.mediaType).toBe('video');
        expect(errFb.message).toBe('video decode failed');
      }
    });

    it('emits decode_error feedback on audio decoder error', () => {
      const audioDecoder = createMockAudioDecoder();
      const feedbacks: DecoderFeedback[] = [];
      const _dispatcher = new CommandDispatcher({
        audioDecoder,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      audioDecoder._triggerError(new Error('audio decode failed'));

      const errFb = feedbacks.find(f => f.type === 'decode_error');
      expect(errFb).toBeDefined();
      if (errFb?.type === 'decode_error') {
        expect(errFb.mediaType).toBe('audio');
        expect(errFb.message).toBe('audio decode failed');
      }
    });

    it('emits frame_rendered feedback from renderer', () => {
      const renderer = createMockRenderer();
      const feedbacks: DecoderFeedback[] = [];
      const _dispatcher = new CommandDispatcher({
        renderer,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      renderer._triggerFrameRendered(1_000_100_000n, 5_100_000);

      const renderedFb = feedbacks.find(f => f.type === 'frame_rendered');
      expect(renderedFb).toBeDefined();
      if (renderedFb?.type === 'frame_rendered') {
        expect(renderedFb.captureTimestampUs).toBe(1_000_100_000n);
        expect(renderedFb.actualRenderUs).toBe(5_100_000);
      }
    });

    it('emits flush_complete after flush resolves', async () => {
      const videoDecoder = createMockVideoDecoder();
      const feedbacks: DecoderFeedback[] = [];
      const dispatcher = new CommandDispatcher({
        videoDecoder,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      dispatcher.dispatch({ type: 'flush', mediaType: 'video' });

      // flush() returns Promise — need to await
      await vi.waitFor(() => {
        expect(feedbacks.find(f => f.type === 'flush_complete')).toBeDefined();
      });

      const flushFb = feedbacks.find(f => f.type === 'flush_complete');
      expect(flushFb?.mediaType).toBe('video');
    });

    it('coexists with existing onError (both fire)', () => {
      const videoDecoder = createMockVideoDecoder();
      const onError = vi.fn();
      const feedbacks: DecoderFeedback[] = [];
      const _dispatcher = new CommandDispatcher({
        videoDecoder,
        onError,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      videoDecoder._triggerError(new Error('test error'));

      // Both should fire
      expect(onError).toHaveBeenCalledWith('video', expect.any(Error));
      expect(feedbacks.find(f => f.type === 'decode_error')).toBeDefined();
    });

    it('coexists with existing onFrameRendered (both fire)', () => {
      const renderer = createMockRenderer();
      const onFrameRendered = vi.fn();
      const feedbacks: DecoderFeedback[] = [];
      const _dispatcher = new CommandDispatcher({
        renderer,
        onFrameRendered,
        onFeedback: (fb) => feedbacks.push(fb),
      });

      renderer._triggerFrameRendered(1_000_000n, 5_000_000);

      // Both should fire
      expect(onFrameRendered).toHaveBeenCalledWith(1_000_000n, 5_000_000);
      expect(feedbacks.find(f => f.type === 'frame_rendered')).toBeDefined();
    });

    it('emits queue_pressure on video frame output (un-throttle path)', () => {
      const videoDecoder = createMockVideoDecoder();
      const renderer = createMockRenderer();
      const feedbacks: DecoderFeedback[] = [];
      const dispatcher = new CommandDispatcher({
        videoDecoder,
        renderer,
        videoCodec: 'avc1.42001f',
        onFeedback: (fb) => feedbacks.push(fb),
      });

      // Simulate high queue depth → pressure fires on decode
      videoDecoder.queueDepth = 10;
      dispatcher.dispatch({
        type: 'decode_video',
        chunk: { type: 'key', timestamp: 0, data: new Uint8Array(1) } as any,
        renderTimeUs: 0,
      });

      const highPressure = feedbacks.find(
        f => f.type === 'queue_pressure' && f.depth === 10,
      );
      expect(highPressure).toBeDefined();
      feedbacks.length = 0;

      // Now decoder outputs a frame and queue drops below low threshold.
      // The un-throttle path: onFrame → checkQueuePressure → low-pressure feedback.
      videoDecoder.queueDepth = 2;
      videoDecoder._triggerFrame({ timestamp: 1000000 }, 100_000);

      const lowPressure = feedbacks.find(
        f => f.type === 'queue_pressure' && f.depth === 2,
      );
      expect(lowPressure).toBeDefined();
    });

    it('emits queue_pressure on audio data output (un-throttle path)', () => {
      const audioDecoder = createMockAudioDecoder();
      const audioOutput = createMockAudioOutput();
      const feedbacks: DecoderFeedback[] = [];
      const dispatcher = new CommandDispatcher({
        audioDecoder,
        audioOutput,
        audioCodec: 'mp4a.40.2',
        onFeedback: (fb) => feedbacks.push(fb),
      });

      // Simulate high queue depth → pressure fires on decode
      audioDecoder.queueDepth = 9;
      dispatcher.dispatch({
        type: 'decode_audio',
        chunk: { type: 'key', timestamp: 0, data: new Uint8Array(1) } as any,
        renderTimeUs: 0,
      });
      feedbacks.length = 0;

      // Decoder outputs data and queue drops → un-throttle feedback
      audioDecoder.queueDepth = 3;
      audioDecoder._triggerData({}, 200_000);

      const lowPressure = feedbacks.find(
        f => f.type === 'queue_pressure' && f.depth === 3,
      );
      expect(lowPressure).toBeDefined();
    });
  });

  // ─── Reset flush behavior ──────────────────────────────────────

  describe('reset flush (Tranche 1)', () => {
    it('video reset calls videoDecoder.reset() and renderer.flush()', () => {
      const videoDecoder = createMockVideoDecoder();
      const renderer = createMockRenderer();
      const dispatcher = new CommandDispatcher({
        videoDecoder,
        renderer,
        videoCodec: 'avc1.42001f',
        videoWidth: 1920,
        videoHeight: 1080,
      });

      dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'stall' });

      expect(videoDecoder.reset).toHaveBeenCalled();
      expect(renderer.flush).toHaveBeenCalled();
    });

    it('audio reset calls audioDecoder.reset() and audioOutput.flush()', () => {
      const audioDecoder = createMockAudioDecoder();
      const audioOutput = createMockAudioOutput();
      const dispatcher = new CommandDispatcher({
        audioDecoder,
        audioOutput,
        audioCodec: 'opus',
      });

      dispatcher.dispatch({ type: 'reset', mediaType: 'audio', reason: 'stall' });

      expect(audioDecoder.reset).toHaveBeenCalled();
      expect(audioOutput.flush).toHaveBeenCalled();
    });

    it('video reset closes held frames in videoHoldQueue', () => {
      const videoDecoder = createMockVideoDecoder();
      const renderer = createMockRenderer();
      const closeFn = vi.fn();

      const dispatcher = new CommandDispatcher({
        videoDecoder,
        renderer,
        videoCodec: 'avc1.42001f',
        videoWidth: 1920,
        videoHeight: 1080,
        // hasSyncReference returns false → frames go to hold queue
        hasSyncReference: () => false,
      });

      // Configure the decoder
      dispatcher.dispatch({
        type: 'configure',
        mediaType: 'video',
        config: new Uint8Array([0x01, 0x02]),
      });

      // Trigger a decoded frame — it should be held (no sync reference)
      const frame = { close: closeFn, timestamp: 0, duration: 33333 };
      videoDecoder._triggerFrame(frame, 0);

      // Frame should NOT have been enqueued to renderer (held)
      expect(renderer.enqueue).not.toHaveBeenCalled();

      // Reset — held frames should be closed, not drained to renderer
      dispatcher.dispatch({ type: 'reset', mediaType: 'video', reason: 'recovery' });

      expect(closeFn).toHaveBeenCalled();
      expect(renderer.enqueue).not.toHaveBeenCalled();
    });
  });
});

describe('unified playout cushion — audio consumes the shared pipeline delay', () => {
  it('adds getPlaybackDelayUs() to audio render times (same cushion as video recompute)', () => {
    const audioDecoder = createMockAudioDecoder();
    const audioOutput = createMockAudioOutput();
    const _d = new CommandDispatcher({
      audioDecoder, audioOutput,
      getPlaybackDelayUs: () => 200_000,
    });
    audioDecoder._triggerData({ sampleRate: 48000 }, 3000);
    expect(audioOutput.schedule).toHaveBeenCalledWith({ sampleRate: 48000 }, 203_000);
  });

  it('adaptive cushion changes reach subsequent audio schedule() arguments (adoption at anchor/underrun is pinned in webaudio-output.test.ts)', () => {
    const audioDecoder = createMockAudioDecoder();
    const audioOutput = createMockAudioOutput();
    let cushion = 200_000;
    const _d = new CommandDispatcher({
      audioDecoder, audioOutput,
      getPlaybackDelayUs: () => cushion,
    });
    audioDecoder._triggerData({ sampleRate: 48000 }, 1000);
    cushion = 400_000; // adaptive gap timeout grew under jitter
    audioDecoder._triggerData({ sampleRate: 48000 }, 2000);
    expect(audioOutput.schedule).toHaveBeenNthCalledWith(1, expect.anything(), 201_000);
    expect(audioOutput.schedule).toHaveBeenNthCalledWith(2, expect.anything(), 402_000);
  });

  it('without the hook, audio render times pass through unchanged (standalone back-compat)', () => {
    const audioDecoder = createMockAudioDecoder();
    const audioOutput = createMockAudioOutput();
    const _d = new CommandDispatcher({ audioDecoder, audioOutput });
    audioDecoder._triggerData({ sampleRate: 48000 }, 3000);
    expect(audioOutput.schedule).toHaveBeenCalledWith(expect.anything(), 3000);
  });
});
