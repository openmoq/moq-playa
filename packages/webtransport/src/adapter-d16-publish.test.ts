/** Draft16 §9.11: subscriber updates of an accepted PUBLISH use the shared control stream. */
import { describe, expect, it } from 'vitest';
import { ForwardState, SessionState, encodeControlMessage, varint } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
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

describe('draft16 pending PUBLISH terminal receipt', () => {
  async function pendingFixture() {
    const { a, b } = createLoopback();
    const publisher = new MoqtConnection(16, { role: 'server' });
    const subscriber = new MoqtConnection(16);
    const responses: string[] = [];
    const errors: Error[] = [];
    publisher.onError = subscriber.onError = error => { errors.push(error); };
    publisher.onMessage = message => {
      if (message.type === 'REQUEST_ERROR' || message.type === 'PUBLISH_OK') responses.push(message.type);
    };
    let id: bigint | undefined;
    subscriber.onPublish = publication => { id = publication.requestId; };
    await Promise.all([
      publisher.connect(b, { maxRequestId: varint(1000n) }),
      subscriber.connect(a, { maxRequestId: varint(1000n) }),
    ]);
    await publisher.publish(namespace, name, 77n);
    await flush(128);
    expect(id).toBeDefined();
    const requestId = id!;
    const owner = subscriber.session.getIncomingSubscription(requestId)!;
    expect(owner.state).toBe('pending');
    expect(subscriber.session.getTrackByAlias(77n)).toBeDefined();
    const done = (target = requestId) => a.bidiOut[0]!.in.injectRead(encodeControlMessage({
      type: 'PUBLISH_DONE', requestId: varint(target), statusCode: varint(0n),
      streamCount: varint(0n), errorReason: 'finished before acceptance',
    }));
    return { publisher, subscriber, responses, errors, requestId, owner, done, a,
      async close() { await publisher.close(); await subscriber.close(); await flush(32); } };
  }

  it('retires pending PUBLISH with exactly one refusal, without session closure or later resurrection', async () => {
    const f = await pendingFixture();
    try {
      await expect(f.subscriber.requestUpdate(f.requestId, { forward: 0 })).rejects.toThrow();
      expect(f.responses).toEqual([]);
      f.done(); await flush(128);
      expect(f.subscriber.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.publisher.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.owner.isTerminated).toBe(true);
      expect(f.subscriber.session.getIncomingSubscription(f.requestId)).toBeUndefined();
      expect(f.subscriber.session.getTrackByAlias(77n)).toBeUndefined();
      expect(f.responses).toEqual(['REQUEST_ERROR']);
      await expect(f.subscriber.acceptSubscribe(f.requestId, 77n)).rejects.toThrow();
      await flush(64);
      expect(f.responses).toEqual(['REQUEST_ERROR']);
      expect(f.subscriber.session.getIncomingSubscription(f.requestId)).toBeUndefined();
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not add a second response when acceptance crosses DONE', async () => {
    const f = await pendingFixture();
    try {
      f.a.bidiOut[0]!.out.faults.hold = true;
      await f.subscriber.acceptSubscribe(f.requestId, 77n);
      expect(f.owner.state).toBe('established');
      expect(f.responses).toEqual([]);
      f.done(); await flush(128);
      expect(f.subscriber.session.state).toBe(SessionState.ESTABLISHED);
      expect(f.subscriber.session.getIncomingSubscription(f.requestId)).toBeUndefined();
      f.a.bidiOut[0]!.out.releaseHeld(); await flush(128);
      expect(f.responses).toEqual(['PUBLISH_OK']);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('still closes for an unknown DONE request', async () => {
    const f = await pendingFixture();
    try {
      f.done(900n); await flush(128);
      expect(f.subscriber.session.state).toBe(SessionState.CLOSED);
      expect(f.responses).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not interpret DONE for an ordinary inbound SUBSCRIBE as inbound PUBLISH', async () => {
    const f = await pendingFixture();
    try {
      let incoming: bigint | undefined;
      f.subscriber.onSubscribe = requestId => { incoming = requestId; };
      await f.publisher.subscribe(namespace, Uint8Array.of(120)); await flush(128);
      expect(incoming).toBeDefined();
      expect(f.subscriber.session.getIncomingSubscription(incoming!)!.isPublishInitiated).toBe(false);
      f.done(incoming!); await flush(128);
      expect(f.subscriber.session.state).toBe(SessionState.CLOSED);
    } finally { await f.close(); }
  });
});

it('draft16 stages an inbound PUBLISH update until ACK while its publisher applies it immediately', async () => {
  const f = await fixture();
  try {
    f.ackPipe.faults.hold = true;
    await f.subscriber.requestUpdate(f.requestId, { subscriberPriority: 9n, forward: 0 });
    await flush(128);
    expect(f.source.currentPriority).toBe(9n);
    expect(f.source.forwardState).toBe(ForwardState.PAUSED);
    expect(f.owner.currentPriority).not.toBe(9n);
    expect(f.owner.forwardState).toBe(ForwardState.ACTIVE);
    f.ackPipe.releaseHeld(); await flush(128);
    expect(f.owner.currentPriority).toBe(9n);
    expect(f.owner.forwardState).toBe(ForwardState.PAUSED);
    expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
