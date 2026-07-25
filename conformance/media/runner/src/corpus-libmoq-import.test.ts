/**
 * LibMoQ MSF fixture import: accounting, provenance, and red-first
 * discrimination.
 *
 * These pin the import accounting: the MSF-01/CMSF-01
 * parser slice promoted the 7 later-era catalogs (4 MSF-01 + 3 CMSF-01) to
 * executable, leaving only the 2 MSF-01 op-array deltas forward-looking. (The
 * import audit had disproved the planned "13 + 1", landing at 5 + 9; the parser then
 * promoted the parseable catalogs.) They also prove the import is not vacuously
 * green: corrupting an expectation fails comparison, and tampering a source hash
 * fails the loader.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDomain, vectorsRoot } from './load-corpus.js';
import { executionCapability } from './capabilities.js';
import { runCatalog } from './catalog-exec.js';
import { comparePlaya } from './exec-compare.js';
import type { CorpusEntry, ExpectBlock, FileInput } from './schema-types.js';

interface ProvRow {
  fixture: string; sha256: string; corpusId: string; corpusFile: string;
  era: string; profile: string; capability: 'executable' | 'forward-looking';
  basis: string; section: string;
}
interface ProvDoc {
  source: { repo: string; commit: string; path: string };
  counts: { total: number; executable: number; forwardLooking: number; byProfile: Record<string, number> };
  fixtures: ProvRow[];
}

const PROV_PATH = join(vectorsRoot(), '..', 'provenance', 'libmoq-msf-fixtures.json');
const prov = JSON.parse(readFileSync(PROV_PATH, 'utf-8')) as ProvDoc;

const loaded = loadDomain('catalog');
const imported = loaded.vectors.filter((v) => v.entry.id.startsWith('catalog/libmoq-'));
const byId = new Map(imported.map((v) => [v.entry.id, v]));
const decoder = new TextDecoder();
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('LibMoQ import — pinned provenance authority', () => {
  it('pins the exact LibMoQ source commit and path', () => {
    expect(prov.source.commit).toBe('455318cade7445880a294e2ec6e6a5ccb67cb776');
    expect(prov.source.path).toBe('media/msf/tests/fixtures');
  });

  it('records all 14 fixtures exactly once (no duplicate fixture or corpus id)', () => {
    expect(prov.fixtures.length).toBe(14);
    expect(new Set(prov.fixtures.map((r) => r.fixture)).size).toBe(14);
    expect(new Set(prov.fixtures.map((r) => r.corpusId)).size).toBe(14);
  });

  it('declares the 14 executable / 0 forward-looking split (all fixtures promoted)', () => {
    expect(prov.counts).toMatchObject({ total: 14, executable: 14, forwardLooking: 0 });
    expect(prov.counts.byProfile).toEqual({ 'msf-00': 5, 'msf-01': 4, 'cmsf-01': 3, 'msf-01-delta': 2 });
  });
});

describe('LibMoQ import — every fixture accounted for exactly once in the manifest', () => {
  it('the provenance rows and the imported manifest entries are a bijection', () => {
    expect(imported.length).toBe(14);
    const provIds = new Set(prov.fixtures.map((r) => r.corpusId));
    const manifestIds = new Set(imported.map((v) => v.entry.id));
    expect(manifestIds).toEqual(provIds);
  });

  it('no imported vector file is orphaned or missing from the manifest', () => {
    const dir = join(vectorsRoot(), 'catalog');
    const onDisk = readdirSync(dir).filter((f) => f.startsWith('libmoq_') && f.endsWith('.json')).sort();
    const referenced = imported.map((v) => (v.entry.input as FileInput).file).sort();
    expect(onDisk).toEqual(referenced);
    expect(onDisk.length).toBe(14);
  });
});

describe('LibMoQ import — source hash matches provenance and preserved bytes', () => {
  for (const row of prov.fixtures) {
    it(`${row.corpusId}: sourceHash == input.sha256 == on-disk bytes (byte-exact)`, () => {
      const v = byId.get(row.corpusId)!;
      expect(v, `${row.corpusId} present`).toBeDefined();
      const fi = v.entry.input as FileInput;
      // Third-party provenance, and the pinned source hash flows through
      // unchanged to the manifest input hash (byte-exact preservation).
      expect(v.entry.provenance.class).toBe('third-party');
      expect(v.entry.provenance.sourceHash).toBe(row.sha256);
      expect(fi.sha256).toBe(row.sha256);
      // And the loader-verified on-disk bytes hash to the same value.
      expect(sha256(v.bytes!)).toBe(row.sha256);
    });
  }
});

describe('LibMoQ import — 14 executable vectors actually run and pass', () => {
  const execIds = prov.fixtures.filter((r) => r.capability === 'executable').map((r) => r.corpusId);

  it('there are exactly 14 (5 MSF-00 + 7 MSF-01/CMSF-01 catalogs + 2 op-array deltas)', () => expect(execIds.length).toBe(14));

  // The 5 MSF-00/CMSF-00 catalogs Playa parsed from the start: no differential.
  for (const id of ['catalog/libmoq-minimal', 'catalog/libmoq-empty-tracks', 'catalog/libmoq-with-init-data', 'catalog/libmoq-av-single', 'catalog/libmoq-unknown-fields']) {
    it(`${id} parses and matches its authored expect (no divergence)`, () => {
      const v = byId.get(id)!;
      expect(executionCapability(v.entry).capability).toBe('executable');
      // Playa matches the authored/regression expect → no differential recorded.
      expect(v.entry.differential).toBeUndefined();
      const cmp = comparePlaya(v.entry, runCatalog(decoder.decode(v.bytes!)));
      expect(cmp.ok, cmp.detail).toBe(true);
    });
  }

  // The 7 later-era catalogs the MSF-01/CMSF-01 parser promoted: executable, matching the
  // authored expect. differential.playa is dropped; an INDEPENDENT external pin
  // (differential.libmoq on mediatimeline) may remain and is not our concern here.
  for (const id of ['catalog/libmoq-vod', 'catalog/libmoq-template', 'catalog/libmoq-mediatimeline', 'catalog/libmoq-termination', 'catalog/libmoq-cmsf-clearkey', 'catalog/libmoq-cmsf-cmaf-simulcast', 'catalog/libmoq-cmsf-drm-cbcs']) {
    it(`${id} is promoted to executable and matches its authored expect`, () => {
      const v = byId.get(id)!;
      expect(executionCapability(v.entry).capability).toBe('executable');
      expect(v.entry.differential?.['playa'], `${id} has no playa divergence`).toBeUndefined();
      const cmp = comparePlaya(v.entry, runCatalog(decoder.decode(v.bytes!)));
      expect(cmp.ok, cmp.detail).toBe(true);
    });
  }

  // The 2 MSF-01 op-array delta docs the delta parser promoted: executable, matching
  // the authored ordered-operation projection, differential.playa dropped.
  for (const id of ['catalog/libmoq-delta-add-clone', 'catalog/libmoq-delta-remove']) {
    it(`${id} is promoted to executable and parses to its ordered operations`, () => {
      const v = byId.get(id)!;
      expect(executionCapability(v.entry).capability).toBe('executable');
      expect(v.entry.differential?.['playa'], `${id} has no playa divergence`).toBeUndefined();
      const cmp = comparePlaya(v.entry, runCatalog(decoder.decode(v.bytes!)));
      expect(cmp.ok, cmp.detail).toBe(true);
    });
  }
});

describe('LibMoQ import — the 2 MSF-01 delta docs are ordered-operation parses', () => {
  const deltas = imported.filter((v) => v.entry.profile === 'msf-01-delta');

  it('there are exactly 2, both executable delta-parse kind with SUCCESSFUL ordered operations', () => {
    expect(deltas.length).toBe(2);
    for (const v of deltas) {
      // MSF-01 deltas are valid behavior (§5.3): the intended result is a
      // successful ordered normalized-operation parse, and production now
      // produces it — executable, no divergence pinned.
      expect(v.entry.kind).toBe('catalog-delta-parse');
      expect(v.entry.expect.status).toBe('ok');
      expect(v.entry.differential?.['playa'], v.entry.id).toBeUndefined();
      expect(executionCapability(v.entry).capability).toBe('executable');
      const sem = v.entry.expect.semantics as { deltaUpdate: Array<{ op: string; tracks: unknown[] }> };
      expect(Array.isArray(sem.deltaUpdate)).toBe(true);
      expect(sem.deltaUpdate.length).toBeGreaterThan(0);
      // And the live production parse matches that authored ordered projection.
      const cmp = comparePlaya(v.entry, runCatalog(decoder.decode(v.bytes!)));
      expect(cmp.ok, cmp.detail).toBe(true);
    }
  });

  it('the add+clone delta parses to the exact ordered operations (§5.6.4)', () => {
    const sem = byId.get('catalog/libmoq-delta-add-clone')!.entry.expect.semantics as {
      generatedAt: string; deltaUpdate: Array<{ op: string; tracks: Array<Record<string, unknown>> }>;
    };
    expect(sem.generatedAt).toBe('1746104606044');
    expect(sem.deltaUpdate.map((o) => o.op)).toEqual(['add', 'clone']); // ORDER is normative
    expect(sem.deltaUpdate[0]!.tracks[0]).toMatchObject({ name: 'slides', bitrate: '750000', framerate: '15' });
    expect(sem.deltaUpdate[1]!.tracks[0]).toMatchObject({ parentName: 'video-1080', parentNamespace: 'example.com/custom', name: 'video-720', width: '1280' });
  });

  it('the remove delta parses to a single ordered remove naming two tracks (§5.6.5)', () => {
    const sem = byId.get('catalog/libmoq-delta-remove')!.entry.expect.semantics as {
      deltaUpdate: Array<{ op: string; tracks: Array<Record<string, unknown>> }>;
    };
    expect(sem.deltaUpdate.length).toBe(1);
    expect(sem.deltaUpdate[0]!.op).toBe('remove');
    expect(sem.deltaUpdate[0]!.tracks).toEqual([{ name: 'video' }, { name: 'slides' }]);
  });
});

describe('LibMoQ import — MSF-01/CMSF-01 oracles are COMPLETE (not core-identity)', () => {
  const sem = (id: string): Record<string, unknown> => byId.get(id)!.entry.expect.semantics as Record<string, unknown>;
  const track0 = (id: string): Record<string, unknown> => (sem(id)['tracks'] as Record<string, unknown>[])[0]!;

  it('VOD pins trackDuration, dimensions, and isLive:false (§5.2.35)', () => {
    const t = track0('catalog/libmoq-vod');
    expect(t).toMatchObject({ name: 'video', packaging: 'loc', isLive: false, trackDuration: '8072340', width: '1920', height: '1080', codec: 'av01.0.08M.10.0.110.09', bitrate: '1500000' });
    // Exact key set — a lossy parser dropping trackDuration would fail this.
    expect(new Set(Object.keys(t))).toEqual(new Set(['name', 'namespace', 'packaging', 'isLive', 'trackDuration', 'renderGroup', 'codec', 'width', 'height', 'framerate', 'bitrate']));
  });

  it('termination pins isComplete:true at the root (§5.1.3)', () => {
    expect(sem('catalog/libmoq-termination')).toMatchObject({ catalogVersion: '1', isComplete: true, tracks: [] });
  });

  it('the template array is normalized element-wise with the wide anchor as a decimal string (§5.2.15)', () => {
    const t = track0('catalog/libmoq-template');
    expect(t['template']).toEqual(['0', '2002', ['0', '0'], ['1', '0'], '1759924158381', '2002']);
  });

  it('mediatimeline keeps depends and DROPS the non-conforming "mimetype" typo (§5.2.14/§5.2.19)', () => {
    const t = track0('catalog/libmoq-mediatimeline');
    expect(t['depends']).toEqual(['1080p-video', 'audio']);
    expect('mimetype' in t).toBe(false);
    expect('mimeType' in t).toBe(false);
  });

  it('ClearKey pins the root contentProtections + initDataList and the track initRef/refIDs (CMSF §4)', () => {
    const s = sem('catalog/libmoq-cmsf-clearkey');
    expect(s['initDataList']).toEqual([{ id: 'init-video', type: 'inline', data: 'AAAB' }]);
    const cp = (s['contentProtections'] as Array<Record<string, unknown>>)[0]!;
    expect(cp).toMatchObject({ refID: '1', scheme: 'cenc' });
    expect((cp['drmSystem'] as Record<string, unknown>)['systemID']).toBe('1077efec-c0b2-4d02-ace3-3c1e52e2fb4b');
    expect(track0('catalog/libmoq-cmsf-clearkey')).toMatchObject({ initRef: 'init-video', contentProtectionRefIDs: ['1'] });
  });

  it('the cbcs DRM catalog pins all THREE protection systems (CMSF §5.2)', () => {
    const cps = sem('catalog/libmoq-cmsf-drm-cbcs')['contentProtections'] as Array<Record<string, unknown>>;
    expect(cps.length).toBe(3);
    expect(cps.map((c) => c['refID'])).toEqual(['1', '2', '3']);
    expect(cps.every((c) => c['scheme'] === 'cbcs')).toBe(true);
  });
});

describe('LibMoQ import — red-first discrimination', () => {
  function corrupt(entry: CorpusEntry): CorpusEntry {
    const { differential: _d, ...rest } = entry;
    return { ...rest, expect: { status: 'ok', stage: 'semantic', semantics: { __wrong__: 'sentinel' } } as ExpectBlock };
  }

  it('corrupting an executable import\'s expectation fails the comparison', () => {
    const v = byId.get('catalog/libmoq-av-single')!;
    const actual = runCatalog(decoder.decode(v.bytes!));
    expect(comparePlaya(v.entry, actual).ok).toBe(true); // sanity: real expect passes
    expect(comparePlaya(corrupt(v.entry), actual).ok).toBe(false);
  });

  it('corrupting a forward-looking import\'s currentBehavior fails the comparison', () => {
    const v = byId.get('catalog/libmoq-vod')!;
    const actual = runCatalog(decoder.decode(v.bytes!));
    expect(comparePlaya(v.entry, actual).ok).toBe(true);
    // Break the recorded currentBehavior → the live invalid-version no longer matches.
    const broken: CorpusEntry = {
      ...v.entry,
      differential: { playa: { status: 'unimplemented', reason: 'x', currentBehavior: { status: 'error', stage: 'semantic', error: { category: 'malformed-json' } } } },
    };
    expect(comparePlaya(broken, actual).ok).toBe(false);
  });

  it('tampering one imported entry\'s source hash makes the loader reject the corpus', () => {
    const srcCatalog = join(vectorsRoot(), 'catalog');
    const tmpRoot = mkdtempSync(join(tmpdir(), 'libmoq-corpus-'));
    try {
      const tmpCatalog = join(tmpRoot, 'catalog');
      cpSync(srcCatalog, tmpCatalog, { recursive: true });
      const manifestPath = join(tmpCatalog, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { vectors: CorpusEntry[] };
      const target = manifest.vectors.find((e) => e.id === 'catalog/libmoq-minimal')!;
      // Flip one hex digit of the pinned sha256.
      const s = (target.input as FileInput).sha256;
      (target.input as { sha256: string }).sha256 = (s[0] === '0' ? '1' : '0') + s.slice(1);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      expect(() => loadDomain('catalog', tmpRoot)).toThrow(/sha256 mismatch/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('LibMoQ import — re-authoring leaves no residue', () => {
  it('no temp/backup residue from the authoring transaction (vectors, index, AND provenance)', () => {
    const base = dirname(vectorsRoot());
    for (const p of ['vectors.tmp', 'vectors.bak', 'MANIFEST.json.tmp', 'MANIFEST.json.bak', 'provenance.tmp', 'provenance.bak']) {
      expect(readdirSync(base).includes(p), `no ${p}`).toBe(false);
    }
  });
});
