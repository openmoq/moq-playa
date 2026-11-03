// @ts-check
import assert from 'node:assert/strict';
import { assessPlayback } from './assessment.mjs';
import { assessVideoPresentation } from './presentation.mjs';

const defaultEnglish = { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24 };

/**
 * @param {readonly import('./assessment.mjs').PlaybackSample[]} samples
 * @param {import('./assessment.mjs').ExpectedPlayback} expected
 */
export function assessAudioSwitchOutput(samples, expected) {
  const assessment = assessPlayback(samples, expected);
  const failures = new Set(assessment.failures);
  if ((expected.outputKind ?? 'video') === 'video') {
    if (samples.some(sample => sample.nativeFrameWidth !== 640 || sample.nativeFrameHeight !== 360)) {
      failures.add('native-video-identity');
    }
  } else {
    for (const failure of assessVideoPresentation(samples)) failures.add(`canvas-${failure}`);
  }
  return { ...assessment, passed: failures.size === 0, failures: [...failures] };
}

/**
 * @param {ReturnType<Window['playerAcceptance']['snapshot']>} observed
 * @param {Window['playerAcceptance']['selection']} initial
 * @param {import('./audio-switch.mjs').AudioSwitchEvidence} evidence
 * @param {boolean} identityChanges
 * @param {import('./assessment.mjs').ExpectedPlayback} expected
 */
function continuity(observed, initial, evidence, identityChanges, expected) {
  const failures = new Set(assessAudioSwitchOutput(observed.samples, expected).failures
    .filter(failure => !identityChanges || failure !== 'audio-identity'));
  if (observed.nativeError || observed.nativeEvents.some(event => event.type === 'error' || event.type === 'stalled')) {
    failures.add('native-media-event');
  }
  if (observed.transportState.length !== 1 || observed.transportState.some(transport => transport.closedAtMs !== null)) {
    failures.add('transport-replaced-or-closed');
  }
  if (observed.events.some(event => event.type === 'error'
    || event.type === 'stall' && event.timeMs >= (observed.samples[0]?.wallMs ?? Infinity))) failures.add('player-error-or-stall');
  for (const point of [evidence.before, evidence.afterSetter, evidence.afterReadiness, evidence.after]) {
    if (point && (point.selection.currentLevel !== initial.currentLevel || point.selection.autoQuality !== initial.autoQuality)) {
      failures.add('video-selection-changed');
    }
  }
  return { passed: failures.size === 0, failures: [...failures], samples: observed.samples.length };
}

/**
 * Native-output arm: the page calls only the public facade setter.
 * @param {import('playwright').Page} page
 * @param {import('./audio-switch.mjs').AudioSwitchEvidence} evidence
 * @param {<T>(promise: Promise<T>, ms: number, label: string) => Promise<T>} bounded
 * @param {import('./audio-switch.mjs').AudioSwitchPlan} [plan]
 */
