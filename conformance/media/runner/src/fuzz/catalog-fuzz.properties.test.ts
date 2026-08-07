/**
 * Catalog crash-fuzz through `parseCatalogAuto` — arbitrary structured JSON,
 * catalog-shaped JSON with edge fields, malformed/truncated JSON, and arbitrary
 * UTF-8 decoded from random bytes.
 *
 * Contract: the parser may reject only with a native `SyntaxError` (JSON.parse)
 * or an INTENTIONAL base `Error` (spec-cited validation). A TypeError /
 * ReferenceError is a bug — even though it extends Error, so the oracle requires
 * the exact `Error` constructor (never whitelists a subclass). On success the
 * result is a catalog with an array of structurally-valid normalized tracks, and
 * re-parsing yields the same projection.
 *
 * Env knobs: FC_RUNS (default 200), FC_SEED.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { parseCatalogAuto, type Catalog, type CatalogTrack } from '@moqt/msf';
import { catalogProjection } from '../catalog-exec.js';
import { fc, fcParams, catalogFuzzInput, catalogFuzzBytes, toHex, describeText, expectParserSafe, allowCatalogError, assertJsonSafe, assertNoMutation } from './media-fuzz.js';

const PACKAGINGS = new Set(['loc', 'cmaf', 'mediatimeline', 'eventtimeline']);

/** Assert the structural invariants of a successfully-parsed Catalog. */
function assertCatalogShape(label: string, cat: Catalog, inputRepr: string): void {
  expect(typeof cat.version, `${label}: version is number`).toBe('number');
  expect(Number.isFinite(cat.version), `${label}: version finite`).toBe(true);
  // Catalog-level numeric fields must also be finite (generatedAt from a JSON
  // overflow exponent would be Infinity).
  if (cat.generatedAt !== undefined) {
    expect(Number.isFinite(cat.generatedAt), `${label}: generatedAt finite (got ${String(cat.generatedAt)})`).toBe(true);
  }
  expect(Array.isArray(cat.tracks), `${label}: tracks is array`).toBe(true);
  for (const t of cat.tracks) {
    expect(typeof t.name, `${label}: track.name string`).toBe('string');
    expect(typeof t.isLive, `${label}: track.isLive boolean`).toBe('boolean');
    expect(PACKAGINGS.has(t.packaging), `${label}: track.packaging is a known value (${t.packaging})`).toBe(true);
    // Optional numeric fields, when present, must be finite (no NaN/Infinity from
    // a JSON number like 1e999).
    for (const [k, v] of Object.entries(t)) {
      if (typeof v === 'number') {
        expect(Number.isFinite(v), `${label}: track.${k} is finite (got ${String(v)})`).toBe(true);
      }
    }
  }
  // The manifest projection must be JSON-safe (no NaN/Infinity, serialisable).
  assertJsonSafe(label, catalogProjection(cat), inputRepr);
}

