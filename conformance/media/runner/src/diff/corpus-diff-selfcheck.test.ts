/**
 * Self-tests for the differential lane's vector selection and comparison logic,
 * with NO probe: they use the corpus vectors' own authored `expect` /
 * `differential.libmoq.currentBehavior` as synthetic "normalized results" and
 * prove the comparison discriminates. Runs in the default `pnpm test`.
 */
import { describe, it, expect } from 'vitest';
import { selectDiffVectors, probeProfile, classifyCohort, SPEC_MSF01_DIFF_IDS } from './probe-client.js';
import { loadDomain } from '../load-corpus.js';
import { compareImpl, type ExecResult } from '../exec-compare.js';
import type { CorpusEntry, ExpectBlock } from '../schema-types.js';

const sem = (semantics: unknown): ExecResult => ({ status: 'ok', semantics });
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const vectors = selectDiffVectors();
const IMPORTS = vectors.filter((v) => v.cohort === 'libmoq-import');
const SPEC = vectors.filter((v) => v.cohort === 'spec-msf01-success');
const LIBMOQ_DIVERGENCES = ['catalog/libmoq-mediatimeline', 'catalog/msf01-mimetype-canonical'];

describe('differential lane — cohort membership & totals', () => {
  it('selects 28 vectors: 14 LibMoQ imports + 14 successful spec vectors', () => {
    expect(vectors.length).toBe(28);
    expect(IMPORTS.length).toBe(14);
    expect(SPEC.length).toBe(14);
  });

  it('the LibMoQ imports keep the 5/4/3/2 profile split', () => {
    const by = (p: string) => IMPORTS.filter((v) => v.entry.profile === p).length;
    expect({ 'msf-00': by('msf-00'), 'msf-01': by('msf-01'), 'cmsf-01': by('cmsf-01'), 'msf-01-delta': by('msf-01-delta') })
      .toEqual({ 'msf-00': 5, 'msf-01': 4, 'cmsf-01': 3, 'msf-01-delta': 2 });
  });

  it('the spec cohort is EXACTLY the 14-ID allowlist (set equality, not a prefix regex)', () => {
    expect(SPEC_MSF01_DIFF_IDS.size).toBe(14);
    expect(new Set(SPEC.map((v) => v.entry.id))).toEqual(new Set(SPEC_MSF01_DIFF_IDS));
    expect(SPEC.every((v) => v.entry.expect.status === 'ok')).toBe(true);
    // The allowlist covers every current successful msf01-/cmsf01- vector (no
    // accidental omission), and excludes error vectors + numeric MSF-00.
    const okSpec = loadDomain('catalog').vectors
      .filter((v) => /^catalog\/(msf01-|cmsf01-)/.test(v.entry.id) && v.entry.expect.status === 'ok')
      .map((v) => v.entry.id);
    expect(new Set(okSpec)).toEqual(new Set(SPEC_MSF01_DIFF_IDS));
    expect(SPEC_MSF01_DIFF_IDS.has('catalog/msf00-numeric-unchanged')).toBe(false);
    expect(SPEC_MSF01_DIFF_IDS.has('catalog/msf01-version-draft-99')).toBe(false); // error vector excluded
  });

  it('every vector is selected once with a deterministic id and correctly-mapped probe profile', () => {
    expect(new Set(vectors.map((v) => v.request.id)).size).toBe(28);
    for (const v of vectors) expect(v.request.id).toBe(v.entry.id);
    // the draft-version vector uses the probe's msf-01-draft profile
    const draft = vectors.find((v) => v.entry.id === 'catalog/msf01-version-draft')!;
    expect(draft.request.profile).toBe('msf-01-draft');
    // deltas map to msf-01 on catalog.delta.parse
    const delta = vectors.find((v) => v.entry.id === 'catalog/msf01-delta-add-clone')!;
    expect(delta.request.operation).toBe('catalog.delta.parse');
    expect(delta.request.profile).toBe('msf-01');
  });
});

