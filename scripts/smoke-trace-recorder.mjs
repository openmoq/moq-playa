#!/usr/bin/env node
// Exercise the published recorder entry point without importing the player.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'playa-recorder-entry-')));
try {
  await mkdir(join(temporary, 'node_modules/@openmoq'), { recursive: true });
  await symlink(join(root, 'packages/transport'), join(temporary, 'node_modules/@openmoq/transport'), 'dir');
  await writeFile(join(temporary, 'package.json'), '{"type":"module","private":true}\n');
  const entry = join(temporary, 'recorder.mjs');
  await writeFile(entry, `export { TraceRecorder, formatLogMessage, PLAYA_EVENT_SCHEMA } from '@openmoq/transport/trace-recorder';\n`);
  const outDir = join(temporary, 'dist');
  await build({
    entry: [entry], outDir, platform: 'browser', format: ['esm'], target: 'es2022',
    bundle: true, noExternal: [/.*/], metafile: true, config: false,
    silent: true, outExtension: () => ({ js: '.mjs' }),
  });
  const graph = JSON.parse(await readFile(join(outDir, 'metafile-esm.json'), 'utf8'));
  const inputs = await Promise.all(Object.keys(graph.inputs).map(file => realpath(resolve(file))));
  assert(inputs.length > 1, 'the dependency graph must include the recorder implementation');
  for (const file of inputs) {
    assert(file === entry || file.startsWith(join(root, 'packages/transport/dist/qlog') + '/'),
      `recorder imported outside its qlog leaf: ${file}`);
  }
  for (const output of Object.values(graph.outputs)) {
    assert.equal(output.imports.length, 0, 'the standalone recorder must not leave external runtime imports');
  }

  const { TraceRecorder, formatLogMessage, PLAYA_EVENT_SCHEMA } = await import(pathToFileURL(join(outDir, 'recorder.mjs')).href);
  let clockReads = 0;
  const recorder = new TraceRecorder({
    clock: { clock_id: 'smoke', clock_type: 'monotonic', now: () => ++clockReads },
    runId: 'standalone', eventSchemas: ['https://example.test/102026/example'],
    limits: { denseMaxEvents: 2 },
  });
  recorder.record('example:ignored', {});
  assert.equal(clockReads, 0, 'disabled recording must not read the clock');
  recorder.start();
  for (let i = 0; i < 3; i++) recorder.record('example:sample', { i });
  recorder.stop();
  const records = recorder.dump().split('\x1e').filter(text => text.trim()).map(text => JSON.parse(text));
  assert.equal(records[0].file_schema, 'urn:ietf:params:qlog:file:sequential');
  assert(records[0].trace.event_schemas.includes(PLAYA_EVENT_SCHEMA));
  assert.deepEqual(records.filter(r => r.name === 'example:sample').map(r => r.data.i), [1, 2]);
  assert.equal(records.find(r => r.name === 'playa:trace_window').data.dense.evicted_events, 1);
  assert.equal(formatLogMessage('value', ['ready'], 100), 'value ready');
  console.log('Standalone recorder: browser bundle stays within qlog; disabled capture, retention and serialization pass');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
