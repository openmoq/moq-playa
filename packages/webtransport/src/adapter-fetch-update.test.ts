import { expect, it, vi } from 'vitest';
import { MessageParam, readLocation, varint, type Parameters } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush, createLoopback } from './testkit/loopback.js';
import { MoqtConnection } from './adapter.js';
import { catToken, type AuthorizationContext, type AuthorizationToken } from './authorization.js';

async function fixture(draft: 16 | 18 | 22) {
  const f = await connectedPair(draft);
  const subscriptionProvider = vi.fn(() => { throw new Error('subscription provider received FETCH'); });
  f.server.setLargestLocationProvider(subscriptionProvider);
  f.server.setFetchLargestLocationProvider(id => {
    if (!f.server.session.getIncomingFetch(id)) throw new Error('unavailable');
    return { group: 9n, object: 4n };
  });
  const id = await f.client.fetch(ns('published'), nm('video'), {
    startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 5n,
  });
  await flush(128);
  await f.server.acceptFetch(id, { endLocation: { group: 3n, object: 5n } });
  await flush(128);
  return { ...f, id, subscriptionProvider };
}

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} public FETCH updates confirm priority without changing finite endpoint`, async () => {
    const f = await fixture(draft);
    try {
      const owner = f.client.session.getFetch(f.id)!;
      const end = [owner.endGroup, owner.endObject];
      const ack = await f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(7n), timeoutMs: 1000 });
      const raw = ack.parameters.get(MessageParam.LARGEST_OBJECT)?.[0];
      expect(raw instanceof Uint8Array ? readLocation(raw, 0).value : raw).toEqual({ group: 9n, object: 4n });
      expect(owner.currentPriority).toBe(7n);
      expect(f.server.session.getIncomingFetch(f.id)?.currentPriority).toBe(7n);
      expect([owner.endGroup, owner.endObject]).toEqual(end);
      const next = await f.client.requestUpdate(f.id, { subscriberPriority: varint(11n) });
      expect(next).toBeGreaterThan(ack.requestId);
      await flush(128);
      expect(owner.currentPriority).toBe(11n);
      expect(f.subscriptionProvider).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    } finally { await f.client.close(); await f.server.close(); }
  });

  it(`draft${draft} FETCH refuses subscription-only options without damaging the live owner`, async () => {
    const f = await fixture(draft);
    try {
      await expect(f.client.requestUpdateConfirmed(f.id, { forward: 0, timeoutMs: 1000 })).rejects.toMatchObject({ disposition: 'not-sent' });
      expect(f.server.session.getIncomingFetch(f.id)?.state).toBe('transferring');
      expect(f.errors).toEqual([]);
    } finally { await f.client.close(); await f.server.close(); }
  });

  it(`draft${draft} FETCH cancellation settles a held confirmation and cannot commit late ACK`, async () => {
    const f = await fixture(draft);
    try {
      const owner = f.client.session.getFetch(f.id)!;
      const prior = owner.currentPriority;
      const response = f.a.bidiOut.at(-1)!.in;
      response.faults.hold = true;
      const result = f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(7n), timeoutMs: 1000 });
      const outcome = result.then(() => 'accepted', error => error);
      await flush(128);
      expect(f.server.session.getIncomingFetch(f.id)?.currentPriority).toBe(7n);
      await f.client.fetchCancel(f.id);
      await flush(128);
      expect(await outcome).toMatchObject({ disposition: 'possibly-sent' });
      response.releaseHeld();
      await flush(128);
      expect(owner.currentPriority).toBe(prior);
      expect(f.client.session.getFetch(f.id)).toBeUndefined();
    } finally { await f.client.close(); await f.server.close(); }
  });
}

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} late FETCH ACK after timeout applies priority only to the live owner`, async () => {
    const f = await fixture(draft);
    vi.useFakeTimers();
    try {
      const owner = f.client.session.getFetch(f.id)!;
      const response = f.a.bidiOut.at(-1)!.in;
      response.faults.hold = true;
      const outcome = f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(19n), timeoutMs: 1000 }).catch(error => error);
      await flush(128);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await outcome).toMatchObject({ disposition: 'possibly-sent' });
      expect(owner.currentPriority).toBe(128n);
      response.releaseHeld();
      await flush(128);
      expect(owner.currentPriority).toBe(19n);
      expect([owner.endGroup, owner.endObject]).toEqual([3n, 5n]);
      expect(f.errors).toEqual([]);
    } finally { vi.useRealTimers(); await f.client.close(); await f.server.close(); }
  });

  for (const callback of ['throw', 'cancel'] as const) {
    it(`draft${draft} FETCH ownership callback ${callback} admits no update`, async () => {
      const f = await fixture(draft);
      const updates: unknown[] = [];
      f.server.onMessage = m => { if (m.type === 'REQUEST_UPDATE') updates.push(m); };
      try {
        const result = await f.client.requestUpdateConfirmed(f.id, {
          subscriberPriority: varint(7n), timeoutMs: 1000,
          onRequestId: () => {
            if (callback === 'throw') throw new Error('callback refused');
            void f.client.fetchCancel(f.id);
          },
        }).catch(error => error);
        expect(result).toMatchObject({ disposition: 'not-sent' });
        await flush(128);
        expect(updates).toEqual([]);
        if (callback === 'throw') {
          await f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(9n), timeoutMs: 1000 });
          expect(f.client.session.getFetch(f.id)?.currentPriority).toBe(9n);
        }
      } finally { await f.client.close(); await f.server.close(); }
    });
  }
}

