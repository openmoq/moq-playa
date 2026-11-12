/**
 * Typed failure disposition for `requestUpdateConfirmed`: every rejection says whether the update was definitely NOT sent
 * (`'not-sent'`: refused before it was handed to the control/request-stream writer) or POSSIBLY sent (`'possibly-sent'`:
 * handed to the writer, so the peer may hold or have applied it). Callers may not infer this from error strings or from
 * accepted-state equality. Error names (AbortError, TimeoutError, RequestUpdateError) and the original cause are kept.
 * Real SDK on both ends of the loopback.
 */
import { describe, expect, it } from 'vitest';
import { MessageParam, varint, type Parameters } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { AuthorizationError, catToken, type AuthorizationToken } from './authorization.js';

type Draft = 16 | 18 | 22;
const NS = [new TextEncoder().encode('live')], NAME = new TextEncoder().encode('video');
type Failure = Error & { disposition?: unknown; errorCode?: unknown; cause?: unknown };
const failure = <T,>(p: Promise<T>) => p.then(() => null as Failure | null, e => e as Failure);
const TOKEN = catToken(Uint8Array.of(1, 2, 3));
const dispositionBase = async () => (await import('./request-update-confirmation.js') as { RequestUpdateFailure?: new (...args: never[]) => Error }).RequestUpdateFailure;

async function establish(draft: Draft, options: { provider?: boolean | 'throw'; holdUpdateCredentials?: { promise: Promise<readonly AuthorizationToken[]> }; maxRequestUpdates?: bigint } = {}) {
  const { a, b } = createLoopback();
  const authorization = options.holdUpdateCredentials
    ? { relayUrl: 'https://relay.example/moq', getTokens: (context: { operation: string }) => context.operation === 'REQUEST_UPDATE' ? options.holdUpdateCredentials!.promise : [TOKEN] }
    : undefined;
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  client.onError = server.onError = () => undefined;
  const received: string[] = []; server.onMessage = m => { received.push(m.type); };
  const requests: bigint[] = [];
  server.onSubscribe = id => { requests.push(id); void server.acceptSubscribe(id, 42n, { parameters: new Map([[MessageParam.LARGEST_OBJECT as bigint, [draft === 16 ? Uint8Array.of(5, 2) : { group: 5n, object: 2n }]]]) as Parameters }); };
  const provider = options.provider ?? (draft === 22);
  if (provider === 'throw') server.setLargestLocationProvider(() => { throw new Error('refused by the peer'); });
  else if (provider) server.setLargestLocationProvider(() => ({ group: 5n, object: 3n }));
  await Promise.all([client.connect(a, authorization ? { authorization } : {}), server.connect(b, { ...(draft === 16 ? { maxRequestId: varint(1000n) } : {}), ...(options.maxRequestUpdates !== undefined ? { maxRequestUpdates: options.maxRequestUpdates } : {}) })]);
  const sub = await client.subscribeTrack(NS, NAME, { filter: { type: 'NextGroupStart' } });
  await flush(64);
  const ackPipe = () => (draft === 16 ? a.bidiOut[0] : a.bidiOut[requests.length - 1])!.in;
  const hold = () => { ackPipe().faults.hold = true; };
  const release = async () => { ackPipe().releaseHeld(); await flush(128); };
  const updates = () => received.filter(t => t === 'REQUEST_UPDATE').length;
  const failNextLocalWrite = (reason: unknown = new Error('simulated local write failure')) => {
    const writer = draft === 16
      ? (client as unknown as { controlWriter: WritableStreamDefaultWriter<Uint8Array> }).controlWriter
      : (client as unknown as { uniPair: { contexts: Map<bigint, { writer: WritableStreamDefaultWriter<Uint8Array> }> } }).uniPair.contexts.get(sub.requestId)!.writer;
    const original = writer.write.bind(writer);
    (writer as { write: unknown }).write = () => { (writer as { write: unknown }).write = original; return Promise.reject(reason); };
  };
  const confirmed = (opts: Record<string, unknown>) => failure(client.requestUpdateConfirmed(sub.requestId, { subscriberPriority: varint(9n), timeoutMs: 5000, ...opts } as never));
  const close = async () => { await client.close(); await server.close(); await flush(16); };
  return { client, server, sub, hold, release, updates, failNextLocalWrite, confirmed, close };
}

/** An Error whose `name` and `message` getters throw: a wrapper that reads them while settling must not orphan the waiter. */
function hostileError(): Error {
  const error = Object.create(Error.prototype) as Error;
  Object.defineProperty(error, 'name', { get() { throw new Error('hostile name'); } });
  Object.defineProperty(error, 'message', { get() { throw new Error('hostile message'); } });
  Object.defineProperty(error, 'stack', { get() { throw new Error('hostile stack'); } });
  return error;
}
const settlesPromptly = async <T,>(p: Promise<T>, ms = 1500) => Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), new Promise<'hung'>(r => setTimeout(() => r('hung'), ms))]);

