import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceTimestamp, VideoChunkInit } from '@openmoq/loc';
import { WebCodecsVideoDecoder } from './webcodecs-video-decoder.js';

class NativeDecoder {
  static instances: NativeDecoder[] = [];
  static isConfigSupported = vi.fn(async () => ({ supported: true }));
  static onConstruct: ((decoder: NativeDecoder) => void) | null = null;
  state: VideoDecoderState = 'unconfigured';
  decodeQueueSize = 0;
  configure = vi.fn(() => { this.state = 'configured'; });
  decode = vi.fn();
  flush = vi.fn(async () => {});
  reset = vi.fn();
  close = vi.fn(() => { this.state = 'closed'; });
  constructor(readonly callbacks: VideoDecoderInit) {
    NativeDecoder.instances.push(this);
    NativeDecoder.onConstruct?.(this);
  }
  output(timestamp: number) {
    const frame = { timestamp, close: vi.fn() };
    this.callbacks.output(frame as unknown as VideoFrame);
    return frame;
  }
}

const source = (ticks: bigint, ticksPerSecond = 1_000_000n): SourceTimestamp => ({ ticks, ticksPerSecond, domain: 'media' });
const chunk = (timestamp: number, time: SourceTimestamp | undefined = source(BigInt(timestamp))): VideoChunkInit => ({
  type: 'key', timestamp, data: Uint8Array.of(1), ...(time ? { sourceTimestamp: time } : {}),
});

function setup(codec = 'test-codec') {
  const decoder = new WebCodecsVideoDecoder();
  decoder.configure(new Uint8Array(), codec);
  const onFrame = vi.fn();
  decoder.onFrame = onFrame;
  return { decoder, onFrame, native: NativeDecoder.instances.at(-1)! };
}

