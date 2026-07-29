/**
 * CatalogManager — manages the catalog subscription lifecycle.
 *
 * Responsibilities:
 * - Detect catalog format (MSF-00 vs catalogformat-01) from JSON content
 * - Parse initial independent catalog via appropriate parser
 * - Detect and apply delta updates (MSF-00 deltas or cf01 JSON Patch)
 * - Track catalog namespace for namespace inheritance (§5.1.10)
 * - Detect broadcast completion via isComplete (§5.1.7, §9.2)
 *
 * The player creates one CatalogManager and feeds it catalog objects
 * as they arrive from the adapter. The manager maintains the
 * materialized CatalogState.
 *
 * @see draft-ietf-moq-msf-00 §5 (Catalog)
 * @see draft-ietf-moq-msf-00 §5.2 (Delta Updates)
 * @see draft-ietf-moq-catalogformat-01 §3 (Legacy format)
 * @see draft-ietf-moq-catalogformat-01 §4 (JSON Patch deltas)
 * @module
 */

import type { CatalogState } from '@moqt/msf';
import {
    parseMsfCatalog,
    parseDeltaUpdate,
    applyCatalogUpdate,
    parseMsf01Delta,
    applyMsf01Delta,
    parseCatalogFormat01,
    applyCf01Patch,
} from '@moqt/msf';

/**
 * Manages catalog state across independent catalogs and delta updates.
 */
export class CatalogManager {
    /**
     * Catalog namespace — used for namespace inheritance (§5.1.10).
     * Tracks without explicit namespace inherit this value.
     */
    private readonly catalogNamespace: string;

    /** Current materialized catalog state. Null until first catalog received. */
    private state: CatalogState | null = null;

    /** Number of catalog objects processed. */
    private _objectCount = 0;

    /** Whether the cf01 catalog advertised delta update support. */
    private cf01DeltaSupport = false;

    /** Raw document for cf01 JSON Patch base. */
    private lastRawDocument: Record<string, unknown> | null = null;

    /** Exact locations already applied via {@link processCatalogObjectAt}.
     *  Pruned only via {@link pruneLocationsBefore} — never by age: an evicted
     *  location would let a replayed CF-01 patch re-apply positionally and
     *  corrupt the document. Fail-closed capacity — see processCatalogObjectAt. */
    private readonly appliedLocations = new Set<string>();
    private static readonly MAX_APPLIED_LOCATIONS = 65_536;

    /** Highest group with an applied object (location-aware path only). */
    private _latestGroup: bigint | null = null;

    /** Last applied location (location-aware path only). */
    private _lastApplied: { group: bigint; object: bigint } | null = null;

    constructor(catalogNamespace: string) {
        this.catalogNamespace = catalogNamespace;
    }

    /** Current catalog state, or null if no catalog received yet. */
    get currentState(): CatalogState | null {
        return this.state;
    }

    /** Number of catalog objects processed. */
    get objectCount(): number {
        return this._objectCount;
    }

    /** Highest group with an applied object (location-aware path only). */
    get latestGroup(): bigint | null {
        return this._latestGroup;
    }

    /** Last applied location (location-aware path only). */
    get lastApplied(): { group: bigint; object: bigint } | null {
        return this._lastApplied;
    }

    /**
     * Full reset: materialized state, cf01 patch context, location dedup and
     * trackers, object count. Used per bootstrap generation (and on migration)
     * so a later session can never apply a delta against a stale base — the
     * cf01 JSON Patch path in particular is stateful over `lastRawDocument`
     * and silently corrupts if replayed against pre-reset state.
     */
    reset(): void {
        this.state = null;
        this._objectCount = 0;
        this.cf01DeltaSupport = false;
        this.lastRawDocument = null;
        this.appliedLocations.clear();
        this._latestGroup = null;
        this._lastApplied = null;
    }

