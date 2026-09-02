/**
 * CatalogBootstrap coordinator unit tests — synthetic interleavings.
 *
 * The coordinator is a pure state machine: transport I/O is injected, timers
 * are real setTimeout (driven with vitest fake timers). These tests cover the
 * convergence core; the player-level suite covers wiring.
 *
 * @see draft-ietf-moq-msf-01 §5, draft-ietf-moq-transport-16 §9.16.2,
 *      draft-ietf-moq-transport-18 §10.12.2
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CatalogBootstrap, CATALOG_BOOTSTRAP_INACTIVITY_MS } from './catalog-bootstrap.js';
import type { CatalogBootstrapCallbacks } from './catalog-bootstrap.js';
import { CatalogManager } from './catalog-manager.js';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** MSF-01-shaped independent catalog (string version). */
const msf01Indep = (names: string[]) => enc({
    version: 'draft-01',
    tracks: names.map((name) => ({ name, packaging: 'loc', renderGroup: 1, isLive: true })),
});
/** MSF-00-shaped independent catalog (numeric version). */
const msf00Indep = (names: string[]) => enc({
    version: 1,
    tracks: names.map((name) => ({ name, packaging: 'loc', renderGroup: 1, isLive: true })),
});
/** MSF-01 op-array delta adding one track. */
const msfDelta = (name: string) => enc({
    deltaUpdate: [{ op: 'add', tracks: [{ name, packaging: 'loc', renderGroup: 1, isLive: true }] }],
});
/** CF-01 JSON Patch (array) — baseless without its predecessor. */
const cf01Patch = () => enc([{ op: 'remove', path: '/tracks/0' }]);

interface Harness {
    coord: CatalogBootstrap;
    manager: CatalogManager;
    /** The attempt id the most recent issued fetch belongs to. */
    attempt: () => number;
    /** Fetch-event helpers bound to the CURRENT attempt unless overridden. */
    f: {
        obj: (o: Parameters<CatalogBootstrap['onFetchObject']>[1], attempt?: number) => void;
        ok: (end: { group: bigint; object: bigint }, eot: boolean, attempt?: number) => void;
        closed: (clean: boolean, attempt?: number) => void;
        err: (kind: 'invalid-range' | 'refused' | 'timeout', attempt?: number) => void;
    };
    calls: {
        joiningFetch: number;
        standaloneFetches: Array<{ startGroup: bigint; startObject: bigint; endGroupWholeOf: bigint }>;
        cancels: number;
        ready: Array<string[]>;      // track names at readiness
        updated: Array<string[]>;    // track names per catalog_updated
        legacyResubscribes: number;
        fatals: string[];
    };
}

function makeHarness(overrides?: { draft?: 14 | 16 | 18 }): Harness {
    const manager = new CatalogManager('live/test');
    const calls: Harness['calls'] = {
        joiningFetch: 0, standaloneFetches: [], cancels: 0,
        ready: [], updated: [], legacyResubscribes: 0, fatals: [],
    };
    let currentAttempt = 0;
    const callbacks: CatalogBootstrapCallbacks = {
        applyAt: (loc, payload, opts) => manager.processCatalogObjectAt(loc, payload, opts),
        resetManager: () => manager.reset(),
        currentState: () => manager.currentState,
        issueJoiningFetch: (attempt) => { currentAttempt = attempt; calls.joiningFetch += 1; },
        issueStandaloneFetch: (range, attempt) => { currentAttempt = attempt; calls.standaloneFetches.push(range); },
        cancelFetch: () => { calls.cancels += 1; },
        onReady: (state) => calls.ready.push(state.tracks.map((t) => t.name)),
        onUpdated: (state) => calls.updated.push(state.tracks.map((t) => t.name)),
        requestLegacyResubscribe: () => { calls.legacyResubscribes += 1; },
        onFatal: (reason) => calls.fatals.push(reason),
        onDegraded: (reason) => calls.fatals.push(`degraded:${reason}`),
        requestStagedRecovery: () => calls.fatals.push('staged-recovery'),
        log: () => { /* silent */ },
    };
    const coord = new CatalogBootstrap(callbacks, { draft: overrides?.draft ?? 16 });
    return {
        coord, manager,
        attempt: () => currentAttempt,
        f: {
            obj: (o, attempt) => coord.onFetchObject(attempt ?? currentAttempt, o),
            ok: (end, eot, attempt) => coord.onFetchOk(attempt ?? currentAttempt, end, eot),
            closed: (clean, attempt) => coord.onFetchStreamClosed(attempt ?? currentAttempt, clean),
            err: (kind, attempt) => coord.onFetchError(attempt ?? currentAttempt, kind),
        },
        calls,
    };
}

