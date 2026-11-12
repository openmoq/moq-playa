import { expect, it } from 'vitest';
import { MessageParam, locationEncodingLength, writeLocation, varint, type Parameters } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { MoqtConnection } from './adapter.js';

async function updatePair(draft: 16 | 18 | 22) {
  if (draft !== 16) return connectedPair(draft);
  const { a, b } = createLoopback();
  const client = new MoqtConnection(16);
  const server = new MoqtConnection(16, { role: 'server' });
  const errors: Error[] = [];
  client.onError = server.onError = error => { errors.push(error); };
  // Both sides allocate request IDs: client PUBLISH, server REQUEST_UPDATE.
  await Promise.all([client.connect(a, { maxRequestId: varint(1000n) }), server.connect(b, { maxRequestId: varint(1000n) })]);
  return { client, server, a, b, errors };
}

function largest(draft: 16 | 18 | 22, group: bigint, object: bigint): Parameters {
  const location = { group, object };
  if (draft !== 16) return new Map([[MessageParam.LARGEST_OBJECT, [location]]]);
  const bytes = new Uint8Array(locationEncodingLength(location));
  writeLocation(location, bytes, 0);
  return new Map([[MessageParam.LARGEST_OBJECT, [bytes]]]);
}
for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} SUBSCRIBE_OK head and priority response are monotonic without changing Joining/window anchor`, async () => {
    const f = await connectedPair(draft);
    f.server.onSubscribe = () => {}; f.server.onFetch = () => {};
    try {
      const id = await f.client.subscribe(ns('metadata'), nm('video'), { subscriptionFilter: { type: 'LargestObject' } });
      await flush(128);
      await f.server.acceptSubscribe(id, 41n, { parameters: largest(draft, 9n, 1n) }); await flush(128);
      const owner = f.client.session.getSubscription(id)!;
      const window = structuredClone(owner.locationWindow);
      await flush(128);
      expect(owner.largestLocation, 'initial response head').toEqual({ groupId: 9n, objectId: 1n });
      f.server.setLargestLocationProvider(() => ({ group: 12n, object: 3n }));
      await f.client.requestUpdate(id, { subscriberPriority: varint(7n) });
      await flush(128);
      expect(owner.largestLocation).toEqual({ groupId: 12n, objectId: 3n });
      f.server.setLargestLocationProvider(() => ({ group: 8n, object: 1n }));
      await f.client.requestUpdate(id, { subscriberPriority: varint(8n) });
      await flush(128);
      expect(owner.largestLocation, 'lower metadata cannot regress').toEqual({ groupId: 12n, objectId: 3n });
      f.server.setLargestLocationProvider(() => null);
      await f.client.requestUpdate(id, { subscriberPriority: varint(9n) });
      await flush(128);
      expect(owner.largestLocation, 'omission cannot erase').toEqual({ groupId: 12n, objectId: 3n });
      expect(owner.locationWindow).toEqual(window);
      if (draft !== 22) {
        const join = await f.client.joiningFetch({ joiningRequestId: id, joiningFetchType: 'absolute', joiningStart: 9n });
        await flush(128);
        expect(f.server.resolveJoiningFetch(join).endLocation).toEqual({ group: 9n, object: 2n });
      }
      expect(f.errors).toEqual([]);
    } finally { await f.client.close(); await f.server.close(); }
  });
  it(`draft${draft} incoming PUBLISH metadata exists before application acceptance`, async () => {
    const f = await connectedPair(draft);
    f.server.onPublish = () => {};
    try {
      const id = await f.client.publish(ns('metadata'), nm('video'), 41n, { parameters: largest(draft, 9n, 1n) });
      await flush(128);
      const owner = f.server.session.getIncomingSubscription(id)!;
      expect(owner.isPending).toBe(true);
      expect(owner.largestLocation).toEqual({ groupId: 9n, objectId: 1n });
      await f.server.acceptSubscribe(id, 41n); await flush(128);
      expect(owner.largestLocation).toEqual({ groupId: 9n, objectId: 1n });
      expect(f.errors).toEqual([]);
    } finally { await f.client.close(); await f.server.close(); }
  });
}
