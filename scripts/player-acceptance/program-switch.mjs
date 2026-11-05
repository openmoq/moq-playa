// @ts-check
import assert from 'node:assert/strict';
import { assessAudioSwitchOutput } from './audio-switch.mjs';

/** Raw source PTS, independent native draw correlation, movement and real post-gain PCM.
 * @param {readonly import('./assessment.mjs').PlaybackSample[]} samples
 * @param {import('./assessment.mjs').ExpectedPlayback} expected @param {string} sourceOriginUs
 */
export function assessProgramSwitchOutput(samples, expected, sourceOriginUs) {
  assert.match(sourceOriginUs, /^\d+$/);
  const origin = Number(sourceOriginUs);
  assert.ok(Number.isSafeInteger(origin) && Number.isFinite(expected.publisherEpochMs), 'Missing exact fixture/publisher origin');
  // This is a check against the declared source epoch, not a rewrite of observed timestamps.
  const adjusted = { ...expected, outputKind: /** @type {const} */ ('canvas'), timestampDomain: /** @type {const} */ ('media'),
    publisherEpochMs: /** @type {number} */ (expected.publisherEpochMs) - origin / 1000 };
  const failures = new Set(assessAudioSwitchOutput(samples, adjusted).failures);
  if (samples.some(sample => !Number.isSafeInteger(sample.nativeDrawTimestampUs)
      || /** @type {number} */ (sample.nativeDrawTimestampUs) < origin
      || sample.videoPresentation?.frameTimestampUs !== String(sample.nativeDrawTimestampUs))) failures.add('raw-video-source');
  return { passed: failures.size === 0, failures: [...failures].sort() };
}

/** Session-level output progress across intentionally different raw video domains.
 * Raw PTS continuity is checked within each retained window, never across the domain change.
 * @param {Parameters<import('./program-switch.mjs').assessProgramSwitchSession>[0]} observed
 */
export function assessProgramSwitchSession(observed) {
  const failures = new Set();
  if (observed.transportState.length !== 1 || observed.transportState.some(transport => transport.closedAtMs !== null)) failures.add('transport-replaced-or-closed');
  const first = observed.samples[0], last = observed.samples.at(-1);
  if (!first || !last || observed.samples.length < 16) failures.add('insufficient-session-observations');
  if (observed.nativeError || observed.nativeEvents.some(event => event.type === 'error' || event.type === 'stalled')) failures.add('native-media-event');
  if (observed.events.some(event => event.type === 'error' || event.type === 'stall' && event.timeMs >= (first?.wallMs ?? Infinity))) failures.add('player-error-or-stall');
  let frameSince = first?.wallMs ?? 0, pictureSince = frameSince, audioSince = frameSince;
  for (let index = 1; index < observed.samples.length; index++) {
    const a = observed.samples[index - 1], b = observed.samples[index];
    if (!a || !b) { failures.add('invalid-session-observation'); continue; }
    const wall = b.wallMs - a.wallMs;
    if (wall <= 0 || wall > 1000) failures.add('observation-gap');
    if (b.presentedFrames > a.presentedFrames) frameSince = b.wallMs;
    if (b.presentedFrames < a.presentedFrames) failures.add('frame-counter-reset');
    if (b.pictureDigest !== a.pictureDigest && b.pictureChange > 1) pictureSince = b.wallMs;
    if (b.audioRms > 0.015) audioSince = b.wallMs;
    if (b.wallMs - frameSince >= 1500) failures.add('presentation-stalled');
    if (b.wallMs - pictureSince >= 1500) failures.add('picture-frozen');
    if (b.wallMs - audioSince >= 500) failures.add('audio-missing');
    if (!Number.isFinite(a.audioContextTimeS) || !Number.isFinite(b.audioContextTimeS)
      || Math.abs((/** @type {number} */ (b.audioContextTimeS) - /** @type {number} */ (a.audioContextTimeS)) * 1000 - wall) > 100) failures.add('audio-clock');
    if (b.paused || b.seeking || b.visibility !== 'visible') failures.add('playback-inactive');
  }
  if (first && last && (last.presentedFrames - first.presentedFrames) / ((last.wallMs - first.wallMs) / 1000) < 24 * 0.8) failures.add('presentation-rate');
  return { passed: failures.size === 0, failures: [...failures].sort() };
}

/** @param {import('./program-switch.mjs').ProgramPauseResumeObservation} observation
 * @param {import('./assessment.mjs').ExpectedPlayback} expected @param {string} sourceOriginUs */
