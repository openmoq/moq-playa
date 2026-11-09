import { describe, expect, it, vi } from 'vitest';
import type { MoqtObject } from '@openmoq/transport';
import { SeekLiveQueue } from './seek-live-queue.js';

type Options = ConstructorParameters<typeof SeekLiveQueue>[0];
function deferred() { let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function data(id = 0, size = 2): MoqtObject & { kind: 'data' } {
  return { kind: 'data', trackAlias: 0n, groupId: 7n, subgroupId: 0n, objectId: BigInt(id), publisherPriority: 128,
    payload: new Uint8Array(size).fill(id) };
}
function fixture(overrides: Partial<Options> = {}) {
  let current = true; const events: string[] = [], captures: MoqtObject[] = [], tokens = new WeakMap<MoqtObject, object>();
  const predicates: Array<() => boolean> = [];
  const capture = vi.fn((object: MoqtObject) => { captures.push(object); const input = { id: object.objectId }; tokens.set(object, input); return input; });
  const discard = vi.fn(), error = vi.fn();
  const prefix = vi.fn(async (object: MoqtObject, _input: object | undefined, admitted: () => boolean) => { events.push('prefix:' + object.objectId); predicates.push(admitted); });
  const live = vi.fn(async (object: MoqtObject, _input: object | undefined, admitted: () => boolean) => { events.push('live:' + object.objectId); predicates.push(admitted); });
  const ready = vi.fn(() => { events.push('ready'); }), ended = vi.fn(() => { events.push('ended'); });
  const options: Options = { maxObjects: 8, maxBytes: 1024, isCurrent: () => current, capture, onDiscard: discard,
    consumePrefix: prefix, consumeLive: live, onPrefixDrained: ready, onTrackEnded: ended, onError: error, ...overrides };
  const queue = new SeekLiveQueue(options);
  return { queue, events, captures, tokens, predicates, capture, discard, error, prefix, live, ready, ended,
    withdraw() { current = false; } };
}

it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses unusable object/byte budgets %s', value => {
  expect(() => fixture({ maxObjects: value })).toThrow(RangeError);
  expect(() => fixture({ maxBytes: value })).toThrow(RangeError);
});

describe('finite prefix and serial live intake', () => {
  it('holds prefix before acceptance, then orders prefix/ready/live across streams', async () => {
    const f = fixture(), p = f.queue.openPrefix(), a = f.queue.openLiveStream(), b = f.queue.openLiveStream();
    const work = [a.push(data(2)), p.push(data(0)), b.push(data(3)), p.push(data(1))];
    p.close('fin'); a.close('fin'); b.close('fin'); await flush(); expect(f.events).toEqual([]);
    f.queue.acceptPrefix(); await Promise.all(work);
    expect(f.events).toEqual(['prefix:0', 'prefix:1', 'ready', 'live:2', 'live:3']);
    expect(f.error).not.toHaveBeenCalled(); expect(f.ended).not.toHaveBeenCalled(); f.queue.cancel();
  });
  it('allows ACK before the prefix header, but never infers prefix completion from a live FIN', async () => {
    const f = fixture(); f.queue.acceptPrefix();
    const live = f.queue.openLiveStream(), work = live.push(data(1)); live.close('fin');
    await flush(); expect(f.events).toEqual([]);
    const p = f.queue.openPrefix(); p.close('fin'); await work;
    expect(f.events).toEqual(['ready', 'live:1']); expect(f.ended).not.toHaveBeenCalled(); f.queue.cancel();
  });
  it('does not open live delivery until an async prefix-drained callback has settled', async () => {
    const gate = deferred(), events: string[] = [];
    const f = fixture({ onPrefixDrained: async () => { events.push('install'); await gate.promise; events.push('installed'); },
      consumeLive: async () => { events.push('live'); } });
    const p = f.queue.openPrefix(), l = f.queue.openLiveStream(), work = l.push(data());
    f.queue.acceptPrefix(); p.close('fin'); await flush(); expect(events).toEqual(['install']);
    gate.resolve(); await work; expect(events).toEqual(['install', 'installed', 'live']); f.queue.cancel();
  });
  it('keeps only one consumer running across all live streams', async () => {
    const gate = deferred(), order: number[] = [];
    const f = fixture({ consumeLive: async object => { order.push(Number(object.objectId)); if (object.objectId === 1n) await gate.promise; } });
    const p = f.queue.openPrefix(); f.queue.acceptPrefix(); p.close('fin'); await flush();
    const a = f.queue.openLiveStream(), b = f.queue.openLiveStream(), first = a.push(data(1)), second = b.push(data(2));
    a.close('fin'); b.close('fin'); await flush(); expect(order).toEqual([1]);
    gate.resolve(); await Promise.all([first, second]); expect(order).toEqual([1, 2]); f.queue.cancel();
  });
  it('healthy FIN retains accepted work and its post-await admission', async () => {
    const gate = deferred(), admitted: boolean[] = []; let still!: () => boolean;
    const f = fixture({ consumePrefix: async (_object, _input, predicate) => { still = predicate; admitted.push(predicate()); await gate.promise; admitted.push(predicate()); } });
    const p = f.queue.openPrefix(); f.queue.acceptPrefix(); const work = p.push(data()); await flush(); p.close('fin');
    expect(still()).toBe(true); expect(f.ready).not.toHaveBeenCalled();
    gate.resolve(); await work; await flush(); expect(admitted).toEqual([true, true]); expect(still()).toBe(true);
    expect(f.ready).toHaveBeenCalledOnce(); f.queue.cancel(); expect(still()).toBe(false);
  });
  it('permits exactly one finite prefix per instance', () => {
    const f = fixture(); f.queue.openPrefix(); expect(() => f.queue.openPrefix()).toThrow(/prefix/i);
    expect(f.error).toHaveBeenCalledOnce(); f.queue.cancel();
  });
});

