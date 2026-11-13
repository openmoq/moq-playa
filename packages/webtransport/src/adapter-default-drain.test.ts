import { describe, expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import type { TerminalDeliveryOptions } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

// Real endpoints over deterministic loopback; hold data/FIN while DONE overtakes it.
describe.each([14, 16, 18, 22] as const)('draft %i default terminal delivery', draft => {
  it.each(['generic', 'raw'] as const)('%s delivers the late tail and FINs, with discard/unsubscribe/drain controls', async api => {
    for (const mode of ['discard', 'unsubscribe', 'drain', 'default'] as const) {
      const faults = { hold: false };
      const h = await connectedPair(draft, { faults: { b: faults } });
      const objects: number[] = [], fins: bigint[] = [];
      const options: TerminalDeliveryOptions = mode === 'discard' ? { terminalDelivery: 'discard' }
        : mode === 'drain' ? { terminalDelivery: 'drain' } : {};
      h.client.onObject = (_id, obj) => { if (obj.kind === 'data') objects.push(obj.payload[0]!); };
      h.client.onStreamClosed = (id, _error, terminal) => {
        if (api === 'generic' && terminal === 'fin') fins.push(id);
      };
      try {
        let id!: bigint;
        const pending = api === 'raw'
          ? h.client.subscribeTrack(ns('tail'), nm('video'), { ...options, onRequestId: value => { id = value; },
            onObject: obj => { if (obj.kind === 'data') objects.push(obj.payload[0]!); },
            onSubgroupClosed: header => fins.push(header.groupId) })
          : h.client.subscribe(ns('tail'), nm('video'), { ...options, onRequestId: value => { id = value; } });
        await flush(128); await h.server.acceptSubscribe(id, 7n); await pending; await flush(128);
        const first = await h.server.openSubgroup(7n, 0n, 0n);
        await h.server.sendObject(first, 0n, Uint8Array.of(1)); await flush(128);
        const openPipe = h.b.uniOut.at(-1)!; openPipe.faults.hold = true;
        await h.server.sendObject(first, 1n, Uint8Array.of(2)); await h.server.closeSubgroup(first);
        faults.hold = true;
        const late = await h.server.openSubgroup(7n, 1n, 0n);
        const latePipe = h.b.uniOut.at(-1)!; faults.hold = false;
        await h.server.sendObject(late, 0n, Uint8Array.of(3)); await h.server.closeSubgroup(late);
        if (mode === 'unsubscribe') await h.client.unsubscribe(id);
        else await h.server.publishDone(id, varint(0n), 'internal error still has a tail');
        await flush(256);
        const discard = mode === 'discard' || mode === 'unsubscribe';
        if (mode !== 'unsubscribe') expect(openPipe.readCancelled, mode).toBe(discard);
        openPipe.releaseHeld(); latePipe.releaseHeld(); await flush(256);
        expect(objects, mode).toEqual(discard ? [1] : [1, 2, 3]);
        if (!discard) expect(fins, mode).toHaveLength(2);
        expect(h.errors, mode).toEqual([]);
      } finally { await h.client.close(); await h.server.close(); }
    }
  });

  it('completes by processed Stream Count by default while explicit drain retains its timeout', async () => {
    for (const explicit of [true, false]) {
      const h = await connectedPair(draft, { clientOptions: { terminatedAliasTtlMs: 100 } });
      try {
        const id = await h.client.subscribe(ns('count'), nm('video'), explicit ? { terminalDelivery: 'drain' } : undefined);
        await flush(128); await h.server.acceptSubscribe(id, 7n); await flush(128);
        const stream = await h.server.openSubgroup(7n, 0n, 0n);
        await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
        const pipe = h.b.uniOut.at(-1)!; pipe.faults.hold = true;
        await h.server.closeSubgroup(stream);
        vi.useFakeTimers();
        await h.server.publishDone(id, varint(2n), 'ended'); await flush(256);
        // No completion callback is allowed without explicit drain. Inspect only
        // retained lifetime state to distinguish early completion from timeout.
        const state = h.client as unknown as { drainConfigs: Map<bigint, unknown> };
        expect(state.drainConfigs.has(id)).toBe(true);
        pipe.releaseHeld(); await flush(256);
        expect(pipe.readCancelled).toBe(false);
        expect(state.drainConfigs.has(id)).toBe(explicit);
        await vi.advanceTimersByTimeAsync(101); await flush(256);
        expect(state.drainConfigs.has(id)).toBe(false);
        expect(h.errors).toEqual([]);
      } finally { vi.useRealTimers(); await h.client.close(); await h.server.close(); }
    }
  });

  describe.each(['generic', 'raw'] as const)('%s unsubscribe after DONE', api => {
    it.each([false, true])('stops a running drain immediately (explicit=%s)', async explicit => {
      const h = await connectedPair(draft);
      const objects: number[] = [], drained = vi.fn();
      const options: TerminalDeliveryOptions = explicit ? { terminalDelivery: 'drain', onDrained: drained } : {};
      h.client.onObject = (_sid, obj) => { if (api === 'generic' && obj.kind === 'data') objects.push(obj.payload[0]!); };
      try {
        let id!: bigint;
        const pending = api === 'raw'
          ? h.client.subscribeTrack(ns('cancel-tail'), nm('video'), { ...options, onRequestId: value => { id = value; },
            onObject: obj => { if (obj.kind === 'data') objects.push(obj.payload[0]!); } })
          : h.client.subscribe(ns('cancel-tail'), nm('video'), { ...options, onRequestId: value => { id = value; } });
        await flush(128); await h.server.acceptSubscribe(id, 7n); await pending; await flush(128);
        const stream = await h.server.openSubgroup(7n, 0n, 0n);
        await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
        const pipe = h.b.uniOut.at(-1)!; pipe.faults.hold = true;
        await h.server.sendObject(stream, 1n, Uint8Array.of(2)); await h.server.closeSubgroup(stream);
        await h.server.publishDone(id, varint(2n), 'ended'); await flush(256);
        await expect(h.client.unsubscribe(id)).resolves.toBeUndefined();
        expect(pipe.readCancelled).toBe(true);
        pipe.releaseHeld(); await flush(256);
        expect(objects).toEqual([1]);
        expect(drained.mock.calls).toEqual(explicit ? [[id]] : []);
        expect(h.errors).toEqual([]);
      } finally { await h.client.close(); await h.server.close(); }
    });
  });

  it('releases a zero-count default drain for alias reuse, preserving explicit drain retention', async () => {
    for (const mode of ['timeout', 'streams', 'default'] as const) {
      const h = await connectedPair(draft);
      try {
        const options: TerminalDeliveryOptions = mode === 'default' ? {} : {
          terminalDelivery: 'drain', ...(mode === 'streams' ? { terminalDeliveryCompletion: 'streams' as const } : {}),
        };
        let first!: bigint;
        const pending = h.client.subscribeTrack(ns('zero'), nm('video'), { ...options, onRequestId: id => { first = id; } });
        await flush(128); await h.server.acceptSubscribe(first, 7n); await pending; await flush(128);
        await h.server.publishDone(first, varint(2n), 'empty'); await flush(256);
        // Default completion has no callback: inspect lifetime state, then prove
        // the public consequence by binding a fresh subscription to the same alias.
        const state = h.client as unknown as { drainConfigs: Map<bigint, unknown> };
        expect(state.drainConfigs.has(first), mode).toBe(mode !== 'default');
        let second!: bigint;
        const next = h.client.subscribeTrack(ns('zero'), nm('video'), { onRequestId: id => { second = id; } });
        const outcome = next.then(() => 'accepted', () => 'refused');
        await flush(128); await h.server.acceptSubscribe(second, 7n); await flush(256);
        expect(await outcome, mode).toBe(mode === 'default' ? 'accepted' : 'refused');
        if (mode === 'default') expect(h.errors).toEqual([]);
      } finally { await h.client.close(); await h.server.close(); }
    }
  });

});

it.each(['generic', 'raw'] as const)('%s rejects unknown terminalDelivery before request allocation', async api => {
  const h = await connectedPair(18);
  const allocated = vi.fn();
  try {
    const options = { terminalDelivery: 'typo' as never, onRequestId: allocated };
    const pending = api === 'raw'
      ? h.client.subscribeTrack(ns('invalid'), nm('video'), options)
      : h.client.subscribe(ns('invalid'), nm('video'), options);
    void pending.catch(() => {});
    await flush(128);
    expect(allocated).not.toHaveBeenCalled();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(h.a.bidiOut).toHaveLength(0);
  } finally { await h.client.close(); await h.server.close(); }
});


describe.each([false, true])('shared draft-22 drain (sibling live=%s)', siblingLive => {
  it.each(['first', 'last'] as const)('unsubscribing %s retires only that member', async retire => {
    const h = await connectedPair(22, { clientOptions: { terminatedAliasTtlMs: 100 } });
    const a: number[] = [], b: number[] = [], drained: bigint[] = [];
    try {
      const add = async (objects: number[]) => {
        let id!: bigint;
        const pending = h.client.subscribeTrack(ns('shared-tail'), nm('video'), {
          terminalDelivery: 'drain', onRequestId: value => { id = value; },
          onObject: obj => { if (obj.kind === 'data') objects.push(obj.payload[0]!); },
          onDrained: value => drained.push(value),
        });
        await flush(128); await h.server.acceptSubscribe(id, 7n); await pending; await flush(128);
        return id;
      };
      const first = await add(a), last = await add(b);
      const victim = retire === 'first' ? first : last, survivor = retire === 'first' ? last : first;
      const stream = await h.server.openSubgroup(7n, 0n, 0n, { requestId: last });
      await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
      const pipe = h.b.uniOut.at(-1)!; pipe.faults.hold = true;
      await h.server.sendObject(stream, 1n, Uint8Array.of(2)); await h.server.closeSubgroup(stream);
      vi.useFakeTimers();
      if (!siblingLive) { await h.server.publishDone(first, varint(2n), 'first'); await flush(128); }
      await h.server.publishDone(siblingLive ? victim : last, varint(2n), 'terminal'); await flush(128);
      await vi.advanceTimersByTimeAsync(40);
      const outcome = await h.client.unsubscribe(victim).then(() => 'retired', () => 'rejected');
      await flush(128);
      pipe.releaseHeld(); await flush(256);
      // The supplied shared-owner reproduction: the sibling must keep its tail.
      expect(retire === 'first' ? b : a).toEqual([1, 2]);
      expect(pipe.readCancelled).toBe(false);
      expect(outcome).toBe('retired');
      expect(retire === 'first' ? a : b).toEqual([1]);
      expect(drained).toEqual([victim]);
      await vi.advanceTimersByTimeAsync(61); await flush(256);
      expect(drained).toEqual(siblingLive ? [victim] : [victim, survivor]);
      expect(h.errors).toEqual([]);
    } finally { vi.useRealTimers(); await h.client.close(); await h.server.close(); }
  });
});

it('the last retained member cancels shared streams after its live sibling unsubscribes', async () => {
  const h = await connectedPair(22);
  const objects: number[] = [], drained: bigint[] = [];
  try {
    const add = async () => {
      let id!: bigint;
      const pending = h.client.subscribeTrack(ns('last-retained'), nm('video'), {
        terminalDelivery: 'drain', onRequestId: value => { id = value; },
        onObject: obj => { if (obj.kind === 'data') objects.push(obj.payload[0]!); },
        onDrained: value => drained.push(value),
      });
      await flush(128); await h.server.acceptSubscribe(id, 7n); await pending; await flush(128);
      return id;
    };
    const first = await add(), live = await add();
    const stream = await h.server.openSubgroup(7n, 0n, 0n, { requestId: live });
    await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
    const pipe = h.b.uniOut.at(-1)!; pipe.faults.hold = true;
    await h.server.sendObject(stream, 1n, Uint8Array.of(2)); await h.server.closeSubgroup(stream);
    await h.server.publishDone(first, varint(2n), 'first'); await flush(128);
    await h.client.unsubscribe(live); await flush(128);
    expect(pipe.readCancelled).toBe(false);
    await expect(h.client.unsubscribe(first)).resolves.toBeUndefined();
    expect(pipe.readCancelled).toBe(true);
    pipe.releaseHeld(); await flush(256);
    expect(objects).toEqual([1, 1]);
    expect(drained).toEqual([first]);
    expect(h.errors).toEqual([]);
  } finally { await h.client.close(); await h.server.close(); }
});
