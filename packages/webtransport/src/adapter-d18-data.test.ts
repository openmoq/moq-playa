/**
 * MoqtConnection draft-18 DATA path, exercised with the deterministic stream
 * simulator: subgroup streams reach onObject, datagrams reach onDatagram,
 * padding (stream + datagram) is discarded, and invalid types raise a protocol
 * violation. Stream type / header / object are also delivered fragmented to
 * prove the read-more loops reassemble vi64 fields across chunks.
 *
 * Inbound (receive-path) buffers are hand-built from the draft-18 wire layouts
 * via the same vi64 `pack` helper used by the decoder unit tests; the publisher
 * send path uses the real d18 encoders and is verified by decoding the bytes.
 */
import { describe, it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { TransportSim, flush } from './testkit/stream-sim.js';
import {
  createControlCodec,
  writeVi64,
  vi64EncodingLength,
  varint,
  StreamType18,
  PADDING_DATAGRAM_TYPE,
  DatagramFlags18,
  decodeSubgroupHeader18,
  decodeSubgroupObject18,
  decodeObjectDatagram18,
  decodeFetchHeader18,
  decodeFetchObject18,
} from '@moqt/transport';
import type { MoqtObject, ObjectDatagram, SubscribeOk, RequestOk } from '@moqt/transport';

const codec18 = createControlCodec(18);
const setupBytes = (): Uint8Array => codec18.encode({ type: 'SETUP', setupOptions: new Map() });
const okBytes = (alias: bigint): Uint8Array =>
  codec18.encode({ type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: alias, parameters: new Map(), trackExtensions: new Map() } as SubscribeOk);

const ns = (s: string) => [new TextEncoder().encode(s)];
const nm = (s: string) => new TextEncoder().encode(s);

/** Build a buffer from vi64 fields and raw byte spans. */
function pack(...parts: Array<bigint | { u8: number } | { raw: number[] }>): Uint8Array {
  let len = 0;
  for (const p of parts) {
    if (typeof p === 'bigint') len += vi64EncodingLength(p);
    else if ('u8' in p) len += 1;
    else len += p.raw.length;
  }
  const buf = new Uint8Array(len);
  let pos = 0;
  for (const p of parts) {
    if (typeof p === 'bigint') pos += writeVi64(p, buf, pos);
    else if ('u8' in p) buf[pos++] = p.u8;
    else { buf.set(p.raw, pos); pos += p.raw.length; }
  }
  return buf;
}
const u8 = (n: number) => ({ u8: n });
const raw = (...b: number[]) => ({ raw: b });
const concat = (...as: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(as.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of as) { out.set(a, p); p += a.length; }
  return out;
};

// SUBGROUP_HEADER type 0x10: mode 0b00 (subgroup id 0), priority present.
const subgroupHeader = (alias: bigint, group: bigint, prio = 5) =>
  pack(0x10n, alias, group, u8(prio));
// One subgroup object: Object ID Delta, Payload Length, Payload.
const subgroupObject = (delta: bigint, payload: number[]) =>
  pack(delta, BigInt(payload.length), raw(...payload));
// OBJECT_DATAGRAM type 0x00: alias, group, object id, priority, payload.
const datagram = (alias: bigint, group: bigint, obj: bigint, prio: number, payload: number[]) =>
  pack(0x00n, alias, group, obj, u8(prio), raw(...payload));

async function connected(): Promise<{ conn: MoqtConnection; transport: TransportSim }> {
  const conn = new MoqtConnection(18);
  const transport = new TransportSim();
  // §3.3: the control stream MUST stay open for the session — a FIN after SETUP is
  // now a protocol violation. openIncomingUni keeps it open (pushIncomingUni FINs).
  transport.openIncomingUni().push(setupBytes());
  await conn.connect(transport);
  return { conn, transport };
}

describe('MoqtConnection(18) subgroup stream delivery', () => {
  it('delivers a subgroup object to onObject (unknown alias → raw onObject)', async () => {
    const { conn, transport } = await connected();
    const objects: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objects.push(o);

    transport.pushIncomingUni(concat(
      subgroupHeader(7n, 42n),
      subgroupObject(3n, [0xaa, 0xbb]),
    ));
    await flush();

    expect(objects.length).toBe(1);
    const o = objects[0]!;
    expect(o.kind).toBe('data');
    expect(o.trackAlias).toBe(7n);
    expect(o.groupId).toBe(42n);
    expect(o.subgroupId).toBe(0n);
    expect(o.objectId).toBe(3n);
    if (o.kind === 'data') expect(o.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it('delivers multiple objects with prev+delta+1 object IDs', async () => {
    const { conn, transport } = await connected();
    const ids: bigint[] = [];
    conn.onObject = (_sid, o) => ids.push(o.objectId);

    transport.pushIncomingUni(concat(
      subgroupHeader(7n, 42n),
      subgroupObject(5n, [0x01]),  // first → objectId 5
      subgroupObject(0n, [0x02]),  // 5 + 0 + 1 = 6
      subgroupObject(1n, [0x03]),  // 6 + 1 + 1 = 8
    ));
    await flush();

    expect(ids).toEqual([5n, 6n, 8n]);
  });

  it('routes a subgroup stream to the matching subscribeTrack callback (alias 7n), suppressing generic onObject', async () => {
    const { conn, transport } = await connected();
    let generic = 0;
    conn.onObject = () => { generic++; };

    const recv: MoqtObject[] = [];
    const subP = conn.subscribeTrack(ns('a'), nm('1'), { onObject: (o) => recv.push(o) });
    await flush();
    // Stamped SUBSCRIBE_OK binds alias 7n to this subscription's request stream.
    transport.bidi[0]!.push(okBytes(7n));
    const sub = await subP;
    expect(sub.trackAlias).toBe(7n);

    // A subgroup stream on alias 7n reaches the per-subscription callback only.
    transport.pushIncomingUni(concat(
      subgroupHeader(7n, 42n),
      subgroupObject(3n, [0xaa, 0xbb]),
    ));
    await flush();

    expect(recv.length).toBe(1);
    expect(recv[0]!.objectId).toBe(3n);
    expect(recv[0]!.trackAlias).toBe(7n);
    if (recv[0]!.kind === 'data') expect(recv[0]!.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(generic).toBe(0); // generic conn.onObject is suppressed for claimed aliases
  });

  it('reassembles a fragmented stream type / header / object across chunks', async () => {
    const { conn, transport } = await connected();
    const objects: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objects.push(o);

    const header = subgroupHeader(0x1234n, 0x5678n); // multi-byte vi64 fields
    const obj = subgroupObject(9n, [0xde, 0xad, 0xbe, 0xef]);
    const all = concat(header, obj);

    const s = transport.openIncomingUni();
    // Dribble one byte at a time so every vi64 boundary is crossed mid-field.
    for (const b of all) {
      s.push(new Uint8Array([b]));
      await flush(2);
    }
    s.closeReadable();
    await flush();

    expect(objects.length).toBe(1);
    const o = objects[0]!;
    expect(o.trackAlias).toBe(0x1234n);
    expect(o.groupId).toBe(0x5678n);
    expect(o.objectId).toBe(9n);
    if (o.kind === 'data') expect(o.payload).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});

describe('MoqtConnection(18) datagram delivery', () => {
  it('delivers an object datagram to onDatagram', async () => {
    const { conn, transport } = await connected();
    const dgs: ObjectDatagram[] = [];
    conn.onDatagram = (d) => dgs.push(d);

    transport.pushDatagram(datagram(7n, 42n, 3n, 4, [0x09, 0x08]));
    await flush();

    expect(dgs.length).toBe(1);
    expect(dgs[0]!.trackAlias).toBe(7n);
    expect(dgs[0]!.groupId).toBe(42n);
    expect(dgs[0]!.objectId).toBe(3n);
    expect(dgs[0]!.payload).toEqual(new Uint8Array([0x09, 0x08]));
  });

  it('discards a padding datagram (§11.5.2) without onDatagram or error', async () => {
    const { conn, transport } = await connected();
    let datagrams = 0;
    let closed = false;
    conn.onDatagram = () => { datagrams++; };
    conn.onClose = () => { closed = true; };

    // Padding datagram: type 0x132B3E29 (vi64) + arbitrary discardable bytes.
    transport.pushDatagram(concat(
      pack(BigInt(PADDING_DATAGRAM_TYPE)),
      new Uint8Array([0xff, 0xff, 0xff]),
    ));
    // A real datagram still flows after the padding one is dropped.
    transport.pushDatagram(datagram(1n, 2n, 3n, 4, [0x01]));
    await flush();

    expect(datagrams).toBe(1);
    expect(closed).toBe(false);
  });
});

describe('MoqtConnection(18) padding stream + invalid types', () => {
  it('discards a padding stream (§11.5.1) — drained, no objects, no error', async () => {
    const { conn, transport } = await connected();
    let objects = 0;
    let closedStream = false;
    let closedSession = false;
    conn.onObject = () => { objects++; };
    conn.onStreamClosed = () => { closedStream = true; };
    conn.onClose = () => { closedSession = true; };

    transport.pushIncomingUni(concat(
      pack(BigInt(StreamType18.PADDING)), // 0x132B3E28
      new Uint8Array([0x00, 0x11, 0x22, 0x33]),
    ));
    await flush();

    expect(objects).toBe(0);
    expect(closedStream).toBe(true);
    expect(closedSession).toBe(false);
  });

  it('raises a protocol violation on an unknown stream type', async () => {
    const { conn, transport } = await connected();
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    // 0x08: not FETCH (0x05), not a subgroup form (bit 4 clear), not SETUP/PADDING.
    transport.pushIncomingUni(pack(0x08n, 1n, 2n));
    await flush();

    expect(closeCode).toBe(0x3); // PROTOCOL_VIOLATION
  });

  it('raises a protocol violation on an invalid datagram type', async () => {
    const { conn, transport } = await connected();
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    // STATUS+END_OF_GROUP together (0x22) is an invalid datagram form.
    const invalid = pack(
      BigInt(DatagramFlags18.STATUS | DatagramFlags18.END_OF_GROUP),
      1n, 2n, 3n, u8(0), 0n,
    );
    transport.pushDatagram(invalid);
    await flush();

    expect(closeCode).toBe(0x3);
  });
});

// ─── FETCH data (§11.4.4) ───────────────────────────────────────────────

// FETCH_HEADER: Type 0x05 + Request ID. First fetch object flags 0x1C =
// GROUP(0x08)|OBJECT(0x04)|PRIORITY(0x10), subgroup mode 0.
const fetchHeader = (reqId: bigint) => pack(0x05n, reqId);
const firstFetchObj = (group: bigint, object: bigint, prio: number, payload: number[]) =>
  pack(0x1cn, group, object, u8(prio), BigInt(payload.length), raw(...payload));

/** Issue a FETCH (registering its Request ID / group order) and return the id. */
async function issueFetch(conn: MoqtConnection, order?: 'ascending' | 'descending'): Promise<bigint> {
  return conn.fetch(ns('a'), nm('1'), {
    startGroup: varint(0n), startObject: varint(0n),
    endGroup: varint(1000n), endObject: varint(0n),
    ...(order ? { groupOrder: order } : {}),
  });
}

describe('MoqtConnection(18) FETCH data', () => {
  it('delivers fetch objects with ascending group deltas (default order)', async () => {
    const { conn, transport } = await connected();
    const objs: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objs.push(o);

    const reqId = await issueFetch(conn);
    transport.pushIncomingUni(concat(
      fetchHeader(reqId),
      firstFetchObj(1n, 0n, 3, [0xaa]),
      // flags 0x0C: group+object present, priority inherited. ascending group:
      // 1 + 0 + 1 = 2; group present → object delta is absolute (7).
      pack(0x0cn, 0n, 7n, 1n, raw(0xbb)),
    ));
    await flush();

    expect(objs.map((o) => [o.groupId, o.objectId])).toEqual([[1n, 0n], [2n, 7n]]);
    expect(objs[0]!.kind).toBe('data');
  });

  it('decodes descending group deltas when the FETCH requested Descending order', async () => {
    const { conn, transport } = await connected();
    const objs: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objs.push(o);

    // Range is still start <= end; Group Order governs delivery direction.
    const reqId = await conn.fetch(ns('a'), nm('1'), {
      startGroup: varint(0n), startObject: varint(0n),
      endGroup: varint(10n), endObject: varint(0n), groupOrder: 'descending',
    });
    transport.pushIncomingUni(concat(
      fetchHeader(reqId),
      firstFetchObj(10n, 0n, 3, [0xaa]),
      pack(0x0cn, 0n, 0n, 1n, raw(0xbb)), // descending: 10 - (0 + 1) = 9
    ));
    await flush();

    expect(objs.map((o) => o.groupId)).toEqual([10n, 9n]);
  });

  it('emits End-of-Range markers as gap objects', async () => {
    const { conn, transport } = await connected();
    const objs: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objs.push(o);

    const reqId = await issueFetch(conn);
    transport.pushIncomingUni(concat(
      fetchHeader(reqId),
      firstFetchObj(1n, 0n, 3, [0xaa]),
      pack(0x8cn, 1n, 5n, 0n), // End of Non-Existent Range at {1,5}
    ));
    await flush();

    expect(objs[0]!.kind).toBe('data');
    expect(objs[1]!.kind).toBe('gap');
    expect(objs[1]!.groupId).toBe(1n);
    expect(objs[1]!.objectId).toBe(5n);
    if (objs[1]!.kind === 'gap') expect(objs[1]!.status).toBe(0x3n);
  });

  it('reassembles a fragmented fetch stream (header + objects across chunks)', async () => {
    const { conn, transport } = await connected();
    const objs: MoqtObject[] = [];
    conn.onObject = (_sid, o) => objs.push(o);

    const reqId = await issueFetch(conn);
    const all = concat(
      fetchHeader(reqId),
      firstFetchObj(3n, 1n, 2, [0xde, 0xad]),
      pack(0x00n, 1n, raw(0xbe)), // inherit all: group 3, object 2, prio 2
    );
    const s = transport.openIncomingUni();
    for (const b of all) {
      s.push(new Uint8Array([b]));
      await flush(2);
    }
    s.closeReadable();
    await flush();

    expect(objs.map((o) => [o.groupId, o.objectId])).toEqual([[3n, 1n], [3n, 2n]]);
  });

  it('does NOT route fetch objects into a real alias-0 subscription', async () => {
    const { conn, transport } = await connected();
    const subObjs: MoqtObject[] = [];
    const subP = conn.subscribeTrack(ns('a'), nm('1'), { onObject: (o) => subObjs.push(o) });
    await flush();
    transport.bidi[0]!.push(okBytes(0n)); // SUBSCRIBE_OK binds track alias 0
    const sub = await subP;
    expect(sub.trackAlias).toBe(0n);

    const generic: MoqtObject[] = [];
    conn.onObject = (_sid, o) => generic.push(o);

    // A fetch stream's objects carry a fabricated alias 0 — they must NOT land
    // in the alias-0 subscription; they go to the generic onObject only.
    const reqId = await issueFetch(conn);
    transport.pushIncomingUni(concat(fetchHeader(reqId), firstFetchObj(1n, 0n, 3, [0xaa])));
    await flush();

    expect(subObjs.length).toBe(0);
    expect(generic.length).toBe(1);
    expect(generic[0]!.groupId).toBe(1n);
  });

  it('raises a protocol violation on invalid fetch Serialization Flags', async () => {
    const { conn, transport } = await connected();
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    const reqId = await issueFetch(conn);
    transport.pushIncomingUni(concat(
      fetchHeader(reqId),
      pack(0x80n, 0n), // 0x80 is not a valid flags value
    ));
    await flush();

    expect(closeCode).toBe(0x3);
  });

  it('raises a protocol violation on a FETCH_HEADER for an unknown Request ID', async () => {
    const { conn, transport } = await connected();
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    // No fetch() was issued for request 9 — the header must be rejected, not
    // silently decoded with a defaulted Ascending order.
    transport.pushIncomingUni(concat(fetchHeader(9n), firstFetchObj(1n, 0n, 3, [0xaa])));
    await flush();

    expect(closeCode).toBe(0x3);
  });

  it('raises a protocol violation on an ascending group overflow', async () => {
    const { conn, transport } = await connected();
    let closeCode: number | undefined;
    conn.onClose = (code) => { closeCode = code; };

    const reqId = await issueFetch(conn);
    transport.pushIncomingUni(concat(
      fetchHeader(reqId),
      firstFetchObj((1n << 64n) - 1n, 0n, 3, [0xaa]), // group at 2^64-1
      pack(0x0cn, 0n, 0n, 1n, raw(0xbb)),             // ascending: +1 → overflow
    ));
    await flush();

    expect(closeCode).toBe(0x3);
  });
});

// ─── inbound PUBLISH (§10.10) ───────────────────────────────────────────

const publishBytes = (requestId: bigint, alias: bigint, name: string): Uint8Array =>
  codec18.encode({
    type: 'PUBLISH', requestId, trackNamespace: [new TextEncoder().encode('a')],
    trackName: new TextEncoder().encode(name), trackAlias: alias,
    parameters: new Map(), trackExtensions: new Map(),
  } as never);

describe('MoqtConnection(18) inbound PUBLISH (§10.10)', () => {
  it('an inbound bidi PUBLISH fires onPublish + onMessage and creates state', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const published: { requestId: bigint; trackAlias: bigint }[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onPublish = (p) => published.push({ requestId: p.requestId, trackAlias: p.trackAlias });

    transport.pushIncomingBidi().push(publishBytes(1n, 42n, 'vid'));
    await flush();

    expect(seen.some((m) => m.type === 'PUBLISH')).toBe(true);
    expect(published).toEqual([{ requestId: 1n, trackAlias: 42n }]);
  });

  it('acceptSubscribe writes REQUEST_OK on the inbound PUBLISH stream, not the control uni stream', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onPublish = (p) => { reqId = p.requestId; };

    const bidi = transport.pushIncomingBidi();
    bidi.push(publishBytes(1n, 42n, 'vid'));
    await flush();

    const controlBytesBefore = transport.uniOut[0]!.writtenBytes().length;
    await conn.acceptSubscribe(reqId, 42n);

    // REQUEST_OK (wire 0x07) was written on the inbound bidi stream.
    expect(bidi.writtenBytes()[0]).toBe(0x07);
    // Nothing extra written on the uni control stream.
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBytesBefore);
  });

  it('acceptSubscribe with Track Properties on an inbound PUBLISH throws, writing no response bytes and no side effects', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    const published: bigint[] = [];
    conn.onPublish = (p) => { reqId = p.requestId; published.push(p.requestId); };
    const bidi = transport.pushIncomingBidi();
    bidi.push(publishBytes(1n, 42n, 'vid'));
    await flush();
    expect(published).toEqual([1n]); // original inbound PUBLISH state only

    const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
    await expect(conn.acceptSubscribe(reqId, 42n, { trackProperties })).rejects.toThrow(/not valid on a PUBLISH acceptance/i);

    // No response written on the bidi stream, no FIN, no session close.
    expect(bidi.writtenBytes().length).toBe(0);
    expect(bidi.writeClosed).toBe(false);
    expect(transport.closeInfo).toBeUndefined();
    expect(published).toEqual([1n]); // no second onPublish / re-acceptance

    // A subsequent valid accept still succeeds (proves nothing was half-accepted).
    await conn.acceptSubscribe(reqId, 42n);
    expect(bidi.writtenBytes()[0]).toBe(0x07); // REQUEST_OK shorthand
  });

  it('rejectSubscribe writes REQUEST_ERROR on the inbound PUBLISH stream', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onPublish = (p) => { reqId = p.requestId; };

    const bidi = transport.pushIncomingBidi();
    bidi.push(publishBytes(1n, 42n, 'vid'));
    await flush();

    await conn.rejectSubscribe(reqId, varint(0x10n), 'no thanks');
    expect(bidi.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR wire type
  });

  it('peer data for the PUBLISH alias routes to the subscription onObject', async () => {
    const { conn, transport } = await connected();
    const objs: MoqtObject[] = [];
    conn.onPublish = (p) => { p.onObject = (o) => objs.push(o); };
    const generic: MoqtObject[] = [];
    conn.onObject = (_sid, o) => generic.push(o);

    const bidi = transport.pushIncomingBidi();
    bidi.push(publishBytes(1n, 7n, 'vid'));
    await flush();
    await conn.acceptSubscribe(1n, 7n);

    // A subgroup stream on the published alias (7n) reaches the publish onObject.
    transport.pushIncomingUni(concat(subgroupHeader(7n, 42n), subgroupObject(3n, [0xaa])));
    await flush();

    expect(objs.map((o) => o.objectId)).toEqual([3n]);
    expect(generic.length).toBe(0); // not delivered to the generic onObject
  });

  it('a duplicate Track Alias rejects the second PUBLISH: session closes, no second onPublish', async () => {
    const { conn, transport } = await connected();
    const published: bigint[] = [];
    conn.onPublish = (p) => { published.push(p.requestId); };

    transport.pushIncomingBidi().push(publishBytes(1n, 42n, 'vid'));
    await flush();
    // Second PUBLISH reuses alias 42 for a DIFFERENT track → DUPLICATE_TRACK_ALIAS.
    transport.pushIncomingBidi().push(publishBytes(3n, 42n, 'aud'));
    await flush();

    expect(published).toEqual([1n]); // only the first PUBLISH surfaced
    expect(transport.closeInfo).toBeDefined(); // DUPLICATE_TRACK_ALIAS closed the session
  });

  it('a wrong-parity Request ID rejects the PUBLISH with no onPublish and no alias routing', async () => {
    const { conn, transport } = await connected();
    let published = 0;
    const objs: MoqtObject[] = [];
    conn.onPublish = (p) => { published++; p.onObject = (o) => objs.push(o); };
    conn.onObject = () => { /* generic */ };

    // requestId 2n is EVEN = our (client) parity, not the peer's — invalid.
    transport.pushIncomingBidi().push(publishBytes(2n, 50n, 'vid'));
    await flush();

    expect(published).toBe(0);
    expect(transport.closeInfo).toBeDefined();
    // No alias binding happened: data on alias 50 does not reach a publish onObject.
    transport.pushIncomingUni(concat(subgroupHeader(50n, 1n), subgroupObject(0n, [0x01])));
    await flush();
    expect(objs.length).toBe(0);
  });

  it('a duplicate Request ID rejects the second PUBLISH with no second onPublish', async () => {
    const { conn, transport } = await connected();
    const published: bigint[] = [];
    conn.onPublish = (p) => { published.push(p.requestId); };

    transport.pushIncomingBidi().push(publishBytes(1n, 10n, 'vid'));
    await flush();
    // Same Request ID 1n again (different alias) → duplicate Request ID.
    transport.pushIncomingBidi().push(publishBytes(1n, 20n, 'aud'));
    await flush();

    expect(published).toEqual([1n]);
    expect(transport.closeInfo).toBeDefined(); // duplicate Request ID closed the session
  });

  it('an unsupported first inbound bidi opener closes the session (PROTOCOL_VIOLATION)', async () => {
    const { transport } = await connected();
    // NAMESPACE is a continuation message (§10.18), never a valid FIRST inbound
    // bidi message — the admitted openers are all request types. So it is a
    // protocol violation here.
    const namespaceBytes = codec18.encode({
      type: 'NAMESPACE', trackNamespaceSuffix: [new TextEncoder().encode('a')],
    } as never);
    transport.pushIncomingBidi().push(namespaceBytes);
    await flush();

    expect(transport.closeInfo?.closeCode).toBe(0x3);
  });
});

// ─── inbound PUBLISH lifecycle (§10.11 PUBLISH_DONE, §10.9 REQUEST_UPDATE) ──

const publishDoneBytes = (): Uint8Array =>
  codec18.encode({ type: 'PUBLISH_DONE', requestId: 0n, statusCode: varint(0n), streamCount: varint(0n), errorReason: 'done' } as never);
const reqOkBytes = (): Uint8Array =>
  codec18.encode({ type: 'REQUEST_OK', requestId: 0n, parameters: new Map() } as never);
const peerUpdateBytes = (updateId: bigint): Uint8Array =>
  codec18.encode({ type: 'REQUEST_UPDATE', requestId: updateId, parameters: new Map() } as never);

async function publishAccepted(): Promise<{ conn: MoqtConnection; transport: TransportSim; bidi: ReturnType<TransportSim['pushIncomingBidi']>; }> {
  const { conn, transport } = await connected();
  const bidi = transport.pushIncomingBidi();
  bidi.push(publishBytes(1n, 42n, 'vid'));
  await flush();
  await conn.acceptSubscribe(1n, 42n);
  return { conn, transport, bidi };
}

describe('MoqtConnection(18) inbound PUBLISH lifecycle', () => {
  it('PUBLISH_DONE is stamped with the original Request ID and surfaced to onMessage', async () => {
    const { conn, bidi } = await publishAccepted();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    bidi.push(publishDoneBytes());
    await flush();

    const done = seen.find((m) => m.type === 'PUBLISH_DONE') as { requestId?: bigint } | undefined;
    expect(done).toBeDefined();
    expect(done!.requestId).toBe(1n); // stamped from stream context
  });

  it('data still routes by alias AFTER PUBLISH_DONE (late streams allowed)', async () => {
    const { conn, transport, bidi } = await publishAccepted();
    const objs: MoqtObject[] = [];
    conn.onPublish = () => { /* already published */ };
    // Re-bind onObject via the publishAliasMaps entry from accept: use onObject on the IncomingPublish.
    // The first onPublish already fired; set onObject through a fresh subscribe is not possible, so we
    // rely on the alias binding staying alive. Push data and assert it reaches the bound publish.
    // (Bind onObject by re-publishing is not needed — the original IncomingPublish kept its onObject slot.)
    void objs;

    bidi.push(publishDoneBytes());
    await flush();

    // A late subgroup stream on the published alias still routes (alias kept).
    const delivered: MoqtObject[] = [];
    conn.onObject = (_sid, o) => delivered.push(o);
    transport.pushIncomingUni(concat(subgroupHeader(42n, 1n), subgroupObject(0n, [0x09])));
    await flush();
    // Not delivered to generic onObject because the alias is still claimed by the publish.
    expect(delivered.length).toBe(0);
  });

  it('a peer REQUEST_UPDATE is stamped with existingRequestId and answered on the same stream', async () => {
    const { conn, bidi } = await publishAccepted();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);
    const writtenBefore = bidi.writtenBytes().length;

    bidi.push(peerUpdateBytes(3n)); // peer's update, its own id 3
    await flush();

    const upd = seen.find((m) => m.type === 'REQUEST_UPDATE') as { existingRequestId?: bigint } | undefined;
    expect(upd?.existingRequestId).toBe(1n); // stamped original PUBLISH id
    // A response (REQUEST_OK) was written on the same stream.
    expect(bidi.writtenBytes().length).toBeGreaterThan(writtenBefore);
  });

  it('peer REQUEST_UPDATE: REQUEST_OK is written on the PUBLISH stream and NO uni control bytes are emitted', async () => {
    const { transport, bidi } = await publishAccepted();
    const writtenBefore = bidi.writtenBytes().length;
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;

    bidi.push(peerUpdateBytes(3n));
    await flush();

    // A response was written on the PUBLISH stream (REQUEST_OK wire type 0x07).
    const after = bidi.writtenBytes();
    expect(after.length).toBeGreaterThan(writtenBefore);
    expect(after[writtenBefore]).toBe(0x07);
    // Nothing was written on the uni control stream.
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
  });

  it('a peer REQUEST_UPDATE that the session rejects closes the session and writes no success response', async () => {
    const { transport, bidi } = await publishAccepted();
    const writtenBefore = bidi.writtenBytes().length;

    // Reuse the PUBLISH Request ID (1n) as the update id → DUPLICATE → close.
    bidi.push(peerUpdateBytes(1n));
    await flush();

    expect(transport.closeInfo).toBeDefined(); // session closed
    // No success REQUEST_OK was written for the rejected update.
    expect(bidi.writtenBytes().length).toBe(writtenBefore);
  });

  it('a local REQUEST_UPDATE is written on the inbound PUBLISH stream and resolves by update id', async () => {
    const { conn, bidi } = await publishAccepted();
    const acceptLen = bidi.writtenBytes().length;

    const p = conn.requestUpdate(1n, { forward: false });
    await flush();
    // REQUEST_UPDATE (0x02) was written on the inbound stream after the accept OK.
    expect(bidi.writtenBytes()[acceptLen]).toBe(0x02);

    bidi.push(reqOkBytes()); // publisher accepts the update
    const updateId = await p;
    expect(typeof updateId).toBe('bigint');
  });

  it('an unsolicited REQUEST_OK on the PUBLISH stream fails the stream (PROTOCOL_VIOLATION)', async () => {
    const { transport, bidi } = await publishAccepted();
    bidi.push(reqOkBytes()); // no local update pending → unsolicited
    await flush();
    expect(transport.closeInfo).toBeDefined();
  });

  it('a message after PUBLISH_DONE fails the stream (PROTOCOL_VIOLATION)', async () => {
    const { transport, bidi } = await publishAccepted();
    bidi.push(publishDoneBytes());
    bidi.push(peerUpdateBytes(3n)); // illegal: after PUBLISH_DONE
    await flush();
    expect(transport.closeInfo).toBeDefined();
  });
});

// ─── inbound SUBSCRIBE (§10.7) — we are the publisher ──────────────────────

const subscribeReqBytes = (reqId: bigint): Uint8Array =>
  codec18.encode({ type: 'SUBSCRIBE', requestId: reqId, trackNamespace: [new TextEncoder().encode('a')], trackName: new TextEncoder().encode('vid'), parameters: new Map() } as never);

describe('MoqtConnection(18) inbound SUBSCRIBE (§10.7)', () => {
  it('fires onSubscribe for an inbound bidi SUBSCRIBE; no uni control bytes emitted', async () => {
    const { conn, transport } = await connected();
    const subs: bigint[] = [];
    conn.onSubscribe = (rid) => subs.push(rid);
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;

    transport.pushIncomingBidi().push(subscribeReqBytes(1n));
    await flush();

    expect(subs).toEqual([1n]);
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
  });

  it('acceptSubscribe writes SUBSCRIBE_OK on the inbound SUBSCRIBE stream', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onSubscribe = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeReqBytes(1n));
    await flush();

    await conn.acceptSubscribe(reqId, 99n);
    expect(bidi.writtenBytes()[0]).toBe(0x04); // SUBSCRIBE_OK wire type
  });

  it('acceptSubscribe with Track Properties writes a SUBSCRIBE_OK that decodes with them', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onSubscribe = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeReqBytes(1n));
    await flush();

    const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
    await conn.acceptSubscribe(reqId, 99n, { trackProperties });
    const { message } = codec18.decode(bidi.writtenBytes(), 0) as { message: SubscribeOk };
    expect(message.type).toBe('SUBSCRIBE_OK');
    expect(message.trackProperties).toEqual(trackProperties);
  });

  it('rejectSubscribe writes REQUEST_ERROR on the inbound SUBSCRIBE stream', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onSubscribe = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeReqBytes(1n));
    await flush();

    await conn.rejectSubscribe(reqId, varint(0x1n), 'no');
    expect(bidi.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR wire type
  });

  it('keeps the stream open after SUBSCRIBE_OK so a peer REQUEST_UPDATE is answered there', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribe = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeReqBytes(1n));
    await flush();
    await conn.acceptSubscribe(1n, 99n);
    const before = bidi.writtenBytes().length;

    bidi.push(peerUpdateBytes(3n)); // subscriber updates the subscription
    await flush();

    // REQUEST_OK answered on the same stream.
    const after = bidi.writtenBytes();
    expect(after.length).toBeGreaterThan(before);
    expect(after[before]).toBe(0x07);
  });
});

