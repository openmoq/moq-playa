/** Parse only; invalid arguments have no filesystem, Git, build, or browser side effects. */
export function parseTailCampaignArgs(argv) {
  const names = new Map([['--original-ref', 'originalRef'], ['--artifacts', 'artifacts'],
    ['--native-donor', 'nativeDonor'], ['--expected-manifest', 'expectedManifest']]);
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = names.get(argv[i]);
    if (!name) throw new Error(`Unknown tail campaign option: ${argv[i]}`);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate tail campaign option: ${argv[i]}`);
    const value = argv[i + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error(`${argv[i]} requires a value`);
    options[name] = value;
  }
  if (!options.originalRef) throw new Error('--original-ref REF is required; choose an explicit original-production baseline');
  return options;
}

export function isTailHarnessFile(path) {
  return path === 'examples/_tests/player-acceptance/main.ts' || path === 'scripts/player-acceptance/run.mjs'
    || /^scripts\/player-acceptance\/[^/]*tail[^/]*\.(mjs|d\.mts|test\.ts)$/.test(path);
}
/** Shared acceptance source needed by both the candidate and archived baseline. */
export function isTailSupportFile(path) {
  return !isTailHarnessFile(path) && /^(scripts\/player-acceptance|examples\/_tests\/player-acceptance)\/.+$/.test(path);
}

/** Overlay acceptance code only, checking the frozen bytes before and after copying. */
export async function copyTailTestFiles(source, target, rows) {
  const { readFile, mkdir, copyFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = validateTailManifest(rows);
  for (const row of files) {
    if (row.deleted || !(isTailHarnessFile(row.path) || isTailSupportFile(row.path))) {
      throw new Error(`Not an acceptance test overlay file: ${row.path}`);
    }
  }
  for (const row of files) {
    if (digest(await readFile(join(source, row.path))) !== row.sha256) throw new Error(`Acceptance source changed: ${row.path}`);
    await mkdir(dirname(join(target, row.path)), { recursive: true });
    await copyFile(join(source, row.path), join(target, row.path));
    if (digest(await readFile(join(target, row.path))) !== row.sha256) throw new Error(`Acceptance copy differs: ${row.path}`);
  }
  return files;
}

/** Link the real archived production entries and load the shared helper modules; never execute the page or runner. */
export async function checkTailTestGraph(directory, rows) {
  const { readFile, readdir, writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { join, dirname, resolve, relative, sep } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { createRequire } = await import('node:module');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { createHash } = await import('node:crypto');
  const { tmpdir } = await import('node:os');
  const require = createRequire(import.meta.url);
  const esbuild = require(require.resolve('esbuild', { paths: [dirname(require.resolve('tsup/package.json'))] }));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = validateTailManifest(rows), available = new Set(files.map(row => row.path));
  for (const row of files) {
    if (row.deleted || !(isTailHarnessFile(row.path) || isTailSupportFile(row.path))
      || digest(await readFile(join(directory, row.path))) !== row.sha256) throw new Error(`Invalid acceptance graph file: ${row.path}`);
  }
  const packages = new Map();
  for (const name of await readdir(join(directory, 'packages'))) {
    const root = join(directory, 'packages', name);
    const json = await readFile(join(root, 'package.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (json) { const pkg = JSON.parse(json); packages.set(pkg.name, { root, pkg }); }
  }
  const publicEntries = new Map();
  const plugin = { name: 'archived-public-entries', setup(build) {
    build.onResolve({ filter: /^[^./]/ }, async args => {
      if (!args.path.startsWith('@openmoq/')) return { path: args.path, external: true };
      const parts = args.path.split('/'), name = parts.slice(0, 2).join('/');
      const record = packages.get(name);
      if (!record) throw new Error(`Archived workspace package absent: ${name}`);
      const subpath = parts.length === 2 ? '.' : `./${parts.slice(2).join('/')}`;
      const entry = record.pkg.exports?.[subpath];
      const output = typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
      if (typeof output !== 'string' || !output.startsWith('./dist/') || !output.endsWith('.js')) {
        throw new Error(`Archived public runtime entry unavailable: ${args.path}`);
      }
      const path = resolve(record.root, output.replace('./dist/', './src/').replace(/\.js$/, '.ts'));
      publicEntries.set(args.path, { path: relative(directory, path).split(sep).join('/'), sha256: digest(await readFile(path)) });
      return { path };
    });
  } };
  const settings = { absWorkingDir: directory, bundle: true, write: false, metafile: true, format: 'esm',
    logLevel: 'silent', plugins: [plugin] };
  const page = await esbuild.build({ ...settings, entryPoints: ['examples/_tests/player-acceptance/main.ts'], platform: 'browser' });
  const runner = await esbuild.build({ ...settings, entryPoints: ['scripts/player-acceptance/run.mjs'], platform: 'node' });
  const helpers = ['program-switch.mjs', 'program-switch.fixture.mjs', 'mse-program-switch.mjs',
    'program-switch-observer.mjs', 'program-switch-wire-observer.mjs', 'mse-program-switch-observer.mjs'];
  const modules = await esbuild.build({ ...settings, stdin: { contents: helpers.map((name, i) =>
    `export * as helper${i} from './scripts/player-acceptance/${name}';`).join('\n'), resolveDir: directory }, platform: 'node' });
  const inputs = [...new Set([page, runner, modules].flatMap(result => Object.keys(result.metafile.inputs)))].sort();
  for (const path of inputs) {
    if ((isTailHarnessFile(path) || isTailSupportFile(path)) && !available.has(path)) throw new Error(`Acceptance graph escaped frozen overlay: ${path}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'playa-tail-module-load-'));
  try {
    const path = join(temporary, 'helpers.mjs'); await writeFile(path, modules.outputFiles[0].contents);
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      'const loaded = await import(process.argv[1]); console.log(JSON.stringify(Object.fromEntries(Object.entries(loaded).map(([key, value]) => [key, Object.keys(value)]))));',
      pathToFileURL(path).href], { cwd: directory, timeout: 10000 });
    const loaded = JSON.parse(stdout);
    if (helpers.some((_name, i) => !Array.isArray(loaded[`helper${i}`]) || loaded[`helper${i}`].length === 0)) {
      throw new Error('Shared acceptance helper did not load');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { pageLinked: true, runnerLinked: true, helperModulesLoaded: helpers,
    publicEntries: Object.fromEntries([...publicEntries].sort(([a], [b]) => a.localeCompare(b))),
    inputs, instrumentation: 'Offline link against this tree\'s actual public source entries corresponding to package runtime exports; no production aliases to other trees, stubs, page execution, or browser.' };
}

