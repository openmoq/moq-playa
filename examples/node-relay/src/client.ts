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
import { MoqtConnection } from '@moqt/webtransport';
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
  opts: { timeoutMs?: number; label?: string; track?: string } = {},
): Promise<Subscription> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const trackName = opts.track ?? DEMO_TRACK;
  const tag = opts.label ? `${opts.label} ` : '';
  const objects: CollectedObject[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });

  const sub = await conn.subscribeTrack(nsBytes(DEMO_NAMESPACE), te(trackName), {
    onObject: (obj) => {
      if (obj.kind !== 'data') return; // ignore gap signals
      const rec: CollectedObject = {
        groupId: obj.groupId, subgroupId: obj.subgroupId, objectId: obj.objectId, payload: td(obj.payload),
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
  /** Close the WebTransport session and await teardown. */
  close: () => Promise<void>;
}

export async function connectClient(url: string): Promise<ClientHandle> {
  // Wait for the native quiche lib before constructing the transport (see server.ts).
  await quicheLoaded;
  const transport: any = new WebTransport(url, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: certSha256() }],
    protocols: ['moqt-18'],
  });
  await transport.ready;
  log(`WebTransport ready (protocol=${transport.protocol ?? ''})`);

  const wtl = nodeSessionToWebTransportLike(transport);
  const conn = new MoqtConnection(18);
  let closing = false;
  conn.onError = (e) => log('onError:', e.message);
  conn.onClose = (code, reason) => { if (!closing) log(`onClose: code=${code} reason=${reason ?? ''}`); };
  conn.onMessage = (m) => log('onMessage:', m.type);

  await conn.connect(wtl);
  log(`SETUP complete — session ${conn.session.state}`);

  return {
    conn,
    transport,
    close: async () => {
      closing = true;
      // Graceful MoQT close FIRST: this transitions the session to CLOSED, so the
      // subsequent control-stream teardown isn't surfaced as a §3.3 violation.
      try { await conn.close(); } catch { /* ignore */ }
      try { transport.close(); } catch { /* ignore */ }
      try { await transport.closed; } catch { /* ignore */ }
    },
  };
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