describe('MoqtConnection(18) inbound request hardening', () => {
  it('a rejected PUBLISH fires onClose with the ACTUAL error code (DUPLICATE_TRACK_ALIAS 0x5, not 0x3)', async () => {
    const { conn, transport } = await connected();
    const closeCodes: (number | undefined)[] = [];
    conn.onClose = (code) => closeCodes.push(code);

    transport.pushIncomingBidi().push(publishBytes(1n, 42n, 'vid'));
    await flush();
    transport.pushIncomingBidi().push(publishBytes(3n, 42n, 'aud')); // duplicate alias
    await flush();

    expect(closeCodes).toContain(0x5); // DUPLICATE_TRACK_ALIAS, not PROTOCOL_VIOLATION
    expect(closeCodes).not.toContain(0x3);
  });

  it('local requestUpdate on an inbound SUBSCRIBE is rejected (not eligible for the inbound-stream path)', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribe = () => { /* observed */ };
    transport.pushIncomingBidi().push(subscribeReqBytes(1n));
    await flush();
    await conn.acceptSubscribe(1n, 99n);

    // We are the publisher of this subscription — we cannot REQUEST_UPDATE it.
    await expect(conn.requestUpdate(1n, { forward: false })).rejects.toThrow(/no open .*request stream/i);
  });
});

