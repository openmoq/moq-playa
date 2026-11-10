import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { assessPlayback } from './assessment.mjs';
import { classifyCaseResult, classifyRunResult, formatCaseResult } from './case-result.mjs';
import { assessAudioContinuity } from './net-shape.mjs';
import { strict as assert } from 'node:assert';

const samples = (frozen: boolean) => Array.from({ length: 25 }, (_, i) => ({
  wallMs: i * 250, mediaTimeS: 4 + i / 4, presentedMediaTimeS: 4 + i / 4,
  presentedFrames: i * 6, pictureDigest: frozen ? 'unchanged' : String(i),
  pictureChange: frozen ? 0 : 2, audioRms: 0.1, audioPeakHz: 440,
  videoWidth: 1920, videoHeight: 1080, markerRgb: [0, 255, 0], outputKind: 'video' as const,
  bufferedRanges: [{ start: 0, end: 20 }], paused: false, seeking: false, visibility: 'visible',
}));
const assess = (frozen: boolean) => assessPlayback(samples(frozen), {
  videoWidth: 1920, videoHeight: 1080, audioHz: 440, videoFps: 24,
});

describe('calibration capture and playback verdict', () => {
  it('records frozen output honestly without making calibration a quality gate', () => {
    const result = classifyCaseResult(assess(true), true);
    expect(result.assessment.failures).toEqual(['picture-frozen']);
    expect(result.assessment.passed).toBe(false);
    expect(result).toMatchObject({ status: 'trace', completed: true });
    expect(result).not.toHaveProperty('passed');
    expect(formatCaseResult('abr', result)).toBe('TRACE abr: picture-frozen (informational)');
  });

  it('labels even healthy calibration TRACE rather than healthy PASS', () => {
    const result = classifyCaseResult(assess(false), true);
    expect(result.assessment).toMatchObject({ passed: true, failures: [] });
    expect(result).not.toHaveProperty('passed');
    expect(formatCaseResult('abr', result)).toBe('TRACE abr: no playback defects observed (informational)');
  });

  it('retains ordinary positive and negative playback gates', () => {
    const healthy = classifyCaseResult(assess(false));
    const frozen = classifyCaseResult(assess(true));
    expect(healthy).toMatchObject({ status: 'pass', passed: true });
    expect(formatCaseResult('gate', healthy)).toBe('PASS gate: healthy output');
    expect(frozen).toMatchObject({ status: 'fail', passed: false });
    expect(formatCaseResult('gate', frozen)).toBe('FAIL gate: picture-frozen');
  });

  it('retains intentional negative controls without erasing their actual assessment', () => {
    const control = classifyCaseResult(assess(true), false, 'picture-frozen');
    expect(control).toMatchObject({ status: 'pass', passed: true, assessment: { passed: false, failures: ['picture-frozen'] } });
    expect(classifyCaseResult(assess(true), false, 'audio-missing')).toMatchObject({ status: 'fail', passed: false });
  });

  it('snapshots failure details without mutating the assessor result', () => {
    const original = assess(true);
    const result = classifyCaseResult(original, true);
    original.failures.push('later');
    expect(result.assessment.failures).toEqual(['picture-frozen']);
    expect(result.assessment.samples).toBe(25);
  });

  it('distinguishes successful mixed capture from a run-level playback pass', () => {
    const gate = classifyCaseResult(assess(false));
    const trace = classifyCaseResult(assess(true), true);
    expect(classifyRunResult([gate], [])).toEqual({ status: 'pass', completed: true, passed: true });
    expect(classifyRunResult([gate, trace], [])).toEqual({ status: 'trace', completed: true });
    expect(classifyRunResult([trace], ['teardown failed'])).toEqual({ status: 'fail', completed: false, passed: false });
    expect(classifyRunResult([{}], [])).toEqual({ status: 'fail', completed: false, passed: false });
    expect(classifyRunResult([classifyCaseResult(assess(true))], [])).toEqual({ status: 'fail', completed: false, passed: false });
  });

  it('wires the real runner to the shared result seam and retains runtime error exit status', () => {
    const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    expect(source).toContain('caseResult.assessment = assessPlayback(observed.samples, {');
    expect(source).not.toContain('observed: assessPlayback(observed.samples, {');
    expect(source).toContain('else if (!scenario.abrTrace) assert.equal(caseResult.assessment.passed, true');
    expect(source).toContain('Object.assign(caseResult, classifyCaseResult(caseResult.assessment, !!scenario.abrTrace, scenario.expectedFailure ?? null))');
    expect(source).toContain('console.log(formatCaseResult(scenario.name, caseResult))');
    expect(source).toContain('delete result.passed;');
    expect(source).toContain('Object.assign(result, classifyRunResult(result.cases, result.errors))');
    expect(source).toContain("if (result.status === 'fail') process.exitCode = 1;");
  });

  it('executes the actual terminal caller statements for trace, ordinary gate and aggregate exception', () => {
    const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    const finalizer = source.match(/  delete result\.passed;\n  Object\.assign\(result, classifyRunResult\(result\.cases, result\.errors\)\);\n  if \(result\.status === 'fail'\) process\.exitCode = 1;/g);
    const catcher = source.match(/  result\.errors\.push\(error\.stack \?\? String\(error\)\);\n  process\.exitCode = 1;/g);
    expect(finalizer).toHaveLength(1);
    expect(catcher).toHaveLength(1);
    if (!finalizer?.[0] || !catcher?.[0]) throw new Error('Terminal caller extraction failed');
    const trace = classifyCaseResult(assess(true), true);
    const gate = classifyCaseResult(assess(false));
    for (const item of [trace, gate]) {
      const context = { result: { cases: [item], errors: [], passed: false },
        process: { exitCode: undefined }, classifyRunResult };
      runInNewContext(finalizer[0], context);
      expect(context.result).toMatchObject({ status: item.status, completed: true });
      if (item.status === 'trace') expect(context.result).not.toHaveProperty('passed');
      else expect(context.result.passed).toBe(true);
      expect(context.process.exitCode).toBeUndefined();
    }
    const error = new AggregateError([new Error('acquisition'), new Error('cleanup')], 'both failed');
    const failed = { result: { cases: [trace], errors: [] as string[], passed: false },
      process: { exitCode: undefined }, error, classifyRunResult };
    runInNewContext(catcher[0] + '\n' + finalizer[0], failed);
    expect(failed.result).toMatchObject({ status: 'fail', completed: false, passed: false });
    expect(failed.result.errors).toEqual([error.stack]);
    expect(failed.process.exitCode).toBe(1);
    expect(failed.result.cases[0]?.status).toBe('trace');
  });

  it.each([true, false])('completes the actual initialized case with informational=%s', informational => {
    const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    const statements = source.match(/(?:    delete caseResult\.passed;\n)?    Object\.assign\(caseResult, classifyCaseResult\(caseResult\.assessment, !!scenario\.abrTrace, scenario\.expectedFailure \?\? null\)\);\n    console\.log\(formatCaseResult\(scenario\.name, caseResult\)\);/g);
    expect(statements).toHaveLength(1);
    if (!statements?.[0]) throw new Error('Case completion extraction failed');
    const caseResult = { name: 'initialized', passed: false, assessment: assess(informational) };
    const lines: string[] = [];
    runInNewContext(statements[0], { caseResult,
      scenario: { name: 'initialized', abrTrace: informational, expectedFailure: null },
      classifyCaseResult, formatCaseResult, console: { log: (line: string) => lines.push(line) } });
    if (informational) {
      expect(caseResult).not.toHaveProperty('passed');
      expect(caseResult).toMatchObject({ status: 'trace', assessment: { passed: false, failures: ['picture-frozen'] } });
      expect(lines).toEqual(['TRACE initialized: picture-frozen (informational)']);
    } else {
      expect(caseResult).toMatchObject({ status: 'pass', passed: true });
      expect(lines).toEqual(['PASS initialized: healthy output']);
    }
  });

  it.each(['missing-window', 'silent'] as const)('propagates %s audio evidence failure through the actual run finalizer', mode => {
    const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    const audio = source.match(/          caseResult\.audioContinuity = assessAudioContinuity[\s\S]+?\n          assert\.ok\(caseResult\.audioContinuity\.passed,[\s\S]+?\);/);
    const catcher = source.match(/  result\.errors\.push\(error\.stack \?\? String\(error\)\);\n  process\.exitCode = 1;/);
    const finalizer = source.match(/  delete result\.passed;\n  Object\.assign\(result, classifyRunResult\(result\.cases, result\.errors\)\);\n  if \(result\.status === 'fail'\) process\.exitCode = 1;/);
    if (!audio || !catcher || !finalizer) throw new Error('Real caller statements unavailable');
    const context = { result: { cases: [{ passed: false }], errors: [], passed: false },
      process: { exitCode: undefined }, caseResult: {},
      observed: { samples: Array.from({ length: 21 }, (_, i) => ({ wallMs: i * 250, audioRms: mode === 'silent' ? 0 : 0.1 })),
        audioObservation: mode === 'missing-window' ? null : { startMs: 0, endMs: 5000, minimumDurationMs: 5000, samplePeriodMs: 250 } },
      assessAudioContinuity, classifyRunResult, assert };
    runInNewContext(`try { ${audio[0]} } catch (error) { ${catcher[0]} }\n${finalizer[0]}`, context);
    expect(context.process.exitCode).toBe(1);
    expect(context.result).toMatchObject({ status: 'fail', completed: false, passed: false });
    expect(context.result.errors).toHaveLength(1);
  });
});

