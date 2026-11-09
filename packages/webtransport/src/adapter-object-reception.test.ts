/**
 * Early object reception: header before payload completion, cumulative payload
 * progress, one receive terminal per observed attempt, honest read-observation
 * times, and correlation to existing receipts. Real parsers and the stream
 * simulator; the observation clock is `performance.now`, controlled here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeObjectDatagram, encodeObjectDatagram18 } from '@openmoq/transport';
import type { MoqtObject, ObjectDatagram } from '@openmoq/transport';
import type { ObjectReceiptObservation } from './object-receipts.js';
import type { ObjectReceptionEvent, ObjectReception, ObjectReceptionHeader } from './object-reception.js';
import { flush } from './testkit/stream-sim.js';
import { ObjectReceptionObservers } from './object-reception.js';
import { MoqtConnection } from './adapter.js';
import {
  ALIAS, GROUP, SUBGROUP, PRIORITY, clock, connect, concat, drafts, legacy, object, observe, payloadOf, read, streamHeader, summary,
} from './testkit/object-reception.js';

beforeEach(() => { clock.now = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock.now); });
afterEach(() => { vi.restoreAllMocks(); });

/** The connection's lazily constructed reception component, if any (white-box). */
const componentOf = (connection: MoqtConnection): unknown => (connection as unknown as { objectReception?: unknown }).objectReception;

/** Record every call into the reception component's per-read and per-object work. */
function receptionWork() {
  const names = ['streamRead', 'objectsBegin', 'objectRead', 'pending', 'complete', 'skip', 'interrupt', 'datagramRead', 'datagram', 'closeAll'] as const;
  const seen: string[] = [];
  const spies = names.map(name => vi.spyOn(ObjectReceptionObservers.prototype, name).mockImplementation(function (this: unknown) { seen.push(name); } as never));
  return { calls: () => seen.slice(), restore: () => { for (const spy of spies) spy.mockRestore(); } };
}