describe('MoqtConnection(18) publisher data send for accepted inbound SUBSCRIBE (§11)', () => {
  async function subscribed(alias: bigint): Promise<{ conn: MoqtConnection; transport: TransportSim }> {
    const { conn, transport } = await connected();
    conn.onSubscribe = () => { /* observed */ };
    transport.pushIncomingBidi().push(subscribeReqBytes(1n));
    await flush();
    await conn.acceptSubscribe(1n, alias);
    return { conn, transport };
  }

  it('openSubgroup + sendObject emit a d18 subgroup stream that decodes via the d18 decoder', async () => {
    const { conn, transport } = await subscribed(99n);

    const streamId = await conn.openSubgroup(varint(99n), varint(1n), varint(0n), { publisherPriority: 7 });
    await conn.sendObject(streamId, varint(0n), new Uint8Array([0xaa, 0xbb]));
    await conn.sendObject(streamId, varint(1n), new Uint8Array([0xcc]));

    // uniOut[0] is the SETUP control stream; the subgroup is the next uni stream.
    const written = transport.uniOut[1]!.writtenBytes();
    const { header, bytesRead } = decodeSubgroupHeader18(written, 0);
    expect(header.trackAlias).toBe(99n);
    expect(header.groupId).toBe(1n);
    expect(header.subgroupId).toBe(0n);
    expect(header.publisherPriority).toBe(7);

    const first = decodeSubgroupObject18(written, bytesRead, false, 0n, true);
    expect(first.object.objectId).toBe(0n);
    expect(first.object.payload).toEqual(new Uint8Array([0xaa, 0xbb]));
    const second = decodeSubgroupObject18(written, bytesRead + first.bytesRead, false, 0n, false);
    expect(second.object.objectId).toBe(1n); // 0 + delta(0) + 1
    expect(second.object.payload).toEqual(new Uint8Array([0xcc]));
  });

  it('sendDatagram emits a d18 OBJECT_DATAGRAM that decodes via the d18 decoder', async () => {
    const { conn, transport } = await subscribed(7n);

    await conn.sendDatagram(7n, 42n, 5n, new Uint8Array([0x01, 0x02]), { publisherPriority: 3 });

    expect(transport.sentDatagrams.length).toBe(1);
    const { datagram } = decodeObjectDatagram18(transport.sentDatagrams[0]!, 0);
    expect(datagram.trackAlias).toBe(7n);
    expect(datagram.groupId).toBe(42n);
    expect(datagram.objectId).toBe(5n);
    expect(datagram.publisherPriority).toBe(3);
    expect(datagram.payload).toEqual(new Uint8Array([0x01, 0x02]));
  });
});

