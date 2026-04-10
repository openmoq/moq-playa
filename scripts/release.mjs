#!/usr/bin/env node
/**
 * Release workflow — build, verify, tag, and optionally publish.
 *
 * Usage:
 *   node scripts/release.mjs              # verify current version, dry-run
 *   node scripts/release.mjs 0.6.0        # bump to 0.6.0, verify, tag
 *   node scripts/release.mjs --publish    # verify + publish to npm
 *
 * Steps:
 *   1. Sync version across all packages (from root or CLI arg)
 *   2. pnpm install (update lockfile if versions changed)
 *   3. pnpm -r build (tsc + tsup for all packages)
 *   4. pnpm test (2400+ tests)
 *   5. node scripts/smoke-exports.mjs (package boundary verification)
 *   6. pnpm -r pack --pack-destination ./release (create tarballs)
 *   7. Git tag v{version}
 *   8. If --publish: pnpm -r publish --access public
 *
 * The tarballs in ./release/ are the exact artifacts that would be
 * published. Inspect them before pushing to npm.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shouldPublish = args.includes('--publish');
const newVersion = args.find(a => /^\d+\.\d+\.\d+/.test(a));

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

// ── Step 0: Version ──────────────────────────────────────────────────

if (newVersion) {
  console.log(`\n📦 Bumping to v${newVersion}`);
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  rootPkg.version = newVersion;
  writeFileSync(join(ROOT, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');
  run('node scripts/sync-versions.mjs');
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
console.log(`\n🏷  Version: ${version}`);

// ── Step 1: Install ──────────────────────────────────────────────────

run('pnpm install');

// ── Step 2: Build ────────────────────────────────────────────────────

console.log('\n🔨 Building all packages...');
run('pnpm -r build');

// ── Step 3: Test ─────────────────────────────────────────────────────

console.log('\n🧪 Running tests...');
run('pnpm test');

// ── Step 4: Smoke ────────────────────────────────────────────────────

console.log('\n🔍 Export smoke test...');
run('node scripts/smoke-exports.mjs');

// ── Step 5: Pack ─────────────────────────────────────────────────────

const releaseDir = join(ROOT, 'release');
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

console.log('\n📦 Packing tarballs...');
run(`pnpm -r pack --pack-destination "${releaseDir}"`);

// List what was packed
const tarballs = runCapture(`ls -lh "${releaseDir}"/*.tgz`);
console.log('\nTarballs:');
console.log(tarballs);

// ── Step 6: Git tag ──────────────────────────────────────────────────

const tag = `v${version}`;
const existingTags = runCapture('git tag -l');
if (existingTags.split('\n').includes(tag)) {
  console.log(`\n⚠️  Tag ${tag} already exists — skipping`);
} else {
  console.log(`\n🏷  Tagging ${tag}`);
  execSync(`git tag -a ${tag} -m "Release ${tag}"`, { cwd: ROOT });
}

// ── Step 7: Publish (opt-in) ─────────────────────────────────────────

if (shouldPublish) {
  console.log('\n🚀 Publishing to npm...');
  run('pnpm -r publish --access public --no-git-checks');
  console.log(`\n✅ Published v${version} to npm`);
} else {
  console.log(`\n✅ Release v${version} verified`);
  console.log('   Tarballs ready in ./release/');
  console.log('   To publish: node scripts/release.mjs --publish');
  console.log(`   To push tag: git push playa ${tag}`);
}
