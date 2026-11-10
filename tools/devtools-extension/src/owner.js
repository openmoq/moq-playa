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
/** `granted`: whether the origin's host permission is known to be held (null until checked), so the panel can word the idle state truthfully. */
let outer = { stage: 'idle', detail: null, origin: null, pattern: null, missing: [], granted: null };
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
/**
 * Automatic attachment. An origin the user has ALREADY granted attaches on its own as soon as the panel is open,
 * once per inspected document (navigation, reload, same-origin replacement each count as a new document; the attempt
 * is given back only when the last view closes before it completes), and the single exposed source is selected without
 * a click (one automatic choice per discovery, never a per-source history). The first grant always comes from the panel's own Attach
 * click, because Chrome shows the permission prompt only on a user gesture. Detach turns automatic attachment OFF
 * for that origin for the rest of this DevTools document; the next manual Attach turns it back on. A failed
 * automatic attempt is not retried: the manual path stays available.
 */
let autoEpoch = -1;
const AUTO_LOAD_WAIT_MS = 250, AUTO_LOAD_WAIT_TRIES = 40;
const detachedOrigins = new Set();
/**
 * The one automatic source choice for the CURRENT discovery (a hello), as that hello's sequence number: a discovery gets
 * one automatic choice, a failed attach from it is not retried, and every fresh hello (manual re-arm, withdrawal
 * refresh, source replacement) is a new decision. One number, never a history.
 */
let autoChoiceHello = -1;
const AUTO_DETAIL_LOADING = 'attaching once the page has finished loading', AUTO_DETAIL_ATTACHING = 'attaching (origin already granted)';
/**
 * The one automatic preparatory operation (permission check, load wait), or null. It is reserved BEFORE its first
 * await (so overlapping triggers cannot start two), owns its timer, and is invalidated by a user Detach, the loss of
 * the last view, a navigation and the owner's destruction; every await re-checks it is still the current one.
 */
let autoOp = null;
/** Count of page-lane hello frames: a withdrawal decides only on a hello that arrived AFTER its rediscover. */
let helloSeq = 0;
/** One coalesced rediscover per withdrawal; `decided` once the fresh hello has been judged (no retry loop). */
let withdrawal = null;
function cancelAutoOp(releaseReservation, only = null) {
  // `only`: cancel just THAT operation; a late failure of a superseded operation must never touch its successor.
  if (!autoOp || (only !== null && autoOp !== only)) return;
  const op = autoOp; autoOp = null;
  if (op.timer) clearTimeout(op.timer);
  if (releaseReservation && autoEpoch === op.epoch) autoEpoch = -1;
  clearAutoDetail();
  publish();
}
/** A detail the automatic operation wrote describes nothing once that operation is gone. */
function clearAutoDetail() { if (outer.detail === AUTO_DETAIL_LOADING || outer.detail === AUTO_DETAIL_ATTACHING) outer = { ...outer, detail: null }; }
function autoCurrent(op) {
  return autoOp === op && op.epoch === originEpoch && !destroyed && !attempt && !tabPort && views.size > 0
    && outer.stage === 'ready' && outer.origin === op.origin && !detachedOrigins.has(op.origin);
}
async function maybeAutoAttach() {
  if (autoOp || destroyed || attempt || tabPort || views.size === 0) return;
  if (outer.stage !== 'ready' || !outer.origin || !outer.pattern) return;
  if (detachedOrigins.has(outer.origin) || autoEpoch === originEpoch) return;
  const op = { epoch: originEpoch, origin: outer.origin, pattern: outer.pattern, timer: null };
  autoOp = op; autoEpoch = op.epoch; publish();   // this document's one automatic attempt is reserved from here
  const drop = () => { if (autoOp === op) { autoOp = null; clearAutoDetail(); publish(); } };
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: [op.pattern] }); } catch { cancelAutoOp(true, op); return; }
  if (!autoCurrent(op)) { drop(); return; }
  if (!granted) { setOuter({ granted: false }); cancelAutoOp(true, op); return; }   // nothing consumed: the prompt needs the user's click
  setOuter({ granted: true });
  // The page's bridge installs with the page's own scripts; injecting while the document is still loading would
  // discover nothing and spend the one automatic attempt. Wait (bounded) until the tab reports it has finished loading.
  for (let i = 0; i < AUTO_LOAD_WAIT_TRIES; i++) {
    let status = null;
    try { status = (await chrome.tabs.get(tabId))?.status ?? null; } catch { drop(); return; }
    if (!autoCurrent(op)) { drop(); return; }
    if (status !== 'loading') break;
    if (i === 0) setOuter({ detail: AUTO_DETAIL_LOADING });
    await new Promise(r => { op.timer = setTimeout(() => { op.timer = null; r(); }, AUTO_LOAD_WAIT_MS); });
    if (!autoCurrent(op)) { drop(); return; }
  }
  // Hand over to the attach itself, which stays an AUTOMATIC attempt: it is cancelled like the preparation was
  // (last view gone, user Detach, navigation) until the relay answers and the carrier owns the connection.
  autoOp = null;
  outer = { ...outer, detail: AUTO_DETAIL_ATTACHING };
  await attach(op.origin, true);
}
function autoSelect(source) {
  if (!core || autoChoiceHello === helloSeq) return false;   // this discovery already had its one automatic choice
  autoChoiceHello = helloSeq;
  return core.attach(source.sourceId, source.runId);
}
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
  // `detached`: the user pressed Detach on this origin; automatic attachment is off for it until a manual Attach.
  const payload = { kind: 'host', ownerId, tabId, panelVisible, outer: { ...outer, detached: outer.origin !== null && detachedOrigins.has(outer.origin), auto: autoOp !== null || attempt?.automatic === true }, core: core ? core.state : null, probe: probeOwner ? probeOwner.state : null, probeLastError };
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
function dropView(port) { views.delete(port); try { port.disconnect(); } catch { /* already gone */ } viewsChanged(); }
/** Nobody is watching: automatic work (preparation or attempt) stops; manual attempts and an established carrier continue. */
function viewsChanged() {
  if (views.size !== 0) return;
  cancelAutoOp(true);
  // View loss is not a failure: the document's automatic attempt is given back, so the next view that opens starts it
  // afresh. A failed attempt stays spent (no automatic loop) and a user Detach stays sticky.
  if (attempt?.automatic) { cancelAttempt('the panel went away'); autoEpoch = -1; }
}

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
  // A navigation's transitional detail does not describe the settled new document; the grant is re-checked per origin.
  const detail = settled === 'ready' && outer.detail === 'the page navigated' ? null : outer.detail;
  setOuter({ stage: settled, origin, pattern: `${origin}/*`, missing: [], detail, granted: origin === outer.origin ? outer.granted : null });
  void maybeAutoAttach();
  return origin;
}