describe('differential lane — selection discrimination', () => {
  const entry = (id: string): CorpusEntry => ({
    id, kind: 'catalog-parse', profile: 'msf-01', description: 'x',
    input: { file: 'x.json', byteLength: 0, sha256: '0'.repeat(64) },
    expect: { status: 'ok', stage: 'semantic', semantics: { catalogVersion: '1', tracks: [] } },
    expectationBasis: 'interpretation',
    provenance: { class: 'spec-derived', source: 'x', section: 'x', generator: 'x', generatorVersion: 'x', command: 'x', sourceHash: '0'.repeat(64) },
  } as CorpusEntry);

  it('classifyCohort uses the allowlist, not a prefix: a synthetic successful msf01-* entry gets NO cohort', () => {
    // A synthetic ok-status vector that WOULD match the old `msf01-`/`cmsf01-`
    // prefix regex. classifyCohort must return null (not a cohort) — proving that
    // reverting to a prefix classifier would fail this test.
    const future = entry('catalog/msf01-future-extra');
    expect(classifyCohort(future)).toBeNull();
    // An allowlisted id classifies as spec-msf01-success; an import as libmoq-import.
    expect(classifyCohort(entry([...SPEC_MSF01_DIFF_IDS][0]!))).toBe('spec-msf01-success');
    expect(classifyCohort(entry('catalog/libmoq-av-single'))).toBe('libmoq-import');
    // …and the synthetic vector never appears in the live selection.
    expect(selectDiffVectors().some((v) => v.entry.id === 'catalog/msf01-future-extra')).toBe(false);
  });

  it('draft routing is EXACT to draft-01; any other draft spelling is rejected, not routed', () => {
    expect(probeProfile(entry('x'), '{"version":"draft-01","tracks":[]}')).toBe('msf-01-draft');
    expect(probeProfile(entry('x'), '{"version":"1","tracks":[]}')).toBe('msf-01');
    for (const bad of ['draft-99', 'draft-1', 'draft-00', 'draft-02', 'draft-abc']) {
      expect(() => probeProfile(entry('x'), `{"version":"${bad}","tracks":[]}`)).toThrow(/unsupported draft version/);
    }
  });
});

describe('differential lane — comparison discriminates (key: libmoq)', () => {
  const get = (id: string) => vectors.find((v) => v.entry.id === id)!.entry;

  it('a conformant vector matches its canonical expect; a corrupted value fails', () => {
    const e = get('catalog/libmoq-av-single');
    expect(compareImpl(e, sem(e.expect.semantics), 'libmoq').ok).toBe(true);
    const corrupt = clone(e.expect.semantics) as { tracks: Array<Record<string, unknown>> };
    corrupt.tracks[0]!['bitrate'] = '999';
    expect(compareImpl(e, sem(corrupt), 'libmoq').ok).toBe(false);
  });

  it('reordered delta operations fail the comparison', () => {
    const e = get('catalog/msf01-delta-add-clone');
    expect(compareImpl(e, sem(e.expect.semantics), 'libmoq').ok).toBe(true);
    const reordered = clone(e.expect.semantics) as { deltaUpdate: unknown[] };
    reordered.deltaUpdate.reverse();
    expect(compareImpl(e, sem(reordered), 'libmoq').ok).toBe(false);
  });

  it('exactly two vectors carry a libmoq divergence (import mediatimeline + spec mimetype)', () => {
    const diverging = vectors.filter((v) => v.entry.differential?.['libmoq']).map((v) => v.entry.id).sort();
    expect(diverging).toEqual([...LIBMOQ_DIVERGENCES].sort());
  });

  for (const id of LIBMOQ_DIVERGENCES) {
    it(`${id}: pinned to currentBehavior; promotion + third-result guards fire`, () => {
      const e = get(id);
      const cur = (e.differential!['libmoq']!.currentBehavior as ExpectBlock).semantics;
      // matches the recorded LibMoQ divergence → ok
      expect(compareImpl(e, sem(cur), 'libmoq').ok).toBe(true);
      // if LibMoQ ever produced the canonical expect, the pin must FAIL (promotion)
      expect(compareImpl(e, sem(e.expect.semantics), 'libmoq').ok).toBe(false);
      // any third result also fails
      expect(compareImpl(e, sem({ catalogVersion: '1', tracks: [] }), 'libmoq').ok).toBe(false);
    });
  }

  it('the 26 non-diverging vectors match their canonical expect under the libmoq key', () => {
    const nonDiv = vectors.filter((v) => !v.entry.differential?.['libmoq']);
    expect(nonDiv.length).toBe(26);
    for (const v of nonDiv) expect(compareImpl(v.entry, sem(v.entry.expect.semantics), 'libmoq').ok, v.entry.id).toBe(true);
  });
});
