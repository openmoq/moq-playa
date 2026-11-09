/**
 * Object reception boundaries: FETCH and FILL carriers, range indicators,
 * local replay, property copies, faults, listener misbehaviour, local discard,
 * FIRST_OBJECT Subgroup IDs, exact integers, connection isolation, data held
 * before SETUP, and ordering against the parsed-object qlog events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createControlCodec,
  encodeFetchHeader,
  encodeFetchHeader18,
  encodeFetchObject18,
  encodeFetchEndOfRange18,
  encodePropertyBlock,
  writeVarint,
  writeVi64,
  vi64EncodingLength,
  varint,
} from '@openmoq/transport';
import type { FetchObjectPrior18, MoqtObject, QlogEvent } from '@openmoq/transport';
import type { ObjectReceiptObservation } from './object-receipts.js';
import type { ObjectReceptionEvent, ObjectReceptionHeader, ObjectReceptionEnd } from './object-reception.js';
import { OBSERVED_PROPERTIES_LIMIT } from './object-reception.js';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import {
  ALIAS, clock, connect, concat, drafts, legacy, object, observe, payloadOf, read, streamHeader, summary,
  expectExactlyOneTerminalPerAttempt, type Draft,
} from './testkit/object-reception.js';

beforeEach(() => { clock.now = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock.now); });
afterEach(() => { vi.restoreAllMocks(); });

const text = new TextEncoder();
const timerTurn = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

function subscribeOk(draft: Draft, requestId: bigint, trackAlias: bigint): Uint8Array {
  const codec = createControlCodec(draft);
  if (legacy(draft)) return codec.encode({ type: 'SUBSCRIBE_OK', requestId: varint(requestId), trackAlias: varint(trackAlias), parameters: new Map(), trackExtensions: [] } as never);
  return codec.encode({ type: 'SUBSCRIBE_OK', requestId, trackAlias, parameters: new Map(), trackExtensions: new Map(), trackProperties: new Map() } as never);
}

// ── FETCH wire builders for every draft ─────────────────────────────────

interface FetchObjectSpec { readonly kind: 'object'; readonly group: bigint; readonly subgroup: bigint; readonly object: bigint; readonly payload: Uint8Array }
interface FetchRangeSpec { readonly kind: 'range'; readonly group: bigint; readonly object: bigint; readonly marker: 'non-existent' | 'timed-out' }
interface FetchStatusSpec { readonly kind: 'status14'; readonly group: bigint; readonly subgroup: bigint; readonly object: bigint; readonly status: bigint }
type FetchItemSpec = FetchObjectSpec | FetchRangeSpec | FetchStatusSpec;

function varints(...values: bigint[]): Uint8Array {
  const out = new Uint8Array(values.length * 8);
  let p = 0; for (const v of values) p += writeVarint(v, out, p);
  return out.slice(0, p);
}
function vi64s(...values: bigint[]): Uint8Array {
  const out = new Uint8Array(values.reduce((n, v) => n + vi64EncodingLength(v), 0));
  let p = 0; for (const v of values) p += writeVi64(v, out, p);
  return out;
}

const FETCH_PRIORITY = 9;

/** Encode a FETCH stream's items, threading the draft's prior-object state. */
function fetchItems(draft: Draft, items: readonly FetchItemSpec[]): Uint8Array[] {
  let prior: FetchObjectPrior18 | undefined, first = true;
  return items.map(item => {
    if (draft === 14) {
      if (item.kind === 'range') throw new Error('draft-14 FETCH has no End-of-Range indicator');
      if (item.kind === 'status14') return concat(varints(item.group, item.subgroup, item.object), Uint8Array.of(FETCH_PRIORITY), varints(0n, 0n, item.status));
      return concat(varints(item.group, item.subgroup, item.object), Uint8Array.of(FETCH_PRIORITY), varints(0n, BigInt(item.payload.length)), item.payload);
    }
    if (item.kind === 'status14') throw new Error('status Objects in FETCH are draft-14 only');
    if (draft === 16) {
      if (item.kind === 'range') return varints(0x8cn, item.group, item.object, 0n);
      // GROUP|OBJECT|PRIORITY and an explicit Subgroup ID.
      return concat(varints(0x1fn, item.group, item.subgroup, item.object), Uint8Array.of(FETCH_PRIORITY), varints(BigInt(item.payload.length)), item.payload);
    }
    if (item.kind === 'range') {
      if (item.marker === 'timed-out') {
        prior = { groupId: item.group, objectId: item.object, lastObjectSubgroupId: prior?.lastObjectSubgroupId, lastObjectPriority: prior?.lastObjectPriority };
        return vi64s(0x20cn, item.group, item.object);
      }
      const { bytes, nextPrior } = encodeFetchEndOfRange18(true, item.group, item.object, prior, draft);
      prior = nextPrior;
      return bytes;
    }
    const { bytes, nextPrior } = encodeFetchObject18({ groupId: item.group, subgroupId: item.subgroup, objectId: item.object,
      publisherPriority: FETCH_PRIORITY, extensions: undefined, payload: item.payload }, prior, first, 'ascending');
    prior = nextPrior; first = false;
    return bytes;
  });
}

