import assert from 'node:assert/strict';
import { assessPlayback } from './assessment.mjs';

const sizes = [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 640, height: 360 }];
const expected = { videoWidth: 1920, videoHeight: 1080, videoSizes: sizes, audioHz: 440, videoFps: 24 };

export function assessSwitchContinuity(observed) {
  const { samples } = observed;
  const failures = new Set(assessPlayback(samples, expected).failures);
  if (observed.nativeError || observed.nativeEvents.length) failures.add('native-media-event');
  if (observed.events.some(event => event.type === 'error'
    || (event.type === 'stall' && event.timeMs >= samples[0]?.wallMs))) failures.add('player-error-or-stall');
  for (const [i, sample] of samples.entries()) {
    if (sample.nativeFrameWidth !== sample.videoWidth || sample.nativeFrameHeight !== sample.videoHeight
      || !Number.isFinite(sample.nativeFrameAtMs) || sample.wallMs - sample.nativeFrameAtMs < 0
      || sample.wallMs - sample.nativeFrameAtMs > 1000) failures.add('native-frame-identity');
    if (sample.bufferedRanges?.length !== 1) failures.add('split-buffer');
    if (!Number.isFinite(sample.audioContextTimeS)) failures.add('audio-clock');
    const previous = samples[i - 1];
    if (!previous) continue;
    if (sample.mediaTimeS < previous.mediaTimeS - 0.05
      || sample.presentedMediaTimeS < previous.presentedMediaTimeS - 0.05) failures.add('timeline-rewind');
    if (sample.bufferedRanges?.[0]?.end < previous.bufferedRanges?.[0]?.end - 0.05) failures.add('buffer-regression');
    const wallSeconds = (sample.wallMs - previous.wallMs) / 1000;
    if (sample.mediaTimeS - previous.mediaTimeS > wallSeconds + 0.5) failures.add('timeline-jump');
  }
  const first = samples[0], last = samples.at(-1);
  if (first && last) {
    const wallSeconds = (last.wallMs - first.wallMs) / 1000;
    if (Math.abs(last.mediaTimeS - first.mediaTimeS - wallSeconds) > 0.75) failures.add('timeline-drift');
    if (last.audioContextTimeS - first.audioContextTimeS < wallSeconds * 0.8) failures.add('audio-clock');
    if (!(last.bufferedRanges?.[0]?.end > first.bufferedRanges?.[0]?.end)) failures.add('buffer-not-extending');
  }
  return { passed: failures.size === 0, failures: [...failures], samples: samples.length };
}

export function assessNativeRetypes(observed, retypes, baselineOffsets) {
  const failures = new Set();
  const native = observed.nativeMse;
  const mimes = native?.calls.map(call => call.mime) ?? [];
  const expectedMimes = retypes ? ['video/mp4; codecs="avc1.42c01e"', 'video/mp4; codecs="avc1.42c028"'] : [];
  if (!native || JSON.stringify(mimes) !== JSON.stringify(expectedMimes)) failures.add('native-retype-calls');
  const video = native?.buffers.filter(buffer => buffer.mime.startsWith('video/')) ?? [];
  const audio = native?.buffers.filter(buffer => buffer.mime.startsWith('audio/')) ?? [];
  if (video.length !== 1 || audio.length !== 1 || native.buffers.length !== 2) failures.add('native-buffer-identity');
  if (native?.calls.some(call => call.bufferId !== video[0]?.id || call.error !== null)) failures.add('native-retype-result');
  if (!native || baselineOffsets.length !== 2 || baselineOffsets.some(offset => !Number.isFinite(offset))
    || native.buffers.some(buffer => buffer.offset !== baselineOffsets[buffer.id])
    || native.calls.some(call => call.offsetBefore !== baselineOffsets[call.bufferId] || call.offsetAfter !== baselineOffsets[call.bufferId])
    || !observed.samples.length || observed.samples.some(sample => sample.nativeTimestampOffsets?.length !== 2
      || sample.nativeTimestampOffsets.some((offset, i) => offset !== baselineOffsets[i]))) failures.add('native-offset-changed');
  return { passed: failures.size === 0, failures: [...failures], mimes, expectedMimes, baselineOffsets };
}

