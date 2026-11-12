/**
 * Real SDK request-stream terminal ordering (draft18 §§5.1,10.9,10.11;
 * draft22 §§9.5,9.9). Crossed updates settle independently of blocked writes
 * and owned cleanup. A peer refusal belongs to its matched waiter; remaining
 * waits terminate without fabricated responses. Sibling delivery remains live.
 * Strict trailing messages, observer reentry and late writes retain their
 * distinct error and cleanup outcomes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setImmediate as realImmediate } from 'node:timers';
import { MessageParam, PublishDoneCode18, SessionState, createControlCodec, varint, type DecodedControlMessage, type MoqtObject, type Parameters } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { RequestUpdateError, RequestUpdateFailure } from './request-update-confirmation.js';
import { createLoopback, flush } from './testkit/loopback.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const NS = [enc.encode('live')];
const ALIAS = { video: 42n, sibling: 43n } as const;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => { process.off('unhandledRejection', onUnhandled); });

type Outcome = { status: 'accepted' } | { status: 'rejected'; error: unknown } | { status: 'pending' };
const settleOf = (p: Promise<unknown>) => {
  let state: Outcome = { status: 'pending' };
  void p.then(() => { state = { status: 'accepted' }; }, error => { state = { status: 'rejected', error }; });
  return () => state;
};
const describeError = (error: unknown) => ({
  failure: error instanceof RequestUpdateFailure, peerRefusal: error instanceof RequestUpdateError,
  disposition: (error as { disposition?: unknown }).disposition, name: (error as Error).name, message: String((error as Error).message).slice(0, 160),
});

async function establish(draft: 18 | 22) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  const clientErrors: string[] = [], serverErrors: string[] = [];
  client.onError = error => { clientErrors.push(String(error)); };
  server.onError = error => { serverErrors.push(String(error)); };
  const updates: Array<{ existing: bigint; priority: unknown; requestId?: bigint }> = [];
  server.onMessage = m => { if (m.type === 'REQUEST_UPDATE') updates.push({ existing: m.existingRequestId, priority: m.parameters.get(MessageParam.SUBSCRIBER_PRIORITY)?.[0], requestId: m.requestId }); };
  const clientReceived: Array<{ type: string; requestId?: bigint }> = [];
  client.onMessage = m => { clientReceived.push({ type: m.type, ...('requestId' in m ? { requestId: m.requestId } : {}) }); };
  server.onSubscribe = (id, _ns, name) => {
    void server.acceptSubscribe(id, dec.decode(name) === 'video' ? ALIAS.video : ALIAS.sibling,
      { parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [{ group: 5n, object: 2n }]]]) as Parameters });
  };
  server.setLargestLocationProvider(() => ({ group: 5n, object: 3n }));
  await Promise.all([client.connect(a), server.connect(b)]);
  const sub = await client.subscribeTrack(NS, enc.encode('video'), { filter: { type: 'NextGroupStart' } });
  await flush(64);
  const pipe = a.bidiOut.at(-1)!;
  const sibling = await client.subscribeTrack(NS, enc.encode('sibling'), { filter: { type: 'NextGroupStart' } });
  await flush(64);
  const siblingObjects: MoqtObject[] = [];
  sibling.onObject = object => { siblingObjects.push(object); };
  const codec = createControlCodec(draft);
  const held = (side: unknown) => ((side as { heldChunks: Uint8Array[] }).heldChunks).flatMap(chunk => {
    const out: DecodedControlMessage[] = []; let offset = 0;
    while (offset < chunk.length) { const d = codec.decode(chunk, offset); out.push(d.message); offset += d.bytesRead; }
    return out;
  }).map(m => m.type);
  let group = 6n;
  /** After A's terminal: the sibling still receives an Object and accepts a priority update. */
  const siblingHealthy = async (priority: bigint) => {
    const before = siblingObjects.length;
    const stream = await server.openSubgroup(ALIAS.sibling, group++, 0n, { publisherPriority: 128 });
    await server.sendObject(stream, 0n, Uint8Array.of(1, 2, 3)); await server.closeSubgroup(stream); await flush(128);
    const update = await client.requestUpdateConfirmed(sibling.requestId, { subscriberPriority: varint(priority), timeoutMs: 2000 })
      .then(() => 'accepted', (error: unknown) => describeError(error));
    return { objectArrived: siblingObjects.length === before + 1, update, publisherPriority: server.session.getIncomingSubscription(sibling.requestId)?.currentPriority };
  };
  const doneFor = (id: bigint) => clientReceived.filter(m => m.type === 'PUBLISH_DONE' && m.requestId === id).length;
  const terminated = (id: bigint) => { const owner = client.session.getSubscription(id); return owner === undefined || owner.isTerminated; };
  const open = () => ({ client: client.session.state !== SessionState.CLOSED, server: server.session.state !== SessionState.CLOSED });
  const close = async () => { await client.close().catch(() => undefined); await server.close().catch(() => undefined); await flush(16); };
  return { client, server, sub, sibling, pipe, updates, clientReceived, clientErrors, serverErrors, held, siblingHealthy, doneFor, terminated, open, close };
}
type Fixture = Awaited<ReturnType<typeof establish>>;
const update = (f: Fixture, priority: bigint) => f.client.requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(priority), timeoutMs: 5000 });
const done = (f: Fixture) => f.server.publishDone(f.sub.requestId, PublishDoneCode18.INTERNAL_ERROR, 'publisher ended the subscription');
const healthy = { objectArrived: true, update: 'accepted' };