const fetchHeaderBytes = (draft: Draft, requestId: bigint) =>
  legacy(draft) ? encodeFetchHeader({ requestId: varint(requestId) }) : encodeFetchHeader18(requestId);

async function issueFetch(connection: MoqtConnection): Promise<bigint> {
  return connection.fetch([text.encode('live')], text.encode('video'), {
    startGroup: varint(0n), startObject: varint(0n), endGroup: varint(1000n), endObject: varint(0n),
  });
}

describe.each(drafts)('FETCH stream reception, draft %i', draft => {
  it('announces a fragmented FETCH Object with its own identity, then later Objects; range indicators are never attempts', async () => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const { events } = observe(connection);
    try {
      const requestId = await issueFetch(connection);
      const middle: FetchItemSpec = draft === 14
        ? { kind: 'status14', group: 3n, subgroup: 1n, object: 5n, status: 1n }
        : { kind: 'range', group: 3n, object: 5n, marker: 'non-existent' };
      const [o0, mid, o1] = fetchItems(draft, [
        { kind: 'object', group: 3n, subgroup: 1n, object: 2n, payload: payloadOf(8) },
        middle,
        { kind: 'object', group: 3n, subgroup: 1n, object: 6n, payload: payloadOf(4) },
      ]);
      const h0 = o0!.length - 8;
      const s = transport.openIncomingUni();
      await read(s, 10, concat(fetchHeaderBytes(draft, requestId), o0!.subarray(0, 2)));
      await read(s, 20, o0!.subarray(2, h0 + 3));
      await read(s, 30, concat(o0!.subarray(h0 + 3), mid!, o1!));
      clock.now = 40; s.closeReadable(); await flush(100);

      const status = draft === 14
        ? [['header', 5n, 30, 30, 0n, 1n], ['end', 5n, 'complete', null, 0n, null, null, 30]]
        : [];
      expect(summary(events)).toEqual([
        ['header', 2n, 10, 20, 8n, null], ['progress', 3n, 20], ['end', 2n, 'complete', null, 8n, 20, 30, 30],
        ...status,
        ['header', 6n, 30, 30, 4n, null], ['end', 6n, 'complete', null, 4n, 30, 30, 30],
      ]);
      expect(events[0]).toMatchObject({ origin: 'fetch', trackAlias: null, requestId, groupId: 3n, subgroupId: 1n, objectId: 2n,
        publisherPriority: FETCH_PRIORITY });
      expectExactlyOneTerminalPerAttempt(events);
      // The range indicator (or status) is still delivered as before.
      expect(delivered.map(o => [o.kind, o.objectId])).toEqual([['data', 2n], ['gap', 5n], ['data', 6n]]);
    } finally { await connection.close(); }
  });
});

describe('draft-22 FETCH End of Timed-Out Range', () => {
  it('is not an attempt, and the following Object resolves its identity from the indicator', async () => {
    const { connection, transport } = await connect(22);
    const { events } = observe(connection);
    try {
      const requestId = await issueFetch(connection);
      const items = fetchItems(22, [
        { kind: 'object', group: 3n, subgroup: 1n, object: 2n, payload: payloadOf(3) },
        { kind: 'range', group: 3n, object: 7n, marker: 'timed-out' },
      ]);
      // After the indicator, Object ID Delta is relative to it: GROUP absent, OBJECT present (+1), PRIORITY present, explicit subgroup.
      const next = concat(vi64s(0x17n, 1n, 1n), Uint8Array.of(FETCH_PRIORITY), vi64s(2n), Uint8Array.of(7, 7));
      const s = transport.openIncomingUni();
      await read(s, 10, concat(encodeFetchHeader18(requestId), ...items, next.subarray(0, 2)));
      await read(s, 20, next.subarray(2));
      expect(summary(events)).toEqual([
        ['header', 2n, 10, 10, 3n, null], ['end', 2n, 'complete', null, 3n, 10, 10, 10],
        ['header', 8n, 10, 20, 2n, null], ['end', 8n, 'complete', null, 2n, 20, 20, 20],
      ]);
      expect(events[2]).toMatchObject({ groupId: 3n, subgroupId: 1n, objectId: 8n });
    } finally { await connection.close(); }
  });
});