/** Drive a complete simple bootstrap: head at (g,0), FETCH_OK, FIN. */
function completeSimplePrefix(h: Harness, group = 5n): void {
    h.coord.start();
    h.coord.onSubscribeOk({ group, object: 0n });
    h.f.obj({ location: { group, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
    h.f.ok({ group, object: 1n }, false);
    h.f.closed(true);
}

afterEach(() => { vi.useRealTimers(); });

describe('CatalogBootstrap — happy path', () => {
    it('#3-shape: start() issues the joining fetch immediately on d16/18, before SUBSCRIBE_OK', () => {
        const h = makeHarness();
        h.coord.start();
        expect(h.calls.joiningFetch).toBe(1);        // Pending association is legal
    });

    it('d14: the joining fetch waits for SUBSCRIBE_OK (§9.16.2 active-subscription rule)', () => {
        const h = makeHarness({ draft: 14 });
        h.coord.start();
        expect(h.calls.joiningFetch).toBe(0);
        h.coord.onSubscribeOk({ group: 0n, object: 0n });
        expect(h.calls.joiningFetch).toBe(1);
    });

    it('#4/#7: head + delta prefix, FETCH_OK + FIN, then live delta → one READY then updates', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 1n });
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.obj({ location: { group: 0n, object: 1n }, kind: 'payload', payload: msfDelta('audio') });
        expect(h.calls.ready).toHaveLength(0);       // prefix incomplete
        h.f.ok({ group: 0n, object: 2n }, false);
        expect(h.calls.ready).toHaveLength(0);       // FETCH_OK alone ≠ complete (#8)
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video', 'audio']]);  // ONE converged ready
        // Live delta after readiness → catalog_updated.
        h.coord.onLiveCatalogObject({ location: { group: 0n, object: 2n }, kind: 'payload', payload: msfDelta('captions') }, 100n);
        expect(h.calls.updated).toEqual([['video', 'audio', 'captions']]);
    });

    it('#8: FIN alone ≠ complete — readiness deferred until FETCH_OK', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 0n });
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.closed(true);
        expect(h.calls.ready).toHaveLength(0);
        h.f.ok({ group: 0n, object: 1n }, false);
        expect(h.calls.ready).toEqual([['video']]);
    });

    it('#9: sparse IDs (0, 2, 5) with FETCH_OK end 6 complete — no short-FIN rule', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 5n });
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.obj({ location: { group: 0n, object: 2n }, kind: 'payload', payload: msfDelta('audio') });
        h.f.obj({ location: { group: 0n, object: 5n }, kind: 'payload', payload: msfDelta('captions') });
        h.f.ok({ group: 0n, object: 6n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video', 'audio', 'captions']]);
        // Variant: last delivered 3 below end 6 with 4-5 nonexistent → also complete.
        const h2 = makeHarness();
        h2.coord.start();
        h2.coord.onSubscribeOk({ group: 0n, object: 5n });
        h2.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['v']) });
        h2.f.obj({ location: { group: 0n, object: 3n }, kind: 'payload', payload: msfDelta('a') });
        h2.f.ok({ group: 0n, object: 6n }, false);
        h2.f.closed(true);
        expect(h2.calls.ready).toHaveLength(1);
    });

    it('ascending violation in the fetch is a failed prefix → fallback ladder', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 5n });
        // MSF-00 accepts the first existing object at any ID as the base…
        h.f.obj({ location: { group: 0n, object: 3n }, kind: 'payload', payload: msf00Indep(['v']) });
        // …then the fetch DESCENDS — an ordering violation the coordinator
        // never reorders around: failed prefix → ladder.
        h.f.obj({ location: { group: 0n, object: 1n }, kind: 'payload', payload: msfDelta('a') });
        expect(h.calls.standaloneFetches).toHaveLength(1);     // rung 1
    });
});

