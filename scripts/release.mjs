#!/usr/bin/env node
/**
 * Release workflow — build, verify, pack, and (with --publish) tag.
 *
 * npm publish lives in .github/workflows/publish.yml (Trusted Publisher).
 * This script never uploads; pushing the vMAJOR.MINOR.PATCH tag does.
 *
 * Usage:
 *   node scripts/release.mjs              # verify current version, dry-run
 *   node scripts/release.mjs 0.6.0        # bump to 0.6.0, verify, pack
 *   node scripts/release.mjs --publish    # verify + tag v{version}
 *
 * Typical cut:
 *   1. node scripts/release.mjs 0.6.0
 *   2. commit the version bump (tree must be clean before tagging)
 *   3. node scripts/release.mjs --publish
 *   4. git push origin HEAD && git push origin v0.6.0
 *
 * Steps:
 *   1. Sync version across all packages (from root or CLI arg)
 *   2. pnpm install (update lockfile if versions changed)
 *   3. pnpm -r build (tsc + tsup for all packages)
 *   4. pnpm test
 *   5. package README check + smoke-exports (boundary verification)
 *   6. Pack the PUBLISHABLE packages only (packages/*) into ./release
 *   7. If --publish: git tag v{version} (do not npm publish)
 *
 * --publish requires a clean working tree so the tag points at the commit
 * that the GitHub Action will check out and publish. The tag is created
 * only on --publish, so a dry run never leaves a tag with no release.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const shouldPublish = args.includes('--publish');
const versionArgs = args.filter(arg => arg !== '--publish');

if (versionArgs.length > 1 || versionArgs.some(arg => !/^\d+\.\d+\.\d+$/.test(arg))) {
  console.error('Usage: node scripts/release.mjs [MAJOR.MINOR.PATCH] [--publish]');
  process.exit(1);
}

const newVersion = versionArgs[0];

if (shouldPublish && newVersion) {
  console.error('Version bumps and tagging are separate steps; commit the bump before --publish.');
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

function requireCleanTree(when) {
  const dirty = runCapture('git status --porcelain');
  if (!dirty) return;

  console.error(`\n✗ Refusing to tag: working tree is dirty ${when}:\n`);
  console.error(dirty + '\n');
  process.exit(1);
}

// ── Guard: never tag from a dirty tree ───────────────────────────────
// The GitHub Action publishes whatever the tag points at. A dirty tree
// would tag a commit that does not include the files about to ship.
if (shouldPublish) {
  requireCleanTree('before verification');
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
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Root package version must be MAJOR.MINOR.PATCH (got ${version})`);
  process.exit(1);
}
console.log(`\n🏷  Version: ${version}`);

const tag = `v${version}`;
const tagAlreadyExists = shouldPublish && runCapture('git tag -l').split('\n').includes(tag);

if (tagAlreadyExists) {
  const tagCommit = runCapture(`git rev-list -n 1 ${tag}`);
  const headCommit = runCapture('git rev-parse HEAD');
  if (tagCommit !== headCommit) {
    console.error(`\n✗ Refusing to use ${tag}: it points at ${tagCommit}, not HEAD ${headCommit}`);
    process.exit(1);
  }
}

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

// ── Step 7: Tag (opt-in) ─────────────────────────────────────────────
// Tag only on --publish (the clean-tree guard above ran), so a dry run
// never leaves a tag with no corresponding GitHub Action run.

if (shouldPublish) {
  requireCleanTree('after verification');

  if (tagAlreadyExists) {
    console.log(`\n⚠️  Tag ${tag} already exists at HEAD - skipping`);
  } else {
    console.log(`\n🏷  Tagging ${tag}`);
    execSync(`git tag -a ${tag} -m "Release ${tag}"`, { cwd: ROOT });
  }
  console.log(`\n✅ Tagged ${tag}`);
  console.log('   npm publish runs in CI when this tag reaches origin:');
  console.log(`   git push origin HEAD && git push origin ${tag}`);
} else {
  console.log(`\n✅ Release v${version} verified`);
  console.log('   Tarballs in ./release/ are exactly what CI would publish.');
  console.log('   To tag (from a clean tree): node scripts/release.mjs --publish');
}
