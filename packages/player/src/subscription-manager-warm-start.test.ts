import { describe, expect, it, vi } from 'vitest';
import type { MoqtObject } from '@openmoq/transport';
import { SubscriptionManager } from './subscription-manager.js';
import type { ObjectDeliveryAdmission } from './subscription-manager.js';

const object: MoqtObject = { kind: 'data', trackAlias: 1n, groupId: 5n, subgroupId: 0n,
  objectId: 0n, payload: Uint8Array.of(1), publisherPriority: 128, extensions: undefined };
function fixture(packaging: 'cmaf' | 'locmaf' | 'loc') {
  const manager = new SubscriptionManager(), delivered = vi.fn(), malformed = vi.fn(), discarded = vi.fn(), context = {};
  manager.registerTrack(1n, 'video', 'video', packaging);
  manager.extensionParser = () => ({});
  manager.objectProvenance = { capture: () => context, discarded };
  manager.onCmafObject = delivered; manager.onLocmafObject = delivered; manager.onObject = delivered;
  manager.onMalformedTrack = malformed;
  return { manager, delivered, malformed, discarded, context };
}

describe.each(['cmaf', 'locmaf', 'loc'] as const)('warm-start delivery lifetime for %s', packaging => {
  it.each(['resolve', 'reject'] as const)('fences an expired delivery when its transform later %ss', async outcome => {
    const h = fixture(packaging); let release!: () => void, live = true;
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.manager.objectTransform = async value => { await pending; if (outcome === 'reject') throw new Error('late rejection'); return value; };
    const work = h.manager.routeObject(3n, object, 18, {}, undefined, { isLive: () => live });
    live = false; release(); await work;
    expect.soft(h.delivered).not.toHaveBeenCalled();
    expect.soft(h.malformed).not.toHaveBeenCalled();
    expect(h.discarded).toHaveBeenCalledExactlyOnceWith(h.context, 'route retired');
  });
  it('refuses an already expired operation before invoking its transform', async () => {
    const h = fixture(packaging), transform = vi.fn(value => value); h.manager.objectTransform = transform;
    await h.manager.routeObject(3n, object, 18, {}, undefined, { isLive: () => false });
    expect.soft(transform).not.toHaveBeenCalled(); expect(h.delivered).not.toHaveBeenCalled();
    expect(h.discarded).toHaveBeenCalledExactlyOnceWith(h.context, 'route retired');
  });
  it('preserves ordinary delivery and transform errors for the current operation', async () => {
    const h = fixture(packaging);
    await h.manager.routeObject(3n, object, 18, {});
    expect(h.delivered).toHaveBeenCalledOnce(); expect(h.discarded).not.toHaveBeenCalled();
    h.manager.objectTransform = () => { throw new Error('current failure'); };
    await h.manager.routeObject(3n, object, 18, {}, undefined, { isLive: () => true });
    expect(h.malformed).toHaveBeenCalledOnce();
    expect(h.discarded).toHaveBeenCalledExactlyOnceWith(h.context, 'object processing failed');
  });
});


function permission() {
  let resolve!: (result: ObjectDeliveryAdmission) => void;
  const promise = new Promise<ObjectDeliveryAdmission>(done => { resolve = done; });
  return { promise, resolve };
}
const allowed = { kind: 'deliver' as const, isLive: () => true, backfill: true };