describe('CatalogBootstrap — gaps and markers', () => {
    it('#10: a missing-status gap at a delta position is accounted, not parsed; prefix completes', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 2n });
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.obj({ location: { group: 0n, object: 1n }, kind: 'gap', gapKind: 'missing' });
        h.f.obj({ location: { group: 0n, object: 2n }, kind: 'payload', payload: msfDelta('audio') });
        h.f.ok({ group: 0n, object: 3n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video', 'audio']]);
    });

    it('#10: gap@0 does not erase the profile distinction — MSF-00 numeric indep@2 accepted', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 2n });
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'gap', gapKind: 'missing' });
        h.f.obj({ location: { group: 0n, object: 2n }, kind: 'payload', payload: msf00Indep(['video']) });
        h.f.ok({ group: 0n, object: 3n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video']]);  // MSF-00: first EXISTING object is the independent
    });

    it('#10: gap@0 + MSF-01 string indep@2 → AWAIT_NEWER_HEAD, resolved by a live head', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 4n, object: 2n });
        h.f.obj({ location: { group: 4n, object: 0n }, kind: 'gap', gapKind: 'missing' });
        // MSF-01 mandates object 0 independent; an independent at 2 violates "≥1 MUST be deltas".
        h.f.obj({ location: { group: 4n, object: 2n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.ok({ group: 4n, object: 3n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toHaveLength(0);       // no base accepted
        // The next live independent head resolves it.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 0n }, kind: 'payload', payload: msf01Indep(['video2']) }, 101n);
        expect(h.calls.ready).toEqual([['video2']]);
    });

    it('#10c: a payload at the SAME location as a prior terminator marker is accepted (ordering + dedup)', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 4n, object: 3n });
        h.f.obj({ location: { group: 4n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        // d18 EOR marker at the NEXT location {5,0}…
        h.f.obj({ location: { group: 5n, object: 0n }, kind: 'gap', gapKind: 'terminator' });
        h.f.ok({ group: 4n, object: 4n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video']]);
        // …which the live subscription later fills with a REAL independent at {5,0}.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 0n }, kind: 'payload', payload: msf01Indep(['v2']) }, 102n);
        expect(h.calls.updated).toEqual([['v2']]);   // applied — marker never entered payload dedup
    });

    it('#9b: status-only completion → AWAIT_FIRST_PAYLOAD; first live payload classified', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 4n, object: 0n });
        h.f.obj({ location: { group: 4n, object: 0n }, kind: 'gap', gapKind: 'terminator' });
        h.f.ok({ group: 4n, object: 1n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toHaveLength(0);
        expect(h.coord.phase).toBe('await-first-payload');
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) }, 103n);
        expect(h.calls.ready).toEqual([['video']]);
    });

    it('#9c: status-only completion then silence → rung 2 at the inactivity deadline', () => {
        vi.useFakeTimers();
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 4n, object: 0n });
        h.f.obj({ location: { group: 4n, object: 0n }, kind: 'gap', gapKind: 'terminator' });
        h.f.ok({ group: 4n, object: 1n }, false);
        h.f.closed(true);
        expect(h.calls.legacyResubscribes).toBe(0);
        vi.advanceTimersByTime(CATALOG_BOOTSTRAP_INACTIVITY_MS + 1);
        expect(h.calls.legacyResubscribes).toBe(1);
    });
});

describe('CatalogBootstrap — suffix convergence', () => {
    it('#6/#11: live deltas before fetch base are held, applied after prefix, ascending, deduped', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 1n });
        // Live suffix arrives FIRST (race B).
        h.coord.onLiveCatalogObject({ location: { group: 0n, object: 3n }, kind: 'payload', payload: msfDelta('captions') }, 104n);
        h.coord.onLiveCatalogObject({ location: { group: 0n, object: 2n }, kind: 'payload', payload: msfDelta('audio') }, 104n);
        expect(h.calls.ready).toHaveLength(0);       // nothing applied yet, no fatal
        // Prefix: head + delta, complete.
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.obj({ location: { group: 0n, object: 1n }, kind: 'payload', payload: msfDelta('hd') });
        h.f.ok({ group: 0n, object: 2n }, false);
        h.f.closed(true);
        // Ready with the converged prefix, then the suffix in ascending order.
        expect(h.calls.ready).toEqual([['video', 'hd']]);
        expect(h.calls.updated).toEqual([
            ['video', 'hd', 'audio'],
            ['video', 'hd', 'audio', 'captions'],
        ]);
    });

    it('#7: an exact duplicate delivered by both fetch and subscription applies once', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 1n });
        h.coord.onLiveCatalogObject({ location: { group: 0n, object: 1n }, kind: 'payload', payload: msfDelta('audio') }, 105n);
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.obj({ location: { group: 0n, object: 1n }, kind: 'payload', payload: msfDelta('audio') });
        h.f.ok({ group: 0n, object: 2n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video', 'audio']]);
        expect(h.calls.updated).toEqual([]);         // suffix duplicate deduped, no event
    });

    it('#12: a newer independent on the live sub mid-prefix supersedes — fetchCancel + ready on the new head', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 4n, object: 9n });
        h.f.obj({ location: { group: 4n, object: 0n }, kind: 'payload', payload: msf01Indep(['old']) });
        const superseded = h.attempt();
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 0n }, kind: 'payload', payload: msf01Indep(['new']) }, 106n);
        expect(h.calls.cancels).toBe(1);
        expect(h.calls.ready).toEqual([['new']]);
        // Trailing stale fetch objects are inert.
        h.f.obj({ location: { group: 4n, object: 1n }, kind: 'payload', payload: msfDelta('stale') }, superseded);
        expect(h.calls.updated).toEqual([]);
        expect(h.calls.fatals).toEqual([]);
    });

    it('#13: suffix-buffer overflow fails the bootstrap → ladder (never silent drop)', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 0n });
        for (let i = 0; i < 300; i++) {
            h.coord.onLiveCatalogObject({ location: { group: 0n, object: BigInt(i + 1) }, kind: 'payload', payload: msfDelta(`t${i}`) }, 107n);
        }
        expect(h.calls.standaloneFetches.length + h.calls.legacyResubscribes).toBeGreaterThan(0);
    });
});

