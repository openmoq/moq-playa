import { describe, expect, it, vi } from 'vitest';
import type { MoqtObjectData, SubgroupHeader } from '@moqt/transport';
import type { IncomingPublish, MoqtConnection } from '@moqt/webtransport';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import { Relay } from './relay.js';

interface SubscriberHarness {
  readonly conn: MoqtConnection;
  readonly openSubgroup: ReturnType<typeof vi.fn>;
  readonly sendObject: ReturnType<typeof vi.fn>;
  readonly closeSubgroup: ReturnType<typeof vi.fn>;
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
  const conn = {
    draftVersion: 18,
    acceptSubscribe: vi.fn(async () => undefined),
    session: {
      getIncomingSubscription: vi.fn(() => ({ remoteFilterType: 'AbsoluteStart' })),
    },
    openSubgroup,
    sendObject,
    closeSubgroup,
  } as unknown as MoqtConnection;
  return {
    conn,
    openSubgroup,
    sendObject,
    closeSubgroup,
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

function object(alias: bigint, groupId: bigint, objectId = 0n): MoqtObjectData {
  return {
    kind: 'data',
    trackAlias: alias,
    groupId,
    subgroupId: 0n,
    objectId,
    publisherPriority: 128,
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
    const relay = new Relay();
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
    expect(subscriber.maxActiveStreams()).toBe(1);
  });

  it('closes a completed cached subgroup after replay to a late subscriber', async () => {
    const relay = new Relay();
    const publish = incomingPublish();
    await acceptPublisher(relay, publish);
    publish.onObject?.(object(publish.trackAlias, 8n));
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
    expect(subscriber.activeStreams()).toBe(0);
  });
});
