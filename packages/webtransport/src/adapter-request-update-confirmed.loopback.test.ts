/**
 * `requestUpdateConfirmed(existingRequestId, options)`: an acknowledged subscription update. It resolves only after
 * the matching REQUEST_OK has been applied to the Session (accepted state already committed when the caller continues)
 * and carries the peer's REQUEST_OK parameters as the caller's own copy; it rejects with the peer's error (bigint
 * errorCode + errorReason retained), on request/session terminal before the acknowledgement, on a local write failure,
 * on a response-stream failure, when already aborted or invalidly bounded (no Request ID allocated, nothing sent), when
 * aborted during credential acquisition (no late send), and on `timeoutMs` (a late acknowledgement is still applied and
 * never settles another waiter). Pending waiters, credential acquisition included, are bounded at 64 per connection.
 * Subscriber-side scope: ordinary SUBSCRIBE and inbound PUBLISH subscriptions. Draft 14 has no acknowledgement and is
 * refused before emission. `requestUpdate` keeps its send-only contract (control). Real SDK on both ends of the loopback.
 */
import { describe, expect, it } from 'vitest';
import { MessageParam, SessionState, encodeObjectDatagram18, encodePropertyBlock, varint, type Parameters } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { catToken, type AuthorizationToken } from './authorization.js';

type Draft = 16 | 18 | 22;
const NS = [new TextEncoder().encode('live')], NAME = new TextEncoder().encode('video');
type Confirmation = { requestId: bigint; parameters: Parameters };
type Confirmed = { requestUpdateConfirmed(existingRequestId: bigint, options: Record<string, unknown>): Promise<Confirmation> };
const confirmed = (client: MoqtConnection) => client as unknown as Confirmed;
const settled = <T,>(p: Promise<T>) => p.then(v => ({ status: 'resolved' as const, value: v }), e => ({ status: 'rejected' as const, error: e as Error & { errorCode?: unknown; errorReason?: unknown } }));
const TOKEN = catToken(Uint8Array.of(1, 2, 3));

/** The controlled publication advertises 5/2 at establishment and advances to 5/3
 * before updates. Accepted updates require its exact live owner on every draft.
 * Explicit false/throw providers exercise missing metadata and peer refusal. */
