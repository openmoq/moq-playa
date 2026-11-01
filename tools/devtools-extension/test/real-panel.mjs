// Browser gate: the BUILT extension inside a real DevTools window.
//
// Proves codec + adapter + renderer in the actual Playa tab using SYNTHETIC
// observations. It does not prove live messaging, observer preservation,
// Probe lifecycle or MOQT traffic — those are separate gates.
//
// Steps: copy the built extension to an isolated temp dir and hash it;
// refuse a manifest with a background owner; open headed Chrome for Testing
// on a data: page with no Playa and no relay traffic; find the real DevTools
// host over browser-level CDP; ask its InspectorView to show the registered
// Playa panel; attach to the real panel iframe; push serialized fixtures
// through `__playaPanel.applyEncoded`; observe DOM row widths [4,1] → [4,2];
// wait for paint; screenshot the DevTools window; then, with a row whose
// window holds the full 256 ids at the top of the uint64 domain and a long
// exact track label, undock DevTools through its own DockController and size
// the DevTools window to the three breakpoint regions (≈1200 / 800 / 550 CSS
// px): the grid must intersect the viewport at scrollTop 0, a cell must stay
// selectable and its details reachable, the document must not overflow
// horizontally, and every 256-column row scrolls INSIDE itself. A screenshot
// is saved per width. The VERDICT is decided by the pure helper in
// ../src/gate-verdict.mjs, which has its own tests; a layout failure is a
// harness-level failure in every mode.
//
// Modes and controls (each operates on the TEMP COPY only; the shipping
// dist and the tree are never modified):
//   (default)                    positive run; passes only with the right DOM
//                                growth AND zero panel exceptions/console errors.
//   --mutate-row-cache           reverts the per-row node cache to the widest-row
//                                count; passes only if THAT failure occurs at the
//                                narrow-row append after a correct [4,1] setup.
//   --control=missing-registration  empties devtools.js so no panel registers;
//                                must FAIL in both modes (harness failure).
//   --control=async-error        wraps applyEncoded to throw asynchronously;
//                                must FAIL the positive run (counted exception).
//   --control=slow-frontend      throttles the DevTools host CPU from attach
//                                (--throttle=N, default 20x); the positive run
//                                must still PASS and the frontend must have been
//                                pending on arrival (readiness wait exercised,
//                                not vacuous). The rate is recorded in the report.
// Harness failures — launch, missing host/panel, timeouts, missing mutation
// anchors — are failures in every mode.
//
// Requirements: a display (headed Chromium; Xvfb on Linux CI), the root
// workspace's Playwright Chromium (`pnpm exec playwright install chromium`),
// and a built `dist/` (`pnpm build` in this directory).
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openPlayaPanel } from './devtools-frontend.mjs';
import { createNativeClick } from './native-click.mjs';
import { gateVerdict } from '../src/gate-verdict.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..');
const repoRoot = resolve(extensionDir, '../..');
const require = createRequire(join(repoRoot, 'package.json'));
const { chromium } = require('playwright');
const { encodeMessage, decodeMessage } = await import('@openmoq/devtools-protocol');
const { snapshotFixture, batchFixture } = await import('@openmoq/devtools-protocol/fixtures');

const args = process.argv.slice(2);
const mode = args.includes('--mutate-row-cache') ? 'negative-row-cache' : 'positive';
const control = args.find(a => a.startsWith('--control='))?.slice(10) ?? null;
// slow-frontend control: the CPU throttle rate is EXPLICIT (default 20x, the control recipe). A heavier host (e.g.
// emulated x64) may choose a fixed lower rate on the command line; it is recorded in the report and `wasPending`
// stays required, so the wait is still proven exercised. No auto-calibration, no retry.
const throttleArg = args.find(a => a.startsWith('--throttle='))?.slice('--throttle='.length);
const throttleRate = throttleArg === undefined ? 20 : Number(throttleArg);
if (!Number.isFinite(throttleRate) || throttleRate < 1) throw new Error(`invalid --throttle=${throttleArg}`);
if (throttleArg !== undefined && control !== 'slow-frontend') throw new Error('--throttle applies to --control=slow-frontend only');
if (control !== null && !['missing-registration', 'async-error', 'slow-frontend'].includes(control)) throw new Error(`unknown --control=${control}`);
const source = args.find(a => a.startsWith('--dist='))?.slice(7) ?? join(extensionDir, 'dist');
const artifact = await mkdtemp(join(tmpdir(), 'playa-devtools-real-panel-'));
const extension = join(artifact, 'extension');
await cp(source, extension, { recursive: true });

