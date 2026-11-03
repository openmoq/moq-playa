import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmStartHead, type WarmStartDelivery, type WarmStartHeadOptions, type WarmStartItem } from './warm-start-head.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function item(group: number | bigint, object: number | bigint, source: 'prefix' | 'live' = 'prefix',
  value = `${group}:${object}`, bytes = 1): WarmStartItem<string> {
  return { group: BigInt(group), object: BigInt(object), source, value, bytes,
    continuation: BigInt(object) === 0n && bytes > 0 ? 'group-start' : 'ordinary' };
}

function harness(options: Partial<WarmStartHeadOptions<string>> = {}) {
  let now = 0, current = true;
  const delivered: string[] = [];
  const discarded: Array<[string, string]> = [];
  const abandon = vi.fn();
  const errors = vi.fn();
  const metadata: WarmStartDelivery[] = [];
  const head = new WarmStartHead<string>({
    clock: { now: () => now }, isCurrent: () => current,
    deliver: (value, context) => { delivered.push(value); metadata.push(context); },
    discard: (value, reason) => { discarded.push([value, reason]); },
    onAbandon: abandon, onError: errors, ...options,
  });
  heads.push(head);
  return { head, delivered, discarded, abandon, errors, metadata,
    setNow: (value: number) => { now = value; },
    expire: () => { now = 1_000_000; vi.advanceTimersByTime(1000); },
    supersede: () => { current = false; },
  };
}

const heads: Array<{ retire(): void }> = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const head of heads.splice(0)) head.retire();
  vi.useRealTimers();
});

describe('WarmStartHead initial prefix', () => {
  it('holds every format until the saved head is known, including a later group keyframe', () => {
    const h = harness();
    h.head.push(item(6, 0, 'live'));
    h.head.push(item(5, 1));
    h.head.push(item(5, 0));
    expect(h.delivered).toEqual([]);
    h.head.acceptLargest({ group: 5n, object: 1n });
    expect(h.delivered).toEqual(['5:0', '5:1', '6:0']);
    expect(h.head.state).toBe('live');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('orders only the initial prefix, then directly routes steady arrivals', () => {
    const h = harness();
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 3, 'live'));
    h.head.push(item(5, 2, 'live'));
    h.head.push(item(5, 1));
    h.head.push(item(5, 0));
    expect(h.delivered).toEqual(['5:0', '5:1', '5:2', '5:3']);
    // Steady-state gaps/order remain the caller's existing policy.
    h.head.push(item(7, 3, 'live'));
    h.head.push(item(7, 1, 'live'));
    expect(h.delivered.slice(-2)).toEqual(['7:3', '7:1']);
    expect(h.head.retainedObjects).toBe(0);
  });

  it('deduplicates queued, in-flight, and already emitted prefix locations', async () => {
    const pending = deferred();
    const delivered: string[] = [];
    const h = harness({ deliver: value => { delivered.push(value); if (value === 'first') return pending.promise; } });
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 1, 'prefix', 'queued'));
    h.head.push(item(5, 1, 'prefix', 'queued duplicate'));
    h.head.push(item(5, 0, 'prefix', 'first'));
    h.head.push(item(5, 0, 'live', 'in-flight duplicate'));
    pending.resolve(); await settle();
    h.head.push(item(5, 0, 'prefix', 'emitted duplicate'));
    h.head.push(item(5, 2, 'live', 'tail'));
    expect(delivered).toEqual(['first', 'queued', 'tail']);
    expect(h.discarded.map(([value]) => value)).toEqual(['queued duplicate', 'in-flight duplicate', 'emitted duplicate']);
  });

  it('keeps a compact completed-prefix fence after FIN and normal live delivery', () => {
    const h = harness();
    h.head.acceptLargest({ group: 5n, object: 0n });
    h.head.push(item(5, 0)); h.head.finishPrefix('fin');
    h.head.push(item(4, 0, 'live'));
    h.head.push(item(5, 0, 'live'));
    h.head.push(item(5, 1, 'live'));
    expect(h.delivered).toEqual(['5:0', '5:1']);
    expect(h.discarded).toEqual([['4:0', 'stale prefix'], ['5:0', 'stale prefix']]);
  });

  it('tags actual backfill, not all arrivals while a retrieval is open', () => {
    const h = harness(); h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 2, 'live')); h.head.push(item(5, 0)); h.head.push(item(5, 1, 'live'));
    expect(h.metadata.map(context => context.backfill)).toEqual([true, false, false]);
  });

  it('does not await a FIN or EOG once the exact inclusive prefix is processed', () => {
    const h = harness(); h.head.acceptLargest({ group: 5n, object: 0n });
    h.head.push(item(8, 0, 'live')); h.head.push(item(5, 0));
    expect(h.delivered).toEqual(['5:0', '8:0']);
    expect(h.abandon).not.toHaveBeenCalled();
    h.expire();
    expect(h.head.state).toBe('live');
  });

  it('rejects prefix items outside the saved single-group range', () => {
    const h = harness(); h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(6, 0)); h.head.push(item(5, 2));
    expect(h.delivered).toEqual([]);
    expect(h.discarded.every(([, reason]) => reason === 'outside prefix')).toBe(true);
  });

  it('does not couple different owner instances with identical locations', () => {
    const a = harness(), b = harness();
    a.head.acceptLargest({ group: 5n, object: 1n }); b.head.acceptLargest({ group: 5n, object: 0n });
    a.head.push(item(5, 1)); b.head.push(item(5, 0));
    expect(a.delivered).toEqual([]); expect(b.delivered).toEqual(['5:0']);
    a.head.push(item(5, 0)); expect(a.delivered).toEqual(['5:0', '5:1']);
  });

  it('distinguishes an unknown Largest from an explicitly empty track', () => {
    const h = harness(); h.head.push(item(6, 4, 'live'));
    expect(h.delivered).toEqual([]);
    h.head.acceptLargest(null);
    expect(h.delivered).toEqual(['6:4']); expect(h.head.state).toBe('live');
    h.head.finishPrefix('fin'); expect(h.abandon).not.toHaveBeenCalled();
  });

  it('accepts a repeated snapshot but refuses replacement of its cutoff', () => {
    const h = harness(); h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.acceptLargest({ group: 5n, object: 1n });
    expect(() => h.head.acceptLargest({ group: 6n, object: 1n })).toThrow(/already accepted/);
    expect(() => h.head.acceptLargest(null)).toThrow(/already accepted/);
  });

  it('captures envelope coordinates and byte accounting at admission', () => {
    const h = harness(); const input = item(5, 0);
    h.head.push(input); Object.assign(input, { group: 99n, bytes: 200 });
    h.head.acceptLargest({ group: 5n, object: 0n });
    expect(h.delivered).toEqual(['5:0']); expect(h.head.retainedBytes).toBe(0);
  });
});

