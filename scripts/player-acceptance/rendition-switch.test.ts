import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assessSwitchContinuity, assessNativeRetypes, type SwitchTransition } from './rendition-switch.mjs';
import type { PlaybackSample } from './assessment.mjs';

function observations() {
  return { nativeError: null, nativeEvents: [] as unknown[], events: [] as { type: string; timeMs: number }[],
    samples: Array.from({ length: 121 }, (_, i) => {
      const height = [1080, 720, 360, 720, 1080][Math.min(4, Math.floor(i / 24))]!;
      return { outputKind: 'video' as const, wallMs: i * 250, mediaTimeS: 2 + i / 4,
        presentedMediaTimeS: 2 + i / 4, presentedFrames: 48 + i * 6,
        pictureDigest: String(i), pictureChange: 4, markerRgb: [0, 255, 0],
        videoWidth: height * 16 / 9, videoHeight: height,
        nativeFrameWidth: height * 16 / 9, nativeFrameHeight: height, nativeFrameAtMs: i * 250,
        audioContextTimeS: 1 + i / 4, audioRms: 0.08, audioPeakHz: 445,
        paused: false, seeking: false, visibility: 'visible', bufferedRanges: [{ start: 0, end: 4 + i / 4 }] };
    }) };
}

describe('manual rendition-switch output evidence', () => {
  it('accepts continuous native frames at the three declared dimensions with established audio', () => {
    expect(assessSwitchContinuity(observations()).failures).toEqual([]);
  });
  it('rejects metadata dimensions without matching native rendered frames', () => {
    const observed = observations();
    observed.samples[30]!.nativeFrameWidth = 1920;
    expect(assessSwitchContinuity(observed).failures).toContain('native-frame-identity');
  });
  it('rejects a valid but wrong decoded size outside the three renditions', () => {
    const observed = observations();
    observed.samples[30]!.videoWidth = 854;
    observed.samples[30]!.videoHeight = 480;
    expect(assessSwitchContinuity(observed).failures).toContain('video-identity');
  });
  it('rejects gaps even if the playhead remains in a buffered range', () => {
    const observed = observations();
    observed.samples[30]!.bufferedRanges.push({ start: 100, end: 101 });
    expect(assessSwitchContinuity(observed).failures).toContain('split-buffer');
  });
  it('rejects a forward jump and accumulated drift despite a healthy average', () => {
    const observed = observations();
    for (const sample of observed.samples.slice(30)) sample.mediaTimeS += 1;
    expect(assessSwitchContinuity(observed).failures).toEqual(expect.arrayContaining(['timeline-jump', 'timeline-drift']));
  });
  it('rejects stalled audio-clock evidence and the wrong continuing audio', () => {
    const observed = observations();
    for (const sample of observed.samples) { sample.audioContextTimeS = 1; sample.audioPeakHz = 880; }
    expect(assessSwitchContinuity(observed).failures).toEqual(expect.arrayContaining(['audio-clock', 'audio-identity']));
  });
  it('rejects a native waiting event or a reported player stall', () => {
    const observed = observations();
    observed.nativeEvents.push({ type: 'waiting', timeMs: 1000 });
    observed.events.push({ type: 'stall', timeMs: 1000 });
    expect(assessSwitchContinuity(observed).failures).toEqual(expect.arrayContaining(['native-media-event', 'player-error-or-stall']));
  });
});

interface SavedRun {
  observed: { nativeError: unknown; nativeEvents: unknown[]; events: { type: string; timeMs: number }[]; samples: PlaybackSample[] };
  transitions: Required<SwitchTransition>[];
}
/** The player-media CI evidence of d4174d7 (run 42705161248), reduced to the fields these assessments read. */
const saved = (): SavedRun => JSON.parse(readFileSync(new URL('./rendition-switch.ci-frame-sampling.saved.json', import.meta.url), 'utf8')) as SavedRun;
const at = (run: SavedRun, wallMs: number) => run.observed.samples.find(sample => sample.wallMs === wallMs)!;
const SPLIT = 14010; // element already 640x360, latest presented frame still 1280x720

