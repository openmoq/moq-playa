// Owner/relay boundary harness: runs the BUILT devtools.js (owner) and relay.js
// inside node:vm with controlled chrome.* APIs and ports. These are VM
// measurements of attempt ownership, hop authentication and hop bounds; they
// prove nothing about native permission prompting or real DevTools routing
// (test/real-tab.mjs does that). Exit code 1 if any check fails.
//
// Requires a built extension (`pnpm build`) and built packages.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..');
const repoRoot = resolve(extensionDir, '../..');
const ownerBundle = await readFile(join(extensionDir, 'dist/devtools.js'), 'utf8');
const relayBundle = await readFile(join(extensionDir, 'dist/relay.js'), 'utf8');
const proto = await import(join(repoRoot, 'packages/devtools-protocol/dist/index.js'));
const fixtures = await import(join(repoRoot, 'packages/devtools-protocol/dist/fixtures.js'));

const EXT = 'extensionid';
const OWNER = 'review-owner';
const common = { channel: 'openmoq-devtools', version: proto.PROTOCOL_VERSION };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const event = () => { const fns = []; return { addListener(fn) { fns.push(fn); }, fire(...a) { for (const f of [...fns]) f(...a); } }; };
function port(name, sender) {
  return { name, sender, onMessage: event(), onDisconnect: event(), sent: [], disconnected: false,
    postMessage(m) { if (this.disconnected) throw new Error('port disconnected'); this.sent.push(structuredClone(m)); },
    disconnect() { if (this.disconnected) return; this.disconnected = true; this.onDisconnect.fire(); } };
}
let receiptSerial = 0;
const receipt = () => `${++receiptSerial}.${'ab'.repeat(16)}`;

function ownerEnv() {
  const runtimeConnect = event(), navigation = event(), panelShown = event(), panelHidden = event(), ports = [], injections = [], held = [], timers = [];
  const state = { origin: 'https://a.example', url: 'https://a.example/', granted: true, hold: false };
  const chrome = {
    runtime: { id: EXT, onConnect: runtimeConnect, lastError: undefined },
    // chrome.devtools.inspectedWindow.eval is replaced per test when a read must be held.
    tabs: { get: async () => ({ url: state.url }), connect: (tab, opts) => { const p = port(opts.name, undefined); p.opts = opts; ports.push(p); return p; } },
    scripting: { executeScript: async opts => { injections.push(opts); if (state.hold) { const d = deferred(); held.push(d); return d.promise; } return [{ frameId: 0, documentId: 'doc-a' }]; } },
    permissions: { contains: async () => state.granted },
    devtools: { inspectedWindow: { tabId: 7, eval: (expression, cb) => { assert.equal(expression, 'location.origin'); cb(state.origin, null); } },
      network: { onNavigated: navigation }, panels: { create: (a, b, c, cb) => cb({ onShown: panelShown, onHidden: panelHidden }) } },
  };
  // A fake WebTransport for the owner-local probe: constructed promptly, its handshake fails (or hangs) by test choice.
  // Modes: 'reject' = handshake fails and `closed` REJECTS like the W3C transport (a settled closure);
  // 'hang' = handshake never settles, close() settles `closed`; 'hang-close' = close() never settles `closed`;
  // 'reject-hold' = handshake fails at once but the failed session's `closed` rejects only when the test calls
  // `wt.releaseHeld()` (a slow transport teardown, the window the Start button must not invite a retry in);
  // 'throw' = the constructor itself throws.
  const wt = { constructed: [], closed: 0, mode: 'reject', releaseHeld: null };
  class FakeWebTransport {
    constructor(url, opts) {
      if (wt.mode === 'throw') { wt.constructed.push({ url, protocols: opts?.protocols ?? null, threw: true }); throw new TypeError('fake constructor refused the URL'); }
      wt.constructed.push({ url, protocols: opts?.protocols ?? null });
      this.protocol = '';
      const rejects = wt.mode === 'reject' || wt.mode === 'reject-hold';
      let settleClosed; this.closed = new Promise((res, rej) => { settleClosed = rejects ? () => rej(new Error('fake WebTransportError: session failed')) : () => res({ closeCode: 0, reason: 'closed by owner' }); });
      this.closed.catch(() => {});
      this.ready = rejects ? Promise.reject(new Error('fake handshake refused')) : new Promise(() => {});
      this.ready.catch(() => {});
      this.close = () => { wt.closed++; if (wt.mode !== 'hang-close' && wt.mode !== 'reject-hold') settleClosed(); };
      if (wt.mode === 'reject') queueMicrotask(settleClosed);   // the failed session's closed promise rejects on its own
      if (wt.mode === 'reject-hold') wt.releaseHeld = settleClosed;   // ...or only when the test says the teardown settles
    }
  }
  let uuid = 0;
  const windowListeners = {};
  const ctx = { chrome, crypto: { randomUUID: () => (uuid++ === 0 ? OWNER : `id-${uuid}`), getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 255; return a; } },
    window: { addEventListener(name, fn) { (windowListeners[name] ??= []).push(fn); } }, URL, TextEncoder, TextDecoder, console, performance, queueMicrotask, AbortController, WebTransport: FakeWebTransport,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.live = false; } };
  vm.runInNewContext(ownerBundle, ctx);
  const legit = () => {
    const p = port('view:' + OWNER, { id: EXT, url: `chrome-extension://${EXT}/panel.html?owner=${OWNER}&tab=7` });
    p.autoAck = true;
    const original = p.postMessage.bind(p);
    p.postMessage = m => {
      original(m);
      if (!p.autoAck) return;
      // Acknowledge like the real panel does, after the owner's current call unwinds.
      // The panel's exact mapping: frames, host state and the stalled notice are acknowledged separately.
      const ack = m.kind === 'frame' ? { kind: 'ack', frames: 1 } : m.kind === 'stalled' ? { kind: 'ack', stalled: true } : { kind: 'ack', host: true };
      queueMicrotask(() => { if (!p.disconnected) p.onMessage.fire(ack); });
    };
    return p;
  };
  const view = legit(); runtimeConnect.fire(view);
  const host = () => view.sent.filter(m => m.kind === 'host').at(-1);
  const fire = ms => { const t = timers.find(t => t.live && t.ms === ms); if (!t) throw new Error(`no live ${ms} ms timer`); t.live = false; t.fn(); };
  /** Drive a successful attach: relay-ready → bootstrap → hello, then select → snapshot. */
  const attachAndBind = async (requestedOrigin = state.origin) => {
    view.onMessage.fire({ kind: 'attach', origin: requestedOrigin }); await settle();
    const p = ports.at(-1); assert.ok(p, 'no relay port');
    p.onMessage.fire({ t: 'relay-ready' }); await settle();
    const boot = p.sent.find(m => m.t === 'bootstrap'); assert.ok(boot, 'no bootstrap');
    const d = proto.decodeMessage(boot.discover); assert.ok(d.ok && d.message.kind === 'discover');
    const reply = frames => p.onMessage.fire({ t: 'packet', g: boot.g, data: proto.encodeCarrierReply({ kind: 'reply', receipt: receipt(), frames: frames.map(proto.encodeMessage) }) });
    reply([{ ...common, kind: 'hello', requestId: d.message.requestId, ownerId: OWNER, sources: [fixtures.fixtureSource] }]); await settle();
    view.onMessage.fire({ kind: 'select', sourceId: fixtures.fixtureSource.sourceId, runId: fixtures.fixtureSource.runId }); await settle();
    const req = lastRequest(p); assert.equal(req.kind, 'attach');
    reply([{ ...fixtures.snapshotFixture, requestId: req.requestId, target: { ...fixtures.fixtureTarget, ownerId: OWNER } }]); await settle();
    return { p, boot, reply };
  };
  const lastRequest = p => {
    const packets = p.sent.filter(m => m.t === 'packet');
    const outer = proto.decodeCarrierRequest(packets.at(-1)?.data); assert.ok(outer.ok, 'owner packet decodes');
    if (outer.packet.kind !== 'request') return { kind: outer.packet.kind };
    const inner = proto.decodeMessage(outer.packet.message); assert.ok(inner.ok); return inner.message;
  };
  const requests = p => p.sent.filter(m => m.t === 'packet').map(m => proto.decodeCarrierRequest(m.data).packet)
    .map(k => k.kind === 'request' ? proto.decodeMessage(k.message).message.kind : k.kind);
  /** Run the owner-local loops: fire observation-cadence timers (≤ 250 ms) with microtask settles, never the 15 s idle timers. */
  const pump = async (rounds = 30) => {
    for (let i = 0; i < rounds; i++) {
      await settle();
      const due = timers.filter(t => t.live && t.ms <= 250).sort((a, b) => a.ms - b.ms)[0];
      if (!due) continue;
      due.live = false; due.fn();
    }
    await settle();
  };
  const fireWindow = name => { for (const fn of windowListeners[name] ?? []) fn({ type: name }); };
  return { state, chrome, wt, view, legit, navigation, panelShown, panelHidden, ports, injections, held, timers, host, fire, pump, fireWindow, attachAndBind, lastRequest, requests, runtimeConnect };
}

