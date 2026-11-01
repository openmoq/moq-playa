import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitObjectDelivery } from './probe-object-wait.mjs';

// A controlled clock: each read advances it by the read's own duration; pause advances it by the interval.
const clock = () => { let t = 0; return { now: () => t, advance: ms => { t += ms; }, pause: async ms => { t += ms; } }; };
const hit = { sample: { groupId: '0', objectId: '0' }, cell: { g: 's/1/0', o: '0' }, details: { objectFacts: 1 } };
const miss = { diagnostics: { objectFacts: 0, accepted: [] } };

test('a sample read back inside the deadline is accepted with its elapsed time', async () => {
  const c = clock(); let reads = 0;
  const read = async () => { c.advance(100); return ++reads < 3 ? miss : hit; };
  const r = await awaitObjectDelivery({ read, deadlineMs: 20000, intervalMs: 250, now: c.now, pause: c.pause });
  assert.deepEqual({ delivered: r.delivered, elapsedMs: r.elapsedMs, objectFacts: r.objectFacts }, { delivered: true, elapsedMs: 3 * 100 + 2 * 250, objectFacts: 1 });
  assert.deepEqual(r.cell, hit.cell, 'the accepted result retains its exact rendered-cell witness');
});

test('LATE RETURN: a matching sample whose read returns after the deadline is refused, not accepted', async () => {
  const c = clock();
  const read = async () => { c.advance(20001); return hit; };      // the read itself crosses the deadline
  const r = await awaitObjectDelivery({ read, deadlineMs: 20000, now: c.now, pause: c.pause });
  assert.equal(r.delivered, false); assert.equal(r.lateReturn, true); assert.equal(r.elapsedMs, 20001);
});

test('a poll started inside the deadline that returns after it is judged on return', async () => {
  const c = clock(); let reads = 0;
  const read = async () => { reads++; c.advance(reads === 2 ? 15000 : 100); return reads === 2 ? hit : miss; };   // second read starts at 350 ms, returns at 15350 ms
  const r = await awaitObjectDelivery({ read, deadlineMs: 15000, intervalMs: 250, now: c.now, pause: c.pause });
  assert.deepEqual({ delivered: r.delivered, lateReturn: r.lateReturn, elapsedMs: r.elapsedMs }, { delivered: false, lateReturn: true, elapsedMs: 15350 });
});

test('non-delivery is reported with the last read diagnostics once the deadline passes', async () => {
  const c = clock();
  const read = async () => { c.advance(100); return miss; };
  const r = await awaitObjectDelivery({ read, deadlineMs: 1000, intervalMs: 250, now: c.now, pause: c.pause });
  assert.equal(r.delivered, false); assert.equal(r.lateReturn, false); assert.deepEqual(r.accepted, []); assert.ok(r.elapsedMs > 1000);
});
