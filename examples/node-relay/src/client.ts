/**
 * Node WebTransport MoQT demo client (browser-free).
 *
 * Uses the FAILS package's Node `WebTransport` client, pins the server's self-signed
 * cert via `serverCertificateHashes`, adapts the session with the SAME adapter as the
 * server, drives a `MoqtConnection(18)` (explicit draft — no protocol negotiation
 * needed), completes SETUP, then subscribes to the demo track and collects its objects.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { MoqtConnection } from '@openmoq/webtransport';
import { fileURLToPath } from 'node:url';
import { nodeSessionToWebTransportLike } from './wt-adapter.js';
import { certSha256 } from './cert.js';
import { DEMO_NAMESPACE, DEMO_TRACK, DEMO_PAYLOADS, nsBytes, te, td, withTimeout } from './demo.js';

const log = (...a: unknown[]) => console.log('[client]', ...a);

/**
 * Subscribe to the demo track and collect exactly `expected` object payloads using
 * the normal `subscribeTrack({ onObject })` surface (no internal hooks). Resolves
 * with the decoded payload strings, or rejects on timeout.
 */
/** A received object's identity + payload (payload decoded to text for the demo). */
export interface CollectedObject {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly extensions: Uint8Array | undefined;
  readonly payload: string;
}

/**
 * Subscribe NOW (await SUBSCRIBE_OK) and return a `collected` promise that resolves
 * with the received objects (identity + payload) once `expected` arrive. Splitting
 * subscribe from collect lets a caller register subscribers BEFORE a publisher starts
 * (live fanout has no cache). `label` distinguishes concurrent subscribers in logs.
 */
export interface Subscription {
  readonly alias: bigint;
  readonly requestId: bigint;
  /** Live array, appended as objects arrive (inspect after cleanup tests). */
  readonly objects: CollectedObject[];
  /** Resolves with `objects` once `expected` have arrived (rejects on timeout). */
  readonly collected: Promise<CollectedObject[]>;
  /** Cancel the subscription (draft-18: resets the SUBSCRIBE stream). */
  unsubscribe: () => Promise<void>;
}

export async function beginSubscribe(
  conn: MoqtConnection,
  expected: number,
  opts: { timeoutMs?: number; label?: string; track?: string; filter?: import('@openmoq/transport').SubscriptionFilter } = {},
): Promise<Subscription> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const trackName = opts.track ?? DEMO_TRACK;
  const tag = opts.label ? `${opts.label} ` : '';
  const objects: CollectedObject[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });

  const sub = await conn.subscribeTrack(nsBytes(DEMO_NAMESPACE), te(trackName), {
    ...(opts.filter ? { filter: opts.filter } : {}),
    onObject: (obj) => {
      if (obj.kind !== 'data') return; // ignore gap signals
      const rec: CollectedObject = {
        groupId: obj.groupId,
        subgroupId: obj.subgroupId,
        objectId: obj.objectId,
        extensions: obj.properties ?? obj.extensions,
        payload: td(obj.payload),
      };
      objects.push(rec);
      log(`${tag}[${trackName}] object ${objects.length}/${expected}: ${JSON.stringify(rec.payload)} (g${rec.groupId} sg${rec.subgroupId} o${rec.objectId})`);
      if (objects.length >= expected) resolveDone();
    },
  });
  log(`${tag}subscribed ${trackName} (alias=${sub.trackAlias}); waiting for ${expected} objects`);

  const collected = withTimeout(done, timeoutMs, `${tag}receive ${expected} ${trackName} objects`).then(() => objects);
  return { alias: sub.trackAlias, requestId: sub.requestId, objects, collected, unsubscribe: () => sub.unsubscribe() };
}

/** Subscribe and wait for `expected` object payloads in one call (the simple demo). */
export async function subscribeAndCollect(
  conn: MoqtConnection,
  expected: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const s = await beginSubscribe(conn, expected, { timeoutMs });
  const objs = await s.collected;
  await s.unsubscribe().catch(() => { /* best effort */ });
  return objs.map((o) => o.payload);
}

