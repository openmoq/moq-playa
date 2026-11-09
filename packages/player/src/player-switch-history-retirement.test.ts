/** Controlled local-quarantine ownership seam: real cleanup, warm-prefix
 * abandonment and cancellation; the adapter callback publishes replacement
 * session registries. Public loopback tests separately require no cancellation
 * after peer refusal. This does not claim public migration reachability. */
import { afterEach, expect, it, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { WarmStartHead } from './warm-start-head.js';

interface Subscription {
  trackName: string;
  mediaType: 'video';
  trackAlias: null;
  namespace: string[];
}

interface Owner {
  head: WarmStartHead<unknown>;
  prefixFetch: Info | null;
}

interface Info {
  requestId: bigint;
  connection: object;
  subscriptionRequestId: bigint;
  trackAlias: null;
  retired: boolean;
  streams: Map<bigint, boolean>;
}

interface Seam {
  connection: object;
  activeSubscriptions: Map<bigint, Subscription>;
  activeFetches: Map<bigint, Info>;
  fetchStreamRequestIds: Map<bigint, bigint>;
  fetchStreamAliases: Map<bigint, bigint>;
  quarantinedFetchRequests: Set<bigint>;
  droppedFetchStreams: Set<bigint>;
  armWarmMediaOwner(conn: object, id: bigint, start: {
    group: bigint;
    object: bigint;
  }): Owner;
  registerMediaFetch(id: bigint, registration: object, conn: object): void;
  quarantineFetchRequest(requestId: bigint): void;
}

afterEach(() => vi.useRealTimers());

for (const replacement of ['colliding', 'distinct', 'none'] as const) {
  it(`draft18 local quarantine cancellation preserves ${replacement} successor routing`, () => {
    vi.useFakeTimers();

    const player = new MoqtPlayer({
      url: 'https://unused.example',
      namespace: ['test'],
      clock: { now: () => 0 }
    });
    const p = player as unknown as Seam;
    const replacementConnection = { draftVersion: 18 };
    const successorId = replacement === 'distinct' ? 42n : 22n;
    const successor: Info = {
      requestId: successorId,
      connection: replacementConnection,
      subscriptionRequestId: 30n,
      trackAlias: null,
      retired: false,
      streams: new Map([[99n, false]])
    };

    const cancel = vi.fn(async (id: bigint) => {
      expect(id).toBe(22n);
      if (replacement === 'none') return;
      // Controlled publication at the external cancellation callback boundary.
      p.connection = replacementConnection;
      p.activeSubscriptions = new Map([[30n, {
        trackName: 'new',
        mediaType: 'video',
        trackAlias: null,
        namespace: ['new']
      }]]);
      p.activeFetches = new Map([[successorId, successor]]);
      p.fetchStreamRequestIds = new Map([[99n, successorId]]);
      p.fetchStreamAliases = new Map([[99n, 79n]]);
      p.quarantinedFetchRequests = new Set();
      p.droppedFetchStreams = new Set();
    });
    const old = { draftVersion: 18, fetchCancel: cancel };
    p.connection = old;
    p.activeSubscriptions.set(10n, {
      trackName: 'target',
      mediaType: 'video',
      trackAlias: null,
      namespace: ['test']
    });
    const owner = p.armWarmMediaOwner(old, 10n, { group: 4n, object: 0n });

    try {
      p.registerMediaFetch(22n, {
        trackName: 'target',
        mediaType: 'video',
        subscriptionRequestId: 10n,
        trackAlias: null,
        warmStart: true,
        warmOwner: owner
      }, old);
      owner.head.acceptLargest({ group: 5n, object: 1n });
      p.quarantineFetchRequest(22n);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(22n);
      if (replacement === 'none') {
        expect(p.activeFetches.has(22n)).toBe(false);
        expect(p.activeSubscriptions.has(10n)).toBe(true);
      } else {
        expect(p.connection).toBe(replacementConnection);
        expect(p.activeFetches.get(successorId), 'successor FETCH survives old local-quarantine cleanup').toBe(successor);
        expect(p.fetchStreamRequestIds.get(99n)).toBe(successorId);
        expect(p.fetchStreamAliases.get(99n)).toBe(79n);
        expect(p.quarantinedFetchRequests.has(successorId)).toBe(false);
        expect(p.droppedFetchStreams.has(99n)).toBe(false);
      }
    } finally {
      owner.head.retire();
    }
  });
}