describe('owned intake copies and global bounds', () => {
  it('captures the original before copying bytes and preserves the exact opaque input', async () => {
    const raw = data(0), input = {}, seen: MoqtObject[] = [];
    const f = fixture({ capture: object => { expect(object).toBe(raw); raw.payload[0] = 8; return input; },
      consumePrefix: async (object, context) => { expect(context).toBe(input); seen.push(object); } });
    const p = f.queue.openPrefix(), work = p.push(raw); raw.payload[0] = 99;
    f.queue.acceptPrefix(); p.close('fin'); await work;
    const copy = seen[0]; expect(copy).not.toBe(raw); if (copy?.kind !== 'data') throw new Error('Expected copied data');
    expect(copy.payload[0]).toBe(8); f.queue.cancel();
  });
  it('copies payload/properties/extensions, counting a shared properties-extension view only once', async () => {
    const shared = Uint8Array.of(2, 3, 4), raw = { ...data(1), properties: shared, extensions: shared };
    const f = fixture({ maxBytes: 5 }); const p = f.queue.openPrefix(), work = p.push(raw);
    raw.payload.fill(9); shared.fill(9); f.queue.acceptPrefix(); p.close('fin'); await work;
    const copied = f.prefix.mock.calls[0]![0]; if (copied.kind !== 'data') throw new Error('Expected data');
    expect([...copied.payload]).toEqual([1, 1]); expect([...copied.properties!]).toEqual([2, 3, 4]);
    expect(copied.extensions).toBe(copied.properties); expect(copied.extensions).not.toBe(shared); f.queue.cancel();
  });
  it('accounts distinct extension buffers and zero-byte gap Objects without inventing inputs', async () => {
    const f = fixture({ maxBytes: 6 }); const p = f.queue.openPrefix(), l = f.queue.openLiveStream();
    const raw = { ...data(1), properties: Uint8Array.of(1, 2), extensions: Uint8Array.of(3, 4) };
    const gap: MoqtObject = { kind: 'gap', trackAlias: 0n, groupId: 7n, subgroupId: 0n, objectId: 2n, status: 1n };
    const work = [p.push(raw), l.push(gap)]; f.queue.acceptPrefix(); p.close('fin'); await Promise.all(work);
    expect(f.live.mock.calls[0]![0]).toEqual(gap); expect(f.live.mock.calls[0]![0]).not.toBe(gap);
    expect(f.capture).toHaveBeenCalledWith(gap); f.queue.cancel();
  });
  it('capture cannot add uncharged byte fields after admission was reserved', async () => {
    const raw = data(0), extra = new Uint8Array(4096);
    const f = fixture({ maxBytes: 2, capture: object => { Object.defineProperty(object, 'properties', { value: extra, enumerable: true }); return {}; } });
    const p = f.queue.openPrefix(), work = p.push(raw); f.queue.acceptPrefix(); p.close('fin'); await work;
    expect(f.prefix.mock.calls[0]![0]).not.toHaveProperty('properties'); expect(f.error).not.toHaveBeenCalled(); f.queue.cancel();
  });
  it('capture-time buffer growth cannot expand the admitted copy beyond charged byte credit', async () => {
    const backing: ArrayBuffer = Reflect.construct(ArrayBuffer, [2, { maxByteLength: 4096 }]);
    const raw = { ...data(0), payload: new Uint8Array(backing) }; raw.payload.set([4, 5]);
    const f = fixture({ maxBytes: 2, capture: () => { Reflect.apply(Reflect.get(backing, 'resize'), backing, [4096]); return {}; } });
    const p = f.queue.openPrefix(), work = p.push(raw); f.queue.acceptPrefix(); p.close('fin'); await work;
    const copy = f.prefix.mock.calls[0]![0]; if (copy.kind !== 'data') throw new Error('Expected data');
    expect(backing.byteLength).toBe(4096); expect(copy.payload.byteLength).toBe(2); expect([...copy.payload]).toEqual([4, 5]);
    expect(f.error).not.toHaveBeenCalled(); f.queue.cancel();
  });
  it('copies the actual gap metadata without retaining uncharged extraneous payload fields', async () => {
    const raw = { ...data(0, 4096), kind: 'gap' as const, status: 1n };
    const f = fixture({ maxBytes: 1 }), p = f.queue.openPrefix(), work = p.push(raw);
    f.queue.acceptPrefix(); p.close('fin'); await work;
    expect(f.prefix.mock.calls[0]![0]).toMatchObject({ kind: 'gap', status: 1n });
    expect(f.prefix.mock.calls[0]![0]).not.toHaveProperty('payload'); f.queue.cancel();
  });
  it('byte-view access that retires the owner cannot proceed into capture or strand a waiter', async () => {
    const f = fixture(), bytes = Uint8Array.of(1, 2), raw = data();
    Object.defineProperty(raw, 'payload', { get() { f.queue.cancel(); return bytes; } });
    const p = f.queue.openPrefix(), work = p.push(raw);
    expect(f.capture).not.toHaveBeenCalled(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.error).not.toHaveBeenCalled(); expect(f.prefix).not.toHaveBeenCalled();
  });
  it('counts in-flight prefix plus queued live Objects under one budget; the invoked input is consumer-owned', async () => {
    const gate = deferred(), f = fixture({ maxObjects: 3, consumePrefix: async () => gate.promise });
    const p = f.queue.openPrefix(), l = f.queue.openLiveStream(), raw = [data(0), data(1), data(2), data(3)];
    f.queue.acceptPrefix(); const first = p.push(raw[0]!); await flush();
    const second = l.push(raw[1]!), third = l.push(raw[2]!), refused = l.push(raw[3]!);
    await expect(refused).rejects.toThrow(/budget/i); await Promise.allSettled([first, second, third]);
    expect(f.capture).toHaveBeenCalledTimes(3); expect(f.discard.mock.calls.map(call => call[0])).toEqual([f.tokens.get(raw[1]!), f.tokens.get(raw[2]!)]);
    expect(f.error).toHaveBeenCalledOnce(); gate.reject(new Error('late native failure')); await flush();
    expect(f.error).toHaveBeenCalledOnce();
  });
  it('counts byte budget while native work is pending, not merely while queued', async () => {
    const gate = deferred(), f = fixture({ maxBytes: 4, consumePrefix: async () => gate.promise });
    const p = f.queue.openPrefix(), l = f.queue.openLiveStream(); f.queue.acceptPrefix();
    const first = p.push(data(0, 4)); await flush();
    await expect(l.push(data(1, 1))).rejects.toThrow(/budget/i); await expect(first).rejects.toThrow();
    expect(f.error).toHaveBeenCalledOnce(); expect(f.discard).not.toHaveBeenCalled(); gate.resolve(); await flush();
  });
  it('releases settled credit for later live work', async () => {
    const f = fixture({ maxObjects: 2, maxBytes: 2 }), p = f.queue.openPrefix(); f.queue.acceptPrefix();
    await p.push(data(0)); p.close('fin'); await flush();
    const l = f.queue.openLiveStream(); await l.push(data(1)); await l.push(data(2));
    expect(f.events).toEqual(['prefix:0', 'ready', 'live:1', 'live:2']); expect(f.error).not.toHaveBeenCalled(); f.queue.cancel();
  });
  it('bounds even empty stream opens and releases terminal zero-pending records', async () => {
    const f = fixture({ maxObjects: 2 }), p = f.queue.openPrefix(); f.queue.acceptPrefix(); p.close('fin'); await flush();
    for (let i = 0; i < 40; i++) f.queue.openLiveStream().close('fin');
    f.queue.openLiveStream(); f.queue.openLiveStream();
    expect(() => f.queue.openLiveStream()).toThrow(/stream.*budget/i); expect(f.error).toHaveBeenCalledOnce();
  });
  it('retains a FIN stream record while its accepted native work is still pending', async () => {
    const gate = deferred(), f = fixture({ maxObjects: 1, consumePrefix: async () => gate.promise });
    const p = f.queue.openPrefix(); f.queue.acceptPrefix(); const work = p.push(data()); await flush(); p.close('fin');
    expect(() => f.queue.openLiveStream()).toThrow(/stream.*budget/i); await expect(work).rejects.toThrow();
    expect(f.discard).not.toHaveBeenCalled(); gate.resolve(); await flush();
  });
});

