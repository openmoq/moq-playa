import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebCodecsVideoDecoder } from './webcodecs-video-decoder.js';
import { WebCodecsAudioDecoder } from './webcodecs-audio-decoder.js';

class NativeDecoder {
  static instances: NativeDecoder[] = [];
  static isConfigSupported = vi.fn(async () => ({ supported: true }));
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  decodeQueueSize = 0;
  configure = vi.fn(() => { this.state = 'configured'; });
  decode = vi.fn();
  flush = vi.fn(async () => {});
  close = vi.fn(() => { this.state = 'closed'; });
  constructor(readonly callbacks: { output: (data: unknown) => void; error: (error: DOMException) => void }) { NativeDecoder.instances.push(this); }
  output(timestamp: number) { const frame = { timestamp, close: vi.fn() }; this.callbacks.output(frame); return frame; }
}
class EncodedChunk {
  readonly timestamp: number;
  readonly duration: number | null;
  constructor(init: { timestamp: number; duration?: number }) { this.timestamp = init.timestamp; this.duration = init.duration ?? null; }
}
const chunk = (timestamp: number, duration: number | undefined = 20_000) => ({ type: 'key' as const, timestamp,
  ...(duration === undefined ? {} : { duration }), data: Uint8Array.of(1) });
function video() {
  const decoder = new WebCodecsVideoDecoder(); decoder.configure(new Uint8Array(), 'test-codec');
  const output = vi.fn(); decoder.onFrame = output;
  return { decoder, output, native: NativeDecoder.instances.at(-1)! };
}
function audio() {
  const decoder = new WebCodecsAudioDecoder(); decoder.configure(new Uint8Array(), 'opus', 48000, 2);
  const output = vi.fn(); decoder.onData = output;
  return { decoder, output, native: NativeDecoder.instances.at(-1)! };
}
beforeEach(() => {
  NativeDecoder.instances = [];
  vi.stubGlobal('VideoDecoder', NativeDecoder); vi.stubGlobal('AudioDecoder', NativeDecoder);
  vi.stubGlobal('EncodedVideoChunk', EncodedChunk); vi.stubGlobal('EncodedAudioChunk', EncodedChunk);
});
afterEach(() => vi.unstubAllGlobals());

describe('native video input identity', () => {
  it('carries each real input token through reordered output without replacing source-time metadata', () => {
    const f = video(), a = {}, b = {};
    f.decoder.decode(chunk(0), 100_000, a); f.decoder.decode(chunk(20_000), 120_000, b);
    f.native.output(20_000); f.native.output(0);
    expect(f.output.mock.calls.map(call => call[3])).toEqual([b, a]);
    expect(f.output.mock.calls.map(call => call[2])).toEqual([null, null]); f.decoder.destroy();
  });
  it.each([false, true])('refuses repeated PTS identity after output=%s with a positive control', emitted => {
    const f = video(), a = {}, b = {}, valid = {};
    f.decoder.decode(chunk(0), 100_000, a); if (emitted) f.native.output(0);
    f.decoder.decode(chunk(0), 200_000, b); f.native.output(0);
    expect(f.output.mock.calls.at(-1)?.[3]).toBeUndefined();
    f.decoder.decode(chunk(20_000), 220_000, valid); f.native.output(20_000);
    expect(f.output.mock.calls.at(-1)?.[3]).toBe(valid); f.decoder.destroy();
  });
  it('does not assign new identity to pre-attachment work that reused the same PTS', () => {
    const f = video(), newInput = {}, fresh = {};
    f.decoder.decode(chunk(0), 100_000); f.decoder.decode(chunk(0), 100_000, newInput); f.native.output(0);
    expect(f.output.mock.calls[0]?.[3]).toBeUndefined();
    f.decoder.decode(chunk(20_000), 120_000, fresh); f.native.output(20_000);
    expect(f.output.mock.calls[1]?.[3]).toBe(fresh); f.decoder.destroy();
  });
  it('fences reset owners when a successor reuses PTS', () => {
    const f = video(), old = {}, fresh = {}; f.decoder.decode(chunk(0), 100_000, old); f.decoder.reset();
    const next = NativeDecoder.instances.at(-1)!; f.decoder.decode(chunk(0), 200_000, fresh);
    const retired = f.native.output(0); expect(retired.close).toHaveBeenCalledOnce(); expect(f.output).not.toHaveBeenCalled();
    next.output(0); expect(f.output.mock.calls[0]?.[3]).toBe(fresh); f.decoder.destroy();
  });
  it('keeps each draining codec owner distinct from a replacement with the same PTS', async () => {
    const f = video(), old = {}, fresh = {}; let settle!: () => void;
    f.native.flush.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    f.decoder.decode(chunk(0), 100_000, old); f.decoder.configure(new Uint8Array(), 'another-codec');
    const next = NativeDecoder.instances.at(-1)!; f.decoder.decode(chunk(0), 200_000, fresh);
    f.native.output(0); next.output(0); expect(f.output.mock.calls.map(call => call[3])).toEqual([old, fresh]);
    settle(); await Promise.resolve(); const late = f.native.output(0); expect(late.close).toHaveBeenCalledOnce(); f.decoder.destroy();
  });
  it('does not recreate an evicted identity at a reused old PTS', () => {
    const f = video(), latest = {};
    for (let i = 0; i < 257; i++) f.decoder.decode(chunk(i), 100_000 + i, i === 256 ? latest : {});
    f.native.output(0); expect(f.output.mock.calls.at(-1)?.[3]).toBeUndefined();
    f.decoder.decode(chunk(0), 200_000, {}); f.native.output(0); expect(f.output.mock.calls.at(-1)?.[3]).toBeUndefined();
    f.native.output(256); expect(f.output.mock.calls.at(-1)?.[3]).toBe(latest); f.decoder.destroy();
  });
  it('does not attribute a throwing submit or imprecise timestamp', () => {
    const f = video(); f.native.decode.mockImplementationOnce(() => { throw Error('submit'); });
    expect(() => f.decoder.decode(chunk(0), 100_000, {})).toThrow(/submit/); f.native.output(0);
    expect(f.output.mock.calls.at(-1)?.[3]).toBeUndefined();
    f.decoder.decode(chunk(Number.MAX_SAFE_INTEGER + 1), 100_000, {}); f.native.output(Number.MAX_SAFE_INTEGER + 1);
    expect(f.output.mock.calls.at(-1)?.[3]).toBeUndefined(); f.decoder.destroy();
  });
  it('registers identity before an inline output, with no extra callback argument when unobserved', () => {
    const f = video(), token = {};
    f.native.decode.mockImplementation((encoded: { timestamp: number }) => { f.native.output(encoded.timestamp); });
    f.decoder.decode(chunk(0), 100_000, token); expect(f.output.mock.calls[0]?.[3]).toBe(token);
    f.decoder.decode(chunk(20_000), 120_000); expect(f.output.mock.calls[1]).toHaveLength(3); f.decoder.destroy();
  });
});