export function assessProgramPauseResume(observation, expected, sourceOriginUs) {
  const { before, pause, paused, resume, ready, after, observed } = observation;
  // Keep the complete phase receipt, including deliberately stopped output.
  // The ordinary moving-output oracle applies unchanged to its active window.
  const samples = observed.samples.filter(sample => sample.wallMs >= ready.timeMs);
  const active = { ...observed, samples, events: observed.events.filter(event => event.type !== 'stall' || event.timeMs >= resume.actionAtMs) };
  const failures = new Set([...assessProgramSwitchOutput(samples, expected, sourceOriginUs).failures,
    ...assessProgramSwitchSession(active).failures]);
  if (before.state !== 'playing' || pause.state !== 'paused' || paused.state !== 'paused') failures.add('pause-not-entered');
  if (pause.presentedFrames !== paused.presentedFrames || pause.nativeDrawTimestampUs !== paused.nativeDrawTimestampUs) failures.add('pause-did-not-stop-native-frames');
  if (resume.state !== 'playing' || ready.state !== 'playing' || after.state !== 'playing') failures.add('resume-not-playing');
  if (![pause.actionAtMs, resume.actionAtMs, ready.timeMs].every(Number.isFinite)
      || !(before.timeMs <= pause.actionAtMs && pause.actionAtMs <= pause.timeMs && pause.timeMs <= paused.timeMs
        && paused.timeMs <= resume.actionAtMs && resume.actionAtMs <= resume.timeMs && resume.timeMs < ready.timeMs
        && ready.timeMs <= after.timeMs)) failures.add('pause-resume-order');
  if (ready.timeMs - resume.actionAtMs >= 15000) failures.add('resume-readiness-deadline');
  if (!Number.isSafeInteger(paused.nativeDrawTimestampUs) || !Number.isSafeInteger(ready.nativeDrawTimestampUs)
      || /** @type {number} */ (ready.nativeDrawTimestampUs) <= /** @type {number} */ (paused.nativeDrawTimestampUs)
      || ready.presentedFrames < paused.presentedFrames + 8
      || ready.nativeDrawTimeMs === null || ready.nativeDrawTimeMs <= resume.actionAtMs
      || samples.some(sample => !Number.isSafeInteger(sample.nativeDrawTimestampUs)
        || /** @type {number} */ (sample.nativeDrawTimestampUs) <= /** @type {number} */ (paused.nativeDrawTimestampUs)
        || typeof sample.nativeDrawTimeMs !== 'number' || sample.nativeDrawTimeMs <= resume.actionAtMs)) failures.add('stale-post-resume-video');
  for (const point of [pause, paused, resume, ready, after]) {
    if (point.currentProgram !== before.currentProgram || point.currentView !== before.currentView
        || point.currentAudioTrackId !== before.currentAudioTrackId) failures.add('pause-resume-selection-changed');
  }
  if (observed.events.some(event => event.type === 'error')) failures.add('player-error-or-stall');
  if (observed.events.some(event => event.type === 'stall' && event.timeMs >= resume.actionAtMs)) failures.add('player-error-or-stall');
  if (observed.events.some(event => ['programchange', 'viewchange', 'audiochange'].includes(event.type)
      && event.timeMs >= pause.actionAtMs)) failures.add('selection-event-after-pause');
  if (observed.events.filter(event => event.type === 'pause' && event.timeMs >= pause.actionAtMs).length !== 1
      || observed.events.filter(event => event.type === 'play' && event.timeMs >= resume.actionAtMs).length !== 1) failures.add('pause-resume-event-count');
  return { passed: failures.size === 0, failures: [...failures].sort() };
}

/** @param {Parameters<import('./program-switch.mjs').assessProgramSwitchSubscriptions>[0]} wire
 * @param {string} namespace @param {import('./program-switch.mjs').ProgramSwitchMode} mode
 * @param {import('./program-switch.fixture.mjs').ProgramSwitchVariant['tracks']} tracks */
export function assessProgramSwitchSubscriptions(wire, namespace, mode, tracks) {
  const failures = new Set();
  if (!wire || wire.connections !== 1 || wire.overflow) failures.add('wire-observation');
  const required = [tracks.oldVideo.name, tracks.oldAudio.name,
    ...(mode === 'program' ? [tracks.nextVideo.name, tracks.nextAudio.name] : [tracks.viewVideo.name])];
  const media = wire?.subscriptions.filter(item => item.name !== 'catalog') ?? [];
  if (media.length !== required.length || required.some(name => media.filter(item => item.name === name
    && item.namespace.length === 1 && item.namespace[0] === namespace).length !== 1)) failures.add('media-subscriptions');
  if (mode === 'view' && media.filter(item => item.name === tracks.oldAudio.name).length !== 1) failures.add('view-audio-resubscribed');
  return { passed: failures.size === 0, failures: [...failures].sort() };
}

