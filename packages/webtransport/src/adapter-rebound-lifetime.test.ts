import { describe, expect, it, vi } from 'vitest';
import { encodeObjectDatagram, encodeObjectDatagram18, varint } from '@openmoq/transport';
import type { SubscribeOptions } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';

type ReboundState = { terminatedAliases: Map<bigint, unknown>; reboundAliases?: Set<bigint> };
const state = (client: MoqtConnection) => client as unknown as ReboundState;

const enc = (value: string) => new TextEncoder().encode(value);

async function fixture(draft: 14 | 16 | 18 | 22, aliasForName = (_name: string) => 77n) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = [];
  const delivered = vi.fn();
  client.onError = error => errors.push(error.message);
  server.onError = error => errors.push(error.message);
  client.onDatagram = delivered;
  server.setLargestLocationProvider(() => null);
  server.onSubscribe = (id, _namespace, name) => {
    void server.acceptSubscribe(id, aliasForName(new TextDecoder().decode(name))).catch(error => errors.push(String(error)));
  };
  const setup = draft < 18 ? { maxRequestId: varint(1000n) } : undefined;
  await Promise.all([client.connect(a, setup), server.connect(b, setup)]);
  const writer = b.datagrams.writable!.getWriter();
  return {
    client, delivered, errors,
    subscribe: async (name = 'video', options?: SubscribeOptions) => {
      const id = await client.subscribe([enc('live')], enc(name), options);
      await flush(128);
      return id;
    },
    send: async (groupId: bigint, objectId = 0n) => {
      // Bypass the publisher's successor window to model old in-flight data.
      await writer.write((draft < 18 ? encodeObjectDatagram : encodeObjectDatagram18)({
        typeByte: 0, trackAlias: 77n, groupId, objectId, publisherPriority: 128,
        payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false,
      }));
      await flush(128);
    },
    close: async () => { writer.releaseLock(); await client.close(); await server.close(); },
  };
}

describe('rebound alias index lifetime', () => {
  it.each([14, 16, 18, 22] as const)('reclaims quiet aliases after their last owner and guard expire on draft %i', async draft => {
    const h = await fixture(draft, name => BigInt(name.slice(5)) + 100n);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 40; i++) {
        const first = await h.subscribe(`track${i}`);
        await h.client.unsubscribe(first); await flush(128);
        const successor = await h.subscribe(`track${i}`);
        await h.client.unsubscribe(successor); await flush(128);
      }
      await vi.advanceTimersByTimeAsync(10_001);
      await flush(128);
      expect(h.errors).toEqual([]);
      for (let alias = 100n; alias < 140n; alias++) {
        expect(h.client.session.getSubscriberRequestsForAlias(alias)).toEqual([]);
      }
      expect(state(h.client).terminatedAliases.size).toBe(0);
      expect(state(h.client).reboundAliases?.size ?? 0).toBe(0);
    } finally { vi.useRealTimers(); await h.close(); }
  });

  it.each([14, 16, 18, 22] as const)('preserves the successor range fence when clearing its old guard on draft %i', async draft => {
    const h = await fixture(draft);
    try {
      const first = await h.subscribe();
      await h.client.unsubscribe(first); await flush(128);
      expect(state(h.client).terminatedAliases.has(77n)).toBe(true);
      await h.subscribe('video', {
        subscriptionFilter: { type: 'AbsoluteRange', startGroup: 10n, startObject: 2n, endGroup: 11n },
      });
      // Acceptance marks the NEW owner rebound, then clears the OLD guard.
      expect(state(h.client).terminatedAliases.has(77n)).toBe(false);
      expect(state(h.client).reboundAliases?.has(77n)).toBe(true);
      await h.send(9n); await h.send(10n, 1n); await h.send(12n);
      expect(h.delivered).not.toHaveBeenCalled();
      await h.send(10n, 2n); await h.send(11n);
      expect(h.delivered).toHaveBeenCalledTimes(2);
      expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });
});