describe('native audio input identity', () => {
  it('follows unique native timing ownership through priming rather than output order', () => {
    const f = audio(), a = {}, b = {}; f.decoder.decode(chunk(0), 100_000, a); f.decoder.decode(chunk(20_000), 120_000, b);
    f.native.output(5_000); f.native.output(20_000);
    expect(f.output.mock.calls.map(call => [call[1], call[2]])).toEqual([[105_000, a], [120_000, b]]); f.decoder.destroy();
  });
  it('allows several actual outputs to retain one input token', () => {
    const f = audio(), token = {}; f.decoder.decode(chunk(0), 100_000, token);
    f.native.output(0); f.native.output(0); expect(f.output.mock.calls.map(call => call[2])).toEqual([token, token]); f.decoder.destroy();
  });
  it.each([false, true])('refuses repeated audio PTS after output=%s and keeps a fresh control', emitted => {
    const f = audio(), valid = {}; f.decoder.decode(chunk(0), 100_000, {}); if (emitted) f.native.output(0);
    f.decoder.decode(chunk(0), 100_000, {}); f.native.output(0); expect(f.output.mock.calls.at(-1)?.[2]).toBeUndefined();
    f.decoder.decode(chunk(20_000), 120_000, valid); f.native.output(20_000); expect(f.output.mock.calls.at(-1)?.[2]).toBe(valid); f.decoder.destroy();
  });
  it('does not confuse proven timing with an ambiguous unknown-duration input identity', () => {
    const f = audio(), valid = {};
    const noDuration = { type: 'key' as const, timestamp: 0, data: Uint8Array.of(1) };
    f.decoder.decode(noDuration, 100_000, {}); f.decoder.decode(chunk(20_000), 120_000, valid);
    f.native.output(20_000); expect(f.output.mock.calls[0]?.[1]).toBe(120_000); expect(f.output.mock.calls[0]?.[2]).toBeUndefined();
    f.native.output(20_000); expect(f.output.mock.calls[1]?.[2]).toBe(valid); f.decoder.destroy();
  });
  it('does not bind a pre-attachment same-PTS output to the new input', () => {
    const f = audio(), valid = {}; f.decoder.decode(chunk(0), 100_000); f.decoder.decode(chunk(0), 100_000, {});
    f.native.output(0); expect(f.output.mock.calls[0]?.[2]).toBeUndefined();
    f.decoder.decode(chunk(20_000), 120_000, valid); f.native.output(20_000); expect(f.output.mock.calls[1]?.[2]).toBe(valid); f.decoder.destroy();
  });
  it('closes old-generation data rather than lending it new-generation identity', () => {
    const f = audio(), valid = {}; f.decoder.decode(chunk(0), 100_000, {}); f.decoder.reset();
    const next = NativeDecoder.instances.at(-1)!; f.decoder.decode(chunk(0), 200_000, valid);
    const old = f.native.output(0); expect(old.close).toHaveBeenCalledOnce(); expect(f.output).not.toHaveBeenCalled();
    next.output(0); expect(f.output.mock.calls[0]?.[2]).toBe(valid); f.decoder.destroy();
  });
  it('does not lend an evicted or throwing input identity to output', () => {
    const f = audio(), valid = {};
    for (let i = 0; i < 257; i++) f.decoder.decode(chunk(i), 100_000 + i, {});
    f.native.output(0); expect(f.output.mock.calls.at(-1)?.[2]).toBeUndefined();
    f.native.decode.mockImplementationOnce(() => { throw Error('submit'); });
    expect(() => f.decoder.decode(chunk(20_000), 200_000, {})).toThrow('submit');
    f.native.output(20_000); expect(f.output.mock.calls.at(-1)?.[2]).toBeUndefined();
    f.decoder.decode(chunk(40_000), 300_000, valid); f.native.output(40_000); expect(f.output.mock.calls.at(-1)?.[2]).toBe(valid); f.decoder.destroy();
  });
  it('registers audio identity before native output and preserves old callback arity without it', () => {
    const f = audio(), token = {};
    f.native.decode.mockImplementation((encoded: { timestamp: number }) => { f.native.output(encoded.timestamp); });
    f.decoder.decode(chunk(0), 100_000, token); expect(f.output.mock.calls[0]?.[2]).toBe(token);
    f.decoder.decode(chunk(20_000), 120_000); expect(f.output.mock.calls[1]).toHaveLength(2); f.decoder.destroy();
  });
});
