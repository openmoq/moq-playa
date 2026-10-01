#!/usr/bin/env bash
set -euo pipefail

# Step 5: Bootstrap publish @openmoq/* packages from local tarballs.
# Run from repo root with npm auth as an owner/publisher in @openmoq.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_clean_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Refusing bootstrap publication from a dirty working tree" >&2
    exit 1
  fi
}

require_clean_tree
if ! git merge-base --is-ancestor HEAD refs/remotes/origin/main; then
  echo "Bootstrap publication must use a commit on origin/main" >&2
  exit 1
fi

echo "==> Validating workspace before bootstrap publish"
pnpm install --frozen-lockfile
pnpm -r build
pnpm test
pnpm smoke:exports
require_clean_tree

echo "==> Packing publishable packages"
mkdir -p release
rm -f release/*.tgz || true
pnpm --filter "@openmoq/*" pack --pack-destination "$PWD/release"

echo "==> Verifying tarball package names"
expected=(
  "@openmoq/browser"
  "@openmoq/loc"
  "@openmoq/locmaf"
  "@openmoq/msf"
  "@openmoq/playback"
  "@openmoq/player"
  "@openmoq/quic"
  "@openmoq/transport"
  "@openmoq/webtransport"
  "@openmoq/playa"
)

node - "${expected[@]}" <<'NODE'
const { execFileSync } = require('node:child_process');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const expected = new Set(process.argv.slice(2));
const seen = new Set();
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Bootstrap requires a stable release version');
for (const filename of readdirSync('release').filter((name) => name.endsWith('.tgz'))) {
  const pkg = JSON.parse(execFileSync('tar', ['-xOzf', join('release', filename), 'package/package.json'], { encoding: 'utf8' }));
  if (!expected.has(pkg.name)) throw new Error(`Unexpected package: ${pkg.name}`);
  if (seen.has(pkg.name)) throw new Error(`Duplicate package: ${pkg.name}`);
  if (pkg.version !== version) throw new Error(`Wrong version for ${pkg.name}: ${pkg.version}, expected ${version}`);
  seen.add(pkg.name);
}
for (const name of expected) {
  if (!seen.has(name)) throw new Error(`Missing tarball for ${name}`);
}
NODE

echo "==> Publishing tarballs (one-time bootstrap)"
for tgz in release/*.tgz; do
  name="$(tar -xOzf "$tgz" package/package.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).name")"
  version="$(tar -xOzf "$tgz" package/package.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
  echo "Publishing ${name}@${version} from ${tgz}"
  npm publish "file:${tgz}" --access public
done

echo "Bootstrap publish complete."