describe.each(drafts)('early object reception on subgroup streams, draft %i', draft => {
  it('announces a fragmented header before the payload completes, then cumulative progress and one complete terminal', async () => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [], receipts: ObjectReceiptObservation[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const removeReceipts = connection.observeObjectReceipts(r => { receipts.push(r); });
    const { events } = observe(connection);
    try {
      const payload = payloadOf(5000);
      const wire = object(draft, 0n, payload, null);
      const headerBytes = wire.length - payload.length;
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), wire.subarray(0, 1)));           // stream header + first object byte
      expect(summary(events), 'an incomplete object header announces nothing').toEqual([]);
      await read(s, 20, wire.subarray(1, headerBytes + 1000));                          // rest of the header + 1000 payload bytes
      await read(s, 30, wire.subarray(headerBytes + 1000, headerBytes + 4000));
      expect(delivered, 'the object is still incomplete').toEqual([]);
      await read(s, 40, wire.subarray(headerBytes + 4000));
      clock.now = 50; s.closeReadable(); await flush(100);

      expect(summary(events)).toEqual([
        ['header', 0n, 10, 20, 5000n, null],
        ['progress', 1000n, 20],
        ['progress', 4000n, 30],
        ['end', 0n, 'complete', null, 5000n, 20, 40, 40],
      ]);
      expect(events.at(-1), 'no Object Status on a non-empty stream Object').toMatchObject({ type: 'end', objectStatus: null });
      const header = events[0] as ObjectReceptionHeader;
      expect(header.type).toBe('header');
      expect(header).toMatchObject({ origin: 'subgroup', trackAlias: ALIAS, requestId: null, groupId: GROUP, subgroupId: SUBGROUP,
        publisherPriority: PRIORITY, propertiesLength: 0, properties: null, propertiesOmitted: 'not-requested' });
      expect(typeof header.streamId).toBe('bigint');
      // Application delivery and receipts are unchanged; correlation is additive.
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ kind: 'data', objectId: 0n, payload });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.reception).toBe(header.reception);
      expect(connection.objectReceptionFor(delivered[0]!)).toBe(header.reception);
    } finally { removeReceipts(); await connection.close(); }
  });

  it('shares one read time among bytes delivered together: A complete + B partial, then B complete + C', async () => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    try {
      const a = object(draft, 0n, payloadOf(10, 1), null);
      const b = object(draft, 1n, payloadOf(10, 2), 0n);
      const c = object(draft, 2n, payloadOf(10, 3), 1n);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), a, b.subarray(0, 1)));
      await read(s, 20, concat(b.subarray(1), c));
      clock.now = 30; s.closeReadable(); await flush(100);
      expect(summary(events)).toEqual([
        ['header', 0n, 10, 10, 10n, null], ['end', 0n, 'complete', null, 10n, 10, 10, 10],
        ['header', 1n, 10, 20, 10n, null], ['end', 1n, 'complete', null, 10n, 20, 20, 20],
        ['header', 2n, 20, 20, 10n, null], ['end', 2n, 'complete', null, 10n, 20, 20, 20],
      ]);
      const tokens = events.filter(e => e.type === 'header').map(e => e.reception);
      expect(new Set(tokens).size, 'one physical arrival, one token').toBe(3);
    } finally { await connection.close(); }
  });

  it('keeps header time and first-payload time apart when the header arrives alone', async () => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    try {
      const payload = payloadOf(10);
      const wire = object(draft, 0n, payload, null);
      const headerBytes = wire.length - payload.length;
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), wire.subarray(0, headerBytes)));
      await read(s, 20, wire.subarray(headerBytes, headerBytes + 4));
      await read(s, 30, wire.subarray(headerBytes + 4));
      expect(summary(events)).toEqual([
        ['header', 0n, 10, 10, 10n, null],
        ['progress', 4n, 20],
        ['end', 0n, 'complete', null, 10n, 20, 30, 30],
      ]);
    } finally { await connection.close(); }
  });

  it('completes zero-length objects at their header with their Object Status and no payload times or progress', async () => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    try {
      const s = transport.openIncomingUni();
      // A zero-byte Normal object is data; an END_OF_GROUP status is a status Object. Both are wire Objects.
      await read(s, 10, concat(streamHeader(draft), object(draft, 0n, new Uint8Array(0), null, { status: 0n }),
        object(draft, 1n, new Uint8Array(0), 0n, { status: 3n })));
      clock.now = 20; s.closeReadable(); await flush(100);
      expect(summary(events)).toEqual([
        ['header', 0n, 10, 10, 0n, 0n], ['end', 0n, 'complete', null, 0n, null, null, 10],
        ['header', 1n, 10, 10, 0n, 3n], ['end', 1n, 'complete', null, 0n, null, null, 10],
      ]);
      expect(events.filter(e => e.type === 'end').map(e => e.objectStatus), 'stream ends carry the Object Status').toEqual([0n, 3n]);
    } finally { await connection.close(); }
  });

  it('ends a payload cut off by FIN as a protocol-violation interruption, before the session closes', async () => {
    const { connection, transport } = await connect(draft);
    const log: string[] = [];
    connection.onClose = () => { log.push('close'); };
    const events: ObjectReceptionEvent[] = [];
    connection.observeObjectReception(e => { events.push(e); log.push(e.type); });
    const payload = payloadOf(10);
    const wire = object(draft, 0n, payload, null);
    const s = transport.openIncomingUni();
    await read(s, 10, concat(streamHeader(draft), wire.subarray(0, wire.length - 7)));
    clock.now = 20; s.closeReadable(); await flush(200);
    expect(summary(events)).toEqual([
      ['header', 0n, 10, 10, 10n, null],
      ['progress', 3n, 10],
      ['end', 0n, 'interrupted', 'protocol-violation', 3n, 10, 10, 20],
    ]);
    expect(log.indexOf('end')).toBeLessThan(log.indexOf('close'));
    expect(connection.session.state).toBe('closed');
  });

  it('ends a payload cut off by a peer reset as a reset interruption with its code, before the stream-close callback', async () => {
    const { connection, transport } = await connect(draft);
    const log: unknown[] = [];
    const events: ObjectReceptionEvent[] = [];
    connection.observeObjectReception(e => { events.push(e); log.push(e.type); });
    connection.onStreamClosed = (_id, code, terminal) => { log.push(['closed', code, terminal]); };
    try {
      const wire = object(draft, 0n, payloadOf(10), null);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), wire.subarray(0, wire.length - 6)));
      clock.now = 20; s.resetReadableWithCode(7); await flush(100);
      const end = events.at(-1)!;
      expect(end).toMatchObject({ type: 'end', outcome: 'interrupted', reason: 'reset', resetCode: 7, payloadReceived: 4n, observedAt: 20 });
      expect(log.slice(-2)).toEqual(['end', ['closed', 7, 'reset']]);
    } finally { await connection.close(); }
  });

  it('ends an in-flight attempt as connection-closed when the connection closes', async () => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    const wire = object(draft, 0n, payloadOf(10), null);
    const s = transport.openIncomingUni();
    await read(s, 10, concat(streamHeader(draft), wire.subarray(0, wire.length - 5)));
    clock.now = 20; await connection.close(); await flush(100);
    const ends = events.filter(e => e.type === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: 'interrupted', reason: 'connection-closed', payloadReceived: 5n, observedAt: 20 });
  });

  it('observes only objects whose first bytes arrive after attachment', async () => {
    const { connection, transport } = await connect(draft);
    try {
      const a = object(draft, 0n, payloadOf(10, 1), null);
      const b = object(draft, 1n, payloadOf(10, 2), 0n);
      const c = object(draft, 2n, payloadOf(10, 3), 1n);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), a, b.subarray(0, 1)));
      clock.now = 15;
      const { events } = observe(connection);
      await read(s, 20, concat(b.subarray(1), c));
      expect(summary(events), 'B began before attachment; C began after').toEqual([
        ['header', 2n, 20, 20, 10n, null], ['end', 2n, 'complete', null, 10n, 20, 20, 20],
      ]);
    } finally { await connection.close(); }
  });

  it('correlates receipts to reception only when reception was observed', async () => {
    const { connection, transport } = await connect(draft);
    const receipts: ObjectReceiptObservation[] = [];
    const removeReceipts = connection.observeObjectReceipts(r => { receipts.push(r); });
    try {
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), object(draft, 0n, payloadOf(3), null)));
      const { events, detach } = observe(connection);
      await read(s, 20, object(draft, 1n, payloadOf(3), 0n));
      detach();
      const headers = events.filter((e): e is ObjectReceptionHeader => e.type === 'header');
      expect(headers.map(e => e.objectId), 'only the Object that began after attachment was observed').toEqual([1n]);
      expect(receipts.map(r => r.objectId)).toEqual([0n, 1n]);
      expect(receipts.map(r => r.reception)).toEqual([null, headers[0]!.reception]);
    } finally { removeReceipts(); await connection.close(); }
  });

  it('samples no observation clock while nobody observes reception', async () => {
    const { connection, transport } = await connect(draft);
    const clockSpy = vi.mocked(performance.now);
    clockSpy.mockClear();
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    try {
      const wire = object(draft, 0n, payloadOf(4000), null);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), wire.subarray(0, 30)));
      await read(s, 20, wire.subarray(30));
      expect(delivered).toHaveLength(1);
      expect(clockSpy).not.toHaveBeenCalled();
      // A detached observer leaves the same state behind as none at all.
      observe(connection).detach();
      clockSpy.mockClear();
      await read(s, 30, object(draft, 1n, payloadOf(5), 0n));
      expect(delivered).toHaveLength(2);
      expect(clockSpy).not.toHaveBeenCalled();
    } finally { await connection.close(); }
  });

  it('constructs no reception component and runs none of its work while nobody observes; a detached one is released', async () => {
    const { connection, transport } = await connect(draft);
    const work = receptionWork();
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    try {
      const wire = object(draft, 0n, payloadOf(4000), null);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), wire.subarray(0, 30)));
      await read(s, 20, wire.subarray(30));
      expect(delivered).toHaveLength(1);
      expect(componentOf(connection), 'nothing allocated before any observer').toBeUndefined();
      expect(work.calls(), 'no component method ran').toEqual([]);
      observe(connection).detach();
      expect(componentOf(connection), 'the last detach releases the component').toBeUndefined();
      await read(s, 30, object(draft, 1n, payloadOf(5), 0n));
      expect(delivered).toHaveLength(2);
      expect(work.calls()).toEqual([]);
    } finally { work.restore(); await connection.close(); }
  });

  it('the final listener leaving mid-object stops all observation work at once; receipts keep their promised provenance', async () => {
    const { connection, transport } = await connect(draft);
    const receipts: ObjectReceiptObservation[] = [];
    const removeReceipts = connection.observeObjectReceipts(r => { receipts.push(r); });
    const { events, detach } = observe(connection);
    try {
      const a = object(draft, 0n, payloadOf(40), null);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), a.subarray(0, a.length - 20)));
      expect(summary(events)).toEqual([['header', 0n, 10, 10, 40n, null], ['progress', 20n, 10]]);
      detach();
      expect(componentOf(connection)).toBeUndefined();
      const work = receptionWork();
      const clockSpy = vi.mocked(performance.now);
      clockSpy.mockClear();
      try {
        await read(s, 20, a.subarray(a.length - 20, a.length - 10));
        await read(s, 30, concat(a.subarray(a.length - 10), object(draft, 1n, payloadOf(3), 0n)));
        clock.now = 40; s.closeReadable(); await flush(100);
        expect(work.calls(), 'no reception work after the final detach').toEqual([]);
        expect(clockSpy, 'no observation clock after the final detach').not.toHaveBeenCalled();
      } finally { work.restore(); }
      expect(events, 'a detached listener expects no terminal').toHaveLength(2);
      expect(receipts.map(r => [r.objectId, r.reception])).toEqual([[0n, null], [1n, null]]);
    } finally { removeReceipts(); await connection.close(); }
  });
});

