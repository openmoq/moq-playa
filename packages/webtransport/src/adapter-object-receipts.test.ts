import { describe, expect, it, vi } from 'vitest';
import { createControlCodec, encodeSubgroupHeader18, encodeSubgroupObject18, encodeObjectDatagram18, encodeObjectDatagram, varint } from '@openmoq/transport';
import type { MoqtObject, ObjectDatagram } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import type { ObjectReceiptObservation } from './object-receipts.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import { createLoopback } from './testkit/loopback.js';

const codec = createControlCodec(18);
const text = new TextEncoder();
const group = 9007199254740993n;

async function connected() {
  const connection = new MoqtConnection(18), transport = new TransportSim();
  transport.openIncomingUni().push(codec.encode({ type: 'SETUP', setupOptions: new Map() }));
  await connection.connect(transport);
  const requestId = await connection.subscribe([text.encode('live')], text.encode('video'));
  transport.bidi[0]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 77n, parameters: new Map(), trackExtensions: new Map() }));
  await flush(100);
  const send = async (end = false) => {
    const stream = transport.openIncomingUni();
    stream.push(encodeSubgroupHeader18({ typeByte: end ? 0x58 : 0x50, trackAlias: 77n, groupId: group, subgroupId: 0n,
      publisherPriority: 128, hasExtensions: false, isEndOfGroup: end, isFirstObjectInSubgroup: true }));
    stream.push(encodeSubgroupObject18({ objectId: 0n, payload: Uint8Array.of(11, 22, 33), extensions: undefined, status: undefined }, false, 0n, true));
    stream.closeReadable();
    await flush(100);
  };
  return { connection, transport, send, requestId };
}