/** The same generic row format written by the campaign's joint-before.json. */
export function validateTailManifest(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Expected manifest must be a nonempty array of file/hash rows');
  const paths = new Set();
  const rows = value.map(row => {
    if (!row || typeof row !== 'object' || typeof row.path !== 'string' || !row.path
      || row.path.startsWith('/') || /^[A-Za-z]:/.test(row.path) || row.path.includes('\\')
      || row.path.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('Invalid manifest file path');
    if (paths.has(row.path)) throw new Error(`Duplicate manifest file: ${row.path}`);
    paths.add(row.path);
    const keys = Object.keys(row).sort().join(',');
    if (keys === 'deleted,path' && row.deleted === true) return { path: row.path, deleted: true };
    if (keys !== 'path,sha256' || typeof row.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(row.sha256)) {
      throw new Error(`Invalid SHA-256 manifest row: ${row.path}`);
    }
    return { path: row.path, sha256: row.sha256.toLowerCase() };
  });
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function assertTailManifest(expected, actual) {
  const want = validateTailManifest(expected), got = validateTailManifest(actual);
  if (want.length !== got.length || want.some((row, index) => row.path !== got[index].path
    || row.sha256 !== got[index].sha256 || row.deleted !== got[index].deleted)) {
    throw new Error('Expected source manifest does not match actual files and SHA-256 values');
  }
}