describe('CatalogBootstrap — MSF delta-at-head vs CF-01', () => {
    it('#16: CF-01 patch as first prefix object → cancel joining fetch FIRST, then full-history fetch', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 7n, object: 2n });
        h.f.obj({ location: { group: 7n, object: 0n }, kind: 'payload', payload: cf01Patch() });
        expect(h.calls.cancels).toBe(1);                              // original join cancelled first
        expect(h.calls.standaloneFetches).toEqual([
            { startGroup: 0n, startObject: 0n, endGroupWholeOf: 7n }, // full history {0,0}..whole-group
        ]);
        expect(h.calls.legacyResubscribes).toBe(0);
    });

    it('#17: MSF delta at the head → AWAIT_NEWER_HEAD — never full-history, never applied', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 7n, object: 2n });
        h.f.obj({ location: { group: 7n, object: 0n }, kind: 'payload', payload: msfDelta('x') });
        expect(h.calls.standaloneFetches).toHaveLength(0);           // no full-history for MSF
        expect(h.coord.phase).toBe('await-newer-head');
        expect(h.manager.currentState).toBeNull();                   // never applied over anything
        // Resolves on the next live independent head.
        h.coord.onLiveCatalogObject({ location: { group: 8n, object: 0n }, kind: 'payload', payload: msf01Indep(['fresh']) }, 108n);
        expect(h.calls.ready).toEqual([['fresh']]);
    });

    it('#17: AWAIT_NEWER_HEAD times out to rung 2 on sustained silence', () => {
        vi.useFakeTimers();
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 7n, object: 2n });
        h.f.obj({ location: { group: 7n, object: 0n }, kind: 'payload', payload: msfDelta('x') });
        // Live (non-resolving) activity re-arms the timer…
        vi.advanceTimersByTime(CATALOG_BOOTSTRAP_INACTIVITY_MS - 100);
        h.coord.onLiveCatalogObject({ location: { group: 7n, object: 3n }, kind: 'payload', payload: msfDelta('y') }, 109n);
        vi.advanceTimersByTime(CATALOG_BOOTSTRAP_INACTIVITY_MS - 100);
        expect(h.calls.legacyResubscribes).toBe(0);
        // …silence trips it.
        vi.advanceTimersByTime(200);
        expect(h.calls.legacyResubscribes).toBe(1);
    });
});

describe('CatalogBootstrap — failure ladder', () => {
    it('#14: INVALID_RANGE → EMPTY_WAIT (fetch resolved, NOT ready, no resubscribe, indefinite)', () => {
        vi.useFakeTimers();
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk(null);          // no largest — track empty
        h.f.err('invalid-range');
        expect(h.coord.phase).toBe('empty-wait');
        expect(h.calls.ready).toHaveLength(0);
        // #23d: intentionally indefinite — no fallback on any timescale.
        vi.advanceTimersByTime(60_000);
        expect(h.calls.legacyResubscribes).toBe(0);
        expect(h.calls.standaloneFetches).toHaveLength(0);
        // First live head completes the bootstrap.
        h.coord.onLiveCatalogObject({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) }, 110n);
        expect(h.calls.ready).toEqual([['video']]);
    });

    it('#15: refusal with history → rung 1 standalone fetch from SUBSCRIBE_OK largest, sub retained', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 6n, object: 4n });
        h.f.err('refused');
        expect(h.calls.standaloneFetches).toEqual([
            { startGroup: 6n, startObject: 0n, endGroupWholeOf: 6n },
        ]);
        expect(h.calls.legacyResubscribes).toBe(0);   // live sub retained — no churn
        // The emulated prefix completes normally.
        h.f.obj({ location: { group: 6n, object: 0n }, kind: 'payload', payload: msf00Indep(['video']) });
        h.f.ok({ group: 6n, object: 5n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video']]);
    });

    it('refusal with NO largest available → straight to rung 2', () => {
        const h = makeHarness();
        h.coord.start();
        h.f.err('refused');       // SUBSCRIBE_OK not yet seen
        expect(h.calls.standaloneFetches).toHaveLength(0);
        expect(h.calls.legacyResubscribes).toBe(1);
    });

    it('#20: rung 1 failure → rung 2; legacy path ready on first acceptable base', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 6n, object: 4n });
        h.f.err('refused');       // → rung 1
        h.f.err('refused');       // rung 1 also refused → rung 2
        expect(h.calls.legacyResubscribes).toBe(1);
        // Legacy replay: an old-group independent, then a NEWER-group delta whose
        // head is missing — the delta must be DROPPED (the invariant holds).
        h.coord.onLiveCatalogObject({ location: { group: 2n, object: 0n }, kind: 'payload', payload: msf00Indep(['video']) }, 111n);
        expect(h.calls.ready).toEqual([['video']]);   // first acceptable base
        h.coord.onLiveCatalogObject({ location: { group: 3n, object: 5n }, kind: 'payload', payload: msfDelta('orphan') }, 111n);
        expect(h.calls.updated).toEqual([]);          // never applied over prior-group state
        expect(h.calls.fatals).toEqual([]);
    });

    it('#18: partial-prefix failure runs the full rung transaction — suffix retained, manager reset', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 6n, object: 3n });
        // Suffix buffered before the failure.
        h.coord.onLiveCatalogObject({ location: { group: 6n, object: 4n }, kind: 'payload', payload: msfDelta('late') }, 112n);
        // Partial prefix applied…
        h.f.obj({ location: { group: 6n, object: 0n }, kind: 'payload', payload: msf00Indep(['video']) });
        h.f.obj({ location: { group: 6n, object: 1n }, kind: 'payload', payload: msfDelta('audio') });
        // …then the stream resets.
        const retired = h.attempt();
        h.f.closed(false);
        expect(h.calls.standaloneFetches).toHaveLength(1);   // rung 1 replacement
        expect(h.manager.currentState).toBeNull();           // manager reset — clean base
        // A late object from the RETIRED attempt is inert.
        h.f.obj({ location: { group: 6n, object: 2n }, kind: 'payload', payload: msfDelta('stale') }, retired);
        expect(h.manager.currentState).toBeNull();
        // Replacement prefix applies from scratch; retained suffix then applies.
        h.f.obj({ location: { group: 6n, object: 0n }, kind: 'payload', payload: msf00Indep(['video']) });
        h.f.obj({ location: { group: 6n, object: 1n }, kind: 'payload', payload: msfDelta('audio') });
        h.f.ok({ group: 6n, object: 4n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video', 'audio']]);
        expect(h.calls.updated).toEqual([['video', 'audio', 'late']]);  // suffix survived the rung
    });

    it('#19: the inactivity timer is progress-based, not total-duration', () => {
        vi.useFakeTimers();
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 9n });
        // Slow but progressing fetch: objects at 4-second intervals survive.
        for (let i = 0; i <= 2; i++) {
            h.f.obj({
                location: { group: 0n, object: BigInt(i) }, kind: 'payload',
                payload: i === 0 ? msf01Indep(['video']) : msfDelta(`t${i}`),
            });
            vi.advanceTimersByTime(CATALOG_BOOTSTRAP_INACTIVITY_MS - 1000);
        }
        expect(h.calls.standaloneFetches).toHaveLength(0);   // survived > 5 s total
        // Then a stall trips it.
        vi.advanceTimersByTime(1_100);
        expect(h.calls.standaloneFetches).toHaveLength(1);
    });
});

