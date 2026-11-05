import { expect, it } from 'vitest';
import { SubscriptionManager } from './subscription-manager.js';

// Absence is an assertion failure during the additive API's red baseline.
function sourceKey(manager: SubscriptionManager, alias: bigint): unknown {
  const read: unknown = Reflect.get(manager, 'getSourceKey');
  return typeof read === 'function' ? Reflect.apply(read, manager, [alias]) : undefined;
}

it('caches the exact namespace fields and name independently from its source connection', () => {
  const manager = new SubscriptionManager(), namespace = ['live/show', 'x\u0000y'];
  manager.registerTrack(1n, 'video\u0000name', 'video', 'cmaf', { sourceConnection: {}, namespace });
  manager.registerTrack(2n, 'video\u0000name', 'video', 'cmaf', { sourceConnection: {}, namespace: ['live', 'show', 'x\u0000y'] });
  manager.registerTrack(3n, 'video\u0000name', 'video', 'cmaf', { sourceConnection: {}, namespace: [...namespace] });
  const expected = JSON.stringify([namespace, 'video\u0000name']);
  expect(sourceKey(manager, 1n)).toBe(expected); expect(sourceKey(manager, 2n)).not.toBe(expected);
  expect(sourceKey(manager, 3n)).toBe(expected);
  namespace[0] = 'mutated caller'; expect(sourceKey(manager, 1n)).toBe(expected);
});

it('uses a fresh identity after an alias is reassigned', () => {
  const manager = new SubscriptionManager();
  manager.registerTrack(1n, 'video', 'video', 'cmaf', { sourceConnection: {}, namespace: ['old'] });
  const before = sourceKey(manager, 1n); expect(before).toBe(JSON.stringify([['old'], 'video']));
  manager.registerTrack(1n, 'video', 'video', 'cmaf', { sourceConnection: {}, namespace: ['new'] });
  expect(sourceKey(manager, 1n)).toBe(JSON.stringify([['new'], 'video'])); expect(sourceKey(manager, 1n)).not.toBe(before);
  manager.unregisterTrack(1n); expect(sourceKey(manager, 1n)).toBeUndefined();
});

it('distinguishes an explicitly empty namespace from an unqualified legacy registration', () => {
  const manager = new SubscriptionManager();
  manager.registerTrack(1n, 'video', 'video', 'cmaf', { sourceConnection: {}, namespace: [] });
  manager.registerTrack(2n, 'video', 'video', 'cmaf');
  expect(sourceKey(manager, 1n)).toBe(JSON.stringify([[], 'video']));
  expect(sourceKey(manager, 2n)).toBeUndefined(); expect(sourceKey(manager, 999n)).toBeUndefined();
});

it('validates a new resolved identity before replacing an existing alias owner', () => {
  const manager = new SubscriptionManager();
  manager.registerTrack(1n, 'video', 'video', 'cmaf', { sourceConnection: {}, namespace: ['old'] });
  const owner = manager.captureRoute(1n), prior = sourceKey(manager, 1n);
  expect(() => manager.registerTrack(1n, 'video', 'video', 'cmaf', { sourceConnection: {}, namespace: ['\ud800'] })).toThrow(/UTF-8/);
  expect(sourceKey(manager, 1n)).toBe(prior); expect(owner?.()).toBe(true);
});
