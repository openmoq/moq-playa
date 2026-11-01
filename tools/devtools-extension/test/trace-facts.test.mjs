import test from 'node:test';
import assert from 'node:assert/strict';
import { windowedChain, recordedFacts, stageCorrelation, OBSERVATION_MARKER } from './trace-facts.mjs';
import { runInNewContext } from 'node:vm';
import { readLiveSnapshot, waitForLiveSnapshot, playbackStarted } from './live-snapshot.mjs';
import { stageSnapshotProblems } from './trace-facts.mjs';

test('live playback waits for first video presentation even when the audio clock is already advancing', () => {
  const sample = { t: 0.6, presentation: null, stats: { framesRendered: 0 }, rvfc: { callbacks: 0, presentedFrames: 0 } };
  assert.equal(playbackStarted(sample, true), false, 'canvas cannot establish a progress baseline before its first draw');
  assert.equal(playbackStarted(sample, false), false, 'MSE cannot establish a progress baseline before a video-frame callback');
  assert.equal(playbackStarted({ ...sample, presentation: { renderedAtUs: 1 }, stats: { framesRendered: 1 } }, true), true);
  assert.equal(playbackStarted({ ...sample, rvfc: { callbacks: 1, presentedFrames: 1 } }, false), true);
  assert.equal(playbackStarted({ ...sample, t: 0, presentation: { renderedAtUs: 1 }, stats: { framesRendered: 1 } }, true), false);
});

test('live snapshot keeps observations and the grid in the same browser turn across a group rollover', async () => {
  const state = group => ({ __pageFrames: [JSON.stringify({ kind: 'batch', events: [{ fact: { kind: 'object', groupId: group } }] })],
    __playaPanel: { vms: { page: { rows: [{ label: `g ${group}` }] } } } });
  const context = { window: state('9') };
  const snapshot = await readLiveSnapshot(async expression => {
    const value = runInNewContext(expression, context);
    context.window = state('10');
    return value;
  }, text => ({ ok: true, message: JSON.parse(text) }));
  assert.equal(snapshot.facts[0].groupId, '9');
  assert.equal(snapshot.vm.rows[0].label, `g ${snapshot.facts[0].groupId}`);
});

test('live snapshot refuses malformed frames instead of treating missing evidence as success', async () => {
  await assert.rejects(readLiveSnapshot(expression => runInNewContext(expression, { window: {
    __pageFrames: ['invalid'], __playaPanel: { vms: { page: { rows: [] } } },
  } }), () => ({ ok: false, error: { code: 'invalid-json' } })), /gate decode failed: invalid-json/);
});

test('live witness wait accepts a new visible group after an ordinary bounded-view gap', async () => {
  let time = 0;
  const snapshots = [
    { facts: [], vm: { rows: [{ label: 'g 10', cells: [] }] } },
    { facts: [{ kind: 'stage', stage: 'presented' }], vm: { rows: [{ label: 'g 10', cells: [{ present: true }] }] } },
  ];
  const result = await waitForLiveSnapshot('visible unit', () => snapshots.shift(), s => s.facts.length ? s : null,
    { now: () => time, pause: async ms => { time += ms; } });
  assert.equal(result.vm.rows[0].label, 'g 10');
  assert.equal(time, 100);
});

test('live witness wait refuses late success and persistent absence at the unchanged deadline', async () => {
  let time = 0;
  const absent = { facts: [], vm: { rows: [] } };
  await assert.rejects(waitForLiveSnapshot('late capture', async () => { time = 15001; return absent; }, () => true,
    { now: () => time, pause: async () => {} }), /timeout waiting for late capture/);
  time = 0;
  await assert.rejects(waitForLiveSnapshot('no visible unit', () => absent, () => null,
    { now: () => time, pause: async ms => { time += ms; } }), /timeout waiting for no visible unit/);
  assert.equal(time, 15000);
});

test('live witness wait rejects terminal contradictions before retrying an absent cell or choosing another valid unit', async () => {
  const facts = [
    { kind: 'stage', deliveryId: 'old', unitId: 'bad', stage: 'presented' },
    { kind: 'stage', deliveryId: 'old', unitId: 'bad', stage: 'discarded' },
  ];
  let selected = false;
  await assert.rejects(waitForLiveSnapshot('visible unit', () => ({ facts, vm: { rows: [] } }), () => { selected = true; return true; },
    { validate: s => assert.deepEqual(stageSnapshotProblems(s.facts, s.vm.rows), []) }), /successful and discarded/);
  assert.equal(selected, false);
});

