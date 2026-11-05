// @ts-check
import assert from 'node:assert/strict';
import { assessAudioSwitchOutput } from './audio-switch.mjs';
import { assessProgramSwitchSession } from './program-switch.mjs';
export { prepareProgramSwitchVariant as prepareMseProgramSwitchVariant } from './program-switch.fixture.mjs';

// Explicit-only runner entries. Reuse the LOC-qualified relocated CMAF files,
// publish via publish-fixture --loop --pace-media --catalog-format cmsf-01.
export const mseProgramSwitchCases = Object.freeze(['program', 'view'].flatMap(mode =>
  ['adopt', 'queue-refusal'].map(outcome => Object.freeze({
    name: `mse-${mode}-switch-${outcome === 'adopt' ? 'reference-map' : outcome}`,
    mode: /** @type {'program' | 'view'} */ (mode), outcome: /** @type {'adopt' | 'queue-refusal'} */ (outcome),
  }))));

/** @param {import('./mse-program-switch-observer.mjs').MseProgramSegment} segment */
function placement(segment) {
  if (segment.rawPtsTicks === null || segment.rebasedPtsTicks === null || segment.endTicks === null
      || !Number.isSafeInteger(segment.timescale) || /** @type {number} */ (segment.timescale) <= 0
      || !Number.isFinite(segment.offset)) return null;
  try {
    const scale = BigInt(/** @type {number} */ (segment.timescale));
    const raw = BigInt(segment.rawPtsTicks), rebased = BigInt(segment.rebasedPtsTicks), end = BigInt(segment.endTicks);
    if (raw < 0n || rebased < 0n || end <= rebased) return null;
    return { raw, rebased, scale, startS: Number(rebased) / Number(scale) + /** @type {number} */ (segment.offset),
      endS: Number(end) / Number(scale) + /** @type {number} */ (segment.offset) };
  } catch { return null; }
}
/** @param {import('./program-switch-wire-observer.mjs').ProgramWireSnapshot | null} wire
 * @param {import('./mse-program-switch.mjs').MseProgramSwitchPlan} plan */
function wireFailures(wire, plan) {
  const t = plan.variant.tracks;
  const names = ['catalog', t.oldVideo.name, t.oldAudio.name,
    ...(plan.mode === 'program' ? [t.nextVideo.name, t.nextAudio.name] : [t.viewVideo.name])];
  const failures = new Set();
  if (!wire || wire.connections !== 1 || wire.overflow) failures.add('wire-owner');
  const records = wire?.subscriptions ?? [];
  if (records.length !== names.length || names.some(name => records.filter(item => item.name === name
      && item.namespace.length === 1 && item.namespace[0] === plan.namespace).length !== 1)) failures.add('exact-wire-tuples');
  const ids = records.map(record => record.requestId);
  if (new Set(ids).size !== records.length || records.some(record => !/^(0|[1-9]\d*)$/.test(record.requestId)
      || !Number.isFinite(record.timeMs))) failures.add('exact-wire-ids');
  return failures;
}

/** Application maps do not declare cross-set alignment. Actual native output
 * and byte/append receipts are necessary, but cannot prove an atomic A/V splice.
 * @param {import('./mse-program-switch.mjs').MseProgramSwitchObservation} result
 * @param {import('./mse-program-switch.mjs').MseProgramSwitchPlan} plan */
