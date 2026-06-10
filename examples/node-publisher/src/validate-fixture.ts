/**
 * CLI: validate a fixture directory's LAYOUT against the contract in fixture.ts.
 *
 *   pnpm --filter @moqt/example-node-publisher validate-fixture [dir]
 *
 * Default dir: ./fixtures/bbb-2s (the planned committed fixture). No fixture on
 * disk is NOT an error — the publisher currently runs in synthetic mode — so that
 * prints a clear message and exits 0. An EXISTING but broken fixture exits 1 with
 * the issue list.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFixtureLayout, validateFixtureBoxes, loadFixtureManifest } from './fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] ?? join(here, '..', 'fixtures', 'bbb-2s'));

if (!existsSync(join(dir, 'manifest.json'))) {
  console.log(`No fixture at ${dir} — nothing to validate yet.`);
  console.log('See fixtures/README.md and scripts/prepare-fixture.mjs for how to create one (the publisher runs in synthetic mode until then).');
  process.exit(0);
}

// Layout first (files exist), then box-level media checks (ftyp+moov / moof+mdat).
const issues = [...validateFixtureLayout(dir)];
if (issues.length === 0) issues.push(...validateFixtureBoxes(dir));

if (issues.length === 0) {
  const m = loadFixtureManifest(dir);
  const chunkCount = m.tracks.reduce((n, t) => n + t.chunks.length, 0);
  console.log(`Fixture OK: ${dir}`);
  console.log(`  namespace=${m.namespace.join('/')}  tracks=${m.tracks.length}  chunks=${chunkCount}  chunkDurationMs=${m.chunkDurationMs}`);
  console.log('  box checks: init=ftyp+moov ✓  chunks=moof+mdat ✓');
  process.exit(0);
}
console.error(`Fixture INVALID: ${dir} — ${issues.length} issue(s):`);
for (const i of issues) console.error(`  [${i.track ?? 'manifest'}] ${i.message}`);
process.exit(1);