it('draft22 FETCH MAX_REQUEST_UPDATES credit returns after the held ACK', async () => {
  const f = await connectedPair(22, { serverSetup: { maxRequestUpdates: 1n } });
  f.server.setFetchLargestLocationProvider(() => ({ group: 3n, object: 4n }));
  try {
    const id = await f.client.fetch(ns('published'), nm('video'), { startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 5n });
    await flush(128);
    await f.server.acceptFetch(id, { endLocation: { group: 3n, object: 5n } });
    await flush(128);
    const response = f.a.bidiOut.at(-1)!.in;
    response.faults.hold = true;
    const first = f.client.requestUpdateConfirmed(id, { subscriberPriority: varint(7n), timeoutMs: 1000 });
    await flush(128);
    await expect(f.client.requestUpdateConfirmed(id, { subscriberPriority: varint(8n), timeoutMs: 1000 })).rejects.toMatchObject({ disposition: 'not-sent' });
    response.releaseHeld();
    await first;
    await f.client.requestUpdateConfirmed(id, { subscriberPriority: varint(9n), timeoutMs: 1000 });
    expect(f.client.session.getFetch(id)?.currentPriority).toBe(9n);
    expect(f.errors).toEqual([]);
  } finally { await f.client.close(); await f.server.close(); }
});

for (const draft of [16, 18, 22] as const) {
  for (const cancel of [false, true]) {
    it(`draft${draft} FETCH credentials preserve exact track and invocation FIFO cancel=${cancel}`, async () => {
      const { a, b } = createLoopback();
      const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
      const contexts: AuthorizationContext[] = [];
      const releases: ((value: readonly AuthorizationToken[]) => void)[] = [];
      const token = catToken(Uint8Array.of(1, 2, 3));
      const updates: bigint[] = [];
      server.onMessage = m => {
        if (m.type === 'REQUEST_UPDATE') updates.push((m as { parameters: Parameters }).parameters.get(MessageParam.SUBSCRIBER_PRIORITY)![0] as bigint);
      };
      server.setFetchLargestLocationProvider(() => ({ group: 3n, object: 4n }));
      try {
        await Promise.all([client.connect(a, { authorization: { relayUrl: 'https://relay.example/moq', getTokens: context => {
          if (context.operation !== 'REQUEST_UPDATE') return [token];
          contexts.push(context);
          return new Promise(resolve => releases.push(resolve));
        } } }), server.connect(b, { maxRequestId: varint(1000n) })]);
        const namespace = ns('published'), name = nm('video');
        const id = await client.fetch(namespace, name, { startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 5n });
        namespace[0]!.fill(0); name.fill(0);
        await flush(128);
        await server.acceptFetch(id, { endLocation: { group: 3n, object: 5n } });
        await flush(128);
        const first = client.requestUpdateConfirmed(id, { subscriberPriority: varint(7n), timeoutMs: 1000 }).catch(error => error);
        const second = client.requestUpdateConfirmed(id, { subscriberPriority: varint(9n), timeoutMs: 1000 }).catch(error => error);
        await flush(64);
        expect(contexts).toHaveLength(2);
        for (const context of contexts) {
          expect(context.namespace).toEqual(ns('published'));
          expect(context.trackName).toEqual(nm('video'));
          expect(context.existingRequestId).toBe(id);
        }
        releases[1]!([token]); await flush(64);
        expect(updates).toEqual([]);
        if (cancel) await client.fetchCancel(id);
        releases[0]!([token]);
        const results = await Promise.all([first, second]);
        await flush(128);
        if (cancel) {
          for (const result of results) expect(result).toMatchObject({ disposition: 'not-sent' });
          expect(updates).toEqual([]);
        } else {
          for (const result of results) expect(result.parameters).toBeInstanceOf(Map);
          expect(updates).toEqual([7n, 9n]);
          expect(client.session.getFetch(id)?.currentPriority).toBe(9n);
        }
      } finally { for (const release of releases) release([token]); await client.close(); await server.close(); }
    });
  }
}

