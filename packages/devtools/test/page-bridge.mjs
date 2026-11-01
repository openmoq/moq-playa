import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { chromium } = createRequire(join(root, 'package.json'))('playwright');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--mutate-receipt')) throw new Error('Unknown browser gate option');
const mutateReceipt = args.includes('--mutate-receipt');
const artifact = await mkdtemp(join(tmpdir(), 'playa-devtools-page-bridge-'));
const files = new Map();
const hash = createHash('sha256');
for (const [route, folder] of [['/devtools/', 'devtools'], ['/protocol/', 'devtools-protocol']]) {
  const dist = join(root, 'packages', folder, 'dist');
  for (const name of (await readdir(dist)).filter(name => name.endsWith('.js')).sort()) {
    let bytes = await readFile(join(dist, name));
    if (mutateReceipt && route === '/devtools/' && name === 'carrier.js') {
      const original = bytes.toString();
      const needle = 'if (p.receipt !== this.receipt) {';
      assert.equal(original.split(needle).length, 2, 'Mutation target drifted');
      bytes = Buffer.from(original.replace(needle, 'if (false) {'));
    }
    files.set(route + name, bytes); hash.update(route + name); hash.update(bytes);
  }
}
const buildHash = hash.digest('hex');
const html = `<!doctype html><title>Playa diagnostic bridge gate</title>
<script type="importmap">{"imports":{"@openmoq/devtools-protocol":"/protocol/index.js"}}</script>
<script type="module">
import * as api from '/devtools/index.js';
import * as protocol from '/protocol/index.js';
import * as fixtures from '/protocol/fixtures.js';
window.fixture = { ...api, ...protocol, ...fixtures };
</script>`;
const child = `<!doctype html><script>
addEventListener('message', event => {
  if (event.data?.kind === 'attempt' && event.ports.length === 1)
    parent.postMessage(event.data.message, location.origin, [event.ports[0]]);
});
</script>`;
const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/child') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(req.url === '/' ? html : child); return;
  }
  const bytes = files.get(req.url);
  if (!bytes) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(bytes);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