describe('draft-22 FILL stream reception', () => {
  it('reports FILL as its own carrier origin, identified by the SUBSCRIBE Request ID', async () => {
    const { connection, transport } = await connect(22);
    const { events } = observe(connection);
    try {
      const pending = connection.subscribeTrack([text.encode('live')], text.encode('catalog'), {
        filter: { type: 'LargestObject' }, fill: { filter: { type: 'RelativeStart', groups: 1n } },
      });
      await flush();
      transport.bidi[0]!.push(createControlCodec(22).encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 7n,
        parameters: new Map([[0x09n, [{ group: 4n, object: 0n }]]]), trackProperties: new Map() } as never));
      const sub = await pending;
      const [o0] = fetchItems(22, [{ kind: 'object', group: 4n, subgroup: 0n, object: 0n, payload: payloadOf(5) }]);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(encodeFetchHeader18(sub.requestId), o0!.subarray(0, 3)));
      await read(s, 20, o0!.subarray(3));
      expect(o0!.length - 5, 'the first read holds only part of the Object header').toBeGreaterThan(3);
      expect(events[0]).toMatchObject({ type: 'header', origin: 'fill', requestId: sub.requestId, trackAlias: null, groupId: 4n,
        objectId: 0n, firstObjectByteObservedAt: 10, headerAvailableAt: 20 });
      expect(events.at(-1)).toMatchObject({ type: 'end', origin: 'fill', outcome: 'complete', observedAt: 20 });
    } finally { await connection.close(); }
  });
});

describe.each(drafts)('local replay keeps the original arrival, draft %i', draft => {
  it('pending-alias parking before SUBSCRIBE_OK: one attempt with the original times, delivered later on the same object', async () => {
    const { connection, transport } = await connect(draft);
    const deliveredAt: Array<[MoqtObject, number]> = [];
    const receipts: ObjectReceiptObservation[] = [];
    const removeReceipts = connection.observeObjectReceipts(r => { receipts.push(r); });
    const { events } = observe(connection);
    try {
      const pending = connection.subscribeTrack([text.encode('live')], text.encode('video'), {
        onObject: obj => { deliveredAt.push([obj, clock.now]); },
      });
      await flush(100);
      const s = transport.openIncomingUni();
      const wire = object(draft, 0n, payloadOf(6), null);
      await read(s, 10, concat(streamHeader(draft), wire.subarray(0, 2)));
      await read(s, 20, wire.subarray(2));
      expect(deliveredAt, 'parked: no subscription owns alias 77 yet').toEqual([]);
      expect(wire.length - 6, 'the first read holds exactly the Object header').toBe(2);
      expect(summary(events)).toEqual([
        ['header', 0n, 10, 10, 6n, null], ['end', 0n, 'complete', null, 6n, 20, 20, 20],
      ]);
      clock.now = 50;
      transport.bidi[0]!.push(subscribeOk(draft, 0n, ALIAS));
      await pending; await flush(100); await timerTurn(); await flush(100);
      expect(deliveredAt.map(([, at]) => at), 'replayed after acknowledgement').toEqual([50]);
      expect(events, 'replay is delivery, not another arrival').toHaveLength(2);
      const token = events[0]!.type === 'header' ? events[0]!.reception : undefined;
      expect(connection.objectReceptionFor(deliveredAt[0]![0])).toBe(token);
      expect(receipts.map(r => r.reception)).toEqual([token]);
    } finally { removeReceipts(); await connection.close(); }
  });

  it('a copy of a delivered object has no reception identity; the original keeps it', async () => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const { events } = observe(connection);
    try {
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), object(draft, 0n, payloadOf(2), null)));
      expect(delivered).toHaveLength(1);
      expect(events.filter(e => e.type === 'header'), 'one observed arrival').toHaveLength(1);
      const original = delivered[0]!;
      const remapped = { ...original, trackAlias: varint(9n) };
      expect(connection.objectReceptionFor(original)).toBe((events[0] as ObjectReceptionHeader).reception);
      expect(connection.objectReceptionFor(remapped)).toBeUndefined();
    } finally { await connection.close(); }
  });
});

