import { expect, it } from 'vitest';
import { createControlCodec, varint } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { SimStream, TransportSim, flush } from './testkit/stream-sim.js';
import type { WebTransportLike } from './types.js';
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map(part => parseInt(part, 16)));
const hex = (data: Uint8Array) => Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');

async function subscribeFill22(failFin = false) {
  const conn = new MoqtConnection(22), transport = new TransportSim(), resets: string[] = [];
  conn.onError = () => {};
  (transport as WebTransportLike).resetSendStream = async writer => {
    resets.push(hex(transport.uniOut.at(-1)!.writtenBytes())); await writer.abort();
  };
  transport.openIncomingUni().push(bytes('af000000')); await conn.connect(transport);
  const createUni = transport.createUnidirectionalStream.bind(transport);
  if (failFin) transport.createUnidirectionalStream = async () => {
    transport.createUnidirectionalStream = createUni;
    const stream = new SimStream(); transport.uniOut.push(stream);
    return new WritableStream<Uint8Array>({
      write(chunk) { stream.written.push(chunk.slice()); },
      close() { throw new Error('simulated close failure'); },
      abort() { stream.writeAborted = true; },
    });
  };
  const request = transport.pushIncomingBidi();
  request.push(createControlCodec(22).encode({ type: 'SUBSCRIBE', requestId: 1n,
    trackNamespace: [], trackName: bytes('76'), parameters: new Map([[0x23n, [Uint8Array.of(0)]]]) }));
  await flush(512);
  await conn.acceptSubscribe(1n, 42n, { parameters: new Map([[0x09n, [{ group: 1n, object: 3n }]]]) });
  const stream = await conn.openFillStream(1n), fill = transport.uniOut.at(-1)!;
  expect(hex(fill.writtenBytes())).toBe('0501');
  return { conn, transport, resets, request, stream, fill };
}