describe('MoqtConnection(18) publisher data send — wide values + PUBLISH_DONE', () => {
  async function subscribedBidi(alias: bigint): Promise<{ conn: MoqtConnection; transport: TransportSim; bidi: ReturnType<TransportSim['pushIncomingBidi']> }> {
    const { conn, transport } = await connected();
    conn.onSubscribe = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeReqBytes(1n));
    await flush();
    await conn.acceptSubscribe(1n, alias);
    return { conn, transport, bidi };
  }

  it('emits subgroup data with alias/group/object above the QUIC range (vi64, full uint64)', async () => {
    const big = 1n << 63n;
    const { conn, transport } = await subscribedBidi(big);

    const streamId = await conn.openSubgroup(big, big + 1n, big + 2n, { publisherPriority: 1 });
    await conn.sendObject(streamId, big + 3n, new Uint8Array([0xaa]));

    const written = transport.uniOut[1]!.writtenBytes();
    const { header, bytesRead } = decodeSubgroupHeader18(written, 0);
    expect(header.trackAlias).toBe(big);
    expect(header.groupId).toBe(big + 1n);
    expect(header.subgroupId).toBe(big + 2n);
    const { object } = decodeSubgroupObject18(written, bytesRead, false, 0n, true);
    expect(object.objectId).toBe(big + 3n);
  });

  it('publishDone writes PUBLISH_DONE (0x0B) on the inbound SUBSCRIBE stream and no uni control bytes', async () => {
    const { conn, transport, bidi } = await subscribedBidi(99n);
    const acceptLen = bidi.writtenBytes().length;
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;

    await conn.publishDone(1n, varint(0n), 'done');

    // PUBLISH_DONE (wire type 0x0B) written on the SUBSCRIBE bidi stream...
    expect(bidi.writtenBytes()[acceptLen]).toBe(0x0b);
    // ...and the writable was FIN'd; nothing on the uni control stream.
    expect(bidi.writeClosed).toBe(true);
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
  });
});

// ─── inbound FETCH (§10.12) — we are the publisher, control-only ───────────

const fetchReqBytes = (reqId: bigint): Uint8Array =>
  codec18.encode({
    type: 'FETCH', requestId: reqId,
    fetch: { fetchType: 0x1, trackNamespace: [new TextEncoder().encode('a')], trackName: new TextEncoder().encode('vid'), startLocation: { group: 0n, object: 0n }, endLocation: { group: 9n, object: 0n } },
    parameters: new Map(),
  } as never);

describe('MoqtConnection(18) inbound FETCH (§10.12)', () => {
  it('fires onFetch for an inbound bidi FETCH; no uni control bytes emitted', async () => {
    const { conn, transport } = await connected();
    const fetches: bigint[] = [];
    conn.onFetch = (rid) => fetches.push(rid);
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;

    transport.pushIncomingBidi().push(fetchReqBytes(1n));
    await flush();

    expect(fetches).toEqual([1n]);
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
  });

  it('acceptFetch writes FETCH_OK (0x18) on the inbound FETCH stream, no uni-control write', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onFetch = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(fetchReqBytes(1n));
    await flush();
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;

    await conn.acceptFetch(reqId, { endOfTrack: 1, endLocation: { group: 9n, object: 4n } });

    expect(bidi.writtenBytes()[0]).toBe(0x18); // FETCH_OK wire type
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
  });

  it('acceptFetch with Track Properties writes a FETCH_OK that decodes with them', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onFetch = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(fetchReqBytes(1n));
    await flush();

    const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
    await conn.acceptFetch(reqId, { endLocation: { group: 9n, object: 0n }, trackProperties });
    const { message } = codec18.decode(bidi.writtenBytes(), 0) as { message: { type: string; trackProperties?: Map<bigint, unknown> } };
    expect(message.type).toBe('FETCH_OK');
    expect(message.trackProperties).toEqual(trackProperties);
  });

  it('rejectFetch writes REQUEST_ERROR (0x05) on the inbound FETCH stream', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onFetch = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(fetchReqBytes(1n));
    await flush();

    await conn.rejectFetch(reqId, varint(0x1n), 'no');
    expect(bidi.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR wire type
  });

  it('acceptFetch round-trips an End Location above the QUIC range (full uint64)', async () => {
    const { conn, transport } = await connected();
    const big = 1n << 63n;
    conn.onFetch = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(fetchReqBytes(1n));
    await flush();

    await conn.acceptFetch(1n, { endOfTrack: 0, endLocation: { group: big, object: big + 1n } });

    const { message } = codec18.decode(bidi.writtenBytes(), 0);
    expect(message.type).toBe('FETCH_OK');
    expect((message as { endLocation: { group: bigint; object: bigint } }).endLocation).toEqual({ group: big, object: big + 1n });
    expect((message as { requestId?: bigint }).requestId).toBeUndefined(); // no wire Request ID
  });

  it('a rejected/invalid FETCH leaks no bound context or onFetch callback', async () => {
    const { conn, transport } = await connected();
    let fetched = 0;
    conn.onFetch = () => { fetched++; };

    // Even Request ID is OUR (client) parity, not the peer's — invalid → close.
    transport.pushIncomingBidi().push(fetchReqBytes(2n));
    await flush();

    expect(fetched).toBe(0);
    expect(transport.closeInfo).toBeDefined();
    // No bound context: accepting that request throws (unknown incoming fetch).
    await expect(conn.acceptFetch(2n)).rejects.toThrow(/Unknown incoming fetch/i);
  });
});

describe('MoqtConnection(18) FETCH data send (§11.4.4)', () => {
  // FetchObject is a DecodedFetchItem with a `payload`; EOR has `nonExistent`.
  function decodeAll(written: Uint8Array, order: 'ascending' | 'descending') {
    const { header, bytesRead } = decodeFetchHeader18(written, 0);
    const items: any[] = [];
    let pos = bytesRead;
    let prior: any;
    let first = true;
    while (pos < written.length) {
      const r = decodeFetchObject18(written, pos, prior, first, order);
      items.push(r.item);
      prior = r.nextPrior;
      pos += r.bytesRead;
      first = false;
    }
    return { requestId: header.requestId, items };
  }

  it('inbound FETCH → acceptFetch → open/send/close emits FETCH data that decodes via the d18 decoder', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onFetch = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(fetchReqBytes(1n)); // no GROUP_ORDER param → ascending
    await flush();
    await conn.acceptFetch(reqId);

    const streamId = await conn.openFetchStream(reqId);
    await conn.sendFetchObject(streamId, { groupId: 10n, subgroupId: 0n, objectId: 5n, publisherPriority: 7, payload: new Uint8Array([0xaa]) });
    await conn.sendFetchObject(streamId, { groupId: 10n, subgroupId: 0n, objectId: 6n, publisherPriority: 7, payload: new Uint8Array([0xbb]) });
    await conn.sendFetchObject(streamId, { groupId: 13n, subgroupId: 0n, objectId: 0n, publisherPriority: 7, payload: new Uint8Array([0xcc]) }); // new group ascending
    await conn.sendFetchEndOfRange(streamId, true, 14n, 0n);
    await conn.closeFetchStream(streamId);

    // uniOut[0] = control SETUP; the fetch response stream is the next uni stream.
    const { requestId, items } = decodeAll(transport.uniOut[1]!.writtenBytes(), 'ascending');
    expect(requestId).toBe(1n);
    expect(items.map((i) => [i.groupId, i.objectId])).toEqual([[10n, 5n], [10n, 6n], [13n, 0n], [14n, 0n]]);
    expect(items[3].nonExistent).toBe(true); // End-of-Range marker
    expect(items[0].payload).toEqual(new Uint8Array([0xaa]));
  });

  it('the FETCH data API works BEFORE acceptFetch (object delivery may precede FETCH_OK)', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onFetch = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(fetchReqBytes(1n));
    await flush();

    // Send objects FIRST, accept LATER.
    const streamId = await conn.openFetchStream(reqId);
    await conn.sendFetchObject(streamId, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 9, payload: new Uint8Array([0x01]) });
    await conn.closeFetchStream(streamId);
    await conn.acceptFetch(reqId);

    const { items } = decodeAll(transport.uniOut[1]!.writtenBytes(), 'ascending');
    expect(items.map((i) => i.objectId)).toEqual([0n]);
    expect(bidi.writtenBytes()[0]).toBe(0x18); // FETCH_OK still went on the bidi stream
  });
});

