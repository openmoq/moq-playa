import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it.each(['healthy', 'system bash', 'publish fails', 'dependency unavailable'] as const)('publishes dependencies before wrappers: %s', (condition) => {
    const directory = mkdtempSync(join(tmpdir(), 'moq-publish-workflow-'));
    try {
      tarballs(directory, [
        { name: '@moqt/browser', version: '1.0.0', dependencies: { '@openmoq/browser': '1.0.0' } },
        { name: '@openmoq/browser', version: '1.0.0', dependencies: { '@openmoq/transport': '1.0.0' } },
        { name: '@openmoq/transport', version: '1.0.0' },
      ]);
      mkdirSync(join(directory, 'scripts'));
      copyFileSync(script, join(directory, 'scripts/order-release-tarballs.mjs'));
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      const log = join(directory, 'published.jsonl');
      writeFileSync(join(bin, 'npm'), `#!${process.execPath}
        const fs = require('node:fs');
        const { execFileSync } = require('node:child_process');
        const args = process.argv.slice(2);
        if (args[0] === 'view') {
          if (${condition === 'dependency unavailable'} && args[1] === '@openmoq/browser@1.0.0') process.exit(1);
          process.stdout.write(args[2] === 'versions' ? '[]' : '1.0.0');
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
        cwd: directory, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe',
      });
      const failure = condition === 'publish fails' || condition === 'dependency unavailable';
      if (failure) expect(run).toThrow();
      else run();
      expect(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(
        failure ? ['@openmoq/transport', '@openmoq/browser'] : ['@openmoq/transport', '@openmoq/browser', '@moqt/browser'],
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