async function establish(draft: Draft, options: { provider?: boolean | 'throw'; holdUpdateCredentials?: { promise: Promise<readonly AuthorizationToken[]> } } = {}) {
  const { a, b } = createLoopback();
  // Credentials: every operation other than REQUEST_UPDATE gets a real token at once, so SETUP and SUBSCRIBE complete
  // normally; REQUEST_UPDATE credentials are held only when the test asks for it.
  const authorization = options.holdUpdateCredentials
    ? { relayUrl: 'https://relay.example/moq', getTokens: (context: { operation: string }) => context.operation === 'REQUEST_UPDATE' ? options.holdUpdateCredentials!.promise : [TOKEN] }
    : undefined;
  const client = new MoqtConnection(draft);   // authorization is a connect() option, not a constructor option
  const server = new MoqtConnection(draft, { role: 'server' });
  const errors: string[] = []; client.onError = server.onError = e => { errors.push(String(e)); };
  const received: string[] = []; const receivedUpdates: bigint[] = [];
  server.onMessage = m => { received.push(m.type); if (m.type === 'REQUEST_UPDATE') receivedUpdates.push((m as { requestId: bigint }).requestId); };
  const requests: bigint[] = [];
  server.onSubscribe = (id) => { requests.push(id); void server.acceptSubscribe(id, 42n, { parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [draft === 16 ? Uint8Array.of(5, 2) : { group: 5n, object: 2n }]]]) as Parameters }); };
  await Promise.all([client.connect(a, authorization ? { authorization } : {}), server.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
  const sub = await client.subscribeTrack(NS, NAME, { filter: { type: 'NextGroupStart' } });
  await flush(64);
  expect(errors, 'establishment must complete before any update').toEqual([]);
  const publication = { owner: server.session.getIncomingSubscription(sub.requestId)!, head: { group: 5n, object: 3n } };
  const provider = options.provider ?? true;
  if (provider !== false) server.setLargestLocationProvider(id => {
    if (id !== sub.requestId || server.session.getIncomingSubscription(id) !== publication.owner
        || publication.owner.isTerminated) throw new Error('Publication unavailable');
    if (provider === 'throw') throw new Error('refused by the peer');
    return { ...publication.head };
  });
  // Peer→client acknowledgement path: the control stream on draft 16, the subscription's request stream on 18/22.
  const ackPipe = () => (draft === 16 ? a.bidiOut[0] : a.bidiOut[requests.length - 1])!.in;
  const hold = () => { ackPipe().faults.hold = true; };
  const release = async () => { ackPipe().releaseHeld(); await flush(128); };
  const state = () => { const s = client.session.getSubscription(sub.requestId)!; return { priority: s.currentPriority === undefined ? undefined : BigInt(s.currentPriority as bigint), forward: s.forwardState, window: s.locationWindow }; };
  const updates = () => received.filter(t => t === 'REQUEST_UPDATE').length;
  /** Local write-failure seam (adapter-private): the writer the next REQUEST_UPDATE will use rejects once. */
  const failNextLocalWrite = () => {
    const writer = draft === 16
      ? (client as unknown as { controlWriter: WritableStreamDefaultWriter<Uint8Array> }).controlWriter
      : (client as unknown as { uniPair: { contexts: Map<bigint, { writer: WritableStreamDefaultWriter<Uint8Array> }> } }).uniPair.contexts.get(sub.requestId)!.writer;
    const original = writer.write.bind(writer);
    (writer as { write: unknown }).write = () => { (writer as { write: unknown }).write = original; return Promise.reject(new Error('simulated local write failure')); };
  };
  const close = async () => { await client.close(); await server.close(); await flush(16); };
  /** A datagram on the subscription's alias whose Object Properties carry a Mandatory Track Property (track-only; §2.4.2 /
   *  §2.5.1): the receiving subscriber must treat the Track as malformed and cancel the subscription. Request-stream drafts
   *  only (draft 16 has no Object Property block). Injected at the receiving end, since the real publisher API refuses it. */
  const injectMalformedObject = () => {
    const extensions = encodePropertyBlock([{ id: 0x4000n, value: 0n }], 'd18-delta-vi64');
    a.injectDatagram(encodeObjectDatagram18({ typeByte: 0x01, trackAlias: 42n, groupId: 6n, objectId: 0n, publisherPriority: 128, isEndOfGroup: false, extensions, payload: Uint8Array.of(1), status: undefined }));
  };
  const largest = (parameters: Parameters) => { const v = parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0]; return v instanceof Uint8Array ? { group: BigInt(v[0]!), object: BigInt(v[1]!) } : v as { group: bigint; object: bigint }; };
  return { a, b, client, server, sub, errors, hold, release, state, updates, receivedUpdates, failNextLocalWrite, injectMalformedObject, largest, close };
}

