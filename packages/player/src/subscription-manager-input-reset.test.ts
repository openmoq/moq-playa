import { expect, it, vi } from 'vitest';
import { varint, type MoqtObject } from '@openmoq/transport';
import { SubscriptionManager, type ObjectDeliveryAdmission } from './subscription-manager.js';

const object = (): MoqtObject => ({ kind: 'data', trackAlias: varint(1), groupId: varint(0),
  subgroupId: varint(0), objectId: varint(0), publisherPriority: 128, payload: Uint8Array.of(1), extensions: undefined });

it.each(['loc', 'locmaf', 'cmaf'] as const)('retires transformed %s inputs without retiring the subscription', async packaging => {
  const manager = new SubscriptionManager(); manager.registerTrack(1n, 'video', 'video', packaging);
  const owner = manager.captureRoute(1n), idle = manager.captureTrackIdle(1n), delivered = vi.fn(), discarded = vi.fn();
  manager.onObject = delivered; manager.onLocmafObject = delivered; manager.onCmafObject = delivered;
  manager.objectProvenance = { capture: () => ({}), discarded };
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  manager.objectTransform = async value => { await hold; return value; };
  const pending = manager.routeObject(0n, object());
  manager.invalidateMediaInputs();
  expect(owner?.()).toBe(true);
  const drained = vi.fn(); const drain = idle()?.then(drained);
  await Promise.resolve(); expect(drained).not.toHaveBeenCalled();
  release(); await pending; await drain;
  expect(delivered).not.toHaveBeenCalled(); expect(discarded).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 'route retired');
  expect(drained).toHaveBeenCalledOnce();
  await manager.routeObject(0n, object()); expect(delivered).toHaveBeenCalledOnce();
});

it('does not call a stale input transform after deferred admission', async () => {
  const manager = new SubscriptionManager(); manager.registerTrack(1n, 'video', 'video');
  const transform = vi.fn((value: MoqtObject) => value); manager.objectTransform = transform;
  let admit!: (value: ObjectDeliveryAdmission) => void;
  const admission = new Promise<ObjectDeliveryAdmission>(resolve => { admit = resolve; });
  const pending = manager.routeObject(0n, object(), 18, {}, undefined, { admission });
  manager.invalidateMediaInputs(); admit({ kind: 'deliver', backfill: false, isLive: () => true }); await pending;
  expect(transform).not.toHaveBeenCalled();
  await manager.routeObject(0n, object()); expect(transform).toHaveBeenCalledOnce();
});

it('does not turn a retired transform rejection into a malformed track', async () => {
  const manager = new SubscriptionManager(); manager.registerTrack(1n, 'video', 'video');
  const malformed = vi.fn(); manager.onMalformedTrack = malformed;
  let reject!: (reason: Error) => void;
  manager.objectTransform = () => new Promise((_resolve, fail) => { reject = fail; });
  const pending = manager.routeObject(0n, object()); manager.invalidateMediaInputs();
  reject(new Error('expired transform')); await pending;
  expect(malformed).not.toHaveBeenCalled(); expect(manager.captureRoute(1n)?.()).toBe(true);
});

it.each(['init', 'mediatimeline', 'eventtimeline'] as const)('keeps %s retrieval independent from media input resets', async packaging => {
  const manager = new SubscriptionManager();
  const type = packaging === 'init' ? 'video' : packaging;
  manager.registerTrack(1n, packaging, type, packaging);
  const delivered = vi.fn(); manager.onInitObject = delivered; manager.onTimelineObject = delivered; manager.onEventTimelineObject = delivered;
  manager.invalidateMediaInputs(); await manager.routeObject(0n, object());
  expect(delivered).toHaveBeenCalledOnce(); expect(manager.captureRoute(1n)?.()).toBe(true);
});
