// Real-tab attachment gate: the BUILT extension, a real DevTools window, a real
// page that installs the diagnostic bridge from the BUILT packages, and the
// full owner → relay → page → owner path with real user-gesture clicks.
//
// What it proves: owner/panel identity matching; capability check; origin read;
// permission check (a labelled API-wrapper DENIAL control, not a native prompt);
// top-frame injection; tabs.connect; carrier bootstrap; hello; pick-a-source
// attach; snapshot + batches applied and painted; instance switch (detach, ack,
// attach) holding at most one lease; panel reload while attached receiving a
// baseline without a new lease; user detach releasing the page lease and
// turning the live indicator off; the DETERMINISTIC injection race on a FRESH
// owner and again after an attachment (grant checked, injection held, page
// navigates to a granted origin, release: zero connects, panel usable); actual
// resnapshot recovery after one owner→view batch is dropped; the view losing
// its owner port (indicator off, "Owner lost"); fresh attach on the second
// origin; a HELD STALE FRAME from the previous channel replayed after a new
// generation: nothing applied.
//
// What it does NOT prove, stated here so nobody reads more into a green run:
// the native optional-permission prompt. This gate runs a labelled TEST BUILD
// whose manifest pre-declares `http://127.0.0.1/*`, so `permissions.contains`
// is true without a prompt and `permissions.request` resolves at once. The
// prompt itself is a manual check. No MOQT traffic, no live player observers.
// The report records the platform, architecture, Node and browser versions of
// the run it describes, so each run speaks only for itself.
//
// Requirements: built packages (`pnpm -r build` for devtools + protocol), a
// built extension (`pnpm build` here), the workspace Playwright Chromium and a
// display (Xvfb on Linux). The verdict is computed AFTER browser shutdown from
// the total counted errors; exit code 1 on any failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openPlayaPanel } from './devtools-frontend.mjs';
import { createNativeClick } from './native-click.mjs';
import { awaitObjectDelivery } from './probe-object-wait.mjs';
const here = dirname(fileURLToPath(import.meta.url));
// Optional labelled arm: --probe-relay=<https url> [--probe-namespace=a,b] [--probe-tracks=x,y] runs a REAL probe against
// that relay after the loopback steps. Off by default; never part of CI. Loopback stays the default everywhere.
const argOf = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const relayArm = argOf('probe-relay') ? { url: argOf('probe-relay'), namespace: (argOf('probe-namespace') ?? 'night').split(','), tracks: argOf('probe-tracks') ? argOf('probe-tracks').split(',') : [],
  policy: process.argv.includes('--probe-compat') ? 'compatibility' : 'strict', draft: argOf('probe-draft') ?? '22' } : null;
const extensionDir = resolve(here, '..');
const repoRoot = resolve(extensionDir, '../..');
const { chromium } = createRequire(join(repoRoot, 'package.json'))('playwright');
const pause = ms => new Promise(r => setTimeout(r, ms));

const artifact = await mkdtemp(join(tmpdir(), 'playa-devtools-real-tab-'));
const report = { artifact, passed: false, steps: [], errors: [], consoleDropped: 0,
  runtime: { platform: process.platform, arch: process.arch, node: process.version },
  notProven: ['native optional-permission prompt (labelled pre-granted test build + API-wrapper denial control)',
    'live Playa observers and live Playa recorder integration (this page emits fixtures and installs the recorder hook itself)', 'Probe', 'MOQT traffic'] };
const noteError = text => { if (report.errors.length >= 50) { report.consoleDropped++; return; } report.errors.push(String(text).slice(0, 300)); };
const step = (name, data = {}) => { report.steps.push({ name, ...data }); };

// 1. Labelled TEST BUILD of the extension: pre-granted loopback origin, nothing else changed.
const ext = join(artifact, 'extension');
await cp(join(extensionDir, 'dist'), ext, { recursive: true });
{
  const m = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  m.name = 'Playa DevTools (TEST BUILD: pre-granted http://127.0.0.1/*)';
  m.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(ext, 'manifest.json'), JSON.stringify(m, null, 2));
  const hash = createHash('sha256');
  for (const name of (await readdir(ext)).sort()) { hash.update(name); hash.update(await readFile(join(ext, name))); }
  report.extensionHash = hash.digest('hex');
}

