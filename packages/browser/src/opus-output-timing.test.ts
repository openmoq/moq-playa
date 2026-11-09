import { describe, expect, it } from 'vitest';
import type { AudioRenderTiming } from '@openmoq/playback';
import { AudioOutputTiming } from './audio-output-timing.js';

const packet = Uint8Array.of(0xf8, 0xff, 0xfe);
const base = 1_800_000_000_000_000, raw = 2n ** 70n;
function head(skip = 312): Uint8Array {
  return Uint8Array.of(79, 112, 117, 115, 72, 101, 97, 100, 1, 1, skip & 255, skip >> 8, 128, 187, 0, 0, 0, 0, 0);
}
function fixture(skip = 312, limit = 256) {
  const timing = new AudioOutputTiming(limit), epoch = {};
  timing.enableSourceTiming(true, head(skip));
  const add = (i: number, overrides: { timestamp?: number; source?: bigint; epoch?: object; packet?: Uint8Array; duration?: number } = {}) => {
    const context: AudioRenderTiming = { epoch: overrides.epoch ?? epoch,
      sourceTimestampUs: overrides.source ?? raw + BigInt(i * 20_000), presentFromSourceUs: raw,
      recomputeRenderTimeUs: offset => 1_000_000 + i * 20_000 + offset };
    return timing.remember(overrides.timestamp ?? base + i * 20_000, overrides.duration, 1_000_000 + i * 20_000,
      { packet: overrides.packet ?? packet, context });
  };
  const output = (timestamp: number, frames: number, rate = 48_000, channels = 1) => timing.resolve(timestamp,
    { numberOfFrames: frames, sampleRate: rate, numberOfChannels: channels });
  return { timing, add, output };
}

