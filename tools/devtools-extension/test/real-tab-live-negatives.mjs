// Negative boundary gate for the LIVE player path: the same real-player recipe as test/real-tab-live.mjs (toy relay +
// fixture publisher on loopback, labelled TEST BUILD of the extension, real DevTools frontend readiness, target-safe
// native clicks) applied to four explicitly controlled conditions that the positive arms cannot show:
//
//   plain        a MINIFIED production page with the real player and NO diagnostics import or install. The emitted
//                bundle graph (Rollup module ids captured by a build plugin) contains no diagnostics, Probe, protocol,
//                trace-recorder or media-tracker leaf; Attach cannot discover or attach it; the engine's public
//                snapshot never gains a media-stage tracker; no new WebTransport is constructed; no fact reaches the
//                panel; playback keeps progressing.
//   two-players  two real players in ONE registry on separate namespaces: the attached source's data envelopes carry
//                its own target (source + run) and its track facts only its own namespace; a switch isolates the second
//                after completion; registering the same player again — through its facade and through its engine — is
//                refused by the real API with the original identity and observation intact.
//   silent       accepted video AND audio subscriptions that never deliver (test-only publisher: real catalog,
//                PUBLISH accepted, no AV objects): the panel shows accepted requests with NO object or stage facts for
//                those tracks, invents no group row, records an empty-of-AV trace, and the engine's own startup fault
//                is observed explicitly afterwards (recorded whether or not it occurred within the window).
//   freeze       an app-induced presentation freeze on MSE (`video.pause()`): NEW selected-video object receipts and
//                correlated NEW `appended` units keep arriving after the cut (batch seq, deliveryId, unitId) while the
//                playhead and rVFC stay at their last values and the reported presented-frames metric (a finite
//                observed value) does not move; playback resumes on `play()`.
//
// Intended assertions are typed witnesses (`intended(name, …)` from ../src/negatives-verdict.mjs). Controls
// (`--control=`) induce one real condition each and pass ONLY when their case fails on the NAMED witness after its
// setup step, with a completed harness, zero unrelated exceptions, unchanged source and proven cleanup (verdict:
// negativesVerdict, pure, tested in src/negatives-verdict.test.ts):
//   discoverable-plain   the diagnostics page replaces the plain page → plain must fail `no-source-discovered`
//   swap-identity        the expected attached identity is the other player → two-players must fail `attached-target-identity`
//   objects-on-silent    the publisher sends ONE video object AFTER attach + accepted requests (file trigger, send
//                        witness in its log) → silent must fail `no-media-objects`
//   no-pause             the freeze case never pauses → freeze must fail `presentation-frozen`
//
// Test-only instrumentation, named here and in the report: the panel frame ring + monotonic fact counter (as in the
// live gate); on the plain page ONLY, a `WebTransport` construction counter installed before navigation; the
// publisher's file trigger (control only). No shipped behaviour changes; the gated live page is used unmodified.
//
// Usage: node test/real-tab-live-negatives.mjs [--case=plain,two-players,silent,freeze] [--control=…] [--fixture=dir]
// Browser: PLAYA_DEVTOOLS_LIVE_BROWSER (codec-capable Chromium / Chrome for Testing), else Playwright's Chromium.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { access, cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPlayaPanel } from './devtools-frontend.mjs';
import { createNativeClick } from './native-click.mjs';
import { countFacts, frameMeta, ringCoverage } from './fact-counter.mjs';
import { recordedFacts, windowedChain } from './trace-facts.mjs';
import { CONTROLS, INTENDED, intended, negativesVerdict } from '../src/negatives-verdict.mjs';

const startedAt = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..');
const repoRoot = resolve(extensionDir, '../..');
const { chromium } = createRequire(join(repoRoot, 'package.json'))('playwright');
const argOf = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ALL = ['plain', 'two-players', 'silent', 'freeze'];
const control = argOf('control') ?? null;
if (control !== null && !CONTROLS[control]) throw new Error(`unknown --control=${control}`);
const cases = control ? [CONTROLS[control].case] : (argOf('case') ?? ALL.join(',')).split(',');
for (const c of cases) if (!ALL.includes(c)) throw new Error(`unknown case ${c}`);
const browserExecutable = process.env.PLAYA_DEVTOOLS_LIVE_BROWSER ?? null;
const pause = ms => new Promise(r => setTimeout(r, ms));
const artifact = await mkdtemp(join(tmpdir(), 'playa-devtools-live-negatives-'));
const report = { artifact, control, cases: {}, passed: false, errors: [], consoleDropped: 0, cleanupErrors: [],
  runtime: { platform: process.platform, arch: process.arch, node: process.version, browserExecutable },
  instrumentation: ['panel frame ring + monotonic fact counter (test/fact-counter.mjs) installed into the panel view', 'plain page only: WebTransport construction counter installed before navigation', 'objects-on-silent control only: publisher file trigger'] };
const noteError = text => { if (report.errors.length >= 50) { report.consoleDropped++; return; } report.errors.push(String(text).slice(0, 300)); };
const children = []; const logs = {};
function launch(name, cmd, args, env = {}, cwd = repoRoot) {
  logs[name] ??= [];
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.push(child);
  const sink = data => { for (const line of String(data).split('\n')) if (line.trim() && logs[name].length < 5000) logs[name].push(line); };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
  return child;
}
const waitForLine = async (name, re, tries = 600) => { for (let i = 0; i < tries; i++) { const hit = (logs[name] ?? []).map(l => l.match(re)).find(Boolean); if (hit) return hit; await pause(100); } throw new Error(`${name}: no line matching ${re} (last: ${(logs[name] ?? []).slice(-15).join(' | ')})`); };
const posix = process.platform !== 'win32';
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const signalGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { /* gone */ } };
const waitGone = async (pid, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (!groupAlive(pid)) return true; await pause(100); } return !groupAlive(pid); };
/** Owned child cleanup. Unavailable liveness evidence (non-POSIX, no pid) is `gone: null` and is NOT counted as proven. */
async function stopChild(child) {
  if (!posix || !child.pid) return { pid: child.pid ?? null, gone: null, note: 'group liveness unavailable on this platform' };
  signalGroup(child.pid, 'SIGTERM');
  let gone = await waitGone(child.pid, 5000), killed = false;
  if (!gone) { killed = true; signalGroup(child.pid, 'SIGKILL'); gone = await waitGone(child.pid, 3000); }
  return { pid: child.pid, gone, killed };
}
/** Same file set as the live gate, so the hash is comparable to its reports. */
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
  for (const f of files) { hash.update(relative(repoRoot, f)); try { hash.update(await readFile(f)); } catch { hash.update('<missing>'); } }
  return { files: files.length, sha256: hash.digest('hex') };
}
const fileHash = async p => createHash('sha256').update(await readFile(p)).digest('hex').slice(0, 16);
const hexText = hex => Buffer.from(hex, 'hex').toString('utf8');
const toHex = text => Buffer.from(text, 'utf8').toString('hex');