test('stage snapshot refuses false discard marks, but accepts another unit\'s truthful discard', () => {
  const facts = [{ kind: 'object', deliveryId: 'd', sessionId: 's', trackAlias: '1', groupId: '10', objectId: '0' },
    { kind: 'stage', deliveryId: 'd', unitId: 'drawn', stage: 'presented' }];
  const rows = [{ cells: [{ present: true, cls: 'discarded', g: 's/1/10', o: '0' }] }];
  assert.match(stageSnapshotProblems(facts, rows).join(), /without a discarded unit/);
  facts.push({ kind: 'stage', deliveryId: 'd', unitId: 'other', stage: 'discarded' });
  assert.deepEqual(stageSnapshotProblems(facts, rows), []);
});

const obs = fact => ({ time: 1, name: 'playa:observation', data: { message: OBSERVATION_MARKER + JSON.stringify(fact) } });

test('parses exactly the marker-prefixed JSON facts and correlates object + both stages on one unitId', () => {
  const records = [
    { file_schema: 'urn:ietf:params:qlog:file:sequential' },
    { time: 0, name: 'playa:metadata', data: { kind: 'diagnostic_baseline', data: { facts: [{ kind: 'stage', deliveryId: 'delivery-9', unitId: 'unit-9', stage: 'appended', reason: null }] } } },
    obs({ kind: 'object', deliveryId: 'delivery-1', groupId: '4', objectId: '0' }),
    obs({ kind: 'stage', deliveryId: 'delivery-1', unitId: 'unit-1', stage: 'reconstructed', reason: null }),
    obs({ kind: 'stage', deliveryId: 'delivery-1', unitId: 'unit-1', stage: 'appended', reason: null }),
    obs({ kind: 'metric', name: 'diagnostic_unattributed_stages', value: 0, definition: 'Stage inputs not observed; appended reconstructed words here are text' }),
  ];
  const { facts, malformed } = recordedFacts(records);
  assert.equal(malformed.length, 0);
  assert.equal(facts.filter(f => f.kind === 'stage').length, 2, 'the baseline-nested stage must NOT count');
  const c = stageCorrelation(facts);
  assert.deepEqual(c.counts, { reconstructed: 1, appended: 1, discarded: 0 });
  assert.deepEqual(c.correlated, { deliveryId: 'delivery-1', unitId: 'unit-1', object: { groupId: '4', objectId: '0' } });
});

test('NEGATIVE: stage words anywhere but in a valid observation fact prove nothing', () => {
  const records = [
    { time: 0, name: 'playa:metadata', data: { kind: 'diagnostic_baseline', data: { facts: [{ kind: 'stage', deliveryId: 'd', unitId: 'u', stage: 'appended' }, { kind: 'stage', deliveryId: 'd', unitId: 'u', stage: 'reconstructed' }] } } },
    { time: 1, name: 'playa:observation', data: { message: 'note: "stage":"appended" "stage":"reconstructed" unitId' } },
    { time: 2, name: 'playa:observation', data: { message: OBSERVATION_MARKER + 'not json {"stage":"appended"}' } },
    obs({ kind: 'object', deliveryId: 'delivery-1', groupId: '4', objectId: '0' }),
    obs({ kind: 'stage', deliveryId: 'delivery-1', unitId: 'unit-1', stage: 'reconstructed', reason: null }),
    obs({ kind: 'stage', deliveryId: 'delivery-1', unitId: 'unit-2', stage: 'appended', reason: null }),   // different unit: no correlation
  ];
  const { facts, malformed } = recordedFacts(records);
  assert.equal(malformed.length, 1, 'a marker with a non-JSON suffix is reported as malformed');
  const c = stageCorrelation(facts);
  assert.deepEqual(c.counts, { reconstructed: 1, appended: 1, discarded: 0 });
  assert.equal(c.correlated, null, 'stages on different units must not correlate');
  assert.throws(() => { assert.ok(c.correlated, 'the trace must carry one correlated object with both stages'); });
});

