import test from 'node:test';
import assert from 'node:assert/strict';
import { countFacts, frameMeta } from './fact-counter.mjs';

const batch = (n, from) => JSON.stringify({ kind: 'batch', fromSeq: String(from), toSeq: String(from + n - 1), events: Array.from({ length: n }, (_, i) => ({ seq: String(from + i), fact: { kind: 'object' } })) });
const snapshot = n => JSON.stringify({ kind: 'snapshot', watermark: '5', facts: Array.from({ length: n }, () => ({ fact: { kind: 'object' } })) });

test('counts batch events and snapshot facts; hello/ack/control frames add nothing', () => {
  assert.equal(countFacts(batch(3, 10)), 3);
  assert.equal(countFacts(snapshot(7)), 7);
  assert.equal(countFacts(JSON.stringify({ kind: 'hello', sources: [] })), 0);
  assert.equal(countFacts(JSON.stringify({ kind: 'ack', frames: 1 })), 0);
  assert.equal(countFacts('not json'), 0);
});

test('CONTROL: one extra fact is detected after a 256-frame ring is full, while the ring length stays 256', () => {
  const ring = []; let counter = 0;
  const apply = text => { if (ring.length >= 256) ring.shift(); ring.push(text); counter += countFacts(text); };
  for (let i = 0; i < 256; i++) apply(batch(1, i));
  const lenFull = ring.length, countFull = counter;
  apply(batch(1, 999));
  assert.equal(ring.length, lenFull, 'the ring length is unchanged when full');
  assert.equal(counter, countFull + 1, 'the counter still grows by exactly the one new fact');
  assert.deepEqual(frameMeta(batch(1, 999)), { kind: 'batch', fromSeq: '999', toSeq: '999' });
});

// Validity guard: the comparison is only meaningful when each sampled counter is a real nonnegative integer.
import { validateCounterSample, validateFactCounterWitness, ringCoverage } from './fact-counter.mjs';
const witness = (pre, at, after) => validateFactCounterWitness({ preRequest: pre, atCompletedDetach: at, afterProgressCheck: after });
const valid = { facts: 688, frames: 10, last: { kind: 'batch', fromSeq: '649', toSeq: '692' } };

test('an uninstalled counter (undefined samples) fails instead of comparing undefined to undefined', () => {
  const r = witness(undefined, undefined, undefined);
  assert.equal(r.ok, false);
  assert.match(r.failures[0], /preRequest: sample is undefined/);
  assert.equal(witness({ facts: undefined, frames: 10 }, valid, valid).ok, false, 'a missing field fails');
});

test('NaN, Infinity, fractional and negative counters fail even when both samples are identical', () => {
  for (const bad of [NaN, Infinity, -Infinity, 1.5, -1, '688', null]) {
    const s = { facts: bad, frames: 10 };
    const r = witness(s, s, s);
    assert.equal(r.ok, false, `facts=${String(bad)} must fail`);
    assert.ok(r.failures.some(f => /not a nonnegative safe integer/.test(f)), r.failures.join('; '));
    assert.equal(validateCounterSample({ facts: 1, frames: bad }, 'x').length, 1, `frames=${String(bad)} must fail`);
  }
  assert.deepEqual(validateCounterSample(valid, 'x'), []);
});

test('zero counters after the attached live/recording workload fail; they do not prove inactivity', () => {
  const zero = { facts: 0, frames: 0 };
  const r = witness(zero, zero, zero);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => /preRequest\.facts must be positive/.test(f)) && r.failures.some(f => /preRequest\.frames must be positive/.test(f)), r.failures.join('; '));
  assert.equal(witness({ facts: 5, frames: 0 }, { facts: 5, frames: 0 }, { facts: 5, frames: 0 }).ok, false, 'positive facts with zero frames is inconsistent');
});

