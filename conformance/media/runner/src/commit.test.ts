/**
 * Fault-injection for the corpus commit transaction, run against REAL temporary
 * directories (not an abstract presence set) with `renameSync` wrapped to fail
 * on a chosen call. Sentinel file CONTENT distinguishes the original tree from
 * the staged replacement, so the tests prove the ORIGINAL bytes come back after
 * a rollback — not merely that some file exists at the path.
 *
 * @module
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitCorpus, type FsOps, type CommitPaths } from './commit.js';

let base = '';
afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = ''; });

/** Lay out a real corpus: original tree/index + a staged temp tree/index, with
 *  sentinel content so identity is observable. Returns the paths. */
function setup(extra: { staleBak?: boolean } = {}): CommitPaths {
  base = mkdtempSync(join(tmpdir(), 'commit-'));
  const paths: CommitPaths = {
    vectors: join(base, 'v'), index: join(base, 'i'),
    vectorsTmp: join(base, 'v.tmp'), indexTmp: join(base, 'i.tmp'),
    vectorsBak: join(base, 'v.bak'), indexBak: join(base, 'i.bak'),
  };
  mkdirSync(paths.vectors, { recursive: true });
  writeFileSync(join(paths.vectors, 'marker.txt'), 'ORIGINAL');
  writeFileSync(paths.index, 'ORIGINAL_INDEX');
  mkdirSync(paths.vectorsTmp, { recursive: true });
  writeFileSync(join(paths.vectorsTmp, 'marker.txt'), 'STAGED');
  writeFileSync(paths.indexTmp, 'STAGED_INDEX');
  if (extra.staleBak) { mkdirSync(paths.vectorsBak, { recursive: true }); writeFileSync(join(paths.vectorsBak, 'marker.txt'), 'LEFTOVER'); }
  return paths;
}

/** Real fs ops, with `rename` wrapped to throw on the `failAt`-th call. */
function fsOps(failAt?: number): FsOps {
  let calls = 0;
  return {
    rename: (from, to) => { calls += 1; if (calls === failAt) throw new Error(`injected failure at rename #${calls}`); renameSync(from, to); },
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    exists: (p) => existsSync(p),
  };
}

const vectorsContent = (p: CommitPaths): string => readFileSync(join(p.vectors, 'marker.txt'), 'utf-8');
const noTempOrBak = (p: CommitPaths): void => {
  for (const path of [p.vectorsTmp, p.indexTmp, p.vectorsBak, p.indexBak]) expect(existsSync(path), path).toBe(false);
};

describe('commitCorpus — success installs the STAGED content', () => {
  it('the new tree + index replace the originals; backups/temps are gone', () => {
    const p = setup();
    commitCorpus(p, fsOps());
    expect(vectorsContent(p)).toBe('STAGED');
    expect(readFileSync(p.index, 'utf-8')).toBe('STAGED_INDEX');
    noTempOrBak(p);
  });
});

describe('commitCorpus — a failure at each rename restores the ORIGINAL content', () => {
  // 4 renames: (1) vectors→bak, (2) index→idxBak, (3) tmp→vectors, (4) idxTmp→index.
  for (let failAt = 1; failAt <= 4; failAt++) {
    it(`rename #${failAt} fails → ORIGINAL bytes restored, staged temp discarded`, () => {
      const p = setup();
      expect(() => commitCorpus(p, fsOps(failAt))).toThrow(/injected failure/);
      expect(existsSync(p.vectors), 'vectors dir present').toBe(true);
      expect(vectorsContent(p), 'vectors content is the ORIGINAL, not the staged replacement').toBe('ORIGINAL');
      expect(readFileSync(p.index, 'utf-8'), 'index content is the ORIGINAL').toBe('ORIGINAL_INDEX');
      noTempOrBak(p);
    });
  }
});

describe('commitCorpus — stale backup', () => {
  it('refuses loudly and touches nothing', () => {
    const p = setup({ staleBak: true });
    expect(() => commitCorpus(p, fsOps())).toThrow(/stale backup/);
    expect(vectorsContent(p)).toBe('ORIGINAL');
    expect(readFileSync(p.index, 'utf-8')).toBe('ORIGINAL_INDEX');
    expect(readFileSync(join(p.vectorsBak, 'marker.txt'), 'utf-8')).toBe('LEFTOVER'); // untouched
    expect(readFileSync(join(p.vectorsTmp, 'marker.txt'), 'utf-8')).toBe('STAGED'); // staged temp left for inspection
  });
});