let errorCount = 0;
const errors = [];
const report = { passed: false, buildHash, mutation: mutateReceipt ? 'receipt-check-disabled' : null, cases: [], errors };
try {
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  const page = await browser.newPage();
  const recordError = value => { errorCount++; if (errors.length < 50) errors.push(String(value).slice(0, 300)); };
  page.on('pageerror', recordError);
  page.on('console', message => { if (message.type() === 'error') recordError(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => Boolean(window.fixture));
  await page.exposeFunction('bridgeCheckpoint', name => {
    assert.equal(typeof name, 'string');
    assert.ok(name.length <= 200 && report.cases.length < 32);
    report.cases.push(name);
  });
  await page.evaluate(async () => {
    const f = window.fixture;
    const clients = [];
    let bridge;
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const common = { channel: 'openmoq-devtools', version: f.PROTOCOL_VERSION };
    const changes = [];
    const capture = new f.DiagnosticCapture({ source: { ...f.fixtureSource, kind: 'attached', exposure: 'production' },
      clock: { id: 'page-performance', now: () => performance.now() }, onActiveChange: active => changes.push(active) });
    const registry = new f.DiagnosticRegistry(); const revoke = registry.register(capture);
    function client(ownerId) {
      const { port1, port2 } = new MessageChannel();
      const queued = [];
      let pending = null;
      port2.onmessage = event => {
        if (pending) { const resolve = pending; pending = null; resolve(event.data); }
        else queued.push(event.data);
      };
      const discover = f.encodeMessage({ ...common, kind: 'discover', requestId: 'discover', ownerId });
      const value = {
        ownerId, port1, port2, queued, discover, receipt: null, target: null,
        send(packet) { port2.postMessage(f.encodeCarrierRequest(packet)); },
        async next(timeoutMs = 3000) {
          let timer;
          try {
            const encoded = queued.length ? queued.shift() : await Promise.race([
              new Promise(resolve => { pending = resolve; }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out awaiting carrier reply')), timeoutMs); }),
            ]);
            const decoded = f.decodeCarrierReply(encoded);
            expect(decoded.ok, 'Invalid carrier envelope');
            const packet = decoded.packet;
            if (packet.kind === 'reply') {
              value.receipt = packet.receipt;
              packet.decoded = packet.frames.map(frame => {
                const result = f.decodeMessage(frame); expect(result.ok, 'Invalid inner frame'); return result.message;
              });
            }
            return packet;
          } finally { clearTimeout(timer); pending = null; }
        },
        async command(message) { value.send({ kind: 'request', receipt: value.receipt, message: f.encodeMessage(message) }); return value.next(); },
        async poll() { value.send({ kind: 'poll', receipt: value.receipt }); return value.next(); },
        async bind() {
          const packet = await value.command({ ...common, kind: 'attach', requestId: 'attach', target: {
            ownerId, sourceId: f.fixtureSource.sourceId, runId: f.fixtureSource.runId } });
          expect(packet.kind === 'reply' && packet.decoded[0]?.kind === 'snapshot', 'Missing attachment snapshot');
          value.target = packet.decoded[0].target; return packet;
        },
        close() { port2.close(); },
      };
      clients.push(value); return value;
    }
    const bootstrap = async owner => {
      const c = client(owner); window.postMessage(c.discover, location.origin, [c.port1]);
      const first = await c.next();
      expect(first.kind === 'reply' && first.decoded[0]?.kind === 'hello', 'Missing private hello');
      return c;
    };
    let broadcastReply = false;
    const watch = event => { if (f.decodeCarrierReply(event.data).ok) broadcastReply = true; };
    window.addEventListener('message', watch);
    try {
      const hidden = client('unexposed'); window.postMessage(hidden.discover, location.origin, [hidden.port1]);
      await wait(50); expect(hidden.queued.length === 0 && !capture.active, 'Unexposed source answered'); hidden.close();
      await window.bridgeCheckpoint('unexposed source stays silent');

      bridge = f.installDiagnosticBridge(registry, { idleTimeoutMs: 1000 });
      const a = await bootstrap('reader');
      expect(!capture.active && changes.length === 0, 'Discovery activated observers');
      expect(!broadcastReply, 'Reply leaked onto window');
      await a.bind(); expect(capture.active, 'Attach failed to activate');
      capture.emit(f.snapshotFixture.facts[3].fact, 'dense');
      const refreshed = await a.command({ ...common, kind: 'snapshot.request', requestId: 'refresh', target: a.target, scope: { kind: 'source' } });
      expect(refreshed.decoded.map(x => x.kind).join(',') === 'batch,snapshot', 'Refresh reordered or dropped its batch');
      const cursor = f.cursorFromSnapshot(refreshed.decoded[1]); expect(cursor.watermark === '1', 'Wrong refresh watermark');
      await window.bridgeCheckpoint('private MessageChannel hello, attach and ordered two-frame refresh');

      const duplicate = client('reader'); window.postMessage(duplicate.discover, location.origin, [duplicate.port1]);
      expect((await duplicate.next()).reason === 'bridge-unavailable', 'Duplicate owner admitted');
      expect(capture.active, 'Duplicate owner killed existing lease');
      await window.bridgeCheckpoint('duplicate owner refused without takeover');

      const oldReceipt = a.receipt; await a.poll(); a.send({ kind: 'poll', receipt: oldReceipt });
      expect((await a.next()).reason === 'invalid-receipt', 'Replayed receipt accepted');
      expect(!capture.active, 'Replayed receipt retained observer');
      await window.bridgeCheckpoint('replayed credit closes and releases observer');

      const b = await bootstrap('reader'); await b.bind();
      expect(b.target.attachmentId !== a.target.attachmentId, 'Rebootstrap reused attachment');
      b.send({ kind: 'close' }); expect((await b.next()).reason === 'owner-closed', 'Explicit close swallowed');
      expect(!capture.active, 'Explicit close retained observer');
      await window.bridgeCheckpoint('same owner, fresh channel and attachment after terminal close');

      const frame = document.createElement('iframe'); frame.src = '/child'; document.body.append(frame);
      await new Promise(resolve => frame.onload = resolve);
      const foreign = client('child-reader');
      frame.contentWindow.postMessage({ kind: 'attempt', message: foreign.discover }, location.origin, [foreign.port1]);
      await wait(75);
      expect(foreign.queued.length === 0 && !capture.active, 'Child frame acquired top-level source');
      foreign.close(); frame.remove(); await window.bridgeCheckpoint('same-origin child-window discovery refused');

      const hiddenPage = await bootstrap('reader'); await hiddenPage.bind();
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      expect((await hiddenPage.next()).reason === 'page-hidden', 'Pagehide did not deliver terminal close');
      expect(!capture.active, 'Pagehide retained observer');
      // This exercises the pagehide handler; it is not a real bfcache navigation proof.
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      const restored = await bootstrap('reader'); await restored.bind();
      bridge.dispose(); expect((await restored.next()).reason === 'bridge-disposed', 'Uninstall lost its terminal packet');
      expect(!capture.active, 'Uninstall retained observer');
      await window.bridgeCheckpoint('explicit pagehide/pageshow and uninstall lifecycle events');

      bridge = f.installDiagnosticBridge(registry, { idleTimeoutMs: 250 });
      const idle = await bootstrap('reader'); await idle.bind();
      expect((await idle.next()).reason === 'idle-timeout', 'Idle reader did not expire');
      expect(!capture.active, 'Timer expiry retained observer');
      const reopened = await bootstrap('reader'); await reopened.bind();
      revoke(); const withdrawal = await reopened.poll();
      expect(withdrawal.decoded[0]?.kind === 'error' && withdrawal.decoded[0].requestId === 'attach'
        && withdrawal.decoded[0].code === 'not-found', 'Withdrawal disappeared on polling');
      expect(!capture.active, 'Withdrawal retained observer');
      reopened.send({ kind: 'close' }); await reopened.next();
      await window.bridgeCheckpoint('real idle timer, rebootstrap and polling withdrawal');
      expect(!broadcastReply, 'Carrier reply appeared on window');
      expect(changes.filter(x => x).length === changes.filter(x => !x).length, 'Unbalanced capture activation');
      return null;
    } finally {
      bridge?.dispose(); registry.dispose(); capture.dispose();
      window.removeEventListener('message', watch);
      for (const c of clients) c.close();
    }
  });
  assert.equal(errorCount, 0, 'Browser errors occurred');
  assert.equal(report.cases.length, 8, 'Browser gate did not execute all cases');
  report.passed = true;
} catch (error) {
  report.failure = String(error).slice(0, 2000); process.exitCode = 1;
} finally {
  await browser?.close();
  report.errorCount = errorCount;
  if (errorCount > 0) {
    report.passed = false; process.exitCode = 1; report.failure ??= 'Browser errors occurred';
  }
  await new Promise(resolve => server.close(resolve));
  await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, buildHash, artifact, failure: report.failure }));
}
