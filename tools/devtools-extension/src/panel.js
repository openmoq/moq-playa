// The panel is a VIEW. It paints a ViewModel from a Source and sends the
// user's panel-local actions back to it. It holds no transport, no player
// reference and no protocol state; Pause freezes this view only.
import { decodeMessage } from '@openmoq/devtools-protocol';
import { MockSource } from './mock-source.js';
import { ProtocolSource } from './adapter.js';
import { parseProbeFields } from './probe-fields.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const params = new URLSearchParams(location.search);
// Owner identity minted by the DevTools page for this window; the panel only
// displays and forwards it, never derives it from the tab.
const owner = { id: params.get('owner'), tab: params.get('tab') };

// Declared before the sources: a source may emit synchronously on construction.
const rowNodes = [];
let vm = null;
// Attach and Probe are two LANES, each with its own adapter: a page source and an owner-local probe
// never share state. The mode is panel-local view state. The mock is an explicit preview
// (`?source=mock`) for layout work, and it says so on screen.
const mockPreview = params.get('source') === 'mock';
let mode = 'attach';
const vms = { page: null, probe: null };
const activeLane = () => (mode === 'probe' && lanes.probe ? 'probe' : 'page');
const makeLane = lane => new ProtocolSource(next => { vms[lane] = next; if (activeLane() === lane) { vm = next; render(); } });
const lanes = mockPreview
  ? { page: new MockSource(next => { vms.page = next; vm = next; render(); }), probe: null }
  : { page: makeLane('page'), probe: makeLane('probe') };
const active = () => lanes[activeLane()];
const source = lanes.page;   // the page lane remains the `source` for the preview and the gates

