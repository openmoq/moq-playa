import { describe, it, expect } from 'vitest';
import { loadDomain } from './load-corpus.js';
import { executionCapability } from './capabilities.js';
import { runCatalog } from './catalog-exec.js';
import { comparePlaya } from './exec-compare.js';

const loaded = loadDomain('catalog');
const decoder = new TextDecoder();

describe('corpus/catalog — parseCatalogAuto', () => {
  it('has the expected number of catalog vectors', () => {
    // 15 spec-authored + 14 LibMoQ imports + 26 MSF-01/CMSF-01 spec-derived.
    expect(loaded.vectors.length).toBe(55);
  });

  // Every vector runs against production. Executable vectors must match their
  // authored `expect`; forward-looking imports (Playa has no MSF-01/CMSF-01
  // parser) must match their recorded `currentBehavior` and still differ from
  // `expect` — both handled by comparePlaya.
  for (const { entry, bytes } of loaded.vectors) {
    it(`${entry.id}`, () => {
      // Independent catalogs use catalog-parse; MSF-01 delta documents use the
      // distinct catalog-delta-parse kind. Both execute against parseCatalogAuto
      // today (delta docs pin their current invalid-version via currentBehavior).
      expect(['catalog-parse', 'catalog-delta-parse']).toContain(entry.kind);
      const json = decoder.decode(bytes!);
      const actual = runCatalog(json);
      const cmp = comparePlaya(entry, actual);
      expect(cmp.ok, cmp.detail).toBe(true);
    });
  }

  it('capability split: all 55 executable, 0 forward-looking (no silent skips)', () => {
    const caps = loaded.vectors.map((v) => executionCapability(v.entry).capability);
    // The MSF-01/CMSF-01 parser promoted every later-era catalog-parse vector,
    // and the op-array delta parser promoted the last 6 delta vectors. The
    // entire catalog domain is now executable against production.
    expect(caps.filter((c) => c === "executable").length).toBe(55);
    expect(caps.filter((c) => c === "forward-looking").length).toBe(0);
    // Nothing else — no pending/retired hiding in the catalog domain.
    expect(caps.every((c) => c === 'executable')).toBe(true);
  });
});
