/** Observation-oracle controls; synthetic samples are not native playback evidence. */
import { describe, expect, it } from 'vitest';
import { assessAudioSwitchOutput } from './audio-switch.mjs';
import { assessPlayback, type ExpectedPlayback, type PlaybackSample } from './assessment.mjs';

const expected = (kind: 'video' | 'canvas', hz = 440): ExpectedPlayback => ({ outputKind: kind,
  videoWidth: 640, videoHeight: 360, videoFps: 24, audioHz: hz,
  ...(kind === 'canvas' ? { timestampDomain: 'media', publisherEpochMs: 1_790_000_000_000 } : {}) });
function samples(kind: 'video' | 'canvas', hz = 440): PlaybackSample[] {
  return Array.from({ length: 26 }, (_, index) => {
    const wallMs = 10_000 + index * 250, timestamp = wallMs * 1000;
    return { outputKind: kind, wallMs, wallEpochMs: 1_790_000_000_000 + wallMs,
      mediaTimeS: wallMs / 1000, presentedMediaTimeS: wallMs / 1000, presentedFrames: index * 6 + 1,
      pictureDigest: String(index), pictureChange: 4, markerRgb: [0, 255, 0], videoWidth: 640, videoHeight: 360,
      audioRms: 0.08, audioPeakHz: hz, paused: false, seeking: false, visibility: 'visible',
      audioContextTimeS: wallMs / 1000,
      ...(kind === 'video' ? { bufferedRanges: [{ start: 0, end: wallMs / 1000 + 1 }],
        nativeFrameWidth: 640, nativeFrameHeight: 360, nativeFrameAtMs: wallMs - 20, videoPresentation: null }
        : { bufferedRanges: null, frameTimestampUs: timestamp, nativeDrawTimestampUs: timestamp, nativeDrawTimeMs: wallMs,
          videoPresentation: { frameTimestampUs: String(timestamp), timestampDomain: 'unknown', renderedAtUs: wallMs * 1000 } }) };
  });
}

describe.each(['video', 'canvas'] as const)('audio round-trip output oracle: %s', kind => {
  it.each([440, 880])('accepts correlated moving output and %s Hz', hz => {
    expect(assessAudioSwitchOutput(samples(kind, hz), expected(kind, hz))).toMatchObject({ passed: true, failures: [] });
  });
  it('retains the wrong-language PCM negative control', () => {
    expect(assessAudioSwitchOutput(samples(kind, 440), expected(kind, 880)).failures).toEqual(['audio-identity']);
  });
});

it('refuses canvas metadata without independent native draw witnesses', () => {
  const observed = samples('canvas').map(({ nativeDrawTimestampUs: _timestamp, nativeDrawTimeMs: _time, ...sample }) =>
    ({ ...sample, videoPresentation: null }));
  expect(assessPlayback(observed, expected('canvas')).failures).toEqual([]);
  expect(assessAudioSwitchOutput(observed, expected('canvas')).failures).toContain('canvas-missing-canvas-observation');
});

it('refuses a public canvas timestamp that disagrees with the native draw', () => {
  const observed = samples('canvas');
  observed[3]!.videoPresentation!.frameTimestampUs = '1';
  expect(assessAudioSwitchOutput(observed, expected('canvas')).failures).toContain('canvas-draw-timestamp-mismatch');
});

it('refuses a public canvas clock that disagrees with the native draw', () => {
  const observed = samples('canvas');
  observed[3]!.videoPresentation!.renderedAtUs += 30_000;
  expect(assessAudioSwitchOutput(observed, expected('canvas')).failures).toContain('canvas-draw-clock-mismatch');
});

it.each([320, undefined])('keeps the exact native MSE frame-width requirement: %s', width => {
  const observed = samples('video').map(({ nativeFrameWidth: _width, ...sample }) =>
    ({ ...sample, ...(width === undefined ? {} : { nativeFrameWidth: width }) }));
  expect(assessPlayback(observed, expected('video')).failures).toEqual([]);
  expect(assessAudioSwitchOutput(observed, expected('video')).failures).toContain('native-video-identity');
});
