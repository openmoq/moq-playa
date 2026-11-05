import assert from 'node:assert/strict';
import { assessPlayback } from './assessment.mjs';

export function tailPair(probe) {
  const target = probe.target, successor = probe.successor;
  if (!target || !successor || target.returnedAtMs === null) return {};
  const tailRows = probe.submissions.filter(row => row.mediaType === 'video' && row.inputs.includes(target.seq));
  const nextRows = probe.submissions.filter(row => row.mediaType === 'video' && row.inputs.includes(successor.seq));
  const tail = tailRows.length === 1 ? tailRows[0] : null;
  const next = nextRows.length === 1 ? nextRows[0] : undefined;
  return { tail, next,
    tailNative: probe.operations.find(row => row.seq === tail?.nativeOperation),
    nextNative: probe.operations.find(row => row.seq === next?.nativeOperation) };
}
export function assessTailDiagnostics(probe, checkpoint = 'observations-settled') {
  const failures = new Set();
  if (probe.errors.length) failures.add('probe-error');
  for (const name of ['overflow', 'missingReceipt', 'missingUnit', 'missingToken', 'changedInputs', 'duplicateTerminal']) {
    if (probe.losses[name] !== 0) failures.add(`probe-loss:${name}`);
  }
  const final = probe.diagnostics.findLast(row => row.checkpoint === checkpoint);
  if (!final) return { passed: false, failures: [...failures, 'missing-diagnostic-checkpoint'] };
  for (const row of probe.diagnostics.filter(row => row.seq <= final.seq)) {
    if (row.lifetime !== 'before-load-through-player-destroy' || row.destroyed !== false || !row.counters) {
      failures.add('diagnostic-runtime-unavailable'); continue;
    }
    for (const name of ['evidenceLossCount', 'unattributedInputCount', 'unobservableAppendCount',
      'unobservableVideoCount', 'unobservableAudioCount', 'refusedReconstructionCount', 'refusedVideoCount',
      'refusedAudioCount', 'inputAdmissionRefusalCount']) {
      if (row.counters[name] !== 0) failures.add(`diagnostic-counter:${name}`);
    }
  }
  return { passed: failures.size === 0, failures: [...failures] };
}
export function assessTailStimulus(probe) {
  const failures = new Set();
  const { target, successor } = probe;
  if (probe.errors.length) failures.add('probe-error');
  if (!target || !successor) return { passed: false, failures: [...failures, 'missing-boundary-witness'] };
  if (target.object !== '11' || successor.object !== '0' || target.alias !== successor.alias
    || target.connection !== successor.connection || BigInt(successor.group) !== BigInt(target.group) + 1n
    || target.stream === successor.stream) failures.add('wrong-boundary-identity');
  if (!target.raw || !/^[a-f0-9]{64}$/.test(target.raw.sha256 ?? '') || target.raw.duration === '0') failures.add('missing-tail-bytes');
  if (target.cancelled || !Number.isFinite(target.returnedAtMs)) failures.add('tail-not-returned');
  if (probe.mode === 'held') {
    const heldMs = target.returnedAtMs - target.heldAtMs;
    const exposedMs = target.returnedAtMs - successor.atMs;
    if (!(heldMs >= 1500 && heldMs < 2000) || target.releaseIssuedAtMs === null) failures.add('stimulus-deadline');
    if (!successor.whileHeld || !(successor.atMs >= target.heldAtMs) || !(exposedMs >= 500)) failures.add('no-successor-while-held');
    if (target.fin?.terminal !== 'fin' || target.fin.error !== null || !target.fin.whilePending
      || !(target.fin.atMs >= target.heldAtMs && target.fin.atMs < target.returnedAtMs)) failures.add('no-fin-while-transform-pending');
  }
  return { passed: failures.size === 0, failures: [...failures] };
}
export function assessTailRetention(probe, baseline, after, combinedRanges) {
  const stimulus = assessTailStimulus(probe), failures = new Set(stimulus.failures);
  const diagnostics = assessTailDiagnostics(probe);
  for (const failure of diagnostics.failures) failures.add(failure);
  if (!baseline.passed) failures.add('baseline-output');
  if (!after.passed) failures.add('post-tail-output');
  const pair = tailPair(probe);
  const nativeSuccess = (submission, native) => {
    const stage = probe.stages.find(row => row.seq === submission?.outcome?.stage);
    return Boolean(submission && native && submission.unit !== null && submission.outcome?.state === 'appended'
    && stage?.stage === 'appended' && stage.unit === submission.unit && stage.reason === null
    && stage.inputs.length === submission.inputs.length && stage.inputs.every((input, i) => input === submission.inputs[i])
    && native.submission === submission.seq && native.error === null && native.updateAtMs !== null
    && native.updateendAtMs !== null && native.updateAtMs >= native.atMs && native.updateendAtMs >= native.updateAtMs
    && /^[a-f0-9]{64}$/.test(submission.sha256 ?? '') && submission.sha256 === native.sha256);
  };
  if (!nativeSuccess(pair.tail, pair.tailNative)) failures.add('held-tail-native-completion');
  if (!nativeSuccess(pair.next, pair.nextNative)) failures.add('successor-native-completion');
  if (pair.tailNative && pair.nextNative && !(pair.tailNative.updateendAtMs <= pair.nextNative.atMs)) failures.add('successor-overtook-tail');
  if (probe.mode === 'held' && pair.nextNative && pair.nextNative.atMs < probe.target.returnedAtMs) failures.add('successor-before-release');
  if (pair.tail && pair.next && pair.nextNative) {
    const from = pair.tail.startSec + pair.nextNative.offset, until = pair.next.endSec + pair.nextNative.offset;
    const covers = ranges => Array.isArray(ranges) && ranges.length === 1 && ranges[0][0] <= from + 0.002 && ranges[0][1] >= until - 0.002;
    if (!covers(pair.nextNative.ranges)) failures.add('video-buffer-not-contiguous');
    if (!covers(combinedRanges)) failures.add('combined-buffer-not-contiguous');
  } else failures.add('missing-native-range-witness');
  const inputDiscards = probe.stages.filter(row => row.unit === null && row.stage === 'discarded' && row.reason === 'stale group'
    && row.inputs.length === 1 && row.inputs[0] === probe.target?.seq && row.atMs >= probe.target.returnedAtMs);
  const contradictoryTarget = inputDiscards.length > 0 && (probe.stages.some(row => row.unit !== null
    && row.inputs.includes(probe.target.seq) && ['reconstructed', 'appended'].includes(row.stage))
    || probe.submissions.some(row => row.inputs.includes(probe.target.seq)));
  if (contradictoryTarget) failures.add('contradictory-target-discard');
  const negativeOutputQualified = after.failures.every(failure => ['buffer-gap', 'picture-frozen', 'presentation-stalled',
    'playhead-stalled', 'audio-missing', 'presentation-rate', 'presentation-clock'].includes(failure));
  const causalLoss = probe.mode === 'held' && stimulus.passed && diagnostics.passed && baseline.passed && inputDiscards.length === 1
    && !contradictoryTarget && negativeOutputQualified && nativeSuccess(pair.next, pair.nextNative)
    && pair.nextNative.updateendAtMs < probe.target.returnedAtMs;
  return { passed: failures.size === 0, failures: [...failures], stimulus, diagnostics, causalLoss, inputDiscards, contradictoryTarget, negativeOutputQualified, pair };
}

