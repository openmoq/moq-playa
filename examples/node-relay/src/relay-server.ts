/**
 * CLI launcher: run the relay in RELAY mode (multi-track fanout) standalone, so
 * other examples (e.g. node-publisher) can spawn it as a child process without
 * importing this package's internals.
 *
 *   pnpm --filter @moqt/example-node-relay relay-server     # HOST/PORT/MOQ_PATH env
 *
 * Prints the same parseable "[server] listening on <url>" line as the demo server.
 */
import { startRelayServer } from './server.js';

startRelayServer()
  .then((srv) => {
    const shutdown = () => { srv.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log('[relay-server] relay mode ready — Ctrl-C to stop');
  })
  .catch((err) => { console.error('[relay-server] failed to start:', (err as Error).message); process.exit(1); });
