// The DevTools PAGE: one incarnation per DevTools window, and the OWNER of
// anything this extension does on behalf of that window. A fresh owner id is
// minted on every load, so a reopened DevTools window on the same tab is a
// different owner and stale commands cannot reach it. The tab id is kept for
// routing but never stands in for the owner.
//
// This document runs the attach flow as ONE attempt at a time with immutable
// intent (the origin the user saw and granted), re-checked after every await
// and invalidated by navigation, user disconnect or owner destruction. It owns
// the relay Port and the carrier credit loop (HostCore), and serves the panel
// as a VIEW over a runtime port named for this owner, authenticated by sender
// identity and bounded per view. Every chrome.* call is guarded; a browser that
// does not expose an API to DevTools shows an explicit unsupported state. The
// only page read is one constant `location.origin` expression, treated as
// untrusted text and shown to the user before any permission is requested.
import { decodeMessage } from '@openmoq/devtools-protocol';
import { HostCore } from './host-core.js';
import { createProbeOwner } from './probe-owner.js';

const RELAY_CHANNEL = 'playa-carrier';
const MAX_VIEWS = 4;
/**
 * View hop policy (documented, finite): every message to a view is acknowledged by the view, per
 * category — `{kind:'ack', frames:n}`, `{kind:'ack', host:true}`, `{kind:'ack', stalled:true}` — and
 * no acknowledgement of one category releases another. A view may hold at most VIEW_FRAME_BUDGET
 * unacknowledged frames, at most ONE unacknowledged host-state message (newer states coalesce into the
 * latest and are sent when that one is acknowledged) and one unacknowledged `stalled` notice. So a view
 * that never acknowledges receives at most VIEW_FRAME_BUDGET + 2 messages in total, however many polls
 * or state changes happen. Page credit never waits on a view; a stalled view recovers — once its frames
 * are all acknowledged AND the notice itself is — with a whole-source refresh whose snapshot is its
 * baseline, and the adapter's gap detection covers the rest.
 */
const VIEW_FRAME_BUDGET = 64;
const ownerId = crypto.randomUUID();
const tabId = chrome.devtools.inspectedWindow.tabId;

/** view port → { frames, hostUnacked, pendingHost, stalled, stalledUnacked, exportUnacked, pendingExport } */
const views = new Map();
/** Everything before the carrier exists: capability, origin, permission, injection, connection. */
let outer = { stage: 'idle', detail: null, origin: null, pattern: null, missing: [] };
let core = null;
let tabPort = null;
let relayReady = false;
/** The one in-progress attach attempt, or null. */
let attempt = null;
let attemptSerial = 0;
/** Monotonic across relay ports: an old channel's packets can never name a later generation. */
let lastGeneration = 0;
/** The last hello frame, replayed to a view that connects while the carrier is up. */
let lastHello = null;
/** One pending source switch (detach, then attach after the ack). */
let pendingSwitch = null;
let destroyed = false;
let panelVisible = false;
/** The owner-local Probe (its own transport, registry and carrier loop); created on the first Start. */
let probeOwner = null;
let probeLastError = null;
function probe() {
  probeOwner ??= createProbeOwner({ ownerId, now: () => performance.now(), publish: () => publish(),
    frame: encoded => forwardFrame(encoded, 'probe'),
    schedule: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); } });
  return probeOwner;
}
/** Bumped on every navigation: an origin read started before it may not write anything. */
let originEpoch = 0;

function setOuter(patch) { outer = { ...outer, ...patch }; publish(); }
function publish() {
  const payload = { kind: 'host', ownerId, tabId, panelVisible, outer, core: core ? core.state : null, probe: probeOwner ? probeOwner.state : null, probeLastError };
  for (const [port, v] of views) sendHost(port, v, payload);
}
function sendExport(port, v, payload) {
  if (v.exportUnacked) { v.pendingExport = payload; return; }
  v.exportUnacked = true;
  post(port, payload);
}
function sendHost(port, v, payload) {
  if (v.hostUnacked) { v.pendingHost = payload; return; }   // coalesce: the view sees the newest state next
  v.hostUnacked = true;
  post(port, payload);
}
function post(port, message) {
  try { port.postMessage(message); } catch { dropView(port); }
}
function dropView(port) { views.delete(port); try { port.disconnect(); } catch { /* already gone */ } }

