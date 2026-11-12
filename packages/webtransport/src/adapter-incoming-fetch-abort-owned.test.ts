import { expect, it, vi } from 'vitest';
import { MessageParam, createControlCodec, MAX_VI64 } from '@openmoq/transport';
import { ns, nm } from './testkit/pair.js';
import { createLoopback, flush } from './testkit/loopback.js';
import { MoqtConnection } from './adapter.js';
import type { WebTransportLike } from './types.js';


async function setup(draft: 18 | 22, wrapResponse?: (stream: WritableStream<Uint8Array>) => WritableStream<Uint8Array>) {
  const { a, b } = createLoopback();
  if (wrapResponse) {
    const incoming = b.incomingBidirectionalStreams.pipeThrough(new TransformStream({
      transform(stream, controller) {
        controller.enqueue({ readable: stream.readable, writable: wrapResponse(stream.writable) });
      },
    }));
    Object.defineProperty(b, 'incomingBidirectionalStreams', { value: incoming });
  }
  const client = new MoqtConnection(draft);
  const server = new MoqtConnection(draft, { role: 'server' });
  const errors: Error[] = [];
  client.onError = error => { errors.push(error); };
  server.onError = error => { errors.push(error); };
  await Promise.all([client.connect(a), server.connect(b)]);
  const p = { a, b, client, server, errors };
  const transport: WebTransportLike = p.b;
  const reasons: unknown[] = [];
  transport.createStreamError = (code, cause) => Object.assign(new Error('cancel', { cause }), { streamErrorCode: code });
  transport.resetSendStream = async (writer, reason, fin) => {
    reasons.push(reason);
    try { await writer.abort(reason); }
    catch (error) {
      if (error !== reason || !fin || !await fin.then(() => false, err => err === reason)) throw error;
    }
  };
  p.server.onFetch = () => {};
  async function fetch(accept = true) {
    const id = await p.client.fetch(ns('history'), nm('video'), { startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 5n });
    await flush(128);
    if (accept) await p.server.acceptFetch(id, { endLocation: { group: 3n, object: 5n } });
    await flush(128);
    return id;
  }
  return { ...p, transport, reasons, fetch, cleanup: async () => { await p.client.close(); await p.server.close(); } };
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} accepted abort synchronously revokes only its owner and preserves sibling data`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch(); const sibling = await f.fetch();
      const stream = await f.server.openFetchStream(id);
      const other = await f.server.openFetchStream(sibling);
      const response = f.b.uniOut.at(-2)!;
      const request = f.a.bidiOut.at(-2)!;
      const initialWrites = request.in.written.length;
      const pending = f.server.abortIncomingFetch(id, { streamErrorCode: 6 });
      expect(f.server.session.getIncomingFetch(id)).toBeUndefined();
      expect(f.server.abortIncomingFetch(id)).toBe(pending);
      await expect(pending).resolves.toEqual({ status: 'aborted' });
      expect(response.writeAborted).toBe(true);
      expect(response.writeClosed).toBe(false);
      expect(request.in.writeAborted).toBe(true);
      expect(request.out.readCancelled).toBe(true);
      expect(request.in.written).toHaveLength(initialWrites);
      expect(new Set(f.reasons).size).toBe(1);
      await expect(f.server.sendFetchObject(stream, { groupId: 3n, objectId: 0n, subgroupId: 0n, publisherPriority: 128, payload: Uint8Array.of(1) })).rejects.toThrow();
      const output: number[] = [];
      f.client.onObject = (_id, object) => { if (object.kind === 'data') output.push(...object.payload); };
      await f.server.sendFetchObject(other, { groupId: 3n, objectId: 0n, subgroupId: 0n, publisherPriority: 128, payload: Uint8Array.of(44) });
      await f.server.closeFetchStream(other); await flush(128);
      expect(output).toEqual([44]);
      expect(f.server.session.state).not.toBe('closed');
      await expect(f.server.abortIncomingFetch(id)).resolves.toEqual({ status: 'already-terminal' });
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} validation and absent/throwing factory preserve accepted owner`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch(); const owner = f.server.session.getIncomingFetch(id);
      await expect(f.server.abortIncomingFetch(id, { streamErrorCode: NaN })).rejects.toThrow();
      const factory = f.transport.createStreamError!;
      delete f.transport.createStreamError;
      await expect(f.server.abortIncomingFetch(id)).rejects.toThrow();
      f.transport.createStreamError = () => { throw new Error('factory failed'); };
      await expect(f.server.abortIncomingFetch(id)).rejects.toThrow();
      expect(f.server.session.getIncomingFetch(id)).toBe(owner);
      f.transport.createStreamError = factory;
      await expect(f.server.abortIncomingFetch(id)).resolves.toEqual({ status: 'aborted' });
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} unproven reset closes the session after one existing deadline`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch(); await f.server.openFetchStream(id);
      f.transport.resetSendStream = () => new Promise(() => {});
      vi.useFakeTimers();
      const operation = f.server.abortIncomingFetch(id);
      const outcome = operation.then(() => 'success', () => 'failure');
      await vi.advanceTimersByTimeAsync(999);
      expect(f.server.session.state).not.toBe('closed');
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBe('failure');
      expect(f.server.session.state).toBe('closed');
    } finally { vi.useRealTimers(); await f.cleanup(); }
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** WebTransport-like abort-signal behavior, over a real loopback pipe. */
function held(stream: WritableStream<Uint8Array>, phase: 'write' | 'close', abortsPending = true) {
  const gate = deferred();
  const started = deferred();
  const writer = stream.getWriter();
  let resets = 0;
  let reset: Promise<void> | undefined;
  const wrapped = new WritableStream<Uint8Array>({
    start(controller) {
      controller.signal.addEventListener('abort', () => {
        if (!abortsPending) return;
        gate.reject(controller.signal.reason);
        resets++;
        reset = writer.abort(controller.signal.reason);
        void reset.catch(() => {});
      });
    },
    async write(bytes) {
      if (phase === 'write') { started.resolve(); await gate.promise; }
      await writer.write(bytes);
    },
    async close() {
      if (phase === 'close') { started.resolve(); await gate.promise; }
      await writer.close();
    },
    async abort(reason) { await (reset ?? writer.abort(reason)); },
  });
  return { stream: wrapped, gate, started: started.promise, resetCount: () => resets };
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} late allocation is reset before its header and remains fenced`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch();
      const gate = deferred();
      const create = f.b.createUnidirectionalStream.bind(f.b);
      f.b.createUnidirectionalStream = async () => { await gate.promise; return create(); };
      const opening = f.server.openFetchStream(id);
      const opened = opening.then(() => 'success', () => 'failure');
      const ending = f.server.abortIncomingFetch(id, { streamErrorCode: 6 });
      gate.resolve();
      expect(await opened).toBe('failure');
      await expect(ending).resolves.toEqual({ status: 'aborted' });
      const pipe = f.b.uniOut.at(-1)!;
      expect(pipe.written).toHaveLength(0);
      expect(pipe.writeAborted).toBe(true);
      expect(pipe.writeClosed).toBe(false);
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} abort fences a physically pending FETCH_OK and its continuation`, async () => {
    let response: ReturnType<typeof held> | undefined;
    const f = await setup(draft, stream => { response = held(stream, 'write'); return response.stream; });
    try {
      const id = await f.fetch(false);
      const accepting = f.server.acceptFetch(id, { endLocation: { group: 3n, object: 5n } });
      const accepted = accepting.then(() => 'success', () => 'failure');
      await response!.started;
      expect(f.server.session.getIncomingFetch(id)?.responseSent).toBe(true);
      expect(f.a.bidiOut.at(-1)!.in.written).toHaveLength(0);
      const ending = f.server.abortIncomingFetch(id, { streamErrorCode: 6 });
      await expect(ending).resolves.toEqual({ status: 'aborted' });
      expect(await accepted).toBe('failure');
      expect(response!.resetCount()).toBe(1);
      expect(f.a.bidiOut.at(-1)!.in.writeClosed).toBe(false);
      expect(f.a.bidiOut.at(-1)!.in.written).toHaveLength(0);
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} pending response FIN rejects on reset and cannot become successful completion`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch();
      let response!: ReturnType<typeof held>;
      const create = f.b.createUnidirectionalStream.bind(f.b);
      f.b.createUnidirectionalStream = async () => { response = held(await create(), 'close'); return response.stream; };
      const stream = await f.server.openFetchStream(id);
      const closing = f.server.closeFetchStream(stream);
      const closed = closing.then(() => 'fin', () => 'reset');
      await response.started;
      await expect(f.server.abortIncomingFetch(id)).resolves.toEqual({ status: 'aborted' });
      expect(await closed).toBe('reset');
      expect(f.b.uniOut.at(-1)!.writeClosed).toBe(false);
      expect(f.b.uniOut.at(-1)!.writeAborted).toBe(true);
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} actual FIN winning the abort race returns already-terminal`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch();
      let response!: ReturnType<typeof held>;
      const create = f.b.createUnidirectionalStream.bind(f.b);
      f.b.createUnidirectionalStream = async () => { response = held(await create(), 'close', false); return response.stream; };
      const stream = await f.server.openFetchStream(id);
      const closing = f.server.closeFetchStream(stream);
      await response.started;
      const ending = f.server.abortIncomingFetch(id);
      response.gate.resolve();
      await closing;
      await expect(ending).resolves.toEqual({ status: 'already-terminal' });
      expect(f.b.uniOut.at(-1)!.writeClosed).toBe(true);
      expect(f.b.uniOut.at(-1)!.writeAborted).toBe(false);
      expect(f.server.session.state).not.toBe('closed');
    } finally { await f.cleanup(); }
  });
}

for (const draft of [18, 22] as const) {
  it(`draft${draft} aborting ${draft === 18 ? 'Joining' : 'standalone'} FETCH preserves its accepted live subscription`, async () => {
    const f = await setup(draft);
    try {
      f.server.setLargestLocationProvider(() => ({ group: 3n, object: 0n }));
      f.server.setFetchLargestLocationProvider(() => ({ group: 3n, object: 0n }));
      f.server.onSubscribe = id => {
        void f.server.acceptSubscribe(id, 9n, { parameters: new Map([
          [MessageParam.LARGEST_OBJECT, [{ group: 3n, object: 0n }]],
        ]) });
      };
      const sub = await f.client.subscribe(ns('joined'), nm('video'), { subscriptionFilter: { type: 'LargestObject' } });
      await flush(128);
      const owner = f.server.session.getIncomingSubscription(sub);
      expect(owner?.state).toBe('established');
      const id = draft === 18
        ? await f.client.joiningFetch({ joiningFetchType: 'relative', joiningRequestId: sub, joiningStart: 0n })
        : await f.client.fetch(ns('joined'), nm('video'), { startGroup: 3n, startObject: 0n, endGroup: 3n, endObject: 0n });
      await flush(128);
      const range = draft === 18 ? f.server.resolveJoiningFetch(id) : { endLocation: { group: 3n, object: 0n } };
      await f.server.acceptFetch(id, { endLocation: range.endLocation });
      await f.server.openFetchStream(id);
      await expect(f.server.abortIncomingFetch(id)).resolves.toEqual({ status: 'aborted' });
      expect(f.server.session.getIncomingSubscription(sub)).toBe(owner);
      expect(owner?.state).toBe('established');
      const output: number[] = [];
      f.client.onObject = (_id, object) => { if (object.kind === 'data') output.push(...object.payload); };
      const live = await f.server.openSubgroup(9n, 4n, 0n, { requestId: sub });
      await f.server.sendObject(live, 0n, Uint8Array.of(99));
      await flush(128);
      expect(output).toEqual([99]);
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} a completed response FIN is already terminal, never a new abort`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch();
      const stream = await f.server.openFetchStream(id);
      await f.server.closeFetchStream(stream);
      expect(f.b.uniOut.at(-1)!.writeClosed).toBe(true);
      await expect(f.server.abortIncomingFetch(id)).resolves.toEqual({ status: 'already-terminal' });
      expect(f.b.uniOut.at(-1)!.writeAborted).toBe(false);
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} pending acceptance owner is not eligible before acceptFetch`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch(false);
      const owner = f.server.session.getIncomingFetch(id);
      await expect(f.server.abortIncomingFetch(id)).rejects.toThrow('not an accepted');
      expect(f.server.session.getIncomingFetch(id)).toBe(owner);
      await f.server.acceptFetch(id, { endLocation: { group: 3n, object: 5n } });
      await expect(f.server.abortIncomingFetch(id)).resolves.toEqual({ status: 'aborted' });
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} allocation timeout escalates, but a late allocated stream still emits no header`, async () => {
    const f = await setup(draft);
    const gate = deferred();
    try {
      const id = await f.fetch();
      const create = f.b.createUnidirectionalStream.bind(f.b);
      f.b.createUnidirectionalStream = async () => { await gate.promise; return create(); };
      const opening = f.server.openFetchStream(id);
      const opened = opening.then(() => 'success', () => 'failure');
      vi.useFakeTimers();
      const ending = f.server.abortIncomingFetch(id).then(() => 'success', () => 'failure');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await ending).toBe('failure');
      expect(f.server.session.state).toBe('closed');
      vi.useRealTimers();
      gate.resolve();
      expect(await opened).toBe('failure');
      expect(f.b.uniOut.at(-1)!.written).toHaveLength(0);
      expect(f.b.uniOut.at(-1)!.writeAborted).toBe(true);
    } finally { gate.resolve(); vi.useRealTimers(); await f.cleanup(); }
  });
}

