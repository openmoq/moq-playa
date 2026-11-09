import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmStartHead, type WarmStartHeadOptions } from './warm-start-head.js';

const heads: WarmStartHead<string>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  heads.splice(0).forEach(head => head.retire());
  vi.useRealTimers();
});

function setup(extra: Partial<WarmStartHeadOptions<string>> = {}, range = true) {
  const delivered: string[] = [];
  const discarded: string[] = [];
  const head = new WarmStartHead<string>({
    clock: { now: () => 0 },
    ...(range ? { prefixStart: { group: 4n, object: 0n } } : {}),
    isCurrent: () => true,
    deliver: value => { delivered.push(value); },
    discard: value => { discarded.push(value); },
    ...extra,
  });
  heads.push(head);
  const push = (group: number, object: number, source: 'prefix' | 'live' = 'prefix', bytes = 1, terminal = false) => {
    head.push({
      group: BigInt(group), object: BigInt(object), source, bytes,
      continuation: terminal ? 'terminal' : object === 0 ? 'group-start' : 'ordinary',
      value: `${group}/${object}`,
    });
  };
  return { head, push, delivered, discarded };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('warm-start range boundaries', () => {
  it('reports prefix readiness after delivery settlement and before live handoff, once', async () => {
    const work = deferred();
    const events: string[] = [];
    const h = setup({
      deliver: value => { events.push(value); return value === '4/0' ? work.promise : undefined; },
      onPrefixReady: () => { events.push('ready'); },
    });
    h.head.acceptLargest({ group: 4n, object: 0n });
    h.push(4, 0);
    h.push(5, 0, 'live');
    h.head.finishPrefix('fin');
    expect(events).toEqual(['4/0']);
    work.resolve(); await settle();
    expect(events).toEqual(['4/0', 'ready', '5/0']);
    h.head.finishPrefix('fin');
    expect(events).toEqual(['4/0', 'ready', '5/0']);
  });

  it('allows readiness observers to retire without delivering queued live media', () => {
    const ready = vi.fn(() => { h.head.retire(); });
    const h = setup({ onPrefixReady: ready });
    h.head.acceptLargest({ group: 4n, object: 0n });
    h.push(4, 0);
    h.push(5, 0, 'live');
    h.head.finishPrefix('fin');
    expect(ready).toHaveBeenCalledOnce();
    expect(h.delivered).toEqual(['4/0']);
    expect(h.head.retainedObjects).toBe(0);
  });

  it('does not announce readiness or deliver fallback after retirement in abandonment', () => {
    const ready = vi.fn();
    const h = setup({ onAbandon: () => { h.head.retire(); }, onPrefixReady: ready });
    h.head.acceptLargest({ group: 4n, object: 0n });
    h.push(4, 0);
    h.push(5, 0, 'live');
    h.head.finishPrefix('reset');
    expect(ready).not.toHaveBeenCalled();
    expect(h.delivered).toEqual([]);
    expect(h.head.retainedObjects).toBe(0);
  });

  it('releases an empty range beyond Largest without FIN and enforces its start', () => {
    const h = setup();
    h.head.acceptLargest({ group: 3n, object: 9n });
    h.push(3, 10, 'live');
    h.push(4, 0, 'live');
    expect(h.delivered).toEqual(['4/0']);
  });

  it('orders sparse FIN objects without inventing missing IDs', () => {
    const h = setup();
    h.head.acceptLargest({ group: 9n, object: 5n });
    h.push(9, 5);
    h.push(4, 2);
    h.head.finishPrefix('fin');
    expect(h.delivered).toEqual(['4/2', '9/5']);
  });

  it('retains EOT outside the requested data floor across an empty prefix', () => {
    const h = setup();
    h.push(3, 9, 'live', 0, true);
    h.head.acceptLargest({ group: 3n, object: 8n });
    expect(h.delivered).toEqual(['3/9']);
  });

  it('fences a reset before Largest and permits a later live restart', () => {
    const h = setup();
    h.push(4, 0);
    h.head.finishPrefix('reset');
    h.push(6, 0, 'live');
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.push(6, 0, 'live');
    expect(h.delivered).toEqual(['6/0']);
  });

  it('abandons byte overflow without delivering prefix data', () => {
    const h = setup({ maxBytes: 2 });
    h.head.acceptLargest({ group: 5n, object: 0n });
    h.push(4, 0, 'prefix', 2);
    h.push(5, 0);
    expect(h.delivered).toEqual([]);
    expect(h.head.retainedBytes).toBe(0);
    h.push(6, 0, 'live');
    expect(h.delivered).toEqual(['6/0']);
  });

  it('retains in-flight credits after reset and delays EOT until settlement', async () => {
    const work = deferred();
    const seen: string[] = [];
    const h = setup({
      maxObjects: 1, maxBytes: 2,
      deliver: value => {
        seen.push(value);
        return value === '4/0' ? work.promise : undefined;
      },
    });
    h.head.acceptLargest({ group: 5n, object: 0n });
    h.push(4, 0, 'prefix', 2);
    h.head.finishPrefix('fin');
    h.head.finishPrefix('reset');
    h.push(6, 0, 'live');
    h.push(7, 0, 'live', 0, true);
    expect(h.head.retainedBytes).toBe(2);
    expect(seen).toEqual(['4/0']);
    work.resolve();
    await settle();
    expect(seen).toEqual(['4/0', '7/0']);
    expect(h.head.retainedObjects).toBe(0);
  });

  it('stops remaining prefix and live delivery when a callback retires the owner', () => {
    const seen: string[] = [];
    const h = setup({ deliver: value => { seen.push(value); h.head.retire(); } });
    h.head.acceptLargest({ group: 5n, object: 0n });
    h.push(4, 0);
    h.push(5, 0);
    h.push(6, 0, 'live');
    h.head.finishPrefix('fin');
    expect(seen).toEqual(['4/0']);
    expect(h.head.retainedObjects).toBe(0);
  });

  it('copies a supplied mutable prefix start', () => {
    const start = { group: 4n, object: 0n };
    const h = setup({ prefixStart: start });
    start.group = 8n;
    h.head.acceptLargest({ group: 5n, object: 0n });
    h.push(4, 0);
    h.head.finishPrefix('fin');
    expect(h.delivered).toEqual(['4/0']);
  });

  it('rejects malformed prefix coordinates', () => {
    for (const prefixStart of [
      { group: -1n, object: 0n },
      { group: 4, object: 0n },
      { group: 4n, object: -1n },
    ]) {
      // Exercise invalid runtime input without weakening the typed caller contract.
      expect(() => Reflect.construct(WarmStartHead, [{
        clock: { now: () => 0 }, isCurrent: () => true,
        deliver: () => {}, discard: () => {}, prefixStart,
      }])).toThrow(TypeError);
    }
  });

  it('preserves default single-group dense delivery before FIN', () => {
    const h = setup({}, false);
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.push(4, 0);
    h.push(5, 1);
    h.push(5, 0);
    expect(h.delivered).toEqual(['5/0', '5/1']);
  });

  it('rejects late overlapping live data behind an in-flight prefix delivery', async () => {
    const work = deferred();
    const seen: string[] = [];
    const h = setup({ deliver: value => {
      seen.push(value);
      return value === '5/0' ? work.promise : undefined;
    } });
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.push(5, 0);
    h.push(5, 1);
    h.head.finishPrefix('fin');
    h.push(4, 0, 'live');
    work.resolve();
    await settle();
    expect(seen).toEqual(['5/0', '5/1']);
  });

  it('bounds retained object count independently of byte capacity', () => {
    const h = setup({ maxObjects: 1, maxBytes: 100 });
    h.head.acceptLargest({ group: 5n, object: 0n });
    h.push(4, 0);
    h.push(5, 0);
    expect(h.head.retainedObjects).toBe(0);
    expect(h.delivered).toEqual([]);
  });

  it('rejects synchronous delivery reentry behind the dispatched prefix location', () => {
    const seen: string[] = [];
    const h = setup({ deliver: value => {
      seen.push(value);
      if (value === '5/0') h.push(4, 0, 'live');
    } });
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.push(5, 0);
    h.push(5, 1);
    h.head.finishPrefix('fin');
    expect(seen).toEqual(['5/0', '5/1']);
  });
});
