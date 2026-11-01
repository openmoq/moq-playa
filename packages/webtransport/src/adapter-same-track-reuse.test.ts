import { describe, expect, it, vi } from 'vitest';
import { encodeObjectDatagram, encodeObjectDatagram18, createControlCodec, encodeSubgroupHeader18, encodeSubgroupObject18, MessageParam, varint } from '@openmoq/transport';
import type { SubscribeOptions, ControlMessage } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback } from './testkit/loopback.js';
import { flush } from './testkit/stream-sim.js';

const enc = (s: string) => new TextEncoder().encode(s);

async function fixture(draft: 14 | 16 | 18 | 22) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors = vi.fn(), delivered = vi.fn(), messages: ControlMessage[] = [];
  client.onMessage = message => { messages.push(message); };
  client.onError = errors; client.onDatagram = delivered;
  server.onSubscribe = id => { void server.acceptSubscribe(id, 77n); };
  server.setLargestLocationProvider(() => null);
  const setup = draft < 18 ? { maxRequestId: varint(100n) } : undefined;
  await Promise.all([client.connect(a, setup), server.connect(b, setup)]);
  const writer = b.datagrams.writable!.getWriter();
  const send = async (groupId = 10n, objectId = 0n) => {
    await writer.write((draft < 18 ? encodeObjectDatagram : encodeObjectDatagram18)({
      typeByte: 0x00, trackAlias: 77n, groupId, objectId, publisherPriority: 128,
      payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false,
    }));
    await flush(100);
  };
  return { client, server, delivered, errors, messages, send, transport: b, publisherTransport: a,
    subscribe: async (namespace = ['live'], name = 'video', options?: SubscribeOptions) => {
      const id = await client.subscribe(namespace.map(enc), enc(name), options);
      await flush(100); return id;
    },
    close: async () => { writer.releaseLock(); await client.close(); await server.close(); },
  };
}

