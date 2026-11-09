import { describe, expect, it, vi } from 'vitest';
import { MAX_VARINT, MAX_VI64, MessageParam, encodeSubgroupObject18, varint, type TrackProperties } from '@openmoq/transport';
import { MoqtConnection } from '@openmoq/webtransport';
import { SeekLiveBridge } from './seek-live-bridge.js';
import { fixture, deferred, turn, connections } from '../test-support/seek-live-bridge.js';

describe.each([18, 22] as const)('seek live boundary draft %i', draft => {
  it('uses the exact track tuple and an ascending next-object subscription with the version-specific prefix', async () => {
    const p = await fixture(draft);
    try {
      expect(p.requests).toHaveLength(1); const message = p.requests[0]!.message;
      expect(message.type).toBe('SUBSCRIBE');
      if (message.type !== 'SUBSCRIBE') throw new Error('Expected SUBSCRIBE');
      expect(message.trackNamespace).toEqual(['a/b', '雪'].map(field => new TextEncoder().encode(field)));
      expect(message.trackName).toEqual(new TextEncoder().encode('v/one'));
      expect(message.parameters.get(MessageParam.GROUP_ORDER)).toEqual([1n]);
      expect(message.parameters.has(0x23n)).toBe(draft === 22);
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream); await turn();
      await p.live(3n);
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']);
      expect(p.accepted).toHaveLength(1); expect(p.boundaries).toHaveLength(1);
      expect(p.boundaries[0]).toMatchObject({ kind: draft === 18 ? 'joining-fetch' : 'fill', head: { groupId: 3n, objectId: 2n }, endOfTrack: false });
      expect(p.generic).toEqual([]); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]); expect(p.ended).not.toHaveBeenCalled();
    } finally { await p.close(); }
  });

  it('holds live work through accepted prefix FIN, consumer credit and the async lease installation', async () => {
    const work = deferred(), install = deferred(), p = await fixture(draft, { early: true, work, install });
    try {
      await p.acknowledge(); let ack = async () => {};
      if (draft === 18) ack = await p.openJoin(undefined, true);
      await p.live(3n); await p.sendPrefixObject(1n); await p.sendPrefixObject(2n);
      await p.server.closeFetchStream(p.prefixStream); await turn();
      expect(p.received).toEqual([]); expect(p.boundaries).toEqual([]);
      await ack(); work.resolve(); await turn();
      expect(p.received).toEqual(['prefix:1', 'prefix:2']); expect(p.order.at(-1)).toBe('install:start');
      install.resolve(); await turn();
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']);
      expect(p.order).toEqual(['prefix:1:start', 'prefix:1:end', 'prefix:2:start', 'prefix:2:end', 'install:start', 'install:end']);
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('routes owned datagrams behind the prefix and captures the exact receipt before copying', async () => {
    const p = await fixture(draft);
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.server.sendDatagram(77n, 3n, 3n, Uint8Array.of(3)); await turn();
      expect(p.datagrams).toHaveLength(1); expect(p.rawInputs).toEqual([p.datagrams[0]]); expect(p.received).toEqual([]);
      p.datagrams[0]!.payload.fill(99);
      expect(p.bridge.handleDatagram({ ...p.datagrams[0]!, trackAlias: 88n })).toBe(false);
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream); await turn();
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']); expect(p.livePayloads).toEqual([[3]]);
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('waits for admission of the saved ACK head while queuing early live data without reading a later head', async () => {
    const admit = deferred<boolean>(), p = await fixture(draft, { admit });
    try {
      await p.acknowledge(); await p.live(4n);
      p.client.session.getSubscription(p.subId)!.updateLargestLocation(3n, 4n);
      expect(p.accepted).toEqual([]); expect(p.received).toEqual([]);
      admit.resolve(true); await turn(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream); await turn();
      expect(p.accepted[0]!.head).toEqual({ groupId: 3n, objectId: 2n });
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:4']); expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  });

  it.each([null, { groupId: 2n, objectId: 2n }])('defers an absent or stale head without inventing a fill completion: %s', async head => {
    const p = await fixture(draft, { head });
    try {
      await p.acknowledge(); expect(p.deferredProbe).toHaveBeenCalledOnce();
      expect(p.joins).toEqual([]); expect(p.accepted).toEqual([]); expect(p.boundaries).toEqual([]);
      expect(p.received).toEqual([]); expect(p.errors).toEqual([]); expect(p.client.session.state).toBe('established');
    } finally { await p.close(); }
  });

  it('owns a late head-admission rejection after cancellation', async () => {
    const admit = deferred<boolean>(), p = await fixture(draft, { admit });
    try {
      await p.acknowledge(); await p.live(3n); p.abort.abort();
      admit.reject(new Error('late index failure')); await turn();
      expect(p.received).toEqual([]); expect(p.accepted).toEqual([]); expect(p.discarded).toHaveLength(1);
      expect(p.errors).toEqual([]); expect(p.deferredProbe).not.toHaveBeenCalled();
    } finally { await p.close(); }
  });

  it('defers a policy-refused head without releasing queued live data', async () => {
    const admit = deferred<boolean>(), p = await fixture(draft, { admit });
    try {
      await p.acknowledge(); await p.live(3n); admit.resolve(false); await turn();
      expect(p.deferredProbe).toHaveBeenCalledOnce(); expect(p.received).toEqual([]);
      expect(p.discarded).toHaveLength(1); expect(p.joins).toEqual([]); expect(p.errors).toEqual([]);
    } finally { await p.close(); }
  });

  it('has bounded early live intake and refuses capacity instead of silently dropping or releasing it', async () => {
    const admit = deferred<boolean>(), p = await fixture(draft, { admit, maxObjects: 2 });
    try {
      await p.acknowledge(); await p.live(3n); await p.live(4n); await p.live(5n); await turn();
      expect(p.errors).toHaveLength(1); expect(p.errors[0]!.message).toContain('budget');
      expect(p.rawInputs).toHaveLength(2); expect(p.discarded).toHaveLength(2);
      expect(p.received).toEqual([]); expect(p.accepted).toEqual([]); expect(p.client.session.state).toBe('established');
    } finally { await p.close(); }
  });

  it('does not treat an EOT Object as terminal drain or lose late accepted work', async () => {
    const p = await fixture(draft);
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream); await turn();
      const stream = await p.server.openSubgroup(77n, 4n, 0n);
      // The publisher convenience API has no status writer. Inject the actual
      // encoded status into its already-counted subgroup, then FIN that stream.
      p.b.uniOut.at(-1)!.injectRead(encodeSubgroupObject18({ objectId: 0n, payload: new Uint8Array(),
        status: 4n, extensions: undefined }, false, 0n, true));
      await p.server.closeSubgroup(stream); await turn();
      expect(p.ended).not.toHaveBeenCalled();
      vi.useFakeTimers(); await p.server.publishDone(p.subId, varint(2n), 'finite'); await turn();
      expect(p.ended).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(50); await turn();
      expect(p.ended).toHaveBeenCalledOnce(); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('ends only after Track Ended, SDK drain and queued application work, never subgroup FIN', async () => {
    const work = deferred(), p = await fixture(draft, { work });
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream);
      const stream = await p.live(3n, false);
      await p.server.closeSubgroup(stream); await turn(); expect(p.ended).not.toHaveBeenCalled();
      vi.useFakeTimers(); await p.server.publishDone(p.subId, varint(2n), 'finite'); await turn();
      await vi.advanceTimersByTimeAsync(50); await turn();
      expect(p.ended).not.toHaveBeenCalled(); work.resolve(); await turn();
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']); expect(p.ended).toHaveBeenCalledOnce();
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('fails a prefix reset once, keeps the session, and never releases queued live media', async () => {
    const p = await fixture(draft);
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.live(3n);
      // The publisher opened the prefix before the live subgroup.
      p.b.uniOut.at(-2)!.reset(23); await turn();
      expect(p.errors).toHaveLength(1); expect(p.received).toEqual([]); expect(p.boundaries).toEqual([]);
      expect(p.client.session.state).toBe('established');
    } finally { await p.close(); }
  });
});

it('draft18 refuses a Joining FETCH boundary derived from a later head', async () => {
  const p = await fixture(18);
  try {
    await p.acknowledge(); const ack = await p.openJoin({ group: 3n, object: 5n }, true); await ack(); await turn();
    expect(p.errors).toHaveLength(1); expect(p.errors[0]!.message).toContain('initial SUBSCRIBE_OK boundary');
    expect(p.accepted).toEqual([]); expect(p.received).toEqual([]); expect(p.client.session.state).toBe('established');
  } finally { await p.close(); }
});

describe.each([18, 22] as const)('live boundary terminal ownership draft %i', draft => {
  it('keeps Joining/FILL prefix intake open after SUB drain until actual FIN and async installation', async () => {
    const install = deferred<void>(), p = await fixture(draft, { install });
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.live(3n);
      if (draft === 18) { vi.useFakeTimers(); await p.server.publishDone(p.subId, varint(2n), 'finite'); await turn();
        await vi.advanceTimersByTimeAsync(50); await turn(); }
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n);
      await p.server.closeFetchStream(p.prefixStream); await turn();
      if (draft === 22) { vi.useFakeTimers(); await p.server.publishDone(p.subId, varint(2n), 'finite'); await turn();
        await vi.advanceTimersByTimeAsync(50); await turn(); }
      expect(p.received).toEqual(['prefix:1', 'prefix:2']);
      expect(p.ended).not.toHaveBeenCalled();
      install.resolve(); await turn();
      expect(p.received).toEqual(['prefix:1', 'prefix:2', 'live:3']);
      expect(p.ended).toHaveBeenCalledOnce(); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('does not end or discard a sent datagram just because the exact stream count has completed', async () => {
    const p = await fixture(draft, { delayDatagrams: true });
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream);
      // A positive stream count exists even on d18 (where JOIN is a separate request).
      await p.live(3n);
      await p.server.sendDatagram(77n, 3n, 4n, Uint8Array.of(4));
      expect(p.heldDatagrams).toHaveLength(1);
      vi.useFakeTimers(); await p.server.publishDone(p.subId, varint(2n), 'finite'); await turn();
      await vi.advanceTimersByTimeAsync(25); await turn();
      const endedBeforeArrival = p.ended.mock.calls.length;
      p.a.injectDatagram(p.heldDatagrams[0]!); await turn();
      expect({endedBeforeArrival, received:p.received, rawCaptured:p.rawInputs.length, errors:p.errors, transportErrors:p.transportErrors})
        .toMatchObject({endedBeforeArrival:0, received:['prefix:1','prefix:2','live:3','live:4'], errors:[], transportErrors:[]});
      expect(p.ended).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(25); await turn();
      expect(p.ended).toHaveBeenCalledOnce();
    } finally { await p.close(); }
  });

  it('healthy datagram delivered before DONE remains captured and consumed', async () => {
    const p = await fixture(draft);
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream);
      await p.live(3n); await p.server.sendDatagram(77n, 3n, 4n, Uint8Array.of(4)); await turn();
      vi.useFakeTimers(); await p.server.publishDone(p.subId, varint(2n), 'finite'); await turn();
      await vi.advanceTimersByTimeAsync(50); await turn();
      expect(p.received).toEqual(['prefix:1','prefix:2','live:3','live:4']); expect(p.ended).toHaveBeenCalledOnce();
      expect(p.rawInputs.some(x => x === p.datagrams[0])).toBe(true); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });
});

const liveDefaults = (): TrackProperties => new Map<bigint, (bigint | Uint8Array)[]>([[0x12n, [90_000n]], [0x79n, [Uint8Array.of(1, 2)]]]);
const prefixDefaults = (): TrackProperties => new Map<bigint, (bigint | Uint8Array)[]>([[0x12n, [48_000n]], [0x79n, [Uint8Array.of(3, 4)]]]);
describe.each([18, 22] as const)('live boundary response property provenance draft %i', draft => {
  it('separates Joining FETCH defaults from live defaults, and uses the own SUBSCRIBE_OK for FILL', async () => {
    const p = await fixture(draft, { subscribeProperties: liveDefaults(), joinProperties: prefixDefaults() });
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream); await turn();
      expect(Reflect.get(p.accepted[0]!, 'prefixTrackProperties')).toEqual(draft === 18 ? prefixDefaults() : liveDefaults());
      expect(Reflect.get(p.accepted[0]!, 'liveTrackProperties')).toEqual(liveDefaults());
      expect(p.boundaries).toHaveLength(1); expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('does not expose or consume early prefix bytes/FIN before its own response establishes defaults', async () => {
    const p = await fixture(draft, { early: draft === 22, subscribeProperties: liveDefaults(), joinProperties: prefixDefaults() });
    try {
      const release = await p.acknowledge(draft === 22);
      const accept = draft === 18 ? await p.openJoin(undefined, true) : async () => { release(); await turn(); };
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream); await turn();
      expect(p.accepted).toEqual([]); expect(p.received).toEqual([]); expect(p.boundaries).toEqual([]);
      await accept(); await turn();
      expect(p.received).toEqual(['prefix:1', 'prefix:2']);
      expect(Reflect.get(p.boundaries[0]!, 'prefixTrackProperties')).toEqual(draft === 18 ? prefixDefaults() : liveDefaults());
      expect(Reflect.get(p.boundaries[0]!, 'liveTrackProperties')).toEqual(liveDefaults());
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });

  it('hands independent property Maps, arrays and bytes to acceptance and later drain', async () => {
    const p = await fixture(draft, { subscribeProperties: liveDefaults(), joinProperties: prefixDefaults(), onAccepted: boundary => {
      for (const key of ['prefixTrackProperties', 'liveTrackProperties']) {
        const properties: unknown = Reflect.get(boundary, key);
        if (!(properties instanceof Map)) return;
        const values: unknown = properties.get(0x79n);
        if (Array.isArray(values)) { if (values[0] instanceof Uint8Array) values[0].fill(99); values.push(99n); }
        properties.clear();
      }
    } });
    try {
      await p.acknowledge(); if (draft === 18) await p.openJoin();
      await p.sendPrefixObject(1n); await p.sendPrefixObject(2n); await p.server.closeFetchStream(p.prefixStream); await turn();
      expect(Reflect.get(p.boundaries[0]!, 'prefixTrackProperties')).toEqual(draft === 18 ? prefixDefaults() : liveDefaults());
      expect(Reflect.get(p.boundaries[0]!, 'liveTrackProperties')).toEqual(liveDefaults());
      expect(p.accepted[0]).not.toBe(p.boundaries[0]);
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });
});

it('keeps an observed empty Joining FETCH set instead of borrowing SUBSCRIBE_OK defaults', async () => {
  const p = await fixture(18, { subscribeProperties: liveDefaults() });
  try {
    await p.acknowledge(); await p.openJoin();
    expect(Reflect.get(p.accepted[0]!, 'prefixTrackProperties')).toEqual(new Map());
    expect(Reflect.get(p.accepted[0]!, 'liveTrackProperties')).toEqual(liveDefaults());
    expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
  } finally { await p.close(); }
});

describe.each([18, 22] as const)('live response capability ownership draft %i', draft => {
  it('refuses an external handle lacking accepted response provenance instead of treating it as empty', async () => {
    const p = await fixture(draft, { subscription: sub => { Reflect.deleteProperty(sub, 'initialTrackProperties'); return sub; } });
    try {
      await p.server.acceptSubscribe(p.subId, 77n, { parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 3n, object: 2n }]]]) });
      await turn();
      expect(p.accepted).toEqual([]); expect(p.joins).toEqual([]); expect(p.received).toEqual([]);
      expect(p.errors).toHaveLength(1); expect(p.errors[0]!.message).toMatch(/initial SUBSCRIBE_OK properties are unavailable/);
      expect(p.transportErrors).toEqual([]); expect(p.client.session.state).toBe('established');
    } finally { await p.close(); }
  });

  it('rechecks owner authority after reading the accepted property getter', async () => {
    let p: Awaited<ReturnType<typeof fixture>>;
    p = await fixture(draft, { subscription: sub => {
      const actual = sub.initialTrackProperties;
      Object.defineProperty(sub, 'initialTrackProperties', { get() { p.retire(); return actual; } });
      return sub;
    } });
    try {
      await p.server.acceptSubscribe(p.subId, 77n, { trackProperties: liveDefaults(),
        parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 3n, object: 2n }]]]) });
      await turn();
      expect(p.accepted).toEqual([]); expect(p.joins).toEqual([]); expect(p.boundaries).toEqual([]);
      expect(p.errors).toEqual([]); expect(p.transportErrors).toEqual([]);
    } finally { await p.close(); }
  });
});