describe('opaque property copies', () => {
  const block = (draft: 16 | 18, ...values: Uint8Array[]) =>
    encodePropertyBlock(values.map((value, i) => ({ id: 0x31n + 2n * BigInt(i), value })), draft === 16 ? 'd16-delta-varint' : 'd18-delta-vi64');

  it.each([16, 18] as const)('draft %i: isolated per-listener copies when requested; byte count always; delivered bytes untouched', async draft => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const requested: ObjectReceptionEvent[] = [], other: ObjectReceptionEvent[] = [];
    connection.observeObjectReception(e => {
      requested.push(e);
      if (e.type === 'header' && e.properties) e.properties.fill(0xee); // a hostile listener mutates its copy
    }, { includeProperties: true });
    connection.observeObjectReception(e => { other.push(e); }, { includeProperties: true });
    const plain = observe(connection);
    try {
      const properties = block(draft, Uint8Array.of(1, 2, 3, 4));
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft, { properties: true }), object(draft, 0n, payloadOf(3), null, { properties })));
      expect(other.filter(e => e.type === 'header'), 'the second listener saw one header').toHaveLength(1);
      expect(plain.events.filter(e => e.type === 'header'), 'the plain listener saw one header').toHaveLength(1);
      const mine = other[0] as ObjectReceptionHeader;
      expect(mine.properties).toEqual(properties);
      expect(mine).toMatchObject({ propertiesLength: properties.length, propertiesOmitted: null });
      expect((plain.events[0] as ObjectReceptionHeader)).toMatchObject({ propertiesLength: properties.length, properties: null,
        propertiesOmitted: 'not-requested' });
      expect((delivered[0] as { extensions?: Uint8Array }).extensions).toEqual(properties);
    } finally { await connection.close(); }
  });

  it.each([16, 18] as const)('draft %i: omits property bytes above the observation limit, explicitly and with the exact count', async draft => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection, { includeProperties: true });
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    try {
      const properties = block(draft, payloadOf(40000, 3), payloadOf(40000, 5));
      expect(properties.length).toBeGreaterThan(OBSERVED_PROPERTIES_LIMIT);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft, { properties: true }), object(draft, 0n, payloadOf(3), null, { properties })));
      expect(events[0]).toMatchObject({ type: 'header', propertiesLength: properties.length, properties: null, propertiesOmitted: 'exceeds-limit' });
      expect((delivered[0] as { extensions?: Uint8Array }).extensions).toEqual(properties);
    } finally { await connection.close(); }
  });
});

describe.each([18, 22] as const)('property-faulted Objects, draft %i', draft => {
  it('a complete Object rejected by property validation ends complete at receive level, with no receipt or delivery', async () => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [], receipts: ObjectReceiptObservation[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const removeReceipts = connection.observeObjectReceipts(r => { receipts.push(r); });
    const { events } = observe(connection);
    try {
      // A Mandatory Track Property (0x4001) is track-only: an Object carrying it is malformed.
      const faulty = encodePropertyBlock([{ id: 0x4001n, value: Uint8Array.of(1) }], 'd18-delta-vi64');
      const next = object(draft, 1n, payloadOf(6), 0n, { properties: true });
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft, { properties: true }), object(draft, 0n, payloadOf(3), null, { properties: faulty }),
        next.subarray(0, next.length - 2)));
      await flush(100);
      expect(summary(events)).toEqual([
        ['header', 0n, 10, 10, 3n, null], ['end', 0n, 'complete', null, 3n, 10, 10, 10],
      ]);
      expect(receipts).toEqual([]);
      expect(delivered).toEqual([]);
    } finally { removeReceipts(); await connection.close(); }
  });
});