for (const draft of [18, 22] as const) {
  for (const high of [1n << 62n]) {
    it(`draft${draft} accepted wire FETCH ID ${high} is a vi64 request, not a QUIC stream ID`, async () => {
      const f = await setup(draft);
      try {
        // Obtain a conforming standalone request shape, then send the high ID
        // on a new real request stream. No allocator loop or synthetic ACK.
        await f.fetch();
        const codec = createControlCodec(draft);
        const template = codec.decode(f.a.bidiOut.at(-1)!.out.writtenBytes(), 0).message;
        expect(template.type).toBe('FETCH');
        if (template.type !== 'FETCH') throw new Error('fixture must encode FETCH');
        // Request parity is endpoint-owned. MAX_VI64 is a server-origin ID.
        const target = high % 2n === 0n ? f.server : f.client;
        const sender = high % 2n === 0n ? f.a : f.b;
        if (target === f.client) Object.assign(f.a, {
          createStreamError: f.transport.createStreamError,
          resetSendStream: f.transport.resetSendStream,
        });
        let seen: bigint | undefined;
        target.onFetch = id => { seen = id; };
        const raw = await sender.createBidirectionalStream();
        const writer = raw.writable.getWriter();
        await writer.write(codec.encode({ ...template, requestId: high as typeof template.requestId }));
        await flush(128);
        expect(f.errors.map(error => error.message)).toEqual([]);
        expect(seen).toBe(high);
        const accepted = target.acceptFetch(high, { endLocation: { group: 3n, object: 5n } });
        const reader = raw.readable.getReader();
        const response = await reader.read();
        expect(codec.decode(response.value!, 0).message.type).toBe('FETCH_OK');
        await accepted;
        const owner = target.session.getIncomingFetch(high);
        expect(owner?.state).toBe('transferring');
        await expect(target.abortIncomingFetch(-1n)).rejects.toThrow();
        await expect(target.abortIncomingFetch(MAX_VI64 + 1n)).rejects.toThrow();
        expect(target.session.getIncomingFetch(high)).toBe(owner);
        await expect(target.abortIncomingFetch(high, { streamErrorCode: 6 })).resolves.toEqual({ status: 'aborted' });
        await expect(reader.read()).rejects.toMatchObject({ streamErrorCode: 6 });
        reader.releaseLock(); writer.releaseLock();
      } finally { await f.cleanup(); }
    });
  }

  it(`draft${draft} outbound SUBSCRIBE and both PUBLISH directions are not retired FETCH IDs`, async () => {
    const f = await setup(draft);
    try {
      const factory = vi.fn(f.transport.createStreamError!);
      f.transport.createStreamError = factory;
      f.server.setLargestLocationProvider(() => ({ group: 3n, object: 0n }));
      f.client.setLargestLocationProvider(() => ({ group: 3n, object: 0n }));
      f.client.onSubscribe = id => { void f.client.acceptSubscribe(id, 19n); };
      const subscription = await f.server.subscribe(ns('live'), nm('two'));
      await flush(128);
      const subOwner = f.server.session.getSubscription(subscription);
      expect(subOwner?.state).toBe('established');
      await expect(f.server.abortIncomingFetch(subscription)).rejects.toThrow('not an accepted');
      expect(f.server.session.getSubscription(subscription)).toBe(subOwner);
      const received: number[] = [];
      f.client.onPublish = pub => {
        pub.onObject = object => { if (object.kind === 'data') received.push(...object.payload); };
        void f.client.acceptSubscribe(pub.requestId, pub.trackAlias);
      };
      f.server.onPublish = pub => {
        pub.onObject = object => { if (object.kind === 'data') received.push(...object.payload); };
        void f.server.acceptSubscribe(pub.requestId, pub.trackAlias);
      };
      const outgoing = await f.server.publish(ns('live'), nm('one'), 29n);
      const incoming = await f.client.publish(ns('live'), nm('three'), 39n);
      await flush(128);
      expect(f.server.session.getOutgoingPublish(outgoing)?.state).toBe('established');
      expect(f.server.session.getIncomingSubscription(incoming)?.state).toBe('established');
      await expect(f.server.abortIncomingFetch(outgoing)).rejects.toThrow('not an accepted');
      await expect(f.server.abortIncomingFetch(incoming)).rejects.toThrow('not an accepted');
      expect(factory).not.toHaveBeenCalled();
      const subscribedOutput: number[] = [];
      f.server.onObject = (_id, object) => {
        if (object.kind === 'data' && object.trackAlias === 19n) subscribedOutput.push(...object.payload);
      };
      const subStream = await f.client.openSubgroup(19n, 4n, 0n, { requestId: subscription });
      await f.client.sendObject(subStream, 0n, Uint8Array.of(73));
      const a = await f.server.openSubgroup(29n, 4n, 0n, { requestId: outgoing });
      const b = await f.client.openSubgroup(39n, 4n, 0n, { requestId: incoming });
      await f.server.sendObject(a, 0n, Uint8Array.of(71));
      await f.client.sendObject(b, 0n, Uint8Array.of(72));
      await flush(128);
      expect(received).toEqual([71, 72]);
      expect(subscribedOutput).toEqual([73]);
    } finally { await f.cleanup(); }
  });
}


