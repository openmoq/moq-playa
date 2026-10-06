import { describe, expect, it, vi } from 'vitest';
import { SessionError, type Fetch, type MoqtObjectData, type SubgroupHeader } from '@openmoq/transport';
import { MoqtConnection, type IncomingPublish } from '@openmoq/webtransport';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import { Relay } from './relay.js';
import { publishFixture } from '../../node-publisher/src/publisher.js';
import { videoInit } from '../../../packages/locmaf/test-support/cmaf.js';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';

interface SubscriberHarness {
  readonly conn: MoqtConnection;
  readonly openSubgroup: ReturnType<typeof vi.fn>;
  readonly sendObject: ReturnType<typeof vi.fn>;
  readonly closeSubgroup: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly activeStreams: () => number;
  readonly maxActiveStreams: () => number;
}

function subscriberHarness(streamLimit: number): SubscriberHarness {
  let nextStreamId = 1n;
  let activeStreams = 0;
  let maxActiveStreams = 0;
  const openSubgroup = vi.fn(async () => {
    if (activeStreams >= streamLimit) throw new Error('No streams available');
    activeStreams += 1;
    maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
    return nextStreamId++;
  });
  const sendObject = vi.fn(async () => undefined);
  const closeSubgroup = vi.fn(async () => {
    activeStreams -= 1;
  });
  const close = vi.fn(async () => undefined);
  const conn = {
    draftVersion: 18,
    acceptSubscribe: vi.fn(async () => undefined),
    session: {
      getIncomingSubscription: vi.fn(() => ({ remoteFilterType: 'AbsoluteStart' })),
    },
    openSubgroup,
    sendObject,
    closeSubgroup,
    close,
  } as unknown as MoqtConnection;
  return {
    conn,
    openSubgroup,
    sendObject,
    closeSubgroup,
    close,
    activeStreams: () => activeStreams,
    maxActiveStreams: () => maxActiveStreams,
  };
}

function incomingPublish(alias = 9n): IncomingPublish {
  return {
    requestId: 1n,
    trackNamespace: nsBytes(DEMO_NAMESPACE),
    trackName: te(DEMO_TRACK),
    trackAlias: alias,
    onObject: null,
    onSubgroupClosed: null,
  };
}

function object(
  alias: bigint,
  groupId: bigint,
  objectId = 0n,
  properties?: Uint8Array,
): MoqtObjectData {
  return {
    kind: 'data',
    trackAlias: alias,
    groupId,
    subgroupId: 0n,
    objectId,
    publisherPriority: 128,
    isFirstObjectInSubgroup: objectId === 0n,
    properties,
    extensions: properties,
    payload: new Uint8Array([Number(groupId & 0xffn)]),
  };
}

function subgroupHeader(alias: bigint, groupId: bigint): SubgroupHeader {
  return {
    typeByte: 0x10,
    trackAlias: alias,
    groupId,
    subgroupId: 0n,
    publisherPriority: 128,
    hasExtensions: false,
    isEndOfGroup: false,
    isFirstObjectInSubgroup: true,
  };
}

async function acceptPublisher(relay: Relay, publish: IncomingPublish): Promise<void> {
  const conn = { acceptSubscribe: vi.fn(async () => undefined) } as unknown as MoqtConnection;
  await relay.handlePublish(conn, publish);
}