export async function checkAudioLanguageSwitch(page, evidence, bounded, plan = { mode: 'same-set' }) {
  const english = { ...defaultEnglish, ...plan.expected, audioHz: 440 };
  const spanish = { ...english, audioHz: 880 };
  const outputKind = english.outputKind ?? 'video';
  evidence.mode = plan.mode;
  const read = () => bounded(page.evaluate(() => ({ timeMs: performance.now(),
    selection: window.playerAcceptance.selection, sample: window.playerAcceptance.latestSample,
  })), 5000, 'audio selection/output snapshot');
  evidence.initial = await read();
  const initial = evidence.initial.selection;
  assert.deepEqual(initial.audioTracks.map(track => track.language), ['en', 'es']);
  assert.equal(initial.audioTracks[initial.currentAudioTrack]?.language, 'en', 'Catalog default must start in English');
  const target = initial.audioTracks.findIndex(track => track.language === 'es');
  assert.ok(target >= 0 && target !== initial.currentAudioTrack, 'Missing distinct Spanish target');
  evidence.requestedIndex = target;
  const targetId = initial.audioTracks[target]?.id;
  assert.ok(typeof targetId === 'string' && targetId.length > 0, 'Spanish target needs its public stable id');
  evidence.requestedId = targetId;

  await bounded(page.evaluate(() => window.playerAcceptance.begin(false)), 5000, 'begin English output window');
  await bounded(page.waitForTimeout(5750), 7000, 'English output window');
  const baseline = await bounded(page.evaluate(() => window.playerAcceptance.snapshot()), 5000, 'English output snapshot');
  evidence.before = await read();
  evidence.english = assessAudioSwitchOutput(baseline.samples, english);
  evidence.englishSpanishControl = assessAudioSwitchOutput(baseline.samples, spanish);
  assert.deepEqual(evidence.english.failures, [], 'English startup must produce moving 360p video and real 440Hz PCM');
  assert.deepEqual(evidence.englishSpanishControl.failures, ['audio-identity'], 'English startup must reject the Spanish signal identity');
  const beforeSample = evidence.before.sample;
  assert.ok(beforeSample, 'Missing measured English output sample');

  evidence.requestedAtMs = await bounded(page.evaluate(() => performance.now()), 5000, 'audio request timestamp');
  if (plan.mode === 'unmapped-refusal') {
    try {
      await bounded(page.evaluate(id => window.playerAcceptance.selectAudioTrack(id), targetId), 15000, 'unmapped audio selection');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      evidence.refusalError = error.message;
    }
    evidence.afterSetter = await read();
    const fromMs = evidence.afterSetter.timeMs;
    await bounded(page.waitForTimeout(5750), 7000, 'continuing English output window');
    const observed = await bounded(page.evaluate(() => window.playerAcceptance.finish()), 5000, 'finish unmapped audio control');
    evidence.after = await read();
    const targetSamples = observed.samples.filter(sample => sample.wallMs >= fromMs);
    evidence.englishAfter = assessAudioSwitchOutput(targetSamples, english);
    evidence.spanish = assessAudioSwitchOutput(targetSamples, spanish);
    evidence.spanishEnglishControl = evidence.englishAfter;
    evidence.continuity = continuity(observed, initial, evidence, false, english);
    evidence.targetWindow = { fromMs, untilMs: evidence.after.timeMs, samples: targetSamples.length,
      first: targetSamples[0], last: targetSamples.at(-1) };
    evidence.failureEventCount = observed.events.filter(event => event.type === 'audiochangefailed' && event.timeMs >= (evidence.requestedAtMs ?? Infinity)
      && typeof event.data === 'object' && event.data !== null && 'trackId' in event.data && event.data.trackId === targetId).length;
    const failures = new Set(evidence.continuity.failures);
    if (!/timeline|mapping|relationship/i.test(evidence.refusalError ?? '')) failures.add('unmapped-selection-not-refused');
    if (evidence.failureEventCount !== 1) failures.add('missing-audio-refusal-event');
    if (evidence.after.selection.currentAudioTrackId !== initial.currentAudioTrackId
      || evidence.after.selection.currentAudioTrack !== initial.currentAudioTrack) failures.add('refusal-changed-selection');
    if (evidence.englishAfter.failures.length || evidence.spanish.failures.join(',') !== 'audio-identity') failures.add('refusal-output-identity');
    evidence.assessment = { passed: failures.size === 0, failures: [...failures] };
    assert.match(evidence.refusalError ?? '', /timeline|mapping|relationship/i, 'Unrelated audio sets must be refused for lack of an explicit time relationship');
    assert.equal(evidence.failureEventCount, 1, 'The public refusal event must identify the requested Spanish track');
    assert.equal(evidence.after.selection.currentAudioTrackId, initial.currentAudioTrackId, 'Refusal changed the adopted identity');
    assert.equal(evidence.after.selection.currentAudioTrack, initial.currentAudioTrack, 'Refusal changed the public index');
    assert.deepEqual(evidence.englishAfter.failures, [], 'Unmapped refusal must preserve real English PCM and video');
    assert.deepEqual(evidence.spanish.failures, ['audio-identity'], 'Unmapped refusal must not be mistaken for a Spanish switch');
    assert.deepEqual(evidence.continuity.failures, [], 'Unmapped refusal must preserve native playback continuity');
    return observed;
  }
  if (plan.mode === 'reference-map') {
    assert.ok(typeof plan.sourceTimeUs === 'string' && typeof plan.referenceTimeUs === 'string', 'Missing application raw-domain map anchors');
    evidence.timeline = await bounded(page.evaluate(({ id, source, reference }) =>
      window.playerAcceptance.selectAudioTrackMapped(id, source, reference),
    { id: targetId, source: plan.sourceTimeUs, reference: plan.referenceTimeUs }), 15000, 'mapped audio selection');
  } else if (plan.mode === 'live-resync') {
    await bounded(page.evaluate(id => window.playerAcceptance.selectAudioTrack(id, { timeline: { kind: 'live-resync' } }), targetId),
      15000, 'explicit live audio resync');
  } else {
    // The compatibility index setter gets no implicit resync policy.
    await bounded(page.evaluate(index => window.playerAcceptance.setAudioTrack(index), target), 15000, `setAudioTrack(${target})`);
  }
  evidence.afterSetter = await read();
  evidence.settleTimedOut = false;
  try {
    await page.waitForFunction(({ index, requestedAtMs, frames, outputKind }) => {
      const state = window.playerAcceptance, sample = state.latestSample;
      return sample !== undefined && state.selection.currentAudioTrack === index && sample.wallMs > requestedAtMs
        && sample.audioRms > 0.015 && Math.abs(sample.audioPeakHz - 880) <= 35
        && sample.presentedFrames >= frames + 8 && sample.videoWidth === 640 && sample.videoHeight === 360
        && sample.outputKind === outputKind
        && (outputKind === 'video' ? sample.nativeFrameWidth === 640 && sample.nativeFrameHeight === 360
          : Number.isSafeInteger(sample.nativeDrawTimestampUs) && Number.isFinite(sample.nativeDrawTimeMs)
            && typeof sample.nativeDrawTimeMs === 'number' && sample.nativeDrawTimeMs > requestedAtMs
            && sample.videoPresentation?.frameTimestampUs === String(sample.nativeDrawTimestampUs));
    }, { index: target, requestedAtMs: evidence.requestedAtMs, frames: beforeSample.presentedFrames, outputKind },
    { timeout: 15000, polling: 100 });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    // Preserve actual output on failure. The index-only stub must fail the PCM
    // assertion below, rather than merely failing this readiness poll.
    evidence.settleTimedOut = true;
    evidence.settleError = error.message;
  }
  evidence.afterReadiness = await read();
  evidence.settledAfterMs = evidence.afterReadiness.timeMs - evidence.requestedAtMs;
  const fromMs = evidence.afterReadiness.timeMs;
  await bounded(page.waitForTimeout(5750), 7000, 'Spanish output window');
  let observed = await bounded(page.evaluate(keepRecording => keepRecording
    ? window.playerAcceptance.snapshot() : window.playerAcceptance.finish(), plan.mode === 'same-set'), 5000, 'retain Spanish output window');
  evidence.after = await read();
  const targetSamples = observed.samples.filter(sample => sample.wallMs >= fromMs);
  evidence.spanish = assessAudioSwitchOutput(targetSamples, spanish);
  evidence.spanishEnglishControl = assessAudioSwitchOutput(targetSamples, english);
  evidence.targetWindow = { fromMs, untilMs: evidence.after.timeMs, samples: targetSamples.length,
    first: targetSamples[0], last: targetSamples.at(-1) };

  // Audio identity legitimately changes during the combined window; both
  // identities are checked on real, separate output windows above. Preserve
  // all other existing playback checks across the complete transition.
  evidence.continuity = continuity(observed, initial, evidence, true, english);
  const failures = new Set([...evidence.spanish.failures, ...evidence.continuity.failures]);
  if (evidence.settleTimedOut) failures.add('audio-switch-readiness-timeout');
  if (evidence.after.selection.currentAudioTrack !== target) failures.add('audio-selection-index');
  if (evidence.after.selection.currentAudioTrackId !== targetId) failures.add('audio-selection-identity');
  if (evidence.spanishEnglishControl.failures.join(',') !== 'audio-identity') failures.add('audio-switch-negative-control');
  evidence.assessment = { passed: failures.size === 0, failures: [...failures] };
  assert.deepEqual(evidence.spanish.failures, [], 'Spanish selection must produce real 880Hz PCM with continuing video');
  assert.deepEqual(evidence.spanishEnglishControl.failures, ['audio-identity'], 'Spanish output must reject the prior English signal identity');
  assert.equal(evidence.settleTimedOut, false, 'Spanish native output did not settle within 15s');
  assert.equal(evidence.after.selection.currentAudioTrack, target, 'Spanish native output must match the public selected index');
  assert.equal(evidence.after.selection.currentAudioTrackId, targetId, 'Spanish native output must match the public selected identity');
  assert.deepEqual(evidence.continuity.failures, [], 'Native playback must continue across the audio switch');

  if (plan.mode === 'same-set') {
    /** @type {import('./audio-switch.mjs').AudioSwitchEvidence} */
    const reverse = { mode: 'same-set', assessment: { passed: false, failures: ['reverse-audio-switch-incomplete'] } };
    evidence.forwardAssessment = evidence.assessment;
    evidence.assessment = { passed: false, failures: ['reverse-audio-switch-incomplete'] };
    evidence.reverse = reverse;
    reverse.before = await read();
    reverse.requestedIndex = initial.currentAudioTrack;
    const englishId = initial.currentAudioTrackId;
    assert.ok(typeof englishId === 'string' && englishId.length > 0, 'English reverse target needs its public stable id');
    reverse.requestedId = englishId;
    const beforeReverse = reverse.before.sample;
    assert.ok(beforeReverse, 'Missing measured Spanish output before reverse switch');
    reverse.requestedAtMs = await bounded(page.evaluate(() => performance.now()), 5000, 'reverse audio request timestamp');
    await bounded(page.evaluate(index => window.playerAcceptance.setAudioTrack(index), initial.currentAudioTrack),
      15000, `reverse setAudioTrack(${initial.currentAudioTrack})`);
    reverse.afterSetter = await read();
    reverse.settleTimedOut = false;
    try {
      await page.waitForFunction(({ index, requestedAtMs, frames, outputKind }) => {
        const state = window.playerAcceptance, sample = state.latestSample;
        return sample !== undefined && state.selection.currentAudioTrack === index && sample.wallMs > requestedAtMs
          && sample.audioRms > 0.015 && Math.abs(sample.audioPeakHz - 440) <= 35
          && sample.presentedFrames >= frames + 8 && sample.videoWidth === 640 && sample.videoHeight === 360
          && sample.outputKind === outputKind
          && (outputKind === 'video' ? sample.nativeFrameWidth === 640 && sample.nativeFrameHeight === 360
            : Number.isSafeInteger(sample.nativeDrawTimestampUs) && Number.isFinite(sample.nativeDrawTimeMs)
              && typeof sample.nativeDrawTimeMs === 'number' && sample.nativeDrawTimeMs > requestedAtMs
              && sample.videoPresentation?.frameTimestampUs === String(sample.nativeDrawTimestampUs));
      }, { index: initial.currentAudioTrack, requestedAtMs: reverse.requestedAtMs, frames: beforeReverse.presentedFrames, outputKind },
      { timeout: 15000, polling: 100 });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      reverse.settleTimedOut = true;
      reverse.settleError = error.message;
    }
    reverse.afterReadiness = await read();
    reverse.settledAfterMs = reverse.afterReadiness.timeMs - reverse.requestedAtMs;
    const reverseFromMs = reverse.afterReadiness.timeMs;
    await bounded(page.waitForTimeout(5750), 7000, 'reverse English output window');
    observed = await bounded(page.evaluate(() => window.playerAcceptance.finish()), 5000, 'finish complete audio round trip');
    reverse.after = await read();
    const reverseSamples = observed.samples.filter(sample => sample.wallMs >= reverseFromMs);
    reverse.english = assessAudioSwitchOutput(reverseSamples, english);
    reverse.englishSpanishControl = assessAudioSwitchOutput(reverseSamples, spanish);
    reverse.targetWindow = { fromMs: reverseFromMs, untilMs: reverse.after.timeMs, samples: reverseSamples.length,
      first: reverseSamples[0], last: reverseSamples.at(-1) };
    reverse.continuity = continuity(observed, initial, reverse, true, english);
    const reverseFailures = new Set([...reverse.english.failures, ...reverse.continuity.failures]);
    if (reverse.settleTimedOut) reverseFailures.add('reverse-audio-switch-readiness-timeout');
    if (reverse.after.selection.currentAudioTrack !== initial.currentAudioTrack) reverseFailures.add('reverse-audio-selection-index');
    if (reverse.after.selection.currentAudioTrackId !== englishId) reverseFailures.add('reverse-audio-selection-identity');
    if (reverse.englishSpanishControl.failures.join(',') !== 'audio-identity') reverseFailures.add('reverse-audio-negative-control');
    reverse.assessment = { passed: reverseFailures.size === 0, failures: [...reverseFailures] };
    evidence.sessionContinuity = continuity(observed, initial, evidence, true, english);
    const combinedFailures = new Set([...failures, ...reverseFailures, ...evidence.sessionContinuity.failures]);
    evidence.assessment = { passed: combinedFailures.size === 0, failures: [...combinedFailures] };
    assert.deepEqual(reverse.english.failures, [], 'Reverse selection must restore real 440Hz PCM with continuing video');
    assert.deepEqual(reverse.englishSpanishControl.failures, ['audio-identity'], 'Reverse output must reject the prior Spanish identity');
    assert.equal(reverse.settleTimedOut, false, 'English native output did not settle within 15s on reverse');
    assert.equal(reverse.after.selection.currentAudioTrack, initial.currentAudioTrack, 'Reverse native output must match the selected English index');
    assert.equal(reverse.after.selection.currentAudioTrackId, englishId, 'Reverse native output must match the selected English identity');
    assert.deepEqual(reverse.continuity.failures, [], 'Same player/session/video must continue through the reverse switch');
    assert.deepEqual(evidence.sessionContinuity.failures, [], 'Native playback must continue across the complete audio round trip');
  }
  return observed;
}
