import { expect, it, vi } from 'vitest';
import { CatalogBootstrap } from './catalog-bootstrap.js';
import { CatalogManager } from './catalog-manager.js';

it('keeps MSF-02 group boundaries and degrades an invalid delta until a fresh independent', () => {
    const manager = new CatalogManager('live/test');
    const joining = vi.fn(), ready = vi.fn(), updated = vi.fn(), degraded = vi.fn(), fatal = vi.fn();
    const bootstrap = new CatalogBootstrap({
        applyAt: (loc, payload, opts) => manager.processCatalogObjectAt(loc, payload, opts),
        resetManager: () => manager.reset(), currentState: () => manager.currentState,
        issueJoiningFetch: joining, issueStandaloneFetch: vi.fn(), cancelFetch: vi.fn(),
        onReady: ready, onReadySettled: vi.fn(), onUpdated: updated,
        requestLegacyResubscribe: vi.fn(), onFatal: fatal, onDegraded: degraded,
        requestStagedRecovery: vi.fn(), log: vi.fn(),
    }, { draft: 23 });
    const head = { version: 'draft-02', tracks: [
        { name: 'v', packaging: 'loc', isLive: true },
        { name: 'timeline', packaging: 'mediatimeline', isLive: true, depends: ['v'] },
    ] };
    const object = (group: bigint, id: bigint, body: unknown) => ({ location: { group, object: id },
        kind: 'payload' as const, payload: new TextEncoder().encode(JSON.stringify(body)) });
    bootstrap.start();
    expect(joining).toHaveBeenCalledTimes(1);
    const attempt = joining.mock.calls[0]![0] as number;
    bootstrap.onSubscribeOk({ group: 6n, object: 0n });
    bootstrap.onFetchObject(attempt, object(6n, 0n, head));
    bootstrap.onFetchOk(attempt, { group: 6n, object: 1n }, false);
    bootstrap.onFetchStreamClosed(attempt, true);
    expect(ready).toHaveBeenCalledTimes(1);
    const previous = manager.currentState;
    bootstrap.onLiveCatalogObject(object(8n, 1n, head), 1n);
    expect(manager.currentState).toBe(previous);
    bootstrap.onLiveCatalogObject(object(5n, 2n, { generatedAt: 2, deltaUpdate: [{ op: 'remove', tracks: [{ name: 'v' }] }] }), 1n);
    expect(degraded).not.toHaveBeenCalled();
    bootstrap.onLiveCatalogObject(object(6n, 1n, { generatedAt: 2, deltaUpdate: [{ op: 'remove', tracks: [{ name: 'v' }] }] }), 1n);
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(manager.currentState).toBe(previous);
    bootstrap.onLiveCatalogObject(object(6n, 2n, { generatedAt: 3, deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'v', label: 'ignored' }] }] }), 1n);
    expect(manager.currentState).toBe(previous);
    bootstrap.onLiveCatalogObject(object(7n, 0n, head), 1n);
    bootstrap.onLiveCatalogObject(object(7n, 1n, { generatedAt: 4, deltaUpdate: [{ op: 'update', tracks: [{ parentName: 'v', label: 'accepted' }] }] }), 1n);
    expect(manager.currentState?.tracks[0]?.label).toBe('accepted');
    expect(fatal).not.toHaveBeenCalled();
    bootstrap.abort();
});