// ─── inbound TRACK_STATUS (§10.14) + inbound PUBLISH_NAMESPACE (§10.15) ─────

const trackStatusReqBytes = (reqId: bigint): Uint8Array =>
  codec18.encode({
    type: 'TRACK_STATUS', requestId: reqId,
    trackNamespace: [new TextEncoder().encode('a')], trackName: new TextEncoder().encode('vid'),
    parameters: new Map(),
  } as never);

const publishNamespaceReqBytes = (reqId: bigint, nsStr = 'a'): Uint8Array =>
  codec18.encode({
    type: 'PUBLISH_NAMESPACE', requestId: reqId,
    trackNamespace: [new TextEncoder().encode(nsStr)], parameters: new Map(),
  } as never);

describe('MoqtConnection(18) inbound TRACK_STATUS (§10.14)', () => {
  it('fires onTrackStatus; accept writes REQUEST_OK on the bidi stream and FINs — no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onTrackStatus = (rid) => { reqId = rid; };
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const bidi = transport.pushIncomingBidi();
    bidi.push(trackStatusReqBytes(1n));
    await flush();
    expect(reqId).toBe(1n);
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore); // no control write on arrival

    await conn.acceptTrackStatus(reqId);
    expect(bidi.writtenBytes()[0]).toBe(0x07); // REQUEST_OK wire type, on the bidi stream
    expect(bidi.writeClosed).toBe(true); // one-shot → FIN
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore); // still no uni-control bytes
  });

  it('accept with Track Properties writes a TRACK_STATUS_OK carrying them on the bidi stream, FINs, no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onTrackStatus = (rid) => { reqId = rid; };
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const bidi = transport.pushIncomingBidi();
    bidi.push(trackStatusReqBytes(1n));
    await flush();

    // DEFAULT_PUBLISHER_PRIORITY (0x0E) = 3.
    const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
    await conn.acceptTrackStatus(reqId, { trackProperties });

    expect(bidi.writtenBytes()[0]).toBe(0x07); // REQUEST_OK on the bidi stream
    expect(bidi.writeClosed).toBe(true); // one-shot → FIN
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore); // no uni-control bytes

    // The written bytes decode back to a REQUEST_OK with the Track Properties.
    const { message } = codec18.decode(bidi.writtenBytes(), 0) as { message: RequestOk };
    expect(message.type).toBe('REQUEST_OK');
    expect(message.trackProperties).toEqual(trackProperties);
  });

  it('accept still works after the subscriber FINs its send side (one-shot half-close)', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onTrackStatus = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(trackStatusReqBytes(1n)).closeReadable(); // peer FINs after the one-shot request
    await flush();
    expect(reqId).toBe(1n);

    // We still owe exactly one response — accept must succeed and write it.
    await conn.acceptTrackStatus(reqId);
    expect(bidi.writtenBytes()[0]).toBe(0x07); // REQUEST_OK on the bidi stream
    expect(bidi.writeClosed).toBe(true);
    expect(transport.closeInfo).toBeUndefined();
  });

  it('reject writes REQUEST_ERROR on the bidi stream and FINs', async () => {
    const { conn, transport } = await connected();
    conn.onTrackStatus = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(trackStatusReqBytes(1n));
    await flush();

    await conn.rejectTrackStatus(1n, varint(0x1n), 'no');
    expect(bidi.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR wire type
    expect(bidi.writeClosed).toBe(true); // one-shot → FIN
  });

  it('a peer REQUEST_UPDATE on a TRACK_STATUS stream closes the session (PROTOCOL_VIOLATION)', async () => {
    const { conn, transport } = await connected();
    conn.onTrackStatus = () => { /* observed, not yet answered */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(trackStatusReqBytes(1n));
    await flush();

    bidi.push(peerUpdateBytes(3n)); // illegal on a one-shot TRACK_STATUS stream
    await flush();
    expect(transport.closeInfo?.closeCode).toBe(0x3);
  });

  it('an invalid TRACK_STATUS (duplicate request id) leaks no bound context or callback', async () => {
    const { conn, transport } = await connected();
    const seen: bigint[] = [];
    conn.onTrackStatus = (rid) => seen.push(rid);
    // request id 0 is even (client parity) — a server-role peer must use odd ids,
    // but here the peer is the client; reuse the same id twice to force a duplicate.
    transport.pushIncomingBidi().push(trackStatusReqBytes(1n));
    await flush();
    transport.pushIncomingBidi().push(trackStatusReqBytes(1n)); // duplicate request id
    await flush();
    // The first bound; the duplicate is rejected (session close, INVALID_REQUEST_ID
    // 0x4), and no second callback fires.
    expect(seen).toEqual([1n]);
    expect(transport.closeInfo?.closeCode).toBe(0x4);
  });
});

describe('MoqtConnection(18) inbound PUBLISH_NAMESPACE (§10.15)', () => {
  it('fires onPublishNamespace and writes REQUEST_OK on the same bidi stream — no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onPublishNamespace = (rid) => { reqId = rid; };
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const bidi = transport.pushIncomingBidi();
    bidi.push(publishNamespaceReqBytes(1n));
    await flush();

    expect(reqId).toBe(1n);
    expect(bidi.writtenBytes()[0]).toBe(0x07); // REQUEST_OK on the bidi stream
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore); // no uni-control bytes
  });

  it('keeps the request stream OPEN after REQUEST_OK (not one-shot)', async () => {
    const { conn, transport } = await connected();
    conn.onPublishNamespace = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(publishNamespaceReqBytes(1n));
    await flush();
    expect(bidi.writeClosed).toBe(false); // stream stays open for REQUEST_UPDATE / withdrawal
  });

  it('a peer REQUEST_UPDATE is stamped to the original request and answered on the same stream', async () => {
    const { conn, transport } = await connected();
    conn.onPublishNamespace = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(publishNamespaceReqBytes(1n));
    await flush();
    const before = bidi.writtenBytes().length; // after REQUEST_OK

    bidi.push(peerUpdateBytes(3n)); // update id 3, existing = original PUBLISH_NAMESPACE (1)
    await flush();

    const after = bidi.writtenBytes();
    expect(after.length).toBeGreaterThan(before); // REQUEST_OK answered on the same stream
    expect(after[before]).toBe(0x07);
    expect(transport.closeInfo).toBeUndefined(); // valid update → no session close
  });

  it('a FIN on the inbound PUBLISH_NAMESPACE stream withdraws it (fires onPublishNamespaceClosed)', async () => {
    const { conn, transport } = await connected();
    conn.onPublishNamespace = () => { /* observed */ };
    const closed: bigint[] = [];
    conn.onPublishNamespaceClosed = (rid) => closed.push(rid);
    const bidi = transport.pushIncomingBidi();
    bidi.push(publishNamespaceReqBytes(1n));
    await flush();

    bidi.closeReadable(); // peer FINs → withdrawal (§3.3.2)
    await flush();
    expect(closed).toEqual([1n]);
    expect(transport.closeInfo).toBeUndefined(); // a FIN here is withdrawal, not an error
  });

  it('a peer RESET on the inbound PUBLISH_NAMESPACE stream withdraws it without surfacing an error', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onPublishNamespace = () => { /* observed */ };
    conn.onError = (e) => errors.push(e);
    const closed: bigint[] = [];
    conn.onPublishNamespaceClosed = (rid) => closed.push(rid);
    const bidi = transport.pushIncomingBidi();
    bidi.push(publishNamespaceReqBytes(1n));
    await flush();

    bidi.resetReadable('peer reset'); // peer resets → withdrawal
    await flush();
    expect(closed).toEqual([1n]);
    expect(errors).toEqual([]); // reset is the §3.3.2 withdrawal mechanism, not an error
  });
});

// ─── inbound SUBSCRIBE_NAMESPACE (continuing, §10.18) ───────────────────────

const subscribeNamespaceReqBytes = (reqId: bigint, prefix: string[] = ['a']): Uint8Array =>
  codec18.encode({
    type: 'SUBSCRIBE_NAMESPACE', requestId: reqId,
    trackNamespacePrefix: prefix.map((s) => new TextEncoder().encode(s)),
    parameters: new Map(),
  } as never);

