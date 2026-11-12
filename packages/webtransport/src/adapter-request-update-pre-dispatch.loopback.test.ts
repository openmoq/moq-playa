/**
 * `requestUpdateConfirmed` pre-dispatch ownership: the existing `onRequestId` pattern (SUBSCRIBE/FETCH) applied to a
 * confirmed update. The callback runs exactly once, after credentials are acquired and before anything is emitted; a
 * refusal (throw) sends nothing, rejects `not-sent`, and on draft 16 reclaims the allocated Request ID; nothing about the
 * callback is encoded on the wire. Draft 14 still refuses confirmed updates. Real SDK on both ends of the loopback.
 */
import { describe, expect, it } from 'vitest';
import { MessageParam, parseAuthorizationToken, parseAuthorizationToken18, varint, type Parameters } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { catToken, type AuthorizationToken } from './authorization.js';

type Draft = 16 | 18 | 22;
type Parameters_ = Parameters_Of<MoqtConnection['requestUpdateConfirmed']>;
type Parameters_Of<F> = F extends (id: bigint, options: infer O) => unknown ? O : never;
const NS = [new TextEncoder().encode('live')], NAME = new TextEncoder().encode('video');
const TOKEN = catToken(Uint8Array.of(1, 2, 3));
type Failure = Error & { disposition?: unknown };
const settled = <T,>(p: Promise<T>) => p.then(v => ({ status: 'resolved' as const, value: v }), e => ({ status: 'rejected' as const, error: e as Failure }));

async function establish(draft: Draft, options: { holdUpdateCredentials?: { promise: Promise<readonly AuthorizationToken[]> } } = {}) {
  const { a, b } = createLoopback();
  const authorization = options.holdUpdateCredentials
    ? { relayUrl: 'https://relay.example/moq', getTokens: (context: { operation: string }) => context.operation === 'REQUEST_UPDATE' ? options.holdUpdateCredentials!.promise : [TOKEN] }
    : undefined;
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  client.onError = server.onError = () => undefined;
  const updates: Array<{ requestId: bigint; parameters: Parameters }> = [];
  server.onMessage = m => { if (m.type === 'REQUEST_UPDATE') updates.push({ requestId: BigInt((m as { requestId: bigint }).requestId), parameters: (m as { parameters: Parameters }).parameters }); };
  server.onSubscribe = id => { void server.acceptSubscribe(id, 42n, { parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [draft === 16 ? Uint8Array.of(5, 2) : { group: 5n, object: 2n }]]]) as Parameters }); };

  await Promise.all([client.connect(a, authorization ? { authorization } : {}), server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
  const sub = await client.subscribeTrack(NS, NAME, { filter: { type: 'NextGroupStart' } });
  await flush(64);
  // This metadata-only source fixture retains the head it advertised at acceptance.
  // No publication occurs between establishment and these ownership controls.
  const owner = server.session.getIncomingSubscription(sub.requestId);
  if (!owner) throw new Error('Fixture publication owner unavailable');
  server.setLargestLocationProvider(id => {
    if (id !== sub.requestId || server.session.getIncomingSubscription(id) !== owner || owner.isTerminated) {
      throw new Error('Fixture publication owner unavailable');
    }
    return { group: 5n, object: 2n };
  });
  const confirmed = (opts: Partial<Parameters_>) => settled(client.requestUpdateConfirmed(sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000, ...opts }));
  const close = async () => { await client.close(); await server.close(); await flush(16); };
  return { client, server, sub, updates, confirmed, close };
}