describe.each([18, 22] as const)('classifier read provenance, draft %i', draft => {
  it('times the first object byte by the classifier read that carried it when the stream type spans reads', async () => {
    const { connection, transport } = await connect(draft);
    try {
      const header = streamHeader(draft);
      expect(header[0], 'a one-byte minimal type').toBe(0x54);
      // Non-minimal two-byte vi64 for the same type (valid on read, draft-18 §1.4.1).
      const splitType = Uint8Array.of(0x80, 0x54);
      const s = transport.openIncomingUni();
      await read(s, 10, splitType.subarray(0, 1));
      clock.now = 15;
      const { events } = observe(connection);
      await read(s, 20, concat(splitType.subarray(1), header.subarray(1), object(draft, 0n, payloadOf(6), null)));
      expect(summary(events)).toEqual([
        ['header', 0n, 20, 20, 6n, null], ['end', 0n, 'complete', null, 6n, 20, 20, 20],
      ]);
    } finally { await connection.close(); }
  });
});

describe.each(drafts)('datagram reception, draft %i', draft => {
  const datagram = (status?: bigint, payload = Uint8Array.of(1, 2, 3)): Uint8Array => {
    const value: ObjectDatagram = { typeByte: status === undefined ? 0x00 : 0x20, trackAlias: ALIAS, groupId: GROUP, objectId: 4n,
      publisherPriority: PRIORITY, payload: status === undefined ? payload : new Uint8Array(0), extensions: undefined, status,
      isEndOfGroup: false };
    return legacy(draft) ? encodeObjectDatagram(value) : encodeObjectDatagram18(value);
  };

  it('reports a whole datagram as one complete end with its metadata and the datagram read time', async () => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    try {
      clock.now = 10; transport.pushDatagram(datagram()); await flush(100);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'end', origin: 'datagram', streamId: null, trackAlias: ALIAS, requestId: null,
        groupId: GROUP, subgroupId: null, objectId: 4n, outcome: 'complete', reason: null, payloadLength: 3n, payloadReceived: 3n,
        objectStatus: null, firstPayloadByteObservedAt: 10, lastPayloadByteObservedAt: 10, observedAt: 10, propertiesLength: 0 });
    } finally { await connection.close(); }
  });

  it('reports a status datagram with its Object Status and no payload times', async () => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    try {
      clock.now = 10; transport.pushDatagram(datagram(3n)); await flush(100);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'end', origin: 'datagram', objectStatus: 3n, payloadLength: 0n,
        firstPayloadByteObservedAt: null, lastPayloadByteObservedAt: null, observedAt: 10 });
    } finally { await connection.close(); }
  });
});

describe('reception identity across listeners', () => {
  it('shares one physical token between listeners eligible for the same arrival', async () => {
    const { connection, transport } = await connect(18);
    try {
      const first = observe(connection), second = observe(connection);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), object(18, 0n, payloadOf(4), null)));
      expect(first.events.filter(e => e.type === 'header')).toHaveLength(1);
      expect(second.events.filter(e => e.type === 'header')).toHaveLength(1);
      const t1 = first.events.find(e => e.type === 'header')!.reception as ObjectReception;
      const t2 = second.events.find(e => e.type === 'header')!.reception as ObjectReception;
      expect(t1).toBe(t2);
      expect(first.events[0]).not.toBe(second.events[0]);
    } finally { await connection.close(); }
  });
});
