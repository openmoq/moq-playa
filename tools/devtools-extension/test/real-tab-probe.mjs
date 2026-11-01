// Probe OBJECT gate, local only: the shipped owner-local Probe (createProbeRunner
// → probe-owner → panel probe lane) against this repo's toy relay and synthetic
// publisher on loopback, over a REAL WebTransport session from the DevTools
// document. No public relay, no network beyond 127.0.0.1.
//
// What it proves: SETUP with the relay (draft 18, the toy relay's draft), an
// ACCEPTED SUBSCRIBE for an explicitly named track, incoming objects observed
// through the Probe lane with exact group/object identity in the decoded facts
// and visible cells, the adapter's bounded group/cell window, Stop with the
// exact transport's `closed` settled (the relay logs the disconnect), no new
// transport on a panel reload, and two negatives that a SETUP-only pass cannot
// satisfy: a WRONG certificate pin fails at dial with no relay SETUP, and a
// REJECTED track name fails at subscribe after SETUP.
//
// Certificate: the toy relay needs TLS; a short-lived self-signed cert is
// generated into the artifact and pinned with `serverCertificateHashes` by a
// TEST-ONLY wrapper installed into the DevTools document over CDP. No
// skip-verification code exists in the shipped bundles. If Chromium does not
// observe the offered `moqt-18` subprotocol from this relay, the gate retries
// once with the explicitly LABELLED compatibility policy and says so.
//
// Requirements: built packages and extension, the workspace Playwright
// Chromium, a display (Xvfb on Linux), and the toy relay's native WebTransport
// backend installed (`@fails-components/webtransport`). The optional
// `PLAYA_DEVTOOLS_PROBE_BROWSER` environment variable names a different
// Chromium/Chrome for Testing executable (root CI pins one build); the chosen
// executable is recorded in the report. There is no fallback and no retry: a
// browser that cannot complete the WebTransport session fails the gate, and a
// startup timeout records the owner/panel/fact state under `startupTimeout`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openPlayaPanel } from './devtools-frontend.mjs';
import { createNativeClick } from './native-click.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..');
const repoRoot = resolve(extensionDir, '../..');
const { chromium } = createRequire(join(repoRoot, 'package.json'))('playwright');
const { decodeMessage } = await import(join(repoRoot, 'packages/devtools-protocol/dist/index.js'));
const pause = ms => new Promise(r => setTimeout(r, ms));

const control = (process.argv.find(a => a.startsWith('--control=')) ?? '').slice('--control='.length) || null;
const artifact = await mkdtemp(join(tmpdir(), 'playa-devtools-probe-objects-'));
const browserExecutable = process.env.PLAYA_DEVTOOLS_PROBE_BROWSER ?? null;
const report = { artifact, passed: false, steps: [], errors: [], consoleDropped: 0, runtime: { platform: process.platform, arch: process.arch, node: process.version, browserExecutable },
  notProven: ['any public relay', 'native optional-permission prompt', 'live Playa observers / recorder', 'media decode or presentation (objects are observed, not played)'] };
const noteError = text => { if (report.errors.length >= 50) { report.consoleDropped++; return; } report.errors.push(String(text).slice(0, 300)); };
const step = (name, data = {}) => { report.steps.push({ name, ...data }); };
const children = [];
const logs = { relay: [], publisher: [] };
// Each child is its own process GROUP (pnpm → tsx → node): cleanup signals the group the gate created, never a
// process by name and never anything the gate did not start.
function launch(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  children.push(child);
  const sink = data => { for (const line of String(data).split('\n')) if (line.trim()) { if (logs[name].length < 5000) logs[name].push(line); } };
  child.stdout.on('data', sink); child.stderr.on('data', sink);
  return child;
}
const waitForLine = async (name, re, tries = 300) => { for (let i = 0; i < tries; i++) { const hit = logs[name].map(l => l.match(re)).find(Boolean); if (hit) return hit; await pause(100); } throw new Error(`${name}: no line matching ${re} (last: ${logs[name].slice(-3).join(' | ')})`); };
const count = (lines, re) => lines.filter(l => re.test(l)).length;