for (const draft of [18, 22] as const) {
  it(`draft${draft} a pending object write is rejected and no payload follows revocation`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch();
      const create = f.b.createUnidirectionalStream.bind(f.b);
      // First admit the FETCH header normally; then hold the next native write.
      let block = false;
      const gate = deferred();
      const started = deferred();
      let interrupted: unknown;
      f.b.createUnidirectionalStream = async () => {
        const pipe = await create();
        const writer = pipe.getWriter();
        return new WritableStream<Uint8Array>({
          start(controller) {
            controller.signal.addEventListener('abort', () => {
              interrupted = controller.signal.reason;
              gate.reject(interrupted);
            });
          },
          async write(bytes) { if (block) { started.resolve(); await gate.promise; } await writer.write(bytes); },
          close: () => writer.close(),
          abort: reason => writer.abort(reason),
        });
      };
      const stream = await f.server.openFetchStream(id);
      block = true;
      const sending = f.server.sendFetchObject(stream, { groupId: 3n, objectId: 0n, subgroupId: 0n, publisherPriority: 128, payload: Uint8Array.of(88) });
      const sent = sending.then(() => 'success', () => 'failure');
      await started.promise;
      await expect(f.server.abortIncomingFetch(id)).resolves.toEqual({ status: 'aborted' });
      expect(await sent).toBe('failure');
      expect(interrupted).toBe(f.reasons[0]);
      expect(f.b.uniOut.at(-1)!.written).toHaveLength(1); // header only
      expect(f.b.uniOut.at(-1)!.writeAborted).toBe(true);
    } finally { await f.cleanup(); }
  });

  it(`draft${draft} a fulfilled abort hook cannot prove an unsettled response FIN`, async () => {
    const f = await setup(draft);
    let response: ReturnType<typeof held> | undefined;
    try {
      const id = await f.fetch();
      const create = f.b.createUnidirectionalStream.bind(f.b);
      f.b.createUnidirectionalStream = async () => { response = held(await create(), 'close', false); return response.stream; };
      const stream = await f.server.openFetchStream(id);
      const closing = f.server.closeFetchStream(stream);
      void closing.catch(() => {});
      await response!.started;
      const reset = f.transport.resetSendStream!;
      let calls = 0;
      f.transport.resetSendStream = (writer, reason, fin) => {
        calls++;
        return calls === 1 ? Promise.resolve() : reset(writer, reason, fin);
      };
      vi.useFakeTimers();
      const ending = f.server.abortIncomingFetch(id).then(() => 'success', () => 'failure');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await ending).toBe('failure');
      expect(f.server.session.state).toBe('closed');
    } finally { response?.gate.resolve(); vi.useRealTimers(); await f.cleanup(); }
  });

  it(`draft${draft} failure to reset only the request half still escalates`, async () => {
    const f = await setup(draft);
    try {
      const id = await f.fetch(); await f.server.openFetchStream(id);
      const reset = f.transport.resetSendStream!;
      let calls = 0;
      f.transport.resetSendStream = (writer, reason, fin) => {
        calls++;
        return calls === 1 ? reset(writer, reason, fin) : new Promise(() => {});
      };
      vi.useFakeTimers();
      const ending = f.server.abortIncomingFetch(id).then(() => 'success', () => 'failure');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await ending).toBe('failure');
      expect(f.b.uniOut.at(-1)!.writeAborted).toBe(true);
      expect(f.server.session.state).toBe('closed');
    } finally { vi.useRealTimers(); await f.cleanup(); }
  });
}
