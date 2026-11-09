import { describe, expect, it, vi } from 'vitest';
import { SubscriptionManager, type ObjectDeliveryOptions } from './subscription-manager.js';
import type { ObjectRoutingProvenance } from './subscription-manager.js';
import type { MoqtObject } from '@openmoq/transport';

const object = (id = 0n): MoqtObject => ({ kind: 'data', trackAlias: 1n, groupId: 2n, subgroupId: 0n, objectId: id,
  publisherPriority: 128, payload: Uint8Array.of(1), extensions: undefined });
function fixture(packaging: 'cmaf' | 'locmaf' | 'loc' = 'cmaf') {
  const manager = new SubscriptionManager();
  manager.registerTrack(1n, 'video', 'video', packaging);
  manager.extensionParser = () => ({});
  const callback = vi.fn();
  if (packaging === 'cmaf') manager.onCmafObject = callback;
  else if (packaging === 'locmaf') manager.onLocmafObject = callback;
  else manager.onObject = callback;
  return { manager, callback };
}

describe('input provenance across object transformation', () => {
  it.each(['cmaf', 'locmaf', 'loc'] as const)('captures before the await and preserves the actual transformed object for %s', async packaging => {
    const { manager, callback } = fixture(packaging), input = object(), output = object(1n), source = {}, context = {};
    const capture = vi.fn(() => context), discarded = vi.fn();
    manager.objectProvenance = { capture, discarded };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    manager.objectTransform = async () => { await gate; return output; };
    const pending = manager.routeObject(3n, input, 18, source);
    expect(capture).toHaveBeenCalledExactlyOnceWith(source, input); expect(callback).not.toHaveBeenCalled();
    release(); await pending;
    expect(callback).toHaveBeenCalledOnce(); expect(callback.mock.calls[0]![2]).toBe(output);
    expect(packaging === 'locmaf' ? callback.mock.calls[0]![3] : callback.mock.calls[0]!.at(-1)).toBe(context);
    if (packaging === 'locmaf') { expect(callback.mock.calls[0]).toHaveLength(5); checkedDelivery(manager, callback.mock.calls[0]![4]); } expect(discarded).not.toHaveBeenCalled();
  });

  it('does not join different input contexts when transforms return the same output instance', async () => {
    const { manager, callback } = fixture(), first = object(), second = object(1n), shared = object(2n), a = {}, b = {}, source = {};
    manager.objectProvenance = { capture: (_source, input) => input === first ? a : b, discarded: vi.fn() };
    manager.objectTransform = () => shared;
    await manager.routeObject(1n, first, 18, source); await manager.routeObject(2n, second, 18, source);
    expect(callback.mock.calls.map(call => call[2])).toEqual([shared, shared]);
    expect(callback.mock.calls.map(call => call[3])).toEqual([a, b]);
  });

  it('adds no context to an input whose transform began before observation', async () => {
    const { manager, callback } = fixture(), input = object(), capture = vi.fn(() => ({}));
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    manager.objectTransform = async value => { await gate; return value; };
    const pending = manager.routeObject(1n, input, 18, {});
    manager.objectProvenance = { capture, discarded: vi.fn() };
    release(); await pending;
    expect(capture).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledExactlyOnceWith('video', 'video', input);
  });

  it('does not transfer a context to a later assignment of the same observer object', async () => {
    const { manager, callback } = fixture(), context = {}, discarded = vi.fn(), input = object();
    const observer = { capture: vi.fn(() => context), discarded };
    manager.objectProvenance = observer;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    manager.objectTransform = async value => { await gate; return value; };
    const pending = manager.routeObject(1n, input, 18, {});
    manager.objectProvenance = null; manager.objectProvenance = observer;
    release(); await pending;
    expect(callback).toHaveBeenCalledExactlyOnceWith('video', 'video', input); expect(discarded).not.toHaveBeenCalled();
  });

  it.each(['dropped', 'retired', 'failed'] as const)('discards the captured input when processing is %s', async outcome => {
    const { manager, callback } = fixture(), context = {}, discarded = vi.fn(), source = {};
    manager.objectProvenance = { capture: () => context, discarded };
    const malformed = vi.fn(); manager.onMalformedTrack = malformed;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let live = true; manager.routeStillValid = () => live;
    manager.objectTransform = async input => { await gate; if (outcome === 'failed') throw new Error('transform failed'); return outcome === 'dropped' ? null : input; };
    const pending = manager.routeObject(1n, object(), 18, source);
    if (outcome === 'retired') live = false;
    release(); await pending;
    expect(callback).not.toHaveBeenCalled();
    expect(discarded).toHaveBeenCalledExactlyOnceWith(context, outcome === 'dropped' ? 'dropped by transform' : outcome === 'retired' ? 'route retired' : 'object processing failed');
    expect(malformed).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  });

  it('contains capture and discard-hook failures without turning diagnostics into malformed media', async () => {
    const { manager, callback } = fixture(), malformed = vi.fn(), input = object();
    manager.onMalformedTrack = malformed;
    manager.objectProvenance = { capture: () => { throw new Error('capture'); }, discarded: vi.fn() };
    await manager.routeObject(1n, input, 18, {});
    expect(callback).toHaveBeenCalledExactlyOnceWith('video', 'video', input); expect(malformed).not.toHaveBeenCalled();
    callback.mockClear();
    manager.objectProvenance = { capture: () => ({}), discarded: async () => { throw new Error('discard observer'); } };
    manager.objectTransform = () => null;
    await manager.routeObject(2n, input, 18, {}); await Promise.resolve();
    expect(callback).not.toHaveBeenCalled(); expect(malformed).not.toHaveBeenCalled();
  });

  it('rechecks route ownership after a capture callback retires it', async () => {
    const { manager, callback } = fixture(), context = {}, discarded = vi.fn();
    let live = true; manager.routeStillValid = () => live;
    manager.objectProvenance = { capture: () => { live = false; return context; }, discarded };
    await manager.routeObject(1n, object(), 18, {});
    expect(callback).not.toHaveBeenCalled(); expect(discarded).toHaveBeenCalledExactlyOnceWith(context, 'route retired');
  });
});