// Execute the current runner's real assessment/audio assertion and completion
// statements; this is a deterministic contract test, not a browser run.
describe('current-head TRACE preserves the folded audio-continuity gate', () => {
  it.each([true, false])('records picture-frozen=%s honestly when audio continuity passes', frozen => {
    const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    const begin = source.indexOf('caseResult.assessment = assessPlayback(observed.samples, {');
    const end = source.indexOf('        } else if (handover)', begin);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    const completion = source.match(/    delete caseResult\.passed;\n    Object\.assign\(caseResult, classifyCaseResult\(caseResult\.assessment, !!scenario\.abrTrace, scenario\.expectedFailure \?\? null\)\);\n    console\.log\(formatCaseResult\(scenario\.name, caseResult\)\);/g);
    expect(completion).toHaveLength(1);
    const caseResult: Record<string, unknown> = { passed: false };
    const lines: string[] = [];
    runInNewContext(source.slice(begin, end) + completion![0], { caseResult,
      observed: { samples: samples(frozen), audioObservation: { startMs: 0, endMs: 6000, minimumDurationMs: 6000, samplePeriodMs: 250 } }, scenario: { name: 'abr', abrTrace: true, expected: {} },
      assessPlayback, assessAudioContinuity, assert,
      classifyCaseResult, formatCaseResult, console: { log: (line: string) => lines.push(line) } });
    expect(caseResult).toMatchObject({ status: 'trace', completed: true,
      audioContinuity: { passed: true, audibleFraction: 1 },
      assessment: { passed: !frozen, failures: frozen ? ['picture-frozen'] : [] } });
    expect(caseResult).not.toHaveProperty('passed');
    expect(lines[0]).toMatch(/^TRACE abr:/);
  });

  it.each(['never-audible', 'fragmentary'] as const)('fails %s audio before publishing a successful TRACE', audio => {
    const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
    const begin = source.indexOf('caseResult.assessment = assessPlayback(observed.samples, {');
    const end = source.indexOf('        } else if (handover)', begin);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    const observed = { audioObservation: { startMs: 0, endMs: 6000, minimumDurationMs: 6000, samplePeriodMs: 250 }, samples: samples(false).map((sample, i) => ({ ...sample,
      audioRms: audio === 'fragmentary' && i % 5 === 0 ? 0.1 : 0 })) };
    const caseResult: Record<string, unknown> = { passed: false };
    expect(() => runInNewContext(source.slice(begin, end), { caseResult, observed,
      scenario: { expected: {} }, assessPlayback, assessAudioContinuity, assert }))
      .toThrow(/Audio observation failed/);
    expect(caseResult).toMatchObject({ passed: false, audioContinuity: { passed: false } });
    expect(caseResult).not.toHaveProperty('completed');
    expect(classifyRunResult([caseResult], [new Error('audio assertion')])).toEqual({ status: 'fail', completed: false, passed: false });
  });
});
