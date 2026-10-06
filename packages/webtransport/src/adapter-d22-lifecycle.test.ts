import { afterEach, describe, expect, it } from 'vitest';
import { createControlCodec, varint, type ControlMessage } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';

const codec = createControlCodec(22);
const ns = [new TextEncoder().encode('live')];
const name = new TextEncoder().encode('video');
const largest = new Map([[9n, [{ group: 5n, object: 0n }]]]);
const connections: MoqtConnection[] = [];
async function settle() { for (let i = 0; i < 10; ++i) await flush(); }
afterEach(async () => { for (const conn of connections.splice(0)) await conn.close(); });

async function simulated() {
  const conn = new MoqtConnection(22);
  connections.push(conn);
  const sim = new TransportSim();
  sim.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
  await conn.connect(sim);
  return { conn, sim };
}

describe('draft-22 request half-close (6.4.2.2)', () => {
  it.each(['FETCH', 'SUBSCRIBE', 'PUBLISH', 'TRACK_STATUS', 'PUBLISH_NAMESPACE', 'SUBSCRIBE_NAMESPACE', 'SUBSCRIBE_TRACKS'] as const)(
    'does not register or deliver %s after cancellation during opener dispatch', async (type) => {
      const { conn, sim } = await simulated();
      const request = sim.pushIncomingBidi();
      let controller!: WritableStreamDefaultController;
      Object.defineProperty(request, 'writable', { value: new WritableStream<Uint8Array>({ start(c) { controller = c; } }) });
      let delivered = 0;
      const onRequest = () => { delivered++; };
      conn.onFetch = onRequest;
      conn.onSubscribe = onRequest;
      conn.onPublish = onRequest;
      conn.onTrackStatus = onRequest;
      conn.onPublishNamespace = onRequest;
      conn.onSubscribeNamespace = onRequest;
      conn.onSubscribeTracks = onRequest;
      conn.onMessage = (message) => {
        if (message.type !== type) return;
        controller.error(new Error('peer STOP_SENDING'));
        request.resetReadable('peer RESET_STREAM');
      };
      const common = { requestId: 1n, parameters: new Map() };
      const message: ControlMessage = type === 'FETCH'
        ? { type, ...common, fetch: { fetchType: 1, trackNamespace: ns, trackName: name,
          startLocation: { group: 0n, object: 0n }, endLocation: { group: 5n, object: 1n } } }
        : type === 'PUBLISH'
          ? { type, ...common, trackNamespace: ns, trackName: name, trackAlias: 50n,
            parameters: largest, trackProperties: new Map() }
          : type === 'SUBSCRIBE' || type === 'TRACK_STATUS'
            ? { type, ...common, trackNamespace: ns, trackName: name }
            : type === 'PUBLISH_NAMESPACE'
              ? { type, ...common, trackNamespace: ns }
              : { type, ...common, trackNamespacePrefix: ns };
      request.push(codec.encode(message));
      await settle();
      expect.soft(delivered).toBe(0);
      expect.soft(conn.session.getIncomingFetch(1n)).toBeUndefined();
      expect.soft(conn.session.getIncomingSubscription(1n)).toBeUndefined();
      expect.soft(conn.session.getIncomingTrackStatus(1n)).toBeUndefined();
      expect.soft(conn.session.getIncomingNamespaceSubscription(1n)).toBeUndefined();
      expect.soft(conn.session.getIncomingTrackSubscription(1n)).toBeUndefined();
      expect.soft((conn as unknown as { inboundRequestContexts: Map<bigint, unknown> }).inboundRequestContexts.has(1n)).toBe(false);
      if (type === 'FETCH') await expect(conn.openFetchStream(1n)).rejects.toThrow();
      expect(conn.session.state).toBe('established');
    },
  );

  it('delivers FETCH data arriving after the responder FIN', async () => {
    const { conn, sim } = await simulated();
    const payloads: number[][] = [];
    const errors: Error[] = [];
    conn.onError = (error) => errors.push(error);
    conn.onObject = (_id, object) => {
      if ('payload' in object) payloads.push([...object.payload]);
    };
    const id = await conn.fetch(ns, name, {
      startGroup: varint(0n), startObject: varint(0n),
      endGroup: varint(5n), endObject: varint(1n),
    });
    expect(id).toBe(0n);
    sim.bidi[0]!.push(codec.encode({ type: 'FETCH_OK', requestId: id,
      endOfTrack: 0, endLocation: { group: 1n, object: 0n }, parameters: new Map(), trackProperties: new Map() })).closeReadable();
    await settle();
    expect(conn.session.getFetch(id)).toBeDefined();
    // Literal FETCH_HEADER and one object, independent of the local encoder.
    sim.openIncomingUni().push(new Uint8Array([0x05, 0x00, 0x1c, 0x01, 0x00, 0x03, 0x01, 0xaa])).closeReadable();
    await settle();
    expect(payloads).toEqual([[0xaa]]);
    expect(conn.session.getFetch(id)).toBeUndefined();
    expect(conn.session.state).toBe('established');
    expect(errors).toEqual([]);
  });

  it.each(['SUBSCRIBE', 'FETCH'] as const)('resets %s data on STOP_SENDING after requester FIN', async (type) => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    let controller!: WritableStreamDefaultController;
    Object.defineProperty(request, 'writable', { value: new WritableStream<Uint8Array>({
      start(c) { controller = c; },
      write(bytes) { request.written.push(bytes.slice()); },
    }) });
    request.push(codec.encode(type === 'SUBSCRIBE'
      ? { type, requestId: 1n, trackNamespace: ns, trackName: name, parameters: new Map() }
      : { type, requestId: 1n, fetch: { fetchType: 1, trackNamespace: ns, trackName: name,
        startLocation: { group: 0n, object: 0n }, endLocation: { group: 5n, object: 1n } }, parameters: new Map() })).closeReadable();
    await settle();
    let stream: bigint;
    let cancellations = 0;
    conn.onSubscribeClosed = () => { cancellations++; };
    if (type === 'SUBSCRIBE') {
      await conn.acceptSubscribe(1n, 50n, { parameters: largest });
      stream = await conn.openSubgroup(50n, 6n, 0n);
    } else {
      await conn.acceptFetch(1n, { endOfTrack: 0, endLocation: { group: 5n, object: 0n } });
      stream = await conn.openFetchStream(1n);
    }
    controller.error(new Error('peer STOP_SENDING'));
    await settle();
    expect(sim.uniOut.at(-1)!.writeAborted).toBe(true);
    if (type === 'SUBSCRIBE') {
      expect(cancellations).toBe(1);
      await expect(conn.sendObject(stream, 0n, new Uint8Array([1]))).rejects.toThrow();
    } else {
      await expect(conn.sendFetchObject(stream, { groupId: 0n, subgroupId: 0n, objectId: 0n,
        publisherPriority: 0, payload: new Uint8Array([1]) })).rejects.toThrow();
    }
    expect(conn.session.state).toBe('established');
  });

  it('FINs a completed FETCH response without waiting for the requester', async () => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 1, trackNamespace: ns, trackName: name,
        startLocation: { group: 0n, object: 0n }, endLocation: { group: 5n, object: 1n } }, parameters: new Map() }));
    await settle();
    await conn.acceptFetch(1n, { endOfTrack: 0, endLocation: { group: 5n, object: 0n } });
    const stream = await conn.openFetchStream(1n);
    await conn.closeFetchStream(stream);
    expect(request.writeClosed).toBe(true);
    expect(request.readCancelled).toBe(false);
    request.closeReadable();
    await settle();
    expect((conn as unknown as { inboundRequestContexts: Map<bigint, unknown> }).inboundRequestContexts.has(1n)).toBe(false);
  });

  it.each(['type', 'length', 'body'] as const)('rejects a truncated control-message %s at FIN (9)', async (part) => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: ns, trackName: name, parameters: new Map() }));
    await settle();
    await conn.acceptSubscribe(1n, 50n, { parameters: largest });
    const update = codec.encode({ type: 'REQUEST_UPDATE', requestId: 3n, existingRequestId: 1n, parameters: new Map([[0x10n, [0n]]]) });
    const tail = part === 'type' ? new Uint8Array([0x40])
      : part === 'length' ? update.slice(0, 2) : update.slice(0, -1);
    request.push(tail).closeReadable();
    await settle();
    expect(conn.session.state).toBe('closed');
    expect(sim.closeInfo?.closeCode).toBe(3);
  });
  it('preserves an established SUBSCRIBE and its data stream on requester FIN', async () => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: ns, trackName: name, parameters: new Map() }));
    await settle();
    await conn.acceptSubscribe(1n, 50n, { parameters: largest });
    const stream = await conn.openSubgroup(50n, 6n, 0n);
    request.closeReadable();
    await settle();
    expect(conn.session.getIncomingSubscription(1n)?.state).toBe('established');
    expect(sim.uniOut.at(-1)!.writeAborted).toBe(false);
    expect(request.writeClosed).toBe(false);
    await conn.sendObject(stream, 0n, new Uint8Array([1]));
    await conn.closeSubgroup(stream);
    await conn.publishDone(1n, varint(2n), 'done');
    expect(request.writeClosed).toBe(true);
  });

  it.each(['accept', 'reject'] as const)('allows a pending SUBSCRIBE to %s after requester FIN', async (response) => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: ns, trackName: name, parameters: new Map() })).closeReadable();
    await settle();
    if (response === 'accept') {
      await conn.acceptSubscribe(1n, 50n, { parameters: largest });
      expect(request.writeClosed).toBe(false);
    } else {
      await conn.rejectSubscribe(1n, 16n, 'not found');
      expect(request.writeClosed).toBe(true);
    }
    expect(conn.session.state).toBe('established');
    expect(request.writtenBytes().length).toBeGreaterThan(0);
  });

  it('still cancels a SUBSCRIBE and resets its data on requester RESET', async () => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: ns, trackName: name, parameters: new Map() }));
    await settle();
    await conn.acceptSubscribe(1n, 50n, { parameters: largest });
    await conn.openSubgroup(50n, 6n, 0n);
    request.resetReadable();
    await settle();
    expect(conn.session.getIncomingSubscription(1n)).toBeUndefined();
    expect(sim.uniOut.at(-1)!.writeAborted).toBe(true);
    expect(conn.session.state).toBe('established');
  });

  it.each(['PUBLISH_NAMESPACE', 'SUBSCRIBE_NAMESPACE', 'SUBSCRIBE_TRACKS'] as const)('keeps %s answerable after requester FIN', async (type) => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    const message = type === 'PUBLISH_NAMESPACE'
      ? { type, requestId: 1n, trackNamespace: ns, parameters: new Map() }
      : { type, requestId: 1n, trackNamespacePrefix: ns, parameters: new Map() };
    request.push(codec.encode(message)).closeReadable();
    await settle();
    if (type === 'SUBSCRIBE_NAMESPACE') await conn.acceptSubscribeNamespace(1n);
    if (type === 'SUBSCRIBE_TRACKS') await conn.acceptSubscribeTracks(1n);
    expect(request.writeClosed).toBe(false);
    expect(request.writtenBytes().length).toBeGreaterThan(0);
    expect(conn.session.state).toBe('established');
  });

  // F=requester FIN, R=FETCH_OK, D=data FIN. The streams have no mutual ordering.
  it.each(['FRD', 'FDR', 'RFD', 'RDF', 'DFR', 'DRF'])('completes FETCH in %s order without retaining its request context', async (order) => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'FETCH', requestId: 1n,
      fetch: { fetchType: 1, trackNamespace: ns, trackName: name, startLocation: { group: 0n, object: 0n },
        endLocation: { group: 5n, object: 1n } }, parameters: new Map() }));
    await settle();
    const stream = await conn.openFetchStream(1n);
    for (const operation of order) {
      if (operation === 'F') request.closeReadable();
      if (operation === 'R') await conn.acceptFetch(1n, { endOfTrack: 0, endLocation: { group: 5n, object: 0n } });
      if (operation === 'D') await conn.closeFetchStream(stream);
      await settle();
    }
    expect(request.writeClosed).toBe(true);
    expect(conn.session.getIncomingFetch(1n)).toBeUndefined();
    expect((conn as unknown as { inboundRequestContexts: Map<bigint, unknown> }).inboundRequestContexts.has(1n)).toBe(false);
    expect(conn.session.state).toBe('established');
  });
});

