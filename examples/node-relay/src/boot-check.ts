/**
 * Slice A2 boot check: prove the FAILS native backend can actually BIND on this
 * machine with a real cert — still WITHOUT any MoQT behavior. Requires:
 *   1. the native addon built (see README "Native backend"), and
 *   2. `pnpm gen-cert` to have produced ./certs/{cert,key}.pem.
 *
 * Constructs an Http3Server, binds it, prints the listening address and the
 * `sessionStream()` shape, then tears down. Exits 0 on a successful bind.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Http3Server } from '@fails-components/webtransport';

const here = dirname(fileURLToPath(import.meta.url));
const certDir = join(here, '..', 'certs');
const certPath = join(certDir, 'cert.pem');
const keyPath = join(certDir, 'key.pem');

async function main(): Promise<number> {
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.error('Missing ./certs — run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
    return 1;
  }
  const cert = readFileSync(certPath, 'utf8');
  const privKey = readFileSync(keyPath, 'utf8');

  let server: any;
  try {
    server = new Http3Server({ port: 0, host: '127.0.0.1', secret: 'boot-check-secret', cert, privKey });
  } catch (err) {
    console.error('Http3Server construct FAILED:', (err as Error).message);
    console.error('(If this is "Cannot find module ...webtransport.node", the native addon is not built.)');
    return 1;
  }

  try {
    server.startServer();
    await server.ready;
    const addr = typeof server.address === 'function' ? server.address() : null;
    console.log('BIND OK — Http3Server is listening:', JSON.stringify(addr));
    const s = server.sessionStream('/moq');
    console.log('sessionStream("/moq"):', s?.constructor?.name, '— has getReader:', typeof s?.getReader === 'function');
    console.log('RESULT: native backend binds. Slice B can proceed.');
    return 0;
  } catch (err) {
    console.error('BIND FAILED:', (err as Error).message);
    return 1;
  } finally {
    try { server.stopServer(); } catch { /* ignore */ }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('boot-check crashed:', err); process.exit(1); });