describe('MoqtConnection(18) inbound SUBSCRIBE_NAMESPACE (§10.18)', () => {
  it('fires onSubscribeNamespace after validation; no auto-ack (no uni-control, nothing on the bidi yet)', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onSubscribeNamespace = (rid) => { reqId = rid; };
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n));
    await flush();

    expect(reqId).toBe(1n);
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore); // no uni-control
    expect(bidi.writtenBytes().length).toBe(0); // no response until the app accepts/rejects
  });

  it('accept writes REQUEST_OK on the bidi stream and keeps it open; no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed */ };
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n));
    await flush();

    await conn.acceptSubscribeNamespace(1n);
    expect(bidi.writtenBytes()[0]).toBe(0x07); // REQUEST_OK
    expect(bidi.writeClosed).toBe(false); // continuing — stays open
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
  });

  it('reject writes REQUEST_ERROR on the bidi stream and FINs', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n));
    await flush();

    await conn.rejectSubscribeNamespace(1n, varint(0x1n), 'no');
    expect(bidi.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR
    expect(bidi.writeClosed).toBe(true); // FIN after rejection
  });

  it('sendNamespace writes NAMESPACE on the same stream after accept', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n));
    await flush();
    await conn.acceptSubscribeNamespace(1n);
    const afterOk = bidi.writtenBytes().length;

    await conn.sendNamespace(1n, [new TextEncoder().encode('s1')]);
    const after = bidi.writtenBytes();
    expect(after.length).toBeGreaterThan(afterOk);
    expect(after[afterOk]).toBe(0x08); // NAMESPACE
    expect(bidi.writeClosed).toBe(false);
  });

  it('sendNamespaceDone writes NAMESPACE_DONE on the same stream and does NOT close/seal', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n));
    await flush();
    await conn.acceptSubscribeNamespace(1n);
    await conn.sendNamespace(1n, [new TextEncoder().encode('s1')]);
    const before = bidi.writtenBytes().length;

    await conn.sendNamespaceDone(1n, [new TextEncoder().encode('s1')]);
    const after = bidi.writtenBytes();
    expect(after[before]).toBe(0x0e); // NAMESPACE_DONE
    expect(bidi.writeClosed).toBe(false); // per-suffix — stream stays open

    // The stream is still usable: another NAMESPACE follows fine.
    await conn.sendNamespace(1n, [new TextEncoder().encode('s2')]);
    expect(bidi.writtenBytes().length).toBeGreaterThan(after.length);
  });

  it('peer FIN cancels: removes state + context without onError (fires onSubscribeNamespaceClosed)', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed */ };
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);
    const closed: bigint[] = [];
    conn.onSubscribeNamespaceClosed = (rid) => closed.push(rid);
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n));
    await flush();
    await conn.acceptSubscribeNamespace(1n);

    bidi.closeReadable(); // subscriber cancels
    await flush();
    expect(closed).toEqual([1n]);
    expect(errors).toEqual([]);
    // State gone — a follow-up send throws (unknown subscription).
    await expect(conn.sendNamespace(1n, [new TextEncoder().encode('s1')])).rejects.toThrow();
  });

  it('peer RESET cancels: removes state + context without onError', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed */ };
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);
    const closed: bigint[] = [];
    conn.onSubscribeNamespaceClosed = (rid) => closed.push(rid);
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n));
    await flush();
    await conn.acceptSubscribeNamespace(1n);

    bidi.resetReadable('peer reset');
    await flush();
    expect(closed).toEqual([1n]);
    expect(errors).toEqual([]);
  });

  it('an overlapping prefix is rejected with REQUEST_ERROR/PREFIX_OVERLAP, no second callback', async () => {
    const { conn, transport } = await connected();
    const seen: bigint[] = [];
    conn.onSubscribeNamespace = (rid) => seen.push(rid);

    transport.pushIncomingBidi().push(subscribeNamespaceReqBytes(1n, ['a']));
    await flush();
    const bidi2 = transport.pushIncomingBidi();
    bidi2.push(subscribeNamespaceReqBytes(3n, ['a', 'b'])); // 'a' is a prefix → overlap
    await flush();

    expect(seen).toEqual([1n]); // only the first bound + notified
    expect(bidi2.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR
    const { message } = codec18.decode(bidi2.writtenBytes(), 0) as { message: { errorCode: bigint } };
    expect(message.errorCode).toBe(0x30n); // PREFIX_OVERLAP
    expect(bidi2.writeClosed).toBe(true); // FIN after the immediate rejection
    expect(transport.closeInfo).toBeUndefined(); // overlap is a request failure, not a session close
  });

  it('a prefix with >32 fields closes the session with PROTOCOL_VIOLATION', async () => {
    const { conn, transport } = await connected();
    const seen: bigint[] = [];
    conn.onSubscribeNamespace = (rid) => seen.push(rid);

    const tooMany = Array.from({ length: 33 }, (_, i) => String.fromCharCode(0x61 + (i % 26)));
    transport.pushIncomingBidi().push(subscribeNamespaceReqBytes(1n, tooMany));
    await flush();

    expect(seen).toEqual([]); // no callback leak
    expect(transport.closeInfo?.closeCode).toBe(0x3); // PROTOCOL_VIOLATION
  });
});

// ─── inbound SUBSCRIBE_TRACKS (continuing, §10.19) ──────────────────────────

const subscribeTracksReqBytes = (reqId: bigint, prefix: string[] = ['a']): Uint8Array =>
  codec18.encode({
    type: 'SUBSCRIBE_TRACKS', requestId: reqId,
    trackNamespacePrefix: prefix.map((s) => new TextEncoder().encode(s)),
    parameters: new Map(),
  } as never);

describe('MoqtConnection(18) inbound SUBSCRIBE_TRACKS (§10.19)', () => {
  it('fires onSubscribeTracks after validation; no auto-ack (no uni-control, nothing on the bidi yet)', async () => {
    const { conn, transport } = await connected();
    let reqId = 0n;
    conn.onSubscribeTracks = (rid) => { reqId = rid; };
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();

    expect(reqId).toBe(1n);
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
    expect(bidi.writtenBytes().length).toBe(0);
  });

  it('accept writes REQUEST_OK on the bidi stream and keeps it open; no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed */ };
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();

    await conn.acceptSubscribeTracks(1n);
    expect(bidi.writtenBytes()[0]).toBe(0x07); // REQUEST_OK
    expect(bidi.writeClosed).toBe(false); // continuing — stays open
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore);
  });

  it('reject writes REQUEST_ERROR on the bidi stream and FINs', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();

    await conn.rejectSubscribeTracks(1n, varint(0x1n), 'no');
    expect(bidi.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR
    expect(bidi.writeClosed).toBe(true); // FIN after rejection
  });

  it('sendPublishBlocked writes PUBLISH_BLOCKED on the same stream after accept and keeps it open', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();
    await conn.acceptSubscribeTracks(1n);
    const afterOk = bidi.writtenBytes().length;

    await conn.sendPublishBlocked(1n, [new TextEncoder().encode('s1')], new TextEncoder().encode('vid'));
    const after = bidi.writtenBytes();
    expect(after.length).toBeGreaterThan(afterOk);
    expect(after[afterOk]).toBe(0x0f); // PUBLISH_BLOCKED
    expect(bidi.writeClosed).toBe(false);
  });

  it('sendPublishBlocked before accept is rejected by session state', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed, not yet accepted */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();

    await expect(
      conn.sendPublishBlocked(1n, [new TextEncoder().encode('s1')], new TextEncoder().encode('vid')),
    ).rejects.toThrow();
  });

  it('peer FIN cancels: removes state + context without onError (fires onSubscribeTracksClosed)', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed */ };
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);
    const closed: bigint[] = [];
    conn.onSubscribeTracksClosed = (rid) => closed.push(rid);
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();
    await conn.acceptSubscribeTracks(1n);

    bidi.closeReadable();
    await flush();
    expect(closed).toEqual([1n]);
    expect(errors).toEqual([]);
    await expect(
      conn.sendPublishBlocked(1n, [new TextEncoder().encode('s1')], new TextEncoder().encode('vid')),
    ).rejects.toThrow();
  });

  it('peer RESET cancels: removes state + context without onError', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed */ };
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);
    const closed: bigint[] = [];
    conn.onSubscribeTracksClosed = (rid) => closed.push(rid);
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();
    await conn.acceptSubscribeTracks(1n);

    bidi.resetReadable('peer reset');
    await flush();
    expect(closed).toEqual([1n]);
    expect(errors).toEqual([]);
  });

  it('an overlapping prefix is rejected with REQUEST_ERROR/PREFIX_OVERLAP, no second callback', async () => {
    const { conn, transport } = await connected();
    const seen: bigint[] = [];
    conn.onSubscribeTracks = (rid) => seen.push(rid);

    transport.pushIncomingBidi().push(subscribeTracksReqBytes(1n, ['a']));
    await flush();
    const bidi2 = transport.pushIncomingBidi();
    bidi2.push(subscribeTracksReqBytes(3n, ['a', 'b'])); // 'a' is a prefix → overlap
    await flush();

    expect(seen).toEqual([1n]);
    expect(bidi2.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR
    const { message } = codec18.decode(bidi2.writtenBytes(), 0) as { message: { errorCode: bigint } };
    expect(message.errorCode).toBe(0x30n); // PREFIX_OVERLAP
    expect(bidi2.writeClosed).toBe(true);
    expect(transport.closeInfo).toBeUndefined();
  });

  it('a prefix overlapping an existing SUBSCRIBE_NAMESPACE is ALLOWED (different request space)', async () => {
    const { conn, transport } = await connected();
    const nsSeen: bigint[] = [];
    const trSeen: bigint[] = [];
    conn.onSubscribeNamespace = (rid) => nsSeen.push(rid);
    conn.onSubscribeTracks = (rid) => trSeen.push(rid);

    transport.pushIncomingBidi().push(subscribeNamespaceReqBytes(1n, ['a']));
    await flush();
    await conn.acceptSubscribeNamespace(1n);

    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(3n, ['a'])); // same prefix, different request type
    await flush();

    expect(nsSeen).toEqual([1n]);
    expect(trSeen).toEqual([3n]); // accepted, not rejected for overlap
    expect(bidi.writtenBytes().length).toBe(0); // pending — no auto-ack, no REQUEST_ERROR
  });

  it('a prefix with >32 fields closes the session with PROTOCOL_VIOLATION', async () => {
    const { conn, transport } = await connected();
    const seen: bigint[] = [];
    conn.onSubscribeTracks = (rid) => seen.push(rid);

    const tooMany = Array.from({ length: 33 }, (_, i) => String.fromCharCode(0x61 + (i % 26)));
    transport.pushIncomingBidi().push(subscribeTracksReqBytes(1n, tooMany));
    await flush();

    expect(seen).toEqual([]);
    expect(transport.closeInfo?.closeCode).toBe(0x3);
  });
});

// ─── outbound PUBLISH creation/fanout (§10.10) ──────────────────────────────

const pubErrBytes = (): Uint8Array =>
  codec18.encode({ type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(1n), retryInterval: varint(0n), errorReason: 'denied' } as never);