describe.each([16, 18, 22] as const)('draft-%i: acknowledged subscription update', draft => {
  it('control — send-only requestUpdate resolves with the Request ID before any acknowledgement', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const id = await f.client.requestUpdate(f.sub.requestId, { subscriberPriority: varint(9n) });
      expect(typeof id).toBe('bigint');
      expect(f.state().priority, 'send-only: nothing committed yet').toBe(undefined);
      await f.release();
      expect(f.state().priority).toBe(9n);
    } finally { await f.close(); }
  });
  it('waits for the matching post-Session acknowledgement, then returns its parameters with the accepted state already committed', async () => {
    const f = await establish(draft, { provider: true });
    try {
      f.hold();
      const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000 }));
      await flush(64);
      expect(f.updates(), 'the update was sent').toBe(1);
      expect(await Promise.race([pending, flush(32).then(() => 'pending' as const)]), 'must not settle before the acknowledgement').toBe('pending');
      expect(f.state().priority, 'not committed before the acknowledgement').toBe(undefined);
      await f.release();
      const result = await pending;
      expect(result.status).toBe('resolved');
      if (result.status === 'resolved') { expect(typeof result.value.requestId).toBe('bigint'); expect(result.value.parameters).toBeInstanceOf(Map); }
      expect(f.state().priority, 'committed when the caller continues').toBe(9n);
      const relative = await confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriptionFilter: { type: 'LargestObject' }, timeoutMs: 5000 });
      expect(relative.parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0], 'a relative update is acknowledged with the anchoring Largest Location').toBeDefined();
    } finally { await f.close(); }
  });
  it('the returned parameters are the caller\'s own copy: mutating them changes neither the Session nor a later result', async () => {
    const f = await establish(draft, { provider: true });
    try {
      const first = await confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriptionFilter: { type: 'LargestObject' }, timeoutMs: 5000 });
      const windowBefore = JSON.stringify(f.state().window, (_k, v) => typeof v === 'bigint' ? String(v) : v);
      first.parameters.set(MessageParam.LARGEST_OBJECT as bigint, [{ group: 999n, object: 999n }]); first.parameters.set(0x7fn, [Uint8Array.of(7)]);
      expect(JSON.stringify(f.state().window, (_k, v) => typeof v === 'bigint' ? String(v) : v)).toBe(windowBefore);
      const second = await confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriptionFilter: { type: 'LargestObject' }, timeoutMs: 5000 });
      expect(second.parameters.has(0x7fn)).toBe(false);
      expect(second.parameters).not.toBe(first.parameters);
    } finally { await f.close(); }
  });
  it.each(['throw', false] as const)('rejects with the peer error, retaining its bigint error code and reason, provider=%s', async provider => {
    const f = await establish(draft, { provider });
    try {
      const result = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriptionFilter: { type: 'LargestObject' }, timeoutMs: 5000 }));
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(typeof result.error.errorCode, 'peer error code kept as bigint').toBe('bigint');
        expect(String(result.error.errorReason)).toMatch(/provider|cannot update/i);
      }
    } finally { await f.close(); }
  });
  it('control — an acknowledgement ordered BEFORE a later PUBLISH_DONE on the same response path still resolves', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000 }));
      await flush(64);
      await f.server.publishDone(f.sub.requestId, varint(0x0n), 'done');   // queued after the (held) acknowledgement
      await f.release();
      const result = await pending;
      expect(result.status, 'the valid acknowledgement precedes the terminal message').toBe('resolved');
      if (result.status === 'resolved') expect(typeof result.value.requestId).toBe('bigint');   // the subscription itself is gone after PUBLISH_DONE
    } finally { await f.close(); }
  });
  it('rejects when the subscription is terminated locally before the acknowledgement arrives', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000 }));
      await flush(64);
      await f.client.unsubscribe(f.sub.requestId);                    // terminal before the acknowledgement is readable
      await f.release();
      const result = await pending;
      expect(result.status).toBe('rejected');
    } finally { await f.close(); }
  });
  it('rejects promptly on a local close() while the acknowledgement is outstanding', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 1500 }));
      await flush(64);
      await f.client.close(); await flush(32);
      const result = await pending;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error.name, 'rejected by the terminal, not by the deadline').not.toBe('TimeoutError');
    } finally { await f.close(); }
  });
  it('rejects promptly when the transport reports the remote close while the acknowledgement is outstanding', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 1500 }));
      await flush(64);
      f.a.close({ closeCode: 0, reason: 'peer closed' });   // delivered to the receiving end: its transport.closed settles
      await flush(32);
      const result = await pending;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error.name, 'rejected by the terminal, not by the deadline').not.toBe('TimeoutError');
    } finally { await f.close(); }
  });
  it('rejects on a local write failure and leaves no pending update behind (nothing reaches the peer)', async () => {
    const f = await establish(draft);
    try {
      f.failNextLocalWrite();
      const result = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000 }));
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        const chain = [result.error.message, String((result.error as { cause?: unknown }).cause ?? '')].join(' ');
        expect(chain, 'the original write failure survives as the rejection or its cause').toMatch(/simulated local write failure/);
      }
      await flush(64);
      expect(f.updates(), 'the peer never received the update').toBe(0);
      const again = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(10n), timeoutMs: 1000 }));
      expect(again.status, 'later work on the failed path is refused, never confused with the failed update').toBe('rejected');
      if (draft === 16) {
        // The control stream is the session: a failed write there is session-fatal.
        expect(f.client.session.state, 'draft 16: the session is closed').toBe(SessionState.CLOSED);
      } else {
        // A failed write on a request stream terminates exactly that request (draft-18 §11.4.1); the session stays usable.
        const gone = f.client.session.getSubscription(f.sub.requestId);
        expect(gone === undefined || gone.isTerminated, 'the request that rode the failed stream is terminated').toBe(true);
        expect(f.client.session.state).not.toBe(SessionState.CLOSED);
        const next = await f.client.subscribeTrack(NS, NAME, { filter: { type: 'NextGroupStart' } });
        expect(typeof next.requestId, 'the session still serves new requests').toBe('bigint');
      }
    } finally { await f.close(); }
  });
  it('rejects when the response stream fails before the acknowledgement', async () => {
    const f = await establish(draft);
    try {
      const pipe = draft === 16 ? f.a.bidiOut[0]!.in : f.a.bidiOut[f.a.bidiOut.length - 1]!.in;
      pipe.faults.resetAfterBytes = 0; pipe.faults.resetCode = 7;       // the peer's next write resets the response stream
      const result = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000 }));
      expect(result.status).toBe('rejected');
    } finally { await f.close(); }
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])('an invalid timeoutMs (%s) is refused before any Request ID is allocated or anything is sent', async timeoutMs => {
    const f = await establish(draft);
    try {
      const result = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), ...(timeoutMs === undefined ? {} : { timeoutMs }) }));
      expect(result.status).toBe('rejected');
      await flush(64);
      expect(f.updates()).toBe(0);
    } finally { await f.close(); }
  });
  it('an already-aborted signal rejects before any Request ID is allocated or anything is sent', async () => {
    const f = await establish(draft);
    try {
      const controller = new AbortController(); controller.abort();
      const result = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000, signal: controller.signal }));
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error.name).toBe('AbortError');
      await flush(64);
      expect(f.updates(), 'nothing sent').toBe(0);
    } finally { await f.close(); }
  });
  it('an abort during credential acquisition rejects with AbortError; releasing a REAL token afterwards sends nothing', async () => {
    let releaseTokens!: (tokens: readonly AuthorizationToken[]) => void;
    const held = { promise: new Promise<readonly AuthorizationToken[]>(resolve => { releaseTokens = resolve; }) };
    const f = await establish(draft, { holdUpdateCredentials: held });
    try {
      const controller = new AbortController();
      const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000, signal: controller.signal }));
      await flush(32); controller.abort(); await flush(32);
      const result = await pending;
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.error.name).toBe('AbortError');
      releaseTokens([TOKEN]); await flush(128);
      expect(f.updates(), 'no late send after the abort').toBe(0);
    } finally { await f.close(); }
  });
  it('timeoutMs rejects with TimeoutError; the late acknowledgement is still applied and never settles another waiter', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const first = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 50 }));
      expect(first.status).toBe('rejected');
      if (first.status === 'rejected') expect(first.error.name).toBe('TimeoutError');
      const second = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(11n), timeoutMs: 5000 }));
      await flush(64);
      expect(f.updates()).toBe(2);
      await f.release();                       // both acknowledgements arrive, in order
      const result = await second;
      expect(result.status).toBe('resolved');
      expect(f.state().priority, 'both acknowledgements applied in order').toBe(11n);
    } finally { await f.close(); }
  });
  it('refuses a 65th pending confirmed update without allocating a Request ID (acknowledgements held)', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const waiters = Array.from({ length: 64 }, (_, i) => settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(BigInt(i % 200)), timeoutMs: 10000 })));
      await flush(64);
      const overflow = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(1n), timeoutMs: 10000 }));
      expect(overflow.status).toBe('rejected');
      for (let i = 0; i < 64 && f.updates() < 64; i++) await flush(64);
      expect(f.updates(), 'exactly 64 updates were sent').toBe(64);
      await f.release();
      expect((await Promise.all(waiters)).every(r => r.status === 'resolved')).toBe(true);
    } finally { await f.close(); }
  });
  it('reentrancy — a confirmed update issued inside another confirmation\'s continuation, and one issued from the pre-application onMessage of an acknowledgement, each resolve with their own acknowledgement', async () => {
    const f = await establish(draft);
    try {
      const order: bigint[] = [];
      const chain = (n: number, priority: bigint): Promise<void> => confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(priority), timeoutMs: 5000 })
        .then(c => { order.push(c.requestId); return n > 1 ? chain(n - 1, priority + 1n) : undefined; });
      await chain(4, 20n);
      expect(new Set(order.map(String)).size, 'four distinct acknowledgements').toBe(4);
      expect(f.state().priority).toBe(23n);
      let nested: Promise<Confirmation> | null = null;
      f.client.onMessage = m => { if (m.type === 'REQUEST_OK' && nested === null) nested = confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(31n), timeoutMs: 5000 }); };
      const outer = await confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(30n), timeoutMs: 5000 });
      delete (f.client as { onMessage?: unknown }).onMessage;
      expect(nested, 'the nested operation was started from the acknowledgement observer').not.toBeNull();
      const inner = await nested!;
      expect(inner.requestId).not.toBe(outer.requestId);
      expect(f.state().priority).toBe(31n);
    } finally { await f.close(); }
  });
  it('the 64-waiter budget counts operations still acquiring credentials', async () => {
    let releaseTokens!: (tokens: readonly AuthorizationToken[]) => void;
    const held = { promise: new Promise<readonly AuthorizationToken[]>(resolve => { releaseTokens = resolve; }) };
    const f = await establish(draft, { holdUpdateCredentials: held });
    try {
      const waiters = Array.from({ length: 64 }, (_, i) => settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(BigInt(i % 200)), timeoutMs: 10000 })));
      await flush(32);
      expect(f.updates(), 'nothing sent while credentials are pending').toBe(0);
      const overflow = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(1n), timeoutMs: 10000 }));
      expect(overflow.status).toBe('rejected');
      releaseTokens([TOKEN]);
      for (let i = 0; i < 64 && f.updates() < 64; i++) await flush(64);
      expect(f.updates()).toBe(64);
      expect((await Promise.all(waiters)).every(r => r.status === 'resolved')).toBe(true);
    } finally { await f.close(); }
  });
  if (draft === 16) {
    it('an abort raised while the REQUEST_UPDATE is being created (before the control write) sends nothing and reclaims its Request ID', async () => {
      const f = await establish(draft);
      const controller = new AbortController();
      try {
        const before = await confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(8n), timeoutMs: 3000 });
        const armed = f.client.observeQlogEvents(e => { if (e.type === 'control_message_created' && (e.message as { type: string }).type === 'REQUEST_UPDATE') controller.abort(); });
        const aborted = await settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 3000, signal: controller.signal }));
        armed();
        expect(aborted.status).toBe('rejected');
        if (aborted.status === 'rejected') expect(aborted.error.name).toBe('AbortError');
        await flush(64);
        expect(f.updates(), 'the aborted update never reaches the peer').toBe(1);
        const after = await confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(10n), timeoutMs: 3000 });
        expect(after.requestId, 'no Request ID gap: the unsent ID is reclaimed (§9.1, increments of two)').toBe(before.requestId + 2n);
        expect(f.state().priority).toBe(10n);
      } finally { await f.close(); }
    });
  } else {
    it('a malformed Track (Mandatory Track Property on an Object) cancels the subscription and promptly rejects an outstanding confirmation', async () => {
      const f = await establish(draft);
      try {
        f.hold();
        const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 1500 }));
        await flush(64);
        f.injectMalformedObject(); await flush(64);
        expect(f.errors.some(e => /malformed/i.test(e)), 'the malformed Track was detected').toBe(true);
        const result = await Promise.race([pending, flush(64).then(() => 'pending' as const)]);
        expect(result, 'rejected at the cancellation, not at its timer').not.toBe('pending');
        if (result !== 'pending') { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(result.error.name).not.toBe('TimeoutError'); }
      } finally { await f.close(); }
    });
    it('a malformed Track promptly rejects a confirmation still acquiring credentials; releasing a real token afterwards sends nothing', async () => {
      let releaseTokens!: (tokens: readonly AuthorizationToken[]) => void;
      const held = { promise: new Promise<readonly AuthorizationToken[]>(resolve => { releaseTokens = resolve; }) };
      const f = await establish(draft, { holdUpdateCredentials: held });
      try {
        const pending = settled(confirmed(f.client).requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 1500 }));
        await flush(32);
        f.injectMalformedObject(); await flush(64);
        expect(f.errors.some(e => /malformed/i.test(e))).toBe(true);
        const result = await Promise.race([pending, flush(64).then(() => 'pending' as const)]);
        expect(result, 'rejected at the cancellation, not at its timer').not.toBe('pending');
        if (result !== 'pending' && result.status === 'rejected') expect(result.error.name).not.toBe('TimeoutError');
        releaseTokens([TOKEN]); await flush(64);
        expect(f.updates(), 'no late send for a cancelled subscription').toBe(0);
      } finally { await f.close(); }
    });
  }
});