it.each([true, false])('keeps LOCMAF transform cancellation scoped to the actual source (matches=%s)', async matches => {
  const { manager, callback } = fixture('locmaf'), source = {}, context = {}, discarded = vi.fn(), input = object();
  manager.objectProvenance = { capture: () => context, discarded };
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  manager.objectTransform = async value => { await gate; return value; };
  const pending = manager.routeObject(1n, input, 18, source);
  manager.invalidateLocmafGroup(1n, 2n, matches ? source : {});
  release(); await pending;
  if (matches) { expect(callback).not.toHaveBeenCalled(); expect(discarded).toHaveBeenCalledExactlyOnceWith(context, 'transform cancelled'); }
  else { expect(callback).toHaveBeenCalledExactlyOnceWith('video', 'video', input, context, checkedDelivery(manager, callback.mock.calls[0]![4])); expect(discarded).not.toHaveBeenCalled(); }
});

it('captures no media provenance for unknown aliases or init/metadata tracks', async () => {
  const { manager } = fixture(), capture = vi.fn(() => ({})), discarded = vi.fn(), source = {};
  manager.objectProvenance = { capture, discarded };
  manager.registerTrack(2n, 'init', 'video', 'init');
  manager.registerTrack(3n, 'timeline', 'mediatimeline', 'mediatimeline');
  const init = vi.fn(), timeline = vi.fn(); manager.onInitObject = init; manager.onTimelineObject = timeline;
  await manager.routeObject(1n, { ...object(), trackAlias: 99n }, 18, source);
  await manager.routeObject(2n, { ...object(), trackAlias: 2n }, 18, source);
  await manager.routeObject(3n, { ...object(), trackAlias: 3n }, 18, source);
  expect(init).toHaveBeenCalledOnce(); expect(timeline).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled(); expect(discarded).not.toHaveBeenCalled();
});

it('forwards an omitted source as undefined rather than guessing an alias owner', async () => {
  const { manager, callback } = fixture(), input = object(), capture = vi.fn(() => undefined);
  manager.objectProvenance = { capture, discarded: vi.fn() };
  await manager.routeObject(1n, input);
  expect(capture).toHaveBeenCalledExactlyOnceWith(undefined, input);
  expect(callback).toHaveBeenCalledExactlyOnceWith('video', 'video', input);
});

it('does not await an accidental asynchronous capture or use its promise as a media context', async () => {
  const { manager, callback } = fixture(), input = object(), malformed = vi.fn();
  const failed = Promise.reject(new Error('capture failed')); void failed.catch(() => {});
  const observer = { capture: () => ({}), discarded: vi.fn() };
  // Model a JavaScript caller violating the synchronous capture contract.
  Object.defineProperty(observer, 'capture', { value: () => failed });
  manager.objectProvenance = observer; manager.onMalformedTrack = malformed;
  await manager.routeObject(1n, input, 18, {}); await Promise.resolve();
  expect(callback).toHaveBeenCalledExactlyOnceWith('video', 'video', input);
  expect(malformed).not.toHaveBeenCalled();
});


// Consumer type contract: removing the synchronous restriction makes this
// directive unused, so the typecheck gate rejects that weakening.
const asynchronousCapture: ObjectRoutingProvenance = {
  // @ts-expect-error A promise cannot be an opaque synchronous input context.
  capture: async () => ({}),
  discarded: () => {},
};
void asynchronousCapture;

function checkedDelivery(manager: SubscriptionManager, value: unknown): ObjectDeliveryOptions {
  const delivery = value as ObjectDeliveryOptions;
  expect(delivery).toBeDefined();
  expect(typeof delivery.isLive).toBe('function');
  expect(delivery.isLive!()).toBe(true);
  manager.invalidateMediaInputs();
  expect(delivery.isLive!()).toBe(false);
  return delivery;
}
