/** Send-only legacy update rollback: omitted-field replay, unreclaimable reentrant allocation,
 * and fail-closed handling of in-place inline-state mutation before write admission. */
import { describe, expect, it } from 'vitest';
import { ForwardState, MessageParam, SessionError, SessionState, decodeSubscriptionFilter, varint } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';

type Draft = 14 | 16;
const NS = [new TextEncoder().encode('live')], NAME = new TextEncoder().encode('video');
const settled = <T,>(p: Promise<T>) => p.then(v => ({ status: 'resolved' as const, value: v }), e => ({ status: 'rejected' as const, error: e as Error & { cause?: unknown } }));
const UPDATE_TYPES = new Set(['SUBSCRIBE_UPDATE', 'REQUEST_UPDATE']);

async function establish(draft: Draft) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = []; client.onError = e => { errors.push(String(e)); }; server.onError = () => undefined;
  const closes: Array<{ code: number | undefined; reason: string | undefined }> = []; client.onClose = (code, reason) => { closes.push({ code, reason }); };
  let updates = 0; server.onMessage = m => { if (UPDATE_TYPES.has(m.type)) updates++; };
  server.onSubscribe = id => { void server.acceptSubscribe(id, 42n); };
  await Promise.all([client.connect(a), server.connect(b, { maxRequestId: varint(1000n) })]);
  const sub = await client.subscribeTrack(NS, NAME);
  await flush(32);
  expect(errors).toEqual([]);
  // This source produces no Objects. Empty is known only for its exact live owner.
  const publication = { owner: server.session.getIncomingSubscription(sub.requestId)! };
  server.setLargestLocationProvider(id => {
    if (id !== sub.requestId || server.session.getIncomingSubscription(id) !== publication.owner
        || publication.owner.isTerminated) throw new Error('Publication unavailable');
    return null;
  });
  const update = (priority: bigint) => settled(client.requestUpdate(sub.requestId, { subscriberPriority: varint(priority) }));
  const updateIds: bigint[] = []; server.onMessage = m => { if (UPDATE_TYPES.has(m.type)) { updates++; updateIds.push(BigInt((m as { requestId: bigint }).requestId)); } };
  const local = () => { const s = client.session.getSubscription(sub.requestId)!; return { priority: s.currentPriority === undefined ? undefined : BigInt(s.currentPriority as bigint), forward: s.forwardState, filter: s.currentFilter === undefined ? undefined : Array.from(s.currentFilter) }; };
  const close = async () => { await client.close(); await server.close(); await flush(16); };
  return { client, server, sub, errors, closes, updates: () => updates, updateIds, update, local, close };
}

describe('send-only legacy follow-up rollback boundaries', () => {
  it('draft 14: later omitted fields replay only the last actually sent values after a pre-write refusal', async () => {
    const f = await establish(14);
    const updates: Array<{ parameters: Map<bigint, unknown[]> }> = [];
    const previous = f.server.onMessage;
    f.server.onMessage = m => { previous?.(m); if (UPDATE_TYPES.has(m.type)) updates.push(m as unknown as { parameters: Map<bigint, unknown[]> }); };
    try {
      await f.client.requestUpdate(f.sub.requestId, { subscriberPriority: varint(8n), forward: 1, subscriptionFilter: { type: 'AbsoluteStart', startGroup: 2n, startObject: 0n } });
      await flush(32);
      const baseline = f.local();
      f.client.onQlogEvent = e => { if (e.type === 'control_message_created' && UPDATE_TYPES.has((e.message as { type: string }).type)) throw new Error('refused before write'); };
      const refused = await settled(f.client.requestUpdate(f.sub.requestId, { subscriberPriority: varint(9n), forward: 0, subscriptionFilter: { type: 'AbsoluteStart', startGroup: 7n, startObject: 0n } }));
      delete f.client.onQlogEvent;
      expect(refused.status).toBe('rejected');
      expect(await settled(f.client.requestUpdate(f.sub.requestId, {}))).toMatchObject({ status: 'resolved' });
      await flush(32);
      const last = updates.at(-1)!;
      const p = last.parameters;
      const filter = decodeSubscriptionFilter(p.get(MessageParam.SUBSCRIPTION_FILTER as bigint)![0] as Uint8Array, 14);

      expect(updates).toHaveLength(2);
      expect(p.get(MessageParam.SUBSCRIBER_PRIORITY as bigint)?.[0]).toBe(8n);
      expect(p.get(MessageParam.FORWARD as bigint)?.[0]).toBe(1n);
      expect(filter).toMatchObject({ type: 'AbsoluteStart', startGroup: 2n, startObject: 0n });
      expect(f.local()).toEqual(baseline);
      expect(f.local().forward).toBe(ForwardState.ACTIVE);
    } finally { await f.close(); }
  });
});
