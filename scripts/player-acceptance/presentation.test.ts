import { describe, expect, it } from 'vitest';
import { assessVideoPresentation } from './presentation.mjs';

const canvas = {
  outputKind: 'canvas', nativeDrawTimestampUs: 5_000_000, nativeDrawTimeMs: 0.123,
  videoPresentation: { frameTimestampUs: '5000000', timestampDomain: 'unknown', renderedAtUs: 123 },
} as const;

describe('public draw observation acceptance', () => {
  it('rejects a stuck clock while independent native draw time advances', () => {
    const samples = [100, 600].map((time) => ({
      ...canvas, nativeDrawTimeMs: time,
      videoPresentation: { ...canvas.videoPresentation, renderedAtUs: 0 },
    }));
    expect(assessVideoPresentation(samples)).toContain('draw-clock-mismatch');
  });
  it('rejects milliseconds masquerading as microseconds and stale tick-entry time', () => {
    const sample = { ...canvas, nativeDrawTimeMs: 300.1 };
    expect(assessVideoPresentation([{ ...sample, videoPresentation: { ...sample.videoPresentation, renderedAtUs: 300.1 } }]))
      .toContain('draw-clock-mismatch');
    expect(assessVideoPresentation([{ ...sample, videoPresentation: { ...sample.videoPresentation, renderedAtUs: 100 } }]))
      .toContain('draw-clock-mismatch');
  });
  it('accepts an advancing microsecond clock with bounded independent sampling skew', () => {
    expect(assessVideoPresentation([100, 600].map((time) => ({
      ...canvas, nativeDrawTimeMs: time,
      videoPresentation: { ...canvas.videoPresentation, renderedAtUs: (time + 5) * 1000 },
    })))).toEqual([]);
  });
  it('requires an independent native draw clock', () => {
    const { nativeDrawTimeMs: _clock, ...sample } = canvas;
    expect(assessVideoPresentation([sample])).toContain('missing-native-draw-clock');
  });
  it('keeps a held draw clock rather than comparing it to the later sample time', () => {
    const held = { ...canvas, nativeDrawTimeMs: 100,
      videoPresentation: { ...canvas.videoPresentation, renderedAtUs: 100000 } };
    const samples = [{ ...held, wallMs: 100 }, { ...held, wallMs: 1000 }];
    expect(assessVideoPresentation(samples)).toEqual([]);
  });
  it('rejects a nonfinite native draw clock', () => {
    expect(assessVideoPresentation([{ ...canvas, nativeDrawTimeMs: NaN }])).toContain('missing-native-draw-clock');
  });

  it('accepts exact canvas evidence including zero and unavailable unsafe timestamps', () => {
    expect(assessVideoPresentation([
      canvas,
      { ...canvas, nativeDrawTimestampUs: 0, videoPresentation: { ...canvas.videoPresentation, frameTimestampUs: '0' } },
      { ...canvas, nativeDrawTimestampUs: 2 ** 53, videoPresentation: { ...canvas.videoPresentation, frameTimestampUs: null } },
    ])).toEqual([]);
  });
  it('rejects absent observations and timestamp unit errors', () => {
    expect(assessVideoPresentation([{ ...canvas, videoPresentation: null }])).toContain('missing-canvas-observation');
    expect(assessVideoPresentation([{ ...canvas, videoPresentation: { ...canvas.videoPresentation, frameTimestampUs: '5000' } }]))
      .toContain('draw-timestamp-mismatch');
  });
  it('rejects stale evidence while the independent draw timestamp changes', () => {
    expect(assessVideoPresentation([canvas, { ...canvas, nativeDrawTimestampUs: 6_000_000 }]))
      .toContain('draw-timestamp-mismatch');
  });
  it('compares draws independently of refresh-coalesced presentation evidence', () => {
    const sample = { ...canvas, frameTimestampUs: 4_958_334 };
    expect(assessVideoPresentation([sample])).toEqual([]);
  });
  it('rejects a guessed origin or a nonfinite client clock', () => {
    expect(assessVideoPresentation([{ ...canvas, videoPresentation: { ...canvas.videoPresentation, timestampDomain: 'media' } }]))
      .toContain('inferred-timestamp-origin');
    expect(assessVideoPresentation([{ ...canvas, videoPresentation: { ...canvas.videoPresentation, renderedAtUs: NaN } }]))
      .toContain('invalid-render-clock');
  });
  it('requires an explicit unavailable result on the uninstrumented MSE path', () => {
    expect(assessVideoPresentation([{ outputKind: 'video', videoPresentation: null }])).toEqual([]);
    expect(assessVideoPresentation([{ outputKind: 'video' }])).toContain('unexpected-mse-observation');
  });
  it('cannot pass without any samples', () => {
    expect(assessVideoPresentation([])).toEqual(['no-samples']);
  });
  it('cannot pass a nullable timestamp without independent native draw evidence', () => {
    expect(assessVideoPresentation([{ outputKind: 'canvas', videoPresentation: { ...canvas.videoPresentation, frameTimestampUs: null } }]))
      .toContain('missing-native-draw-timestamp');
  });
});
