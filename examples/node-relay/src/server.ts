import { serveDemoSubscribe } from './demo-publication.js';
/**
 * Node WebTransport MoQT demo server.
 *
 * Accepts WebTransport sessions on a path, adapts each to Playa's `WebTransportLike`,
 * drives a `MoqtConnection(18, { role: 'server' })`, completes MoQT SETUP, and answers
 * a SUBSCRIBE for the fixed demo track with a tiny object stream (see
 * `serveDemoSubscribe`). Relay mode instead forwards newly received Objects on
 * registered tracks; viewers retrieve history with FETCH. Neither mode provides
 * route authorization.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Http3Server, quicheLoaded } from '@fails-components/webtransport';
import { MoqtConnection } from '@openmoq/webtransport';
import { fileURLToPath } from 'node:url';
import { nodeSessionToWebTransportLike } from './wt-adapter.js';
import { loadCert } from './cert.js';
import { Relay, type RelayOptions } from './relay.js';

const log = (...a: unknown[]) => console.log('[server]', ...a);

export interface StartServerOptions {
  host?: string;
  port?: number; // 0 → OS-assigned (useful for the smoke)
  path?: string;
  /** Called once a per-session MoqtConnection completes SETUP (ESTABLISHED). */
  onEstablished?: (conn: MoqtConnection) => void;
  /** When set, sessions are wired for toy relay/fanout instead of the toy publisher. */
  relay?: Relay;
}

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  readonly closed: Promise<void>;
  stop: () => Promise<void>;
}

export interface StartRelayServerOptions extends Omit<StartServerOptions, 'relay'> {
  relayOptions?: RelayOptions;
}

/** Convenience: a relay-mode server sharing one in-memory {@link Relay} route table. */
export async function startRelayServer(
  opts: StartRelayServerOptions = {},
): Promise<RunningServer & { relay: Relay }> {
  const { relayOptions, ...serverOptions } = opts;
  const relay = new Relay(relayOptions);
  const srv = await startServer({ ...serverOptions, relay });
  return { ...srv, relay };
}

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.PORT ?? 4433);
  const path = opts.path ?? process.env.MOQ_PATH ?? '/moq';

  // The native quiche lib loads asynchronously — MUST be awaited before constructing
  // any server/transport, or you get "Lib quiche loading attempt did not end".
  await quicheLoaded;

  const { cert, privKey } = loadCert();
  const server: any = new Http3Server({ port, host, secret: 'moqt-node-example', cert, privKey });
  const closed: Promise<void> = Promise.resolve(server.closed);
  void closed.catch(() => undefined);
  server.startServer();
  await server.ready;

  const boundPort = server.address?.()?.port ?? port;
  const url = `https://${host}:${boundPort}${path}`;
  log(`listening on ${url}`);

  void acceptLoop(server, path, opts.onEstablished, opts.relay);

  let stopping: Promise<void> | undefined;
  return {
    port: boundPort,
    url,
    closed,
    stop: () => stopping ??= Promise.resolve()
      .then(() => server.stopServer())
      .then(() => closed),
  };
}

async function acceptLoop(
  server: any,
  path: string,
  onEstablished?: (conn: MoqtConnection) => void,
  relay?: Relay,
): Promise<void> {
  const reader: ReadableStreamDefaultReader<any> = server.sessionStream(path).getReader();
  for (;;) {
    let session: any;
    try {
      const next = await reader.read();
      if (next.done) { log('session stream ended'); return; }
      session = next.value;
    } catch (err) {
      log('session stream error:', (err as Error).message);
      return;
    }
    void handleSession(session, onEstablished, relay);
  }
}

async function handleSession(
  session: any,
  onEstablished?: (conn: MoqtConnection) => void,
  relay?: Relay,
): Promise<void> {
  try {
    await session.ready;
    log('session ready — completing MoQT SETUP');
    const transport = nodeSessionToWebTransportLike(session);
    let established = false;
    const conn = new MoqtConnection(18, { role: 'server' });
    conn.onError = (e) => log('onError:', e.message);
    // Soften ONLY the known benign teardown: after SETUP, a client that closes the
    // transport cleanly (WT code 0) ends the uni control stream, which surfaces at the
    // MoQT layer as a §3.3 PROTOCOL_VIOLATION (code 3) carrying a "Session closed …
    // with code 0" reason. That one shape is logged as a plain disconnect; ANY other
    // close (incl. a real post-SETUP protocol error) still shows its code/reason so
    // manual use isn't misled. (See README "Teardown".)
    conn.onClose = (code, reason) => {
      const r = reason ?? '';
      const benignDisconnect = established && code === 3 && r.includes('Session closed') && r.includes('with code 0');
      if (benignDisconnect) log('client disconnected');
      else log(`onClose: code=${code} reason=${r}`);
      relay?.removeConn(conn); // drop this connection's subscribers from the route table
    };
    conn.onMessage = (m) => log('onMessage:', m.type);

    if (relay) {
      relay.setupConnection(conn);
      // Relay mode: forward new objects from accepted publishers to subscribers.
      conn.onSubscribe = (requestId, namespace, trackName) => {
        void relay.handleSubscribe(conn, requestId, namespace, trackName);
      };
      // §3.3.2: a subscriber resetting one SUBSCRIBE stream (ABR quality-switch) drops
      // ONLY that subscription — the viewer connection stays open.
      conn.onSubscribeClosed = (requestId) => relay.removeSubscription(conn, requestId);
      conn.onPublish = (publish) => { void relay.handlePublish(conn, publish); };
      // Serve standalone + joining FETCH from bounded, proven history (§10.12).
      conn.onFetch = (requestId, fetch) => { void relay.handleFetch(conn, requestId, fetch); };
      // §5.1: a Forward 0→1 REQUEST_UPDATE_OK must communicate the CURRENT
      // Largest Location — supply it from the live cache per subscription.
      conn.setLargestLocationProvider((subReqId) => relay.currentLargestFor(conn, subReqId));
    } else {
      // Toy-publisher mode: answer a SUBSCRIBE for the demo track with a tiny stream.
      conn.onSubscribe = (requestId, namespace, trackName) => {
        void serveDemoSubscribe(conn, requestId, namespace, trackName);
      };
    }

    await conn.connect(transport);
    established = true;
    log(`SETUP complete — session ${conn.session.state}`);
    onEstablished?.(conn);
  } catch (err) {
    log('session error:', (err as Error).message);
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then((srv) => {
      const shutdown = () => {
        log('shutting down');
        void srv.stop().then(() => process.exit(0), (error) => {
          log('shutdown failed:', (error as Error).message);
          process.exit(1);
        });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      log('ready — connect a client (e.g. `pnpm client`), or Ctrl-C to stop');
    })
    .catch((err) => { log('failed to start:', (err as Error).message); process.exit(1); });
}
