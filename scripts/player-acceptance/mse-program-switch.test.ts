/** Oracle controls only. No native MSE, video, PCM or Chrome qualification. */
import { describe, expect, it } from 'vitest';
import { assessMseProgramSwitch, mseProgramSwitchCases, prepareMseProgramSwitchVariant } from './mse-program-switch.mjs';
import { prepareProgramSwitchVariant } from './program-switch.fixture.mjs';
import type { ProgramSwitchVariant } from './program-switch.fixture.mjs';
import type { MseProgramSwitchObservation, MseProgramSwitchPlan, MseProgramSnapshot, MseSelectionPoint } from './mse-program-switch.mjs';
import type { MseProgramSegment } from './mse-program-switch-observer.mjs';
import type { PlaybackSample } from './assessment.mjs';
import type { AudioTrack, Level, Program, View } from '../../packages/playa/src/types.js';

const namespace = 'local-program', relayUrl = 'https://127.0.0.1:9999/moq', offset = 3.75;
const key = (name: string) => JSON.stringify([[namespace], name]);
const track = (name: string, role: 'video' | 'audio', renderGroup: number, altGroup: number, origin: string) => ({
  name, role, renderGroup, altGroup, sourceTrack: name, offsetUs: origin, firstPresentationTimeUs: origin,
  firstLocTimeUs: origin, timescale: 1000, samples: 1, compositionOffsetsTicks: [0], durationTicks: [500],
});
const variant: ProgramSwitchVariant = {
  kind: 'header-timing-rewrite', metadataOnly: false, mediaBytesUnchanged: false, encodedPayloadUnchanged: true,
  tracks: { oldVideo: track('video-360', 'video', 1, 1, '0'), oldAudio: track('audio-en', 'audio', 1, 2, '0'),
    nextVideo: track('video-1080', 'video', 2, 11, '90000000'), nextAudio: track('audio-es', 'audio', 2, 12, '900000000'),
    viewVideo: track('video-720', 'video', 1, 4, '700000000') },
  maps: { program: { video: { sourceTimeUs: '90000000', referenceTimeUs: '0' }, audio: { sourceTimeUs: '900000000', referenceTimeUs: '0' } },
    view: { video: { sourceTimeUs: '700000000', referenceTimeUs: '0' } } },
  encodedPayloadProof: { 'sample.m4s': { beforeSha256: 'a'.repeat(64), afterSha256: 'a'.repeat(64), bytes: 100 } },
  fileHashes: {}, timingEvidence: 'synthetic assessor control; no native execution',
};
function level(name: string): Level {
  return { index: 0, trackName: name, id: key(name), namespace: [namespace], label: name,
    width: 640, height: 360, bitrate: 100000, codec: 'avc1.42c01e' };
}
function audio(name: string): AudioTrack {
  return { index: 0, trackName: name, id: key(name), namespace: [namespace], label: name, codec: 'opus' };
}
function view(id: string, name: string): View { return { id, label: id, levels: [level(name)] }; }
const oldView = view('v1', 'video-360'), alternate = view('v4', 'video-720'), nextView = view('v2', 'video-1080');
const programs: Program[] = [
  { id: 'p1', label: 'old', renderGroup: 1, views: [oldView, alternate], audioTracks: [audio('audio-en')] },
  { id: 'p2', label: 'next', renderGroup: 2, views: [nextView], audioTracks: [audio('audio-es')] },
];
function point(timeMs: number, selected: View = oldView, program = 'p1', audioName = 'audio-en'): MseSelectionPoint {
  return { timeMs, media: { programs, views: program === 'p1' ? [oldView, alternate] : [nextView],
    currentProgram: program, currentView: selected.id, currentAudioTrackId: key(audioName) },
    selection: { levels: [...selected.levels], currentLevel: 0, autoQuality: false, currentAudioTrack: 0,
      currentAudioTrackId: key(audioName), audioTracks: [audio(audioName)] }, sample: undefined };
}
function samples(mode: 'program' | 'view', adopt: boolean): PlaybackSample[] {
  return Array.from({ length: 62 }, (_, index) => {
    const wallMs = 1000 + index * 250;
    return { outputKind: 'video', wallMs, mediaTimeS: wallMs / 1000 + offset, presentedMediaTimeS: wallMs / 1000 + offset,
      presentedFrames: 6 * index + 1, pictureDigest: String(index), pictureChange: 4, markerRgb: [0, 255, 0],
      videoWidth: 640, videoHeight: 360, nativeFrameWidth: 640, nativeFrameHeight: 360, nativeFrameAtMs: wallMs - 10,
      audioRms: 0.08, audioPeakHz: adopt && mode === 'program' && wallMs > 8000 ? 880 : 440,
      audioContextTimeS: wallMs / 1000, paused: false, seeking: false, visibility: 'visible',
      bufferedRanges: [{ start: wallMs / 1000 + offset - 0.5, end: wallMs / 1000 + offset + 3 }] };
  });
}
function receipt(name: string, type: 'video' | 'audio', rawOrigin: number, wallMs: number, seq: number): MseProgramSegment {
  return { seq, mediaType: type, trackName: name, sourceKey: key(name), groupId: '1', rawPtsTicks: String(rawOrigin + wallMs),
    rebasedPtsTicks: String(wallMs), endTicks: String(wallMs + 500), timescale: 1000, offset,
    submittedAtMs: wallMs - 100, completedAtMs: wallMs - 50, state: 'appended', reason: null };
}
function fixture(mode: 'program' | 'view' = 'program', outcome: 'adopt' | 'queue-refusal' = 'adopt') {
  const adopted = outcome === 'adopt', program = mode === 'program';
  const plan: MseProgramSwitchPlan = { mode, outcome, namespace, relayUrl, variant: structuredClone(variant),
    expected: { outputKind: 'video', videoWidth: 640, videoHeight: 360, videoFps: 24, audioHz: adopted && program ? 880 : 440 } };
  const all = samples(mode, adopted), baselineSamples = all.slice(0, 26);
  const segments: MseProgramSegment[] = [];
  for (const sample of all) {
    const next = adopted && sample.wallMs > 8000;
    segments.push(receipt(next ? program ? 'video-1080' : 'video-720' : 'video-360', 'video', next ? program ? 90000 : 700000 : 0, sample.wallMs, segments.length));
    segments.push(receipt(next && program ? 'audio-es' : 'audio-en', 'audio', next && program ? 900000 : 0, sample.wallMs, segments.length));
  }
  const baselineWire = ['catalog', 'video-360', 'audio-en'].map((name, index) => ({ name, namespace: [namespace], requestId: String(index * 4), timeMs: 100 + index }));
  const newWire = (program ? ['video-1080', 'audio-es'] : ['video-720']).map((name, index) => ({ name, namespace: [namespace], requestId: String(12 + index * 4), timeMs: 8100 + index }));
  const initial = point(500), before = point(7500), after = adopted
    ? point(17000, program ? nextView : alternate, program ? 'p2' : 'p1', program ? 'audio-es' : 'audio-en') : point(17000);
  const snapshot = (isBaseline: boolean): MseProgramSnapshot => ({
    samples: isBaseline ? baselineSamples : all, startupError: null,
    events: isBaseline ? [] : [{ timeMs: 8200, type: adopted ? program ? 'programchange' : 'viewchange' : program ? 'programchangefailed' : 'viewchangefailed',
      data: adopted ? program ? { program: programs[1] } : { view: alternate }
        : program ? { programId: 'p2', message: 'MSE acceptance injected queue acquisition refusal' } : { viewId: 'v4', message: 'MSE acceptance injected queue acquisition refusal' } },
      ...(adopted && program ? [{ timeMs: 8200, type: 'viewchange', data: { view: nextView } }] : [])],
    nativeEvents: [], nativeError: null,
    transportState: [{ url: relayUrl, openedAtMs: 1, closedAtMs: null }],
    nativeMse: { calls: [], buffers: [{ id: 0, mime: 'video/mp4; codecs="avc1.42c01e"', offset }, { id: 1, mime: 'audio/mp4; codecs="opus"', offset }] },
    programWire: { connections: 1, overflow: false, subscriptions: isBaseline ? baselineWire : [...baselineWire, ...newWire] },
    mseProgram: { sources: 1, overflow: false, failures: [], segments: isBaseline ? segments.filter(item => (item.completedAtMs ?? Infinity) < 7500) : segments,
      queues: isBaseline ? [] : [{ kind: adopted ? 'acquire' : 'refused', timeMs: 8150, roles: program ? ['video', 'audio'] : ['video'] }] },
    warmStart: null, decodedSource: null, playbackQuality: { before: null, reported: null, after: null },
    outputState: { presentedFrames: 100, currentTime: 10, audioRms: 0.08, audioContext: 'running', videoPaused: false, videoTime: 10, videoReadyState: 4, buffered: [[0, 30]] },
    levels: [], videoGroups: [], audioTracks: [],
  });
  const result: MseProgramSwitchObservation = { initial, before, after, requestedAtMs: 8000, targetFromMs: 10000,
    timeline: { id: program ? 'p2' : 'v4', track: { name: 'audio-en', namespaceFields: [namespace] }, domain: 'media-time',
      observedSourceTimeUs: '7500000', anchors: program ? plan.variant.maps.program : plan.variant.maps.view },
    refusal: adopted ? null : 'MSE acceptance injected queue acquisition refusal', baseline: snapshot(true), observed: snapshot(false) };
  return { plan, result };
}

