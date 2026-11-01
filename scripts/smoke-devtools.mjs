#!/usr/bin/env node
// Prove optional-tooling inclusion with the built consumer import graphs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const temp = await realpath(await mkdtemp(join(tmpdir(), 'playa-devtools-inclusion-')));
try {
  await mkdir(join(temp, 'node_modules/@openmoq'), { recursive: true });
  for (const name of ['playa', 'devtools', 'player']) await symlink(join(root, 'packages', name), join(temp, 'node_modules/@openmoq', name), 'dir');
  async function arm(name, contents) {
    const entry = join(temp, `${name}.mjs`), outDir = join(temp, name);
    await writeFile(entry, contents);
    await build({ entry: [entry], outDir, platform: 'browser', format: ['esm'], target: 'es2022', bundle: true,
      noExternal: [/.*/], metafile: true, minify: true, config: false, silent: true, outExtension: () => ({js:'.mjs'}) });
    const graph = JSON.parse(await readFile(join(outDir, 'metafile-esm.json'), 'utf8'));
    const inputs = await Promise.all(Object.keys(graph.inputs).map(file => realpath(resolve(file))));
    for (const output of Object.values(graph.outputs)) assert.equal(output.imports.length, 0, 'browser bundle left runtime imports');
    return { inputs, output: join(outDir, `${name}.mjs`) };
  }
  const normal = await arm('normal', "export { Player } from '@openmoq/playa';\n");
  assert(normal.inputs.some(file => file.includes('/packages/playa/')), 'normal arm must include the actual player');
  assert(!normal.inputs.some(file => /\/packages\/devtools(?:-protocol|-probe)?\//.test(file)), 'normal Playa imported diagnostic code');
  assert(!normal.inputs.some(file => file.endsWith('/packages/player/dist/media-diagnostics.js')), 'normal player imported optional media tracker');
  const tracker = await arm('tracker', "export { createMediaDiagnostics } from '@openmoq/player/diagnostics';\n");
  assert(tracker.inputs.some(file => file.endsWith('/packages/player/dist/media-diagnostics.js')), 'tracker arm must include actual implementation');
  assert.deepEqual(tracker.inputs.filter(file => !file.startsWith(temp + '/')),
    [join(root, 'packages/player/dist/media-diagnostics.js')], 'optional tracker leaf must have no runtime dependencies beyond the consumer entry');
  const optional = await arm('optional', "export { installPlayerDiagnostics } from '@openmoq/devtools/player';\n");
  assert(optional.inputs.some(file => file.endsWith('/packages/devtools/dist/player.js')), 'optional arm must include the real adapter');
  for (const file of optional.inputs) assert(file === join(root, 'packages/player/dist/media-diagnostics.js') || !/\/packages\/(player|playa|playback|browser|webtransport|devtools-probe)\//.test(file),
    `optional adapter imported player, rendering or connection factory runtime: ${file}`);
  const adapter = await import(pathToFileURL(optional.output).href);
  assert.equal(typeof adapter.installPlayerDiagnostics, 'function');
  console.log(`DevTools inclusion: ${normal.inputs.length} normal inputs, zero optional devtools packages or media tracker; ${optional.inputs.length} optional inputs, only the optional tracker leaf, no player/rendering/Probe/connection factory runtime; inert import`);
} finally { await rm(temp, {recursive:true,force:true}); }