test('a stage without a recorded object fact does not correlate', () => {
  const { facts } = recordedFacts([
    obs({ kind: 'stage', deliveryId: 'delivery-7', unitId: 'unit-7', stage: 'reconstructed', reason: null }),
    obs({ kind: 'stage', deliveryId: 'delivery-7', unitId: 'unit-7', stage: 'appended', reason: null }),
  ]);
  assert.equal(stageCorrelation(facts).correlated, null);
});

import { locCorrelation } from './trace-facts.mjs';
const obs2 = fact => ({ time: 1, name: 'playa:observation', data: { message: OBSERVATION_MARKER + JSON.stringify(fact) } });
const object = (deliveryId, trackId, groupId, objectId) => obs2({ kind: 'object', deliveryId, trackId, groupId, objectId });
const stage = (deliveryId, unitId, name) => obs2({ kind: 'stage', deliveryId, unitId, stage: name, reason: name === 'discarded' ? 'late frame' : null });
const tracks = { videoTracks: new Set(['v-main', 'v-other']), audioTracks: new Set(['a-main']), selectedTrack: 'v-main' };

test('LOC: video correlates only on a unit of the selected video track with all three stages; audio on a unit with decoded + scheduled and no presented', () => {
  const { facts } = recordedFacts([
    object('d1', 'v-main', '3', '0'), stage('d1', 'u1', 'decoded'), stage('d1', 'u1', 'scheduled'), stage('d1', 'u1', 'presented'),
    object('d2', 'a-main', '3', '1'), stage('d2', 'u2', 'decoded'), stage('d2', 'u2', 'scheduled'),
  ]);
  const r = locCorrelation(facts, tracks);
  assert.deepEqual(r.video, { deliveryId: 'd1', unitId: 'u1', trackId: 'v-main', object: { groupId: '3', objectId: '0' } });
  assert.deepEqual(r.audio, { deliveryId: 'd2', unitId: 'u2', trackId: 'a-main', object: { groupId: '3', objectId: '1' } });
  assert.equal(r.audioPresented, 0);
});

test('NEGATIVE: a presented AUDIO unit can never satisfy the video claim, and is counted so the caller rejects it', () => {
  const { facts } = recordedFacts([
    object('d1', 'a-main', '3', '0'), stage('d1', 'u1', 'decoded'), stage('d1', 'u1', 'scheduled'), stage('d1', 'u1', 'presented'),
  ]);
  const r = locCorrelation(facts, tracks);
  assert.equal(r.video, null, 'only audio presented must not satisfy video');
  assert.equal(r.audio, null, 'a presented audio unit is not a valid audio correlation');
  assert.equal(r.audioPresented, 1);
});

test('NEGATIVE: a valid audio unit next to another falsely presented audio unit still fails the audio check', () => {
  const { facts } = recordedFacts([
    object('d1', 'a-main', '3', '0'), stage('d1', 'u1', 'decoded'), stage('d1', 'u1', 'scheduled'),
    object('d2', 'a-main', '3', '1'), stage('d2', 'u2', 'decoded'), stage('d2', 'u2', 'scheduled'), stage('d2', 'u2', 'presented'),
  ]);
  const r = locCorrelation(facts, tracks);
  assert.ok(r.audio, 'the valid unit is found');
  assert.equal(r.audioPresented, 1, 'the false one is counted and the caller must assert 0');
  assert.throws(() => assert.equal(r.audioPresented, 0));
});

test('NEGATIVE: an unselected video track cannot satisfy selected-video evidence', () => {
  const { facts } = recordedFacts([
    object('d1', 'v-other', '3', '0'), stage('d1', 'u1', 'decoded'), stage('d1', 'u1', 'scheduled'), stage('d1', 'u1', 'presented'),
  ]);
  assert.equal(locCorrelation(facts, tracks).video, null);
  assert.ok(locCorrelation(facts, { ...tracks, selectedTrack: null }).video, 'without a selected track any video track qualifies');
});