describe('CatalogBootstrap — PUBLISH_DONE reasons', () => {
    it('#21: TRACK_ENDED post-base is not a failure; drained finalizes with no error', () => {
        const h = makeHarness();
        completeSimplePrefix(h);
        h.coord.onPublishDone('ended');
        h.coord.onSubscriptionDrained();
        expect(h.calls.ready).toHaveLength(1);
        expect(h.calls.fatals).toEqual([]);
        expect(h.calls.legacyResubscribes).toBe(0);
    });

    it('#21g: a live delta buffered before DONE survives — applied after the prefix', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 4n });
        h.coord.onLiveCatalogObject({ location: { group: 0n, object: 5n }, kind: 'payload', payload: msfDelta('late') }, 113n);
        h.coord.onPublishDone('ended');
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.ok({ group: 0n, object: 5n }, false);
        h.f.closed(true);
        h.coord.onSubscriptionDrained();
        expect(h.calls.ready).toEqual([['video']]);
        expect(h.calls.updated).toEqual([['video', 'late']]);   // DONE did not empty the suffix
    });

    it('#21b: DONE in EMPTY_WAIT → fatal (no history, no future)', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk(null);
        h.f.err('invalid-range');
        h.coord.onPublishDone('ended');
        h.coord.onSubscriptionDrained();
        expect(h.calls.fatals).toHaveLength(1);
    });

    it('#21b: DONE in AWAIT_FIRST_PAYLOAD → rung 2 (history may exist)', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 4n, object: 0n });
        h.f.obj({ location: { group: 4n, object: 0n }, kind: 'gap', gapKind: 'terminator' });
        h.f.ok({ group: 4n, object: 1n }, false);
        h.f.closed(true);
        h.coord.onPublishDone('ended');
        h.coord.onSubscriptionDrained();
        expect(h.calls.legacyResubscribes).toBe(1);
    });

    it('#21d: DONE before the first fetch payload defers; base + FETCH_OK + FIN still → READY', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 0n });
        h.coord.onPublishDone('ended');       // one-shot catalog: DONE races the fetch
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.ok({ group: 0n, object: 1n }, false);
        h.f.closed(true);
        h.coord.onSubscriptionDrained();
        expect(h.calls.ready).toEqual([['video']]);
        expect(h.calls.fatals).toEqual([]);
    });

    it('#21e: DONE recorded, fetch INVALID_RANGE after → fatal; status-only completion after → rung 2', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk(null);
        h.coord.onPublishDone('ended');
        h.coord.onSubscriptionDrained();
        h.f.err('invalid-range');
        expect(h.calls.fatals).toHaveLength(1);

        const h2 = makeHarness();
        h2.coord.start();
        h2.coord.onSubscribeOk({ group: 4n, object: 0n });
        h2.coord.onPublishDone('ended');
        h2.coord.onSubscriptionDrained();
        h2.f.obj({ location: { group: 4n, object: 0n }, kind: 'gap', gapKind: 'terminator' });
        h2.f.ok({ group: 4n, object: 1n }, false);
        h2.f.closed(true);
        expect(h2.calls.legacyResubscribes).toBe(1);
    });

    it('#21f: fatal-track pre-base → fatal; retriable pre-base → rung 2', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 0n });
        h.coord.onPublishDone('fatal-track');
        expect(h.calls.fatals).toHaveLength(1);

        const h2 = makeHarness();
        h2.coord.start();
        h2.coord.onSubscribeOk({ group: 4n, object: 0n });
        h2.f.obj({ location: { group: 4n, object: 0n }, kind: 'gap', gapKind: 'terminator' });
        h2.f.ok({ group: 4n, object: 1n }, false);
        h2.f.closed(true);      // AWAIT_FIRST_PAYLOAD
        h2.coord.onPublishDone('retriable');
        h2.coord.onSubscriptionDrained();
        expect(h2.calls.legacyResubscribes).toBe(1);
    });

    it('a retriable DONE deferred during the fetch is reprocessed at readiness', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 5n, object: 0n });
        // DONE + drained land while the prefix is still in flight…
        h.coord.onPublishDone('retriable');
        h.coord.onSubscriptionDrained();
        expect(h.calls.fatals).toEqual([]);         // deferred, not lost
        // …the prefix then completes: readiness must immediately request
        // recovery — the live feed is already dead.
        h.f.obj({ location: { group: 5n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.ok({ group: 5n, object: 1n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toEqual([['video']]);
        expect(h.calls.fatals).toEqual(['staged-recovery']);
    });

    it('an exact-location duplicate independent is a silent no-op — no catalog_updated', () => {
        const h = makeHarness();
        completeSimplePrefix(h, 5n);
        expect(h.calls.ready).toEqual([['video']]);
        // The SAME independent re-delivered at the SAME location (overlap
        // defense) must not emit a spurious update.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) }, 300n);
        expect(h.calls.updated).toEqual([]);
    });

    it('retriable DONE post-ready (drained) requests staged recovery; ended does not', () => {
        const h = makeHarness();
        completeSimplePrefix(h);
        h.coord.onPublishDone('retriable');
        h.coord.onSubscriptionDrained();
        expect(h.calls.fatals).toEqual(['staged-recovery']);

        const h2 = makeHarness();
        completeSimplePrefix(h2);
        h2.coord.onPublishDone('ended');
        h2.coord.onSubscriptionDrained();
        expect(h2.calls.fatals).toEqual([]);
    });

    it('abort() makes every late input inert', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 0n, object: 0n });
        h.coord.abort();
        h.f.obj({ location: { group: 0n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) });
        h.f.ok({ group: 0n, object: 1n }, false);
        h.f.closed(true);
        h.coord.onLiveCatalogObject({ location: { group: 1n, object: 0n }, kind: 'payload', payload: msf01Indep(['x']) }, 114n);
        expect(h.calls.ready).toHaveLength(0);
        expect(h.calls.fatals).toHaveLength(0);
        expect(h.coord.phase).toBe('aborted');
    });
});