describe('same full track alias reuse after cancellation', () => {
  it.each([14, 16, 18, 22] as const)('accepts an immediate generic retry on draft %i', async draft => {
    const h = await fixture(draft);
    try {
      const first = await h.subscribe(); await h.send();
      await h.client.unsubscribe(first); await flush(100);
      await h.send(); expect(h.delivered).toHaveBeenCalledOnce();
      const next = await h.subscribe(); await h.send(11n);
      expect(h.errors).not.toHaveBeenCalled();
      expect(h.client.session.getSubscription(next)?.trackAlias).toBe(77n);
      expect(h.delivered).toHaveBeenCalledTimes(2);
    } finally { await h.close(); }
  });

  it.each([14, 16, 18, 22] as const)('accepts an immediate raw retry on draft %i', async draft => {
    const h = await fixture(draft), receive = vi.fn();
    try {
      const first = await h.client.subscribeTrack([enc('live')], enc('video'), { onObject: receive });
      await first.unsubscribe(); await flush(100);
      const next = h.client.subscribeTrack([enc('live')], enc('video'), { onObject: receive });
      // Own the rejection from creation, including on the red baseline.
      const result = next.then(value => ({ value }), error => ({ error }));
      await flush(100);
      const outcome = await result;
      expect(outcome).toHaveProperty('value'); expect(h.errors).not.toHaveBeenCalled();
      const stream = await h.server.openSubgroup(77n, 11n, 0n, { publisherPriority: 128 });
      await h.server.sendObject(stream, 0n, Uint8Array.of(4)); await h.server.closeSubgroup(stream);
      await flush(100); expect(receive).toHaveBeenCalledOnce();
    } finally { await h.close(); }
  });

  it.each([14, 16, 18, 22] as const)('does not relabel a conflicting namespace on draft %i', async draft => {
    const h = await fixture(draft);
    try {
      const first = await h.subscribe(['live/room']); await h.client.unsubscribe(first); await flush(100);
      await h.subscribe(['live', 'room']); await h.send();
      expect(h.errors).toHaveBeenCalledOnce(); expect(h.delivered).not.toHaveBeenCalled();
      // A refused B may already have put its data on the wire. Returning to A
      // must not un-poison the guard while those packets remain in flight.
      await h.subscribe(['live/room']); await h.send();
      expect(h.errors).toHaveBeenCalledTimes(2); expect(h.delivered).not.toHaveBeenCalled();
      expect(h.client.session.state).toBe('established');
    } finally { await h.close(); }
  });

  it.each([14, 16, 18, 22] as const)('keeps the successor AbsoluteRange on draft %i', async draft => {
    const h = await fixture(draft);
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      await h.subscribe(['live'], 'video', { subscriptionFilter: { type: 'AbsoluteRange', startGroup: 10n, startObject: 2n, endGroup: 11n } });
      expect(h.errors).not.toHaveBeenCalled();
      await h.send(9n); await h.send(10n, 1n); await h.send(12n);
      expect(h.delivered).not.toHaveBeenCalled();
      await h.send(10n, 2n); await h.send(11n);
      expect(h.delivered).toHaveBeenCalledTimes(2);
    } finally { await h.close(); }
  });
  it.each([14, 16, 18, 22] as const)('uses the acknowledged successor update and Forward State on draft %i', async draft => {
    const h = await fixture(draft);
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      const next = await h.subscribe(['live'], 'video', { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 10n, startObject: 0n } });
      await h.client.requestUpdate(next, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 20n, startObject: 3n } });
      await flush(100); expect(h.errors).not.toHaveBeenCalled();
      expect(h.messages.filter((m) => m.type === 'REQUEST_ERROR')).toEqual([]);
      expect(h.client.session.getSubscription(next)?.locationWindow).toEqual({ start: { group: 20n, object: 3n } });
      expect(h.client.session.getSubscription(next)?.isActive).toBe(true);
      await h.send(20n, 2n); expect(h.delivered).not.toHaveBeenCalled();
      await h.send(20n, 3n); expect(h.delivered).toHaveBeenCalledOnce();
      await h.client.requestUpdate(next, { forward: 0 }); await flush(100);
      await h.send(21n); expect(h.delivered).toHaveBeenCalledOnce();
      await h.client.requestUpdate(next, { forward: 1 }); await flush(100);
      await h.send(22n); expect(h.delivered).toHaveBeenCalledTimes(2);
    } finally { await h.close(); }
  });

  it.each([14, 16, 18, 22] as const)('filters late stream objects against the successor range on draft %i', async draft => {
    const h = await fixture(draft), delivered = vi.fn();
    h.client.onObject = (_stream, object) => delivered(object);
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      await h.subscribe(['live'], 'video', { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 10n, startObject: 2n } });
      if (draft === 22) {
        // Model an old in-flight stream, bypassing the publisher's correct
        // refusal to send outside the new subscription's own range.
        const writer = (await h.transport.createUnidirectionalStream()).getWriter();
        try {
          await writer.write(encodeSubgroupHeader18({ typeByte: 0x50, trackAlias: 77n, groupId: 10n, subgroupId: 0n,
            publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
          await writer.write(encodeSubgroupObject18({ objectId: 1n, payload: Uint8Array.of(1), extensions: undefined, status: undefined }, false, 0n, true));
          await flush(100); expect(delivered).not.toHaveBeenCalled();
          await writer.write(encodeSubgroupObject18({ objectId: 2n, payload: Uint8Array.of(2), extensions: undefined, status: undefined }, false, 1n, false));
          await writer.close(); await flush(100);
        } finally { writer.releaseLock(); }
      } else {
        const stream = await h.server.openSubgroup(77n, 10n, 0n, { publisherPriority: 128 });
        await h.server.sendObject(stream, 1n, Uint8Array.of(1)); await flush(100);
        expect(delivered).not.toHaveBeenCalled();
        await h.server.sendObject(stream, 2n, Uint8Array.of(2)); await h.server.closeSubgroup(stream); await flush(100);
      }
      expect(delivered).toHaveBeenCalledOnce(); expect(delivered.mock.calls[0]![0].objectId).toBe(2n);
    } finally { await h.close(); }
  });

  it.each([14, 16, 18, 22] as const)('keeps repeated in-range datagrams as distinct receipts on draft %i', async draft => {
    const h = await fixture(draft), receipts: unknown[] = [];
    const release = h.client.observeObjectReceipts(event => { receipts.push(event.receipt); });
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      await h.subscribe(['live'], 'video', { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 10n, startObject: 2n } });
      await h.send(10n, 2n); await h.send(10n, 2n);
      expect(h.delivered).toHaveBeenCalledTimes(2);
      expect(receipts).toHaveLength(2); expect(receipts[0]).not.toBe(receipts[1]);
      expect(h.errors).not.toHaveBeenCalled();
    } finally { release(); await h.close(); }
  });

  it('does not mutate identity proof when an unknown successor is queried', async () => {
    const h = await fixture(18);
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      const policy = h.client as unknown as { aliasReuseSafe(alias: bigint, requestId?: bigint): boolean };
      expect(policy.aliasReuseSafe(77n)).toBe(false);
      expect(policy.aliasReuseSafe(77n, 999n)).toBe(false);
      await h.subscribe(); await h.send();
      expect(h.errors).not.toHaveBeenCalled(); expect(h.delivered).toHaveBeenCalledOnce();
    } finally { await h.close(); }
  });

  it.each([18, 22] as const)('fences a same-track PUBLISH successor after a peer reset on draft %i', async draft => {
    const h = await fixture(draft), delivered = vi.fn(), serverErrors = vi.fn();
    h.server.onDatagram = delivered; h.server.onError = serverErrors;
    let count = 0, latestPublish = -1n;
    h.client.setLargestLocationProvider(() => null);
    h.server.onPublish = publication => {
      count++; latestPublish = publication.requestId;
      void h.server.acceptSubscribe(publication.requestId, 77n, draft === 22 ? undefined : {
        parameters: new Map([[MessageParam.FORWARD, [count === 1 ? 1n : 0n]]]),
      }).catch(serverErrors);
    };
    const writer = h.publisherTransport.datagrams.writable!.getWriter();
    try {
      await h.client.publish([enc('live')], enc('video'), 77n); await flush(100);
      expect(count).toBe(1);
      h.publisherTransport.bidiOut[0]!.out.reset(0); await flush(100);
      await h.client.publish([enc('live')], enc('video'), 77n); await flush(100);
      expect(count).toBe(2); expect(serverErrors).not.toHaveBeenCalled();
      if (draft === 22) { await h.server.requestUpdate(latestPublish, { forward: 0 }); await flush(100); }
      expect(h.server.session.getIncomingSubscription(latestPublish)?.forwardState).toBe(0);
      await writer.write(encodeObjectDatagram18({ typeByte: 0, trackAlias: 77n, groupId: 10n, objectId: 0n,
        publisherPriority: 128, payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false }));
      await flush(100); expect(delivered).not.toHaveBeenCalled();
    } finally { writer.releaseLock(); await h.close(); }
  });

  it.each([18, 22] as const)('does not replay guarded pre-OK stream data into the successor on draft %i', async draft => {
    const h = await fixture(draft), delivered = vi.fn();
    h.client.onObject = (_stream, object) => delivered(object);
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      h.server.onSubscribe = () => {};
      const next = await h.subscribe(['live'], 'video', { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 10n, startObject: 2n } });
      const writer = (await h.transport.createUnidirectionalStream()).getWriter();
      try {
        const header = encodeSubgroupHeader18({ typeByte: 0x50, trackAlias: 77n, groupId: 9n, subgroupId: 0n,
          publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true });
        const body = encodeSubgroupObject18({ objectId: 0n, payload: Uint8Array.of(1), extensions: undefined, status: undefined }, false, 0n, true);
        const bytes = new Uint8Array(header.length + body.length); bytes.set(header); bytes.set(body, header.length);
        await writer.write(bytes); await flush(100);
        // The guard rejects the coalesced header/body before the object can be parked.
        expect((h.client as unknown as { pendingAliasEvents: Map<bigint, unknown> }).pendingAliasEvents.has(77n)).toBe(false);
        expect(delivered).not.toHaveBeenCalled();
      } finally { writer.releaseLock(); }
      await h.server.acceptSubscribe(next, 77n); await flush(100);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(delivered).not.toHaveBeenCalled(); expect(h.errors).not.toHaveBeenCalled();
      const stream = await h.server.openSubgroup(77n, 10n, 0n, { publisherPriority: 128 });
      await h.server.sendObject(stream, 2n, Uint8Array.of(2)); await h.server.closeSubgroup(stream); await flush(100);
      expect(delivered).toHaveBeenCalledOnce();
    } finally { await h.close(); }
  });

  it.each([16, 18, 22] as const)('keeps the prior window on update rejection before terminal cleanup in draft %i', async draft => {
    const h = await fixture(draft);
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      const next = await h.subscribe(['live'], 'video', { subscriptionFilter: { type: 'AbsoluteRange', startGroup: 10n, startObject: 2n, endGroup: 11n } });
      const stream = h.publisherTransport.bidiOut.at(-1)!;
      stream.out.faults.hold = true;
      const update = await h.client.requestUpdate(next, { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 20n, startObject: 0n } });
      // A peer rejects the update; its terminal message (required on18/22)
      // has not arrived yet. Already in-flight objects still use the old window.
      stream.in.injectRead(createControlCodec(draft).encode({ type: 'REQUEST_ERROR', requestId: update,
        errorCode: 0n, errorReason: 'update refused', retryInterval: varint(0n) }));
      await flush(100);
      expect(h.messages.some(message => message.type === 'REQUEST_ERROR' && message.requestId === update)).toBe(true);
      await h.send(10n, 2n); await h.send(20n);
      expect(h.delivered).toHaveBeenCalledOnce(); expect(h.errors).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('reports a policy discard on the exact received token, without replacing application callbacks', async () => {
    const h = await fixture(18), receipts: unknown[] = [], discarded: unknown[] = [];
    expect(h.client.observeObjectDiscards).toBeTypeOf('function');
    const off = h.client.observeObjectReceipts(event => { receipts.push(event.receipt); });
    const offDiscard = h.client.observeObjectDiscards(event => { discarded.push(event); });
    try {
      const first = await h.subscribe(); await h.client.unsubscribe(first); await flush(100);
      await h.subscribe(['live'], 'video', { subscriptionFilter: { type: 'AbsoluteStart', startGroup: 10n, startObject: 0n } });
      await h.send(9n); await h.send(10n);
      expect(receipts).toHaveLength(2);
      expect(discarded).toEqual([{ receipt: receipts[0], reason: 'subscription policy' }]);
      expect(h.delivered).toHaveBeenCalledOnce();
    } finally { offDiscard(); off(); await h.close(); }
  });

});