/** Calls public facade program/view selectors only; the opaque reference token stays in-page.
 * @param {import('playwright').Page} page @param {import('./program-switch.mjs').ProgramSwitchEvidence} evidence
 * @param {<T>(promise: Promise<T>, ms: number, label: string) => Promise<T>} bounded
 * @param {import('./program-switch.mjs').ProgramSwitchPlan} plan */
export async function checkProgramSwitch(page, evidence, bounded, plan) {
  evidence.mode = plan.mode;
  const tracks = plan.variant.tracks, program = plan.mode === 'program';
  const target = program ? tracks.nextVideo : tracks.viewVideo;
  const targetHz = program ? 880 : 440;
  const read = () => bounded(page.evaluate(() => ({ timeMs: performance.now(), media: window.playerAcceptance.mediaSelection,
    selection: window.playerAcceptance.selection, sample: window.playerAcceptance.latestSample })), 5000, 'program selection/output snapshot');
  const initial = await read();
  assert.deepEqual(initial.media.programs.map(item => item.renderGroup), [1, 2]);
  const oldProgram = initial.media.programs.find(item => item.renderGroup === 1);
  assert.ok(oldProgram && initial.media.currentProgram === oldProgram.id, 'Startup must adopt program 1');
  assert.deepEqual(initial.selection.levels.map(item => item.trackName), [tracks.oldVideo.name]);
  assert.equal(initial.selection.audioTracks[initial.selection.currentAudioTrack]?.trackName, tracks.oldAudio.name);

  await bounded(page.evaluate(() => window.playerAcceptance.begin(false)), 5000, 'begin original program window');
  await bounded(page.waitForTimeout(5750), 7000, 'original program output window');
  const baseline = await bounded(page.evaluate(() => window.playerAcceptance.snapshot()), 5000, 'original program snapshot');
  evidence.before = await read();
  evidence.baseline = { samples: baseline.samples,
    assessment: assessProgramSwitchOutput(baseline.samples, { ...plan.expected, audioHz: 440 }, tracks.oldVideo.firstPresentationTimeUs),
    wrongAudio: assessProgramSwitchOutput(baseline.samples, { ...plan.expected, audioHz: 880 }, tracks.oldVideo.firstPresentationTimeUs) };
  assert.deepEqual(evidence.baseline.assessment.failures, [], 'Original program must draw moving raw-source 360p frames and real 440Hz PCM');
  assert.deepEqual(evidence.baseline.wrongAudio.failures, ['audio-identity'], 'Original English signal must reject Spanish identity');
  const before = evidence.before.sample; assert.ok(before, 'Missing measured original program output');
  const requestedAtMs = await bounded(page.evaluate(() => performance.now()), 5000, 'program/view request time');
  evidence.requestedAtMs = requestedAtMs;
  evidence.timeline = program
    ? await bounded(page.evaluate(anchors => window.playerAcceptance.selectProgramMapped(2, anchors), plan.variant.maps.program), 15000, 'public mapped program selection')
    : await bounded(page.evaluate(({ name, anchors }) => window.playerAcceptance.selectViewMapped(name, anchors),
      { name: target.name, anchors: plan.variant.maps.view }), 15000, 'public mapped view selection');
  assert.deepEqual(evidence.timeline.track, { name: tracks.oldAudio.name, namespaceFields: [plan.namespace] }, 'Mapping must bind the adopted canonical audio reference');
  evidence.afterSetter = await read();
  await page.waitForFunction(({ origin, hz, requestedAt, frames }) => {
    const state = window.playerAcceptance, sample = state.latestSample;
    return sample !== undefined && sample.outputKind === 'canvas' && sample.wallMs > requestedAt
      && sample.audioRms > 0.015 && Math.abs(sample.audioPeakHz - hz) <= 35
      && sample.videoWidth === 640 && sample.videoHeight === 360 && sample.presentedFrames >= frames + 8
      && sample.pictureChange > 1 && typeof sample.nativeDrawTimeMs === 'number' && sample.nativeDrawTimeMs > requestedAt
      && Number.isSafeInteger(sample.nativeDrawTimestampUs) && BigInt(/** @type {number} */ (sample.nativeDrawTimestampUs)) >= BigInt(origin)
      && sample.videoPresentation?.frameTimestampUs === String(sample.nativeDrawTimestampUs);
  }, { origin: target.firstPresentationTimeUs, hz: targetHz, requestedAt: evidence.requestedAtMs, frames: before.presentedFrames },
  { polling: 100, timeout: 15000 });
  evidence.afterReadiness = await read();
  evidence.settledAfterMs = evidence.afterReadiness.timeMs - evidence.requestedAtMs;
  const fromMs = evidence.afterReadiness.timeMs;
  await bounded(page.waitForTimeout(5750), 7000, 'new raw-source output window');
  const observed = await bounded(page.evaluate(() => window.playerAcceptance.finish()), 5000, 'finish program/view output');
  evidence.after = await read();
  const samples = observed.samples.filter(sample => sample.wallMs >= fromMs);
  evidence.target = { samples, fromMs, untilMs: evidence.after.timeMs,
    assessment: assessProgramSwitchOutput(samples, { ...plan.expected, audioHz: targetHz }, target.firstPresentationTimeUs),
    wrongAudio: assessProgramSwitchOutput(samples, { ...plan.expected, audioHz: targetHz === 880 ? 440 : 880 }, target.firstPresentationTimeUs),
    oldVideo: assessProgramSwitchOutput(samples, { ...plan.expected, audioHz: targetHz }, tracks.oldVideo.firstPresentationTimeUs) };
  evidence.session = assessProgramSwitchSession(observed);
  evidence.wire = assessProgramSwitchSubscriptions(observed.programWire, plan.namespace, plan.mode, tracks);
  const failures = new Set([...evidence.target.assessment.failures, ...evidence.session.failures, ...evidence.wire.failures]);
  if (evidence.target.wrongAudio.failures.join(',') !== 'audio-identity') failures.add('audio-negative-control');
  if (!evidence.target.oldVideo.failures.includes('timestamp-domain')) failures.add('old-video-negative-control');
  const selected = evidence.after.media;
  if (program ? selected.currentProgram !== evidence.timeline.id : selected.currentProgram !== initial.media.currentProgram
      || selected.currentView !== evidence.timeline.id || selected.currentAudioTrackId !== initial.media.currentAudioTrackId) failures.add('adopted-selection');
  if (evidence.after.selection.levels.length !== 1 || evidence.after.selection.levels[0]?.trackName !== target.name
      || evidence.after.selection.audioTracks[evidence.after.selection.currentAudioTrack]?.trackName !== (program ? tracks.nextAudio.name : tracks.oldAudio.name)) failures.add('adopted-track-identity');
  const changes = observed.events.filter(event => event.type === (program ? 'programchange' : 'viewchange') && event.timeMs >= requestedAtMs);
  if (changes.length !== 1) failures.add('adoption-event-count');
  evidence.assessment = { passed: failures.size === 0, failures: [...failures].sort() };
  assert.deepEqual(evidence.target.assessment.failures, [], 'Target must draw new raw-source moving frames with actual target PCM');
  assert.deepEqual(evidence.target.wrongAudio.failures, ['audio-identity'], 'PCM negative control must reject the other signal');
  assert.ok(evidence.target.oldVideo.failures.includes('timestamp-domain'), 'New raw video source must reject the old source epoch');
  assert.deepEqual(evidence.assessment.failures, [], 'Program/view output, ownership and same-session continuity');
  evidence.adoptionAssessment = evidence.assessment;
  evidence.assessment = { passed: false, failures: ['pause-resume-incomplete'] };
  /** @type {import('./program-switch.mjs').ProgramPauseResumeEvidence} */
  const cycle = {}; evidence.pauseResume = cycle;
  cycle.before = await bounded(page.evaluate(() => window.playerAcceptance.playback), 5000, 'adopted playback before pause');
  cycle.pause = await bounded(page.evaluate(() => {
    const state = window.playerAcceptance, point = state.pausePlayback(); state.begin(false); return point;
  }), 5000, 'public pause after mapped adoption');
  assert.equal(cycle.pause.state, 'paused', 'Public pause must enter paused state');
  // Deliberate dwell exercises paused queue/clock boundaries. It is not an output witness.
  await bounded(page.waitForTimeout(2000), 4000, 'deliberate paused interval');
  cycle.paused = await bounded(page.evaluate(() => window.playerAcceptance.playback), 5000, 'paused native-output boundary');
  assert.equal(cycle.paused.state, 'paused', 'Pause must remain active until public play');
  cycle.resume = await bounded(page.evaluate(() => window.playerAcceptance.resumePlayback()), 5000, 'public play after pause');
  const resumeAtMs = cycle.resume.actionAtMs, pausedFrames = cycle.paused.presentedFrames, pausedRaw = cycle.paused.nativeDrawTimestampUs;
  assert.ok(Number.isSafeInteger(pausedRaw), 'Missing native pre-resume raw frame timestamp');
  await bounded(page.waitForFunction(({ resumeAtMs, frames, raw, hz, origin }) => {
    const state = window.playerAcceptance, sample = state.latestSample;
    return state.playback.state === 'playing' && sample !== undefined && !sample.paused && sample.wallMs > resumeAtMs
      && sample.outputKind === 'canvas' && sample.videoWidth === 640 && sample.videoHeight === 360
      && sample.presentedFrames >= frames + 8 && sample.pictureChange > 1
      && sample.audioRms > 0.015 && Math.abs(sample.audioPeakHz - hz) <= 35
      && typeof sample.nativeDrawTimeMs === 'number' && sample.nativeDrawTimeMs > resumeAtMs
      && typeof sample.nativeDrawTimestampUs === 'number' && Number.isSafeInteger(sample.nativeDrawTimestampUs)
      && sample.nativeDrawTimestampUs > raw && BigInt(sample.nativeDrawTimestampUs) >= BigInt(origin)
      && sample.videoPresentation?.frameTimestampUs === String(sample.nativeDrawTimestampUs);
  }, { resumeAtMs, frames: pausedFrames, raw: /** @type {number} */ (pausedRaw), hz: targetHz, origin: target.firstPresentationTimeUs },
  { polling: 100, timeout: 15000 }), 17000, 'fresh native output after mapped resume');
  cycle.ready = await bounded(page.evaluate(() => window.playerAcceptance.playback), 5000, 'resumed native-output readiness');
  cycle.readinessAfterMs = cycle.ready.timeMs - resumeAtMs;
  assert.ok(cycle.readinessAfterMs < 15000, 'Mapped resume exceeded its 15s readiness deadline');
  const resumeFromMs = cycle.ready.timeMs;
  await bounded(page.waitForTimeout(5750), 7000, 'post-resume mapped output window');
  const resumed = await bounded(page.evaluate(() => window.playerAcceptance.finish()), 5000, 'finish post-resume output');
  cycle.observed = resumed;
  cycle.after = await bounded(page.evaluate(() => window.playerAcceptance.playback), 5000, 'post-resume selection/output boundary');
  const resumedSamples = resumed.samples.filter(sample => sample.wallMs >= resumeFromMs);
  cycle.output = { samples: resumedSamples, fromMs: resumeFromMs, untilMs: cycle.after.timeMs,
    assessment: assessProgramSwitchOutput(resumedSamples, { ...plan.expected, audioHz: targetHz }, target.firstPresentationTimeUs),
    wrongAudio: assessProgramSwitchOutput(resumedSamples, { ...plan.expected, audioHz: targetHz === 880 ? 440 : 880 }, target.firstPresentationTimeUs),
    oldVideo: assessProgramSwitchOutput(resumedSamples, { ...plan.expected, audioHz: targetHz }, tracks.oldVideo.firstPresentationTimeUs) };
  cycle.wire = assessProgramSwitchSubscriptions(resumed.programWire, plan.namespace, plan.mode, tracks);
  const resumedAssessment = assessProgramPauseResume({ before: cycle.before, pause: cycle.pause, paused: cycle.paused,
    resume: cycle.resume, ready: cycle.ready, after: cycle.after, observed: resumed }, { ...plan.expected, audioHz: targetHz }, target.firstPresentationTimeUs);
  const resumedFailures = new Set([...resumedAssessment.failures, ...cycle.wire.failures]);
  if (cycle.output.wrongAudio.failures.join(',') !== 'audio-identity') resumedFailures.add('resume-audio-negative-control');
  if (!cycle.output.oldVideo.failures.includes('timestamp-domain')) resumedFailures.add('resume-old-video-negative-control');
  cycle.assessment = { passed: resumedFailures.size === 0, failures: [...resumedFailures].sort() };
  evidence.assessment = { ...cycle.assessment, failures: [...new Set([...evidence.adoptionAssessment.failures, ...cycle.assessment.failures])].sort() };
  assert.deepEqual(cycle.output.assessment.failures, [], 'Resumed mapped output must draw fresh source frames and actual target PCM');
  assert.deepEqual(cycle.output.wrongAudio.failures, ['audio-identity'], 'Resumed PCM must retain its negative control');
  assert.deepEqual(evidence.assessment.failures, [], 'Pause/resume must preserve adopted output, timing correlation and one session');
  // Existing runner draw/source/teardown checks receive both active windows.
  // The complete intentionally paused/readiness capture remains in cycle.observed.
  return { ...resumed, samples: [...observed.samples, ...resumedSamples], nativeEvents: [...observed.nativeEvents, ...resumed.nativeEvents] };
}
