import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLink, type LinkStats } from './shaper.mjs';
import { checkScheduleTransition, type ScheduleArrival } from './schedule-test-oracle.js';

interface Model { down: LinkStats; arrivals: ScheduleArrival[]; sent: number }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval'] });
  vi.spyOn(dgram, 'createSocket').mockImplementation(() => { throw new Error('No native UDP is authorized'); });
});
afterEach(() => {
  expect(dgram.createSocket).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});

function plan(options: { stepMs?: number; originDelayMs?: number; receiverOrigin?: number; initialIdleMs?: number } = {}): Model {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const link = createLink({ rateBps: 4_000_000, queueBytes: 64 * 1024 * 1024,
    schedule: [{ atMs: options.stepMs ?? 600, rateBps: 1_000_000 }] }, { recordPackets: true });
  now += options.originDelayMs ?? 37;
  try {
    for (let i = 0; i < 400; i++) {
      if (i === 1 && options.initialIdleMs !== undefined) now += 2.4 + options.initialIdleMs;
      const packet = Buffer.alloc(1200); packet.writeUInt32BE(i, 0);
      link.enqueue(packet, () => { throw new Error('Controlled planner must not release packets'); });
    }
    const stats = link.stats();
    expect(stats.deliveredPackets).toBe(0); expect(stats.packets).toHaveLength(400);
    const packets = stats.packets!.map(row => ({ ...row, actualMs: row.intendedMs!, lateMs: 0 }));
    const receiverOrigin = options.receiverOrigin ?? 1_000_000;
    const firstIntended = packets[0]!.intendedMs!;
    const arrivals = packets.map(row => ({ seq: row.index, size: row.size,
      atMs: receiverOrigin + row.intendedMs! - firstIntended }));
    // Only serializer plans come from the actual source. Completed-release
    // counters and release/receive timestamps below are synthetic test models.
    return { sent: 400, down: { ...stats, packets, deliveredPackets: 400, deliveredBytes: 400 * 1200 }, arrivals };
  } finally { link.close(); }
}
function check(p: Model) { return checkScheduleTransition(p.arrivals, p.down, p.sent); }
function rate(arrivals: readonly ScheduleArrival[]): number {
  return arrivals.slice(1).reduce((sum, item) => sum + item.size, 0) * 8000 / (arrivals.at(-1)!.atMs - arrivals[0]!.atMs);
}
function rateWindows(p: Model) {
  const origin = p.arrivals[0]!.atMs;
  const before = rate(p.arrivals.filter(item => item.atMs - origin > 50 && item.atMs - origin < 550));
  const after = rate(p.arrivals.filter(item => item.atMs - origin > 650 && item.atMs - origin < 1150));
  expect(Math.abs(before / 4_000_000 - 1)).toBeLessThan(0.05);
  expect(Math.abs(after / 1_000_000 - 1)).toBeLessThan(0.05);
  return { before, after };
}
function shiftReceive(p: Model, index: number, shiftMs: number) {
  const target = p.arrivals[index]!.atMs + shiftMs;
  p.arrivals = p.arrivals.map((row, i) => i < index ? row
    : { ...row, atMs: target + (row.atMs - p.arrivals[index]!.atMs) });
}
function shiftRelease(p: Model, index: number, shiftMs: number) {
  const packets = p.down.packets!, target = packets[index]!.actualMs! + shiftMs;
  p.down = { ...p.down, packets: packets.map((row, i) => {
    if (i < index) return row;
    const actualMs = target + (row.actualMs! - packets[index]!.actualMs!);
    return { ...row, actualMs, lateMs: actualMs - row.intendedMs! };
  }) };
  shiftReceive(p, index, shiftMs);
}
function legacyOnset(arrivals: readonly ScheduleArrival[]) {
  const origin = arrivals[0]!.atMs;
  return arrivals.slice(1).map((item, i) => ({ atMs: item.atMs - origin, gapMs: item.atMs - arrivals[i]!.atMs }))
    .find(gap => gap.atMs > 300 && gap.gapMs > 5)!.atMs;
}

