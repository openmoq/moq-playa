import { describe, expect, it } from 'vitest';
import { assessSwitchContinuity, assessNativeRetypes } from './rendition-switch.mjs';

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