describe('listener misbehaviour cannot change protocol processing', () => {
  it('throwing and rejecting listeners are contained; delivery and other listeners continue', async () => {
    const { connection, transport } = await connect(18);
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    connection.observeObjectReception(() => { throw new Error('listener failure'); });
    connection.observeObjectReception(async () => { throw new Error('async listener failure'); });
    const { events } = observe(connection);
    try {
      const wire = object(18, 0n, payloadOf(6), null);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), wire.subarray(0, wire.length - 2)));
      await read(s, 20, wire.subarray(wire.length - 2));
      expect(summary(events).map(e => (e as unknown[])[0])).toEqual(['header', 'progress', 'end']);
      expect(delivered).toHaveLength(1);
      expect(connection.session.state).toBe('established');
    } finally { await connection.close(); }
  });

  it('a listener detaching another mid-notification ends that listener\'s evidence at once', async () => {
    const { connection, transport } = await connect(18);
    const first: ObjectReceptionEvent[] = [], second: ObjectReceptionEvent[] = [];
    let detachSecond = (): void => {};
    connection.observeObjectReception(e => { first.push(e); if (e.type === 'header') detachSecond(); });
    detachSecond = connection.observeObjectReception(e => { second.push(e); });
    try {
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), object(18, 0n, payloadOf(2), null)));
      expect(first.map(e => e.type)).toEqual(['header', 'end']);
      expect(second).toEqual([]);
    } finally { await connection.close(); }
  });

  it('closing the connection inside a header callback still gives every listener header before its connection-closed end', async () => {
    const { connection, transport } = await connect(18);
    const first: ObjectReceptionEvent[] = [], second: ObjectReceptionEvent[] = [];
    connection.observeObjectReception(e => { first.push(e); if (e.type === 'header') void connection.close(); });
    connection.observeObjectReception(e => { second.push(e); });
    const wire = object(18, 0n, payloadOf(6), null);
    const s = transport.openIncomingUni();
    clock.now = 10; s.push(concat(streamHeader(18), wire.subarray(0, wire.length - 3))); await flush(200);
    for (const seen of [first, second]) {
      expect(seen.map(e => e.type)).toEqual(['header', 'end']);
      // The read carried 3 of the 6 payload bytes; teardown in the header callback keeps them.
      expect(seen[1]).toMatchObject({ outcome: 'interrupted', reason: 'connection-closed', payloadLength: 6n, payloadReceived: 3n,
        firstPayloadByteObservedAt: 10, lastPayloadByteObservedAt: 10, observedAt: 10 });
    }
  });

  it('closing the connection inside the header callback of an Object received whole still ends it complete', async () => {
    const { connection, transport } = await connect(18);
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const first: ObjectReceptionEvent[] = [], second: ObjectReceptionEvent[] = [];
    connection.observeObjectReception(e => { first.push(e); if (e.type === 'header') void connection.close(); });
    connection.observeObjectReception(e => { second.push(e); });
    const s = transport.openIncomingUni();
    clock.now = 10; s.push(concat(streamHeader(18), object(18, 0n, payloadOf(6), null))); await flush(200);
    for (const seen of [first, second]) {
      expect(seen.map(e => e.type)).toEqual(['header', 'end']);
      expect(seen[1]).toMatchObject({ outcome: 'complete', reason: null, payloadLength: 6n, payloadReceived: 6n,
        firstPayloadByteObservedAt: 10, lastPayloadByteObservedAt: 10, observedAt: 10 });
    }
    expect(delivered, 'teardown suppresses application delivery, not the receive outcome').toEqual([]);
  });
});

describe('arrival identity outlives the last listener', () => {
  it('a listener detaching itself in its end callback leaves the receipt and lookup correlated', async () => {
    const { connection, transport } = await connect(18);
    const delivered: MoqtObject[] = [], receipts: ObjectReceiptObservation[] = [], events: ObjectReceptionEvent[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const removeReceipts = connection.observeObjectReceipts(r => { receipts.push(r); });
    const detach = connection.observeObjectReception(e => { events.push(e); if (e.type === 'end') detach(); });
    try {
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), object(18, 0n, payloadOf(4), null)));
      expect(events.map(e => e.type)).toEqual(['header', 'end']);
      const token = (events[0] as ObjectReceptionHeader).reception;
      expect(receipts.map(r => r.reception)).toEqual([token]);
      expect(connection.objectReceptionFor(delivered[0]!)).toBe(token);
    } finally { removeReceipts(); await connection.close(); }
  });

  it.each([16, 18] as const)('draft %i: a parked Object delivered after the final detach keeps its arrival identity', async draft => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [], receipts: ObjectReceiptObservation[] = [];
    const removeReceipts = connection.observeObjectReceipts(r => { receipts.push(r); });
    const { events, detach } = observe(connection);
    try {
      const pending = connection.subscribeTrack([text.encode('live')], text.encode('video'), { onObject: obj => { delivered.push(obj); } });
      await flush(100);
      await read(transport.openIncomingUni(), 10, concat(streamHeader(draft), object(draft, 0n, payloadOf(5), null)));
      expect(events.map(e => e.type)).toEqual(['header', 'end']);
      const token = (events[0] as ObjectReceptionHeader).reception;
      detach();
      transport.bidi[0]!.push(subscribeOk(draft, 0n, ALIAS));
      await pending; await flush(100); await timerTurn(); await flush(100);
      expect(delivered).toHaveLength(1);
      expect(connection.objectReceptionFor(delivered[0]!)).toBe(token);
      expect(receipts.map(r => r.reception)).toEqual([token]);
    } finally { removeReceipts(); await connection.close(); }
  });
});

describe('local discard', () => {
  it('cancelling a FETCH with an Object in flight ends that attempt as local-discard', async () => {
    const { connection, transport } = await connect(18);
    const { events } = observe(connection);
    const closed: string[] = [];
    connection.onStreamClosed = (_id, _code, terminal) => { closed.push(terminal); };
    try {
      const requestId = await issueFetch(connection);
      const [o0] = fetchItems(18, [{ kind: 'object', group: 3n, subgroup: 0n, object: 0n, payload: payloadOf(10) }]);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(encodeFetchHeader18(requestId), o0!.subarray(0, o0!.length - 4)));
      clock.now = 20; await connection.fetchCancel(requestId); await flush(100);
      expect(events.at(-1)).toMatchObject({ type: 'end', outcome: 'interrupted', reason: 'local-discard', payloadReceived: 6n, observedAt: 20 });
      expect(closed).toEqual(['local-discard']);
      expectExactlyOneTerminalPerAttempt(events);
    } finally { await connection.close(); }
  });
});

