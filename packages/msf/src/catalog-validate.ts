/**
 * Shared post-parse validation for a normalized catalog. Kept in a leaf module
 * (imports only the type) so EVERY public catalog-producing path — the MSF-00
 * and CF-01 parsers and the CF-01/delta application paths — can call it without
 * a circular import.
 *
 * @module
 */

import type { Catalog, CatalogDelta, CatalogState, Msf01Delta } from './types.js';

/**
 * Reject a normalized catalog carrying a non-finite number. JSON permits an
 * overflow exponent (`1e999` → Infinity), which `typeof x === 'number'` accepts,
 * so a catalog with Infinity/NaN for generatedAt, bitrate, width, … is corrupt
 * data; throw a base `Error` (a caught, deterministic rejection) rather than
 * propagate it downstream. Bounded recursion covers catalog- and track-level
 * fields (and any future nested numeric field).
 */
export function assertFiniteCatalogNumbers(cat: Catalog | CatalogState): void {
  walk(cat, 'Catalog', 0);
}

/**
 * Reject a parsed delta update carrying a non-finite number (generatedAt or any
 * added/cloned track field from a JSON overflow exponent). `parseDeltaUpdate`
 * hands the delta to callers directly — validation cannot wait for
 * `applyCatalogUpdate`, which may never run.
 */
export function assertFiniteCatalogDelta(delta: CatalogDelta): void {
  walk(delta, 'Catalog delta', 0);
}

/**
 * Reject an MSF-01 op-array delta carrying a non-finite number (generatedAt or
 * any op-track numeric field from a JSON overflow exponent). Same contract as
 * {@link assertFiniteCatalogDelta}; the op-array shape is walked generically.
 */
export function assertFiniteMsf01Delta(delta: Msf01Delta): void {
  walk(delta, 'MSF-01 delta', 0);
}

/**
 * Reject builder input carrying a non-finite number before it is serialized:
 * `JSON.stringify(Infinity)` is `"null"`, so an Infinity/NaN field would be
 * silently emitted as `null` in the catalog payload. Throw instead of shipping
 * corrupt bytes.
 */
export function assertFiniteBuilderInput(value: unknown): void {
  walk(value, 'Catalog', 0);
}

function walk(value: unknown, path: string, depth: number): void {
  if (depth > 8 || value === null) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number, got ${String(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => walk(el, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, `${path}.${k}`, depth + 1);
  }
}
