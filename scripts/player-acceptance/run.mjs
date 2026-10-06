import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { assessPlayback } from './assessment.mjs';
import { prepareFixture } from './fixture.mjs';
import { stopProcess as stop } from './shutdown.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const artifacts = resolve(root, 'reports/player-acceptance', runId);
const namespace = `acceptance-${randomUUID().slice(0, 8)}`;
const children = new Set();
const logs = [];
const abort = new AbortController();
const onInterrupt = () => abort.abort(new Error('Playback test interrupted'));
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);

function bounded(promise, ms, label, interruptible = true) {
  return new Promise((res, rej) => {
    const settle = (callback, value) => { cleanup(); callback(value); };
    const timer = setTimeout(() => settle(rej, new Error(`${label} did not settle within ${ms}ms`)), ms);
    const cancelled = () => settle(rej, abort.signal.reason);
    if (interruptible) abort.signal.addEventListener('abort', cancelled, { once: true });
    const cleanup = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); };
    if (interruptible && abort.signal.aborted) cancelled();
    promise.then((value) => settle(res, value), (error) => settle(rej, error));
  });
}

function launch(name, command, args, env = {}, cwd = root) {
  const log = createWriteStream(join(artifacts, `${name}.log`));
  logs.push(log);
  const child = spawn(command, args, {
    cwd, env: { ...process.env, ...env }, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, text: '', exited: false, exitCode: null, exitSignal: null, failure: null, log };
  children.add(state);
  for (const output of [child.stdout, child.stderr]) output.on('data', (bytes) => {
    log.write(bytes);
    state.text = (state.text + bytes.toString()).slice(-65536);
  });
  state.done = new Promise((res) => {
    child.once('error', (error) => { state.failure = error.message; state.exited = true; res(-1); });
    child.once('close', (code, signal) => {
      state.exitCode = code;
      state.exitSignal = signal;
      state.exited = true;
      res(code);
    });
  });
  return state;
}

async function command(name, executable, args) {
  const state = launch(name, executable, args);
  const code = await bounded(state.done, 120000, name);
  if (code !== 0) throw new Error(`${name}: exit=${code} ${state.failure ?? ''}\n${state.text.slice(-4000)}`);
  return state.text.trim();
}

async function recordSource() {
  const git = (args) => promisify(execFile)('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const { stdout: listed } = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const files = [];
  for (const path of [...new Set(listed.split('\0').filter(Boolean))].sort()) {
    try {
      files.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files.push({ path, deleted: true });
    }
  }
  const manifest = `${JSON.stringify(files, null, 2)}\n`;
  await writeFile(join(artifacts, 'source-files.json'), manifest);
  const { stdout: patch } = await git(['diff', 'HEAD', '--binary']);
  await writeFile(join(artifacts, 'source.patch'), patch);
  return { manifestSha256: createHash('sha256').update(manifest).digest('hex'), files: files.length };
}

async function waitForLine(state, pattern) {
  let timer;
  try {
    return await bounded(new Promise((res, rej) => {
      timer = setInterval(() => {
        const match = pattern.exec(state.text);
        if (match) res(match[1]);
        else if (state.exited) rej(new Error(`Server exited: ${state.failure}\n${state.text}`));
      }, 50);
    }), 20000, 'server startup');
  } finally { clearInterval(timer); }
}

let browser;
const result = { runId, source: {}, platform: { os: process.platform, arch: process.arch, node: process.version },
  transport: { kind: 'WebTransport over local QUIC', draft: 18, namespace },
  media: { catalog: 'MSF/CMSF-01', packaging: ['cmaf', 'loc', 'locmaf'], video: 'H.264', audio: ['AAC', 'Opus'], paths: ['MSE', 'canvas/Web Audio'] },
  audioEvidence: '440/880 Hz post-gain PCM in the browser output graph; physical speakers not measured',
  fixtures: {}, cases: [], passed: false, errors: [] };
await mkdir(artifacts, { recursive: true });
console.log(`Playback evidence: ${artifacts}`);

try {
  result.source.sha = await command('source', 'git', ['rev-parse', 'HEAD']);
  result.source.dirty = (await command('status', 'git', ['status', '--porcelain'])).length > 0;
  Object.assign(result.source, await recordSource());
  if (!process.argv.includes('--skip-build')) {
    await command('build', 'pnpm', ['--filter', '@openmoq/playa...', '--filter', '@moqt/example-node-publisher...', 'build']);
  }
  const certDir = join(artifacts, 'certs');
  await command('certificate', process.execPath, ['examples/node-relay/scripts/gen-cert.mjs', '--out-dir', certDir]);
  const relayCert = join(certDir, 'cert.pem');
  const relayKey = join(certDir, 'key.pem');
  const cert = new X509Certificate(await readFile(relayCert));
  const pin = cert.fingerprint256.replaceAll(':', '').toLowerCase();
  result.transport.serverCertificateSha256 = pin;
  for (const frozen of [false, true]) {
    const name = frozen ? 'frozen' : 'moving';
    result.fixtures[name] = await prepareFixture(join(artifacts, name), namespace, frozen, abort.signal);
  }
  result.fixtures.alternatives = await prepareFixture(join(artifacts, 'alternatives'), namespace, false, abort.signal, true);
  result.fixtures.loc = await prepareFixture(join(artifacts, 'loc'), namespace, false, abort.signal, false, 'opus');
  result.fixtures.locFrozen = await prepareFixture(join(artifacts, 'locFrozen'), namespace, true, abort.signal, false, 'opus');
  browser = await chromium.launch({ channel: process.env.PLAYER_TEST_BROWSER ?? 'chrome' });
  result.platform.browser = browser.version();
  const vite = launch('vite', process.execPath, ['_tests/player-acceptance/serve.mjs'], {}, join(root, 'examples'));
  const webUrl = await waitForLine(vite, /Acceptance page: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const scenarios = [
    { name: 'moving-video-and-audio', fixture: 'moving', silent: false, expectedFailure: null },
    { name: 'frozen-picture-control', fixture: 'frozen', silent: false, expectedFailure: 'picture-frozen' },
    { name: 'missing-audio-control', fixture: 'moving', silent: true, expectedFailure: 'audio-missing' },
    ...[360, 720, 1080].flatMap((height, index) => ['en', 'es'].map((lang) => ({
      name: `${height}p-${lang}-selection`, fixture: 'alternatives', silent: false, expectedFailure: null,
      level: 2 - index, lang, alternatives: true,
      expected: { videoWidth: height * 16 / 9, videoHeight: height, audioHz: lang === 'en' ? 440 : 880, videoFps: 24 },
    }))),
    ...[{ version: 1, mode: 'wall-clock' }, { version: 4, mode: 'wall-clock' }, { version: 4, mode: 'media' }].map(({ version, mode }) => ({
      name: `loc-${version}-${mode}`, fixture: 'loc', silent: false, expectedFailure: null, version, mode,
      expected: { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: 'canvas' },
    })),
    { name: 'loc-frozen-picture-control', fixture: 'locFrozen', silent: false, expectedFailure: 'picture-frozen', version: 4, mode: 'media',
      expected: { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: 'canvas' } },
    { name: 'loc-missing-audio-control', fixture: 'loc', silent: true, expectedFailure: 'audio-missing', version: 4, mode: 'media',
      expected: { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: 'canvas' } },
    ...['mse', 'frame'].flatMap((decoding) => [
      { name: `locmaf-${decoding}`, fixture: 'moving', silent: false, expectedFailure: null },
      { name: `locmaf-${decoding}-frozen-picture-control`, fixture: 'frozen', silent: false, expectedFailure: 'picture-frozen' },
      { name: `locmaf-${decoding}-missing-audio-control`, fixture: 'moving', silent: true, expectedFailure: 'audio-missing' },
    ].map((scenario) => ({ ...scenario, locmaf: decoding,
      expected: { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: decoding === 'frame' ? 'canvas' : 'video' },
    }))),
  ];
  const caseArg = process.argv.indexOf('--case');
  const selectedCase = caseArg < 0 ? null : process.argv[caseArg + 1];
  if (caseArg >= 0 && !scenarios.some((s) => s.name === selectedCase)) throw new Error(`Unknown playback case: ${selectedCase}`);
  result.selectedCase = selectedCase;
  for (const scenario of scenarios.filter((s) => selectedCase === null || s.name === selectedCase)) {
    const relay = launch(`${scenario.name}-relay`, 'pnpm', ['--filter', '@moqt/example-node-relay', 'relay-server'],
      { HOST: '127.0.0.1', PORT: '0', DEMO_NAMESPACE: namespace, RELAY_CERT: relayCert, RELAY_KEY: relayKey });
    const relayUrl = await waitForLine(relay, /listening on (https:\/\/127\.0\.0\.1:\d+\/moq)/);
    const publisher = launch(`${scenario.name}-publisher`, 'pnpm', scenario.version ? [
      '--filter', '@moqt/example-node-publisher', 'exec', 'tsx', 'src/publish-loc.ts',
      relayUrl, join(artifacts, scenario.fixture), String(scenario.version), scenario.mode,
    ] : [
      '--filter', '@moqt/example-node-publisher', 'publish-fixture', '--loop', '--pace-media', '--catalog-format', 'cmsf-01',
      ...(scenario.locmaf ? ['--packaging', 'locmaf'] : []),
      relayUrl, join(artifacts, scenario.fixture),
    ], { RELAY_CERT: relayCert });
    await waitForLine(publisher, /loop mode: (\d+ tracks established)/);
    if (scenario.version) {
      const epochUs = await waitForLine(publisher, /epoch_us=(\d+)/);
      scenario.expected.timestampDomain = scenario.mode;
      scenario.expected.publisherEpochMs = Number(epochUs) / 1000;
    }
    if (scenario.locmaf === 'frame') {
      scenario.expected.timestampDomain = 'media';
      scenario.expected.publisherEpochMs = Number(await waitForLine(publisher, /media epoch_ms=(\d+)/));
    }
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleLines = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => consoleLines.push({ type: message.type(), text: message.text() }));
    const caseResult = { name: scenario.name, expectedFailure: scenario.expectedFailure, relayUrl, passed: false };
    caseResult.media = scenario.version ? { packaging: 'loc', version: scenario.version, timestamps: scenario.mode,
      video: 'H.264', audio: 'Opus', output: 'canvas/Web Audio', properties: 'd18-delta-vi64' }
      : { packaging: scenario.locmaf ? 'locmaf' : 'cmaf', video: 'H.264', audio: 'AAC',
          output: scenario.locmaf === 'frame' ? 'canvas/Web Audio' : 'MSE',
          ...(scenario.locmaf ? { locmafVersion: '0.3', decoding: scenario.locmaf } : {}) };
    result.cases.push(caseResult);
    try {
      const query = new URLSearchParams({ url: relayUrl, ns: namespace, hash: pin });
      if (scenario.version) { query.set('output', 'canvas'); query.set('debug', 'render'); }
      if (scenario.locmaf) {
        query.set('locmaf', scenario.locmaf);
        if (scenario.locmaf === 'frame') query.set('output', 'canvas');
      }
      if (scenario.expected) {
        caseResult.expected = scenario.expected;
      }
      if (scenario.alternatives) { query.set('level', String(scenario.level)); query.set('lang', scenario.lang); }
      await page.goto(`${webUrl}_tests/player-acceptance/?${query}`, { waitUntil: 'domcontentloaded' });
      await page.locator('#start').click();
      const startupStart = performance.now();
      await page.waitForFunction(() => {
        const state = window.playerAcceptance;
        if (state?.startupError) throw new Error(state.startupError);
        return state?.presentedFrames >= 8 && state.currentTime > 0.1 && state.audioRms > 0.015;
      }, null, { timeout: 20000 });
      caseResult.outputReadyAfterMs = performance.now() - startupStart;
      await page.evaluate((silent) => window.playerAcceptance.begin(silent), scenario.silent);
      await page.waitForTimeout(7250);
      const observed = await page.evaluate(() => window.playerAcceptance.finish());
      caseResult.observed = observed;
      caseResult.assessment = assessPlayback(observed.samples, scenario.expected);
      if (scenario.locmaf) assert.deepEqual(observed.locmafFailures, [], 'Browser did not receive the required LOCMAF catalog/full/delta/group mapping');
      if (scenario.alternatives) {
        assert.deepEqual(observed.levels.map((level) => level.trackName), ['video-1080', 'video-720', 'video-360']);
        assert.deepEqual(observed.audioTracks.map((track) => track.language), ['en', 'es']);
        const wrongVideo = { ...scenario.expected, videoHeight: scenario.expected.videoHeight === 360 ? 720 : 360,
          videoWidth: scenario.expected.videoHeight === 360 ? 1280 : 640 };
        const wrongAudio = { ...scenario.expected, audioHz: scenario.expected.audioHz === 440 ? 880 : 440 };
        caseResult.identityControls = {
          wrongVideo: assessPlayback(observed.samples, wrongVideo),
          wrongAudio: assessPlayback(observed.samples, wrongAudio),
        };
        assert.deepEqual(caseResult.identityControls.wrongVideo.failures, ['video-identity']);
        assert.deepEqual(caseResult.identityControls.wrongAudio.failures, ['audio-identity']);
      }
      await page.screenshot({ path: join(artifacts, `${scenario.name}.png`) });
      caseResult.teardown = await bounded(page.evaluate(() => window.playerAcceptance.destroy()), 5000, 'player teardown');
      assert.equal(caseResult.teardown.transports, 1, 'Expected one established transport');
      assert.ok(caseResult.teardown.transportOutcomes.every((outcome) => outcome.status === 'closed'), 'Transport did not close cleanly');
      assert.equal(caseResult.teardown.audioState, 'closed', 'Observer AudioContext leaked');
      assert.ok(!caseResult.teardown.videoSource, 'MediaSource URL remained attached');
      assert.equal(caseResult.teardown.state, 'idle', 'Player did not return to idle');
      assert.deepEqual(pageErrors, [], 'Uncaught browser error');
      assert.ok(!caseResult.teardown.events.some((event) => event.type === 'error'), 'Player emitted an error, including during teardown');
      assert.ok(!relay.exited && !publisher.exited, 'Media process exited before test teardown');
      if (scenario.expectedFailure) {
        assert.deepEqual(caseResult.assessment.failures, [scenario.expectedFailure], 'Control must fail only its intended output check');
      } else assert.equal(caseResult.assessment.passed, true, `Playback failed: ${caseResult.assessment.failures.join(', ')}`);
    } catch (error) {
      caseResult.error = error.message;
      await page.screenshot({ path: join(artifacts, `${scenario.name}-failure.png`) }).catch(() => {});
      caseResult.observed ??= await page.evaluate(() => window.playerAcceptance?.finish()).catch(() => null);
      throw error;
    } finally {
      caseResult.pageErrors = pageErrors;
      await writeFile(join(artifacts, `${scenario.name}-console.json`), JSON.stringify(consoleLines, null, 2));
      try {
        await bounded(context.close(), 5000, 'browser context close', false);
        assert.deepEqual(pageErrors, [], 'Uncaught browser error during context shutdown');
        await stop(publisher);
        await stop(relay);
      } catch (error) {
        caseResult.error ??= error.message;
        throw error;
      }
    }
    caseResult.passed = true;
    console.log(`PASS ${scenario.name}: ${caseResult.assessment.failures.join(', ') || 'healthy output'}`);
  }
  result.passed = true;
} catch (error) {
  result.errors.push(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  if (browser) await bounded(browser.close(), 5000, 'browser close', false)
    .catch((error) => { result.errors.push(error.message); process.exitCode = 1; });
  for (const child of children) {
    try { await stop(child); } catch (error) { result.errors.push(error.message); process.exitCode = 1; }
  }
  for (const log of logs) { log.end(); await once(log, 'finish'); }
  result.passed &&= result.errors.length === 0;
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
}
if (!result.passed) console.error(result.errors.join('\n'));
