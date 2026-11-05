import { describe, expect, it } from 'vitest';
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTailCampaignArgs, validateTailManifest, assertTailManifest, isTailHarnessFile, isTailSupportFile,
  copyTailTestFiles, checkTailTestGraph } from './group-tail-cli.mjs';

const hash = 'a'.repeat(64);
describe('standalone tail campaign arguments (pure validation)', () => {
  it('requires an explicit baseline and supplies no HEAD fallback', () => {
    expect(() => parseTailCampaignArgs([])).toThrow('--original-ref');
    expect(() => parseTailCampaignArgs(['--artifacts', '/tmp/tail'])).toThrow('--original-ref');
    expect(parseTailCampaignArgs(['--original-ref', 'v0.6.1', '--artifacts', '/tmp/tail'])).toEqual({ originalRef: 'v0.6.1', artifacts: '/tmp/tail' });
  });
  it.each(['--production-id', '--production-manifest', '--unknown'])('rejects unsupported option %s before any orchestration', option => {
    expect(() => parseTailCampaignArgs(['--original-ref', 'baseline', option, 'value'])).toThrow('Unknown');
  });
  it('rejects missing values and duplicate options', () => {
    expect(() => parseTailCampaignArgs(['--original-ref'])).toThrow('requires a value');
    expect(() => parseTailCampaignArgs(['--original-ref', '--artifacts', '/tmp/tail'])).toThrow('requires a value');
    expect(() => parseTailCampaignArgs(['--original-ref', 'one', '--original-ref', 'two'])).toThrow('Duplicate');
  });
  it('permits explicit optional donor and expected-manifest paths', () => {
    expect(parseTailCampaignArgs(['--original-ref', 'abc123', '--native-donor', '/offline/install', '--expected-manifest', '/tmp/joint-before.json']))
      .toEqual({ originalRef: 'abc123', nativeDonor: '/offline/install', expectedManifest: '/tmp/joint-before.json' });
  });
});
describe('generic expected source manifests', () => {
  it('accepts the campaign row format and compares canonical file identities', () => {
    const rows = [{ path: 'packages/player/src/player.ts', sha256: hash.toUpperCase() }, { path: 'old.ts', deleted: true }];
    expect(validateTailManifest(rows)).toEqual([{ path: 'old.ts', deleted: true }, { path: 'packages/player/src/player.ts', sha256: hash }]);
    expect(() => assertTailManifest(rows, [...rows].reverse())).not.toThrow();
  });
  it('refuses unknown or mismatching expected hashes and files', () => {
    expect(() => assertTailManifest([{ path: 'a.ts', sha256: hash }], [{ path: 'a.ts', sha256: 'b'.repeat(64) }])).toThrow('does not match');
    expect(() => assertTailManifest([{ path: 'unknown.ts', sha256: hash }], [{ path: 'a.ts', sha256: hash }])).toThrow('does not match');
    expect(() => validateTailManifest([{ path: 'a.ts', sha256: 'unknown' }])).toThrow('Invalid SHA-256');
  });
  it('rejects non-row wrapper formats, duplicate paths, and paths outside the source tree', () => {
    expect(() => validateTailManifest({ files: { 'a.ts': hash } })).toThrow('array');
    expect(() => validateTailManifest([{ path: 'a.ts', sha256: hash }, { path: 'a.ts', sha256: hash }])).toThrow('Duplicate');
    expect(() => validateTailManifest([{ path: '../a.ts', sha256: hash }])).toThrow('file path');
  });
});
describe('baseline test-support overlay boundary', () => {
  it('retains the tail harness as a separate identity', () => {
    for (const path of ['examples/_tests/player-acceptance/main.ts', 'scripts/player-acceptance/run.mjs',
      'scripts/player-acceptance/group-tail.mjs', 'scripts/player-acceptance/group-tail.d.mts', 'scripts/player-acceptance/group-tail.test.ts']) {
      expect(isTailHarnessFile(path)).toBe(true); expect(isTailSupportFile(path)).toBe(false);
    }
  });
  it('includes shared selection helpers and page support absent from an older baseline', () => {
    for (const path of ['scripts/player-acceptance/program-switch.mjs', 'scripts/player-acceptance/mse-program-switch.mjs',
      'scripts/player-acceptance/view-choice.mjs', 'examples/_tests/player-acceptance/native-mse.ts',
      'scripts/player-acceptance/support/selection-wire.mjs',
      'examples/_tests/player-acceptance/index.html']) {
      expect(isTailSupportFile(path)).toBe(true); expect(isTailHarnessFile(path)).toBe(false);
    }
  });
  it('never overlays production, publisher code, another example or root configuration', () => {
    for (const path of ['packages/player/src/player.ts', 'packages/browser/src/mp4-box.ts', 'examples/node-publisher/src/fixture.ts',
      'examples/player/main.ts', 'package.json', 'scripts/other.mjs']) {
      expect(isTailSupportFile(path)).toBe(false); expect(isTailHarnessFile(path)).toBe(false);
    }
  });
  it('rejects an attempted production overlay before any copy', async () => {
    await expect(copyTailTestFiles('/unused/source', '/unused/target', [{ path: 'packages/player/src/player.ts', sha256: hash }]))
      .rejects.toThrow('Not an acceptance test overlay');
  });
  it('rejects missing shared support then loads a source-only real-package dependency fixture without Git history', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const scratch = await mkdtemp(join(tmpdir(), 'playa-tail-source-only-'));
    const original = join(scratch, 'source');
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const walk = async (directory: string): Promise<string[]> => {
      const paths: string[] = [];
      for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) paths.push(...await walk(path));
        else if (entry.isFile()) paths.push(path);
      }
      return paths;
    };
    try {
      await mkdir(original);
      const paths = [...await walk('examples/_tests/player-acceptance'), ...await walk('scripts/player-acceptance')].sort();
      const rows = await Promise.all(paths.map(async path => ({ path,
        sha256: digest(await readFile(join(root, path))) })));
      const actual = await checkTailTestGraph(root, rows);
      const packageFiles = new Set(actual.inputs.filter(path => path.startsWith('packages/')));
      for (const path of [...packageFiles]) {
        const name = path.split('/')[1];
        if (!name) throw new Error(`Invalid package source input: ${path}`);
        packageFiles.add(`packages/${name}/package.json`);
      }
      const production = await Promise.all([...packageFiles].sort().map(async path => {
        const bytes = await readFile(join(root, path));
        await mkdir(dirname(join(original, path)), { recursive: true });
        await copyFile(join(root, path), join(original, path));
        expect(digest(await readFile(join(original, path)))).toBe(digest(bytes));
        return { path, sha256: digest(bytes) };
      }));
      expect(production.some(row => row.path.endsWith('.test.ts'))).toBe(false);
      expect(production.some(row => row.path === 'packages/player/src/player.ts')).toBe(true);
      const missing = 'scripts/player-acceptance/program-switch-observer.mjs';
      const beforeSupport = rows.filter(row => row.path !== missing);
      await copyTailTestFiles(root, original, beforeSupport);
      await expect(access(join(original, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(original, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(original, missing))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(checkTailTestGraph(original, beforeSupport)).rejects.toThrow(/Could not resolve[^\n]*program-switch-observer\.mjs/);
      const copied = await copyTailTestFiles(root, original, rows);
      expect(copied).toHaveLength(rows.length);
      const graph = await checkTailTestGraph(original, rows);
      expect(graph.pageLinked).toBe(true); expect(graph.runnerLinked).toBe(true);
      expect(graph.helperModulesLoaded).toHaveLength(6);
      expect(graph.inputs).toContain('packages/player/src/player.ts');
      expect(graph.inputs).toContain('scripts/player-acceptance/mse-program-switch-observer.mjs');
      expect(graph.publicEntries['@openmoq/browser']?.path).toBe('packages/browser/src/index.ts');
      expect(graph.publicEntries).toEqual(actual.publicEntries);
      for (const row of production) expect(digest(await readFile(join(original, row.path)))).toBe(row.sha256);
      console.info(JSON.stringify({ fixture: 'source-only real-package closure', productionFiles: production.length,
        acceptanceFiles: rows.length, pageLinked: graph.pageLinked,
        runnerLinked: graph.runnerLinked, helperModulesLoaded: graph.helperModulesLoaded,
        publicEntries: graph.publicEntries, productionClosureUnchanged: true }));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }, 60000);
});