// Panel-local actions.
function setMode(next) {
  mode = next === 'probe' ? 'probe' : 'attach';
  if (mockPreview) { lanes.page.setMode(mode); return; }
  vm = vms[activeLane()]; if (vm) render();
}
$('btnAttach').onclick = () => setMode('attach');
$('btnProbe').onclick = () => setMode('probe');
$('btnPause').onclick = () => { if (vm?.actions.pause) active().togglePause(); };
// Record and Detach are host actions. A source that cannot honour them
// leaves the buttons disabled rather than pretending.
// Record is a HOST action: the owner holds the recording and its token; the panel only sees
// token-free state. Start → (recording) Stop → Save, which exports and downloads the trace.
$('btnRec').onclick = () => {
  const ui = recordLabel();
  if (!viewPort || !ui.action) return;
  viewPort.postMessage({ kind: ui.action });
};
function recordLabel() {
  const rec = host?.core?.recording ?? null;             // this owner's, token-free
  const fact = vm?.recording ?? { active: false, owner: null };
  if (!viewPort || host?.core?.phase !== 'attached') return { text: 'Record .moqtrace', enabled: false, action: null, dot: false };
  // A source that does not advertise `recording` is never offered the action (the registry would refuse anyway).
  if (!vm?.canRecord && !rec) return { text: 'Record .moqtrace', enabled: false, action: null, dot: false, why: 'this source does not declare the recording capability' };
  if (rec?.exporting) return { text: `Exporting · ${rec.exporting.chunks} chunk${rec.exporting.chunks === 1 ? '' : 's'} · ${Math.round(rec.exporting.bytes / 1024)} KiB`, enabled: false, action: null, dot: false };
  // Someone else's active recording blocks a start (one active recording per source); our stopped one stays exportable afterwards.
  if (fact.active && fact.owner === 'other') return { text: 'Recording (another owner)', enabled: false, action: null, dot: true };
  if (rec && fact.active && fact.owner === 'me') return { text: 'Recording', enabled: true, action: 'record.stop', dot: true };
  if (rec && !fact.active) return { text: 'Save .moqtrace', enabled: true, action: 'record.export', dot: false };
  if (rec) return { text: 'Recording', enabled: true, action: 'record.stop', dot: true };   // started; the fact has not arrived yet
  return { text: 'Record .moqtrace', enabled: true, action: 'record.start', dot: false };
}
function download(result) {
  // The reassembled trace text, UTF-8; surrogate pairs were joined before encoding.
  const blob = new Blob([new TextEncoder().encode(result.text)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = `playa-${result.recordingId}.moqtrace`; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  lastExport = { recordingId: result.recordingId, exportId: result.exportId, bytes: result.bytes, filename: a.download, head: result.text.slice(0, 160) };
}
let lastExport = null;
// Attach/Detach are HOST actions: they go to the DevTools-document owner over
// the view port. The permission request itself must run inside this click (a
// real user gesture); the owner then verifies the origin and injects.
let denied = null;   // the origin whose grant the user declined, for the host line
$('btnDev').onclick = () => {
  if (!viewPort) return;
  const ui = hostLabel();                 // label and action come from the same state rule
  if (!ui.enabled || !ui.action) return;
  if (ui.action === 'disconnect') { viewPort.postMessage({ kind: 'disconnect' }); return; }
  if (ui.action === 'reconnect') { viewPort.postMessage({ kind: 'reconnect', origin: host?.outer?.origin ?? null }); return; }
  // 'attach': the grant is requested for exactly the origin shown; a denial or failure never sends Attach.
  const origin = host?.outer?.origin ?? null, pattern = host?.outer?.pattern ?? null;
  if (!origin || !pattern) return;
  denied = null;
  const request = chrome?.permissions?.request ? chrome.permissions.request({ origins: [pattern] }) : Promise.resolve(false);
  request.then(granted => {
    if (granted === true) viewPort?.postMessage({ kind: 'attach', origin });
    else { denied = origin; render(); }
  }, () => { denied = origin; render(); });
};

// View port to this window's owner. Absent in the `?source=mock` preview and
// outside DevTools; the panel then shows what it can and disables host actions.
let host = null;
let viewPort = null;
let stalled = false;   // the owner stopped forwarding frames to this view until it caught up
let ownerLost = false; // this view had an owner port and lost it
try {
  if (owner.id && globalThis.chrome?.runtime?.connect && params.get('source') !== 'mock') {
    viewPort = chrome.runtime.connect({ name: `view:${owner.id}` });
    viewPort.onMessage.addListener(m => {
      if (!m || typeof m !== 'object') return;
      // Every owner message is acknowledged so the owner can bound what it sends to this view.
      if (m.kind === 'host') { host = m; viewPort?.postMessage({ kind: 'ack', host: true }); if (vm) render(); }
      else if (m.kind === 'frame') { window.__playaPanel.applyEncoded(m.encoded, m.lane ?? 'page'); viewPort?.postMessage({ kind: 'ack', frames: 1 }); }
      else if (m.kind === 'stalled') { stalled = true; viewPort?.postMessage({ kind: 'ack', stalled: true }); if (vm) render(); }
      else if (m.kind === 'export') { download(m); viewPort?.postMessage({ kind: 'ack', export: true }); if (vm) render(); }
    });
    // Losing the owner is NOT the mock preview: retained rows stay, the live indicator does not.
    viewPort.onDisconnect.addListener(() => { viewPort = null; host = null; ownerLost = true; if (vm) render(); });
  }
} catch { viewPort = null; }

// ONE rule yields the button text, whether it is enabled, the action it performs and the host line.
const ATTACH = { text: 'Attach to page', enabled: true, action: 'attach' };
const DETACH = { text: 'Detach', enabled: true, action: 'disconnect' };
const RECONNECT = { text: 'Reconnect', enabled: true, action: 'reconnect' };
const BUSY = { text: 'Attaching…', enabled: false, action: null };
function hostLabel() {
  if (!viewPort) {
    if (ownerLost) return { text: 'Owner lost', enabled: false, action: null, live: false, line: 'the DevTools owner for this view went away · showing the last observed data' };
    return { text: 'Exposure off', enabled: false, action: null, line: null, live: false };
  }
  const o = host?.outer ?? { stage: 'idle' }; const c = host?.core ?? null;
  const detail = o.detail ? ` · ${o.detail}` : '';
  const deniedLine = denied && denied === o.origin ? `not attached · access to ${denied} was not granted` : null;
  const historical = vm?.exposed ? ' · showing the last observed data' : '';
  switch (o.stage) {
    case 'idle': case 'ready': return { ...ATTACH, live: false, line: deniedLine ?? (o.origin ? `ready · attach asks for access to ${o.origin}${detail}${historical}` : null) };
    case 'unsupported': case 'unsupported-origin': return { text: 'Attach unavailable', enabled: false, action: null, live: false, line: `attach unavailable${detail}` };
    case 'needs-permission': return { ...ATTACH, live: false, line: `not attached · permission for ${o.origin} was not granted` };
    case 'origin-unverified': case 'origin-mismatch': case 'not-attached': return { ...ATTACH, live: false, line: `not attached${detail}${historical}` };
    case 'injecting': case 'connecting': return { ...BUSY, live: false, line: `${o.stage}…` };
    case 'carrier-lost': return { ...RECONNECT, live: false, line: `carrier lost${detail}${historical}` };
    case 'carrier': {
      if (!c) return { ...BUSY, live: false, line: 'carrier…' };
      const reason = c.reason ? ` · ${c.reason}` : '';
      const err = c.lastError ? ` · ${c.lastError.command} refused: ${c.lastError.code}` : '';
      switch (c.phase) {
        case 'bootstrapping': return { ...BUSY, live: false, line: 'discovering sources…' };
        case 'discovered': return { ...DETACH, live: false, line: `connected to the page · ${c.sources.length} source${c.sources.length === 1 ? '' : 's'} exposed · no lease${err}${historical}` };
        case 'attaching': return { ...DETACH, live: false, line: 'attaching to source…' };
        case 'attached': return { ...DETACH, live: true, line: `attached · ${c.target.sourceId} · ${c.target.attachmentId}${err}` };
        case 'withdrawn': return { ...DETACH, live: false, line: `source withdrawn by the page${reason} · pick another source${historical}` };
        case 'closed': return { ...RECONNECT, live: false, line: `carrier closed${reason}${historical}` };
        case 'lost': return { ...RECONNECT, live: false, line: `carrier lost${reason}${historical}` };
      }
    }
  }
  return { ...ATTACH, live: false, line: null };
}
// ── Probe strip: explicit Start/Stop of the owner-local probe; presets only on an explicit click ──
let probeInputError = null;
function probeConfig() {
  return { url: $('probeUrl').value.trim(), namespace: parseProbeFields($('probeNs').value), trackHints: parseProbeFields($('probeTracks').value),
    draft: Number($('probeDraft').value), policy: $('probePolicy').checked ? 'compatibility' : 'strict' };
}
const probeRunning = () => ['starting', 'ready', 'stopping'].includes(host?.probe?.status ?? '');
// A quarantined runner (the owner reports `blocked`: its stop rejected) offers no Start; the status line says why
// and how to recover. A settled stopped/failed run is retried at once as before.
const probeBlocked = () => !probeRunning() && !!host?.probe?.blocked;
$('probeGo').onclick = () => {
  if (!viewPort || mockPreview || probeBlocked()) return;
  probeInputError = null;
  if (probeRunning()) viewPort.postMessage({ kind: 'probe.stop' });
  else {
    let config;
    try { config = probeConfig(); }
    catch (error) { probeInputError = String(error?.message ?? error); render(); return; }
    viewPort.postMessage({ kind: 'probe.start', config });
  }
};
let presets = { status: null, items: [] };
$('probePresetsBtn').onclick = async () => {
  const box = $('probePresetsUrl'); box.classList.remove('hidden');
  let url = box.value.trim();
  if (!url) { try { url = new URL('/player/channels.json', $('probeUrl').value.trim()).href; box.value = url; } catch { presets = { status: 'enter a presets URL first', items: [] }; render(); return; } }
  presets = { status: `fetching ${url}…`, items: [] }; render();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json();
    const list = Array.isArray(body) ? body : [];
    presets = { status: `${list.length} presets from ${new URL(url).host} (fetched on your click)`,
      items: list.filter(x => x && typeof x.namespace === 'string').slice(0, 64).map(x => ({ name: String(x.name ?? x.id ?? x.namespace).slice(0, 80), namespace: x.namespace, label: x.label ? String(x.label).slice(0, 24) : '' })) };
  } catch (e) { presets = { status: `presets unavailable: ${String(e?.message ?? e).slice(0, 120)}`, items: [] }; }
  render();
};
function probeStatusLine() {
  const p = host?.probe ?? null;
  if (probeInputError) return `refused: ${probeInputError}`;
  if (host?.probeLastError) return `refused: ${host.probeLastError}`;
  if (!p) return 'not started';
  const scope = p.scope === 'tracks' ? `${p.config.trackHints.length} track${p.config.trackHints.length === 1 ? '' : 's'}` : 'session setup only — no objects are observed';
  const core = p.core ? ` · ${p.core.phase}${p.core.reason ? ' · ' + p.core.reason : ''}` : '';
  switch (p.status) {
    case 'starting': return `starting · draft ${p.config.draft} · ${p.config.policy} · ${scope}${core}`;
    case 'ready': return `ready · draft ${p.config.draft} · ${p.config.policy} · ${scope}${core}`;
    case 'stopping': return `stopping…${core}`;
    case 'stopped': return `stopped · ${p.failure ?? ''}${core}`;
    case 'failed': return `failed · ${p.failure ?? 'see the events column'}${core}${p.blocked ? ` · quarantined: ${p.blocked.message}` : ''}`;
  }
  return p.status;
}

// Rendering keeps DOM nodes for the grid and rebuilds only what changed in
// count; the cell set per row is bounded (ring of 8 groups × ≤60 objects).
function render() {
  // Keep applying and acknowledging observations while hidden; the next shown host state paints the latest VM.
  // Losing the owner must still clear the live indicator, since that port can no longer send a shown state.
  if (!mockPreview && host?.panelVisible === false) return;
  const probe = mockPreview ? vm.mode === 'probe' : mode === 'probe';
  const probeLive = probe && !mockPreview && host?.probe?.core?.phase === 'attached';
  const live = mockPreview ? (vm.exposed || probe) : (probe ? probeLive : vm.exposed);

  $('pickerName').textContent = vm.picker.name;
  $('pickerMeta').textContent = vm.picker.meta;
  // An ended source is not live, whatever its last session state said; nor is retained data
  // once the owner reports the lease is gone (detach, withdrawal, carrier closed or lost).
  const hostUi = hostLabel();
  $('pickerDot').classList.toggle('live', live && !vm.sourceEnded && (mockPreview || (probe ? probeLive : hostUi.live)));
  $('btnAttach').classList.toggle('on', !probe);
  $('btnProbe').classList.toggle('on', probe);
  $('btnPause').textContent = vm.paused ? '▶ Resume' : '❚❚ Pause';
  // Elapsed time is shown only when an observation supplies it; nothing is timed locally.
  const recUi = recordLabel();
  $('recDot').classList.toggle('on', recUi.dot);
  $('recLabel').textContent = recUi.dot && vm.recording.elapsedMs !== null ? `Recording · ${Math.round(vm.recording.elapsedMs / 1000)} s` : recUi.text;
  $('btnDev').textContent = hostUi.text;
  $('btnRec').classList.toggle('disabled', !recUi.enabled);
  $('btnRec').title = recUi.why ?? '';
  $('btnDev').classList.toggle('disabled', !hostUi.enabled);
  $('hostLine').classList.toggle('hidden', !hostUi.line);
  if (hostUi.line) $('hostLine').textContent = hostUi.line;
  $('btnPause').classList.toggle('disabled', !vm.actions.pause);
  $('btnAttach').classList.toggle('disabled', !vm.actions.mode);
  $('btnProbe').classList.toggle('disabled', !vm.actions.mode);
  $('resnap').classList.toggle('hidden', !vm.needsResnapshot);
  if (vm.needsResnapshot) $('resnap').textContent = `view incomplete · ${vm.needsResnapshot} · resnapshot pending`;
  $('ended').classList.toggle('hidden', !vm.sourceEnded);
  if (vm.sourceEnded) $('ended').textContent = `diagnostic capture ended · ${vm.sourceEnded.reason} · session values below are the last observed, not a transport close`;
  $('hookStats').textContent = vm.hookStats;
  $('mockTag').classList.toggle('hidden', !vm.synthetic);
  document.title = vm.synthetic ? 'Playa · MOCK' : 'Playa';

  $('probeStrip').classList.toggle('hidden', !probe);
  if (probe && !mockPreview) {
    const running = probeRunning();
    $('probeGo').textContent = running ? 'Stop' : 'Start';
    $('probeGo').classList.toggle('disabled', !viewPort || host?.probe?.status === 'stopping' || probeBlocked());
    for (const id of ['probeUrl', 'probeNs', 'probeTracks', 'probeDraft', 'probePolicy']) $(id).disabled = running;
    $('probeStatus').textContent = probeStatusLine() + (presets.status ? ` · ${presets.status}` : '');
    $('probePresetList').classList.toggle('hidden', presets.items.length === 0);
    $('probePresetList').replaceChildren(...presets.items.map(p => {
      const d = el('div', 'inst'); d.append(el('span', 'name', p.name), el('span', 'meta', `${p.label ? p.label + ' · ' : ''}ns ${p.namespace}`));
      d.onclick = () => { $('probeNs').value = JSON.stringify([p.namespace]); };
      return d;
    }));
  }
  $('emptyProbeBody').classList.toggle('hidden', !probe);
  $('emptyBody').classList.toggle('hidden', probe);
  $('emptyState').classList.toggle('hidden', live);
  $('body').classList.toggle('hidden', !live);
  // Sources the page exposed but nothing attached yet: let the user pick one.
  const pickable = host?.core && (host.core.phase === 'discovered' || host.core.phase === 'withdrawn') ? host.core.sources : [];
  $('pickList').classList.toggle('hidden', pickable.length === 0);
  $('pickList').replaceChildren(...pickable.map(s => {
    const d = el('div', 'inst mono');
    d.append(el('span', 'name', s.label ?? s.sourceId), el('span', 'meta', `${s.kind}${s.exposure ? ' · ' + s.exposure : ''} · run ${s.runId}`));
    d.onclick = () => viewPort?.postMessage({ kind: 'select', sourceId: s.sourceId, runId: s.runId });
    return d;
  }));
  if (probe) $('emptyTitle').textContent = host?.probe ? `Probe ${host.probe.status}.` : 'No probe run.';
  else if (pickable.length) $('emptyTitle').textContent = `${pickable.length} exposed Playa source${pickable.length === 1 ? '' : 's'} on this page — pick one to attach.`;
  else $('emptyTitle').textContent = 'No exposed Playa sources found on this page.';
  if (!live) return;

  // track tabs
  const tabs = $('trackTabs');
  tabs.replaceChildren(...vm.tracks.map(t => {
    const b = el('span', 'segBtn track' + (t.on ? ' on' : ''), t.name);
    b.style.color = t.on ? 'var(--grn)' : '';
    b.onclick = () => active().selectTrack(t.id ?? t.name);
    return b;
  }));
  $('ring').textContent = vm.ring;

  // left column
  $('instances').replaceChildren(...vm.instances.map(i => {
    const d = el('div', 'inst' + (i.on ? ' on' : ''));
    d.append(el('span', 'name', i.name), el('span', 'meta', i.sub));
    // Switching sources is detach-then-attach at the page; the owner refuses a second lease otherwise.
    const src = host?.core?.sources.find(s => s.sourceId === i.id);
    if (src && !i.on && viewPort) { d.style.cursor = 'pointer'; d.onclick = () => viewPort.postMessage({ kind: 'switch', sourceId: src.sourceId, runId: src.runId }); }
    return d;
  }));
  $('session').replaceChildren(...vm.session.flatMap(([k, v, flag]) => [el('span', 'k', k), el('span', flag === 'na' ? 'na' : '', v)]));
  $('requests').replaceChildren(...vm.requests.map(r => {
    const d = el('div', 'req' + (r.state === 'gone' ? ' gone' : ''));
    const top = el('div', 'top'); top.append(el('span', '', `${r.id} · ${r.track}`), el('span', r.state === 'active' ? 'state' : '', r.label));
    const chain = el('div', 'chain');
    for (let i = 0; i < r.chain; i++) chain.append(el('i'));
    if (r.state === 'gone') chain.append(el('i', 'dash'));
    d.append(top, chain);
    if (r.caption) d.append(el('span', 'caption', r.caption));
    if (r.context) d.append(el('span', 'caption context', r.context));
    return d;
  }));
  $('decoder').replaceChildren(...vm.decoder.flatMap(([k, v]) => [el('span', 'k', k), el('span', '', v)]));
  $('legendKey').textContent = 'independent · expected (hatched)';
  $('legendNote').textContent = vm.legendNote ?? '';
  $('legendNote').classList.toggle('hidden', !vm.legendNote);

  // grid
  $('colHeader').textContent = vm.colHeader;
  const rowsHost = $('rows');
  while (rowNodes.length > vm.rows.length) rowNodes.pop().row.remove();
  vm.rows.forEach((r, ri) => {
    let node = rowNodes[ri];
    // Rows have their OWN widths (a bounded window each); the node cache is
    // keyed by that row's cell count, never by the widest row.
    if (!node || node.count !== r.cells.length) {
      const row = el('div', 'row'); const label = el('span', 'label'); const cells = el('div', 'cells'); const meta = el('span', 'meta');
      const cellNodes = r.cells.map(() => { const c = el('div', 'cell'); cells.append(c); return c; });
      row.append(label, cells, meta);
      if (node) node.row.replaceWith(row); else rowsHost.append(row);
      node = rowNodes[ri] = { row, label, cells, meta, cellNodes, count: r.cells.length };
    }
    // Rows share a column grid for a uniform cell size only. Each row is its
    // OWN window (`row.window.from`), so the same column can hold different
    // object ids in different rows; the range under the label says which.
    node.cells.style.gridTemplateColumns = `repeat(${vm.columns},minmax(var(--cellMin,0px),1fr))`;   // --cellMin: static/panel.css
    node.row.className = 'row' + (r.head ? ' head' : '');
    node.label.replaceChildren(r.label, el('small', '', (r.window ? `o${r.window.from}–o${r.window.to}${r.window.beyond ? ` +${r.window.beyond}` : ''}` : '') + (r.context ? ` · ${r.context}` : '')));
    node.meta.textContent = r.meta; node.meta.className = 'meta ' + r.metaClass;
    r.cells.forEach((c, ci) => {
      const n = node.cellNodes[ci];
      n.className = 'cell ' + c.cls + (c.sel ? ' sel' : '');
      n.onclick = () => active().selectCell(c.g, c.o);
      n.title = `${c.g} / o${c.o}`;
    });
  });

  // selected object
  const selHost = $('selected');
  // Each [key, value] is ONE item (label above its own value), so the pairing survives any column count the
  // responsive grid produces; five items side by side reproduce the wide five-column appearance.
  selHost.replaceChildren(...vm.selected.map(([k, v, cls]) => { const pair = el('div', 'pair'); pair.append(el('span', 'k', k), el('span', 'v ' + (cls || ''), v)); return pair; }));

  // charts
  $('sparks').replaceChildren(...vm.sparks.map(s => {
    const d = el('div', 'spark'); const top = el('div', 'top');
    const label = el('h4', '', s.name);
    const value = el('span', 'now' + (s.na ? ' na' : ''), s.now);
    label.title = value.title = s.definition ?? s.na ?? '';
    top.append(label, value);
    const bars = el('div', 'bars');
    for (const b of s.bars) { const i = el('i'); i.style.height = b.h + 'px'; i.style.background = b.color; i.style.opacity = s.na ? 0.15 : b.op; bars.append(i); }
    if (s.bars.length === 0) { const i = el('i'); i.style.height = '1px'; i.style.background = 'var(--line2)'; bars.append(i); }
    d.append(top, bars);
    if (s.na) d.append(el('span', 'why', s.na));
    if (s.range) d.append(el('span', 'why', s.range));
    return d;
  }));

  // coalesced events
  $('events').replaceChildren(...vm.events.map(e => {
    const d = el('div', 'ev'); const n = el('span', '', e.name); n.style.color = e.color;
    d.append(n, el('span', 'n', e.count)); return d;
  }));
}

window.addEventListener('pagehide', () => { for (const l of Object.values(lanes)) l?.destroy(); });
// Exposed for the browser checks only; not an API. `applyEncoded` takes a
// serialized frame through the real codec, as a host would.
const applied = [];   // bounded record of frame metadata applied, for the browser gates (kind, seq range, lane, outcome; no payloads)
window.__playaPanel = {
  owner, get vm() { return vm; }, get vms() { return vms; }, get mode() { return mode; }, setMode, get host() { return host; }, get hasOwner() { return viewPort !== null; }, get applied() { return applied; }, get stalled() { return stalled; }, get lastExport() { return lastExport; }, get presets() { return presets; }, source,
  applyEncoded(text, lane = 'page') {
    const result = decodeMessage(text);
    if (!result.ok) return result;
    const target = lanes[lane] ?? lanes.page;
    const m = result.message;
    let outcome = null;
    if (m.kind === 'hello') target.applyHello?.(m);
    else if (m.kind === 'snapshot') outcome = target.applySnapshot?.(m) ?? null;
    else if (m.kind === 'batch') {
      outcome = target.applyBatch?.(m) ?? null;
      // The adapter asks for a resnapshot on a gap/overlap/unknown clock: request one for THAT lane (the owner
      // coalesces per lane; for the probe lane it is a local refresh of our own capture, never a redial).
      if (outcome?.kind === 'resnapshot') viewPort?.postMessage({ kind: 'refresh', lane });
    }
    // ack/error are correlated by the owner (host-core); the panel shows them through the host line.
    const seq = m.kind === 'batch' ? `${m.fromSeq}-${m.toSeq}` : m.kind === 'snapshot' ? `w${m.watermark}` : null;
    if (applied.length >= 256) applied.shift();
    applied.push({ kind: m.kind, seq, lane, outcome: outcome?.kind ?? outcome?.applied ?? null });

    return { ok: true, kind: m.kind, outcome };
  },
};
