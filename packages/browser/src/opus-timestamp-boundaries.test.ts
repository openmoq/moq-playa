import { describe, expect, it } from 'vitest';
import type { AudioRenderTiming } from '@openmoq/playback';
import { AudioOutputTiming } from './audio-output-timing.js';

const packet = Uint8Array.of(0xf8, 0xff, 0xfe);
const source = 2n ** 180n;
const base = 1_800_000_000_000_000;

function fixture(skip = 312, origin = base) {
  const timing = new AudioOutputTiming(), epoch = Object.freeze({});
  const head = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 1,
    skip & 255, skip >> 8, 128, 187, 0, 0, 0, 0, 0);
  timing.enableSourceTiming(true, head);
  const add = (i: number, nativeError = 0, sourceError = 0, owner = epoch) => {
    const context: AudioRenderTiming = Object.freeze({ epoch: owner,
      sourceTimestampUs: source + BigInt(i * 20_000 + sourceError),
      presentFromSourceUs: source,
      recomputeRenderTimeUs: (offset: number) => 1_000_000 + i * 20_000 + sourceError + offset,
    });
    const input = timing.remember(origin + i * 20_000 + nativeError, 20_000,
      1_000_000 + i * 20_000 + sourceError, { packet, context });
    return { input, context };
  };
  const pcm = (timestamp: number, frames: number) => timing.resolve(timestamp,
    { numberOfFrames: frames, sampleRate: 48_000, numberOfChannels: 1 });
  const global = (i: number, error = 0) => pcm(origin + (i ? i * 20_000 - skip * 1_000_000 / 48_000 : 0) + error,
    i ? 960 : 960 - skip);
  return { timing, add, pcm, global };
}

describe('independent fixed-origin Opus representation boundaries', () => {
  it.each([
    { clock: 'native', sign: -1 }, { clock: 'native', sign: 1 },
    { clock: 'source', sign: -1 }, { clock: 'source', sign: 1 },
  ])('does not chain accepted single-step errors: $clock $sign', ({ clock, sign }) => {
    const f = fixture(); f.add(0); expect(f.global(0).sourceOffsetUs).toBe(6500);
    const first = f.add(1, clock === 'native' ? sign : 0, clock === 'source' ? sign : 0);
    expect(f.global(1).input).toBe(first.input);
    f.add(2, clock === 'native' ? sign * 2 : 0, clock === 'source' ? sign * 2 : 0);
    expect(f.timing.sourceTimingFailure).toMatch(/discontinuous/);
    expect(f.global(2).input).toBeNull();
  });

  it('accepts alternating signed representations without shifting origin or rewriting data', () => {
    const bytes = [...packet], f = fixture();
    for (let i = 0; i < 128; i++) {
      const e = i ? (i % 2 ? 1 : -1) : 0;
      const { input, context } = f.add(i, e, -e);
      expect(f.global(i, e)).toEqual({ input, sourceOffsetUs: i ? 0 : 6500,
        renderTimeUs: 1_000_000 + i * 20_000 - e + (i ? 0 : 6500) });
      expect(input?.timestamp).toBe(base + i * 20_000 + e);
      expect(context.sourceTimestampUs).toBe(source + BigInt(i * 20_000 - e));
      expect(Object.isFrozen(context)).toBe(true);
    }
    expect([...packet]).toEqual(bytes);
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });

  it('rejects signed two-microsecond PCM drift after a model is pinned', () => {
    for (const sign of [-1, 1]) {
      const f = fixture(); f.add(0); f.global(0);
      const first = f.add(1); expect(f.global(1, sign).input).toBe(first.input);
      f.add(2); expect(f.global(2, sign * 2).input).toBeNull();
      expect(f.timing.sourceTimingFailure).toMatch(/timestamp contradicts/);
    }
  });

  it('keeps epoch identity strict despite individually acceptable clock errors', () => {
    const f = fixture(); f.add(0); f.global(0);
    f.add(1, 1, -1, Object.freeze({}));
    expect(f.timing.sourceTimingFailure).toMatch(/discontinuous/);
    expect(f.global(1).input).toBeNull();
  });

  it('cannot revive either eliminated model across a 6500us convention swap', () => {
    for (const first of ['global', 'input']) {
      const f = fixture(); f.add(0);
      expect(f.pcm(base + (first === 'input' ? 6500 : 0) + 1, 648).sourceOffsetUs).toBe(6500);
      f.add(1, -1, 1);
      const switched = first === 'global' ? base + 19_999 : base + 13_500;
      expect(f.pcm(switched, 960).input).toBeNull();
      expect(f.timing.sourceTimingFailure).toMatch(/timestamp contradicts/);
      expect(f.global(1).input).toBeNull();
    }
  });

  it('documents the composed bound without treating global+2 as automatically invalid', () => {
    const f = fixture(0); f.add(0); f.global(0);
    const { input, context } = f.add(1, 1, -1);
    // Global prediction +2 is associated-input prediction +1. The same exact
    // coded interval owns it; the preserved source point differs by 3us.
    const actual = base + 20_002;
    const result = f.pcm(actual, 960);
    expect(result).toEqual({ input, sourceOffsetUs: 0, renderTimeUs: 1_019_999 });
    expect(BigInt(actual - base) - (context.sourceTimestampUs - source)).toBe(3n);
    const next = f.add(2, -1, 1);
    // The global model was eliminated above and must not revive here.
    expect(next.input).toBeDefined();
    expect(f.pcm(base + 40_001, 960).input).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/timestamp contradicts/);
  });

  it('compares huge raw epochs and both safe-integer native endpoints exactly', () => {
    for (const origin of [Number.MAX_SAFE_INTEGER - 100_000, Number.MIN_SAFE_INTEGER + 100_000]) {
      const f = fixture(312, origin); f.add(0); expect(f.global(0).sourceOffsetUs).toBe(6500);
      const { input, context } = f.add(1, 1, -1);
      expect(f.global(1, -1).input).toBe(input);
      expect(context.sourceTimestampUs).toBe(source + 19_999n);
      f.add(2, -1, 2);
      expect(f.timing.sourceTimingFailure).toMatch(/discontinuous/);
    }
    const f = fixture(0); f.add(0);
    expect(f.pcm(Number.MAX_SAFE_INTEGER + 1, 960).input).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/sample span/);
  });

  it('does not waive exact containment, fractional offsets, or flush accounting', () => {
    const crossing = fixture(); crossing.add(0); crossing.add(1);
    expect(crossing.pcm(base + 1, 649).input).toBeNull();
    expect(crossing.timing.sourceTimingFailure).toMatch(/crosses or exceeds/);
    const fractional = fixture(1); fractional.add(0);
    expect(fractional.pcm(base + 1, 959).input).toBeNull();
    expect(fractional.timing.sourceTimingFailure).toMatch(/whole microseconds/);
    const short = fixture(); short.add(0); short.add(1); short.global(0, -1);
    short.timing.finishSourceTiming();
    expect(short.timing.sourceTimingFailure).toMatch(/unaccounted samples/);
  });
});
