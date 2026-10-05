import { describe, expect, it, vi } from 'vitest';
import { MessageParam, SetupParam, varint, createControlCodec, decodeSubscriptionFilter, parseAuthorizationToken, parseAuthorizationToken18, QlogTrace, type DraftVersion, type ControlMessage } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { catToken, type AuthorizationContext, type AuthorizationProvider } from './authorization.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { nm, ns, withProtocol } from './testkit/pair.js';
import { createHmac } from 'node:crypto';

// Red5 issue-cat-token.py at 52ae16e281ad3774b6d7862c6132b7fc0b39d68c,
// profile cose, key-id playa-test, public all-zero test key, time 1800000000.
// Viewer scopes: CLIENT_SETUP; SUBSCRIBE/FETCH/REQUEST_UPDATE in [live,test].
const signedCat = Uint8Array.from(Buffer.from(
  'hFSjAQUESnBsYXlhLXRlc3QQY0NBVKBYMKQEGmtJ4BACa3Rlc3Qtdmlld2VyGQFIABkBR4KBgQCCgwQHBYNEbGl2ZUR0ZXN09lggLE563bldwVqE+gi12/WF2utCirIE5lLmL3KKDoS2u6o=', 'base64',
));

async function pair(version: DraftVersion, getTokens: AuthorizationProvider, timeoutMs?: number) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(version);
  const server = new MoqtConnection(version, { role: 'server' });
  server.setLargestLocationProvider(() => null);
  const observed = vi.spyOn(server.session, 'handleControlMessage');
  await Promise.all([
    client.connect(a, { authorization: { relayUrl: 'https://relay.example/moq', getTokens, ...(timeoutMs !== undefined ? { timeoutMs } : {}) } }),
    server.connect(b, version === 18 ? {} : { maxRequestId: varint(1000n) }),
  ]);
  return { client, server, a, b, observed };
}