async function expectDisposition(error: Failure | null, disposition: 'not-sent' | 'possibly-sent', name?: string) {
  expect(error, 'the operation rejected').not.toBeNull();
  const Base = await dispositionBase();
  expect.soft(Base, 'RequestUpdateFailure is exported').toBeDefined();
  if (Base) expect.soft(error, 'every rejection is a RequestUpdateFailure').toBeInstanceOf(Base);
  expect.soft(error!.disposition, 'typed disposition').toBe(disposition);
  if (name) expect(error!.name, 'the error name is preserved').toBe(name);
}

describe.each([16, 18, 22] as const)('draft-%i: requestUpdateConfirmed failure disposition', draft => {
  it.each([0, -1, Number.NaN])('pre-admission validation (timeoutMs %s) is not-sent', async timeoutMs => {
    const f = await establish(draft);
    try { await expectDisposition(await f.confirmed({ timeoutMs }), 'not-sent'); await flush(32); expect(f.updates()).toBe(0); } finally { await f.close(); }
  });
  it('an already-aborted signal is not-sent and keeps AbortError', async () => {
    const f = await establish(draft);
    try { const c = new AbortController(); c.abort(); await expectDisposition(await f.confirmed({ signal: c.signal }), 'not-sent', 'AbortError'); } finally { await f.close(); }
  });
  it('a timeout while credentials are held is not-sent and keeps TimeoutError; a later real token sends nothing', async () => {
    let releaseTokens!: (tokens: readonly AuthorizationToken[]) => void;
    const held = { promise: new Promise<readonly AuthorizationToken[]>(resolve => { releaseTokens = resolve; }) };
    const f = await establish(draft, { holdUpdateCredentials: held });
    try {
      await expectDisposition(await f.confirmed({ timeoutMs: 60 }), 'not-sent', 'TimeoutError');
      releaseTokens([TOKEN]); await flush(64); expect(f.updates()).toBe(0);
    } finally { await f.close(); }
  });
  it('an abort while credentials are held is not-sent and keeps AbortError', async () => {
    let releaseTokens!: (tokens: readonly AuthorizationToken[]) => void;
    const held = { promise: new Promise<readonly AuthorizationToken[]>(resolve => { releaseTokens = resolve; }) };
    const f = await establish(draft, { holdUpdateCredentials: held });
    try {
      const c = new AbortController();
      const pending = f.confirmed({ signal: c.signal });
      await flush(16); c.abort();
      await expectDisposition(await pending, 'not-sent', 'AbortError');
      releaseTokens([TOKEN]); await flush(64); expect(f.updates()).toBe(0);
    } finally { await f.close(); }
  });
  it('a timeout with the acknowledgement held is possibly-sent and keeps TimeoutError (the late acknowledgement still applies)', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      await expectDisposition(await f.confirmed({ timeoutMs: 60 }), 'possibly-sent', 'TimeoutError');
      expect(f.updates(), 'it was in fact sent').toBe(1);
      await f.release();
    } finally { await f.close(); }
  });
  it('an abort with the acknowledgement held is possibly-sent and keeps AbortError', async () => {
    const f = await establish(draft);
    try {
      f.hold();
      const c = new AbortController();
      const pending = f.confirmed({ signal: c.signal });
      await flush(32); expect(f.updates()).toBe(1); c.abort();
      await expectDisposition(await pending, 'possibly-sent', 'AbortError');
      await f.release();
    } finally { await f.close(); }
  });
  it('a peer refusal is possibly-sent, is a RequestUpdateError, and retains the bigint error code', async () => {
    const f = await establish(draft, { provider: 'throw' });
    try {
      const error = await f.confirmed({ subscriptionFilter: { type: 'LargestObject' } });
      await expectDisposition(error, 'possibly-sent', 'RequestUpdateError');
      expect(typeof error!.errorCode).toBe('bigint');
    } finally { await f.close(); }
  });
  it('a local write failure is possibly-sent (handed to the writer) and keeps the original failure as the cause or message', async () => {
    const f = await establish(draft);
    try {
      f.failNextLocalWrite();
      const error = await f.confirmed({});
      await expectDisposition(error, 'possibly-sent');
      expect([error!.message, String(error!.cause ?? '')].join(' ')).toMatch(/simulated local write failure/);
    } finally { await f.close(); }
  });
  if (draft === 22) it('a local credit refusal (peer MAX_REQUEST_UPDATES=1, one update unanswered) is not-sent and allocates nothing', async () => {
    const f = await establish(22, { maxRequestUpdates: 1n });
    try {
      f.hold();
      const first = f.confirmed({ timeoutMs: 2000 });
      await flush(32); expect(f.updates()).toBe(1);
      await expectDisposition(await f.confirmed({ subscriberPriority: varint(10n) }), 'not-sent');
      await flush(32); expect(f.updates(), 'nothing else reached the peer').toBe(1);
      await f.release();
      expect(await first, 'the first update completes normally').toBeNull();
    } finally { await f.close(); }
  });
});