describe('Relay subgroup lifecycle', () => {
  it('drops queued forwarding on cancellation without sending FIN to an unfinished subgroup', async () => {
    const relay = new Relay();
    const sub = subscriberHarness(2);
    let release!: () => void;
    sub.sendObject.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await relay.handleSubscribe(sub.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    publish.onObject?.({ ...object(publish.trackAlias, 1n), subgroupContainsEndOfGroup: true });
    await vi.waitFor(() => expect(sub.sendObject).toHaveBeenCalledOnce());
    publish.onObject?.({ ...object(publish.trackAlias, 1n, 1n), subgroupContainsEndOfGroup: true });
    relay.removeSubscription(sub.conn, 2n);
    release();
    await flush();
    publish.onSubgroupClosed?.({ ...subgroupHeader(publish.trackAlias, 1n), isEndOfGroup: true });
    await flush();
    expect(sub.sendObject).toHaveBeenCalledOnce();
    expect(sub.closeSubgroup).not.toHaveBeenCalled();
    expect(sub.close).not.toHaveBeenCalled();
  });

  it.each([18, 22] as const)('draft %s cancellation resets unfinished relay output instead of sending FIN', async (draft) => {
    const { a, b } = createLoopback();
    const client = new MoqtConnection(draft);
    const server = new MoqtConnection(draft, { role: 'server' });
    const errors: Error[] = [];
    client.onError = server.onError = (error) => errors.push(error);
    const relay = new Relay();
    server.onSubscribe = (requestId, namespace, name) => { void relay.handleSubscribe(server, requestId, namespace, name); };
    server.onSubscribeClosed = (requestId) => relay.removeSubscription(server, requestId);
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      const subscription = await client.subscribeTrack(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
      const publish = incomingPublish();
      await acceptPublisher(relay, publish);
      publish.onObject?.({ ...object(publish.trackAlias, 1n), subgroupContainsEndOfGroup: true });
      await vi.waitFor(() => expect(b.uniOut).toHaveLength(2));
      await flush();
      const stream = b.uniOut[1]!;
      expect(stream.writeClosed).toBe(false);
      expect(stream.writeAborted).toBe(false);
      await subscription.unsubscribe();
      await vi.waitFor(() => expect(stream.writeAborted).toBe(true));
      expect(stream.writeClosed).toBe(false);
      expect(errors).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('preserves the incoming END_OF_GROUP header through live forwarding and cache replay', async () => {
    const relay = new Relay();
    const live = subscriberHarness(4);
    await relay.handleSubscribe(live.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    publish.onObject?.({ ...object(publish.trackAlias, 1n, 5n), isFirstObjectInSubgroup: true,
      subgroupContainsEndOfGroup: true });
    await vi.waitFor(() => expect(live.sendObject).toHaveBeenCalledOnce());
    expect(live.openSubgroup.mock.calls[0]?.[3]).toMatchObject({ endOfGroup: true });
    publish.onSubgroupClosed?.({ ...subgroupHeader(publish.trackAlias, 1n), isEndOfGroup: true });
    await vi.waitFor(() => expect(live.closeSubgroup).toHaveBeenCalledOnce());
    const late = subscriberHarness(4);
    await relay.handleSubscribe(late.conn, 3n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    await vi.waitFor(() => expect(late.closeSubgroup).toHaveBeenCalledOnce());
    expect(late.openSubgroup.mock.calls[0]?.[3]).toMatchObject({ endOfGroup: true });
  });

  it('forwards the fixture publisher single-object subgroups with FIRST_OBJECT on each stream', async () => {
    const relay = new Relay();
    const live = subscriberHarness(4);
    await relay.handleSubscribe(live.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publications = new Map<bigint, IncomingPublish>();
    const streams = new Map<bigint, { alias: bigint; group: bigint; subgroup: bigint; first: boolean }>();
    let nextRequest = 0n;
    const origin = {
      onMessage: undefined as ((m: { type: string; requestId: bigint }) => void) | undefined,
      async publish(namespace: Uint8Array[], name: Uint8Array, alias: bigint) {
        const requestId = nextRequest++;
        const p: IncomingPublish = { requestId, trackNamespace: namespace, trackName: name,
          trackAlias: alias, onObject: null, onSubgroupClosed: null };
        publications.set(alias, p);
        await acceptPublisher(relay, p);
        setTimeout(() => origin.onMessage?.({ type: 'REQUEST_OK', requestId }), 0);
        return requestId;
      },
      async openSubgroup(alias: bigint, group: bigint, subgroup: bigint, opts: { firstObject?: boolean }) {
        const id = BigInt(streams.size + 1);
        streams.set(id, { alias, group, subgroup, first: opts.firstObject === true });
        return id;
      },
      async sendObject(id: bigint, objectId: bigint, payload: Uint8Array) {
        const s = streams.get(id)!;
        publications.get(s.alias)!.onObject?.({ ...object(s.alias, s.group, objectId),
          subgroupId: s.subgroup, payload, isFirstObjectInSubgroup: s.first });
        s.first = false;
      },
      async closeSubgroup(id: bigint) {
        const s = streams.get(id)!;
        publications.get(s.alias)!.onSubgroupClosed?.({ ...subgroupHeader(s.alias, s.group), subgroupId: s.subgroup });
      },
    };
    const meta = { name: DEMO_TRACK, role: 'video', packaging: 'cmaf', codec: 'avc1.42c01e',
      init: 'init.mp4', chunks: [] } as const;
    await publishFixture(origin as unknown as MoqtConnection, {
      manifest: { namespace: DEMO_NAMESPACE, renderGroup: 1, chunkDurationMs: 500, tracks: [meta] },
      tracks: [{ meta, initData: videoInit(), chunks: [1, 2, 3].map((v) => new Uint8Array([v])) }],
    }, { catalogFormat: 'cmsf-01' });
    await vi.waitFor(() => expect(live.sendObject).toHaveBeenCalledTimes(3));
    expect(live.openSubgroup.mock.calls.map((c) => c[3])).toEqual([
      { publisherPriority: 128, firstObject: true, hasExtensions: false },
      { publisherPriority: 128, firstObject: true, hasExtensions: false },
      { publisherPriority: 128, firstObject: true, hasExtensions: false },
    ]);
    expect(live.sendObject.mock.calls.map((c) => c[1])).toEqual([0n, 1n, 2n]);
    const late = subscriberHarness(4);
    await relay.handleSubscribe(late.conn, 3n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    await vi.waitFor(() => expect(late.sendObject).toHaveBeenCalledTimes(3));
    expect(late.openSubgroup.mock.calls.map((c) => c[3])).toEqual(live.openSubgroup.mock.calls.map((c) => c[3]));
  });

  it('preserves nonzero FIRST_OBJECT evidence during live forwarding and cache replay', async () => {
    const relay = new Relay();
    const live = subscriberHarness(2);
    await relay.handleSubscribe(live.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    publish.onObject?.({ ...object(publish.trackAlias, 1n, 5n), subgroupId: 1n, isFirstObjectInSubgroup: true });
    await vi.waitFor(() => expect(live.sendObject).toHaveBeenCalledOnce());
    expect(live.openSubgroup.mock.calls[0]?.[3]).toMatchObject({ firstObject: true });
    const late = subscriberHarness(2);
    await relay.handleSubscribe(late.conn, 3n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    await vi.waitFor(() => expect(late.sendObject).toHaveBeenCalledOnce());
    expect(late.openSubgroup.mock.calls[0]?.[3]).toMatchObject({ firstObject: true });
  });

  it('does not invent FIRST_OBJECT when the decoded evidence is false', async () => {
    const relay = new Relay();
    const sub = subscriberHarness(2);
    await relay.handleSubscribe(sub.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    publish.onObject?.({ ...object(publish.trackAlias, 1n), isFirstObjectInSubgroup: false });
    await vi.waitFor(() => expect(sub.sendObject).toHaveBeenCalledOnce());
    expect(sub.openSubgroup.mock.calls[0]?.[3]).toMatchObject({ firstObject: false });
  });

  it('lets an independent subgroup advance while another subgroup write is blocked', async () => {
    const relay = new Relay({ maxConcurrentSubgroupsPerSubscription: 2 });
    const subscriber = subscriberHarness(2);
    let releaseFirst!: () => void;
    subscriber.sendObject.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    await relay.handleSubscribe(subscriber.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);

    publish.onObject?.(object(publish.trackAlias, 1n));
    publish.onObject?.(object(publish.trackAlias, 2n));

    await vi.waitFor(() => expect(subscriber.sendObject).toHaveBeenCalledTimes(2));
    expect(subscriber.openSubgroup).toHaveBeenCalledTimes(2);
    expect(subscriber.maxActiveStreams()).toBe(2);

    releaseFirst();
    publish.onSubgroupClosed?.(subgroupHeader(publish.trackAlias, 1n));
    publish.onSubgroupClosed?.(subgroupHeader(publish.trackAlias, 2n));
    await vi.waitFor(() => expect(subscriber.closeSubgroup).toHaveBeenCalledTimes(2));
  });

  it('keeps objects ordered within one subgroup', async () => {
    const relay = new Relay({ maxConcurrentSubgroupsPerSubscription: 2 });
    const subscriber = subscriberHarness(2);
    let releaseFirst!: () => void;
    subscriber.sendObject.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    await relay.handleSubscribe(subscriber.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);

    publish.onObject?.(object(publish.trackAlias, 1n, 0n));
    publish.onObject?.(object(publish.trackAlias, 1n, 1n));

    await vi.waitFor(() => expect(subscriber.sendObject).toHaveBeenCalledOnce());
    releaseFirst();
    await vi.waitFor(() => expect(subscriber.sendObject).toHaveBeenCalledTimes(2));
    expect(subscriber.sendObject.mock.calls.map((call) => call[1])).toEqual([0n, 1n]);
  });

  it('disconnects only the subscriber whose forwarding backlog exceeds its object bound', async () => {
    const relay = new Relay({
      maxConcurrentSubgroupsPerSubscription: 1,
      maxPendingObjectsPerSubscription: 2,
    });
    const slow = subscriberHarness(1);
    const healthy = subscriberHarness(1);
    let releaseSlow!: () => void;
    slow.sendObject.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseSlow = resolve;
    }));
    await relay.handleSubscribe(slow.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    await relay.handleSubscribe(healthy.conn, 3n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);

    publish.onObject?.(object(publish.trackAlias, 1n, 0n));
    await vi.waitFor(() => {
      expect(slow.sendObject).toHaveBeenCalledOnce();
      expect(healthy.sendObject).toHaveBeenCalledOnce();
    });
    publish.onObject?.(object(publish.trackAlias, 1n, 1n));
    await vi.waitFor(() => expect(healthy.sendObject).toHaveBeenCalledTimes(2));
    publish.onObject?.(object(publish.trackAlias, 1n, 2n));

    await vi.waitFor(() => expect(slow.close).toHaveBeenCalledOnce());
    expect(slow.close).toHaveBeenCalledWith(
      SessionError.INTERNAL_ERROR,
      expect.stringMatching(/cannot keep up.*3 object\(s\)/s),
    );
    publish.onObject?.(object(publish.trackAlias, 1n, 3n));
    await vi.waitFor(() => expect(healthy.sendObject).toHaveBeenCalledTimes(4));
    expect(slow.sendObject).toHaveBeenCalledOnce();
    expect(healthy.close).not.toHaveBeenCalled();
    releaseSlow();
  });

  it('counts Object Properties toward the forwarding byte bound', async () => {
    const relay = new Relay({ maxPendingBytesPerSubscription: 1 });
    const subscriber = subscriberHarness(1);
    await relay.handleSubscribe(subscriber.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);

    publish.onObject?.(object(publish.trackAlias, 1n, 0n, new Uint8Array([0x01])));

    await vi.waitFor(() => expect(subscriber.close).toHaveBeenCalledOnce());
    expect(subscriber.sendObject).not.toHaveBeenCalled();
  });

  it('rejects invalid forwarding limits before accepting traffic', () => {
    const names = [
      'maxConcurrentSubgroupsPerSubscription',
      'maxPendingObjectsPerSubscription',
      'maxPendingBytesPerSubscription',
    ] as const;
    for (const name of names) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new Relay({ [name]: value })).toThrow(/positive safe integer/);
      }
    }
  });

  it('preserves LOC properties for every live subscriber', async () => {
    const relay = new Relay();
    const first = subscriberHarness(1);
    const second = subscriberHarness(1);
    await relay.handleSubscribe(first.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    await relay.handleSubscribe(second.conn, 3n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    const locProperties = new Uint8Array([0x0b, 0x03, 0x01]);

    publish.onObject?.(object(publish.trackAlias, 3n, 0n, locProperties));

    await vi.waitFor(() => {
      expect(first.sendObject).toHaveBeenCalledOnce();
      expect(second.sendObject).toHaveBeenCalledOnce();
    });
    for (const subscriber of [first, second]) {
      expect(subscriber.openSubgroup.mock.calls[0]?.[3]).toMatchObject({
        firstObject: true,
        hasExtensions: true,
      });
      expect(subscriber.sendObject.mock.calls[0]?.[3]).toBe(locProperties);
    }
  });

  it('waits for the final object send before closing its downstream subgroup', async () => {
    const relay = new Relay();
    const subscriber = subscriberHarness(1);
    let releaseSend!: () => void;
    subscriber.sendObject.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseSend = resolve;
    }));
    await relay.handleSubscribe(
      subscriber.conn,
      2n,
      nsBytes(DEMO_NAMESPACE),
      te(DEMO_TRACK),
    );
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);

    publish.onObject?.(object(publish.trackAlias, 3n));
    publish.onSubgroupClosed?.(subgroupHeader(publish.trackAlias, 3n));
    await vi.waitFor(() => expect(subscriber.sendObject).toHaveBeenCalledOnce());
    expect(subscriber.closeSubgroup).not.toHaveBeenCalled();

    releaseSend();
    await vi.waitFor(() => expect(subscriber.closeSubgroup).toHaveBeenCalledOnce());
    expect(subscriber.activeStreams()).toBe(0);
  });

  it('returns stream credit after every live subgroup FIN', async () => {
    const relay = new Relay({ maxConcurrentSubgroupsPerSubscription: 4 });
    const subscriber = subscriberHarness(4);
    await relay.handleSubscribe(
      subscriber.conn,
      2n,
      nsBytes(DEMO_NAMESPACE),
      te(DEMO_TRACK),
    );
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);

    const groups = 150;
    for (let i = 0; i < groups; i++) {
      const groupId = BigInt(i);
      publish.onObject?.(object(publish.trackAlias, groupId));
      publish.onSubgroupClosed?.(subgroupHeader(publish.trackAlias, groupId));
    }

    await vi.waitFor(() => {
      expect(subscriber.sendObject).toHaveBeenCalledTimes(groups);
      expect(subscriber.closeSubgroup).toHaveBeenCalledTimes(groups);
    });
    expect(subscriber.openSubgroup).toHaveBeenCalledTimes(groups);
    expect(subscriber.activeStreams()).toBe(0);
    expect(subscriber.maxActiveStreams()).toBe(4);
  });

  it('closes a completed cached subgroup after replay to a late subscriber', async () => {
    const relay = new Relay();
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    const locProperties = new Uint8Array([0x0b, 0x03, 0x01]);
    publish.onObject?.(object(publish.trackAlias, 8n, 0n, locProperties));
    publish.onSubgroupClosed?.(subgroupHeader(publish.trackAlias, 8n));

    const subscriber = subscriberHarness(1);
    await relay.handleSubscribe(
      subscriber.conn,
      2n,
      nsBytes(DEMO_NAMESPACE),
      te(DEMO_TRACK),
    );

    await vi.waitFor(() => {
      expect(subscriber.sendObject).toHaveBeenCalledOnce();
      expect(subscriber.closeSubgroup).toHaveBeenCalledOnce();
    });
    expect(subscriber.openSubgroup.mock.calls[0]?.[3]).toMatchObject({ hasExtensions: true });
    expect(subscriber.sendObject.mock.calls[0]?.[3]).toBe(locProperties);
    expect(subscriber.activeStreams()).toBe(0);
  });

  it('does not silently strip properties that first appear after a subgroup opens', async () => {
    const relay = new Relay();
    const subscriber = subscriberHarness(1);
    await relay.handleSubscribe(subscriber.conn, 2n, nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK));
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      publish.onObject?.(object(publish.trackAlias, 4n, 0n));
      publish.onObject?.(object(publish.trackAlias, 4n, 1n, new Uint8Array([0x01])));

      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
        '[relay] FORWARD ERROR (object dropped):',
        expect.stringMatching(/subgroup 4\/0 opened without properties/i),
      ));
      expect(subscriber.sendObject).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
    }
  });

  it('preserves cached properties on a FETCH response', async () => {
    const relay = new Relay();
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    const locProperties = new Uint8Array([0x0b, 0x03, 0x01]);
    publish.onObject?.(object(publish.trackAlias, 5n, 0n, locProperties));

    const sendFetchObject = vi.fn(async (_streamId: bigint, _fields: unknown) => undefined);
    const conn = {
      draftVersion: 18,
      acceptFetch: vi.fn(async () => undefined),
      openFetchStream: vi.fn(async () => 77n),
      sendFetchObject,
      closeFetchStream: vi.fn(async () => undefined),
      rejectFetch: vi.fn(async () => undefined),
    } as unknown as MoqtConnection;
    const fetch: Fetch = {
      type: 'FETCH',
      requestId: 4n,
      fetch: {
        fetchType: 0x1,
        trackNamespace: nsBytes(DEMO_NAMESPACE),
        trackName: te(DEMO_TRACK),
        startLocation: { group: 5n, object: 0n },
        endLocation: { group: 5n, object: 1n },
      },
      parameters: new Map(),
    };

    await relay.handleFetch(conn, fetch.requestId, fetch);

    expect(sendFetchObject).toHaveBeenCalledOnce();
    expect(sendFetchObject.mock.calls[0]?.[1]).toMatchObject({ extensions: locProperties });
  });
});
