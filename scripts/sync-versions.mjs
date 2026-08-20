#!/usr/bin/env node
/**
 * Sync all package versions from the root package.json.
 *
 * Usage: pnpm version:sync
 *
 * Reads `version` from the root package.json, then writes it to
 * every packages/[name]/package.json. Single source of truth.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const version = rootPkg.version;

if (!version) {
  console.error('No version field in root package.json');
  process.exit(1);
}

const packagesDir = join(root, 'packages');
let updated = 0;

for (const name of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, name, 'package.json');
  try {
    statSync(pkgPath);
  } catch {
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (pkg.version !== version) {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  ${pkg.name}: ${pkg.version} → ${version}`);
    updated++;
  }
}

// Update the `static readonly version` literal in player class sources
const versionStatics = [
  ['@playa/playa Player.version', join(packagesDir, 'playa', 'src', 'player.ts')],
  ['@moqt/player MoqtPlayer.version', join(packagesDir, 'player', 'src', 'player.ts')],
];
for (const [label, srcPath] of versionStatics) {
  try {
    const src = readFileSync(srcPath, 'utf-8');
    const replaced = src.replace(
      /static readonly version = '[^']+'/,
      `static readonly version = '${version}'`,
    );
    if (replaced !== src) {
      writeFileSync(srcPath, replaced);
      console.log(`  ${label} → '${version}'`);
      updated++;
    }
  } catch { /* package not found — skip */ }
}

console.log(`\nSynced ${updated} package(s) to v${version}`);