// Evidence the verdict decides on. Error COUNTING never stops; stored text is bounded.
const MAX_LINES = 50, MAX_LINE = 300;
const evidence = { fatal: null, before: null, after: null, rendererError: null, painted: false, errorCount: 0 };
const report = { artifact, copiedFrom: source, mode, control, steps: [], console: [], consoleDropped: 0 };
const noteError = text => {
  evidence.errorCount++;
  if (report.console.length >= MAX_LINES) { report.consoleDropped++; return; }
  report.console.push(String(text).slice(0, MAX_LINE));
};

try {
  if (mode === 'negative-row-cache') {
    // The exact regression the renderer test exists for. BOTH anchors must be
    // present; a renderer that changed shape makes this a harness failure.
    const file = join(extension, 'panel.js');
    const text = await readFile(file, 'utf8');
    const a1 = 'if (!node || node.count !== r.cells.length) {', a2 = 'count: r.cells.length };';
    if (!text.includes(a1) || !text.includes(a2)) throw new Error('row-cache mutation anchors not found; the renderer changed shape');
    await writeFile(file, text.replace(a1, 'if (!node || node.count !== vm.columns) {').replace(a2, 'count: vm.columns };'));
  }
  if (control === 'missing-registration') await writeFile(join(extension, 'devtools.js'), '');
  if (control === 'async-error') {
    const file = join(extension, 'panel.js');
    const text = await readFile(file, 'utf8');
    const anchor = 'window.__playaPanel = {';
    if (!text.includes(anchor)) throw new Error('async-error control anchor not found');
    await writeFile(file, text + `
;(() => { const real = window.__playaPanel.applyEncoded.bind(window.__playaPanel);
  window.__playaPanel.applyEncoded = (t) => { const r = real(t); queueMicrotask(() => { throw new Error('control: asynchronous renderer error'); }); return r; }; })();
`);
  }

  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  if (manifest.background) throw new Error('shipping manifest unexpectedly has a background owner');
  const hash = createHash('sha256');
  for (const file of (await readdir(extension)).sort()) { hash.update(file); hash.update(await readFile(join(extension, file))); }
  report.buildHash = hash.digest('hex');
} catch (e) { evidence.fatal = String(e && e.message || e); }

