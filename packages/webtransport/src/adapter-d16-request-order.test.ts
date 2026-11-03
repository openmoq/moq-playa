import { describe, expect, it } from 'vitest';
import { createControlCodec, SessionState, varint, type ControlMessage } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import type { WebTransportBidirectionalStream } from './types.js';
import { createLoopback, flush, type LoopPipe } from './testkit/loopback.js';

const codec = createControlCodec(16);
const enc = new TextEncoder();
const namespace = [enc.encode('live')];
const settle = () => flush(100);

function messages(pipe: LoopPipe): ControlMessage[] {
  const bytes = new Uint8Array(pipe.written.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const chunk of pipe.written) { bytes.set(chunk, offset); offset += chunk.length; }
  const result: ControlMessage[] = [];
  for (offset = 0; offset < bytes.length;) {
    const next = codec.decode(bytes, offset);
    result.push(next.message as ControlMessage);
    offset += next.bytesRead;
  }
  return result;
}

async function rawPeer(maximum = 100n, fragmented = false, rejectNamespaceWrites = false) {
  const { a, b } = createLoopback({ b: fragmented ? { chunkSize: 1 } : {} });
  const client = new MoqtConnection(16);
  const errors: Error[] = [];
  client.onError = error => errors.push(error);
  const mapped = rejectNamespaceWrites ? a.incomingBidirectionalStreams.pipeThrough(new TransformStream<WebTransportBidirectionalStream, WebTransportBidirectionalStream>({
    transform(stream, controller) {
      controller.enqueue({ readable: stream.readable, writable: new WritableStream({
        write() { throw new Error('namespace response write refused'); },
      }) });
    },
  })) : a.incomingBidirectionalStreams;
  const transport = new Proxy(a, { get(target, key) {
    if (key === 'incomingBidirectionalStreams') return mapped;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const connecting = client.connect(transport, { maxRequestId: varint(maximum) });
  const incoming = b.incomingBidirectionalStreams.getReader();
  const { value: control } = await incoming.read();
  incoming.releaseLock();
  const writer = control!.writable.getWriter();
  await writer.write(codec.encode({ type: 'SERVER_SETUP', parameters: new Map([[2n, [1000n]]]) }));
  await connecting;
  return {
    client, a, b, errors, control: a.bidiOut[0]!,
    send: (message: ControlMessage) => writer.write(codec.encode(message)),
    async namespace(id: bigint, bytes?: Uint8Array) {
      const stream = await b.createBidirectionalStream();
      const nsWriter = stream.writable.getWriter();
      await nsWriter.write(bytes ?? codec.encode({ type: 'SUBSCRIBE_NAMESPACE', requestId: varint(id),
        trackNamespacePrefix: namespace, subscribeOptions: varint(2n), parameters: new Map() }));
      nsWriter.releaseLock();
      await settle();
      return b.bidiOut[b.bidiOut.length - 1]!;
    },
    async destroy() { await client.close(); b.close(); writer.releaseLock(); },
  };
}

describe('draft-16 namespace/control request ordering', () => {
  it.each(['namespace type', 'stalled type'])('finds control behind an early %s stream', async kind => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(16);
    const server = new MoqtConnection(16, { role: 'server' });
    const serverSetup = server.connect(b, { maxRequestId: varint(100n) }).then(() => null, error => error);
    const early = await a.createBidirectionalStream();
    if (kind === 'namespace type') {
      const writer = early.writable.getWriter();
      await writer.write(new Uint8Array([0x11]));
      writer.releaseLock();
    }
    const clientSetup = client.connect(a, { maxRequestId: varint(100n) }).then(() => null, error => error);
    try {
      await settle();
      expect(server.session.state).toBe(SessionState.ESTABLISHED);
      expect(client.session.state).toBe(SessionState.ESTABLISHED);
      expect(await serverSetup).toBeNull();
      expect(await clientSetup).toBeNull();
      expect(a.bidiOut[0]!.out.readCancelled).toBe(true);
      expect(await client.publishNamespace(namespace)).toBe(0n);
      await settle();
      expect(server.session.state).toBe(SessionState.ESTABLISHED);
    } finally {
      const closing = Promise.all([client.close(), server.close()]);
      // The loopback records both directions under the endpoint that opened
      // the bidi. End both explicitly when setup never reached the peer.
      for (const record of [...a.bidiOut, ...b.bidiOut]) { record.out.reset(); record.in.reset(); }
      await closing;
      await Promise.all([serverSetup, clientSetup]);
    }
  });

  it.each([false, true])('admits both streams once (namespace first=%s)', async namespaceFirst => {
    const peer = await rawPeer();
    try {
      const publish = () => peer.send({ type: 'PUBLISH_NAMESPACE', requestId: varint(3n),
        trackNamespace: namespace, parameters: new Map() });
      if (!namespaceFirst) await publish();
      const stream = await peer.namespace(1n);
      if (namespaceFirst) await publish();
      await settle();
      expect(peer.client.session.state).toBe(SessionState.ESTABLISHED);
      expect(messages(stream.in)).toEqual([expect.objectContaining({
        type: 'REQUEST_ERROR', requestId: 1n, errorCode: 3n,
      })]);
      expect(stream.in.writeClosed).toBe(true);
      expect(messages(peer.control.out)).toContainEqual(expect.objectContaining({ type: 'REQUEST_OK', requestId: 3n }));
      expect(peer.errors).toEqual([]);
    } finally { await peer.destroy(); }
  });

  it('keeps namespace rejection on its bidi and replenishment on control', async () => {
    const peer = await rawPeer(4n);
    try {
      const stream = await peer.namespace(3n);
      expect(messages(stream.in)).toEqual([expect.objectContaining({ type: 'REQUEST_ERROR', requestId: 3n })]);
      expect(messages(peer.control.out).filter(m => m.type !== 'CLIENT_SETUP')).toEqual([
        expect.objectContaining({ type: 'MAX_REQUEST_ID', maxRequestId: 1004n }),
      ]);
      expect(peer.client.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await peer.destroy(); }
  });

  it('frames fragmented namespace requests without losing their Request ID', async () => {
    const peer = await rawPeer(100n, true);
    try {
      const stream = await peer.namespace(1n);
      expect(messages(stream.in)).toEqual([expect.objectContaining({ type: 'REQUEST_ERROR', requestId: 1n })]);
      expect(peer.errors).toEqual([]);
    } finally { await peer.destroy(); }
  });

  it.each(['namespace', 'control'] as const)('a rejected namespace ID remains consumed on %s', async path => {
    const peer = await rawPeer();
    const closed: Array<number | undefined> = [];
    peer.client.onClose = code => closed.push(code);
    try {
      const first = await peer.namespace(1n);
      expect(messages(first.in)).toHaveLength(1);
      if (path === 'namespace') await peer.namespace(1n);
      else await peer.send({ type: 'PUBLISH_NAMESPACE', requestId: varint(1n),
        trackNamespace: namespace, parameters: new Map() });
      await settle();
      expect(closed).toEqual([4]);
    } finally { await peer.destroy(); }
  });

  it.each([0n, 3n, 5n])('rejects invalid parity or credit for namespace ID %s', async id => {
    const peer = await rawPeer(3n);
    const closed: Array<number | undefined> = [];
    peer.client.onClose = code => closed.push(code);
    try {
      await peer.namespace(id);
      expect(closed).toEqual([id === 0n ? 4 : 7]);
    } finally { await peer.destroy(); }
  });

  it.each([0n, 1n, 2n])('rejects unsupported serving cleanly for Subscribe Options %s', async options => {
    const peer = await rawPeer();
    try {
      const stream = await peer.namespace(1n, codec.encode({ type: 'SUBSCRIBE_NAMESPACE', requestId: varint(1n),
        trackNamespacePrefix: namespace, subscribeOptions: varint(options), parameters: new Map() }));
      expect(messages(stream.in)).toEqual([expect.objectContaining({ type: 'REQUEST_ERROR', requestId: 1n, errorCode: 3n })]);
      expect(stream.in.writeClosed).toBe(true);
      expect(peer.client.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await peer.destroy(); }
  });

  it.each(['fin', 'reset'] as const)('an abandoned partial namespace stream (%s) does not consume its ID', async ending => {
    const peer = await rawPeer();
    try {
      const stream = await peer.b.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(new Uint8Array([0x11, 0x00])); // Type plus a partial uint16 length.
      if (ending === 'fin') await writer.close();
      else await writer.abort();
      writer.releaseLock();
      await settle();
      expect(peer.client.session.state).toBe(SessionState.ESTABLISHED);
      expect(peer.errors).toEqual([]);
      const retry = await peer.namespace(1n);
      expect(messages(retry.in)).toContainEqual(expect.objectContaining({ type: 'REQUEST_ERROR', requestId: 1n }));
    } finally { await peer.destroy(); }
  });

  it('releases partial readers on close without cancelling the transport-owned source', async () => {
    const peer = await rawPeer();
    try {
      await peer.b.createBidirectionalStream();
      await settle();
      const pending = peer.b.bidiOut.at(-1)!;
      expect(pending.out.readCancelled).toBe(false);
      await peer.client.close();
      await settle();
      expect(pending.out.readCancelled).toBe(true);
      expect(pending.in.writeAborted).toBe(true);
      expect(peer.a.incomingBidirectionalStreams.locked).toBe(false);
      // A backend that closes its own controller after onClose must still be
      // able to enqueue here; cancel() would have permanently closed it.
      await expect(peer.b.createBidirectionalStream()).resolves.toBeDefined();
      await expect(peer.a.closed).resolves.toEqual({ closeCode: 0, reason: '' });
    } finally { await peer.destroy(); }
  });

  it('bounds partial namespace streams as local resource exhaustion', async () => {
    const peer = await rawPeer();
    const closed: Array<number | undefined> = [];
    peer.client.onClose = code => closed.push(code);
    try {
      for (let i = 0; i < 128; i++) await peer.b.createBidirectionalStream();
      await settle();
      expect(peer.client.session.state).toBe(SessionState.ESTABLISHED);
      await peer.b.createBidirectionalStream();
      await settle();
      expect(closed).toEqual([1]);
      for (const pending of peer.b.bidiOut) expect(pending.out.readCancelled).toBe(true);
    } finally { await peer.destroy(); }
  });

  it('observer shutdown cannot admit or answer the just-observed namespace request', async () => {
    const peer = await rawPeer();
    let closing: Promise<void> | undefined;
    peer.client.onMessage = message => { if (message.type === 'SUBSCRIBE_NAMESPACE') closing = peer.client.close(); };
    try {
      const stream = await peer.namespace(1n);
      await closing;
      expect(messages(stream.in)).toEqual([]);
      expect(peer.client.session.state).toBe(SessionState.CLOSED);
    } finally { await peer.destroy(); }
  });

  it('does not let an observation rewrite namespace request admission', async () => {
    const peer = await rawPeer();
    peer.client.onMessage = message => { if (message.type === 'SUBSCRIBE_NAMESPACE') Reflect.set(message, 'requestId', 3n); };
    try {
      const stream = await peer.namespace(1n);
      expect(messages(stream.in)).toContainEqual(expect.objectContaining({ type: 'REQUEST_ERROR', requestId: 1n }));
      await peer.send({ type: 'PUBLISH_NAMESPACE', requestId: varint(3n), trackNamespace: namespace, parameters: new Map() });
      await settle();
      expect(peer.client.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await peer.destroy(); }
  });

  it('does not lose committed credit when the namespace response write fails', async () => {
    const peer = await rawPeer(4n, false, true);
    try {
      await peer.namespace(3n);
      expect(messages(peer.control.out)).toContainEqual(expect.objectContaining({ type: 'MAX_REQUEST_ID', maxRequestId: 1004n }));
      await peer.send({ type: 'PUBLISH_NAMESPACE', requestId: varint(1n), trackNamespace: namespace, parameters: new Map() });
      await settle();
      expect(peer.client.session.state).toBe(SessionState.ESTABLISHED);
      expect(messages(peer.control.out)).toContainEqual(expect.objectContaining({ type: 'REQUEST_OK', requestId: 1n }));
    } finally { await peer.destroy(); }
  });

  it('answers in-flight namespace requests after receiving GOAWAY', async () => {
    const peer = await rawPeer();
    try {
      await peer.send({ type: 'GOAWAY', newSessionUri: '' });
      await settle();
      expect(peer.client.session.state).toBe(SessionState.DRAINING);
      const stream = await peer.namespace(1n);
      expect(messages(stream.in)).toContainEqual(expect.objectContaining({ type: 'REQUEST_ERROR', requestId: 1n, errorCode: 3n }));
      expect(peer.client.session.state).toBe(SessionState.DRAINING);
    } finally { await peer.destroy(); }
  });

  it.each([0x1d, 0x21, 0x3e])('refuses forbidden bidi type %s before its frame completes', async type => {
    const peer = await rawPeer();
    const closed: Array<number | undefined> = [];
    peer.client.onClose = code => closed.push(code);
    try {
      const stream = await peer.b.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(new Uint8Array([type]));
      await writer.close();
      writer.releaseLock();
      await settle();
      expect(closed).toEqual([3]);
    } finally { await peer.destroy(); }
  });

  it.each([{ bytes: [0x20] }, { bytes: [0x20, 0, 0] }])('owns terminal setup failure after handing off $bytes', async ({ bytes }) => {
    const { a, b } = createLoopback();
    const server = new MoqtConnection(16, { role: 'server' });
    const setup = server.connect(b, { maxRequestId: varint(100n) }).then(() => null, error => error);
    const control = await a.createBidirectionalStream();
    const writer = control.writable.getWriter();
    try {
      await writer.write(new Uint8Array(bytes));
      await writer.close();
      expect(await setup).toBeInstanceOf(Error);
      await settle();
      expect(server.session.state).toBe(SessionState.CLOSED);
      expect(b.closeInfo?.closeCode).toBe(3);
      await expect(b.closed).resolves.toEqual(expect.objectContaining({ closeCode: 3 }));
    } finally { await server.close(); a.close(); writer.releaseLock(); }
  });

  it('closes on a complete frame whose namespace payload cannot be decoded', async () => {
    const peer = await rawPeer();
    const closed: Array<number | undefined> = [];
    peer.client.onClose = code => closed.push(code);
    try {
      await peer.namespace(1n, new Uint8Array([0x11, 0, 0]));
      expect(closed).toEqual([3]);
    } finally { await peer.destroy(); }
  });

  it('rejects an undefined Subscribe Options value', async () => {
    const peer = await rawPeer();
    const closed: Array<number | undefined> = [];
    peer.client.onClose = code => closed.push(code);
    try {
      await peer.namespace(1n, codec.encode({ type: 'SUBSCRIBE_NAMESPACE', requestId: varint(1n),
        trackNamespacePrefix: namespace, subscribeOptions: varint(3n), parameters: new Map() }));
      expect(closed).toEqual([3]);
    } finally { await peer.destroy(); }
  });

  it('refuses SUBSCRIBE_NAMESPACE on the control stream', async () => {
    const peer = await rawPeer();
    const closed: Array<number | undefined> = [];
    peer.client.onClose = code => closed.push(code);
    try {
      await peer.send({ type: 'SUBSCRIBE_NAMESPACE', requestId: varint(1n),
        trackNamespacePrefix: namespace, subscribeOptions: varint(2n), parameters: new Map() });
      await settle();
      expect(closed).toEqual([3]);
    } finally { await peer.destroy(); }
  });

  it.each(['PUBLISH_NAMESPACE', 'CLIENT_SETUP', 'SERVER_SETUP'] as const)(
    'refuses extra-bidi opener %s', async type => {
      const peer = await rawPeer();
      const closed: Array<number | undefined> = [];
      peer.client.onClose = code => closed.push(code);
      try {
        const message: ControlMessage = type === 'PUBLISH_NAMESPACE'
          ? { type, requestId: varint(1n), trackNamespace: namespace, parameters: new Map() }
          : { type, parameters: new Map() };
        await peer.namespace(1n, codec.encode(message));
        expect(closed).toEqual([3]);
      } finally { await peer.destroy(); }
    });
});