    /**
     * Location-aware apply with EXACT-LOCATION dedup — and nothing more.
     *
     * A duplicate `(group, object)` is a no-op (`'duplicate'`), never a throw:
     * with a fetch prefix and a live suffix converging, the same object can
     * legally be seen twice, and a replayed delta must not be misread as a
     * conflict (nor a cf01 patch re-applied, which corrupts positionally).
     *
     * Deliberately profile-neutral: ordering, group-head rules and the MSF
     * latest-group rule are the CatalogBootstrap coordinator's responsibility —
     * imposing MSF grouping here would break CF-01, whose patches may cross
     * group boundaries.
     *
     * @throws Only on parse/apply errors of an object it accepted.
     */
    processCatalogObjectAt(
        location: { group: bigint; object: bigint },
        payload: Uint8Array,
        opts?: { pruneBeforeOnSuccess?: bigint },
    ): { outcome: 'applied'; state: CatalogState } | { outcome: 'duplicate' } {
        const key = `${location.group}:${location.object}`;
        if (this.appliedLocations.has(key)) return { outcome: 'duplicate' };
        // FAIL-CLOSED capacity: duplicate knowledge cannot be evicted by age
        // (a forgotten location would let a replayed CF-01 patch re-apply
        // positionally), so at capacity the manager REFUSES new applications.
        // The one path through is an independent head carrying
        // `pruneBeforeOnSuccess`: its prune frees capacity — but ONLY after
        // the head has successfully applied (a failed replacement must leave
        // the old catalog's replay protection fully intact).
        if (this.appliedLocations.size >= CatalogManager.MAX_APPLIED_LOCATIONS) {
            // An independent head passes ONLY if its prune would actually
            // restore capacity — checked BEFORE applying (transactional):
            // repeated same-group heads must not creep the set past the cap.
            const freed = opts?.pruneBeforeOnSuccess !== undefined
                ? this.countLocationsBefore(opts.pruneBeforeOnSuccess) : 0;
            if (this.appliedLocations.size - freed >= CatalogManager.MAX_APPLIED_LOCATIONS) {
                throw new Error('catalog location-dedup capacity exhausted — refusing updates until a fresh independent base');
            }
        }
        const state = this.processCatalogObject(payload);
        if (opts?.pruneBeforeOnSuccess !== undefined) {
            this.pruneLocationsBefore(opts.pruneBeforeOnSuccess);
        }
        this.appliedLocations.add(key);
        if (this._latestGroup === null || location.group > this._latestGroup) {
            this._latestGroup = location.group;
        }
        this._lastApplied = { group: location.group, object: location.object };
        return { outcome: 'applied', state };
    }

    /**
     * Prune dedup entries for locations with `group < beforeGroup`.
     *
     * Called by the coordinator ONLY when those locations are provably
     * obsolete — an MSF independent head at `beforeGroup` applied, so every
     * older group is dropped upstream by the latest-group rule and a replay
     * can never reach {@link processCatalogObjectAt}. This is what bounds the
     * dedup set over a session's lifetime without risking positional
     * re-application (CF-01 bases never prune).
     */
    /** How many dedup entries {@link pruneLocationsBefore} would remove. */
    private countLocationsBefore(beforeGroup: bigint): number {
        let n = 0;
        for (const key of this.appliedLocations) {
            if (BigInt(key.slice(0, key.indexOf(':'))) < beforeGroup) n += 1;
        }
        return n;
    }

    pruneLocationsBefore(beforeGroup: bigint): void {
        for (const key of this.appliedLocations) {
            const group = BigInt(key.slice(0, key.indexOf(':')));
            if (group < beforeGroup) this.appliedLocations.delete(key);
        }
    }