it('reuses the relocated fixture implementation and registers four explicit-only native cases', () => {
  expect(prepareMseProgramSwitchVariant).toBe(prepareProgramSwitchVariant);
  expect(mseProgramSwitchCases.map(item => item.name)).toEqual(['mse-program-switch-reference-map', 'mse-program-switch-queue-refusal',
    'mse-view-switch-reference-map', 'mse-view-switch-queue-refusal']);
});

it('accepts both changed facade dimensions from one joint program adoption', () => {
  const f = fixture('program');
  f.result.observed.events = [
    { timeMs: 8200, type: 'programchange', data: { program: programs[1] } },
    { timeMs: 8200, type: 'viewchange', data: { view: nextView } },
  ];
  expect(assessMseProgramSwitch(f.result, f.plan).failures).toEqual([]);
});

it('refuses a program adoption which never reports its changed view', () => {
  const f = fixture('program');
  f.result.observed.events = [{ timeMs: 8200, type: 'programchange', data: { program: programs[1] } }];
  expect(assessMseProgramSwitch(f.result, f.plan).failures).toContain('selection-outcome');
});

it('refuses a program adoption whose secondary view event identifies another view', () => {
  const f = fixture('program');
  f.result.observed.events = [
    { timeMs: 8200, type: 'programchange', data: { program: programs[1] } },
    { timeMs: 8200, type: 'viewchange', data: { view: oldView } },
  ];
  expect(assessMseProgramSwitch(f.result, f.plan).failures).toContain('selection-event-identity');
});