describe.each(drafts)('FIRST_OBJECT Subgroup ID, draft %i', draft => {
  it('takes the Subgroup ID from the stream\'s first Object, whether announced early or at completion', async () => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    try {
      const first = object(draft, 7n, payloadOf(5), null);
      const second = object(draft, 8n, payloadOf(2), 7n);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft, { subgroupFromFirstObject: true }), first.subarray(0, first.length - 2)));
      await read(s, 20, concat(first.subarray(first.length - 2), second));
      const headers = events.filter(e => e.type === 'header');
      expect(headers.map(e => [e.objectId, e.subgroupId])).toEqual([[7n, 7n], [8n, 7n]]);
    } finally { await connection.close(); }
  });
});

describe('exact wire integers', () => {
  it.each([16, 18] as const)('draft %i: a group above 2^53 and a declared length above 2^53 are reported exactly; nothing is sized by the declaration', async draft => {
    const { connection, transport } = await connect(draft);
    const { events } = observe(connection);
    try {
      const group = (1n << 60n) + 1n, declared = (1n << 53n) + 1n;
      const lengthField = draft === 16 ? varints(declared) : vi64s(declared);
      const delta = draft === 16 ? varints(0n) : vi64s(0n);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft, { groupId: group }), delta, lengthField, payloadOf(5)));
      await read(s, 20, payloadOf(7));
      clock.now = 30; s.resetReadableWithCode(3); await flush(100);
      expect(summary(events)).toEqual([
        ['header', 0n, 10, 10, declared, null], ['progress', 5n, 10], ['progress', 12n, 20],
        ['end', 0n, 'interrupted', 'reset', 12n, 10, 20, 30],
      ]);
      expect(events[0]).toMatchObject({ groupId: group });
    } finally { await connection.close(); }
  });
});

describe('connection isolation', () => {
  it('equal alias and stream numbers on two connections never share attempts or listeners', async () => {
    const one = await connect(18), two = await connect(18);
    const a = observe(one.connection), b = observe(two.connection);
    try {
      const s1 = one.transport.openIncomingUni(), s2 = two.transport.openIncomingUni();
      await read(s1, 10, concat(streamHeader(18), object(18, 0n, payloadOf(2), null)));
      await read(s2, 20, concat(streamHeader(18), object(18, 0n, payloadOf(3), null)));
      expect(summary(a.events)).toEqual([['header', 0n, 10, 10, 2n, null], ['end', 0n, 'complete', null, 2n, 10, 10, 10]]);
      expect(summary(b.events)).toEqual([['header', 0n, 20, 20, 3n, null], ['end', 0n, 'complete', null, 3n, 20, 20, 20]]);
      expect((a.events[0] as ObjectReceptionHeader).streamId).toBe((b.events[0] as ObjectReceptionHeader).streamId);
      expect(a.events[0]!.reception).not.toBe(b.events[0]!.reception);
    } finally { await one.connection.close(); await two.connection.close(); }
  });
});

describe.each([18, 22] as const)('data held until SETUP, draft %i', draft => {
  it('times the first object byte by the classifier read, not by release after SETUP', async () => {
    const connection = new MoqtConnection(draft), transport = new TransportSim();
    const { events } = observe(connection);
    try {
      const connecting = connection.connect(transport); // the router classifies every incoming stream from here on
      const data = transport.openIncomingUni();
      clock.now = 10; data.push(concat(streamHeader(draft), object(draft, 0n, payloadOf(4), null))); await flush(100);
      expect(events, 'held: data streams wait for SETUP').toEqual([]);
      clock.now = 20;
      transport.openIncomingUni().push(createControlCodec(draft).encode({ type: 'SETUP', setupOptions: new Map() }));
      await connecting; await flush(100);
      expect(summary(events)).toEqual([['header', 0n, 10, 10, 4n, null], ['end', 0n, 'complete', null, 4n, 10, 10, 10]]);
    } finally { await connection.close(); }
  });
});