describe('retirement, errors and callback reentry', () => {
  it('reset after healthy FIN revokes in-flight admission and explicitly fails the boundary once', async () => {
    const gate = deferred(); let admitted!: () => boolean;
    const f = fixture({ consumePrefix: async (_object, _input, predicate) => { admitted = predicate; await gate.promise; } });
    const p = f.queue.openPrefix(), l = f.queue.openLiveStream(), firstRaw = data(), liveRaw = data(1);
    f.queue.acceptPrefix(); const first = p.push(firstRaw); await flush(); const queued = l.push(liveRaw); p.close('fin');
    expect(admitted()).toBe(true); p.close('reset'); p.close('error');
    await expect(first).rejects.toThrow(/reset/i); await expect(queued).rejects.toThrow(/reset/i);
    expect(admitted()).toBe(false); expect(f.discard).toHaveBeenCalledExactlyOnceWith(f.tokens.get(liveRaw));
    expect(f.error).toHaveBeenCalledOnce(); expect(f.ready).not.toHaveBeenCalled(); gate.reject(new Error('late')); await flush();
  });
  it('prefix failure before acceptance discards captured unconsumed inputs and never drains live', async () => {
    const f = fixture(), p = f.queue.openPrefix(), l = f.queue.openLiveStream(), first = p.push(data()), second = l.push(data(1));
    p.close('fin'); p.close('error'); f.queue.acceptPrefix();
    await Promise.allSettled([first, second]); expect(f.discard).toHaveBeenCalledTimes(2);
    expect(f.prefix).not.toHaveBeenCalled(); expect(f.live).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled(); expect(f.error).toHaveBeenCalledOnce();
  });
  it('cancel releases a never-settling native wait locally, with no double discard or error', async () => {
    const gate = deferred(), f = fixture({ consumePrefix: async () => gate.promise }), p = f.queue.openPrefix(), l = f.queue.openLiveStream();
    f.queue.acceptPrefix(); const first = p.push(data()); await flush(); const secondRaw = data(1), second = l.push(secondRaw);
    f.queue.cancel(); f.queue.cancel();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' }); await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.discard).toHaveBeenCalledExactlyOnceWith(f.tokens.get(secondRaw)); expect(f.error).not.toHaveBeenCalled();
    gate.reject(new Error('late')); await flush(); expect(f.error).not.toHaveBeenCalled();
  });
  it('owns ignored SDK-return promises and fences late callback rejection after cancellation', async () => {
    const gate = deferred(), f = fixture({ consumeLive: async () => gate.promise });
    const p = f.queue.openPrefix(); f.queue.acceptPrefix(); p.close('fin'); await flush();
    const l = f.queue.openLiveStream(); void l.push(data()); await flush(); void l.push(data(1));
    f.queue.cancel(); gate.reject(new Error('ignored native rejection')); void l.push(data(2)); await flush();
    expect(f.error).not.toHaveBeenCalled(); expect(f.capture).toHaveBeenCalledTimes(2);
  });
  it('handles capture-time cancellation and reentrant close without resurrecting an entry', async () => {
    let queue!: SeekLiveQueue; const token = {}, discard = vi.fn();
    const f = fixture({ capture: () => { queue.cancel(); return token; }, onDiscard: discard }); queue = f.queue;
    const p = queue.openPrefix(); await expect(p.push(data())).rejects.toMatchObject({ name: 'AbortError' });
    expect(discard).toHaveBeenCalledExactlyOnceWith(token); expect(f.prefix).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled();
  });
  it('capture reentry reserves FIFO position and budget before accepting another Object', async () => {
    let queue!: SeekLiveQueue, prefix!: ReturnType<SeekLiveQueue['openPrefix']>; const seen: bigint[] = [], nested: Promise<void>[] = [];
    const f = fixture({ capture: object => { if (object.objectId === 0n) nested.push(prefix.push(data(1))); return {}; },
      consumePrefix: async object => { seen.push(object.objectId); } }); queue = f.queue; prefix = queue.openPrefix();
    const first = prefix.push(data()); queue.acceptPrefix(); prefix.close('fin'); await Promise.all([first, ...nested]);
    expect(seen).toEqual([0n, 1n]); queue.cancel();
  });
  it('cancels during async prefix-drained callback and never invokes queued live or end callbacks', async () => {
    const gate = deferred(), f = fixture({ onPrefixDrained: () => gate.promise });
    const p = f.queue.openPrefix(), l = f.queue.openLiveStream(), work = l.push(data()); f.queue.acceptPrefix(); p.close('fin');
    await flush(); f.queue.endTrack(); f.queue.cancel(); await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    gate.reject(new Error('late callback')); await flush(); expect(f.live).not.toHaveBeenCalled(); expect(f.ended).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled();
  });
  it('does not invoke delivery/completion/error after owner withdrawal', async () => {
    const gate = deferred(), f = fixture({ consumePrefix: async () => gate.promise }), p = f.queue.openPrefix(), l = f.queue.openLiveStream();
    f.queue.acceptPrefix(); const first = p.push(data()); await flush(); const second = l.push(data(1)); p.close('fin'); f.withdraw(); gate.resolve();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' }); await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.live).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled();
  });
  it('cleanup callback reentry cannot touch a successor queue or duplicate old outcomes', async () => {
    const next = fixture(); let old!: SeekLiveQueue;
    const f = fixture({ onDiscard: async () => { old.cancel(); const p = next.queue.openPrefix(); next.queue.acceptPrefix(); p.close('fin'); throw new Error('observer'); } }); old = f.queue;
    const p = old.openPrefix(), work = p.push(data()); p.close('reset'); await expect(work).rejects.toThrow(); await flush();
    const l = next.queue.openLiveStream(); await l.push(data(9)); expect(next.error).not.toHaveBeenCalled(); expect(next.live).toHaveBeenCalledOnce();
    expect(f.error).toHaveBeenCalledOnce(); next.queue.cancel();
  });
  it('owns a synchronous consumer throw even when discard and error observers also throw', async () => {
    const boom = new Error('synchronous native failure'), discarded = vi.fn(() => { throw new Error('discard observer'); });
    const reported = vi.fn(() => { throw new Error('error observer'); });
    const f = fixture({ consumePrefix: () => { throw boom; }, onDiscard: discarded, onError: reported });
    const p = f.queue.openPrefix(), l = f.queue.openLiveStream(), liveRaw = data(1); f.queue.acceptPrefix();
    const first = p.push(data()), second = l.push(liveRaw); p.close('fin');
    await expect(first).rejects.toBe(boom); await expect(second).rejects.toBe(boom); await flush();
    expect(discarded).toHaveBeenCalledExactlyOnceWith(f.tokens.get(liveRaw)); expect(reported).toHaveBeenCalledExactlyOnceWith(boom);
    expect(f.ready).not.toHaveBeenCalled(); f.queue.cancel();
  });
  it.each(['capture', 'prefix', 'live', 'ready', 'ended'] as const)('reports %s callback failure once and preserves input terminal ownership', async kind => {
    const boom = new Error('callback failure');
    const f = fixture({ ...(kind === 'capture' ? { capture: () => { throw boom; } } : {}),
      ...(kind === 'prefix' ? { consumePrefix: async () => { throw boom; } } : {}),
      ...(kind === 'live' ? { consumeLive: async () => { throw boom; } } : {}),
      ...(kind === 'ready' ? { onPrefixDrained: async () => { throw boom; } } : {}),
      ...(kind === 'ended' ? { onTrackEnded: async () => { throw boom; } } : {}),
      onError: async () => { f.error(boom); throw new Error('error observer'); } });
    const p = f.queue.openPrefix(), l = f.queue.openLiveStream(); f.queue.acceptPrefix();
    const work = kind === 'capture' || kind === 'prefix' ? p.push(data()) : l.push(data()); p.close('fin');
    if (kind === 'ended') { await work; f.queue.endTrack(); } else await work.catch(() => {});
    await flush(); expect(f.error).toHaveBeenCalledExactlyOnceWith(boom);
    expect(f.discard).toHaveBeenCalledTimes(kind === 'ready' ? 1 : 0); f.queue.cancel();
  });
});

