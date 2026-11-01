// LIVE PLAYER gate, local only: a REAL Playa player (the `@openmoq/playa`
// facade) plays this repo's fixtures through the toy relay on loopback, with
// diagnostics installed EXPLICITLY by the page (`installPlayerDiagnostics` +
// `installDiagnosticBridge`); the SHIPPED extension attaches to that page in a
// real DevTools window and the panel shows the live session, tracks and
// requests, real object cells, the metrics the adapter reports, and records and
// downloads a `.moqtrace` that is read back from disk.
//
// Arms (default all three): `cmaf` (CMAF over MSE into <video>), `locmaf-mse`
// (LOCMAF objects, MSE decoding into <video>) and `loc` (LOC-04, media timing,
// the genuine WebCodecs/canvas frame path; no media element is observed).
// `--production` runs ONE minified production-built CMAF arm instead
// (`vite build` of the same page, `exposure: 'production'`), so source
// regressions and production bundling failures stay attributable.
//
// Evidence rules: MSE arms must show INCREASING real `requestVideoFrameCallback`
// presented frames and media time; the LOC arm must show advancing engine
// rendered frames and `Player.videoPresentation.renderedAtUs` on a visible
// canvas. Detach is proven by progress AFTER detach on the same evidence, not
// by a state string. Fact↔cell identity and the saved file are compared exactly.
//
// Identity: the served BACKEND sources (packages/*/src without tests, the
// relay/publisher examples, the fixture generator, `examples/vite.config.ts`
// and this page) are fingerprinted before and after all arms; a change fails
// the run. Browser: Playwright's pinned Chromium by default; the optional
// `PLAYA_DEVTOOLS_LIVE_BROWSER` environment variable names a codec-capable
// executable (Linux Playwright Chromium has no H.264/AAC). A codec preflight in
// the page fails fast and names the missing codec rather than timing out.
//
// Not proven: media correctness/presentation quality (player acceptance
// harness), the native permission prompt (labelled pre-granted test build),
// any public relay. Requirements: built extension; `pnpm install`; ffmpeg on
// PATH (the LOC arm needs an Opus fixture; CMAF/LOCMAF use
// examples/node-publisher/fixtures/test-pattern when present).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { access, cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { openPlayaPanel } from './devtools-frontend.mjs';
import { recordedFacts, stageCorrelation, locCorrelation, cellVerdict, stageSnapshotProblems, recordedUnit, recordingCut, chainAfterCut } from './trace-facts.mjs';
import { countFacts, frameMeta, validateFactCounterWitness } from './fact-counter.mjs';
import { reportedElementMetrics } from './element-metrics.mjs';
import { createNativeClick } from './native-click.mjs';
import { readLiveSnapshot, waitForLiveSnapshot, playbackStarted } from './live-snapshot.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..');
const repoRoot = resolve(extensionDir, '../..');
const { chromium } = createRequire(join(repoRoot, 'package.json'))('playwright');
const pause = ms => new Promise(r => setTimeout(r, ms));
const argOf = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const production = process.argv.includes('--production');
const arms = production ? ['cmaf-production'] : (argOf('arms') ?? 'cmaf,locmaf-mse,loc').split(',');
const browserExecutable = process.env.PLAYA_DEVTOOLS_LIVE_BROWSER ?? null;

const artifact = await mkdtemp(join(tmpdir(), production ? 'playa-devtools-live-prod-' : 'playa-devtools-live-'));
const report = { artifact, mode: production ? 'production-build' : 'source', passed: false, arms: {}, errors: [], consoleDropped: 0,
  runtime: { platform: process.platform, arch: process.arch, node: process.version, browserExecutable },
  notProven: ['media correctness / presentation quality (player acceptance harness)', 'native optional-permission prompt (labelled pre-granted test build)', 'any public relay'] };
const noteError = text => { if (report.errors.length >= 50) { report.consoleDropped++; return; } report.errors.push(String(text).slice(0, 300)); };
const children = [];
const logs = {};
function launch(name, cmd, args, env = {}, cwd = repoRoot) {
  logs[name] ??= [];
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.push(child);
  const sink = data => { for (const line of String(data).split('\n')) if (line.trim() && logs[name].length < 5000) logs[name].push(line); };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
  return child;
}
const waitForLine = async (name, re, tries = 600) => { for (let i = 0; i < tries; i++) { const hit = (logs[name] ?? []).map(l => l.match(re)).find(Boolean); if (hit) return hit; await pause(100); } throw new Error(`${name}: no line matching ${re} (last: ${(logs[name] ?? []).slice(-3).join(' | ')})`); };
const posix = process.platform !== 'win32';
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const signalGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { /* gone */ } };
const waitGone = async (pid, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (!groupAlive(pid)) return true; await pause(100); } return !groupAlive(pid); };
async function stopChild(child) {
  if (!posix || !child.pid) return { pid: child.pid, gone: null, note: 'group liveness unavailable on this platform' };
  signalGroup(child.pid, 'SIGTERM');
  let gone = await waitGone(child.pid, 5000), killed = false;
  if (!gone) { killed = true; signalGroup(child.pid, 'SIGKILL'); gone = await waitGone(child.pid, 3000); }
  return { pid: child.pid, gone, killed };
}

/** Fingerprint of the runtime sources the Vite/build serves plus the relay/publisher/fixture code behind the media. */
async function backendFingerprint() {
  const hash = createHash('sha256'); const files = [];
  const walk = async (dir, keep) => {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'dist', 'fixtures', 'certs'].includes(e.name)) await walk(p, keep); }
      else if (keep(p)) files.push(p);
    }
  };
  const source = p => /\.(ts|mts|js|mjs|json)$/.test(p) && !/\.test\.(ts|mts|js|mjs)$/.test(p) && !/\.d\.ts$/.test(p);
  for (const name of (await readdir(join(repoRoot, 'packages'))).sort()) await walk(join(repoRoot, 'packages', name, 'src'), source);
  await walk(join(repoRoot, 'examples/node-relay/src'), source); await walk(join(repoRoot, 'examples/node-relay/scripts'), source);
  await walk(join(repoRoot, 'examples/node-publisher/src'), source);
  for (const f of ['scripts/player-acceptance/fixture.mjs', 'examples/vite.config.ts', 'tools/devtools-extension/test/live-page/index.html', 'tools/devtools-extension/test/live-page/main.ts']) files.push(join(repoRoot, f));
  for (const f of files) { const rel = relative(repoRoot, f); hash.update(rel); try { hash.update(await readFile(f)); } catch { hash.update('<missing>'); } }
  return { files: files.length, sha256: hash.digest('hex') };
}

// 1. Labelled TEST BUILD of the extension (pre-granted loopback origin), hashed.
const ext = join(artifact, 'extension');
await cp(join(extensionDir, 'dist'), ext, { recursive: true });
{
  const m = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  m.name = 'Playa DevTools (TEST BUILD: pre-granted http://127.0.0.1/*)'; m.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(ext, 'manifest.json'), JSON.stringify(m, null, 2));
  const hash = createHash('sha256'); for (const name of (await readdir(ext)).sort()) { hash.update(name); hash.update(await readFile(join(ext, name))); }
  report.extensionHash = hash.digest('hex');
}
report.backendBefore = await backendFingerprint();

