import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmStartHead, type WarmStartHeadOptions } from './warm-start-head.js';

const heads: WarmStartHead<string>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { heads.splice(0).forEach(h => h.retire()); vi.useRealTimers(); });
function setup(extra: Partial<Omit<WarmStartHeadOptions<string>, 'prefixStart'>> & { prefixStart?: WarmStartHeadOptions<string>['prefixStart'] } = {}) {
  let now = 0;
  const delivered: string[] = [], discarded: string[] = [];
  const options = { clock: { now: () => now }, isCurrent: () => true,
    prefixStart: { group: 4n, object: 0n },
    deliver: (value: string) => { delivered.push(value); },
    discard: (value: string) => { discarded.push(value); }, ...extra };
  const { prefixStart, ...rest } = options;
  const head = new WarmStartHead<string>({ ...rest, ...(prefixStart === undefined ? {} : { prefixStart }) }); heads.push(head);
  const push = (group: bigint, object: bigint, source: 'prefix' | 'live' = 'prefix', bytes = 1) => head.push({
    group, object, source, bytes, continuation: object === 0n ? 'group-start' : 'ordinary', value: `${group}/${object}`,
  });
  return { head, push, delivered, discarded, expire: () => { now = 1_000_000; vi.advanceTimersByTime(1000); } };
}
describe('bounded multi-group initial prefix', () => {
  it('waits for FIN, then drains sparse history before the held live tail without inventing missing IDs', () => {
    const h = setup(); h.head.acceptLargest({ group: 5n, object: 2n });
    h.push(5n, 3n, 'live'); h.push(5n, 2n); h.push(4n, 0n); h.push(4n, 3n);
    expect(h.delivered).toEqual([]);
    h.head.finishPrefix('fin');
    expect(h.delivered).toEqual(['4/0', '4/3', '5/2', '5/3']);
    expect(h.head.retainedObjects).toBe(0);
  });
  it('does not borrow objects before the requested prefix start', () => {
    const h = setup(); h.head.acceptLargest({ group: 5n, object: 0n });
    h.push(3n, 0n); h.push(4n, 0n); h.push(5n, 0n); h.head.finishPrefix('fin');
    expect(h.delivered).toEqual(['4/0', '5/0']); expect(h.discarded).toContain('3/0');
  });
  it('deduplicates overlapping live/prefix locations and preserves the first object past the saved head', () => {
    const h = setup(); h.head.acceptLargest({ group: 5n, object: 1n });
    h.push(4n, 0n); h.push(5n, 0n); h.push(5n, 1n); h.push(5n, 1n, 'live'); h.push(5n, 2n, 'live');
    h.head.finishPrefix('fin'); h.push(4n, 0n);
    expect(h.delivered).toEqual(['4/0', '5/0', '5/1', '5/2']);
  });
  it('releases an empty range beyond Largest without waiting for a nonexistent fill stream', () => {
    const h = setup(); h.head.acceptLargest({ group: 3n, object: 9n });
    h.push(3n, 10n, 'live'); h.push(4n, 0n, 'live');
    expect(h.delivered).toEqual(['4/0']); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['reset', 'error', 'timeout'] as const)('abandons %s history and resumes only at a later group start', terminal => {
    const h = setup(); h.head.acceptLargest({ group: 5n, object: 1n });
    h.push(4n, 0n); h.push(5n, 2n, 'live'); h.push(6n, 0n, 'live');
    if (terminal === 'timeout') h.expire(); else h.head.finishPrefix(terminal);
    expect(h.delivered).toEqual(['6/0']); expect(h.head.retainedObjects).toBe(0);
  });
  it('retains byte credit and holds live delivery until accepted prefix work settles', async () => {
    let resolve!: () => void; const held = new Promise<void>(yes => { resolve = yes; });
    const order: string[] = [];
    const h = setup({ deliver: value => { order.push(value); return value === '4/0' ? held : undefined; } });
    h.head.acceptLargest({ group: 5n, object: 0n }); h.push(4n, 0n); h.push(5n, 0n); h.push(6n, 0n, 'live');
    h.head.finishPrefix('fin'); expect(order).toEqual(['4/0']); expect(h.head.retainedBytes).toBe(3);
    resolve(); for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(order).toEqual(['4/0', '5/0', '6/0']); expect(h.head.retainedBytes).toBe(0);
  });
});


describe('finite prefix fallback before any history delivery', () => {
  it.each(['queued', 'late'] as const)('uses an independent live start in the abandoned range (%s)', arrival => {
    const h = setup(); h.head.acceptLargest({ group: 5n, object: 2n });
    if (arrival === 'queued') { h.push(5n, 0n, 'live'); h.push(5n, 1n, 'live'); }
    h.expire();
    if (arrival === 'late') { h.push(5n, 0n, 'live'); h.push(5n, 1n, 'live'); }
    h.push(5n, 2n, 'live'); h.push(5n, 3n, 'live');
    expect(h.delivered).toEqual(['5/0', '5/1', '5/2', '5/3']);
    h.push(4n, 0n, 'live'); h.push(5n, 0n, 'prefix');
    expect(h.delivered).toEqual(['5/0', '5/1', '5/2', '5/3']);
  });
  it('still waits for a group start after a dependent live object', () => {
    const h = setup(); h.head.acceptLargest({ group: 5n, object: 2n }); h.expire();
    h.push(5n, 1n, 'live'); expect(h.delivered).toEqual([]);
    h.push(6n, 0n, 'live'); expect(h.delivered).toEqual(['6/0']);
  });
  it('does not rewind when prefix delivery began before timeout', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const delivered: string[] = [];
    const h = setup({ deliver: value => { delivered.push(value); return hold; } });
    h.head.acceptLargest({ group: 5n, object: 2n }); h.push(5n, 0n); h.head.finishPrefix('fin');
    expect(delivered).toEqual(['5/0']); h.expire(); h.push(5n, 0n, 'live');
    expect(delivered).toEqual(['5/0']); release(); await Promise.resolve();
  });
  it('keeps default single-group fallback policy unchanged', () => {
    const h = setup({ prefixStart: undefined }); h.head.acceptLargest({ group: 5n, object: 2n });
    h.expire(); h.push(5n, 0n, 'live'); expect(h.delivered).toEqual([]);
    h.push(6n, 0n, 'live'); expect(h.delivered).toEqual(['6/0']);
  });
});
