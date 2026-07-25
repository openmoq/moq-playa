/**
 * MSF-01/CMSF-01 spec-derived corpus assertions. Proves every listed
 * normative requirement has a spec-derived vector (with the correct draft
 * provenance and expectation basis), that expected projections are independent
 * literals with wide integers as decimal strings, that reference / delta error
 * vectors discriminate, that Playa's current behavior is captured exactly, and
 * that capability status is profile-driven (never an accidental-match artifact).
 *
 * @module
 */
import { describe, it, expect } from 'vitest';
import { loadDomain } from './load-corpus.js';
import { executionCapability } from './capabilities.js';
import { normalizeCatalogVersion } from './libmoq-import.js';

const loaded = loadDomain('catalog');
const byId = new Map(loaded.vectors.map((v) => [v.entry.id, v.entry]));
const SPEC_VECTORS = loaded.vectors.map((v) => v.entry).filter((e) => /^catalog\/(msf01-|cmsf01-|msf00-numeric)/.test(e.id));

type Draft = 'msf-00' | 'msf-01' | 'cmsf-01';
interface Req { profile: string; kind: string; basis: string; status: 'ok' | 'error'; category?: string; draft: Draft; capability: 'executable' | 'forward-looking' }
// Capability: every MSF-01/CMSF-01 vector — catalog documents AND op-array
// deltas alike — is EXECUTABLE, i.e. production parses each one to the authored
// truth. Nothing here is forward-looking.
const REQUIREMENTS: Record<string, Req> = {
  // version & detection
  'catalog/msf01-version-string-one': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-version-draft': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-version-draft-99': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'invalid-version', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-version-draft-1': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'invalid-version', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-version-draft-00': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'invalid-version', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-version-draft-02': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'invalid-version', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-version-draft-abc': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'invalid-version', draft: 'msf-01', capability: 'executable' },
  'catalog/msf00-numeric-unchanged': { profile: 'msf-00', kind: 'catalog-parse', basis: 'normative', status: 'ok', draft: 'msf-00', capability: 'executable' },
  // MSF-01 semantics
  'catalog/msf01-vod-trackduration': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-depends': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-template-wide': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-initdata-initref': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-dangling-initref': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'dangling-init-ref', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-duplicate-initid': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'duplicate-init-ref', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-unknown-fields': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-mimetype-canonical': { profile: 'msf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  // CMSF-01 semantics
  'catalog/cmsf01-clear-cmaf': { profile: 'cmsf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'cmsf-01', capability: 'executable' },
  'catalog/cmsf01-simulcast-altgroup': { profile: 'cmsf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'cmsf-01', capability: 'executable' },
  'catalog/cmsf01-sap-eventtimeline': { profile: 'cmsf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'cmsf-01', capability: 'executable' },
  'catalog/cmsf01-content-protection': { profile: 'cmsf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'ok', draft: 'cmsf-01', capability: 'executable' },
  'catalog/cmsf01-dangling-protectionref': { profile: 'cmsf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'dangling-protection-ref', draft: 'cmsf-01', capability: 'executable' },
  'catalog/cmsf01-duplicate-protectionref': { profile: 'cmsf-01', kind: 'catalog-parse', basis: 'interpretation', status: 'error', category: 'duplicate-protection-ref', draft: 'cmsf-01', capability: 'executable' },
  // MSF-01 op-array deltas — executable via the op-array delta parser.
  'catalog/msf01-delta-add-clone': { profile: 'msf-01-delta', kind: 'catalog-delta-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-delta-remove': { profile: 'msf-01-delta', kind: 'catalog-delta-parse', basis: 'interpretation', status: 'ok', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-delta-unknown-op': { profile: 'msf-01-delta', kind: 'catalog-delta-parse', basis: 'interpretation', status: 'error', category: 'unknown-delta-op', draft: 'msf-01', capability: 'executable' },
  'catalog/msf01-delta-illegal-field': { profile: 'msf-01-delta', kind: 'catalog-delta-parse', basis: 'normative', status: 'error', category: 'illegal-delta-field', draft: 'msf-01', capability: 'executable' },
};
const DRAFT_SOURCE: Record<Draft, string> = { 'msf-00': 'draft-ietf-moq-msf-00', 'msf-01': 'draft-ietf-moq-msf-01', 'cmsf-01': 'draft-ietf-moq-cmsf-01' };

describe('spec vectors — every listed requirement has a spec-derived vector with correct provenance', () => {
  it('the exact set of 26 spec vectors is present (clone-before-add removed; 5 unsupported-version detectors)', () => {
    expect(new Set(SPEC_VECTORS.map((e) => e.id))).toEqual(new Set(Object.keys(REQUIREMENTS)));
    expect(SPEC_VECTORS.length).toBe(26);
  });

  for (const [id, want] of Object.entries(REQUIREMENTS)) {
    it(`${id}: ${want.status}, basis ${want.basis}, provenance ${DRAFT_SOURCE[want.draft]}`, () => {
      const e = byId.get(id)!;
      expect(e, id).toBeDefined();
      expect(e.profile).toBe(want.profile);
      expect(e.kind).toBe(want.kind);
      expect(e.expectationBasis).toBe(want.basis);
      expect(e.expect.status).toBe(want.status);
      if (want.category) expect(e.expect.error?.category).toBe(want.category);
      // Per-vector provenance: the numeric MSF-00 vector cites MSF-00, not -01.
      expect(e.provenance.class).toBe('spec-derived');
      expect(e.provenance.source).toBe(DRAFT_SOURCE[want.draft]);
    });
  }
});

describe('canonical draft-version normalization', () => {
  it('recognizes ONLY the draft-01 alias; canonical "1"/1 unchanged', () => {
    expect(normalizeCatalogVersion('draft-01')).toBe('1');
    expect(normalizeCatalogVersion('1')).toBe('1');
    expect(normalizeCatalogVersion(1)).toBe('1');
  });
  it('does NOT coerce other draft-N spellings to a numeric version (they are preserved, i.e. unsupported)', () => {
    for (const bad of ['draft-1', 'draft-00', 'draft-02', 'draft-99', 'draft-abc']) {
      expect(normalizeCatalogVersion(bad)).toBe(bad); // preserved, never mapped to a version number
    }
  });
  it('the draft-version vector projects catalogVersion "1" (agrees with the neutral probe/model)', () => {
    expect((byId.get('catalog/msf01-version-draft')!.expect.semantics as { catalogVersion: string }).catalogVersion).toBe('1');
  });
});

describe('independent literals; wide integers stay decimal strings', () => {
  it('the template wide wallclock anchor is the exact decimal STRING (never a JSON number)', () => {
    const t = (byId.get('catalog/msf01-template-wide')!.expect.semantics as { tracks: Array<Record<string, unknown>> }).tracks[0]!['template'];
    expect(t).toEqual(['0', '2002', ['0', '0'], ['1', '0'], '1759924158381', '2002']);
  });
  it('mimeType is canonical-only: the lowercase misspelling is dropped from the expect literal', () => {
    const tr = (byId.get('catalog/msf01-mimetype-canonical')!.expect.semantics as { tracks: Array<Record<string, unknown>> }).tracks[0]!;
    expect(tr['mimeType']).toBe('video/mp4');
    expect('mimetype' in tr).toBe(false);
  });
  it('depends preserves array content (not asserted as semantically ordered); the vector is self-contained', () => {
    const sem = byId.get('catalog/msf01-depends')!.expect.semantics as { tracks: Array<Record<string, unknown>> };
    const mt = sem.tracks.find((t) => t['name'] === 't')!;
    expect(mt['depends']).toEqual(['a', 'b']);
    expect(mt['mimeType']).toBe('application/json'); // §7.2 mandatory
    // the depended-upon tracks exist in the same catalog
    expect(sem.tracks.map((t) => t['name'])).toEqual(expect.arrayContaining(['a', 'b', 't']));
  });
  it('content-protection metadata is preserved (nested); no playback claim', () => {
    const sem = byId.get('catalog/cmsf01-content-protection')!.expect.semantics as { contentProtections: Array<Record<string, unknown>>; tracks: Array<Record<string, unknown>> };
    expect((sem.contentProtections[0]!['drmSystem'] as Record<string, unknown>)['systemID']).toBe('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
    expect(sem.tracks[0]!['initRef']).toBe('i1'); // otherwise-valid CMAF track (§3.1)
  });
});

describe('reference & delta error vectors discriminate', () => {
  const errorIds = Object.entries(REQUIREMENTS).filter(([, w]) => w.status === 'error').map(([id]) => id);

  it('the reference/delta error categories are all DISTINCT; the 5 version detectors share invalid-version', () => {
    const cats = errorIds.map((id) => byId.get(id)!.expect.error!.category);
    // The seven distinct intended categories are all present.
    expect(new Set(cats)).toEqual(new Set(['dangling-init-ref', 'duplicate-init-ref', 'dangling-protection-ref', 'duplicate-protection-ref', 'unknown-delta-op', 'illegal-delta-field', 'invalid-version']));
    // The six reference/delta faults are pairwise-distinct (each discriminates).
    const nonVersion = cats.filter((c) => c !== 'invalid-version');
    expect(new Set(nonVersion).size).toBe(nonVersion.length);
    expect(nonVersion.length).toBe(6);
    // The five version-rejection vectors deliberately share invalid-version.
    expect(cats.filter((c) => c === 'invalid-version').length).toBe(5);
  });

  it('EVERY error vector carries NO differential.playa (production categorizes them all correctly)', () => {
    // With the op-array delta parser, the delta error vectors (unknown-op,
    // illegal-field) join the reference/version error vectors as executable:
    // production throws the intended category, so no divergence is pinned.
    for (const id of errorIds) {
      expect(byId.get(id)!.differential?.['playa'], id).toBeUndefined();
    }
  });
});

describe('capability reflects the parser promotions; nothing forward-looking remains', () => {
  it('every spec vector\'s capability matches its declared capability', () => {
    for (const [id, want] of Object.entries(REQUIREMENTS)) {
      expect(executionCapability(byId.get(id)!).capability, id).toBe(want.capability);
    }
  });

  it('ALL five unsupported-version spellings reject with invalid-version and are now executable', () => {
    const drafts = ['draft-99', 'draft-1', 'draft-00', 'draft-02', 'draft-abc'];
    for (const d of drafts) {
      const e = byId.get(`catalog/msf01-version-${d}`)!;
      expect(e, d).toBeDefined();
      expect(e.expect.status).toBe('error');
      expect(e.expect.error?.category, d).toBe('invalid-version');
      // Production's MSF-01 profile genuinely rejects these versions — real
      // support, so no differential.playa and the vector is executable.
      expect(e.differential?.['playa'], d).toBeUndefined();
      expect(executionCapability(e).capability, d).toBe('executable');
    }
  });

  it('all 26 spec vectors are executable — zero forward-looking', () => {
    const caps = SPEC_VECTORS.map((e) => executionCapability(e).capability);
    expect(caps.filter((c) => c === 'executable').length).toBe(26);
    expect(caps.filter((c) => c === 'forward-looking').length).toBe(0);
  });

  it('the 4 MSF-01 op-array delta vectors are executable and carry no differential.playa', () => {
    const deltas = SPEC_VECTORS.filter((e) => e.kind === 'catalog-delta-parse');
    expect(new Set(deltas.map((e) => e.id))).toEqual(new Set([
      'catalog/msf01-delta-add-clone', 'catalog/msf01-delta-remove',
      'catalog/msf01-delta-unknown-op', 'catalog/msf01-delta-illegal-field',
    ]));
    for (const e of deltas) {
      expect(e.differential?.['playa'], e.id).toBeUndefined();
      expect(executionCapability(e).capability, e.id).toBe('executable');
    }
  });
});
