#!/usr/bin/env node
// Verify shipped compatibility packages without workspace symlinks or registry access.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'moq-compat-'));
const consumer = join(temporary, 'consumer');
const tarballs = join(temporary, 'tarballs');
const modules = join(consumer, 'node_modules');
const packages = readdirSync(join(root, 'packages')).map((directory) => ({
  directory,
  manifest: JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8')),
})).filter(({ manifest }) => !manifest.private);

try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync('pnpm', ['--filter', './packages/*', 'pack', '--pack-destination', tarballs], {
    cwd: root, stdio: 'pipe',
  });
  for (const tarball of readdirSync(tarballs)) {
    const path = join(tarballs, tarball);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }));
    const destination = join(modules, manifest.name);
    mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xzf', path, '--strip-components=1', '-C', destination]);
  }

  // Copy installed external dependencies, never the workspace libraries. Imports
  // and declarations below must resolve entirely from extracted tarballs.
  const copied = new Set();
  function copyExternal(name, sourceModules) {
    if (name.startsWith('@openmoq/') || copied.has(name)) return;
    const source = realpathSync(join(sourceModules, name));
    copied.add(name);
    const destination = join(modules, name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true });
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const local = join(source, 'node_modules');
      copyExternal(dependency, existsSync(join(local, dependency)) ? local : sourceModules);
    }
  }
  for (const { directory, manifest } of packages) {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      copyExternal(name, join(root, 'packages', directory, 'node_modules'));
    }
  }

  const pairs = [];
  for (const { directory, manifest } of packages.filter(({ directory }) => directory.startsWith('compat-'))) {
    const packed = JSON.parse(readFileSync(join(modules, manifest.name, 'package.json'), 'utf8'));
    const [canonical] = Object.keys(manifest.dependencies);
    if (packed.dependencies[canonical] !== manifest.version) throw new Error(`${manifest.name}: dependency is not pinned to ${manifest.version}`);
    for (const subpath of Object.keys(manifest.exports)) {
      const suffix = subpath === '.' ? '' : subpath.slice(1);
      pairs.push([manifest.name + suffix, canonical + suffix]);
    }
  }
  if (pairs.length !== 19) throw new Error(`Expected 19 compatibility entry points, got ${pairs.length}`);
  writeFileSync(join(consumer, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    const pairs = ${JSON.stringify(pairs)};
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    for (const [legacy, canonical] of pairs) {
      const old = await import(legacy);
      const current = await import(canonical);
      assert.deepEqual(Object.keys(old), Object.keys(current), legacy);
      for (const key of Object.keys(current)) assert.equal(old[key], current[key], legacy + ':' + key);
      try { await import(legacy + '/dist/internal.js'); assert.fail('deep import allowed'); }
      catch (error) { assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED'); }
    }
    assert.equal(warnings.length, 0, 'imports must not emit runtime warnings');
  `);
  execFileSync(process.execPath, ['verify.mjs'], { cwd: consumer, stdio: 'inherit' });
  // Canonical browser bundles expose the root API but have no separate d.ts.
  // The wrappers deliberately expose the canonical root declarations there.
  writeFileSync(join(consumer, 'verify.ts'), pairs.map(([legacy, canonical], index) =>
    `import * as old${index} from '${legacy}';\nimport * as current${index} from '${canonical.split('/').slice(0, 2).join('/')}';\n` +
    `const forward${index}: typeof current${index} = old${index};\nconst reverse${index}: typeof old${index} = current${index};\n`,
  ).join('\n'));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'verify.ts'],
  { cwd: consumer, stdio: 'inherit' });
  console.log(`${pairs.length} packed compatibility entry points: runtime identity and types pass`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
