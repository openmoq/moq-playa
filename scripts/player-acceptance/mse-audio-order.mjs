/** Native MSE audio-order PCM gate.
 * Node 24+: node scripts/player-acceptance/mse-audio-order.mjs
 * Optional: --out <new-directory>, --native-diagnostic, --zero-window-control.
 * --quantum-diagnostic measures two plain-native contexts without qualification.
 * PLAYER_TEST_BROWSER selects the Playwright channel (default chrome).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAudioOrderFixture } from './mse-audio-order.fixture.mjs';
import { activePcmSpan, assessAudioOrder, PCM_TOLERANCE_SAMPLES } from './mse-audio-order.assessment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const i = process.argv.indexOf('--out');
const output = i < 0 ? join(root, 'reports/player-acceptance', `mse-audio-order-${Date.now()}-${randomUUID().slice(0, 8)}`) : resolve(process.argv[i + 1]);
const browserChannel = process.env.PLAYER_TEST_BROWSER ?? 'chrome';
const diagnosticOnly = process.argv.includes('--quantum-diagnostic');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const libraryFiles = ['packages/browser/src/mse-adapter.ts', 'packages/browser/src/mp4-box.ts', 'packages/browser/src/timeline-index.ts'];
const driverFiles = ['examples/_tests/player-acceptance/mse-audio-order.html', 'examples/_tests/player-acceptance/mse-audio-order.ts',
  'examples/_tests/player-acceptance/mse-audio-order.worklet.js', 'scripts/player-acceptance/mse-audio-order.fixture.mjs',
  'scripts/player-acceptance/mse-audio-order.assessment.mjs', 'scripts/player-acceptance/mse-audio-order.mjs'];
const snapshot = async () => ({ head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files: Object.fromEntries(await Promise.all(libraryFiles.map(async file => [file, hash(await readFile(join(root, file)))]))) });
const bounded = async (promise, ms, name) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: timeout`)), ms); })]); }
  finally { clearTimeout(timer); }
};
// Never overwrite an earlier receipt, including a failed setup or red control.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const result = { root, node: process.version, platform: `${process.platform}/${process.arch}`, cases: [],
  browserChannel, browserIsolation: 'fresh-process-per-case', diagnosticOnly, runtimeQualified: false,
  pageErrors: [], console: [], blockedRequests: [], sourceBefore: await snapshot(), driverHashes: {} };
let server;
try {
  await mkdir(join(output, 'driver-source'));
  for (const file of driverFiles) {
    const bytes = await readFile(join(root, file)); result.driverHashes[file] = hash(bytes);
    await writeFile(join(output, 'driver-source', file.replaceAll('/', '__')), bytes);
  }
  result.fixture = await prepareAudioOrderFixture(root, join(output, 'fixture'));
  const fixture = { ...result.fixture, init: await readFile(join(output, 'fixture/init.mp4'), 'base64'),
    data: await Promise.all(result.fixture.frames.map(frame => readFile(join(output, 'fixture', frame.file), 'base64'))) };
  const { createServer } = await import(createRequire(join(root, 'examples/package.json')).resolve('vite'));
  const { chromium } = createRequire(join(root, 'package.json'))('playwright');
  result.playwrightVersion = createRequire(join(root, 'package.json'))('playwright/package.json').version;
  server = await createServer({ configFile: false, root: join(root, 'examples'), cacheDir: join(output, 'vite-cache'),
    server: { host: '127.0.0.1', hmr: false, fs: { allow: [root] } }, optimizeDeps: { noDiscovery: true, include: [] } });
  await bounded(new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.listen(0, '127.0.0.1', resolve); }), 5000, 'localhost listen');
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`; result.origin = origin;
  const kinds = diagnosticOnly ? ['in-order', 'in-order-repeat'] : ['in-order', 'in-order-repeat', 'candidate', 'omitted-tail',
    ...(process.argv.includes('--zero-window-control') ? ['zero-window'] : []),
    ...(process.argv.includes('--native-diagnostic') ? ['native-reordered'] : [])];
  for (const kind of kinds) {
    let browser, context, row;
    const runtime = { browserChannel, browserClosed: false, contextClosed: false, cleanupErrors: [] };
    try {
      browser = await chromium.launch({ channel: browserChannel, args: ['--enable-automation'], timeout: 15000 });
      runtime.browser = browser.version();
      const cdp = await browser.newBrowserCDPSession();
      try {
        const command = await cdp.send('Browser.getBrowserCommandLine');
        runtime.browserExecutable = command.arguments[0];
        assert.ok(typeof runtime.browserExecutable === 'string' && runtime.browserExecutable.length > 0, 'actual browser executable was not reported');
        runtime.browserRuntime = await cdp.send('Browser.getVersion');
      } finally { await cdp.detach(); }
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin === origin) await route.continue();
        else { result.blockedRequests.push({ kind, url: route.request().url() }); await route.abort('blockedbyclient'); }
      });
      const page = await context.newPage();
      page.on('pageerror', error => result.pageErrors.push({ kind, error: String(error) }));
      page.on('console', message => result.console.push({ kind, type: message.type(), text: message.text() }));
      await page.goto(`${origin}/_tests/player-acceptance/mse-audio-order.html`, { timeout: 10000 });
      await page.waitForFunction(() => !!window.mseAudioOrder, { timeout: 5000 });
      const prepared = await bounded(page.evaluate(({ kind, fixture }) => window.mseAudioOrder.prepare(kind, fixture), { kind, fixture }), 15000, `${kind} preparation`);
      if (!prepared.ready) row = prepared;
      else {
        await page.click('#pcm-start', { timeout: 5000 }); // Actual DOM activation, after native EOS.
        row = await bounded(page.evaluate(async () => {
          if (!window.mseAudioOrderCapture.done) throw new Error('native click did not start PCM');
          return await window.mseAudioOrderCapture.done;
        }), 15000, `${kind} PCM`);
      }
      if (row.pcmBase64 !== undefined) {
        assert.ok(row.pcmBase64.length <= Math.ceil(256000 / 3) * 4, 'PCM base64 byte cap');
        const pcm = Buffer.from(row.pcmBase64, 'base64'); delete row.pcmBase64;
        row.pcmBytes = pcm.length; row.pcmSha256 = hash(pcm); row.pcmFile = `${kind}.f32le`;
        await writeFile(join(output, row.pcmFile), pcm); row.active = activePcmSpan(pcm);
      }
    } catch (error) { row = { kind, failure: String(error), assertions: [] }; }
    finally {
      try { if (context) { await context.close(); runtime.contextClosed = true; } }
      catch (error) { runtime.cleanupErrors.push(String(error)); }
      try { if (browser) { await browser.close(); runtime.browserClosed = true; } }
      catch (error) { runtime.cleanupErrors.push(String(error)); }
    }
    Object.assign(row, runtime);
    const caseFailures = assessAudioOrder([row]).failures.filter(failure => failure.startsWith(`${kind}:`));
    if (result.pageErrors.some(error => error.kind === kind)
        || result.console.some(message => message.kind === kind && ['error', 'warn', 'warning'].includes(message.type))
        || result.blockedRequests.some(request => request.kind === kind)) caseFailures.push('runtime errors/warnings or blocked requests');
    if (runtime.cleanupErrors.length || !runtime.browserClosed || !runtime.contextClosed) caseFailures.push('case cleanup incomplete');
    const reference = result.cases.find(entry => entry.kind === 'in-order')?.active?.span;
    if (['in-order-repeat', 'candidate'].includes(kind) && !(Math.abs(reference - row.active?.span) <= PCM_TOLERANCE_SAMPLES)) caseFailures.push('PCM span differs from healthy by more than 16 samples');
    if (['omitted-tail', 'zero-window'].includes(kind) && !(Math.abs(reference - row.active?.span - 1024) <= PCM_TOLERANCE_SAMPLES)) caseFailures.push('negative control did not separate by 1024 samples');
    if (!row.failure && caseFailures.length) row.failure = caseFailures.join('; ');
    row.caseFailures = caseFailures;
    result.cases.push(row);
    console.log(JSON.stringify({ kind, active: row.active, nativeOrder: row.nativeOrder,
      failedAssertions: row.assertions?.filter(assertion => !assertion.passed), failure: row.failure }));
    if (row.failure) { result.stoppedAfter = kind; break; }
  }
  if (!diagnosticOnly) result.assessment = assessAudioOrder(result.cases);
} catch (error) { result.setupFailure = error.stack ?? String(error); }
finally {
  try { await server?.close(); }
  catch (error) { result.cleanupFailure = String(error); }
  result.sourceAfter = await snapshot();
  result.sourceUnchanged = JSON.stringify(result.sourceBefore) === JSON.stringify(result.sourceAfter);
  result.driverUnchanged = (await Promise.all(driverFiles.map(async file => hash(await readFile(join(root, file))) === result.driverHashes[file]))).every(Boolean);
  const runtimeWarnings = result.console.filter(message => ['error', 'warn', 'warning'].includes(message.type));
  result.passed = !diagnosticOnly && !result.setupFailure && !result.cleanupFailure && result.assessment?.passed === true
    && result.pageErrors.length === 0 && runtimeWarnings.length === 0 && result.blockedRequests.length === 0
    && result.sourceUnchanged && result.driverUnchanged;
  result.disposition = result.setupFailure ? 'SETUP FAILURE: no qualification'
    : diagnosticOnly ? 'DIAGNOSTIC ONLY: runtime candidate unqualified'
    : !result.sourceUnchanged || !result.driverUnchanged ? 'INVALID RUN: source changed during measurement'
      : result.passed ? 'PASS: candidate PCM span and native byte order match healthy controls'
        : 'FAIL: inspect mandatory controls, native identity, capture integrity and runtime errors';
  result.runtimeQualified = result.passed;
  await writeFile(join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, passed: result.passed, disposition: result.disposition,
    assessment: result.assessment, setupFailure: result.setupFailure, sourceUnchanged: result.sourceUnchanged }));
  if (!result.passed) process.exitCode = 1;
}
