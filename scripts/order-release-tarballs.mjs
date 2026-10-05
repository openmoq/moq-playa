#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

// Validate the whole graph before emitting any paths. CI publishes canonical
// dependencies first and compatibility names only after that phase completes.
const packages = new Map();
for (const path of process.argv.slice(2)) {
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }));
  if (!/^@(openmoq|moqt)\//.test(manifest.name) && manifest.name !== '@playa/player') {
    throw new Error(`Unexpected release package: ${manifest.name}`);
  }
  if (packages.has(manifest.name)) throw new Error(`Duplicate release package: ${manifest.name}`);
  packages.set(manifest.name, { path, manifest });
}
if (packages.size === 0) throw new Error('No release tarballs');

const ordered = [];
const visiting = new Set();
const visited = new Set();
function visit(name) {
  if (visited.has(name)) return;
  if (visiting.has(name)) throw new Error(`Cyclic release dependency: ${name}`);
  const entry = packages.get(name);
  if (!entry) throw new Error(`Missing release dependency: ${name}`);
  visiting.add(name);
  for (const [dependency, version] of Object.entries(entry.manifest.dependencies ?? {})) {
    if (/^@(moqt|playa)\//.test(dependency)) throw new Error(`${name} depends on legacy ${dependency}`);
    if (!dependency.startsWith('@openmoq/')) continue;
    const target = packages.get(dependency);
    if (!target || target.manifest.version !== version) {
      throw new Error(`${name} requires unavailable ${dependency}@${version}`);
    }
    visit(dependency);
  }
  visiting.delete(name);
  visited.add(name);
  ordered.push(entry.path);
}
const names = [...packages.keys()].sort();
for (const name of names.filter((name) => name.startsWith('@openmoq/'))) visit(name);
for (const name of names.filter((name) => !name.startsWith('@openmoq/'))) visit(name);
process.stdout.write(ordered.join('\n') + '\n');