describe('CatalogBootstrap — retained chain (rung 2)', () => {
    function toRung2WithSuffix(objs: Array<{ loc: { group: bigint; object: bigint }; payload: Uint8Array; clean?: boolean }>): Harness {
        const h = makeHarness();
        h.coord.start();
        // largest group 8: a buffered group-7 independent is NOT a supersession
        // (supersession — a strictly newer head — is covered by #12).
        h.coord.onSubscribeOk({ group: 8n, object: 0n });
        for (const o of objs) {
            h.coord.onLiveCatalogObject({ location: o.loc, kind: 'payload', payload: o.payload }, 200n);
        }
        h.coord.onLiveStreamEvent(200n, 'fin');   // contributing stream ends cleanly
        h.f.err('refused');           // rung 1
        h.f.err('refused');           // rung 2
        return h;
    }

    it('#23f-chain: a retained self-contained chain (head + same-group deltas) supersedes replayed history', () => {
        const h = toRung2WithSuffix([
            { loc: { group: 7n, object: 0n }, payload: msf00Indep(['newer']) },
            { loc: { group: 7n, object: 1n }, payload: msfDelta('extra') },
        ]);
        // Replayed old history arrives first and becomes the base…
        h.coord.onLiveCatalogObject({ location: { group: 2n, object: 0n }, kind: 'payload', payload: msf00Indep(['old']) }, 201n);
        expect(h.calls.ready).toEqual([['old']]);
        // …then the retained chain supersedes it (its group is newer).
        expect(h.calls.updated.at(-1)).toEqual(['newer', 'extra']);
    });

    it('#23f-seq: a headless retained delta is NEVER spliced onto replayed history', () => {
        const h = toRung2WithSuffix([
            { loc: { group: 6n, object: 5n }, payload: msfDelta('orphan') },  // no head in snapshot
        ]);
        h.coord.onLiveCatalogObject({ location: { group: 6n, object: 0n }, kind: 'payload', payload: msf00Indep(['base']) }, 202n);
        expect(h.calls.ready).toEqual([['base']]);
        h.coord.onLiveCatalogObject({ location: { group: 6n, object: 2n }, kind: 'payload', payload: msfDelta('replayed') }, 202n);
        // Applied: base + replayed. The orphan retained delta is NOT spliced in.
        expect(h.calls.updated).toEqual([['base', 'replayed']]);
    });

    // Only a peer FIN is clean. A reset, OUR OWN cancellation, and a generic
    // failure are all non-clean — and the chain rule must test for the one
    // clean value rather than exclude the reset it was first written against.
    for (const terminal of ['reset', 'local-discard', 'error'] as const) {
        it(`#23f-race: a ${terminal} on the contributing stream dirties the chain — not applied`, () => {
            const h = makeHarness();
            h.coord.start();
            h.coord.onSubscribeOk({ group: 8n, object: 0n });
            h.coord.onLiveCatalogObject({ location: { group: 7n, object: 0n }, kind: 'payload', payload: msf00Indep(['newer']) }, 203n);
            h.coord.onLiveStreamEvent(203n, terminal);  // NOT clean
            h.f.err('refused');
            h.f.err('refused');
            h.coord.onLiveCatalogObject({ location: { group: 2n, object: 0n }, kind: 'payload', payload: msf00Indep(['old']) }, 204n);
            expect(h.calls.ready).toEqual([['old']]);
            expect(h.calls.updated).toEqual([]);       // dirty chain dropped, never applied
        });
    }
});