describe.each(drafts)('ordering against qlog, draft %i', draft => {
  it('ends each Object before its parsed-object qlog event, and leaves the qlog sequence unchanged', async () => {
    const run = async (withReception: boolean) => {
      const { connection, transport } = await connect(draft);
      const log: string[] = [];
      const removeQlog = connection.observeQlogEvents((e: QlogEvent) => {
        if (e.type === 'subgroup_object_parsed' || e.type === 'subgroup_header_parsed' || e.type === 'stream_type_set') log.push(`qlog:${e.type}`);
      });
      if (withReception) connection.observeObjectReception(e => { log.push(`rx:${e.type}`); });
      const wire = object(draft, 0n, payloadOf(9), null);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(draft), wire.subarray(0, wire.length - 4)));
      await read(s, 20, concat(wire.subarray(wire.length - 4), object(draft, 1n, payloadOf(1), 0n)));
      removeQlog(); await connection.close();
      return log;
    };
    const plain = await run(false), observed = await run(true);
    expect(observed.filter(e => e.startsWith('qlog:'))).toEqual(plain);
    expect(observed).toEqual([
      'qlog:stream_type_set', 'qlog:subgroup_header_parsed', 'rx:header', 'rx:progress',
      'rx:end', 'qlog:subgroup_object_parsed', 'rx:header', 'rx:end', 'qlog:subgroup_object_parsed',
    ]);
  });
});

describe('re-attachment', () => {
  it('detaching every listener and re-attaching mid-object observes only Objects that begin afterwards, with no stale terminal', async () => {
    const { connection, transport } = await connect(18);
    const first = observe(connection);
    try {
      const a = object(18, 0n, payloadOf(6), null);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), a.subarray(0, a.length - 3)));
      first.detach();
      const second = observe(connection);
      await read(s, 20, concat(a.subarray(a.length - 3), object(18, 1n, payloadOf(2), 0n)));
      expect(summary(first.events)).toEqual([['header', 0n, 10, 10, 6n, null], ['progress', 3n, 10]]);
      expect(summary(second.events)).toEqual([['header', 1n, 20, 20, 2n, null], ['end', 1n, 'complete', null, 2n, 20, 20, 20]]);
      expect((second.events.at(-1) as ObjectReceptionEnd).origin).toBe('subgroup');
    } finally { await connection.close(); }
  });
});

describe('a RangeError thrown after a successful decode is not a short read', () => {
  // The FETCH and subgroup loops treat ANY RangeError in their try block as "need more bytes",
  // including one thrown by application delivery. That pre-existing behaviour is preserved here;
  // reception must still end each consumed Object once and attribute leftover bytes correctly.
  it.each([16, 18] as const)('draft %i FETCH: an onObject RangeError leaves one terminal per Object and the next Object intact', async draft => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [];
    let thrown = false;
    connection.onObject = (_id, obj) => {
      delivered.push(obj);
      if (!thrown) { thrown = true; throw new RangeError('application failure after decode'); }
    };
    const { events } = observe(connection);
    try {
      const requestId = await issueFetch(connection);
      const [a, b] = fetchItems(draft, [
        { kind: 'object', group: 3n, subgroup: 1n, object: 2n, payload: payloadOf(4) },
        { kind: 'object', group: 3n, subgroup: 1n, object: 3n, payload: payloadOf(8) },
      ]);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(fetchHeaderBytes(draft, requestId), a!, b!.subarray(0, b!.length - 3)));
      await read(s, 20, b!.subarray(b!.length - 3));
      expect(summary(events)).toEqual([
        ['header', 2n, 10, 10, 4n, null], ['end', 2n, 'complete', null, 4n, 10, 10, 10],
        ['header', 3n, 10, 10, 8n, null], ['progress', 5n, 10], ['end', 3n, 'complete', null, 8n, 10, 20, 20],
      ]);
      expectExactlyOneTerminalPerAttempt(events);
      expect(delivered.map(o => o.objectId), 'both Objects still delivered').toEqual([2n, 3n]);
    } finally { await connection.close(); }
  });

  it('draft 18 subgroup: an onObject RangeError leaves reception agreeing with what the decoder delivers next', async () => {
    const { connection, transport } = await connect(18);
    const delivered: MoqtObject[] = [];
    let thrown = false;
    connection.onObject = (_id, obj) => {
      delivered.push(obj);
      if (!thrown) { thrown = true; throw new RangeError('application failure after decode'); }
    };
    const { events } = observe(connection);
    try {
      const a = object(18, 0n, payloadOf(4), null), b = object(18, 1n, payloadOf(6), 0n);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), a, b.subarray(0, b.length - 2)));
      await read(s, 20, b.subarray(b.length - 2));
      expectExactlyOneTerminalPerAttempt(events);
      const ends = events.filter((e): e is ObjectReceptionEnd => e.type === 'end');
      expect(ends.map(e => e.outcome), 'no consumed Object is reported incomplete').toEqual(['complete', 'complete']);
      expect(ends.map(e => [e.objectId, e.observedAt])).toEqual(delivered.map((o, i) => [o.objectId, i === 0 ? 10 : 20]));
      expect(ends.map(e => e.payloadReceived)).toEqual([4n, 6n]);
    } finally { await connection.close(); }
  });
});

