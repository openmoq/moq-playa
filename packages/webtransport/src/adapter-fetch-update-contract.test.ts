import { expect, it } from 'vitest';
import { createControlCodec, MessageParam, readLocation, varint, type ControlMessage } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

async function prepare(draft: 16 | 18 | 22) {
  const p = await connectedPair(draft);
  // Publisher's declared preexisting cache, independent of the requested finite range.
  const cache = [{ group: 3n, object: 0n, payload: Uint8Array.of(11, 22) },
    { group: 6n, object: 4n, payload: Uint8Array.of(66, 44) }];
  const publication = { group: cache[1]!.group, object: cache[1]!.object };
  const received: number[] = [];
  let receivedRequest: bigint | undefined;
  p.server.onFetch = (id, message) => {
    receivedRequest = id;
    expect(message.fetch.fetchType).toBe(1);
    if (message.fetch.fetchType === 1) {
      expect(new TextDecoder().decode(message.fetch.trackName)).toBe('video');
      expect(message.fetch.endLocation).toEqual({ group: 3n, object: 5n });
    }
  };
  p.client.onObject = (_id, object) => { if (object.kind === 'data') received.push(...object.payload); };
  const subscriptionProviderCalls: bigint[] = [];
  p.server.setLargestLocationProvider(id => {
    subscriptionProviderCalls.push(id);
    throw new Error('A FETCH ID is not a subscription publication owner');
  });
  const id = await p.client.fetch(ns('published'), nm('video'), {
    startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 5n,
  });
  await flush(128);
  expect(receivedRequest).toBe(id);
  await p.server.acceptFetch(id, { endLocation: { group: 3n, object: 5n } });
  await flush(128);
  const exactOwner = p.server.session.getIncomingFetch(id);
  (p.server as unknown as { setFetchLargestLocationProvider?: (provider: (id: bigint) => { group: bigint; object: bigint }) => void })
    .setFetchLargestLocationProvider?.(requestId => {
      if (requestId !== id || p.server.session.getIncomingFetch(id) !== exactOwner) throw new Error('unavailable owner');
      return { ...publication };
    });
  const stream = draft !== 16 ? await p.server.openFetchStream(id) : null;
  return { ...p, id, stream, received, publication, cache, subscriptionProviderCalls };
}

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} FETCH update ACK reports track head, not finite retrieval endpoint`, async () => {
    const f = await prepare(draft);
    try {
      const request = f.a.bidiOut.at(-1)!;
      request.in.faults.hold = true;
      const before = request.in.written.length;
      const codec = createControlCodec(draft);
      const update: ControlMessage = { type: 'REQUEST_UPDATE', requestId: varint(f.id + 2n), existingRequestId: varint(f.id),
        parameters: new Map([[MessageParam.SUBSCRIBER_PRIORITY, [varint(7n)]]]) };
      // Real server request parser; no fabricated onMessage/Session response.
      request.out.injectRead(codec.encode(update));
      await flush(256);
      expect(f.server.session.getIncomingFetch(f.id)?.currentPriority).toBe(7n);
      const replies = request.in.written.slice(before).map(bytes => codec.decode(bytes, 0).message);
      const ack = replies.find(message => message.type === 'REQUEST_OK');
      expect(ack).toBeDefined();
      expect(f.subscriptionProviderCalls, 'do not silently reuse subscription-ID provider for FETCH').toEqual([]);
      const value = ack?.type === 'REQUEST_OK' ? ack.parameters.get(MessageParam.LARGEST_OBJECT)?.[0] : undefined;
      const largest = value instanceof Uint8Array ? readLocation(value, 0).value : value;
      expect(largest, 'FETCH publication head is independent of the finite endpoint').toEqual(f.publication);
    } finally { await f.client.close(); await f.server.close(); }
  });

  it(`draft${draft} public API boundaries and available finite FETCH delivery control`, async () => {
    const f = await prepare(draft);
    try {
      const ack = await f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(7n), timeoutMs: 1000 });
      const raw = ack.parameters.get(MessageParam.LARGEST_OBJECT)?.[0];
      expect(raw instanceof Uint8Array ? readLocation(raw, 0).value : raw).toEqual(f.publication);
      expect(f.client.session.getFetch(f.id)?.currentPriority).toBe(7n);
      expect([f.client.session.getFetch(f.id)?.endGroup, f.client.session.getFetch(f.id)?.endObject]).toEqual([3n, 5n]);
      if (draft === 16) {
        await expect(f.server.openFetchStream(f.id)).rejects.toThrow('openFetchStream is draft-18 only');
        expect(f.server.session.getIncomingFetch(f.id)?.state).toBe('transferring');
        expect(f.subscriptionProviderCalls).toEqual([]);
        return;
      }
      if (f.stream === null) throw new Error('missing18 stream');
      await f.server.sendFetchObject(f.stream, { groupId: 3n, subgroupId: 0n, objectId: 0n,
        publisherPriority: 128, payload: f.cache[0]!.payload });
      await f.server.closeFetchStream(f.stream); await flush(256);
      expect(f.received).toEqual([11, 22]);
      expect(f.subscriptionProviderCalls).toEqual([]);
    } finally { await f.client.close(); await f.server.close(); }
  });
}