// ── Capability and origin ───────────────────────────────────────────────────
function missingApis() {
  const need = [
    ['tabs.get', chrome.tabs?.get], ['tabs.connect', chrome.tabs?.connect],
    ['scripting.executeScript', chrome.scripting?.executeScript],
    ['permissions.contains', chrome.permissions?.contains],
    ['devtools.inspectedWindow.eval', chrome.devtools?.inspectedWindow?.eval],
  ];
  return need.filter(([, fn]) => typeof fn !== 'function').map(([name]) => name);
}
/** One compile-time constant read; the result is untrusted text, a UX hint, not authority. */
function discoverOrigin() {
  return new Promise(resolve => {
    try {
      chrome.devtools.inspectedWindow.eval('location.origin', (result, exception) => {
        if (exception || typeof result !== 'string' || result.length > 2048) return resolve(null);
        if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+(?::\d{1,5})?$/.test(result)) return resolve(null);
        try { if (new URL(result).origin !== result) return resolve(null); } catch { return resolve(null); }
        resolve(result);
      });
    } catch { resolve(null); }
  });
}
async function refreshOrigin(retries = 5) {
  const missing = missingApis();
  if (missing.length) { setOuter({ stage: 'unsupported', missing, detail: `this browser does not expose ${missing.join(', ')} to DevTools` }); return null; }
  const epoch = originEpoch;
  let origin = await discoverOrigin();
  if (epoch !== originEpoch || destroyed) return null;     // a navigation happened: this read is about an older document
  // During a navigation the document may not be there yet; a few bounded retries, then give up visibly.
  for (let i = 0; origin === null && i < retries && !destroyed; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (epoch !== originEpoch) return null;
    origin = await discoverOrigin();
    if (epoch !== originEpoch) return null;
  }
  if (destroyed) return null;
  if (origin === null) { setOuter({ stage: 'unsupported-origin', origin: null, pattern: null, detail: 'the inspected document has no canonical http(s) origin' }); return null; }
  const settled = ['idle', 'unsupported', 'unsupported-origin', 'origin-mismatch'].includes(outer.stage) ? 'ready' : outer.stage;
  setOuter({ stage: settled, origin, pattern: `${origin}/*`, missing: [] });
  return origin;
}

// ── Attach flow: one attempt, immutable intent, cancellation identity ───────
function cancelAttempt(why) {
  if (!attempt) return;
  const a = attempt; attempt = null;
  a.cancelled = why;
  if (a.port && tabPort !== a.port) { try { a.port.disconnect(); } catch { /* already gone */ } }
  // The panel must not stay "Attaching…" for an attempt that can no longer complete.
  if (outer.stage === 'injecting' || outer.stage === 'connecting') setOuter({ stage: 'ready', detail: why });
}
/** True when this attempt may still act; otherwise it must stop without touching state. */
function current(a) { return attempt === a && !a.cancelled && !destroyed; }

/**
 * @param requestedOrigin the origin the panel showed and requested permission for; it must equal the
 *   origin this owner currently believes it is inspecting, or nothing happens.
 */
