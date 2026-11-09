import { describe, expect, it, vi } from 'vitest';
import { MessageParam, varint, writeLocation, locationEncodingLength, type Parameters } from '@openmoq/transport';
import { MoqtConnection, type TrackSubscription, type TrackSubscribeOptions, type RequestOwnershipOptions, type TerminalDeliveryOptions } from './adapter.js';
import { catToken, type AuthorizationProvider } from './authorization.js';
import { createLoopback, flush, type LoopbackTransport } from './testkit/loopback.js';
import { ns, nm } from './testkit/pair.js';

type Draft = 14 | 16 | 18 | 22;
type Options = TrackSubscribeOptions;
type Raw = { sub: TrackSubscription; resolve: unknown };
type Internals = {
  rawSubscriptions: Map<bigint, Raw>;
  rawAliasMaps: Map<bigint, Raw>;
  drainConfigs: Map<bigint, unknown>;
  pendingSubscriptionGenerations: Map<bigint, unknown>;
  pendingAliasEvents: Map<bigint, unknown>;
  pendingAliasReplays: Map<bigint, unknown>;
  controlWriter: WritableStreamDefaultWriter<Uint8Array> | null;
};
const internal = (connection: MoqtConnection) => connection as unknown as Internals;
const wireSize = (a: LoopbackTransport) => [...a.uniOut, ...a.bidiOut.map(stream => stream.out)]
  .reduce((sum, pipe) => sum + pipe.written.reduce((n, bytes) => n + bytes.length, 0), 0);
const turn = async () => { await flush(128); await new Promise<void>(resolve => setTimeout(resolve, 0)); await flush(128); };
const largestParameters = (draft: Draft, group: bigint, object: bigint): Parameters => {
  const location = { group, object }, bytes = new Uint8Array(locationEncodingLength(location));
  writeLocation(location, bytes, 0);
  return new Map([[MessageParam.LARGEST_OBJECT, [draft < 18 ? bytes : location]]]);
};

async function pair(draft: Draft, auto = true, authorize?: AuthorizationProvider) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft, { terminatedAliasTtlMs: 20 });
  const server = new MoqtConnection(draft, { role: 'server' });
  const errors: Error[] = [], requests: bigint[] = [];
  client.onError = error => errors.push(error); server.onError = error => errors.push(error);
  server.setLargestLocationProvider(() => null);
  server.onSubscribe = id => {
    requests.push(id);
    if (auto) void server.acceptSubscribe(id, 77n).catch(error => errors.push(error));
  };
  await Promise.all([
    client.connect(a, authorize ? { authorization: { relayUrl: 'https://sdk.example/moq', getTokens: authorize } } : {}),
    server.connect(b, draft < 18 ? { maxRequestId: varint(1000n) } : {}),
  ]);
  return { client, server, a, b, requests, errors, async close() { await client.close(); await server.close(); } };
}

function expectEmpty(connection: MoqtConnection) {
  const state = internal(connection);
  expect(state.rawSubscriptions.size).toBe(0); expect(state.rawAliasMaps.size).toBe(0);
  expect(state.drainConfigs.size).toBe(0); expect(state.pendingSubscriptionGenerations.size).toBe(0);
  expect(state.pendingAliasEvents.size).toBe(0); expect(state.pendingAliasReplays.size).toBe(0);
}

