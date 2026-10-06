import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({ root, server: { host: '127.0.0.1', hmr: false } });
// Vite's server.listen(0) substitutes its default port. Bind the HTTP server directly.
await new Promise((resolve, reject) => {
  server.httpServer.once('error', reject);
  server.httpServer.listen(0, '127.0.0.1', resolve);
});
console.log(`Acceptance page: http://127.0.0.1:${server.httpServer.address().port}/`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  server.close().then(() => process.exit(0), (error) => {
    console.error(error);
    process.exit(1);
  });
});