describe('WarmStartHead promise settlement and terminal ownership', () => {
  it('FIN waits for accepted transforms, then releases the held tail once', async () => {
    const first = deferred(), second = deferred();
    const seen: string[] = [], delivered: string[] = [];
    const h = harness({ deliver: async (value, { isLive }) => {
      seen.push(value);
      if (value === '5:0') await first.promise;
      if (value === '5:1') await second.promise;
      if (isLive()) delivered.push(value);
    } });
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 0)); h.head.push(item(5, 1)); h.head.push(item(5, 2, 'live'));
    h.head.finishPrefix('fin');
    expect(seen).toEqual(['5:0']); expect(h.head.state).toBe('prefix');
    first.resolve(); await settle(); expect(seen).toEqual(['5:0', '5:1']);
    expect(h.head.state).toBe('prefix'); expect(h.abandon).not.toHaveBeenCalled();
    second.resolve(); await settle();
    expect(delivered).toEqual(['5:0', '5:1', '5:2']);
    expect(h.head.state).toBe('live'); expect(h.head.retainedObjects).toBe(0);
  });

  it('FIN with a proven hole abandons only after its accepted contiguous work settles', async () => {
    const pending = deferred(); const delivered: string[] = [];
    const h = harness({ deliver: async (value, { isLive }) => {
      if (value === '5:0') await pending.promise;
      if (isLive()) delivered.push(value);
    } });
    h.head.acceptLargest({ group: 5n, object: 2n });
    h.head.push(item(5, 0)); h.head.push(item(5, 2)); h.head.push(item(6, 0, 'live'));
    h.head.finishPrefix('fin'); expect(h.abandon).not.toHaveBeenCalled();
    pending.resolve(); await settle();
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('incomplete prefix');
    expect(delivered).toEqual(['5:0', '6:0']);
    expect(h.discarded).toEqual([['5:2', 'incomplete prefix']]);
  });

  it('an early FIN with unknown Largest waits for the saved snapshot', () => {
    const h = harness(); h.head.push(item(5, 0)); h.head.finishPrefix('fin');
    expect(h.abandon).not.toHaveBeenCalled();
    h.head.acceptLargest({ group: 5n, object: 0n });
    expect(h.delivered).toEqual(['5:0']); expect(h.head.state).toBe('live');
  });

  it.each(['reset', 'error'] as const)('%s fences an in-flight transform and resumes at a future start', async terminal => {
    const pending = deferred(); const delivered: string[] = [];
    const h = harness({ deliver: async (value, { isLive }) => {
      if (value === '5:0') await pending.promise;
      if (isLive()) delivered.push(value);
    } });
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 0)); h.head.push(item(5, 1));
    h.head.finishPrefix(terminal); h.head.finishPrefix(terminal);
    h.head.push(item(6, 0, 'live')); await settle();
    pending.resolve(); await settle();
    expect(delivered).toEqual(['6:0']);
    expect(h.discarded).toEqual([['5:1', terminal]]);
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith(terminal);
  });

  it('retire invalidates pending guards and discards only unstarted items once', async () => {
    const pending = deferred(); let guard!: () => boolean;
    const h = harness({ deliver: (_value, context) => { guard = context.isLive; return pending.promise; } });
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 0)); h.head.push(item(5, 1)); h.head.retire(); h.head.retire();
    expect(guard()).toBe(false); expect(h.discarded).toEqual([['5:1', 'retired']]);
    expect(h.head.retainedObjects).toBe(1); expect(vi.getTimerCount()).toBe(0);
    pending.resolve(); await settle(); expect(h.head.retainedObjects).toBe(0);
    expect(h.discarded).toEqual([['5:1', 'retired']]); expect(h.abandon).not.toHaveBeenCalled();
  });

  it('loss of current ownership is checked even without diagnostic observers', async () => {
    const pending = deferred(); let guard!: () => boolean;
    const h = harness({ deliver: (_value, context) => { guard = context.isLive; return pending.promise; } });
    h.head.acceptLargest({ group: 5n, object: 1n }); h.head.push(item(5, 0)); h.head.push(item(5, 1));
    h.supersede(); expect(guard()).toBe(false); pending.resolve(); await settle();
    expect(h.head.state).toBe('retired'); expect(h.discarded).toEqual([['5:1', 'retired']]);
  });
});

