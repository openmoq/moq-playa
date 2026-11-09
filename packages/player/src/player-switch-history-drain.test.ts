/** Internal ownership injection, not public migration reachability proof. */
import { afterEach, expect, it, vi } from 'vitest';
import { MoqtPlayer } from './player.js';
import type { WarmStartHead } from './warm-start-head.js';

interface Info {
  requestId: bigint;
  trackAlias: bigint | null;
  connection: object;
  retired: boolean;
}

interface Route {
  permit: (admission: unknown) => void;
  work: Promise<void>;
  isLive: () => boolean;
}

interface Owner {
  head: WarmStartHead<Route>;
  prefixFetch: Info | null;
}

interface Seam {
  connection: object;
  activeSubscriptions: Map<bigint, object>;
  activeFetches: Map<bigint, Info>;
  refusedFetchRequests: Map<bigint, {
    reason: string;
    code: bigint;
  }>;
  quarantinedFetchRequests: Set<bigint>;
  fetchStreamRequestIds: Map<bigint, bigint>;
  fetchStreamAliases: Map<bigint, bigint>;
  droppedFetchStreams: Set<bigint>;
  pendingFetchStreams: Map<bigint, object>;
  armWarmMediaOwner(conn: object, id: bigint, start: object): Owner;
  registerMediaFetch(id: bigint, registration: object, conn: object): void;
  drainMediaFetch(id: bigint): void;
}

afterEach(() => vi.useRealTimers());

for (const boundary of ['refused-registration', 'stale-registration', 'reset-drain', 'fin-drain'] as const) {
  for (const collide of [true, false]) {
    it(`${boundary}: ${collide ? 'colliding' : 'distinct'} successor survives`, () => {
      vi.useFakeTimers();

      const p = new MoqtPlayer({
        url: 'https://unused.example',
        namespace: ['test'],
        clock: { now: () => 0 }
      }) as unknown as Seam;
      const next = { draftVersion: 18 };
      const id = collide ? 22n : 42n;
      const successor: Info = {
        requestId: id,
        trackAlias: 79n,
        connection: next,
        retired: false
      };
      let published = 0;

      const publish = () => {
        published++;
        p.connection = next;
        p.activeSubscriptions = new Map([[30n, {}]]);
        p.activeFetches = new Map([[id, successor]]);
        p.refusedFetchRequests = new Map([[id, { reason: 'new session refusal', code: 9n }]]);
        p.quarantinedFetchRequests = new Set();
        p.fetchStreamRequestIds = new Map([[99n, id]]);
        p.fetchStreamAliases = new Map([[99n, 79n]]);
        p.droppedFetchStreams = new Set();
        p.pendingFetchStreams = new Map();
      };

      const cancel = vi.fn(async () => publish());
      const old = { draftVersion: 18, fetchCancel: cancel };
      p.connection = old;
      p.activeSubscriptions.set(10n, {
        trackName: 'target',
        mediaType: 'video',
        trackAlias: null,
        namespace: ['test']
      });
      const owner = p.armWarmMediaOwner(old, 10n, { group: 4n, object: 0n });
      const registration = {
        trackName: 'target',
        mediaType: 'video',
        subscriptionRequestId: 10n,
        trackAlias: null,
        warmStart: true,
        warmOwner: owner
      };

      try {
        owner.head.acceptLargest({ group: 5n, object: 1n });
        if (boundary === 'refused-registration') {
          p.refusedFetchRequests.set(22n, { reason: 'old refusal', code: 3n });
          p.registerMediaFetch(22n, registration, old);
        } else if (boundary === 'stale-registration') {
          p.activeSubscriptions.delete(10n);
          p.registerMediaFetch(22n, registration, old);
          expect(published).toBe(0);
          expect(cancel).not.toHaveBeenCalled();
          expect(p.activeFetches.has(22n)).toBe(false);
          return;
        } else {
          p.registerMediaFetch(22n, registration, old);
          p.activeFetches.get(22n)!.trackAlias = 77n;
          if (boundary === 'fin-drain')
            owner.head.push({
              group: 4n,
              object: 0n,
              bytes: 1,
              source: 'prefix',
              continuation: 'group-start',
              value: {
                permit: publish,
                work: Promise.resolve(),
                isLive: () => true
              }
            });
          p.pendingFetchStreams.set(88n, {
            requestId: 22n,
            sourceConnection: old,
            sourceDraft: 18,
            objects: [],
            bytes: 0,
            terminal: boundary === 'fin-drain' ? 'fin' : 'reset'
          });
          p.drainMediaFetch(22n);
        }

        expect(published).toBe(1);
        expect.soft(p.activeFetches.get(id), 'successor FETCH retained').toBe(successor);
        expect.soft(p.refusedFetchRequests.has(id), 'successor refusal record retained').toBe(true);
        expect.soft(p.quarantinedFetchRequests.has(id), 'no old tombstone in replacement session').toBe(false);
        expect.soft(p.fetchStreamRequestIds.get(99n), 'successor stream owner retained').toBe(id);
        expect.soft(p.fetchStreamAliases.get(99n), 'successor stream alias retained').toBe(79n);
        expect.soft(p.droppedFetchStreams.has(99n), 'successor stream not dropped').toBe(false);
      } finally {
        owner.head.retire();
      }
    });
  }
}