// ── Attach flow: one attempt, immutable intent, cancellation identity ───────
function cancelAttempt(why) {
  if (!attempt) return;
  const a = attempt; attempt = null;
  a.cancelled = why;
  // A port the attempt opened but the relay has not yet answered on belongs to the attempt: close it with the attempt,
  // so a late relay-ready cannot bootstrap a carrier nobody asked for. (A ready carrier has no attempt any more.)
  if (a.port) { if (tabPort === a.port) { tabPort = null; relayReady = false; } try { a.port.disconnect(); } catch { /* already gone */ } }
  // The panel must not stay "Attaching…" for an attempt that can no longer complete.
  if (outer.stage === 'injecting' || outer.stage === 'connecting') setOuter({ stage: 'ready', detail: why });
  else if (a.automatic) { clearAutoDetail(); setOuter({ detail: why }); }
}
/** True when this attempt may still act; otherwise it must stop without touching state. */
function current(a) { return attempt === a && !a.cancelled && !destroyed; }

/**
 * @param requestedOrigin the origin the panel showed and requested permission for; it must equal the
 *   origin this owner currently believes it is inspecting, or nothing happens.
 */
async function attach(requestedOrigin, automatic = false) {
  if (attempt) { setOuter({ detail: 'an attach attempt is already in progress' }); return; }
  if (tabPort && relayReady) { rebootstrap(); return; }
  const a = { id: ++attemptSerial, origin: null, pattern: null, cancelled: null, port: null, automatic };
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
  if (!granted) { attempt = null; setOuter({ stage: 'needs-permission', detail: `grant access to ${origin} to attach`, granted: false }); return; }
  setOuter({ granted: true });
  // The ACTUAL current top URL must still have the granted origin before anything is injected.
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (e) { if (current(a)) { attempt = null; setOuter({ stage: 'origin-unverified', detail: `tabs.get failed: ${e?.message ?? e}` }); } return; }
  if (!current(a)) return;
  let actual = null;
  try { actual = tab?.url ? new URL(tab.url).origin : null; } catch { actual = null; }
  if (actual === null) { attempt = null; setOuter({ stage: 'origin-unverified', detail: 'the tab URL is not readable even after the grant; attach refused' }); return; }
  if (actual !== a.origin) { attempt = null; setOuter({ stage: 'origin-mismatch', detail: `the page is now ${actual}; discovery restarted`, origin: null, pattern: null }); void refreshOrigin(); return; }
  setOuter({ stage: 'injecting', detail: null });
  if (!current(a)) return;   // publishing may have dropped the last view and, for an automatic attempt, cancelled it
  let documentId;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['relay.js'] });
    documentId = results?.[0]?.documentId;
  } catch (e) { if (current(a)) { attempt = null; setOuter({ stage: 'not-attached', detail: `injection refused: ${e?.message ?? e}` }); } return; }
  // A navigation, disconnect or destruction during the injection invalidates this attempt entirely.
  if (!current(a)) return;
  setOuter({ stage: 'connecting' });
  if (!current(a)) return;
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
  } else if (s.phase === 'discovered' && core && s.sources.length === 1 && outer.origin && !detachedOrigins.has(outer.origin)) {
    // Exactly one exposed source and nothing attached: select it (once per source run). Several sources still ask.
    autoSelect(s.sources[0]);
  }
  if (s.phase === 'withdrawn' && core && tabPort === port) {
    // The hello list in hand is the OLD one (it still names the withdrawn source). Ask the page once for a fresh
    // list; choose only from the hello that answers, and only when exactly one source remains. A repeated notice,
    // an empty fresh hello or a failed refresh never asks again: the pick list stays for the user.
    if (!withdrawal) { withdrawal = { helloSeq, decided: false }; core.rediscover(); }
    else if (!withdrawal.decided && helloSeq > withdrawal.helloSeq) {
      withdrawal.decided = true;
      if (s.sources.length === 1 && outer.origin && !detachedOrigins.has(outer.origin)) autoSelect(s.sources[0]);
    }
  } else if (s.phase !== 'withdrawn') withdrawal = null;
  publish();
}
function forwardFrame(encoded, lane) {
  // Classify by the decoded discriminant, never by a substring of the serialized text.
  const decoded = decodeMessage(encoded);
  if (lane === 'page' && decoded.ok && decoded.message.kind === 'hello') { lastHello = encoded; helloSeq++; }
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
  port.onDisconnect.addListener(() => { views.delete(port); viewsChanged(); });   // no view: no automatic start; the next view may begin one
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
      // A manual Attach/Reconnect is an explicit re-arm: it lifts a Detach for that origin, lets the single source be
      // selected again, and supersedes any automatic preparation (the document's one automatic attempt stays spent).
      case 'attach': if (typeof m.origin === 'string') detachedOrigins.delete(m.origin); autoChoiceHello = -1; cancelAutoOp(false); void attach(m.origin); break;
      case 'reconnect': if (typeof m.origin === 'string') detachedOrigins.delete(m.origin); autoChoiceHello = -1; cancelAutoOp(false); if (tabPort && relayReady) rebootstrap(); else void attach(m.origin); break;
      case 'disconnect': if (outer.origin) detachedOrigins.add(outer.origin); cancelAutoOp(false); disconnect('detached by the user'); break;
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
  void maybeAutoAttach();   // a panel that opens on an already granted origin attaches by itself
});

chrome.devtools.network.onNavigated.addListener(() => {
  // A navigation (also a same-origin replacement) ends the inspected document: no pending attempt, in-flight
  // origin read, receipt or attachment may apply to its successor.
  originEpoch++; autoChoiceHello = -1; withdrawal = null; cancelAutoOp(true);
  cancelAttempt('the page navigated');
  disconnect('the page navigated');
  void refreshOrigin();
});
window.addEventListener('pagehide', () => { destroyed = true; cancelAutoOp(false); cancelAttempt('DevTools closed'); disconnect('DevTools closed'); void probeOwner?.destroy(); });

chrome.devtools.panels.create('Playa', '', `panel.html?owner=${ownerId}&tab=${tabId}`, panel => {
  // Chrome keeps the iframe document visible even when another DevTools tab is selected. Carry the panel's
  // actual lifecycle over the existing bounded host-state lane; capture, credit and recording are unchanged.
  panel.onShown.addListener(() => { panelVisible = true; publish(); });
  panel.onHidden.addListener(() => { panelVisible = false; publish(); });
});
// Read-only identity for the browser gates; not an API.
globalThis.__playaOwner = { ownerId, tabId };
void refreshOrigin();