describe.each([14, 16, 18] as const)('draft %i connection authorization', version => {
  it('never rewinds past a reentrant allocation when pre-send ownership fails', async () => {
    const p = await pair(version, () => [catToken(signedCat)]);
    try {
      await expect(p.client.fetch(ns('live'), nm('catalog'), {
        startGroup: 0n, startObject: 0n, endGroup: 1n,
        onRequestId: () => {
          p.client.session.subscribe(ns('live'), nm('video'));
          throw new Error('retired attempt');
        },
      })).rejects.toThrow('retired attempt');
      expect(p.client.session.state).toBe(version === 18 ? 'established' : 'closed');
      if (version === 18) expect(await p.client.subscribe(ns('live'), nm('audio'))).toBe(4n);
      expect(p.observed.mock.calls.some(([message]) => message.type === 'FETCH')).toBe(false);
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('reclaims an unsent FETCH request ID when its ownership callback rejects retirement', async () => {
    const p = await pair(version, () => [catToken(signedCat)]);
    const errors: string[] = [];
    p.server.onError = error => { errors.push(error.message); };
    try {
      await expect(p.client.fetch(ns('live'), nm('catalog'), {
        startGroup: 0n, startObject: 0n, endGroup: 1n,
        onRequestId: () => { throw new Error('retired attempt'); },
      })).rejects.toThrow('retired attempt');
      expect(p.observed.mock.calls.some(([message]) => message.type === 'FETCH')).toBe(false);
      const next = await p.client.subscribe(ns('live'), nm('video'));
      await flush();
      expect(errors).toEqual([]);
      expect(p.server.session.state).toBe('established');
      expect(p.observed.mock.calls.filter(([message]) => message.type === 'SUBSCRIBE')).toHaveLength(1);
      expect(next).toBe(0n);
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('preserves successive seek order despite reverse credential completion', async () => {
    const releases: Array<() => void> = [];
    const p = await pair(version, context => context.operation === 'REQUEST_UPDATE'
      ? new Promise(resolve => releases.push(() => resolve([catToken(signedCat)]))) : [catToken(signedCat)]);
    let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('video'));
      completed = Promise.allSettled([7n, 9n].map(startGroup => p.client.requestUpdate(sub.requestId, {
        subscriptionFilter: { type: 'AbsoluteStart', startGroup, startObject: 0n },
      })));
      await flush();
      releases[1]!();
      await flush();
      expect(p.observed.mock.calls.some(([message]) => message.type === 'REQUEST_UPDATE')).toBe(false);
      releases[0]!();
      expect((await completed).every(result => result.status === 'fulfilled')).toBe(true);
      await flush();
      const sent = p.observed.mock.calls.map(([message]) => message).filter(message => message.type === 'REQUEST_UPDATE');
      expect(sent.map(message => decodeSubscriptionFilter(message.parameters.get(MessageParam.SUBSCRIPTION_FILTER)![0] as Uint8Array, version)))
        .toEqual([7n, 9n].map(startGroup => ({ type: 'AbsoluteStart', startGroup, startObject: 0n })));
    } finally { await p.client.close(); await p.server.close(); await completed; }
  });

  it('preserves pause then resume order when credentials resolve in reverse order', async () => {
    const releases: Array<() => void> = [];
    const p = await pair(version, context => context.operation === 'REQUEST_UPDATE'
      ? new Promise(resolve => releases.push(() => resolve([catToken(new Uint8Array([1]))])))
      : [catToken(new Uint8Array([1]))]);
    const errors: string[] = [];
    p.client.onError = error => { errors.push(error.message); };
    p.server.onError = error => { errors.push(error.message); };
    let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('video'));
      completed = Promise.allSettled([
        p.client.requestUpdate(sub.requestId, { forward: 0 }),
        p.client.requestUpdate(sub.requestId, { forward: 1 }),
      ]);
      await flush();
      expect(releases).toHaveLength(2);
      releases[1]!();
      await flush();
      expect(p.observed.mock.calls.map(([message]) => message).filter(message => message.type === 'REQUEST_UPDATE')).toHaveLength(0);
      releases[0]!();
      expect((await completed).every(result => result.status === 'fulfilled')).toBe(true);
      await flush();
      const updates = p.observed.mock.calls.map(([message]) => message).filter(message => message.type === 'REQUEST_UPDATE');
      expect(updates.map(message => message.parameters.get(MessageParam.FORWARD)?.[0])).toEqual([0n, 1n]);
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(p.client.session.getSubscription(sub.requestId)?.forwardState).toBe(1);
      });
    } finally {
      await p.client.close(); await p.server.close(); await completed;
    }
  });

  it('does not let provider mutation change Buffer-backed request targets', async () => {
    const p = await pair(version, context => {
      context.namespace?.forEach(field => field.fill(90));
      context.trackName?.fill(90);
      return [catToken(new Uint8Array([1]))];
    });
    try {
      const namespace = [Buffer.from('live')];
      const name = Buffer.from('video');
      await p.client.subscribe(namespace, name);
      await flush();
      const sub = p.observed.mock.calls.map(([message]) => message).find(message => message.type === 'SUBSCRIBE');
      expect(sub).toBeDefined();
      if (sub?.type !== 'SUBSCRIBE') throw new Error('Missing SUBSCRIBE');
      expect(new TextDecoder().decode(sub.trackNamespace[0])).toBe('live');
      expect(new TextDecoder().decode(sub.trackName)).toBe('video');
      expect(namespace[0]!.toString()).toBe('live');
      expect(name.toString()).toBe('video');
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('does not let a failed middle acquisition release a later update early', async () => {
    const releases: Array<() => void> = [];
    let updates = 0;
    const p = await pair(version, context => {
      if (context.operation !== 'REQUEST_UPDATE') return [catToken(signedCat)];
      if (++updates === 2) return Promise.reject(new Error('issuer failure'));
      return new Promise(resolve => releases.push(() => resolve([catToken(signedCat)])));
    });
    let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('video'));
      completed = Promise.allSettled([
        p.client.requestUpdate(sub.requestId, { forward: 0 }),
        p.client.requestUpdate(sub.requestId, { subscriberPriority: varint(3n) }),
        p.client.requestUpdate(sub.requestId, { forward: 1 }),
      ]);
      await flush();
      releases[1]!();
      await flush();
      expect(p.observed.mock.calls.some(([message]) => message.type === 'REQUEST_UPDATE')).toBe(false);
      releases[0]!();
      const results = await completed;
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      if (results[1]?.status !== 'rejected') throw new Error('Missing authorization failure');
      expect(results[1].reason.message).toBe('Authorization provider failed');
      await flush();
      const sent = p.observed.mock.calls.map(([message]) => message).filter(message => message.type === 'REQUEST_UPDATE');
      expect(sent.map(message => message.parameters.get(MessageParam.FORWARD)?.[0])).toEqual([0n, 1n]);
      expect(sent.map(message => message.requestId)).toEqual([2n, 4n]);
    } finally { await p.client.close(); await p.server.close(); await completed; }
  });

  it('lets an unrelated subscription update while another waits for credentials', async () => {
    let blocked: bigint | undefined;
    const p = await pair(version, context => context.operation === 'REQUEST_UPDATE' && context.existingRequestId === blocked
      ? new Promise(() => {}) : [catToken(signedCat)]);
    let pending: Promise<unknown> | undefined;
    try {
      let alias = 9n;
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, alias++); };
      const first = await p.client.subscribeTrack(ns('live'), nm('video'));
      const second = await p.client.subscribeTrack(ns('live'), nm('audio'));
      blocked = first.requestId;
      pending = p.client.requestUpdate(first.requestId, { forward: 0 }).catch(error => error);
      await p.client.requestUpdate(second.requestId, { forward: 0 });
      await flush();
      const sent = p.observed.mock.calls.map(([message]) => message).filter(message => message.type === 'REQUEST_UPDATE');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.existingRequestId).toBe(second.requestId);
    } finally { await p.client.close(); await p.server.close(); await pending; }
  });

  it('rejects waiting and already-acquired queued updates immediately on connection close', async () => {
    let count = 0;
    let signal!: AbortSignal;
    const p = await pair(version, context => {
      if (context.operation === 'REQUEST_UPDATE' && count++ === 0) {
        signal = context.signal;
        return new Promise(() => {});
      }
      return [catToken(signedCat)];
    });
    let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('video'));
      completed = Promise.allSettled([
        p.client.requestUpdate(sub.requestId, { forward: 0 }),
        p.client.requestUpdate(sub.requestId, { forward: 1 }),
      ]);
      await flush();
      await p.client.close();
      const results = await completed;
      expect(results.every(result => result.status === 'rejected' && result.reason.message.includes('closed'))).toBe(true);
      expect(signal.aborted).toBe(true);
      expect(p.observed.mock.calls.some(([message]) => message.type === 'REQUEST_UPDATE')).toBe(false);
    } finally { await p.client.close(); await p.server.close(); await completed; }
  });

  it('bounds queued updates even when later credentials have already resolved', async () => {
    let count = 0;
    const p = await pair(version, context => context.operation === 'REQUEST_UPDATE' && count++ === 0
      ? new Promise(() => {}) : [catToken(signedCat)]);
    let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('video'));
      completed = Promise.allSettled(Array.from({ length: 64 }, () => p.client.requestUpdate(sub.requestId, { forward: 0 })));
      await flush();
      await expect(p.client.requestUpdate(sub.requestId, { forward: 1 })).rejects.toThrow('Too many pending authorized updates');
      expect(count).toBe(64);
      await p.client.close();
      expect((await completed).every(result => result.status === 'rejected')).toBe(true);
      expect(p.observed.mock.calls.some(([message]) => message.type === 'REQUEST_UPDATE')).toBe(false);
    } finally { await p.client.close(); await p.server.close(); await completed; }
  });

  it('releases the update turn after a timed-out acquisition', async () => {
    let count = 0;
    const p = await pair(version, context => context.operation === 'REQUEST_UPDATE' && count++ === 0
      ? new Promise(() => {}) : [catToken(signedCat)], 20);
    vi.useFakeTimers();
    let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('video'));
      completed = Promise.allSettled([
        p.client.requestUpdate(sub.requestId, { forward: 0 }),
        p.client.requestUpdate(sub.requestId, { forward: 1 }),
      ]);
      await flush();
      await vi.advanceTimersByTimeAsync(20);
      const results = await completed;
      expect(results[0]).toMatchObject({ status: 'rejected', reason: { message: 'Authorization timed out' } });
      expect(results[1]?.status).toBe('fulfilled');
      await flush();
      const sent = p.observed.mock.calls.map(([message]) => message).filter(message => message.type === 'REQUEST_UPDATE');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.parameters.get(MessageParam.FORWARD)?.[0]).toBe(1n);
    } finally {
      await p.client.close(); await p.server.close(); await completed;
      vi.useRealTimers();
    }
  });

  it('does not send an acquired queued update after its subscription is retired', async () => {
    const releases: Array<() => void> = [];
    const p = await pair(version, context => context.operation === 'REQUEST_UPDATE'
      ? new Promise(resolve => releases.push(() => resolve([catToken(signedCat)]))) : [catToken(signedCat)]);
    let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('video'));
      completed = Promise.allSettled([
        p.client.requestUpdate(sub.requestId, { forward: 0 }),
        p.client.requestUpdate(sub.requestId, { forward: 1 }),
      ]);
      await flush();
      releases[1]!();
      await flush();
      await sub.unsubscribe();
      releases[0]!();
      const results = await completed;
      expect(results.every(result => result.status === 'rejected' && result.reason.message.includes('target no longer exists'))).toBe(true);
      expect(p.observed.mock.calls.some(([message]) => message.type === 'REQUEST_UPDATE')).toBe(false);
    } finally { await p.client.close(); await p.server.close(); await completed; }
  });

  it('rejects an explicitly invalid authorization configuration rather than connecting anonymously', async () => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(version);
    const bidi = vi.spyOn(a, 'createBidirectionalStream').mockRejectedValue(new Error('Unexpected stream creation'));
    const uni = vi.spyOn(a, 'createUnidirectionalStream').mockRejectedValue(new Error('Unexpected stream creation'));
    try {
      await expect(client.connect(a, { authorization: null as unknown as import('./authorization.js').ConnectionAuthorization }))
        .rejects.toThrow('Invalid authorization configuration');
      expect(uni).not.toHaveBeenCalled();
      expect(bidi).not.toHaveBeenCalled();
    } finally { await client.close(); b.close(); }
  });

  it('authorizes SETUP, catalog, init and media independently, preserving opaque bytes on the wire', async () => {
    const contexts: AuthorizationContext[] = [];
    const value = new Uint8Array([0xd2, 0x84, 0xff]);
    const p = await pair(version, ctx => { contexts.push(ctx); return [catToken(value)]; });
    try {
      for (const name of ['catalog', 'init', 'video']) await p.client.subscribe(ns('live'), nm(name));
      await flush();
      expect(contexts.map(ctx => ctx.operation)).toEqual(['SETUP', 'SUBSCRIBE', 'SUBSCRIBE', 'SUBSCRIBE']);
      expect(contexts.slice(1).map(ctx => ctx.trackName)).toEqual(['catalog', 'init', 'video'].map(nm));
      const messages = p.observed.mock.calls.map(([msg]) => msg);
      const requests = messages.filter(msg => ['SETUP', 'CLIENT_SETUP', 'SUBSCRIBE'].includes(msg.type));
      expect(requests).toHaveLength(4);
      for (const msg of requests) {
        const parameters = 'setupOptions' in msg ? msg.setupOptions : 'parameters' in msg ? msg.parameters : new Map();
        const token = parameters.get(msg.type.includes('SETUP') ? SetupParam.AUTHORIZATION_TOKEN : MessageParam.AUTHORIZATION_TOKEN)?.[0];
        const parse = version === 18 ? parseAuthorizationToken18 : parseAuthorizationToken;
        expect(parse(token as Uint8Array)).toMatchObject({ tokenType: 1n, tokenValue: value });
      }
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('uses fresh credentials and the referenced target for Joining FETCH and REQUEST_UPDATE', async () => {
    const contexts: AuthorizationContext[] = [];
    const p = await pair(version, ctx => { contexts.push(ctx); return [catToken(new Uint8Array([contexts.length]))]; });
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('catalog'));
      await p.client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub.requestId, joiningStart: 0n });
      await p.client.requestUpdate(sub.requestId, { forward: 0 });
      await flush();
      expect(contexts.map(ctx => ctx.operation)).toEqual(['SETUP', 'SUBSCRIBE', 'FETCH', 'REQUEST_UPDATE']);
      expect(contexts.slice(1).every(ctx => ctx.namespace?.[0]?.[0] === nm('live')[0] && ctx.trackName?.[0] === nm('catalog')[0])).toBe(true);
      expect(contexts[2]!.existingRequestId).toBe(sub.requestId);
      expect(contexts[3]!.existingRequestId).toBe(sub.requestId);
      const requests = p.observed.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'FETCH' || msg.type === 'REQUEST_UPDATE');
      expect(requests).toHaveLength(2);
      const parse = version === 18 ? parseAuthorizationToken18 : parseAuthorizationToken;
      expect(requests.map(msg => parse(msg.parameters.get(MessageParam.AUTHORIZATION_TOKEN)![0] as Uint8Array)))
        .toMatchObject([{ tokenValue: new Uint8Array([3]) }, { tokenValue: new Uint8Array([4]) }]);
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('sends nothing and spends no request ID when credential acquisition fails', async () => {
    let fail = false;
    const p = await pair(version, () => { if (fail) throw new Error('secret'); return [catToken(new Uint8Array([1]))]; });
    try {
      fail = true;
      const before = p.a.bidiOut.length;
      await expect(p.client.subscribe(ns('live'), nm('video'))).rejects.toThrow('Authorization provider failed');
      expect(p.a.bidiOut.length).toBe(before);
      fail = false;
      expect(await p.client.subscribe(ns('live'), nm('video'))).toBe(0n);
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('cancels pending authorization on close without emitting late request bytes', async () => {
    let resolve!: (tokens: ReturnType<typeof catToken>[]) => void;
    let signal!: AbortSignal;
    const p = await pair(version, ctx => ctx.operation === 'SETUP'
      ? [catToken(new Uint8Array([1]))]
      : new Promise(done => { resolve = done; signal = ctx.signal; }));
    const before = p.a.bidiOut.length;
    const request = p.client.subscribe(ns('live'), nm('video'));
    const rejected = expect(request).rejects.toThrow('closed');
    await flush();
    await p.client.close();
    await rejected;
    expect(signal.aborted).toBe(true);
    resolve([catToken(new Uint8Array([2]))]);
    await flush();
    expect(p.a.bidiOut.length).toBe(before);
    await p.server.close();
  });

  it('covers standalone FETCH, publishing and namespace discovery without dropping other parameters', async () => {
    const contexts: AuthorizationContext[] = [];
    const p = await pair(version, ctx => { contexts.push(ctx); return [catToken(signedCat)]; });
    try {
      await p.client.fetch(ns('live'), nm('video'), { startGroup: 0n, startObject: 0n, endGroup: 1n });
      await p.client.publish(ns('live'), nm('outgoing'), 33n, { parameters: new Map([[MessageParam.FORWARD, [varint(0n)]]]) });
      await p.client.publishNamespace(ns('live'));
      await p.client.subscribeNamespace(ns('live'));
      await p.client.trackStatus(ns('live'), nm('video'));
      if (version === 18) await p.client.subscribeTracks(ns('live'));
      await flush();
      const expected = ['SETUP', 'FETCH', 'PUBLISH', 'PUBLISH_NAMESPACE', 'SUBSCRIBE_NAMESPACE', 'TRACK_STATUS', ...(version === 18 ? ['SUBSCRIBE_TRACKS'] : [])];
      expect(contexts.map(ctx => ctx.operation)).toEqual(expected);
      const requests = p.observed.mock.calls.map(([msg]) => msg).filter(msg => expected.slice(1).includes(msg.type));
      // Draft-16 namespace requests are dispatched by the namespace-stream
      // state machine rather than handleControlMessage; inspect its actual wire.
      if (version === 16) requests.push(createControlCodec(16).decode(p.a.bidiOut[1]!.out.writtenBytes(), 0).message as ControlMessage);
      expect(requests).toHaveLength(expected.length - 1);
      const parse = version === 18 ? parseAuthorizationToken18 : parseAuthorizationToken;
      for (const request of requests) {
        if (!('parameters' in request)) throw new Error('No request parameters');
        const token = request.parameters.get(MessageParam.AUTHORIZATION_TOKEN)![0] as Uint8Array;
        expect(parse(token)).toMatchObject({ tokenType: 1n, tokenValue: signedCat });
        if (request.type === 'PUBLISH') expect(request.parameters.get(MessageParam.FORWARD)).toEqual([0n]);
      }
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('does not authorize a retired subscription with a late Joining FETCH credential', async () => {
    let release!: (tokens: ReturnType<typeof catToken>[]) => void;
    const p = await pair(version, ctx => ctx.operation === 'FETCH'
      ? new Promise(done => { release = done; }) : [catToken(signedCat)]);
    try {
      p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 9n); };
      const sub = await p.client.subscribeTrack(ns('live'), nm('catalog'));
      const pending = p.client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub.requestId, joiningStart: 0n });
      const rejection = expect(pending).rejects.toThrow('target no longer exists');
      await flush();
      await sub.unsubscribe();
      release([catToken(signedCat)]);
      await rejection;
      await flush();
      expect(p.observed.mock.calls.some(([msg]) => msg.type === 'FETCH')).toBe(false);
    } finally { await p.client.close(); await p.server.close(); }
  });

  it('surfaces a relay authorization rejection without retrying anonymously', async () => {
    const provider = vi.fn((_ctx: AuthorizationContext) => [catToken(signedCat)]);
    const p = await pair(version, provider);
    try {
      const received: Uint8Array[] = [];
      p.server.onSubscribe = (rid, _namespace, _name, parameters) => {
        received.push(parameters.get(MessageParam.AUTHORIZATION_TOKEN)![0]);
        void p.server.rejectSubscribe(rid, varint(3n), 'Unauthorized');
      };
      await expect(p.client.subscribeTrack(ns('other'), nm('video'))).rejects.toThrow('Unauthorized');
      await flush();
      expect(received).toHaveLength(1);
      expect(provider).toHaveBeenCalledTimes(2);
      expect(p.client.session.state).toBe('established');
    } finally { await p.client.close(); await p.server.close(); }
  });
});

it('the signed CAT fixture has the issuer MAC and remains opaque to the client', () => {
  const input = Buffer.from('84644d41433054a30105044a706c6179612d746573741063434154405830a4041a6b49e010026b746573742d7669657765721901480019014782818100828304070583446c6976654474657374f6', 'hex');
  expect(createHmac('sha256', new Uint8Array(32)).update(input).digest()).toEqual(Buffer.from(signedCat.slice(-32)));
});

it('authorizes namespace prefix updates against their new target', async () => {
  const contexts: AuthorizationContext[] = [];
  const p = await pair(18, ctx => { contexts.push(ctx); return [catToken(signedCat)]; });
  try {
    p.server.onSubscribeNamespace = rid => { void p.server.acceptSubscribeNamespace(rid); };
    const rid = await p.client.subscribeNamespace(ns('live'));
    await flush();
    await p.client.requestUpdate(rid, { trackNamespacePrefix: [nm('live'), nm('test')] });
    await flush();
    expect(contexts.at(-1)).toMatchObject({ operation: 'REQUEST_UPDATE', existingRequestId: rid, namespace: [nm('live'), nm('test')] });
    const update = p.observed.mock.calls.map(([msg]) => msg).find(msg => msg.type === 'REQUEST_UPDATE');
    expect(update?.parameters.has(MessageParam.AUTHORIZATION_TOKEN)).toBe(true);
  } finally { await p.client.close(); await p.server.close(); }
});

it('queues later namespace updates without waiting for the earlier peer acknowledgement', async () => {
  const p = await pair(18, () => [catToken(signedCat)]);
  let completed: Promise<PromiseSettledResult<bigint>[]> | undefined;
  try {
    p.server.onSubscribeNamespace = rid => { void p.server.acceptSubscribeNamespace(rid); };
    const rid = await p.client.subscribeNamespace(ns('live'));
    await flush();
    const response = p.a.bidiOut.at(-1)!.in;
    response.faults.hold = true;
    completed = Promise.allSettled(['first', 'second'].map(name => p.client.requestUpdate(rid, {
      trackNamespacePrefix: [nm('live'), nm(name)],
    })));
    await vi.waitFor(() => expect(p.observed.mock.calls.filter(([message]) => message.type === 'REQUEST_UPDATE')).toHaveLength(2));
    response.releaseHeld();
    expect((await completed).every(result => result.status === 'fulfilled')).toBe(true);
  } finally {
    p.a.bidiOut.forEach(stream => stream.in.releaseHeld());
    await p.client.close(); await p.server.close(); await completed;
  }
});

it('authorizes updates on an accepted inbound PUBLISH with the publisher track identity', async () => {
  const contexts: AuthorizationContext[] = [];
  const p = await pair(18, ctx => { contexts.push(ctx); return [catToken(signedCat)]; });
  try {
    p.client.onPublish = pub => { void p.client.acceptSubscribe(pub.requestId, pub.trackAlias); };
    const rid = await p.server.publish(ns('live'), nm('video'), 3n);
    await flush();
    await p.client.requestUpdate(rid, { forward: 0 });
    await flush();
    expect(contexts.at(-1)).toMatchObject({ operation: 'REQUEST_UPDATE', existingRequestId: rid, namespace: ns('live'), trackName: nm('video') });
    const update = p.observed.mock.calls.map(([msg]) => msg).find(msg => msg.type === 'REQUEST_UPDATE');
    expect(update?.parameters.has(MessageParam.AUTHORIZATION_TOKEN)).toBe(true);
  } finally { await p.client.close(); await p.server.close(); }
});

it('qlog exports only token lengths, never signed credential contents', async () => {
  const p = await pair(18, () => [catToken(signedCat)]);
  try {
    await p.client.subscribe(ns('live'), nm('video'));
    await flush();
    const recorder = new QlogTrace('authorization', () => 0);
    for (const [message] of p.observed.mock.calls) recorder.record({ type: 'control_message_parsed', stream_id: 0n, message });
    const trace = JSON.stringify(recorder.toContained());
    expect(trace).toContain('payload_length');
    expect(trace).not.toContain(Buffer.from(signedCat).toString('hex'));
    expect(trace).not.toContain(Buffer.from(signedCat).toString('base64'));
    expect(trace).not.toContain('test-viewer');
  } finally { await p.client.close(); await p.server.close(); }
});

it('authorizes SETUP using the negotiated draft, not the constructor default', async () => {
  const { a, b } = createLoopback();
  const contexts: AuthorizationContext[] = [];
  const client = new MoqtConnection();
  const server = new MoqtConnection(18, { role: 'server' });
  try {
    await Promise.all([
      client.connect(withProtocol(a, 'moqt-18'), { authorization: { relayUrl: 'https://relay.example/moq', getTokens: ctx => {
        contexts.push(ctx); return [catToken(new Uint8Array([1]))];
      } } }),
      server.connect(b),
    ]);
    expect(contexts[0]!.draftVersion).toBe(18);
    const msg = createControlCodec(18).decode(a.uniOut[0]!.writtenBytes(), 0).message;
    expect(msg.type).toBe('SETUP');
  } finally { await client.close(); await server.close(); }
});

it('aborts SETUP credential acquisition when the peer transport closes', async () => {
  const { a } = createLoopback();
  const client = new MoqtConnection(18);
  let signal!: AbortSignal;
  const connecting = client.connect(a, { authorization: { relayUrl: 'https://relay.example/moq', getTokens: ctx => {
    signal = ctx.signal;
    return new Promise(() => {});
  } } });
  const rejected = expect(connecting).rejects.toThrow('closed');
  await flush();
  a.close({ closeCode: 2, reason: 'unauthorized' });
  await flush();
  try {
    expect(signal.aborted).toBe(true);
    await rejected;
    expect(a.uniOut).toHaveLength(0);
  } finally { await client.close(); await rejected; }
});
