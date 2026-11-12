import { expect, it } from 'vitest';
import { createControlCodec, MessageParam, readLocation, varint } from '@openmoq/transport';
import { encodeSubscriptionFilter } from '../../transport/src/control/subscription-filter.js';
import { ns, nm } from './testkit/pair.js';
import { flush, createLoopback } from './testkit/loopback.js';
import { MoqtConnection } from './adapter.js';

for (const draft of [16, 18] as const) {
  for (const direction of ['incoming', 'outgoing'] as const) {
    it(`draft${draft} Joining FETCH uses ${direction} publication; update/failure never changes joined ownership`, async () => {
      const { a, b } = createLoopback();
      const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
      const errors: Error[] = [];
      client.onError = server.onError = error => { errors.push(error); };
      await Promise.all([client.connect(a, { maxRequestId: varint(1_000_000n) }), server.connect(b, { maxRequestId: varint(1_000_000n) })]);
      const f = { client, server, a, b, errors };
      let head = { group: 3n, object: 0n };
      f.server.setFetchLargestLocationProvider(id => {
        if (!f.server.session.getIncomingFetch(id)) throw new Error('Unknown FETCH');
        return { ...head };
      });
      const initial = new Map([[MessageParam.LARGEST_OBJECT, [draft === 16 ? Uint8Array.of(3, 0) : { group: 3n, object: 0n }]]]);
      let joined: bigint;
      const objects: number[] = [];
      if (direction === 'incoming') {
        f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 9n, { parameters: initial }); };
        joined = await f.client.subscribe(ns('joined'), nm('video'), { subscriptionFilter: { type: 'LargestObject' } });
        f.client.onObject = (_id, object) => { if (object.kind === 'data') objects.push(...object.payload); };
      } else {
        f.client.onPublish = p => { p.onObject = object => { if (object.kind === 'data') objects.push(...object.payload); }; void f.client.acceptSubscribe(p.requestId, 9n, { parameters: new Map([[MessageParam.SUBSCRIPTION_FILTER, [encodeSubscriptionFilter({ type: 'LargestObject' }, draft)]]]) }); };
        joined = await f.server.publish(ns('joined'), nm('video'), 9n, { parameters: initial });
      }
      await flush(128);
      const joinedOwner = direction === 'incoming' ? f.server.session.getIncomingSubscription(joined)! : f.server.session.getOutgoingPublish(joined)!;
      expect(f.errors.map(error => error.message)).toEqual([]);
      expect(joinedOwner?.state).toBe('established');
      f.server.onFetch = (_id, request) => {
        expect(request.fetch.fetchType).not.toBe(1);
      };
      const join = async () => {
        const id = await f.client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: joined, joiningStart: 0n });
        await flush(128);
        const range = f.server.resolveJoiningFetch(id);
        await f.server.acceptFetch(id, { endLocation: range.endLocation }); await flush(128);
        return { id, range, request: f.a.bidiOut.at(-1)! };
      };
      const update = async (id: bigint, request: typeof f.a.bidiOut[number]) => {
        request.in.faults.hold = true;
        // Reserve the legacy peer ID through its real allocator; replies stay held
        // to isolate receiver metadata from public update correlation.
        const updateId = draft === 16 ? (direction === 'incoming'
          ? f.client.session.requestUpdate(joined, { subscriberPriority: varint(7n) })
          : f.client.session.updateIncomingSubscription(joined, { subscriberPriority: varint(7n) })).requestId : id + 100n;
        const before = request.in.written.length, codec = createControlCodec(draft);
        request.out.injectRead(codec.encode({ type: 'REQUEST_UPDATE', requestId: updateId, existingRequestId: id,
          parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [7n]]]) }));
        await flush(256);
        return request.in.written.slice(before).map(bytes => codec.decode(bytes, 0).message);
      };
      try {
        head = { group: 6n, object: 4n };
        const first = await join();
        const response = (await update(first.id, first.request)).find(m => m.type === 'REQUEST_OK');
        const raw = response?.type === 'REQUEST_OK' ? response.parameters.get(MessageParam.LARGEST_OBJECT)?.[0] : undefined;
        expect(raw instanceof Uint8Array ? readLocation(raw, 0).value : raw).toEqual({ group: 6n, object: 4n });
        const second = await join();
        expect(second.range).toEqual(first.range);
        f.server.setFetchLargestLocationProvider(() => { throw new Error('publication unavailable'); });
        const failure = await update(second.id, second.request);
        expect(failure.some(m => m.type === 'REQUEST_ERROR')).toBe(true);
        expect(failure.some(m => m.type === 'PUBLISH_DONE')).toBe(false);
        expect(f.errors.map(error => error.message)).toEqual([]);
        expect(joinedOwner?.state).toBe('established');
        expect(f.server.session.getIncomingFetch(first.id)).toBeDefined();
        expect(f.server.session.getIncomingFetch(second.id)).toBeUndefined();
        const stream = await f.server.openSubgroup(9n, 7n, 0n);
        head = { group: 7n, object: 0n };
        await f.server.sendObject(stream, 0n, Uint8Array.of(9)); await f.server.closeSubgroup(stream); await flush(128);
        expect(objects).toEqual([9]);
        expect(f.errors).toEqual([]);
      } finally { await f.client.close(); await f.server.close(); }
    });
  }
}