test('units are judged per (deliveryId, unitId): a discarded first unit then a complete second unit is found; stages spread across units are not', () => {
  const { facts } = recordedFacts([
    object('d1', 'v-main', '3', '0'), stage('d1', 'u1', 'decoded'), stage('d1', 'u1', 'discarded'),
    stage('d1', 'u2', 'decoded'), stage('d1', 'u2', 'scheduled'), stage('d1', 'u2', 'presented'),
    object('d2', 'v-main', '3', '1'), stage('d2', 'u3', 'decoded'), stage('d2', 'u4', 'scheduled'), stage('d2', 'u4', 'presented'),
  ]);
  const r = locCorrelation(facts, tracks);
  assert.deepEqual(r.video.unitId, 'u2'); assert.equal(r.video.deliveryId, 'd1');
  assert.equal(locCorrelation(facts.filter(f => f.deliveryId !== 'd1'), tracks).video, null, 'cross-unit stages do not correlate');
});

import { cellVerdict } from './trace-facts.mjs';
const unitsOf = pairs => new Map(pairs.map(([id, stages]) => [id, new Set(stages)]));
test('cellVerdict: a presented unit with a drawn clean cell is ok', () => {
  const v = cellVerdict(unitsOf([['u1', ['decoded', 'scheduled', 'presented']]]), 'u1', { present: true, cls: 'fast' });
  assert.deepEqual([v.ok, v.kind, v.otherDiscarded], [true, 'drawn', []]);
});
test('cellVerdict: a presented unit beside ANOTHER unit\'s truthful discard is ok, and the cell may carry the discarded mark', () => {
  const units = unitsOf([['u1', ['decoded', 'discarded']], ['u2', ['decoded', 'scheduled', 'presented']]]);
  const v = cellVerdict(units, 'u2', { present: true, cls: 'fast discarded' });
  assert.deepEqual([v.ok, v.kind, v.otherDiscarded], [true, 'drawn-discarded-by-other-unit', ['u1']]);
});
test('NEGATIVE cellVerdict: the same unit presented AND discarded is refused', () => {
  const v = cellVerdict(unitsOf([['u1', ['decoded', 'scheduled', 'presented', 'discarded']]]), 'u1', { present: true, cls: 'fast discarded' });
  assert.equal(v.ok, false); assert.ok(v.problems.some(p => /both presented and discarded/.test(p)));
});
test('NEGATIVE cellVerdict: a discarded mark with no discarded unit behind it is refused', () => {
  const v = cellVerdict(unitsOf([['u1', ['decoded', 'scheduled', 'presented']]]), 'u1', { present: true, cls: 'fast discarded' });
  assert.equal(v.ok, false); assert.ok(v.problems.some(p => /no unit of this delivery discarded/.test(p)));
});
test('cellVerdict: an absent cell is named as a bounded-view condition, not as a discard', () => {
  const v = cellVerdict(unitsOf([['u1', ['decoded', 'scheduled', 'presented']]]), 'u1', null);
  assert.deepEqual([v.ok, v.kind], [false, 'absent']); assert.ok(v.problems.some(p => /no drawn cell/.test(p)));
});

import { recordedUnit } from './trace-facts.mjs';
test('recordedUnit reports the exact unit\'s stages and whether its object is in the file', () => {
  const { facts } = recordedFacts([
    object('d1', 'v-main', '3', '0'), stage('d1', 'u1', 'decoded'), stage('d1', 'u1', 'scheduled'), stage('d1', 'u1', 'presented'), stage('d1', 'u2', 'discarded'),
    stage('d9', 'u9', 'decoded'),   // stages whose object is outside the file prove nothing about d9
  ]);
  assert.deepEqual(recordedUnit(facts, 'd1', 'u1'), { object: { trackId: 'v-main', groupId: '3', objectId: '0' }, stages: ['decoded', 'presented', 'scheduled'] });
  assert.deepEqual(recordedUnit(facts, 'd1', 'u2').stages, ['discarded']);
  assert.deepEqual(recordedUnit(facts, 'd9', 'u9'), { object: null, stages: ['decoded'] });
});

import { recordingCut, chainAfterCut } from './trace-facts.mjs';
const ev = (seq, fact, origin = 'batch') => ({ seq, fact, origin });
const o = (deliveryId, trackId, groupId, objectId) => ({ kind: 'object', deliveryId, trackId, groupId, objectId });
const st = (deliveryId, unitId, name) => ({ kind: 'stage', deliveryId, unitId, stage: name, reason: null });
const video = { trackOk: t => t === 'v', needs: ['decoded', 'scheduled', 'presented'] };