describe('WarmStartHead deadline and bounds', () => {
  it('wakes a missing prefix without a later push or FIN', () => {
    const h = harness(); h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 1)); h.head.push(item(6, 0, 'live')); h.expire();
    expect(h.delivered).toEqual(['6:0']); expect(h.discarded).toEqual([['5:1', 'timeout']]);
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('timeout');
    h.head.push(item(5, 0)); h.head.push(item(5, 7, 'live'));
    expect(h.delivered).toEqual(['6:0']);
  });

  it('checks the deadline inside isLive even before the host timer runs', async () => {
    const pending = deferred(); let guard!: () => boolean;
    const delivered: string[] = [];
    const h = harness({ deliver: async (value, context) => {
      if (value === '5:0') { guard = context.isLive; await pending.promise; }
      if (context.isLive()) delivered.push(value);
    } });
    h.head.acceptLargest({ group: 5n, object: 0n }); h.head.push(item(5, 0));
    h.setNow(1_000_000); expect(guard()).toBe(false);
    h.head.push(item(6, 0, 'live')); await settle();
    pending.resolve(); await settle();
    expect(delivered).toEqual(['6:0']); expect(h.discarded).toEqual([]);
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('timeout');
  });

  it('a settled promise checks time even when the delivery never consults its guard', async () => {
    const pending = deferred(); const h = harness({ deliver: () => pending.promise });
    h.head.acceptLargest({ group: 5n, object: 0n }); h.head.push(item(5, 0));
    h.setNow(1_000_000); pending.resolve(); await settle();
    expect(h.head.state).toBe('fallback'); expect(h.abandon).toHaveBeenCalledExactlyOnceWith('timeout');
  });

  it('old transform completion cannot clear the replacement pump or advance its cursor', async () => {
    const old = deferred(), replacement = deferred(); const seen: string[] = [];
    const h = harness({ deliver: value => {
      seen.push(value);
      if (value === '5:0') return old.promise;
      if (value === '6:0') return replacement.promise;
    } });
    h.head.acceptLargest({ group: 5n, object: 0n }); h.head.push(item(5, 0)); h.expire();
    h.head.push(item(6, 0, 'live')); h.head.push(item(6, 1, 'live'));
    old.resolve(); await settle(); expect(seen).toEqual(['5:0', '6:0']);
    expect(h.head.retainedObjects).toBe(2);
    replacement.resolve(); await settle(); expect(seen).toEqual(['5:0', '6:0', '6:1']);
  });

  it('an obsolete transform rejection does not report recovery against the continuing owner', async () => {
    const pending = deferred(); const h = harness({ deliver: () => pending.promise });
    h.head.acceptLargest({ group: 5n, object: 0n }); h.head.push(item(5, 0)); h.expire();
    pending.reject(new Error('late transform')); await settle();
    expect(h.errors).not.toHaveBeenCalled(); expect(h.abandon).toHaveBeenCalledTimes(1);
  });

  it('never guesses an anchor after unknown-Largest expiry', () => {
    const h = harness(); h.head.push(item(5, 1)); h.expire();
    h.head.push(item(6, 0, 'live')); expect(h.delivered).toEqual([]);
    expect(h.discarded).toEqual([['5:1', 'timeout'], ['6:0', 'awaiting largest']]);
    h.head.acceptLargest({ group: 5n, object: 1n });
    h.head.push(item(5, 2, 'live')); h.head.push(item(6, 1, 'live')); h.head.push(item(7, 0, 'live'));
    expect(h.delivered).toEqual(['7:0']);
  });

  it('an empty answer after unknown expiry allows normal startup', () => {
    const h = harness(); h.expire(); h.head.acceptLargest(null); h.head.push(item(8, 3, 'live'));
    expect(h.delivered).toEqual(['8:3']); expect(h.head.state).toBe('live');
  });

  it('rearms early wakes without extending a monotonic deadline', () => {
    const h = harness(); vi.advanceTimersByTime(1000); expect(h.abandon).not.toHaveBeenCalled();
    h.setNow(999_000); vi.advanceTimersByTime(1000); expect(h.abandon).not.toHaveBeenCalled();
    h.setNow(1_000_000); vi.advanceTimersByTime(1);
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('timeout'); expect(vi.getTimerCount()).toBe(0);
  });

  it('later arrivals do not renew the fixed deadline', () => {
    const h = harness(); h.head.acceptLargest({ group: 5n, object: 3n });
    h.setNow(999_000); vi.advanceTimersByTime(999); h.head.push(item(5, 2));
    h.setNow(1_000_000); vi.advanceTimersByTime(1);
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('timeout');
  });

  it.each(['objects', 'bytes'] as const)('counts in-flight work against its %s bound', async bound => {
    const pending = deferred();
    const h = harness({ maxObjects: bound === 'objects' ? 2 : 100, maxBytes: bound === 'bytes' ? 2 : 100,
      deliver: () => pending.promise });
    h.head.acceptLargest({ group: 5n, object: 2n });
    h.head.push(item(5, 0)); h.head.push(item(5, 1));
    expect(h.head.retainedObjects).toBe(2); expect(h.head.retainedBytes).toBe(2);
    h.head.push(item(5, 2));
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('overflow');
    expect(h.discarded).toEqual([['5:1', 'overflow'], ['5:2', 'overflow']]);
    expect(h.head.retainedObjects).toBe(1);
    pending.resolve(); await settle(); expect(h.head.retainedObjects).toBe(0);
  });

  it('refuses a single oversized item before delivery', () => {
    const h = harness({ maxBytes: 1 }); h.head.acceptLargest({ group: 5n, object: 0n });
    h.head.push(item(5, 0, 'prefix', 'oversized', 2));
    expect(h.delivered).toEqual([]); expect(h.head.retainedBytes).toBe(0);
    expect(h.discarded).toEqual([['oversized', 'overflow']]);
  });

  it('applies the default 100-object admission bound before Largest is known', () => {
    const h = harness();
    for (let i = 0; i < 100; i++) h.head.push(item(5, i));
    expect(h.head.retainedObjects).toBe(100);
    h.head.push(item(5, 100));
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('overflow');
    expect(h.discarded).toHaveLength(101); expect(h.head.retainedObjects).toBe(0);
  });

  it('applies the default 4 MiB retained-byte bound', () => {
    const h = harness();
    h.head.push(item(5, 1, 'prefix', 'full', 4 * 1024 * 1024));
    expect(h.head.retainedBytes).toBe(4 * 1024 * 1024);
    h.head.push(item(5, 2));
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('overflow');
    expect(h.head.retainedBytes).toBe(0);
  });

  it('keeps fenced pending transforms charged against later fallback admission', async () => {
    const old = deferred(); const seen: string[] = [];
    const h = harness({ maxObjects: 1, deliver: value => { seen.push(value); if (value === '5:0') return old.promise; } });
    h.head.acceptLargest({ group: 5n, object: 0n }); h.head.push(item(5, 0)); h.expire();
    h.head.push(item(6, 0, 'live'));
    expect(seen).toEqual(['5:0']); expect(h.discarded).toEqual([['6:0', 'overflow']]);
    old.resolve(); await settle(); h.head.push(item(7, 0, 'live'));
    expect(seen).toEqual(['5:0', '7:0']); expect(h.abandon).toHaveBeenCalledTimes(1);
  });
});

