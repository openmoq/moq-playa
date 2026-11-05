import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, readdir, realpath, symlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareFixture } from './fixture.mjs';
import { stopProcess } from './shutdown.mjs';
import { parseTailCampaignArgs, validateTailManifest, assertTailManifest, isTailHarnessFile, isTailSupportFile,
  copyTailTestFiles, checkTailTestGraph } from './group-tail-cli.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const options = parseTailCampaignArgs(process.argv.slice(2));
const artifacts = resolve(options.artifacts ?? join(tmpdir(), `playa-group-tail-${randomUUID().slice(0, 8)}`));
const original = join(artifacts, 'original-main');
const namespace = `tail-${randomUUID().slice(0, 8)}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const children = [];
const result = { originalRef: options.originalRef, root, original, namespace, arms: [], commands: [], passed: false, errors: [],
  scope: 'CMAF receiving-stream and accepted-transform tail retention; native freeze recovery is not qualified by this case.' };
const abort = new AbortController();
const interrupted = () => abort.abort(new Error('Tail campaign interrupted'));
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
await mkdir(artifacts, { recursive: true });
console.log(`Tail campaign: ${artifacts}`);

async function manifest(directory, env = {}) {
  const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: directory, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }, maxBuffer: 16 * 1024 * 1024,
  });
  const files = [];
  for (const path of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    try { files.push({ path, sha256: sha(await readFile(join(directory, path))) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files.push({ path, deleted: true }); }
  }
  const harness = files.filter(file => isTailHarnessFile(file.path)), support = files.filter(file => isTailSupportFile(file.path));
  const production = files.filter(file => !isTailHarnessFile(file.path) && !isTailSupportFile(file.path));
  return { files, jointSha256: sha(`${JSON.stringify(files, null, 2)}\n`), production, harness, support,
    supportSha256: sha(`${JSON.stringify(support, null, 2)}\n`), productionSha256: sha(`${JSON.stringify(production, null, 2)}\n`),
    harnessSha256: sha(`${JSON.stringify(harness, null, 2)}\n`) };
}
async function stopOwned(state) {
  if (state.stopPromise) return state.stopPromise;
  if (state.exited) return;
  state.stopPromise = (async () => {
    if (!state.cooperative) { await stopProcess(state); return; }
    // The runner owns page/transport/browser cleanup. Do not let Playwright's
    // signal handler close Chrome before the page can settle caller-held closed.
    state.stopRequested = true;
    try { process.platform === 'win32' ? state.child.kill('SIGTERM') : process.kill(-state.child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    let timer;
    try {
      await Promise.race([state.done, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned runner cleanup exceeded fixed 20000ms bound')), 20000);
      })]);
    } catch (error) { await stopProcess(state); throw error; }
    finally { clearTimeout(timer); }
  })();
  return state.stopPromise;
}
async function command(name, executable, args, cwd = root, env = {}, timeoutMs = 120000) {
  if (abort.signal.aborted) throw abort.signal.reason;
  const child = spawn(executable, args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, exited: false, exitCode: null, exitSignal: null, failure: null,
    cooperative: args[0] === 'scripts/player-acceptance/run.mjs' };
  children.push(state);
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => chunks.push(bytes));
  state.done = new Promise(resolve => {
    child.once('error', error => { state.failure = error.message; });
    child.once('close', (code, signal) => { state.exited = true; state.exitCode = code; state.exitSignal = signal; resolve(); });
  });
  let timeout;
  const cancel = () => { void stopOwned(state).catch(error => result.errors.push(error.message)); };
  abort.signal.addEventListener('abort', cancel, { once: true });
  try {
    await Promise.race([state.done, new Promise((_, reject) => {
      timeout = setTimeout(() => { cancel(); reject(new Error(`${name}: exceeded fixed ${timeoutMs}ms bound`)); }, timeoutMs);
    })]);
    if (abort.signal.aborted) throw abort.signal.reason;
    return { code: state.exitCode, signal: state.exitSignal, text: Buffer.concat(chunks).toString() };
  } finally {
    clearTimeout(timeout); abort.signal.removeEventListener('abort', cancel);
    if (!state.exited) await stopOwned(state);
    await writeFile(join(artifacts, `${name}.log`), Buffer.concat(chunks));
    result.commands.push({ name, executable, args, cwd, pid: child.pid, code: state.exitCode, signal: state.exitSignal, failure: state.failure });
  }
}
async function must(name, executable, args, cwd = root, env = {}) {
  const run = await command(name, executable, args, cwd, env);
  assert.equal(run.code, 0, `${name}: ${run.text.slice(-3000)}`); return run;
}

/** External dependencies are reused; every workspace dependency resolves inside the private copy. */
async function moduleLinks(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '@openmoq') {
      const scope = join(target, entry.name); await mkdir(scope, { recursive: true });
      for (const name of await readdir(join(source, entry.name))) {
        const sourcePath = join(source, entry.name, name);
        const packageName = JSON.parse(await readFile(join(sourcePath, 'package.json'), 'utf8')).name;
        const packageDirectories = await readdir(join(original, 'packages'));
        let workspace;
        for (const directory of packageDirectories) {
          const json = await readFile(join(original, 'packages', directory, 'package.json'), 'utf8').catch(() => null);
          if (json && JSON.parse(json).name === packageName) { workspace = join(original, 'packages', directory); break; }
        }
        await symlink(workspace ?? await realpath(sourcePath), join(scope, name));
      }
    } else await symlink(await realpath(join(source, entry.name)), join(target, entry.name));
  }
}
async function ensureNative() {
  const name = '@fails-components/webtransport-transport-http3-quiche';
  const target = await realpath(join(root, 'examples/node-relay/node_modules', name));
  const installed = join(target, 'build/Release/webtransport.node');
  const existing = await readFile(installed).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  const json = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  assert.equal(json.version, '1.6.8');
  if (existing) { result.nativeBinding = { version: json.version, path: installed, sha256: sha(existing), reusedInstalled: true, napi: process.versions.napi }; return; }
  const donorOption = options.nativeDonor;
  if (!donorOption) throw new Error(`Missing installed native binding: ${installed}. Install the package normally, or supply a matching --native-donor for a byte-matched darwin-arm64 1.6.8 binding.`);
  assert.equal(process.platform, 'darwin', 'Explicit offline donor reuse supports only darwin-arm64'); assert.equal(process.arch, 'arm64');
  const donorRoot = resolve(donorOption);
  const compared = [];
  for (const pkg of ['@fails-components/webtransport', name]) {
    for (const file of ['package.json', pkg === name ? 'lib/index.js' : 'lib/index.node.js']) {
      const receiver = await realpath(join(root, 'examples/node-relay/node_modules', pkg));
      const donor = await realpath(join(donorRoot, 'examples/node-relay/node_modules', pkg));
      const [a, b] = await Promise.all([readFile(join(receiver, file)), readFile(join(donor, file))]);
      assert.ok(a.equals(b), `${pkg}/${file}: native donor differs`);
      compared.push({ package: pkg, file, sha256: sha(a) });
    }
  }
  const donor = join(await realpath(join(donorRoot, 'examples/node-relay/node_modules', name)), 'build/Release/webtransport.node');
  const binary = await readFile(donor);
  const description = (await exec('file', [donor])).stdout;
  assert.match(description, /Mach-O.*arm64/);
  assert.ok(target.startsWith(join(root, 'node_modules') + '/'), 'Native receiver must belong to this worktree');
  await mkdir(dirname(installed), { recursive: true }); await copyFile(donor, installed);
  assert.equal(sha(await readFile(installed)), sha(binary));
  result.nativeBinding = { version: '1.6.8', napi: process.versions.napi, donor, path: installed, sha256: sha(binary), description: description.trim(), compared };
}

try {
  let expected;
  if (options.expectedManifest) {
    const bytes = await readFile(resolve(options.expectedManifest));
    expected = validateTailManifest(JSON.parse(bytes));
    // Refuse a bad expected file/hash before launching Git, builds or browsers.
    const actual = [];
    for (const row of expected) {
      try { actual.push({ path: row.path, sha256: sha(await readFile(join(root, row.path))) }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; actual.push({ path: row.path, deleted: true }); }
    }
    assertTailManifest(expected, actual);
    result.expectedManifest = { path: resolve(options.expectedManifest), sha256: sha(bytes), files: expected.length };
    await writeFile(join(artifacts, 'expected-manifest.json'), `${JSON.stringify(expected, null, 2)}\n`);
  }
  result.before = await manifest(root);
  if (expected) assertTailManifest(expected, result.before.files);
  await writeFile(join(artifacts, 'joint-before.json'), `${JSON.stringify(result.before.files, null, 2)}\n`);
  await writeFile(join(artifacts, 'production-before.json'), `${JSON.stringify(result.before.production, null, 2)}\n`);
  await writeFile(join(artifacts, 'harness-files.json'), `${JSON.stringify(result.before.harness, null, 2)}\n`);
  await writeFile(join(artifacts, 'support-files.json'), `${JSON.stringify(result.before.support, null, 2)}\n`);
  const base = (await exec('git', ['rev-parse', '--verify', `${options.originalRef}^{commit}`], { cwd: root })).stdout.trim();
  result.originalCommit = base;
  await ensureNative();
  await mkdir(original, { recursive: true });
  await must('archive-original', 'git', ['archive', '--format=tar', '--output', join(artifacts, 'original-main.tar'), base]);
  await must('extract-original', 'tar', ['-xf', join(artifacts, 'original-main.tar'), '-C', original]);
  const sharedTests = [...result.before.harness, ...result.before.support];
  await copyTailTestFiles(root, original, sharedTests);
  result.dependencyGraph = {
    reworked: await checkTailTestGraph(root, sharedTests), original: await checkTailTestGraph(original, sharedTests),
  };
  await writeFile(join(artifacts, 'dependency-graphs.json'), `${JSON.stringify(result.dependencyGraph, null, 2)}\n`);
  const moduleDirectories = ['node_modules', 'examples/node_modules', 'examples/node-relay/node_modules', 'examples/node-publisher/node_modules',
    ...(await readdir(join(root, 'packages'))).map(name => `packages/${name}/node_modules`)];
  for (const path of moduleDirectories) {
    if (await realpath(join(root, path)).catch(() => null)) await moduleLinks(join(root, path), join(original, path));
  }
  const gitDir = (await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd: root })).stdout.trim();
  const oldEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: original };
  await must('build-reworked', 'pnpm', ['--filter', '@openmoq/playa...', '--filter', '@moqt/example-node-publisher...', 'build']);
  await must('build-original', 'pnpm', ['--filter', '@openmoq/playa...', '--filter', '@moqt/example-node-publisher...', 'build'], original, oldEnv);
  const fixture = join(artifacts, 'fixture');
  result.fixture = await prepareFixture(fixture, namespace, false, abort.signal);
  result.fixtureManifestSha256 = sha(await readFile(join(fixture, 'manifest.json')));
  const initial = await manifest(root);
  assert.equal(initial.productionSha256, result.before.productionSha256, 'Production changed during preparation');
  assert.equal(initial.harnessSha256, result.before.harnessSha256, 'Harness changed during preparation');
  assert.equal(initial.supportSha256, result.before.supportSha256, 'Acceptance support changed during preparation');
  for (const [source, mode] of [['reworked', 'ordinary'], ['original', 'ordinary'], ['reworked', 'held'], ['original', 'held']]) {
    const stable = await manifest(root);
    await writeFile(join(artifacts, `before-${source}-${mode}-files.json`), `${JSON.stringify(stable, null, 2)}\n`);
    assert.equal(stable.productionSha256, result.before.productionSha256, 'Frozen production changed before arm');
    assert.equal(stable.harnessSha256, result.before.harnessSha256, 'Harness changed before arm');
    assert.equal(stable.supportSha256, result.before.supportSha256, 'Acceptance support changed before arm');
    const name = `${source}-${mode}`, cwd = source === 'original' ? original : root;
    const run = await command(name, process.execPath, ['scripts/player-acceptance/run.mjs', '--skip-build', '--case', `cmaf-group-tail-${mode}`], cwd,
      { ...(source === 'original' ? oldEnv : {}), PLAYER_TEST_ARTIFACTS: join(artifacts, name), PLAYER_TAIL_FIXTURE: fixture,
        PLAYER_TAIL_NAMESPACE: namespace, PLAYER_TAIL_EXPECT_LOSS: source === 'original' && mode === 'held' ? '1' : '0' });
    const directories = await readdir(join(artifacts, name)).catch(() => []);
    const evidence = directories.length === 1 ? JSON.parse(await readFile(join(artifacts, name, directories[0], 'result.json'), 'utf8')) : null;
    result.arms.push({ name, code: run.code, artifact: directories.length === 1 ? join(artifacts, name, directories[0], 'result.json') : null, evidence });
    assert.equal(run.code, 0, `${name}: arm failed; remaining arms were not started`);
    assert.equal(evidence?.passed, true, `${name}: arm did not qualify; remaining arms were not started`);
    assert.equal(evidence.source.harnessManifestSha256, result.before.harnessSha256, `${name}: harness differs`);
    assert.equal(evidence.source.supportManifestSha256, result.before.supportSha256, `${name}: acceptance support differs`);
  }
  const fingerprints = result.arms.map(arm => arm.evidence?.source.harnessManifestSha256);
  assert.ok(fingerprints.every(value => value === result.before.harnessSha256), 'All four arms must execute identical harness bytes');
  for (const source of ['original', 'reworked']) {
    const arms = result.arms.filter(arm => arm.name.startsWith(source));
    assert.equal(arms[0].evidence?.source.productionManifestSha256, arms[1].evidence?.source.productionManifestSha256, 'Production differs between paired arms');
  }
  assert.ok(result.arms.every(arm => JSON.stringify(arm.evidence?.fixtures.moving.sha256) === JSON.stringify(result.fixture.sha256)), 'Fixture bytes differ between arms');
  result.passed = result.arms.length === 4 && result.arms.every(arm => arm.code === 0 && arm.evidence?.passed)
    && result.arms.find(arm => arm.name === 'original-held')?.evidence.cases[0].groupTail.retention.causalLoss === true;
  if (!result.passed) process.exitCode = 1;
} catch (error) { result.errors.push(error.stack ?? String(error)); process.exitCode = 1; }
finally {
  for (const child of children) try { await stopOwned(child); } catch (error) { result.errors.push(error.message); process.exitCode = 1; }
  if (result.before) try {
    result.after = await manifest(root);
    assert.equal(result.after.jointSha256, result.before.jointSha256, 'Source changed during campaign');
  } catch (error) { result.errors.push(error.message); process.exitCode = 1; }
  result.passed &&= result.errors.length === 0;
  await writeFile(join(artifacts, 'campaign.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
}
