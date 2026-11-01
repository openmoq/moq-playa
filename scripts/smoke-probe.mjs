#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const temp = await realpath(await mkdtemp(join(tmpdir(), 'playa-probe-bundle-')));
try {
  const entry = join(temp, 'probe.mjs');
  await writeFile(entry, `export { createProbeRunner } from ${JSON.stringify(join(root, 'packages/devtools-probe/dist/index.js'))};\n`);
  await build({ entry: [entry], outDir: join(temp, 'dist'), platform: 'browser', format: ['esm'],
    target: 'es2022', bundle: true, noExternal: [/.*/], metafile: true, config: false,
    silent: true, outExtension: () => ({ js: '.mjs' }) });
  const graph = JSON.parse(await readFile(join(temp, 'dist/metafile-esm.json'), 'utf8'));
  assert(Object.keys(graph.inputs).length > 4, 'the graph must include real runtime dependencies');
  for (const input of Object.keys(graph.inputs)) {
    const path = await realpath(resolve(input));
    assert(!/\/packages\/(player|playback|browser|playa)\//.test(path), `Probe imported rendering/player code: ${path}`);
  }
  for (const output of Object.values(graph.outputs)) assert.equal(output.imports.length, 0, 'Probe browser bundle left runtime imports');
  const mod = await import(pathToFileURL(join(temp, 'dist/probe.mjs')).href);
  assert.equal(typeof mod.createProbeRunner, 'function');
  console.log('Probe browser bundle: real transport graph, no player/rendering imports, inert import');
} finally { await rm(temp, { recursive: true, force: true }); }
