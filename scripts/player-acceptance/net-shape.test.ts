import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { Page } from 'playwright';
import { expect, it, vi } from 'vitest';
import { netShapeOption, shapedUrl, summarizeAbrTrace, observeShapedAbr, assessAudioContinuity } from './net-shape.mjs';
import type { LinkStats } from '../net-shaper/shaper.mjs';

it('stays unshaped unless a preset is named', async () => {
  expect(await netShapeOption(['--case', 'x'], {})).toBeNull();
  expect(await netShapeOption([], { PLAYER_NET_SHAPE: '' })).toBeNull();
  expect((await netShapeOption(['--net-shape', 'ample'], { PLAYER_NET_SHAPE: 'cap-1m' }))?.preset).toBe('ample');
  expect((await netShapeOption([], { PLAYER_NET_SHAPE: 'cap-1m', PLAYER_NET_SHAPE_SECONDS: '30' }))?.durationMs).toBe(30000);
  await expect(netShapeOption([], { PLAYER_NET_SHAPE: 'dialup' })).rejects.toThrow(/Unknown net shape/);
});

it('changes only the port of the relay URL', () => {
  expect(shapedUrl('https://127.0.0.1:4433/moq', 50123)).toBe('https://127.0.0.1:50123/moq');
});

it('puts browser events on the shaper downlink time base', () => {
  const down = { firstPacketMs: 500, deliveredBps: 990000, deliveredPackets: 10, lossPackets: 0, tailPackets: 3,
    queue: { maxBytes: 12000 }, lateness: { p99Ms: 0.5, maxMs: 1 },
    timeline: [400, 600, 1400, 1600].map((tMs, i) => ({ tMs, deliveredBps: [9e6, 1e6, 2e6, 0][i], queueBytes: i * 100 })) } as unknown as LinkStats;
  const summary = summarizeAbrTrace({ timeOrigin: 1_000_000, events: [
    { timeMs: 2500, type: 'quality_switched', data: { fromTrackName: 'video-1080', toTrackName: 'video-360', reason: 'abr-down' } },
    { timeMs: 3000, type: 'stall', data: { durationMs: 250 } },
    ...[3100, 3200].map(timeMs => ({ timeMs, type: 'quality_switch_failed',
      data: { fromTrackName: 'video-360', toTrackName: 'video-720', reason: 'abr-up', error: 'Error: closed' } })),
    { timeMs: 3700, type: 'stall_recovered', data: { durationMs: 950 } },
    { timeMs: 4000, type: 'stats', data: { captureTimestampAgeMs: 1200 } },
  ] }, { startedAtEpochMs: 1_001_000, down });
  expect(summary.switches).toEqual([{ atS: 1, from: 'video-1080', to: 'video-360', reason: 'abr-down' }]);
  expect(summary.stalls).toEqual([{ atS: 1.5, detectedAfterMs: 250 }]);
  expect(summary.failedSwitches).toEqual([{ atS: 1.6, lastAtS: 1.7, repeats: 2, from: 'video-360', to: 'video-720',
    reason: 'abr-up', error: 'Error: closed' }]);
  expect(summary.stalledMs).toBe(950);
  expect(summary.captureAge).toEqual({ samples: 1, maxMs: 1200, last: { atS: 2.5, ageMs: 1200 } });
  expect(summary.shaper?.tailPackets).toBe(3);
  expect(summary.shaper?.downlinkMbps).toEqual([1.5, 0]);
  expect(summary.shaper?.queueMaxBytes).toEqual([200, 300]);
});

