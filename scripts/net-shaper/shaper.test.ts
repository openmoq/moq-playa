import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { createShaper, defaultQueueBytes, type LinkOptions, type LinkStats, type Shaper } from './shaper.mjs';

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

describe('net shaper', () => {
  it.each([1_000_000, 5_000_000, 30_000_000])('delivers %d bps within 5%% on loopback', async (rateBps) => {
    // Overload by 20% with room for the whole backlog, so the link never idles and never drops.
    const { arrivals, sent, down } = await run({ rateBps, queueBytes: 64 * 1024 * 1024 }, rateBps * 1.2, 1500);
    expect(arrivals.length).toBe(sent);
    expect(down.tailPackets).toBe(0);
    const measured = receivedBps(arrivals);
    const latenessP99 = down.lateness.p99Ms!;
    console.log(`rate ${rateBps}: received ${Math.round(measured)} bps (${((measured / rateBps - 1) * 100).toFixed(2)}%), `
      + `shaper ${down.deliveredBps} bps, lateness p50 ${down.lateness.p50Ms} p99 ${latenessP99} max ${down.lateness.maxMs.toFixed(3)} ms`);
    expect(Math.abs(measured / rateBps - 1)).toBeLessThan(0.05);
    expect(Math.abs(down.deliveredBps! / rateBps - 1)).toBeLessThan(0.05);
    if (rateBps === 30_000_000) expect(latenessP99).toBeLessThan(2);
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

  it('applies a schedule step at its time', async () => {
    const { arrivals, down } = await run({ rateBps: 4_000_000, queueBytes: 64 * 1024 * 1024,
      schedule: [{ atMs: 600, rateBps: 1_000_000 }] }, 5_000_000, 1200);
    // The step is relative to the link's first packet, which is the first offered one.
    const origin = arrivals[0]!.atMs;
    const before = arrivals.filter(item => item.atMs - origin > 50 && item.atMs - origin < 550);
    const after = arrivals.filter(item => item.atMs - origin > 650 && item.atMs - origin < 1150);
    expect(Math.abs(receivedBps(before) / 4_000_000 - 1)).toBeLessThan(0.05);
    expect(Math.abs(receivedBps(after) / 1_000_000 - 1)).toBeLessThan(0.05);
    // The serializer's change of pace lands at the scheduled instant.
    const gaps = arrivals.slice(1).map((item, i) => ({ atMs: item.atMs - origin, gapMs: item.atMs - arrivals[i]!.atMs }));
    const slowFrom = gaps.find(gap => gap.atMs > 300 && gap.gapMs > 5)!.atMs;
    expect(Math.abs(slowFrom - 600)).toBeLessThan(15);
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

  it('defaults the queue to about 100 ms or one BDP', () => {
    expect(defaultQueueBytes(1_000_000)).toBe(12500);
    expect(defaultQueueBytes(8_000_000, 100)).toBe(200000);
  });
});