export function assessMseProgramSwitch(result, plan) {
  const { initial, before, after, baseline, observed, requestedAtMs, targetFromMs, timeline } = result;
  const tracks = plan.variant.tracks, program = plan.mode === 'program', adopted = plan.outcome === 'adopt';
  const targetVideo = program ? tracks.nextVideo : tracks.viewVideo;
  const targetAudio = program ? tracks.nextAudio : tracks.oldAudio;
  const failures = new Set();
  const initialProgram = initial.media.programs.find(item => item.renderGroup === 1);
  if (!initialProgram || initial.media.currentProgram !== initialProgram.id
      || initial.selection.levels.length !== 1 || initial.selection.levels[0]?.trackName !== tracks.oldVideo.name
      || initial.selection.audioTracks[initial.selection.currentAudioTrack]?.trackName !== tracks.oldAudio.name) failures.add('initial-selection');
  if (!Number.isFinite(requestedAtMs) || !Number.isFinite(targetFromMs) || targetFromMs < requestedAtMs
      || targetFromMs - requestedAtMs >= 15000 || after.timeMs <= targetFromMs) failures.add('selection-deadline');
  if (timeline.domain !== 'media-time' || timeline.track.name !== tracks.oldAudio.name
      || timeline.track.namespaceFields.length !== 1 || timeline.track.namespaceFields[0] !== plan.namespace
      || !/^\d+$/.test(timeline.observedSourceTimeUs)
      || JSON.stringify(timeline.anchors) !== JSON.stringify(program ? plan.variant.maps.program : plan.variant.maps.view)) failures.add('canonical-raw-reference');
  if (plan.variant.encodedPayloadUnchanged !== true || plan.variant.metadataOnly !== false
      || Object.keys(plan.variant.encodedPayloadProof).length === 0
      || Object.values(plan.variant.encodedPayloadProof).some(item => item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.beforeSha256)
        || item.beforeSha256 !== item.afterSha256)) failures.add('fixture-payload-proof');
  const targetSamples = observed.samples.filter(sample => sample.wallMs >= targetFromMs);
  const oldExpected = { ...plan.expected, outputKind: /** @type {const} */ ('video'), audioHz: 440 };
  const newExpected = { ...oldExpected, audioHz: adopted && program ? 880 : 440 };
  for (const reason of assessAudioSwitchOutput(baseline.samples, oldExpected).failures) failures.add(`baseline-${reason}`);
  for (const reason of assessAudioSwitchOutput(targetSamples, newExpected).failures) failures.add(`output-${reason}`);
  if (assessAudioSwitchOutput(targetSamples, { ...newExpected, audioHz: newExpected.audioHz === 440 ? 880 : 440 })
      .failures.join(',') !== 'audio-identity') failures.add('pcm-negative-control');
  for (const reason of assessProgramSwitchSession(observed).failures) failures.add(`session-${reason}`);
  if (observed.startupError || baseline.startupError) failures.add('startup-error');
  for (const capture of [baseline, observed]) {
    if (capture.transportState.length !== 1 || capture.transportState[0]?.url !== plan.relayUrl
        || capture.transportState[0]?.closedAtMs !== null) failures.add('transport-owner');
    if (!capture.nativeMse || capture.nativeMse.buffers.length !== 2
        || capture.nativeMse.buffers.filter(item => item.mime.startsWith('video/')).length !== 1
        || capture.nativeMse.buffers.filter(item => item.mime.startsWith('audio/')).length !== 1
        || capture.nativeMse.buffers.some(item => !Number.isFinite(item.offset))) failures.add('native-buffer-owner');
    if (capture.mseProgram.sources !== 1 || capture.mseProgram.overflow || capture.mseProgram.failures.length) failures.add('native-source-evidence');
  }
  if (JSON.stringify(baseline.nativeMse?.buffers) !== JSON.stringify(observed.nativeMse?.buffers)
      || observed.nativeMse?.calls.length !== baseline.nativeMse?.calls.length) failures.add('native-buffer-replaced-or-retyped');
  for (const reason of wireFailures(observed.programWire, plan)) failures.add(reason);
  const initialWire = baseline.programWire?.subscriptions ?? [];
  if (baseline.programWire?.connections !== 1 || baseline.programWire.overflow || initialWire.length !== 3
      || new Set(initialWire.map(item => item.requestId)).size !== 3
      || ['catalog', tracks.oldVideo.name, tracks.oldAudio.name].some(name => initialWire.filter(item => item.name === name
        && item.namespace.length === 1 && item.namespace[0] === plan.namespace).length !== 1)
      || initialWire.some(record => !observed.programWire?.subscriptions.some(item =>
    item.requestId === record.requestId && item.name === record.name && JSON.stringify(item.namespace) === JSON.stringify(record.namespace)))) failures.add('wire-owner-changed');
  if (observed.programWire?.subscriptions.some(record => !initialWire.some(old => old.requestId === record.requestId)
      && record.timeMs < requestedAtMs)) failures.add('stale-wire-target');
  const changes = observed.events.filter(event => ['programchange', 'viewchange'].includes(event.type) && event.timeMs >= requestedAtMs);
  const refused = observed.events.filter(event => event.type === (program ? 'programchangefailed' : 'viewchangefailed') && event.timeMs >= requestedAtMs);
  const failedChanges = observed.events.filter(event => ['programchangefailed', 'viewchangefailed', 'audiochangefailed'].includes(event.type)
    && event.timeMs >= requestedAtMs);
  /** @param {unknown} data @param {string} field */
  const field = (data, field) => typeof data === 'object' && data !== null ? Reflect.get(data, field) : undefined;
  const eventIdentity = adopted ? field(field(changes[0]?.data, program ? 'program' : 'view'), 'id')
    : field(refused[0]?.data, program ? 'programId' : 'viewId');
  const expectedProgram = program ? timeline.id : initial.media.currentProgram;
  const expectedView = program ? after.media.views.find(item => item.levels.some(level => level.trackName === targetVideo.name))?.id : timeline.id;
  const correctChanges = program
    ? changes.length === 2 && changes[0]?.type === 'programchange' && changes[1]?.type === 'viewchange'
    : changes.length === 1 && changes[0]?.type === 'viewchange';
  if (adopted ? after.media.currentProgram !== expectedProgram || after.media.currentView !== expectedView
      || !correctChanges || refused.length !== 0 || result.refusal !== null
    : after.media.currentProgram !== before.media.currentProgram || after.media.currentView !== before.media.currentView
      || after.media.currentAudioTrackId !== before.media.currentAudioTrackId || changes.length !== 0 || refused.length !== 1
      || !result.refusal?.includes('MSE acceptance injected queue acquisition refusal')) failures.add('selection-outcome');
  if (eventIdentity !== timeline.id || failedChanges.length !== (adopted ? 0 : 1)) failures.add('selection-event-identity');
  if (adopted && program && field(field(changes[1]?.data, 'view'), 'id') !== expectedView) failures.add('selection-event-identity');
  if (after.selection.levels.length !== 1 || after.selection.levels[0]?.trackName !== (adopted ? targetVideo.name : tracks.oldVideo.name)
      || after.selection.audioTracks[after.selection.currentAudioTrack]?.trackName !== (adopted ? targetAudio.name : tracks.oldAudio.name)
      || !program && after.media.currentAudioTrackId !== before.media.currentAudioTrackId) failures.add('adopted-track-identity');
  const queueRefusals = observed.mseProgram.queues.filter(item => item.kind === 'refused' && item.timeMs >= requestedAtMs);
  if (adopted ? queueRefusals.length !== 0 : queueRefusals.length !== 1) failures.add('queue-refusal-not-exercised');
  const key = /** @param {string} name */ name => JSON.stringify([[plan.namespace], name]);
  const segments = observed.mseProgram.segments;
  const reference = [...baseline.mseProgram.segments].reverse().find(item => item.mediaType === 'audio'
    && item.sourceKey === key(tracks.oldAudio.name) && item.state === 'appended');
  const referencePlacement = reference && placement(reference);
  if (!referencePlacement) failures.add('canonical-native-placement');
  const referenceUntil = observed.mseProgram.queues[0]?.timeMs ?? targetFromMs;
  if (!/^\d+$/.test(timeline.observedSourceTimeUs) || !segments.some(item => {
    const p = placement(item);
    return item.mediaType === 'audio' && item.sourceKey === key(tracks.oldAudio.name) && p
      && item.submittedAtMs !== null && item.submittedAtMs <= referenceUntil
      && p.raw * 1_000_000n / p.scale === BigInt(timeline.observedSourceTimeUs);
  })) failures.add('canonical-reference-without-raw-bytes');
  const expectedNames = adopted ? [targetVideo.name, targetAudio.name] : [tracks.oldVideo.name, tracks.oldAudio.name];
  for (const type of /** @type {const} */ (['video', 'audio'])) {
    const name = type === 'video' ? expectedNames[0] : expectedNames[1];
    if (name === undefined) { failures.add('missing-output-identity'); continue; }
    const placed = segments.filter(item => item.mediaType === type && item.sourceKey === key(name)
      && item.trackName === name && item.state === 'appended');
    if (!placed.length) failures.add('missing-native-target-append');
    const anchor = adopted ? (program ? plan.variant.maps.program[type] : type === 'video' ? plan.variant.maps.view.video : null) : null;
    for (const segment of placed) {
      const actual = placement(segment);
      if (!actual || segment.completedAtMs === null || segment.submittedAtMs === null) { failures.add('unavailable-native-placement'); continue; }
      if (anchor && referencePlacement && segment.submittedAtMs >= requestedAtMs) {
        const deltaN = actual.raw * referencePlacement.scale * 1_000_000n
          - referencePlacement.raw * actual.scale * 1_000_000n
          + (BigInt(anchor.referenceTimeUs) - BigInt(anchor.sourceTimeUs)) * actual.scale * referencePlacement.scale;
        const expectedStart = referencePlacement.startS + Number(deltaN) / Number(actual.scale * referencePlacement.scale * 1_000_000n);
        if (!Number.isFinite(expectedStart) || Math.abs(actual.startS - expectedStart) > 1 / Number(actual.scale) + 1e-6) failures.add('application-map-placement');
      }
    }
    if (type === 'video') for (const sample of targetSamples) {
      const frameAt = sample.nativeFrameAtMs;
      if (typeof frameAt !== 'number' || !Number.isFinite(frameAt)) { failures.add('stale-or-fake-native-frame'); continue; }
      if (frameAt <= requestedAtMs
          || sample.wallMs - frameAt < 0 || sample.wallMs - frameAt > 1000
          || Math.abs(sample.mediaTimeS - sample.presentedMediaTimeS) > 0.25) failures.add('stale-or-fake-native-frame');
      if (!placed.some(segment => {
        const p = placement(segment);
        return p && segment.completedAtMs !== null && segment.completedAtMs <= frameAt
          && p.startS - 1e-6 <= sample.presentedMediaTimeS && sample.presentedMediaTimeS < p.endS + 1e-6;
      })) failures.add('native-frame-without-target-append');
    }
  }
  const targets = new Set([key(targetVideo.name), ...(program ? [key(targetAudio.name)] : [])]);
  if (!adopted && segments.some(item => targets.has(item.sourceKey ?? '') && item.submittedAtMs !== null)) failures.add('refusal-submitted-target');
  if (adopted) {
    const firstTarget = segments.find(item => targets.has(item.sourceKey ?? '') && item.submittedAtMs !== null);
    const firstAt = firstTarget?.submittedAtMs;
    if (typeof firstAt !== 'number' || firstAt < requestedAtMs || segments.some(item => item.submittedAtMs !== null
        && item.submittedAtMs > firstAt && item.sourceKey === key(tracks.oldVideo.name))) failures.add('old-video-after-target');
  }
  return { passed: failures.size === 0, failures: [...failures].sort() };
}