const results = [];
async function check(name, fn) {
  try { const evidence = await fn(); results.push({ name, pass: true, evidence }); }
  catch (error) { results.push({ name, pass: false, message: String(error?.message ?? error), evidence: error?.evidence }); }
}
function invariant(ok, message, evidence) { if (!ok) { const e = new Error(message); e.evidence = evidence; throw e; } return evidence; }

await check('control: denied permission injects nothing and reports needs-permission', async () => {
  const e = ownerEnv(); e.state.granted = false; await settle();
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle();
  return invariant(e.injections.length === 0 && e.host().outer.stage === 'needs-permission', 'denied grant injected', e.host().outer);
});
await check('attach for an origin other than the one inspected does nothing', async () => {
  const e = ownerEnv(); await settle();
  e.view.onMessage.fire({ kind: 'attach', origin: 'https://other.example' }); await settle();
  return invariant(e.injections.length === 0 && e.host().outer.stage === 'origin-mismatch', 'foreign origin attach proceeded', e.host().outer);
});
await check('navigation cancels a pending injection attempt', async () => {
  const e = ownerEnv(); await settle(); e.state.hold = true;
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle(); assert.equal(e.held.length, 1);
  e.state.origin = 'https://b.example'; e.state.url = 'https://b.example/'; e.navigation.fire(e.state.url); await settle();
  e.held[0].resolve([{ frameId: 0, documentId: 'doc-b' }]); await settle();
  e.ports[0]?.onMessage.fire({ t: 'relay-ready' }); await settle();
  return invariant(e.ports.length === 0 && e.host().outer.origin === 'https://b.example', 'cancelled A attempt connected on B', { connects: e.ports.length, outer: e.host().outer });
});
await check('user disconnect cancels a pending injection attempt', async () => {
  const e = ownerEnv(); await settle(); e.state.hold = true;
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle(); assert.equal(e.held.length, 1);
  e.view.onMessage.fire({ kind: 'disconnect' }); await settle();
  e.held[0].resolve([{ frameId: 0, documentId: 'doc-a' }]); await settle();
  return invariant(e.ports.length === 0, 'detached attempt still connected', { connects: e.ports.length, outer: e.host().outer });
});
await check('two attach clicks make one attempt and at most one live port', async () => {
  const e = ownerEnv(); await settle(); e.state.hold = true;
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle();
  for (const d of e.held) d.resolve([{ frameId: 0, documentId: 'doc-a' }]); await settle();
  return invariant(e.injections.length === 1 && e.ports.filter(p => !p.disconnected).length === 1, 'concurrent attaches', { injections: e.injections.length, live: e.ports.filter(p => !p.disconnected).length });
});
await check('a relay port that closes before relay-ready is "not attached", not "carrier lost"', async () => {
  const e = ownerEnv(); await settle();
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle();
  e.ports[0].disconnect(); await settle();
  return invariant(e.host().outer.stage === 'not-attached', 'wrong state', e.host().outer);
});
await check('view port with a tab sender, wrong owner or no extension identity is refused without host state', async () => {
  const e = ownerEnv(); await settle();
  const bad = [
    port('view:' + OWNER, { id: EXT, tab: { id: 7 }, url: `chrome-extension://${EXT}/panel.html?owner=${OWNER}` }),
    port('view:' + OWNER, { id: EXT, url: `chrome-extension://${EXT}/panel.html?owner=someone-else` }),
    port('view:' + OWNER, { id: 'other', url: `chrome-extension://other/panel.html?owner=${OWNER}` }),
    port('view:' + OWNER, { id: EXT, url: `https://a.example/panel.html?owner=${OWNER}` }),
  ];
  for (const p of bad) { e.runtimeConnect.fire(p); p.onMessage.fire({ kind: 'attach', origin: e.state.origin }); }
  await settle();
  return invariant(e.injections.length === 0 && bad.every(p => p.disconnected && !p.sent.some(m => m.kind === 'host')), 'illegitimate view accepted', bad.map(p => ({ disconnected: p.disconnected, sent: p.sent.length })));
});
await check('owner timeout relinquishes the channel: close packet sent and relay port disconnected', async () => {
  const e = ownerEnv(); await settle();
  const { p } = await e.attachAndBind();
  assert.equal(e.host().core.phase, 'attached');
  e.fire(250); await settle();                 // poll goes out
  e.fire(5000); await settle();                // no reply
  const last = proto.decodeCarrierRequest(p.sent.filter(m => m.t === 'packet').at(-1).data);
  return invariant(e.host().core.phase === 'lost' && last.ok && last.packet.kind === 'close' && p.disconnected && e.host().outer.stage === 'carrier-lost', 'silent channel not released', { core: e.host().core, outer: e.host().outer, last: last.packet, disconnected: p.disconnected });
});
await check('whole-source refresh requests coalesce into one exchange', async () => {
  const e = ownerEnv(); await settle();
  const { p } = await e.attachAndBind();
  const before = e.requests(p).length;
  e.view.onMessage.fire({ kind: 'refresh' }); e.view.onMessage.fire({ kind: 'refresh' }); e.view.onMessage.fire({ kind: 'refresh' }); await settle();
  const sent = e.requests(p).slice(before);
  return invariant(sent.length === 1 && sent[0] === 'snapshot.request' && e.host().core.queued === 0, 'refreshes not coalesced', { sent, queued: e.host().core.queued });
});
await check('instance switch sequences detach, waits for the ack, then attaches', async () => {
  const e = ownerEnv(); await settle();
  const { p, reply } = await e.attachAndBind();
  e.view.onMessage.fire({ kind: 'switch', sourceId: 'second', runId: 'run-2' }); await settle();
  const detach = e.lastRequest(p); assert.equal(detach.kind, 'detach');
  reply([{ ...common, kind: 'ack', requestId: detach.requestId, target: { ...fixtures.fixtureTarget, ownerId: OWNER } }]); await settle();
  const attach = e.lastRequest(p);
  return invariant(attach.kind === 'attach' && attach.target.sourceId === 'second' && attach.target.runId === 'run-2', 'switch did not attach after the ack', attach);
});
await check('a view that stops acknowledging has a TOTAL message bound (frames, state and notices) and resyncs when it recovers', async () => {
  const e = ownerEnv(); await settle();
  const { p, reply } = await e.attachAndBind();
  e.view.autoAck = false;                      // from here the view consumes nothing
  const before = e.view.sent.length;
  // 70 polls each answered by one batch, then 256 empty polls: the view never acknowledges anything.
  for (let i = 0; i < 70; i++) {
    e.fire(250); await settle();
    reply([{ ...fixtures.batchFixture, target: { ...fixtures.fixtureTarget, ownerId: OWNER }, fromSeq: String(6 + i), toSeq: String(6 + i), events: [{ ...fixtures.batchFixture.events[0], seq: String(6 + i) }] }]); await settle();
  }
  for (let i = 0; i < 256; i++) { e.fire(250); await settle(); reply([]); await settle(); }
  const total = e.view.sent.length - before;
  const frames = e.view.sent.slice(before).filter(m => m.kind === 'frame').length;
  const hosts = e.view.sent.slice(before).filter(m => m.kind === 'host').length;
  const stalled = e.view.sent.filter(m => m.kind === 'stalled').length;
  // Recovery: the view acknowledges everything it has; it gets the newest state and a baseline refresh.
  const reqBefore = e.requests(p).length;
  const sentBefore = e.view.sent.length;
  e.view.onMessage.fire({ kind: 'ack', frames: 64, host: true }); await settle();
  e.view.onMessage.fire({ kind: 'ack', stalled: true }); await settle();
  const afterAck = e.requests(p).slice(reqBefore);
  const resumedHost = e.view.sent.slice(sentBefore).some(m => m.kind === 'host');
  return invariant(frames <= 64 && hosts <= 1 && stalled === 1 && total <= 66 && afterAck.includes('snapshot.request') && resumedHost,
    'view hop unbounded or no recovery', { total, frames, hosts, stalled, afterAck, resumedHost });
});
await check('first attach cancelled by navigation returns to a usable ready state', async () => {
  const e = ownerEnv(); await settle(); e.state.hold = true;
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle();
  assert.equal(e.held.length, 1);
  e.state.origin = 'https://b.example'; e.state.url = 'https://b.example/'; e.navigation.fire(e.state.url); await settle();
  e.held[0].resolve([{ frameId: 0, documentId: 'doc-b' }]); await settle();
  return invariant(e.ports.length === 0 && e.host().outer.stage === 'ready' && e.host().outer.origin === 'https://b.example', 'cancelled first attach left the panel busy', { connects: e.ports.length, outer: e.host().outer });
});
await check('same-origin document replacement during the first attach returns to ready', async () => {
  const e = ownerEnv(); await settle(); e.state.hold = true;
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle();
  e.state.url = 'https://a.example/replaced'; e.navigation.fire(e.state.url); await settle();
  e.held[0].resolve([{ frameId: 0, documentId: 'new-a' }]); await settle();
  return invariant(e.ports.length === 0 && e.host().outer.stage === 'ready', 'same-origin navigation left a dead attempt busy', { connects: e.ports.length, outer: e.host().outer });
});
await check('a late origin read from before a navigation cannot overwrite the new document\'s origin', async () => {
  const e = ownerEnv(); await settle(); const reads = [];
  e.chrome.devtools.inspectedWindow.eval = (expression, cb) => { const result = e.state.origin; reads.push(() => cb(result, null)); };
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle(); assert.equal(reads.length, 1);
  e.state.origin = 'https://b.example'; e.state.url = 'https://b.example/'; e.navigation.fire(e.state.url); await settle(); assert.equal(reads.length, 2);
  reads[1](); await settle(); assert.equal(e.host().outer.origin, 'https://b.example');
  reads[0](); await settle();
  return invariant(e.host().outer.origin === 'https://b.example' && e.host().outer.stage === 'ready', 'stale origin read overwrote the new document', e.host().outer);
});
await check('a valid non-minified hello is retained as the baseline for a late view', async () => {
  const e = ownerEnv(); await settle();
  e.view.onMessage.fire({ kind: 'attach', origin: e.state.origin }); await settle();
  const p = e.ports.at(-1); p.onMessage.fire({ t: 'relay-ready' }); await settle();
  const boot = p.sent.find(m => m.t === 'bootstrap'); const d = proto.decodeMessage(boot.discover).message;
  const hello = { ...common, kind: 'hello', requestId: d.requestId, ownerId: OWNER, sources: [fixtures.fixtureSource], extra: 'ignored additive field' };
  const formatted = JSON.stringify(hello, null, 2); assert.equal(proto.decodeMessage(formatted).ok, true);
  p.onMessage.fire({ t: 'packet', g: boot.g, data: proto.encodeCarrierReply({ kind: 'reply', receipt: receipt(), frames: [formatted] }) }); await settle();
  e.view.onMessage.fire({ kind: 'select', sourceId: fixtures.fixtureSource.sourceId, runId: fixtures.fixtureSource.runId }); await settle();
  const a = e.lastRequest(p);
  p.onMessage.fire({ t: 'packet', g: boot.g, data: proto.encodeCarrierReply({ kind: 'reply', receipt: receipt(), frames: [proto.encodeMessage({ ...fixtures.snapshotFixture, requestId: a.requestId, target: { ...fixtures.fixtureTarget, ownerId: OWNER } })] }) }); await settle();
  const late = e.legit(); e.runtimeConnect.fire(late); await settle();
  const kinds = late.sent.filter(m => m.kind === 'frame').map(m => proto.decodeMessage(m.encoded).message.kind);
  return invariant(kinds.includes('hello'), 'JSON formatting prevented hello caching', { lateFrameKinds: kinds });
});
await check('a view joining while attached gets the hello and a baseline refresh, without a new lease', async () => {
  const e = ownerEnv(); await settle();
  const { p } = await e.attachAndBind();
  const before = e.requests(p);
  const second = e.legit(); e.runtimeConnect.fire(second); await settle();
  const got = second.sent.map(m => m.kind);
  const after = e.requests(p).slice(before.length);
  const hello = second.sent.find(m => m.kind === 'frame');
  return invariant(got.includes('host') && hello && hello.encoded.includes('"kind":"hello"') && after.length === 1 && after[0] === 'snapshot.request' && !after.includes('attach'), 'late view not baselined', { got, after });
});
await check('relay admits one data reply per exchange and relay-ready carries no page URL', async () => {
  const connects = event(), channels = [];
  class FakeChannel { constructor() { this.port1 = { postMessage() {}, close() {}, start() {}, onmessage: null, onmessageerror: null }; this.port2 = {}; channels.push(this); } }
  const win = {}; win.top = win; win.postMessage = () => {};
  vm.runInNewContext(relayBundle, { chrome: { runtime: { id: EXT, onConnect: connects } }, window: win, location: { origin: 'https://a.example', href: 'https://a.example/?secret=must-not-send' }, MessageChannel: FakeChannel, TextEncoder, console });
  const p = port('playa-carrier', { id: EXT }); connects.fire(p);
  p.onMessage.fire({ t: 'bootstrap', g: 1, origin: 'https://a.example', discover: proto.encodeMessage({ ...common, kind: 'discover', requestId: 'd', ownerId: OWNER }) });
  const hello = proto.encodeMessage({ ...common, kind: 'hello', requestId: 'd', ownerId: OWNER, sources: [fixtures.fixtureSource] });
  const packet = proto.encodeCarrierReply({ kind: 'reply', receipt: '1.' + 'ab'.repeat(16), frames: [hello] });
  for (let i = 0; i < 100; i++) channels[0].port1.onmessage({ data: packet });
  const forwarded = p.sent.filter(m => m.t === 'packet');
  const ready = p.sent.find(m => m.t === 'relay-ready');
  return invariant(forwarded.length === 1 && ready && !('href' in ready) && p.sent.some(m => m.t === 'refused' && m.why === 'excess-reply'), 'relay amplified page traffic or leaked the URL', { forwarded: forwarded.length, ready });
});
await check('relay refuses a bootstrap for another origin and a port from another extension', async () => {
  const connects = event(), channels = [];
  class FakeChannel { constructor() { this.port1 = { postMessage() {}, close() {}, start() {}, onmessage: null }; this.port2 = {}; channels.push(this); } }
  const win = {}; win.top = win; let posted = 0; win.postMessage = () => { posted++; };
  vm.runInNewContext(relayBundle, { chrome: { runtime: { id: EXT, onConnect: connects } }, window: win, location: { origin: 'https://a.example' }, MessageChannel: FakeChannel, TextEncoder, console });
  const foreign = port('playa-carrier', { id: 'other' }); connects.fire(foreign);
  const p = port('playa-carrier', { id: EXT }); connects.fire(p);
  p.onMessage.fire({ t: 'bootstrap', g: 1, origin: 'https://b.example', discover: proto.encodeMessage({ ...common, kind: 'discover', requestId: 'd', ownerId: OWNER }) });
  return invariant(foreign.disconnected && posted === 0 && p.sent.some(m => m.t === 'refused' && m.why === 'origin-mismatch'), 'relay accepted a foreign origin or extension', { foreign: foreign.disconnected, posted, sent: p.sent });
});

