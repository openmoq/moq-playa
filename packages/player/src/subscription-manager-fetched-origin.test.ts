/** New delivery-origin contract, independently labelled from actual old-estimator causal reds. */
import { expect, it } from 'vitest';
import { varint } from '@openmoq/transport';
import { SubscriptionManager, type ObjectDeliveryOptions, type ObjectDeliveryAdmission } from './subscription-manager.js';

it.each(['loc', 'locmaf'] as const)('FETCH remains distinct from playback backfill through immediate/held %s admission', async packaging => {
  for (const held of [false, true]) {
    const manager = new SubscriptionManager(), source = {};
    manager.registerTrack(1n, 'v', 'video', packaging, { sourceConnection: source, namespace: ['live'] });
    const delivered: ObjectDeliveryOptions[] = [];
    if (packaging === 'loc') manager.onObject = (_role, _name, _object, _headers, _input, delivery) => { if (delivery) delivered.push(delivery); };
    else manager.onLocmafObject = (_role, _name, _object, _input, delivery) => { if (delivery) delivered.push(delivery); };
    let release!: (value: ObjectDeliveryAdmission) => void;
    const admission = new Promise<ObjectDeliveryAdmission>(resolve => { release = resolve; });
    const work = manager.routeObject(1n, { kind: 'data', trackAlias: varint(1n), groupId: varint(0n), subgroupId: varint(0n),
      objectId: varint(0n), publisherPriority: 128, payload: Uint8Array.of(1) }, 18, source, undefined,
    { fetched: true, backfill: false, ...(held ? { admission } : {}), isLive: () => true });
    if (held) { await Promise.resolve(); expect(delivered).toEqual([]); release({ kind: 'deliver', backfill: false, isLive: () => true }); }
    await work;
    expect(delivered).toHaveLength(1); expect(delivered[0]).toMatchObject({ fetched: true, backfill: false });
    expect(delivered[0]?.isLive?.()).toBe(true);
  }
});