export async function checkRenditionSwitch(page, evidence, bounded, nativeRetypes = false) {
  const selection = () => page.evaluate(() => window.playerAcceptance.selection);
  const initial = await selection();
  evidence.initialSelection = initial;
  evidence.transitions = [];
  evidence.windows = [];
  assert.deepEqual(initial.levels.map(level => level.trackName), ['video-1080', 'video-720', 'video-360']);
  const codecs = ['avc1.42c028', 'avc1.42c028', nativeRetypes ? 'avc1.42c01e' : 'avc1.42c028'];
  assert.deepEqual(initial.levels.map(level => level.codec), codecs);
  assert.equal(initial.autoQuality, false, 'Manual case must start with ABR disabled');
  const audioTrack = initial.currentAudioTrack;
  assert.equal(initial.audioTracks[audioTrack]?.language, 'en');
  evidence.nativeOffsetBaseline = await page.evaluate(() => window.playerAcceptance.snapshot().nativeMse.buffers);
  const baselineOffsets = evidence.nativeOffsetBaseline.map(buffer => buffer.offset);
  assert.deepEqual(baselineOffsets, [0, 0], 'Expected the running player to place this fixture at zero');
  await page.evaluate(() => window.playerAcceptance.begin(false));

  const observeWindow = async (level, fromMs) => {
    await page.waitForTimeout(5750);
    const observed = await page.evaluate(() => window.playerAcceptance.snapshot());
    const samples = observed.samples.filter(sample => sample.wallMs >= fromMs);
    const size = sizes[level];
    const assessment = assessPlayback(samples, { videoWidth: size.width, videoHeight: size.height, audioHz: 440, videoFps: 24 });
    evidence.windows.push({ level, fromMs, untilMs: samples.at(-1)?.wallMs,
      first: samples[0], last: samples.at(-1), assessment });
    assert.deepEqual(assessment.failures, [], `Level ${level} did not sustain its decoded dimensions and output`);
    const state = await selection();
    assert.equal(state.currentAudioTrack, audioTrack, 'Manual video switch changed the audio selection');
    assert.equal(state.autoQuality, false, 'Manual selection enabled ABR');
    return observed;
  };
  await page.waitForFunction(() => window.playerAcceptance.latestSample?.nativeFrameWidth === 1920, null, { timeout: 10000 });
  await observeWindow(0, await page.evaluate(() => window.playerAcceptance.latestSample.wallMs));

  let previousCodec = codecs[0];
  for (const level of [1, 2, 1, 0]) {
    const before = await page.evaluate(() => ({ timeMs: performance.now(), sample: window.playerAcceptance.latestSample,
      nativeCalls: window.playerAcceptance.snapshot().nativeMse.calls.length }));
    const transition = { level, requestedAtMs: before.timeMs, before: before.sample };
    evidence.transitions.push(transition);
    await bounded(page.evaluate(level => window.playerAcceptance.setQuality(level), level), 15000, `setQuality(${level})`);
    await page.waitForFunction(({ level, size, before }) => {
      const state = window.playerAcceptance;
      const sample = state.latestSample;
      return state.selection.currentLevel === level && sample?.videoWidth === size.width && sample.videoHeight === size.height
        && sample.nativeFrameWidth === size.width && sample.nativeFrameHeight === size.height
        && sample.presentedFrames >= before.presentedFrames + 8 && sample.mediaTimeS > before.mediaTimeS + 0.2
        && sample.nativeFrameAtMs > before.wallMs && sample.audioRms > 0.015;
    }, { level, size: sizes[level], before: before.sample }, { timeout: 15000 });
    const settled = await page.evaluate(() => window.playerAcceptance.latestSample);
    transition.settled = settled;
    transition.committedSelection = await selection();
    const after = await observeWindow(level, settled.wallMs);
    transition.nativeCalls = after.nativeMse.calls.slice(before.nativeCalls);
    assert.deepEqual(transition.nativeCalls.map(call => call.mime), previousCodec === codecs[level]
      ? [] : [`video/mp4; codecs="${codecs[level]}"`], `Unexpected native retype for level ${level}`);
    previousCodec = codecs[level];
  }
  const observed = await page.evaluate(() => window.playerAcceptance.finish());
  evidence.continuity = assessSwitchContinuity(observed);
  evidence.nativeRetypes = assessNativeRetypes(observed, nativeRetypes, baselineOffsets);
  assert.deepEqual(evidence.continuity.failures, [], 'Native output failed across manual switches');
  assert.deepEqual(evidence.nativeRetypes.failures, [], 'Native retype/offset evidence failed');
  return observed;
}
