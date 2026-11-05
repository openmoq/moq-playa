/** Synthetic oracle/adapter controls; native Chrome is a separate qualification. */
import { describe, expect, it, vi } from 'vitest';
import type { VideoDecoderLike } from '../../packages/player/src/interfaces.js';
import type { SourceTimestamp } from '../../packages/loc/src/index.js';
import type { VideoRenderTiming } from '../../packages/playback/src/index.js';
import { assessProgramSwitchOutput, assessProgramSwitchSession, assessProgramSwitchSubscriptions } from './program-switch.mjs';
import { observeProgramDecodedSource } from './program-switch-observer.mjs';
import type { ExpectedPlayback, PlaybackSample } from './assessment.mjs';
import type { ProgramSwitchVariant } from './program-switch.fixture.mjs';

const epoch = 1_790_000_000_000;
const expected = (audioHz = 440): ExpectedPlayback => ({ outputKind: 'canvas', timestampDomain: 'media', publisherEpochMs: epoch,
  videoWidth: 640, videoHeight: 360, videoFps: 24, audioHz });
function samples(origin = 0, audioHz = 440): PlaybackSample[] {
  return Array.from({ length: 26 }, (_, index) => {
    const wallMs = 10_000 + index * 250, timestamp = origin + wallMs * 1000;
    return { outputKind: 'canvas', wallMs, wallEpochMs: epoch + wallMs, mediaTimeS: wallMs / 1000,
      presentedMediaTimeS: timestamp / 1_000_000, presentedFrames: index * 6 + 1,
      pictureDigest: String(index), pictureChange: 4, markerRgb: [0, 255, 0], videoWidth: 640, videoHeight: 360,
      audioRms: 0.08, audioPeakHz: audioHz, paused: false, seeking: false, visibility: 'visible', bufferedRanges: null,
      audioContextTimeS: wallMs / 1000, frameTimestampUs: timestamp, nativeDrawTimestampUs: timestamp, nativeDrawTimeMs: wallMs,
      videoPresentation: { frameTimestampUs: String(timestamp), timestampDomain: 'unknown', renderedAtUs: wallMs * 1000 } };
  });
}
describe('program/view native output oracle', () => {
  it.each([[90_000_000, 880], [700_000_000, 440]])('accepts moving correlated canvas source %s and measured %s Hz', (origin, hz) => {
    expect(assessProgramSwitchOutput(samples(origin, hz), expected(hz), String(origin)).failures).toEqual([]);
    expect(assessProgramSwitchOutput(samples(origin, hz), expected(hz), '0').failures).toContain('timestamp-domain');
  });
  it('rejects new menu metadata when actual native frames still come from the old raw source', () => {
    expect(assessProgramSwitchOutput(samples(0, 880), expected(880), '90000000').failures)
      .toEqual(expect.arrayContaining(['raw-video-source', 'timestamp-domain']));
  });
  it('requires both real PCM identity and independent native draw correlation', () => {
    const observed = samples(90_000_000, 440);
    expect(assessProgramSwitchOutput(observed, expected(880), '90000000').failures).toEqual(['audio-identity']);
    observed[3]!.videoPresentation!.frameTimestampUs = '1';
    expect(assessProgramSwitchOutput(observed, expected(440), '90000000').failures).toContain('canvas-draw-timestamp-mismatch');
  });
  it('rejects frozen pixels even with fresh decoded timestamps and progressing frame counts', () => {
    const observed = samples(700_000_000).map(sample => ({ ...sample, pictureDigest: 'frozen', pictureChange: 0 }));
    expect(assessProgramSwitchOutput(observed, expected(), '700000000').failures).toContain('picture-frozen');
  });
  it('retains same-session frame, picture, audio clock and transport ownership checks', () => {
    const observed = { samples: samples(), nativeError: null, nativeEvents: [], events: [],
      transportState: [{ url: 'https://local.invalid/moq', openedAtMs: 0, closedAtMs: null as number | null }] };
    expect(assessProgramSwitchSession(observed).failures).toEqual([]);
    observed.transportState[0]!.closedAtMs = 14000;
    for (const sample of observed.samples) sample.audioContextTimeS = 0;
    expect(assessProgramSwitchSession(observed).failures).toEqual(['audio-clock', 'transport-replaced-or-closed']);
  });
});

function tracks(): ProgramSwitchVariant['tracks'] {
  const entry = (name: string, role: 'video' | 'audio', renderGroup: number, altGroup: number) => ({ name, role, renderGroup, altGroup,
    sourceTrack: name, offsetUs: '0', firstPresentationTimeUs: '0', firstLocTimeUs: '0', timescale: 48000, samples: 1,
    compositionOffsetsTicks: [0], durationTicks: [960] });
  return { oldVideo: entry('video-360', 'video', 1, 1), oldAudio: entry('audio-en', 'audio', 1, 2),
    viewVideo: entry('video-view', 'video', 1, 4), nextVideo: entry('video-next', 'video', 2, 11), nextAudio: entry('audio-es-next', 'audio', 2, 12) };
}
function wire(names: string[]) {
  return { connections: 1, overflow: false, subscriptions: names.map((name, index) =>
    ({ name, namespace: ['test'], requestId: String(index * 4), timeMs: index * 1000 })) };
}
it.each(['program', 'view'] as const)('requires exact one-session SUBSCRIBEs for %s', mode => {
  const names = ['catalog', 'video-360', 'audio-en', ...(mode === 'program' ? ['video-next', 'audio-es-next'] : ['video-view'])];
  expect(assessProgramSwitchSubscriptions(wire(names), 'test', mode, tracks()).failures).toEqual([]);
  expect(assessProgramSwitchSubscriptions(wire([...names, 'audio-en']), 'test', mode, tracks()).failures).toContain('media-subscriptions');
  const wrongNamespace = wire(names); wrongNamespace.subscriptions[1]!.namespace = ['other'];
  expect(assessProgramSwitchSubscriptions(wrongNamespace, 'test', mode, tracks()).failures).toContain('media-subscriptions');
});

it.each([false, true])('preserves the native decoder output-timing capability and producing argument identities: %s', supported => {
  const source: SourceTimestamp = Object.freeze({ ticks: 90_000_000n, ticksPerSecond: 1_000_000n, domain: 'media' });
  const input = {}, renderTiming: VideoRenderTiming = { recomputeRenderTimeUs: () => 11_000_000 };
  const decode = vi.fn<VideoDecoderLike['decode']>();
  const native: VideoDecoderLike = { ...(supported ? { supportsOutputTiming: true } : {}), configure() {}, decode,
    flush: async () => {}, reset() {}, destroy() {}, queueDepth: 0, onFrame: null, onError: null };
  const observer = observeProgramDecodedSource(), wrapper = observer.wrap(native), output = vi.fn(); wrapper.onFrame = output;
  expect(wrapper.supportsOutputTiming).toBe(supported ? true : undefined);
  const chunk = { type: 'key' as const, timestamp: 90_000_000, data: Uint8Array.of(1), sourceTimestamp: source };
  wrapper.decode(chunk, 11_000_000, input, renderTiming);
  expect(decode.mock.calls[0]?.[3]).toBe(renderTiming); expect(decode.mock.calls[0]?.[2]).toBe(input);
  const frame = { timestamp: 90_000_000, close() {} };
  native.onFrame?.(frame, 11_000_000, source, input, renderTiming);
  expect(output.mock.calls[0]?.[4]).toBe(renderTiming); expect(output.mock.calls[0]?.[3]).toBe(input);
  expect(observer.snapshot()).toEqual({ inputs: 1, outputs: 1, matched: 1, failures: [] });
});
