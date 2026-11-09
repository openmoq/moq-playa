import { describe, expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { LocmafEncoder, LocmafGroupState, LocmafTrackDecoder, parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildInit, buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { SubscriptionManager, type ObjectDeliveryAdmission, type ObjectDeliveryOptions } from './subscription-manager.js';

const init = buildInit({ trackId: 11, timescale: 90000, handler: 'vide', trex: { duration: 3000, flags: SYNC_FLAGS } });
function data(id: bigint, group = 1n, alias = 1n, payload: Uint8Array = Uint8Array.of(1)): MoqtObject {
  return { kind: 'data', trackAlias: varint(alias), groupId: varint(group), subgroupId: varint(0n),
    objectId: varint(id), publisherPriority: 128, payload };
}
function chunks(count: number): MoqtObject[] {
  const context = parseLocmafTrackContext(init), state = new LocmafGroupState(), encoder = new LocmafEncoder();
  return Array.from({ length: count }, (_, index) => {
    const id = BigInt(index), chunk = buildChunk({ trackId: 11, bmdt: 90000n + id * 3000n,
      samples: [{ duration: 3000, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(1, 2, 3, index) });
    return data(id, 1n, 1n, serializeLocmafObject(encoder.encode(chunk, state, context, false, id)));
  });
}
function harness() {
  const manager = new SubscriptionManager(), source = {}, decoder = new LocmafTrackDecoder(init);
  const decoded: bigint[] = [], rejected: bigint[] = [];
  manager.registerTrack(1n, 'video', 'video', 'locmaf', { sourceConnection: source, namespace: ['live'] });
  manager.onLocmafObject = (_type, _name, object) => {
    if (object.kind !== 'data') return;
    const result = decoder.push(object.groupId, object.objectId, object.payload);
    (result.kind === 'chunk' ? decoded : rejected).push(object.objectId);
  };
  const send = (object: MoqtObject, delivery?: ObjectDeliveryOptions) => manager.routeObject(1n, object, 18, source, undefined, delivery);
  return { manager, source, decoder, decoded, rejected, send };
}

describe('replay ownership at stateful consumers', () => {

  it.each(['transform', 'admission'] as const)('subgroup reset retires %s work without retiring registration or its terminal barrier', async phase => {
    const h = harness(), objects = chunks(4); await h.send(objects[0]!);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const idle = h.manager.captureTrackIdle(1n, 1n), registration = h.manager.captureRoute(1n);
    let stale: Promise<void>;
    if (phase === 'transform') {
      h.manager.objectTransform = async object => { await gate; return object; };
      stale = h.send(objects[1]!);
    } else {
      stale = h.send(objects[1]!, { admission: gate.then((): ObjectDeliveryAdmission => ({ kind: 'deliver', isLive: () => true, backfill: false })) });
    }
    const drained = vi.fn(), barrier = idle()?.then(drained);
    h.manager.invalidateLocmafGroup(1n, 1n, h.source); h.decoder.resetGroup(1n);
    expect(registration?.()).toBe(true); await Promise.resolve(); expect(drained).not.toHaveBeenCalled();
    release(); await stale; await barrier; h.manager.objectTransform = null;
    for (const object of objects) await h.send(object);
    expect(drained).toHaveBeenCalledOnce();
    expect(h.decoded).toEqual([0n, 0n, 1n, 2n, 3n]); expect(h.rejected).toEqual([]);
  });

  it.each(['namespace', 'connection'] as const)('same locations in an independent %s retain their own history', async replacement => {
    const h = harness(), object = chunks(1)[0]!;
    await h.send(object); h.decoder.reset();
    const source = replacement === 'connection' ? {} : h.source;
    h.manager.registerTrack(1n, 'video', 'video', 'locmaf', { sourceConnection: source,
      namespace: replacement === 'namespace' ? ['different'] : ['live'] });
    await h.manager.routeObject(2n, object, 18, source);
    expect(h.decoded).toEqual([0n, 0n]);
  });



  it('does not confuse namespaces with the same slash-joined spelling', async () => {
    const manager = new SubscriptionManager(), source = {}, delivered: bigint[] = [];
    manager.onCmafObject = (_type, _name, object) => { delivered.push(object.trackAlias); };
    manager.registerTrack(1n, 'video', 'video', 'cmaf', { sourceConnection: source, namespace: ['live/show'] });
    manager.registerTrack(2n, 'video', 'video', 'cmaf', { sourceConnection: source, namespace: ['live', 'show'] });
    await manager.routeObject(1n, data(0n), 18, source); await manager.routeObject(2n, data(0n, 1n, 2n), 18, source);
    expect(delivered).toEqual([1n, 2n]);
  });


  it('an old source transform cannot suppress the replacement source at the same location', async () => {
    const h = harness(), object = chunks(1)[0]!;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    h.manager.objectTransform = async value => { await gate; return value; };
    const stale = h.send(object), next = {};
    h.manager.registerTrack(1n, 'video', 'video', 'locmaf', { sourceConnection: next, namespace: ['live'] });
    h.manager.objectTransform = null; await h.manager.routeObject(2n, object, 18, next);
    release(); await stale; expect(h.decoded).toEqual([0n]);
  });

  it('transform drops do not claim a location reached the consumer', async () => {
    const h = harness(), objects = chunks(2);
    h.manager.objectTransform = () => null; await h.send(objects[0]!);
    h.manager.objectTransform = null; for (const object of objects) await h.send(object);
    expect(h.decoded).toEqual([0n, 1n]);
  });


  it.each(['group', 'track', 'all'] as const)('consumer %s reset retires old admission and permits fresh immutable copies', async scope => {
    const h = harness(), objects = chunks(3); await h.send(objects[0]!);
    let admit!: (value: ObjectDeliveryAdmission) => void;
    const admission = new Promise<ObjectDeliveryAdmission>(resolve => { admit = resolve; });
    const stale = h.send(objects[1]!, { admission });
    h.manager.resetMediaConsumer(scope === 'all' ? undefined : 1n, scope === 'group' ? 1n : undefined);
    h.decoder.reset(); admit({ kind: 'deliver', isLive: () => true, backfill: false }); await stale;
    for (const object of objects) await h.send(object);
    expect(h.decoded).toEqual([0n, 0n, 1n, 2n]); expect(h.rejected).toEqual([]);
  });

  it('group reset does not cancel another group or source admission', async () => {
    const h = harness(), delivered: bigint[] = [];
    h.manager.onLocmafObject = (_type, _name, object) => { delivered.push(object.groupId); };
    let admit!: (value: ObjectDeliveryAdmission) => void;
    const admission = new Promise<ObjectDeliveryAdmission>(resolve => { admit = resolve; });
    const otherGroup = h.send(data(0n, 2n), { admission });
    const otherSource = h.manager.routeObject(2n, data(0n), 18, {}, undefined, { admission });
    h.manager.invalidateLocmafGroup(1n, 1n, h.source);
    admit({ kind: 'deliver', isLive: () => true, backfill: false }); await Promise.all([otherGroup, otherSource]);
    expect(delivered).toEqual([2n, 1n]);
  });


});
