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

    /**
     * Process a catalog object payload (independent or delta).
     *
     * The first object MUST be an independent catalog (§9.1).
     * Subsequent objects may be independent catalogs or delta updates.
     *
     * Format detection:
     * - Array → cf01 JSON Patch delta (RFC 6902)
     * - Object with deltaUpdate: true → MSF-00 delta
     * - Object with streamingFormat → cf01 independent catalog
     * - Object without streamingFormat → MSF-00 independent catalog
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
                };
            }
        }

        this._objectCount++;
        return this.state!;
    }
}