/** Fixed bounded phases end on actual receipts/outcomes/samples, never on an evidence sleep. */
export async function checkGroupTail(page, evidence, mode) {
  const windowReady = () => page.waitForFunction(() => {
    const samples = window.playerAcceptance.snapshot().samples;
    return samples.length >= 22 && samples.at(-1).wallMs - samples[0].wallMs >= 5250;
  }, null, { polling: 100, timeout: 10000 });
  await page.evaluate(() => window.playerAcceptance.begin(false));
  await windowReady();
  await page.evaluate(() => window.playerAcceptance.settleTailObservations('baseline-settled'));
  const baseline = await page.evaluate(() => window.playerAcceptance.finish());
  evidence.baseline = assessPlayback(baseline.samples);
  evidence.baselineSamples = baseline.samples;
  evidence.baselineDiagnostics = assessTailDiagnostics(baseline.groupTail, 'baseline-settled');
  assert.deepEqual(evidence.baseline.failures, [], 'Healthy native picture/PCM prerequisite');
  assert.deepEqual(evidence.baselineDiagnostics.failures, [], 'Loss-free public diagnostics prerequisite');
  await page.evaluate(mode => { window.playerAcceptance.begin(false); window.playerAcceptance.armTail(mode); }, mode);
  await page.waitForFunction(() => {
    const probe = window.playerAcceptance.tailSnapshot;
    if (probe.errors.length) throw new Error(probe.errors.join('; '));
    return window.playerAcceptance.tailBoundarySettled;
  }, null, { polling: 50, timeout: 18000 });
  evidence.terminalAtMs = await page.evaluate(() => performance.now());
  await page.waitForFunction(fromMs => {
    const samples = window.playerAcceptance.snapshot().samples.filter(sample => sample.wallMs >= fromMs);
    return samples.length >= 22 && samples.at(-1).wallMs - samples[0].wallMs >= 5250;
  }, evidence.terminalAtMs, { polling: 100, timeout: 10000 });
  await page.evaluate(() => window.playerAcceptance.settleTailObservations('observations-settled'));
  const observed = await page.evaluate(() => window.playerAcceptance.finish());
  evidence.probe = observed.groupTail;
  evidence.postSamples = observed.samples.filter(sample => sample.wallMs >= evidence.terminalAtMs);
  evidence.after = assessPlayback(evidence.postSamples);
  evidence.retention = assessTailRetention(evidence.probe, evidence.baseline, evidence.after, observed.outputState.buffered);
  evidence.scope = 'CMAF receiving-stream and accepted-transform tail retention; native freeze recovery is not qualified by this case.';
  evidence.assessment = evidence.retention;
  return observed;
}