it('refuses duplicate change events rather than accepting a matching event among extras', () => {
  const f = fixture('program');
  f.result.observed.events.push({ timeMs: 8201, type: 'programchange', data: { program: programs[1] } });
  expect(assessMseProgramSwitch(f.result, f.plan).failures).toContain('selection-outcome');
});
describe.each(['program', 'view'] as const)('%s native MSE acceptance oracle', mode => {
  it.each(['adopt', 'queue-refusal'] as const)('accepts complete measured-shaped evidence for %s, including nonzero native offsets', outcome => {
    const f = fixture(mode, outcome);
    expect(assessMseProgramSwitch(f.result, f.plan).failures).toEqual([]);
  });
  const bad: [string, (result: MseProgramSwitchObservation) => void, string][] = [
    ['new menu with no actual target append', r => { r.observed.mseProgram.segments = r.observed.mseProgram.segments.filter(item => item.trackName === 'audio-en' || item.trackName === 'video-360'); }, 'native-frame-without-target-append'],
    ['stale rVFC despite progressing playhead', r => { r.observed.samples = r.observed.samples.map(item => ({ ...item, nativeFrameAtMs: 7000 })); }, 'stale-or-fake-native-frame'],
    ['frozen pixels despite counters', r => { r.observed.samples = r.observed.samples.map(item => ({ ...item, pictureDigest: 'frozen', pictureChange: 0 })); }, 'output-picture-frozen'],
    ['wrong PCM', r => { r.observed.samples = r.observed.samples.map(item => ({ ...item, audioPeakHz: 1234 })); }, 'output-audio-identity'],
    ['submitted but never completed target', r => { for (const item of r.observed.mseProgram.segments) if (item.trackName === (mode === 'program' ? 'video-1080' : 'video-720')) item.state = 'submitted'; }, 'native-frame-without-target-append'],
    ['wrong application placement', r => { for (const item of r.observed.mseProgram.segments) if (item.trackName === (mode === 'program' ? 'video-1080' : 'video-720')) item.rawPtsTicks = String(BigInt(item.rawPtsTicks!) + 1000n); }, 'application-map-placement'],
    ['duplicate request id', r => { r.observed.programWire!.subscriptions.at(-1)!.requestId = '4'; }, 'exact-wire-ids'],
    ['duplicated startup owner', r => { r.baseline.programWire!.subscriptions[2] = { ...r.baseline.programWire!.subscriptions[0]! }; }, 'wire-owner-changed'],
    ['wrong namespace tuple', r => { r.observed.programWire!.subscriptions.at(-1)!.namespace = ['local', 'program']; }, 'exact-wire-tuples'],
    ['extra catalog request', r => { r.observed.programWire!.subscriptions.push({ name: 'catalog', namespace: [namespace], requestId: '40', timeMs: 8100 }); }, 'exact-wire-tuples'],
    ['replaced connection', r => { r.observed.programWire!.connections = 2; }, 'wire-owner'],
    ['closed transport', r => { r.observed.transportState[0]!.closedAtMs = 11000; }, 'transport-owner'],
    ['overflowed sensor', r => { r.observed.mseProgram.overflow = true; }, 'native-source-evidence'],
    ['wrong public adoption event id', r => { r.observed.events[0]!.data = mode === 'program' ? { program: { id: 'other' } } : { view: { id: 'other' } }; }, 'selection-event-identity'],
    ['missing source authority', r => { for (const item of r.observed.mseProgram.segments) item.sourceKey = null; }, 'canonical-native-placement'],
    ['unobserved canonical raw reference', r => { r.timeline.observedSourceTimeUs = '123'; }, 'canonical-reference-without-raw-bytes'],
    ['changed encoded payload proof', r => { void r; }, 'fixture-payload-proof'],
  ];
  it.each(bad)('rejects %s', (name, mutate, failure) => {
    const f = fixture(mode);
    if (name === 'changed encoded payload proof') f.plan.variant.encodedPayloadProof['sample.m4s']!.afterSha256 = 'b'.repeat(64);
    mutate(f.result);
    expect(assessMseProgramSwitch(f.result, f.plan).failures).toContain(failure);
  });
  it('rejects an ineffective failure injection or a refusal which submits target media', () => {
    const f = fixture(mode, 'queue-refusal');
    f.result.observed.mseProgram.queues = [];
    expect(assessMseProgramSwitch(f.result, f.plan).failures).toContain('queue-refusal-not-exercised');
    f.result.observed.mseProgram.segments.push(receipt(mode === 'program' ? 'video-1080' : 'video-720', 'video', 90000, 12000, 500));
    expect(assessMseProgramSwitch(f.result, f.plan).failures).toContain('refusal-submitted-target');
  });
});