describe('CatalogBootstrap — live profile bookkeeping (F6/F10)', () => {
    const cf01Indep = () => enc({
        version: 1, streamingFormat: 1, streamingFormatVersion: '0.2', supportsDeltaUpdates: true,
        commonTrackFields: { namespace: 'live/test', packaging: 'cmaf', renderGroup: 1 },
        tracks: [{ name: '1.m4s', initTrack: '0.mp4', selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } }],
    });

    it('an independent supersession updates the base profile — a later orphan MSF delta no longer rides the CF-01 cross-group path', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 5n, object: 0n });
        h.f.obj({ location: { group: 5n, object: 0n }, kind: 'payload', payload: cf01Indep() });
        h.f.ok({ group: 5n, object: 1n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toHaveLength(1);
        // A live MSF-01 independent REPLACES the catalog (new group head).
        h.coord.onLiveCatalogObject({ location: { group: 8n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) }, 10n);
        expect(h.calls.updated).toHaveLength(1);
        const updatedBefore = h.calls.updated.length;
        const fatalsBefore = h.calls.fatals.length;
        // Orphan MSF delta: group 9's head was never applied — it must be
        // DROPPED, not applied through a stale cf01 cross-group exemption.
        h.coord.onLiveCatalogObject({ location: { group: 9n, object: 1n }, kind: 'payload', payload: msfDelta('late') }, 11n);
        expect(h.calls.updated).toHaveLength(updatedBefore);
        expect(h.calls.fatals).toHaveLength(fatalsBefore);
    });

    it('a live MSF-01 independent at a NONZERO object never becomes a base (objects ≥1 MUST be deltas)', () => {
        const h = makeHarness();
        completeSimplePrefix(h);
        expect(h.calls.ready).toHaveLength(1);
        h.coord.onLiveCatalogObject({ location: { group: 8n, object: 2n }, kind: 'payload', payload: msf01Indep(['other']) }, 10n);
        expect(h.calls.updated).toHaveLength(0);
        // No base for group 8 was applied, so its deltas stay dropped too.
        h.coord.onLiveCatalogObject({ location: { group: 8n, object: 3n }, kind: 'payload', payload: msfDelta('x') }, 11n);
        expect(h.calls.updated).toHaveLength(0);
    });

    it('a new MSF head prunes the manager dedup below its group — bounded WITHOUT age eviction', () => {
        const h = makeHarness();
        completeSimplePrefix(h);            // head applied at (5,0)
        h.coord.onLiveCatalogObject({ location: { group: 8n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) }, 10n);
        const locations = (h.manager as unknown as { appliedLocations: Set<string> }).appliedLocations;
        expect([...locations]).toEqual(['8:0']);   // group-5 entries provably obsolete → pruned
    });

    it('a FAILED live replacement head leaves the old dedup intact — no premature prune', () => {
        const h = makeHarness();
        completeSimplePrefix(h);            // base (5,0) applied
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 1n }, kind: 'payload', payload: msfDelta('a') }, 10n);
        const locations = (h.manager as unknown as { appliedLocations: Set<string> }).appliedLocations;
        expect(locations.size).toBe(2);
        // A MALFORMED independent at a newer group: parse fails → the old
        // catalog stays active and its replay protection must survive.
        h.coord.onLiveCatalogObject({ location: { group: 9n, object: 0n }, kind: 'payload', payload: new TextEncoder().encode('{broken') }, 11n);
        expect(locations.has('5:0')).toBe(true);
        expect(locations.has('5:1')).toBe(true);
        // A replayed old delta is still deduplicated.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 1n }, kind: 'payload', payload: msfDelta('a') }, 12n);
        expect(h.calls.updated).toHaveLength(1);   // no double-application
    });

    it('live-phase stream headers are not tracked — suffix evidence stays bounded for the session lifetime', () => {
        const h = makeHarness();
        completeSimplePrefix(h);
        for (let i = 0; i < 50; i++) h.coord.onLiveStreamEvent(BigInt(1000 + i), 'header');
        const streams = (h.coord as unknown as { suffixStreams: Map<bigint, unknown> }).suffixStreams;
        expect(streams.size).toBe(0);
    });
});

