#!/usr/bin/env node
/**
 * Package-consumer smoke test for exports maps.
 *
 * Verifies that published packages expose only intended public imports
 * and block accidental deep dist/* imports via package.json "exports".
 *
 * Run after `pnpm -r build`:
 *   node scripts/smoke-exports.mjs
 *
 * Creates a temp consumer project with symlinked packages (simulating
 * how node_modules would look after npm install). Node's ESM resolver
 * respects "exports" maps on symlinked packages.
 */

import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(import.meta.url), '../..');
let passed = 0;
let failed = 0;

const tmpDir = mkdtempSync(join(tmpdir(), 'moqt-smoke-'));
const consumerDir = join(tmpDir, 'consumer');
mkdirSync(consumerDir);

// ── Symlink packages into node_modules ───────────────────────────────

const packages = [
  ['transport',    '@moqt/transport'],
  ['webtransport', '@moqt/webtransport'],
  ['loc',          '@moqt/loc'],
  ['msf',          '@moqt/msf'],
  ['playback',     '@moqt/playback'],
  ['player',       '@moqt/player'],
  ['browser',      '@moqt/browser'],
  ['playa',        '@playa/player'],
];

const nm = join(consumerDir, 'node_modules');
mkdirSync(join(nm, '@moqt'), { recursive: true });
mkdirSync(join(nm, '@playa'), { recursive: true });

for (const [dir, name] of packages) {
  const src = join(ROOT, 'packages', dir);
  const [scope, pkg] = name.split('/');
  symlinkSync(src, join(nm, scope, pkg), 'dir');
}

// Symlink third-party deps so transitive imports resolve.
// Check both root node_modules and per-package node_modules (pnpm hoists
// differently depending on the dep).
import { readdirSync, statSync, existsSync } from 'fs';
const nmSources = [join(ROOT, 'node_modules')];
for (const [dir] of packages) {
  const pkgNm = join(ROOT, 'packages', dir, 'node_modules');
  if (existsSync(pkgNm)) nmSources.push(pkgNm);
}
for (const srcNm of nmSources) {
  for (const entry of readdirSync(srcNm)) {
    if (entry.startsWith('.')) continue;
    const target = join(nm, entry);
    const src = join(srcNm, entry);
    try { statSync(target); } catch {
      try {
        if (entry.startsWith('@')) {
          mkdirSync(target, { recursive: true });
          for (const sub of readdirSync(src)) {
            const subTarget = join(target, sub);
            try { statSync(subTarget); } catch {
              try { symlinkSync(join(src, sub), subTarget, 'junction'); } catch { /* */ }
            }
          }
        } else {
          symlinkSync(src, target, 'junction');
        }
      } catch { /* ignore */ }
    }
  }
}

writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
  name: 'smoke-consumer', type: 'module', private: true,
}, null, 2));

// ── Test helpers ─────────────────────────────────────────────────────

function testImport(description, code, shouldSucceed = true) {
  try {
    execSync(`node --input-type=module -e ${JSON.stringify(code)}`, {
      cwd: consumerDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (shouldSucceed) {
      console.log(`  ✓ ${description}`);
      passed++;
    } else {
      console.log(`  ✗ ${description} — expected to FAIL but succeeded`);
      failed++;
    }
  } catch (err) {
    if (!shouldSucceed) {
      console.log(`  ✓ ${description} (correctly blocked)`);
      passed++;
    } else {
      const lines = (err.stderr || err.stdout || '').split('\n');
      const msg = lines.find(l => l.includes('ERR_') || l.includes('Error')) || 'unknown error';
      console.log(`  ✗ ${description} — ${msg.trim()}`);
      failed++;
    }
  }
}

// ── Root imports (must succeed) ──────────────────────────────────────

console.log('Root imports (must succeed):');

testImport('@moqt/transport',       `import '@moqt/transport'`);
testImport('@moqt/webtransport',    `import '@moqt/webtransport'`);
testImport('@moqt/loc',             `import '@moqt/loc'`);
testImport('@moqt/msf',             `import '@moqt/msf'`);
testImport('@moqt/playback',        `import '@moqt/playback'`);
testImport('@moqt/player',          `import '@moqt/player'`);
testImport('@moqt/browser resolves', `import.meta.resolve('@moqt/browser')`);
testImport('@playa/player resolves', `import.meta.resolve('@playa/player')`);

// ── Named exports (must succeed) ─────────────────────────────────────

console.log('\nNamed exports from roots (must succeed):');

testImport('MoqtConnection',     `import { MoqtConnection } from '@moqt/webtransport'; if (!MoqtConnection) throw 1;`);
testImport('MoqtConnectionError', `import { MoqtConnectionError } from '@moqt/webtransport'; if (!MoqtConnectionError) throw 1;`);
testImport('MoqtPlayer',         `import { MoqtPlayer } from '@moqt/player'; if (!MoqtPlayer) throw 1;`);
testImport('checkSupport',       `import { checkSupport } from '@moqt/player'; if (!checkSupport) throw 1;`);
testImport('PlayerErrorCode',    `import { PlayerErrorCode } from '@moqt/player'; if (!PlayerErrorCode) throw 1;`);
testImport('varint',             `import { varint } from '@moqt/transport'; if (!varint) throw 1;`);
testImport('Session',            `import { Session } from '@moqt/transport'; if (!Session) throw 1;`);
testImport('parseCatalog',       `import { parseCatalog } from '@moqt/msf'; if (!parseCatalog) throw 1;`);
testImport('PlaybackPipeline',   `import { PlaybackPipeline } from '@moqt/playback'; if (!PlaybackPipeline) throw 1;`);
testImport('parseLocHeaders',    `import { parseLocHeaders } from '@moqt/loc'; if (!parseLocHeaders) throw 1;`);

// ── Deep imports (must FAIL) ─────────────────────────────────────────

console.log('\nDeep imports (must be blocked by exports maps):');

testImport('@moqt/browser/dist/mse-adapter.js',          `import '@moqt/browser/dist/mse-adapter.js'`, false);
testImport('@moqt/player/dist/player.js',                `import '@moqt/player/dist/player.js'`, false);
testImport('@moqt/webtransport/dist/adapter.js',         `import '@moqt/webtransport/dist/adapter.js'`, false);
testImport('@moqt/transport/dist/session/session.js',    `import '@moqt/transport/dist/session/session.js'`, false);
testImport('@moqt/browser/dist/codec-strategy-h264.js',  `import '@moqt/browser/dist/codec-strategy-h264.js'`, false);
testImport('@moqt/playback/dist/pipeline.js',            `import '@moqt/playback/dist/pipeline.js'`, false);

// ── Trimmed exports (must not be importable from root) ───────────────

console.log('\nTrimmed @moqt/browser internals (must not be in root):');

testImport('H264Strategy not in root', `import { H264Strategy } from '@moqt/browser'; if (!H264Strategy) throw 1;`, false);
testImport('isAnnexB not in root',     `import { isAnnexB } from '@moqt/browser'; if (!isAnnexB) throw 1;`, false);
testImport('readU32 not in root',      `import { readU32 } from '@moqt/browser'; if (!readU32) throw 1;`, false);

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
