import { describe, expect, it } from 'vitest';
import {
  connectQuicCandidatesWithRuntime,
  connectQuicWithRuntime,
  parseMoqtUri,
  resolveDialAddresses,
} from './connect.js';
import type {
  NativeQuicConnectOptions,
  NativeQuicCloseOptions,
  NativeQuicOpenedInfo,
  NativeQuicRuntime,
  NativeQuicSession,
  NativeQuicStream,
} from './native.js';

const DRAINABLE_PROTOCOL = Symbol.for('Stream.drainableProtocol');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeStream implements NativeQuicStream {
  readonly resetCodes: bigint[] = [];
  readonly stopCodes: bigint[] = [];
  readonly writes: Uint8Array[] = [];
  ended = 0;
  iteratorCreations = 0;
  iteratorReturns = 0;
  stopFailure: unknown;
  drainCalls = 0;
  onerror?: (error: unknown) => void;
  onreset?: (error: unknown) => void;
  onstopsending?: (error: unknown) => void;
  private readonly chunks: Uint8Array[][];
  private writeAllowed = true;
  private writeDrain = deferred<void>();
  readonly writer: NativeQuicStream['writer'];
  readonly closed: Promise<void>;

  constructor(
    readonly direction: 'bidi' | 'uni',
    chunks: Uint8Array[][] = [],
    private readonly readFailure?: unknown,
    closed: Promise<void> = Promise.resolve(),
  ) {
    this.chunks = [...chunks];
    this.closed = closed;
    const self = this;
    this.writer = {
      get canWrite() { return self.writeAllowed; },
      write: async (chunk: Uint8Array) => {
        if (!self.writeAllowed) throw new Error('Stream write buffer is full');
        self.writes.push(chunk.slice());
      },
      end: async () => { this.ended++; },
      fail: () => {},
      [DRAINABLE_PROTOCOL]: () => {
        self.drainCalls++;
        return self.writeAllowed ? null : self.writeDrain.promise;
      },
    } as NativeQuicStream['writer'];
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array[]> {
    this.iteratorCreations++;
    const batches = this.chunks;
    let failed = false;
    return {
      next: async () => {
        if (this.readFailure !== undefined && !failed) {
          failed = true;
          throw this.readFailure;
        }
        return batches.length > 0
          ? { done: false, value: batches.shift()! }
          : { done: true, value: undefined };
      },
      return: async () => {
        this.iteratorReturns++;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  resetStream(code = 0n): void { this.resetCodes.push(BigInt(code)); }
  stopSending(code = 0n): void {
    this.stopCodes.push(BigInt(code));
    if (this.stopFailure !== undefined) throw this.stopFailure;
  }

  blockWrites(): void {
    this.writeAllowed = false;
    this.writeDrain = deferred<void>();
  }

  unblockWrites(): void {
    this.writeAllowed = true;
    this.writeDrain.resolve();
  }

}

class FakeSession implements NativeQuicSession {
  readonly closeCalls: Array<{ code?: bigint | number; type?: 'transport' | 'application'; reason?: string }> = [];
  readonly destroyCalls: Array<{ error?: unknown; options?: { code?: bigint | number; type?: 'transport' | 'application'; reason?: string } }> = [];
  readonly datagrams: Uint8Array[] = [];
  readonly outgoingBidi: FakeStream[] = [];
  readonly outgoingUni: FakeStream[] = [];
  readonly outgoingBidiClosed: ReturnType<typeof deferred<void>>[] = [];
  readonly outgoingUniClosed: ReturnType<typeof deferred<void>>[] = [];
  readonly closedGate = deferred<void>();
  readonly opened: Promise<NativeQuicOpenedInfo>;
  readonly closed = this.closedGate.promise;
  maxDatagramSize = 1180;

  constructor(
    info: Partial<NativeQuicOpenedInfo> = {},
    opened?: Promise<NativeQuicOpenedInfo>,
  ) {
    this.opened = opened ?? Promise.resolve({
      protocol: 'moqt-18',
      earlyDataAttempted: false,
      earlyDataAccepted: false,
      ...info,
    });
  }

  async createBidirectionalStream(): Promise<NativeQuicStream> {
    const closed = deferred<void>();
    void closed.promise.catch(() => {});
    const stream = new FakeStream('bidi', [], undefined, closed.promise);
    this.outgoingBidi.push(stream);
    this.outgoingBidiClosed.push(closed);
    return stream;
  }

  async createUnidirectionalStream(): Promise<NativeQuicStream> {
    const closed = deferred<void>();
    void closed.promise.catch(() => {});
    const stream = new FakeStream('uni', [], undefined, closed.promise);
    this.outgoingUni.push(stream);
    this.outgoingUniClosed.push(closed);
    return stream;
  }

  async sendDatagram(data: Uint8Array): Promise<bigint> {
    this.datagrams.push(data.slice());
    return 1n;
  }

  async close(options = {}): Promise<void> { this.closeCalls.push(options); }
  destroy(error?: unknown, options?: NativeQuicCloseOptions): void {
    this.destroyCalls.push({ error, options });
    this.closedGate.resolve();
  }
}

function fakeRuntime(session: FakeSession) {
  let address = '';
  let options: NativeQuicConnectOptions | undefined;
  const runtime: NativeQuicRuntime = {
    connect: async (nextAddress, nextOptions) => {
      address = nextAddress;
      options = nextOptions;
      return session;
    },
  };
  return { runtime, address: () => address, options: () => options! };
}

describe('parseMoqtUri', () => {
  it('derives the dial address and exact native SETUP routing fields', () => {
    expect(parseMoqtUri('moqt://relay.example:4443/live/channel?token=a%2Fb#track:local')).toEqual({
      address: 'relay.example:4443',
      servername: 'relay.example',
      setup: { authority: 'relay.example:4443', path: '/live/channel?token=a%2Fb' },
    });
  });

  it('resolves DNS for Node while preserving literal IPv4 and IPv6 addresses', async () => {
    const lookup = async (hostname: string) => {
      expect(hostname).toBe('relay.example');
      return [
        { address: '192.0.2.10', family: 4 },
        { address: '2001:db8::10', family: 6 },
      ];
    };
    await expect(resolveDialAddresses(parseMoqtUri('moqt://relay.example:4443/moq'), lookup))
      .resolves.toEqual(['192.0.2.10:4443', '[2001:db8::10]:4443']);
    await expect(resolveDialAddresses(parseMoqtUri('moqt://192.0.2.20/moq'), lookup))
      .resolves.toEqual(['192.0.2.20:443']);
    await expect(resolveDialAddresses(parseMoqtUri('moqt://[2001:db8::1]:4443/moq'), lookup))
      .resolves.toEqual(['[2001:db8::1]:4443']);
  });

  it('uses port 443 without adding it to an omitted URI authority', () => {
    expect(parseMoqtUri('moqt://relay.example')).toEqual({
      address: 'relay.example:443',
      servername: 'relay.example',
      setup: { authority: 'relay.example', path: '' },
    });
  });

  it('preserves URI component text sent in SETUP without transmitting the fragment', () => {
    expect(parseMoqtUri('moqt://RELAY.example:443/a/../b?#track:one')).toEqual({
      address: 'relay.example:443',
      servername: 'relay.example',
      setup: { authority: 'RELAY.example:443', path: '/a/../b?' },
    });
  });

  it('brackets IPv6 for dialing and rejects unsupported or credentialed URIs', () => {
    expect(parseMoqtUri('moqt://[2001:db8::1]:4443/a').address).toBe('[2001:db8::1]:4443');
    expect(() => parseMoqtUri('https://relay.example/moq')).toThrow(/moqt:/);
    expect(() => parseMoqtUri('moqt://user@relay.example/moq')).toThrow(/credentials/);
    expect(() => parseMoqtUri('moqt://relay.example\\evil/moq')).toThrow(/authority/);
    expect(() => parseMoqtUri('moqt://relay.example\u0001/moq')).toThrow(/authority/);
    expect(() => parseMoqtUri('moqt:///moq')).toThrow(/host/);
    expect(() => parseMoqtUri('moqt://relay.example/moq#local')).toThrow(/fragment/);
    expect(() => parseMoqtUri('moqt://relay.example/moq#UPPER:value')).toThrow(/fragment/);
    expect(() => parseMoqtUri('moqt://relay.example/a b')).toThrow(/path/);
    expect(() => parseMoqtUri('moqt://relay.example/%GG')).toThrow(/path/);
    expect(() => parseMoqtUri('moqt://relay.example/moq?q=%GG')).toThrow(/query/);
    expect(() => parseMoqtUri('moqt://relay.example/moq#track:a b')).toThrow(/fragment value/);
    expect(() => parseMoqtUri('moqt://r\u00e9lay.example/moq')).toThrow(/authority/);
  });
});

describe('connectQuicWithRuntime', () => {
  it('tries every address for one authority without changing SETUP identity', async () => {
    const failed = new FakeSession({}, Promise.reject(new Error('unreachable')));
    const succeeded = new FakeSession();
    const attempts: string[] = [];
    const options: NativeQuicConnectOptions[] = [];
    const runtime: NativeQuicRuntime = {
      connect: async (address, connectOptions) => {
        attempts.push(address);
        options.push(connectOptions);
        return attempts.length === 1 ? failed : succeeded;
      },
    };

    const transport = await connectQuicCandidatesWithRuntime(
      'moqt://Relay.example:4443/live',
      {},
      runtime,
      ['192.0.2.1:4443', '[2001:db8::1]:4443'],
    );
    expect(attempts).toEqual(['192.0.2.1:4443', '[2001:db8::1]:4443']);
    expect(options.map((candidate) => candidate.endpoint)).toEqual([
      { address: '0.0.0.0:0' },
      { address: '[::]:0' },
    ]);
    expect(options.map((candidate) => candidate.reuseEndpoint)).toEqual([false, false]);
    expect(transport.setupOptions).toEqual({ authority: 'Relay.example:4443', path: '/live' });
    expect(failed.destroyCalls).toHaveLength(1);
  });

  it('offers only moqt-18, advertises datagrams, disables 0-RTT, and captures early ingress', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const connecting = connectQuicWithRuntime('moqt://relay.example:4443/moq', {}, fake.runtime);
    await Promise.resolve();

    const earlyUni = new FakeStream('uni', [[new Uint8Array([1, 2])]]);
    const earlyBidi = new FakeStream('bidi', [[new Uint8Array([3])]]);
    fake.options().onstream!(earlyUni);
    fake.options().onstream!(earlyBidi);
    fake.options().ondatagram!(new Uint8Array([4, 5]), false);

    const transport = await connecting;
    expect(fake.address()).toBe('relay.example:4443');
    expect(fake.options()).toMatchObject({
      alpn: 'moqt-18',
      enableEarlyData: false,
      rejectUnauthorized: true,
      verifyPeer: 'strict',
      servername: 'relay.example',
      handshakeTimeout: 10_000,
      transportParams: { maxDatagramFrameSize: 1200 },
    });
    expect(transport).toMatchObject({
      kind: 'quic',
      protocol: 'moqt-18',
      maxDatagramSize: 1180,
      setupOptions: { authority: 'relay.example:4443', path: '/moq' },
    });
    const uni = await transport.incomingUnidirectionalStreams.getReader().read();
    expect(uni.done).toBe(false);
    expect(await uni.value!.getReader().read()).toEqual({ done: false, value: new Uint8Array([1, 2]) });
    const bidi = await transport.incomingBidirectionalStreams!.getReader().read();
    expect(bidi.done).toBe(false);
    expect(await bidi.value!.readable.getReader().read()).toEqual({ done: false, value: new Uint8Array([3]) });
    expect(await transport.datagrams.readable.getReader().read()).toEqual({ done: false, value: new Uint8Array([4, 5]) });
  });

  it('fails startup even when rejecting an invalid incoming stream throws', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const connecting = connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    await Promise.resolve();
    const invalid = new FakeStream('uni');
    Object.defineProperty(invalid, 'direction', { value: null });
    invalid.stopFailure = new Error('backend STOP_SENDING failed');

    expect(() => fake.options().onstream!(invalid)).not.toThrow();
    await expect(connecting).rejects.toThrow(/incoming stream queue overflowed or had no direction/);
    expect(session.destroyCalls).toHaveLength(1);
  });

  it('uses explicit insecure verification only when requested', async () => {
    const session = new FakeSession({ validationErrorCode: 18, validationErrorReason: 'self signed' });
    const fake = fakeRuntime(session);
    await connectQuicWithRuntime('moqt://relay.example/moq', { allowUnauthorized: true }, fake.runtime);
    expect(fake.options()).toMatchObject({ verifyPeer: 'manual', rejectUnauthorized: false });
  });

  it('rejects a reported certificate validation failure in strict mode', async () => {
    const session = new FakeSession({ validationErrorCode: 18, validationErrorReason: 'self signed' });
    const fake = fakeRuntime(session);
    await expect(connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime))
      .rejects.toThrow(/certificate validation failed: self signed/);
    expect(session.destroyCalls).toHaveLength(1);
  });

  it.each([
    [{ protocol: 'h3' }, /negotiated ALPN/],
    [{ earlyDataAttempted: true }, /0-RTT/],
  ] as const)('fails closed when handshake metadata is invalid: %j', async (info, message) => {
    const session = new FakeSession(info);
    const fake = fakeRuntime(session);
    await expect(connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime)).rejects.toThrow(message);
    expect(session.destroyCalls).toHaveLength(1);
  });

  it('observes a closed rejection that races ahead of a failed handshake', async () => {
    const opened = deferred<NativeQuicOpenedInfo>();
    const session = new FakeSession({}, opened.promise);
    const fake = fakeRuntime(session);
    const connecting = connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    await Promise.resolve();

    const failure = new Error('handshake failed');
    session.closedGate.reject(failure);
    opened.reject(failure);

    await expect(connecting).rejects.toBe(failure);
  });

  it('reports the native handshake diagnostic instead of a generic opened rejection', async () => {
    const openedFailure = new Error('Session was destroyed before it opened');
    const nativeFailure = new Error('TLS certificate name mismatch');
    const session = new FakeSession({}, Promise.reject(openedFailure));
    const runtime: NativeQuicRuntime = {
      connect: async (_address, options) => {
        options.onerror(nativeFailure);
        session.closedGate.reject(nativeFailure);
        return session;
      },
    };

    await expect(connectQuicWithRuntime('moqt://relay.example/moq', {}, runtime))
      .rejects.toBe(nativeFailure);
  });

  it('fails closed when the peer did not negotiate QUIC DATAGRAM', async () => {
    const session = new FakeSession();
    session.maxDatagramSize = 0;
    const fake = fakeRuntime(session);
    await expect(connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime)).rejects.toThrow(/datagram/i);
    expect(session.destroyCalls).toHaveLength(1);
  });

  it('maps Web Streams FIN, RESET_STREAM, and STOP_SENDING to distinct native operations', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);

    const outgoing = await transport.createBidirectionalStream();
    const writer = outgoing.writable.getWriter();
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.close();
    expect(session.outgoingBidi[0]!.writes).toEqual([new Uint8Array([1, 2, 3])]);
    expect(session.outgoingBidi[0]!.ended).toBe(1);
    expect(session.outgoingBidi[0]!.resetCodes).toEqual([]);

    const reset = await transport.createUnidirectionalStream!();
    await reset.getWriter().abort(0x1n);
    expect(session.outgoingUni[0]!.resetCodes).toEqual([0x1n]);

    const incoming = new FakeStream('uni', [[new Uint8Array([9])]]);
    fake.options().onstream!(incoming);
    const readable = (await transport.incomingUnidirectionalStreams.getReader().read()).value!;
    await readable.cancel(0x2n);
    expect(incoming.stopCodes).toEqual([0x2n]);
  });

  it('waits for native QUIC write capacity without dropping or duplicating bytes', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writable = await transport.createUnidirectionalStream!();
    const outgoing = session.outgoingUni[0]!;
    outgoing.blockWrites();

    const bytes = new Uint8Array([1, 2, 3, 4]);
    let outcome = 'pending';
    const writing = writable.getWriter().write(bytes).then(
      () => { outcome = 'fulfilled'; },
      () => { outcome = 'rejected'; },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(outcome).toBe('pending');
    expect(outgoing.drainCalls).toBe(1);
    expect(outgoing.writes).toEqual([]);

    outgoing.unblockWrites();
    await writing;
    expect(outcome).toBe('fulfilled');
    expect(outgoing.writes).toEqual([bytes]);
  });

  it('aborts a flow-controlled write without waiting for peer drain', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writable = await transport.createUnidirectionalStream!();
    const writer = writable.getWriter();
    const outgoing = session.outgoingUni[0]!;
    outgoing.blockWrites();

    const writing = writer.write(new Uint8Array([1])).then(
      () => 'fulfilled',
      () => 'rejected',
    );
    await Promise.resolve();
    await Promise.resolve();
    const aborting = writer.abort(0x1n);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(outgoing.resetCodes).toEqual([0x1n]);
    await expect(aborting).resolves.toBeUndefined();
    await expect(writing).resolves.toBe('rejected');
  });

  it('releases the native read iterator when STOP_SENDING throws', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const incoming = new FakeStream('uni', [[new Uint8Array([9])]]);
    incoming.stopFailure = new Error('stop failed');
    fake.options().onstream!(incoming);
    const readable = (await transport.incomingUnidirectionalStreams.getReader().read()).value!;
    const reader = readable.getReader();
    await reader.read();

    await expect(reader.cancel(0x2n)).rejects.toThrow('stop failed');
    expect(incoming.iteratorReturns).toBe(1);
  });

  it('retires every queued native stream when its aggregate source is cancelled', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const queued = [new FakeStream('uni'), new FakeStream('uni'), new FakeStream('uni')];
    for (const stream of queued) fake.options().onstream!(stream);

    await transport.incomingUnidirectionalStreams.cancel(0x1n);

    expect(queued.map((stream) => stream.stopCodes)).toEqual([[0x1n], [0x1n], [0x1n]]);
    expect(queued.map((stream) => stream.iteratorCreations)).toEqual([0, 0, 0]);
  });

  it('retires both halves of a queued bidirectional stream', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const nativeClosed = deferred<void>();
    void nativeClosed.promise.catch(() => {});
    const queued = new FakeStream('bidi', [], undefined, nativeClosed.promise);
    fake.options().onstream!(queued);

    await transport.incomingBidirectionalStreams!.cancel(0x1n);

    expect(queued.stopCodes).toEqual([0x1n]);
    expect(queued.resetCodes).toEqual([0x1n]);
    expect(queued.iteratorCreations).toBe(0);
  });

  it('settles an idle stream writer when the native stream closes', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writer = (await transport.createUnidirectionalStream!()).getWriter();

    session.outgoingUniClosed[0]!.resolve();

    await expect(writer.closed).rejects.toThrow(/native QUIC stream closed/);
  });

  it('surfaces a native stream failure through an idle writer', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writer = (await transport.createUnidirectionalStream!()).getWriter();
    const failure = Object.assign(new Error('stream failed'), {
      type: 'application',
      errorCode: 0x2n,
    });

    session.outgoingUniClosed[0]!.reject(failure);

    await expect(writer.closed).rejects.toMatchObject({
      message: 'stream failed',
      streamErrorCode: 0x2,
    });
  });

  it('settles the datagram writer when the native session closes', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writer = transport.datagrams.writable!.getWriter();

    session.closedGate.resolve();

    await expect(writer.closed).rejects.toThrow(/native QUIC session closed/);
  });

  it('surfaces a native session failure through the datagram writer', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writer = transport.datagrams.writable!.getWriter();
    const failure = new Error('session failed');

    session.closedGate.reject(failure);

    await expect(writer.closed).rejects.toBe(failure);
  });

  it('surfaces peer STOP_SENDING and RESET_STREAM with the same application code', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writable = await transport.createUnidirectionalStream!();
    const writer = writable.getWriter();
    const closed = writer.closed.then(
      () => null,
      (error: unknown) => error,
    );
    const outgoing = session.outgoingUni[0]!;
    outgoing.onstopsending?.(Object.assign(new Error('cancelled'), {
      type: 'application',
      errorCode: 0x2n,
    }));
    expect(outgoing.resetCodes).toEqual([0x2n]);
    await expect(closed).resolves.toMatchObject({
      message: 'cancelled',
      streamErrorCode: 0x2,
    });
  });

  it('answers an unknown STOP_SENDING code with stream INTERNAL_ERROR', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writer = (await transport.createUnidirectionalStream!()).getWriter();
    const closed = writer.closed.then(
      () => null,
      (error: unknown) => error,
    );
    const outgoing = session.outgoingUni[0]!;
    const unknownCode = (1n << 62n) - 1n;

    outgoing.onstopsending?.(Object.freeze(Object.assign(new Error('unknown cancellation'), {
      type: 'application',
      errorCode: unknownCode,
    })));

    expect(outgoing.resetCodes).toEqual([0n]);
    await expect(closed).resolves.toMatchObject({
      message: 'unknown cancellation',
      quicErrorCode: unknownCode,
      streamErrorCode: 0,
    });
  });

  it('preserves a peer RESET_STREAM code without inventing one for generic read errors', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const incoming = transport.incomingUnidirectionalStreams.getReader();

    const reset = Object.assign(new Error('peer reset'), { errorCode: 0x1n, type: 'application' });
    const resetStream = new FakeStream('uni', [], reset);
    fake.options().onstream!(resetStream);
    resetStream.onreset?.(reset);
    const resetReadable = (await incoming.read()).value!;
    await expect(resetReadable.getReader().read()).rejects.toMatchObject({
      message: 'peer reset',
      streamErrorCode: 0x1,
    });

    const failureStream = new FakeStream('uni', [], new Error('socket failed'));
    fake.options().onstream!(failureStream);
    const failureReadable = (await incoming.read()).value!;
    const failure = await failureReadable.getReader().read().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('streamErrorCode');
  });

  it('does not classify a QUIC transport error as a MOQT stream reset', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const incoming = transport.incomingUnidirectionalStreams.getReader();
    const failure = Object.assign(new Error('QUIC flow-control failure'), {
      type: 'transport',
      errorCode: 0x3n,
    });
    fake.options().onstream!(new FakeStream('uni', [], failure));
    const readable = (await incoming.read()).value!;

    const reported = await readable.getReader().read().then(
      () => null,
      (error: unknown) => error,
    );
    expect(reported).toBe(failure);
    expect(reported).not.toHaveProperty('streamErrorCode');
  });

  it.each([0x8n, (1n << 62n) - 1n])(
    'maps unknown stream reset code %s to INTERNAL_ERROR',
    async (unknownCode) => {
      const session = new FakeSession();
      const fake = fakeRuntime(session);
      const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
      const reset = Object.assign(new Error('unknown peer reset'), {
        errorCode: unknownCode,
        type: 'application',
      });
      const stream = new FakeStream('uni', [], reset);
      fake.options().onstream!(stream);
      stream.onreset?.(reset);
      const readable = (await transport.incomingUnidirectionalStreams.getReader().read()).value!;

      await expect(readable.getReader().read()).rejects.toMatchObject({
        message: 'unknown peer reset',
        errorCode: unknownCode,
        quicErrorCode: unknownCode,
        streamErrorCode: 0,
      });
    },
  );

  it('recovers a reset-only unidirectional stream code from native closed state', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const closed = deferred<void>();
    const reset = Object.assign(new Error('reset before payload'), {
      errorCode: 0x12n,
      type: 'application',
    });
    const stream = new FakeStream('uni', [], undefined, closed.promise);
    fake.options().onstream!(stream);
    const readable = (await transport.incomingUnidirectionalStreams.getReader().read()).value!;
    const reading = readable.getReader().read();
    await Promise.resolve();
    closed.reject(reset);
    await expect(reading).rejects.toMatchObject({
      message: 'reset before payload',
      streamErrorCode: 0x12,
    });
  });

  it('preserves a reset code carried by a non-extensible native error', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const reset = Object.freeze(Object.assign(new Error('frozen reset'), {
      errorCode: 0x12n,
      type: 'application',
    }));
    fake.options().onstream!(new FakeStream('uni', [], reset));
    const readable = (await transport.incomingUnidirectionalStreams.getReader().read()).value!;

    await expect(readable.getReader().read()).rejects.toMatchObject({
      message: 'frozen reset',
      streamErrorCode: 0x12,
    });
  });

  it('sends datagrams and rejects a backend refusal', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const writer = transport.datagrams.writable!.getWriter();
    await writer.write(new Uint8Array([7, 8]));
    expect(session.datagrams).toEqual([new Uint8Array([7, 8])]);

    session.sendDatagram = async () => 0n;
    await expect(writer.write(new Uint8Array([9]))).rejects.toThrow(/refused/);
  });

  it('owns native session teardown and settles closed with the application close info', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    transport.close({ closeCode: 3, reason: 'bad message' });
    expect(session.destroyCalls).toEqual([{
      error: undefined,
      options: { code: 3, type: 'application', reason: 'bad message' },
    }]);
    await expect(transport.closed).resolves.toEqual({ closeCode: 3, reason: 'bad message' });
  });

  it('preserves a peer application close code and reason', async () => {
    const session = new FakeSession();
    const fake = fakeRuntime(session);
    const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
    const peerClose = Object.assign(new Error('QUIC application error 3: bad message'), {
      type: 'application',
      errorCode: 3n,
      reason: 'bad message',
    });
    fake.options().onerror(peerClose);
    session.closedGate.reject(peerClose);
    await expect(transport.closed).resolves.toEqual({ closeCode: 3, reason: 'bad message' });
  });

  it.each([0x7n, (1n << 62n) - 1n])(
    'maps unknown session close code %s to INTERNAL_ERROR',
    async (unknownCode) => {
      const session = new FakeSession();
      const fake = fakeRuntime(session);
      const transport = await connectQuicWithRuntime('moqt://relay.example/moq', {}, fake.runtime);
      const peerClose = Object.assign(new Error('future peer close'), {
        type: 'application',
        errorCode: unknownCode,
        reason: 'future peer close',
      });

      fake.options().onerror(peerClose);
      session.closedGate.reject(peerClose);

      await expect(transport.closed).resolves.toEqual({
        closeCode: 1,
        reason: `unknown session error code ${unknownCode}; treated as INTERNAL_ERROR: future peer close`,
      });
    },
  );
});