test('a regression at completed detach or movement after it fails', () => {
  assert.ok(witness(valid, { facts: 687, frames: 10 }, { facts: 687, frames: 10 }).failures.some(f => /facts regressed/.test(f)));
  assert.ok(witness(valid, { facts: 688, frames: 9 }, { facts: 688, frames: 9 }).failures.some(f => /frames regressed/.test(f)));
  assert.ok(witness(valid, valid, { facts: 689, frames: 11 }).failures.some(f => /facts moved after the COMPLETED detach: 688 → 689/.test(f)));
  assert.ok(witness(valid, valid, { facts: 688, frames: 9 }).failures.some(f => /frames regressed after the completed detach/.test(f)));
  assert.ok(witness(valid, { facts: 0, frames: 0 }, { facts: 0, frames: 0 }).ok === false, 'a counter reset to zero at detach is a regression, not a quiet detach');
});

test('a legitimate pre-completion drain passes while post-completion facts fail', () => {
  const drained = { facts: 700, frames: 11 };
  assert.deepEqual(witness(valid, drained, drained), { ok: true, failures: [] });
  assert.equal(witness(valid, drained, { facts: 701, frames: 11 }).ok, false);
});

// Scalars recorded by the live gate on the final gate bytes (Mac and Linux, source and production builds) replay
// as valid witnesses; each is pre-request → at completed detach → after the progress check.
const recorded = {
  'mac loc': [[688, 10], [688, 10], [688, 10]],
  'mac cmaf': [[197, 7], [197, 7], [197, 7]],
  'mac locmaf-mse': [[400, 15], [400, 15], [400, 15]],
  'mac loc (three-arm run)': [[1006, 24], [1006, 24], [1006, 24]],
  'mac cmaf-production': [[203, 7], [203, 7], [203, 7]],
  'linux cmaf': [[268, 9], [268, 9], [268, 9]],
  'linux locmaf-mse': [[532, 18], [532, 18], [532, 18]],
  'linux loc': [[4790, 127], [4790, 127], [4790, 127]],
  'linux cmaf-production': [[232, 8], [232, 8], [232, 8]],
};
test('recorded live-gate counters replay as valid witnesses', () => {
  for (const [name, [pre, at, after]] of Object.entries(recorded)) {
    const s = ([facts, frames]) => ({ facts, frames });
    assert.deepEqual(witness(s(pre), s(at), s(after)), { ok: true, failures: [] }, name);
  }
});

test('ringCoverage admits an absence claim only when every frame since the cutoff is still retained', () => {
  // full coverage: cutoff 100, ring holds 100..355 (256 frames), next index 356
  assert.deepEqual(ringCoverage({ cutoffIndex: 100, firstRetainedIndex: 100, nextIndex: 356, evictedSinceCutoff: 0 }), { ok: true, failures: [] });
  // the ring shifted past the cutoff: frames 100..119 are gone
  const lost = ringCoverage({ cutoffIndex: 100, firstRetainedIndex: 120, nextIndex: 376, evictedSinceCutoff: 20 });
  assert.equal(lost.ok, false); assert.match(lost.failures[0], /frames 100\.\.119 applied since the cutoff fell out of the ring \(20 evicted\)/);
  // nothing applied since the cutoff and nothing retained: trivially covered
  assert.equal(ringCoverage({ cutoffIndex: 50, firstRetainedIndex: null, nextIndex: 50, evictedSinceCutoff: 0 }).ok, true);
  // frames applied since the cutoff but the ring is empty (cleared afterwards): not covered
  assert.equal(ringCoverage({ cutoffIndex: 50, firstRetainedIndex: null, nextIndex: 60, evictedSinceCutoff: 0 }).ok, false);
  // invalid metadata never passes
  assert.equal(ringCoverage({ cutoffIndex: NaN, firstRetainedIndex: 0, nextIndex: 1, evictedSinceCutoff: 0 }).ok, false);
  assert.equal(ringCoverage({ cutoffIndex: 10, firstRetainedIndex: 0, nextIndex: 5, evictedSinceCutoff: 0 }).ok, false);
});