async function attach(requestedOrigin) {
  if (attempt) { setOuter({ detail: 'an attach attempt is already in progress' }); return; }
  if (tabPort && relayReady) { rebootstrap(); return; }
  const a = { id: ++attemptSerial, origin: null, pattern: null, cancelled: null, port: null };
  attempt = a;
  const origin = await refreshOrigin();
  if (!current(a)) return;
  if (origin === null) { attempt = null; return; }
  if (typeof requestedOrigin !== 'string' || requestedOrigin !== origin) {
    attempt = null;
    setOuter({ stage: 'origin-mismatch', detail: `the page is ${origin}, not the ${requestedOrigin ?? 'unknown'} origin that was requested; attach again` });
    return;
  }
  a.origin = origin; a.pattern = `${origin}/*`;
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: [a.pattern] }); }
  catch (e) { if (current(a)) { attempt = null; setOuter({ stage: 'unsupported', detail: `permissions.contains failed: ${e?.message ?? e}` }); } return; }
  if (!current(a)) return;
  if (!granted) { attempt = null; setOuter({ stage: 'needs-permission', detail: `grant access to ${origin} to attach` }); return; }
  // The ACTUAL current top URL must still have the granted origin before anything is injected.
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (e) { if (current(a)) { attempt = null; setOuter({ stage: 'origin-unverified', detail: `tabs.get failed: ${e?.message ?? e}` }); } return; }
  if (!current(a)) return;
  let actual = null;
  try { actual = tab?.url ? new URL(tab.url).origin : null; } catch { actual = null; }
  if (actual === null) { attempt = null; setOuter({ stage: 'origin-unverified', detail: 'the tab URL is not readable even after the grant; attach refused' }); return; }
  if (actual !== a.origin) { attempt = null; setOuter({ stage: 'origin-mismatch', detail: `the page is now ${actual}; discovery restarted`, origin: null, pattern: null }); void refreshOrigin(); return; }
  setOuter({ stage: 'injecting', detail: null });
  let documentId;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['relay.js'] });
    documentId = results?.[0]?.documentId;
  } catch (e) { if (current(a)) { attempt = null; setOuter({ stage: 'not-attached', detail: `injection refused: ${e?.message ?? e}` }); } return; }
  // A navigation, disconnect or destruction during the injection invalidates this attempt entirely.
  if (!current(a)) return;
  setOuter({ stage: 'connecting' });
  relayReady = false;
  let port;
  try { port = chrome.tabs.connect(tabId, documentId ? { documentId, name: RELAY_CHANNEL } : { frameId: 0, name: RELAY_CHANNEL }); }
  catch (e) { attempt = null; setOuter({ stage: 'not-attached', detail: `tabs.connect failed: ${e?.message ?? e}` }); return; }
  a.port = port;
  port.onMessage.addListener(m => onRelay(port, a, m));
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message ?? null;
    if (tabPort !== port) { if (attempt === a) attempt = null; return; }
    tabPort = null;
    if (!relayReady) { attempt = null; setOuter({ stage: 'not-attached', detail: why ? `no relay in the page (${why})` : 'relay port closed before it answered' }); return; }
    if (core) core.lost(why ? `relay port disconnected (${why})` : 'relay port disconnected');
    setOuter({ stage: 'carrier-lost', detail: 'the page or its relay went away without a terminal packet' });
  });
  tabPort = port;
}

function onRelay(port, a, m) {
  if (tabPort !== port || !m || typeof m !== 'object') return;
  if (m.t === 'relay-ready') {
    if (!current(a)) { tabPort = null; try { port.disconnect(); } catch { /* already gone */ } return; }
    attempt = null;                       // the attempt succeeded; from here the carrier owns the channel
    relayReady = true;
    rebootstrap(a.origin);
    return;
  }
  if (!core) return;
  if (m.t === 'packet') { core.receive(m.data, m.g); return; }
  if (m.t === 'refused') {
    if (m.g === core.state.generation) { core.lost(`relay refused: ${m.why}`); setOuter({ stage: 'carrier-lost', detail: `relay refused the bootstrap: ${m.why}` }); }
    return;
  }
  // 'ended' follows a terminal packet the core already saw.
}