const pause = ms => new Promise(r => setTimeout(r, ms));
let ctx;
if (evidence.fatal === null) {
  try {
    ctx = await chromium.launchPersistentContext(join(artifact, 'profile'), { headless: false,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--auto-open-devtools-for-tabs',
        '--disable-background-networking', '--window-size=1440,1000'] });
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto('data:text/html,<title>Playa panel gate</title><h1>No Playa on this page</h1>');

    const root = await ctx.browser().newBrowserCDPSession();
    let nextId = 0;
    const attach = async targetId => (await root.send('Target.attachToTarget', { targetId })).sessionId;
    const rpc = (sessionId, method, params = {}, timeoutMs = 5000) => new Promise((resolveRpc, reject) => {
      const id = ++nextId;
      const cleanup = () => { clearTimeout(timer); root.off('Target.receivedMessageFromTarget', listener); };
      const listener = e => {
        if (e.sessionId !== sessionId) return;
        const m = JSON.parse(e.message); if (m.id !== id) return;
        cleanup(); m.error ? reject(new Error(JSON.stringify(m.error))) : resolveRpc(m.result);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP timeout ${method} (${timeoutMs} ms)`)); }, timeoutMs);
      root.on('Target.receivedMessageFromTarget', listener);
      root.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(e => { cleanup(); reject(e); });
    });
    const evaluate = async (session, expression, timeoutMs) => {
      const r = await rpc(session, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? JSON.stringify(r.exceptionDetails));
      return r.result?.value;
    };
    const findTarget = async (pick, tries = 30) => {
      for (let i = 0; i < tries; i++) {
        const t = (await root.send('Target.getTargets')).targetInfos.find(pick);
        if (t) return t;
        await pause(100);
      }
      return null;
    };

    // 1. The real DevTools host, and its InspectorView. Frontend internals are
    //    test-only; if they change, this gate fails visibly rather than falling
    //    back to an extension-page-only check. The panel is opened only once the
    //    frontend's own bootstrap promise has resolved (test/devtools-frontend.mjs).
    //    Control --control=slow-frontend throttles the host's CPU 20x from the
    //    moment of attach and requires the frontend to have been PENDING on
    //    arrival, so the wait is proven exercised, then lifts the throttle.
    const host = await findTarget(t => t.url.startsWith('devtools://'));
    if (!host) throw new Error('No DevTools host target');
    const hostSession = await attach(host.targetId);
    if (control === 'slow-frontend') await rpc(hostSession, 'Emulation.setCPUThrottlingRate', { rate: throttleRate });
    const opened = await openPlayaPanel({ evaluate, session: hostSession });
    if (control === 'slow-frontend') await rpc(hostSession, 'Emulation.setCPUThrottlingRate', { rate: 1 });
    report.steps.push(opened);
    report.frontend = control === 'slow-frontend' ? { ...opened, throttleRate } : opened;
    if (control === 'slow-frontend' && opened.wasPending !== true) throw new Error(`slow-frontend control: the frontend was already ready on arrival (${JSON.stringify(opened)}); the readiness wait was not exercised`);

    // 2. The REAL panel iframe, with the DevTools page's fresh owner/tab params.
    //    Error listeners are registered BEFORE Runtime.enable so replayed
    //    bootstrap exceptions are counted too.
    const panel = await findTarget(t => t.type === 'iframe' && t.url.includes('/panel.html'));
    if (!panel) throw new Error('Playa panel iframe did not open');
    report.panelTarget = { type: panel.type, url: panel.url };
    const panelSession = await attach(panel.targetId);
    root.on('Target.receivedMessageFromTarget', e => {
      if (e.sessionId !== panelSession) return;
      const m = JSON.parse(e.message);
      if (m.method === 'Runtime.exceptionThrown') noteError(`exception: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? ''}`);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') noteError(`console.error: ${m.params.args?.map(a => a.value ?? a.description).join(' ')}`);
    });
    await rpc(panelSession, 'Runtime.enable');
    await pause(150);
    const initial = await evaluate(panelSession, `({ title: document.title, owner: window.__playaPanel?.owner, rect: document.body.getBoundingClientRect().toJSON() })`);
    report.initial = initial;
    evidence.painted = initial.rect.width > 0;

    // 3. Synthetic fixtures through the real codec: a 4-object group and a
    //    1-object group, then the narrow group grows.
    const snapshot = { ...snapshotFixture, watermark: '10', facts: [...snapshotFixture.facts.slice(0, 3),
      ...[0, 1, 2, 3].map(o => ({ ...snapshotFixture.facts[3], fact: { ...snapshotFixture.facts[3].fact, groupId: '2', objectId: String(o), deliveryId: 'wide-' + o } })),
      { ...snapshotFixture.facts[3], fact: { ...snapshotFixture.facts[3].fact, groupId: '1', objectId: '0', deliveryId: 'small-0' } },
      { ...snapshotFixture.facts[4], fact: { ...snapshotFixture.facts[4].fact, name: 'receive_bitrate', value: 64000,
        unavailable: null, unit: 'bps', definition: 'Observed receive bitrate for this source.', windowMs: 250 } }] };
    const batch = { ...batchFixture, fromSeq: '11', toSeq: '11',
      events: [{ ...batchFixture.events[0], seq: '11', fact: { ...batchFixture.events[0].fact, groupId: '1', objectId: '1', deliveryId: 'small-1' } }] };
    for (const m of [snapshot, batch]) { const d = decodeMessage(encodeMessage(m)); if (!d.ok) throw new Error(`fixture rejected: ${d.error.code}`); }
    const observe = `(() => [...document.querySelectorAll('#rows .row')].map(r => r.querySelectorAll('.cell').length))()`;
    const apply = wire => `(() => { const r = window.__playaPanel.applyEncoded(${JSON.stringify(wire)}); if (!r.ok) throw new Error('codec rejected: ' + r.error.code); return true; })()`;
    await evaluate(panelSession, apply(encodeMessage(snapshot)));
    evidence.before = await evaluate(panelSession, observe);
    try {
      await evaluate(panelSession, apply(encodeMessage(batch)));
      evidence.after = await evaluate(panelSession, observe);
    } catch (e) { evidence.rendererError = String(e && e.message || e); }

    if (evidence.rendererError === null) {
      const meaning = await evaluate(panelSession, `(() => {
        const row = [...document.querySelectorAll('#sparks .spark')].find(s => s.querySelector('h4')?.textContent === 'receive bitrate');
        const label = row?.querySelector('h4'), value = row?.querySelector('.now');
        return { label: label?.textContent, value: value?.textContent, labelTitle: label?.title, valueTitle: value?.title };
      })()`);
      report.metricMeaning = meaning;
      const expected = 'Observed receive bitrate for this source. (250 ms window)';
      if (meaning.labelTitle !== expected || meaning.valueTitle !== expected || meaning.value !== '64000 bps') {
        throw new Error(`available metric must expose its source definition and window on label and value: ${JSON.stringify(meaning)}`);
      }

      // A hidden tab keeps consuming observations, but must not update its DOM. Showing it again paints the
      // latest adapter state without another snapshot or attachment. Use the actual DevTools tab lifecycle.
      const selectedTab = await evaluate(hostSession, `(async () => { const UI = await import('./ui/legacy/legacy.js'); const v = UI.InspectorView.InspectorView.instance(); await v.showPanel('elements'); return v.tabbedPane.selectedTabId; })()`);
      if (selectedTab !== 'elements') throw new Error(`DevTools did not select Elements: ${selectedTab}`);
      const metricDom = `(() => [...document.querySelectorAll('#sparks .spark')].find(s => s.querySelector('h4')?.textContent === 'receive bitrate')?.querySelector('.now')?.textContent)()`;
      const beforeHidden = await evaluate(panelSession, metricDom);
      const hiddenBatch = { ...batch, fromSeq: '12', toSeq: '12', events: [{ ...batch.events[0], seq: '12',
        fact: { ...snapshot.facts.at(-1).fact, value: 128000 } }] };
      await evaluate(panelSession, apply(encodeMessage(hiddenBatch)));
      const hiddenState = await evaluate(panelSession, `({ hidden: document.hidden, metric: window.__playaPanel.vm.sparks.find(s => s.name === 'receive bitrate')?.now, applied: window.__playaPanel.applied.at(-1) })`);
      const whileHidden = await evaluate(panelSession, metricDom);
      report.visibility = { beforeHidden, whileHidden, hiddenState };
      if (hiddenState.metric !== '128000 bps' || hiddenState.applied?.seq !== '12-12') throw new Error(`hidden panel stopped consuming observations: ${JSON.stringify(report.visibility)}`);
      if (whileHidden !== beforeHidden) throw new Error(`hidden panel updated its DOM: ${JSON.stringify(report.visibility)}`);
      await evaluate(hostSession, `(async () => { const UI = await import('./ui/legacy/legacy.js'); await UI.InspectorView.InspectorView.instance().showPanel(${JSON.stringify(opened.panelId)}); })()`);
      let shown;
      for (let i = 0; i < 40; i++) { shown = await evaluate(panelSession, `({ hidden: document.hidden, value: ${metricDom} })`); if (!shown.hidden && shown.value === '128000 bps') break; await pause(50); }
      report.visibility.shown = shown;
      if (shown.hidden || shown.value !== '128000 bps') throw new Error(`shown panel did not paint the latest observation: ${JSON.stringify(report.visibility)}`);
    }

    // 4. Paint, let asynchronous errors surface, then screenshot the actual DevTools window.
    await evaluate(panelSession, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    await pause(250);
    const shot = await rpc(hostSession, 'Page.captureScreenshot', { format: 'png' });
    await writeFile(join(artifact, 'actual-devtools.png'), Buffer.from(shot.data, 'base64'));

    // 4b. Overlapping connections: a second session reusing the same request id, alias and group. The rows must name
    //     their owning session (requests) and session + alias (groups, selected object) IN THE DOM, while the two
    //     groups keep distinct selectCell keys. Applied as a snapshot (state replacement) and then the base snapshot is
    //     restored so the later steps see the original rows.
    if (evidence.rendererError === null) {
      const [sess, , req, obj] = snapshotFixture.facts;
      // A snapshot is adopted only when its watermark advances; the restore below advances it again.
      const overlap = { ...snapshot, watermark: '20', facts: [...snapshot.facts,
        { ...sess, fact: { ...sess.fact, sessionId: 'replacement-session' } },
        { ...req, fact: { ...req.fact, sessionId: 'replacement-session' } },
        { ...obj, fact: { ...obj.fact, sessionId: 'replacement-session', groupId: '2', objectId: '0', deliveryId: 'replacement-delivery' } }] };
      { const d = decodeMessage(encodeMessage(overlap)); if (!d.ok) throw new Error(`overlap fixture rejected: ${d.error.code}`); }
      await evaluate(panelSession, apply(encodeMessage(overlap)));
      const dom = await evaluate(panelSession, `(() => ({
        requests: [...document.querySelectorAll('#requests .req')].map(r => ({ top: r.querySelector('.top').textContent, context: r.querySelector('.caption.context')?.textContent ?? null })),
        rows: [...document.querySelectorAll('#rows .row')].map(r => ({ label: r.querySelector('.label').textContent, key: r.querySelector('.cell')?.title ?? null })),
        session: [...document.querySelectorAll('#session .k')].map(k => [k.textContent, k.nextElementSibling?.textContent ?? null]).find(([k]) => k === 'session') ?? null }))()`);
      report.overlap = dom;
      const g2 = dom.rows.filter(r => /^g 2/.test(r.label));
      const problems = [];
      if (dom.requests.length !== 2 || new Set(dom.requests.map(r => r.context)).size !== 2 || !dom.requests.every(r => /^session /.test(r.context ?? ''))) problems.push(`request rows do not each name their own session: ${JSON.stringify(dom.requests)}`);
      if (g2.length !== 2 || new Set(g2.map(r => r.label)).size !== 2 || !g2.every(r => /session [^\s]+ · alias \d+/.test(r.label))) problems.push(`the two g 2 rows do not name session + alias: ${JSON.stringify(g2)}`);
      if (g2.length === 2 && g2[0].key === g2[1].key) problems.push(`the two g 2 rows share a cell key: ${JSON.stringify(g2)}`);
      if (!dom.session || !/replacement-session \(latest of 2 retained\)/.test(dom.session[1])) problems.push(`the session header does not name the displayed session: ${JSON.stringify(dom.session)}`);
      if (problems.length) throw new Error(`overlapping sessions: ${problems.join('; ')}`);
      await evaluate(panelSession, apply(encodeMessage({ ...snapshot, watermark: '30' })));
      await evaluate(panelSession, apply(encodeMessage({ ...batch, fromSeq: '31', toSeq: '31', events: batch.events.map(e => ({ ...e, seq: '31' })) })));
      const restored = await evaluate(panelSession, observe);
      if (JSON.stringify(restored) !== JSON.stringify(evidence.after)) throw new Error(`rows after restoring the base snapshot ${JSON.stringify(restored)} ≠ ${JSON.stringify(evidence.after)}`);
    }

    // 5. Docked-width layout, measured in the REAL panel document after the row-cache evidence is fixed above.
    //    Skipped only when the renderer already failed (the negative row-cache mode has its own verdict).
    if (evidence.rendererError === null) {
      // 5a. A 256-id window at the top of the uint64 domain (exact ids, never truncated) and a long exact label.
      const wideFrom = 18446744073709551615n - 255n;
      // Batches must be contiguous: the restored snapshot is watermark 30 and its batch seq 31, so this one starts at 32.
      const base = 32;
      const wide = { ...batchFixture, fromSeq: String(base), toSeq: String(base + 257), events: [
        { ...batchFixture.events[0], seq: String(base), fact: { kind: 'track', trackId: 'video-long', identity: { namespace: ['6d65646961', '61766e'], name: '766964656f2d6c6f6e67' }, displayName: 'video-' + 'longexactlabel'.repeat(5), mediaType: 'video', codec: 'avc1.640028', packaging: 'cmaf' } },
        ...Array.from({ length: 256 }, (_, i) => ({ ...batchFixture.events[0], seq: String(base + 1 + i), fact: { ...batchFixture.events[0].fact, groupId: '3', objectId: (wideFrom + BigInt(i)).toString(), deliveryId: 'wide256-' + i, streamId: '18446744073709551615', subgroupId: '18446744073709551614' } })),
        // A FIN-derived bound at the top of the domain gives the wide row a genuinely long metadata value.
        { ...batchFixture.events[0], seq: String(base + 257), fact: { kind: 'group_bound', sessionId: batchFixture.events[0].fact.sessionId, requestId: batchFixture.events[0].fact.requestId, trackId: batchFixture.events[0].fact.trackId, trackAlias: batchFixture.events[0].fact.trackAlias, groupId: '3', objectId: '18446744073709551615', bound: 'exclusive', evidence: 'end-of-group' } } ] };
      { const d = decodeMessage(encodeMessage(wide)); if (!d.ok) throw new Error(`wide fixture rejected: ${d.error.code}`); }
      await evaluate(panelSession, apply(encodeMessage(wide)));
      const columns = await evaluate(panelSession, `(() => [...document.querySelectorAll('#rows .row .cells')].map(c => c.querySelectorAll('.cell').length))()`);
      if (!columns.includes(256)) throw new Error(`the wide row did not render 256 cells: ${JSON.stringify(columns)}`);

      // 5b. The real dock setting: DevTools in its own window, so the window bounds ARE the panel size. Frontend
      //     internals are test-only; drift fails visibly.
      const dock = await evaluate(hostSession, `(async () => { const UI = await import('./ui/legacy/legacy.js'); const dc = UI.DockController?.DockController?.instance?.();
        if (!dc || typeof dc.setDockSide !== 'function') throw new Error('DevTools frontend internals drifted: DockController.setDockSide is unavailable');
        dc.setDockSide('undocked'); return typeof dc.dockSide === 'function' ? String(dc.dockSide()) : null; })()`, 15000);
      const pageWindow = (await root.send('Browser.getWindowForTarget', { targetId: (await findTarget(t => t.type === 'page' && t.url.startsWith('data:'))).targetId })).windowId;
      let devWindow = null;
      for (let i = 0; i < 50 && devWindow === null; i++) { const w = (await root.send('Browser.getWindowForTarget', { targetId: host.targetId })).windowId; if (w !== pageWindow) devWindow = w; else await pause(100); }
      if (devWindow === null) throw new Error('DevTools did not move to its own window after setDockSide(undocked)');
      const click = createNativeClick({ evaluate, rpc, session: () => panelSession });
      const measureExpr = `(() => { const de = document.documentElement; de.scrollTop = 0; document.body.scrollTop = 0;
        const cols = document.querySelector('.cols'); const tracks = getComputedStyle(cols).gridTemplateColumns.trim().split(/\\s+/).length;
        const rows = document.getElementById('rows').getBoundingClientRect();
        const rowInfo = [...document.querySelectorAll('#rows .row')].map(r => { const c = r.querySelector('.cells'); const cells = [...c.querySelectorAll('.cell')];
          return { count: cells.length, scrollWidth: c.scrollWidth, clientWidth: c.clientWidth, internalScroll: c.scrollWidth > c.clientWidth, minCell: Math.min(...cells.map(x => x.getBoundingClientRect().width)) }; });
        const order = [...cols.children].map(c => ({ region: c.className, top: c.getBoundingClientRect().top }));
        const clipped = [...document.querySelectorAll('.seg, .picker, .pickList, .bar, .notice, .legend')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.className);
        // Internally clipped descendants the document-level check cannot see: long values must fit or wrap in their OWN box.
        const clippedValues = [...document.querySelectorAll('.row .meta, .row .label, .selected > *, .kv > *, .ev > *')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => ({ cls: e.className, text: e.textContent.slice(0, 40), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth }));
        const selectedTracks = getComputedStyle(document.getElementById('selected')).gridTemplateColumns.trim().split(/\s+/).length;
        const metaWhiteSpace = getComputedStyle(document.querySelector('#rows .row .meta')).whiteSpace;
        const longestMeta = Math.max(...[...document.querySelectorAll('#rows .row .meta')].map(e => e.textContent.length));
        return { innerWidth, innerHeight, tracks, rowsTop: rows.top, rowsBottom: rows.bottom, gridIntersects: rows.height > 0 && rows.top < innerHeight && rows.bottom > 0,
          docScrollWidth: de.scrollWidth, docClientWidth: de.clientWidth, bodyScrollWidth: document.body.scrollWidth, scrollTop: de.scrollTop, rows: rowInfo, order, clipped, clippedValues, selectedTracks, metaWhiteSpace, longestMeta }; })()`;
      const selectedExpr = `(() => { const s = document.getElementById('selected'); s.scrollIntoView({ block: 'nearest' }); const r = s.getBoundingClientRect();
        return { text: s.textContent.trim().slice(0, 160), inView: r.height > 0 && r.top >= 0 && r.bottom <= innerHeight, top: r.top, bottom: r.bottom }; })()`;
      const region = w => (w > 980 ? 3 : w > 640 ? 2 : 1);
      report.layout = { dock, passes: [] };
      let inset = null;   // window chrome: outer width − panel CSS width, derived once from the first pass
      for (const target of [1200, 800, 550]) {
        const requested = inset === null ? target : target + inset;
        const before = await evaluate(panelSession, 'innerWidth');
        await root.send('Browser.setWindowBounds', { windowId: devWindow, bounds: { windowState: 'normal', width: requested, height: 1000 } });
        let actual = before;
        for (let i = 0; i < 60 && actual === before; i++) { await pause(100); actual = await evaluate(panelSession, 'innerWidth'); }
        await pause(300);
        actual = await evaluate(panelSession, 'innerWidth');
        if (inset === null) inset = target - actual;
        await evaluate(panelSession, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
        const m = await evaluate(panelSession, measureExpr);
        await click('#rows .row .cell');                       // a real click selects a cell at this width
        const selected = await evaluate(panelSession, selectedExpr);
        const cascade = await evaluate(panelSession, `(() => { const sel = document.getElementById('selected');
          const kids = [...sel.children];
          // Pairing is structural: every item holds exactly one key and one value; the value under 'stream' is the exact long id.
          const pairs = kids.map(e => ({ keys: e.querySelectorAll('.k').length, values: e.querySelectorAll('.v').length, key: e.querySelector('.k')?.textContent ?? null, value: e.querySelector('.v')?.textContent ?? null,
            keyTop: e.querySelector('.k')?.getBoundingClientRect().top ?? null, valueTop: e.querySelector('.v')?.getBoundingClientRect().top ?? null, left: e.getBoundingClientRect().left }));
          return { pairs, selectedTracks: getComputedStyle(sel).gridTemplateColumns.trim().split(/\\s+/).length, selectedCells: kids.length,
            clippedSelected: kids.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 40)), longestSelected: Math.max(...kids.map(e => e.textContent.length)),
            metaWhiteSpace: getComputedStyle(document.querySelector('#rows .row .meta')).whiteSpace, clippedMeta: [...document.querySelectorAll('#rows .row .meta, #rows .row .label')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.slice(0, 40)) }; })()`);
        const png = await rpc(hostSession, 'Page.captureScreenshot', { format: 'png' });
        await writeFile(join(artifact, `actual-devtools-${target}.png`), Buffer.from(png.data, 'base64'));
        const pass = { target, requested, inset, expectedTracks: region(target), ...m, selected, cascade };
        report.layout.passes.push(pass);
        const problems = [];
        if (region(m.innerWidth) !== region(target)) problems.push(`actual panel width ${m.innerWidth} lies outside the ${target} breakpoint region`);
        if (m.tracks !== region(target)) problems.push(`.cols has ${m.tracks} column tracks, expected ${region(target)}`);
        if (!m.gridIntersects) problems.push(`the grid does not intersect the viewport at scrollTop 0 (rows top ${m.rowsTop}, viewport height ${m.innerHeight})`);
        if (m.docScrollWidth > m.docClientWidth || m.bodyScrollWidth > m.docClientWidth) problems.push(`the document overflows horizontally (${m.docScrollWidth}/${m.bodyScrollWidth} > ${m.docClientWidth})`);
        if (m.rows.some(r => r.minCell < 3.5)) problems.push(`a cell collapsed below --cellMin: ${JSON.stringify(m.rows.map(r => r.minCell))}`);
        if (!m.rows.every(r => r.internalScroll)) problems.push(`a 256-column row has no internal horizontal scroller: ${JSON.stringify(m.rows)}`);
        if (region(target) === 1) { const top = Object.fromEntries(m.order.map(o => [o.region, o.top])); if (!(top.center < top.left && top.left < top.right)) problems.push(`narrow order must be center → left → right, got ${JSON.stringify(m.order)}`); }
        // Cascade policy: the narrow override must actually win (same specificity → source order). Base: 5 selected columns;
        // ≤640: auto-fit columns (fewer than 5 at this width). Row meta wraps at every width. Long values fit their box.
        if (region(target) === 1) { if (cascade.selectedTracks >= 5) problems.push(`narrow .selected still has ${cascade.selectedTracks} columns (base rule won the cascade)`); }
        else if (cascade.selectedTracks !== 5) problems.push(`wide .selected has ${cascade.selectedTracks} columns, expected 5`);
        if (cascade.metaWhiteSpace !== 'normal') problems.push(`.row .meta white-space is ${cascade.metaWhiteSpace}; a long exact summary must wrap in its box at every width`);
        // Each selected item must pair its key with ITS value (same DOM item, value below the key); the long exact ids must be
        // the values of their own keys. Five pairs are expected for an object.
        if (cascade.pairs.length !== 5 || cascade.pairs.some(p => p.keys !== 1 || p.values !== 1 || p.valueTop <= p.keyTop)) problems.push(`selected details are not five key/value pairs with the value under its own key: ${JSON.stringify(cascade.pairs)}`);
        const byKey = Object.fromEntries(cascade.pairs.map(p => [p.key, p.value]));
        if (byKey.stream !== 'subgroup stream 18446744073709551615' || byKey.status !== 'received' || !/^g3 \/ o18446744073709551360$/.test(byKey.selected ?? '')) problems.push(`selected pairs carry the wrong values: ${JSON.stringify(byKey)}`);
        if (cascade.clippedSelected.length || cascade.clippedMeta.length || m.clippedValues.length) problems.push(`values clipped inside their own box: ${JSON.stringify({ selected: cascade.clippedSelected, meta: cascade.clippedMeta, other: m.clippedValues })}`);
        if (cascade.longestSelected < 20 || m.longestMeta < 40) problems.push(`the fixture's long values are missing (selected ${cascade.longestSelected} chars, meta ${m.longestMeta} chars)`);
        if (m.clipped.length) problems.push(`header text is clipped by its container (exact labels must wrap, never vanish): ${JSON.stringify(m.clipped)}`);
        if (!selected.text || !selected.inView) problems.push(`selected-object details unreachable after a real cell click: ${JSON.stringify(selected)}`);
        if (problems.length) throw new Error(`layout at ${target} CSS px: ${problems.join('; ')} — ${JSON.stringify(pass)}`);
      }
    }
  } catch (e) { evidence.fatal = String(e && e.message || e); }
  finally { if (ctx) await ctx.close(); }
}

const verdict = gateVerdict(mode, evidence);
report.evidence = evidence;
report.verdict = verdict;
await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ artifact, mode, control, buildHash: report.buildHash, panelTarget: report.panelTarget?.url,
  before: evidence.before, after: evidence.after, rendererError: evidence.rendererError, errorCount: evidence.errorCount,
  overlap: report.overlap ? { requests: report.overlap.requests.map(r => r.context), rows: report.overlap.rows.map(r => r.label), session: report.overlap.session?.[1] } : null,
  layout: report.layout?.passes.map(p => ({ target: p.target, innerWidth: p.innerWidth, innerHeight: p.innerHeight, tracks: p.tracks, rowsTop: Math.round(p.rowsTop), gridIntersects: p.gridIntersects, docOverflow: p.docScrollWidth > p.docClientWidth, minCell: Math.min(...p.rows.map(r => r.minCell)), selectedInView: p.selected.inView, selectedTracks: p.cascade.selectedTracks, metaWhiteSpace: p.cascade.metaWhiteSpace, longestMeta: p.longestMeta })) ?? null,
  painted: evidence.painted, fatal: evidence.fatal, verdict }, null, 2));
process.exitCode = verdict.pass ? 0 : 1;
