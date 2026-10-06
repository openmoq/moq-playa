import { describe, expect, it } from 'vitest';
import { assessPlayback } from './assessment.mjs';

function healthySamples() {
  return Array.from({ length: 29 }, (_, i) => ({
    outputKind: 'video' as const,
    wallMs: i * 250,
    mediaTimeS: 2 + i / 4,
    presentedMediaTimeS: 2 + i / 4,
    presentedFrames: 48 + i * 6,
    pictureDigest: String(i),
    pictureChange: 4,
    markerRgb: [0, 255, 0],
    videoWidth: 640,
    videoHeight: 360,
    audioRms: 0.08,
    audioPeakHz: 445,
    paused: false,
    seeking: false,
    visibility: 'visible',
    bufferedRanges: [{ start: 0, end: 12 }],
  }));
}

const canvasExpected = { outputKind: 'canvas' as const, timestampDomain: 'media' as const, publisherEpochMs: 1790000000000,
  videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24 };
function canvasSamples() {
  return healthySamples().map((s) => ({ ...s, outputKind: 'canvas' as const, bufferedRanges: null,
    frameTimestampUs: s.presentedMediaTimeS * 1_000_000, wallEpochMs: canvasExpected.publisherEpochMs + s.presentedMediaTimeS * 1000 + 100 }));
}

