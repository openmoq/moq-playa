// Bundles the panel (which imports the shared protocol package through the
// workspace link) and copies the static extension files into dist/, which is
// what gets loaded unpacked.
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(here, 'static'), dist, { recursive: true });
const shared = { bundle: true, target: ['chrome120'], platform: 'browser', logLevel: 'warning' };
// The panel is a module page; the DevTools document and the content relay are
// classic scripts (a content script injected by scripting.executeScript must be).
await build({ ...shared, entryPoints: [resolve(here, 'src/panel.js')], format: 'esm', outfile: resolve(dist, 'panel.js') });
await build({ ...shared, entryPoints: [resolve(here, 'src/owner.js')], format: 'iife', outfile: resolve(dist, 'devtools.js') });
await build({ ...shared, entryPoints: [resolve(here, 'src/relay.js')], format: 'iife', outfile: resolve(dist, 'relay.js') });
console.log('built', dist);
