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
import { assessVideoPresentation } from './presentation.mjs';
import { prepareFixture } from './fixture.mjs';
import { stopProcess as stop } from './shutdown.mjs';
import { checkExampleViews } from './view-ui.mjs';
import { checkHandover } from './handover.mjs';
import { checkRenditionSwitch } from './rendition-switch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const artifacts = resolve(root, 'reports/player-acceptance', runId);
const namespace = `acceptance-${randomUUID().slice(0, 8)}`;
const children = new Set();
const logs = [];
const abort = new AbortController();
const caseArg = process.argv.indexOf('--case');
const selectedCase = caseArg < 0 ? null : process.argv[caseArg + 1];
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

/**
 * Per-track first emitted decode time, parsed from a publisher's own output.
 * Empty when the publisher reports none (a non-CMAF fixture).
 */
function mediaOrigins(publisher) {
  return [...publisher.text.matchAll(
    /\[publisher\] (\S+): first group (\d+) tfdt (\d+) ticks @(\d+) Hz \(([\d.]+)s\)/g)]
    .map(([, track, group, ticks, timescale, seconds]) => ({
      track, group: Number(group), tfdtTicks: Number(ticks),
      timescale: Number(timescale), seconds: Number(seconds),
    }));
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
  result.fixtures.views = await prepareFixture(join(artifacts, 'views'), namespace, false, abort.signal, false, 'aac', true);
  result.fixtures.loc = await prepareFixture(join(artifacts, 'loc'), namespace, false, abort.signal, false, 'opus');
  result.fixtures.locViews = await prepareFixture(join(artifacts, 'locViews'), namespace, false, abort.signal, false, 'opus', true);
  result.fixtures.locFrozen = await prepareFixture(join(artifacts, 'locFrozen'), namespace, true, abort.signal, false, 'opus');
  result.fixtures.retimed = await prepareFixture(join(artifacts, 'retimed'), namespace, false, abort.signal, false, 'aac', false,
    { videoTimescale: 60000 });
  assert.notEqual(result.fixtures.moving.timing['video-360'].timescale, result.fixtures.retimed.timing['video-360'].timescale,
    'Replacement video must exercise a different initialization timescale');
  for (const [name, caseName, lowLevel, lowCodec] of [
    ['switching', 'cmaf-manual-rendition-switch', '4.0', 'avc1.42c028'],
    ['retyping', 'cmaf-manual-avc-level-switch', '3.0', 'avc1.42c01e'],
  ]) {
    if (selectedCase !== null && selectedCase !== caseName) continue;
    result.fixtures[name] = await prepareFixture(join(artifacts, name), namespace, false, abort.signal, true, 'aac', false,
      { tracks: { 'video-360': { trackId: 1, videoTimescale: 12288, videoLevel: lowLevel, expectedCodec: lowCodec },
        'video-720': { trackId: 3, videoTimescale: 60000, videoLevel: '4.0', expectedCodec: 'avc1.42c028' },
        'video-1080': { trackId: 4, videoTimescale: 90000, videoLevel: '4.0', expectedCodec: 'avc1.42c028' } } });
    const fixture = result.fixtures[name];
    assert.deepEqual(['video-360', 'video-720', 'video-1080'].map(name => fixture.headers[name]), [
      { trackId: 1, timescale: 12288, codecFourcc: 'avc1', codec: lowCodec },
      { trackId: 3, timescale: 60000, codecFourcc: 'avc1', codec: 'avc1.42c028' },
      { trackId: 4, timescale: 90000, codecFourcc: 'avc1', codec: 'avc1.42c028' },
    ]);
    assert.equal(new Set(['video-360', 'video-720', 'video-1080'].map(name => fixture.sha256[`${name}/init.mp4`])).size, 3,
      'Renditions must have distinct actual initialization bytes');
    assert.deepEqual(fixture.expected.videos.map(track => track.altGroup), [1, 1, 1]);
  }
  browser = await chromium.launch({ channel: process.env.PLAYER_TEST_BROWSER ?? 'chrome' });
  result.platform.browser = browser.version();
  const vite = launch('vite', process.execPath, ['_tests/player-acceptance/serve.mjs'], {}, join(root, 'examples'));
  const webUrl = await waitForLine(vite, /Acceptance page: (http:\/\/127\.0\.0\.1:\d+\/)/);
  const scenarios = [
    { name: 'moving-video-and-audio', fixture: 'moving', silent: false, expectedFailure: null },
    { name: 'cmaf-manual-rendition-switch', fixture: 'switching', startLoop: 3, manualSwitch: true,
      silent: false, expectedFailure: null },
    { name: 'cmaf-manual-avc-level-switch', fixture: 'retyping', startLoop: 3, manualSwitch: true, nativeRetypes: true,
      silent: false, expectedFailure: null },
    { name: 'frozen-picture-control', fixture: 'frozen', silent: false, expectedFailure: 'picture-frozen' },
    { name: 'missing-audio-control', fixture: 'moving', silent: true, expectedFailure: 'audio-missing' },
    { name: 'cmaf-handover', fixture: 'moving', handover: 'accept', silent: false, expectedFailure: null },
    { name: 'cmaf-handover-reconfigured', fixture: 'moving', replacementFixture: 'retimed', handover: 'accept', silent: false, expectedFailure: null },
    { name: 'cmaf-handover-nonzero-epoch', fixture: 'moving', replacementFixture: 'retimed', startLoop: 3,
      handover: 'accept', silent: false, expectedFailure: null },
    { name: 'cmaf-handover-refused', fixture: 'moving', handover: 'reject', silent: false, expectedFailure: null },
    { name: 'cmaf-handover-catalog-timeout', fixture: 'moving', handover: 'catalog-timeout', silent: false, expectedFailure: null },
    { name: 'loc-handover', fixture: 'loc', handover: 'accept', version: 4, mode: 'media', silent: false, expectedFailure: null,
      expected: { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: 'canvas' } },
    { name: 'default-video-view', fixture: 'views', view: 1, silent: false, expectedFailure: null,
      expected: { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24 } },
    { name: 'portrait-video-view', fixture: 'views', view: 0, altGroup: 0, silent: false, expectedFailure: null,
      expected: { videoWidth: 360, videoHeight: 640, audioHz: 440, videoFps: 24 } },
    { name: 'portrait-loc-video-view', fixture: 'locViews', view: 0, altGroup: 0, version: 4, mode: 'media', silent: false, expectedFailure: null,
      expected: { videoWidth: 360, videoHeight: 640, audioHz: 440, videoFps: 24, outputKind: 'canvas' } },
    { name: 'example-views-cmaf', fixture: 'views', exampleViews: true, silent: false, expectedFailure: null },
    { name: 'example-views-loc', fixture: 'locViews', exampleViews: true, version: 4, mode: 'media', silent: false, expectedFailure: null },
    ...['video', 'audio'].map(cmafRole => ({
      name: `mixed-cmaf-${cmafRole}`, fixture: 'moving', mixed: cmafRole, silent: false, expectedFailure: null,
      expected: { videoWidth: 640, videoHeight: 360, audioHz: 440, videoFps: 24, outputKind: cmafRole === 'video' ? 'video' : 'canvas' },
    })),
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
  if (caseArg >= 0 && !scenarios.some((s) => s.name === selectedCase)) throw new Error(`Unknown playback case: ${selectedCase}`);
  result.selectedCase = selectedCase;
  for (const scenario of scenarios.filter((s) => selectedCase === null || s.name === selectedCase)) {
    const relay = launch(`${scenario.name}-relay`, 'pnpm', scenario.handover
      ? ['--filter', '@moqt/example-node-relay', 'exec', 'tsx', '../../scripts/player-acceptance/handover-relays.ts',
          ...(scenario.handover === 'reject' ? ['--reject-audio'] : []),
          ...(scenario.handover === 'catalog-timeout' ? ['--hold-catalog'] : [])]
      : ['--filter', '@moqt/example-node-relay', 'relay-server'],
      { HOST: '127.0.0.1', PORT: '0', DEMO_NAMESPACE: namespace, RELAY_CERT: relayCert, RELAY_KEY: relayKey,
        ...(scenario.view !== undefined || scenario.exampleViews ? { DEMO_TRACK: 'video-portrait' } : {}) });
    const handover = scenario.handover ? JSON.parse(await waitForLine(relay, /handover-ready: (.+)/)) : null;
    const relayUrl = handover?.source ?? await waitForLine(relay, /listening on (https:\/\/127\.0\.0\.1:\d+\/moq)/);
    // `startLoop` applies to BOTH publishers: a later media origin is a
    // property of the presentation, not of one relay. Offsetting only the
    // source would also put the replacement's live point 18 s behind, which
    // is a second condition and would stop the case isolating anything.
    const startLoopArgs = scenario.startLoop ? ['--start-loop', String(scenario.startLoop)] : [];
    const startPublisher = (name, relayUrl, fixture = scenario.fixture) => scenario.mixed ? launch(name, process.execPath, [
      'scripts/player-acceptance/mixed-publisher.mjs', relayUrl, join(artifacts, 'moving'), join(artifacts, 'loc'), scenario.mixed,
    ], { RELAY_CERT: relayCert }) : launch(name, 'pnpm', scenario.version ? [
      '--filter', '@moqt/example-node-publisher', 'exec', 'tsx', 'src/publish-loc.ts',
      relayUrl, join(artifacts, fixture), String(scenario.version), scenario.mode,
    ] : [
      '--filter', '@moqt/example-node-publisher', 'publish-fixture', '--loop', '--pace-media', '--catalog-format', 'cmsf-01',
      ...(scenario.locmaf ? ['--packaging', 'locmaf'] : []), ...startLoopArgs,
      relayUrl, join(artifacts, fixture),
    ], { RELAY_CERT: relayCert });
    const publisher = startPublisher(`${scenario.name}-publisher`, relayUrl);
    const replacementPublisher = handover
      ? startPublisher(`${scenario.name}-replacement-publisher`, handover.target, scenario.replacementFixture ?? scenario.fixture) : null;
    await waitForLine(publisher, /loop mode: (\d+ tracks established)/);
    if (replacementPublisher) await waitForLine(replacementPublisher, /loop mode: (\d+ tracks established)/);
    if ((scenario.version || scenario.mixed === 'audio') && scenario.expected) {
      const epochUs = await waitForLine(publisher, /epoch_us=(\d+)/);
      scenario.expected.timestampDomain = scenario.mode ?? 'media';
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
    const httpErrors = [];
    let httpErrorCount = 0;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => consoleLines.push({ type: message.type(), text: message.text(), location: message.location() }));
    page.on('response', (response) => {
      if (response.status() < 400) return;
      httpErrorCount++;
      if (httpErrors.length < 32) httpErrors.push({ url: response.url(), status: response.status() });
    });
    const caseResult = { name: scenario.name, expectedFailure: scenario.expectedFailure, relayUrl, passed: false };
    // The decode time each publisher actually emits FIRST, read back from the
    // bytes it is about to send. A relay's group-replay log identifies the
    // iteration; this is the media timing that goes with it, which is what a
    // nonzero-origin case has to establish.
    if (scenario.startLoop !== undefined) {
      caseResult.startLoop = scenario.startLoop;
      caseResult.mediaOrigin = {
        source: mediaOrigins(publisher),
        ...(replacementPublisher ? { replacement: mediaOrigins(replacementPublisher) } : {}),
      };
    }
    caseResult.media = scenario.version ? { packaging: 'loc', version: scenario.version, timestamps: scenario.mode,
      video: 'H.264', audio: 'Opus', output: 'canvas/Web Audio', properties: 'd18-delta-vi64' }
      : { packaging: scenario.locmaf ? 'locmaf' : 'cmaf', video: 'H.264', audio: 'AAC',
          output: scenario.locmaf === 'frame' ? 'canvas/Web Audio' : 'MSE',
          ...(scenario.locmaf ? { locmafVersion: '0.3', decoding: scenario.locmaf } : {}) };
    result.cases.push(caseResult);
    try {
      if (scenario.manualSwitch) {
        const origins = caseResult.mediaOrigin.source;
        for (const track of ['video-360', 'video-720', 'video-1080', 'audio-en']) {
          const origin = origins.find(origin => origin.track === track);
          assert.ok(origin?.seconds >= 18 && origin.group === 3, `${track}: missing nonzero emitted media origin`);
          assert.equal(origin.timescale, result.fixtures[scenario.fixture].headers[track].timescale, `${track}: published timescale changed`);
        }
      }
      const query = new URLSearchParams({ url: relayUrl, ns: namespace, hash: pin });
      if (scenario.manualSwitch) {
        query.set('nativeMse', '1');
        if (process.argv.includes('--debug')) query.set('debug', 'mse');
      }
      if (scenario.handover) query.set('debug', 'handover');
      if (scenario.version) { query.set('output', 'canvas'); query.set('debug', 'render'); }
      if (scenario.mixed) {
        query.set('audio', scenario.mixed === 'video' ? 'webcodecs' : 'mse');
        query.set('gestureAudio', '1');
        if (scenario.mixed === 'audio') query.set('output', 'canvas');
        caseResult.media = { video: scenario.mixed === 'video' ? 'CMAF/H.264' : 'LOC-04/H.264',
          audio: scenario.mixed === 'video' ? 'LOC-04/Opus' : 'CMAF/AAC', audioActivation: 'gesture' };
      }
      if (scenario.locmaf) {
        query.set('locmaf', scenario.locmaf);
        if (scenario.locmaf === 'frame') query.set('output', 'canvas');
      }
      if (scenario.expected) {
        caseResult.expected = scenario.expected;
      }
      if (scenario.alternatives) { query.set('level', String(scenario.level)); query.set('lang', scenario.lang); }
      if (scenario.altGroup !== undefined) query.set('altGroup', String(scenario.altGroup));
      if (scenario.exampleViews) {
        caseResult.observed = await checkExampleViews(page, webUrl, query, artifacts, scenario.name, Boolean(scenario.version));
        caseResult.assessment = { passed: true, failures: [] };
      } else {
        await page.goto(`${webUrl}_tests/player-acceptance/?${query}`, { waitUntil: 'domcontentloaded' });
        await page.locator('#start').click();
        const startupStart = performance.now();
        await page.waitForFunction(() => {
          const state = window.playerAcceptance;
          if (state?.startupError) throw new Error(state.startupError);
          return state?.presentedFrames >= 8 && state.currentTime > 0.1 && state.audioRms > 0.015;
        }, null, { timeout: 20000 });
        caseResult.outputReadyAfterMs = performance.now() - startupStart;
        let observed;
        if (scenario.manualSwitch) {
          caseResult.renditionSwitch = {};
          observed = await checkRenditionSwitch(page, caseResult.renditionSwitch, bounded, Boolean(scenario.nativeRetypes));
        } else if (handover) {
          caseResult.handover = {};
          await checkHandover(page, handover.control, scenario.expected, scenario.handover, caseResult.handover,
            { timelineContinuity: scenario.startLoop !== undefined });
          observed = caseResult.handover.after;
        } else {
          await page.evaluate((silent) => window.playerAcceptance.begin(silent), scenario.silent);
          await page.waitForTimeout(7250);
          observed = await page.evaluate(() => window.playerAcceptance.finish());
        }
        caseResult.observed = observed;
        caseResult.assessment = scenario.manualSwitch ? caseResult.renditionSwitch.continuity : assessPlayback(observed.samples, scenario.expected);
        caseResult.presentationFailures = assessVideoPresentation(observed.samples);
        assert.deepEqual(caseResult.presentationFailures, [], 'Public video draw observation');
        if (scenario.expected?.outputKind === 'canvas') {
          assert.ok(observed.decodedSource?.matched > 0, 'No decoded source timestamp evidence');
          assert.deepEqual(observed.decodedSource.failures, [], 'Decoded source timestamp correlation');
        } else assert.equal(observed.decodedSource, null, 'MSE must not claim WebCodecs output evidence');
        if (scenario.locmaf) assert.deepEqual(observed.locmafFailures, [], 'Browser did not receive the required LOCMAF catalog/full/delta/group mapping');
        if (scenario.view !== undefined) {
          assert.deepEqual(observed.videoGroups.map(g => g.altGroup), [1, 0]);
          assert.deepEqual(observed.levels.map(level => level.trackName), [scenario.view === 0 ? 'video-portrait' : 'video-360']);
          const otherView = { ...scenario.expected,
            videoWidth: scenario.view === 0 ? 640 : 360, videoHeight: scenario.view === 0 ? 360 : 640 };
          caseResult.identityControls = { otherView: assessPlayback(observed.samples, otherView) };
          assert.deepEqual(caseResult.identityControls.otherView.failures, ['video-identity']);
        }
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
        if (scenario.mixed) {
          const rms = async () => {
            await page.waitForTimeout(250);
            const values = [];
            for (let i = 0; i < 8; i++) {
              values.push(await page.evaluate(() => window.playerAcceptance.audioRms));
              await page.waitForTimeout(100);
            }
            return values.reduce((sum, value) => sum + value, 0) / values.length;
          };
          const full = await rms();
          await page.evaluate(() => window.playerAcceptance.setVolume(0.25));
          const quarter = await rms();
          await page.evaluate(() => window.playerAcceptance.setMuted(true));
          const duringMute = () => page.evaluate(() => {
            const video = document.querySelector('#video');
            return { frames: window.playerAcceptance.presentedFrames, audioTime: video.currentTime, audioPaused: video.paused };
          });
          const beforeMute = await duringMute();
          const muted = await rms();
          const afterMute = await duringMute();
          await page.evaluate(() => window.playerAcceptance.setMuted(false));
          const unmuted = await rms();
          caseResult.volume = { full, quarter, muted, unmuted,
            framesDuringMute: afterMute.frames - beforeMute.frames, beforeMute, afterMute };
          assert.ok(full > 0.015 && quarter / full > 0.15 && quarter / full < 0.35, 'Player volume must attenuate the actual audio output');
          assert.ok(muted < 0.001 && unmuted > 0.005, 'Mute/unmute must affect the actual audio output');
          assert.ok(unmuted / quarter > 0.8 && unmuted / quarter < 1.2, 'Unmute must preserve the selected volume');
          assert.ok(afterMute.frames - beforeMute.frames >= 16, 'Video must keep advancing while muted');
          if (scenario.mixed === 'audio') {
            assert.ok(!beforeMute.audioPaused && !afterMute.audioPaused
              && afterMute.audioTime - beforeMute.audioTime > 0.75, 'MSE audio must keep advancing while muted');
          }
        }
        await page.screenshot({ path: join(artifacts, `${scenario.name}.png`) });
        caseResult.teardown = await bounded(page.evaluate(() => window.playerAcceptance.destroy()), 5000, 'player teardown');
        assert.equal(caseResult.teardown.transports, handover ? 2 : 1, 'Unexpected established transport count');
        assert.ok(caseResult.teardown.transportOutcomes.every((outcome) => outcome.status === 'closed'), 'Transport did not close cleanly');
        assert.equal(caseResult.teardown.audioState, 'closed', 'Observer AudioContext leaked');
        assert.ok(!caseResult.teardown.videoSource, 'MediaSource URL remained attached');
        assert.equal(caseResult.teardown.state, 'idle', 'Player did not return to idle');
      }
      assert.deepEqual(pageErrors, [], 'Uncaught browser error');
      if (scenario.manualSwitch) {
        assert.deepEqual(consoleLines.filter(line => line.type === 'error'), [], 'Native Chrome console error');
        assert.equal(httpErrorCount, 0, `HTTP errors: ${JSON.stringify(httpErrors)}`);
      }
      if (!scenario.exampleViews) {
        const errors = caseResult.teardown.events.filter(event => event.type === 'error');
        if (scenario.handover && scenario.handover !== 'accept') {
          assert.deepEqual(errors, caseResult.handover.after.events.filter(event => event.type === 'error'), 'Additional error during teardown');
        } else assert.deepEqual(errors, [], 'Player emitted an error, including during teardown');
      }
      assert.ok(!relay.exited && !publisher.exited && !replacementPublisher?.exited, 'Media process exited before test teardown');
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
      caseResult.httpErrors = { total: httpErrorCount, responses: httpErrors, truncated: Math.max(0, httpErrorCount - httpErrors.length) };
      await writeFile(join(artifacts, `${scenario.name}-console.json`), JSON.stringify(consoleLines, null, 2));
      try {
        await bounded(context.close(), 5000, 'browser context close', false);
        assert.deepEqual(pageErrors, [], 'Uncaught browser error during context shutdown');
        await stop(publisher);
        if (replacementPublisher) await stop(replacementPublisher);
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