// 2. Two loopback origins (different ports) serving the same bridge-installing page from BUILT packages.
const files = new Map();
const backendHash = createHash('sha256');
for (const [route, folder] of [['/devtools/', 'devtools'], ['/protocol/', 'devtools-protocol'], ['/transport/', 'transport/dist/qlog']]) {
  const dist = folder.includes('/') ? join(repoRoot, 'packages', folder) : join(repoRoot, 'packages', folder, 'dist');
  for (const name of (await readdir(dist)).filter(n => n.endsWith('.js')).sort()) {
    const bytes = await readFile(join(dist, name));
    files.set(route + name, bytes); backendHash.update(route + name); backendHash.update(bytes);
  }
}
report.backendHash = backendHash.digest('hex');
const html = port => `<!doctype html><title>Playa real-tab gate ${port}</title>
<h1>Gate page on port ${port}</h1>
<script type="importmap">{"imports":{"@openmoq/devtools-protocol":"/protocol/index.js","@openmoq/transport/trace-recorder":"/transport/trace-recorder.js"}}</script>
<script type="module">
import { DiagnosticCapture, DiagnosticRegistry, installDiagnosticBridge } from '/devtools/index.js';
import { encodeMessage, PROTOCOL_VERSION } from '/protocol/index.js';
import { snapshotFixture, batchFixture } from '/protocol/fixtures.js';
import { TraceRecorder } from '/transport/trace-recorder.js';
const gate = { active: { player: null, second: null }, changes: { player: [], second: [] }, emitted: 0, port: ${port},
  recorder: { created: 0, started: 0, stopped: 0, dumped: 0, disposed: 0, lines: 0 } };
window.gate = gate;
const registry = new DiagnosticRegistry();
// The page's recorder hook: an independent bounded TraceRecorder per accepted record.start. While
// recording, labelled fixture loglevel lines are written through its logger tee so an export spans
// several 16 KiB chunks. No new qlog schema; the recorder's own serialization is what is exported.
const silent = { error() {}, warn() {}, info() {}, debug() {} };
const recordingOptions = {
  createRecorder({ maxBytes }) {
    gate.recorder.created++;
    const rec = new TraceRecorder({ clock: { clock_id: 'gate-clock', clock_type: 'monotonic', now: () => performance.now() },
      runId: 'run-${port}', eventSchemas: ['https://openmoq.org/082026/playa'], title: 'Playa real-tab gate (fixture lines)',
      limits: { denseMaxBytes: Math.floor(maxBytes / 4), sparseMaxBytes: Math.floor(maxBytes / 4), metadataMaxBytes: 65536 } });
    const log = rec.logger(silent);
    let feed = null;
    return {
      start() { gate.recorder.started++; rec.start(); let i = 0; feed = setInterval(() => { log.info('FIXTURE line ' + (i++) + ' ' + 'x'.repeat(900)); gate.recorder.lines++; }, 5); },
      stop() { gate.recorder.stopped++; clearInterval(feed); feed = null; rec.stop(); },
      dump() { gate.recorder.dumped++; return rec.dump(); },
      dispose() { gate.recorder.disposed++; clearInterval(feed); feed = null; rec.stop(); },
    };
  },
};
function expose(name, sourceId, runId) {
  let timer = null;
  const capture = new DiagnosticCapture({
    source: { sourceId, runId, kind: 'attached', label: 'Playa gate ' + name, synthetic: true,
      exposure: 'development', capabilities: name === 'player' ? ['objects', 'recording'] : ['objects'], modules: [{ name: 'gate', version: '0', buildId: null }] },
    clock: { id: 'page-performance', now: () => performance.now() },
    onActiveChange(active) {
      gate.active[name] = active; gate.changes[name].push(active);
      clearInterval(timer); timer = null;
      if (!active) return;
      for (const f of snapshotFixture.facts) capture.emit(f.fact, 'sparse');
      let object = 10;
      timer = setInterval(() => {
        const fact = { ...batchFixture.events[0].fact, objectId: String(object++), deliveryId: name + '-' + object };
        if (capture.emit(fact, 'dense')) gate.emitted++;
      }, 100);
    },
  });
  registry.register(capture, name === 'player' ? recordingOptions : undefined);
}
expose('player', 'gate-player', 'run-${port}');
expose('second', 'gate-second', 'run-${port}-b');
installDiagnosticBridge(registry, { idleTimeoutMs: 15000 });
// A SECOND owner, local to the page (a registry connection, not the DevTools owner): used by the gate
// to hold the source's one active recording so the panel must show "another owner".
const common = { channel: 'openmoq-devtools', version: PROTOCOL_VERSION };
const other = { connection: null, target: null, recording: null };
const reply = frames => frames.map(f => JSON.parse(f)).find(m => m.kind !== 'error') ?? JSON.parse(frames[0]);
gate.other = {
  attach() { other.connection = registry.open('other-owner');
    const snap = reply(other.connection.request(encodeMessage({ ...common, kind: 'attach', requestId: 'o-attach', target: { ownerId: 'other-owner', sourceId: 'gate-player', runId: 'run-${port}' } })));
    other.target = snap.target; return snap.kind; },
  startRecording() { const r = reply(other.connection.request(encodeMessage({ ...common, kind: 'record.start', requestId: 'o-start', target: other.target }))); other.recording = r; return r.kind; },
  stopRecording() { const r = reply(other.connection.request(encodeMessage({ ...common, kind: 'record.stop', requestId: 'o-stop', target: other.target, recordingId: other.recording.recordingId, token: other.recording.token }))); return r.kind; },
  detach() { const r = reply(other.connection.request(encodeMessage({ ...common, kind: 'detach', requestId: 'o-detach', target: other.target }))); other.connection.close(); return r.kind; },
};
</script>`;
const serve = () => new Promise((ok, reject) => {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(html(server.address().port)); return; }
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const bytes = files.get(path);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(bytes);
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => ok(server));
});
const serverA = await serve(), serverB = await serve();
const originA = `http://127.0.0.1:${serverA.address().port}`, originB = `http://127.0.0.1:${serverB.address().port}`;
report.origins = { a: originA, b: originB };