describe('armed Opus sample intervals', () => {
  it('keeps zero-pre-skip described Opus on its exact producing sample points', () => {
    const f = fixture(0);
    for (let i = 0; i < 3; i++) {
      const input = f.add(i);
      expect(f.output(base + i * 20_000, 960)).toEqual({ renderTimeUs: 1_000_000 + i * 20_000, input, sourceOffsetUs: 0 });
    }
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });
  it('accounts for wholly primed inputs without requiring callbacks for them', () => {
    const f = fixture(2232); f.add(0); f.add(1);
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
    const input = f.add(2);
    expect(f.output(base + 46_500, 648)).toEqual({ renderTimeUs: 1_046_500, input, sourceOffsetUs: 6500 });
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });
  it('locates disjoint split PCM within one producing input', () => {
    const f = fixture(), input = f.add(0);
    expect(f.output(base + 6500, 324)).toEqual({ renderTimeUs: 1_006_500, input, sourceOffsetUs: 6500 });
    expect(f.output(base + 13_250, 324)).toEqual({ renderTimeUs: 1_013_250, input, sourceOffsetUs: 13_250 });
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });
  it('keeps flush on the same generation and exhausts pre-skip only once', () => {
    const f = fixture(); f.add(0); expect(f.output(base, 648).sourceOffsetUs).toBe(6500);
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
    const next = f.add(1); expect(f.output(base + 13_500, 960).input).toBe(next);
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });
  it('refuses PCM spanning different producing contexts rather than choosing one', () => {
    const f = fixture(); f.add(0); f.add(1);
    expect(f.output(base, 1608).sourceOffsetUs).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/crosses or exceeds/);
  });
  it('cannot swap timestamp conventions after one was ruled out', () => {
    const f = fixture(); f.add(0); f.add(1);
    expect(f.output(base, 648).sourceOffsetUs).toBe(6500);
    expect(f.output(base + 20_000, 960).sourceOffsetUs).toBeNull();
    expect(f.output(base + 13_500, 960).sourceOffsetUs).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/timestamp contradicts/);
  });
  it('does not consume an interval twice when a native timestamp is repeated', () => {
    const f = fixture(); f.add(0); f.add(1);
    expect(f.output(base + 6500, 648).sourceOffsetUs).toBe(6500);
    expect(f.output(base + 6500, 648).sourceOffsetUs).toBeNull();
    expect(f.output(base + 20_000, 960).sourceOffsetUs).toBeNull();
  });
  it.each([
    { label: 'wrong rate', frames: 648, rate: 44_100, channels: 1 },
    { label: 'wrong channels', frames: 648, rate: 48_000, channels: 2 },
    { label: 'zero frames', frames: 0, rate: 48_000, channels: 1 },
    { label: 'fractional frames', frames: 648.5, rate: 48_000, channels: 1 },
  ])('refuses an unsupported PCM descriptor: $label', ({ frames, rate, channels }) => {
    const f = fixture(); f.add(0);
    expect(f.output(base, frames, rate, channels).sourceOffsetUs).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/sample span/);
  });
  it('does not round a sub-microsecond sample offset into source proof', () => {
    const f = fixture(1); f.add(0);
    expect(f.output(base, 959).sourceOffsetUs).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/whole microseconds/);
  });
  it.each([
    { label: 'native gap', timestamp: base + 40_000 },
    { label: 'native overlap', timestamp: base + 10_000 },
    { label: 'source gap', source: raw + 40_000n },
    { label: 'source overlap', source: raw + 10_000n },
    { label: 'owner epoch', epoch: {} },
  ])('refuses discontinuous submitted ownership: $label', overrides => {
    const f = fixture(); f.add(0); f.add(1, overrides);
    expect(f.output(base, 648).sourceOffsetUs).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/discontinuous/);
  });
  it('requires actual packet framing, not an asserted chunk duration', () => {
    const f = fixture(); f.add(0, { packet: Uint8Array.of(0xf9, 1), duration: 20_000 });
    expect(f.output(base, 648).sourceOffsetUs).toBeNull();
    expect(f.timing.sourceTimingFailure).toMatch(/packet framing/);
  });
  it('refuses a duration that contradicts the submitted packet', () => {
    const f = fixture(); f.add(0, { duration: 10_000 });
    expect(f.timing.sourceTimingFailure).toMatch(/duration contradicts/);
  });
  it('refuses source proof armed after an unobserved native submission', () => {
    const timing = new AudioOutputTiming(); timing.remember(base, undefined, 1_000_000);
    timing.enableSourceTiming(true, head());
    expect(timing.sourceTimingFailure).toMatch(/armed after submission/);
  });
  it('keeps unknown applied profiles explicitly unsupported', () => {
    const timing = new AudioOutputTiming(); timing.enableSourceTiming(true, Uint8Array.of(1, 2));
    expect(timing.sourceTimingFailure).toMatch(/OpusHead/);
  });
  it('refuses unreconciled PCM at flush rather than treating FIN as sample proof', () => {
    const f = fixture(); f.add(0); f.add(1); f.output(base, 648);
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toMatch(/unaccounted/);
    expect(f.output(base + 13_500, 960).sourceOffsetUs).toBeNull();
  });
  it('bounds outstanding ownership and never recovers by borrowing a newer input', () => {
    const f = fixture(312, 2); f.add(0); f.add(1); f.add(2);
    expect(f.timing.sourceTimingFailure).toMatch(/history limit/);
    expect(f.output(base, 648).sourceOffsetUs).toBeNull();
  });
  it('releases progressing sample history without a 256-input cliff', () => {
    const f = fixture();
    for (let i = 0; i < 1024; i++) {
      const input = f.add(i);
      expect(f.output(base + (i ? i * 20_000 - 6500 : 0), i ? 960 : 648))
        .toEqual({ renderTimeUs: 1_000_000 + i * 20_000 + (i ? 0 : 6500), input, sourceOffsetUs: i ? 0 : 6500 });
    }
    f.timing.finishSourceTiming(); expect(f.timing.sourceTimingFailure).toBeNull();
  });
  it('ends ownership on submission failure, while clear begins a real fresh generation', () => {
    const f = fixture(); f.add(0); f.timing.poison(base);
    expect(f.output(base, 648).sourceOffsetUs).toBeNull();
    f.timing.clear(); f.timing.enableSourceTiming(true, head());
    const input = f.add(0); expect(f.output(base, 648).input).toBe(input);
    expect(f.timing.sourceTimingFailure).toBeNull();
  });
});
