import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, 'order-release-tarballs.mjs');
type Manifest = { name: string; version: string; dependencies?: Record<string, string> };

function tarballs(directory: string, packages: Manifest[]): string[] {
  mkdirSync(join(directory, 'release'), { recursive: true });
  return packages.map((manifest, index) => {
    const source = join(directory, `source-${index}`);
    mkdirSync(join(source, 'package'), { recursive: true });
    writeFileSync(join(source, 'package/package.json'), JSON.stringify(manifest));
    const path = join(directory, 'release', `${index}.tgz`);
    execFileSync('tar', ['-czf', path, '-C', source, 'package']);
    return path;
  });
}

function order(packages: Manifest[]): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'moq-publish-order-'));
  try {
    const paths = tarballs(directory, packages);
    return execFileSync(process.execPath, [script, ...paths], { encoding: 'utf8', stdio: 'pipe' })
      .trim().split('\n').map((path) => packages[paths.indexOf(path)]!.name);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('release publication order', () => {
  it.each([
    'healthy', 'system bash', 'node version manager shim', 'publish fails', 'dependency unavailable',
    'metadata delayed', 'tarball delayed', 'already published',
    'last tarball unavailable', 'download forbidden', 'wrong download version',
    'download timeout', 'download hangs',
  ] as const)('publishes dependencies before wrappers: %s', (condition) => {
    const directory = mkdtempSync(join(tmpdir(), 'moq-publish-workflow-'));
    try {
      tarballs(directory, [
        { name: '@moqt/browser', version: '1.0.0', dependencies: { '@openmoq/browser': '1.0.0' } },
        { name: '@openmoq/browser', version: '1.0.0', dependencies: { '@openmoq/transport': '1.0.0' } },
        { name: '@openmoq/transport', version: '1.0.0' },
      ]);
      mkdirSync(join(directory, 'scripts'));
      copyFileSync(script, join(directory, 'scripts/order-release-tarballs.mjs'));
      const waitScript = resolve(import.meta.dirname, 'wait-for-npm-package.mjs');
      if (existsSync(waitScript)) copyFileSync(waitScript, join(directory, 'scripts/wait-for-npm-package.mjs'));
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      // Version-manager shims can rewrite PATH and bypass the fixture's npm.
      writeFileSync(join(bin, 'node'), `#!/bin/sh
exec ${shellQuote(process.execPath)} "$@"
`, { mode: 0o755 });
      const shimBin = join(directory, 'node-shim');
      if (condition === 'node version manager shim') {
        const poisonBin = join(directory, 'poison-npm');
        mkdirSync(shimBin);
        mkdirSync(poisonBin);
        writeFileSync(join(poisonBin, 'npm'), `#!/bin/sh
printf '%s\\n' '{"error":{"code":"ENODE_SHIM_BYPASS"}}'
exit 1
`, { mode: 0o755 });
        writeFileSync(join(shimBin, 'node'), `#!/bin/sh
PATH=${shellQuote(poisonBin)}:"$PATH"
export PATH
exec ${shellQuote(process.execPath)} "$@"
`, { mode: 0o755 });
      }
      const log = join(directory, 'published.jsonl');
      const downloads = join(directory, 'downloads.jsonl');
      writeFileSync(join(bin, 'npm'), `#!${process.execPath}
        const fs = require('node:fs');
        const { execFileSync } = require('node:child_process');
        const args = process.argv.slice(2);
        const downloads = fs.existsSync(${JSON.stringify(downloads)})
          ? fs.readFileSync(${JSON.stringify(downloads)}, 'utf8').trim().split('\\n').map(JSON.parse) : [];
        function fail(code) {
          process.stdout.write(JSON.stringify({ error: { code, summary: 'induced failure' } }));
          process.exit(1);
        }
        if (args[0] === 'view') {
          if (${condition === 'dependency unavailable'} && args[1] === '@openmoq/browser@1.0.0') process.exit(1);
          if (${condition === 'metadata delayed'} && args[1] === '@openmoq/transport@1.0.0' && downloads.length === 0) fail('E404');
          process.stdout.write(args[2] === 'versions' ? ${JSON.stringify(condition === 'already published' ? '["1.0.0"]' : '[]')} : '1.0.0');
        } else if (args[0] === 'pack') {
          const spec = args[1];
          if (!args.includes('--ignore-scripts') || !args.includes('--registry=https://registry.npmjs.org/')
            || !args.includes('--cache') || !args.includes('--fetch-retries=0')) fail('EUNSAFEPACK');
          fs.appendFileSync(${JSON.stringify(downloads)}, JSON.stringify(spec) + '\\n');
          const timeouts = ['FETCH_ERROR', 'ECONNECTIONTIMEOUT', 'EIDLETIMEOUT', 'ERESPONSETIMEOUT', 'ETRANSFERTIMEOUT'];
          if (${condition === 'download timeout'} && downloads.length < timeouts.length) fail(timeouts[downloads.length]);
          if (${condition === 'download hangs'}) {
            setTimeout(() => process.exit(1), 60_000);
            return;
          }
          if (${condition === 'download forbidden'}) fail('E403');
          if (${condition === 'dependency unavailable'} && spec === '@openmoq/browser@1.0.0') fail('E404');
          if (${condition === 'last tarball unavailable'} && spec === '@moqt/browser@1.0.0') fail('E404');
          if (${['metadata delayed', 'tarball delayed', 'already published'].includes(condition)} && spec === '@openmoq/transport@1.0.0'
            && downloads.filter(s => s === spec).length < 2) fail('E404');
          const at = spec.lastIndexOf('@');
          process.stdout.write(JSON.stringify([{ name: spec.slice(0, at), version: ${condition === 'wrong download version'} ? '0.9.0' : spec.slice(at + 1) }]));
        } else if (args[0] === 'publish') {
          const pkg = JSON.parse(execFileSync('tar', ['-xOzf', args[1].slice(5), 'package/package.json'], { encoding: 'utf8' }));
          fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(pkg.name) + '\\n');
          if (${condition === 'publish fails'} && pkg.name === '@openmoq/browser') process.exit(1);
        } else process.exit(99);
      `, { mode: 0o755 });
      const workflow = readFileSync(resolve(import.meta.dirname, '../.github/workflows/publish.yml'), 'utf8');
      const step = workflow.match(/- name: Publish to npm\n\s+run: \|\n([\s\S]*)$/)?.[1];
      expect(step).toBeDefined();
      const run = () => execFileSync(condition === 'system bash' ? '/bin/bash' : 'bash', ['-c', step!.replace(/^          /gm, '')], {
        cwd: directory,
        env: { ...process.env, PATH: `${bin}:${condition === 'node version manager shim' ? `${shimBin}:` : ''}${process.env.PATH}`,
          NPM_PACKAGE_WAIT_MS: ['dependency unavailable', 'last tarball unavailable', 'download hangs'].includes(condition) ? '3000' : '30000',
          NPM_PACKAGE_POLL_MS: '1' },
        stdio: 'pipe', timeout: 60_000,
      });
      const failure = ['publish fails', 'dependency unavailable', 'last tarball unavailable', 'download forbidden', 'wrong download version', 'download hangs'].includes(condition);
      let caught: unknown;
      const started = performance.now();
      if (failure) {
        try { run(); } catch (error) { caught = error; }
        expect(caught).toBeDefined();
      } else run();
      if (['dependency unavailable', 'last tarball unavailable', 'download hangs'].includes(condition)) {
        expect(caught).toMatchObject({ status: 1, signal: null });
        expect((caught as { stderr: Buffer }).stderr.toString()).toContain('Timed out after 3000ms waiting for');
        expect(performance.now() - started).toBeLessThan(30_000);
      }
      const published = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
      const expected = condition === 'already published' ? []
        : ['download forbidden', 'wrong download version', 'download hangs'].includes(condition) ? ['@openmoq/transport']
        : ['publish fails', 'dependency unavailable'].includes(condition) ? ['@openmoq/transport', '@openmoq/browser']
        : ['@openmoq/transport', '@openmoq/browser', '@moqt/browser'];
      expect(published).toEqual(expected);
      const packed: string[] = existsSync(downloads) ? readFileSync(downloads, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
      if (!failure) {
        expect(new Set(packed)).toEqual(new Set(['@openmoq/transport@1.0.0', '@openmoq/browser@1.0.0', '@moqt/browser@1.0.0']));
      }
      if (['metadata delayed', 'tarball delayed', 'already published'].includes(condition)) {
        expect(packed.filter((spec) => spec === '@openmoq/transport@1.0.0').length).toBeGreaterThanOrEqual(3);
      }
      if (condition === 'download forbidden') expect(packed).toEqual(['@openmoq/transport@1.0.0']);
      if (condition === 'download timeout') expect(packed.filter((spec) => spec === '@openmoq/transport@1.0.0').length).toBeGreaterThanOrEqual(6);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it('places canonical dependencies before dependents and all compatibility packages last', () => {
    expect(order([
      { name: '@moqt/browser', version: '1.0.0', dependencies: { '@openmoq/browser': '1.0.0' } },
      { name: '@openmoq/browser', version: '1.0.0', dependencies: { '@openmoq/transport': '1.0.0' } },
      { name: '@playa/player', version: '1.0.0', dependencies: { '@openmoq/playa': '1.0.0' } },
      { name: '@openmoq/transport', version: '1.0.0' },
      { name: '@openmoq/playa', version: '1.0.0', dependencies: { '@openmoq/browser': '1.0.0' } },
    ])).toEqual(['@openmoq/transport', '@openmoq/browser', '@openmoq/playa', '@moqt/browser', '@playa/player']);
  });

  it.each(['missing', 'wrong version', 'cycle', 'duplicate'] as const)('rejects %s before emitting a publication plan', (condition) => {
    const packages = [
      { name: '@moqt/transport', version: '1.0.0', dependencies: { '@openmoq/transport': '1.0.0' } },
      { name: '@openmoq/transport', version: '1.0.0', dependencies: {} as Record<string, string> },
    ];
    if (condition === 'missing') packages.pop();
    if (condition === 'wrong version') packages[1]!.version = '0.9.0';
    if (condition === 'cycle') packages[1]!.dependencies['@openmoq/transport'] = '1.0.0';
    if (condition === 'duplicate') packages.push(packages[1]!);
    expect(() => order(packages)).toThrow();
  });

  it('uses the combined smoke gate for local releases', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'release.mjs'), 'utf8');
    expect(source).toContain("run('pnpm smoke:exports')");
  });
});