let ctx;
try {
  ctx = await chromium.launchPersistentContext(join(artifact, 'profile'), { headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--auto-open-devtools-for-tabs',
      '--disable-background-networking', '--window-size=1440,1000'] });
  report.browser = ctx.browser().version();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('pageerror', e => noteError(`page: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') noteError(`page console: ${m.text()}`); });
  await page.goto(`${originA}/`);

  // Browser-level CDP for the DevTools host, the extension's DevTools document and the panel iframe.
  const root = await ctx.browser().newBrowserCDPSession();
  // Downloads are saved under the artifact by GUID so the exported file itself can be read back.
  const downloads = [];
  await root.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: join(artifact, 'downloads'), eventsEnabled: true });
  root.on('Browser.downloadWillBegin', d => downloads.push({ ...d, state: 'started' }));
  root.on('Browser.downloadProgress', d => { const x = downloads.find(x => x.guid === d.guid); if (x) Object.assign(x, d); });
  let nextId = 0;
  const attach = async targetId => (await root.send('Target.attachToTarget', { targetId })).sessionId;
  const rpc = (sessionId, method, params = {}, timeoutMs = 8000) => new Promise((ok, reject) => {
    const id = ++nextId;
    const cleanup = () => { clearTimeout(timer); root.off('Target.receivedMessageFromTarget', listener); };
    const listener = e => { if (e.sessionId !== sessionId) return; const m = JSON.parse(e.message); if (m.id !== id) return; cleanup(); m.error ? reject(new Error(JSON.stringify(m.error))) : ok(m.result); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP timeout ${method} (${timeoutMs} ms)`)); }, timeoutMs);
    root.on('Target.receivedMessageFromTarget', listener);
    root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(e => { cleanup(); reject(e); });
  });
  const evaluate = async (s, expression, timeoutMs) => {
    const r = await rpc(s, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  const targets = async () => (await root.send('Target.getTargets')).targetInfos;
  const findTarget = async (pick, tries = 60) => { for (let i = 0; i < tries; i++) { const t = (await targets()).find(pick); if (t) return t; await pause(100); } return null; };
  const until = async (name, fn, tries = 80) => { let last; for (let i = 0; i < tries; i++) { last = await fn(); if (last) return last; await pause(100); } throw new Error(`timeout waiting for ${name}: ${JSON.stringify(last)?.slice(0, 200)}`); };
  const watch = (sessionId, label) => root.on('Target.receivedMessageFromTarget', e => {
    if (e.sessionId !== sessionId) return;
    const m = JSON.parse(e.message);
    if (m.method === 'Runtime.exceptionThrown') noteError(`${label} exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') noteError(`${label} console: ${m.params.args?.map(a => a.value ?? a.description).join(' ')}`);
  });

  // 3. Exactly one DevTools document for this extension, and the panel that belongs to THAT owner.
  await findTarget(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/devtools.html'));
  const dts = (await targets()).filter(t => t.url.startsWith('chrome-extension://') && t.url.endsWith('/devtools.html'));
  assert.equal(dts.length, 1, `expected one extension DevTools document, found ${dts.length}`);
  const dtSession = await attach(dts[0].targetId);
  watch(dtSession, 'owner');
  await rpc(dtSession, 'Runtime.enable');
  const identity = await until('owner identity', () => evaluate(dtSession, 'globalThis.__playaOwner ? JSON.parse(JSON.stringify(globalThis.__playaOwner)) : null'));
  const host = await findTarget(t => t.url.startsWith('devtools://'));
  assert.ok(host, 'no DevTools host');
  const hs = await attach(host.targetId);
  step('show panel', await openPlayaPanel({ evaluate, session: hs }));   // after the frontend's own bootstrap promise, never before
  let ps;
  const bindPanel = async () => {
    const panel = await findTarget(t => t.type === 'iframe' && t.url.includes('/panel.html') && t.url.includes(`owner=${identity.ownerId}`));
    assert.ok(panel, 'panel iframe for this owner not found');
    ps = await attach(panel.targetId);
    watch(ps, 'panel');
    await rpc(ps, 'Runtime.enable');
    const owner = await until('panel hook', () => evaluate(ps, 'window.__playaPanel ? JSON.parse(JSON.stringify(window.__playaPanel.owner)) : null'));
    assert.equal(owner.id, identity.ownerId, 'panel owner must be this DevTools document');
    assert.equal(Number(owner.tab), identity.tabId, 'panel tab must be the inspected tab');
    return owner;
  };
  const owner = await bindPanel();
  step('identity', { ownerId: identity.ownerId, tabId: identity.tabId, panelOwner: owner.id });

  const hostState = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel?.host ?? null))');
  const applied = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel.applied))');
  const appliedCount = async kind => (await applied()).filter(a => !kind || a.kind === kind).length;
  // Target-safe native click (test/native-click.mjs): stable layout + hit test before dispatch, the received click
  // verified after it; a click that lands on another control fails loudly instead of passing as the intended action.
  const click = createNativeClick({ evaluate, rpc, session: () => ps });
  const pageActive = () => page.evaluate(() => JSON.parse(JSON.stringify(window.gate.active)));

  // Test-only instrumentation in the DevTools document: count injections/connects, hold injection on
  // demand, and keep the last packet each relay port delivered so a stale frame can be replayed later.
  await evaluate(dtSession, `(() => {
    const race = window.__race = { injections: 0, connects: 0, hold: false, held: null, ports: [] };
    const origInject = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = opts => { race.injections++; if (!race.hold) return origInject(opts);
      return new Promise((res, rej) => { race.held = { release: () => origInject(opts).then(res, rej) }; }); };
    const origConnect = chrome.tabs.connect.bind(chrome.tabs);
    chrome.tabs.connect = (tabId, opts) => { race.connects++; const port = origConnect(tabId, opts);
      const entry = { listeners: [], last: null }; race.ports.push(entry);
      const origAdd = port.onMessage.addListener.bind(port.onMessage);
      port.onMessage.addListener = fn => { entry.listeners.push(fn); origAdd(m => { if (m && m.t === 'packet') entry.last = m; fn(m); }); };
      return port; };
    race.replayStale = () => { const e = race.ports.at(-2); if (!e || !e.last) return false; for (const fn of e.listeners) fn(e.last); return true; };
  })()`);

  // 4. Before anything: owner ready, origin A shown, nothing injected, both page captures inert.
  const ready = await until('owner ready', async () => { const h = await hostState(); return h?.outer?.stage === 'ready' ? h : null; });
  assert.equal(ready.outer.origin, originA);
  assert.equal(await evaluate(ps, `document.getElementById('btnDev').textContent`), 'Attach to page');
  assert.deepEqual(await pageActive(), { player: null, second: null }, 'page captures must be inert before attach');
  step('ready', { origin: ready.outer.origin });

  // 5. DENIAL CONTROL (labelled API wrapper, not the native prompt): the panel's request returns false.
  await evaluate(ps, `window.__origRequest = chrome.permissions.request; chrome.permissions.request = async () => false;`);
  await click('#btnDev');
  const deniedLine = await until('denial shown', async () => { const t = await evaluate(ps, `document.getElementById('hostLine').textContent`); return /was not granted/.test(t) ? t : null; });
  await pause(300);
  assert.equal(await evaluate(dtSession, 'window.__race.injections'), 0, 'a denied grant must inject nothing');
  assert.deepEqual(await pageActive(), { player: null, second: null });
  await evaluate(ps, `chrome.permissions.request = window.__origRequest;`);
  step('denial control', { line: deniedLine, injections: 0, note: 'API wrapper returning false; not a native prompt test' });

  // 5b. FRESH-OWNER injection race: nothing attached yet, injection held, navigate A → A (same-origin
  //     replacement), release: zero connects and the panel is immediately usable again.
  await evaluate(dtSession, 'window.__race.hold = true; window.__race.held = null;');
  await click('#btnDev');
  await until('first injection held', () => evaluate(dtSession, 'window.__race.held !== null'));
  await page.goto(`${originA}/?replaced=1`);
  await until('owner ready after replacement', async () => { const h = await hostState(); return h?.outer?.stage === 'ready' && h.outer.origin === originA ? h : null; });
  await evaluate(dtSession, 'window.__race.hold = false; window.__race.held.release()');
  await pause(800);
  const fresh = await evaluate(dtSession, '({ connects: window.__race.connects, injections: window.__race.injections })');
  assert.equal(fresh.connects, 0, 'a cancelled first attach must not connect');
  const freshUi = await evaluate(ps, `({ text: document.getElementById('btnDev').textContent, disabled: document.getElementById('btnDev').classList.contains('disabled'), stage: window.__playaPanel.host.outer.stage })`);
  assert.deepEqual(freshUi, { text: 'Attach to page', disabled: false, stage: 'ready' }, 'the panel must be usable after a cancelled first attach');
  assert.deepEqual(await pageActive(), { player: null, second: null });
  step('fresh-owner injection race', { ...fresh, ...freshUi });

  // 6. Attach: real click → request in the panel → owner verifies origin, injects, connects, bootstraps.
  await click('#btnDev');
  const discovered = await until('discovered', async () => { const h = await hostState(); return h?.core?.phase === 'discovered' ? h : null; });
  assert.equal(discovered.core.sources.length, 2);
  assert.deepEqual(await pageActive(), { player: null, second: null }, 'discovery must not activate capture');
  step('discovered', { sources: discovered.core.sources.map(s => s.sourceId), generation: discovered.core.generation, injections: await evaluate(dtSession, 'window.__race.injections') });

  // 7. Pick the first source: lease bound, baseline snapshot, then batches applied and painted.
  await click('#pickList .inst');
  const attached = await until('attached', async () => { const h = await hostState(); return h?.core?.phase === 'attached' ? h : null; });
  assert.equal(attached.core.target.ownerId, identity.ownerId);
  assert.equal(attached.core.target.sourceId, 'gate-player');
  await until('page player active', async () => (await pageActive()).player === true);
  const batches = await until('batches applied', async () => { const n = await appliedCount('batch'); return n >= 3 ? n : null; });
  const painted = await evaluate(ps, `({ rows: window.__playaPanel.vm.rows.length, cells: window.__playaPanel.vm.rows.map(r => r.cells.length), hookStats: window.__playaPanel.vm.hookStats, live: document.getElementById('pickerDot').classList.contains('live') })`);
  assert.ok(painted.rows > 0 && painted.live, 'rows must paint and the indicator must be live');
  assert.ok(!/resnapshot/.test(painted.hookStats), 'no resnapshot loop expected');
  assert.ok((await applied()).every(a => a.outcome !== 'resnapshot'), 'no frame may have asked for a resnapshot');
  step('attached', { target: attached.core.target, batches, ...painted });

  // 7b. RECORD on gate-player: start (page recorder created and started), stop, export (multi-chunk), download.
  const recorderCounts = () => page.evaluate(() => JSON.parse(JSON.stringify(window.gate.recorder)));
  const recLabel = () => evaluate(ps, `({ text: document.getElementById('recLabel').textContent, disabled: document.getElementById('btnRec').classList.contains('disabled'), dot: document.getElementById('recDot').classList.contains('on') })`);
  assert.deepEqual(await recorderCounts(), { created: 0, started: 0, stopped: 0, dumped: 0, disposed: 0, lines: 0 }, 'no recorder may exist before record.start');
  assert.deepEqual(await recLabel(), { text: 'Record .moqtrace', disabled: false, dot: false });
  await click('#btnRec');
  await until('recording started', async () => { const l = await recLabel(); const h = await hostState(); return l.text === 'Recording' && l.dot && h.core.recording?.recordingId ? h : null; });
  await until('page recorder started', async () => (await recorderCounts()).started === 1);
  const heldKeys = Object.keys((await hostState()).core.recording).sort();
  assert.deepEqual(heldKeys, ['exporting', 'recordingId'], 'the panel must see token-free recording state only');
  await until('fixture lines written', async () => (await recorderCounts()).lines >= 40);
  await click('#btnRec');
  await until('recording stopped', async () => (await recLabel()).text === 'Save .moqtrace');
  assert.equal((await recorderCounts()).stopped, 1);
  await click('#btnRec');
  const exported = await until('export downloaded', () => evaluate(ps, 'window.__playaPanel.lastExport ? JSON.parse(JSON.stringify(window.__playaPanel.lastExport)) : null'), 150);
  assert.ok(exported.bytes > 16384, `a multi-chunk export was expected, got ${exported.bytes} bytes`);
  assert.match(exported.head, /qlog/);
  assert.match(exported.filename, /^playa-.*\.moqtrace$/);
  assert.equal((await recorderCounts()).dumped, 1);
  // The SAVED FILE, not just the panel's record of having called download(): same size, parseable JSON-SEQ, qlog file schema.
  const saved = await until('download completed', () => downloads.find(d => d.state === 'completed') ?? null, 100);
  assert.equal(saved.suggestedFilename, exported.filename);
  const fileBytes = await readFile(join(artifact, 'downloads', saved.guid));
  assert.equal(fileBytes.byteLength, exported.bytes, 'saved file size must equal the reassembled export');
  const records = fileBytes.toString('utf8').split('\x1e').filter(t => t.trim()).map(t => JSON.parse(t));
  assert.equal(records[0].file_schema, 'urn:ietf:params:qlog:file:sequential');
  assert.ok(records.length > 20, `expected many JSON-SEQ records, got ${records.length}`);
  const afterExport = await hostState();
  assert.equal(afterExport.core.recording.exporting, null);
  assert.equal(afterExport.core.phase, 'attached');
  await until('batches still flowing after export', async () => (await appliedCount('batch')) > batches);
  step('record', { ...exported, savedBytes: fileBytes.byteLength, records: records.length, recorder: await recorderCounts() });

  // 7c. ANOTHER OWNER (a page-local registry connection) holds the source's active recording.
  assert.equal(await page.evaluate(() => window.gate.other.attach()), 'snapshot');
  assert.equal(await page.evaluate(() => window.gate.other.startRecording()), 'record.started');
  await until('another owner shown', async () => { const l = await recLabel(); return l.text === 'Recording (another owner)' && l.disabled && l.dot ? l : null; });
  assert.equal(await page.evaluate(() => window.gate.other.stopRecording()), 'ack');
  await until('our stopped recording exportable again', async () => (await recLabel()).text === 'Save .moqtrace');
  assert.equal(await page.evaluate(() => window.gate.other.detach()), 'ack');
  step('another owner', { recorder: await recorderCounts() });

  // 7d. CLEANUP: detach releases this owner's recording at the page; re-attach starts clean.
  const disposedBefore = (await recorderCounts()).disposed;
  await click('#btnDev');
  await until('detached after recording', async () => (await hostState())?.outer?.stage === 'ready');
  await until('recorder disposed by the registry', async () => (await recorderCounts()).disposed > disposedBefore);
  assert.equal((await hostState()).core?.recording ?? null, null);
  await click('#btnDev');
  await until('discovered again', async () => (await hostState())?.core?.phase === 'discovered');
  await click('#pickList .inst');
  await until('attached again to player', async () => { const h = await hostState(); return h?.core?.phase === 'attached' && h.core.target.sourceId === 'gate-player' ? h : null; });
  assert.deepEqual(await recLabel(), { text: 'Record .moqtrace', disabled: false, dot: false });
  step('record cleanup', { recorder: await recorderCounts() });

  // 8. Instance switch: detach, ack, attach the second source; never two leases at once.
  await click('#instances .inst:not(.on)');
  const switched = await until('switched', async () => { const h = await hostState(); return h?.core?.phase === 'attached' && h.core.target.sourceId === 'gate-second' ? h : null; });
  await until('page second active, player inactive', async () => { const a = await pageActive(); return a.second === true && a.player === false; });
  // gate-second declares no `recording` capability: the action is not offered.
  const noRecord = await recLabel();
  assert.deepEqual(noRecord, { text: 'Record .moqtrace', disabled: true, dot: false }, 'a source without the recording capability must not offer Record');
  assert.equal(await evaluate(ps, 'window.__playaPanel.vm.canRecord'), false);
  const changes = await page.evaluate(() => JSON.parse(JSON.stringify(window.gate.changes)));
  // player: our attach, cleanup detach, re-attach, switch detach. The page-local second owner attached while we
  // held a lease, so the capture never changed activity for it.
  assert.deepEqual(changes, { player: [true, false, true, false], second: [true] }, 'exactly one lease at a time');
  step('switched', { target: switched.core.target, changes, recordOffered: !noRecord.disabled });

  // 9. Panel reload while attached: the new view gets hello + a baseline refresh, no new lease. The owner's
  //    NEXT view port is also wrapped so one owner→view batch can be dropped deliberately later.
  await evaluate(dtSession, `(() => {
    const review = window.__viewReview = { views: [], dropBatch: false, dropped: 0, refreshes: 0, snapshots: 0 };
    chrome.runtime.onConnect.addListener(port => {
      if (!port.name.startsWith('view:')) return;
      review.views.push(port);
      const original = port.postMessage.bind(port);
      port.postMessage = m => {
        if (m.kind === 'frame') {
          const inner = JSON.parse(m.encoded);
          if (inner.kind === 'batch' && review.dropBatch) { review.dropBatch = false; review.dropped++; return; }
          if (inner.kind === 'snapshot') review.snapshots++;
        }
        return original(m);
      };
      port.onMessage.addListener(m => { if (m.kind === 'refresh') review.refreshes++; });
    });
  })()`);
  const connectsBeforeReload = await evaluate(dtSession, 'window.__race.connects');
  await evaluate(ps, 'setTimeout(() => location.reload(), 0); true');
  await pause(800);
  await bindPanel();
  await until('reloaded view attached', async () => (await hostState())?.core?.phase === 'attached');
  const baseline = await until('baseline applied after reload', async () => { const a = await applied(); return a.some(x => x.kind === 'snapshot') ? a : null; });
  await until('rows painted after reload', async () => (await evaluate(ps, 'window.__playaPanel.vm.rows.length')) > 0);
  assert.equal(await evaluate(dtSession, 'window.__race.connects'), connectsBeforeReload, 'a view reload must not open a new relay port');
  assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(window.gate.changes))), changes, 'a view reload must not change any lease');
  step('view reload', { applied: baseline.map(a => a.kind), hello: baseline[0]?.kind });

  // 9b. Actual-panel resnapshot recovery: drop ONE owner→view batch; the panel must ask for a refresh,
  //     receive the snapshot and clear its incomplete state, with a bounded number of requests.
  const recoveryBefore = await evaluate(dtSession, '({ refreshes: window.__viewReview.refreshes, snapshots: window.__viewReview.snapshots })');
  await evaluate(dtSession, 'window.__viewReview.dropBatch = true;');
  await until('one batch deliberately dropped', () => evaluate(dtSession, 'window.__viewReview.dropped === 1'));
  await until('refresh requested from the actual panel', async () => (await evaluate(dtSession, 'window.__viewReview.refreshes')) > recoveryBefore.refreshes);
  await until('refresh snapshot delivered', async () => (await evaluate(dtSession, 'window.__viewReview.snapshots')) > recoveryBefore.snapshots);
  await until('panel recovered', () => evaluate(ps, 'window.__playaPanel.vm.needsResnapshot === null'));
  await pause(1000);
  const recovery = await evaluate(dtSession, '({ dropped: window.__viewReview.dropped, refreshes: window.__viewReview.refreshes, snapshots: window.__viewReview.snapshots })');
  assert.ok(recovery.refreshes - recoveryBefore.refreshes <= 3, `resnapshot recovery must settle, not loop (${recovery.refreshes - recoveryBefore.refreshes} requests)`);
  step('resnapshot recovery', { ...recovery, requestsForOneDrop: recovery.refreshes - recoveryBefore.refreshes });

  // 10. Detach by the user: lease released at the page, indicator off, data marked historical.
  await click('#btnDev');
  await until('page inactive', async () => { const a = await pageActive(); return a.second === false; });
  const detached = await until('owner ready again', async () => { const h = await hostState(); return h?.outer?.stage === 'ready' ? h : null; });
  const afterDetach = await evaluate(ps, `({ live: document.getElementById('pickerDot').classList.contains('live'), line: document.getElementById('hostLine').textContent, rows: window.__playaPanel.vm.rows.length })`);
  assert.equal(afterDetach.live, false, 'the live indicator must turn off on detach');
  assert.match(afterDetach.line, /last observed/);
  step('detached', { outer: detached.outer.stage, ...afterDetach });

  // 11. DETERMINISTIC injection race: grant checked, injection held, navigate to granted origin B, release.
  await evaluate(dtSession, 'window.__race.hold = true; window.__race.held = null;');
  const connectsBefore = await evaluate(dtSession, 'window.__race.connects');
  await click('#btnDev');
  await until('injection held', () => evaluate(dtSession, 'window.__race.held !== null'));
  await page.goto(`${originB}/`);
  await until('owner shows B', async () => { const h = await hostState(); return h?.outer?.origin === originB && h.outer.stage === 'ready' ? h : null; });
  await evaluate(dtSession, 'window.__race.hold = false; window.__race.held.release()');
  await pause(800);
  const race = await evaluate(dtSession, '({ connects: window.__race.connects, injections: window.__race.injections })');
  assert.equal(race.connects, connectsBefore, 'a cancelled origin-A attempt must not connect on origin B');
  const afterRace = await hostState();
  assert.equal(afterRace.outer.stage, 'ready');
  assert.deepEqual(await pageActive(), { player: null, second: null }, 'page B must be untouched');
  step('injection race', { connectsBefore, ...race, outer: afterRace.outer });

  // 12. Fresh attach on B, then a held stale frame from the previous channel is replayed into the owner.
  await click('#btnDev');
  const onB = await until('discovered on B', async () => { const h = await hostState(); return h?.core?.phase === 'discovered' ? h : null; });
  assert.equal(onB.core.sources[0].runId, `run-${serverB.address().port}`);
  assert.ok(onB.core.generation > switched.core.generation, 'generation must advance across channels');
  await click('#pickList .inst');
  await until('attached on B', async () => (await hostState())?.core?.phase === 'attached');
  await until('page B active', async () => (await pageActive()).player === true);
  await until('batches on B', async () => (await appliedCount('batch')) >= 3);
  const beforeReplay = await applied();
  const replayed = await evaluate(dtSession, 'window.__race.replayStale()');
  assert.equal(replayed, true, 'a stale packet from the previous channel must exist to replay');
  await pause(400);
  const afterReplay = await applied();
  // Live batches keep arriving; the stale frame must not appear: every new entry is a batch for the current
  // channel in increasing order, and no entry from before was altered.
  assert.deepEqual(afterReplay.slice(0, beforeReplay.length), beforeReplay, 'the applied record must not change retroactively');
  assert.ok(afterReplay.slice(beforeReplay.length).every(a => a.kind === 'batch' && a.outcome === 'accept'), 'only live accepted batches may follow');
  const stateAfterReplay = await hostState();
  assert.equal(stateAfterReplay.core.phase, 'attached');
  step('stale frame replay', { replayed, appliedBefore: beforeReplay.length, appliedAfter: afterReplay.length, phase: stateAfterReplay.core.phase, generation: stateAfterReplay.core.generation });

  // 12b. PROBE, negative control: an owner-local dial toward a closed loopback port fails with its own facts,
  //      the page lane is untouched, Stop/Start cycle, and mode switching is view-only.
  await click('#btnProbe');
  await until('probe strip', () => evaluate(ps, `!document.getElementById('probeStrip').classList.contains('hidden') && document.getElementById('probeGo').textContent === 'Start'`));
  const pageCellsBefore = await evaluate(ps, `window.__playaPanel.vms.page.rows.map(r => r.cells.length).reduce((a, b) => a + b, 0)`);
  await evaluate(ps, `document.getElementById('probeUrl').value = 'https://127.0.0.1:1/moq'; document.getElementById('probeNs').value = 'night'; document.getElementById('probeTracks').value = ''; document.getElementById('probeDraft').value = '22';`);
  await click('#probeGo');
  const probeFailed = await until('probe failed', async () => { const h = await hostState(); return h?.probe?.status === 'failed' ? h : null; }, 150);
  // The failure facts arrive through the owner-local poll shortly after the status flips.
  const probeVm = await until('dial failure fact shown', async () => {
    const v = await evaluate(ps, `JSON.parse(JSON.stringify({ events: window.__playaPanel.vms.probe.events, session: window.__playaPanel.vms.probe.session, exposed: window.__playaPanel.vms.probe.exposed, status: document.getElementById('probeStatus').textContent, go: document.getElementById('probeGo').textContent, live: document.getElementById('pickerDot').classList.contains('live') }))`);
    return v.events.some(ev => /dial (error|timeout)/.test(ev.name)) ? v : null;
  }, 100);
  assert.ok(probeVm.events.some(ev => /dial (error|timeout)/.test(ev.name)), `a dial failure fact must be shown, got ${JSON.stringify(probeVm.events)}`);
  assert.ok(!probeVm.events.some(ev => /teardown/.test(ev.name)), `a rejected closed promise is a settled closure, not a teardown failure: ${JSON.stringify(probeVm.events)}`);
  // Retry on the SAME runner after the failed handshake: not refused, fails the same way.
  await click('#probeGo');
  await until('retry started', async () => { const h = await hostState(); return h?.probe?.status === 'starting' || h?.probe?.status === 'failed' ? h : null; }, 50);
  assert.equal((await hostState()).probeLastError, null, 'a retry after a failed handshake must not be refused');
  await until('retry failed too', async () => (await hostState())?.probe?.status === 'failed', 150);
  assert.match(probeVm.status, /^failed/);
  assert.equal(probeVm.go, 'Start');
  assert.equal(probeVm.live, false);
  assert.equal(probeFailed.probe.scope, 'setup-only');
  const pageCellsAfter = await evaluate(ps, `window.__playaPanel.vms.page.rows.map(r => r.cells.length).reduce((a, b) => a + b, 0)`);
  assert.ok(pageCellsAfter >= pageCellsBefore, 'the page lane must be untouched by the probe');
  await click('#btnAttach');
  await until('attach lane shown again', () => evaluate(ps, `document.getElementById('probeStrip').classList.contains('hidden') && window.__playaPanel.mode === 'attach'`));
  assert.equal((await hostState()).core.phase, 'attached', 'switching modes must not touch the page lease');
  step('probe negative control', { status: probeVm.status, events: probeVm.events.map(ev => ev.name), scope: probeFailed.probe.scope });

  if (relayArm) {
    // Labelled PUBLIC RELAY ARM: real WebTransport + MoQT from the DevTools document to the relay you named.
    // TEST-ONLY: retain the last 64 encoded probe-lane frames this view applies (decoded in Node with the built codec).
    await evaluate(ps, `(() => { const hook = window.__playaPanel; if (hook.__probeRing) return true;
      const frames = window.__probeFrames = []; const original = hook.applyEncoded.bind(hook);
      hook.applyEncoded = (text, lane = 'page') => { if (lane === 'probe') { if (frames.length >= 64) frames.shift(); frames.push(text); } return original(text, lane); };
      hook.__probeRing = true; return true; })()`);
    await click('#btnProbe');
    await evaluate(ps, `document.getElementById('probeUrl').value = ${JSON.stringify(relayArm.url)}; document.getElementById('probeNs').value = ${JSON.stringify(relayArm.namespace.join(','))}; document.getElementById('probeTracks').value = ${JSON.stringify(relayArm.tracks.join(','))}; document.getElementById('probeDraft').value = ${JSON.stringify(relayArm.draft)}; document.getElementById('probePolicy').checked = ${relayArm.policy === 'compatibility'};`);
    await click('#probeGo');
    // A NEW run for this relay must exist (not the negative control's retired run), and it must not have been refused.
    await until('relay run started', async () => { const h = await hostState(); return h?.probe?.config?.url?.startsWith(relayArm.url) ? h : null; }, 50);
    assert.equal((await hostState()).probeLastError, null, 'the relay Start must not be refused');
    const outcome = await until('relay probe settled', async () => { const h = await hostState(); return h?.probe && h.probe.config.url.startsWith(relayArm.url) && (h.probe.status === 'ready' || h.probe.status === 'failed') ? h : null; }, 300);
    // With explicit track names the arm must show a REAL OBJECT for a named track: a decoded `object` fact (never a
    // SUBSCRIBE acceptance or a group_bound) on the accepted request's session/alias, and the rendered cell with the
    // SAME identity. Judged against a 20 s wall deadline on return; a non-delivery is recorded and fails the arm.
    const objectDeadlineMs = 20000;
    let objectOutcome = { required: relayArm.tracks.length > 0, delivered: false };
    if (relayArm.tracks.length && outcome.probe.status === 'ready') {
      const { decodeMessage } = await import(join(repoRoot, 'packages/devtools-protocol/dist/index.js'));
      const probeFacts = async () => (await evaluate(ps, 'JSON.parse(JSON.stringify(window.__probeFrames ?? []))'))
        .map(text => { const r = decodeMessage(text); if (!r.ok) throw new Error(`gate decode failed: ${r.error.code}`); return r.message; })
        .flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
      const nameOf = f => f.displayName ?? Buffer.from(f.identity.name, 'hex').toString('utf8');
      // One poll = one read of facts + view model; the deadline is judged on the read's RETURN before any sample is
      // accepted (test/probe-object-wait.mjs, with a controlled-clock late-return regression).
      const read = async () => {
        const facts = await probeFacts();
        const tracks = facts.filter(f => f.kind === 'track' && relayArm.tracks.includes(nameOf(f)));
        const accepted = facts.filter(f => f.kind === 'request' && f.state === 'accepted' && tracks.some(t => t.trackId === f.trackId));
        const objects = facts.filter(f => f.kind === 'object' && accepted.some(r => r.sessionId === f.sessionId && r.trackAlias === f.trackAlias));
        const vm = await evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel.vms.probe))');
        const sample = objects.at(-1) ?? null;
        const cell = sample ? vm.rows.flatMap(r => r.cells).find(c => c.present && c.g === `${sample.sessionId}/${sample.trackAlias}/${sample.groupId}` && c.o === sample.objectId) ?? null : null;
        const groupBounds = facts.filter(f => f.kind === 'group_bound').length;
        return { sample, cell,
          details: sample ? { track: nameOf(tracks.find(t => accepted.some(r => r.trackId === t.trackId && r.trackAlias === sample.trackAlias)) ?? tracks[0] ?? { identity: { name: '' } }),
            request: accepted.map(r => ({ requestId: r.requestId, trackAlias: r.trackAlias, trackId: r.trackId })), object: { sessionId: sample.sessionId, trackAlias: sample.trackAlias, groupId: sample.groupId, objectId: sample.objectId, payloadBytes: sample.payloadBytes, objectStatus: sample.objectStatus }, cell: cell && { g: cell.g, o: cell.o }, objectFacts: objects.length, groupBounds } : {},
          diagnostics: { tracksSeen: tracks.map(nameOf), accepted: accepted.map(r => ({ requestId: r.requestId, trackAlias: r.trackAlias, state: r.state })), requests: facts.filter(f => f.kind === 'request').map(r => ({ requestId: r.requestId, state: r.state, trackId: r.trackId })), objectFacts: objects.length, groupBounds, failures: facts.filter(f => f.kind === 'failure').map(f => ({ stage: f.stage, outcome: f.outcome, detail: f.detail ?? null })) } };
      };
      const waited = await awaitObjectDelivery({ read, deadlineMs: objectDeadlineMs });
      const { sample, ...rest } = waited;
      objectOutcome = { required: true, ...rest };
    } else await pause(500);
    const relayVm = await evaluate(ps, `JSON.parse(JSON.stringify({ session: window.__playaPanel.vms.probe.session, events: window.__playaPanel.vms.probe.events, rows: window.__playaPanel.vms.probe.rows.length, cells: window.__playaPanel.vms.probe.rows.map(r => r.cells.length), status: document.getElementById('probeStatus').textContent }))`);
    report.publicRelayArm = { relay: relayArm.url, namespace: relayArm.namespace, tracks: relayArm.tracks, policy: relayArm.policy, draft: relayArm.draft, status: outcome.probe.status, failure: outcome.probe.failure, ...relayVm, objectOutcome,
      note: 'labelled arm against a real relay named on the command line; not a loopback or CI claim' };
    if (outcome.probe.status === 'ready') {
      await click('#probeGo');                                    // Stop (the button reads Stop only while a run is live)
      const stopped = await until('relay probe stopped', async () => { const h = await hostState(); return h?.probe?.status === 'stopped' || h?.probe?.status === 'failed' ? h : null; }, 150);
      report.publicRelayArm.stop = { status: stopped.probe.status, failure: stopped.probe.failure };
    }
    step('public relay arm', report.publicRelayArm);
    if (objectOutcome.required) assert.ok(objectOutcome.delivered, `the named track(s) ${JSON.stringify(relayArm.tracks)} did not deliver an object with a matching rendered cell within ${objectDeadlineMs} ms: ${JSON.stringify(objectOutcome)}`);
    await click('#btnAttach');
  }

  // 12c. PROBE, quarantine control: a TEST-ONLY wrapper in the DevTools document makes the next transport's
  //      `closed` never settle, so the dial failure's teardown exceeds the runner's close bound. The owner must
  //      publish the handshake failure WITH `blocked`, the panel must offer no Start (disabled, status naming the
  //      recovery), and a press must reach no run. Nothing resets it; it is the last probe step of this gate.
  await evaluate(dtSession, `(() => { const Orig = WebTransport; window.__gateHoldClose = false;
    window.WebTransport = class HeldCloseWebTransport extends Orig { get closed() { return window.__gateHoldClose ? new Promise(() => {}) : super.closed; } }; return true; })()`);
  await click('#btnProbe');
  await until('probe strip for quarantine control', () => evaluate(ps, `!document.getElementById('probeStrip').classList.contains('hidden') && document.getElementById('probeGo').textContent === 'Start' && !document.getElementById('probeGo').classList.contains('disabled')`));
  await evaluate(dtSession, 'window.__gateHoldClose = true; true');
  await evaluate(ps, `document.getElementById('probeUrl').value = 'https://127.0.0.1:1/moq'; document.getElementById('probeNs').value = 'night'; document.getElementById('probeTracks').value = ''; document.getElementById('probeDraft').value = '22';`);
  await click('#probeGo');
  const quarantined = await until('quarantined', async () => { const h = await hostState(); return h?.probe?.status === 'failed' && h.probe.blocked ? h : null; }, 120);   // dial failure + 3 s close bound
  await evaluate(dtSession, 'window.__gateHoldClose = false; true');
  const qFacts = await evaluate(ps, `JSON.parse(JSON.stringify(window.__playaPanel.vms.probe.events.map(ev => ev.name)))`);
  assert.ok(qFacts.some(n => /teardown timeout/.test(n)), `the teardown timeout fact must be shown, got ${JSON.stringify(qFacts)}`);
  assert.ok(qFacts.some(n => /dial (error|timeout)/.test(n)), 'the dial failure fact must still be shown');
  assert.equal(quarantined.probe.blocked.reason, 'unproven-close');
  assert.equal(quarantined.probe.canStart, false);
  assert.match(quarantined.probe.failure ?? '', /./, 'the handshake failure stays as context');
  const qUi = await evaluate(ps, `({ go: document.getElementById('probeGo').textContent, disabled: document.getElementById('probeGo').classList.contains('disabled'), status: document.getElementById('probeStatus').textContent })`);
  assert.equal(qUi.go, 'Start'); assert.equal(qUi.disabled, true);
  assert.match(qUi.status, /^failed · .* · quarantined: .*close and reopen DevTools/);
  const qGeneration = quarantined.probe.core?.generation;
  await click('#probeGo');                                        // a real press on the disabled control
  await pause(500);
  const afterPress = await hostState();
  assert.equal(afterPress.probeLastError, null, 'the disabled Start must not even send a refused request');
  assert.equal(afterPress.probe.status, 'failed'); assert.equal(afterPress.probe.core?.generation, qGeneration);
  assert.equal(afterPress.probe.blocked.reason, 'unproven-close');
  assert.equal((await hostState()).core.phase, 'attached', 'the page lane is untouched by the quarantine');
  await click('#btnAttach');
  await until('attach lane shown after quarantine', () => evaluate(ps, `document.getElementById('probeStrip').classList.contains('hidden')`));
  step('probe quarantine control', { failure: quarantined.probe.failure, blocked: quarantined.probe.blocked, ui: qUi, facts: qFacts, generation: qGeneration });

  // 13. The view loses its owner port while attached: retained rows stay, the indicator is off, the
  //     button reads "Owner lost", and the panel does not claim a mock preview or a live source.
  await evaluate(dtSession, 'window.__viewReview.views.at(-1).disconnect();');
  await until('panel lost owner port', () => evaluate(ps, 'window.__playaPanel.hasOwner === false'));
  const loss = await evaluate(ps, `({ live: document.getElementById('pickerDot').classList.contains('live'), button: document.getElementById('btnDev').textContent, host: window.__playaPanel.host, rows: window.__playaPanel.vm.rows.length, line: document.getElementById('hostLine').textContent })`);
  assert.equal(loss.live, false, 'a view without its owner must not display a live source');
  assert.equal(loss.button, 'Owner lost');
  assert.equal(loss.host, null);
  step('owner-view port loss', loss);

  await rpc(hs, 'Page.enable').catch(() => {});
  const shot = await rpc(hs, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) await writeFile(join(artifact, 'devtools.png'), Buffer.from(shot.data, 'base64'));
  report.completed = true;
} catch (e) {
  report.fatal = String(e?.stack ?? e);
} finally {
  await ctx?.close().catch(() => {});
  serverA.close(); serverB.close();
}
// The verdict is decided after shutdown: late-counted errors fail the run.
report.errorCount = report.errors.length + report.consoleDropped;
report.passed = report.completed === true && !report.fatal && report.errorCount === 0;
await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