let ctx;
let staticServer = null;
try {
  // 2. Certificate + pin; fixtures.
  await new Promise((ok, fail) => { const c = launch('cert', process.execPath, [join(repoRoot, 'examples/node-relay/scripts/gen-cert.mjs'), '--out-dir', join(artifact, 'certs')]); c.on('close', code => code === 0 ? ok() : fail(new Error(`gen-cert exited ${code}`))); });
  const certPath = join(artifact, 'certs/cert.pem'), keyPath = join(artifact, 'certs/key.pem');
  const pinHex = new X509Certificate(await readFile(certPath)).fingerprint256.replaceAll(':', '').toLowerCase();
  const { prepareFixture } = await import(join(repoRoot, 'scripts/player-acceptance/fixture.mjs'));
  const fixtures = {};
  const cmafDir = argOf('fixture') ?? join(repoRoot, 'examples/node-publisher/fixtures/test-pattern');
  try { await access(join(cmafDir, 'manifest.json')); fixtures.cmaf = { dir: cmafDir, namespace: JSON.parse(await readFile(join(cmafDir, 'manifest.json'), 'utf8')).namespace.join('/'), origin: 'prepared' }; }
  catch { const dir = join(artifact, 'fixture-cmaf'); await prepareFixture(dir, 'live-gate', false, new AbortController().signal); fixtures.cmaf = { dir, namespace: 'live-gate', origin: 'generated (ffmpeg, aac)' }; }
  if (arms.includes('loc')) { const dir = join(artifact, 'fixture-loc'); await prepareFixture(dir, 'live-gate-loc', false, new AbortController().signal, false, 'opus'); fixtures.loc = { dir, namespace: 'live-gate-loc', origin: 'generated (ffmpeg, opus)' }; }
  report.fixtures = fixtures;

  // 3. The page: Vite dev server on workspace sources, or a minified production build served statically.
  let pageBase;
  if (production) {
    const { build } = await import(createRequire(join(repoRoot, 'examples/package.json')).resolve('vite'));
    const outDir = join(artifact, 'dist-prod');
    await build({ root: repoRoot, configFile: join(repoRoot, 'examples/vite.config.ts'), logLevel: 'warn',
      build: { outDir, emptyOutDir: true, minify: true, sourcemap: false, rollupOptions: { input: join(here, 'live-page/index.html') } } });
    const built = await readdir(join(outDir, 'tools/devtools-extension/test/live-page')).catch(() => []);
    assert.ok(built.includes('index.html'), `production build must emit the page, got ${built}`);
    const assets = await readdir(join(outDir, 'assets')).catch(() => []);
    report.productionBuild = { outDir, assets: assets.length, minified: true };
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
    staticServer = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      try { const body = await readFile(join(outDir, path)); res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise(r => staticServer.listen(0, '127.0.0.1', r));
    pageBase = `http://127.0.0.1:${staticServer.address().port}/tools/devtools-extension/test/live-page/index.html`;
  } else {
    launch('vite', process.execPath, [join(here, 'live-page/serve.mjs')]);
    pageBase = (await waitForLine('vite', /Live page: (http:\/\/127\.0\.0\.1:\d+\/tools\/devtools-extension\/test\/live-page\/)/))[1];
  }

  ctx = await chromium.launchPersistentContext(join(artifact, 'profile'), { headless: false, ...(browserExecutable ? { executablePath: browserExecutable } : {}),
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--auto-open-devtools-for-tabs', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,1000'] });
  report.browser = ctx.browser().version();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('pageerror', e => noteError(`page: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') noteError(`page console: ${m.text()}`); });
  await page.goto('data:text/html,<title>live gate</title>');

  const root = await ctx.browser().newBrowserCDPSession();
  const downloads = [];
  await root.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: join(artifact, 'downloads'), eventsEnabled: true });
  root.on('Browser.downloadWillBegin', d => downloads.push({ ...d, state: 'started' }));
  root.on('Browser.downloadProgress', d => { const x = downloads.find(x => x.guid === d.guid); if (x) Object.assign(x, d); });
  let nextId = 0;
  const attach = async targetId => (await root.send('Target.attachToTarget', { targetId })).sessionId;
  const rpc = (sessionId, method, params = {}, timeoutMs = 8000) => new Promise((ok, reject) => {
    const id = ++nextId;
    const done = () => { clearTimeout(timer); root.off('Target.receivedMessageFromTarget', listener); };
    const listener = e => { if (e.sessionId !== sessionId) return; const m = JSON.parse(e.message); if (m.id !== id) return; done(); m.error ? reject(new Error(JSON.stringify(m.error))) : ok(m.result); };
    const timer = setTimeout(() => { done(); reject(new Error(`CDP timeout ${method} (${timeoutMs} ms)`)); }, timeoutMs);
    root.on('Target.receivedMessageFromTarget', listener);
    root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(e => { done(); reject(e); });
  });
  const evaluate = async (s, expression, timeoutMs) => { const r = await rpc(s, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result?.value; };
  const targets = async () => (await root.send('Target.getTargets')).targetInfos;
  const findTarget = async (pick, tries = 60) => { for (let i = 0; i < tries; i++) { const t = (await targets()).find(pick); if (t) return t; await pause(100); } return null; };
  const until = async (name, fn, tries = 80) => { let last; for (let i = 0; i < tries; i++) { last = await fn(); if (last) return last; await pause(100); } throw new Error(`timeout waiting for ${name}: ${JSON.stringify(last)?.slice(0, 300)}`); };
  const watch = (sessionId, label) => root.on('Target.receivedMessageFromTarget', e => { if (e.sessionId !== sessionId) return; const m = JSON.parse(e.message);
    if (m.method === 'Runtime.exceptionThrown') noteError(`${label} exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') noteError(`${label} console: ${m.params.args?.map(a => a.value ?? a.description).join(' ')}`); });
  await findTarget(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/devtools.html'));
  const dts = (await targets()).filter(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/devtools.html'));
  assert.equal(dts.length, 1);
  const dtSession = await attach(dts[0].targetId); watch(dtSession, 'owner'); await rpc(dtSession, 'Runtime.enable');
  const identity = await until('owner identity', () => evaluate(dtSession, 'globalThis.__playaOwner ? JSON.parse(JSON.stringify(globalThis.__playaOwner)) : null'));
  const host = await findTarget(t => t.url.startsWith('devtools://')); const hs = await attach(host.targetId);
  report.frontend = await openPlayaPanel({ evaluate, session: hs });   // after the frontend's own bootstrap promise, never before
  let ps;
  const bindPanel = async () => {
    const panel = await findTarget(t => t.type === 'iframe' && t.url.includes('/panel.html') && t.url.includes(`owner=${identity.ownerId}`));
    assert.ok(panel, 'panel iframe for this owner not found');
    ps = await attach(panel.targetId); watch(ps, 'panel'); await rpc(ps, 'Runtime.enable');
    await until('panel hook', () => evaluate(ps, 'window.__playaPanel ? true : null'));
    // TEST-ONLY: retain the last 256 encoded PAGE-lane frames this view applied (diagnosis; decoded here in Node) and
    // keep a MONOTONIC count of the facts those frames carried (test/fact-counter.mjs; the same function text runs in
    // the panel). Ring length is not monotonic — a full ring shifts out as many frames as it adds — the counter is.
    await evaluate(ps, `(() => { const hook = window.__playaPanel; if (hook.__gateWrapped) return true;
      const countFacts = ${countFacts.toString()}; const frameMeta = ${frameMeta.toString()};
      const frames = window.__pageFrames = []; window.__pageFactCount = 0; window.__pageFrameCount = 0; window.__pageLastFrame = null;
      const original = hook.applyEncoded.bind(hook);
      hook.applyEncoded = (text, lane = 'page') => { if (lane === 'page') { if (frames.length >= 256) frames.shift(); frames.push(text);
        window.__pageFactCount += countFacts(text); window.__pageFrameCount++; window.__pageLastFrame = frameMeta(text); } return original(text, lane); };
      hook.__gateWrapped = true; return true; })()`);
  };
  await bindPanel();
  const { decodeMessage } = await import(join(repoRoot, 'packages/devtools-protocol/dist/index.js'));
  const pageSnapshot = () => readLiveSnapshot(expression => evaluate(ps, expression), decodeMessage);
  const hostState = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel?.host ?? null))');
  const pageVm = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel.vms.page))');
  const pageMessages = async () => (await evaluate(ps, 'JSON.parse(JSON.stringify(window.__pageFrames ?? []))'))
    .map(text => { const r = decodeMessage(text); if (!r.ok) throw new Error(`gate decode failed: ${r.error.code}`); return r.message; });
  const pageFacts = async () => (await pageMessages()).flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
  /** Facts WITH their provenance: batch events keep their exact decimal seq; snapshot-baseline facts carry none. */
  const pageEvents = async () => (await pageMessages()).flatMap(m => m.kind === 'batch' ? m.events.map(ev => ({ seq: ev.seq, fact: ev.fact, origin: 'batch' })) : m.kind === 'snapshot' ? m.facts.map(o => ({ seq: null, fact: o.fact, origin: 'snapshot' })) : []);
  // Target-safe native click (test/native-click.mjs): stable layout + hit test before dispatch, the received click
  // verified after it; a click that lands on another control fails loudly instead of passing as the intended action.
  const click = createNativeClick({ evaluate, rpc, session: () => ps });
  const recLabel = () => evaluate(ps, `({ text: document.getElementById('recLabel').textContent, disabled: document.getElementById('btnRec').classList.contains('disabled') })`);
  /** Progress evidence read from the page itself: state, media time, presentation, engine stats, canvas visibility. */
  const progress = () => page.evaluate(() => ({ state: window.live.state, error: window.live.error, t: window.live.currentTime(),
    presentation: window.live.presentation(), rvfc: window.live.rvfc(), stats: JSON.parse(JSON.stringify(window.live.stats())), canvasVisible: window.live.canvasVisible() }));

  for (const arm of arms) {
    const canvas = arm === 'loc';
    const locmaf = arm === 'locmaf-mse';
    const fixture = canvas ? fixtures.loc : fixtures.cmaf;
    const armReport = { arm, fixture, steps: [] };
    report.arms[arm] = armReport;
    const step = (name, data = {}) => armReport.steps.push({ name, ...data });

    // 4. Relay + publisher for this arm (fresh relay per arm: a relay registers one publisher per track).
    const relayName = `relay-${arm}`, pubName = `publisher-${arm}`;
    const relay = launch(relayName, 'pnpm', ['--filter', '@moqt/example-node-relay', 'relay-server'], { HOST: '127.0.0.1', PORT: '0', DEMO_NAMESPACE: fixture.namespace, RELAY_CERT: certPath, RELAY_KEY: keyPath });
    const relayUrl = (await waitForLine(relayName, /listening on (https:\/\/127\.0\.0\.1:\d+\/moq)/))[1];
    const publisher = canvas
      ? launch(pubName, 'pnpm', ['--filter', '@moqt/example-node-publisher', 'exec', 'tsx', 'src/publish-loc.ts', relayUrl, fixture.dir, '4', 'media'], { RELAY_CERT: certPath })
      : launch(pubName, 'pnpm', ['--filter', '@moqt/example-node-publisher', 'publish-fixture', '--loop', '--pace-media', '--catalog-format', 'cmsf-01', ...(locmaf ? ['--packaging', 'locmaf'] : []), relayUrl, fixture.dir], { RELAY_CERT: certPath });
    await waitForLine(pubName, /tracks established/);
    step('relay + publisher', { relayUrl, packaging: canvas ? 'loc-04 media' : locmaf ? 'locmaf (mse)' : 'cmaf (mse)' });

    // 5. The REAL player page; codec preflight; playback starts on a click.
    const query = new URLSearchParams({ url: relayUrl, ns: fixture.namespace, hash: pinHex, exposure: production ? 'production' : 'development', ...(canvas ? { output: 'canvas' } : {}) });
    await page.goto(`${pageBase}?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.live?.installed && window.live?.bridgeInstalled);
    await page.waitForFunction(() => window.live.codecs.webCodecsH264 !== null);
    const installed = await page.evaluate(() => ({ sourceId: window.live.sourceId, runId: window.live.runId, exposure: window.live.exposure, output: window.live.output, codecs: window.live.codecs }));
    if (canvas ? installed.codecs.webCodecsH264 !== true : !(installed.codecs.mseH264 && installed.codecs.mseAac)) {
      throw new Error(`this browser cannot decode the fixture (${JSON.stringify(installed.codecs)}); point PLAYA_DEVTOOLS_LIVE_BROWSER at a codec-capable Chromium/Chrome for Testing build`);
    }
    await page.click('#start');
    await page.waitForFunction(() => window.live.state === 'playing' || window.live.error, { timeout: 30000 });
    const started = await progress();
    assert.equal(started.error, null, `player error: ${started.error}`);
    assert.equal(started.state, 'playing');
    // Advancing media, on this arm's evidence.
    const sampleA = await until('media advancing with a first video presentation', async () => { const p = await progress(); return playbackStarted(p, canvas) ? p : null; }, 300);
    await pause(1200);
    const sampleB = await progress();
    armReport.playbackSamples = { before: sampleA, after: sampleB };
    assert.ok(sampleB.t > sampleA.t, `media time must advance (${sampleA.t} → ${sampleB.t})`);
    if (canvas) {
      assert.ok(sampleB.canvasVisible, 'the canvas must be the visible active surface');
      assert.ok(sampleB.presentation && sampleA.presentation && sampleB.presentation.renderedAtUs > sampleA.presentation.renderedAtUs, 'canvas draws must advance (renderedAtUs)');
      assert.ok(sampleB.stats.framesRendered > sampleA.stats.framesRendered, 'engine rendered frames must advance');
    } else {
      assert.ok(sampleB.rvfc.presentedFrames > sampleA.rvfc.presentedFrames && sampleB.rvfc.mediaTime > sampleA.rvfc.mediaTime, `real video-frame callbacks must advance (${JSON.stringify(sampleA.rvfc)} → ${JSON.stringify(sampleB.rvfc)})`);
    }
    step('player playing', { ...installed, state: started.state, mediaTime: [sampleA.t, sampleB.t], framesRendered: [sampleA.stats.framesRendered, sampleB.stats.framesRendered], rvfc: [sampleA.rvfc, sampleB.rvfc], presentation: sampleB.presentation });

    // 6. Attach from the panel: the page's one Playa source is discovered and attached. This arm's facts only.
    await evaluate(ps, 'if (window.__pageFrames) window.__pageFrames.length = 0; true');
    await until('owner ready for this document', async () => { const h = await hostState(); return h?.outer?.stage === 'ready' && h.outer.origin === new URL(pageBase).origin ? h : null; }, 100);
    await click('#btnDev');
    const discovered = await until('discovered', async () => { const h = await hostState(); return h?.core?.phase === 'discovered' ? h : null; }, 150);
    assert.equal(discovered.core.sources.length, 1);
    const source = discovered.core.sources[0];
    assert.equal(source.sourceId, installed.sourceId); assert.equal(source.runId, installed.runId);
    assert.equal(source.exposure, production ? 'production' : 'development');
    assert.ok(['session', 'requests', 'objects', 'metrics', 'recording'].every(c => source.capabilities.includes(c)), `capabilities ${source.capabilities}`);
    assert.equal(source.synthetic, false);
    await click('#pickList .inst');
    await until('attached', async () => (await hostState())?.core?.phase === 'attached', 100);

    // 7. Live facts and rendering.
    const relayOrigin = new URL(relayUrl).origin;
    const vm = await until('live session, tracks, objects and metrics painted', async () => {
      const v = await pageVm();
      const okSession = v.session.some(([k, val]) => k === 'draft' && /d18/.test(val));
      const okRows = v.rows.length > 0 && v.rows.some(r => r.cells.some(c => c.present));
      const bitrate = v.sparks.find(s => s.name === 'receive bitrate');
      return okSession && v.tracks.length >= 2 && okRows && bitrate && /bps$/.test(bitrate.now) ? v : null;
    }, 300);
    const facts = await pageFacts();
    const session = facts.filter(f => f.kind === 'session' && f.state === 'ready' && f.endpoint?.origin === relayOrigin).at(-1);
    assert.ok(session, `a ready session fact for ${relayOrigin} must exist`);
    assert.equal(session.draft, 18); assert.equal(session.endpoint.path, '/moq');
    assert.ok(!JSON.stringify(facts).includes(pinHex), 'the certificate pin must never appear in facts');
    const objects = facts.filter(f => f.kind === 'object' && f.sessionId === session.sessionId);
    assert.ok(objects.length >= 1);
    for (const o of objects) { assert.ok(/^\d+$/.test(o.groupId) && /^\d+$/.test(o.objectId)); assert.ok(Number.isInteger(o.payloadBytes) && o.payloadBytes >= 0); }
    const requests = facts.filter(f => f.kind === 'request' && f.state === 'accepted' && f.sessionId === session.sessionId);
    assert.ok(requests.length >= 1, 'accepted SUBSCRIBE requests must be reported');
    // Group bounds: a FIN-derived END_OF_GROUP is a `group_bound` fact (exclusive, evidence end-of-group), never an
    // `object` fact, so no object may share a bound's (alias, group, id). The LOC fixture flags end-of-group on every
    // group's last frame, so that arm must show at least one bound once a group completed; the CMAF publisher's
    // flagging is not assumed, so there the invariant is checked and the count recorded.
    const boundsOf = f => f.filter(x => x.kind === 'group_bound' && x.sessionId === session.sessionId);
    const boundInvariant = f => { for (const b of boundsOf(f)) {
      assert.equal(b.evidence, 'end-of-group'); assert.ok(b.bound === 'exclusive' || b.bound === 'inclusive');
      assert.ok(!f.some(o => o.kind === 'object' && o.sessionId === b.sessionId && o.trackAlias === b.trackAlias && o.groupId === b.groupId && o.objectId === b.objectId),
        `an object fact exists at bound ${b.trackAlias}/${b.groupId}/${b.objectId}: a bound was also reported as a cell`); } };
    boundInvariant(facts);
    let groupBounds = boundsOf(facts).length;
    if (canvas) {
      const f = await until('a LOC group bound (FIN-derived end of group) reported', async () => { const f = await pageFacts(); return boundsOf(f).length ? f : null; }, 150);
      boundInvariant(f); groupBounds = boundsOf(f).length;
      // The rendered rows are a ring of the most recent groups, so the FIRST bound's group may already be evicted;
      // the label is checked on whichever retained row carries a bound, and that row's bound must be a fact.
      const bounded = await until('a retained LOC row labelled with its bound', async () => { const v = await pageVm(); const f2 = await pageFacts();
        for (const r of v.rows) { const m = /ends o(\d+)/.exec(r.meta); if (!m) continue; const groupId = r.label.replace(/^g /, '');
          const fact = boundsOf(f2).find(x => x.groupId === groupId && x.objectId === m[1]); if (fact) return { row: r, fact }; }
        return null; }, 100);
      assert.ok(!bounded.row.cells.some(c => c.present && c.o === bounded.fact.objectId), 'no cell may be drawn at the bound id');
      groupBounds = Math.max(groupBounds, boundsOf(await pageFacts()).length);
    }
    const metricNames = new Set(facts.filter(f => f.kind === 'metric').map(f => f.name));
    for (const n of ['receive_bitrate', 'objects_received', 'payload_bytes_received', 'frames_rendered']) assert.ok(metricNames.has(n), `metric ${n} expected`);
    const seriesOf = (list, name) => list.filter(f => f.kind === 'metric' && f.name === name && f.value !== null).map(f => f.value);
    const series = name => seriesOf(facts, name);
    // Progress in the REPORTED metrics is judged over time: wait until the series itself shows an increase.
    const increasing = async (name, label) => until(`${label} increasing in reported metrics`, async () => {
      const s = seriesOf(await pageFacts(), name); return s.length >= 2 && s.at(-1) > s[0] ? { first: s[0], last: s.at(-1), samples: s.length } : null; }, 100);
    const latest = (f, name) => { const s = seriesOf(f, name); return s.length ? s.at(-1) : null; };
    const latestFact = (f, name) => f.filter(x => x.kind === 'metric' && x.name === name).at(-1) ?? null;
    // Decode counters. `video_decode_submissions` is the SDK's legacy count of emitted decode commands (engine
    // lifetime, before native dispatch); `frames_decoded` / `audio_outputs_decoded` are ACTUAL decoder output
    // callbacks during the diagnostic tracker lifetime. On MSE both output counters must be UNAVAILABLE with the
    // reason `unsupported` (never 0): the browser decodes inside MSE and no output callback exists. On the LOC arm
    // all three increase; `frames_decoded <= video_decode_submissions` is pinned ONLY because this fixture's decoder
    // yields one output per input and the tracker attaches after playback began — a decoder may legitimately emit
    // zero or several outputs per input, so this is not a contract and the difference is never "drops".
    const unavailableUnsupported = (f, name) => { const m = latestFact(f, name); return !!m && m.value === null && m.unavailable === 'unsupported'; };
    let reportedEvidence;
    if (canvas) {
      // No media element was supplied, so no ELEMENT metric may be reported (test/element-metrics.mjs: the explicit
      // set the adapter samples from a <video> or its document; membership is a list, never the `video_` prefix, which
      // engine counters such as `video_decode_submissions` also use and which ARE expected here).
      const reportedElement = reportedElementMetrics(metricNames);
      assert.deepEqual(reportedElement, [], `canvas arm must not report element metrics, got ${JSON.stringify(reportedElement)}`);
      assert.ok(metricNames.has('video_decode_submissions'), 'the engine decode-submission counter must be reported on the canvas arm');
      reportedEvidence = { framesRendered: await increasing('frames_rendered', 'engine rendered frames'),
        submissions: await increasing('video_decode_submissions', 'video decode submissions'), framesDecoded: await increasing('frames_decoded', 'actual video decoder outputs') };
      {
        const f0 = await pageFacts();
        const submissions = latest(f0, 'video_decode_submissions'), outputs = latest(f0, 'frames_decoded');
        assert.ok(outputs <= submissions, `one-output fixture: actual outputs (${outputs}) cannot exceed submissions (${submissions}) when the tracker attached after playback began`);
        reportedEvidence.decodeCounters = { submissions, framesDecoded: outputs, audioOutputs: latest(f0, 'audio_outputs_decoded') };
      }
    } else {
      reportedEvidence = { presentedFrames: await increasing('video_presented_frames', 'rVFC presented frames'), mediaTime: await increasing('video_frame_media_time', 'rVFC media time') };
      for (const n of ['frames_decoded', 'audio_outputs_decoded']) assert.ok(unavailableUnsupported(facts, n), `${n} must be unavailable (unsupported) on an MSE arm, got ${JSON.stringify(latestFact(facts, n))}`);
      reportedEvidence.decodeCounters = { submissions: latest(facts, 'video_decode_submissions'), framesDecoded: latestFact(facts, 'frames_decoded')?.unavailable ?? null, audioOutputs: latestFact(facts, 'audio_outputs_decoded')?.unavailable ?? null };
    }
    const selectedTrack = vm.tracks.find(t => t.on)?.id; assert.ok(selectedTrack, 'a track must be selected');
    const { sample, cell } = await until('an object of the selected track rendered as a cell', async () => {
      const f = await pageFacts(); const v = await pageVm();
      for (const o of f.filter(x => x.kind === 'object' && x.trackId === selectedTrack && x.sessionId === session.sessionId).reverse()) {
        const c = v.rows.flatMap(r => r.cells).find(c => c.present && c.g === `${o.sessionId}/${o.trackAlias}/${o.groupId}` && c.o === o.objectId);
        if (c) return { sample: o, cell: c };
      }
      return null;
    }, 150);
    // 7b. MEDIA STAGES. On the MSE arms the engine's CMAF chain must show, for an object of the selected track, a
    //     `reconstructed` AND an `appended` stage carrying the SAME deliveryId as that object fact and one shared
    //     non-null unitId; `appended` > 0 is also the proof that Chromium fires the MSE `update` witness. Decode and
    //     presentation are NOT observable through MSE, so no such stage may appear. Every stage's deliveryId must be
    //     an object the panel holds; every discard reason must be a documented string; the engine's evidence-loss
    //     and unobservable-append counters must be 0 on this fixture (no retype, no quota pressure, observer attached
    //     with the capture). The LOC canvas arm has no append path: zero such stages.
    const stageFacts = f => f.filter(x => x.kind === 'stage');
    // The shared outcome vocabulary as PLAYER.md lists it (transport, routing, reconstruction/player policy, buffered
    // playback, MSE, dispatcher, canvas, audio scheduling, unavailable evidence). A reason outside it is a producer bug.
    const documentedReasons = new Set(['subscription policy', 'late',
      'transform cancelled', 'dropped by transform', 'route retired', 'object processing failed',
      'track superseded', 'invalid media', 'orphaned media', 'epoch refused', 'superseded pending moof', 'paused', 'awaiting init', 'awaiting keyframe', 'not attached', 'stale group',
      'skipped', 'buffer full', 'buffer eviction', 'backlog shed', 'late frame', 'decoder policy',
      'destroyed', 'treated as a replay', 'append error', 'append aborted', 'retype', 'flushed', 'decoder reset',
      'hold queue overflow', 'output failed', 'draw failed', 'schedule failed', 'completion unproven']);
    const capabilities = vm.sourceCapabilities;
    // Track identity for stage judgements comes from the source's own `track` facts, never from the stages.
    const videoTracks = new Set(facts.filter(x => x.kind === 'track' && x.mediaType === 'video').map(x => x.trackId));
    const audioTracks = new Set(facts.filter(x => x.kind === 'track' && x.mediaType === 'audio').map(x => x.trackId));
    let stageEvidence;
    if (!canvas) {
      assert.ok(capabilities.includes('cmaf-append-stages'), `source must declare cmaf-append-stages, got ${JSON.stringify(capabilities)}`);
      const proven = await waitForLiveSnapshot('reconstructed AND appended on one visible delivery of the selected track', pageSnapshot, ({ facts: f, vm: v }) => {
        const st = stageFacts(f);
        for (const o of f.filter(x => x.kind === 'object' && x.trackId === selectedTrack && x.sessionId === session.sessionId).reverse()) {
          const cell = v.rows.flatMap(r => r.cells).find(c => c.present && c.g === `${o.sessionId}/${o.trackAlias}/${o.groupId}` && c.o === o.objectId);
          if (!cell) continue;
          const mine = st.filter(x => x.deliveryId === o.deliveryId);
          const rec = mine.find(x => x.stage === 'reconstructed'), app = mine.find(x => x.stage === 'appended');
          if (rec && app && rec.unitId !== null && rec.unitId === app.unitId) return { object: o, reconstructed: rec, appended: app, facts: f, vm: v, cell };
        }
        return null; }, { validate: s => assert.deepEqual(stageSnapshotProblems(s.facts, s.vm.rows), [], 'contradictory media-stage evidence') });
      const f = proven.facts, all = stageFacts(f);
      const objectIds = new Set(f.filter(x => x.kind === 'object').map(x => x.deliveryId));
      for (const st of all) {
        assert.ok(!['decoded', 'scheduled', 'presented'].includes(st.stage), `MSE cannot observe ${st.stage}; a stage claimed it`);
        assert.ok(objectIds.has(st.deliveryId), `stage ${st.stage} names delivery ${st.deliveryId} the panel never saw as an object`);
        if (st.stage === 'discarded') assert.ok(documentedReasons.has(st.reason), `undocumented discard reason ${JSON.stringify(st.reason)}`);
      }
      const appended = all.filter(x => x.stage === 'appended').length;
      assert.ok(appended > 0);
      const byUnit = new Map(); for (const st of all) if (st.unitId) byUnit.set(st.unitId, (byUnit.get(st.unitId) ?? new Set()).add(st.deliveryId));
      const discardsByReason = {}; for (const st of all) if (st.stage === 'discarded') discardsByReason[st.reason] = (discardsByReason[st.reason] ?? 0) + 1;
      const names = new Set(f.filter(x => x.kind === 'metric').map(x => x.name));
      for (const n of ['diagnostic_unattributed_stages', 'diagnostic_unattributed_inputs', 'diagnostic_evidence_loss', 'diagnostic_unobservable_appends']) assert.ok(names.has(n), `metric ${n} expected`);
      assert.equal(latest(f, 'diagnostic_evidence_loss'), 0, 'no diagnostic evidence may be lost on this fixture');
      assert.equal(latest(f, 'diagnostic_unobservable_appends'), 0, 'the standard MSE adapter reports appends');
      const unattributed = latest(f, 'diagnostic_unattributed_stages'); assert.ok(unattributed !== null && unattributed <= objects.length + all.length);
      // The proven object's cell is drawn and not marked discarded; the panel's legend wording states the coverage.
      const v = proven.vm;
      const provenCell = proven.cell;
      assert.ok(provenCell && !/discarded/.test(provenCell.cls), 'the appended object must be a drawn, non-discarded cell');
      assert.match(v.legendNote ?? '', /append stages reported/);
      stageEvidence = { provenDelivery: proven.object.deliveryId, unitId: proven.reconstructed.unitId, reconstructed: all.filter(x => x.stage === 'reconstructed').length, appended,
        discardsByReason, unitsWithTwoInputs: [...byUnit.values()].filter(s => s.size > 1).length, unattributedStages: unattributed, unattributedInputs: latest(f, 'diagnostic_unattributed_inputs'),
        evidenceLoss: latest(f, 'diagnostic_evidence_loss'), unobservableAppends: latest(f, 'diagnostic_unobservable_appends'), legendNote: v.legendNote };
    } else {
      // LOC canvas arm. Video: an object of the selected track with decoded → scheduled → presented on ONE unit of ONE
      // deliveryId (the renderer's own draw witness). Audio: decoded → scheduled on one unit and NEVER presented (no
      // audible witness; `released` is not a stage). No reconstructed/appended on LOC. Stages are judged per
      // (deliveryId, unitId): one input can yield several native output units. Every assertion over "all facts" is
      // made on ONE snapshot taken AFTER both positives, so nothing arriving between the two can be missed.
      for (const c of ['loc-video-stages', 'loc-audio-stages']) assert.ok(capabilities.includes(c), `source must declare ${c}, got ${JSON.stringify(capabilities)}`);
      assert.ok(videoTracks.has(selectedTrack), 'the selected track on the LOC arm must be a video track');
      const unitsOf = (st, deliveryId) => { const m = new Map(); for (const x of st) if (x.deliveryId === deliveryId && x.unitId !== null) (m.get(x.unitId) ?? m.set(x.unitId, new Set()).get(x.unitId)).add(x.stage); return m; };
      const findUnit = (f, trackOk, needs, forbid, visible = null) => {
        const st = stageFacts(f);
        for (const o of f.filter(x => x.kind === 'object' && trackOk(x.trackId) && x.sessionId === session.sessionId).reverse()) {
          if (visible && !visible.some(c => c.present && c.g === `${o.sessionId}/${o.trackAlias}/${o.groupId}` && c.o === o.objectId)) continue;
          for (const [unitId, set] of unitsOf(st, o.deliveryId)) if (needs.every(n => set.has(n)) && !forbid.some(n => set.has(n))) return { object: o, unitId };
        }
        return null;
      };
      if (audioTracks.size) await increasing('audio_outputs_decoded', 'actual audio decoder outputs');
      // Both positives and the grid belong to ONE browser turn. A bounded grid can legitimately roll to the next
      // group before that group's first presentation, so wait for a visible complete witness, not for an old cell
      // to reappear. Once selected, its terminal consistency and every "all facts" assertion use this same snapshot.
      const { facts: f, vm: v, video: provenVideo, audio: provenAudio } = await waitForLiveSnapshot('complete LOC video/audio units with a currently drawn video cell', pageSnapshot, snapshot => {
        const video = findUnit(snapshot.facts, t => t === selectedTrack, ['decoded', 'scheduled', 'presented'], [], snapshot.vm.rows.flatMap(r => r.cells));
        const audio = audioTracks.size ? findUnit(snapshot.facts, t => audioTracks.has(t), ['decoded', 'scheduled'], ['presented']) : null;
        return video && (!audioTracks.size || audio) ? { ...snapshot, video, audio } : null;
      }, { validate: s => assert.deepEqual(stageSnapshotProblems(s.facts, s.vm.rows), [], 'contradictory media-stage evidence') });
      const all = stageFacts(f);
      const objectById = new Map(f.filter(x => x.kind === 'object').map(x => [x.deliveryId, x]));
      for (const st of all) {
        assert.ok(!['reconstructed', 'appended'].includes(st.stage), `the LOC canvas arm has no append path; got ${st.stage}`);
        assert.ok(objectById.has(st.deliveryId), `stage ${st.stage} names delivery ${st.deliveryId} the panel never saw as an object`);
        if (st.stage === 'discarded') assert.ok(documentedReasons.has(st.reason), `undocumented discard reason ${JSON.stringify(st.reason)}`);
        if (st.stage === 'presented') assert.ok(videoTracks.has(objectById.get(st.deliveryId).trackId), `only video may be presented; delivery ${st.deliveryId} is ${objectById.get(st.deliveryId).trackId}`);
      }
      const audioPresented = all.filter(x => x.stage === 'presented' && audioTracks.has(objectById.get(x.deliveryId)?.trackId)).length;
      assert.equal(audioPresented, 0, 'audio must never be reported presented');
      const names = new Set(f.filter(x => x.kind === 'metric').map(x => x.name));
      const zeroCounters = ['diagnostic_evidence_loss', 'diagnostic_unobservable_video_outputs', 'diagnostic_unobservable_audio_outputs', 'diagnostic_unobservable_appends',
        'diagnostic_refused_reconstructed_units', 'diagnostic_refused_video_units', 'diagnostic_refused_audio_units', 'diagnostic_input_admission_refusals'];
      for (const n of [...zeroCounters, 'diagnostic_unattributed_stages', 'diagnostic_unattributed_inputs']) assert.ok(names.has(n), `metric ${n} expected`);
      for (const n of zeroCounters) assert.equal(latest(f, n), 0, `${n} must be 0 on the standard LOC fixture`);
      const cellOf = o => v.rows.flatMap(r => r.cells).find(c => c.present && c.g === `${o.sessionId}/${o.trackAlias}/${o.groupId}` && c.o === o.objectId) ?? null;
      const provenCell = cellOf(provenVideo.object);
      // Judge the proven UNIT and its cell together (test/trace-facts.mjs cellVerdict): the unit must be presented and
      // not discarded; the cell must be drawn; a "discarded" mark is legitimate only when ANOTHER unit of this
      // delivery truthfully discarded. On failure the evidence names the object, unit, cell, every stage of the
      // delivery by unit, and the retained rows with their windows, so absence/eviction is distinguishable from a
      // discard and from an inconsistent unit.
      const deliveryUnits = unitsOf(all, provenVideo.object.deliveryId);
      const verdict = cellVerdict(deliveryUnits, provenVideo.unitId, provenCell);
      const cellEvidence = { object: { deliveryId: provenVideo.object.deliveryId, trackId: provenVideo.object.trackId, group: provenVideo.object.groupId, object: provenVideo.object.objectId }, unitId: provenVideo.unitId,
        cell: provenCell, unitsOfDelivery: Object.fromEntries([...deliveryUnits].map(([id, set]) => [id, [...set]])), verdict,
        rows: v.rows.map(r => ({ label: r.label, meta: r.meta, window: r.window, cells: r.cells.filter(c => c.present).length })), selectedTrack };
      assert.ok(verdict.ok, `presented unit and its cell disagree: ${verdict.problems.join('; ')} — evidence ${JSON.stringify(cellEvidence)}`);
      assert.match(v.legendNote ?? '', /presented reported from the renderer/); assert.match(v.legendNote ?? '', /presentation is not observable/);
      const discardsByReason = {}; for (const st of all) if (st.stage === 'discarded') discardsByReason[st.reason] = (discardsByReason[st.reason] ?? 0) + 1;
      stageEvidence = { provenVideo: { deliveryId: provenVideo.object.deliveryId, unitId: provenVideo.unitId, group: provenVideo.object.groupId, object: provenVideo.object.objectId }, cell: { kind: verdict.kind, otherDiscarded: verdict.otherDiscarded, cls: provenCell.cls },
        provenAudio: provenAudio && { deliveryId: provenAudio.object.deliveryId, unitId: provenAudio.unitId }, audioTracks: audioTracks.size, audioPresented,
        decoded: all.filter(x => x.stage === 'decoded').length, scheduled: all.filter(x => x.stage === 'scheduled').length, presented: all.filter(x => x.stage === 'presented').length,
        discardsByReason, unattributedStages: latest(f, 'diagnostic_unattributed_stages'), unattributedInputs: latest(f, 'diagnostic_unattributed_inputs'),
        counters: Object.fromEntries(zeroCounters.map(n => [n, latest(f, n)])), legendNote: v.legendNote };
    }
    step('live view', { session: { draft: session.draft, transport: session.transport, negotiated: session.negotiatedProtocol, setupMs: session.setupDurationMs },
      tracks: vm.tracks.map(t => t.name), selectedTrack, requests: requests.map(r => `${r.requestType} ${r.requestId} alias ${r.trackAlias} → ${r.trackId}`).slice(0, 6),
      objectsSeen: objects.length, groupBounds, stages: stageEvidence, sampleObject: { track: sample.trackId, alias: sample.trackAlias, group: sample.groupId, object: sample.objectId, bytes: sample.payloadBytes }, sampleCell: cell,
      metrics: [...metricNames].sort(), evidence: reportedEvidence, hookStats: vm.hookStats });

    // 8. Record → cut → witnesses → Stop → Save. The recording window is not a blind pause. Record starts; the
    //    source's own `recording` fact (state 'recording', the active recordingId) arrives as a BATCH event and is
    //    the CUT: the registry starts the recorder before publishing it, so every event with a seq strictly greater
    //    was emitted while the writer was active. The gate then waits, under an explicit wall-clock deadline judged
    //    on every poll's return, until object EVENTS after the cut have complete stage chains — LOC: a selected-track
    //    video object with decoded→scheduled→presented on one unit and (with an audio track) an audio object with
    //    decoded→scheduled on one unit and no presented; MSE: an object with reconstructed→appended on one unit —
    //    and only then stops. Those EXACT identities (deliveryId, unitId, track/group/object) must then be in the
    //    SAVED file with those stages. Pre-cut objects, in-flight pre-cut deliveries and snapshot-baseline facts can
    //    never be witnesses. A timeout fails with the counts of what did arrive after the cut.
    assert.deepEqual(await recLabel(), { text: 'Record .moqtrace', disabled: false });
    const recordStartedAt = Date.now();
    await click('#btnRec');
    const recordingId = (await until('recording started', async () => { const l = await recLabel(); const h = await hostState(); return l.text === 'Recording' && h?.core?.recording?.recordingId ? h.core.recording.recordingId : null; }, 50));
    let cut = null;   // retained once observed, even if the frame ring later evicts the marker's batch
    const chainsAfter = async () => {
      const events = await pageEvents();
      cut ??= recordingCut(events, recordingId);
      if (cut === null) return null;
      if (canvas) {
        // Terminal consistency: a presented unit is terminal, so the SAME unit may not also be discarded (another unit of
        // the delivery may); audio `scheduled` is not terminal, so a later discard is legitimate — only presented is forbidden.
        const video = chainAfterCut(events, cut, { trackOk: t => t === selectedTrack, needs: ['decoded', 'scheduled', 'presented'], forbid: ['discarded'] });
        const audio = audioTracks.size ? chainAfterCut(events, cut, { trackOk: t => audioTracks.has(t), needs: ['decoded', 'scheduled'], forbid: ['presented'] }) : null;
        return video && (!audioTracks.size || audio) ? { video, audio } : null;
      }
      const unit = chainAfterCut(events, cut, { trackOk: t => t === selectedTrack, needs: ['reconstructed', 'appended'], forbid: ['discarded'] });
      return unit ? { video: unit, audio: null } : null;
    };
    const recordDeadlineMs = 20000;
    let witnesses = null;
    for (;;) {
      const found = await chainsAfter();
      const elapsed = Date.now() - recordStartedAt;
      if (elapsed > recordDeadlineMs) {
        const events = await pageEvents(); const fresh = cut === null ? [] : events.filter(e => e.origin === 'batch' && e.seq !== null && BigInt(e.seq) > cut && e.fact.kind === 'object');
        const byMedia = {}; for (const e of fresh) { const m = videoTracks.has(e.fact.trackId) ? 'video' : audioTracks.has(e.fact.trackId) ? 'audio' : 'other'; byMedia[m] = (byMedia[m] ?? 0) + 1; }
        const ids = new Set(fresh.map(e => e.fact.deliveryId)); const stg = events.map(e => e.fact).filter(f => f.kind === 'stage' && ids.has(f.deliveryId));
        const reasons = {}; for (const f of stg) if (f.stage === 'discarded') reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
        throw new Error(`no complete post-cut stage chain within ${recordDeadlineMs} ms (observed at ${elapsed} ms${found ? ', found only after the deadline' : ''}; cut ${cut === null ? 'NOT observed — no recording fact in a batch' : `seq ${cut}`}; post-cut objects ${JSON.stringify(byMedia)}; their stages ${JSON.stringify(Object.fromEntries(['decoded', 'scheduled', 'presented', 'reconstructed', 'appended', 'discarded'].map(k => [k, stg.filter(f => f.stage === k).length])))}; discard reasons ${JSON.stringify(reasons)})`);
      }
      if (found) { witnesses = found; break; }
      await pause(100);
    }
    const recordWindowMs = Date.now() - recordStartedAt;
    await click('#btnRec');
    await until('stopped', async () => (await recLabel()).text === 'Save .moqtrace', 50);
    const downloadsBefore = downloads.length;
    const previousExport = await evaluate(ps, 'window.__playaPanel.lastExport?.exportId ?? null');
    await click('#btnRec');
    const exported = await until('export downloaded', async () => { const e = await evaluate(ps, 'window.__playaPanel.lastExport ? JSON.parse(JSON.stringify(window.__playaPanel.lastExport)) : null'); return e && e.exportId !== previousExport ? e : null; }, 200);
    const saved = await until('download completed', () => downloads.slice(downloadsBefore).find(d => d.state === 'completed') ?? null, 100);
    const fileBytes = await readFile(join(artifact, 'downloads', saved.guid));
    assert.equal(fileBytes.byteLength, exported.bytes);
    const text = fileBytes.toString('utf8');
    const records = text.split('\x1e').filter(t => t.trim()).map(t => JSON.parse(t));
    assert.equal(records[0].file_schema, 'urn:ietf:params:qlog:file:sequential');
    const observations = records.filter(r => JSON.stringify(r).includes('[devtools_observation:v1]'));
    assert.ok(observations.length >= 5, `expected live observations in the trace, got ${observations.length}`);
    assert.ok(!text.includes(pinHex) && !text.includes('hash='), 'the trace must not contain the certificate pin or the page query');
    assert.ok(text.includes('diagnostic_baseline'), 'the recording must declare its sanitized baseline');
    // The recorded FACTS are parsed from the observation records (marker + one JSON value; test/trace-facts.mjs), never
    // grepped: baseline metadata and metric definitions must not satisfy anything. On the MSE arms the recording must
    // carry the same association the live facts pinned: an object whose deliveryId has both stages on one unitId.
    const recorded = recordedFacts(records);
    assert.equal(recorded.malformed.length, 0, `malformed observation suffixes: ${JSON.stringify(recorded.malformed)}`);
    const correlation = stageCorrelation(recorded.facts);
    let locRecorded = null;
    if (!canvas) assert.ok(correlation.correlated, `the trace must carry an object with recorded reconstructed+appended on one unitId, got ${JSON.stringify(correlation.counts)} over ${correlation.objects} objects`);
    else {
      assert.deepEqual([correlation.counts.reconstructed, correlation.counts.appended], [0, 0], 'the LOC arm records no append stages');
      locRecorded = locCorrelation(recorded.facts, { videoTracks, audioTracks, selectedTrack });
      assert.ok(locRecorded.video, `the trace must carry an object of the selected video track with recorded decoded+scheduled+presented on one unit, got ${JSON.stringify(locRecorded.counts)}`);
      assert.equal(locRecorded.audioPresented, 0, 'the trace must not record any presented audio unit');
      if (audioTracks.size) assert.ok(locRecorded.audio, 'the trace must carry an audio object with recorded decoded+scheduled on one unit');
    }
    // The EXACT witnesses the panel showed completing inside the window must be in the file with those stages.
    const recordedWitnesses = { video: recordedUnit(recorded.facts, witnesses.video.deliveryId, witnesses.video.unitId), audio: witnesses.audio ? recordedUnit(recorded.facts, witnesses.audio.deliveryId, witnesses.audio.unitId) : null };
    const tuple = w => ({ trackId: w.trackId, groupId: w.groupId, objectId: w.objectId });
    assert.deepEqual(recordedWitnesses.video.object, tuple(witnesses.video), `the file's video witness object must be exactly ${JSON.stringify(tuple(witnesses.video))}, got ${JSON.stringify(recordedWitnesses.video.object)}`);
    for (const n of (canvas ? ['decoded', 'scheduled', 'presented'] : ['reconstructed', 'appended'])) assert.ok(recordedWitnesses.video.stages.includes(n), `the file lacks ${n} for the video witness unit ${witnesses.video.unitId}: ${JSON.stringify(recordedWitnesses.video)}`);
    assert.ok(!recordedWitnesses.video.stages.includes('discarded'), `the saved ${canvas ? 'presented' : 'appended'} witness unit must not also be discarded: ${JSON.stringify(recordedWitnesses.video)}`);
    if (recordedWitnesses.audio) {
      assert.deepEqual(recordedWitnesses.audio.object, tuple(witnesses.audio), `the file's audio witness object must be exactly ${JSON.stringify(tuple(witnesses.audio))}, got ${JSON.stringify(recordedWitnesses.audio.object)}`);
      for (const n of ['decoded', 'scheduled']) assert.ok(recordedWitnesses.audio.stages.includes(n), `the file lacks ${n} for the audio witness unit: ${JSON.stringify(recordedWitnesses.audio)}`);
      assert.ok(!recordedWitnesses.audio.stages.includes('presented'), 'the audio witness must not be presented in the file');
    }
    step('recording', { bytes: fileBytes.byteLength, records: records.length, observations: observations.length, recordedFacts: recorded.facts.length, stages: correlation.counts, correlated: correlation.correlated,
      ...(locRecorded ? { locStages: locRecorded.counts, locVideo: locRecorded.video, locAudio: locRecorded.audio, audioPresented: locRecorded.audioPresented } : {}),
      recordWindowMs, recordingId, cutSeq: String(cut), witnesses, recordedWitnesses, filename: saved.suggestedFilename });

    // 9. Detach: the owner is ready, and playback keeps PROGRESSING on this arm's evidence afterwards.
    const beforeDetach = await progress();
    // Detach proof. Facts that arrive during the click → disconnect round trip are a legitimate drain and are disclosed
    // separately. The comparison cut is taken only once the detach has COMPLETED: the owner reports `ready` and the
    // core is terminal (phase closed/lost — the owner's disconnect closes the carrier with reason owner-closed; the
    // core keeps its last target for display, so target is evidence, not the predicate) or gone (idle/null). After
    // that, the monotonic fact counter must not move at all while playback progress is checked. No "quiet period" is
    // waited for beyond the progress check itself.
    const factCounter = () => evaluate(ps, '({ facts: window.__pageFactCount, frames: window.__pageFrameCount, last: window.__pageLastFrame })');
    const preRequest = await factCounter();
    await click('#btnDev');
    const detachedHost = await until('detach completed (owner ready, no attachment)', async () => { const h = await hostState();
      // The Detach button sends the owner 'disconnect': the owner closes the carrier (HostCore.terminal('closed',
      // 'owner-closed'), which cancels timers and clears exchange, queue and recording but keeps the last target as
      // history) and then publishes outer 'ready'. Completed = exactly that terminal authority state.
      const c = h?.core;
      const terminal = !c || (c.phase === 'closed' && c.reason === 'owner-closed' && c.inFlight === false && c.queued === 0 && c.recording === null);
      return h?.outer?.stage === 'ready' && terminal ? h : null; }, 100);
    const factsAtDetach = await factCounter();
    await pause(1500);
    const afterDetach = await progress();
    assert.equal(afterDetach.state, 'playing');
    assert.ok(afterDetach.t > beforeDetach.t, `media time must keep advancing after detach (${beforeDetach.t} → ${afterDetach.t})`);
    // Presentation evidence after detach: the page's own callbacks (MSE) or canvas draws + engine frames (LOC).
    if (canvas) assert.ok(afterDetach.presentation.renderedAtUs > beforeDetach.presentation.renderedAtUs && afterDetach.stats.framesRendered > beforeDetach.stats.framesRendered, 'canvas draws must continue after detach');
    else assert.ok(afterDetach.rvfc.presentedFrames > beforeDetach.rvfc.presentedFrames && afterDetach.rvfc.mediaTime > beforeDetach.rvfc.mediaTime, `video-frame callbacks must continue after detach (${JSON.stringify(beforeDetach.rvfc)} → ${JSON.stringify(afterDetach.rvfc)})`);
    const factsAfterDetach = await factCounter();
    // Every sample is validated before comparison (test/fact-counter.mjs): a missing, NaN or zero counter after the
    // positive attached workload fails instead of passing as "unchanged".
    const counterWitness = validateFactCounterWitness({ preRequest, atCompletedDetach: factsAtDetach, afterProgressCheck: factsAfterDetach });
    assert.ok(counterWitness.ok, `no fact (so no stage) may reach the panel after a COMPLETED detach, and the counters must be valid: ${counterWitness.failures.join('; ')} (samples ${JSON.stringify({ preRequest, factsAtDetach, factsAfterDetach })}, core ${JSON.stringify(detachedHost.core && { phase: detachedHost.core.phase, target: detachedHost.core.target })})`);
    step('detached', { before: { t: beforeDetach.t, framesRendered: beforeDetach.stats.framesRendered, rvfc: beforeDetach.rvfc }, after: { t: afterDetach.t, framesRendered: afterDetach.stats.framesRendered, rvfc: afterDetach.rvfc },
      facts: { beforeRequest: preRequest.facts, drainedDuringDetach: factsAtDetach.facts - preRequest.facts, atCompletedDetach: factsAtDetach.facts, afterProgressCheck: factsAfterDetach.facts, validated: counterWitness.ok, frames: { beforeRequest: preRequest.frames, atCompletedDetach: factsAtDetach.frames, after: factsAfterDetach.frames }, lastFrame: factsAfterDetach.last },
      core: detachedHost.core && { phase: detachedHost.core.phase, reason: detachedHost.core.reason, inFlight: detachedHost.core.inFlight, queued: detachedHost.core.queued, recording: detachedHost.core.recording, historicalTarget: detachedHost.core.target } });

    armReport.cleanup = [await stopChild(publisher), await stopChild(relay)];
    armReport.relayTail = (logs[relayName] ?? []).slice(-6);
    armReport.passed = armReport.cleanup.every(c => c.gone !== false);
  }

  await rpc(hs, 'Page.enable').catch(() => {});
  const shot = await rpc(hs, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) await writeFile(join(artifact, 'devtools.png'), Buffer.from(shot.data, 'base64'));
  report.completed = true;
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  try { report.pageAtFailure = await ctx?.pages()?.[0]?.evaluate(() => window.live ? { state: window.live.state, error: window.live.error, t: window.live.currentTime(), codecs: window.live.codecs, events: window.live.events.slice(-10) } : null); } catch { /* page gone */ }
} finally {
  await ctx?.close().catch(() => {});
  staticServer?.close();
  report.cleanup = [];
  for (const c of children) if (c.exitCode === null && c.signalCode === null) report.cleanup.push(await stopChild(c));
}
report.backendAfter = await backendFingerprint();
report.backendUnchanged = report.backendBefore.sha256 === report.backendAfter.sha256;
report.errorCount = report.errors.length + report.consoleDropped;
report.cleanupProven = [...report.cleanup, ...Object.values(report.arms).flatMap(a => a.cleanup ?? [])].every(x => x.gone === true || x.gone === null);
report.passed = report.completed === true && !report.fatal && report.errorCount === 0 && report.cleanupProven === true && report.backendUnchanged === true && arms.every(a => report.arms[a]?.passed);
await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