describe.each([14, 16] as const)('legacy seek live Location limits draft%i', draft => {
  function options(start: { groupId: bigint; objectId: bigint }): ConstructorParameters<typeof SeekLiveBridge>[1] {
    return {
      track: { namespace: ['live'], name: 'video' }, start, maxObjects: 10, maxBytes: 1024,
      isCurrent: () => true, signal: new AbortController().signal, admitHead: async () => true,
      onDiscard() {}, consumePrefix: async () => {}, consumeLive: async () => {}, onPrefixAccepted() {},
      onPrefixDrained: async () => {}, onTrackEnded: async () => {}, onDeferred() {}, onError() {},
    };
  }
  it.each(['groupId', 'objectId'] as const)('rejects an out-of-width %s before starting a subscription', async axis => {
    const client = new MoqtConnection(draft); connections.push(client);
    expect(() => {
      const bridge = new SeekLiveBridge(client, options({ groupId: 0n, objectId: 0n, [axis]: MAX_VARINT + 1n }));
      bridge.cancel();
    })
      .toThrow(/Invalid seek live start Location/);
  });
  it('admits the maximum representable start without sending anything at construction', () => {
    const client = new MoqtConnection(draft); connections.push(client);
    const subscribe = vi.spyOn(client, 'subscribeTrack');
    const bridge = new SeekLiveBridge(client, options({ groupId: MAX_VARINT, objectId: MAX_VARINT }));
    expect(subscribe).not.toHaveBeenCalled(); bridge.cancel();
  });
  it.each([2n, MAX_VARINT])('accepts the saved-head Joining FETCH endpoint for Object %s', async objectId => {
    const f = await fixture(draft, { head: { groupId: 3n, objectId } });
    try {
      await f.acknowledge(); expect(f.joins).toHaveLength(1);
      const id = f.joins[0]!;
      const endLocation = { group: 3n, object: objectId === MAX_VARINT ? 0n : objectId + 1n };
      // Check acceptance of the actual control response. The local owner then
      // cancels before DATA; this does not claim delivery of an enormous Group.
      await f.server.acceptFetch(id, { endOfTrack: 0, endLocation }); await turn();
      expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]); expect(f.accepted).toHaveLength(1);
      expect(f.accepted[0]!.head).toEqual({ groupId: 3n, objectId });
    } finally { await f.close(); }
  });
  it('resolves the SDK publisher endpoint without overflowing the saved maximum Object', async () => {
    const f = await fixture(draft, { head: { groupId: 3n, objectId: MAX_VARINT } });
    try {
      await f.acknowledge(); expect(f.joins).toHaveLength(1);
      expect(f.server.resolveJoiningFetch(f.joins[0]!).endLocation).toEqual({ group: 3n, object: 0n });
    } finally { await f.close(); }
  });
});