describe('WarmStartHead callback reentrancy', () => {
  it('reserves ownership before a deliver callback reenters with a duplicate and FIN', () => {
    const delivered: string[] = []; let head!: WarmStartHead<string>;
    const h = harness({ deliver: value => {
      delivered.push(value);
      if (value === '5:0') { head.push(item(5, 0, 'prefix', 'duplicate')); head.finishPrefix('fin'); }
    } }); head = h.head;
    head.acceptLargest({ group: 5n, object: 0n }); head.push(item(5, 0));
    expect(delivered).toEqual(['5:0']); expect(h.discarded).toEqual([['duplicate', 'duplicate']]);
    expect(h.abandon).not.toHaveBeenCalled(); expect(head.retainedObjects).toBe(0);
  });

  it('a reentrant retire from delivery cannot drain the next item', () => {
    let head!: WarmStartHead<string>; const delivered: string[] = [];
    const h = harness({ deliver: value => { delivered.push(value); head.retire(); } }); head = h.head;
    head.acceptLargest({ group: 5n, object: 1n }); head.push(item(5, 1)); head.push(item(5, 0));
    expect(delivered).toEqual(['5:0']); expect(h.discarded).toEqual([['5:1', 'retired']]);
    expect(head.state).toBe('retired'); expect(head.retainedObjects).toBe(0);
  });

  it('a reentrant fallback start from onAbandon is delivered after state is fenced', () => {
    let head!: WarmStartHead<string>;
    const h = harness({ onAbandon: () => { head.push(item(6, 0, 'live')); } }); head = h.head;
    head.acceptLargest({ group: 5n, object: 1n }); head.push(item(5, 1)); h.expire();
    expect(h.delivered).toEqual(['6:0']); expect(h.discarded).toEqual([['5:1', 'timeout']]);
  });

  it('a fallback-start discard callback may provide another start without stranding it', () => {
    let head!: WarmStartHead<string>; const delivered: string[] = [];
    const h = harness({ deliver: value => { delivered.push(value); },
      discard: (_value, reason) => { if (reason === 'awaiting group start') head.push(item(7, 0, 'live')); } });
    head = h.head; head.acceptLargest({ group: 5n, object: 1n });
    head.push(item(6, 1, 'live')); h.expire();
    expect(delivered).toEqual(['7:0']); expect(head.state).toBe('live');
  });

  it('a duplicate discard callback may supply a missing prefix object', () => {
    let head!: WarmStartHead<string>; const delivered: string[] = [];
    const h = harness({ deliver: value => { delivered.push(value); },
      discard: (_value, reason) => { if (reason === 'duplicate') head.push(item(5, 0)); } });
    head = h.head; head.acceptLargest({ group: 5n, object: 1n });
    head.push(item(5, 1)); head.push(item(5, 1, 'prefix', 'duplicate'));
    expect(delivered).toEqual(['5:0', '5:1']); expect(head.state).toBe('live');
  });

  it('a reentrant retire during abandonment claims the held future item only once', () => {
    let head!: WarmStartHead<string>;
    const h = harness({ onAbandon: () => { head.retire(); } }); head = h.head;
    head.acceptLargest({ group: 5n, object: 1n }); head.push(item(5, 1)); head.push(item(6, 0, 'live'));
    h.expire();
    expect(h.discarded).toEqual([['6:0', 'retired'], ['5:1', 'timeout']]);
    expect(h.delivered).toEqual([]); expect(head.retainedObjects).toBe(0);
  });

  it('a guard-triggered expiry inside delivery cannot resurrect the old prefix cursor', () => {
    let head!: WarmStartHead<string>, now = 0; const delivered: string[] = [];
    const h = harness({ clock: { now: () => now }, deliver: (value, context) => {
      if (value === '5:0') { now = 1_000_000; expect(context.isLive()).toBe(false); head.push(item(6, 0, 'live')); }
      else if (context.isLive()) delivered.push(value);
    } }); head = h.head;
    head.acceptLargest({ group: 5n, object: 1n }); head.push(item(5, 1)); head.push(item(5, 0));
    expect(delivered).toEqual(['6:0']); expect(h.discarded).toEqual([['5:1', 'timeout']]);
    expect(head.state).toBe('live'); expect(head.retainedObjects).toBe(0);
  });

  it('contains discard/abandon observer errors and still makes progress', () => {
    const delivered: string[] = [];
    const h = harness({ deliver: value => { delivered.push(value); },
      discard: () => { throw new Error('discard observer'); },
      onAbandon: () => { throw new Error('abandon observer'); } });
    h.head.acceptLargest({ group: 5n, object: 1n }); h.head.push(item(5, 1)); h.head.push(item(6, 0, 'live'));
    expect(() => h.expire()).not.toThrow(); expect(delivered).toEqual(['6:0']);
    expect(h.errors).toHaveBeenCalledTimes(2);
  });

  it.each(['sync', 'async'] as const)('contains a %s delivery failure without discarding the claimed item twice', async kind => {
    const error = new Error('delivery');
    const h = harness({ deliver: () => { if (kind === 'sync') throw error; return Promise.reject(error); } });
    h.head.acceptLargest({ group: 5n, object: 1n }); h.head.push(item(5, 1)); h.head.push(item(5, 0)); await settle();
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('error');
    expect(h.discarded).toEqual([['5:1', 'error']]); expect(h.errors).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('keeps the live handoff sequential while a delivery is pending', async () => {
    const pending = deferred(); const seen: string[] = [];
    const h = harness({ deliver: value => { seen.push(value); if (value === '5:2') return pending.promise; } });
    h.head.acceptLargest({ group: 5n, object: 0n });
    h.head.push(item(6, 0, 'live')); h.head.push(item(5, 2, 'live')); h.head.push(item(5, 0));
    h.head.push(item(5, 3, 'live')); expect(seen).toEqual(['5:0', '5:2']);
    pending.resolve(); await settle(); expect(seen).toEqual(['5:0', '5:2', '5:3', '6:0']);
  });

  it('deduplicates an in-flight handoff item without extending the prefix fence to live repairs', () => {
    let head!: WarmStartHead<string>; const delivered: string[] = [];
    const h = harness({ deliver: value => {
      delivered.push(value);
      if (value === '5:2') { head.push(item(5, 2, 'live')); head.push(item(5, 1, 'live')); }
    } }); head = h.head;
    head.acceptLargest({ group: 5n, object: 0n }); head.push(item(5, 2, 'live')); head.push(item(5, 0));
    expect(h.discarded.map(([value]) => value)).toEqual(['5:2']);
    // Already emitted live data cannot be reordered retroactively. The existing
    // LOC/MSE policy owns this late live repair; it is outside the prefix fence.
    expect(delivered).toEqual(['5:0', '5:2', '5:1']);
    expect(head.state).toBe('live');
  });

  it('contains rejected direct delivery and fences it on retire', async () => {
    let guard!: () => boolean; const error = new Error('direct');
    const h = harness({ deliver: (_value, context) => { guard = context.isLive; return Promise.reject(error); } });
    h.head.acceptLargest(null); h.head.push(item(6, 0, 'live')); h.head.retire();
    expect(guard()).toBe(false); await settle(); expect(h.errors).toHaveBeenCalledExactlyOnceWith(error);
  });
});

describe('WarmStartHead input validation', () => {
  it.each([
    ['maxWaitUs', -1], ['maxWaitUs', NaN], ['maxWaitUs', Infinity], ['maxWaitUs', 1.5],
    ['maxWaitUs', 0x7fffffff * 1000 + 1],
    ['maxObjects', 0], ['maxObjects', 1.5], ['maxBytes', 0], ['maxBytes', Infinity],
  ])('refuses invalid %s before creating a timer', (name, value) => {
    expect(() => harness({ [name]: value })).toThrow(); expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses invalid locations and byte counts without changing admission', () => {
    const h = harness();
    expect(() => h.head.push(item(-1, 0))).toThrow();
    expect(() => h.head.push(item(0, 0, 'prefix', 'bad bytes', -1))).toThrow();
    expect(() => h.head.acceptLargest({ group: 0n, object: -1n })).toThrow();
    expect(h.head.retainedObjects).toBe(0);
  });

  it('checks a zero deadline on admission', () => {
    const h = harness({ maxWaitUs: 0 }); h.head.acceptLargest({ group: 5n, object: 0n });
    h.head.push(item(5, 0)); expect(h.delivered).toEqual([]); expect(h.abandon).toHaveBeenCalledExactlyOnceWith('timeout');
  });

  it.each([NaN, Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER])('refuses unsafe clock/deadline %s before arming a timer', now => {
    expect(() => harness({ clock: { now: () => now } })).toThrow(/safe numeric range/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a fractional monotonic microsecond clock', () => {
    const h = harness({ clock: { now: () => 123.75 } });
    h.head.acceptLargest(null); h.head.push(item(5, 0, 'live'));
    expect(h.delivered).toEqual(['5:0']);
  });
});

// Closed raw shapes keep status-vs-data mistakes observable without a decoder.
type ClosedValue = { kind: 'data'; payload: Uint8Array; label: string }
  | { kind: 'gap'; status: 3n | 4n; label: string };

function classified(group: number, object: number, kind: 'data' | 'eog' | 'eot',
  label = `${kind}:${group}:${object}`, source: 'prefix' | 'live' = 'live'): WarmStartItem<ClosedValue> {
  const value: ClosedValue = kind === 'data'
    ? { kind, payload: Uint8Array.of(1), label }
    : { kind: 'gap', status: kind === 'eog' ? 3n : 4n, label };
  return { group: BigInt(group), object: BigInt(object), source, value,
    bytes: value.kind === 'data' ? value.payload.byteLength : 0,
    continuation: kind === 'eot' ? 'terminal' : kind === 'data' && object === 0 ? 'group-start' : 'ordinary' };
}

function closedHarness(options: Partial<WarmStartHeadOptions<ClosedValue>> = {}) {
  let now = 0;
  const delivered: string[] = [], discarded: Array<[string, string]> = [];
  const abandon = vi.fn();
  const head = new WarmStartHead<ClosedValue>({ clock: { now: () => now }, isCurrent: () => true,
    deliver: value => { delivered.push(value.label); },
    discard: (value, reason) => { discarded.push([value.label, reason]); },
    onAbandon: abandon, ...options });
  heads.push(head);
  return { head, delivered, discarded, abandon,
    expire: () => { now = 1_000_000; vi.advanceTimersByTime(1000); } };
}

describe('WarmStartHead classified continuation', () => {
  it('does not use EOG object zero to rescue a dependent frame', () => {
    const h = closedHarness(); h.head.acceptLargest({ group: 100n, object: 1n }); h.expire();
    h.head.push(classified(101, 0, 'eog')); h.head.push(classified(101, 1, 'data'));
    expect.soft(h.head.state).toBe('fallback'); expect(h.delivered).toEqual([]);
    expect(h.discarded).toEqual([['eog:101:0', 'awaiting group start'], ['data:101:1', 'awaiting group start']]);
  });

  it('still resumes on a real nonempty DATA object zero', () => {
    const h = closedHarness(); h.head.acceptLargest({ group: 100n, object: 1n }); h.expire();
    h.head.push(classified(101, 0, 'data')); h.head.push(classified(101, 1, 'data'));
    expect(h.delivered).toEqual(['data:101:0', 'data:101:1']); expect(h.head.state).toBe('live');
  });

  it.each([[101, 0], [101, 7], [100, 2]])('forwards EOT %i:%i after expiry without selecting a data start', (group, object) => {
    const h = closedHarness(); h.head.acceptLargest({ group: 100n, object: 1n });
    h.head.push(classified(group, object, 'eot'));
    expect(h.delivered).toEqual([]); expect(h.abandon).not.toHaveBeenCalled();
    h.expire();
    expect.soft(h.delivered).toEqual([`eot:${group}:${object}`]);
    expect.soft(h.head.state).toBe('fallback'); expect(h.discarded).toEqual([]);
    h.head.push(classified(101, 1, 'data'));
    expect(h.delivered).toEqual([`eot:${group}:${object}`]);
  });

  it('forwards EOT after unknown-Largest expiry without guessing an anchor', () => {
    const h = closedHarness(); h.head.push(classified(101, 0, 'eot')); h.expire();
    expect(h.delivered).toEqual(['eot:101:0']); expect(h.head.state).toBe('fallback');
    h.head.push(classified(102, 0, 'data'));
    expect(h.discarded).toEqual([['data:102:0', 'awaiting largest']]);
  });

  it('does not let an EOT arrival itself abandon an incomplete prefix', () => {
    const h = closedHarness(); h.head.acceptLargest({ group: 100n, object: 1n });
    h.head.push(classified(100, 2, 'eot'));
    expect(h.abandon).not.toHaveBeenCalled(); expect(h.delivered).toEqual([]);
    h.head.push(classified(100, 0, 'data', 'head-0', 'prefix'));
    expect(h.delivered).toEqual(['head-0']);
    h.head.push(classified(100, 1, 'data', 'head-1', 'prefix'));
    expect(h.delivered).toEqual(['head-0', 'head-1', 'eot:100:2']);
    expect(h.abandon).not.toHaveBeenCalled();
  });

  it('reserves EOT outside a saturated data budget and waits for fenced in-flight work', async () => {
    const pending = deferred(); const started: string[] = [], delivered: string[] = [];
    const h = closedHarness({ maxObjects: 1, maxBytes: 1, deliver: async (value, { isLive }) => {
      started.push(value.label); if (value.kind === 'data') await pending.promise;
      if (isLive()) delivered.push(value.label);
    } });
    h.head.acceptLargest({ group: 100n, object: 1n });
    h.head.push(classified(100, 0, 'data', 'head', 'prefix'));
    h.head.push(classified(101, 7, 'eot'));
    expect.soft(h.head.retainedObjects).toBe(2); expect(h.head.retainedBytes).toBe(1);
    expect(h.abandon).not.toHaveBeenCalled();
    h.expire(); expect(started).toEqual(['head']); expect(h.discarded).toEqual([]);
    pending.resolve(); await settle();
    expect(started).toEqual(['head', 'eot:101:7']); expect(delivered).toEqual(['eot:101:7']);
    expect(h.head.retainedObjects).toBe(0); expect(h.head.state).toBe('fallback');
  });

  it('a terminal reservation does not consume any data admission slot', () => {
    const h = closedHarness({ maxObjects: 2, maxBytes: 2 }); h.head.acceptLargest({ group: 100n, object: 2n });
    h.head.push(classified(101, 7, 'eot'));
    h.head.push(classified(100, 1, 'data', 'head-1', 'prefix'));
    h.head.push(classified(100, 2, 'data', 'head-2', 'prefix'));
    expect(h.head.retainedObjects).toBe(3); expect(h.head.retainedBytes).toBe(2);
    expect(h.abandon).not.toHaveBeenCalled();
    h.expire(); expect(h.delivered).toEqual(['eot:101:7']);
  });

  it('FIN wakes EOT after accepted prefix work settles and reveals a hole', async () => {
    const pending = deferred(); const delivered: string[] = [];
    const h = closedHarness({ deliver: async (value, { isLive }) => {
      if (value.kind === 'data') await pending.promise;
      if (isLive()) delivered.push(value.label);
    } });
    h.head.acceptLargest({ group: 100n, object: 1n });
    h.head.push(classified(100, 0, 'data', 'head', 'prefix'));
    h.head.push(classified(100, 2, 'eot'));
    h.head.finishPrefix('fin'); expect(h.abandon).not.toHaveBeenCalled();
    pending.resolve(); await settle();
    expect(h.abandon).toHaveBeenCalledExactlyOnceWith('incomplete prefix');
    expect(delivered).toEqual(['head', 'eot:100:2']); expect(h.head.state).toBe('fallback');
  });

  it('orders queued live work before EOT without a FIN after the prefix is complete', async () => {
    const pending = deferred(); const delivered: string[] = [];
    const h = closedHarness({ deliver: async (value, { isLive }) => {
      if (value.label === 'live') await pending.promise;
      if (isLive()) delivered.push(value.label);
    } });
    h.head.acceptLargest({ group: 100n, object: 0n });
    h.head.push(classified(100, 1, 'data', 'live'));
    h.head.push(classified(100, 2, 'eot'));
    h.head.push(classified(100, 0, 'data', 'head', 'prefix')); await settle();
    expect(delivered).toEqual(['head']);
    pending.resolve(); await settle();
    expect(delivered).toEqual(['head', 'live', 'eot:100:2']);
    expect(h.head.state).not.toBe('live'); expect(h.abandon).not.toHaveBeenCalled();
  });

  it('can process an EOT inside the prefix only after every lower location', () => {
    const h = closedHarness(); h.head.acceptLargest({ group: 100n, object: 1n });
    h.head.push(classified(100, 1, 'eot', 'end', 'prefix'));
    expect(h.delivered).toEqual([]);
    h.head.push(classified(100, 0, 'data', 'head', 'prefix'));
    expect(h.delivered).toEqual(['head', 'end']); expect(h.head.state).not.toBe('live');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('processes saved Largest 100:2 EOT from FETCH immediately after data 0 and 1 settle', async () => {
    const prior = deferred(); const delivered: string[] = [];
    const h = closedHarness({ maxObjects: 2, maxBytes: 2, deliver: async (value, { isLive }) => {
      if (value.label === 'head-0') await prior.promise;
      if (isLive()) delivered.push(value.label);
    } });
    h.head.acceptLargest({ group: 100n, object: 2n });
    h.head.push(classified(100, 0, 'data', 'head-0', 'prefix'));
    h.head.push(classified(100, 1, 'data', 'head-1', 'prefix'));
    h.head.push(classified(100, 2, 'eot', 'end', 'prefix')); await settle();
    expect(delivered).toEqual([]); expect(h.abandon).not.toHaveBeenCalled();
    expect(h.head.retainedObjects).toBe(3); expect(h.head.retainedBytes).toBe(2);
    prior.resolve(); await settle();
    expect(delivered).toEqual(['head-0', 'head-1', 'end']);
    expect(h.head.state).not.toBe('live'); expect(h.head.retainedObjects).toBe(0);
    expect(h.abandon).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not erase a started EOT when the warm deadline expires during its await', async () => {
    const pending = deferred(); let guard!: () => boolean; const delivered: string[] = [];
    const h = closedHarness({ deliver: async (value, { isLive }) => {
      guard = isLive; await pending.promise; if (isLive()) delivered.push(value.label);
    } });
    h.head.acceptLargest({ group: 100n, object: 0n });
    h.head.push(classified(100, 0, 'eot', 'end', 'prefix')); h.expire();
    expect(guard()).toBe(true); pending.resolve(); await settle();
    expect(delivered).toEqual(['end']); expect(h.discarded).toEqual([]);
    expect(h.head.state).toBe('fallback'); expect(h.head.retainedObjects).toBe(0);
  });

  it.each(['reset', 'error'] as const)('%s preserves the owner guard of a started EOT', async terminal => {
    const pending = deferred(); let guard!: () => boolean; const delivered: string[] = [];
    const h = closedHarness({ deliver: async (value, { isLive }) => {
      guard = isLive; await pending.promise; if (isLive()) delivered.push(value.label);
    } });
    h.head.acceptLargest({ group: 100n, object: 0n });
    h.head.push(classified(100, 0, 'eot', 'end', 'prefix')); h.head.finishPrefix(terminal);
    expect(guard()).toBe(true); pending.resolve(); await settle();
    expect(delivered).toEqual(['end']); expect(h.head.state).toBe('fallback');
  });

  it('bounds duplicates across pending, in-flight, and delivered EOT to one control slot', async () => {
    const pending = deferred(); const started: string[] = [];
    const h = closedHarness({ deliver: value => { started.push(value.label); if (value.kind === 'gap') return pending.promise; } });
    h.head.acceptLargest({ group: 100n, object: 1n }); h.head.push(classified(101, 7, 'eot', 'first'));
    for (let i = 0; i < 100; i++) h.head.push(classified(102 + i, 0, 'eot', `duplicate-${i}`));
    expect(h.head.retainedObjects).toBe(1); expect(h.abandon).not.toHaveBeenCalled();
    h.expire(); h.head.push(classified(201, 0, 'eot', 'in-flight duplicate'));
    pending.resolve(); await settle(); h.head.push(classified(202, 0, 'eot', 'after completion'));
    expect(started).toEqual(['first']); expect(h.head.retainedObjects).toBe(0);
    expect(h.discarded).toHaveLength(102); expect(h.discarded.every(([, reason]) => reason === 'duplicate')).toBe(true);
  });

  it('retire discards an unstarted EOT exactly once', () => {
    const h = closedHarness(); h.head.acceptLargest({ group: 100n, object: 1n });
    h.head.push(classified(101, 7, 'eot')); h.head.retire(); h.head.retire();
    expect(h.discarded).toEqual([['eot:101:7', 'retired']]); expect(h.delivered).toEqual([]);
    expect(h.head.retainedObjects).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('retire fences an already started EOT without discarding it twice', async () => {
    const pending = deferred(); let isLive!: () => boolean; const delivered: string[] = [];
    const h = closedHarness({ deliver: async (value, context) => {
      isLive = context.isLive; await pending.promise; if (isLive()) delivered.push(value.label);
    } });
    h.head.acceptLargest({ group: 100n, object: 1n }); h.expire(); h.head.push(classified(101, 7, 'eot'));
    expect(typeof isLive).toBe('function'); h.head.retire(); expect(isLive()).toBe(false);
    pending.resolve(); await settle();
    expect(delivered).toEqual([]); expect(h.discarded).toEqual([]); expect(h.head.retainedObjects).toBe(0);
  });

  it('a reentrant retire during expiry cannot reserve the incoming EOT afterwards', () => {
    let head!: WarmStartHead<ClosedValue>, now = 0;
    const h = closedHarness({ clock: { now: () => now }, onAbandon: () => { head.retire(); } });
    head = h.head; head.acceptLargest({ group: 100n, object: 1n }); now = 1_000_000;
    head.push(classified(101, 7, 'eot'));
    expect(h.discarded).toEqual([['eot:101:7', 'retired']]);
    expect(head.retainedObjects).toBe(0); expect(h.delivered).toEqual([]);
  });

  it('a terminal delivery callback cannot reserve a reentrant duplicate', () => {
    let head!: WarmStartHead<ClosedValue>; const delivered: string[] = [];
    const h = closedHarness({ deliver: value => {
      delivered.push(value.label); head.push(classified(102, 0, 'eot', 'duplicate'));
    } }); head = h.head; head.acceptLargest({ group: 100n, object: 1n }); h.expire();
    head.push(classified(101, 7, 'eot', 'first'));
    expect(delivered).toEqual(['first']); expect(h.discarded).toEqual([['duplicate', 'duplicate']]);
    expect(head.retainedObjects).toBe(0); expect(head.state).toBe('fallback');
  });

  it('owner loss fences a started EOT even though warm data fences do not', async () => {
    let current = true, guard!: () => boolean; const pending = deferred();
    const h = closedHarness({ isCurrent: () => current, deliver: (_value, { isLive }) => { guard = isLive; return pending.promise; } });
    h.head.acceptLargest({ group: 100n, object: 1n }); h.expire(); h.head.push(classified(101, 7, 'eot'));
    current = false; expect(guard()).toBe(false); pending.resolve(); await settle();
    expect(h.head.state).toBe('retired'); expect(h.head.retainedObjects).toBe(0); expect(h.discarded).toEqual([]);
  });
});

describe('WarmStartHead continuation validation', () => {
  it('requires classification on every input', () => {
    const h = harness(); const input = item(5, 0);
    Reflect.deleteProperty(input, 'continuation');
    expect(() => h.head.push(input)).toThrow(/classification/);
    expect(h.head.retainedObjects).toBe(0);
  });
  it('requires object zero and nonempty data accounting for a group start', () => {
    const h = harness();
    expect(() => h.head.push({ ...item(5, 1), continuation: 'group-start' })).toThrow(/group-start/);
    expect(() => h.head.push({ ...item(5, 0), bytes: 0, continuation: 'group-start' })).toThrow(/group-start/);
    expect(h.head.retainedObjects).toBe(0);
  });
  it('requires a zero-byte terminal so its reserve cannot hide a payload', () => {
    const h = harness();
    expect(() => h.head.push({ ...item(5, 0), continuation: 'terminal' })).toThrow(/zero payload/);
    expect(h.head.retainedObjects).toBe(0);
  });
});
