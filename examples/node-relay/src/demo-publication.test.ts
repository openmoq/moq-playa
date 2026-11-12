import { expect, it } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { MessageParam, varint } from '@openmoq/transport';
import { serveDemoSubscribe } from './demo-publication.js';
import { DEMO_NAMESPACE, DEMO_TRACK, DEMO_PAYLOADS, nsBytes, te } from './demo.js';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';

it.each([18, 22] as const)('toy SUBSCRIBE producer answers updates with its actual last Object (draft %i)', async draft => {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  let served!: Promise<void>;
  server.onSubscribe = (id, namespace, name) => { served = serveDemoSubscribe(server, id, namespace, name); };
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const request = await client.subscribeTrack(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    await flush(64); await served;
    const result = await client.requestUpdateConfirmed(request.requestId, { subscriberPriority: varint(7n), timeoutMs: 1000 });
    const value = result.parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0];
    expect(value).toEqual({ group: 0n, object: BigInt(DEMO_PAYLOADS.length - 1) });
    expect(server.session.getIncomingSubscription(request.requestId)?.isTerminated).toBe(false);
  } finally { await Promise.all([client.close(), server.close()]); }
});