describe('object receipt provenance', () => {
  it.each([18, 22] as const)('drops a generic subscription\'s late datagram after peer request reset in draft %i', async draft => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' }), app = vi.fn();
    server.onSubscribe = id => { void server.acceptSubscribe(id, 77n); };
    client.onDatagram = app;
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      const requestId = await client.subscribe([text.encode('live')], text.encode('video'));
      await flush(100);
      const bytes = encodeObjectDatagram18({ typeByte: 0x00, trackAlias: 77n, groupId: group, objectId: 0n,
        publisherPriority: 128, payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false });
      const writer = b.datagrams.writable!.getWriter();
      try {
        await writer.write(bytes); await flush(100); expect(app).toHaveBeenCalledOnce();
        a.bidiOut[0]!.in.reset(0);
        await flush(100);
        expect(client.session.getSubscription(requestId)).toBeUndefined();
        await writer.write(bytes); await flush(100);
        expect(app).toHaveBeenCalledOnce(); expect(client.session.state).toBe('established');
      } finally { writer.releaseLock(); }
    } finally { await client.close(); await server.close(); }
  });

  it.each([14, 16, 18, 22] as const)('drops a generic subscription\'s late datagram without any receipt observer in draft %i', async draft => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' }), app = vi.fn();
    server.onSubscribe = id => { void server.acceptSubscribe(id, 77n); };
    client.onDatagram = app;
    try {
      const options = draft === 14 || draft === 16 ? { maxRequestId: varint(100n) } : undefined;
      await Promise.all([client.connect(a, options), server.connect(b, options)]);
      const requestId = await client.subscribe([text.encode('live')], text.encode('video'));
      await flush(100);
      const bytes = (draft === 14 || draft === 16 ? encodeObjectDatagram : encodeObjectDatagram18)({
        typeByte: 0x00, trackAlias: 77n, groupId: group, objectId: 0n, publisherPriority: 128,
        payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false,
      });
      const writer = b.datagrams.writable!.getWriter();
      try {
        await writer.write(bytes); await flush(100); expect(app).toHaveBeenCalledOnce();
        await client.unsubscribe(requestId);
        // Raw transport write models a datagram already in flight when we unsubscribed.
        await writer.write(bytes); await flush(100);
        expect(app).toHaveBeenCalledOnce(); expect(client.session.state).toBe('established');
      } finally { writer.releaseLock(); }
    } finally { await client.close(); await server.close(); }
  });

  it.each([14, 16, 18, 22] as const)('preserves callback identity and FIN provenance in draft %i', async draft => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
    const observed: ObjectReceiptObservation[] = [], tokens: unknown[] = [];
    const remove = client.observeObjectReceipts(event => { observed.push(event); });
    server.onSubscribe = id => { void server.acceptSubscribe(id, 77n); };
    try {
      const options = draft === 14 || draft === 16 ? { maxRequestId: varint(100n) } : undefined;
      await Promise.all([client.connect(a, options), server.connect(b, options)]);
      await client.subscribeTrack([text.encode('live')], text.encode('video'), {
        onObject: object => { tokens.push(client.objectReceiptFor(object)); },
      });
      const stream = await server.openSubgroup(77n, group, 0n, { publisherPriority: 128, endOfGroup: true });
      await server.sendObject(stream, 0n, Uint8Array.of(1));
      await server.closeSubgroup(stream); await flush(100);
      expect(observed).toHaveLength(2);
      expect(observed.map(event => [event.origin, event.objectId, event.payloadBytes])).toEqual([
        ['subgroup', 0n, 1], ['group-end', 1n, 0],
      ]);
      expect(tokens).toEqual(observed.map(event => event.receipt));
    } finally { remove(); await client.close(); await server.close(); }
  });

  it('ties copied metadata to the exact delivered object without exposing its payload', async () => {
    const h = await connected(), observed: ObjectReceiptObservation[] = [];
    expect(h.connection.observeObjectReceipts).toBeTypeOf('function');
    const remove = h.connection.observeObjectReceipts(event => { observed.push(event); });
    const app = vi.fn((object: MoqtObject) => h.connection.objectReceiptFor(object));
    h.connection.onObject = (_stream, object) => { app(object); };
    try {
      await h.send();
      expect(observed).toHaveLength(1); expect(app).toHaveBeenCalledOnce();
      expect(observed[0]).toMatchObject({ origin: 'subgroup', trackAlias: 77n, groupId: group, subgroupId: 0n,
        objectId: 0n, objectStatus: 0n, payloadBytes: 3 });
      expect(app.mock.results[0]!.value).toBe(observed[0]!.receipt);
      expect(Object.isFrozen(observed[0]!.receipt)).toBe(true);
      expect(Object.keys(observed[0]!.receipt)).toEqual([]);
      expect(observed[0]).not.toHaveProperty('payload'); expect(observed[0]).not.toHaveProperty('extensions');
      expect(observed[0]).not.toHaveProperty('object');
    } finally { remove(); await h.connection.close(); }
  });

  it('does not join separate receipts merely because their wire locations match', async () => {
    const h = await connected(), observed: ObjectReceiptObservation[] = [];
    expect(h.connection.observeObjectReceipts).toBeTypeOf('function');
    const remove = h.connection.observeObjectReceipts(event => { observed.push(event); });
    try {
      await h.send(); await h.send();
      expect(observed).toHaveLength(2);
      expect(observed[0]!.receipt).not.toBe(observed[1]!.receipt);
      expect(observed[0]!.objectId).toBe(observed[1]!.objectId);
      expect(observed[0]!.groupId).toBe(observed[1]!.groupId);
    } finally { remove(); await h.connection.close(); }
  });

  it('keeps the same receipt when early data is buffered and replayed after acceptance', async () => {
    const h = await connected(), observed: ObjectReceiptObservation[] = [], replayed: unknown[] = [];
    const remove = h.connection.observeObjectReceipts(event => { observed.push(event); });
    const pending = h.connection.subscribeTrack([text.encode('live')], text.encode('early'), {
      onObject: object => { replayed.push(h.connection.objectReceiptFor(object)); },
    });
    void pending.catch(() => {});
    try {
      await flush(100);
      const stream = h.transport.openIncomingUni();
      stream.push(encodeSubgroupHeader18({ typeByte: 0x50, trackAlias: 88n, groupId: group, subgroupId: 0n,
        publisherPriority: 128, hasExtensions: false, isEndOfGroup: false, isFirstObjectInSubgroup: true }));
      stream.push(encodeSubgroupObject18({ objectId: 0n, payload: Uint8Array.of(1), extensions: undefined, status: undefined }, false, 0n, true));
      await flush(100);
      expect(observed).toHaveLength(1); expect(replayed).toEqual([]);
      h.transport.bidi[1]!.push(codec.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 88n, parameters: new Map(), trackExtensions: new Map() }));
      await pending;
      await vi.waitFor(() => { expect(replayed).toEqual([observed[0]!.receipt]); });
      expect(observed).toHaveLength(1);
    } finally { remove(); await h.connection.close(); await pending.catch(() => {}); }
  });

  it('creates no association while unobserved and releases it after the last unsubscribe', async () => {
    const h = await connected(), seen: (object | undefined)[] = [];
    expect(h.connection.objectReceiptFor).toBeTypeOf('function');
    let last: MoqtObject | undefined;
    h.connection.onObject = (_stream, object) => { last = object; seen.push(h.connection.objectReceiptFor(object)); };
    try {
      await h.send(); expect(seen).toEqual([undefined]);
      const remove = h.connection.observeObjectReceipts(() => {});
      await h.send(); expect(seen[1]).toBeDefined();
      remove(); remove();
      expect(h.connection.objectReceiptFor(last!)).toBeUndefined();
      await h.send(); expect(seen[2]).toBeUndefined();
    } finally { await h.connection.close(); }
  });

  it('isolates listener mutations and failures, including reentrant unsubscribe', async () => {
    const h = await connected(), peer = vi.fn(), removed = vi.fn(), app = vi.fn();
    expect(h.connection.observeObjectReceipts).toBeTypeOf('function');
    let removePeer = () => {};
    const removers = [h.connection.observeObjectReceipts(event => {
      (event as { groupId: bigint }).groupId = 1n; removePeer(); throw new Error('observer failure');
    }), h.connection.observeObjectReceipts(async () => { throw new Error('async observer failure'); }),
    h.connection.observeObjectReceipts(peer)];
    removePeer = h.connection.observeObjectReceipts(removed); removers.push(removePeer);
    h.connection.onObject = (_stream, object) => { app(object); };
    try {
      await h.send();
      expect(removed).not.toHaveBeenCalled(); expect(peer).toHaveBeenCalledOnce(); expect(app).toHaveBeenCalledOnce();
      expect(peer.mock.calls[0]![0].groupId).toBe(group);
      expect(app.mock.calls[0]![0].groupId).toBe(group);
      expect(h.transport.closeInfo).toBeUndefined();
    } finally { removers.forEach(remove => remove()); await h.connection.close(); }
  });

  it('distinguishes a FIN-derived group bound from an object parsed on the stream', async () => {
    const h = await connected(), observed: ObjectReceiptObservation[] = [], tokens: unknown[] = [];
    expect(h.connection.observeObjectReceipts).toBeTypeOf('function');
    const remove = h.connection.observeObjectReceipts(event => { observed.push(event); });
    h.connection.onObject = (_stream, object) => { tokens.push(h.connection.objectReceiptFor(object)); };
    try {
      await h.send(true);
      expect(observed).toHaveLength(2);
      expect(observed[0]).toMatchObject({ origin: 'subgroup', objectId: 0n, objectStatus: 0n, payloadBytes: 3 });
      expect(observed[1]).toMatchObject({ origin: 'group-end', objectId: 1n, objectStatus: 3n, payloadBytes: 0 });
      expect(tokens).toEqual(observed.map(event => event.receipt));
    } finally { remove(); await h.connection.close(); }
  });

  it('does not deliver stream data or a peer FIN after a receipt observer closes the session', async () => {
    const h = await connected(), app = vi.fn(), fin = vi.fn(), observed = vi.fn();
    const remove = h.connection.observeObjectReceipts(() => { observed(); void h.connection.close(); });
    h.connection.onObject = app; h.connection.onSubgroupFin = fin;
    try {
      await h.send(true);
      expect(observed).toHaveBeenCalledOnce();
      expect(app).not.toHaveBeenCalled(); expect(fin).not.toHaveBeenCalled();
    } finally { remove(); await h.connection.close(); }
  });

  it('associates datagrams with the actual callback object and respects reentrant close', async () => {
    const h = await connected(), observed: ObjectReceiptObservation[] = [], tokens: unknown[] = [];
    expect(h.connection.observeObjectReceipts).toBeTypeOf('function');
    const remove = h.connection.observeObjectReceipts(event => { observed.push(event); });
    h.connection.onDatagram = (datagram: ObjectDatagram) => { tokens.push(h.connection.objectReceiptFor(datagram)); };
    const bytes = encodeObjectDatagram18({ typeByte: 0x00, trackAlias: 77n, groupId: group, objectId: 0n,
      publisherPriority: 128, payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false });
    try {
      h.transport.pushDatagram(bytes); await flush(100);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ origin: 'datagram', groupId: group, subgroupId: null, payloadBytes: 1 });
      expect(tokens).toEqual([observed[0]!.receipt]);
      const close = h.connection.observeObjectReceipts(() => { void h.connection.close(); });
      h.transport.pushDatagram(bytes); await flush(100); close();
      expect(tokens).toHaveLength(1);
    } finally { remove(); await h.connection.close(); }
  });

  it('honors an unsubscribe initiated by a datagram receipt observer before the app callback', async () => {
    const h = await connected(), app = vi.fn();
    const remove = h.connection.observeObjectReceipts(() => h.connection.unsubscribe(h.requestId));
    h.connection.onDatagram = app;
    try {
      h.transport.pushDatagram(encodeObjectDatagram18({ typeByte: 0x00, trackAlias: 77n, groupId: group, objectId: 0n,
        publisherPriority: 128, payload: Uint8Array.of(4), extensions: undefined, status: undefined, isEndOfGroup: false }));
      await flush(100);
      expect(app).not.toHaveBeenCalled();
      expect(h.connection.session.getSubscription(h.requestId)).toBeUndefined();
    } finally { remove(); await h.connection.close(); }
  });
});