export interface ClientHandle {
  readonly conn: MoqtConnection;
  readonly transport: any;
  /** Rejects if this client fails before an intentional close begins. */
  readonly failure: Promise<never>;
  /** Close the WebTransport session and await teardown. */
  close: () => Promise<void>;
}

export interface ConnectClientOptions {
  /** Cancels connection setup and closes the adopted transport immediately. */
  readonly signal?: AbortSignal;
}

export async function connectClient(
  url: string,
  options: ConnectClientOptions = {},
): Promise<ClientHandle> {
  // Wait for the native quiche lib before constructing the transport (see server.ts).
  await quicheLoaded;
  if (options.signal?.aborted) throw new Error('WebTransport connection aborted');
  const transport: any = new WebTransport(url, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: certSha256() }],
    protocols: ['moqt-18'],
  });
  const transportClosed = Promise.resolve(transport.closed);
  void transportClosed.catch(() => undefined);
  let transportCloseRequested = false;
  let closing = false;
  const closeTransport = () => {
    if (transportCloseRequested) return;
    transportCloseRequested = true;
    try { transport.close(); } catch { /* transport may already be terminal */ }
  };
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    closing = true;
    closeTransport();
    rejectAbort(new Error('WebTransport connection aborted'));
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (options.signal?.aborted) onAbort();
    await Promise.race([transport.ready, aborted]);
    log(`WebTransport ready (protocol=${transport.protocol ?? ''})`);

    const wtl = nodeSessionToWebTransportLike(transport);
    const conn = new MoqtConnection(18);
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    // Most demo callers only need close(); keep an ignored lifecycle observer
    // from becoming an unhandled rejection while still exposing it to load tests.
    void failure.catch(() => undefined);
    let failureReported = false;
    const reportFailure = (error: Error) => {
      if (closing || failureReported) return;
      failureReported = true;
      rejectFailure(error);
    };
    conn.onError = (e) => {
      log('onError:', e.message);
      reportFailure(e);
    };
    conn.onClose = (code, reason) => {
      if (closing) return;
      const message = `MoQT session closed unexpectedly (code=${code ?? 'unknown'}, reason=${reason ?? ''})`;
      log(message);
      reportFailure(new Error(message));
    };
    conn.onMessage = (m) => log('onMessage:', m.type);

    await Promise.race([conn.connect(wtl), aborted, failure]);
    log(`SETUP complete — session ${conn.session.state}`);
    let closePromise: Promise<void> | undefined;

    return {
      conn,
      transport,
      failure,
      close: () => {
        if (closePromise !== undefined) return closePromise;
        closing = true;
        // MoQT owns the transport close; observe both outcomes without closing twice.
        closePromise = Promise.allSettled([
          Promise.resolve().then(() => conn.close()),
          transportClosed,
        ]).then((results) => {
          const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
          if (errors.length > 0) {
            const messages = errors.map((error: unknown) => error instanceof Error ? error.message : String(error));
            throw new AggregateError(errors, `client shutdown failed: ${messages.join('; ')}`);
          }
        });
        return closePromise;
      },
    };
  } catch (error) {
    closing = true;
    closeTransport();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.argv[2] ?? process.env.URL ?? 'https://127.0.0.1:4433/moq';
  log('connecting to', url);
  connectClient(url)
    .then(async (h) => {
      const payloads = await subscribeAndCollect(h.conn, DEMO_PAYLOADS.length);
      const ok = payloads.length === DEMO_PAYLOADS.length
        && payloads.every((p, i) => p === DEMO_PAYLOADS[i]);
      log(ok ? `received all ${payloads.length} demo objects ✓` : `MISMATCH: got ${JSON.stringify(payloads)}`);
      await h.close();
      process.exit(ok ? 0 : 1);
    })
    .catch((err) => { log('failed:', (err as Error).message); process.exit(1); });
}
