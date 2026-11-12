/** Draft16 §9.11: subscriber updates of an accepted PUBLISH use the shared control stream. */
import { describe, expect, it } from 'vitest';
import { ForwardState, SessionState, encodeControlMessage, varint } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { RequestUpdateError, RequestUpdateFailure } from './request-update-confirmation.js';
import { catToken, type AuthorizationToken } from './authorization.js';
import { createLoopback, flush } from './testkit/loopback.js';

const namespace = [Uint8Array.of(108)];
const name = Uint8Array.of(118);
const token = catToken(Uint8Array.of(1, 2, 3));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  const result = promise.then(value => { state = 'resolved'; return { value, error: undefined }; },
    (error: unknown) => { state = 'rejected'; return { value: undefined, error }; });
  return { state: () => state, result };
}
async function fixture(credentials?: Promise<readonly AuthorizationToken[]>) {
  const { a, b } = createLoopback();
  const publisher = new MoqtConnection(16, { role: 'server' });
  const subscriber = new MoqtConnection(16);
  const errors: Error[] = [];
  publisher.onError = subscriber.onError = error => { errors.push(error); };
  const updates: bigint[] = [];
  publisher.onMessage = message => { if (message.type === 'REQUEST_UPDATE') updates.push(message.requestId); };
  let id: bigint | undefined;
  subscriber.onPublish = publication => {
    id = publication.requestId;
    void subscriber.acceptSubscribe(publication.requestId, publication.trackAlias);
  };
  const authorization = credentials ? {
    relayUrl: 'https://relay.example/moq',
    getTokens: (context: { operation: string }) => context.operation === 'REQUEST_UPDATE' ? credentials : [token],
  } : undefined;
  await Promise.all([publisher.connect(b, { maxRequestId: varint(1000n) }), subscriber.connect(a, { maxRequestId: varint(1000n), ...(authorization ? { authorization } : {}) })]);
  await publisher.publish(namespace, name, 77n);
  await flush(128);
  expect(id).toBeDefined();
  const requestId = id!;
  const source = publisher.session.getOutgoingPublish(requestId)!;
  const owner = subscriber.session.getIncomingSubscription(requestId)!;
  expect(owner.isPublishInitiated).toBe(true);
  expect(owner.state).toBe('established');
  publisher.setLargestLocationProvider(target => {
    if (target !== requestId || publisher.session.getOutgoingPublish(target) !== source || source.isTerminated) throw new Error('source unavailable');
    return { group: 5n, object: 3n };
  });
  const ackPipe = a.bidiOut[0]!.in;
  const updatePipe = a.bidiOut[0]!.out;
  return { publisher, subscriber, requestId, source, owner, updates, errors, ackPipe, updatePipe,
    async close() { ackPipe.releaseHeld(); await publisher.close(); await subscriber.close(); await flush(32); } };
}

