import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLink, type Link } from './shaper.mjs';

let now = 0;
const pending = new Set<{ fn: () => void }>();
const intervals = new Set<object>();
const links: Link[] = [];
const arm = (fn: () => void) => { const handle = { fn }; pending.add(handle); return handle; };
const at = (time: number) => {
  now = time;
  for (const handle of [...pending]) { pending.delete(handle); handle.fn(); }
};
beforeEach(() => {
  now = 0;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('setTimeout', arm); vi.stubGlobal('setImmediate', arm);
  vi.stubGlobal('clearTimeout', (handle: { fn: () => void }) => pending.delete(handle));
  vi.stubGlobal('clearImmediate', (handle: { fn: () => void }) => pending.delete(handle));
  vi.stubGlobal('setInterval', () => { const handle = { unref() {} }; intervals.add(handle); return handle; });
  vi.stubGlobal('clearInterval', (handle: object) => intervals.delete(handle));
});
afterEach(() => {
  links.splice(0).forEach(link => link.close());
  const remaining = { work: pending.size, intervals: intervals.size };
  pending.clear(); intervals.clear(); vi.unstubAllGlobals();
  expect(remaining).toEqual({ work: 0, intervals: 0 });
});
function changingLink() {
  const link = createLink({ rateBps: 8000, schedule: [{ atMs: 500, rateBps: 16000 }],
    queueBytes: 10000, delayMs: 20 }, { recordPackets: true });
  links.push(link); return link;
}

it('integrates work on both sides of a rate boundary before adding propagation', () => {
  const link = changingLink();
  link.enqueue(Buffer.alloc(1000), () => {}); link.enqueue(Buffer.alloc(1000), () => {});
  expect(link.stats().packets!.map(p => p.finishMs)).toEqual([750, 1250]);
  expect(link.stats().packets!.map(p => p.intendedMs)).toEqual([770, 1270]);
});

it('late wakeup preserves intended times and reports actual lateness without reordering', () => {
  const link = changingLink(), delivered: number[] = [];
  link.enqueue(Buffer.alloc(1000), () => delivered.push(1));
  link.enqueue(Buffer.alloc(1000), () => delivered.push(2));
  at(2000);
  expect(delivered).toEqual([1, 2]);
  expect(link.stats().packets!.map(p => p.finishMs)).toEqual([750, 1250]);
  expect(link.stats().packets!.map(p => p.intendedMs)).toEqual([770, 1270]);
  expect(link.stats().packets!.map(p => p.actualMs)).toEqual([2000, 2000]);
  expect(link.stats().lateness.maxMs).toBe(1230);
});

it('reanchors serialization after idle time instead of spending stale capacity', () => {
  const link = changingLink(); link.enqueue(Buffer.alloc(1000), () => {});
  at(2000); link.enqueue(Buffer.alloc(1000), () => {});
  expect(link.stats().packets![1]!.finishMs).toBe(2500);
});

it('tail-drops at the byte limit and reclaims only serialized backlog', () => {
  const link = createLink({ rateBps: 8000, queueBytes: 1000 }, { recordPackets: true }); links.push(link);
  link.enqueue(Buffer.alloc(1000), () => {}); link.enqueue(Buffer.alloc(1), () => {});
  expect(link.stats().tailPackets).toBe(1); expect(link.stats().queue.bytes).toBe(1000);
  at(999); link.enqueue(Buffer.alloc(1), () => {});
  expect(link.stats().tailPackets).toBe(2);
  at(1000); link.enqueue(Buffer.alloc(1000), () => {});
  expect(link.stats().tailPackets).toBe(2); expect(link.stats().packets![3]!.finishMs).toBe(2000);
});

it('fixed seed reproduces loss/jitter while jitter preserves serialization and FIFO bounds', () => {
  function pattern(seed: number) {
    const link = createLink({ rateBps: 8000, queueBytes: 10000, delayMs: 5, jitterMs: 15, lossPct: 10 },
      { recordPackets: true, seed }); links.push(link);
    for (let i = 0; i < 200; i++) link.enqueue(Buffer.alloc(1), () => {});
    const records = link.stats().packets!;
    const delivered = records.filter(p => p.dropped === undefined);
    for (let i = 0; i < delivered.length; i++) {
      expect(delivered[i]!.intendedMs!).toBeGreaterThanOrEqual(delivered[i]!.finishMs!);
      if (i) expect(delivered[i]!.intendedMs!).toBeGreaterThanOrEqual(delivered[i - 1]!.intendedMs!);
    }
    link.close();
    return records.map(p => [p.dropped ?? null, p.jitterMs ?? null]);
  }
  const first = pattern(7); expect(pattern(7)).toEqual(first); expect(pattern(8)).not.toEqual(first);
});

it('close retires pending dispatch and sampling, and refuses later enqueue', () => {
  const link = changingLink(), deliver = vi.fn();
  link.enqueue(Buffer.alloc(1000), deliver);
  const callbacks = [...pending]; expect(callbacks.length).toBeGreaterThan(0);
  link.close(); link.close(); at(2000);
  callbacks.forEach(handle => handle.fn()); link.enqueue(Buffer.alloc(1000), deliver);
  expect(deliver).not.toHaveBeenCalled(); expect(link.stats().offeredPackets).toBe(1);
  expect(pending.size).toBe(0); expect(intervals.size).toBe(0);
});
