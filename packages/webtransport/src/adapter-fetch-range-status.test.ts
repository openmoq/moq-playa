/**
 * A FETCH End of Non-Existent Range (0x8C) reaches `onObject` as a gap with the
 * non-existence status, never as END_OF_GROUP.
 *
 * draft-18 §11.4.4.2 / draft-22 §11.4.1.2: "All Objects with Locations between
 * the last serialized Object, if any, and this Location, inclusive, either do
 * not exist (0x8C) or are unknown (0x10C)". The range can span groups and says
 * nothing about where any group ends; End of Group (0x3) instead means no
 * object at or after the Location exists in that group.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ObjectStatus, varint, type MoqtObject, type Parameters } from '@openmoq/transport';
import type { MoqtConnection } from './adapter.js';
import { connectedPair, nm, ns, type ConnectedPair } from './testkit/pair.js';
import { flush } from './testkit/stream-sim.js';

const connections: MoqtConnection[] = [];
afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.close();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await flush();
}

async function pair(draft: 18 | 22): Promise<ConnectedPair & { recv: MoqtObject[] }> {
  const p = await connectedPair(draft);
  connections.push(p.client, p.server);
  const recv: MoqtObject[] = [];
  p.client.onObject = (_sid, o) => recv.push(o);
  return { ...p, recv };
}

const gaps = (recv: MoqtObject[]) => recv.filter(o => o.kind === 'gap')
  .map(o => ({ group: o.groupId, object: o.objectId, status: o.kind === 'gap' ? o.status : undefined }));

describe('FETCH End of Range → onObject gap status', () => {
  it.each([true, false])('draft-18: nonExistent=%s maps to OBJECT_DOES_NOT_EXIST / unknown, not END_OF_GROUP', async (nonExistent) => {
    const p = await pair(18);
    let fetchReqId = -1n;
    p.server.onFetch = (rid) => { fetchReqId = rid; };
    await p.client.fetch(ns('live'), nm('vid'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(9n), endObject: varint(0n),
    });
    await settle();
    await p.server.acceptFetch(fetchReqId, { endLocation: { group: 9n, object: 0n } });
    const sid = await p.server.openFetchStream(fetchReqId);
    await p.server.sendFetchObject(sid, { groupId: 1n, subgroupId: 0n, objectId: 0n, publisherPriority: 5, payload: new Uint8Array([0xaa]) });
    // Objects {1,1}..{1,3} do not exist; {1,4} follows in the same group.
    await p.server.sendFetchEndOfRange(sid, nonExistent, 1n, 3n);
    await p.server.sendFetchObject(sid, { groupId: 1n, subgroupId: 0n, objectId: 4n, publisherPriority: 5, payload: new Uint8Array([0xbb]) });
    await p.server.closeFetchStream(sid);
    await settle();

    expect(gaps(p.recv)).toEqual([{
      group: 1n, object: 3n, status: nonExistent ? ObjectStatus.OBJECT_DOES_NOT_EXIST : ObjectStatus.NORMAL,
    }]);
    expect(p.recv.filter(o => o.kind === 'data').map(o => o.objectId)).toEqual([0n, 4n]);
    expect(p.errors).toEqual([]);
  });

  it('draft-22: a fill stream End of Non-Existent Range maps to OBJECT_DOES_NOT_EXIST', async () => {
    const p = await pair(22);
    p.server.setLargestLocationProvider(() => ({ group: 5n, object: 0n }));
    p.server.onSubscribe = (requestId) => {
      const parameters: Parameters = new Map([[0x09n, [{ group: 5n, object: 0n }]]]);
      void p.server.acceptSubscribe(requestId, 50n, { parameters }).catch((err: Error) => p.errors.push(err));
    };
    const id = await p.client.subscribe(ns('live'), nm('video'), { fill: {} });
    await settle();
    const stream = await p.server.openFillStream(id);
    await p.server.sendFetchEndOfRange(stream, true, 5n, 0n);
    await p.server.closeFetchStream(stream);
    await settle();

    expect(gaps(p.recv)).toEqual([{ group: 5n, object: 0n, status: ObjectStatus.OBJECT_DOES_NOT_EXIST }]);
    expect(p.errors).toEqual([]);
  });
});
