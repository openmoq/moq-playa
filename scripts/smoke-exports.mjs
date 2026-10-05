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
  ['transport',    '@openmoq/transport'],
  ['webtransport', '@openmoq/webtransport'],
  ['quic',          '@openmoq/quic'],
  ['loc',          '@openmoq/loc'],
  ['locmaf',       '@openmoq/locmaf'],
  ['msf',          '@openmoq/msf'],
  ['playback',     '@openmoq/playback'],
  ['player',       '@openmoq/player'],
  ['browser',      '@openmoq/browser'],
  ['playa',        '@openmoq/playa'],
];

const nm = join(consumerDir, 'node_modules');
mkdirSync(join(nm, '@openmoq'), { recursive: true });

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

testImport('@openmoq/transport',       `import '@openmoq/transport'`);
testImport('@openmoq/webtransport',    `import '@openmoq/webtransport'`);
testImport('@openmoq/quic',            `import '@openmoq/quic'`);
testImport('@openmoq/loc',             `import '@openmoq/loc'`);
testImport('@openmoq/locmaf',          `import '@openmoq/locmaf'`);
testImport('@openmoq/msf',             `import '@openmoq/msf'`);
testImport('@openmoq/playback',        `import '@openmoq/playback'`);
testImport('@openmoq/player',          `import '@openmoq/player'`);
testImport('@openmoq/browser resolves', `import.meta.resolve('@openmoq/browser')`);
testImport('@openmoq/playa resolves', `import.meta.resolve('@openmoq/playa')`);

// ── Named exports (must succeed) ─────────────────────────────────────

console.log('\nNamed exports from roots (must succeed):');

testImport('MoqtConnection',     `import { MoqtConnection } from '@openmoq/webtransport'; if (!MoqtConnection) throw 1;`);
testImport('MoqtConnectionError', `import { MoqtConnectionError } from '@openmoq/webtransport'; if (!MoqtConnectionError) throw 1;`);
testImport('connectQuic',         `import { connectQuic, parseMoqtUri } from '@openmoq/quic'; if (typeof connectQuic !== 'function') throw 1; if (parseMoqtUri('moqt://example.com/moq').setup.path !== '/moq') throw 1;`);
testImport('MoqtPlayer',         `import { MoqtPlayer } from '@openmoq/player'; if (!MoqtPlayer) throw 1;`);
for (const pkg of ['webtransport', 'player', 'playa']) {
  testImport(`CAT helper from @openmoq/${pkg}`, [
    `import { catToken, AuthorizationError } from '@openmoq/${pkg}';`,
    'const bytes = new Uint8Array([1, 2]);',
    'const token = catToken(bytes); bytes[0] = 9;',
    "if (token.tokenType !== 1n || token.value[0] !== 1 || new AuthorizationError('test').name !== 'AuthorizationError') throw 1;",
  ].join(' '));
}
testImport('checkSupport',       `import { checkSupport } from '@openmoq/player'; if (!checkSupport) throw 1;`);
testImport('PlayerErrorCode',    `import { PlayerErrorCode } from '@openmoq/player'; if (!PlayerErrorCode) throw 1;`);
testImport('varint',             `import { varint } from '@openmoq/transport'; if (!varint) throw 1;`);
testImport('Session',            `import { Session } from '@openmoq/transport'; if (!Session) throw 1;`);
testImport('parseCatalog',       `import { parseCatalog } from '@openmoq/msf'; if (!parseCatalog) throw 1;`);
testImport('PlaybackPipeline',   `import { PlaybackPipeline } from '@openmoq/playback'; if (!PlaybackPipeline) throw 1;`);
testImport('parseLocHeaders',    `import { parseLocHeaders } from '@openmoq/loc'; if (!parseLocHeaders) throw 1;`);
testImport('LocmafTrackDecoder', `import { LocmafTrackDecoder, deserializeLocmafObject, LOCMAF_VERSION } from '@openmoq/locmaf'; if (typeof LocmafTrackDecoder !== 'function' || typeof deserializeLocmafObject !== 'function') throw 1; if (LOCMAF_VERSION !== '0.3') throw 1;`);

// ── Trace recorder exports (docs/playout-trace.md) ───────────────

console.log('\nTrace recorder public surface:');

testImport('TraceRecorder constructs and dumps', `import { TraceRecorder, DEFAULT_TRACE_LIMITS, PLAYA_EVENT_SCHEMA, LOGLEVEL_EVENT_SCHEMA, formatLogMessage } from '@openmoq/player'; if (typeof TraceRecorder !== 'function') throw 1; if (typeof formatLogMessage !== 'function') throw 1; if (typeof DEFAULT_TRACE_LIMITS?.denseMaxAgeMs !== 'number') throw 1; if (PLAYA_EVENT_SCHEMA !== 'https://openmoq.org/082026/playa') throw 1; if (LOGLEVEL_EVENT_SCHEMA !== 'urn:ietf:params:qlog:events:loglevel') throw 1; const r = new TraceRecorder({ clock: { clock_id: 'smoke', clock_type: 'monotonic', now: () => 0 }, runId: 'smoke', eventSchemas: ['urn:ietf:params:qlog:events:moqt-06'], enabled: true }); r.record('moqt:a', {}); if (!r.dump().includes('playa:trace_window')) throw 1;`);
testImport('assertEventName', `import { assertEventName } from '@openmoq/transport'; if (typeof assertEventName !== 'function') throw 1; assertEventName('moqt:stream_type_set'); let threw = false; try { assertEventName('unnamespaced'); } catch { threw = true; } if (!threw) throw 1;`);

// ── Deep imports (must FAIL) ─────────────────────────────────────────

console.log('\nDeep imports (must be blocked by exports maps):');

testImport('@openmoq/browser/dist/mse-adapter.js',          `import '@openmoq/browser/dist/mse-adapter.js'`, false);
testImport('@openmoq/player/dist/player.js',                `import '@openmoq/player/dist/player.js'`, false);
testImport('@openmoq/webtransport/dist/adapter.js',         `import '@openmoq/webtransport/dist/adapter.js'`, false);
testImport('@openmoq/quic/dist/connect.js',                  `import '@openmoq/quic/dist/connect.js'`, false);
testImport('@openmoq/transport/dist/session/session.js',    `import '@openmoq/transport/dist/session/session.js'`, false);
testImport('@openmoq/browser/dist/codec-strategy-h264.js',  `import '@openmoq/browser/dist/codec-strategy-h264.js'`, false);
testImport('@openmoq/playback/dist/pipeline.js',            `import '@openmoq/playback/dist/pipeline.js'`, false);

// ── Trimmed exports (must not be importable from root) ───────────────

console.log('\nTrimmed @openmoq/browser internals (must not be in root):');

testImport('H264Strategy not in root', `import { H264Strategy } from '@openmoq/browser'; if (!H264Strategy) throw 1;`, false);
testImport('isAnnexB not in root',     `import { isAnnexB } from '@openmoq/browser'; if (!isAnnexB) throw 1;`, false);
testImport('readU32 not in root',      `import { readU32 } from '@openmoq/browser'; if (!readU32) throw 1;`, false);

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