/** @param {import('playwright').Page} page @param {import('./mse-program-switch.mjs').MseProgramSwitchEvidence} evidence
 * @param {<T>(promise: Promise<T>, ms: number, label: string) => Promise<T>} bounded
 * @param {import('./mse-program-switch.mjs').MseProgramSwitchPlan} plan */
export async function checkMseProgramSwitch(page, evidence, bounded, plan) {
  evidence.nativeExecuted = false; evidence.mode = plan.mode; evidence.outcome = plan.outcome;
  evidence.assessment = { passed: false, failures: ['native-execution-incomplete'] };
  const read = () => bounded(page.evaluate(() => ({ timeMs: performance.now(), media: window.playerAcceptance.mediaSelection,
    selection: window.playerAcceptance.selection, sample: window.playerAcceptance.latestSample })), 5000, 'MSE selection/output');
  const capture = () => bounded(page.evaluate(() => {
    const state = /** @type {Window['playerAcceptance'] & import('./mse-program-switch-observer.mjs').MseProgramPageHooks} */ (window.playerAcceptance);
    return { ...state.snapshot(), mseProgram: state.mseProgramSnapshot() };
  }), 5000, 'native MSE byte/queue snapshot');
  evidence.initial = await read();
  await bounded(page.evaluate(() => window.playerAcceptance.begin(false)), 5000, 'begin old native MSE window');
  await bounded(page.waitForTimeout(5750), 7000, 'old native video/PCM window');
  evidence.baseline = await capture(); evidence.before = await read();
  assert.deepEqual(assessAudioSwitchOutput(evidence.baseline.samples, { ...plan.expected, outputKind: 'video', audioHz: 440 }).failures, [], 'Old native output must be healthy');
  if (plan.outcome === 'queue-refusal') await bounded(page.evaluate(() => {
    const state = /** @type {Window['playerAcceptance'] & import('./mse-program-switch-observer.mjs').MseProgramPageHooks} */ (window.playerAcceptance);
    state.armMseQueueRefusal();
  }), 5000, 'arm one queue acquisition refusal');
  evidence.requestedAtMs = await bounded(page.evaluate(() => performance.now()), 5000, 'mapped MSE request time');
  // The page's existing public helpers keep the canonical opaque token in its
  // realm. For a refusal retain the descriptive reference before calling them.
  const response = await bounded(page.evaluate(({ mode, variant }) => {
    const state = /** @type {Window['playerAcceptance'] & import('./mse-program-switch-observer.mjs').MseProgramPageHooks} */ (window.playerAcceptance);
    return state.selectMseMapped(mode, variant);
  }, { mode: plan.mode, variant: plan.variant }), 15000, 'public mapped native MSE selection');
  evidence.refusal = response.refusal;
  if (!response.timeline) throw new Error(`Mapped MSE selection did not return its canonical reference receipt: ${response.refusal}`);
  evidence.timeline = response.timeline;
  const beforeFrames = evidence.before.sample?.presentedFrames;
  assert.ok(typeof beforeFrames === 'number', 'Missing real pre-switch rVFC output');
  await bounded(page.waitForFunction(({ requestedAtMs, frames, hz }) => {
    const sample = window.playerAcceptance.latestSample;
    return sample !== undefined && sample.outputKind === 'video' && sample.presentedFrames >= frames + 8
      && typeof sample.nativeFrameAtMs === 'number' && sample.nativeFrameAtMs > requestedAtMs && sample.wallMs > requestedAtMs && sample.pictureChange > 1
      && sample.nativeFrameWidth === 640 && sample.nativeFrameHeight === 360 && sample.audioRms > 0.015
      && Math.abs(sample.audioPeakHz - hz) <= 35;
  }, { requestedAtMs: evidence.requestedAtMs, frames: beforeFrames,
    hz: plan.outcome === 'adopt' && plan.mode === 'program' ? 880 : 440 }, { polling: 100, timeout: 15000 }), 17000, 'fresh native MSE output');
  evidence.targetFromMs = await bounded(page.evaluate(() => performance.now()), 5000, 'native target window start');
  evidence.readinessAfterMs = evidence.targetFromMs - evidence.requestedAtMs;
  await bounded(page.waitForTimeout(5750), 7000, 'continuing native MSE video/PCM window');
  await bounded(page.evaluate(() => window.playerAcceptance.finish()), 5000, 'finish native MSE window');
  evidence.observed = await capture(); evidence.after = await read();
  evidence.assessment = assessMseProgramSwitch(/** @type {import('./mse-program-switch.mjs').MseProgramSwitchObservation} */ (evidence), plan);
  evidence.nativeExecuted = true;
  assert.deepEqual(evidence.assessment.failures, [], 'Native MSE program/view output and exact owner evidence');
  return evidence.observed;
}
