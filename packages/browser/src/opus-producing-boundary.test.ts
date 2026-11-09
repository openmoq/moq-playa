import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioRenderTiming } from '@openmoq/playback';
import { WebCodecsAudioDecoder } from './webcodecs-audio-decoder.js';

const base = 1_800_000_000_000_000n;
const packet = Uint8Array.of(0xf8, 0xff, 0xfe);
const head = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 56, 1, 128, 187, 0, 0, 0, 0, 0);
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let afterCopy: (() => void) | undefined;
  class Native {
    state = 'configured';
    decodeQueueSize = 0;
    decode = vi.fn();
    flush = vi.fn(async () => {});
    configure() {}
    close() { this.state = 'closed'; }
    constructor(readonly callbacks: { output(data: unknown): void; error(error: DOMException): void }) { natives.push(this); }
  }
  const natives: Native[] = [];
  vi.stubGlobal('AudioDecoder', Native);
  vi.stubGlobal('EncodedAudioChunk', class {
    readonly timestamp: number;
    readonly duration: number | undefined;
    private readonly bytes: Uint8Array;
    get byteLength() { return this.bytes.length; }
    constructor(init: { timestamp: number; duration?: number; data: Uint8Array }) {
      this.timestamp = init.timestamp; this.duration = init.duration; this.bytes = new Uint8Array(init.data);
    }
    copyTo(destination: Uint8Array) { destination.set(this.bytes); afterCopy?.(); }
  });
  const decoder = new WebCodecsAudioDecoder();
  decoder.configure(head, 'opus', 48_000, 1);
  const received = vi.fn(), errors = vi.fn();
  decoder.onData = received; decoder.onError = errors;
  const epoch = {};
  const context = (i = 0, owner = epoch): AudioRenderTiming => ({ epoch: owner,
    sourceTimestampUs: base + BigInt(i * 20_000), presentFromSourceUs: base,
    recomputeRenderTimeUs: offset => 1_000_000 + i * 20_000 + offset });
  const submit = (i: number, c: AudioRenderTiming, token: object) => decoder.decode({ type: 'key',
    timestamp: Number(base) + i * 20_000, data: packet }, 1_000_000 + i * 20_000, token, c);
  const pcm = (timestamp: number, frames: number) => ({ timestamp, numberOfFrames: frames,
    sampleRate: 48_000, numberOfChannels: 1, close: vi.fn() });
  return { decoder, natives, received, errors, context, submit, pcm,
    onCopy(callback: () => void) { afterCopy = callback; } };
}

describe('Opus producing ownership across decoder boundaries', () => {
  it.each(['per-input', 'emitted-sample-clock'] as const)('binds split PCM and a successor input by sample interval: %s', async mode => {
    const f = fixture(), contexts = [f.context(0), f.context(1)], tokens = [{}, {}];
    try {
      f.submit(0, contexts[0]!, tokens[0]!); f.submit(1, contexts[1]!, tokens[1]!);
      const times = mode === 'per-input' ? [6500, 13_250, 20_000] : [0, 6750, 13_500];
      for (const [i, offset] of times.entries()) f.natives[0]!.callbacks.output(f.pcm(Number(base) + offset, i < 2 ? 324 : 960));
      expect(f.errors).not.toHaveBeenCalled(); expect(f.received).toHaveBeenCalledTimes(3);
      expect(f.received.mock.calls.map(call => [call[2], call[3]])).toEqual([
        [tokens[0], { context: contexts[0], sourceOffsetUs: 6500 }],
        [tokens[0], { context: contexts[0], sourceOffsetUs: 13_250 }],
        [tokens[1], { context: contexts[1], sourceOffsetUs: 0 }],
      ]);
      await expect(f.decoder.flush()).resolves.toBeUndefined();
    } finally { f.decoder.destroy(); }
  });

  it('refuses a missing middle interval rather than borrowing the later input', () => {
    const f = fixture();
    try {
      for (let i = 0; i < 3; i++) f.submit(i, f.context(i), {});
      f.natives[0]!.callbacks.output(f.pcm(Number(base), 648));
      expect(f.received.mock.calls[0]![3]).not.toBeNull();
      f.natives[0]!.callbacks.output(f.pcm(Number(base) + 33_500, 960));
      expect(f.errors).toHaveBeenCalledOnce();
      expect(f.received.mock.calls[1]![3]).toBeNull();
      expect(f.received.mock.calls[1]![2]).toBeUndefined();
    } finally { f.decoder.destroy(); }
  });

  it('never attaches a retired native output to a fresh epoch at the same timestamp', () => {
    const f = fixture(), next = f.context(0, {}), token = {};
    try {
      f.submit(0, f.context(), {}); f.decoder.reset(); f.submit(0, next, token);
      const stale = f.pcm(Number(base), 648); f.natives[0]!.callbacks.output(stale);
      expect(stale.close).toHaveBeenCalledOnce(); expect(f.received).not.toHaveBeenCalled();
      f.natives[1]!.callbacks.output(f.pcm(Number(base), 648));
      expect(f.received.mock.calls[0]![2]).toBe(token);
      expect(f.received.mock.calls[0]![3]).toEqual({ context: next, sourceOffsetUs: 6500 });
    } finally { f.decoder.destroy(); }
  });

  it('keeps a replacement generation when actual chunk copyTo reenters reset', () => {
    const f = fixture();
    try {
      let once = false;
      f.onCopy(() => { if (!once) { once = true; f.decoder.reset(); } });
      f.submit(0, f.context(), {});
      expect(f.natives[0]!.decode).not.toHaveBeenCalled(); expect(f.natives[1]!.decode).not.toHaveBeenCalled();
      const next = f.context(0, {}); f.submit(0, next, {});
      f.natives[1]!.callbacks.output(f.pcm(Number(base), 648));
      expect(f.received.mock.calls[0]![3]).toEqual({ context: next, sourceOffsetUs: 6500 });
    } finally { f.decoder.destroy(); }
  });

  it('does not submit or poison a successor when source-context acquisition resets', () => {
    const f = fixture(), ordinary = f.context();
    try {
      let once = false;
      const c: AudioRenderTiming = { ...ordinary, get sourceTimestampUs() {
        if (!once) { once = true; f.decoder.reset(); }
        return base;
      } };
      f.submit(0, c, {});
      expect(f.natives[0]!.decode).not.toHaveBeenCalled(); expect(f.natives[1]!.decode).not.toHaveBeenCalled();
      const next = f.context(0, {}); f.submit(0, next, {});
      f.natives[1]!.callbacks.output(f.pcm(Number(base), 648));
      expect(f.received.mock.calls[0]![3]).toEqual({ context: next, sourceOffsetUs: 6500 });
    } finally { f.decoder.destroy(); }
  });

  it('rejects unaccounted output at flush and never falls back to a scalar proof', async () => {
    const f = fixture();
    try {
      f.submit(0, f.context(), {});
      await expect(f.decoder.flush()).rejects.toThrow(/unaccounted samples/);
      f.natives[0]!.callbacks.output(f.pcm(Number(base), 648));
      expect(f.errors).toHaveBeenCalledOnce(); expect(f.received.mock.calls[0]![3]).toBeNull();
      expect(() => f.submit(1, f.context(1), {})).toThrow(/Opus source timing unavailable/);
    } finally { f.decoder.destroy(); }
  });
});
