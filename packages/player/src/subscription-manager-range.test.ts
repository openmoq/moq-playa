import { expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { SubscriptionManager } from './subscription-manager.js';

const object = (group = 7n, id = 2n): MoqtObject => ({ kind: 'data', trackAlias: varint(1), groupId: varint(group),
  objectId: varint(id), subgroupId: varint(0), publisherPriority: 128, payload: Uint8Array.of(1) });

it.each(['loc', 'cmaf', 'locmaf'] as const)('bounds %s data by exact Location while terminal status still drains', async packaging => {
  const manager = new SubscriptionManager(), received = vi.fn(), discarded = vi.fn();
  manager.registerTrack(1n, 'video', 'video', packaging);
  manager.onObject = received; manager.onCmafObject = received; manager.onLocmafObject = received;
  manager.objectProvenance = { capture: () => ({}), discarded };
  const route = manager.captureRoute(1n);
  manager.setMinimumMediaLocation(1n, { groupId: 7n, objectId: 2n });
  await manager.routeObject(0n, object(6n, 99n)); await manager.routeObject(0n, object(7n, 1n));
  expect(received).not.toHaveBeenCalled(); expect(discarded).toHaveBeenCalledTimes(2);
  await manager.routeObject(0n, object()); await manager.routeObject(0n, object(8n, 0n));
  expect(received).toHaveBeenCalledTimes(2);
  await manager.routeObject(0n, { kind: 'gap', trackAlias: varint(1), groupId: varint(6), objectId: varint(0), subgroupId: varint(0), status: varint(4) });
  expect(received).toHaveBeenCalledTimes(3); expect(route?.()).toBe(true);
});

it('checks the current Location bound after an async transform without expiring the route or drain owner', async () => {
  const manager = new SubscriptionManager(), received = vi.fn(); manager.registerTrack(1n, 'video', 'video', 'cmaf');
  manager.onCmafObject = received;
  const route = manager.captureRoute(1n), idle = manager.captureTrackIdle(1n);
  let release!: () => void;
  manager.objectTransform = async value => { await new Promise<void>(resolve => { release = resolve; }); return value; };
  const pending = manager.routeObject(0n, object());
  const drained = vi.fn(), draining = idle()?.then(drained);
  manager.setMinimumMediaLocation(1n, { groupId: 8n, objectId: 0n });
  await Promise.resolve(); expect(drained).not.toHaveBeenCalled(); expect(route?.()).toBe(true);
  release(); await pending; await draining;
  expect(received).not.toHaveBeenCalled(); expect(drained).toHaveBeenCalledOnce();
});

it('copies the bound and clears it when a route is replaced or explicitly cleared for seek', async () => {
  const manager = new SubscriptionManager(), received = vi.fn(); manager.onCmafObject = received;
  manager.registerTrack(1n, 'old', 'video', 'cmaf');
  const location = { groupId: 8n, objectId: 0n };
  expect(manager.setMinimumMediaLocation(1n, location)).toBe(true); location.groupId = 0n;
  await manager.routeObject(0n, object()); expect(received).not.toHaveBeenCalled();
  manager.setMinimumMediaLocation(1n, undefined);
  await manager.routeObject(0n, object()); expect(received).toHaveBeenCalledOnce();
  manager.setMinimumMediaLocation(1n, { groupId: 8n, objectId: 0n });
  manager.registerTrack(1n, 'replacement', 'video', 'cmaf');
  await manager.routeObject(0n, object()); expect(received).toHaveBeenCalledTimes(2);
  manager.unregisterTrack(1n); expect(manager.setMinimumMediaLocation(1n, location)).toBe(false);
});

it.each(['init', 'mediatimeline', 'eventtimeline'] as const)('does not apply a media access point to %s retrieval', async packaging => {
  const manager = new SubscriptionManager(), received = vi.fn();
  manager.registerTrack(1n, 'metadata', packaging === 'init' ? 'video' : packaging, packaging);
  manager.onInitObject = received; manager.onTimelineObject = received; manager.onEventTimelineObject = received;
  manager.setMinimumMediaLocation(1n, { groupId: 8n, objectId: 0n });
  await manager.routeObject(0n, object()); expect(received).toHaveBeenCalledOnce();
});