describe.each([14, 16, 18] as const)('saved Joining FETCH endpoint draft%i', draft => {
  it.each([false, true])('encodes the saved head after the current Group advances, at maximum=%s', async atMaximum => {
    const maximum = draft < 18 ? MAX_VARINT : MAX_VI64;
    const objectId = atMaximum ? maximum : maximum - 1n;
    const head = { groupId: 3n, objectId };
    const f = await fixture(draft, { head });
    try {
      await f.acknowledge(); expect(f.joins).toHaveLength(1);
      // The publisher's provider now sees another Group. Resolution must use
      // the subscription's own saved ACK, including its draft's integer width.
      head.groupId = 4n; head.objectId = 0n;
      const id = f.joins[0]!, range = f.server.resolveJoiningFetch(id);
      expect(range.startLocation).toEqual({ group: 3n, object: 0n });
      expect(range.endLocation).toEqual({ group: 3n, object: atMaximum ? 0n : maximum });
      await f.server.acceptFetch(id, { endOfTrack: 0, endLocation: range.endLocation }); await turn();
      expect(f.accepted).toHaveLength(1);
      expect(f.accepted[0]!.head).toEqual({ groupId: 3n, objectId });
      expect(f.errors).toEqual([]); expect(f.transportErrors).toEqual([]);
    } finally { await f.close(); }
  });
});