for (const draft of [16, 18, 22] as const) {
  it(`draft${draft} failed FETCH update rejects its confirmation and preserves sibling`, async () => {
    const f = await fixture(draft);
    try {
      const sibling = await f.client.fetch(ns('published'), nm('video'), { startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 5n });
      await flush(128);
      await f.server.acceptFetch(sibling, { endLocation: { group: 3n, object: 5n } });
      await flush(128);
      f.server.setFetchLargestLocationProvider(id => {
        if (id === f.id) throw { get message() { throw new Error('must not execute'); } };
        return { group: 9n, object: 4n };
      });
      const owner = f.client.session.getFetch(f.id)!;
      await expect(f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(7n), timeoutMs: 1000 })).rejects.toMatchObject({ name: 'RequestUpdateError' });
      await flush(128);
      expect(owner.currentPriority).toBe(128n);
      expect(f.client.session.getFetch(f.id)).toBeUndefined();
      await f.client.requestUpdateConfirmed(sibling, { subscriberPriority: varint(9n), timeoutMs: 1000 });
      expect(f.client.session.getFetch(sibling)?.currentPriority).toBe(9n);
      expect(f.client.session.state).toBe('established');
    } finally { await f.client.close(); await f.server.close(); }
  });
}

for (const draft of [16, 18] as const) {
  it(`draft${draft} Joining FETCH update retains establishment snapshot and its own authorization identity`, async () => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
    const contexts: AuthorizationContext[] = [];
    const head = draft === 16 ? Uint8Array.of(5, 2) : { group: 5n, object: 2n };
    server.onSubscribe = id => { void server.acceptSubscribe(id, 42n, { parameters: new Map([[MessageParam.LARGEST_OBJECT, [head]]]) }); };
    server.setFetchLargestLocationProvider(() => ({ group: 9n, object: 4n }));
    server.setLargestLocationProvider(() => { throw new Error('FETCH identity escaped'); });
    try {
      await Promise.all([client.connect(a, { authorization: { relayUrl: 'https://relay.example/moq', getTokens: context => {
        contexts.push(context); return [catToken(Uint8Array.of(1, 2, 3))];
      } } }), server.connect(b, { maxRequestId: varint(1000n) })]);
      const sub = await client.subscribeTrack(ns('published'), nm('video'), { filter: { type: 'LargestObject' } });
      await flush(128);
      const id = await client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub.requestId, joiningStart: 0n });
      await flush(128);
      const range = server.resolveJoiningFetch(id);
      await server.acceptFetch(id, { endLocation: range.endLocation });
      await flush(128);
      await client.requestUpdateConfirmed(id, { subscriberPriority: varint(7n), timeoutMs: 1000 });
      const update = contexts.filter(context => context.operation === 'REQUEST_UPDATE');
      expect(update).toHaveLength(1);
      expect(update[0]).toMatchObject({ existingRequestId: id, namespace: ns('published'), trackName: nm('video') });
      expect(server.resolveJoiningFetch(id)).toEqual(range);
      const second = await client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub.requestId, joiningStart: 0n });
      await flush(128);
      expect(server.resolveJoiningFetch(second)).toEqual(range);
      expect(server.session.getIncomingSubscription(sub.requestId)?.state).toBe('established');
    } finally { await client.close(); await server.close(); }
  });
}

for (const draft of [16, 18, 22] as const) {
  for (const terminal of ['abort-wait', 'close'] as const) {
    it(`draft${draft} FETCH ${terminal} settles an emitted wait`, async () => {
      const f = await fixture(draft);
      try {
        const response = f.a.bidiOut.at(-1)!.in;
        response.faults.hold = true;
        const controller = new AbortController();
        const result = f.client.requestUpdateConfirmed(f.id, {
          subscriberPriority: varint(7n), timeoutMs: 1000, signal: controller.signal,
        }).catch(error => error);
        await flush(128);
        if (terminal === 'close') await f.client.close();
        else controller.abort();
        expect(await result).toMatchObject({ disposition: 'possibly-sent' });
        response.releaseHeld();
        await flush(128);
        if (terminal === 'abort-wait') {
          expect(f.client.session.getFetch(f.id)?.currentPriority).toBe(7n);
          await f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(9n), timeoutMs: 1000 });
        }
      } finally { await f.client.close(); await f.server.close(); }
    });
  }
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} FETCH updated priority preserves finite decoded retrieval and FIN`, async () => {
    const f = await fixture(draft);
    const received: bigint[] = [];
    f.client.onObject = (_streamId, object) => { received.push(object.objectId); };
    try {
      await f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(7n), timeoutMs: 1000 });
      const stream = await f.server.openFetchStream(f.id);
      await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: 0n, publisherPriority: 128, payload: Uint8Array.of(11) });
      await f.server.sendFetchObject(stream, { groupId: 3n, subgroupId: 0n, objectId: 4n, publisherPriority: 128, payload: Uint8Array.of(22) });
      await f.server.closeFetchStream(stream);
      await flush(256);
      expect(received).toEqual([0n, 4n]);
      expect(f.client.session.getFetch(f.id)).toBeUndefined();
      await expect(f.client.requestUpdateConfirmed(f.id, { subscriberPriority: varint(9n), timeoutMs: 1000 })).rejects.toMatchObject({ disposition: 'not-sent' });
      expect(f.errors).toEqual([]);
    } finally { await f.client.close(); await f.server.close(); }
  });
}