/** A new channel generation over the existing relay port, bound to the origin that attempt was granted for. */
function rebootstrap(origin = outer.origin) {
  if (!tabPort || !relayReady || destroyed) return;
  if (core) { const c = core.close(); if (c) sendPacket(c, core.state.generation); }
  lastHello = null; pendingSwitch = null;
  const port = tabPort;
  core = new HostCore({
    send: p => sendPacket(p, core.state.generation),
    frame: encoded => forwardFrame(encoded, 'page'),
    state: s => onCoreState(s, port),
    schedule: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
    // A completed export goes to the views as its own bounded category (one unacknowledged at a time,
    // a newer one replaces an unread one). The token never travels: HostCore does not expose it.
    exported: result => { for (const [p, v] of views) sendExport(p, v, { kind: 'export', ...result }); },
  }, { ownerId, generation: lastGeneration });
  const discover = core.bootstrap();
  lastGeneration = core.state.generation;
  setOuter({ stage: 'carrier', detail: null });
  try { tabPort.postMessage({ t: 'bootstrap', g: core.state.generation, discover, origin }); }
  catch (e) { core.lost(`relay port failed: ${e?.message ?? e}`); }
}
function sendPacket(data, g) {
  if (!tabPort) return;
  try { tabPort.postMessage({ t: 'packet', g, data }); } catch (e) { core?.lost(`relay port failed: ${e?.message ?? e}`); }
}
function onCoreState(s, port) {
  if (s.phase === 'lost' && tabPort === port) {
    // The owner gave up or the relay went away: relinquish the port so nothing lingers.
    tabPort = null; relayReady = false;
    try { port.disconnect(); } catch { /* already gone */ }
    if (outer.stage === 'carrier') setOuter({ stage: 'carrier-lost', detail: s.reason });
  }
  if (s.phase === 'discovered' && pendingSwitch && core) {
    const sw = pendingSwitch; pendingSwitch = null;
    core.attach(sw.sourceId, sw.runId);
  }
  publish();
}
function forwardFrame(encoded, lane) {
  // Classify by the decoded discriminant, never by a substring of the serialized text.
  const decoded = decodeMessage(encoded);
  if (lane === 'page' && decoded.ok && decoded.message.kind === 'hello') lastHello = encoded;
  for (const [port, v] of views) {
    if (v.stalled) continue;
    if (v.frames >= VIEW_FRAME_BUDGET) {
      // A view that stopped consuming must not grow a queue; it is told once and resyncs when it recovers.
      v.stalled = true; v.stalledUnacked = true; post(port, { kind: 'stalled' }); continue;
    }
    v.frames++;
    post(port, { kind: 'frame', encoded, lane });
  }
}
function disconnect(detail) {
  cancelAttempt(detail);
  if (core) { const c = core.close(); if (c) sendPacket(c, core.state.generation); }
  const port = tabPort; tabPort = null; relayReady = false;
  try { port?.disconnect(); } catch { /* already gone */ }
  lastHello = null; pendingSwitch = null;
  if (!destroyed) setOuter({ stage: outer.stage.startsWith('unsupported') ? outer.stage : 'ready', detail: detail ?? null });
}

