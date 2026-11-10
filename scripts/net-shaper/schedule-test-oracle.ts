/** Test-only oracle for the fixed 4Mbps -> 1Mbps at600ms UDP fixture. */
import type { LinkStats } from './shaper.mjs';
export interface ScheduleArrival { readonly seq: number; readonly atMs: number; readonly size: number }
export interface ScheduleTransition {
  readonly packetIndex: number;
  readonly kind: 'straddles-boundary' | 'starts-at-boundary';
  readonly boundaryMs: number;
  readonly startFromFirstEnqueueMs: number;
  readonly finishFromFirstEnqueueMs: number;
  readonly releaseFromFirstEnqueueMs: number;
  readonly receiveFromFirstArrivalMs: number;
  readonly releaseErrorMs: number;
  readonly receiveErrorMs: number;
  readonly releaseDriftMs: number;
  readonly receiveDriftMs: number;
  readonly maxPlanBitError: number;
}
const STEP_MS = 600, FAST_BPS = 4_000_000, SLOW_BPS = 1_000_000, PACKET_BYTES = 1200;
const BOUND_MS = 15;
// Only a floating-arithmetic consistency tolerance, never a timer allowance.
const PLAN_BIT_ROUNDING = 0.000001;
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function finite(value: unknown, name: string): number {
  requireEvidence(typeof value === 'number' && Number.isFinite(value), `Missing/nonfinite ${name}`);
  return value;
}
function timeRounding(a: number, b: number): number {
  return Math.max(64 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)),
    PLAN_BIT_ROUNDING * 1000 / SLOW_BPS);
}

export function checkScheduleTransition(arrivals: readonly ScheduleArrival[], down: LinkStats, sent: number): ScheduleTransition {
  requireEvidence(Number.isSafeInteger(sent) && sent >= 2, 'Incomplete ordinal evidence: offered count');
  const records = down.packets;
  requireEvidence(records && records.length === sent && arrivals.length === sent
    && down.offeredPackets === sent && down.deliveredPackets === sent,
  'Incomplete ordinal evidence: offered/recorded/released/received counts');
  requireEvidence(down.lossPackets === 0 && down.tailPackets === 0, 'Incomplete ordinal evidence: dropped packets');
  const origin = finite(down.firstPacketMs, 'first-enqueue origin'), boundary = origin + STEP_MS;
  const firstArrival = finite(arrivals[0]?.atMs, 'first receive callback');
  // Validate ALL counts/ordinals/sizes before any cross-phase correspondence.
  for (let i = 0; i < sent; i++) {
    const row = records[i]!, arrival = arrivals[i]!;
    requireEvidence(row.index === i && arrival.seq === i && row.size === PACKET_BYTES
      && arrival.size === PACKET_BYTES && row.dropped === undefined,
    `Incomplete ordinal evidence at packet ${i}`);
    finite(row.enqueuedMs, 'enqueue'); finite(row.finishMs, 'finish'); finite(row.intendedMs, 'intended');
    finite(row.actualMs, 'release-call sample'); finite(arrival.atMs, 'receive callback');
  }
  const rows: Array<{ start: number; finish: number; intended: number; actual: number }> = [];
  let priorFinish = -Infinity, priorActual = -Infinity, priorReceive = -Infinity;
  let maxPlanBitError = 0;
  for (let i = 0; i < sent; i++) {
    const row = records[i]!, arrival = arrivals[i]!;
    const enqueued = finite(row.enqueuedMs, 'enqueue');
    const start = Math.max(enqueued, priorFinish), finish = finite(row.finishMs, 'finish');
    const intended = finite(row.intendedMs, 'intended'), actual = finite(row.actualMs, 'release-call sample');
    requireEvidence(finish >= start && actual >= priorActual && arrival.atMs >= priorReceive,
      `Nonmonotonic packet timing at ${i}`);
    requireEvidence(Math.abs(intended - finish) <= timeRounding(intended, finish),
      'Schedule fixture requires zero propagation/jitter');
    requireEvidence(actual + timeRounding(actual, intended) >= intended, 'Release-call sample precedes planned due time');
    if (i === 0) requireEvidence(Math.abs(enqueued - origin) <= timeRounding(enqueued, origin), 'First-enqueue origin mismatch');
    const fastMs = Math.max(0, Math.min(finish, boundary) - start);
    const slowMs = Math.max(0, finish - Math.max(start, boundary));
    const bitError = Math.abs(fastMs * FAST_BPS / 1000 + slowMs * SLOW_BPS / 1000 - row.size * 8);
    maxPlanBitError = Math.max(maxPlanBitError, bitError);
    requireEvidence(bitError < PLAN_BIT_ROUNDING, `Capacity integral disagrees with expected600ms step at packet ${i}: ${bitError} bits`);
    rows.push({ start, finish, intended, actual });
    priorFinish = finish; priorActual = actual; priorReceive = arrival.atMs;
  }
  // A packet finishing exactly AT the boundary used only the old rate. Select
  // the first packet carrying any post-boundary serialization, not a receive gap.
  const index = rows.findIndex(row => row.finish - boundary > timeRounding(row.finish, boundary));
  requireEvidence(index >= 0, 'No serialized media beyond schedule boundary');
  const crossing = rows[index]!;
  requireEvidence(crossing.start - boundary <= timeRounding(crossing.start, boundary),
    'No busy packet spans/starts at boundary; onset cannot be witnessed across an idle interval');
  const releaseFromFirstEnqueueMs = crossing.actual - origin;
  const receiveFromFirstArrivalMs = arrivals[index]!.atMs - firstArrival;
  const releaseErrorMs = releaseFromFirstEnqueueMs - STEP_MS;
  const receiveErrorMs = receiveFromFirstArrivalMs - STEP_MS;
  const releaseDriftMs = crossing.actual - crossing.intended;
  const receiveDriftMs = receiveFromFirstArrivalMs - (crossing.intended - rows[0]!.intended);
  // Preserve the endpoint budget, including the crossing packet's remaining
  // serialization. Do NOT add its duration to15ms or subtract it from these errors.
  requireEvidence(Math.abs(releaseErrorMs) < BOUND_MS, `Boundary release-call endpoint exceeds <15ms: ${releaseErrorMs}ms`);
  requireEvidence(Math.abs(receiveErrorMs) < BOUND_MS, `Boundary receive endpoint exceeds <15ms: ${receiveErrorMs}ms`);
  requireEvidence(Math.abs(releaseDriftMs) < BOUND_MS, `Boundary release-call drift exceeds <15ms: ${releaseDriftMs}ms`);
  requireEvidence(Math.abs(receiveDriftMs) < BOUND_MS, `Boundary receive drift exceeds <15ms: ${receiveDriftMs}ms`);
  return { packetIndex: index,
    kind: Math.abs(crossing.start - boundary) <= timeRounding(crossing.start, boundary)
      ? 'starts-at-boundary' : 'straddles-boundary',
    boundaryMs: boundary, startFromFirstEnqueueMs: crossing.start - origin,
    finishFromFirstEnqueueMs: crossing.finish - origin, releaseFromFirstEnqueueMs,
    receiveFromFirstArrivalMs, releaseErrorMs, receiveErrorMs, releaseDriftMs, receiveDriftMs, maxPlanBitError };
}
