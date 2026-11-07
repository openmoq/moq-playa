/**
 * CLI launcher: run the relay in RELAY mode (multi-track fanout) standalone, so
 * other examples (e.g. node-publisher) can spawn it as a child process without
 * importing this package's internals.
 *
 *   pnpm --filter @moqt/example-node-relay relay-server     # HOST/PORT/MOQ_PATH env
 *
 * RELAY_MAX_PENDING_OBJECTS / RELAY_MAX_PENDING_BYTES override the per-subscription
 * backlog at which a subscriber that cannot keep up is disconnected.
 *
 * Prints the same parseable "[server] listening on <url>" line as the demo server.
 */
import { startRelayServer } from './server.js';

/** An optional numeric env override; the relay validates the value. */
const envLimit = (name: string): number | undefined =>
  process.env[name] === undefined ? undefined : Number(process.env[name]);

const maxPendingObjects = envLimit('RELAY_MAX_PENDING_OBJECTS');
const maxPendingBytes = envLimit('RELAY_MAX_PENDING_BYTES');

startRelayServer({
  relayOptions: {
    ...(maxPendingObjects !== undefined ? { maxPendingObjectsPerSubscription: maxPendingObjects } : {}),
    ...(maxPendingBytes !== undefined ? { maxPendingBytesPerSubscription: maxPendingBytes } : {}),
  },
})
  .then((srv) => {
    const shutdown = () => {
      void srv.stop().then(() => process.exit(0), (error) => {
        console.error('[relay-server] shutdown failed:', (error as Error).message);
        process.exit(1);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    console.log('[relay-server] relay mode ready — Ctrl-C to stop');
  })
  .catch((err) => { console.error('[relay-server] failed to start:', (err as Error).message); process.exit(1); });