const window5 = {startMs: 0, endMs: 5000, minimumDurationMs: 5000, samplePeriodMs: 250};
const window40 = {...window5, endMs: 40000, minimumDurationMs: 40000};
const dense = (values: number[]) => values.map((audioRms, i) => ({audioRms, wallMs: i * 250}));
const cases: [string, unknown, unknown][] = [
 ['silence before one final audible point is included', dense([...Array(160).fill(0),0.1]), window40],
 ['unobserved forty-second gap is not continuity', [0,250,500,40000].map(wallMs=>({wallMs,audioRms:0.1})), window40],
 ['missing timestamps cannot qualify', [{audioRms:0.1},{audioRms:0.1}], window5],
 ['nonfinite timestamps cannot qualify', [{wallMs:0,audioRms:0.1},{wallMs:NaN,audioRms:0.1}], window5],
 ['nonfinite RMS cannot qualify', dense([Infinity,...Array(20).fill(0.1)]), window5],
 ['negative RMS cannot qualify', dense([-1,...Array(20).fill(0.1)]), window5],
 ['backward clock cannot qualify', dense(Array(21).fill(0.1)).reverse(), window5],
 ['duplicate timestamp cannot qualify', [...dense(Array(21).fill(0.1)),{wallMs:5000,audioRms:0.1}], window5],
 ['extra burst observations cannot inflate the fraction', dense(Array(21).fill(0.1)).flatMap(x=>[x,{...x,wallMs:x.wallMs+1}]).filter(x=>x.wallMs<=5000), window5],
 ['a retained tail cannot replace the declared start', dense(Array(21).fill(0.1)).map(x=>({...x,wallMs:x.wallMs+35000})), window40],
 ['a short prefix cannot replace the declared end', dense(Array(21).fill(0.1)), window40],
 ['missing declared window cannot qualify', dense(Array(21).fill(0.1)), undefined],
 ['capture shorter than the requested duration cannot qualify', dense(Array(21).fill(0.1)), {...window5,minimumDurationMs:40000}],
 ['out-of-window observations cannot qualify', dense(Array(22).fill(0.1)), window5],
];
for(const [name,samples,window] of cases) it(name,()=>{assert.equal(assessAudioContinuity(samples,window).passed,false);});
it('healthy regular observations cover the declared window',()=>{const a=assessAudioContinuity(dense(Array(21).fill(0.1)),window5);assert.equal(a.passed,true);assert.equal(a.audibleFraction,1);});
it('genuinely fragmented dense audio still fails',()=>{assert.equal(assessAudioContinuity(dense(Array.from({length:21},(_,i)=>i%5===0?0.1:0)),window5).passed,false);});

it('null and sparse records produce structured nonqualifying evidence',()=>{
  for(const samples of [[null,...dense(Array(21).fill(0.1))],Array(21)]) {
    let actual: ReturnType<typeof assessAudioContinuity> | undefined;
    assert.doesNotThrow(()=>{actual=assessAudioContinuity(samples,window5);});
    assert.ok(actual);
    assert.equal(actual.passed,false); assert.equal(actual.evidenceValid,false);
  }
});

// Controlled page evaluates the real driver callback in a distinct browser-like realm.
// No browser or sockets are started by these caller tests.
it('declares the requested duration at begin and retains the returned page window', async () => {
  vi.useFakeTimers();
  let now = 1000;
  const begins: unknown[] = [];
  const observation = { startMs: 1000, endMs: 6000, minimumDurationMs: 5000, samplePeriodMs: 250 };
  const page = {
    async evaluate(callback: Function, argument?: unknown) {
      return runInNewContext(`(${callback.toString()})(argument)`, { argument, window: { playerAcceptance: {
        selection: { currentLevel: 0 },
        begin(_silent: boolean, duration: unknown) { begins.push(duration); },
        finish() { return { samples: [], audioObservation: observation }; },
      } }, performance: { now: () => now } });
    },
    async waitForTimeout(ms: number) { now += ms; await vi.advanceTimersByTimeAsync(ms); },
  } as unknown as Page;
  try {
    const result = await observeShapedAbr(page, {}, 5000);
    expect(begins).toEqual([5000]);
    expect(result).toMatchObject({ audioObservation: observation });
  } finally { vi.useRealTimers(); }
});

it.each([0, Infinity, NaN])('rejects a nonfinite or nonpositive declared duration %s before starting', async duration => {
  const evaluate = vi.fn();
  await expect(observeShapedAbr({ evaluate } as unknown as Page, {}, duration)).rejects.toThrow(/duration/i);
  expect(evaluate).not.toHaveBeenCalled();
});

it.each([
  { PLAYER_NET_SHAPE_SECONDS: 'Infinity' },
  { PLAYER_NET_SHAPE_SEED: 'NaN' },
])('rejects invalid capture options before acquiring a shaper: %j', async options => {
  await expect(netShapeOption([], { PLAYER_NET_SHAPE: 'ample', ...options })).rejects.toThrow(/finite|integer/);
});