await check('consuming in FIFO order with the panel mapping: a stalled-notice ack cannot release an unread host state', async () => {
  const e = ownerEnv(); await settle();
  const { p, reply } = await e.attachAndBind();
  e.view.autoAck = false;
  let consumed = e.view.sent.length;
  // Queue: host H1 (the first poll's state change), 64 frames, stalled S — nothing consumed meanwhile.
  for (let i = 0; i < 70; i++) {
    e.fire(250); await settle();
    reply([{ ...fixtures.batchFixture, target: { ...fixtures.fixtureTarget, ownerId: OWNER }, fromSeq: String(6 + i), toSeq: String(6 + i), events: [{ ...fixtures.batchFixture.events[0], seq: String(6 + i) }] }]); await settle();
  }
  const first = e.view.sent[consumed++]; assert.equal(first.kind, 'host');
  e.view.onMessage.fire({ kind: 'ack', host: true }); await settle();          // H2 (coalesced) is queued AFTER S
  for (let i = 0; i < 64; i++) {
    const frame = e.view.sent[consumed++]; assert.equal(frame.kind, 'frame');
    e.view.onMessage.fire({ kind: 'ack', frames: 1 }); await settle();
  }
  const notice = e.view.sent[consumed++]; assert.equal(notice.kind, 'stalled');
  assert.equal(e.view.sent.slice(consumed).filter(m => m.kind === 'host').length, 1);
  const reqBefore = e.requests(p).length;
  e.view.onMessage.fire({ kind: 'ack', stalled: true }); await settle();      // the notice's OWN acknowledgement
  const unread = e.view.sent.slice(consumed).map(m => m.kind);
  const recovered = e.requests(p).slice(reqBefore).includes('snapshot.request');
  return invariant(unread.filter(k => k === 'host').length <= 1 && recovered, 'stalled ack released an unread host state, or no recovery', { unreadMessages: unread, recovered });
});

