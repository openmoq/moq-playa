/**
 * Finite-number enforcement pinned at EVERY public catalog boundary in this
 * package.
 *
 * A JSON overflow exponent (`1e999`) parses to `Infinity`, which
 * `typeof x === 'number'` accepts, and `JSON.stringify(Infinity)` is `"null"` —
 * so a non-finite field is either propagated as corrupt data or silently
 * flattened to `null` on the wire. Every public parse/apply/build entrypoint
 * must reject it with a base `Error` (never a `TypeError`, never silently).
 *
 * These tests live in the OWNING package (not only the corpus/fuzz lanes) so
 * that removing or moving any single `assertFinite*` call fails here — the
 * corpus and fuzz suites import the built dist and would not localize the
 * regression to the boundary that lost its guard.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { parseMsfCatalog } from './catalog-msf00.js';
// `parseCatalog` is the public re-exported alias of `parseMsfCatalog`.
import { parseCatalog } from './index.js';
import { parseCatalogFormat01, applyCf01Patch } from './catalog-cf01.js';
import { parseDeltaUpdate, applyCatalogUpdate } from './delta.js';
import { buildCatalog } from './catalog-builder.js';
import type { CatalogDelta, CatalogState } from './types.js';

/** Assert `fn` throws a base `Error` (not a subclass) whose message flags a non-finite number. */
function expectFiniteRejection(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, 'expected a rejection').toBeInstanceOf(Error);
  // A TypeError/RangeError extends Error but signals a DIFFERENT contract; the
  // finite-number guard must throw the base class.
  expect((thrown as Error).constructor, 'must be a base Error, not a subclass').toBe(Error);
  expect((thrown as Error).message).toMatch(/must be a finite number/i);
}

// ─── MSF-00 direct parsers ───────────────────────────────────────────────

describe('parseMsfCatalog / parseCatalog — finite-number guard', () => {
  it('rejects an overflow generatedAt', () => {
    expectFiniteRejection(() =>
      parseMsfCatalog('{"version":1,"generatedAt":1e999,"tracks":[{"name":"v","packaging":"loc","isLive":true}]}'));
  });

  it('rejects an overflow track field', () => {
    expectFiniteRejection(() =>
      parseMsfCatalog('{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"bitrate":1e999}]}'));
  });

  it('the `parseCatalog` alias enforces the same guard', () => {
    expectFiniteRejection(() =>
      parseCatalog('{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"width":1e400}]}'));
  });

  it('accepts a finite catalog through both names', () => {
    const json = '{"version":1,"generatedAt":123,"tracks":[{"name":"v","packaging":"loc","isLive":true,"bitrate":500}]}';
    expect(parseMsfCatalog(json).tracks[0]?.bitrate).toBe(500);
    expect(parseCatalog(json).generatedAt).toBe(123);
  });
});

// ─── CF-01 parse + patch ─────────────────────────────────────────────────

describe('parseCatalogFormat01 / applyCf01Patch — finite-number guard', () => {
  const BASE = {
    version: 1,
    streamingFormat: 1,
    streamingFormatVersion: '0.2',
    tracks: [
      { name: 'v', packaging: 'loc', selectionParams: { bitrate: 1500000 } },
    ],
  };

  it('rejects an overflow selectionParam on parse', () => {
    // Raw JSON text carries the literal overflow exponent — an object built in
    // JS would collapse `1e999` to `Infinity` and `JSON.stringify` it to `null`
    // before the parser ever sees it.
    const bad = '{"version":1,"streamingFormat":1,"streamingFormatVersion":"0.2",'
      + '"tracks":[{"name":"v","packaging":"loc","selectionParams":{"bitrate":1e999}}]}';
    expectFiniteRejection(() => parseCatalogFormat01(bad));
  });

  it('rejects a patch that introduces an overflow number', () => {
    const raw = JSON.parse(JSON.stringify(BASE)) as Record<string, unknown>;
    // JSON Patch ops are supplied programmatically, so Infinity reaches the
    // post-patch normalizer directly.
    const ops = [{ op: 'replace', path: '/tracks/0/selectionParams/bitrate', value: Infinity }];
    expectFiniteRejection(() => applyCf01Patch(raw, ops));
  });

  it('accepts a finite CF-01 catalog', () => {
    expect(parseCatalogFormat01(JSON.stringify(BASE)).catalog.tracks[0]?.bitrate).toBe(1500000);
  });
});

// ─── Delta parse + apply ─────────────────────────────────────────────────

describe('parseDeltaUpdate / applyCatalogUpdate — finite-number guard', () => {
  function baseState(): CatalogState {
    return { version: 1, tracks: [{ name: 'audio', packaging: 'loc', isLive: true }] };
  }

  it('parseDeltaUpdate rejects an overflow generatedAt', () => {
    expectFiniteRejection(() =>
      parseDeltaUpdate('{"deltaUpdate":true,"generatedAt":1e999,"addTracks":[{"name":"v","packaging":"loc","isLive":true}]}'));
  });

  it('parseDeltaUpdate rejects an overflow added-track field', () => {
    expectFiniteRejection(() =>
      parseDeltaUpdate('{"deltaUpdate":true,"addTracks":[{"name":"v","packaging":"loc","isLive":true,"bitrate":2e308}]}'));
  });

  it('applyCatalogUpdate rejects a delta constructed with a non-finite field', () => {
    // A delta object built in code (not via parseDeltaUpdate) still must not
    // apply into a corrupt state.
    const delta: CatalogDelta = { deltaUpdate: true, generatedAt: Infinity };
    expectFiniteRejection(() => applyCatalogUpdate(baseState(), delta));
  });

  it('applies a finite delta', () => {
    const delta = parseDeltaUpdate('{"deltaUpdate":true,"generatedAt":42,"addTracks":[{"name":"v","packaging":"loc","isLive":true}]}');
    const next = applyCatalogUpdate(baseState(), delta, 'live.example.com/broadcast');
    expect(next.generatedAt).toBe(42);
    expect(next.tracks.map((t) => t.name)).toContain('v');
  });
});

// ─── Builder ─────────────────────────────────────────────────────────────

describe('buildCatalog — finite-number guard', () => {
  it('rejects a non-finite numeric field instead of serializing it as null', () => {
    expectFiniteRejection(() =>
      buildCatalog({ tracks: [{ name: 'v', packaging: 'loc', isLive: true, bitrate: Infinity }] }));
  });

  it('builds a finite catalog', () => {
    const json = new TextDecoder().decode(
      buildCatalog({ tracks: [{ name: 'v', packaging: 'loc', isLive: true, bitrate: 500 }] }));
    expect(JSON.parse(json).tracks[0].bitrate).toBe(500);
  });
});
