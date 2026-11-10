import dgram from 'node:dgram';
import { writeScheduleCapture } from './schedule-test-artifacts.js';
import { checkScheduleTransition } from './schedule-test-oracle.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createShaper, type LinkOptions, type LinkStats, type Shaper } from './shaper.mjs';

// Real UDP on loopback: a fake relay behind the shaper sends sequence-numbered
// packets at an offered load, and a client socket records what arrives.
const PACKET = 1200;
const open: Array<{ close(): unknown }> = [];
afterEach(async () => { for (const item of open.splice(0)) await item.close(); });

interface Arrival { seq: number; atMs: number; size: number }
interface Run { shaper: Shaper; arrivals: Arrival[]; sent: number; down: LinkStats }

async function bind(): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  socket.setRecvBufferSize(4 * 1024 * 1024);
  socket.setSendBufferSize(4 * 1024 * 1024);
  open.push({ close: () => new Promise<void>(resolve => socket.close(() => resolve())) });
  return socket;
}

/** Offer `offeredBps` downlink for `durationMs` and wait for the link to drain. */
async function run(down: LinkOptions, offeredBps: number, durationMs: number, extra: { seed?: number; recordPackets?: boolean } = {}): Promise<Run> {
  const relay = await bind();
  const client = await bind();
  const shaper = await createShaper({ upstream: `127.0.0.1:${relay.address().port}`, down, ...extra });
  open.push(shaper);
  const arrivals: Arrival[] = [];
  client.on('message', packet => arrivals.push({ seq: packet.readUInt32BE(0), atMs: performance.now(), size: packet.length }));
  const peer = new Promise<dgram.RemoteInfo>(resolve => relay.once('message', (_packet, from) => resolve(from)));
  client.send(Buffer.from('hello'), shaper.port, '127.0.0.1');
  const { port } = await peer;
  // Offered load is paced from its own virtual clock, so the sender's timer
  // lateness only bunches packets, never changes the offered average.
  let sent = 0;
  const start = performance.now();
  await new Promise<void>(resolve => {
    const tick = () => {
      const elapsed = performance.now() - start;
      const owed = Math.floor(Math.min(elapsed, durationMs) * offeredBps / 8000 / PACKET);
      while (sent < owed) {
        const packet = Buffer.alloc(PACKET);
        packet.writeUInt32BE(sent++, 0);
        relay.send(packet, port, '127.0.0.1');
      }
      if (elapsed >= durationMs) resolve(); else setTimeout(tick, 1);
    };
    tick();
  });
  // Drain: wait until the link has nothing queued or in flight, then let loopback settle.
  for (;;) {
    const { queue } = shaper.stats().down;
    if (queue.packets === 0 && queue.inFlightPackets === 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  return { shaper, arrivals, sent, down: shaper.stats().down };
}

/** Receive-side rate: bytes after the first arrival over the first-to-last span. */
function receivedBps(arrivals: Arrival[]): number {
  const bytes = arrivals.slice(1).reduce((sum, item) => sum + item.size, 0);
  return bytes * 8000 / (arrivals.at(-1)!.atMs - arrivals[0]!.atMs);
}

/** Postmeasurement diagnostics only: capture BEFORE assertions; never infer identity from a partial count. */
async function captureScheduleDiagnostic(arrivals: Arrival[], down: LinkStats, sent: number): Promise<void> {
  const origin = arrivals[0]?.atMs;
  const gaps = origin === undefined ? [] : arrivals.slice(1).map((item, i) => ({
    index: i + 1, seq: item.seq, previousSeq: arrivals[i]!.seq,
    atMs: item.atMs - origin, gapMs: item.atMs - arrivals[i]!.atMs,
  }));
  const selectedGap = gaps.find(gap => gap.atMs > 300 && gap.gapMs > 5) ?? null;
  const before = origin === undefined ? [] : arrivals.filter(item => item.atMs - origin > 50 && item.atMs - origin < 550);
  const after = origin === undefined ? [] : arrivals.filter(item => item.atMs - origin > 650 && item.atMs - origin < 1150);
  const raw = { capturedAfterMeasurement: true, clock: 'performance.now milliseconds',
    arrivals, sent, down, receiveOriginMs: origin ?? null, gaps, legacySelectedGap: selectedGap,
    legacySignedOnsetErrorMs: selectedGap === null ? null : selectedGap.atMs - 600,
    beforeRateBps: before.length > 1 ? receivedBps(before) : null,
    afterRateBps: after.length > 1 ? receivedBps(after) : null };
  const artifact = await writeScheduleCapture(raw);
  console.info(`net-shaper schedule capture: ${artifact}`);
  // Only after persisting every observed value, validate the full ordinal
  // premise. Cross-phase association/analysis happens offline, not on the hot path.
  expect(arrivals).toHaveLength(sent);
  expect(down.packets).toHaveLength(sent);
  expect(down.offeredPackets).toBe(sent); expect(down.deliveredPackets).toBe(sent);
  expect(down.lossPackets).toBe(0); expect(down.tailPackets).toBe(0);
  const expected = Array.from({ length: sent }, (_unused, index) => index);
  expect(arrivals.map(item => item.seq)).toEqual(expected);
  expect(down.packets!.map(item => item.index)).toEqual(expected);
  expect(arrivals.every(item => item.size === PACKET && Number.isFinite(item.atMs))).toBe(true);
  expect(down.packets!.every(item => item.size === PACKET && item.dropped === undefined
    && Number.isFinite(item.enqueuedMs) && Number.isFinite(item.finishMs)
    && Number.isFinite(item.intendedMs) && Number.isFinite(item.actualMs))).toBe(true);
}

describe('net shaper', () => {
  it.each([1_000_000, 5_000_000, 30_000_000])('delivers %d bps within 5%% on loopback', async (rateBps) => {
    // Overload by 20% with room for the whole backlog, so the link never idles and never drops.
    const { arrivals, sent, down } = await run({ rateBps, queueBytes: 64 * 1024 * 1024 }, rateBps * 1.2, 1500);
    expect(arrivals.length).toBe(sent);
    expect(down.tailPackets).toBe(0);
    const measured = receivedBps(arrivals);
    console.log(`rate ${rateBps}: received ${Math.round(measured)} bps (${((measured / rateBps - 1) * 100).toFixed(2)}%), `
      + `shaper ${down.deliveredBps} bps, lateness p50 ${down.lateness.p50Ms} p99 ${down.lateness.p99Ms} max ${down.lateness.maxMs.toFixed(3)} ms`);
    expect(Math.abs(measured / rateBps - 1)).toBeLessThan(0.05);
    expect(Math.abs(down.deliveredBps! / rateBps - 1)).toBeLessThan(0.05);
  });

  // Host-sensitive: an idle machine measures p99 well under 1 ms, but parallel
  // test workers or other load can deschedule the process for tens of ms.
  // Explicit host-performance lane: one attempt, retain any failure.
  it('adds under 2 ms p99 send lateness at 30 Mbps', { retry: 0 }, async () => {
    const { down } = await run({ rateBps: 30_000_000, queueBytes: 64 * 1024 * 1024 }, 36_000_000, 1500);
    console.log(`30 Mbps lateness p50 ${down.lateness.p50Ms} p90 ${down.lateness.p90Ms} p99 ${down.lateness.p99Ms} max ${down.lateness.maxMs.toFixed(3)} ms`);
    expect(down.lateness.p99Ms!).toBeLessThan(2);
  });

  it('tail-drops overload at a bounded queue', async () => {
    const queueBytes = 20 * PACKET;
    const { arrivals, sent, down } = await run({ rateBps: 2_000_000, queueBytes }, 4_000_000, 1500);
    expect(down.tailPackets).toBeGreaterThan(sent * 0.35);
    expect(down.tailPackets).toBeLessThan(sent * 0.65);
    expect(arrivals.length).toBe(sent - down.tailPackets);
    expect(down.queue.maxBytes).toBeLessThanOrEqual(queueBytes);
    expect(down.queue.maxBytes).toBeGreaterThan(queueBytes - 2 * PACKET);
    expect(Math.abs(receivedBps(arrivals) / 2_000_000 - 1)).toBeLessThan(0.05);
  });

  it('jitters without reordering', async () => {
    const { arrivals, sent, down } = await run({ rateBps: 5_000_000, delayMs: 20, jitterMs: 15 }, 4_000_000, 1000, { recordPackets: true });
    expect(arrivals.length).toBe(sent);
    expect(arrivals.map(item => item.seq)).toEqual([...Array(sent).keys()]);
    const packets = down.packets!;
    expect(packets.some(item => Math.abs(item.jitterMs!) > 10)).toBe(true);
    for (let i = 1; i < packets.length; i++) {
      expect(packets[i]!.intendedMs!).toBeGreaterThanOrEqual(packets[i - 1]!.intendedMs!);
      expect(packets[i]!.actualMs!).toBeGreaterThanOrEqual(packets[i - 1]!.actualMs!);
      expect(packets[i]!.intendedMs!).toBeGreaterThanOrEqual(packets[i]!.finishMs!);
    }
  });

  it('schedule step: serializer virtual-finish timing', async () => {
    const { arrivals, down } = await run({ rateBps: 4_000_000, queueBytes: 64 * 1024 * 1024,
      schedule: [{ atMs: 600, rateBps: 1_000_000 }] }, 5_000_000, 1200, { recordPackets: true });
    // The step is relative to the link's first packet, which is the first offered one.
    const origin = arrivals[0]!.atMs;
    const before = arrivals.filter(item => item.atMs - origin > 50 && item.atMs - origin < 550);
    const after = arrivals.filter(item => item.atMs - origin > 650 && item.atMs - origin < 1150);
    expect(Math.abs(receivedBps(before) / 4_000_000 - 1)).toBeLessThan(0.05);
    expect(Math.abs(receivedBps(after) / 1_000_000 - 1)).toBeLessThan(0.05);
    // The serializer's change of pace lands at the scheduled instant. Read it
    // from the shaper's own serialization times, not from arrivals: those
    // bunch whenever the test process's event loop stalls. A packet that
    // found the queue non-empty was serialized back to back with the one
    // before, so their spacing is its size at the rate then in force.
    const packets = down.packets!.filter(item => item.dropped === undefined);
    const slow = packets.find((item, i) => i > 0 && item.queueBytes! > 0
      && item.finishMs! - packets[i - 1]!.finishMs! > 5)!;
    expect(Math.abs(slow.finishMs! - packets[0]!.finishMs! - 600)).toBeLessThan(15);
    expect(down.timeline.some(sample => sample.rateBps === 1_000_000)).toBe(true);
  });

  it('schedule step: release and receive endpoint timing', async () => {
    const { arrivals, down, sent } = await run({ rateBps: 4_000_000, queueBytes: 64 * 1024 * 1024,
      schedule: [{ atMs: 600, rateBps: 1_000_000 }] }, 5_000_000, 1200, { recordPackets: true });
    await captureScheduleDiagnostic(arrivals, down, sent);
    // The step is relative to the link's first packet, which is the first offered one.
    const origin = arrivals[0]!.atMs;
    const before = arrivals.filter(item => item.atMs - origin > 50 && item.atMs - origin < 550);
    const after = arrivals.filter(item => item.atMs - origin > 650 && item.atMs - origin < 1150);
    expect(Math.abs(receivedBps(before) / 4_000_000 - 1)).toBeLessThan(0.05);
    expect(Math.abs(receivedBps(after) / 1_000_000 - 1)).toBeLessThan(0.05);
    // The fixed-profile oracle selects from the validated serialization plan,
    // then checks that same packet's release-call and receive endpoints (<15ms).
    checkScheduleTransition(arrivals, down, sent);
    expect(down.timeline.some(sample => sample.rateBps === 1_000_000)).toBe(true);
  });

  it('is deterministic for a fixed seed', async () => {
    const pattern = async (seed: number) => {
      const { down } = await run({ rateBps: 20_000_000, delayMs: 5, jitterMs: 3, lossPct: 10 }, 5_000_000, 400, { seed, recordPackets: true });
      return down.packets!.map(item => item.dropped === 'loss' ? 'L' : item.jitterMs!.toFixed(6));
    };
    const first = await pattern(7);
    const second = await pattern(7);
    const other = await pattern(8);
    expect(first.length).toBeGreaterThan(100);
    expect(second).toEqual(first);
    expect(other).not.toEqual(first.slice(0, other.length));
    const losses = first.filter(item => item === 'L').length;
    expect(losses / first.length).toBeGreaterThan(0.04);
    expect(losses / first.length).toBeLessThan(0.18);
  });

});