describe('corrected schedule oracle, no native traffic', () => {
  it('healthy600ms plan selects first post-boundary packet, not the one ending at600', () => {
    const p = plan(), result = check(p); rateWindows(p);
    expect(result.packetIndex).toBe(250); expect(result.kind).toBe('starts-at-boundary');
    expect(result.finishFromFirstEnqueueMs).toBeCloseTo(609.6, 7);
    expect(result.releaseErrorMs).toBeCloseTo(9.6, 7); expect(result.receiveErrorMs).toBeCloseTo(7.2, 7);

  });

  it('valid600ms plan plus earlier receiver pause is accepted, despite old unrelated-gap false onset', () => {
    const p = plan(), first = p.arrivals[0]!.atMs;
    p.arrivals = p.arrivals.map(row => ({ ...row, atMs:
      row.atMs - first >= 390 && row.atMs - first < 398 ? first + 398 : row.atMs }));
    rateWindows(p); const result = check(p), old = legacyOnset(p.arrivals);
    expect(old).toBeCloseTo(398, 7); expect(Math.abs(old - 600)).toBeGreaterThan(15);
    expect(result.packetIndex).toBe(250); expect(result.receiveErrorMs).toBeCloseTo(7.2, 7);

  });

  for (const stepMs of [580, 620]) it(`actual${stepMs}ms capacity change is refused although rate windows pass`, () => {
    const p = plan({ stepMs }); rateWindows(p);
    expect(() => check(p)).toThrow(/Capacity integral disagrees/);

  });

  it('>15ms extra release delay at the boundary is refused', () => {
    const p = plan(), crossing = check(p).packetIndex;
    shiftRelease(p, crossing, 16); rateWindows(p);
    expect(() => check(p)).toThrow(/Boundary release-call endpoint exceeds <15ms/);

  });
  it('>15ms extra receive delay at the same boundary packet is refused', () => {
    const p = plan(), crossing = check(p).packetIndex;
    shiftReceive(p, crossing, 16); rateWindows(p);
    expect(() => check(p)).toThrow(/Boundary receive endpoint exceeds <15ms/);

  });
  it('exact15ms release endpoint error is not accepted as less than15', () => {
    const p = plan(), result = check(p);
    shiftRelease(p, result.packetIndex, 15 - result.releaseErrorMs);
    expect(() => check(p)).toThrow(/Boundary release-call endpoint exceeds <15ms/);
  });
  it('exact15ms receive endpoint error is not accepted as less than15', () => {
    const p = plan(), result = check(p);
    shiftReceive(p, result.packetIndex, 15 - result.receiveErrorMs);
    expect(() => check(p)).toThrow(/Boundary receive endpoint exceeds <15ms/);
  });

  it('a genuine partially serialized crossing packet is selected without assuming a full slow-packet duration', () => {
    const p = plan({ initialIdleMs: 0.7 }), result = check(p); rateWindows(p);
    expect(result.kind).toBe('straddles-boundary'); expect(result.packetIndex).toBe(249);
    expect(result.startFromFirstEnqueueMs).toBeCloseTo(598.3, 7);
    expect(result.finishFromFirstEnqueueMs).toBeCloseTo(602.8, 7);

  });
  it('>15ms receive drift on a near-complete crossing fails even if its raw endpoint still fits15ms', () => {
    const p = plan({ initialIdleMs: 0.025 }), initial = check(p);
    expect(initial.finishFromFirstEnqueueMs).toBeCloseTo(600.1, 6);
    shiftReceive(p, initial.packetIndex, 16); rateWindows(p);
    const endpointError = p.arrivals[initial.packetIndex]!.atMs - p.arrivals[0]!.atMs - 600;
    expect(Math.abs(endpointError)).toBeLessThan(15);
    expect(() => check(p)).toThrow(/Boundary receive drift exceeds <15ms/);

  });
  it('different relative enqueue and absolute receiver origins do not alter timing errors', () => {
    const a = check(plan({ originDelayMs: 0, receiverOrigin: 100_000 }));
    const b = check(plan({ originDelayMs: 137, receiverOrigin: 9_000_000 }));
    expect(a.packetIndex).toBe(b.packetIndex);
    expect(a.releaseErrorMs).toBeCloseTo(b.releaseErrorMs, 6);
    expect(a.receiveErrorMs).toBeCloseTo(b.receiveErrorMs, 6);
  });
  it('missing rows cannot establish correspondence', () => {
    const p = plan(); p.arrivals.pop(); expect(() => check(p)).toThrow(/Incomplete ordinal evidence/);
  });
  it('equal counts with an unrelated/reordered receiver identity cannot establish correspondence', () => {
    const p = plan(); p.arrivals[250] = { ...p.arrivals[250]!, seq: 251 };
    expect(() => check(p)).toThrow(/Incomplete ordinal evidence at packet250|Incomplete ordinal evidence at packet 250/);
  });
  it('an idle interval spanning600ms is insufficient transition evidence', () => {
    const p = plan({ initialIdleMs: 700 });
    expect(() => check(p)).toThrow(/No busy packet spans\/starts at boundary/);
  });

});
