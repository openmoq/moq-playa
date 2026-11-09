import { describe, expect, it } from 'vitest';
import type { AudioRenderTiming } from '@openmoq/playback';
import { AudioOutputTiming } from './audio-output-timing.js';

const packet = Uint8Array.of(0xf8, 0xff, 0xfe);
const head = Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 56, 1, 128, 187, 0, 0, 0, 0, 0);
const base = 1_800_000_000_000_000, sourceBase = 2n ** 70n;
function fixture() {
  const timing = new AudioOutputTiming(), epoch = {};
  timing.enableSourceTiming(true, head);
  const add = (index: number, nativeError = 0, sourceError = 0, owner = epoch) => {
    const context: AudioRenderTiming = { epoch: owner,
      sourceTimestampUs: sourceBase + BigInt(index * 20_000 + sourceError), presentFromSourceUs: sourceBase,
      recomputeRenderTimeUs: offset => 1_000_000 + index * 20_000 + sourceError + offset };
    const input = timing.remember(base + index * 20_000 + nativeError, 20_000,
      1_000_000 + index * 20_000 + sourceError, { packet, context });
    return { context, input };
  };
  const output = (index: number, error = 0) => timing.resolve(base + (index ? index * 20_000 - 6500 : 0) + error,
    { numberOfFrames: index ? 960 : 648, sampleRate: 48_000, numberOfChannels: 1 });
  return { timing, add, output };
}

describe('Opus integer-microsecond representation', () => {
  it('keeps one-microsecond input and output quantization on their exact coded owners', () => {
    const f = fixture();
    for (let i = 0; i < 60; i++) {
      const inputError = [13, 26, 52].includes(i) ? -1 : 0;
      const outputError = i === 26 ? -1 : 0;
      const { input, context } = f.add(i, inputError, inputError);
      const result = f.output(i, outputError), offset = i ? 0 : 6500;
      expect(result).toEqual({ input, sourceOffsetUs: offset, renderTimeUs: 1_000_000 + i * 20_000 + inputError + offset });
      expect(context.sourceTimestampUs).toBe(sourceBase + BigInt(i * 20_000 + inputError));
      expect(input?.timestamp).toBe(base + i * 20_000 + inputError);
    }
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });

  it.each([
    { native: -1, source: 1, output: -1 },
    { native: 1, source: -1, output: 1 },
  ])('validates both source clocks independently: $native / $source / $output', errors => {
    const f = fixture(); f.add(0); expect(f.output(0).sourceOffsetUs).toBe(6500);
    const { input } = f.add(1, errors.native, errors.source);
    expect(f.output(1, errors.output)).toEqual({ input, sourceOffsetUs: 0, renderTimeUs: 1_020_000 + errors.source });
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });

  it.each(['native', 'source'] as const)('refuses cumulative %s drift instead of resetting its origin at each input', clock => {
    const f = fixture(); f.add(0); f.output(0);
    const first = f.add(1, clock === 'native' ? -1 : 0, clock === 'source' ? -1 : 0);
    expect(f.output(1).input).toBe(first.input);
    f.add(2, clock === 'native' ? -2 : 0, clock === 'source' ? -2 : 0);
    expect(f.timing.sourceTimingFailure).toMatch(/discontinuous/);
    expect(f.output(2).input).toBeNull();
  });

  it('refuses native output drift beyond the fixed-origin representation bound', () => {
    const f = fixture(); f.add(0); f.output(0);
    const first = f.add(1); expect(f.output(1, -1).input).toBe(first.input);
    f.add(2); expect(f.output(2, -2).input).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/timestamp contradicts/);
  });

  it('does not revive an associated-input model eliminated by priming', () => {
    const f = fixture(); f.add(0); expect(f.output(0, 1).sourceOffsetUs).toBe(6500);
    f.add(1, -1, -1);
    expect(f.timing.resolve(base + 19_999, { numberOfFrames: 960, sampleRate: 48_000, numberOfChannels: 1 }).input).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/timestamp contradicts/);
  });

  it('never treats a timestamp representation allowance as epoch continuity', () => {
    const f = fixture(); f.add(0); f.output(0); f.add(1, -1, -1, {});
    expect(f.timing.sourceTimingFailure).toMatch(/discontinuous/); expect(f.output(1).input).toBeNull();
  });
});
