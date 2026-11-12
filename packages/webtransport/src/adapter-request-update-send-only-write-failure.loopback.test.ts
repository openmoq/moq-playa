/**
 * Send-only `requestUpdate` on the legacy control-stream drafts (14, 16): an ACTUAL local control-stream write failure is
 * session-fatal (the control stream is the session), so the operation rejects with the original failure, the session is
 * terminalized with INTERNAL_ERROR, and later work is refused. Controls keep the send-only semantics: a healthy update
 * resolves with its Request ID before any peer acknowledgement, and a pre-write failure (a diagnostic callback throwing
 * before the write is admitted) is not a transport write failure, so the session stays usable. Real SDK on both ends.
 */
import { describe, expect, it } from 'vitest';
import { ForwardState, SessionError, SessionState, varint } from '@openmoq/transport';
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
  /** The control writer the next message will use rejects once: a real local write failure, nothing reaches the peer. */
  const failNextControlWrite = () => {
    const writer = (client as unknown as { controlWriter: WritableStreamDefaultWriter<Uint8Array> }).controlWriter;
    const original = writer.write.bind(writer);
    (writer as { write: unknown }).write = () => { (writer as { write: unknown }).write = original; return Promise.reject(new Error('simulated local write failure')); };
  };
  const update = (priority: bigint) => settled(client.requestUpdate(sub.requestId, { subscriberPriority: varint(priority) }));
  const updateIds: bigint[] = []; server.onMessage = m => { if (UPDATE_TYPES.has(m.type)) { updates++; updateIds.push(BigInt((m as { requestId: bigint }).requestId)); } };
  const local = () => { const s = client.session.getSubscription(sub.requestId)!; return { priority: s.currentPriority === undefined ? undefined : BigInt(s.currentPriority as bigint), forward: s.forwardState, filter: s.currentFilter === undefined ? undefined : Array.from(s.currentFilter) }; };
  const close = async () => { await client.close(); await server.close(); await flush(16); };
  return { client, server, sub, errors, closes, updates: () => updates, updateIds, failNextControlWrite, update, local, close };
}

describe.each([14, 16] as const)('draft-%i: send-only requestUpdate on the control stream', draft => {
  it('control — a healthy update resolves with its Request ID before any acknowledgement and reaches the peer', async () => {
    const f = await establish(draft);
    try {
      const result = await f.update(9n);
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') expect(typeof result.value).toBe('bigint');
      await flush(32);
      expect(f.updates()).toBe(1);
      expect(f.client.session.state).not.toBe(SessionState.CLOSED);
    } finally { await f.close(); }
  });
  it('an actual local control-stream write failure rejects with the original failure, terminalizes the session with INTERNAL_ERROR, and refuses later work', async () => {
    const f = await establish(draft);
    try {
      f.failNextControlWrite();
      const result = await f.update(9n);
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        const chain = [result.error.message, String(result.error.cause ?? '')].join(' ');
        expect(chain, 'the original write failure is the rejection or its cause').toMatch(/simulated local write failure/);
      }
      await flush(32);
      expect(f.updates(), 'nothing reached the peer').toBe(0);
      expect(f.client.session.state, 'the control stream is the session: a failed write there is session-fatal').toBe(SessionState.CLOSED);
      expect(f.closes.map(c => c.code), 'reported once through onClose as a local INTERNAL_ERROR, not a peer protocol violation').toEqual([Number(SessionError.INTERNAL_ERROR)]);
      const later = await f.update(10n);
      expect(later.status, 'later work is refused').toBe('rejected');
    } finally { await f.close(); }
  });
  it('control — a diagnostic callback throwing BEFORE the write is admitted is not a write failure: the operation rejects, the session stays usable', async () => {
    const f = await establish(draft);
    try {
      f.client.onQlogEvent = e => { if (e.type === 'control_message_created' && UPDATE_TYPES.has((e.message as { type: string }).type)) throw new Error('observer refused before the write'); };
      const result = await f.update(9n);
      delete (f.client as { onQlogEvent?: unknown }).onQlogEvent;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error.message).toMatch(/observer refused before the write/);
      await flush(32);
      expect(f.updates(), 'the refused message was never written').toBe(0);
      expect(f.client.session.state, 'not misclassified as a failed transport writer').not.toBe(SessionState.CLOSED);
      const next = await f.update(10n);
      expect(next.status).toBe('resolved');
      await flush(32);
      expect(f.updates(), 'a later send-only update still reaches the peer').toBe(1);
    } finally { await f.close(); }
  });
});

describe('draft-16: send-only requestUpdate refused before the write (legacy pre-write callback)', () => {
  it('reclaims the unsent Request ID: the next update uses previous + 2 (§9.1), no silent gap', async () => {
    const f = await establish(16);
    try {
      const before = await f.update(8n);
      expect(before.status).toBe('resolved');
      f.client.onQlogEvent = e => { if (e.type === 'control_message_created' && UPDATE_TYPES.has((e.message as { type: string }).type)) throw new Error('observer refused before the write'); };
      const refused = await f.update(9n);
      delete (f.client as { onQlogEvent?: unknown }).onQlogEvent;
      expect(refused.status).toBe('rejected');
      await flush(32);
      const after = await f.update(10n);
      expect(after.status).toBe('resolved');
      await flush(32);
      expect(f.updateIds.length).toBe(2);
      expect(f.updateIds[1]! - f.updateIds[0]!, 'the refused allocation was reclaimed: consecutive ids on the wire').toBe(2n);
    } finally { await f.close(); }
  });
});

describe('draft-14: send-only requestUpdate refused before the write (no acknowledgement)', () => {
  it('leaves the local accepted state unchanged: a refused SUBSCRIBE_UPDATE must not have applied priority, filter or Forward locally', async () => {
    const f = await establish(14);
    try {
      const baseline = f.local();
      f.client.onQlogEvent = e => { if (e.type === 'control_message_created' && UPDATE_TYPES.has((e.message as { type: string }).type)) throw new Error('observer refused before the write'); };
      const refused = await settled(f.client.requestUpdate(f.sub.requestId, { subscriberPriority: varint(9n), forward: 0, subscriptionFilter: { type: 'AbsoluteStart', startGroup: varint(7n), startObject: varint(0n) } }));
      delete (f.client as { onQlogEvent?: unknown }).onQlogEvent;
      expect(refused.status).toBe('rejected');
      await flush(32);
      expect(f.updates(), 'nothing reached the peer').toBe(0);
      expect(f.local(), 'draft 14 applies an update at send time; a refused write must not leave it applied').toEqual(baseline);
      expect(f.local().forward).toBe(ForwardState.ACTIVE);
    } finally { await f.close(); }
  });
});
