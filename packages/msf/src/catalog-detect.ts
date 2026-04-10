/**
 * Auto-detect catalog format and parse.
 *
 * Simple entry point for callers that don't need delta support.
 * CatalogManager does its own detection — see catalog-manager.ts.
 *
 * @module
 */

import type { Catalog } from './types.js';
import { parseMsfCatalog } from './catalog-msf00.js';
import { parseCatalogFormat01 } from './catalog-cf01.js';

/**
 * Parse a catalog, auto-detecting the format.
 *
 * Detection: if the root object has a `streamingFormat` key, it's
 * catalogformat-01; otherwise it's MSF-00.
 *
 * @param json Raw JSON string or UTF-8 bytes
 * @param catalogNamespace Namespace fallback
 * @returns Parsed Catalog (normalized, regardless of source format)
 * @throws {Error} If input is an array (JSON Patch delta — use applyCf01Patch)
 */
export function parseCatalogAuto(
    json: string | Uint8Array,
    catalogNamespace?: string,
): Catalog {
    const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
    const raw: unknown = JSON.parse(text);

    if (Array.isArray(raw)) {
        throw new Error(
            'Input is a JSON array (likely a JSON Patch delta, not an independent catalog). ' +
            'Use applyCf01Patch() for delta updates.',
        );
    }

    if (typeof raw !== 'object' || raw === null) {
        throw new Error('Catalog must be a JSON object');
    }

    const obj = raw as Record<string, unknown>;

    if ('streamingFormat' in obj) {
        return parseCatalogFormat01(text, catalogNamespace).catalog;
    }

    return parseMsfCatalog(text, catalogNamespace);
}