describe('MoqtConnection(18) outbound PUBLISH (§10.10)', () => {
  it('publish() opens a new bidi stream and writes PUBLISH (0x1d); no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;

    const requestId = await conn.publish(ns('a'), nm('vid'), 42n);
    expect(typeof requestId).toBe('bigint');
    expect(transport.bidi.length).toBe(1);
    expect(transport.bidi[0]!.writtenBytes()[0]).toBe(0x1d); // PUBLISH
    expect(transport.bidi[0]!.writeClosed).toBe(false); // stays open
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore); // control carried only SETUP
  });

  it('publish() with Track Properties writes a PUBLISH that decodes with them', async () => {
    const { conn, transport } = await connected();
    const trackProperties = new Map<bigint, (bigint | Uint8Array)[]>([[0x0en, [3n]]]);
    await conn.publish(ns('a'), nm('vid'), 42n, { trackProperties });
    const { message } = codec18.decode(transport.bidi[0]!.writtenBytes(), 0) as { message: { type: string; trackProperties?: Map<bigint, unknown> } };
    expect(message.type).toBe('PUBLISH');
    expect(message.trackProperties).toEqual(trackProperties);
  });

  it('REQUEST_OK on the PUBLISH stream is stamped to the publish requestId and keeps the stream open', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    conn.onMessage = (m) => seen.push(m);

    const requestId = await conn.publish(ns('a'), nm('vid'), 42n);
    transport.bidi[0]!.push(reqOkBytes()); // accept (PUBLISH_OK shorthand)
    await flush();

    const ok = seen.find((m) => m.type === 'REQUEST_OK') as { requestId?: bigint } | undefined;
    expect(ok?.requestId).toBe(requestId); // stamped from stream context
    expect(transport.bidi[0]!.writeClosed).toBe(false); // open for data + PUBLISH_DONE
  });

  it('REQUEST_ERROR on the PUBLISH stream terminates only that publish (no session close)', async () => {
    const { conn, transport } = await connected();
    const seen: ControlMessage[] = [];
    const errors: Error[] = [];
    conn.onMessage = (m) => seen.push(m);
    conn.onError = (e) => errors.push(e);

    await conn.publish(ns('a'), nm('vid'), 42n);
    transport.bidi[0]!.push(pubErrBytes());
    await flush();

    expect(seen.some((m) => m.type === 'REQUEST_ERROR')).toBe(true);
    expect(transport.closeInfo).toBeUndefined(); // only this publish is rejected
    expect(errors).toEqual([]); // REQUEST_ERROR is a valid response, not a stream failure
  });

  it('objects MAY be sent before REQUEST_OK and use the PUBLISH track alias', async () => {
    const { conn, transport } = await connected();
    await conn.publish(ns('a'), nm('vid'), 77n);
    // No REQUEST_OK yet — send a subgroup object immediately.
    const sid = await conn.openSubgroup(77n, 3n, 0n, { publisherPriority: 5 });
    await conn.sendObject(sid, 0n, new Uint8Array([0xaa, 0xbb]));
    await conn.closeSubgroup(sid);

    // uniOut[0] = control SETUP; the subgroup data stream is the next uni stream.
    const { header } = decodeSubgroupHeader18(transport.uniOut[1]!.writtenBytes(), 0);
    expect(header.trackAlias).toBe(77n);
    expect(header.groupId).toBe(3n);
  });

  it('publishDone() writes PUBLISH_DONE (0x0b) on the PUBLISH stream, FINs it, no uni-control bytes', async () => {
    const { conn, transport } = await connected();
    const requestId = await conn.publish(ns('a'), nm('vid'), 42n);
    transport.bidi[0]!.push(reqOkBytes()); // establish first
    await flush();
    const controlBefore = transport.uniOut[0]!.writtenBytes().length;
    const beforeDone = transport.bidi[0]!.writtenBytes().length;

    await conn.publishDone(requestId, varint(0n), 'done');

    const after = transport.bidi[0]!.writtenBytes();
    expect(after[beforeDone]).toBe(0x0b); // PUBLISH_DONE on the same bidi stream
    expect(transport.bidi[0]!.writeClosed).toBe(true); // FIN
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlBefore); // no uni-control bytes
  });

  it('a peer REQUEST_UPDATE the session rejects closes the connection and writes no REQUEST_OK', async () => {
    const { conn, transport } = await connected();
    await conn.publish(ns('a'), nm('vid'), 9n);
    transport.bidi[0]!.push(reqOkBytes()); // establish
    await flush();
    const beforeLen = transport.bidi[0]!.writtenBytes().length;

    // REQUEST_UPDATE with an EVEN update id — wrong parity for a peer (server is
    // odd) → INVALID_REQUEST_ID, so the session closes the connection.
    transport.bidi[0]!.push(codec18.encode({ type: 'REQUEST_UPDATE', requestId: 2n, parameters: new Map() } as never));
    await flush();

    expect(transport.closeInfo).toBeDefined(); // session closed
    expect(transport.bidi[0]!.writtenBytes().length).toBe(beforeLen); // no REQUEST_OK written
  });
});

// ─── end-to-end integration (cross-stream, multi-step) ──────────────────────
//
// These chain the full draft-18 sequences through the public adapter + topology
// + session seams (peer simulated deterministically via the codec / decoders),
// asserting the cross-stream invariants that independently-green unit slices do
// not: control-stream non-leakage, request/data stream ownership, and correct
// correlation across the control-response → data seam.

describe('MoqtConnection(18) E2E — subscriber happy path', () => {
  it('SUBSCRIBE → SUBSCRIBE_OK → subgroup data reaches the per-subscription callback; no control-stream leak', async () => {
    const { conn, transport } = await connected();
    const controlAfterSetup = transport.uniOut[0]!.writtenBytes().length;

    const recv: MoqtObject[] = [];
    const subP = conn.subscribeTrack(ns('live'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flush();

    // Ownership: the SUBSCRIBE rode its OWN bidi request stream (not control).
    expect(transport.bidi.length).toBe(1);
    expect(codec18.decode(transport.bidi[0]!.writtenBytes(), 0).message.type).toBe('SUBSCRIBE');

    // Publisher accepts on that same stream → binds alias 9n.
    transport.bidi[0]!.push(okBytes(9n));
    const sub = await subP;
    expect(sub.trackAlias).toBe(9n);

    // Publisher sends subgroup data on a separate incoming uni stream for alias 9n.
    transport.pushIncomingUni(concat(subgroupHeader(9n, 7n), subgroupObject(0n, [0x01, 0x02])));
    await flush();

    // Delivered through the per-subscription callback, fully decoded.
    expect(recv.length).toBe(1);
    expect(recv[0]!.trackAlias).toBe(9n);
    expect(recv[0]!.groupId).toBe(7n);
    if (recv[0]!.kind === 'data') expect(recv[0]!.payload).toEqual(new Uint8Array([0x01, 0x02]));

    // Cross-stream invariant: nothing leaked onto the uni control stream post-SETUP.
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlAfterSetup);
    // Ownership stays sane: exactly one outbound bidi (the SUBSCRIBE request stream).
    expect(transport.bidi.length).toBe(1);
  });
});

describe('MoqtConnection(18) E2E — outbound PUBLISH happy path', () => {
  it('PUBLISH → REQUEST_OK → subgroup + datagram data → PUBLISH_DONE FINs the stream; no control-stream leak', async () => {
    const { conn, transport } = await connected();
    const controlAfterSetup = transport.uniOut[0]!.writtenBytes().length;

    const requestId = await conn.publish(ns('live'), nm('vid'), 55n);
    expect(transport.bidi.length).toBe(1);
    expect(codec18.decode(transport.bidi[0]!.writtenBytes(), 0).message.type).toBe('PUBLISH');

    // Peer accepts (PUBLISH_OK shorthand) on the same stream.
    transport.bidi[0]!.push(reqOkBytes());
    await flush();
    expect(transport.bidi[0]!.writeClosed).toBe(false); // stays open for data + PUBLISH_DONE

    // Publisher streams a subgroup object and a datagram using the advertised alias.
    const sid = await conn.openSubgroup(55n, 1n, 0n, { publisherPriority: 4 });
    await conn.sendObject(sid, 0n, new Uint8Array([0xa1]));
    await conn.closeSubgroup(sid);
    await conn.sendDatagram(55n, 1n, 1n, new Uint8Array([0xb2]), { publisherPriority: 4 });

    // A conforming subscriber decodes both off the data plane with the same alias.
    const { header } = decodeSubgroupHeader18(transport.uniOut[1]!.writtenBytes(), 0);
    expect(header.trackAlias).toBe(55n);
    const { datagram } = decodeObjectDatagram18(transport.sentDatagrams[0]!, 0);
    expect(datagram.trackAlias).toBe(55n);
    expect(datagram.objectId).toBe(1n);
    expect(datagram.payload).toEqual(new Uint8Array([0xb2]));

    // PUBLISH_DONE rides the PUBLISH stream and FINs it; no uni-control bytes.
    const beforeDone = transport.bidi[0]!.writtenBytes().length;
    await conn.publishDone(requestId, varint(0n), 'done');
    expect(transport.bidi[0]!.writtenBytes()[beforeDone]).toBe(0x0b); // PUBLISH_DONE
    expect(transport.bidi[0]!.writeClosed).toBe(true);
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlAfterSetup);
  });
});