await check('recording: the token never reaches a view, the export is reassembled and handed over once, a late view sees the recording', async () => {
  const e = ownerEnv(); await settle();
  const { p, reply } = await e.attachAndBind();
  e.view.onMessage.fire({ kind: 'record.start' }); await settle();
  const start = e.lastRequest(p); assert.equal(start.kind, 'record.start');
  const target = { ...fixtures.fixtureTarget, ownerId: OWNER };
  reply([{ ...common, kind: 'record.started', requestId: start.requestId, target, recordingId: 'rec-9', token: 'tok-secret-9' }]); await settle();
  assert.equal(e.host().core.recording?.recordingId, 'rec-9');
  e.view.onMessage.fire({ kind: 'record.stop' }); await settle();
  const stop = e.lastRequest(p); assert.equal(stop.kind, 'record.stop'); assert.equal(stop.token, 'tok-secret-9');
  reply([{ ...common, kind: 'ack', requestId: stop.requestId, target }]); await settle();
  e.view.onMessage.fire({ kind: 'record.export' }); await settle();
  const ex = e.lastRequest(p); assert.equal(ex.kind, 'record.export');
  const chunk = (index, data, final) => ({ ...common, kind: 'export.chunk', requestId: ex.requestId, target, exportId: 'exp-9', index, final, data });
  reply([chunk(0, '{"qlog_version"', false)]); await settle();
  e.fire(0); await settle();                                 // credit yielded immediately while exporting
  reply([chunk(1, ':"0.4",\u00e9', false)]); await settle();
  e.fire(0); await settle();
  reply([chunk(2, '}', true)]); await settle();
  const exportsToView = e.view.sent.filter(m => m.kind === 'export');
  const late = e.legit(); e.runtimeConnect.fire(late); await settle();
  const lateHost = late.sent.find(m => m.kind === 'host');
  return invariant(
    !JSON.stringify(e.view.sent).includes('tok-secret-9') && !JSON.stringify(late.sent).includes('tok-secret-9')
      && exportsToView.length === 1 && exportsToView[0].text === '{"qlog_version":"0.4",\u00e9}' && exportsToView[0].recordingId === 'rec-9'
      && lateHost?.core?.recording?.recordingId === 'rec-9',
    'token leaked, export not handed over exactly once, or late view blind to the recording',
    { exports: exportsToView.length, text: exportsToView[0]?.text, lateRecording: lateHost?.core?.recording });
});

