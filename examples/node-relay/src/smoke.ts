/**
 * Node WebTransport MoQT demo smoke: one process, no browser, no media. Boot the
 * server on a dynamic port, connect the Node client, assert BOTH endpoints complete
 * MoQT SETUP, then subscribe and receive/validate the 3 demo objects. Tears
 * everything down and exits non-zero on failure/timeout.
 */
import { SessionState } from '@moqt/transport';
import { startServer } from './server.js';
import { connectClient, subscribeAndCollect } from './client.js';
import { certsExist } from './cert.js';
import { DEMO_PAYLOADS } from './demo.js';
import type { MoqtConnection } from '@moqt/webtransport';

const log = (...a: unknown[]) => console.log('[smoke]', ...a);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}

async function main(): Promise<number> {
  if (!certsExist()) {
    log('Missing ./certs — run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
    return 1;
  }

  // Resolve when the SERVER side of some session reaches ESTABLISHED.
  let resolveServer: (c: MoqtConnection) => void;
  const serverEstablished = new Promise<MoqtConnection>((res) => { resolveServer = res; });

  const srv = await startServer({ port: 0, onEstablished: (c) => resolveServer(c) });
  log(`server up at ${srv.url}`);

  try {
    const client = await withTimeout(connectClient(srv.url), 15_000, 'client SETUP');
    if (client.conn.session.state !== SessionState.ESTABLISHED) {
      throw new Error(`client not ESTABLISHED (state=${client.conn.session.state})`);
    }
    log('client ESTABLISHED ✓');

    const serverConn = await withTimeout(serverEstablished, 5_000, 'server SETUP');
    if (serverConn.session.state !== SessionState.ESTABLISHED) {
      throw new Error(`server not ESTABLISHED (state=${serverConn.session.state})`);
    }
    log('server ESTABLISHED ✓');

    // Subscribe and receive the demo object stream.
    const payloads = await withTimeout(
      subscribeAndCollect(client.conn, DEMO_PAYLOADS.length),
      15_000,
      'subscribe + objects',
    );
    const expected = [...DEMO_PAYLOADS];
    if (payloads.length !== expected.length || !payloads.every((p, i) => p === expected[i])) {
      throw new Error(`object mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(payloads)}`);
    }
    log(`received ${payloads.length} objects: ${JSON.stringify(payloads)} ✓`);

    await client.close();
    log('RESULT: SETUP + subscribe + 3 objects on both endpoints. PASS.');
    return 0;
  } catch (err) {
    log('RESULT: FAIL —', (err as Error).message);
    return 1;
  } finally {
    srv.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('[smoke] crashed:', err); process.exit(1); });
