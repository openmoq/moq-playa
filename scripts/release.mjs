#!/usr/bin/env node
/**
 * Release workflow — build, verify, tag, and optionally publish.
 *
 * Usage:
 *   node scripts/release.mjs              # verify current version, dry-run
 *   node scripts/release.mjs 0.6.0        # bump to 0.6.0, verify, pack
 *   node scripts/release.mjs --publish    # verify + tag + publish to npm
 *
 * Steps:
 *   1. Sync version across all packages (from root or CLI arg)
 *   2. pnpm install (update lockfile if versions changed)
 *   3. pnpm -r build (tsc + tsup for all packages)
 *   4. pnpm test
 *   5. package README check + smoke-exports (boundary verification)
 *   6. Pack the PUBLISHABLE packages only (packages/*) into ./release
 *   7. If --publish: git tag v{version} + pnpm publish --access public
 *
 * Publishing requires a clean working tree (asserted up front), so the
 * tarballs in ./release/ — which cover exactly the packages that publish —
 * are the exact artifacts sent to npm. The tag is created only on publish,
 * so a dry run never leaves a tag with no corresponding release.
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

// ── Guard: never publish from a dirty tree ───────────────────────────
// Publishing packs from the working tree; a dirty tree would ship artifacts
// the git tag does not represent. Require a clean, committed state up front.
if (shouldPublish) {
  const dirty = runCapture('git status --porcelain');
  if (dirty) {
    console.error('\n✗ Refusing to publish from a dirty working tree — commit or stash first:\n');
    console.error(dirty + '\n');
    process.exit(1);
  }
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

// ── Step 4: Package READMEs ──────────────────────────────────────────
// Each published package's README is derived from its package.json; fail
// the release if any is stale so npm never ships a drifted description.

console.log('\n📄 Checking package READMEs...');
run('node scripts/generate-package-readmes.mjs --check');

// ── Step 5: Smoke ────────────────────────────────────────────────────

console.log('\n🔍 Export smoke test...');
run('node scripts/smoke-exports.mjs');

// ── Step 5: Pack ─────────────────────────────────────────────────────

const releaseDir = join(ROOT, 'release');
rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

// Pack ONLY the publishable packages (packages/*) — `pnpm -r` would also pack
// the private example workspaces, so ./release would misrepresent what ships.
console.log('\n📦 Packing publishable tarballs...');
run(`pnpm --filter "./packages/*" pack --pack-destination "${releaseDir}"`);

// List what was packed
const tarballs = runCapture(`ls -lh "${releaseDir}"/*.tgz`);
console.log('\nTarballs:');
console.log(tarballs);

// ── Step 7: Tag + Publish (opt-in) ───────────────────────────────────
// Tag only when actually publishing (the clean-tree guard above ran), so a
// dry run never leaves a tag with no corresponding release.

const tag = `v${version}`;

if (shouldPublish) {
  if (runCapture('git tag -l').split('\n').includes(tag)) {
    console.log(`\n⚠️  Tag ${tag} already exists — skipping`);
  } else {
    console.log(`\n🏷  Tagging ${tag}`);
    execSync(`git tag -a ${tag} -m "Release ${tag}"`, { cwd: ROOT });
  }
  console.log('\n🚀 Publishing to npm...');
  run('pnpm --filter "./packages/*" publish --access public --no-git-checks');
  console.log(`\n✅ Published v${version} to npm`);
  console.log(`   Push the tag: git push origin ${tag}`);
} else {
  console.log(`\n✅ Release v${version} verified`);
  console.log('   Tarballs in ./release/ are exactly what would publish.');
  console.log('   To publish (from a clean tree): node scripts/release.mjs --publish');
}
