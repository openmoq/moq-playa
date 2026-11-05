import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebCodecsVideoDecoder } from './webcodecs-video-decoder.js';
import type { VideoRenderTiming } from '@openmoq/playback';
import { PlaybackPipeline, SyncController } from '@openmoq/playback';
import { varint } from '../../transport/src/index.js';
import { CommandDispatcher } from '../../player/src/command-dispatcher.js';

type VideoDecoderState = VideoDecoder['state'];

class MockEncodedVideoChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number;
  readonly data: Uint8Array;

  constructor(init: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.data = init.data;
  }
}

describe('WebCodecsVideoDecoder', () => {
  let decodeSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let createdDecoders: Array<{ error: (error: DOMException) => void; output: (frame: VideoFrame) => void;
    state: VideoDecoderState; flush: () => Promise<void> }>;

  beforeEach(() => {
    decodeSpy = vi.fn();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createdDecoders = [];

    class MockVideoDecoder {
      state: VideoDecoderState = 'unconfigured';
      decodeQueueSize = 0;
      readonly output: (frame: VideoFrame) => void;
      readonly error: (error: DOMException) => void;

      constructor(init: { output: (frame: VideoFrame) => void; error: (error: DOMException) => void }) {
        this.output = init.output;
        this.error = init.error;
        createdDecoders.push(this);
      }

      lastConfig: any = null;
      configure(config?: any): void {
        this.lastConfig = config;
        this.state = 'configured';
      }

      decode(chunk: unknown): void {
        decodeSpy(chunk);
      }

      flush = vi.fn().mockResolvedValue(undefined);

      reset(): void {}

      close(): void {
        this.state = 'closed';
      }
    }

    (MockVideoDecoder as any).isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal('VideoDecoder', MockVideoDecoder);
    vi.stubGlobal('EncodedVideoChunk', MockEncodedVideoChunk);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  describe('producing output timing', () => {
    function chunk(timestamp: number) {
      return { type: 'key' as const, timestamp, duration: 33_333, data: Uint8Array.of(1),
        sourceTimestamp: { ticks: BigInt(timestamp), ticksPerSecond: 1_000_000n, domain: 'media' as const } };
    }
    function frame(timestamp: number) { return { timestamp, close: vi.fn() }; }
    function emit(index: number, value: ReturnType<typeof frame>) { createdDecoders[index]!.output(value as unknown as VideoFrame); }
    function outputTimings(decoder: WebCodecsVideoDecoder) {
      return (decoder as unknown as { owner: { outputTimings?: Map<number, VideoRenderTiming | null | undefined> } }).owner.outputTimings;
    }

    it('schedules held, reordered native output with the provider that produced each decode', () => {
      const decoder = new WebCodecsVideoDecoder();
      const renderer = { enqueue: vi.fn(), flush() {}, destroy() {}, onFirstFrame: null, onFrameRendered: null, onStall: null };
      let ready = false, now = 0;
      const sync = new SyncController({ clock: { now: () => now }, driftThresholdUs: 500_000 });
      sync.setAudioReference(990_000_000n); now = 9_980_000;
      const global = vi.fn(() => 9_000_000);
      const dispatcher = new CommandDispatcher({ videoDecoder: decoder, renderer, videoCodec: 'test',
        hasSyncReference: () => ready, getPlaybackDelayUs: () => 2_000, recomputeVideoRenderTime: global });
      const pipeline = new PlaybackPipeline({ mediaType: 'video', clock: { now: () => now }, sync,
        config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 100 },
        onCommand: command => dispatcher.dispatch(command), onEvent() {} });
      pipeline.configure(Uint8Array.of(1));
      const firstSeen: bigint[] = [], secondSeen: bigint[] = [];
      const provider = (seen: bigint[], origin: bigint, nominal: number) => ({ computeVideoRenderTime(timestamp: bigint) {
        seen.push(timestamp); return { renderTimeUs: nominal + Number(timestamp - origin), offsetUs: 20_000, shouldDrop: false };
      } });
      const push = (id: number, timestamp: bigint) => {
        pipeline.pushObject({ kind: 'data', trackAlias: varint(1), groupId: varint(0), subgroupId: varint(0),
          objectId: varint(id), publisherPriority: 128, extensions: undefined, payload: Uint8Array.of(1) },
        { captureTimestamp: timestamp, timestamp, timescale: 1_000_000n,
          videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } });
        pipeline.tick();
      };
      try {
        pipeline.setVideoTimingSource(provider(firstSeen, 90_000_000n, 10_000_000)); push(0, 90_000_000n);
        pipeline.setVideoTimingSource(provider(secondSeen, 190_000_000n, 11_000_000)); push(1, 190_000_000n);
        const second = frame(190_000_000), first = frame(90_000_000);
        emit(0, second); emit(0, first);
        expect(renderer.enqueue).not.toHaveBeenCalled();
        pipeline.setVideoTimingSource(undefined); push(2, 1_000_020_000n);
        ready = true; const ordinary = frame(1_000_020_000); emit(0, ordinary);
        expect(renderer.enqueue).toHaveBeenNthCalledWith(1, second, 11_002_000);
        expect(renderer.enqueue).toHaveBeenNthCalledWith(2, first, 10_002_000);
        expect(renderer.enqueue).toHaveBeenNthCalledWith(3, ordinary, 9_000_000);
        expect(firstSeen).toEqual([90_000_000n, 90_000_000n]);
        expect(secondSeen).toEqual([190_000_000n, 190_000_000n]);
        expect(global).toHaveBeenCalledOnce();
      } finally { dispatcher.destroy(); decoder.destroy(); }
    });

    it('advertises timing association and returns each producing context out of order', () => {
      const decoder = new WebCodecsVideoDecoder(), output = vi.fn(), one = {}, two = {};
      decoder.onFrame = output; decoder.configure(Uint8Array.of(1), 'test');
      const a = Object.freeze({ recomputeRenderTimeUs: () => 10_000 });
      const b = Object.freeze({ recomputeRenderTimeUs: () => 20_000 });
      const first = chunk(90), second = chunk(91);
      decoder.decode(first, 1, one, a); decoder.decode(second, 2, two, b);
      const later = frame(91), earlier = frame(90); emit(0, later); emit(0, earlier);
      expect(decoder.supportsOutputTiming).toBe(true);
      expect(output).toHaveBeenNthCalledWith(1, later, 2, second.sourceTimestamp, two, b);
      expect(output).toHaveBeenNthCalledWith(2, earlier, 1, first.sourceTimestamp, one, a);
      expect(outputTimings(decoder)?.size).toBeLessThanOrEqual(256);
      decoder.destroy();
    });

    it.each([false, true])('does not assign a duplicate timestamp to either producing context: normalCollision=%s', normal => {
      const decoder = new WebCodecsVideoDecoder(), output = vi.fn();
      decoder.onFrame = output; decoder.configure(Uint8Array.of(1), 'test');
      decoder.decode(chunk(90), 1, undefined, { recomputeRenderTimeUs: () => 10 });
      decoder.decode(chunk(90), 2, undefined, normal ? undefined : { recomputeRenderTimeUs: () => 20 });
      const first = frame(90), second = frame(90); emit(0, first); emit(0, second);
      expect(output.mock.calls.map(call => call[4])).toEqual([null, null]);
      decoder.destroy();
    });

    it('marks an unsafe mapped timestamp unavailable instead of reverting to global scheduling', () => {
      const decoder = new WebCodecsVideoDecoder(), output = vi.fn();
      decoder.onFrame = output; decoder.configure(Uint8Array.of(1), 'test');
      const timestamp = 2 ** 54;
      decoder.decode(chunk(timestamp), 1, undefined, { recomputeRenderTimeUs: () => 10 });
      emit(0, frame(timestamp));
      expect(output.mock.calls[0]?.[4]).toBeNull();
      decoder.destroy();
    });

    it('bounds mapped metadata with source-time eviction and retains ordinary output arity', () => {
      const decoder = new WebCodecsVideoDecoder(), output = vi.fn();
      decoder.onFrame = output; decoder.configure(Uint8Array.of(1), 'test');
      decoder.decode(chunk(10), 1, undefined, { recomputeRenderTimeUs: () => 10 });
      for (let timestamp = 11; timestamp <= 266; timestamp++) decoder.decode(chunk(timestamp), 1);
      expect(outputTimings(decoder)?.size).toBeLessThanOrEqual(256);
      emit(0, frame(10));
      expect(output.mock.calls[0]?.[4]).toBeNull();
      emit(0, frame(266));
      expect(output.mock.calls[1]).toHaveLength(3);
      decoder.destroy();
    });

    it('does not allocate a timing map or extend default output arguments when unused', () => {
      const decoder = new WebCodecsVideoDecoder(), output = vi.fn();
      decoder.onFrame = output; decoder.configure(Uint8Array.of(1), 'test');
      decoder.decode(chunk(10), 11); const value = frame(10); emit(0, value);
      expect(outputTimings(decoder)).toBeUndefined();
      expect(output).toHaveBeenCalledExactlyOnceWith(value, 11, chunk(10).sourceTimestamp);
      decoder.destroy();
    });

    it('retires timing at reset and cannot transfer it to the new native owner', () => {
      const decoder = new WebCodecsVideoDecoder(), output = vi.fn();
      decoder.onFrame = output; decoder.configure(Uint8Array.of(1), 'test');
      decoder.decode(chunk(10), 1, undefined, { recomputeRenderTimeUs: () => 10 });
      decoder.reset(); const stale = frame(10); emit(0, stale);
      expect(stale.close).toHaveBeenCalledOnce(); expect(output).not.toHaveBeenCalled();
      decoder.decode(chunk(10), 2); emit(1, frame(10));
      expect(output.mock.calls[0]).toHaveLength(3);
      expect(outputTimings(decoder)).toBeUndefined();
      decoder.destroy();
    });

    it('retains the context of a draining native predecessor across reconfiguration', async () => {
      const decoder = new WebCodecsVideoDecoder(), output = vi.fn();
      decoder.onFrame = output; decoder.configure(Uint8Array.of(1), 'test');
      const a = { recomputeRenderTimeUs: () => 10 }, b = { recomputeRenderTimeUs: () => 20 };
      decoder.decode(chunk(10), 1, undefined, a);
      decoder.configure(Uint8Array.of(2), 'test-two'); decoder.decode(chunk(10), 2, undefined, b);
      emit(1, frame(10)); emit(0, frame(10));
      expect(output.mock.calls.map(call => call[4])).toEqual([b, a]);
      await Promise.resolve(); await Promise.resolve();
      const retired = frame(10); emit(0, retired);
      expect(retired.close).toHaveBeenCalledOnce();
      decoder.destroy();
    });
  });

  it('drops reserved NAL type 0 chunks before decode', () => {
    const decoder = new WebCodecsVideoDecoder();
    decoder.configure(buildAvccDescription(), 'avc1.42c01f', 640, 368);

    decoder.decode({
      type: 'delta',
      timestamp: 1,
      duration: 33333,
      data: annexb([new Uint8Array([0xe0, 0x11, 0x22, 0x33])]),
    }, 0);

    // NAL type 0 is reserved — stripped by H264Strategy.
    // No VCL NALs remain, so prepareChunkData returns null (chunk dropped).
    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it('strips unsupported partition NALs and decodes remaining AVC payload', () => {
    const decoder = new WebCodecsVideoDecoder();
    decoder.debug = true;
    decoder.configure(buildAvccDescription(), 'avc1.42c01f', 640, 368);

    decoder.decode({
      type: 'key',
      timestamp: 1,
      duration: 33333,
      data: annexb([new Uint8Array([0x65, 0x88, 0x99, 0xaa])]),
    }, 0);

    decodeSpy.mockClear();
    warnSpy.mockClear();

    decoder.decode({
      type: 'delta',
      timestamp: 2,
      duration: 33333,
      data: annexb([
        new Uint8Array([0xa3, 0x01, 0x02]), // nal type 3
        new Uint8Array([0x41, 0xaa, 0xbb, 0xcc]), // nal type 1
      ]),
    }, 0);

    expect(decodeSpy).toHaveBeenCalledOnce();
    const chunk = decodeSpy.mock.calls[0]![0] as MockEncodedVideoChunk;
    expect(Array.from(chunk.data)).toEqual([0, 0, 0, 4, 0x41, 0xaa, 0xbb, 0xcc]);
    expect(warnSpy).toHaveBeenCalledWith(
      '[WebCodecsVideoDecoder] Dropped NAL/OBU units: nal-type-3',
    );
  });

  it('recreates AVC decoder after decode error and waits for next IDR', () => {
    const decoder = new WebCodecsVideoDecoder();
    const onError = vi.fn();
    decoder.onError = onError;
    decoder.configure(buildAvccDescription(), 'avc1.42c01f', 640, 368);

    expect(createdDecoders).toHaveLength(1);
    createdDecoders[0]!.error(new DOMException('Decoding error.', 'EncodingError'));

    expect(onError).toHaveBeenCalledOnce();
    expect(createdDecoders).toHaveLength(2);

    decoder.decode({
      type: 'delta',
      timestamp: 10,
      duration: 33333,
      data: annexb([new Uint8Array([0x41, 0x01, 0x02, 0x03])]),
    }, 0);
    expect(decodeSpy).not.toHaveBeenCalled();

    decoder.decode({
      type: 'key',
      timestamp: 11,
      duration: 33333,
      data: annexb([new Uint8Array([0x65, 0x11, 0x22, 0x33])]),
    }, 0);
    expect(decodeSpy).toHaveBeenCalledOnce();
  });
  it('defaults to hardware acceleration for H.264', () => {
    let configuredWith: VideoDecoderConfig | undefined;
    vi.stubGlobal('VideoDecoder', class {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      state: VideoDecoderState = 'unconfigured';
      decodeQueueSize = 0;
      constructor(_init: any) {}
      configure(config: VideoDecoderConfig): void {
        configuredWith = config;
        this.state = 'configured';
      }
      decode(): void {}
      flush(): Promise<void> { return Promise.resolve(); }
      reset(): void {}
      close(): void { this.state = 'closed'; }
    });

    const decoder = new WebCodecsVideoDecoder();
    decoder.configure(buildAvccDescription(), 'avc1.42c01f', 640, 368);

    // Default: no prefer-software — let browser pick (hardware when available)
    expect(configuredWith?.hardwareAcceleration).toBeUndefined();
  });

  it('preferSoftwareDecoder forces software acceleration for H.264', () => {
    let configuredWith: VideoDecoderConfig | undefined;
    vi.stubGlobal('VideoDecoder', class {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      state: VideoDecoderState = 'unconfigured';
      decodeQueueSize = 0;
      constructor(_init: any) {}
      configure(config: VideoDecoderConfig): void {
        configuredWith = config;
        this.state = 'configured';
      }
      decode(): void {}
      flush(): Promise<void> { return Promise.resolve(); }
      reset(): void {}
      close(): void { this.state = 'closed'; }
    });

    const decoder = new WebCodecsVideoDecoder({ preferSoftwareDecoder: true });
    decoder.configure(buildAvccDescription(), 'avc1.42c01f', 640, 368);

    expect(configuredWith?.hardwareAcceleration).toBe('prefer-software');
  });

  it('AV1 configure does NOT set description', () => {
    let configuredWith: VideoDecoderConfig | undefined;
    vi.stubGlobal('VideoDecoder', class {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      state: VideoDecoderState = 'unconfigured';
      decodeQueueSize = 0;
      constructor(_init: any) {}
      configure(config: VideoDecoderConfig): void {
        configuredWith = config;
        this.state = 'configured';
      }
      decode(): void {}
      flush(): Promise<void> { return Promise.resolve(); }
      reset(): void {}
      close(): void { this.state = 'closed'; }
    });

    const decoder = new WebCodecsVideoDecoder();
    // Pass a non-empty config — AV1 should ignore it
    decoder.configure(new Uint8Array([0x81, 0x04, 0x0C, 0x00]), 'av01.0.08M.10', 1920, 1080);

    expect(configuredWith?.description).toBeUndefined();
  });

  it('HEVC configure sets description from HVCC record', () => {
    let configuredWith: VideoDecoderConfig | undefined;
    vi.stubGlobal('VideoDecoder', class {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      state: VideoDecoderState = 'unconfigured';
      decodeQueueSize = 0;
      constructor(_init: any) {}
      configure(config: VideoDecoderConfig): void {
        configuredWith = config;
        this.state = 'configured';
      }
      decode(): void {}
      flush(): Promise<void> { return Promise.resolve(); }
      reset(): void {}
      close(): void { this.state = 'closed'; }
    });

    const hvcc = new Uint8Array(23);
    hvcc[0] = 0x01; // configurationVersion
    hvcc[21] = 0xFF; // lengthSizeMinusOne = 3

    const decoder = new WebCodecsVideoDecoder();
    decoder.configure(hvcc, 'hvc1.1.6.L120.B0', 1920, 1080);

    expect(configuredWith?.description).toBeDefined();
    expect(configuredWith?.codec).toBe('hvc1.1.6.L120.B0');
  });

  it('HEVC gates on IRAP keyframe after configure', () => {
    const decoder = new WebCodecsVideoDecoder();
    decoder.configure(new Uint8Array(0), 'hvc1.1.6.L120.B0', 1920, 1080);

    // TRAIL_R (type 1) delta — should be gated
    const trailR = new Uint8Array([0x02, 0x01, 0xAA, 0xAA]); // (1 << 1) = 0x02
    decoder.decode({
      type: 'delta',
      timestamp: 1,
      duration: 33333,
      data: new Uint8Array([0x00, 0x00, 0x00, 0x04, ...trailR]),
    }, 0);
    expect(decodeSpy).not.toHaveBeenCalled();

    // IDR_W_RADL (type 19) key — should pass gate
    const idr = new Uint8Array([0x26, 0x01, 0xAA, 0xAA]); // (19 << 1) = 0x26
    decoder.decode({
      type: 'key',
      timestamp: 2,
      duration: 33333,
      data: new Uint8Array([0x00, 0x00, 0x00, 0x04, ...idr]),
    }, 0);
    expect(decodeSpy).toHaveBeenCalledOnce();
  });

  it('AV1 gates on sequence header after configure', () => {
    const decoder = new WebCodecsVideoDecoder();
    decoder.configure(new Uint8Array(0), 'av01.0.08M.10', 1920, 1080);

    // Frame OBU without sequence header — should be gated
    // OBU_FRAME (type 6), has_size_field=1: (6 << 3) | 0x02 = 0x32
    decoder.decode({
      type: 'key',
      timestamp: 1,
      duration: 33333,
      data: new Uint8Array([0x32, 0x02, 0x10, 0x20]),
    }, 0);
    expect(decodeSpy).not.toHaveBeenCalled();

    // Sequence header + frame — should pass gate
    // OBU_SEQUENCE_HEADER (type 1), has_size_field=1: (1 << 3) | 0x02 = 0x0A
    decoder.decode({
      type: 'key',
      timestamp: 2,
      duration: 33333,
      data: new Uint8Array([0x0A, 0x01, 0xFF, 0x32, 0x02, 0x10, 0x20]),
    }, 0);
    expect(decodeSpy).toHaveBeenCalledOnce();
  });

  it('preferSoftwareDecoder does not affect non-H.264 codecs', () => {
    let configuredWith: VideoDecoderConfig | undefined;
    vi.stubGlobal('VideoDecoder', class {
      static isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
      state: VideoDecoderState = 'unconfigured';
      decodeQueueSize = 0;
      constructor(_init: any) {}
      configure(config: VideoDecoderConfig): void {
        configuredWith = config;
        this.state = 'configured';
      }
      decode(): void {}
      flush(): Promise<void> { return Promise.resolve(); }
      reset(): void {}
      close(): void { this.state = 'closed'; }
    });

    const decoder = new WebCodecsVideoDecoder({ preferSoftwareDecoder: true });
    decoder.configure(new Uint8Array(0), 'av01.0.08M.10', 1920, 1080);

    expect(configuredWith?.hardwareAcceleration).toBeUndefined();
  });

  it('decode error + isConfigSupported=false → clean shutdown, no recovery loop', async () => {
    /**
     * When isConfigSupported returns false (advisory) AND a decode error
     * follows, the decoder should close cleanly with a clear message
     * instead of entering the recovery loop.
     *
     * This is the Firefox/HEVC and Safari/AV1 path.
     */
    (VideoDecoder as any).isConfigSupported = vi.fn().mockResolvedValue({ supported: false });

    const decoder = new WebCodecsVideoDecoder();
    const onError = vi.fn();
    decoder.onError = onError;
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    // Let the async isConfigSupported() resolve (sets advisory flag)
    await new Promise(r => setTimeout(r, 10));

    // Simulate a decode error from WebCodecs
    createdDecoders[0]!.error(new DOMException('Decoding error.', 'EncodingError'));

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].message).toContain('Codec not supported');

    // No recovery loop — only the original decoder, no extras
    expect(createdDecoders).toHaveLength(1);
  });

  it('isConfigSupported=false alone does NOT kill the decoder (advisory only)', async () => {
    /**
     * isConfigSupported can return false for configs that work at runtime
     * (e.g., non-standard resolutions). The flag is advisory — the decoder
     * should keep working until an actual decode error occurs.
     */
    (VideoDecoder as any).isConfigSupported = vi.fn().mockResolvedValue({ supported: false });

    const decoder = new WebCodecsVideoDecoder();
    const onError = vi.fn();
    decoder.onError = onError;
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    // Let the async check resolve
    await new Promise(r => setTimeout(r, 10));

    // No error fired — decoder is still alive
    expect(onError).not.toHaveBeenCalled();

    // Decode still works
    decoder.decode({
      type: 'key',
      timestamp: 1,
      duration: 33333,
      data: annexb([new Uint8Array([0x65, 0x88, 0x84, 0xFF])]),
    }, 0);
    expect(decodeSpy).toHaveBeenCalled();
  });

  it('normal decode errors trigger recovery when isConfigSupported=true', async () => {
    /**
     * When isConfigSupported returns true, decode errors should go through
     * normal recovery (createDecoder + applyConfig), not clean shutdown.
     */
    (VideoDecoder as any).isConfigSupported = vi.fn().mockResolvedValue({ supported: true });

    const decoder = new WebCodecsVideoDecoder();
    const onError = vi.fn();
    decoder.onError = onError;
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);
    await new Promise(r => setTimeout(r, 10));

    // Simulate decode error
    createdDecoders[0]!.error(new DOMException('Decoding error.', 'EncodingError'));

    expect(onError).toHaveBeenCalledOnce();
    // Should NOT contain "Codec not supported" — it's a regular decode error
    expect(onError.mock.calls[0]![0].message).not.toContain('Codec not supported');
    // Recovery should have created a second decoder
    expect(createdDecoders).toHaveLength(2);
  });

  it('proceeds normally when isConfigSupported returns true', async () => {
    const decoder = new WebCodecsVideoDecoder();
    const onError = vi.fn();
    decoder.onError = onError;
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();

    decoder.decode({
      type: 'key',
      timestamp: 1,
      duration: 33333,
      data: annexb([new Uint8Array([0x65, 0x88, 0x84, 0xFF])]),
    }, 0);
    expect(decodeSpy).toHaveBeenCalledOnce();
  });

  it('continues if isConfigSupported throws', async () => {
    (VideoDecoder as any).isConfigSupported = vi.fn().mockRejectedValue(new Error('not implemented'));

    const decoder = new WebCodecsVideoDecoder();
    const onError = vi.fn();
    decoder.onError = onError;
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();

    decoder.decode({
      type: 'key',
      timestamp: 1,
      duration: 33333,
      data: annexb([new Uint8Array([0x65, 0x88, 0x84, 0xFF])]),
    }, 0);
    expect(decodeSpy).toHaveBeenCalledOnce();
  });

  // ─── Flush-before-reconfigure (seamless ABR switch) ──────────────

  it('flushes old decoder before closing during codec switch', async () => {
    /**
     * When configure() is called with a different codec (track switch),
     * the old decoder must be flushed to push pending frames to the
     * renderer before being destroyed. This prevents the frame gap
     * that causes visible stutter during ABR switches.
     *
     * @see draft-ietf-moq-msf-00 §4.2 (seamless switch at group boundaries)
     */
    const decoder = new WebCodecsVideoDecoder();
    decoder.onFrame = vi.fn();
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    const oldDecoder = createdDecoders[0]!;
    expect(oldDecoder.flush).not.toHaveBeenCalled();

    // Switch to HEVC — should flush old decoder
    decoder.configure(new Uint8Array([0x01]), 'hev1.1.6.L90.90', 636, 480);

    expect(oldDecoder.flush).toHaveBeenCalledOnce();
    // New decoder created
    expect(createdDecoders).toHaveLength(2);
  });

  it('old decoder NOT closed synchronously — closed after flush resolves', async () => {
    const decoder = new WebCodecsVideoDecoder();
    decoder.onFrame = vi.fn();
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    const oldDecoder = createdDecoders[0]!;

    // Switch codec
    decoder.configure(new Uint8Array([0x01]), 'hev1.1.6.L90.90', 636, 480);

    // Old decoder NOT closed synchronously (flush is async)
    expect(oldDecoder.state).not.toBe('closed');

    // After flush resolves, old decoder is closed
    await new Promise(r => setTimeout(r, 10));
    expect(oldDecoder.state).toBe('closed');
  });

  it('old decoder closed even if flush rejects', async () => {
    const decoder = new WebCodecsVideoDecoder();
    decoder.onFrame = vi.fn();
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    const oldDecoder = createdDecoders[0]!;
    oldDecoder.flush = vi.fn().mockRejectedValue(new Error('decoder error'));

    // Switch codec — flush rejects
    decoder.configure(new Uint8Array([0x01]), 'hev1.1.6.L90.90', 636, 480);

    await new Promise(r => setTimeout(r, 10));
    // Old decoder still closed despite flush rejection
    expect(oldDecoder.state).toBe('closed');
  });

  it('same-codec reconfigure does NOT flush', () => {
    /**
     * Reconfigures with the same codec (e.g., updated SPS/PPS from LOC
     * VideoConfig header on a keyframe) should NOT flush — it's the same
     * track, just updated description bytes.
     */
    const decoder = new WebCodecsVideoDecoder();
    decoder.onFrame = vi.fn();
    decoder.configure(buildAvccDescription(), 'avc1.640028', 1920, 1080);

    const oldDecoder = createdDecoders[0]!;

    // Same codec, different description
    decoder.configure(new Uint8Array([0x01, 0x42, 0xc0, 0x1f, 0xff]), 'avc1.640028', 1920, 1080);

    expect(oldDecoder.flush).not.toHaveBeenCalled();
  });

  // ─── Deterministic congestion sim tests ────────────────────────

  describe('queue overflow congestion', () => {
    it('queue overflow resets decoder and sets awaitingKeyframe instead of silent drop', () => {
      const decoder = new WebCodecsVideoDecoder();
      decoder.configure(buildAvccDescription(), 'avc1.42c01f', 640, 368);

      // Send keyframe to satisfy initial awaitingKeyframe gate
      decoder.decode({
        type: 'key',
        timestamp: 0,
        duration: 33333,
        data: annexb([new Uint8Array([0x65, 0x88, 0x99, 0xaa])]),
      }, 0);

      // Simulate queue pressure: set decodeQueueSize to overflow
      const mockDecoder = createdDecoders[createdDecoders.length - 1]!;
      (mockDecoder as any).decodeQueueSize = 16;

      decodeSpy.mockClear();

      // Send a delta frame while queue is overflowed
      decoder.decode({
        type: 'delta',
        timestamp: 33333,
        duration: 33333,
        data: annexb([new Uint8Array([0x41, 0xaa, 0xbb])]),
      }, 33333);

      // Reduce queue pressure
      (mockDecoder as any).decodeQueueSize = 0;

      // Send another delta — should be REJECTED because awaitingKeyframe
      decodeSpy.mockClear();
      decoder.decode({
        type: 'delta',
        timestamp: 66666,
        duration: 33333,
        data: annexb([new Uint8Array([0x41, 0xcc, 0xdd])]),
      }, 66666);

      expect(decodeSpy).not.toHaveBeenCalled();

      // Send a keyframe — should be ACCEPTED
      decoder.decode({
        type: 'key',
        timestamp: 99999,
        duration: 33333,
        data: annexb([new Uint8Array([0x65, 0x11, 0x22, 0x33])]),
      }, 99999);

      expect(decodeSpy).toHaveBeenCalledTimes(1);
    });

    it('overflow reconfigure preserves description and codedWidth/Height', () => {
      const decoder = new WebCodecsVideoDecoder();
      const desc = buildAvccDescription();
      decoder.configure(desc, 'avc1.42c01f', 640, 368);

      // Verify initial config
      const initialDecoder = createdDecoders[createdDecoders.length - 1]!;
      expect((initialDecoder as any).lastConfig?.description).toBe(desc);
      expect((initialDecoder as any).lastConfig?.codedWidth).toBe(640);
      expect((initialDecoder as any).lastConfig?.codedHeight).toBe(368);

      // Send keyframe to clear awaitingKeyframe
      decoder.decode({
        type: 'key',
        timestamp: 0,
        duration: 33333,
        data: annexb([new Uint8Array([0x65, 0x88, 0x99, 0xaa])]),
      }, 0);

      // Overflow
      (initialDecoder as any).decodeQueueSize = 16;
      decoder.decode({
        type: 'delta',
        timestamp: 33333,
        duration: 33333,
        data: annexb([new Uint8Array([0x41, 0xaa, 0xbb])]),
      }, 33333);

      // After overflow, decoder should be reconfigured with full config
      const postOverflowDecoder = createdDecoders[createdDecoders.length - 1]!;
      expect((postOverflowDecoder as any).lastConfig?.description).toBe(desc);
      expect((postOverflowDecoder as any).lastConfig?.codedWidth).toBe(640);
      expect((postOverflowDecoder as any).lastConfig?.codedHeight).toBe(368);
    });

    it('queue overflow emits onError so pipeline can react', () => {
      const decoder = new WebCodecsVideoDecoder();
      const errorFn = vi.fn();
      decoder.onError = errorFn;
      decoder.configure(buildAvccDescription(), 'avc1.42c01f', 640, 368);

      // Send keyframe
      decoder.decode({
        type: 'key',
        timestamp: 0,
        duration: 33333,
        data: annexb([new Uint8Array([0x65, 0x88, 0x99, 0xaa])]),
      }, 0);

      // Overflow queue
      const mockDecoder = createdDecoders[createdDecoders.length - 1]!;
      (mockDecoder as any).decodeQueueSize = 16;

      // Send delta during overflow
      decoder.decode({
        type: 'delta',
        timestamp: 33333,
        duration: 33333,
        data: annexb([new Uint8Array([0x41, 0xaa, 0xbb])]),
      }, 33333);

      // Should have notified via onError
      expect(errorFn).toHaveBeenCalled();
    });
  });
});

function annexb(nals: Uint8Array[]): Uint8Array {
  const total = nals.reduce((sum, nal) => sum + 4 + nal.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const nal of nals) {
    out.set([0x00, 0x00, 0x00, 0x01], pos);
    pos += 4;
    out.set(nal, pos);
    pos += nal.byteLength;
  }
  return out;
}

function buildAvccDescription(): Uint8Array {
  return Uint8Array.from([
    0x01, 0x42, 0xc0, 0x1f, 0xff, 0xe1, 0x00, 0x18,
    0x67, 0x42, 0xc0, 0x1f, 0xd9, 0x00, 0xa0, 0x2f,
    0xb0, 0x11, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00,
    0x00, 0x03, 0x00, 0x3c, 0x0f, 0x18, 0x32, 0x48,
    0x01, 0x00, 0x04, 0x68, 0xcb, 0x8c, 0xb2,
  ]);
}