it('isolates discard listeners and releases receipt state only after both observer channels detach', async () => {
  const h = await connected();
  const received: ObjectReceiptObservation[] = [], discards: unknown[] = [];
  const off = h.connection.observeObjectReceipts(event => { received.push(event); });
  const first = h.connection.observeObjectDiscards(event => { Reflect.set(event, 'reason', 'changed'); throw new Error('observer failed'); });
  const second = h.connection.observeObjectDiscards(async () => { throw new Error('async observer failed'); });
  const last = h.connection.observeObjectDiscards(event => { discards.push(event); });
  let actual: MoqtObject | undefined;
  h.connection.onObject = (_stream, object) => { actual = object; };
  try {
    await h.send(); expect(actual).toBeDefined();
    const token = h.connection.objectReceiptFor(actual!); expect(token).toBe(received[0]!.receipt);
    off(); // A discard observer still needs the recorded token.
    expect(h.connection.objectReceiptFor(actual!)).toBe(token);
    const observers = (h.connection as unknown as { objectReceiptObservers: { discard(object: object, reason: 'late'): void } }).objectReceiptObservers;
    observers.discard(actual!, 'late'); observers.discard(actual!, 'late');
    await flush(100);
    expect(discards).toEqual([{ receipt: token, reason: 'late' }]);
    first(); second(); last();
    expect(h.connection.objectReceiptFor(actual!)).toBeUndefined();
  } finally { off(); first(); second(); last(); await h.connection.close(); }
});

it('reports a received object discarded by reentrant local close on the same token', async () => {
  const h = await connected(), received: unknown[] = [], discarded: unknown[] = [];
  const off = h.connection.observeObjectReceipts(event => { received.push(event.receipt); void h.connection.close(); });
  const offDiscard = h.connection.observeObjectDiscards(event => { discarded.push(event); });
  const app = vi.fn(); h.connection.onObject = app;
  try {
    await h.send();
    expect(received).toHaveLength(1); expect(app).not.toHaveBeenCalled();
    expect(discarded).toEqual([{ receipt: received[0], reason: 'late' }]);
  } finally { off(); offDiscard(); await h.connection.close(); }
});