await check('probe: Start dials once with the offered subprotocol, a refused handshake is a failed run with its facts, Stop and a fresh Start follow', async () => {
  const e = ownerEnv(); await settle();
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(60);
  const hostNow = e.host();
  const frames = e.view.sent.filter(m => m.kind === 'frame' && m.lane === 'probe').map(m => proto.decodeMessage(m.encoded).message);
  const facts = frames.flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
  const dial = facts.filter(f => f.kind === 'dial_attempt').map(f => f.state);
  const sessions = facts.filter(f => f.kind === 'session').map(f => f.state);
  const failure = facts.find(f => f.kind === 'failure');
  // Start again while the failed run is retired is allowed; starting a SECOND run while one is live is refused.
  const refusedBefore = e.host().probeLastError;
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(40);
  return invariant(e.wt.constructed.length >= 1 && e.wt.constructed[0].protocols?.[0] === 'moqt-22'
    && hostNow.probe?.status === 'failed' && dial.includes('started') && dial.includes('failed') && sessions.includes('dialing') && failure?.stage === 'dial'
    && refusedBefore === null && e.host().probe?.status === 'failed' && e.wt.constructed.length === 2,
    'probe lifecycle not as expected', { constructed: e.wt.constructed, status: hostNow.probe?.status, dial, sessions, failure: failure && { stage: failure.stage, outcome: failure.outcome }, refusedBefore, second: e.host().probe?.status });
});
await check('probe: a live run refuses a second Start, survives a view reload, and Stop ends it with its transport closed', async () => {
  const e = ownerEnv(); await settle(); e.wt.mode = 'hang';
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: ['video'], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  assert.equal(e.host().probe?.status, 'starting');
  e.view.onMessage.fire({ kind: 'probe.start', config }); await settle();
  const refused = e.host().probeLastError;
  const late = e.legit(); e.runtimeConnect.fire(late); await settle();
  const lateProbe = late.sent.find(m => m.kind === 'host')?.probe;
  e.view.onMessage.fire({ kind: 'probe.stop' }); await e.pump(60);
  return invariant(/already active/.test(refused ?? '') && lateProbe?.status === 'starting' && e.wt.constructed.length === 1
    && e.wt.closed === 1 && e.host().probe?.status === 'stopped' && e.host().probe?.scope === 'tracks',
    'probe run ownership not as expected', { refused, lateProbe: lateProbe?.status, constructed: e.wt.constructed.length, closed: e.wt.closed, final: e.host().probe });
});
await check('probe: a rejected handshake (rejected closed) permits retry on the SAME runner without a teardown fact', async () => {
  const e = ownerEnv(); await settle();
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(60);
  const facts1 = e.view.sent.filter(m => m.kind === 'frame' && m.lane === 'probe').map(m => proto.decodeMessage(m.encoded).message)
    .flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
  const teardown = facts1.filter(f => f.kind === 'failure' && f.stage === 'teardown');
  const liveTimersAfterFirst = e.timers.filter(t => t.live).length;
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(60);
  const liveTimersAfterSecond = e.timers.filter(t => t.live).length;
  return invariant(e.host().probe?.status === 'failed' && e.host().probeLastError === null && e.wt.constructed.length === 2 && teardown.length === 0
    && liveTimersAfterSecond <= liveTimersAfterFirst,
    'retry after a rejected handshake not as expected', { status: e.host().probe?.status, refused: e.host().probeLastError, constructed: e.wt.constructed.length, teardown: teardown.length, liveTimersAfterFirst, liveTimersAfterSecond });
});
await check('control: a failed handshake whose teardown is still settling is NOT reported failed — the runner rejects ready only after its stop settles, so the run stays starting (dial failure fact already visible), a Start press is refused by the owner\'s overlap rule before any runner call and consumes no generation, and once the close settles the same runner starts with the next generation', async () => {
  const e = ownerEnv(); await settle(); e.wt.mode = 'reject-hold';
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  const held = e.host().probe;
  const generationHeld = held?.core?.generation;
  const factsHeld = e.view.sent.filter(m => m.kind === 'frame' && m.lane === 'probe').map(m => proto.decodeMessage(m.encoded).message)
    .flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
  const dialFailureVisible = factsHeld.some(f => f.kind === 'failure' && f.stage === 'dial');
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);   // a Start pressed inside that window
  const pressed = e.host();
  const constructedAfterPress = e.wt.constructed.length;
  e.wt.releaseHeld(); await e.pump(40);                   // the teardown settles (closed rejects: a settled closure)
  const settledHost = e.host();
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  const restarted = e.host();
  const ownerRefused = /already active; stop it first/.test(pressed.probeLastError ?? '');   // the owner's wording, not the runner's
  return invariant(held?.status === 'starting' && dialFailureVisible && pressed.probe?.status === 'starting' && ownerRefused && constructedAfterPress === 1
    && pressed.probe?.core?.generation === generationHeld && settledHost.probe?.status === 'failed' && /handshake refused/.test(settledHost.probe?.failure ?? '')
    && restarted.probeLastError === null && e.wt.constructed.length === 2 && restarted.probe?.core?.generation === generationHeld + 1,
    'held-teardown ordering not as documented',
    { held: { status: held?.status, generation: generationHeld, dialFailureVisible }, pressed: { status: pressed.probe?.status, refused: pressed.probeLastError, ownerRefused, generation: pressed.probe?.core?.generation, constructedAfterPress },
      settled: { status: settledHost.probe?.status, failure: settledHost.probe?.failure }, restarted: { refused: restarted.probeLastError, generation: restarted.probe?.core?.generation, constructed: e.wt.constructed.length } });
});
await check('probe: a failed handshake whose close never settles within the runner\'s bound QUARANTINES the owner — failed with the handshake failure kept, blocked/canStart false published, a Start refused by the owner naming the recovery before any generation or factory step, destruction still clean', async () => {
  const e = ownerEnv(); await settle(); e.wt.mode = 'reject-hold';
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  e.fire(3000); await e.pump(40);                        // the runner's close bound expires without the closed promise settling
  const after = e.host().probe;
  const facts = e.view.sent.filter(m => m.kind === 'frame' && m.lane === 'probe').map(m => proto.decodeMessage(m.encoded).message)
    .flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
  const teardownFact = facts.some(f => f.kind === 'failure' && f.stage === 'teardown' && f.outcome === 'timeout');
  const generationBefore = after?.core?.generation;
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  const refused = e.host().probeLastError;
  const pressed = e.host().probe;
  e.fireWindow('pagehide'); await e.pump(40);              // owner destruction: the runner is disposed, the loop released
  const live = e.timers.filter(t => t.live && t.ms <= 250);
  return invariant(after?.status === 'failed' && /handshake refused/.test(after?.failure ?? '') && teardownFact
    && after?.blocked?.reason === 'unproven-close' && after?.canStart === false && /close and reopen DevTools/.test(after?.blocked?.message ?? '')
    && /^Probe quarantined on this DevTools owner/.test(refused ?? '') && e.wt.constructed.length === 1 && pressed?.core?.generation === generationBefore
    && pressed?.failure === after.failure && live.length === 0,
    'quarantine after an automatic failure not reflected, bypassed, or dirty on destroy',
    { after: after && { status: after.status, failure: after.failure, blocked: after.blocked, canStart: after.canStart }, teardownFact, refused, constructed: e.wt.constructed.length, generationBefore, generationAfterPress: pressed?.core?.generation, liveTimers: live.length });
});
await check('probe: a SETTLED failed run still permits an immediate retry (canStart true, no blocked state)', async () => {
  const e = ownerEnv(); await settle();
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(60);
  const failed = e.host().probe;
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  return invariant(failed?.status === 'failed' && failed?.blocked === null && failed?.canStart === true && e.host().probeLastError === null && e.wt.constructed.length === 2,
    'a settled failure did not permit retry', { failed: failed && { status: failed.status, blocked: failed.blocked, canStart: failed.canStart }, refused: e.host().probeLastError, constructed: e.wt.constructed.length });
});
await check('probe: a transport whose close NEVER settles quarantines the runner — no successor, factory count stays one', async () => {
  const e = ownerEnv(); await settle(); e.wt.mode = 'hang-close';
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  e.view.onMessage.fire({ kind: 'probe.stop' }); await e.pump(10);
  e.fire(3000); await e.pump(30);                      // the runner's close bound expires: unproven release
  const after = e.host().probe;
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(20);
  return invariant(after?.status === 'failed' && /teardown/.test(after?.failure ?? '') && /already active|disposed|quarant/i.test(e.host().probeLastError ?? '') && e.wt.constructed.length === 1,
    'unsettled close did not quarantine the runner', { after, refused: e.host().probeLastError, constructed: e.wt.constructed.length });
});
await check('probe: the factory constructs exactly once with the offered protocols; a constructor error is a dial failure, never a plain retry', async () => {
  const e = ownerEnv(); await settle(); e.wt.mode = 'throw';
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 18, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config }); await e.pump(60);
  const facts = e.view.sent.filter(m => m.kind === 'frame' && m.lane === 'probe').map(m => proto.decodeMessage(m.encoded).message)
    .flatMap(m => m.kind === 'batch' ? m.events.map(ev => ev.fact) : m.kind === 'snapshot' ? m.facts.map(o => o.fact) : []);
  const dialFailure = facts.find(f => f.kind === 'failure' && f.stage === 'dial');
  return invariant(e.wt.constructed.length === 1 && e.wt.constructed[0].protocols?.[0] === 'moqt-18' && e.host().probe?.status === 'failed' && dialFailure,
    'constructor error was retried or hidden', { constructed: e.wt.constructed, status: e.host().probe?.status, failure: e.host().probe?.failure, dialFailure: !!dialFailure });
});
await check('probe: owner destruction right after an automatic failure releases the loop — no timers, no frames or states afterwards, repeatable', async () => {
  const e = ownerEnv(); await settle();
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config });
  for (let i = 0; i < 60; i++) await settle();           // the failure lands; its deferred drain is only SCHEDULED
  const failedBeforeDestroy = e.host().probe?.status;
  e.fireWindow('pagehide'); e.fireWindow('pagehide');     // destroy twice
  for (let i = 0; i < 60; i++) await settle();
  const sentAfter = e.view.sent.length;
  const live = e.timers.filter(t => t.live).map(t => t.ms);
  await e.pump(40);                                       // whatever is still live would run now
  const sentLater = e.view.sent.length;
  return invariant(failedBeforeDestroy === 'failed' && live.length === 0 && sentLater === sentAfter,
    'destroy left the failed run\'s loop alive', { failedBeforeDestroy, liveTimers: live, sentAfter, sentLater });
});
await check('probe: explicit Stop after an automatic failure finishes the local release itself', async () => {
  const e = ownerEnv(); await settle();
  const config = { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' };
  e.view.onMessage.fire({ kind: 'probe.start', config });
  for (let i = 0; i < 60; i++) await settle();
  e.view.onMessage.fire({ kind: 'probe.stop' });
  for (let i = 0; i < 60; i++) await settle();
  const live = e.timers.filter(t => t.live).map(t => t.ms);
  return invariant(e.host().probe?.status === 'failed' && live.length === 0, 'Stop after automatic failure left timers alive', { status: e.host().probe?.status, live });
});
await check('probe: a stalled view that recovers gets a fresh baseline on BOTH lanes, and a probe-lane resnapshot request refreshes the probe without a redial', async () => {
  const e = ownerEnv(); await settle(); e.wt.mode = 'hang';
  const { p, reply } = await e.attachAndBind();                                       // page lane attached
  let answered = p.sent.filter(m => m.t === 'packet').length;                          // page polls sent later are unanswered until the loop replies
  e.view.onMessage.fire({ kind: 'probe.start', config: { url: 'https://relay.example:4433/moq', namespace: ['night'], trackHints: [], draft: 22, policy: 'strict' } });
  await e.pump(30);                                                                   // probe lane: local hello + snapshot, run still dialing
  const probeFrames = () => e.view.sent.filter(m => m.kind === 'frame' && m.lane === 'probe').map(m => proto.decodeMessage(m.encoded).message.kind);
  const snapshotsBefore = probeFrames().filter(k => k === 'snapshot').length;
  assert.ok(snapshotsBefore >= 1, 'probe lane must have its baseline');
  // Adapter-driven path: the view reports a probe-lane gap.
  e.view.onMessage.fire({ kind: 'refresh', lane: 'probe' }); await e.pump(20);
  const afterLaneRefresh = probeFrames().filter(k => k === 'snapshot').length;
  // Stall the view on page traffic, then recover: both lanes must deliver a new snapshot. Two cores poll at the
  // same cadence now, so fire every due timer and answer only the PAGE core's actual polls with a batch.
  e.view.autoAck = false;
  let seq = 6;
  for (let i = 0; i < 90 && seq < 76; i++) {
    for (const t of e.timers.filter(t => t.live && t.ms <= 250)) { t.live = false; t.fn(); }
    await settle();
    const n = p.sent.filter(m => m.t === 'packet').length;
    if (n > answered) { answered = n; reply([{ ...fixtures.batchFixture, target: { ...fixtures.fixtureTarget, ownerId: OWNER }, fromSeq: String(seq), toSeq: String(seq), events: [{ ...fixtures.batchFixture.events[0], seq: String(seq) }] }]); seq++; await settle(); }
  }
  const pageReqBefore = e.requests(p).length; const probeSnapsBefore = probeFrames().filter(k => k === 'snapshot').length;
  e.view.onMessage.fire({ kind: 'ack', frames: 64, host: true }); await settle();
  e.view.onMessage.fire({ kind: 'ack', stalled: true }); await e.pump(30);
  const pageRefreshed = e.requests(p).slice(pageReqBefore).includes('snapshot.request');
  const probeRefreshed = probeFrames().filter(k => k === 'snapshot').length > probeSnapsBefore;
  return invariant(afterLaneRefresh === snapshotsBefore + 1 && pageRefreshed && probeRefreshed && e.wt.constructed.length === 1,
    'lane recovery incomplete or a redial happened', { snapshotsBefore, afterLaneRefresh, pageRefreshed, probeRefreshed, constructed: e.wt.constructed.length,
      pageCore: { phase: e.host().core?.phase, reason: e.host().core?.reason }, pageRequests: e.requests(p).slice(-6), seqReached: seq, frames: e.view.sent.filter(m => m.kind === 'frame').length, stalled: e.view.sent.filter(m => m.kind === 'stalled').length });
});
await check('probe: an invalid config is refused before any transport is constructed', async () => {
  const e = ownerEnv(); await settle();
  e.view.onMessage.fire({ kind: 'probe.start', config: { url: 'https://user:pw@relay.example/moq', namespace: ['x'], draft: 22 } }); await settle();
  const a = e.host().probeLastError;
  e.view.onMessage.fire({ kind: 'probe.start', config: { url: 'https://relay.example/moq', namespace: ['x'], draft: 21 } }); await settle();
  const b = e.host().probeLastError;
  return invariant(a && b && e.wt.constructed.length === 0 && e.host().probe === null, 'invalid probe config reached the transport', { a, b, constructed: e.wt.constructed.length });
});

await check('panel visibility coalesces without changing the carrier or its lease', async () => {
  const e = ownerEnv(); await settle();
  assert.equal(e.host().panelVisible, false);
  e.panelShown.fire(); await settle(); assert.equal(e.host().panelVisible, true);
  const { p } = await e.attachAndBind();
  const target = JSON.stringify(e.host().core.target), requests = e.requests(p).length;
  e.view.autoAck = false;
  e.panelHidden.fire();
  const sent = e.view.sent.length;
  e.panelShown.fire(); e.panelHidden.fire(); e.panelShown.fire();
  assert.equal(e.view.sent.length, sent, 'unacknowledged visibility updates were not coalesced');
  e.view.onMessage.fire({ kind: 'ack', host: true });
  assert.equal(e.host().panelVisible, true);
  assert.equal(JSON.stringify(e.host().core.target), target);
  assert.equal(e.requests(p).length, requests);
  assert.equal(p.disconnected, false);
  const late = e.legit(); e.runtimeConnect.fire(late); await settle();
  assert.equal(late.sent.find(m => m.kind === 'host').panelVisible, true);
  return { visibility: e.host().panelVisible, leaseUnchanged: true, lateViewReplayed: true };
});

// Reports go to a temporary artifact directory, never into the source tree.
const out = join(await mkdtemp(join(tmpdir(), 'playa-devtools-owner-path-')), 'report.json');
await writeFile(out, JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.pass);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, report: out, results }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