describe('Catalog crash fuzz — parseCatalogAuto', () => {
  it('is crash-safe (SyntaxError/base Error only), returns valid tracks, deterministic', () => {
    fc.assert(
      fc.property(catalogFuzzInput, (json) => {
        const repr = describeText(json);
        const r = expectParserSafe('parseCatalogAuto', repr, allowCatalogError, () => parseCatalogAuto(json));
        if (r.ok) {
          assertCatalogShape('parseCatalogAuto', r.value, repr);
          const again = parseCatalogAuto(json);
          expect(catalogProjection(again)).toEqual(catalogProjection(r.value));
        }
      }),
      fcParams(),
    );
  });

  it('with an explicit catalog namespace is equally crash-safe', () => {
    fc.assert(
      fc.property(catalogFuzzInput, fc.string({ maxLength: 24 }), (json, ns) => {
        const repr = describeText(json);
        const r = expectParserSafe('parseCatalogAuto(ns)', repr, allowCatalogError, () => parseCatalogAuto(json, ns));
        if (r.ok) assertCatalogShape('parseCatalogAuto(ns)', r.value, repr);
      }),
      fcParams(),
    );
  });

  it('the Uint8Array entrypoint (± namespace) is crash-safe, returns valid tracks, and does not mutate input', () => {
    fc.assert(
      fc.property(catalogFuzzBytes, fc.option(fc.string({ maxLength: 24 }), { nil: undefined }), (bytes, ns) => {
        const repr = `0x${toHex(bytes)}`;
        const before = bytes.slice();
        const r = expectParserSafe('parseCatalogAuto(bytes)', repr, allowCatalogError,
          () => (ns !== undefined ? parseCatalogAuto(bytes, ns) : parseCatalogAuto(bytes)));
        // The byte entrypoint must not mutate the caller's buffer, whether it
        // succeeds or rejects.
        assertNoMutation('parseCatalogAuto(bytes)', before, bytes, repr);
        if (r.ok) {
          assertCatalogShape('parseCatalogAuto(bytes)', r.value, repr);
          const again = ns !== undefined ? parseCatalogAuto(bytes, ns) : parseCatalogAuto(bytes);
          expect(catalogProjection(again)).toEqual(catalogProjection(r.value));
        }
      }),
      fcParams(),
    );
  });

  it('accepts a valid catalog whose track is literally named "NaN" (not treated as numeric corruption)', () => {
    const json = JSON.stringify({ version: 1, tracks: [{ name: 'NaN', packaging: 'loc', isLive: true, codec: 'Infinity' }] });
    const cat = parseCatalogAuto(json);
    expect(cat.tracks.map((t) => t.name)).toEqual(['NaN']);
    // The projection is accepted — a "NaN" string field is valid data.
    expect(() => assertCatalogShape('parseCatalogAuto', cat, describeText(json))).not.toThrow();
  });

  it('REJECTS an overflow-exponent numeric field (1e999 → Infinity) with a base Error', () => {
    // JSON literal 1e999 parses to Infinity; a catalog must not carry it.
    expect(() => parseCatalogAuto('{"version":1,"generatedAt":1e999,"tracks":[{"name":"v","packaging":"loc","isLive":true}]}'))
      .toThrow(/finite number/);
    expect(() => parseCatalogAuto('{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"bitrate":1e999}]}'))
      .toThrow(/finite number/);
    // and the thrown error is a base Error (the fuzz oracle's allowed class).
    try { parseCatalogAuto('{"version":1,"tracks":[{"name":"v","packaging":"loc","isLive":true,"width":1e400}]}'); }
    catch (e) { expect(e instanceof Error && e.constructor === Error).toBe(true); }
  });

  it('projects the previously-omitted normalized fields (displayWidth/Height, depends, temporal/spatialId)', () => {
    const json = JSON.stringify({
      version: 1,
      tracks: [{
        name: 'v', packaging: 'loc', isLive: true,
        displayWidth: 1920, displayHeight: 1080, depends: ['a', 'b'], temporalId: 1, spatialId: 0,
      }],
    });
    const proj = catalogProjection(parseCatalogAuto(json)) as { tracks: Record<string, unknown>[] };
    const t = proj.tracks[0]!;
    expect(t['displayWidth']).toBe('1920');
    expect(t['displayHeight']).toBe('1080');
    expect(t['depends']).toEqual(['a', 'b']);
    expect(t['temporalId']).toBe('1');
    expect(t['spatialId']).toBe('0');
  });

  it('catalogProjection projects EVERY normalized CatalogTrack field (complete-field coverage)', () => {
    // `satisfies Required<CatalogTrack>` forces EVERY current field to be present
    // — a future CatalogTrack field is a COMPILE error here until it is both set
    // in this fixture and projected. Fields that individually conflict at parse
    // time (targetLatency vs trackDuration, eventType) are fine here because this
    // projects a hand-built track, not a parsed one.
    const track = {
      name: 'n', packaging: 'loc', isLive: true, namespace: 'ns', role: 'video',
      renderGroup: 1, altGroup: 2, codec: 'av01', mimeType: 'video/mp4',
      framerate: 30, timescale: 90000, bitrate: 1_000_000, width: 1920, height: 1080,
      samplerate: 48000, channelConfig: '2', displayWidth: 1920, displayHeight: 1080,
      lang: 'en', label: 'Main', initData: 'AAAA', initTrack: 'init',
      depends: ['x'], temporalId: 1, spatialId: 0, targetLatency: 200, trackDuration: 5000,
      eventType: 'sap', parentName: 'base', parentNamespace: 'base-ns', maxGrpSapStartingType: 1, maxObjSapStartingType: 2,
      // MSF-01 / CMSF-01: template carried in its canonical 6-tuple wire shape.
      initRef: 'i1', template: [0, 2002, [0, 0], [1, 0], 1759924158381, 2002], contentProtectionRefIDs: ['1'],
    } satisfies Required<CatalogTrack>;
    const cat: Catalog = { version: 1, generatedAt: 1700000000, isComplete: true, tracks: [track] };

    const proj = catalogProjection(cat) as { tracks: Record<string, unknown>[] };
    const t = proj.tracks[0]!;
    // The projected key set must exactly match the CatalogTrack field set, with
    // no fields silently dropped or accidentally added.
    expect(Object.keys(t).sort()).toEqual(Object.keys(track).sort());
    // A spot-check of the string-rendered numerics and the array field.
    expect(t['displayWidth']).toBe('1920');
    expect(t['depends']).toEqual(['x']);
    expect(t['trackDuration']).toBe('5000');
    expect(t['eventType']).toBe('sap');
  });
});