describe('warm-start admission observation', () => {
  it('keeps the admission lifetime when an observer is reassigned before delivery', async () => {
    const h = fixture('cmaf'), capture = vi.fn(() => h.context), observer = { capture, discarded: h.discarded }, gate = permission();
    h.manager.objectProvenance = observer;
    const work = h.manager.routeObject(3n, object, 18, {}, object, { admission: gate.promise });
    expect(capture).toHaveBeenCalledOnce(); expect(h.delivered).not.toHaveBeenCalled();
    h.manager.objectProvenance = null; h.manager.objectProvenance = observer;
    gate.resolve(allowed); await work;
    expect(capture).toHaveBeenCalledOnce();
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith('video', 'video', object, undefined, allowed);
    expect(h.discarded).not.toHaveBeenCalled();
  });
  it('does not invent an observation for an input admitted before attachment', async () => {
    const h = fixture('cmaf'), gate = permission(); h.manager.objectProvenance = null;
    const work = h.manager.routeObject(3n, object, 18, {}, object, { admission: gate.promise });
    const capture = vi.fn(() => h.context); h.manager.objectProvenance = { capture, discarded: h.discarded };
    gate.resolve(allowed); await work;
    expect(capture).not.toHaveBeenCalled();
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith('video', 'video', object, undefined, allowed);
  });
  it('captures the receipt before staging and resolves a refusal without a transform', async () => {
    const h = fixture('cmaf'), source = {}, capture = vi.fn(() => h.context), gate = permission(), transform = vi.fn(value => value);
    h.manager.objectProvenance = { capture, discarded: h.discarded }; h.manager.objectTransform = transform;
    const work = h.manager.routeObject(3n, object, 18, source, object, { admission: gate.promise });
    expect(capture).toHaveBeenCalledExactlyOnceWith(source, object); expect(transform).not.toHaveBeenCalled();
    gate.resolve({ kind: 'discard', reason: 'warm start incomplete' }); await work;
    expect(h.discarded).toHaveBeenCalledExactlyOnceWith(h.context, 'warm start incomplete');
    expect(h.delivered).not.toHaveBeenCalled(); expect(transform).not.toHaveBeenCalled();
  });
  it('contains a local admission rejection without blaming the publisher', async () => {
    const h = fixture('cmaf');
    await h.manager.routeObject(3n, object, 18, {}, object, { admission: Promise.reject(new Error('local gate failed')) });
    expect(h.discarded).toHaveBeenCalledExactlyOnceWith(h.context, 'route retired');
    expect(h.delivered).not.toHaveBeenCalled(); expect(h.malformed).not.toHaveBeenCalled();
  });
  it('fences the captured registration when the alias is registered again', () => {
    const h = fixture('cmaf'), stillRegistered = h.manager.captureRoute(1n);
    expect(stillRegistered?.()).toBe(true);
    h.manager.unregisterTrack(1n); h.manager.registerTrack(1n, 'video', 'video', 'cmaf');
    expect(stillRegistered?.()).toBe(false);
    expect(h.manager.captureRoute(1n)?.()).toBe(true); expect(h.manager.captureRoute(99n)).toBeNull();
  });
  it('preserves the backfill marker beside the captured LOC input', async () => {
    const h = fixture('loc'), gate = permission();
    const work = h.manager.routeObject(3n, object, 18, {}, object, { admission: gate.promise });
    gate.resolve(allowed); await work;
    expect(h.delivered).toHaveBeenCalledExactlyOnceWith('video', 'video', object, {}, h.context, allowed);
  });
});

it('fences ownership retired by a custom LOC parser', async () => {
  const h = fixture('loc'), isLive = h.manager.captureRoute(1n)!;
  h.manager.extensionParser = () => {
    h.manager.unregisterTrack(1n); h.manager.registerTrack(1n, 'video', 'video', 'loc');
    return {};
  };
  await h.manager.routeObject(3n, object, 18, {}, object, { isLive });
  expect(isLive()).toBe(false); expect.soft(h.delivered).not.toHaveBeenCalled();
  expect(h.discarded).toHaveBeenCalledExactlyOnceWith(h.context, 'route retired');
  expect(h.malformed).not.toHaveBeenCalled();
});


it('does not report malformed media after the discard observer retires its owner', async () => {
  const h = fixture('cmaf'); let live = true;
  h.manager.objectProvenance = { capture: () => h.context, discarded: () => { live = false; } };
  h.manager.objectTransform = () => { throw new Error('current transform failed'); };
  await h.manager.routeObject(3n, object, 18, {}, object, { isLive: () => live });
  expect(live).toBe(false); expect(h.delivered).not.toHaveBeenCalled();
  expect(h.malformed).not.toHaveBeenCalled();
});

describe.each(['cmaf', 'locmaf', 'loc'] as const)('EOT delivery after an earlier transform for %s', packaging => {
  it.each([true, false])('rechecks terminal ownership before entering the transform: live=%s', async current => {
    const h = fixture(packaging); let release!: () => void, live = true;
    const held = new Promise<void>(resolve => { release = resolve; });
    const transform = vi.fn((value: MoqtObject) => value.kind === 'data' ? held.then(() => value) : value);
    h.manager.objectTransform = transform;
    const terminal: MoqtObject = { kind: 'gap', trackAlias: 1n, groupId: 5n, subgroupId: 0n, objectId: 1n, status: 4n };
    const first = h.manager.routeObject(1n, object, 18, {});
    const last = h.manager.routeObject(2n, terminal, 18, {}, terminal, { isLive: () => live });
    expect(transform).toHaveBeenCalledOnce();
    live = current; release(); await Promise.all([first, last]);
    expect(transform.mock.calls.map(([value]) => value.kind)).toEqual(current ? ['data', 'gap'] : ['data']);
    expect(h.delivered).toHaveBeenCalledTimes(current ? 2 : 1);
    expect(h.malformed).not.toHaveBeenCalled();
    if (current) expect(h.discarded).not.toHaveBeenCalled();
    else expect(h.discarded).toHaveBeenCalledExactlyOnceWith(h.context, 'route retired');
  });
});
