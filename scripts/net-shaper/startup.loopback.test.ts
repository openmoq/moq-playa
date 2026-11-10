import dgram from 'node:dgram';
import { afterEach, expect, it } from 'vitest';
import { createShaper } from './shaper.mjs';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Loopback test cleanup failed');
});

async function bind() {
  const socket = dgram.createSocket('udp4');
  cleanup.push(() => new Promise<void>(resolve => socket.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => { socket.off('error', reject); resolve(); });
  });
  return socket;
}

it('unwinds a real loopback bind refusal without closing the pre-existing owner', async () => {
  const owner = await bind();
  await expect(createShaper({ listen: owner.address().port, listenHost: '127.0.0.1',
    upstream: '127.0.0.1:9' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(owner.address().address).toBe('127.0.0.1');
  const healthy = await createShaper({ listenHost: '127.0.0.1', upstream: '127.0.0.1:9' });
  cleanup.push(() => healthy.close());
  await healthy.close();
});

it('relays one packet in both directions and closes owned client sockets once', async () => {
  const upstream = await bind();
  const client = await bind();
  const shaper = await createShaper({ listenHost: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    down: { delayMs: 1 }, up: { delayMs: 1 }, spinMs: 0 });
  cleanup.push(() => shaper.close());
  upstream.on('message', (packet, from) => {
    expect(from.address).toBe('127.0.0.1');
    upstream.send(packet, from.port, '127.0.0.1');
  });
  const received = new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => { client.off('message', message); reject(new Error('Loopback echo timed out')); }, 2000);
    const message = (packet: Buffer) => { clearTimeout(timer); resolve(packet); };
    client.once('message', message);
  });
  client.send(Buffer.from('owned'), shaper.port, '127.0.0.1');
  expect((await received).toString()).toBe('owned');
  const first = shaper.close();
  expect(shaper.close()).toBe(first);
  const stats = await first;
  expect(stats.clients).toBe(1);
  expect(stats.up.deliveredPackets).toBe(1);
  expect(stats.down.deliveredPackets).toBe(1);
  expect(stats.errors).toEqual([]);
});