describe('draft-22 fill cancellation (3.4.1)', () => {
  it('does not terminate the session when peer STOP_SENDING errors a fill writer', async () => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: ns, trackName: name,
      parameters: new Map([[0x23n, [new Uint8Array()]]]) }));
    await settle();
    await conn.acceptSubscribe(1n, 50n, { parameters: largest });
    let controller!: WritableStreamDefaultController;
    sim.createUnidirectionalStream = async () => new WritableStream<Uint8Array>({ start(c) { controller = c; } });
    const stream = await conn.openFillStream(1n);
    controller.error(Object.assign(new Error('peer cancelled fill'), { streamErrorCode: 0x10 }));
    await expect(conn.closeFetchStream(stream)).rejects.toThrow();
    expect(sim.closeInfo).toBeUndefined();
    expect(conn.session.getIncomingSubscription(1n)?.state).toBe('established');
    expect(conn.session.state).toBe('established');
    await conn.publishDone(1n, varint(2n), 'done');
  });

  it.each(['resolves', 'rejects', 'hangs'] as const)('requires a proven reset after failed fill FIN: abort %s', async (outcome) => {
    const { conn, sim } = await simulated();
    const request = sim.pushIncomingBidi();
    request.push(codec.encode({ type: 'SUBSCRIBE', requestId: 1n, trackNamespace: ns, trackName: name,
      parameters: new Map([[0x23n, [new Uint8Array()]]]) }));
    await settle();
    await conn.acceptSubscribe(1n, 50n, { parameters: largest });
    let aborted = false;
    sim.createUnidirectionalStream = async () => ({ getWriter: () => ({
      write: async () => {},
      close: async () => { throw new Error('FIN failed'); },
      abort: async () => {
        aborted = true;
        if (outcome === 'hangs') return new Promise<void>(() => {});
        if (outcome === 'rejects') throw new Error('reset failed');
      },
    }) }) as unknown as WritableStream<Uint8Array>;
    const stream = await conn.openFillStream(1n);
    await expect(conn.closeFetchStream(stream)).rejects.toThrow('FIN failed');
    expect(aborted).toBe(true);
    expect(conn.session.state).toBe(outcome === 'resolves' ? 'established' : 'closed');
  }, 3000);
});