describe('CatalogBootstrap — legacy start mode terminal', () => {
    it('a legacy-mode coordinator whose subscription drains before any base FAILS instead of hanging', () => {
        const h = makeHarness();
        const coord = new CatalogBootstrap({
            applyAt: (loc, payload, opts) => h.manager.processCatalogObjectAt(loc, payload, opts),
            resetManager: () => h.manager.reset(),
            currentState: () => h.manager.currentState,
            issueJoiningFetch: () => { throw new Error('legacy mode must not fetch'); },
            issueStandaloneFetch: () => { throw new Error('legacy mode must not fetch'); },
            cancelFetch: () => { /* none */ },
            onReady: () => h.calls.ready.push(['ready']),
            onUpdated: () => { /* none */ },
            requestLegacyResubscribe: () => h.calls.legacyResubscribes++,
            onFatal: (r) => h.calls.fatals.push(r),
            onDegraded: (r) => h.calls.fatals.push(`degraded:${r}`),
            requestStagedRecovery: () => { /* none */ },
            log: () => { /* silent */ },
        }, { draft: 16, startMode: 'legacy' });
        coord.start();
        expect(coord.phase).toBe('fallback-legacy');
        coord.onPublishDone('ended');
        coord.onSubscriptionDrained();
        expect(h.calls.fatals.some((f) => f.includes('before a base'))).toBe(true);
    });
});

describe('CatalogBootstrap — rejected-delta chain invalidation', () => {
    const bogusDelta = () => enc({ deltaUpdate: [{ op: 'bogus-op', tracks: [{ name: 'x' }] }] });

    it('an MSF delta failure blocks later deltas of the group until a fresh independent head', () => {
        const h = makeHarness();
        completeSimplePrefix(h);
        expect(h.calls.ready).toHaveLength(1);
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 1n }, kind: 'payload', payload: msfDelta('captions') }, 10n);
        expect(h.calls.updated).toHaveLength(1);
        // A REJECTED delta: state now provably misses this update.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 2n }, kind: 'payload', payload: bogusDelta() }, 11n);
        const degradedCount = h.calls.fatals.length;
        expect(degradedCount).toBeGreaterThan(0);
        // A later VALID delta of the same group depends on the rejected one —
        // it must be dropped, not applied over the gapped state.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 3n }, kind: 'payload', payload: msfDelta('subtitles') }, 12n);
        expect(h.calls.updated).toHaveLength(1);
        expect(h.calls.fatals).toHaveLength(degradedCount);   // silent drop, no extra fault
        // A fresh independent head heals the chain wholesale.
        h.coord.onLiveCatalogObject({ location: { group: 6n, object: 0n }, kind: 'payload', payload: msf01Indep(['video']) }, 13n);
        expect(h.calls.updated).toHaveLength(2);
        h.coord.onLiveCatalogObject({ location: { group: 6n, object: 1n }, kind: 'payload', payload: msfDelta('captions') }, 14n);
        expect(h.calls.updated).toHaveLength(3);
    });

    it('a CF-01 patch failure blocks the whole positional chain until a new independent', () => {
        const h = makeHarness();
        h.coord.start();
        h.coord.onSubscribeOk({ group: 5n, object: 0n });
        h.f.obj({ location: { group: 5n, object: 0n }, kind: 'payload', payload: enc({
            version: 1, streamingFormat: 1, streamingFormatVersion: '0.2', supportsDeltaUpdates: true,
            commonTrackFields: { namespace: 'live/test', packaging: 'cmaf', renderGroup: 1 },
            tracks: [{ name: '1.m4s', initTrack: '0.mp4', selectionParams: { codec: 'avc1.640028', mimeType: 'video/mp4' } }],
        }) });
        h.f.ok({ group: 5n, object: 1n }, false);
        h.f.closed(true);
        expect(h.calls.ready).toHaveLength(1);
        // A patch that FAILS to apply (bad path) poisons the chain.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 1n }, kind: 'payload', payload: enc([{ op: 'remove', path: '/tracks/99' }]) }, 10n);
        const afterFail = h.calls.updated.length;
        // Subsequent patches are positional against a document missing the
        // failed update — dropped until a fresh independent.
        h.coord.onLiveCatalogObject({ location: { group: 5n, object: 2n }, kind: 'payload', payload: enc([{ op: 'remove', path: '/tracks/0' }]) }, 11n);
        expect(h.calls.updated).toHaveLength(afterFail);
    });
});
