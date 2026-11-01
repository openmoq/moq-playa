#!/usr/bin/env node
// Verify shipped compatibility packages without workspace symlinks or registry access.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'moq-compat-'));
const consumer = join(temporary, 'consumer');
const tarballs = join(temporary, 'tarballs');
const modules = join(consumer, 'node_modules');
const packages = readdirSync(join(root, 'packages')).map((directory) => ({
  directory,
  manifest: JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8')),
})).filter(({ manifest }) => !manifest.private);

try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  execFileSync('pnpm', ['--filter', './packages/*', 'pack', '--pack-destination', tarballs], {
    cwd: root, stdio: 'pipe',
  });
  for (const tarball of readdirSync(tarballs)) {
    const path = join(tarballs, tarball);
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }));
    const destination = join(modules, manifest.name);
    mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xzf', path, '--strip-components=1', '-C', destination]);
  }

  // Copy installed external dependencies, never the workspace libraries. Imports
  // and declarations below must resolve entirely from extracted tarballs.
  const copied = new Set();
  function copyExternal(name, sourceModules) {
    if (name.startsWith('@openmoq/') || copied.has(name)) return;
    const source = realpathSync(join(sourceModules, name));
    copied.add(name);
    const destination = join(modules, name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true });
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const local = join(source, 'node_modules');
      copyExternal(dependency, existsSync(join(local, dependency)) ? local : sourceModules);
    }
  }
  for (const { directory, manifest } of packages) {
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      copyExternal(name, join(root, 'packages', directory, 'node_modules'));
    }
  }

  const pairs = [];
  for (const { directory, manifest } of packages.filter(({ directory }) => directory.startsWith('compat-'))) {
    const packed = JSON.parse(readFileSync(join(modules, manifest.name, 'package.json'), 'utf8'));
    const [canonical] = Object.keys(manifest.dependencies);
    if (packed.dependencies[canonical] !== manifest.version) throw new Error(`${manifest.name}: dependency is not pinned to ${manifest.version}`);
    for (const subpath of Object.keys(manifest.exports)) {
      const suffix = subpath === '.' ? '' : subpath.slice(1);
      pairs.push([manifest.name + suffix, canonical + suffix]);
    }
  }
  if (pairs.length !== 21) throw new Error(`Expected 21 compatibility entry points, got ${pairs.length}`);
  writeFileSync(join(consumer, 'verify.mjs'), `
    import assert from 'node:assert/strict';
    const pairs = ${JSON.stringify(pairs)};
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    for (const [legacy, canonical] of pairs) {
      const old = await import(legacy);
      const current = await import(canonical);
      assert.deepEqual(Object.keys(old), Object.keys(current), legacy);
      for (const key of Object.keys(current)) assert.equal(old[key], current[key], legacy + ':' + key);
      try { await import(legacy + '/dist/internal.js'); assert.fail('deep import allowed'); }
      catch (error) { assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED'); }
    }
    assert.equal(warnings.length, 0, 'imports must not emit runtime warnings');
    const optionalMedia = await import('@openmoq/player/diagnostics');
    assert.equal(typeof optionalMedia.createMediaDiagnostics, 'function');
    assert.equal('createMediaDiagnostics' in (await import('@openmoq/player')), false);
    const standalone = await import('@openmoq/transport/trace-recorder');
    assert.equal(standalone.TraceRecorder, (await import('@openmoq/player')).TraceRecorder);
    assert.equal(standalone.TraceRecorder, (await import('@moqt/player')).TraceRecorder);
    const { DiagnosticCapture, DiagnosticRegistry, DiagnosticCarrier, installDiagnosticBridge } = await import('@openmoq/devtools');
    const { fixtureSource } = await import('@openmoq/devtools-protocol/fixtures');
    const { decodeMessage, decodeCarrierReply, encodeMessage, PROTOCOL_VERSION } = await import('@openmoq/devtools-protocol');
    const capture = new DiagnosticCapture({ source: fixtureSource, clock: { id: 'packed-clock', now: () => 1 } });
    const { lease } = capture.attach('packed-owner', 'attach');
    capture.dispose();
    const terminal = decodeMessage(lease.pull());
    assert.equal(terminal.ok && terminal.message.kind === 'batch' && terminal.message.events[0]?.fact.kind, 'source_state');
    lease.close();
    const registry = new DiagnosticRegistry();
    const observed = new DiagnosticCapture({ source: { ...fixtureSource, kind: 'attached' }, clock: { id: 'clock', now: () => 1 } });
    registry.register(observed);
    const carrier = new DiagnosticCarrier(registry.open('packed'), { now: () => 1 });
    const hello = decodeCarrierReply(carrier.start(encodeMessage({ channel: 'openmoq-devtools', version: PROTOCOL_VERSION,
      kind: 'discover', ownerId: 'packed', requestId: 'discover' })));
    assert.equal(hello.ok && hello.packet.kind, 'reply');
    assert.equal(observed.active, false);
    assert.equal(decodeCarrierReply(carrier.close()).ok, true);
    assert.equal(typeof installDiagnosticBridge, 'function');
    const { installPlayerDiagnostics } = await import('@openmoq/devtools/player');
    assert.equal(typeof installPlayerDiagnostics, 'function');
    assert.equal('installPlayerDiagnostics' in (await import('@openmoq/devtools')), false);
    const { MoqtPlayer } = await import('@openmoq/player');
    const engine = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: 'live' });
    const diagnostic = installPlayerDiagnostics(engine, { registry, exposure: 'production' });
    assert.equal(diagnostic.source.exposure, 'production');
    diagnostic.dispose(); await engine.destroy();
    registry.dispose();
  `);
  execFileSync(process.execPath, ['verify.mjs'], { cwd: consumer, stdio: 'inherit' });
  // Canonical browser bundles expose the root API but have no separate d.ts.
  // The wrappers deliberately expose the canonical root declarations there.
  writeFileSync(join(consumer, 'verify.ts'), pairs.map(([legacy, canonical], index) =>
    `import * as old${index} from '${legacy}';\nimport * as current${index} from '${canonical.split('/').length === 3 && canonical.endsWith('/browser') ? canonical.slice(0, -8) : canonical}';\n` +
    `const forward${index}: typeof current${index} = old${index};\nconst reverse${index}: typeof old${index} = current${index};\n`,
  ).join('\n') + `
    import { TraceRecorder as standaloneRecorder } from '@openmoq/transport/trace-recorder';
    import { TraceRecorder as playerRecorder } from '@openmoq/player';
    const recorderForward: typeof standaloneRecorder = playerRecorder;
    const recorderReverse: typeof playerRecorder = standaloneRecorder;
    import { DiagnosticCapture, DiagnosticRegistry, DiagnosticCarrier, installDiagnosticBridge } from '@openmoq/devtools';
    import type { CaptureLease } from '@openmoq/devtools';
    import { fixtureSource } from '@openmoq/devtools-protocol/fixtures';
    const capture = new DiagnosticCapture({ source: fixtureSource, clock: { id: 'packed-clock', now: () => 1 } });
    const captureLease: CaptureLease = capture.attach('packed-owner', 'attach').lease;
    const frames: readonly string[] = captureLease.refresh('refresh', { kind: 'source' });
    // @ts-expect-error Target identities are immutable to a host.
    captureLease.target.ownerId = 'other-owner';
    // @ts-expect-error An unknown fact must not silently become any through packed declarations.
    capture.emit({ kind: 'no-such-fact' }, 'dense');
    const registry = new DiagnosticRegistry();
    const connection = registry.open('typecheck');
    const carrier = new DiagnosticCarrier(connection, { now: () => 1 });
    const deadline: number | null = carrier.deadlineMs;
    const optionalBridge: typeof installDiagnosticBridge = installDiagnosticBridge;
    // @ts-expect-error A carrier clock is required, including through packed declarations.
    new DiagnosticCarrier(connection, {});
    // @ts-expect-error A port-bound connection's closed state is readonly.
    connection.closed = false;
    import { installPlayerDiagnostics } from '@openmoq/devtools/player';
    import { MoqtPlayer } from '@openmoq/player';
    import type { Player } from '@openmoq/playa';
    type AdapterIsAny<T> = 0 extends (1 & T) ? true : false;
    const adapterIsAny: AdapterIsAny<typeof installPlayerDiagnostics> = false;
    const adapterTargetIsAny: AdapterIsAny<Parameters<typeof installPlayerDiagnostics>[0]> = false;
    const engine = new MoqtPlayer({ url: 'https://relay.example/moq', namespace: 'live' });
    installPlayerDiagnostics(engine, { registry, exposure: 'production' });
    declare const facade: Player;
    installPlayerDiagnostics(facade, { registry, exposure: 'development' });
    // @ts-expect-error The packed target must expose the supported observation interface.
    installPlayerDiagnostics({}, { registry, exposure: 'production' });
    // @ts-expect-error Exposure is explicit through the packed subpath, including legacy resolution.
    installPlayerDiagnostics(engine, { registry });
    // @ts-expect-error An arbitrary string is not an exposure policy.
    installPlayerDiagnostics(engine, { registry, exposure: 'automatic' });

  `);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'verify.ts'],
  { cwd: consumer, stdio: 'inherit' });
  // Player typings previously worked with legacy Node resolution too. Its
  // re-export must not become unresolved (and silently any under skipLibCheck).
  writeFileSync(join(consumer, 'verify-player-legacy.ts'), `
    import { TraceRecorder as current } from '@openmoq/player';
    import { TraceRecorder as legacy } from '@moqt/player';
    type IsAny<T> = 0 extends (1 & T) ? true : false;
    const currentIsAny: IsAny<typeof current> = false;
    const legacyIsAny: IsAny<typeof legacy> = false;
    // @ts-expect-error Recorder options are required through the player export.
    new current({});
    // @ts-expect-error Recorder options are required through the legacy player export.
    new legacy({});
  `);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict',
    '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Node', 'verify-player-legacy.ts', 'verify.ts'],
  { cwd: consumer, stdio: 'inherit' });
  console.log(`${pairs.length} packed compatibility entry points: runtime identity and types pass`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