describe.each([16, 18, 22] as const)('draft-%i: confirmed update pre-dispatch callback (onRequestId)', draft => {
  it('runs exactly once, after credentials are acquired and before emission, with the Request ID the update will use', async () => {
    let releaseTokens!: (t: readonly AuthorizationToken[]) => void;
    const held = { promise: new Promise<readonly AuthorizationToken[]>(r => { releaseTokens = r; }) };
    const f = await establish(draft, { holdUpdateCredentials: held });
    try {
      const seen: bigint[] = []; let updatesAtCallback = -1;
      const pending = f.confirmed({ onRequestId: (id: bigint) => { seen.push(BigInt(id)); updatesAtCallback = f.updates.length; } });
      await flush(64);
      expect(seen, 'not before credentials').toEqual([]);
      releaseTokens([TOKEN]);
      const result = await pending;
      expect(result.status).toBe('resolved');
      expect(seen.length, 'exactly once').toBe(1);
      expect(updatesAtCallback, 'before the peer could have received anything').toBe(0);
      if (result.status === 'resolved') expect(result.value.requestId, 'the id the update used').toBe(seen[0]);
      expect(f.updates.length).toBe(1);
      // Credentials are enabled in this case: the wire carries the REAL token plus the priority, and nothing else.
      expect([...f.updates[0]!.parameters.keys()].map(String).sort(), 'authorization + priority only; nothing about the callback is encoded')
        .toEqual([String(MessageParam.AUTHORIZATION_TOKEN), String(MessageParam.SUBSCRIBER_PRIORITY)].sort());
      const parse = draft === 16 ? parseAuthorizationToken : parseAuthorizationToken18;
      expect(parse(f.updates[0]!.parameters.get(MessageParam.AUTHORIZATION_TOKEN as bigint)![0] as Uint8Array)).toMatchObject({ tokenType: 1n, tokenValue: Uint8Array.of(1, 2, 3) });
    } finally { await f.close(); }
  });
  it('control — without credentials the wire carries the priority only; the callback leaves no trace', async () => {
    const f = await establish(draft);
    try {
      let calls = 0;
      const result = await f.confirmed({ onRequestId: () => { calls++; } });
      expect(result.status).toBe('resolved'); expect(calls).toBe(1);
      await flush(32);
      expect([...f.updates[0]!.parameters.keys()].map(String), 'priority only').toEqual([String(MessageParam.SUBSCRIBER_PRIORITY)]);
    } finally { await f.close(); }
  });
  it('control — a callback returning a thenable is refused as not-sent and its rejection is owned (no unhandled rejection)', async () => {
    const f = await establish(draft);
    try {
      let calls = 0;
      const result = await f.confirmed({ onRequestId: (() => { calls++; return Promise.reject(new Error('async refusal')); }) as unknown as () => void });
      expect(calls).toBe(1);
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') { expect(result.error.disposition).toBe('not-sent'); expect(result.error.message).toMatch(/synchronous/); }
      await flush(64);
      expect(f.updates.length, 'nothing sent').toBe(0);
      const after = await f.confirmed({ subscriberPriority: varint(10n) });
      expect(after.status, 'the connection is still usable').toBe('resolved');
    } finally { await f.close(); }
  });
  it('a refusing callback sends nothing and rejects not-sent; a later update proceeds (draft 16 reclaims the unsent Request ID)', async () => {
    const f = await establish(draft);
    try {
      const before = await f.confirmed({});
      expect(before.status).toBe('resolved');
      const withdrawal = new Error('withdrawn: viewer intent changed');
      let calls = 0;
      const refused = await f.confirmed({ onRequestId: () => { calls++; throw withdrawal; } });
      expect(calls, 'the callback ran (a refusal is the callback\'s decision, not an options-handling failure)').toBe(1);
      expect(refused.status).toBe('rejected');
      if (refused.status === 'rejected') { expect(refused.error.disposition).toBe('not-sent'); expect(refused.error.cause, 'the refusal is the cause').toBe(withdrawal); expect(refused.error.message).toBe('withdrawn: viewer intent changed'); }
      await flush(64);
      expect(f.updates.length, 'nothing reached the peer').toBe(1);
      const after = await f.confirmed({ subscriberPriority: varint(10n) });
      expect(after.status).toBe('resolved');
      if (before.status === 'resolved' && after.status === 'resolved' && draft === 16) expect(after.value.requestId, 'no Request ID gap (§9.1)').toBe(before.value.requestId + 2n);
      expect(f.updates.length).toBe(2);
    } finally { await f.close(); }
  });
  it('without a callback nothing changes (control)', async () => {
    const f = await establish(draft);
    try { expect((await f.confirmed({})).status).toBe('resolved'); await flush(32); expect(f.updates.length).toBe(1); } finally { await f.close(); }
  });
});

describe('draft 14', () => {
  it('still refuses a confirmed update, callback or not', async () => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(14), server = new MoqtConnection(14, { role: 'server' });
    server.onSubscribe = id => { void server.acceptSubscribe(id, 42n); };
    try {
      await Promise.all([client.connect(a), server.connect(b, { maxRequestId: varint(1000n) })]);
      const sub = await client.subscribeTrack(NS, NAME);
      const result = await settled(client.requestUpdateConfirmed(sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 1000, onRequestId: () => undefined }));
      expect(result.status).toBe('rejected');
    } finally { await client.close(); await server.close(); await flush(16); }
  });
});