describe.each([14, 16, 18, 22] as const)('track request ownership draft %i', draft => {
  it('reserves raw and drain state before the one ownership callback and before bytes; forwards ascending', async () => {
    const h = await pair(draft), before = wireSize(h.a), observe = vi.spyOn(h.server.session, 'handleControlMessage');
    const callback = vi.fn((id: bigint) => {
      expect(wireSize(h.a)).toBe(before);
      expect(h.client.session.getSubscription(id)).toBeDefined();
      expect(internal(h.client).rawSubscriptions.has(id)).toBe(true);
      expect(internal(h.client).drainConfigs.has(id)).toBe(true);
      expect(internal(h.client).rawSubscriptions.get(id)!.sub.initialLargestLocation).toBeNull();
    });
    try {
      const sub = await h.client.subscribeTrack(ns('live'), nm('video'), {
        onRequestId: callback, groupOrder: varint(1n), terminalDelivery: 'drain',
      } satisfies Options);
      expect(callback).toHaveBeenCalledExactlyOnceWith(sub.requestId);
      const message = observe.mock.calls.map(([message]) => message).find(message => message.type === 'SUBSCRIBE');
      expect(message?.parameters.get(MessageParam.GROUP_ORDER)?.[0]).toBe(1n);
      await sub.unsubscribe(); await flush(128); expectEmpty(h.client); expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('copies the accepted ACK Largest before replay and never reads the moving subscription head', async () => {
    const h = await pair(draft, false), seen: bigint[] = [];
    const observed = vi.spyOn(h.client.session, 'handleControlMessage');
    const pending = h.client.subscribeTrack(ns('live'), nm('video'), { onObject: object => seen.push(BigInt(object.objectId)) });
    void pending.catch(() => {});
    try {
      await flush(128); const id = h.requests[0]!; expect(id).toBeDefined();
      const response = h.a.bidiOut[0]!.in; response.faults.hold = true;
      h.server.setLargestLocationProvider(() => ({ group: 4n, object: 2n }));
      await h.server.acceptSubscribe(id, 77n, { parameters: largestParameters(draft, 4n, 2n) });
      const stream = await h.server.openSubgroup(77n, 5n, 0n, { publisherPriority: 128 });
      await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
      expect(seen).toEqual([]); response.releaseHeld();
      const sub = await pending;
      const snapshot = sub.initialLargestLocation;
      expect(snapshot).toEqual({ groupId: 4n, objectId: 2n }); expect(Object.isFrozen(snapshot)).toBe(true);
      expect(seen).toEqual([]);
      sub.onObject = object => {
        expect(sub.initialLargestLocation).toBe(snapshot);
        // A raw consumer may maintain the exposed session's observed head.
        // This must never overwrite the initial response observation.
        h.client.session.getSubscription(id)!.updateLargestLocation(BigInt(object.groupId), BigInt(object.objectId));
        seen.push(BigInt(object.objectId));
      };
      await h.server.sendObject(stream, 1n, Uint8Array.of(2)); await turn();
      expect(seen).toEqual([0n, 1n]);
      expect(h.client.session.getSubscription(id)?.largestLocation).toEqual({ groupId: 5n, objectId: 1n });
      expect(sub.initialLargestLocation).toBe(snapshot);
      const ack = observed.mock.calls.map(([message]) => message).find(message => message.type === 'SUBSCRIBE_OK');
      const largest = ack?.parameters.get(MessageParam.LARGEST_OBJECT)?.[0];
      if (largest instanceof Uint8Array) largest.fill(0);
      else if (largest && typeof largest === 'object') Reflect.set(largest, 'group', 99n);
      expect(sub.initialLargestLocation).toEqual({ groupId: 4n, objectId: 2n });
      expect(Reflect.set(sub, 'initialLargestLocation', null)).toBe(false);
      await h.server.closeSubgroup(stream); expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('distinguishes a real ACK Largest Object0/Group0 from missing metadata', async () => {
    const h = await pair(draft, false), pending = h.client.subscribeTrack(ns('live'), nm('video'));
    void pending.catch(() => {});
    try {
      await flush(128);
      await h.server.acceptSubscribe(h.requests[0]!, 77n, { parameters: largestParameters(draft, 0n, 0n) });
      const sub = await pending;
      expect(sub.initialLargestLocation).toEqual({ groupId: 0n, objectId: 0n });
      expect(Object.isFrozen(sub.initialLargestLocation)).toBe(true); expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('keeps absent Largest null after objects and pause/resume update', async () => {
    const h = await pair(draft);
    try {
      const sub = await h.client.subscribeTrack(ns('live'), nm('video'));
      expect(sub.initialLargestLocation).toBeNull();
      const stream = await h.server.openSubgroup(77n, 2n, 0n);
      await h.server.sendObject(stream, 0n, Uint8Array.of(2)); await flush(128);
      await h.client.requestUpdate(sub.requestId, { forward: 0 }); await flush(128);
      h.server.setLargestLocationProvider(() => ({ group: 8n, object: 9n }));
      await h.client.requestUpdate(sub.requestId, { forward: 1 }); await flush(128);
      expect(sub.initialLargestLocation).toBeNull(); await h.server.closeSubgroup(stream);
      expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('authorizes before ownership/allocation', async () => {
    let release!: () => void;
    const tokens = [catToken(Uint8Array.of(1))];
    const gate = new Promise<typeof tokens>(resolve => { release = () => resolve(tokens); });
    const authorization = vi.fn<AuthorizationProvider>(context => context.operation === 'SUBSCRIBE' ? gate : tokens);
    const h = await pair(draft, true, authorization), callback = vi.fn();
    const before = wireSize(h.a);
    const pending = h.client.subscribeTrack(ns('live'), nm('video'), { onRequestId: callback } satisfies Options);
    void pending.catch(() => {});
    try {
      await flush(128); expect(callback).not.toHaveBeenCalled(); expectEmpty(h.client); expect(wireSize(h.a)).toBe(before);
      release(); const sub = await pending; expect(callback).toHaveBeenCalledExactlyOnceWith(sub.requestId);
      expect(authorization.mock.calls.some(([context]) => context.operation === 'SUBSCRIBE')).toBe(true);
      await sub.unsubscribe(); expectEmpty(h.client);
    } finally { release(); await h.close(); }
  });

  it('does not allocate or call ownership when the session closes during authorization', async () => {
    let release!: () => void;
    const tokens = [catToken(Uint8Array.of(1))];
    const gate = new Promise<typeof tokens>(resolve => { release = () => resolve(tokens); });
    const h = await pair(draft, true, context => context.operation === 'SUBSCRIBE' ? gate : tokens);
    const callback = vi.fn(), pending = h.client.subscribeTrack(ns('live'), nm('video'), { onRequestId: callback } satisfies Options);
    void pending.catch(() => {});
    try {
      await flush(128); await h.client.close(); release();
      await expect(pending).rejects.toThrow(); expect(callback).not.toHaveBeenCalled(); expectEmpty(h.client);
      expect(h.requests).toEqual([]);
    } finally { release(); await h.close(); }
  });

  it('does not send when the ownership callback cancels its pending request', async () => {
    const h = await pair(draft), callback = vi.fn((id: bigint) => { void h.client.unsubscribe(id); });
    try {
      await expect(h.client.subscribeTrack(ns('live'), nm('video'), {
        onRequestId: callback, terminalDelivery: 'drain',
      } satisfies Options)).rejects.toThrow();
      await flush(128); expect(callback).toHaveBeenCalledOnce(); expect(h.requests).toEqual([]); expectEmpty(h.client);
    } finally { await h.close(); }
  });

  it('rolls back a throwing ownership callback without bytes or raw/drain state and reuses the unsent ID', async () => {
    const h = await pair(draft), before = wireSize(h.a), error = new Error('retired before send');
    try {
      await expect(h.client.subscribeTrack(ns('live'), nm('video'), {
        terminalDelivery: 'drain', onRequestId: () => { throw error; },
      } satisfies Options)).rejects.toBe(error);
      expect(wireSize(h.a)).toBe(before); expectEmpty(h.client); expect(h.requests).toEqual([]);
      const sub = await h.client.subscribeTrack(ns('live'), nm('video')); expect(sub.requestId).toBe(0n);
      expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('rolls back a transport send failure with no raw/drain state', async () => {
    const h = await pair(draft), error = new Error('request write failed');
    if (draft < 18) vi.spyOn(internal(h.client).controlWriter!, 'write').mockRejectedValueOnce(error);
    else vi.spyOn(h.a, 'createBidirectionalStream').mockRejectedValueOnce(error);
    try {
      await expect(h.client.subscribeTrack(ns('live'), nm('video'), { terminalDelivery: 'drain' } satisfies Options)).rejects.toBe(error);
      await flush(128); expectEmpty(h.client); expect(h.client.session.getSubscription(0n)).toBeUndefined();
      expect(h.client.session.state).toBe(draft < 18 ? 'closed' : 'established');
    } finally { await h.close(); }
  });

  it('registers before an ownership callback closes the session and emits no request', async () => {
    const h = await pair(draft), callback = vi.fn(() => { void h.client.close(); });
    const before = wireSize(h.a);
    try {
      await expect(h.client.subscribeTrack(ns('live'), nm('video'), {
        terminalDelivery: 'drain', onRequestId: callback,
      } satisfies Options)).rejects.toThrow();
      await flush(128); expect(callback).toHaveBeenCalledOnce(); expectEmpty(h.client);
      expect(h.requests).toEqual([]); expect(wireSize(h.a)).toBe(before);
    } finally { await h.close(); }
  });

  it('rejects a pending raw/drain owner on session close', async () => {
    const h = await pair(draft, false);
    const pending = h.client.subscribeTrack(ns('live'), nm('video'), { terminalDelivery: 'drain' } satisfies Options);
    void pending.catch(() => {});
    try {
      await flush(128); await h.client.close(); await expect(pending).rejects.toThrow(); expectEmpty(h.client);
    } finally { await h.close(); }
  });

  it('preserves synchronous mutable raw callbacks and does not await returned promises', async () => {
    const h = await pair(draft); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const early = vi.fn(), current = vi.fn(() => held), closed = vi.fn();
    try {
      const sub = await h.client.subscribeTrack(ns('live'), nm('video'), { onObject: early });
      sub.onObject = current; sub.onSubgroupClosed = closed;
      const stream = await h.server.openSubgroup(77n, 1n, 0n);
      await h.server.sendObject(stream, 0n, Uint8Array.of(1));
      await h.server.sendObject(stream, 1n, Uint8Array.of(2)); await h.server.closeSubgroup(stream); await turn();
      expect(current).toHaveBeenCalledTimes(2); expect(early).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce();
      expect(h.errors).toEqual([]);
    } finally { release(); await h.close(); }
  });

  it('keeps terminal drain routing for valid late delivery and publishes onDrained once', async () => {
    const h = await pair(draft), objects = vi.fn(), drained = vi.fn(), closed = vi.fn();
    try {
      const sub = await h.client.subscribeTrack(ns('finite'), nm('video'), {
        onObject: objects, onSubgroupClosed: closed,
        terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams', onDrained: drained,
      } satisfies Options);
      await turn();
      const stream = await h.server.openSubgroup(77n, 1n, 0n), pipe = h.b.uniOut.at(-1)!;
      pipe.faults.hold = true;
      await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await h.server.closeSubgroup(stream);
      await h.server.publishDone(sub.requestId, varint(2n), 'finite'); await flush(128);
      expect(objects).not.toHaveBeenCalled(); expect(drained).not.toHaveBeenCalled();
      pipe.releaseHeld(); await turn();
      expect(objects).toHaveBeenCalledOnce(); expect(drained).toHaveBeenCalledExactlyOnceWith(sub.requestId);
      expect(closed).toHaveBeenCalledOnce(); expectEmpty(h.client);
      expect(internal(h.client).drainConfigs.size).toBe(0); expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('processes already parked early DATA and FIN before an immediate terminal drain', async () => {
    const h = await pair(draft, false), events: string[] = [];
    const pending = h.client.subscribeTrack(ns('finite'), nm('video'), {
      onObject: () => events.push('object'), onSubgroupClosed: () => events.push('closed'),
      terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams', onDrained: () => events.push('drained'),
    } satisfies Options);
    void pending.catch(() => {});
    try {
      await flush(128); const id = h.requests[0]!;
      const response = h.a.bidiOut[0]!.in; response.faults.hold = true;
      await h.server.acceptSubscribe(id, 77n);
      const stream = await h.server.openSubgroup(77n, 1n, 0n);
      await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await h.server.closeSubgroup(stream); await flush(128);
      response.releaseHeld(); await pending;
      expect(events).toEqual([]);
      await h.server.publishDone(id, varint(2n), 'finite'); await turn();
      expect(events).toEqual(['object', 'closed', 'drained']); expectEmpty(h.client); expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it('retires the raw owner before onDrained admits a fresh same-alias successor', async () => {
    const h = await pair(draft), delivered = vi.fn(); let successor: Promise<TrackSubscription> | undefined;
    const drained = vi.fn(() => {
      expect(internal(h.client).rawSubscriptions.size).toBe(0);
      successor = h.client.subscribeTrack(ns('finite'), nm('video'), { onObject: delivered });
      void successor.catch(() => {});
    });
    try {
      const sub = await h.client.subscribeTrack(ns('finite'), nm('video'), {
        terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams', onDrained: drained,
      } satisfies Options);
      const stream = await h.server.openSubgroup(77n, 1n, 0n);
      await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await h.server.closeSubgroup(stream); await turn();
      await h.server.publishDone(sub.requestId, varint(2n), 'finite'); await turn();
      expect(drained).toHaveBeenCalledOnce(); expect(successor).toBeDefined();
      const next = await successor!; expect(next.requestId).not.toBe(sub.requestId);
      const fresh = await h.server.openSubgroup(77n, 2n, 0n);
      await h.server.sendObject(fresh, 0n, Uint8Array.of(2)); await h.server.closeSubgroup(fresh); await turn();
      expect(delivered).toHaveBeenCalledOnce(); expect(internal(h.client).rawSubscriptions.size).toBe(1);
      await next.unsubscribe(); await flush(128); expectEmpty(h.client); expect(h.errors).toEqual([]);
    } finally { await h.close(); }
  });

  it.each([
    { onDrained: () => {} },
    { terminalDeliveryStatuses: [2n] },
    { terminalDeliveryCompletion: 'streams' },
    { terminalDelivery: 'drain', terminalDeliveryStatuses: [-1n] },
    { terminalDelivery: 'drain', terminalDeliveryStatuses: Array<bigint>(33).fill(2n) },
    { terminalDelivery: 'drain', terminalDeliveryCompletion: 'bad' },
  ])('uses the generic validation boundary for malformed terminal options case %#', async invalid => {
    const h = await pair(draft), callback = vi.fn(), before = wireSize(h.a);
    const options = { ...invalid, onRequestId: callback } as unknown as TerminalDeliveryOptions & RequestOwnershipOptions;
    try {
      const generic = await h.client.subscribe(ns('live'), nm('video'), options).then(() => null, error => error as Error);
      expect(generic).toBeInstanceOf(Error);
      const raw = await h.client.subscribeTrack(ns('live'), nm('video'), options).then(() => null, error => error as Error);
      expect(raw?.constructor).toBe(generic?.constructor); expect(raw?.message).toBe(generic?.message);
      expect(callback).not.toHaveBeenCalled(); expect(wireSize(h.a)).toBe(before); expectEmpty(h.client);
    } finally { await h.close(); }
  });
});