describe('explicit end-of-track proof', () => {
  it('waits accepted live work and async track-ended once; healthy completion retains admission', async () => {
    const gate = deferred(), ending = deferred(), ended = vi.fn(() => ending.promise); let admitted!: () => boolean;
    const f = fixture({ consumeLive: async (_object, _input, predicate) => { admitted = predicate; await gate.promise; }, onTrackEnded: ended });
    const p = f.queue.openPrefix(); f.queue.acceptPrefix(); p.close('fin'); await flush();
    const l = f.queue.openLiveStream(), work = l.push(data()); l.close('fin'); f.queue.endTrack(); f.queue.endTrack();
    await flush(); expect(f.events).toEqual(['ready']); expect(admitted()).toBe(true); expect(ended).not.toHaveBeenCalled();
    gate.resolve(); await work; await flush(); expect(admitted()).toBe(true); expect(ended).toHaveBeenCalledOnce();
    f.queue.endTrack(); ending.resolve(); await flush(); expect(ended).toHaveBeenCalledOnce(); expect(admitted()).toBe(true); expect(f.error).not.toHaveBeenCalled(); f.queue.cancel(); expect(admitted()).toBe(false);
  });
  it('endTrack before prefix acceptance waits its actual prefix FIN and drained callback', async () => {
    const f = fixture(), p = f.queue.openPrefix(), l = f.queue.openLiveStream(), work = l.push(data()); f.queue.endTrack();
    await flush(); expect(f.events).toEqual([]); f.queue.acceptPrefix(); await flush(); expect(f.events).toEqual([]);
    p.close('fin'); await work; await flush(); expect(f.events).toEqual(['ready', 'live:0', 'ended']);
    f.queue.endTrack(); expect(f.ended).toHaveBeenCalledOnce(); f.queue.cancel();
  });
  it('cancel during async track-ended owns a late rejection without reporting an error', async () => {
    const ending = deferred(), ended = vi.fn(() => ending.promise), f = fixture({ onTrackEnded: ended });
    const p = f.queue.openPrefix(); f.queue.acceptPrefix(); p.close('fin'); f.queue.endTrack(); await flush(); expect(ended).toHaveBeenCalledOnce();
    f.queue.cancel(); ending.reject(new Error('late')); await flush(); expect(f.error).not.toHaveBeenCalled(); expect(ended).toHaveBeenCalledOnce();
  });
});


describe('synchronous capture boundary', () => {
  it.each(['resolved', 'rejected'] as const)('refuses a %s Promise token without delivering it or leaking its rejection', async kind => {
    const f = fixture({ capture: () => kind === 'resolved' ? Promise.resolve({}) : Promise.reject(new Error('capture rejected')) });
    const p = f.queue.openPrefix(); f.queue.acceptPrefix();
    await expect(p.push(data())).rejects.toThrow(/synchronous/); await flush();
    expect(f.prefix).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled(); expect(f.error).toHaveBeenCalledOnce(); f.queue.cancel();
  });
  it('owns a rejected capture return even when capture cancelled reentrantly', async () => {
    let queue!: SeekLiveQueue;
    const f = fixture({ capture: () => { queue.cancel(); return Promise.reject(new Error('retired capture rejected')); } });
    queue = f.queue; const p = queue.openPrefix(); queue.acceptPrefix();
    await expect(p.push(data())).rejects.toMatchObject({ name: 'AbortError' }); await flush();
    expect(f.prefix).not.toHaveBeenCalled(); expect(f.discard).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled();
  });
});