/** The shared crossing oracle for the crossed update and its context. */
async function expectLegalCrossing(f: Fixture, crossed: () => Outcome) {
  expect(f.clientErrors, 'no protocol violation for a legal crossing').toEqual([]);
  expect(f.open(), 'both sessions stay open').toEqual({ client: true, server: true });
  expect(f.doneFor(f.sub.requestId), 'the terminal was applied once').toBe(1);
  expect(f.terminated(f.sub.requestId), 'the subscriber retired the owner').toBe(true);
  const outcome = crossed();
  expect(outcome.status, 'the crossed update is rejected explicitly, promptly (no timeout wait)').toBe('rejected');
  if (outcome.status === 'rejected') {
    expect(describeError(outcome.error), 'a local terminal failure, possibly sent, not a peer refusal')
      .toMatchObject({ failure: true, peerRefusal: false, disposition: 'possibly-sent' });
  }
  expect(f.client.session.getSubscription(f.sub.requestId)?.currentPriority, 'no accepted priority without a response').not.toBe(9n);
  expect(await f.siblingHealthy(11n), 'a sibling subscription is unaffected').toMatchObject({ ...healthy, publisherPriority: 11n });
  expect(unhandled.map(String), 'no unhandled rejection').toEqual([]);
}

describe.each([18, 22] as const)('draft-%i: PUBLISH_DONE and in-flight REQUEST_UPDATEs', draft => {
  it('control: PUBLISH_DONE with nothing outstanding terminates once; session and sibling stay healthy', async () => {
    const f = await establish(draft);
    try {
      await done(f); await flush(128);
      expect(f.doneFor(f.sub.requestId)).toBe(1);
      expect(f.terminated(f.sub.requestId)).toBe(true);
      expect(f.open()).toEqual({ client: true, server: true });
      expect(f.clientErrors).toEqual([]);
      expect(await f.siblingHealthy(11n)).toMatchObject({ ...healthy, publisherPriority: 11n });
      expect(unhandled.map(String)).toEqual([]);
    } finally { await f.close(); }
  });
  it('control: an answered update then PUBLISH_DONE in one read: the update is accepted, then the terminal once', async () => {
    const f = await establish(draft);
    try {
      f.pipe.in.faults.hold = true;
      const answered = settleOf(update(f, 9n)); await flush(64);
      expect(f.updates.map(u => u.priority), 'premise: the publisher received the update').toEqual([9n]);
      await done(f); await flush(64);
      expect(f.held(f.pipe.in), 'premise: REQUEST_OK then PUBLISH_DONE, in one held read').toEqual(['REQUEST_OK', 'PUBLISH_DONE']);
      f.pipe.in.releaseHeld(); await flush(128);
      expect(answered().status).toBe('accepted');
      expect(f.doneFor(f.sub.requestId)).toBe(1);
      expect(f.open()).toEqual({ client: true, server: true });
      expect(f.clientErrors).toEqual([]);
      expect(await f.siblingHealthy(11n)).toMatchObject({ ...healthy, publisherPriority: 11n });
    } finally { await f.close(); }
  });
  it('an update still in transit (write completed, bytes held) crosses PUBLISH_DONE', async () => {
    const f = await establish(draft);
    try {
      f.pipe.out.faults.hold = true;
      const crossed = settleOf(update(f, 9n)); await flush(64);
      expect(f.updates, 'premise: the publisher never received the update').toEqual([]);
      expect(f.held(f.pipe.out), 'premise: the update is held in transit').toEqual(['REQUEST_UPDATE']);
      await done(f); await flush(128);
      expect(f.server.session.getIncomingSubscription(f.sub.requestId), 'premise: the publisher ended and destroyed the subscription').toBeUndefined();
      f.pipe.out.releaseHeld(); await flush(128);

      await expectLegalCrossing(f, crossed);
      expect(f.updates.filter(u => u.existing === f.sub.requestId), 'releasing the held bytes after the terminal admits nothing at the publisher (for this request; the sibling health check updates its own)').toEqual([]);
      expect(f.serverErrors, 'nor raises a publisher error').toEqual([]);
    } finally { await f.close(); }
  });
  it.each(['released', 'rejected'] as const)('an update whose write is itself held crosses PUBLISH_DONE; the held write is later %s', async late => {
    const f = await establish(draft);
    try {
      type Writer = WritableStreamDefaultWriter<Uint8Array>;
      type Topology = { contexts: Map<bigint, { writer: Writer }>; onRequestClosed?: (id: bigint, disposition: string, error?: Error) => unknown };
      const topology = (f.client as unknown as { uniPair: Topology }).uniPair;
      // Scratch observation hooks: every request-closed notification, and one held write (promise pending, no byte delivered).
      const closedCalls: Array<{ id: bigint; disposition: string }> = [];
      const previousClosed = topology.onRequestClosed;
      topology.onRequestClosed = (id, disposition, error) => { closedCalls.push({ id, disposition }); return previousClosed?.(id, disposition, error); };
      const context = topology.contexts.get(f.sub.requestId)!;
      const original = context.writer.write.bind(context.writer);
      let settleWrite: (() => Promise<string>) | undefined;
      context.writer.write = (chunk?: Uint8Array) => {
        context.writer.write = original;
        return new Promise<void>((resolve, reject) => {
          // Each returns the REAL outcome of the underlying write (not of this wrapper).
          settleWrite = late === 'released'
            ? () => original(chunk!).then(() => { resolve(); return 'write resolved'; },
              (error: unknown) => { reject(error); return `write rejected: ${String(error).slice(0, 80)}`; })
            : () => { reject(new Error('held write failed after the terminal')); return Promise.resolve('write rejected (injected)'); };
        });
      };
      const crossed = settleOf(update(f, 9n)); await flush(64);
      expect(settleWrite, 'premise: the write is held before any byte left').toBeDefined();
      expect(f.updates, 'premise: the publisher never received the update').toEqual([]);
      await done(f); await flush(128);
      // Before the held write settles: the caller is settled, the terminal applied once, and the read side is not waiting on the write.
      const before = { outcome: crossed().status, error: (o => o.status === 'rejected' ? describeError(o.error) : null)(crossed()),
        errors: f.clientErrors.slice(), open: f.open(), done: f.doneFor(f.sub.requestId), unhandled: unhandled.map(String),
        contextPresent: topology.contexts.has(f.sub.requestId), closedCalls: closedCalls.filter(c => c.id === f.sub.requestId).map(c => c.disposition) };
      const lateWrite = await settleWrite!(); await flush(128);
      const after = { lateWrite, outcome: crossed().status, publisherSawUpdate: f.updates.length, open: f.open(), done: f.doneFor(f.sub.requestId),
        clientErrors: f.clientErrors.slice(), unhandled: unhandled.map(String), contextPresent: topology.contexts.has(f.sub.requestId),
        closedCalls: closedCalls.filter(c => c.id === f.sub.requestId).map(c => c.disposition) };

      expect(before.outcome, 'the caller settled before the held write did').toBe('rejected');
      expect(before.done, 'the terminal was applied before the held write settled').toBe(1);
      await expectLegalCrossing(f, crossed);
      expect(after.done, 'the late write produced no second terminal').toBe(1);
      expect(after.closedCalls.length, 'the request closed at most once across terminal and late write').toBeLessThanOrEqual(1);
      expect(after.closedCalls, 'and that close is the clean peer FIN after the drain, not a local reset').toEqual(['fin']);
      expect(after.clientErrors, 'the late write raised nothing').toEqual([]);
      expect(after.publisherSawUpdate, 'the late write admitted nothing at the publisher').toBe(0);
      expect(f.terminated(f.sub.requestId), 'the retired owner was not revived').toBe(true);
      expect(await f.siblingHealthy(12n), 'the sibling is still healthy after the late write').toMatchObject({ ...healthy, publisherPriority: 12n });
    } finally { await f.close(); }
  });
  it('one peer refusal followed by DONE settles multiple pending confirmations without FIFO misattribution', async () => {
    const f = await establish(draft);
    try {
      f.server.setLargestLocationProvider(id => {
        if (id === f.sub.requestId) throw new Error('Publication head unavailable');
        if (id === f.sibling.requestId) return { group: 5n, object: 3n };
        throw new Error('Unknown publication');
      });
      f.pipe.out.faults.hold = true;
      f.pipe.in.faults.hold = true;
      const ids: bigint[] = [];
      const first = settleOf(f.client.requestUpdateConfirmed(f.sub.requestId, {
        subscriberPriority: varint(8n), timeoutMs: 5000, onRequestId: id => { ids.push(id); },
      }));
      const second = settleOf(f.client.requestUpdateConfirmed(f.sub.requestId, {
        subscriberPriority: varint(9n), timeoutMs: 5000, onRequestId: id => { ids.push(id); },
      }));
      await flush(64);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
      expect(first().status).toBe('pending');
      expect(second().status).toBe('pending');
      expect(f.held(f.pipe.out)).toEqual(['REQUEST_UPDATE', 'REQUEST_UPDATE']);
      f.pipe.out.releaseHeld(); await flush(128);
      expect(f.held(f.pipe.in), 'one refusal, then mandatory terminal; no second response is required').toEqual(['REQUEST_ERROR', 'PUBLISH_DONE']);
      const wire = createControlCodec(draft).decode((f.pipe.in as unknown as { heldChunks: Uint8Array[] }).heldChunks[0]!, 0).message;
      if (wire.type !== 'REQUEST_ERROR') throw new Error('Expected the real peer refusal first');
      expect(first().status).toBe('pending');
      expect(second().status).toBe('pending');
      f.pipe.in.releaseHeld(); await flush(128);
      const firstResult = first(), secondResult = second();
      expect(firstResult.status).toBe('rejected');
      if (firstResult.status !== 'rejected') throw new Error('First confirmation did not settle');
      expect(firstResult.error).toBeInstanceOf(RequestUpdateError);
      expect(firstResult.error).toMatchObject({ requestId: ids[0], errorCode: 0n, retryInterval: 0n, disposition: 'possibly-sent' });
      expect(firstResult.error).toMatchObject({ errorCode: wire.errorCode, errorReason: wire.errorReason, retryInterval: wire.retryInterval });
      expect(secondResult.status).toBe('rejected');
      if (secondResult.status !== 'rejected') throw new Error('Remaining confirmation did not settle');
      expect(secondResult.error).toBeInstanceOf(RequestUpdateFailure);
      expect(secondResult.error).not.toBeInstanceOf(RequestUpdateError);
      expect(secondResult.error).toMatchObject({ disposition: 'possibly-sent' });
      expect((secondResult.error as Error).name).not.toBe('TimeoutError');
      expect(f.doneFor(f.sub.requestId)).toBe(1);
      expect(f.terminated(f.sub.requestId)).toBe(true);
      expect(f.clientReceived.filter(m => m.type === 'REQUEST_ERROR').map(m => m.requestId)).toEqual([ids[0]]);
      expect(f.open()).toEqual({ client: true, server: true });
      expect(f.clientErrors).toEqual([]);
      expect(f.serverErrors).toEqual([]);
      expect(await f.siblingHealthy(11n)).toMatchObject({ ...healthy, publisherPriority: 11n });
      expect(unhandled.map(String)).toEqual([]);
    } finally { await f.close(); }
  });

  it('two updates pending; the publisher answered the first, then PUBLISH_DONE with the second unseen', async () => {
    const f = await establish(draft);
    try {
      f.pipe.in.faults.hold = true;
      const first = settleOf(update(f, 8n)); await flush(64);
      expect(f.updates.map(u => u.priority), 'premise: the publisher received only the first').toEqual([8n]);
      f.pipe.out.faults.hold = true;
      const second = settleOf(update(f, 9n)); await flush(64);
      expect(f.held(f.pipe.out), 'premise: the second is held in transit').toEqual(['REQUEST_UPDATE']);
      await done(f); await flush(64);
      expect(f.held(f.pipe.in), 'premise: the answer to the first, then the terminal').toEqual(['REQUEST_OK', 'PUBLISH_DONE']);
      f.pipe.in.releaseHeld(); await flush(128);

      expect(first().status, 'the answered update is accepted').toBe('accepted');
      await expectLegalCrossing(f, second);
    } finally { await f.close(); }
  });
  it('updates attempted after the terminal (inside its callback and after it) are refused not-sent: no bytes, no Request ID consumed', async () => {
    async function run(probe: boolean) {
      const f = await establish(draft);
      try {
        const attempts: Array<{ kind: string; outcome: () => Outcome }> = [];
        const attempt = () => {
          attempts.push({ kind: 'confirmed', outcome: settleOf(f.client.requestUpdateConfirmed(f.sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 1000 })) });
          attempts.push({ kind: 'send-only', outcome: settleOf(f.client.requestUpdate(f.sub.requestId, { subscriberPriority: varint(9n) })) });
        };
        if (probe) {
          const previous = f.client.onMessage;
          f.client.onMessage = m => { previous?.(m); if (m.type === 'PUBLISH_DONE') attempt(); };
        }
        const writtenBefore = f.pipe.out.written.length;
        await done(f); await flush(128);
        if (probe) attempt();
        await flush(128);
        const wroteAfterTerminal = f.pipe.out.written.length - writtenBefore;
        const sibling = await f.siblingHealthy(11n);
        return { attempts: attempts.map(a => ({ kind: a.kind, ...(o => o.status === 'rejected' ? { status: o.status, ...describeError(o.error) } : { status: o.status })(a.outcome()) })),
          wroteAfterTerminal, sibling, siblingUpdateId: f.updates.filter(u => u.existing === f.sibling.requestId).at(-1)?.requestId,
          done: f.doneFor(f.sub.requestId), open: f.open(), errors: f.clientErrors.slice() };
      } finally { await f.close(); }
    }
    const control = await run(false);
    const probe = await run(true);

    expect(probe.attempts.map(a => [a.kind, a.status]), 'every post-terminal attempt is refused').toEqual(
      [['confirmed', 'rejected'], ['send-only', 'rejected'], ['confirmed', 'rejected'], ['send-only', 'rejected']]);
    for (const a of probe.attempts.filter(x => x.kind === 'confirmed')) expect(a, 'confirmed refusals are not-sent').toMatchObject({ failure: true, peerRefusal: false, disposition: 'not-sent' });
    expect(probe.wroteAfterTerminal, 'no bytes written for them').toBe(0);
    expect(probe.sibling).toMatchObject({ ...healthy, publisherPriority: 11n });
    expect({ done: probe.done, open: probe.open, errors: probe.errors }).toEqual({ done: 1, open: { client: true, server: true }, errors: [] });
    expect(unhandled.map(String)).toEqual([]);
  });

  // Ownership edge cases: a local encoding failure, updates acknowledged before the terminal, and a write failing after its response.
  type Writer = WritableStreamDefaultWriter<Uint8Array>;
  type Ctx = { writer: Writer; codec: { encode(message: unknown): Uint8Array } };
  type Topology = { contexts: Map<bigint, Ctx>; onRequestClosed?: (id: bigint, disposition: string, error?: Error) => unknown };
  const topologyOf = (f: Fixture) => (f.client as unknown as { uniPair: Topology }).uniPair;
  it.each(['separate reads', 'one read'] as const)('control: a held write whose update the publisher acknowledged before PUBLISH_DONE (%s) is not reclassified as terminal', async order => {
    const f = await establish(draft);
    try {
      const context = topologyOf(f).contexts.get(f.sub.requestId)!;
      const original = context.writer.write.bind(context.writer);
      let release: (() => Promise<string>) | undefined;
      // The bytes are delivered now; only the write's own promise is held.
      context.writer.write = (chunk?: Uint8Array) => {
        context.writer.write = original;
        const real = original(chunk!);
        return new Promise<void>((resolve, reject) => {
          release = () => real.then(() => { resolve(); return 'write resolved'; }, (error: unknown) => { reject(error); return `write rejected: ${String(error).slice(0, 60)}`; });
        });
      };
      if (order === 'one read') f.pipe.in.faults.hold = true;
      const sendOnly = settleOf(f.client.requestUpdate(f.sub.requestId, { subscriberPriority: varint(9n) })); await flush(64);
      expect(f.updates.map(u => u.priority), 'premise: the publisher received and applied the update').toEqual([9n]);
      expect(f.server.session.getIncomingSubscription(f.sub.requestId)?.currentPriority).toBe(9n);
      if (order === 'separate reads') {
        expect(f.client.session.getSubscription(f.sub.requestId)?.currentPriority, 'premise: the REQUEST_OK was applied before the terminal').toBe(9n);
      }
      await done(f); await flush(64);
      if (order === 'one read') {
        expect(f.held(f.pipe.in), 'premise: REQUEST_OK then PUBLISH_DONE in one held read').toEqual(['REQUEST_OK', 'PUBLISH_DONE']);
        f.pipe.in.releaseHeld(); await flush(128);
      }
      const outcome = sendOnly();

      expect(outcome.status === 'rejected' ? (outcome.error as Error).name : outcome.status, 'the acknowledged update is not a terminal rejection').not.toBe('RequestTerminatedError');
      expect(f.doneFor(f.sub.requestId)).toBe(1);
      expect(f.clientErrors).toEqual([]);
      expect(f.open()).toEqual({ client: true, server: true });
      const late = await release!(); await flush(64);
      expect(sendOnly().status, `the acknowledged update resolves (late write: ${late})`).toBe('accepted');
      expect(unhandled.map(String)).toEqual([]);
    } finally { await f.close(); }
  });
  it('control: with no terminal, a write that fails after its response arrived stays authoritative (r5 semantics)', async () => {
    const f = await establish(draft);
    try {
      const context = topologyOf(f).contexts.get(f.sub.requestId)!;
      const original = context.writer.write.bind(context.writer);
      let fail: (() => void) | undefined;
      const failure = new Error('write failed after its response');
      context.writer.write = (chunk?: Uint8Array) => {
        context.writer.write = original;
        void original(chunk!).catch(() => undefined);                     // the bytes go out now
        return new Promise<void>((_resolve, reject) => { fail = () => { reject(failure); }; });
      };
      const sent = settleOf(f.client.requestUpdate(f.sub.requestId, { subscriberPriority: varint(9n) })); await flush(64);
      expect(f.client.session.getSubscription(f.sub.requestId)?.currentPriority, 'premise: the response arrived first').toBe(9n);
      expect(sent().status, 'premise: the call waits for its write').toBe('pending');
      fail!(); await flush(128);
      const outcome = sent();

      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') expect(outcome.error).toBe(failure);
      expect(unhandled.map(String)).toEqual([]);
    } finally { await f.close(); }
  });

  // Strict-failure notification is separate from the cleanup witness: a session-fatal violation detected after the terminal starts the
  // existing session-error handling at once; the full close still waits for the owned cleanup. Ordinary failures keep their timing.
  async function heldCleanup(f: Fixture, options: { lateAbortRejects?: boolean } = {}) {
    type Context = { writer: Writer; closed: Promise<void>; failure: Error | null; onPeerRequest?: (m: unknown) => unknown };
    const topology = (f.client as unknown as { uniPair: { contexts: Map<bigint, Context>; onRequestClosed?: (id: bigint, disposition: string, error?: Error) => unknown } }).uniPair;
    const context = topology.contexts.get(f.sub.requestId)!;
    const closedCalls: string[] = [];
    const previousClosed = topology.onRequestClosed;
    topology.onRequestClosed = (id, disposition, error) => { if (id === f.sub.requestId) closedCalls.push(disposition); return previousClosed?.(id, disposition, error); };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const abort = context.writer.abort.bind(context.writer);
    const state = { abortCalls: 0, settled: false };
    context.writer.abort = async (reason?: unknown) => {
      state.abortCalls++; await gate;
      try { if (options.lateAbortRejects) throw new Error('request-direction abort failed late'); await abort(reason); } finally { state.settled = true; }
    };
    return { context, topology, closedCalls, release, state, closed: settleOf(context.closed) };
  }
  const injectTrailingDone = async (f: Fixture) => {
    const bytes = createControlCodec(draft).encode({ type: 'PUBLISH_DONE', requestId: f.sub.requestId, statusCode: PublishDoneCode18.INTERNAL_ERROR,
      streamCount: 0n, errorReason: 'ended' } as never);
    f.pipe.in.injectRead(bytes); await flush(128); f.pipe.in.injectRead(bytes); await flush(256);
  };
  const violations = (f: Fixture) => f.clientErrors.filter(e => /after the terminal PUBLISH_DONE/.test(e));

  // A throwing error observer must not veto the session-fatal handling of a strict violation (nor leak an unhandled rejection).
  /** Let Node report any rejection left unhandled by the preceding turn. */
  const unhandledSettled = () => new Promise<void>(resolve => { realImmediate(resolve); });
  const throwingObserver = (f: Fixture) => {
    const calls: string[] = [];
    f.client.onError = error => { calls.push(String(error)); throw new Error('application onError threw'); };
    return calls;
  };
});