for (const kind of ['object', 'range', 'fin'] as const) it(`draft22 SUBSCRIBE fill ${kind} failure resets once, reclaims, and preserves its parent`, async () => {
  const f = await subscribeFill22(kind === 'fin');
  try {
    if (kind !== 'fin') f.fill.failWrites = true;
    const operation = kind === 'object'
      ? f.conn.sendFetchObject(f.stream, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') })
      : kind === 'range' ? f.conn.sendFetchEndOfRange(f.stream, false, 0n, 0n) : f.conn.closeFetchStream(f.stream);
    await expect(operation).rejects.toThrow(/simulated .* failure/);
    expect(f.resets).toEqual(['0501']);
    await expect(f.conn.sendFetchEndOfRange(f.stream, false, 0n, 0n)).rejects.toThrow(/Unknown fetch stream/);
    await expect(f.conn.openFillStream(1n)).rejects.toThrow(/No pending fill/);
    expect(f.conn.session.getIncomingSubscription(1n)?.state).toBe('established');
    const live = await f.conn.openSubgroup(42n, 2n, 0n);
    await f.conn.sendObject(live, 0n, bytes('bb')); await f.conn.closeSubgroup(live);
    expect(f.transport.closeInfo).toBeUndefined();
  } finally { await f.conn.close(); }
});

it('draft22 local encoder refusal preserves the fill writer and first Object bytes', async () => {
  const f = await subscribeFill22();
  try {
    await expect(f.conn.sendFetchObject(f.stream, { groupId: 0n, subgroupId: -1n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') })).rejects.toThrow();
    expect(f.resets).toEqual([]); expect(hex(f.fill.writtenBytes())).toBe('0501');
    await f.conn.sendFetchObject(f.stream, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') });
    expect(hex(f.fill.writtenBytes())).toBe('05011f0000000701aa');
    await f.conn.closeFetchStream(f.stream); expect(f.resets).toEqual([]);
  } finally { await f.conn.close(); }
});

it('concurrent fill write/FIN failures and cancellation share one held reset', async () => {
  const f = await subscribeFill22();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  (f.transport as WebTransportLike).resetSendStream = async writer => {
    f.resets.push(hex(f.fill.writtenBytes())); await gate; await writer.abort();
  };
  try {
    f.fill.failWrites = true;
    const writes = Promise.allSettled([
      f.conn.sendFetchEndOfRange(f.stream, false, 0n, 0n),
      f.conn.sendFetchObject(f.stream, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') }),
      f.conn.closeFetchStream(f.stream),
    ]);
    await flush(512);
    expect(f.resets).toEqual(['0501']);
    await expect(f.conn.publishDone(1n, varint(0n), 'done')).rejects.toThrow(/in-flight/);
    await expect(f.conn.sendFetchEndOfRange(f.stream, false, 0n, 0n)).rejects.toThrow(/Unknown fetch stream/);
    f.request.resetReadable(); await flush(512);
    expect(f.resets).toEqual(['0501']);
    release();
    expect((await writes).every(result => result.status === 'rejected')).toBe(true);
    expect(f.resets).toHaveLength(1); expect(f.transport.closeInfo).toBeUndefined();
  } finally { release(); await f.conn.close(); }
});

for (const kind of ['object', 'range'] as const) it(`ordinary draft22 FETCH ${kind} failure retains its caller-owned policy`, async () => {
  const conn = new MoqtConnection(22), transport = new TransportSim();
  let resets = 0;
  conn.onError = () => {};
  (transport as WebTransportLike).resetSendStream = async writer => { resets++; await writer.abort(); };
  try {
    transport.openIncomingUni().push(bytes('af000000')); await conn.connect(transport);
    const request = transport.pushIncomingBidi();
    request.push(createControlCodec(22).encode({ type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 1, trackNamespace: [], trackName: bytes('76'), startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } }, parameters: new Map() }));
    await flush(512);
    const stream = await conn.openFetchStream(1n), pipe = transport.uniOut.at(-1)!;
    pipe.failWrites = true;
    const operation = kind === 'object'
      ? conn.sendFetchObject(stream, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') })
      : conn.sendFetchEndOfRange(stream, false, 0n, 0n);
    await expect(operation).rejects.toThrow(/write failure/);
    expect(resets).toBe(0);
    await expect(conn.sendFetchEndOfRange(stream, false, 0n, 1n)).rejects.toThrow(/write failure/);
    expect(resets).toBe(0); expect(transport.closeInfo).toBeUndefined();
    const owner = conn.session.getIncomingFetch(1n)!;
    const closeError = await conn.closeFetchStream(stream).then(() => undefined, error => error);
    expect(closeError).toBeInstanceOf(TypeError);
    expect(pipe.writeClosed).toBe(false);
    expect(await conn.closeFetchStream(stream).catch(error => error)).toBe(closeError);
    expect(conn.session.getIncomingFetch(1n)).toBe(owner);
    // FIN rejection is observable; the caller cancels this exact request.
    request.resetReadable(); await flush(512);
    expect(conn.session.getIncomingFetch(1n)).toBeUndefined();
    await expect(conn.sendFetchEndOfRange(stream, false, 0n, 2n)).rejects.toThrow(/Unknown fetch stream/);
    await expect(conn.openFetchStream(1n)).rejects.toThrow(/No admitted/);
    expect(pipe.writeClosed).toBe(false);
    expect(resets).toBe(0); expect(transport.closeInfo).toBeUndefined();
    await healthyFetchFin();
  } finally { await conn.close(); }
});

async function healthyFetchFin() {
  const conn = new MoqtConnection(22), transport = new TransportSim();
  conn.onError = () => {};
  try {
    transport.openIncomingUni().push(bytes('af000000')); await conn.connect(transport);
    transport.pushIncomingBidi().push(createControlCodec(22).encode({ type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 1, trackNamespace: [], trackName: bytes('76'), startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } }, parameters: new Map() }));
    await flush(512);
    await conn.acceptFetch(1n, { endLocation: { group: 9n, object: 0n } });
    const stream = await conn.openFetchStream(1n), pipe = transport.uniOut.at(-1)!;
    await conn.sendFetchObject(stream, { groupId: 0n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: bytes('aa') });
    await expect(conn.closeFetchStream(stream)).resolves.toBeUndefined();
    expect(pipe.writeClosed).toBe(true);
    await expect(conn.sendFetchEndOfRange(stream, false, 0n, 1n)).rejects.toThrow(/Unknown fetch stream/);
    expect(conn.session.getIncomingFetch(1n)).toBeUndefined();
    expect(transport.closeInfo).toBeUndefined();
  } finally { await conn.close(); }
}
