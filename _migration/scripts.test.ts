import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const names = ['browser', 'loc', 'locmaf', 'msf', 'playback', 'player', 'quic', 'transport', 'webtransport', 'playa'];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function run(script: string, missing?: string) {
  const root = mkdtempSync(resolve(tmpdir(), 'moq-scope-migration-'));
  roots.push(root);
  mkdirSync(resolve(root, '_migration'));
  mkdirSync(resolve(root, 'bin'));
  copyFileSync(resolve(import.meta.dirname, script), resolve(root, '_migration', script));
  copyFileSync(resolve(import.meta.dirname, 'step6_trusted_publisher_check.sh'),
    resolve(root, '_migration/step6_trusted_publisher_check.sh'));
  const log = resolve(root, 'npm.jsonl');
  appendFileSync(log, '');
  writeFileSync(resolve(root, 'bin/npm'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  if (args[1] === process.env.MISSING_PACKAGE) process.exit(1);
  process.stdout.write(args[1] + '\\n');
} else if (args[0] !== 'deprecate') {
  throw new Error('Unexpected npm operation: ' + args.join(' '));
}
`, { mode: 0o755 });
  const result = spawnSync('bash', [resolve(root, '_migration', script)], {
    cwd: root, encoding: 'utf8', timeout: 45_000,
    env: { PATH: `${root}/bin:${process.env.PATH}`, CALL_LOG: log, MISSING_PACKAGE: missing ?? '' },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { ...result, calls };
}

describe('scope migration scripts', { timeout: 60_000 }, () => {
  it('supplies npm deprecate with a package spec and the intended message', () => {
    const result = run('step9_deprecate_old_scopes.sh');
    expect(result.status, result.stderr).toBe(0);
    const calls = result.calls.filter(([command]) => command === 'deprecate');
    expect(calls).toEqual(names.map((name) => {
      const old = name === 'playa' ? '@playa/player' : `@moqt/${name}`;
      return ['deprecate', `${old}@*`, `${old} has moved. Install @openmoq/${name} instead.`];
    }));
  });

  it('checks every replacement before deprecating any old package', () => {
    const result = run('step9_deprecate_old_scopes.sh', '@openmoq/playa');
    expect(result.status).not.toBe(0);
    expect(result.calls.filter(([command]) => command === 'deprecate')).toEqual([]);
  });

  it('accepts a complete set of visible new packages', () => {
    const result = run('step6_trusted_publisher_check.sh');
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(names.map((name) => ['view', `@openmoq/${name}`, 'name']));
  });

  it('does not claim success when a replacement cannot be verified', () => {
    const result = run('step6_trusted_publisher_check.sh', '@openmoq/transport');
    expect(result.status).not.toBe(0);
    expect(result.calls.every(([command]) => command === 'view')).toBe(true);
  });
});