    /**
     * Process a catalog object payload (independent or delta).
     *
     * The first object MUST be an independent catalog (§9.1).
     * Subsequent objects may be independent catalogs or delta updates.
     *
     * Format detection:
     * - Array → cf01 JSON Patch delta (RFC 6902)
     * - Object with deltaUpdate: true → MSF-00 grouped delta
     * - Object with deltaUpdate: [ ... ] → MSF-01 op-array delta (§5.3)
     * - Object with streamingFormat → cf01 independent catalog
     * - Object without streamingFormat → MSF-00/MSF-01/CMSF-01 independent catalog
     *
     * @param payload Raw catalog JSON bytes from the catalog track
     * @returns The new materialized CatalogState
     * @throws {Error} If parsing fails or delta arrives before initial catalog
     * @see draft-ietf-moq-msf-00 §5, §5.2
     * @see draft-ietf-moq-catalogformat-01 §3, §4
     */
    processCatalogObject(payload: Uint8Array): CatalogState {
        const text = new TextDecoder().decode(payload);
        const raw: unknown = JSON.parse(text);

        if (Array.isArray(raw)) {
            // ── cf01 JSON Patch delta ──────────────────────────────
            if (!this.cf01DeltaSupport || !this.lastRawDocument) {
                throw new Error(
                    'Received JSON Patch delta but initial catalog did not ' +
                    'advertise supportsDeltaUpdates (catalogformat-01 §4)',
                );
            }
            const result = applyCf01Patch(
                this.lastRawDocument,
                raw,
                this.catalogNamespace,
            );
            this.lastRawDocument = result.rawDocument;
            this.state = { version: 1, tracks: [...result.catalog.tracks] };
        } else if (
            typeof raw === 'object' &&
            raw !== null &&
            'deltaUpdate' in raw &&
            (raw as Record<string, unknown>)['deltaUpdate'] === true
        ) {
            // ── MSF-00 delta ───────────────────────────────────────
            if (!this.state) {
                throw new Error(
                    'Delta catalog update received before initial catalog (§9.1: ' +
                    'publisher MUST publish catalog before media)',
                );
            }
            const delta = parseDeltaUpdate(payload);
            this.state = applyCatalogUpdate(
                this.state,
                delta,
                this.catalogNamespace,
            );
        } else if (
            typeof raw === 'object' &&
            raw !== null &&
            Array.isArray((raw as Record<string, unknown>)['deltaUpdate'])
        ) {
            // ── MSF-01 op-array delta (deltaUpdate:[{op,tracks}]) ──────
            if (!this.state) {
                throw new Error(
                    'Delta catalog update received before initial catalog (§9.1: ' +
                    'publisher MUST publish catalog before media)',
                );
            }
            const delta = parseMsf01Delta(payload);
            this.state = applyMsf01Delta(
                this.state,
                delta,
                this.catalogNamespace,
            );
        } else {
            // ── Independent catalog — detect format ────────────────
            const obj = raw as Record<string, unknown>;

            if ('streamingFormat' in obj) {
                // catalogformat-01
                const result = parseCatalogFormat01(
                    payload,
                    this.catalogNamespace,
                );
                this.cf01DeltaSupport = result.supportsDeltaUpdates;
                this.lastRawDocument = result.rawDocument;
                this.state = {
                    version: result.catalog.version,
                    tracks: [...result.catalog.tracks],
                };
            } else {
                // MSF-00
                const catalog = parseMsfCatalog(payload, this.catalogNamespace);
                // Explicit reset — clear cf01 state to prevent stale patch context
                this.cf01DeltaSupport = false;
                this.lastRawDocument = null;
                this.state = {
                    version: catalog.version,
                    tracks: [...catalog.tracks],
                    ...(catalog.generatedAt !== undefined
                        ? { generatedAt: catalog.generatedAt }
                        : {}),
                    ...(catalog.isComplete !== undefined
                        ? { isComplete: catalog.isComplete }
                        : {}),
                    // MSF-01 / CMSF-01 root fields: materialized so the player
                    // can resolve per-track initRef against the root initDataList and
                    // preserve content-protection metadata. Absent on MSF-00 catalogs.
                    ...(catalog.initDataList !== undefined
                        ? { initDataList: catalog.initDataList }
                        : {}),
                    ...(catalog.contentProtections !== undefined
                        ? { contentProtections: catalog.contentProtections }
                        : {}),
                    ...(catalog.publishTracks !== undefined
                        ? { publishTracks: catalog.publishTracks }
                        : {}),
                };
            }
        }

        this._objectCount++;
        return this.state!;
    }
}
