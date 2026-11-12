import { expect, it, vi } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { MessageParam, varint } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
// The CLI connector is not part of these in-memory producer tests; do not load its native provider.
vi.mock('./client.js', () => ({ connectClient: () => { throw new Error('Network connector must not run'); } }));
import { publishTrack, publishGroupObjects } from './publisher.js';

it.each([18, 22] as const)('demo producer keeps the same publication owner across update and next group (draft %i)', async draft => {
  const { a, b } = createLoopback();
  const producer = new MoqtConnection(draft), receiver = new MoqtConnection(draft, { role: 'server' });
  let requestId = -1n;
  const received: { group: bigint; object: bigint }[] = [];
  receiver.onPublish = publication => {
    requestId = publication.requestId;
    publication.onObject = object => { if (object.kind === 'data') received.push({ group: object.groupId, object: object.objectId }); };
    setImmediate(() => { void receiver.acceptSubscribe(publication.requestId, publication.trackAlias); });
  };
  await Promise.all([producer.connect(a), receiver.connect(b)]);
  try {
    await publishTrack(producer, 'objects', 9n, ['first']);
    const owner = producer.session.getOutgoingPublish(requestId);
    const first = await receiver.requestUpdateConfirmed(requestId, { subscriberPriority: varint(1n), timeoutMs: 1000 });
    expect(first.parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0]).toEqual({ group: 0n, object: 0n });
    await publishGroupObjects(producer, 9n, 1n, ['next']); await flush(64);
    const next = await receiver.requestUpdateConfirmed(requestId, { subscriberPriority: varint(2n), timeoutMs: 1000 });
    expect(next.parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0]).toEqual({ group: 1n, object: 0n });
    expect(received).toEqual([{ group: 0n, object: 0n }, { group: 1n, object: 0n }]);
    expect(producer.session.getOutgoingPublish(requestId)).toBe(owner);
    expect(owner?.isTerminated).toBe(false);
  } finally { await Promise.all([producer.close(), receiver.close()]); }
});