describe('attachment boundaries', () => {
  it('a listener attached inside a callback for A is not eligible for B whose first bytes arrived in the same read', async () => {
    const { connection, transport } = await connect(18);
    const late: ObjectReceptionEvent[] = [];
    const early = observe(connection);
    let attached = false;
    connection.onObject = () => {
      if (!attached) { attached = true; connection.observeObjectReception(e => { late.push(e); }); }
    };
    try {
      const a = object(18, 0n, payloadOf(3), null), b = object(18, 1n, payloadOf(3), 0n), c = object(18, 2n, payloadOf(3), 1n);
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), a, b.subarray(0, 2)));
      await read(s, 20, concat(b.subarray(2), c));
      expect(early.events.filter(e => e.type === 'header').map(e => e.objectId)).toEqual([0n, 1n, 2n]);
      expect(summary(late)).toEqual([['header', 2n, 20, 20, 3n, null], ['end', 2n, 'complete', null, 3n, 20, 20, 20]]);
    } finally { await connection.close(); }
  });

  it('a listener attached inside a reception end callback is likewise not eligible for the same read', async () => {
    const { connection, transport } = await connect(18);
    const late: ObjectReceptionEvent[] = [];
    let attached = false;
    connection.observeObjectReception(e => {
      if (e.type === 'end' && !attached) { attached = true; connection.observeObjectReception(x => { late.push(x); }); }
    });
    try {
      const s = transport.openIncomingUni();
      await read(s, 10, concat(streamHeader(18), object(18, 0n, payloadOf(3), null), object(18, 1n, payloadOf(3), 0n)));
      await read(s, 20, object(18, 2n, payloadOf(3), 1n));
      expect(late.filter(e => e.type === 'header').map(e => e.objectId)).toEqual([2n]);
    } finally { await connection.close(); }
  });

  it.each([18, 22] as const)('draft %i: attaching while classified data waits for SETUP does not claim bytes already read', async draft => {
    const connection = new MoqtConnection(draft), transport = new TransportSim();
    try {
      const connecting = connection.connect(transport);
      const data = transport.openIncomingUni();
      clock.now = 10; data.push(concat(streamHeader(draft), object(draft, 0n, payloadOf(4), null))); await flush(100);
      clock.now = 15;
      const { events } = observe(connection);
      clock.now = 20;
      transport.openIncomingUni().push(createControlCodec(draft).encode({ type: 'SETUP', setupOptions: new Map() }));
      await connecting; await flush(100);
      expect(events, 'the held Object began before attachment').toEqual([]);
      await read(data, 30, object(draft, 1n, payloadOf(2), 0n));
      expect(summary(events)).toEqual([['header', 1n, 30, 30, 2n, null], ['end', 1n, 'complete', null, 2n, 30, 30, 30]]);
    } finally { await connection.close(); }
  });
});

describe.each([16, 18, 22] as const)('FETCH Datagram-form Objects, draft %i', draft => {
  it('keep their FETCH carrier and report no Subgroup ID, not the decoder\'s synthetic zero', async () => {
    const { connection, transport } = await connect(draft);
    const delivered: MoqtObject[] = [];
    connection.onObject = (_id, obj) => { delivered.push(obj); };
    const { events } = observe(connection);
    try {
      const requestId = await issueFetch(connection);
      // DATAGRAM | PRIORITY | GROUP | OBJECT, no Subgroup ID field.
      const datagramForm = draft === 16
        ? concat(varints(0x5cn, 3n, 4n), Uint8Array.of(FETCH_PRIORITY), varints(2n), Uint8Array.of(1, 2))
        : concat(vi64s(0x5cn, 3n, 4n), Uint8Array.of(FETCH_PRIORITY), vi64s(2n), Uint8Array.of(1, 2));
      const s = transport.openIncomingUni();
      await read(s, 10, concat(fetchHeaderBytes(draft, requestId), datagramForm));
      expect(events[0]).toMatchObject({ type: 'header', origin: 'fetch', requestId, groupId: 3n, objectId: 4n, subgroupId: null });
      expect(events[1]).toMatchObject({ type: 'end', origin: 'fetch', subgroupId: null, outcome: 'complete' });
      expect(delivered[0]?.subgroupId, 'application delivery is unchanged').toBe(0n);
    } finally { await connection.close(); }
  });
});
