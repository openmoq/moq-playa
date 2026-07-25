/**
 * Red-first discrimination: prove the executable comparison actually catches a
 * WRONG expectation (the corpus tests aren't vacuously green). For one vector in
 * each executable family we corrupt its recorded expectation and assert the live
 * comparison fails.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { loadDomain } from './load-corpus.js';
import { runLocProperties, runLocSemantics } from './loc-exec.js';
import { runPropertyDecode } from './property-exec.js';
import { runCatalog } from './catalog-exec.js';
import { runBmff } from './bmff-exec.js';
import { comparePlaya } from './exec-compare.js';
import type { CorpusEntry, ExpectBlock, PropertyMapInput, WireProfile } from './schema-types.js';

function corruptSemantics(entry: CorpusEntry): CorpusEntry {
  const { differential: _drop, ...rest } = entry;
  return { ...rest, expect: { ...entry.expect, status: 'ok', stage: 'semantic', semantics: { __wrong__: 'sentinel' } } as ExpectBlock };
}

describe('discrimination — a wrong expectation is caught (per executable family)', () => {
  it('loc-properties: corrupted expect fails the comparison', () => {
    const v = loadDomain('loc').vectors.find((x) => x.entry.id === 'loc/props-audio-level')!;
    const actual = runLocProperties(v.bytes!, 'd16-delta-varint');
    expect(comparePlaya(v.entry, actual).ok).toBe(true); // sanity: real expect passes
    expect(comparePlaya(corruptSemantics(v.entry), actual).ok).toBe(false);
  });

  it('property-block-decode (Layer A): corrupted expect fails the comparison', () => {
    const v = loadDomain('properties').vectors.find((x) => x.entry.id === 'properties/equiv-64-d18')!;
    const run = runPropertyDecode(v.bytes!, v.entry.wireProfile as WireProfile);
    expect(comparePlaya(v.entry, run.result).ok).toBe(true);
    expect(comparePlaya(corruptSemantics(v.entry), run.result).ok).toBe(false);
  });

  it('loc-semantics (Layer B): corrupted expect fails the comparison', () => {
    const v = loadDomain('loc').vectors.find((x) => x.entry.id === 'loc/sem-all-four')!;
    const actual = runLocSemantics((v.entry.input as PropertyMapInput).propertyMap);
    expect(comparePlaya(v.entry, actual).ok).toBe(true);
    expect(comparePlaya(corruptSemantics(v.entry), actual).ok).toBe(false);
  });

  it('catalog: corrupted expect fails the comparison', () => {
    const v = loadDomain('catalog').vectors.find((x) => x.entry.id === 'catalog/msf00-minimal')!;
    const actual = runCatalog(new TextDecoder().decode(v.bytes!));
    expect(comparePlaya(v.entry, actual).ok).toBe(true);
    expect(comparePlaya(corruptSemantics(v.entry), actual).ok).toBe(false);
  });

  it('bmff: corrupted expect fails the comparison', () => {
    const v = loadDomain('bmff').vectors.find((x) => x.entry.id === 'bmff/frag-tfdt-v0')!;
    const actual = runBmff(v.bytes!, v.entry.operation!);
    expect(comparePlaya(v.entry, actual).ok).toBe(true);
    expect(comparePlaya(corruptSemantics(v.entry), actual).ok).toBe(false);
  });

  it('the wiring discriminates: the vi64 driver read with the QUIC (d16) profile mis-reads it', () => {
    // The revert-check, as a test: the promoted d18 driver passes under the
    // correct vi64 profile, and would FAIL under the older QUIC wiring — so the
    // fix genuinely discriminates rather than being vacuously green.
    const v = loadDomain('loc').vectors.find((x) => x.entry.id === 'loc/props-d18-ts-epoch-diverges')!;
    const correct = runLocProperties(v.bytes!, 'd18-delta-vi64');
    expect(comparePlaya(v.entry, correct).ok, 'production d18 path matches').toBe(true);
    const preFixWiring = runLocProperties(v.bytes!, 'd16-delta-varint');
    expect(comparePlaya(v.entry, preFixWiring).ok, 'QUIC wiring must NOT match the vi64 expectation').toBe(false);
  });
});