it('the real audio caller fails malformed/short/silent evidence and accepts a complete declared window', () => {
  const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  const statements = source.match(/          caseResult\.audioContinuity = assessAudioContinuity[\s\S]+?\n          assert\.ok\(caseResult\.audioContinuity\.passed,[\s\S]+?\);/g);
  expect(statements).toHaveLength(1);
  if (!statements?.[0]) throw new Error('Audio caller extraction failed');
  const run = (samples: unknown, audioObservation: unknown) => runInNewContext(statements[0]!, {
    caseResult: {}, observed: { samples, audioObservation }, assessAudioContinuity, assert,
  });
  expect(() => run(dense(Array(21).fill(0.1)), window5)).not.toThrow();
  expect(() => run(dense(Array(21).fill(0.1)), null)).toThrow();
  expect(() => run(dense(Array(21).fill(0.1)), window40)).toThrow();
  expect(() => run(dense(Array(21).fill(0)), window5)).toThrow();
  expect(() => run([null], window5)).toThrow();
});

it('retains the actual startup, public output and teardown assertions in the runner', () => {
  const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  const ready = source.match(/        await page\.waitForFunction\(\(\) => \{\n          const state = window\.playerAcceptance;[\s\S]+?        \}, null, \{ timeout: 20000 \}\);/);
  expect(ready).not.toBeNull();
  if (!ready) throw new Error('Startup caller extraction failed');
  const readyWhen = (state: object) => {
    let result: unknown;
    runInNewContext(ready[0].replace('await ', ''), { window: { playerAcceptance: state },
      page: { waitForFunction(check: () => unknown, _argument: null, options: { timeout: number }) {
        expect(options.timeout).toBe(20000); result = check();
      } } });
    return result;
  };
  expect(readyWhen({ presentedFrames: 8, currentTime: 1, audioRms: 0 })).toBe(false);
  expect(readyWhen({ presentedFrames: 7, currentTime: 1, audioRms: 0.1 })).toBe(false);
  expect(readyWhen({ presentedFrames: 8, currentTime: 1, audioRms: 0.1 })).toBe(true);
  for (const statement of [
    "assert.deepEqual(caseResult.playbackQuality.failures, [], 'Public playback quality must match its owned native video source');",
    "assert.deepEqual(caseResult.presentationFailures, [], 'Public video draw observation');",
    "assert.deepEqual(observed.decodedSource.failures, [], 'Decoded source timestamp correlation');",
    "assert.deepEqual(pageErrors, [], 'Uncaught browser error');",
  ]) {
    expect(source).toContain(statement);
    expect(source).not.toContain('if (!scenario.abrTrace) ' + statement);
  }
});

it.each(['calibration-lost', 'ordinary-lost', 'calibration-captured'] as const)('preserves mandatory capture authority during finalization: %s', async mode => {
  const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  const from = source.indexOf('      const abrTrace = shaper ?');
  const until = source.indexOf('\n    }\n    delete caseResult.passed;', from);
  if (from < 0 || until < 0) throw new Error('Real capture finalization unavailable');
  const stopped: object[] = [], written: string[] = [];
  const shaper = {}, publisher = {}, relay = { text: '' };
  const trace = { timeOrigin: 1000, events: [] };
  const stats = { startedAtEpochMs: 1000, down: { firstPacketMs: null, timeline: [],
    queue: { maxBytes: 0 }, lateness: { p99Ms: null, maxMs: 0 } } };
  const complete = runInNewContext(`(async () => { const pageErrors = []; ${source.slice(from, until)} })()`, {
    shaper, publisher, relay, replacementPublisher: null,
    scenario: { name: 'capture', abrTrace: mode !== 'ordinary-lost' },
    page: { async evaluate() {
      if (mode !== 'calibration-captured') throw new Error('Page evaluation lost');
      return trace;
    } },
    bounded: (promise: Promise<unknown>) => promise,
    context: { async close() {} }, pageErrors: [], assert,
    async stop(child: object) { stopped.push(child); },
    async readFile() { return JSON.stringify(stats); },
    async writeFile(_path: string, value: string) { written.push(value); },
    join: (...parts: string[]) => parts.join('/'), artifacts: 'capture', shaperStats: 'stats',
    netShape: { preset: 'ample', params: {} }, browserUrl: 'https://local:2/moq', relayUrl: 'https://local:1/moq',
    caseResult: { netShape: {} }, summarizeAbrTrace,
  });
  if (mode === 'calibration-lost') await expect(complete).rejects.toThrow(/required ABR trace/i);
  else await complete;
  expect(stopped).toContain(shaper);
  expect(written).toHaveLength(1);
  expect(JSON.parse(written[0]!).abrTrace).toEqual(mode === 'calibration-captured' ? trace : null);
  if (mode !== 'calibration-lost') expect(stopped).toEqual([shaper, publisher, relay]);
});
