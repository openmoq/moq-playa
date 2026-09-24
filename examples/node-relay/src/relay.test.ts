import { describe, expect, it, vi } from 'vitest';
import { SessionError, type Fetch, type MoqtObjectData, type SubgroupHeader } from '@moqt/transport';
import type { IncomingPublish, MoqtConnection } from '@moqt/webtransport';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import { Relay } from './relay.js';

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
