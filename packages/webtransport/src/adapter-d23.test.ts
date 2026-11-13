/**
 * MoqtConnection at draft 23 over the in-memory loopback: a FETCH answered with
 * REQUEST_OK (§9.3), the draft-23 FETCH stream markers (§11.4.2) and the
 * draft-23 close codes (§12.2).
 */
import { describe, it, expect } from 'vitest';
import { MoqtConnection } from './adapter.js';
import { flush } from './testkit/loopback.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { TransportSim } from './testkit/stream-sim.js';
import { varint, createControlCodec } from '@openmoq/transport';
import type { ControlMessage, FetchOk, MoqtObject } from '@openmoq/transport';

const object = (groupId: bigint, objectId: bigint) => ({
  groupId, subgroupId: 0n, objectId, publisherPriority: 5, payload: new Uint8Array([0xaa]),
});

const setupBytes = (): Uint8Array => createControlCodec(23).encode({ type: 'SETUP', setupOptions: new Map() });

describe('MoqtConnection(23) negotiation', () => {
  it('connects with a varint-framed SETUP', async () => {
    const conn = new MoqtConnection(23);
    const transport = new TransportSim();
    transport.openIncomingUni().push(setupBytes());
    await conn.connect(transport);
    expect(conn.draftVersion).toBe(23);
    // SETUP 0x2F00 (also the control stream's type) with a one-byte vi64 Length
    // of 0; draft 22 writes a 16-bit Length.
    expect([...transport.uniOut[0]!.writtenBytes()]).toEqual([0xaf, 0x00, 0x00]);
  });

  it('a connection without an explicit draft adopts a negotiated moqt-23', async () => {
    const conn = new MoqtConnection();
    const transport = Object.assign(new TransportSim(), { protocol: 'moqt-23' });
    transport.openIncomingUni().push(setupBytes());
    await conn.connect(transport);
    expect(conn.draftVersion).toBe(23);
  });
});

describe('MoqtConnection(23) FETCH (§3.2, §9.3, §11.4)', () => {
  async function fetchPair(endGroup = 9n) {
    const pair = await connectedPair(23);
    let fetchReqId = -1n;
    pair.server.onFetch = (rid) => { fetchReqId = rid; };
    const seen: ControlMessage[] = [];
    pair.client.onMessage = (m) => seen.push(m);
    const recv: MoqtObject[] = [];
    pair.client.onObject = (_sid, o) => recv.push(o);
    const requestId = await pair.client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(endGroup), endObject: varint(0n),
    });
    await flush();
    return { ...pair, requestId, fetchReqId: () => fetchReqId, seen, recv };
  }

  it('the client sees a FETCH_OK ending at the LARGEST_OBJECT the server sent', async () => {
    const p = await fetchPair();
    await p.server.acceptFetch(p.fetchReqId(), { largestObject: { group: 4n, object: 2n } });
    await flush();
    const ok = p.seen.find((m) => m.type === 'FETCH_OK') as FetchOk | undefined;
    expect(ok).toMatchObject({ endLocation: { group: 4n, object: 2n }, endOfTrack: 0 });
    expect(ok!.parameters.get(0x09n)).toEqual([{ group: 4n, object: 2n }]);
    expect(p.errors).toEqual([]);
  });

  it('serves a whole FETCH end to end and reclaims both endpoints', async () => {
    const p = await fetchPair();
    await p.server.acceptFetch(p.fetchReqId(), { endLocation: { group: 2n, object: 0n } });
    const sid = await p.server.openFetchStream(p.fetchReqId());
    await p.server.sendFetchObject(sid, object(1n, 0n));
    await p.server.sendFetchObject(sid, object(1n, 3n));
    await p.server.sendFetchEndMarker(sid, 'end-of-group');
    await p.server.sendFetchEndOfRange(sid, 'gone', 2n, 0n);
    await p.server.closeFetchStream(sid);
    await flush();
    expect(p.recv.filter((o) => o.kind === 'data').map((o) => [o.groupId, o.objectId])).toEqual([[1n, 0n], [1n, 3n]]);
    const gaps = p.recv.filter((o) => o.kind === 'gap');
    // End of Group follows 1/3 as an END_OF_GROUP status at 1/4; a Gone range
    // never reads as non-existence.
    expect(gaps.map((o) => [o.groupId, o.objectId, o.kind === 'gap' ? o.status : undefined]))
      .toEqual([[1n, 4n, 0x3n], [2n, 0n, 0x0n]]);
    expect(p.client.session.getFetch(p.requestId)).toBeUndefined();
    expect(p.errors).toEqual([]);
  });

  it('End of Track arrives as an END_OF_TRACK gap', async () => {
    const p = await fetchPair();
    await p.server.acceptFetch(p.fetchReqId());
    const sid = await p.server.openFetchStream(p.fetchReqId());
    await p.server.sendFetchObject(sid, object(3n, 1n));
    await p.server.sendFetchEndMarker(sid, 'end-of-track');
    await p.server.closeFetchStream(sid);
    await flush();
    expect(p.recv.find((o) => o.kind === 'gap')).toMatchObject({ groupId: 3n, objectId: 2n, status: 0x4n });
    expect(p.errors).toEqual([]);
  });

  it('an End of Group before any Object is refused locally', async () => {
    const p = await fetchPair();
    await p.server.acceptFetch(p.fetchReqId());
    const sid = await p.server.openFetchStream(p.fetchReqId());
    await expect(p.server.sendFetchEndMarker(sid, 'end-of-group')).rejects.toThrow(/no Object/);
  });
});

describe('MoqtConnection(23) fill updates (§9.5, §9.19.15)', () => {
  it('keeps two pipelined fill updates separate instead of coalescing them', async () => {
    const { client, server, errors } = await connectedPair(23);
    const largest = { group: 5n, object: 0n };
    server.setLargestLocationProvider(() => largest);
    server.onSubscribe = (rid) => {
      void server.acceptSubscribe(rid, 7n, { parameters: new Map([[0x09n, [largest]]]) }).catch((e: Error) => errors.push(e));
    };
    const id = await client.subscribe(ns('live'), nm('vid'));
    await flush();
    const fill = { filter: { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n } } as const;
    const updates = await Promise.all([client.requestUpdate(id, { fill }), client.requestUpdate(id, { fill })]);
    await flush();
    expect(new Set(updates).size).toBe(2);
    // Each update keeps its own pending fill, so each gets its own fill stream.
    for (const update of updates) await expect(server.openFillStream(update)).resolves.toBeTypeOf('bigint');
    expect(errors).toEqual([]);
  });
});

describe('end markers before draft 23', () => {
  it('sendFetchEndMarker writes nothing on draft 22', async () => {
    const { client, server, errors } = await connectedPair(22);
    let fetchReqId = -1n;
    server.onFetch = (rid) => { fetchReqId = rid; };
    const recv: MoqtObject[] = [];
    client.onObject = (_sid, o) => recv.push(o);
    await client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    await flush();
    await server.acceptFetch(fetchReqId, { endLocation: { group: 1n, object: 0n } });
    const sid = await server.openFetchStream(fetchReqId);
    await server.sendFetchObject(sid, object(1n, 0n));
    await server.sendFetchEndMarker(sid, 'end-of-track');
    await server.closeFetchStream(sid);
    await flush();
    expect(recv.map((o) => o.kind)).toEqual(['data']);
    expect(errors).toEqual([]);
  });
});
