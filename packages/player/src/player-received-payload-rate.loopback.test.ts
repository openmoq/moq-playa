import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { fixture, readRate, observeReceiptSamples } from '../test-support/received-payload-fixture.js';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it.each(['equal', 'key-heavy'] as const)('actual root CMAF received payload at 4 Mbps is shape-independent: %s', async shape => {
  const f = await fixture();
  try {
    await f.accept();
    for (let index = 0; index < 250; index++) {
      f.setNow(1_000_000 + index * 40_000);
      await f.send(index, shape === 'equal' ? 20_000 : index % 25 === 0 ? 100_016 : 16_666);
      f.player.tick();
    }
    expect(f.receipts).toHaveLength(250);
    expect(f.receipts.reduce((sum, bytes) => sum + bytes, 0)).toBe(5_000_000);
    expect(f.delivered).toHaveLength(250); expect(f.appended).toHaveLength(250);
    expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]);
    expect(readRate(f.player), 'same actual received payload over ten seconds; private estimate only').toBeCloseTo(4000, 1);
  } finally { await f.close(); }
});

it('pre-ACK parked payload replay must not create a later receipt observation in the actual root estimator', async () => {
  const f = await fixture(), sampler = observeReceiptSamples(f.player);
  try {
    f.response.faults.hold = true;
    await f.server.acceptSubscribe(f.requests[0]!, 77n); await flush(128);
    expect(f.client.session.getSubscription(f.requests[0]!)?.state).toBe('pending');
    await f.send(0, 20_000); f.setNow(1_040_000); await f.send(1, 4_000_000);
    expect(f.receipts).toEqual([20_000, 4_000_000]);
    expect(f.delivered).toEqual([]); expect(f.appended).toEqual([]); expect(sampler.calls()).toEqual([]);
    f.setNow(10_000_000); f.response.releaseHeld(); await flush(128); await vi.advanceTimersByTimeAsync(1); await flush(128);
    expect(f.client.session.getSubscription(f.requests[0]!)?.state).toBe('established');
    expect(f.receipts).toEqual([20_000, 4_000_000]); // No new SDK receipt accompanied the replay.
    expect(f.delivered).toHaveLength(2); expect(f.appended).toHaveLength(2);
    expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]);
    expect(sampler.calls(), 'wire receipts happened before ACK; replay is delivery, not a new receipt at ten seconds').toEqual([]);
  } finally { sampler.restore(); await f.close(); }
});

it('accepted current-source payload produces one estimator observation per genuine wire receipt', async () => {
  const f = await fixture(), sampler = observeReceiptSamples(f.player);
  try {
    await f.accept();
    f.setNow(10_000_000); await f.send(0, 20_000);
    f.setNow(10_040_000); await f.send(1, 20_000);
    expect(f.receipts).toEqual([20_000, 20_000]); expect(f.delivered).toHaveLength(2); expect(f.appended).toHaveLength(2);
    expect(sampler.calls()).toEqual([[20_000, 10_000_000], [20_000, 10_040_000]]);
    expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]);
  } finally { sampler.restore(); await f.close(); }
});
