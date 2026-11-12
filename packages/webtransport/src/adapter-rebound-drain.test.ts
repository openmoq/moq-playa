import { expect, it, vi } from 'vitest';
import { encodeObjectDatagram18, varint } from '@openmoq/transport';
import type { SubscriptionStateMachine } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import type { MoqtConnection } from './adapter.js';

type Internals = {
  reboundAliases?: Set<bigint>;
  reboundSubscribers?: WeakSet<SubscriptionStateMachine>;
  terminatedAliases: Map<bigint, unknown>;
  drainingAliases: Map<bigint, unknown>;
  clearTerminatedAlias(alias: bigint): void;
};
const state = (c: MoqtConnection) => c as unknown as Internals;

it('quiet terminal drain releases rebound indexes with their last owners (draft 18, 40 aliases)', async () => {
  const h = await connectedPair(18);
  const drained = vi.fn();
  h.server.setLargestLocationProvider(() => null);
  h.server.onSubscribe = (id, _ns, name) => {
    void h.server.acceptSubscribe(id, BigInt(new TextDecoder().decode(name).slice(5)) + 100n).catch(e => h.errors.push(e));
  };
  try {
    vi.useFakeTimers();
    for (let i = 0; i < 40; i++) {
      const first = await h.client.subscribe(ns('live'), nm(`track${i}`)); await flush(128);
      await h.client.unsubscribe(first); await flush(128);
      const successor = await h.client.subscribe(ns('live'), nm(`track${i}`), {
        terminalDelivery: 'drain', onDrained: drained,
      }); await flush(128);
      const owner = h.client.session.getSubscription(successor)!;
      expect(state(h.client).reboundSubscribers?.has(owner)).toBe(true);
      await h.server.publishDone(successor, varint(2n), 'complete'); await flush(128);
      await vi.advanceTimersByTimeAsync(30_001); await flush(256);
      expect(h.client.session.getSubscriberRequestsForAlias(BigInt(i) + 100n)).toEqual([]);
    }
    expect(drained).toHaveBeenCalledTimes(40);
    expect(h.errors).toEqual([]);
    expect(state(h.client).terminatedAliases.size).toBe(0);
    expect(state(h.client).drainingAliases.size).toBe(0);
    expect(state(h.client).reboundAliases?.size ?? 0).toBe(0);
  } finally { vi.useRealTimers(); await h.client.close(); await h.server.close(); }
});

it('paused rebound owner survives clearing with another live owner; last retirement reclaims it (draft 22)', async () => {
  const h = await connectedPair(22);
  const delivered = vi.fn(); h.client.onDatagram = delivered;
  h.server.setLargestLocationProvider(() => null);
  h.server.onSubscribe = id => { void h.server.acceptSubscribe(id, 77n).catch(e => h.errors.push(e)); };
  const writer = h.b.datagrams.writable!.getWriter();
  const send = async (groupId: bigint) => {
    await writer.write(encodeObjectDatagram18({ typeByte: 0, trackAlias: 77n, groupId, objectId: 0n,
      publisherPriority: 128, payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false }));
    await flush(128);
  };
  try {
    const first = await h.client.subscribe(ns('live'), nm('video')); await flush(128);
    await h.client.unsubscribe(first); await flush(128);
    const rebound = await h.client.subscribe(ns('live'), nm('video')); await flush(128);
    await h.client.requestUpdate(rebound, { forward: 0 }); await flush(128);
    const other = await h.client.subscribe(ns('live'), nm('video'), {
      subscriptionFilter: { type: 'AbsoluteRange', startGroup: 20n, startObject: 0n, endGroup: 21n },
    }); await flush(128);
    expect(h.client.session.getSubscriberRequestsForAlias(77n)).toHaveLength(2);
    state(h.client).clearTerminatedAlias(77n);
    expect(state(h.client).reboundAliases?.has(77n)).toBe(true);
    await send(19n); expect(delivered).not.toHaveBeenCalled();
    await send(20n); expect(delivered).toHaveBeenCalledOnce();
    await h.client.unsubscribe(other); await flush(128);
    state(h.client).clearTerminatedAlias(77n);
    expect(state(h.client).reboundAliases?.has(77n)).toBe(true);
    await send(20n); expect(delivered).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    await h.client.unsubscribe(rebound); await flush(128);
    await vi.advanceTimersByTimeAsync(10_001); await flush(128);
    expect(h.errors).toEqual([]);
    expect(state(h.client).reboundAliases?.size ?? 0).toBe(0);
  } finally { vi.useRealTimers(); writer.releaseLock(); await h.client.close(); await h.server.close(); }
});

it('ordinary aliases preserve successor receive heads after another alias rebounds and close from receipt clears both indexes (draft 18)', async () => {
  const h = await connectedPair(18);
  h.server.setLargestLocationProvider(() => null);
  h.server.onSubscribe = (id, _ns, name) => {
    void h.server.acceptSubscribe(id, new TextDecoder().decode(name) === 'ordinary' ? 88n : 77n).catch(e => h.errors.push(e));
  };
  const delivered = vi.fn(); h.client.onDatagram = delivered;
  const writer = h.b.datagrams.writable!.getWriter();
  try {
    const first = await h.client.subscribe(ns('live'), nm('video')); await flush(128);
    await h.client.unsubscribe(first); await flush(128);
    await h.client.subscribe(ns('live'), nm('video')); await flush(128);
    await h.client.subscribe(ns('live'), nm('ordinary')); await flush(128);
    expect(state(h.client).reboundAliases?.has(77n)).toBe(true);
    for (let objectId = 0n; objectId < 3n; objectId++) {
      await writer.write(encodeObjectDatagram18({ typeByte: 0, trackAlias: 88n, groupId: 1n, objectId,
        publisherPriority: 128, payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false }));
      await flush(128);
    }
    expect(delivered).toHaveBeenCalledTimes(3);
    let closing: Promise<void> | undefined;
    const off = h.client.observeObjectReceipts(() => { closing = h.client.close(); });
    await writer.write(encodeObjectDatagram18({ typeByte: 0, trackAlias: 77n, groupId: 1n, objectId: 0n,
      publisherPriority: 128, payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false }));
    await flush(128); await closing; off();
    expect(delivered).toHaveBeenCalledTimes(3);
    expect(state(h.client).reboundAliases).toBeUndefined();
    expect(state(h.client).reboundSubscribers).toBeUndefined();
    expect(h.errors).toEqual([]);
  } finally { writer.releaseLock(); await h.client.close(); await h.server.close(); }
});
