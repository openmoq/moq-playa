/**
 * A send already in flight must not resurrect a request that was retired while
 * it was travelling.
 *
 * `abort()` stops the catalog coordinator's FUTURE work, but it cannot revoke an
 * async call the legacy-resubscribe fallback has already launched. Retiring one
 * request also must not bump the shared bootstrap generation, since unrelated
 * media observes it — so liveness here is operation-local: the installed
 * coordinator identity. Without it, the fallback's late completion restored the
 * dead request ID and its pending alias bind, or raised a fatal catalog error
 * for an operation nobody owns.
 *
 * The `GOAWAY=false` cases are the controls: a live fallback must still keep its
 * request, and a genuine current-owner send failure must still be reported.
 *
 * draft-18 only — this exercises the real joining-FETCH-to-legacy fallback path.
 *
 * Uses an internal relative testkit import by design — the testkit is not a
 * published export of @openmoq/webtransport.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MoqtConnection } from '@openmoq/webtransport';
import { connectedPair } from '../../webtransport/src/testkit/pair.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { MoqtPlayer } from './player.js';
import { CATALOG_BOOTSTRAP_INACTIVITY_MS } from './catalog-bootstrap.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('catalog fallback send completion after request retirement', () => {
  for (const completion of ['resolve', 'reject'] as const) {
    it.each([false, true])(`${completion} after fallback send (GOAWAY=%s)`, async (redirect) => {
      vi.useFakeTimers();
      const pair = await connectedPair(18);
      const requests: bigint[] = [];
      pair.server.onSubscribe = id => { requests.push(id); };
      pair.server.onFetch = () => {};
      const player = new MoqtPlayer({
        url: 'https://old.example/moq', namespace: 'review', draftVersion: 18,
        connection: pair.client as unknown as MoqtConnection,
        createTransport: async () => ({}) as never,
      });
      const errors: string[] = [];
      const notices: bigint[] = [];
      player.on('error', event => { errors.push(event.error.message); });
      player.on('request_goaway', event => { notices.push(event.requestId); });
      const gate = deferred();
      try {
        await player.load();
        await flush(64);
        expect(requests).toHaveLength(1);
        await pair.server.acceptSubscribe(requests[0]!, 100n);
        await flush(64);
        const original = pair.client.subscribe.bind(pair.client);
        vi.spyOn(pair.client, 'subscribe').mockImplementation(async (ns, name, options) => {
          const id = await original(ns, name, options);
          await gate.promise;
          return id;
        });
        await vi.advanceTimersByTimeAsync(CATALOG_BOOTSTRAP_INACTIVITY_MS + 1);
        await flush(128);
        expect(requests).toHaveLength(2);
        expect(errors).toEqual([]);
        const fallbackId = requests[1]!;
        const state = player as unknown as { pendingAliasBinds: Set<bigint>; catalogSlots: { catalogRequestId: bigint | null; catalogBootstrapCoord: { phase: string } | null } };
        expect(state.catalogSlots.catalogRequestId).toBe(fallbackId);
        if (redirect) {
          const contexts = (pair.server as unknown as {
            inboundRequestContexts: Map<bigint, { writeMessage(message: unknown): Promise<void> }>;
          }).inboundRequestContexts;
          await contexts.get(fallbackId)!.writeMessage({
            type: 'GOAWAY', newSessionUri: 'https://new.example/moq', timeout: 0n,
          });
          await flush(64);
          expect(notices).toEqual([fallbackId]);
          expect(state.catalogSlots.catalogRequestId).toBeNull();
          expect(state.catalogSlots.catalogBootstrapCoord).toBeNull();
          expect(state.pendingAliasBinds.has(fallbackId)).toBe(false);
        }
        if (completion === 'resolve') gate.resolve();
        else gate.reject(new Error('late fallback send failure'));
        await flush(128);
        if (redirect) {
          expect(state.catalogSlots.catalogRequestId).toBeNull();
          expect(state.pendingAliasBinds.has(fallbackId)).toBe(false);
          expect(errors).toEqual([]);
        } else if (completion === 'resolve') {
          expect(state.catalogSlots.catalogRequestId).toBe(fallbackId);
          expect(errors).toEqual([]);
        } else {
          expect(errors).toHaveLength(1);
          expect(errors[0]).toContain('late fallback send failure');
        }
      } finally {
        gate.resolve();
        await flush(64);
        await player.destroy();
        await pair.client.close();
        await pair.server.close();
        vi.useRealTimers();
      }
    });
  }
});
