/**
 * CLI: publish a fixture into an ALREADY-RUNNING relay (start one with
 * `pnpm --filter @moqt/example-node-relay relay-server`).
 *
 *   pnpm --filter @moqt/example-node-publisher publish-fixture [--loop | --loop-count N] [url] [fixtureDir]
 *
 * With no fixtureDir the SYNTHETIC fixture is published (protocol smoke bytes, not
 * playable). With a fixtureDir (produced by `prepare-fixture` + checked by
 * `validate-fixture`), the REAL fixture is loaded from disk — same publish flow.
 *
 * Loop mode: `--loop` repeats the media chunks indefinitely as new groups
 * (groupId 0, 1, 2, …) on the SAME established tracks — a tiny fixture becomes an
 * endless live demo. `--loop-count N` sends exactly N groups (finite smoke/debug).
 * Default (no flag) is the one-shot behavior.
 *
 * Default url https://127.0.0.1:4433/moq. PACE_MS env (default = the manifest's
 * chunkDurationMs) paces chunk sends like a live origin; PACE_MS=0 sends as fast
 * as possible.
 */
import { resolve } from 'node:path';
import { connectClient } from './client.js';
import { publishFixture } from './publisher.js';
import { loadSyntheticFixture } from './synthetic-fixture.js';
import { loadFixtureFromDisk, validateFixtureLayout, validateFixtureBoxes } from './fixture.js';

// Flags first (--loop / --loop-count N), then [url] [fixtureDir] in either order:
// anything starting with https:// is the url, anything else is a fixture dir.
const rawArgs = process.argv.slice(2);
let loops = 1;
const positionals: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]!;
  if (a === '--loop') loops = Infinity;
  else if (a === '--loop-count') {
    const n = Number(rawArgs[++i]);
    if (!Number.isInteger(n) || n < 1) { console.error('--loop-count requires a positive integer'); process.exit(2); }
    loops = n;
  } else positionals.push(a);
}
const url = positionals.find((a) => a.startsWith('https://')) ?? process.env.URL ?? 'https://127.0.0.1:4433/moq';
const fixtureDir = positionals.find((a) => !a.startsWith('https://'));

let fixture;
if (fixtureDir) {
  const dir = resolve(fixtureDir);
  const issues = [...validateFixtureLayout(dir), ...validateFixtureBoxes(dir)];
  if (issues.length > 0) {
    console.error(`[publish] fixture ${dir} is invalid (${issues.length} issue(s)) — run validate-fixture for details`);
    process.exit(1);
  }
  fixture = loadFixtureFromDisk(dir);
  console.log(`[publish] loaded REAL fixture from ${dir} (${fixture.tracks.length} tracks)`);
} else {
  fixture = loadSyntheticFixture();
  console.log('[publish] using SYNTHETIC fixture (not browser-playable; pass a fixture dir for real media)');
}

const paceMs = process.env.PACE_MS !== undefined ? Number(process.env.PACE_MS) : fixture.manifest.chunkDurationMs;
console.log(`[publish] connecting to ${url} (paceMs=${paceMs}, loops=${loops === Infinity ? '∞' : loops})`);
connectClient(url, 'publisher')
  .then(async (h) => {
    await publishFixture(h.conn, fixture, { paceMs, loops });
    await h.close();
    process.exit(0);
  })
  .catch((err) => { console.error('[publish] failed:', (err as Error).message); process.exit(1); });