// ─── provenance participates in the SAME transaction ───────────────────────

/** Lay out a 3-artifact corpus (vectors + index + provenance dir), sentinel-tagged. */
function setup3(extra: { staleProvBak?: boolean } = {}): CommitPaths {
  const base2 = setup();
  const p: CommitPaths = {
    ...base2,
    provenance: join(base, 'p'), provenanceTmp: join(base, 'p.tmp'), provenanceBak: join(base, 'p.bak'),
  };
  mkdirSync(p.provenance!, { recursive: true });
  writeFileSync(join(p.provenance!, 'prov.json'), 'ORIGINAL_PROV');
  mkdirSync(p.provenanceTmp!, { recursive: true });
  writeFileSync(join(p.provenanceTmp!, 'prov.json'), 'STAGED_PROV');
  if (extra.staleProvBak) { mkdirSync(p.provenanceBak!, { recursive: true }); writeFileSync(join(p.provenanceBak!, 'prov.json'), 'LEFTOVER_PROV'); }
  return p;
}
const provContent = (p: CommitPaths): string => readFileSync(join(p.provenance!, 'prov.json'), 'utf-8');
const noTempOrBak3 = (p: CommitPaths): void => {
  for (const path of [p.vectorsTmp, p.indexTmp, p.vectorsBak, p.indexBak, p.provenanceTmp!, p.provenanceBak!]) expect(existsSync(path), path).toBe(false);
};

describe('commitCorpus — provenance swaps atomically with vectors + index', () => {
  it('success installs the STAGED provenance alongside the vectors and index', () => {
    const p = setup3();
    commitCorpus(p, fsOps());
    expect(vectorsContent(p)).toBe('STAGED');
    expect(readFileSync(p.index, 'utf-8')).toBe('STAGED_INDEX');
    expect(provContent(p)).toBe('STAGED_PROV');
    noTempOrBak3(p);
  });

  // 6 renames: (1-3) vectors/index/prov → bak, (4-6) tmp → live for each.
  for (let failAt = 1; failAt <= 6; failAt++) {
    it(`rename #${failAt} fails → ORIGINAL vectors/index/provenance all restored`, () => {
      const p = setup3();
      expect(() => commitCorpus(p, fsOps(failAt))).toThrow(/injected failure/);
      expect(vectorsContent(p), 'vectors ORIGINAL').toBe('ORIGINAL');
      expect(readFileSync(p.index, 'utf-8'), 'index ORIGINAL').toBe('ORIGINAL_INDEX');
      expect(provContent(p), 'provenance ORIGINAL — never left stale/partial').toBe('ORIGINAL_PROV');
      noTempOrBak3(p);
    });
  }

  it('a stale provenance backup is refused loudly, touching nothing', () => {
    const p = setup3({ staleProvBak: true });
    expect(() => commitCorpus(p, fsOps())).toThrow(/stale backup/);
    expect(vectorsContent(p)).toBe('ORIGINAL');
    expect(provContent(p)).toBe('ORIGINAL_PROV');
    expect(readFileSync(join(p.provenanceBak!, 'prov.json'), 'utf-8')).toBe('LEFTOVER_PROV');
  });

  it('a PARTIAL provenance configuration is rejected (all-or-none), touching nothing', () => {
    const p = setup3();
    // Drop one of the three provenance paths → must refuse rather than silently
    // commit a two-artifact swap with stale provenance left behind.
    const { provenanceBak: _drop, ...partial } = p;
    expect(() => commitCorpus(partial as CommitPaths, fsOps())).toThrow(/partial provenance configuration/);
    expect(vectorsContent(p), 'vectors untouched').toBe('ORIGINAL');
    expect(provContent(p), 'provenance untouched').toBe('ORIGINAL_PROV');
    expect(existsSync(p.vectorsBak), 'no backup created').toBe(false);
  });
});