describe('browser playback acceptance', () => {
  it('accepts identifiable moving video and the expected audio signal', () => {
    expect(assessPlayback(healthySamples())).toMatchObject({ passed: true, failures: [] });
  });

  it('fails when no output was observed', () => {
    expect(assessPlayback([]).failures).toContain('insufficient-observations');
  });

  it('fails when the observation window is too short', () => {
    expect(assessPlayback(healthySamples().slice(0, 5)).failures).toContain('insufficient-observations');
  });

  it('detects a frozen picture even when playhead and frame callbacks advance', () => {
    const samples = healthySamples().map((s) => ({ ...s, pictureDigest: 'unchanged', pictureChange: 0 }));
    expect(assessPlayback(samples).failures).toContain('picture-frozen');
  });

  it('detects a stopped frame callback with an advancing playhead', () => {
    const samples = healthySamples().map((s) => ({ ...s, presentedFrames: 48, presentedMediaTimeS: 2 }));
    expect(assessPlayback(samples).failures).toContain('presentation-stalled');
  });

  it('does not count small compression changes as movement in the known moving fixture', () => {
    const samples = healthySamples().map((s) => ({ ...s, pictureChange: 0.2 }));
    expect(assessPlayback(samples).failures).toContain('picture-frozen');
  });

  it('detects a stalled playhead', () => {
    const samples = healthySamples().map((s) => ({ ...s, mediaTimeS: 2 }));
    expect(assessPlayback(samples).failures).toContain('playhead-stalled');
  });

  it('detects missing audio while video continues', () => {
    const samples = healthySamples().map((s) => ({ ...s, audioRms: 0, audioPeakHz: 0 }));
    expect(assessPlayback(samples).failures).toContain('audio-missing');
  });

  it('rejects one-frame-per-second output with an advancing picture and playhead', () => {
    const samples = healthySamples().map((s, i) => ({ ...s, presentedFrames: 48 + Math.floor(i / 4) }));
    expect(assessPlayback(samples).failures).toContain('presentation-rate');
  });

  it('rejects a one-second presentation interruption despite a healthy average rate', () => {
    const samples = healthySamples();
    for (let i = 8; i < 12; i++) samples[i]!.presentedFrames = samples[7]!.presentedFrames;
    expect(assessPlayback(samples).failures).toContain('presentation-rate');
  });

  it('rejects a sustained audio hole even when over eighty percent of samples are audible', () => {
    const samples = healthySamples();
    for (let i = 8; i < 12; i++) { samples[i]!.audioRms = 0; samples[i]!.audioPeakHz = 0; }
    expect(assessPlayback(samples).failures).toContain('audio-missing');
  });

  it('detects audio from the wrong fixture', () => {
    const samples = healthySamples().map((s) => ({ ...s, audioPeakHz: 880 }));
    expect(assessPlayback(samples).failures).toContain('audio-identity');
  });

  it('detects video from the wrong fixture', () => {
    const samples = healthySamples().map((s) => ({ ...s, markerRgb: [255, 0, 0] }));
    expect(assessPlayback(samples).failures).toContain('video-identity');
  });

  it('does not treat the last buffered endpoint as proof of headroom', () => {
    const samples = healthySamples().map((s) => ({
      ...s, bufferedRanges: [{ start: 0, end: 1 }, { start: 10, end: 20 }],
    }));
    expect(assessPlayback(samples).failures).toContain('buffer-gap');
  });

  it('rejects a hidden or paused run rather than passing a quiet window', () => {
    expect(assessPlayback(healthySamples().map((s) => ({ ...s, paused: true }))).failures)
      .toContain('playback-inactive');
    expect(assessPlayback(healthySamples().map((s) => ({ ...s, visibility: 'hidden' }))).failures)
      .toContain('playback-inactive');
  });

  it('rejects nonfinite observations', () => {
    const samples = healthySamples();
    samples[5]!.mediaTimeS = Number.NaN;
    expect(assessPlayback(samples).failures).toContain('invalid-observation');
  });

  it('rejects a sampler that stopped and restarted during the window', () => {
    const samples = healthySamples();
    samples.splice(8, 12);
    expect(assessPlayback(samples).failures).toContain('observation-gap');
  });

  it('accepts the selected high rendition and second audio signal', () => {
    const samples = healthySamples().map((s) => ({ ...s, videoWidth: 1920, videoHeight: 1080, audioPeakHz: 879 }));
    expect(assessPlayback(samples, { videoWidth: 1920, videoHeight: 1080, audioHz: 880, videoFps: 24 }).passed).toBe(true);
  });

  it('rejects unchanged audio when a different signal is expected', () => {
    expect(assessPlayback(healthySamples(), { videoWidth: 640, videoHeight: 360, audioHz: 880, videoFps: 24 }).failures)
      .toEqual(['audio-identity']);
  });

  it('rejects unchanged video even when timestamps, callbacks and pixels advance', () => {
    expect(assessPlayback(healthySamples(), { videoWidth: 1280, videoHeight: 720, audioHz: 440, videoFps: 24 }).failures)
      .toEqual(['video-identity']);
  });

  it('rejects missing or nonfinite decoded dimensions and marker channels', () => {
    expect(assessPlayback(healthySamples().map((s) => ({ ...s, videoWidth: NaN }))).failures)
      .toContain('invalid-observation');
    expect(assessPlayback(healthySamples().map((s) => ({ ...s, markerRgb: [0, NaN, 0] }))).failures)
      .toContain('video-identity');
  });

  it('accepts observed canvas output without inventing MSE residency', () => {
    expect(assessPlayback(canvasSamples(), canvasExpected).passed).toBe(true);
  });

  it('rejects a missing or unexpected output kind', () => {
    expect(assessPlayback(healthySamples().map((s) => ({ ...s, outputKind: undefined })) as never).failures).toContain('output-kind');
    expect(assessPlayback(healthySamples(), { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: 'canvas' }).failures).toContain('output-kind');
  });

  it('requires real buffer observations for video and no fabricated ranges for canvas', () => {
    expect(assessPlayback(healthySamples().map((s) => ({ ...s, bufferedRanges: null }))).failures).toContain('invalid-observation');
    const expected = { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: 'canvas' as const };
    expect(assessPlayback(healthySamples().map((s) => ({ ...s, outputKind: 'canvas' as const })), expected).failures).toContain('invalid-observation');
  });

  it('rejects nonfinite timestamps and the wrong LOC timestamp domain', () => {
    expect(assessPlayback(canvasSamples().map((s) => ({ ...s, frameTimestampUs: NaN })), canvasExpected).failures).toContain('timestamp-domain');
    expect(assessPlayback(canvasSamples(), { ...canvasExpected, timestampDomain: 'wall-clock' }).failures).toContain('timestamp-domain');
    expect(assessPlayback(canvasSamples().map((s) => ({ ...s, frameTimestampUs: s.frameTimestampUs + canvasExpected.publisherEpochMs * 1000 })),
      { ...canvasExpected, timestampDomain: 'wall-clock' }).passed).toBe(true);
  });

  it('rejects impossible presentation-time progress despite normal frame counts', () => {
    expect(assessPlayback(canvasSamples().map((s) => ({ ...s, presentedMediaTimeS: s.presentedMediaTimeS * 1000 })), canvasExpected).failures).toContain('presentation-clock');
  });
});