describe.each([16, 18, 22] as const)('draft-%i: inbound PUBLISH subscription (subscriber side)', draft => {
  it( 'a confirmed update on a PUBLISH-initiated subscription resolves on the publisher\'s acknowledgement', async () => {
    const { a, b } = createLoopback();
    const publisher = new MoqtConnection(draft), subscriber = new MoqtConnection(draft, { role: 'server' });
    const errors: string[] = []; publisher.onError = subscriber.onError = e => { errors.push(String(e)); };
    let accepted: bigint | null = null;
    subscriber.onPublish = publish => { accepted = publish.requestId; void subscriber.acceptSubscribe(publish.requestId, publish.trackAlias); };
    publisher.setLargestLocationProvider(() => ({ group: 5n, object: 3n }));
    try {
      await Promise.all([publisher.connect(a, draft === 16 ? { maxRequestId: varint(1000n) } : {}), subscriber.connect(b, draft === 16 ? { maxRequestId: varint(1000n) } : {})]);
      await publisher.publish(NS, NAME, 77n); await flush(128);
      expect(accepted, 'the publication was accepted').not.toBeNull();
      const result = await settled(confirmed(subscriber).requestUpdateConfirmed(accepted!, { subscriberPriority: varint(9n), timeoutMs: 5000 }));
      expect(result.status).toBe('resolved');
      const sub = subscriber.session.getIncomingSubscription(accepted!)!;
      expect(BigInt(sub.currentPriority as bigint)).toBe(9n);
      expect(errors).toEqual([]);
    } finally { await publisher.close(); await subscriber.close(); await flush(16); }
  });
  if (draft !== 16) it('a malformed Track on the accepted publication promptly rejects an outstanding confirmation', async () => {
    const { a, b } = createLoopback();
    const publisher = new MoqtConnection(draft), subscriber = new MoqtConnection(draft, { role: 'server' });
    const subErrors: string[] = []; publisher.onError = () => undefined; subscriber.onError = e => { subErrors.push(String(e)); };
    let accepted: bigint | null = null;
    subscriber.onPublish = publish => { accepted = publish.requestId; void subscriber.acceptSubscribe(publish.requestId, publish.trackAlias); };
    publisher.setLargestLocationProvider(() => ({ group: 5n, object: 3n }));
    try {
      await Promise.all([publisher.connect(a), subscriber.connect(b, {})]);
      await publisher.publish(NS, NAME, 77n); await flush(128);
      expect(accepted).not.toBeNull();
      a.bidiOut[a.bidiOut.length - 1]!.out.faults.hold = true;   // the publisher's REQUEST_OK is held
      const pending = settled(confirmed(subscriber).requestUpdateConfirmed(accepted!, { subscriberPriority: varint(9n), timeoutMs: 1500 }));
      await flush(64);
      const extensions = encodePropertyBlock([{ id: 0x4000n, value: 0n }], 'd18-delta-vi64');
      b.injectDatagram(encodeObjectDatagram18({ typeByte: 0x01, trackAlias: 77n, groupId: 6n, objectId: 0n, publisherPriority: 128, isEndOfGroup: false, extensions, payload: Uint8Array.of(1), status: undefined }));
      await flush(64);
      expect(subErrors.some(e => /malformed/i.test(e)), 'the malformed Track was detected by the subscriber').toBe(true);
      const result = await Promise.race([pending, flush(64).then(() => 'pending' as const)]);
      expect(result, 'rejected at the cancellation, not at its timer').not.toBe('pending');
      if (result !== 'pending' && result.status === 'rejected') expect(result.error.name).not.toBe('TimeoutError');
    } finally { await publisher.close(); await subscriber.close(); await flush(16); }
  });
});

describe('draft 14 has no acknowledgement', () => {
  it('requestUpdateConfirmed is refused before emission', async () => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(14), server = new MoqtConnection(14, { role: 'server' });
    const received: string[] = []; server.onMessage = m => { received.push(m.type); };
    server.onSubscribe = id => { void server.acceptSubscribe(id, 42n); };
    try {
      await Promise.all([client.connect(a), server.connect(b, { maxRequestId: varint(1000n) })]);
      const sub = await client.subscribeTrack(NS, NAME);
      const result = await settled(confirmed(client).requestUpdateConfirmed(sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 1000 }));
      expect(result.status).toBe('rejected');
      await flush(64);
      expect(received.filter(t => t === 'SUBSCRIBE_UPDATE' || t === 'REQUEST_UPDATE')).toEqual([]);
    } finally { await client.close(); await server.close(); await flush(16); }
  });
});
