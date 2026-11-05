/** Synthetic pause/resume oracle controls; actual canvas/PCM qualification runs separately. */
import { expect, it } from 'vitest';
import { assessProgramPauseResume, type ProgramPauseResumeObservation, type ProgramPlaybackPoint } from './program-switch.mjs';
import type { ExpectedPlayback, PlaybackSample } from './assessment.mjs';

const epoch = 1_790_000_000_000;
function observation(origin = 90_000_000, hz = 880): ProgramPauseResumeObservation {
  const point = (timeMs: number, state: ProgramPlaybackPoint['state'], frames: number, raw: number): ProgramPlaybackPoint => ({
    timeMs, state, presentedFrames: frames, nativeDrawTimestampUs: raw, nativeDrawTimeMs: state === 'paused' ? 19990 : timeMs - 10,
    currentProgram: 'program-2', currentView: 'view-2', currentAudioTrackId: 'audio-es' });
  const pause = { ...point(20000, 'paused', 480, origin + 20_000_000), actionAtMs: 20000 };
  const paused = point(22000, 'paused', 480, origin + 20_000_000);
  const resume = { ...point(22010, 'playing', 480, origin + 20_000_000), nativeDrawTimeMs: paused.nativeDrawTimeMs, actionAtMs: 22010 };
  const ready = point(22500, 'playing', 492, origin + 22_500_000);
  const samples: PlaybackSample[] = Array.from({ length: 26 }, (_, index) => {
    const wallMs = 22500 + index * 250, timestamp = origin + wallMs * 1000;
    return { outputKind: 'canvas', wallMs, wallEpochMs: epoch + wallMs, mediaTimeS: wallMs / 1000,
      presentedMediaTimeS: timestamp / 1_000_000, presentedFrames: 492 + index * 6,
      pictureDigest: String(index), pictureChange: 4, markerRgb: [0, 255, 0], videoWidth: 640, videoHeight: 360,
      audioRms: 0.08, audioPeakHz: hz, paused: false, seeking: false, visibility: 'visible', bufferedRanges: null,
      audioContextTimeS: wallMs / 1000, frameTimestampUs: timestamp, nativeDrawTimestampUs: timestamp, nativeDrawTimeMs: wallMs,
      videoPresentation: { frameTimestampUs: String(timestamp), timestampDomain: 'unknown', renderedAtUs: wallMs * 1000 } };
  });
  const first = samples[0]!;
  const pausedSamples: PlaybackSample[] = Array.from({ length: 9 }, (_, index) => {
    const wallMs = 20000 + index * 250, raw = origin + 20_000_000;
    return { ...first, wallMs, wallEpochMs: epoch + wallMs, mediaTimeS: 20, presentedMediaTimeS: raw / 1_000_000,
      presentedFrames: 480, frameTimestampUs: raw, nativeDrawTimestampUs: raw, nativeDrawTimeMs: 19990,
      videoPresentation: { frameTimestampUs: String(raw), timestampDomain: 'unknown', renderedAtUs: 19990000 },
      paused: true, pictureDigest: 'paused', pictureChange: 0, audioContextTimeS: wallMs / 1000 };
  });
  return { before: point(19990, 'playing', 480, origin + 20_000_000), pause, paused, resume, ready,
    after: point(28760, 'playing', 642, origin + 28_750_000), observed: {
    // Intentionally stopped native output stays in the raw phase receipt;
    // active-output assessment begins only at post-resume readiness.
    samples: [...pausedSamples, ...samples],
    nativeError: null, nativeEvents: [], events: [
      { timeMs: 20000, type: 'pause', data: {} }, { timeMs: 22010, type: 'play', data: {} },
    ], transportState: [{ url: 'https://local.invalid/moq', openedAtMs: 0, closedAtMs: null }],
  } };
}
const expected = (audioHz = 880): ExpectedPlayback => ({ outputKind: 'canvas', timestampDomain: 'media', publisherEpochMs: epoch,
  videoWidth: 640, videoHeight: 360, videoFps: 24, audioHz });

it.each([[90_000_000, 880], [700_000_000, 440]])('assesses fresh mapped %s output and %s Hz after a deliberate pause in a separate active window', (origin, hz) => {
  expect(assessProgramPauseResume(observation(origin, hz), expected(hz), String(origin)).failures).toEqual([]);
});

it('rejects a readiness checkpoint that only reuses the pre-pause raw native frame', () => {
  const observed = observation(); observed.ready.nativeDrawTimestampUs = observed.paused.nativeDrawTimestampUs;
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('stale-post-resume-video');
});

it('rejects a native draw from before play even when public metadata agrees and later output is healthy', () => {
  const observed = observation(), sample = observed.observed.samples.find(sample => sample.wallMs === observed.ready.timeMs)!;
  sample.nativeDrawTimeMs = observed.resume.actionAtMs - 1;
  sample.videoPresentation!.renderedAtUs = sample.nativeDrawTimeMs * 1000;
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('stale-post-resume-video');
});

it('rejects resumed program output which falls back to English PCM', () => {
  const observed = observation(); for (const sample of observed.observed.samples) sample.audioPeakHz = 440;
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('audio-identity');
});

it('requires native frames to remain stopped during the declared pause', () => {
  const observed = observation(); observed.paused.presentedFrames++;
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('pause-did-not-stop-native-frames');
});

it('does not accept fresh-looking output while the public player remains paused', () => {
  const observed = observation(); observed.ready.state = 'paused';
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('resume-not-playing');
});

it('judges the readiness deadline on return, including exactly 15 seconds', () => {
  const observed = observation(); observed.ready.timeMs = observed.resume.actionAtMs + 15000;
  observed.after.timeMs = observed.ready.timeMs + 7000;
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('resume-readiness-deadline');
});

it('keeps errors during the deliberate pause visible', () => {
  const observed = observation(); observed.observed.events.push({ type: 'error', timeMs: 21000, data: {} });
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('player-error-or-stall');
});

it('rejects a stall after play before fresh-output readiness', () => {
  const observed = observation(); observed.observed.events.push({ type: 'stall', timeMs: observed.resume.actionAtMs + 1, data: {} });
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('player-error-or-stall');
});

it('preserves the adopted program, view and audio identities through pause and play', () => {
  const observed = observation(); observed.after.currentAudioTrackId = 'audio-en';
  expect(assessProgramPauseResume(observed, expected(), '90000000').failures).toContain('pause-resume-selection-changed');
});