describe('decoded video source timestamp ownership', () => {
  beforeEach(() => {
    NativeDecoder.instances = [];
    NativeDecoder.onConstruct = null;
    NativeDecoder.isConfigSupported.mockReset();
    NativeDecoder.isConfigSupported.mockResolvedValue({ supported: true });
    vi.stubGlobal('VideoDecoder', NativeDecoder);
    vi.stubGlobal('EncodedVideoChunk', class {
      readonly timestamp: number;
      constructor(init: EncodedVideoChunkInit) { this.timestamp = init.timestamp; }
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('correlates reordered output with exact input time, not the latest submitted chunk', () => {
    const { decoder, onFrame, native } = setup();
    const exact = source(9007199254740993n, 9007199254740993000n);
    decoder.decode(chunk(1000, exact), 111);
    decoder.decode(chunk(2000), 222);
    const second = native.output(2000);
    const first = native.output(1000);
    expect(onFrame.mock.calls).toEqual([[second, 222, source(2000n)], [first, 111, exact]]);
    decoder.destroy();
  });

  it('snapshots input scalars before asynchronous output', () => {
    const { decoder, onFrame, native } = setup();
    const mutable = { ...source(1000n) };
    decoder.decode(chunk(1000, mutable), 111);
    mutable.ticks = 1001n;
    native.output(1000);
    expect(onFrame.mock.calls[0]![2]).toEqual(source(1000n));
    expect(Object.isFrozen(onFrame.mock.calls[0]![2])).toBe(true);
    decoder.destroy();
  });

  it('validates source time against the submitted timestamp even if metadata mutates the input', () => {
    const { decoder, onFrame, native } = setup();
    const input = { ...chunk(1000), get sourceTimestamp() {
      input.timestamp = 2000;
      return source(2000n);
    } };
    decoder.decode(input, 111);
    expect(native.decode.mock.calls[0]![0].timestamp).toBe(1000);
    const frame = native.output(1000);
    expect(onFrame).toHaveBeenLastCalledWith(frame, 111, null);
    decoder.destroy();
  });

  it.each(['reset', 'recover', 'configure'] as const)('renews pending codec support evidence after %s replaces its owner', async (replacement) => {
    let settle!: (value: { supported: boolean }) => void;
    NativeDecoder.isConfigSupported.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const { decoder, native } = setup('av01.0.08M.10');
    const staleSettle = settle;
    const error = vi.fn();
    decoder.onError = error;
    if (replacement === 'reset') decoder.reset();
    else if (replacement === 'recover') native.callbacks.error(new DOMException('early error', 'EncodingError'));
    else decoder.configure(new Uint8Array(), 'av01.0.08M.10');
    expect(NativeDecoder.isConfigSupported).toHaveBeenCalledTimes(2);
    staleSettle({ supported: false });
    await Promise.resolve();
    await Promise.resolve();
    expect((decoder as any).configLikelyUnsupported).toBe(false);
    settle({ supported: false });
    await Promise.resolve();
    await Promise.resolve();
    const current = NativeDecoder.instances.at(-1)!;
    const count = NativeDecoder.instances.length;
    current.callbacks.error(new DOMException('unsupported', 'EncodingError'));
    expect(error.mock.calls.at(-1)![0].message).toMatch(/Codec not supported/);
    expect(current.close).toHaveBeenCalledOnce();
    expect(NativeDecoder.instances).toHaveLength(count);
    decoder.destroy();
  });

  it.each([0, 1])('does not guess which same-timestamp input produced output (prior output=%s)', (priorOutput) => {
    const { decoder, onFrame, native } = setup();
    decoder.decode(chunk(0, source(1n, 10_000_000n)), 111);
    if (priorOutput) native.output(0);
    decoder.decode(chunk(0, source(2n, 10_000_000n)), 222);
    const frame = native.output(0);
    expect(onFrame).toHaveBeenLastCalledWith(frame, 222, null);
    const next = native.output(0);
    expect(onFrame).toHaveBeenLastCalledWith(next, 0, null);
    decoder.destroy();
  });

  it('does not attach input metadata to an unsolicited or repeated output', () => {
    const { decoder, onFrame, native } = setup();
    decoder.decode(chunk(1), 111);
    native.output(1);
    const duplicate = native.output(1);
    expect(onFrame).toHaveBeenLastCalledWith(duplicate, 0, null);
    const unknown = native.output(2);
    expect(onFrame).toHaveBeenLastCalledWith(unknown, 0, null);
    decoder.destroy();
  });

  it('keeps source history bounded and does not reassign an evicted timestamp', () => {
    const { decoder, onFrame, native } = setup();
    for (let i = 0; i < 1024; i++) {
      decoder.decode(chunk(i), i);
      native.output(i);
    }
    const newest = native.output(1023);
    expect(onFrame).toHaveBeenLastCalledWith(newest, 0, null);
    decoder.decode(chunk(0, source(1n, 10_000_000n)), 999);
    const replay = native.output(0);
    expect(onFrame).toHaveBeenLastCalledWith(replay, 999, null);
    // The cap remains meaningful even when the browser consumes inputs silently.
    for (let i = 1024; i < 2048; i++) decoder.decode(chunk(i), i);
    expect((decoder as any).owner.sourceTimes.size).toBeLessThanOrEqual(256);
    decoder.destroy();
  });

  it('retains fresh timestamps after the bound, including reordered inputs within the retained window', () => {
    const { decoder, onFrame, native } = setup();
    for (let i = 0; i < 1024; i++) { decoder.decode(chunk(i), i); native.output(i); }
    decoder.decode(chunk(1100), 1);
    decoder.decode(chunk(1099), 2);
    const first = native.output(1099);
    expect(onFrame).toHaveBeenLastCalledWith(first, 2, source(1099n));
    const second = native.output(1100);
    expect(onFrame).toHaveBeenLastCalledWith(second, 1, source(1100n));
    decoder.destroy();
  });

  it('returns unavailable without changing delivery for absent or unsafe numeric input time', () => {
    const { decoder, onFrame, native } = setup();
    decoder.decode({ type: 'key', timestamp: 0, data: Uint8Array.of(1) }, 123);
    const missing = native.output(0);
    expect(onFrame).toHaveBeenLastCalledWith(missing, 123, null);
    decoder.decode(chunk(Number.MAX_SAFE_INTEGER + 1, source(9007199254740993n)), 456);
    const unsafe = native.output(Number.MAX_SAFE_INTEGER + 1);
    expect(onFrame).toHaveBeenLastCalledWith(unsafe, 456, null);
    decoder.destroy();
  });

  it('cannot let a failed submit lend its source time to a later output', () => {
    const { decoder, onFrame, native } = setup();
    native.decode.mockImplementationOnce(() => { throw new Error('submit failed'); });
    expect(() => decoder.decode(chunk(1), 123)).toThrow(/submit failed/);
    const frame = native.output(1);
    expect(onFrame).toHaveBeenLastCalledWith(frame, 0, null);
    decoder.destroy();
  });

  it('keeps draining decoder metadata separate from the replacement even when timestamps match', async () => {
    const { decoder, onFrame, native } = setup();
    let settle!: () => void;
    native.flush.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    decoder.decode(chunk(1, source(10n, 10_000_000n)), 111);
    decoder.configure(new Uint8Array(), 'another-codec');
    const replacement = NativeDecoder.instances.at(-1)!;
    decoder.decode(chunk(1, source(11n, 10_000_000n)), 222);
    const old = native.output(1);
    expect(onFrame).toHaveBeenLastCalledWith(old, 111, source(10n, 10_000_000n));
    const current = replacement.output(1);
    expect(onFrame).toHaveBeenLastCalledWith(current, 222, source(11n, 10_000_000n));
    settle();
    await Promise.resolve();
    const retired = native.output(1);
    expect(retired.close).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledTimes(2);
    decoder.destroy();
  });

  it.each(['reset', 'destroy'] as const)('retires output callbacks at %s, including a draining decoder', async (terminal) => {
    const { decoder, onFrame, native } = setup();
    let settle!: () => void;
    native.flush.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    decoder.decode(chunk(1), 111);
    decoder.configure(new Uint8Array(), 'another-codec');
    const replaced = NativeDecoder.instances.at(-1)!;
    decoder[terminal]();
    if (terminal === 'reset') {
      decoder.decode(chunk(1, source(11n, 10_000_000n)), 333);
      const current = NativeDecoder.instances.at(-1)!;
      const good = current.output(1);
      expect(onFrame).toHaveBeenLastCalledWith(good, 333, source(11n, 10_000_000n));
    }
    onFrame.mockClear();
    const staleOld = native.output(1);
    const staleReplaced = replaced.output(1);
    expect(staleOld.close).toHaveBeenCalledOnce();
    expect(staleReplaced.close).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    settle();
    await Promise.resolve();
    decoder.destroy();
  });

  it('ignores a retired error callback instead of resetting the active decoder', () => {
    const { decoder, native } = setup();
    const error = vi.fn();
    decoder.onError = error;
    decoder.configure(new Uint8Array(), 'test-codec');
    const replacement = NativeDecoder.instances.at(-1)!;
    native.callbacks.error(new DOMException('old error', 'EncodingError'));
    expect(error).not.toHaveBeenCalled();
    expect(NativeDecoder.instances.at(-1)).toBe(replacement);
    decoder.destroy();
  });

  it('consumes correlation even when no output consumer is wired', () => {
    const { decoder, onFrame, native } = setup();
    decoder.onFrame = null;
    decoder.decode(chunk(1), 111);
    const discarded = native.output(1);
    expect(discarded.close).toHaveBeenCalledOnce();
    decoder.onFrame = onFrame;
    const duplicate = native.output(1);
    expect(onFrame).toHaveBeenLastCalledWith(duplicate, 0, null);
    decoder.destroy();
  });

  it('cannot deliver after frame timestamp access retires the owner', () => {
    const { decoder, onFrame, native } = setup();
    decoder.decode(chunk(1), 111);
    const frame = { get timestamp() { decoder.destroy(); return 1; }, close: vi.fn() };
    native.callbacks.output(frame as unknown as VideoFrame);
    expect(frame.close).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('keeps native decoder owners bounded when successive codec flushes never finish', () => {
    const { decoder, onFrame, native } = setup();
    native.flush.mockImplementation(() => new Promise(() => {}));
    decoder.configure(new Uint8Array(), 'second-codec');
    const second = NativeDecoder.instances.at(-1)!;
    second.flush.mockImplementation(() => new Promise(() => {}));
    decoder.configure(new Uint8Array(), 'third-codec');
    expect(native.close).toHaveBeenCalledOnce();
    expect((decoder as any).owners.size).toBe(2);
    const stale = native.output(1);
    expect(stale.close).toHaveBeenCalledOnce();
    expect(onFrame).not.toHaveBeenCalled();
    decoder.destroy();
  });

  it.each(['flush', 'close'] as const)('cannot revive an owner destroyed during native %s', (operation) => {
    const { decoder, native } = setup();
    if (operation === 'flush') native.flush.mockImplementationOnce(() => {
      decoder.destroy();
      return Promise.resolve();
    });
    else native.close.mockImplementationOnce(() => { native.state = 'closed'; decoder.destroy(); });
    decoder.configure(new Uint8Array(), operation === 'flush' ? 'next-codec' : 'test-codec');
    expect((decoder as any).owner).toBeNull();
    expect((decoder as any).owners.size).toBe(0);
    expect(NativeDecoder.instances.every(owner => owner.state === 'closed')).toBe(true);
  });

  it.each(['flush', 'close'] as const)('preserves the successor configured during native %s', (operation) => {
    const { decoder, native } = setup();
    let successor!: NativeDecoder;
    const replace = () => {
      decoder.configure(new Uint8Array(), 'successor-codec');
      successor = NativeDecoder.instances.at(-1)!;
    };
    if (operation === 'flush') native.flush.mockImplementationOnce(() => { replace(); return Promise.resolve(); });
    else native.close.mockImplementationOnce(() => { native.state = 'closed'; replace(); });
    decoder.configure(new Uint8Array(), operation === 'flush' ? 'next-codec' : 'test-codec');
    expect((decoder as any).owner.decoder).toBe(successor);
    expect(successor.close).not.toHaveBeenCalled();
    decoder.destroy();
  });

  it.each(['destroy', 'replace'] as const)('fences %s reentry during native construction', (operation) => {
    const { decoder } = setup();
    let interrupted!: NativeDecoder;
    let successor: NativeDecoder | null = null;
    NativeDecoder.onConstruct = native => {
      NativeDecoder.onConstruct = null;
      interrupted = native;
      if (operation === 'destroy') decoder.destroy();
      else {
        decoder.configure(new Uint8Array(), 'successor-codec');
        successor = NativeDecoder.instances.at(-1)!;
      }
    };
    decoder.configure(new Uint8Array(), 'test-codec');
    expect(interrupted.close).toHaveBeenCalledOnce();
    expect((decoder as any).owner?.decoder ?? null).toBe(successor);
    expect((decoder as any).owners.size).toBe(successor ? 1 : 0);
    expect(NativeDecoder.instances.filter(owner => owner.state === 'configured')).toEqual(successor ? [successor] : []);
    decoder.destroy();
  });

  it.each(['reset', 'recover'] as const)('does not revive a decoder destroyed during %s cleanup', (operation) => {
    const { decoder, native } = setup();
    native.close.mockImplementationOnce(() => { native.state = 'closed'; decoder.destroy(); });
    if (operation === 'reset') decoder.reset();
    else native.callbacks.error(new DOMException('error', 'EncodingError'));
    expect((decoder as any).owner).toBeNull();
    expect((decoder as any).owners.size).toBe(0);
    expect(NativeDecoder.instances.every(owner => owner.state === 'closed')).toBe(true);
  });

  it('cancelled recovery cannot re-arm a successor after its keyframe was submitted', () => {
    const { decoder, native } = setup();
    let successor!: NativeDecoder;
    native.close.mockImplementationOnce(() => {
      native.state = 'closed';
      decoder.configure(new Uint8Array(), 'av01.0.08M.10');
      successor = NativeDecoder.instances.at(-1)!;
      decoder.decode({ ...chunk(1), data: Uint8Array.of(0x0a, 1, 0xaa, 0x32, 1, 0xbb) }, 111);
    });
    native.callbacks.error(new DOMException('retired error', 'EncodingError'));
    decoder.decode({ ...chunk(2), type: 'delta', data: Uint8Array.of(0x32, 1, 0xbb) }, 222);
    expect(successor.decode).toHaveBeenCalledTimes(2);
    decoder.destroy();
  });

  it('cancelled recovery cannot notify a successor with the old owner error', () => {
    const { decoder, native } = setup();
    const successorError = vi.fn();
    native.close.mockImplementationOnce(() => {
      native.state = 'closed';
      decoder.configure(new Uint8Array(), 'successor-codec');
      decoder.onError = successorError;
    });
    native.callbacks.error(new DOMException('retired error', 'EncodingError'));
    expect(successorError).not.toHaveBeenCalled();
    decoder.destroy();
  });

  it.each(['unsupported', 'overflow'] as const)('does not send a retired %s error to a successor created during cleanup', (failure) => {
    const { decoder, native } = setup();
    const successorError = vi.fn();
    native.close.mockImplementationOnce(() => {
      native.state = 'closed';
      decoder.configure(new Uint8Array(), 'successor-codec');
      decoder.onError = successorError;
    });
    if (failure === 'unsupported') {
      (decoder as any).configLikelyUnsupported = true;
      native.callbacks.error(new DOMException('unsupported old owner', 'EncodingError'));
    } else {
      native.decodeQueueSize = 16;
      decoder.decode(chunk(1), 111);
    }
    expect(successorError).not.toHaveBeenCalled();
    expect((decoder as any).owner.decoder).toBe(NativeDecoder.instances.at(-1));
    decoder.destroy();
  });

  it('keeps both maps bounded after many rejected submits and silently consumed inputs', () => {
    const { decoder, native } = setup();
    native.decode.mockImplementation(() => { throw new Error('submit failed'); });
    for (let i = 0; i < 1024; i++) expect(() => decoder.decode(chunk(i), i)).toThrow(/submit failed/);
    expect((decoder as any).owner.sourceTimes.size).toBeLessThanOrEqual(256);
    native.decode.mockImplementation(() => {});
    for (let i = -2048; i < 0; i++) decoder.decode(chunk(i), i);
    expect((decoder as any).owner.sourceTimes.size).toBeLessThanOrEqual(256);
    expect((decoder as any).owner.renderTimes.size).toBeLessThanOrEqual(256);
    decoder.destroy();
  });

  it('metadata getters can retire the input owner without submitting to its replacement', () => {
    const { decoder, native } = setup();
    const input: VideoChunkInit = {
      ...chunk(1),
      get sourceTimestamp() { decoder.reset(); return source(1n); },
    };
    decoder.decode(input, 111);
    expect(native.decode).not.toHaveBeenCalled();
    expect(NativeDecoder.instances.at(-1)!.decode).not.toHaveBeenCalled();
    decoder.destroy();
  });

  it('a throwing metadata getter does not fail or fabricate a source time for decoding', () => {
    const { decoder, native, onFrame } = setup();
    const input: VideoChunkInit = {
      ...chunk(1), get sourceTimestamp(): SourceTimestamp { throw new Error('metadata unavailable'); },
    };
    expect(() => decoder.decode(input, 111)).not.toThrow();
    expect(native.decode).toHaveBeenCalledOnce();
    const frame = native.output(1);
    expect(onFrame).toHaveBeenLastCalledWith(frame, 111, null);
    decoder.destroy();
  });
});