describe('draft16 inbound PUBLISH confirmed updates', () => {
  it('stages priority and pause until the real ACK and preserves send-only completion', async () => {
    const f = await fixture();
    try {
      const priority = f.owner.currentPriority;
      f.ackPipe.faults.hold = true;
      const wait = observe(f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(9n), forward: 0, timeoutMs: 2000 }));
      await flush(128);
      expect(f.updates).toHaveLength(1);
      expect(f.source.forwardState).toBe(ForwardState.PAUSED);
      expect(f.owner.forwardState).toBe(ForwardState.ACTIVE);
      expect(f.owner.currentPriority).toBe(priority);
      expect(wait.state()).toBe('pending');
      f.ackPipe.releaseHeld();
      expect((await wait.result).error).toBeUndefined();
      expect(f.owner.currentPriority).toBe(9n);
      expect(f.owner.forwardState).toBe(ForwardState.PAUSED);
      f.ackPipe.faults.hold = true;
      const sent = await f.subscriber.requestUpdate(f.requestId, { forward: 1 });
      expect(typeof sent).toBe('bigint');
      expect(f.owner.forwardState).toBe(ForwardState.PAUSED);
      f.ackPipe.releaseHeld(); await flush(128);
      expect(f.owner.forwardState).toBe(ForwardState.ACTIVE);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('peer refusal rejects with wire metadata and retires only the publication', async () => {
    const f = await fixture();
    try {
      f.publisher.setLargestLocationProvider(() => { throw new Error('unavailable'); });
      const result = await observe(f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(9n), timeoutMs: 2000 })).result;
      expect(result.error).toBeInstanceOf(RequestUpdateError);
      expect(result.error).toMatchObject({ errorCode: 0n, retryInterval: 0n, disposition: 'possibly-sent' });
      await flush(128);
      expect(f.subscriber.session.getIncomingSubscription(f.requestId)).toBeUndefined();
      expect(f.publisher.session.getOutgoingPublish(f.requestId)).toBeUndefined();
      expect(f.subscriber.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.publisher.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('timeout leaves late ACK protocol-owned and a later waiter distinct', async () => {
    const f = await fixture();
    try {
      f.ackPipe.faults.hold = true;
      const first = observe(f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(9n), timeoutMs: 30 }));
      expect((await first.result).error).toMatchObject({ name: 'TimeoutError', disposition: 'possibly-sent' });
      expect(f.updates).toHaveLength(1);
      const second = observe(f.subscriber.requestUpdateConfirmed(f.requestId, { forward: 0, timeoutMs: 2000 }));
      await flush(128); expect(second.state()).toBe('pending');
      f.ackPipe.releaseHeld();
      expect((await second.result).error).toBeUndefined();
      expect(f.owner.currentPriority).toBe(9n);
      expect(f.owner.forwardState).toBe(ForwardState.PAUSED);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(['release', 'abort', 'terminal'] as const)('held authorization: %s preserves exact ownership', async mode => {
    const credentials = deferred<readonly AuthorizationToken[]>();
    const f = await fixture(credentials.promise);
    const controller = new AbortController();
    try {
      const wait = observe(f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(9n), timeoutMs: 2000, signal: controller.signal }));
      await flush(64);
      expect(wait.state()).toBe('pending'); expect(f.updates).toEqual([]);
      if (mode === 'abort') controller.abort();
      if (mode === 'terminal') await f.publisher.publishDone(f.requestId, varint(0n), 'finished');
      if (mode !== 'release') {
        await flush(128);
        expect(wait.state()).toBe('rejected');
        const result = await wait.result;
        expect(result.error).toBeInstanceOf(RequestUpdateFailure);
        expect(result.error).toMatchObject({ disposition: 'not-sent' });
        expect((result.error as Error).name).not.toBe('TimeoutError');
      }
      credentials.resolve([token]); await flush(128);
      if (mode === 'release') {
        expect((await wait.result).error).toBeUndefined();
        expect(f.updates).toHaveLength(1); expect(f.owner.currentPriority).toBe(9n);
      } else expect(f.updates).toEqual([]);
      expect(f.subscriber.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.errors).toEqual([]);
    } finally { credentials.resolve([token]); await f.close(); }
  });

  it('PUBLISH_DONE settles an admitted but not yet received update without closing the session', async () => {
    const f = await fixture();
    try {
      f.updatePipe.faults.hold = true;
      let admitted: bigint | undefined;
      const wait = observe(f.subscriber.requestUpdateConfirmed(f.requestId, {
        subscriberPriority: varint(9n), timeoutMs: 2000, onRequestId: id => { admitted = id; },
      }));
      await flush(64);
      expect(admitted).toBeDefined();
      expect(wait.state()).toBe('pending');
      expect(f.updates).toEqual([]);
      await f.publisher.publishDone(f.requestId, varint(0n), 'finished');
      await flush(128);
      expect(wait.state()).toBe('rejected');
      expect((await wait.result).error).toMatchObject({ disposition: 'possibly-sent' });
      expect(f.subscriber.session.getIncomingSubscription(f.requestId)).toBeUndefined();
      expect(f.subscriber.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.errors).toEqual([]);
      // Do not deliver a now-obsolete held update to its already-terminal peer.
      // Connection cleanup owns the held transport bytes.
    } finally { await f.close(); }
  });

  it('ACK before DONE resolves before the publication is reclaimed', async () => {
    const f = await fixture();
    try {
      f.ackPipe.faults.hold = true;
      const wait = observe(f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(9n), timeoutMs: 2000 }));
      await flush(128); expect(f.updates).toHaveLength(1);
      await f.publisher.publishDone(f.requestId, varint(0n), 'finished');
      expect(wait.state()).toBe('pending');
      f.ackPipe.releaseHeld();
      expect((await wait.result).error).toBeUndefined();
      await flush(128);
      expect(f.subscriber.session.getIncomingSubscription(f.requestId)).toBeUndefined();
      expect(f.subscriber.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('a refusing admission callback remains not-sent and reclaims its legacy request ID', async () => {
    const f = await fixture();
    try {
      const first = await f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(8n), timeoutMs: 2000 });
      const reason = new Error('caller declined');
      const refused = await observe(f.subscriber.requestUpdateConfirmed(f.requestId, {
        forward: 0, timeoutMs: 2000, onRequestId: () => { throw reason; },
      })).result;
      expect(refused.error).toMatchObject({ disposition: 'not-sent', cause: reason });
      const next = await f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(9n), timeoutMs: 2000 });
      expect(next.requestId).toBe(first.requestId + 2n);
      expect(f.updates).toHaveLength(2);
      expect(f.owner.forwardState).toBe(ForwardState.ACTIVE);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('an admitted legacy write failure is possibly-sent and session-terminal', async () => {
    const f = await fixture();
    try {
      const writer = (f.subscriber as unknown as { controlWriter: WritableStreamDefaultWriter<Uint8Array> }).controlWriter;
      const original = writer.write.bind(writer);
      const reason = new Error('write failed');
      writer.write = () => { writer.write = original; return Promise.reject(reason); };
      const result = await observe(f.subscriber.requestUpdateConfirmed(f.requestId, { forward: 0, timeoutMs: 2000 })).result;
      expect(result.error).toMatchObject({ disposition: 'possibly-sent', cause: reason });
      await flush(64);
      expect(f.subscriber.session.state).toBe(SessionState.CLOSED);
      expect(f.updates).toEqual([]);
    } finally { await f.close(); }
  });

  it('ordinary incoming SUBSCRIBE is not a subscriber-owned update target', async () => {
    const f = await fixture();
    try {
      let id: bigint | undefined;
      f.subscriber.onSubscribe = requestId => { id = requestId; void f.subscriber.acceptSubscribe(requestId, 88n); };
      await f.publisher.subscribe(namespace, Uint8Array.of(119)); await flush(128);
      expect(id).toBeDefined();
      const before = f.updates.length;
      await expect(f.subscriber.requestUpdateConfirmed(id!, { subscriberPriority: varint(9n), timeoutMs: 1000 })).rejects.toMatchObject({ disposition: 'not-sent' });
      await expect(f.subscriber.requestUpdate(id!, { subscriberPriority: varint(9n) })).rejects.toThrow();
      expect(() => f.subscriber.session.updateIncomingSubscription(id!, { subscriberPriority: varint(9n) })).toThrow();
      await flush(64); expect(f.updates).toHaveLength(before);
      expect(f.subscriber.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await f.close(); }
  });

  it.each([{ trackNamespacePrefix: namespace }, { subgroupDeliveryTimeout: varint(3n) }])('invalid subscription option rejects before allocation', async option => {
    const f = await fixture();
    try {
      const first = await f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(8n), timeoutMs: 2000 });
      await expect(f.subscriber.requestUpdateConfirmed(f.requestId, { ...option, timeoutMs: 1000 })).rejects.toMatchObject({ disposition: 'not-sent' });
      const second = await f.subscriber.requestUpdateConfirmed(f.requestId, { subscriberPriority: varint(9n), timeoutMs: 2000 });
      expect(second.requestId).toBe(first.requestId + 2n);
      expect(f.updates).toHaveLength(2); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});


/** Legitimate peer control isolates receiver support: the SDK sender still refuses pending DONE. */
