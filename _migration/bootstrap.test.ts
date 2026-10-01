import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const packages = ['browser', 'loc', 'locmaf', 'msf', 'playback', 'player', 'quic', 'transport', 'webtransport', 'playa']
  .map((name) => ({ name: `@openmoq/${name}`, version: '0.5.9' }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function run(options: { tarballs?: typeof packages; dirty?: boolean; offMain?: boolean; shell?: string } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'moq-scope-bootstrap-'));
  roots.push(root);
  mkdirSync(resolve(root, '_migration'));
  mkdirSync(resolve(root, 'bin'));
  copyFileSync(resolve(import.meta.dirname, 'step5_bootstrap_publish_openmoq.sh'),
    resolve(root, '_migration/step5_bootstrap_publish_openmoq.sh'));
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({ version: '0.5.9' }));
  const log = resolve(root, 'calls.jsonl');
  writeFileSync(log, '');
  const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const fixture = JSON.parse(process.env.FIXTURE);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([command, ...args]) + '\\n');
if (command === 'npm') {
  if (args[0] !== 'publish') throw new Error('Unexpected npm operation');
} else if (command === 'git') {
  if (args[0] === 'status') process.stdout.write(fixture.dirty ? ' M package.json\\n' : '');
  else if (args[0] === 'merge-base') process.exit(fixture.offMain ? 1 : 0);
  else throw new Error('Unexpected git operation: ' + args.join(' '));
} else if (command === 'pnpm' && args.includes('pack')) {
  const destination = args[args.indexOf('--pack-destination') + 1];
  const source = path.join(process.cwd(), 'tar-source');
  fs.mkdirSync(path.join(source, 'package'), { recursive: true });
  for (const [i, pkg] of fixture.tarballs.entries()) {
    fs.writeFileSync(path.join(source, 'package/package.json'), JSON.stringify(pkg));
    execFileSync('tar', ['-czf', path.join(destination, 'package-' + i + '.tgz'), '-C', source, 'package']);
  }
}
`;
  for (const command of ['npm', 'pnpm', 'git']) writeFileSync(resolve(root, 'bin', command), stub, { mode: 0o755 });
  const result = spawnSync(options.shell ?? 'bash', [resolve(root, '_migration/step5_bootstrap_publish_openmoq.sh')], {
    cwd: root, encoding: 'utf8', timeout: 45_000,
    env: {
      PATH: `${root}/bin:${process.env.PATH}`, CALL_LOG: log,
      FIXTURE: JSON.stringify({ ...options, tarballs: options.tarballs ?? packages }),
    },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { ...result, calls, publications: calls.filter(([cmd]) => cmd === 'npm') };
}

// Each case runs the shell script and creates ten real package archives.
describe('bootstrap publication', { timeout: 60_000 }, () => {
  it('publishes the complete validated set as local public tarballs', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.publications).toHaveLength(10);
    for (const call of result.publications) {
      expect(call.slice(0, 2)).toEqual(['npm', 'publish']);
      expect(call[2]).toMatch(/^file:.*\.tgz$/);
      expect(call.slice(3)).toEqual(['--access', 'public']);
    }
  });

  it('uses the frozen dependency graph', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContainEqual(['pnpm', 'install', '--frozen-lockfile']);
  });

  it.each([
    ['a missing package', packages.slice(1)],
    ['an unexpected package', [...packages, { name: '@openmoq/extra', version: '0.5.9' }]],
    ['a duplicate package', [...packages, packages[0]!]],
    ['a mismatched version', packages.map((pkg, i) => i === 0 ? { ...pkg, version: '0.5.8' } : pkg)],
  ] as const)('refuses %s before any publication', (_name, tarballs) => {
    const result = run({ tarballs: [...tarballs] });
    expect(result.status).not.toBe(0);
    expect(result.publications).toEqual([]);
  });

  it.each([{ dirty: true }, { offMain: true }])('refuses an unapproved source tree: %j', (options) => {
    const result = run(options);
    expect(result.status).not.toBe(0);
    expect(result.publications).toEqual([]);
  });

  it.skipIf(process.platform !== 'darwin')('works with the macOS system bash', () => {
    const result = run({ shell: '/bin/bash' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.publications).toHaveLength(10);
  });
});