test('recordingCut: the active recording fact in a BATCH is the cut; snapshot baseline and other ids are not', () => {
  const events = [
    ev(null, { kind: 'recording', state: 'recording', recordingId: 'rec-1' }, 'snapshot'),
    ev('9007199254740993', { kind: 'recording', state: 'recording', recordingId: 'rec-0' }),
    ev('9007199254740995', { kind: 'recording', state: 'recording', recordingId: 'rec-1' }),
  ];
  assert.equal(recordingCut(events, 'rec-1'), 9007199254740995n, 'BigInt seq beyond 2^53 must compare exactly');
  assert.equal(recordingCut(events, 'rec-2'), null, 'missing marker yields null');
});

test('chainAfterCut: a PRE-cut object with POST-cut stages is never a witness; a post-cut object with a complete unit is', () => {
  const cut = 100n;
  const events = [
    ev('90', o('d-pre', 'v', '1', '0')), ev('101', st('d-pre', 'u1', 'decoded')), ev('102', st('d-pre', 'u1', 'scheduled')), ev('103', st('d-pre', 'u1', 'presented')),
    ev('95', o('d-inflight', 'v', '1', '1')), ev('104', st('d-inflight', 'u2', 'decoded')),
    ev('105', o('d-post', 'v', '1', '2')), ev('106', st('d-post', 'u3', 'decoded')), ev('107', st('d-post', 'u3', 'scheduled')), ev('108', st('d-post', 'u3', 'presented')),
  ];
  assert.deepEqual(chainAfterCut(events, cut, video), { deliveryId: 'd-post', unitId: 'u3', trackId: 'v', groupId: '1', objectId: '2', seq: '105' });
  assert.equal(chainAfterCut(events.filter(e => e.fact.deliveryId !== 'd-post'), cut, video), null, 'pre-cut and in-flight deliveries are refused');
  assert.equal(chainAfterCut(events, null, video), null, 'no cut, no witness');
});

test('chainAfterCut: an object AT the cut seq is not after it; snapshot-origin objects never count; audio forbids presented', () => {
  const events = [
    ev('100', o('d-at', 'v', '1', '0')), ev('101', st('d-at', 'u1', 'decoded')), ev('102', st('d-at', 'u1', 'scheduled')), ev('103', st('d-at', 'u1', 'presented')),
    ev(null, o('d-snap', 'v', '1', '1'), 'snapshot'), ev('104', st('d-snap', 'u2', 'decoded')), ev('105', st('d-snap', 'u2', 'scheduled')), ev('106', st('d-snap', 'u2', 'presented')),
    ev('107', o('d-a', 'a', '2', '0')), ev('108', st('d-a', 'u3', 'decoded')), ev('109', st('d-a', 'u3', 'scheduled')), ev('110', st('d-a', 'u3', 'presented')),
  ];
  assert.equal(chainAfterCut(events, 100n, video), null);
  assert.equal(chainAfterCut(events, 100n, { trackOk: t => t === 'a', needs: ['decoded', 'scheduled'], forbid: ['presented'] }), null, 'a presented audio unit is refused');
});

test('NEGATIVE file identity: a recorded unit whose object tuple differs from the witness must not pass a deep compare', () => {
  const { facts } = recordedFacts([object('d1', 'v-main', '3', '0'), stage('d1', 'u1', 'decoded'), stage('d1', 'u1', 'scheduled'), stage('d1', 'u1', 'presented')]);
  const witness = { deliveryId: 'd1', unitId: 'u1', trackId: 'v-main', groupId: '3', objectId: '1' };   // objectId differs
  const rec = recordedUnit(facts, witness.deliveryId, witness.unitId);
  assert.throws(() => assert.deepEqual(rec.object, { trackId: witness.trackId, groupId: witness.groupId, objectId: witness.objectId }));
});