// ── Views ───────────────────────────────────────────────────────────────────
function legitimateView(port) {
  const s = port.sender;
  if (!s || s.tab || typeof chrome.runtime.id !== 'string' || s.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(s.url ?? '');
    return url.protocol === 'chrome-extension:' && url.host === chrome.runtime.id && url.pathname === '/panel.html'
      && url.searchParams.get('owner') === ownerId;
  } catch { return false; }
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== `view:${ownerId}`) return;
  if (!legitimateView(port) || views.size >= MAX_VIEWS) { try { port.disconnect(); } catch { /* already gone */ } return; }
  const v = { frames: 0, hostUnacked: false, pendingHost: null, stalled: false, stalledUnacked: false, exportUnacked: false, pendingExport: null };
  views.set(port, v);
  port.onDisconnect.addListener(() => views.delete(port));
  port.onMessage.addListener(m => {
    if (!m || typeof m !== 'object' || destroyed) return;
    switch (m.kind) {
      case 'ack': {                    // the view consumed messages; release credit per category, never across them
        const frames = Number.isInteger(m.frames) && m.frames > 0 ? m.frames : 0;
        v.frames = Math.max(0, v.frames - frames);
        if (m.host === true) {
          v.hostUnacked = false;
          if (v.pendingHost) { const next = v.pendingHost; v.pendingHost = null; sendHost(port, v, next); }
        }
        if (m.stalled === true) v.stalledUnacked = false;
        if (m.export === true) {
          v.exportUnacked = false;
          if (v.pendingExport) { const next = v.pendingExport; v.pendingExport = null; sendExport(port, v, next); }
        }
        // A stalled view that consumed all its frames AND the notice gets a fresh baseline on EVERY active lane.
        if (v.stalled && !v.stalledUnacked && v.frames === 0) { v.stalled = false; core?.refresh(); probeOwner?.refresh(); }
        break;
      }
      case 'attach': void attach(m.origin); break;
      case 'reconnect': if (tabPort && relayReady) rebootstrap(); else void attach(m.origin); break;
      case 'disconnect': disconnect('detached by the user'); break;
      case 'select': core?.attach(String(m.sourceId), String(m.runId)); break;
      case 'switch':
        if (!core) break;
        if (core.state.target === null) core.attach(String(m.sourceId), String(m.runId));
        else if (core.detach()) pendingSwitch = { sourceId: String(m.sourceId), runId: String(m.runId) };
        break;
      case 'refresh':                  // lane-scoped; whole-source refreshes coalesce in each lane's HostCore
        if (m.lane === 'probe') probeOwner?.refresh(); else core?.refresh(m.scope ?? undefined);
        break;
      case 'detach': core?.detach(); break;
      case 'rediscover': core?.rediscover(); break;
      case 'record.start': core?.recordStart(); break;
      case 'record.stop': core?.recordStop(); break;
      case 'record.export': core?.recordExport(); break;
      // Probe: owner-local, explicit, never through the page. Invalid configs are refused by the runner.
      case 'probe.start':
        probeLastError = null;
        try { probe().start(m.config ?? {}); } catch (e) { probeLastError = String(e?.message ?? e).slice(0, 300); publish(); }
        break;
      case 'probe.stop': void probe().stop('stopped by the user'); break;
      case 'origin': void refreshOrigin(); break;
    }
  });
  // A view that joins while the carrier is up gets the current picture: the last hello now, and
  // a whole-source refresh whose snapshot is its baseline (no new lease, same cursor order).
  publish();
  if (core && lastHello) { v.frames++; post(port, { kind: 'frame', encoded: lastHello, lane: 'page' }); }
  if (core?.state.target) core.refresh();
  probeOwner?.resync();
});

chrome.devtools.network.onNavigated.addListener(() => {
  // A navigation (also a same-origin replacement) ends the inspected document: no pending attempt, in-flight
  // origin read, receipt or attachment may apply to its successor.
  originEpoch++;
  cancelAttempt('the page navigated');
  disconnect('the page navigated');
  void refreshOrigin();
});
window.addEventListener('pagehide', () => { destroyed = true; cancelAttempt('DevTools closed'); disconnect('DevTools closed'); void probeOwner?.destroy(); });

chrome.devtools.panels.create('Playa', '', `panel.html?owner=${ownerId}&tab=${tabId}`, panel => {
  // Chrome keeps the iframe document visible even when another DevTools tab is selected. Carry the panel's
  // actual lifecycle over the existing bounded host-state lane; capture, credit and recording are unchanged.
  panel.onShown.addListener(() => { panelVisible = true; publish(); });
  panel.onHidden.addListener(() => { panelVisible = false; publish(); });
});
// Read-only identity for the browser gates; not an API.
globalThis.__playaOwner = { ownerId, tabId };
void refreshOrigin();
