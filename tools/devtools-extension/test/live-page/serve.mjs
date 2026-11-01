// Vite dev server for the live-gate page: repo root so this directory is
// servable, `examples/vite.config.ts` for the workspace-source aliases. Prints
// a parseable "Live page: <url>" line and exits on SIGTERM.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../../../..');
// Vite is a dependency of the examples workspace, not of this directory: resolve it from there.
const { createServer } = await import(createRequire(resolve(root, 'examples/package.json')).resolve('vite'));
const server = await createServer({ root, configFile: resolve(root, 'examples/vite.config.ts'), server: { host: '127.0.0.1', hmr: false, strictPort: false }, logLevel: 'warn' });
await new Promise((ok, fail) => { server.httpServer.once('error', fail); server.httpServer.listen(0, '127.0.0.1', ok); });
console.log(`Live page: http://127.0.0.1:${server.httpServer.address().port}/tools/devtools-extension/test/live-page/`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return; closing = true;
  server.close().then(() => process.exit(0), () => process.exit(1));
});
