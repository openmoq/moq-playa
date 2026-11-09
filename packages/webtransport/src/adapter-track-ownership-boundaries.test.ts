import { describe, expect, it, vi } from 'vitest';
import { MessageParam, writeLocation, locationEncodingLength, varint, type Parameters } from '@openmoq/transport';
import { MoqtConnection, type TrackSubscription } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';

type Draft = 14 | 16 | 18 | 22;
const enc = new TextEncoder(), ns = [enc.encode('media')], name = enc.encode('video');
const turn = async () => { await flush(128); await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(128); };
async function pair(draft: Draft, auto = true) {
  const { a, b } = createLoopback(), client = new MoqtConnection(draft, { terminatedAliasTtlMs: 50 });
  const server = new MoqtConnection(draft, { role: 'server' });
  const requests: bigint[] = [], errors: Error[] = [];
  client.onError = server.onError = error => { errors.push(error); };
  server.setLargestLocationProvider(() => null);
  server.onSubscribe = id => { requests.push(id); if (auto) void server.acceptSubscribe(id, 77n).catch(error => { errors.push(error); }); };
  await Promise.all([client.connect(a), server.connect(b, draft < 18 ? { maxRequestId: varint(1000) } : {})]);
  return { a, b, client, server, requests, errors, async close() { await client.close(); await server.close(); } };
}

describe.each([14, 16, 18, 22] as const)('raw subscription metadata and retirement draft %i', draft => {
  it('initial ACK retains the exact wire-width boundary as frozen bigints', async () => {
    const f = await pair(draft, false), limit = draft < 18 ? (1n << 62n) - 1n : (1n << 64n) - 1n;
    const largest = { group: limit, object: limit }, parameters: Parameters = new Map();
    if (draft < 18) {
      const bytes = new Uint8Array(locationEncodingLength(largest)); writeLocation(largest, bytes, 0);
      parameters.set(MessageParam.LARGEST_OBJECT, [bytes]);
    } else parameters.set(MessageParam.LARGEST_OBJECT, [largest]);
    const pending = f.client.subscribeTrack(ns, name); void pending.catch(() => {});
    try {
      await flush(128); await f.server.acceptSubscribe(f.requests[0]!, 77n, { parameters });
      const sub = await pending;
      expect(sub.initialLargestLocation).toEqual({ groupId: limit, objectId: limit });
      expect(Object.isFrozen(sub.initialLargestLocation)).toBe(true);
      await sub.unsubscribe(); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('session close reentry during parked replay cannot publish later DATA/FIN or onDrained', async () => {
    const f = await pair(draft, false), events: string[] = []; let closed: Promise<void> | undefined;
    const pending = f.client.subscribeTrack(ns, name, { terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams',
      onObject: () => { events.push('object'); closed = f.client.close(); void closed.catch(() => {}); },
      onSubgroupClosed: () => events.push('fin'), onDrained: () => events.push('drained') });
    void pending.catch(() => {});
    try {
      await flush(128); const id = f.requests[0]!, response = f.a.bidiOut[0]!.in; response.faults.hold = true;
      await f.server.acceptSubscribe(id, 77n);
      const stream = await f.server.openSubgroup(77n, 1n, 0n);
      await f.server.sendObject(stream, 0n, Uint8Array.of(1)); await f.server.sendObject(stream, 1n, Uint8Array.of(2));
      await f.server.closeSubgroup(stream); await flush(128);
      await f.server.publishDone(id, varint(2), 'finite'); response.releaseHeld(); await pending;
      await turn(); await closed;
      expect(events).toEqual(['object']); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});

it.each([18, 22] as const)('draft %i throwing ownership callback cannot remove a reentrant successor', async draft => {
  const f = await pair(draft), expected = new Error('old unsent owner failed'); let next: Promise<TrackSubscription> | undefined;
  try {
    await expect(f.client.subscribeTrack(ns, name, { terminalDelivery: 'drain', onRequestId: () => {
      next = f.client.subscribeTrack(ns, name); void next.catch(() => {}); throw expected;
    } })).rejects.toBe(expected);
    const sub = await next!;
    expect(f.requests).toEqual([sub.requestId]); expect(f.client.session.getSubscription(0n)).toBeUndefined();
    const received = vi.fn(); sub.onObject = received;
    const stream = await f.server.openSubgroup(77n, 2n, 0n);
    await f.server.sendObject(stream, 0n, Uint8Array.of(7)); await f.server.closeSubgroup(stream); await turn();
    expect(received).toHaveBeenCalledOnce(); expect(f.client.session.state).toBe('established'); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

it('draft22 retained raw member drains independently while a same-alias peer and successor remain healthy', async () => {
  const f = await pair(22), oldData = vi.fn(), oldFin = vi.fn(), peerData = vi.fn(), successorData = vi.fn();
  let next: Promise<TrackSubscription> | undefined;
  const drained = vi.fn(() => { next = f.client.subscribeTrack(ns, name, { onObject: successorData }); void next.catch(() => {}); });
  try {
    const old = await f.client.subscribeTrack(ns, name, { terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams',
      onObject: oldData, onSubgroupClosed: oldFin, onDrained: drained });
    const peer = await f.client.subscribeTrack(ns, name, { onObject: peerData });
    vi.useFakeTimers();
    const stream = await f.server.openSubgroup(77n, 3n, 0n, { requestId: old.requestId }), pipe = f.b.uniOut.at(-1)!; pipe.faults.hold = true;
    await f.server.sendObject(stream, 0n, Uint8Array.of(1)); await f.server.closeSubgroup(stream);
    await f.server.publishDone(old.requestId, varint(2), 'finite'); await flush(128);
    expect(oldData).not.toHaveBeenCalled(); expect(drained).not.toHaveBeenCalled();
    pipe.releaseHeld(); await flush(128); await vi.advanceTimersByTimeAsync(0);
    expect(oldData).toHaveBeenCalledOnce(); expect(oldFin).toHaveBeenCalledOnce(); expect(peerData).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60); await flush(128); expect(drained).toHaveBeenCalledOnce();
    const successor = await next!; expect(successor.requestId).not.toBe(peer.requestId);
    const fresh = await f.server.openSubgroup(77n, 4n, 0n, { requestId: peer.requestId });
    await f.server.sendObject(fresh, 0n, Uint8Array.of(2)); await f.server.closeSubgroup(fresh); await flush(128);
    expect(peerData).toHaveBeenCalledTimes(2); expect(successorData).toHaveBeenCalledOnce(); expect(oldData).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
  } finally { await f.close(); vi.useRealTimers(); }
});