// 1. Extension copy (shipping manifest: Probe needs no host permission) and its hash.
const ext = join(artifact, 'extension');
await cp(join(extensionDir, 'dist'), ext, { recursive: true });
{ const hash = createHash('sha256'); for (const name of (await readdir(ext)).sort()) { hash.update(name); hash.update(await readFile(join(ext, name))); } report.extensionHash = hash.digest('hex'); }

let ctx;
try {
  // 2. Certificate + pins, relay, synthetic publisher — all loopback.
  await new Promise((ok, fail) => { const c = launch('relay', process.execPath, [join(repoRoot, 'examples/node-relay/scripts/gen-cert.mjs'), '--out-dir', join(artifact, 'certs')]); c.on('close', code => code === 0 ? ok() : fail(new Error(`gen-cert exited ${code}`))); });
  logs.relay.length = 0;
  const certPath = join(artifact, 'certs/cert.pem'), keyPath = join(artifact, 'certs/key.pem');
  const pinHex = new X509Certificate(await readFile(certPath)).fingerprint256.replaceAll(':', '').toLowerCase();
  const wrongPinHex = pinHex.replace(/^../, pinHex.startsWith('00') ? 'ff' : '00');
  launch('relay', 'pnpm', ['--filter', '@moqt/example-node-relay', 'relay-server'], { HOST: '127.0.0.1', PORT: '0', DEMO_NAMESPACE: 'demo', RELAY_CERT: certPath, RELAY_KEY: keyPath });
  const relayUrl = (await waitForLine('relay', /listening on (https:\/\/127\.0\.0\.1:\d+\/moq)/))[1];
  launch('publisher', 'pnpm', ['--filter', '@moqt/example-node-publisher', 'publish-fixture', '--loop', relayUrl], { RELAY_CERT: certPath, PACE_MS: '250' });
  await waitForLine('publisher', /loop mode: \d+ tracks established/);
  report.relay = { url: relayUrl, pin: pinHex, namespace: ['demo'], track: 'video-360', draft: 18 };
  step('local relay + publisher ready', { relayUrl });

  // 3. Browser, DevTools, owner and panel (same routing as the attachment gate).
  ctx = await chromium.launchPersistentContext(join(artifact, 'profile'), { headless: false, ...(browserExecutable ? { executablePath: browserExecutable } : {}),
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--auto-open-devtools-for-tabs', '--disable-background-networking', '--window-size=1440,1000'] });
  report.browser = ctx.browser().version();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('data:text/html,<title>Probe gate</title><h1>No Playa here. The Probe dials by itself.</h1>');
  const root = await ctx.browser().newBrowserCDPSession();
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
  const evaluate = async (s, expression, timeoutMs) => { const r = await rpc(s, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result?.value; };
  const targets = async () => (await root.send('Target.getTargets')).targetInfos;
  const findTarget = async (pick, tries = 60) => { for (let i = 0; i < tries; i++) { const t = (await targets()).find(pick); if (t) return t; await pause(100); } return null; };
  const until = async (name, fn, tries = 80) => { let last; for (let i = 0; i < tries; i++) { last = await fn(); if (last) return last; await pause(100); } throw new Error(`timeout waiting for ${name}: ${JSON.stringify(last)?.slice(0, 200)}`); };
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
    // TEST-ONLY, installed by the gate into THIS view: retain the last 64 encoded probe-lane frames the panel
    // applied. The shipped panel keeps no such storage; decoding happens here in Node with the built codec.
    await evaluate(ps, `(() => { const hook = window.__playaPanel; if (hook.__gateWrapped) return true;
      const frames = window.__probeFrames = []; const original = hook.applyEncoded.bind(hook);
      hook.applyEncoded = (text, lane = 'page') => { if (lane === 'probe') { if (frames.length >= 64) frames.shift(); frames.push(text); } return original(text, lane); };
      hook.__gateWrapped = true; return true; })()`);
  };
  await bindPanel();
  const hostState = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel?.host ?? null))');
  const probeVm = () => evaluate(ps, 'JSON.parse(JSON.stringify(window.__playaPanel.vms.probe))');
  // Raw probe-lane facts: the retained encoded frames, decoded HERE with the workspace codec — identities independent of rendering.
  const probeFacts = async () => (await evaluate(ps, 'JSON.parse(JSON.stringify(window.__probeFrames ?? []))'))
    .map(text => { const r = decodeMessage(text); if (!r.ok) throw new Error(`gate decode failed: ${r.error.code}`); return r.message; })
    .flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
  const failureAt = (facts, stage, outcome) => facts.find(f => f.kind === 'failure' && f.stage === stage && f.outcome === outcome);
  // Target-safe native click (test/native-click.mjs): stable layout + hit test before dispatch, the received click
  // verified after it; a click that lands on another control fails loudly instead of passing as the intended action.
  const click = createNativeClick({ evaluate, rpc, session: () => ps });

  // 4. TEST-ONLY certificate pin in the DevTools document: the shipped factory constructs `WebTransport`;
  //    this wrapper adds `serverCertificateHashes` for the local self-signed cert and counts constructions.
  await evaluate(dtSession, `(() => {
    const Orig = WebTransport;
    const gate = window.__probeGate = { constructed: 0, pinHex: ${JSON.stringify(pinHex)} };
    const bytes = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));
    window.WebTransport = class PinnedWebTransport extends Orig {
      constructor(url, opts) { gate.constructed++; super(url, { ...(opts ?? {}), serverCertificateHashes: [{ algorithm: 'sha-256', value: bytes(gate.pinHex) }] }); }
    };
  })()`);

  const setConfig = async (tracks, policy) => evaluate(ps, `(() => { document.getElementById('probeUrl').value = ${JSON.stringify(relayUrl)}; document.getElementById('probeNs').value = '["demo"]';
    document.getElementById('probeTracks').value = ${JSON.stringify(JSON.stringify([tracks]))}; document.getElementById('probeDraft').value = '18'; document.getElementById('probePolicy').checked = ${policy === 'compatibility'}; return true; })()`);
  // A new run is recognised by its carrier generation, so a retired run's status is never mistaken for the new one's.
  let lastGeneration = 0;
  // On a startup timeout, record WHAT the owner, the panel and the runner's facts say instead of a bare null: the
  // host state and refusal, the Start button as rendered, the config fields, the generation the gate waited past,
  // the wrapper's construction count, the failure/session/dial facts and the relay's SETUP count.
  const startupDiagnostics = async label => {
    const facts = await probeFacts().catch(e => ({ unavailable: String(e?.message ?? e) }));
    const summary = Array.isArray(facts) ? {
      failures: facts.filter(f => f.kind === 'failure').map(f => ({ stage: f.stage, outcome: f.outcome, message: f.message })),
      sessions: facts.filter(f => f.kind === 'session').map(f => f.state),
      dialAttempts: facts.filter(f => f.kind === 'dial_attempt').map(f => ({ state: f.state, negotiatedProtocol: f.negotiatedProtocol, policy: f.policy })),
    } : facts;
    const d = { label, host: await hostState().catch(e => ({ unavailable: String(e?.message ?? e) })), lastGeneration,
      button: await evaluate(ps, `(() => { const b = document.getElementById('probeGo'); return { text: b.textContent, disabled: b.classList.contains('disabled'), status: document.getElementById('probeStatus').textContent }; })()`).catch(e => ({ unavailable: String(e?.message ?? e) })),
      config: await evaluate(ps, `(() => ({ url: document.getElementById('probeUrl').value, ns: document.getElementById('probeNs').value, tracks: document.getElementById('probeTracks').value, draft: document.getElementById('probeDraft').value, compat: document.getElementById('probePolicy').checked }))()`).catch(e => ({ unavailable: String(e?.message ?? e) })),
      constructed: await evaluate(dtSession, 'window.__probeGate.constructed').catch(() => null), relaySetups: count(logs.relay, /SETUP complete/), facts: summary };
    report.startupTimeout = d;
    return d;
  };
  const settled = async label => {
    try {
      return await until('probe settled', async () => { const h = await hostState(); const g = h?.probe?.core?.generation ?? 0;
        if (!h?.probe || g <= lastGeneration || (h.probe.status !== 'ready' && h.probe.status !== 'failed')) return null; lastGeneration = g; return h; }, 200);
    } catch (e) {
      const d = await startupDiagnostics(label);
      throw new Error(`${e.message} [${label}] host=${JSON.stringify({ probe: d.host?.probe && { status: d.host.probe.status, failure: d.host.probe.failure, generation: d.host.probe.core?.generation, phase: d.host.probe.core?.phase }, probeLastError: d.host?.probeLastError })} button=${JSON.stringify(d.button)} lastGeneration=${lastGeneration} constructed=${d.constructed} relaySetups=${d.relaySetups} facts=${JSON.stringify(d.facts)}`);
    }
  };
  const stopRun = async () => { await click('#probeGo'); await until('probe stopped', async () => { const h = await hostState(); return h?.probe?.status === 'stopped' || h?.probe?.status === 'failed' ? h : null; }, 150); };

  // 5. POSITIVE: strict first; if the relay does not confirm the subprotocol, once more with LABELLED compatibility.
  await click('#btnProbe');
  await until('probe strip', () => evaluate(ps, `!document.getElementById('probeStrip').classList.contains('hidden')`));
  await setConfig('video-360', 'strict');
  await evaluate(ps, `document.getElementById('probeTracks').value = '["unterminated'; true`);
  const beforeMalformed = await evaluate(dtSession, 'window.__probeGate.constructed');
  await click('#probeGo');
  await until('malformed identity refused locally', () => evaluate(ps, `document.getElementById('probeStatus').textContent.startsWith('refused: Use a JSON array')`), 50);
  assert.equal(await evaluate(dtSession, 'window.__probeGate.constructed'), beforeMalformed, 'malformed identity must not construct a transport');
  step('negative: malformed identity input', { constructed: beforeMalformed });
  await setConfig('video-360', 'strict');
  // Control (--control=moved-start): the Start button is hidden right after the click helper measured it, so the
  // dispatched coordinates hit whatever lies beneath; the helper must refuse that as a harness failure, and the
  // run must NOT continue as if Start had been pressed.
  if (control === 'moved-start') await evaluate(ps, `window.__gateMoveAfterMeasure = '#probeGo'; true`);
  const strictClick = await click('#probeGo');
  step('strict Start clicked', strictClick);
  let outcome = await settled('strict Start');
  let policyUsed = 'strict';
  if (outcome.probe.status === 'failed' && /protocol was not observed or did not match/.test(outcome.probe.failure ?? '')) {
    // The runner's message covers BOTH a missing and a mismatched observation; only a genuinely missing one
    // (negotiatedProtocol null on the strict attempt's dial_attempt) justifies the labelled compatibility retry.
    const strictFacts = await probeFacts();
    const dial = strictFacts.filter(f => f.kind === 'dial_attempt').at(-1);
    assert.ok(dial, 'the strict attempt must have left a dial_attempt fact');
    assert.equal(dial.negotiatedProtocol, null, `the relay confirmed a DIFFERENT protocol (${dial.negotiatedProtocol}); that is a mismatch, not a missing observation — no compatibility retry`);
    report.subprotocolObserved = false;
    await setConfig('video-360', 'compatibility'); policyUsed = 'compatibility (labelled: the relay did not confirm moqt-18; negotiatedProtocol was null)';
    // The Start button must be offered again before it is pressed (the previous run's runner-side stop has settled
    // by the time the owner reports `failed`; this makes that visible in the report rather than assumed).
    const offered = await until('Start offered after the strict refusal', () => evaluate(ps, `(() => { const b = document.getElementById('probeGo'); return b.textContent === 'Start' && !b.classList.contains('disabled') ? true : null; })()`), 50);
    step('strict refusal', { offered, failure: outcome.probe.failure, generation: outcome.probe.core?.generation, constructed: await evaluate(dtSession, 'window.__probeGate.constructed') });
    await click('#probeGo'); outcome = await settled('compatibility Start');
  } else report.subprotocolObserved = true;
  assert.equal(outcome.probe.status, 'ready', `probe must reach ready, got ${outcome.probe.status}: ${outcome.probe.failure}`);
  assert.equal(outcome.probe.scope, 'tracks');
  const relaySetups = count(logs.relay, /SETUP complete/);
  const joined = await waitForLine('relay', /subscriber joined video-360 \(alias=(\d+), requestId=(\d+)\)/);
  // Objects: wait for cells, then compare the decoded identities with the relay-side subscription.
  const painted = await until('objects observed through the probe lane', async () => { const v = await probeVm(); return v.rows.length > 0 && v.rows.some(r => r.cells.some(c => c.present)) ? v : null; }, 200);
  // The synthetic publisher sends four DATA objects (0..3) per group and flags the subgroup header END_OF_GROUP,
  // so the group's end reaches the subscriber as a graceful FIN, not as a parsed status Object. The producer
  // reports that FIN-derived end as a `group_bound` fact (exclusive bound at id 4, evidence end-of-group), never
  // as an `object` fact: a bound is a label on the row, not a cell. Judging too early would never see the bound,
  // so the facts are taken only once ONE group of THIS subscription (its DATA objects observed) has its bound on
  // this session/alias: at most one synthetic group of pacing, and the bound branch below is then exercised
  // deterministically. This is the controlled fixture's completeness, not a rule for arbitrary traffic.
  const onThisRequest = f => f.kind === 'object' && f.trackAlias === joined[1] && f.requestId === joined[2] && f.trackId === 'track-0';
  const boundOf = (facts, sessionId, groupId) => facts.find(f => f.kind === 'group_bound' && f.sessionId === sessionId && f.trackAlias === joined[1] && f.groupId === groupId);
  const boundedGroup = await until('END_OF_GROUP bound (group_bound) for a group of the accepted request', async () => {
    const f = await probeFacts();
    const data = f.filter(x => onThisRequest(x) && x.objectStatus === '0');
    for (const o of data) { const b = boundOf(f, o.sessionId, o.groupId); if (b) return { groupId: o.groupId, sessionId: o.sessionId, bound: b }; }
    return null; }, 300);
  // Exact identities from the DECODED facts, then the rendering must agree with them.
  const facts = await probeFacts();
  const requestFact = facts.find(f => f.kind === 'request' && f.state === 'accepted' && f.trackId === 'track-0');
  assert.ok(requestFact, 'an accepted request fact for the named track must exist');
  assert.equal(requestFact.requestId, joined[2], 'request fact id must equal the relay-side SUBSCRIBE request id');
  assert.equal(requestFact.trackAlias, joined[1], 'request fact alias must equal the relay-side alias');
  const request = painted.requests.find(r => r.id === `req ${joined[2]}`);
  assert.ok(request && /video-360/.test(request.track) && request.state === 'active', `the rendered request row must be exactly req ${joined[2]} for video-360, got ${JSON.stringify(painted.requests)}`);
  const objectFacts = facts.filter(onThisRequest);
  assert.ok(objectFacts.length >= 1, 'at least one object fact on the relay-side alias/request must exist');
  // The ring may still hold the strict attempt's session; the objects name THIS run's session, which must be a known one.
  const sessionFact = facts.find(f => f.kind === 'session' && f.sessionId === objectFacts[0].sessionId);
  assert.ok(sessionFact, 'the objects must belong to a session this run reported');
  assert.equal(new Set(objectFacts.map(o => o.sessionId)).size, 1, 'all objects on this alias/request belong to one session');
  // Judge each object by its status: DATA objects carry payload at ids 0..3. On this fixture the group's end is a
  // FIN-derived bound, so NO status `object` fact may exist: one would mean a producer classified the bound as a
  // parsed wire Object.
  const dataObjects = objectFacts.filter(o => o.objectStatus === '0');
  const statusObjects = objectFacts.filter(o => o.objectStatus !== '0');
  assert.ok(dataObjects.length >= 1, 'at least one DATA object must be observed');
  assert.equal(statusObjects.length, 0, `no status object fact may exist on this fixture (the end of group is a FIN-derived bound), got ${JSON.stringify(statusObjects.map(o => ({ g: o.groupId, o: o.objectId, s: o.objectStatus })))}`);
  // The bound itself: exclusive at id 4 (= last DATA id 3 + 1), evidence end-of-group, on the objects' session.
  const bound = boundedGroup.bound;
  assert.equal(bound.sessionId, sessionFact.sessionId, 'the bound belongs to the objects\' session');
  assert.equal(bound.objectId, '4'); assert.equal(bound.bound, 'exclusive'); assert.equal(bound.evidence, 'end-of-group');
  assert.ok(!objectFacts.some(o => o.groupId === boundedGroup.groupId && o.objectId === '4'), 'no object fact may exist at the bound id');
  // Coverage disclosure: a delivery the runner could not attribute to an observed receipt is COUNTED, never turned
  // into an object or bound. The metric is reported from Start (value 0) and must still be 0 on this fixture.
  const unattributed = facts.filter(f => f.kind === 'metric' && f.name === 'diagnostic_unattributed_deliveries' && f.sessionId === sessionFact.sessionId);
  assert.ok(unattributed.length >= 1, 'the runner must report diagnostic_unattributed_deliveries for this run');
  assert.equal(unattributed.at(-1).value, 0, `every delivery on this fixture must be attributable, got ${unattributed.at(-1).value}`);
  const groupData = dataObjects.filter(o => o.groupId === boundedGroup.groupId).map(o => Number(o.objectId)).sort();
  assert.deepEqual(groupData, [0, 1, 2, 3], `the bounded group must have exactly its four DATA objects observed, got ${JSON.stringify(groupData)}`);
  for (const o of objectFacts) {
    assert.equal(o.sessionId, sessionFact.sessionId);
    assert.ok(/^\d+$/.test(o.groupId) && /^\d+$/.test(o.objectId));
  }
  for (const o of dataObjects) assert.ok(Number(o.objectId) >= 0 && Number(o.objectId) <= 3 && o.payloadBytes > 0, `data objects are 0..3 with payload, got id ${o.objectId} bytes ${o.payloadBytes}`);   // CHUNKS_PER_TRACK = 4
  const sample = dataObjects.find(o => o.groupId === boundedGroup.groupId);
  const cell = painted.rows.flatMap(r => r.cells).find(c => c.present && c.g === `${sample.sessionId}/${sample.trackAlias}/${sample.groupId}` && c.o === sample.objectId);
  assert.ok(cell, `the rendered cell for object ${sample.groupId}/${sample.objectId} on alias ${sample.trackAlias} must exist with the same identity`);
  const row = painted.rows.find(r => r.cells.includes(cell));
  assert.equal(row.label, `g ${sample.groupId}`);
  // The bound is rendered as the row's label text, never as a cell: the rendered row for the bounded group is
  // re-read after the bound arrived (the painted snapshot above may predate it).
  const boundedRow = await until('bounded row label', async () => { const v = await probeVm(); const r = v.rows.find(x => x.label === `g ${boundedGroup.groupId}`); return r && /ends o4 \(excl\.\)/.test(r.meta) ? r : null; }, 50);
  assert.ok(!boundedRow.cells.some(c => c.present && c.o === '4'), 'no cell may be drawn at the bound id');
  // Observed within the adapter's declared windows (an observation, not an eviction-pressure proof).
  assert.ok(painted.rows.length <= 8 && painted.rows.every(r => r.cells.length <= 256), 'observed rows/cells exceed the adapter windows');
  assert.ok(painted.exposed && painted.session.some(([k, v]) => k === 'draft' && /d18/.test(v)));
  step('objects observed', { policy: policyUsed, subprotocolObserved: report.subprotocolObserved, relaySetups, relayAlias: joined[1], relayRequestId: joined[2],
    requestFact: { requestId: requestFact.requestId, trackAlias: requestFact.trackAlias, trackId: requestFact.trackId }, sampleObject: { sessionId: sample.sessionId, alias: sample.trackAlias, group: sample.groupId, object: sample.objectId },
    renderedCell: cell, objectsSeen: objectFacts.length, dataObjectsSeen: dataObjects.length, statusObjectsSeen: statusObjects.length,
    groupBound: { groupId: boundedGroup.groupId, objectId: bound.objectId, bound: bound.bound, evidence: bound.evidence, rowMeta: boundedRow.meta }, unattributedDeliveries: unattributed.at(-1).value, observedBounds: { rows: painted.rows.length, maxCells: Math.max(...painted.rows.map(r => r.cells.length)) }, hookStats: painted.hookStats });

  // 6. Panel reload: the run and its transport are the owner's; no new construction, no new relay SETUP.
  const constructedBefore = await evaluate(dtSession, 'window.__probeGate.constructed');
  await evaluate(ps, 'setTimeout(() => location.reload(), 0); true'); await pause(800); await bindPanel();
  await until('probe still ready after reload', async () => (await hostState())?.probe?.status === 'ready');
  await until('probe lane repainted', async () => { const v = await probeVm(); return v.rows.length > 0 ? v : null; }, 100);
  assert.equal(await evaluate(dtSession, 'window.__probeGate.constructed'), constructedBefore, 'a view reload must not construct a transport');
  assert.equal(count(logs.relay, /SETUP complete/), relaySetups, 'a view reload must not cause a relay SETUP');
  step('view reload', { constructed: constructedBefore });

  // 7. Stop: the exact transport's closed settles and the relay sees the disconnect. (The reloaded view opened in
  //    Attach mode, as any fresh view does; switching to Probe is view-only and shows the live run's Stop.)
  await click('#btnProbe');
  await until('probe strip after reload', () => evaluate(ps, `!document.getElementById('probeStrip').classList.contains('hidden') && document.getElementById('probeGo').textContent === 'Stop'`));
  const disconnectsBefore = count(logs.relay, /client disconnected|onClose:/);
  await evaluate(ps, `document.getElementById('probeGo').textContent`).then(t => assert.equal(t, 'Stop'));
  await stopRun();
  assert.equal((await hostState()).probe.status, 'stopped');
  await until('relay saw the disconnect', () => count(logs.relay, /client disconnected|onClose:/) > disconnectsBefore ? true : null, 100);
  step('stopped', { relayDisconnects: count(logs.relay, /client disconnected|onClose:/) });

  // 8. NEGATIVE A: wrong pin → dial failure, and the relay completes no SETUP.
  await evaluate(dtSession, `window.__probeGate.pinHex = ${JSON.stringify(wrongPinHex)};`);
  const setupsBeforeWrong = count(logs.relay, /SETUP complete/);
  await evaluate(ps, 'window.__probeFrames.length = 0; true');                 // this negative's facts only
  await setConfig('video-360', policyUsed.startsWith('compat') ? 'compatibility' : 'strict');
  await click('#probeGo'); outcome = await settled();
  assert.equal(outcome.probe.status, 'failed');
  const wrongFailure = await until('dial failure fact', async () => failureAt(await probeFacts(), 'dial', 'error') ?? null, 100);
  const wrongVm = await probeVm();
  assert.ok(wrongVm.events.some(ev => ev.name === 'dial error · cause unknown'), `rendered events must carry the dial error, got ${JSON.stringify(wrongVm.events)}`);
  assert.equal(count(logs.relay, /SETUP complete/), setupsBeforeWrong, 'a wrong pin must never reach SETUP');
  step('negative: wrong pin', { failure: outcome.probe.failure, fact: { stage: wrongFailure.stage, outcome: wrongFailure.outcome }, events: wrongVm.events.map(e => e.name) });

  // 9. NEGATIVE B: right pin, rejected track → SETUP completes, SUBSCRIBE fails, run fails at the subscribe stage.
  await evaluate(dtSession, `window.__probeGate.pinHex = ${JSON.stringify(pinHex)};`);
  const setupsBeforeReject = count(logs.relay, /SETUP complete/);
  await evaluate(ps, 'window.__probeFrames.length = 0; true');                 // this negative's facts only
  const rejectedTrack = ' no,such-track ';
  await setConfig(rejectedTrack, policyUsed.startsWith('compat') ? 'compatibility' : 'strict');
  await click('#probeGo'); outcome = await settled();
  assert.equal(outcome.probe.status, 'failed');
  assert.deepEqual(outcome.probe.config.namespace, ['demo']);
  assert.deepEqual(outcome.probe.config.trackHints, [rejectedTrack], 'the actual panel must preserve spaces and a comma inside one track name');
  const rejectFacts = await until('subscribe failure and REQUEST_ERROR facts', async () => { const f = await probeFacts();
    return failureAt(f, 'subscribe', 'error') && f.some(x => x.kind === 'control' && x.messageType === 'REQUEST_ERROR' && x.direction === 'received') ? f : null; }, 100);
  const rejectVm = await probeVm();
  assert.ok(rejectVm.events.some(ev => ev.name === 'subscribe error · cause unknown') && rejectVm.events.some(ev => ev.name === 'REQUEST_ERROR'), `rendered events must carry both, got ${JSON.stringify(rejectVm.events)}`);
  assert.ok(!failureAt(rejectFacts, 'dial', 'error') && !failureAt(rejectFacts, 'setup', 'error'), 'the rejected track must fail at SUBSCRIBE, after a completed SETUP');
  await until('relay completed that SETUP', () => count(logs.relay, /SETUP complete/) > setupsBeforeReject ? true : null, 50);
  const rejectedIdentity = rejectFacts.find(f => f.kind === 'track' && f.identity.name === Buffer.from(rejectedTrack).toString('hex'));
  assert.ok(rejectedIdentity, 'the requested exact track name must reach the runner facts');
  assert.equal(count(logs.relay, /subscriber joined .*such-track/), 0);
  step('negative: rejected track', { failure: outcome.probe.failure, fact: { stage: 'subscribe', outcome: 'error' }, events: rejectVm.events.map(e => e.name) });

  await rpc(hs, 'Page.enable').catch(() => {});
  const shot = await rpc(hs, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot) await writeFile(join(artifact, 'devtools.png'), Buffer.from(shot.data, 'base64'));
  report.completed = true;
} catch (e) {
  report.fatal = String(e?.stack ?? e);
} finally {
  await ctx?.close().catch(() => {});
  // Bounded, awaited, PROVEN: signal the gate-owned process group, then poll the GROUP's existence (signal 0 to -pid
  // throws ESRCH once no member remains), SIGKILL the group if it outlives 5 s, and record whether it is gone.
  // The pnpm leader exiting is not proof; a descendant that ignored SIGTERM keeps the group alive. Group liveness
  // checks are POSIX-only; on other platforms this is stated as unavailable and the Linux CI check is authoritative.
  const posix = process.platform !== 'win32';
  const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const signalGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { /* already gone */ } };
  const waitGone = async (pid, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (!groupAlive(pid)) return true; await pause(100); } return !groupAlive(pid); };
  report.cleanup = [];
  for (const c of children) {
    if (!posix || !c.pid) { report.cleanup.push({ pid: c.pid, gone: null, note: 'group liveness unavailable on this platform' }); continue; }
    signalGroup(c.pid, 'SIGTERM');
    let gone = await waitGone(c.pid, 5000), killed = false;
    if (!gone) { killed = true; signalGroup(c.pid, 'SIGKILL'); gone = await waitGone(c.pid, 3000); }
    report.cleanup.push({ pid: c.pid, gone, killed });
  }
  report.cleanupProven = report.cleanup.every(x => x.gone === true || x.gone === null);
}
report.relayLogTail = logs.relay.slice(-40);
report.publisherLogTail = logs.publisher.slice(-10);
report.errorCount = report.errors.length + report.consoleDropped;
report.control = control;
// The moved-start control passes ONLY if the click helper refused the misdirected click loudly (no Start was
// recorded as completed) and teardown was still proven; everything else is the positive verdict.
report.passed = control === 'moved-start'
  ? /click #probeGo: (landed on|layout not stable|expected exactly one new click)/.test(report.fatal ?? '') && !report.steps.some(s => s.name === 'strict refusal' || s.name === 'objects observed') && report.cleanupProven === true
  : report.completed === true && !report.fatal && report.errorCount === 0 && report.cleanupProven === true;
await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed ? 0 : 1);