// 1. Labelled TEST BUILD (pre-granted loopback origin), hashed; the pages and helper this gate owns, hashed separately.
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
// Inputs this gate depends on but the backend fingerprint intentionally excludes: its pages, the publisher helper, the
// gate itself and its helpers. Hashed before and after; both verdict modes require them unchanged.
const gateInputs = async () => Object.fromEntries(await Promise.all(['live-page/plain.html', 'live-page/plain.ts', 'live-page/two-players.html', 'live-page/two-players.ts', 'silent-publisher.ts', 'real-tab-live-negatives.mjs', 'fact-counter.mjs', 'trace-facts.mjs', 'native-click.mjs', 'devtools-frontend.mjs', '../src/negatives-verdict.mjs'].map(async f => [f, await fileHash(join(here, f))])));
report.negativePages = await gateInputs();

let ctx; let staticServer = null;
try {
  // 2. Certificate + pin; fixtures (the CMAF fixture, and a copy under a second namespace for the two-player case).
  await new Promise((ok, fail) => { const c = launch('cert', process.execPath, [join(repoRoot, 'examples/node-relay/scripts/gen-cert.mjs'), '--out-dir', join(artifact, 'certs')]); c.on('close', code => code === 0 ? ok() : fail(new Error(`gen-cert exited ${code}`))); });
  const certPath = join(artifact, 'certs/cert.pem'), keyPath = join(artifact, 'certs/key.pem');
  const pinHex = new X509Certificate(await readFile(certPath)).fingerprint256.replaceAll(':', '').toLowerCase();
  const { prepareFixture } = await import(join(repoRoot, 'scripts/player-acceptance/fixture.mjs'));
  const cmafDir = argOf('fixture') ?? join(repoRoot, 'examples/node-publisher/fixtures/test-pattern');
  let fixture;
  try { await access(join(cmafDir, 'manifest.json')); const m = JSON.parse(await readFile(join(cmafDir, 'manifest.json'), 'utf8')); fixture = { dir: cmafDir, namespaceParts: m.namespace, namespace: m.namespace.join('/'), origin: 'prepared' }; }
  catch { const dir = join(artifact, 'fixture-cmaf'); await prepareFixture(dir, 'negatives', false, new AbortController().signal); fixture = { dir, namespaceParts: ['negatives'], namespace: 'negatives', origin: 'generated (ffmpeg, aac)' }; }
  let fixtureB = null;
  if (cases.includes('two-players')) {
    const dir = join(artifact, 'fixture-b'); await cp(fixture.dir, dir, { recursive: true });
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')); m.namespace = ['negatives', 'second'];
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
    fixtureB = { dir, namespaceParts: m.namespace, namespace: m.namespace.join('/'), origin: `copy of ${fixture.origin} under a second namespace` };
  }
  report.fixtures = { a: fixture, b: fixtureB };

  // 3. Pages: Vite dev server on workspace sources (two-players, and the gated live page for silent/freeze), plus a
  //    MINIFIED production build of the plain page served statically, with its emitted module graph captured.
  launch('vite', process.execPath, [join(here, 'live-page/serve.mjs')]);
  const devBase = (await waitForLine('vite', /Live page: (http:\/\/127\.0\.0\.1:\d+\/tools\/devtools-extension\/test\/live-page\/)/))[1];
  let prodBase = null, prodBuild = null;
  if (cases.includes('plain')) {
    const { build } = await import(createRequire(join(repoRoot, 'examples/package.json')).resolve('vite'));
    const outDir = join(artifact, 'dist-prod');
    const entry = control === 'discoverable-plain' ? 'live-page/index.html' : 'live-page/plain.html';
    const modules = [];   // { id, renderedLength } for every module Rollup emitted into a chunk
    const graphPlugin = { name: 'negatives-gate-graph', generateBundle(_, bundle) { for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') for (const [id, m] of Object.entries(chunk.modules)) modules.push({ id, renderedLength: m.renderedLength }); } };
    await build({ root: repoRoot, configFile: join(repoRoot, 'examples/vite.config.ts'), logLevel: 'warn', plugins: [graphPlugin],
      build: { outDir, emptyOutDir: true, minify: true, sourcemap: false, rollupOptions: { input: join(here, entry) } } });
    const assets = await readdir(join(outDir, 'assets')).catch(() => []);
    const bundles = await Promise.all(assets.filter(a => a.endsWith('.js')).map(a => readFile(join(outDir, 'assets', a), 'utf8')));
    // Graph boundary, the same one scripts/smoke-devtools.mjs pins for a normal Playa consumer: no diagnostics,
    // protocol or Probe package and no optional media-tracker implementation (media-diagnostics.ts). Core diagnostic
    // interfaces/branches inside the player (e.g. the lazy media-stage-observers host) are allowed. The trace recorder
    // (re-exported by the player package index) and that host are DISCLOSED with their rendered bytes, not forbidden.
    // Module ids are workspace SOURCE paths (the examples Vite config aliases to src).
    const rel = modules.map(m => ({ file: relative(repoRoot, m.id.split('?')[0]), renderedLength: m.renderedLength }));
    const forbidden = rel.filter(m => /^packages\/devtools(?:-protocol|-probe)?\//.test(m.file) || /^packages\/player\/src\/media-diagnostics\.ts$/.test(m.file));
    const disclosed = rel.filter(m => /\/qlog\/trace-recorder\.ts$/.test(m.file) || /^packages\/player\/src\/media-stage-observers\.ts$/.test(m.file) || /^packages\/player\/src\/trace-recorder\.ts$/.test(m.file));
    prodBuild = { outDir, entry, assets: assets.length, minified: true, modules: rel.length, renderedModules: rel.filter(m => m.renderedLength > 0).length,
      diagnosticModules: forbidden, disclosedModules: disclosed, playerModules: rel.filter(m => m.file.startsWith('packages/player/')).length,
      bridgeMarkerPresent: bundles.some(b => b.includes('openmoq.devtools.page-bridge')) };
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    staticServer = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      try { const body = await readFile(join(outDir, path)); res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise(r => staticServer.listen(0, '127.0.0.1', r));
    prodBase = `http://127.0.0.1:${staticServer.address().port}/tools/devtools-extension/test/live-page/`;
    report.productionBuild = prodBuild;
  }

  ctx = await chromium.launchPersistentContext(join(artifact, 'profile'), { headless: false, ...(browserExecutable ? { executablePath: browserExecutable } : {}),
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--auto-open-devtools-for-tabs', '--disable-background-networking', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,1000'] });
  report.browser = ctx.browser().version();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('pageerror', e => noteError(`page: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') noteError(`page console: ${m.text()}`); });
  // TEST-ONLY (plain page evidence): count WebTransport constructions in the inspected page from before its scripts run.
  await page.addInitScript(() => { window.__wtConstructions = 0; const W = window.WebTransport; if (W) window.WebTransport = new Proxy(W, { construct(t, a, n) { window.__wtConstructions++; return Reflect.construct(t, a, n); } }); });
  await page.goto('data:text/html,<title>live negatives</title>');

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
  /** Bounded poll that returns null when the condition never held — for conditions whose absence is itself evidence. */
  const poll = async (fn, tries) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await pause(100); } return null; };
  const watch = (sessionId, label) => root.on('Target.receivedMessageFromTarget', e => { if (e.sessionId !== sessionId) return; const m = JSON.parse(e.message);
    if (m.method === 'Runtime.exceptionThrown') noteError(`${label} exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') noteError(`${label} console: ${m.params.args?.map(a => a.value ?? a.description).join(' ')}`); });
  await findTarget(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/devtools.html'));
  const dts = (await targets()).filter(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/devtools.html'));
  assert.equal(dts.length, 1);
  const dtSession = await attach(dts[0].targetId); watch(dtSession, 'owner'); await rpc(dtSession, 'Runtime.enable');
  const identity = await until('owner identity', () => evaluate(dtSession, 'globalThis.__playaOwner ? JSON.parse(JSON.stringify(globalThis.__playaOwner)) : null'));
  const host = await findTarget(t => t.url.startsWith('devtools://')); const hs = await attach(host.targetId);
  report.frontend = await openPlayaPanel({ evaluate, session: hs });
  const panel = await findTarget(t => t.type === 'iframe' && t.url.includes('/panel.html') && t.url.includes(`owner=${identity.ownerId}`));
  assert.ok(panel, 'panel iframe for this owner not found');
  const ps = await attach(panel.targetId); watch(ps, 'panel'); await rpc(ps, 'Runtime.enable');
  await until('panel hook', () => evaluate(ps, 'window.__playaPanel ? true : null'));
  // TEST-ONLY: bounded frame ring (256, diagnosis) with a MONOTONIC index per retained frame and an eviction count, plus
  // the monotonic fact counter, as in the live gate. Absence claims over an interval are admitted only when
  // ringCoverage proves no frame of that interval fell out (test/fact-counter.mjs).
  await evaluate(ps, `(() => { const hook = window.__playaPanel; if (hook.__gateWrapped) return true;
    const countFacts = ${countFacts.toString()}; const frameMeta = ${frameMeta.toString()};
    const frames = window.__pageFrames = []; window.__pageFactCount = 0; window.__pageFrameCount = 0; window.__pageLastFrame = null; window.__pageEvicted = 0;
    const original = hook.applyEncoded.bind(hook);
    hook.applyEncoded = (text, lane = 'page') => { if (lane === 'page') { if (frames.length >= 256) { frames.shift(); window.__pageEvicted++; } frames.push({ i: window.__pageFrameCount, text });
      window.__pageFactCount += countFacts(text); window.__pageFrameCount++; window.__pageLastFrame = frameMeta(text); } return original(text, lane); };
    hook.__gateWrapped = true; return true; })()`);
  const ringState = () => evaluate(ps, '({ nextIndex: window.__pageFrameCount, firstRetainedIndex: window.__pageFrames[0]?.i ?? null, evicted: window.__pageEvicted, retained: window.__pageFrames.length })');
  /** A mark for later absence claims: the next frame index and the eviction count now. */
  const ringMark = async () => { const r = await ringState(); return { cutoffIndex: r.nextIndex, evictedAt: r.evicted }; };
  /** Clears the ring (a new interval starts) and marks it. */
  const resetRing = async () => { await evaluate(ps, 'window.__pageFrames.length = 0; true'); return ringMark(); };
  /** Fails an absence claim whose interval is not fully retained. */
  const coverage = async (mark, label) => { const r = await ringState(); const c = ringCoverage({ cutoffIndex: mark.cutoffIndex, firstRetainedIndex: r.firstRetainedIndex, nextIndex: r.nextIndex, evictedSinceCutoff: r.evicted - mark.evictedAt });
    assert.ok(c.ok, `${label}: the frame ring does not cover the judged interval: ${c.failures.join('; ')} (${JSON.stringify(r)})`); return r; };
  const { decodeMessage } = await import(join(repoRoot, 'packages/devtools-protocol/dist/index.js'));
  const hostState = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel?.host ?? null))');
  const pageVm = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel.vms.page))');
  const factCounter = () => evaluate(ps, '({ facts: window.__pageFactCount, frames: window.__pageFrameCount, last: window.__pageLastFrame })');
  /** Decoded page-lane frames with their monotonic index. Only snapshot/batch carry a target ENVELOPE; hello/ack are control frames. */
  const pageFramesIndexed = async () => (await evaluate(ps, 'JSON.parse(JSON.stringify(window.__pageFrames ?? []))'))
    .map(f => { const r = decodeMessage(f.text); if (!r.ok) throw new Error(`gate decode failed: ${r.error.code}`); return { i: f.i, message: r.message }; });
  const pageMessages = async () => (await pageFramesIndexed()).map(f => f.message);
  const isData = m => m.kind === 'snapshot' || m.kind === 'batch';
  const factsOf = msgs => msgs.filter(isData).flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.facts.map(o => o.fact));
  const pageFacts = async () => factsOf(await pageMessages());
  /** Facts WITH provenance: batch events keep their exact decimal seq; snapshot facts carry none. */
  const pageEvents = async () => (await pageMessages()).flatMap(m => m.kind === 'batch' ? m.events.map(ev => ({ seq: ev.seq, clockId: ev.clockId, timeMs: ev.timeMs, fact: ev.fact })) : m.kind === 'snapshot' ? m.facts.map(o => ({ seq: null, clockId: o.clockId, timeMs: o.timeMs, fact: o.fact })) : []);
  const click = createNativeClick({ evaluate, rpc, session: () => ps });
  const recLabel = () => evaluate(ps, `document.getElementById('recLabel').textContent`);
  const ownerReadyFor = origin => until('owner ready for this document', async () => { const h = await hostState(); return h?.outer?.stage === 'ready' && h.outer.origin === origin ? h : null; }, 100);
  /** The granted origin attaches by itself and selects the page's single source; no click is sent. */
  const attachFirst = async () => until('attached automatically', async () => { const h = await hostState(); return h?.core?.phase === 'attached' ? h : null; }, 200);
  const startRelayAndPublisher = async (name, fx, publisherArgs) => {
    const relay = launch(`relay-${name}`, 'pnpm', ['--filter', '@moqt/example-node-relay', 'relay-server'], { HOST: '127.0.0.1', PORT: '0', DEMO_NAMESPACE: fx.namespace, RELAY_CERT: certPath, RELAY_KEY: keyPath });
    const relayUrl = (await waitForLine(`relay-${name}`, /listening on (https:\/\/127\.0\.0\.1:\d+\/moq)/))[1];
    const publisher = launch(`publisher-${name}`, ...publisherArgs(relayUrl));
    try { await waitForLine(`publisher-${name}`, /tracks established/); }
    catch (e) { throw new Error(`${e.message}\nrelay log tail: ${(logs[`relay-${name}`] ?? []).slice(-25).join(' | ')}`); }
    return { relay, relayUrl, publisher };
  };
  const cmafPublisher = fx => relayUrl => ['pnpm', ['--filter', '@moqt/example-node-publisher', 'publish-fixture', '--loop', '--pace-media', '--catalog-format', 'cmsf-01', relayUrl, fx.dir], { RELAY_CERT: certPath }];
  const liveProgress = () => page.evaluate(() => ({ state: window.live.state, error: window.live.error, t: window.live.currentTime(), rvfc: window.live.rvfc(), stats: JSON.parse(JSON.stringify(window.live.stats())) }));
  const tracksByType = facts => ({ video: new Set(facts.filter(f => f.kind === 'track' && f.mediaType === 'video').map(f => f.trackId)), audio: new Set(facts.filter(f => f.kind === 'track' && f.mediaType === 'audio').map(f => f.trackId)) });

  const runCase = async (name, fn) => {
    const c = { name, steps: [], passed: false, error: null, intendedFailure: null }; report.cases[name] = c;
    const step = (label, data = {}) => c.steps.push({ step: label, ...data });
    const procs = [];
    try { await fn(step, procs); c.passed = true; }
    catch (e) { c.error = String(e?.stack ?? e); c.intendedFailure = e?.intended ?? null; if (!control) throw e; }
    finally { c.cleanup = []; for (const p of procs) c.cleanup.push(await stopChild(p)); }
  };

  // ───────────────────────────────── plain ─────────────────────────────────
  if (cases.includes('plain')) await runCase('plain', async (step, procs) => {
    const { relay, relayUrl, publisher } = await startRelayAndPublisher('plain', fixture, cmafPublisher(fixture)); procs.push(publisher, relay);
    const pageFile = control === 'discoverable-plain' ? 'index.html' : 'plain.html';
    step('production graph', prodBuild);
    if (control !== 'discoverable-plain') {
      assert.deepEqual(prodBuild.diagnosticModules, [], `the plain production bundle must contain no diagnostics/Probe/protocol package or media-tracker implementation: ${JSON.stringify(prodBuild.diagnosticModules)}`);
      assert.equal(prodBuild.bridgeMarkerPresent, false, 'the page-bridge symbol must not appear in the plain bundle');
      assert.ok(prodBuild.playerModules > 0, 'the real player is bundled');
    }
    const query = new URLSearchParams({ url: relayUrl, ns: fixture.namespace, hash: pinHex, exposure: 'production' });
    await page.goto(`${prodBase}${pageFile}?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.live !== undefined);
    const installed = await page.evaluate(() => ({ installed: window.live.installed, bridgeInstalled: window.live.bridgeInstalled }));
    step('page', { pageFile, ...installed });
    await page.click('#start');
    await page.waitForFunction(() => window.live.state === 'playing' || window.live.error, { timeout: 30000 });
    const p0 = await until('media advancing', async () => { const p = await liveProgress(); return p.t > 0.5 ? p : null; }, 300);
    const before = await page.evaluate(() => ({ wt: window.__wtConstructions, snapshot: window.live.diagnosticSnapshot ? window.live.diagnosticSnapshot() : null }));
    step('playing before attach', { t: p0.t, rvfc: p0.rvfc, ...before });
    await evaluate(ps, 'window.__pageFactCount = 0; true'); const plainMark = await resetRing();
    // The granted origin triggers ONE automatic attempt on this document (no click); it must settle without discovery.
    const phases = new Set();
    const outcome = await until('automatic attach attempt settled', async () => { const h = await hostState(); if (h?.core?.phase) phases.add(h.core.phase);
      return h?.outer?.stage === 'carrier-lost' || h?.outer?.stage === 'not-attached' || h?.core?.phase === 'discovered' || h?.core?.phase === 'attached' ? h : null; }, 150);
    if (phases.has('attached')) phases.add('discovered');
    const ui = await evaluate(ps, `({ pickListHidden: document.getElementById('pickList').classList.contains('hidden'), picks: document.querySelectorAll('#pickList .inst').length, title: document.getElementById('emptyTitle').textContent, notice: document.querySelector('.notice.host')?.textContent ?? null })`);
    step('attach attempt', { outer: outcome.outer, core: outcome.core && { phase: outcome.core.phase, reason: outcome.core.reason, sources: outcome.core.sources?.length ?? null }, phasesSeen: [...phases], ui });
    intended(INTENDED.plain, !phases.has('discovered'), `a source was discovered on the plain page: phases ${JSON.stringify([...phases])}, sources ${JSON.stringify(outcome.core?.sources)}`);
    assert.equal(outcome.outer.stage, 'carrier-lost', `expected the carrier to be given up (no bridge answered), got ${JSON.stringify(outcome.outer)}`);
    assert.equal(ui.picks, 0); assert.ok(ui.pickListHidden);
    assert.equal(ui.title, 'No Playa diagnostics answered on this page.', 'the empty title must say nothing answered, not that sources were found absent');
    await pause(1500);
    const after = await page.evaluate(() => ({ wt: window.__wtConstructions, snapshot: window.live.diagnosticSnapshot ? window.live.diagnosticSnapshot() : null }));
    const p1 = await liveProgress(); await pause(1200); const p2 = await liveProgress();
    const facts = await factCounter(); const ring = await coverage(plainMark, 'plain: no fact reached the panel');
    step('after attempt', { ...after, facts: facts.facts, frames: facts.frames, ring, t: [p1.t, p2.t], rvfc: [p1.rvfc, p2.rvfc], relayTail: (logs['relay-plain'] ?? []).slice(-4) });
    assert.equal(before.wt, 1, 'the player opens exactly one WebTransport for playback');
    assert.equal(after.wt, before.wt, `WebTransport constructions changed across the attach attempt: ${before.wt} → ${after.wt}`);
    assert.equal(after.snapshot?.hasMediaStages, false, `the engine snapshot gained a media-stage tracker: ${JSON.stringify(after.snapshot)}`);
    assert.equal(facts.facts, 0, `${facts.facts} fact(s) reached the panel from a page without a bridge`);
    assert.equal(p2.state, 'playing'); assert.ok(p2.t > p1.t && p2.rvfc.presentedFrames > p1.rvfc.presentedFrames, `playback must keep progressing (${p1.t} → ${p2.t}; rVFC ${p1.rvfc.presentedFrames} → ${p2.rvfc.presentedFrames})`);
  });

  // ────────────────────────────── two-players ──────────────────────────────
  if (cases.includes('two-players')) await runCase('two-players', async (step, procs) => {
    const A = await startRelayAndPublisher('a', fixture, cmafPublisher(fixture)); procs.push(A.publisher, A.relay);
    const B = await startRelayAndPublisher('b', fixtureB, cmafPublisher(fixtureB)); procs.push(B.publisher, B.relay);
    const query = new URLSearchParams({ urlA: A.relayUrl, nsA: fixture.namespace, urlB: B.relayUrl, nsB: fixtureB.namespace, hash: pinHex, exposure: 'development' });
    await page.goto(`${devBase}two-players.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.live?.installed && window.live?.bridgeInstalled);
    await page.click('#start');
    const both = () => page.evaluate(() => ({ a: window.live.a(), b: window.live.b() }));
    const v0 = await until('both players advancing', async () => { const v = await both(); return v.a.t > 0.5 && v.b.t > 0.5 && !v.a.error && !v.b.error ? v : null; }, 400);
    assert.notEqual(v0.a.sourceId, v0.b.sourceId); assert.notEqual(v0.a.runId, v0.b.runId);
    step('both playing', { a: v0.a, b: v0.b });
    const expectFirst = control === 'swap-identity' ? v0.b : v0.a;      // the control expects the WRONG player
    await evaluate(ps, 'window.__pageFactCount = 0; true'); const attachMark = await resetRing();
    // Automatic attach discovers both players; with TWO sources nothing is selected until the user picks.
    const discovered = await until('discovered automatically', async () => { const h = await hostState(); return h?.core?.phase === 'discovered' && h.outer.origin === new URL(devBase).origin ? h : null; }, 200);
    await pause(300);
    assert.equal((await hostState()).core.phase, 'discovered', 'two sources must not be auto-selected');
    assert.equal(discovered.core.sources.length, 2);
    assert.deepEqual(new Set(discovered.core.sources.map(s => s.sourceId)), new Set([v0.a.sourceId, v0.b.sourceId]));
    // Pick A by identity: the pick list renders the owner's sources in order (labels may be module names; both recorded).
    const indexA = discovered.core.sources.findIndex(s => s.sourceId === v0.a.sourceId) + 1;
    const listed = await evaluate(ps, `[...document.querySelectorAll('#pickList .inst .name')].map(n => n.textContent)`);
    assert.ok(indexA >= 1 && listed.length === 2, `player A is listed (${JSON.stringify({ sources: discovered.core.sources.map(s => s.sourceId), listed })})`);
    await click(`#pickList .inst:nth-child(${indexA})`);
    const attached = await until('attached', async () => { const h = await hostState(); return h?.core?.phase === 'attached' ? h : null; }, 100);
    intended(INTENDED['two-players'], attached.core.target.sourceId === expectFirst.sourceId && attached.core.target.runId === expectFirst.runId,
      `attached target ${JSON.stringify({ sourceId: attached.core.target.sourceId, runId: attached.core.target.runId })} is not the picked player ${JSON.stringify({ sourceId: expectFirst.sourceId, runId: expectFirst.runId })}`);
    // Source scope travels in the data ENVELOPE (target.sourceId/runId). `mark` (a monotonic frame index + eviction
    // count) separates frames that arrived before a switch completed (the previous lease's legitimate drain) from frames
    // after completion; the absence claim is admitted only when the ring still covers everything since the mark.
    const scopedEvidence = async (label, expected, otherParts, mark) => {
      const indexed = await until(`${label}: facts with objects`, async () => { const f = await pageFramesIndexed(); return f.some(x => x.i >= mark.cutoffIndex && x.message.kind === 'batch' && x.message.target.sourceId === expected.sourceId && x.message.events.some(e => e.fact.kind === 'object')) ? f : null; }, 200);
      const ring = await coverage(mark, label);
      const msgs = indexed.map(f => f.message);
      const afterCompletion = indexed.filter(f => f.i >= mark.cutoffIndex && isData(f.message)).map(f => f.message);
      const foreign = afterCompletion.filter(m => m.target.sourceId !== expected.sourceId || m.target.runId !== expected.runId).map(m => `${m.kind} ${m.target.sourceId}/${m.target.runId}`);
      assert.ok(afterCompletion.length >= 1, `${label}: no data envelopes after completion`);
      assert.deepEqual(foreign, [], `${label}: after completion every data envelope must name ${expected.sourceId}/${expected.runId}; foreign: ${JSON.stringify(foreign)}`);
      const otherKinds = indexed.filter(f => f.i >= mark.cutoffIndex && !isData(f.message)).map(f => f.message.kind);
      // Track identity for THIS source: exact namespace field arrays from its own snapshot/batches, selected by envelope.
      const facts = factsOf(msgs.filter(m => isData(m) && m.target.sourceId === expected.sourceId && m.target.runId === expected.runId));
      const namespaces = facts.filter(f => f.kind === 'track').map(f => f.identity.namespace);
      assert.ok(namespaces.length >= 1, `${label}: no track facts for ${expected.sourceId}`);
      for (const ns of namespaces) assert.deepEqual(ns, expected.namespaceParts.map(toHex), `${label}: track namespace ${JSON.stringify(ns.map(hexText))} must be exactly ${JSON.stringify(expected.namespaceParts)}`);
      assert.ok(!namespaces.some(ns => JSON.stringify(ns) === JSON.stringify(otherParts.map(toHex))), `${label}: the other player's namespace leaked`);
      const trackIds = new Set(facts.filter(f => f.kind === 'track').map(f => f.trackId));
      const objects = facts.filter(f => f.kind === 'object');
      assert.ok(objects.length >= 1 && objects.every(o => trackIds.has(o.trackId)), `${label}: object facts must belong to this source's tracks`);
      return { envelopes: afterCompletion.length, otherKinds, namespaces: [...new Set(namespaces.map(ns => ns.map(hexText).join('/')))], objects: objects.length, tracks: trackIds.size, ring };
    };
    const evA = await scopedEvidence('attached to A', { ...v0.a, namespaceParts: fixture.namespaceParts }, fixtureB.namespaceParts, attachMark);
    step('attached to A', { target: attached.core.target, ...evA, bProgressing: (await both()).b.objectsReceived > v0.b.objectsReceived });
    // Switch to B (detach-then-attach at the page). The mark is taken at COMPLETION: frames before it may be A's drain
    // (disclosed), frames at or after it must all be B's; B's snapshot may sit before the mark and still identifies B.
    const clickMark = await ringMark();
    await click('#instances .inst:not(.on)');
    const switched = await until('switched to B', async () => { const h = await hostState(); return h?.core?.phase === 'attached' && h.core.target.sourceId === v0.b.sourceId ? h : null; }, 150);
    const cutCounter = await factCounter(); const switchMark = await ringMark();
    const drained = (await pageFramesIndexed()).filter(f => f.i >= clickMark.cutoffIndex && f.i < switchMark.cutoffIndex && isData(f.message)).map(f => `${f.message.kind} ${f.message.target.sourceId}`);
    const evB = await scopedEvidence('switched to B', { ...v0.b, namespaceParts: fixtureB.namespaceParts }, fixture.namespaceParts, switchMark);
    step('switched to B', { target: switched.core.target, factsAtSwitch: cutCounter.facts, framesBetweenClickAndCompletion: drained, ...evB });
    // Duplicate registration through the REAL API: facade A again, and A's engine against the same registry.
    const dup = await page.evaluate(() => window.live.duplicate());
    const v1 = await both();
    step('duplicate registration', { attempts: dup, a: v1.a, b: v1.b });
    for (const d of dup) assert.ok(d.refused && /already/i.test(d.message ?? ''), `duplicate registration must be refused with the real reason: ${JSON.stringify(d)}`);
    assert.deepEqual({ sourceId: v1.a.sourceId, runId: v1.a.runId }, { sourceId: v0.a.sourceId, runId: v0.a.runId }, 'player A keeps its identity after the refused duplicates');
    await pause(1200); const v2 = await both(); const after = await factCounter();
    assert.ok(v2.a.t > v1.a.t && v2.b.t > v1.b.t, `both players keep playing after the refused duplicates (${v1.a.t}→${v2.a.t}, ${v1.b.t}→${v2.b.t})`);
    assert.ok(after.facts > cutCounter.facts, 'facts from the attached player B keep flowing after the refused duplicates');
    assert.equal((await hostState()).core.target.sourceId, v0.b.sourceId, 'the lease stays with B');
  });

  // ───────────────────────────────── silent ────────────────────────────────
  if (cases.includes('silent')) await runCase('silent', async (step, procs) => {
    const trigger = join(artifact, 'silent-control-trigger');
    const silentArgs = relayUrl => ['pnpm', ['--filter', '@moqt/example-node-publisher', 'exec', 'tsx', join(here, 'silent-publisher.ts'), relayUrl, fixture.dir, ...(control === 'objects-on-silent' ? [`--trigger=${trigger}`] : [])], { RELAY_CERT: certPath }];
    const { relay, relayUrl, publisher } = await startRelayAndPublisher('silent', fixture, silentArgs); procs.push(publisher, relay);
    const query = new URLSearchParams({ url: relayUrl, ns: fixture.namespace, hash: pinHex, exposure: 'development' });
    await evaluate(ps, 'window.__pageFactCount = 0; true'); const silentMark = await resetRing();   // before load: the auto-attach snapshot must be retained
    await page.goto(`${devBase}index.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.live?.installed && window.live?.bridgeInstalled);
    const t0 = Date.now();
    await page.click('#start');
    await attachFirst();
    // Accepted VIDEO and AUDIO subscriptions, identified from the source's own track facts (the fixture/player picks the
    // renditions; every advertised one is not required), well inside the engine's bootstrap fault.
    const { media, accepted } = await until('accepted video and audio subscriptions', async () => { const f = await pageFacts(); const t = tracksByType(f);
      const acc = f.filter(x => x.kind === 'request' && x.state === 'accepted');
      const video = acc.filter(r => t.video.has(r.trackId)), audio = acc.filter(r => t.audio.has(r.trackId));
      return video.length >= 1 && audio.length >= 1 ? { media: new Set([...t.video, ...t.audio]), accepted: { video: video.map(r => r.requestId), audio: audio.map(r => r.requestId) } } : null; }, 80);
    const acceptedAt = Date.now() - t0;
    await pause(3000);
    const judge = async label => {
      const ring = await coverage(silentMark, `${label}: absence of media objects`);
      const f = await pageFacts(); const vm = await pageVm(); const p = await liveProgress();
      const mediaObjects = f.filter(x => x.kind === 'object' && media.has(x.trackId));
      const stages = f.filter(x => x.kind === 'stage');
      const otherObjects = f.filter(x => x.kind === 'object' && !media.has(x.trackId));
      const latest = name => f.filter(x => x.kind === 'metric' && x.name === name).at(-1) ?? null;
      const ev = { mediaTracks: [...media], accepted, mediaObjects: mediaObjects.length, stageFacts: stages.length, nonMediaObjects: otherObjects.length,
        rows: vm.rows.length, requestsShown: vm.requests.length, cellsPresent: vm.rows.flatMap(r => r.cells).filter(c => c.present).length,
        objectsReceivedMetric: latest('objects_received')?.value ?? null, framesRenderedMetric: latest('frames_rendered') ? { value: latest('frames_rendered').value, unavailable: latest('frames_rendered').unavailable } : null,
        page: { state: p.state, error: p.error, t: p.t, rvfc: p.rvfc }, ring };
      step(label, ev);
      intended(INTENDED.silent, mediaObjects.length === 0, `${label}: ${mediaObjects.length} media objects were reported for accepted-but-silent tracks: ${JSON.stringify(mediaObjects.slice(0, 3))}`);
      assert.equal(stages.length, 0, `${label}: stage facts without any media object`);
      assert.equal(vm.rows.length, 0, `${label}: a group row was invented without objects: ${JSON.stringify(vm.rows.map(r => r.label))}`);
      assert.ok(vm.requests.length >= 2, `${label}: accepted requests must stay visible`);
      assert.equal(p.t, 0, `${label}: the playhead must stay at a measurable 0 (got ${p.t})`);
      return ev;
    };
    const w = await judge('observation window'); w.acceptedAfterMs = acceptedAt;
    if (control === 'objects-on-silent') {
      // The induced condition: ONE real object sent by the publisher only now — after attach and accepted requests.
      await writeFile(trigger, 'send');
      const witness = await waitForLine('publisher-silent', /CONTROL: sent one object on (\S+) \(alias (\d+)\) group (\d+) object (\d+), (\d+) bytes/, 100);
      step('control object sent', { track: witness[1], alias: witness[2], groupId: witness[3], objectId: witness[4], bytes: Number(witness[5]) });
      await pause(1500);
      await judge('after control object');
    }
    // Recording during silence: an export that holds NO AV object facts for the media tracks (catalog traffic may exist).
    await click('#btnRec'); await until('recording', async () => (await recLabel()) === 'Recording' ? true : null);
    await pause(2000);
    await click('#btnRec'); await until('stopped', async () => (await recLabel()) === 'Save .moqtrace' ? true : null);
    const n = downloads.length; await click('#btnRec');
    const saved = await until('download completed', () => downloads.slice(n).find(d => d.state === 'completed') ?? null, 200);
    const records = (await readFile(join(artifact, 'downloads', saved.guid))).toString('utf8').split('\x1e').filter(t => t.trim()).map(t => JSON.parse(t));
    const rec = recordedFacts(records);
    const recordedMedia = rec.facts.filter(x => x.kind === 'object' && media.has(x.trackId));
    step('recording', { records: records.length, recordedFacts: rec.facts.length, recordedMediaObjects: recordedMedia.length, recordedRequests: rec.facts.filter(x => x.kind === 'request').length, malformed: rec.malformed.length });
    assert.equal(recordedMedia.length, 0, 'the recording must hold no media object facts for silent tracks');
    // The engine's own startup fault, OBSERVED rather than assumed: a bounded wait that records whether it happened.
    const faultWindowMs = 15000;
    const fault = await poll(async () => { const p = await liveProgress(); return p.error !== null || !['idle', 'loading', 'buffering', 'playing'].includes(p.state) ? p : null; }, faultWindowMs / 100);
    step('startup fault', { observed: fault !== null, state: fault?.state ?? (await liveProgress()).state, error: fault?.error ?? null, windowMs: faultWindowMs, elapsedMs: Date.now() - t0 });
    await judge('after fault window');
  });

  // ───────────────────────────────── freeze ────────────────────────────────
  if (cases.includes('freeze')) await runCase('freeze', async (step, procs) => {
    const { relay, relayUrl, publisher } = await startRelayAndPublisher('freeze', fixture, cmafPublisher(fixture)); procs.push(publisher, relay);
    const query = new URLSearchParams({ url: relayUrl, ns: fixture.namespace, hash: pinHex, exposure: 'development' });
    await evaluate(ps, 'window.__pageFactCount = 0; true'); await resetRing();   // before load: the auto-attach snapshot must be retained
    await page.goto(`${devBase}index.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.live?.installed && window.live?.bridgeInstalled);
    await page.click('#start');
    await page.waitForFunction(() => window.live.state === 'playing' || window.live.error, { timeout: 30000 });
    await until('media advancing', async () => { const p = await liveProgress(); return p.t > 0.5 ? p : null; }, 300);
    await attachFirst();
    const flowing = await until('video objects and appended stages flowing', async () => { const f = await pageFacts(); const t = tracksByType(f);
      return t.video.size >= 1 && f.some(x => x.kind === 'object' && t.video.has(x.trackId)) && f.some(x => x.kind === 'stage' && x.stage === 'appended') ? t : null; }, 200);
    const videoTracks = flowing.video;
    // The source timestamps every observation with its declared clock; the gated live page installs diagnostics with
    // the default clock (`performance`, the page's own performance.now), so the page's performance.now read at the
    // stable start and at the end of the frozen interval bound the SAME clock. Only observations the source clocked
    // strictly inside that interval count as receipts/appends DURING the freeze (test/trace-facts.mjs windowedChain);
    // batch seq order would also admit old observations delivered late.
    const clocks = (await pageMessages()).filter(m => m.kind === 'snapshot').flatMap(m => m.clocks.map(c => c.id));
    assert.ok(clocks.includes('performance'), `the source must declare the 'performance' clock, declared: ${JSON.stringify([...new Set(clocks)])}`);
    const pageNow = () => page.evaluate(() => performance.now());
    const sample = async () => { const f = await pageFacts(); const p = await liveProgress(); const paused = await page.evaluate(() => document.querySelector('#video').paused);
      const m = f.filter(x => x.kind === 'metric' && x.name === 'video_presented_frames').at(-1) ?? null;
      return { paused, t: p.t, rvfc: p.rvfc, presentedStages: f.filter(x => x.kind === 'stage' && x.stage === 'presented').length, presentedMetric: m ? m.value : undefined, facts: (await factCounter()).facts }; };
    if (control !== 'no-pause') await page.evaluate(() => document.querySelector('#video').pause());
    const s0 = await sample();
    await pause(500);                                              // the transition settles before the judged interval
    const s1 = await sample(); const windowStartMs = await pageNow(); const windowMark = await ringMark();
    await pause(3000);
    const windowEndMs = await pageNow(); const s2 = await sample();
    const ring = await coverage(windowMark, 'freeze: receipts during the frozen interval');
    const chain = windowedChain(await pageEvents(), { clockId: 'performance', afterMs: windowStartMs, untilMs: windowEndMs, trackIds: videoTracks });
    step('freeze', { paused: control !== 'no-pause', window: { clockId: 'performance', startMs: windowStartMs, endMs: windowEndMs }, s0, s1, s2, newVideoObjects: chain.objects.length, newAppendedUnits: chain.appended.length,
      outsideWindow: chain.outsideWindow, otherClocks: chain.otherClocks, ring,
      sampleChain: chain.appended.slice(0, 2).map(e => ({ seq: e.seq, timeMs: e.timeMs, deliveryId: e.fact.deliveryId, unitId: e.fact.unitId })) });
    const newVideoObjects = chain.objects, newAppended = chain.appended;
    intended(INTENDED.freeze, s1.t > 0 && s1.rvfc.presentedFrames > 0 && s2.t === s1.t && s2.rvfc.presentedFrames === s1.rvfc.presentedFrames,
      `playhead and rVFC must stay at their last observed (non-zero) values while frozen: t ${s1.t} → ${s2.t}, presentedFrames ${s1.rvfc.presentedFrames} → ${s2.rvfc.presentedFrames}`);
    assert.ok(s1.paused && s2.paused, `the element must be paused (${s1.paused}, ${s2.paused})`);
    assert.ok(newVideoObjects.length >= 1, `video object receipts must be clocked by the source INSIDE the frozen interval (${windowStartMs.toFixed(1)}, ${windowEndMs.toFixed(1)}] ms; got ${newVideoObjects.length} (${chain.outsideWindow} outside)`);
    assert.ok(newAppended.length >= 1, `appended units correlated to those receipts (deliveryId + unitId) must be clocked inside the frozen interval; got ${newAppended.length}`);
    assert.equal(s2.presentedStages, 0, 'MSE never reports a presented stage');
    assert.ok(Number.isFinite(s1.presentedMetric) && Number.isFinite(s2.presentedMetric), `video_presented_frames must be a finite observed value on this codec-capable fixture (${s1.presentedMetric}, ${s2.presentedMetric})`);
    assert.equal(s2.presentedMetric, s1.presentedMetric, `the reported presented-frames metric must not move while paused (${s1.presentedMetric} → ${s2.presentedMetric})`);
    await page.evaluate(() => document.querySelector('#video').play());
    const resumed = await until('playback resumes after play()', async () => { const p = await liveProgress(); return p.t > s2.t + 0.2 ? p : null; }, 100);
    step('resumed', { t: resumed.t, rvfc: resumed.rvfc });
  });

  report.backendAfter = await backendFingerprint();
  report.backendUnchanged = report.backendBefore.sha256 === report.backendAfter.sha256;
  report.negativePagesAfter = await gateInputs();
  report.inputsUnchanged = JSON.stringify(report.negativePages) === JSON.stringify(report.negativePagesAfter);
  report.completed = true;
} catch (e) { report.fatal = String(e?.stack ?? e); }
finally {
  // Owned cleanup, each step witnessed: a rejected browser close or an unclosed server is an error, not silence.
  if (ctx) { try { await Promise.race([ctx.close(), pause(15000).then(() => { throw new Error('browser close exceeded 15 s'); })]); report.browserClosed = true; } catch (e) { report.browserClosed = false; report.cleanupErrors.push(`browser close: ${e?.message ?? e}`); } }
  else report.browserClosed = null;
  if (staticServer) { try { await new Promise((ok, fail) => staticServer.close(err => (err ? fail(err) : ok()))); report.staticServerClosed = true; } catch (e) { report.staticServerClosed = false; report.cleanupErrors.push(`static server close: ${e?.message ?? e}`); } }
  report.cleanup = []; for (const c of children) report.cleanup.push(await stopChild(c));
}
report.durationMs = Date.now() - startedAt;
report.errorCount = report.errors.length + report.consoleDropped + report.cleanupErrors.length;
report.cleanupProven = report.cleanup.every(c => c.gone === true) && report.browserClosed !== false && report.staticServerClosed !== false && report.cleanupErrors.length === 0;
report.verdict = negativesVerdict({ control, expectedCases: cases, cases: report.cases, fatal: report.fatal ?? null, errorCount: report.errorCount, backendUnchanged: report.backendUnchanged ?? null, inputsUnchanged: report.inputsUnchanged ?? null, cleanupProven: report.cleanupProven, completed: report.completed ?? null });
report.passed = report.verdict.pass;
await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ artifact, control, passed: report.passed, reasons: report.verdict.reasons, durationMs: report.durationMs, errorCount: report.errorCount, backendUnchanged: report.backendUnchanged, inputsUnchanged: report.inputsUnchanged, cleanupProven: report.cleanupProven,
  cases: Object.fromEntries(Object.values(report.cases).map(c => [c.name, { passed: c.passed, intendedFailure: c.intendedFailure, error: c.error?.split('\n')[0] ?? null, steps: c.steps.map(s => s.step) }])) }, null, 2));
process.exit(report.passed ? 0 : 1);