describe('MoqtConnection(18) E2E — FETCH happy path', () => {
  it('inbound FETCH → acceptFetch (FETCH_OK same stream) → FETCH_HEADER + objects + EOR decode in order; no control leak', async () => {
    const { conn, transport } = await connected();
    const controlAfterSetup = transport.uniOut[0]!.writtenBytes().length;

    let reqId = 0n;
    conn.onFetch = (rid) => { reqId = rid; };
    const bidi = transport.pushIncomingBidi();
    bidi.push(fetchReqBytes(1n)); // ascending (no GROUP_ORDER param)
    await flush();
    expect(reqId).toBe(1n);

    await conn.acceptFetch(reqId);
    expect(bidi.writtenBytes()[0]).toBe(0x18); // FETCH_OK on the SAME bidi stream

    const sid = await conn.openFetchStream(reqId);
    await conn.sendFetchObject(sid, { groupId: 4n, subgroupId: 0n, objectId: 0n, publisherPriority: 6, payload: new Uint8Array([0xaa]) });
    await conn.sendFetchObject(sid, { groupId: 4n, subgroupId: 0n, objectId: 1n, publisherPriority: 6, payload: new Uint8Array([0xbb]) });
    await conn.sendFetchEndOfRange(sid, true, 5n, 0n);
    await conn.closeFetchStream(sid);

    // Receiver decodes the FETCH response stream: header, two objects, then EOR.
    const written = transport.uniOut[1]!.writtenBytes();
    const { header, bytesRead } = decodeFetchHeader18(written, 0);
    expect(header.requestId).toBe(1n);
    const items: any[] = [];
    let pos = bytesRead;
    let prior: any;
    let first = true;
    while (pos < written.length) {
      const r = decodeFetchObject18(written, pos, prior, first, 'ascending');
      items.push(r.item);
      prior = r.nextPrior;
      pos += r.bytesRead;
      first = false;
    }
    expect(items.map((i) => [i.groupId, i.objectId])).toEqual([[4n, 0n], [4n, 1n], [5n, 0n]]);
    expect(items[2].nonExistent).toBe(true); // End-of-Range marker (a gap, not an object)

    // No leakage onto the uni control stream throughout.
    expect(transport.uniOut[0]!.writtenBytes().length).toBe(controlAfterSetup);
  });

  it('a local FETCH cancel tears down the request stream without surfacing onError', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    const requestId = await conn.fetch(ns('a'), nm('1'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    expect(transport.bidi.length).toBe(1);

    await conn.fetchCancel(requestId);
    await flush();

    expect(transport.bidi[0]!.writeAborted).toBe(true); // RESET_STREAM
    expect(transport.bidi[0]!.readCancelled).toBe(true); // STOP_SENDING
    expect(errors).toEqual([]); // a local cancel is not a failure
  });
});

// ─── object-only Track Properties → malformed track (§2.4.2), not session close ──

const objOnly = () => new Map([[0x3cn, [1n]]]) as never; // a data-Object-only Property

describe('MoqtConnection(18) malformed track — object-only Track Properties (§2.4.2)', () => {
  it('SUBSCRIBE_OK with an object-only Property fails the subscription and RESETs its stream — no session close', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    const subP = conn.subscribeTrack(ns('a'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    const ok = codec18.encode({
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 9n, parameters: new Map(), trackExtensions: objOnly(),
    } as never);
    transport.bidi[0]!.push(ok);

    await expect(subP).rejects.toThrow(/Object-only|reset/i);
    await flush(); // let the request-stream RESET settle
    expect(transport.bidi[0]!.writeAborted).toBe(true);  // RESET_STREAM (request reset)
    expect(transport.bidi[0]!.readCancelled).toBe(true); // STOP_SENDING
    expect(transport.closeInfo).toBeUndefined();          // the TRACK failed, NOT the session
    expect(errors.some((e) => /Object-only|reset/i.test(e.message))).toBe(true);
  });

  it('FETCH_OK with an object-only Property resets the fetch stream — no session close', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    await conn.fetch(ns('a'), nm('1'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    const ok = codec18.encode({
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 0, endLocation: { group: 0n, object: 0n },
      parameters: new Map(), trackExtensions: objOnly(),
    } as never);
    transport.bidi[0]!.push(ok);
    await flush();

    expect(transport.bidi[0]!.writeAborted).toBe(true);
    expect(transport.closeInfo).toBeUndefined();
    expect(errors.some((e) => /Object-only|reset/i.test(e.message))).toBe(true);
  });

  it('inbound PUBLISH with an object-only Property is rejected with REQUEST_ERROR (no onPublish, no session close)', async () => {
    const { conn, transport } = await connected();
    let published = false;
    conn.onPublish = () => { published = true; };

    const pub = codec18.encode({
      type: 'PUBLISH', requestId: 1n, trackNamespace: ns('a'), trackName: nm('vid'), trackAlias: 42n,
      parameters: new Map(), trackExtensions: objOnly(),
    } as never);
    const bidi = transport.pushIncomingBidi();
    bidi.push(pub);
    await flush();

    expect(published).toBe(false);                 // never surfaced to the app
    expect(bidi.writtenBytes()[0]).toBe(0x05);     // REQUEST_ERROR on the PUBLISH stream
    expect(bidi.writeClosed).toBe(true);           // FIN after the rejection
    expect(transport.closeInfo).toBeUndefined();   // the REQUEST failed, NOT the session
  });
});

// ─── audit: deferred peer REQUEST_UPDATE guards + REDIRECT through subscribeTrack ──

describe('MoqtConnection(18) audit — peer REQUEST_UPDATE prefix changes on continuing inbound streams (§10.9.2)', () => {
  const prefixUpdateBytes = (updateId: bigint, fields: Uint8Array[]): Uint8Array =>
    codec18.encode({ type: 'REQUEST_UPDATE', requestId: updateId, parameters: new Map([[0x34n, [fields]]]) } as never);

  it('a peer REQUEST_UPDATE changes the prefix of an inbound SUBSCRIBE_NAMESPACE, answered on the same stream (no close)', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n, ['a']));
    await flush();
    await conn.acceptSubscribeNamespace(1n);

    bidi.push(prefixUpdateBytes(3n, [nm('a'), nm('b')]));
    await flush();
    expect(transport.closeInfo).toBeUndefined();
    expect(conn.session.getIncomingNamespaceSubscription(1n)!.namespacePrefix).toEqual([nm('a'), nm('b')]);
  });

  it('a peer REQUEST_UPDATE changes the prefix of an inbound SUBSCRIBE_TRACKS, answered on the same stream (no close)', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();
    await conn.acceptSubscribeTracks(1n);

    bidi.push(prefixUpdateBytes(3n, [nm('z')]));
    await flush();
    expect(transport.closeInfo).toBeUndefined();
    expect(conn.session.getIncomingTrackSubscription(1n)!.trackNamespacePrefix).toEqual([nm('z')]);
  });

  it('a REQUEST_UPDATE before acceptSubscribeNamespace closes the session (PROTOCOL_VIOLATION)', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeNamespace = () => { /* observed — but NOT accepted */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeNamespaceReqBytes(1n, ['a']));
    await flush();
    bidi.push(prefixUpdateBytes(3n, [nm('a'), nm('b')])); // before accept
    await flush();
    expect(transport.closeInfo?.closeCode).toBe(0x3);
  });

  it('a REQUEST_UPDATE before acceptSubscribeTracks closes the session (PROTOCOL_VIOLATION)', async () => {
    const { conn, transport } = await connected();
    conn.onSubscribeTracks = () => { /* observed — but NOT accepted */ };
    const bidi = transport.pushIncomingBidi();
    bidi.push(subscribeTracksReqBytes(1n));
    await flush();
    bidi.push(prefixUpdateBytes(3n, [nm('z')])); // before accept
    await flush();
    expect(transport.closeInfo?.closeCode).toBe(0x3);
  });
});

describe('MoqtConnection(18) audit — REDIRECT surfaces through subscribeTrack', () => {
  it('subscribeTrack receiving a REDIRECT rejects its promise (subscription torn down, no session close)', async () => {
    // For subscribeTrack the REQUEST_ERROR is consumed by the raw-subscription
    // resolver (promise rejection), not onMessage — the plain subscribe() path
    // (adapter-d18.test.ts) covers REDIRECT-via-onMessage. Here the subscription
    // is failed, not the session.
    const { conn, transport } = await connected();

    const subP = conn.subscribeTrack(ns('a'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    const redirectErr = codec18.encode({
      type: 'REQUEST_ERROR', requestId: 0n, errorCode: varint(0x34n), retryInterval: varint(0n), errorReason: 'moved',
      redirect: { connectUri: new TextEncoder().encode('https://r.example/moq'), trackNamespace: ns('a'), trackName: nm('vid') },
    } as never);
    transport.bidi[0]!.push(redirectErr).closeReadable();

    await expect(subP).rejects.toBeDefined();
    expect(transport.closeInfo).toBeUndefined(); // SUBSCRIBE is a valid REDIRECT context — no session close
  });
});

// ─── unsupported Mandatory Track Properties (§2.5.1) ───────────────────────

const mandatory = () => new Map([[0x4000n, [1n]]]) as never; // a Mandatory Track Property (0x4000..0x7FFF)

describe('MoqtConnection(18) unsupported Mandatory Track Property (§2.5.1)', () => {
  it('inbound PUBLISH is rejected with REQUEST_ERROR / UNSUPPORTED_EXTENSION (0x33), no onPublish, no session close', async () => {
    const { conn, transport } = await connected();
    let published = false;
    conn.onPublish = () => { published = true; };

    const pub = codec18.encode({
      type: 'PUBLISH', requestId: 1n, trackNamespace: ns('a'), trackName: nm('vid'), trackAlias: 42n,
      parameters: new Map(), trackProperties: mandatory(),
    } as never);
    const bidi = transport.pushIncomingBidi();
    bidi.push(pub);
    await flush();

    expect(published).toBe(false);
    expect(bidi.writtenBytes()[0]).toBe(0x05); // REQUEST_ERROR
    const { message } = codec18.decode(bidi.writtenBytes(), 0) as { message: { errorCode: bigint } };
    expect(message.errorCode).toBe(0x33n); // UNSUPPORTED_EXTENSION
    expect(bidi.writeClosed).toBe(true);
    expect(transport.closeInfo).toBeUndefined();
  });

  it('SUBSCRIBE_OK cancels the subscription (RESET) without closing the session', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    const subP = conn.subscribeTrack(ns('a'), nm('vid'), { onObject: () => { /* none */ } });
    await flush();
    transport.bidi[0]!.push(codec18.encode({
      type: 'SUBSCRIBE_OK', requestId: 0n, trackAlias: 9n, parameters: new Map(), trackProperties: mandatory(),
    } as never));

    await expect(subP).rejects.toBeDefined();
    await flush();
    expect(transport.bidi[0]!.writeAborted).toBe(true); // RESET the subscription (§3.3.2)
    expect(transport.closeInfo).toBeUndefined();
    expect(errors.some((e) => /Mandatory/i.test(e.message))).toBe(true);
  });

  it('FETCH_OK cancels the fetch (RESET) without closing the session', async () => {
    const { conn, transport } = await connected();
    const errors: Error[] = [];
    conn.onError = (e) => errors.push(e);

    await conn.fetch(ns('a'), nm('1'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    transport.bidi[0]!.push(codec18.encode({
      type: 'FETCH_OK', requestId: 0n, endOfTrack: 0, endLocation: { group: 0n, object: 0n },
      parameters: new Map(), trackProperties: mandatory(),
    } as never));
    await flush();

    expect(transport.bidi[0]!.writeAborted).toBe(true);
    expect(transport.closeInfo).toBeUndefined();
    expect(errors.some((e) => /Mandatory/i.test(e.message))).toBe(true);
  });
});

describe('MoqtConnection(18) outbound SUBSCRIBE peer-close (§11.4.1)', () => {
  it('a peer close of the SUBSCRIBE stream terminates the subscription; late data on its alias is NOT delivered', async () => {
    const { conn, transport } = await connected();
    const recv: MoqtObject[] = [];
    const subP = conn.subscribeTrack(ns('a'), nm('vid'), { onObject: (o) => recv.push(o) });
    await flush();
    transport.bidi[0]!.push(okBytes(9n)); // SUBSCRIBE_OK binds alias 9n (stream stays open)
    const sub = await subP;
    expect(sub.trackAlias).toBe(9n);

    // While the subscription is live, data on alias 9n reaches the per-sub callback.
    transport.pushIncomingUni(concat(subgroupHeader(9n, 1n), subgroupObject(0n, [0xaa])));
    await flush();
    expect(recv.length).toBe(1);

    // §11.4.1: a peer FIN of the SUBSCRIBE request stream terminates the subscription.
    transport.bidi[0]!.closeReadable();
    await flush();
    expect(conn.session.getSubscription(sub.requestId)).toBeUndefined(); // session state dropped
    expect(conn.session.getTrackByAlias(9n)).toBeUndefined();            // alias unregistered

    // Late data on the now-freed alias is NOT delivered to the terminated subscription.
    transport.pushIncomingUni(concat(subgroupHeader(9n, 2n), subgroupObject(0n, [0xbb])));
    await flush();
    expect(recv.length).toBe(1); // unchanged — no late delivery to a dead subscription
  });
});

describe('MoqtConnection(18) openSubgroup FIRST_OBJECT (§9.4.2)', () => {
  it('openSubgroup({ firstObject: true }) emits a header the peer decodes as FIRST_OBJECT (0x40 set)', async () => {
    const { conn, transport } = await connected();
    await conn.openSubgroup(7n, 42n, 3n, { publisherPriority: 5, firstObject: true });
    const bytes = transport.uniOut[1]!.writtenBytes(); // uniOut[0] = control stream
    expect((bytes[0]! & 0x40)).toBe(0x40); // FIRST_OBJECT bit set on the type byte
    const { header } = decodeSubgroupHeader18(bytes, 0);
    expect(header.isFirstObjectInSubgroup).toBe(true);
  });
  it('openSubgroup without firstObject does NOT set the FIRST_OBJECT bit (default)', async () => {
    const { conn, transport } = await connected();
    await conn.openSubgroup(7n, 42n, 3n, { publisherPriority: 5 });
    const bytes = transport.uniOut[1]!.writtenBytes();
    expect((bytes[0]! & 0x40)).toBe(0);
    const { header } = decodeSubgroupHeader18(bytes, 0);
    expect(header.isFirstObjectInSubgroup).toBe(false);
  });
  it('draft-16 openSubgroup with firstObject throws (draft-18-only option)', async () => {
    const conn = new MoqtConnection(16);
    await expect(conn.openSubgroup(7n, 1n, 0n, { firstObject: true })).rejects.toThrow(/draft-18-only/i);
  });
});
