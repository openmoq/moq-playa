import { expect, it, vi } from 'vitest';
import { CatalogBootstrap, type CatalogObjectEvent } from './catalog-bootstrap.js';
import { CatalogManager } from './catalog-manager.js';

function owner() {
  const manager = new CatalogManager('live'), ready = vi.fn(), updated = vi.fn(), degraded = vi.fn(), fatal = vi.fn(), joining = vi.fn();
  const bootstrap = new CatalogBootstrap({ applyAt: (l, p, o) => manager.processCatalogObjectAt(l, p, o),
    resetManager: () => manager.reset(), currentState: () => manager.currentState,
    issueJoiningFetch: joining, issueStandaloneFetch: vi.fn(), cancelFetch: vi.fn(), onReady: ready,
    onUpdated: updated, onFatal: fatal, onDegraded: degraded, requestStagedRecovery: vi.fn(), requestLegacyResubscribe: vi.fn(), log: vi.fn(),
  }, { draft: 23 });
  bootstrap.start(); bootstrap.onSubscribeOk({ group: 1n, object: 0n });
  return { bootstrap, manager, ready, updated, degraded, fatal, attempt: joining.mock.calls[0]![0] as number };
}
const head = new TextEncoder().encode(JSON.stringify({ version: 'draft-02', tracks: [{ name: 'v', packaging: 'loc', isLive: true }] }));
const event = (object: bigint, payload = head): CatalogObjectEvent => ({ location: { group: 1n, object }, kind: 'payload', payload });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

it('finishes catalog preparation before FETCH FIN and subscription drain', async () => {
  const f = owner(); let release!: (bytes: Uint8Array) => void;
  const prepared = new Promise<Uint8Array>(r => { release = r; });
  f.bootstrap.onFetchObject(f.attempt, { ...event(0n, Uint8Array.of(1)), prepare: () => prepared } as CatalogObjectEvent);
  f.bootstrap.onFetchOk(f.attempt, { group: 1n, object: 0n }, false);
  f.bootstrap.onFetchStreamClosed(f.attempt, true);
  f.bootstrap.onPublishDone('ended'); f.bootstrap.onSubscriptionDrained();
  expect(f.fatal).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
  release(head); await settle();
  expect(f.ready).toHaveBeenCalledOnce(); expect(f.bootstrap.feedEnded).toBe(true);
  f.bootstrap.abort();
});

it('keeps an aborted candidate preparation isolated from the active catalog', async () => {
  const active = owner(), candidate = owner();
  active.bootstrap.onFetchObject(active.attempt, event(0n));
  active.bootstrap.onFetchOk(active.attempt, { group: 1n, object: 0n }, false); active.bootstrap.onFetchStreamClosed(active.attempt, true);
  const before = active.manager.currentState; let release!: (bytes: Uint8Array) => void;
  const pending = new Promise<Uint8Array>(r => { release = r; });
  candidate.bootstrap.onFetchObject(candidate.attempt, { ...event(0n), prepare: () => pending } as CatalogObjectEvent);
  expect(candidate.manager.currentState).toBeNull(); candidate.bootstrap.abort();
  release(head); await settle();
  expect(candidate.manager.currentState).toBeNull(); expect(candidate.ready).not.toHaveBeenCalled();
  expect(active.manager.currentState).toBe(before); active.bootstrap.abort();
});

it('poisons a failed compressed delta until a fresh independent catalog', async () => {
  const f = owner(); f.bootstrap.onFetchObject(f.attempt, event(0n));
  f.bootstrap.onFetchOk(f.attempt, { group: 1n, object: 0n }, false); f.bootstrap.onFetchStreamClosed(f.attempt, true);
  const delta = new TextEncoder().encode(JSON.stringify({ generatedAt: 1, deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'v', label: 'changed' }] }] }));
  f.bootstrap.onLiveCatalogObject({ ...event(1n, delta), prepare: () => Promise.reject(new Error('MSF_COMPRESSION 9')) } as CatalogObjectEvent, 2n);
  f.bootstrap.onLiveCatalogObject(event(2n, delta), 2n); await settle();
  expect(f.degraded).toHaveBeenCalledOnce(); expect(f.manager.currentState?.tracks[0]?.label).toBeUndefined();
  f.bootstrap.onLiveCatalogObject({ ...event(0n), location: { group: 2n, object: 0n } }, 3n);
  f.bootstrap.onLiveCatalogObject({ ...event(1n, delta), location: { group: 2n, object: 1n } }, 3n);
  expect(f.manager.currentState?.tracks[0]?.label).toBe('changed'); f.bootstrap.abort();
});