test('chainAfterCut terminal consistency: a same-unit presented+discarded is refused while another unit\'s discard does not block a valid witness', () => {
  const events = [
    ev('101', o('d-bad', 'v', '1', '0')), ev('102', st('d-bad', 'u1', 'decoded')), ev('103', st('d-bad', 'u1', 'scheduled')), ev('104', st('d-bad', 'u1', 'presented')), ev('105', st('d-bad', 'u1', 'discarded')),
    ev('106', o('d-ok', 'v', '1', '1')), ev('107', st('d-ok', 'u2', 'decoded')), ev('108', st('d-ok', 'u2', 'discarded')),
    ev('109', st('d-ok', 'u3', 'decoded')), ev('110', st('d-ok', 'u3', 'scheduled')), ev('111', st('d-ok', 'u3', 'presented')),
  ];
  const strict = { trackOk: t => t === 'v', needs: ['decoded', 'scheduled', 'presented'], forbid: ['discarded'] };
  const w = chainAfterCut(events, 100n, strict);
  assert.deepEqual([w.deliveryId, w.unitId], ['d-ok', 'u3'], 'the presented+discarded unit is skipped; the sibling-discard delivery still yields its clean unit');
  const { facts } = recordedFacts([object('d-bad', 'v', '1', '0'), stage('d-bad', 'u1', 'presented'), stage('d-bad', 'u1', 'discarded')]);
  assert.ok(recordedUnit(facts, 'd-bad', 'u1').stages.includes('discarded'), 'the saved-unit check sees the same-unit discard and must refuse it');
});

test('windowedChain admits only observations the SOURCE clocked inside the window; seq order and other clocks do not qualify', () => {
  const ev = (seq, timeMs, fact, clockId = 'performance') => ({ seq: String(seq), clockId, timeMs, fact });
  const obj = (d, t) => ({ kind: 'object', deliveryId: d, trackId: t, groupId: '1', objectId: '0' });
  const app = (d, u) => ({ kind: 'stage', stage: 'appended', deliveryId: d, unitId: u });
  const video = new Set(['video-1']);
  const events = [
    ev(10, 900, obj('d-old', 'video-1')), ev(11, 950, app('d-old', 'u-old')),        // before the window
    ev(20, 1200, obj('d-new', 'video-1')), ev(21, 1300, app('d-new', 'u-new')),      // inside the window
    ev(22, 1250, obj('d-audio', 'audio-1')), ev(23, 1260, app('d-audio', 'u-a')),    // inside, other track
    ev(30, 1400, obj('d-late-seq-old-time', 'video-1')), ev(31, 1450, app('d-late-seq-old-time', 'u-x')), // late batch seq, but...
    ev(40, 1500, obj('d-other-clock', 'video-1'), 'mock-clock'), ev(41, 1500, app('d-other-clock', 'u-oc'), 'mock-clock'),
    { seq: null, clockId: 'performance', timeMs: 1250, fact: obj('d-snapshot', 'video-1') },   // snapshot replay never counts
  ];
  // Pre-window object + append with a LATER batch seq do not qualify (window is (1000, 1350])
  events[6] = ev(30, 980, obj('d-late-seq-old-time', 'video-1')); events[7] = ev(31, 990, app('d-late-seq-old-time', 'u-x'));
  const w = windowedChain(events, { clockId: 'performance', afterMs: 1000, untilMs: 1350, trackIds: video });
  assert.deepEqual(w.objects.map(e => e.fact.deliveryId), ['d-new']);
  assert.deepEqual(w.appended.map(e => e.fact.unitId), ['u-new']);
  assert.equal(w.otherClocks, 2);
  // A real post-window chain qualifies when the window covers it; an append without its object in the window does not.
  const later = windowedChain(events, { clockId: 'performance', afterMs: 1000, untilMs: 1600, trackIds: video });
  assert.deepEqual(later.objects.map(e => e.fact.deliveryId), ['d-new']);
  const appendOnly = windowedChain([ev(50, 1600, app('d-ghost', 'u-g'))], { clockId: 'performance', afterMs: 1000, untilMs: 2000, trackIds: video });
  assert.deepEqual(appendOnly.appended, []);
  // An empty frozen interval: nothing qualifies even though plenty of facts exist with higher seqs.
  const empty = windowedChain(events, { clockId: 'performance', afterMs: 1300, untilMs: 1300.5, trackIds: video });
  assert.deepEqual({ objects: empty.objects.length, appended: empty.appended.length }, { objects: 0, appended: 0 });
});
