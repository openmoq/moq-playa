import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebCodecsAudioDecoder } from './webcodecs-audio-decoder.js';

class MockEncodedAudioChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number | undefined;
  readonly data: Uint8Array;

  constructor(init: { type: 'key' | 'delta'; timestamp: number; duration?: number; data: Uint8Array }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.data = init.data;
  }
}

describe('WebCodecsAudioDecoder', () => {
  let decodeSpy: ReturnType<typeof vi.fn>;
  let createdDecoders: Array<{
    decodeQueueSize: number;
    output: (data: unknown) => void;
    error: (error: DOMException) => void;
  }>;

  beforeEach(() => {
    decodeSpy = vi.fn();
    createdDecoders = [];

    class MockAudioDecoder {
      state: AudioDecoderState = 'unconfigured';
      decodeQueueSize = 0;
      readonly output: (data: unknown) => void;
      readonly error: (error: DOMException) => void;

      constructor(init: { output: (data: unknown) => void; error: (error: DOMException) => void }) {
        this.output = init.output;
        this.error = init.error;
        createdDecoders.push(this);
      }

      configure(): void {
        this.state = 'configured';
      }

      decode(chunk: unknown): void {
        decodeSpy(chunk);
      }

      flush = vi.fn().mockResolvedValue(undefined);

      close(): void {
        this.state = 'closed';
      }
    }

    (MockAudioDecoder as any).isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal('AudioDecoder', MockAudioDecoder);
    vi.stubGlobal('EncodedAudioChunk', MockEncodedAudioChunk);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Opus (non-AAC) sidesteps ADTS wrapping — payload bytes are irrelevant here. */
  function configuredDecoder(): WebCodecsAudioDecoder {
    const decoder = new WebCodecsAudioDecoder();
    decoder.configure(new Uint8Array(0), 'opus', 48000, 2);
    return decoder;
  }

  function chunk(timestamp: number): { type: 'key'; timestamp: number; duration: number; data: Uint8Array } {
    return { type: 'key', timestamp, duration: 20_000, data: new Uint8Array([1, 2, 3]) };
  }

  it('pairs each decoder output with its submitted render time (FIFO)', () => {
    const decoder = configuredDecoder();
    const received: number[] = [];
    decoder.onData = (_data, renderTimeUs) => received.push(renderTimeUs);

    decoder.decode(chunk(1), 100);
    decoder.decode(chunk(2), 200);
    decoder.decode(chunk(3), 300);

    const mock = createdDecoders[0]!;
    mock.output({});
    mock.output({});
    mock.output({});

    expect(received).toEqual([100, 200, 300]);
  });

  it('clears queued render times on decode error — outputs after recovery use fresh times', () => {
    const decoder = configuredDecoder();
    const received: number[] = [];
    decoder.onData = (_data, renderTimeUs) => received.push(renderTimeUs);
    const onError = vi.fn();
    decoder.onError = onError;

    // Three chunks in flight; only the first produces output before the error.
    decoder.decode(chunk(1), 100);
    decoder.decode(chunk(2), 200);
    decoder.decode(chunk(3), 300);
    createdDecoders[0]!.output({});
    expect(received).toEqual([100]);

    // Decoder dies — chunks 2 and 3 die with it. Their queued render
    // times (200, 300) MUST be discarded, or every later output pops a
    // stale entry and audio drifts permanently behind (A/V desync).
    createdDecoders[0]!.error(new DOMException('Decoding error.', 'EncodingError'));
    expect(onError).toHaveBeenCalledOnce();
    expect(createdDecoders).toHaveLength(2); // recreated

    decoder.decode(chunk(4), 999);
    createdDecoders[1]!.output({});

    expect(received).toEqual([100, 999]);
  });

  it('preserves the chunk timestamp through decode (CaptureTimestamp fidelity)', () => {
    // LOC sets EncodedAudioChunk.timestamp = CaptureTimestamp; the playhead
    // mapping (WebAudioOutput.playheadCaptureUs) depends on that value
    // surviving decode untouched. Our decoder must (a) pass the chunk
    // timestamp into the EncodedAudioChunk verbatim and (b) hand the
    // decoder's AudioData to onData unmodified. (The browser preserving
    // chunk→AudioData timestamps is WebCodecs-spec behavior, verified
    // end-to-end in Chrome by the skew harness.)
    const decoder = configuredDecoder();
    const received: any[] = [];
    decoder.onData = (data) => received.push(data);

    decoder.decode({ type: 'key', timestamp: 1_234_567, duration: 20_000, data: new Uint8Array([1]) }, 99);

    const submitted = decodeSpy.mock.calls[0]![0] as { timestamp: number };
    expect(submitted.timestamp).toBe(1_234_567);

    const fakeAudioData = { timestamp: 1_234_567 };
    createdDecoders[0]!.output(fakeAudioData);
    expect(received[0]).toBe(fakeAudioData); // same object, timestamp untouched
  });

  it('resets and reports on decode queue overflow instead of dropping silently', () => {
    const decoder = configuredDecoder();
    const received: number[] = [];
    decoder.onData = (_data, renderTimeUs) => received.push(renderTimeUs);
    const onError = vi.fn();
    decoder.onError = onError;

    // Decoder stopped draining — queue is at the cap.
    createdDecoders[0]!.decodeQueueSize = 32;
    decoder.decode(chunk(1), 100);

    // Overflow must be observable (like the video decoder), not a silent drop.
    expect(decodeSpy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/queue overflow/);
    expect(createdDecoders).toHaveLength(2); // reset → fresh decoder, empty queue

    // Recovery is immediate — the next frame decodes with a fresh render time.
    decoder.decode(chunk(2), 200);
    expect(decodeSpy).toHaveBeenCalledOnce();
    createdDecoders[1]!.output({});
    expect(received).toEqual([200]);
  });
});