describe('element size and latest presented frame read at different times', () => {
  it('reproduces the CI failure when the switch record is not consulted', () => {
    expect(assessSwitchContinuity(saved().observed).failures).toEqual(['native-frame-identity']);
  });
  it('accepts that one sample inside the 720p to 360p switch, and nothing else disagrees', () => {
    const run = saved();
    const result = assessSwitchContinuity(run.observed, run.transitions);
    expect(result.failures).toEqual([]);
    expect(result.transitional).toEqual([{ wallMs: SPLIT, transition: 1, element: { width: 640, height: 360 },
      frame: { width: 1280, height: 720 }, presentedFrames: 325, nativeFrameAtMs: 13959.200000000012 }]);
  });
  it('accepts the opposite order too: neither specification orders the two observations', () => {
    const run = saved(), sample = at(run, SPLIT);
    Object.assign(sample, { videoWidth: 1280, videoHeight: 720, nativeFrameWidth: 640, nativeFrameHeight: 360 });
    expect(assessSwitchContinuity(run.observed, run.transitions).failures).toEqual([]);
  });
  it.each([
    ['a presented frame of neither switch size', (run: SavedRun) => { Object.assign(at(run, SPLIT), { nativeFrameWidth: 1920, nativeFrameHeight: 1080 }); }],
    ['an element size of neither switch size', (run: SavedRun) => { Object.assign(at(run, SPLIT), { videoWidth: 1920, videoHeight: 1080, nativeFrameWidth: 1280, nativeFrameHeight: 720 }); }],
    ['a stale presented frame', (run: SavedRun) => { at(run, SPLIT).nativeFrameAtMs = SPLIT - 1500; }],
    ['a disagreement at the sample that settled the switch', (run: SavedRun) => {
      Object.assign(at(run, run.transitions[1]!.settled.wallMs), { nativeFrameWidth: 1280, nativeFrameHeight: 720 }); }],
    ['a disagreement after the switch settled', (run: SavedRun) => {
      const later = run.observed.samples.find(sample => sample.wallMs > run.transitions[1]!.settled.wallMs + 2000)!;
      Object.assign(later, { nativeFrameWidth: 1280, nativeFrameHeight: 720 }); }],
    ['a disagreement before the switch was requested', (run: SavedRun) => {
      const earlier = [...run.observed.samples].reverse().find(sample => sample.wallMs < run.transitions[1]!.requestedAtMs)!;
      Object.assign(earlier, { videoWidth: 640, videoHeight: 360 }); }],
    ['a switch record that never settled', (run: SavedRun) => { delete (run.transitions[1] as SwitchTransition).settled; }],
    ['a switch whose starting sample already disagreed', (run: SavedRun) => { run.transitions[1]!.before.nativeFrameWidth = 1920; }],
  ] as const)('rejects %s', (_name, change) => {
    const run = saved(); change(run);
    expect(assessSwitchContinuity(run.observed, run.transitions).failures).toContain(
      'native-frame-identity');
  });
  it('keeps the presentation-progress checks: frames that stop advancing still fail', () => {
    const run = saved();
    const from = run.observed.samples.findIndex(sample => sample.wallMs === SPLIT);
    for (const sample of run.observed.samples.slice(from, from + 10)) {
      sample.presentedFrames = 325; sample.presentedMediaTimeS = 13.894333;
    }
    expect(assessSwitchContinuity(run.observed, run.transitions).failures).toEqual(expect.arrayContaining(['presentation-stalled']));
  });
});

function nativeEvidence(retypes: boolean, offset = 0) {
  return { ...observations(),
    samples: observations().samples.map(sample => ({ ...sample, nativeTimestampOffsets: [offset, offset] })),
    nativeMse: {
      buffers: [{ id: 0, mime: 'video/mp4; codecs="avc1.42c028"', offset }, { id: 1, mime: 'audio/mp4; codecs="mp4a.40.2"', offset }],
      calls: (retypes ? ['video/mp4; codecs="avc1.42c01e"', 'video/mp4; codecs="avc1.42c028"'] : [])
        .map((mime, i) => ({ timeMs: 1000 + i * 6000, bufferId: 0, mime, offsetBefore: offset,
          offsetAfter: offset as number | null, error: null as string | null })) } };
}

describe('manual native retype qualification', () => {
  it.each([false, true])('requires the exact native call sequence (retypes: %s)', (retypes) => {
    for (const offset of [0, 3.75]) {
      expect(assessNativeRetypes(nativeEvidence(retypes, offset), retypes, [offset, offset]).failures).toEqual([]);
      expect(assessNativeRetypes(nativeEvidence(!retypes, offset), retypes, [offset, offset]).failures).toContain('native-retype-calls');
    }
  });
  it('rejects zeroing the offset during a call or later media playback', () => {
    const during = nativeEvidence(true, 3.75);
    during.nativeMse.calls[0]!.offsetAfter = 0;
    expect(assessNativeRetypes(during, true, [3.75, 3.75]).failures).toContain('native-offset-changed');
    const later = nativeEvidence(true, 3.75);
    later.samples[40]!.nativeTimestampOffsets[0] = 0;
    expect(assessNativeRetypes(later, true, [3.75, 3.75]).failures).toContain('native-offset-changed');
  });
  it('rejects rebasing a running zero-offset buffer to currentTime', () => {
    const observed = nativeEvidence(true);
    observed.samples[40]!.nativeTimestampOffsets[0] = observed.samples[40]!.mediaTimeS;
    expect(assessNativeRetypes(observed, true, [0, 0]).failures).toContain('native-offset-changed');
  });
  it('rejects an audio retype or a native exception', () => {
    const observed = nativeEvidence(true);
    observed.nativeMse.calls[0]!.bufferId = 1;
    observed.nativeMse.calls[0]!.error = 'native failure';
    expect(assessNativeRetypes(observed, true, [0, 0]).failures).toContain('native-retype-result');
  });
  it('rejects missing native evidence', () => {
    expect(assessNativeRetypes({ ...nativeEvidence(false), nativeMse: null }, false, [0, 0]).passed).toBe(false);
  });
});
