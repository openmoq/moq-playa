/**
 * Node WebTransport MoQT client for the publisher example: connects to the relay
 * with the relay's pinned cert hash and an explicit `MoqtConnection(18)` (the FAILS
 * server does not echo an application protocol, so draft auto-negotiation would
 * fall back to draft-16). Also provides a small subscribe-and-collect helper used
 * by the verification subscriber in the smoke.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { MoqtConnection } from '@moqt/webtransport';
import { nodeSessionToWebTransportLike } from './wt-adapter.js';
import { relayCertSha256 } from './cert.js';

const log = (...a: unknown[]) => console.log('[client]', ...a);
const te = new TextEncoder();
const td = new TextDecoder();

export interface ClientHandle {
  readonly conn: MoqtConnection;
  close: () => Promise<void>;
}

export async function connectClient(url: string, label = 'client'): Promise<ClientHandle> {
  // The native quiche lib loads asynchronously — await before constructing.
  await quicheLoaded;
  const transport: any = new WebTransport(url, {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: relayCertSha256() }],
    protocols: ['moqt-18'],
  });
  await transport.ready;

  const conn = new MoqtConnection(18);
  let closing = false;
  conn.onError = (e) => { if (!closing) console.error(`[${label}] onError:`, e.message); };
  conn.onClose = (code, reason) => { if (!closing) console.error(`[${label}] onClose: code=${code} reason=${reason ?? ''}`); };
  await conn.connect(nodeSessionToWebTransportLike(transport));
  log(`${label} SETUP complete — session ${conn.session.state}`);

  return {
    conn,
    close: async () => {
      closing = true;
      try { await conn.close(); } catch { /* ignore */ }
      try { transport.close(); } catch { /* ignore */ }
      try { await transport.closed; } catch { /* ignore */ }
    },
  };
}

/** A received object with identity + raw payload. */
export interface ReceivedObject {
  readonly groupId: bigint;
  readonly subgroupId: bigint;
  readonly objectId: bigint;
  readonly payload: Uint8Array;
}

/** Subscribe to one track and resolve once `expected` data objects arrive. */
export async function subscribeCollect(
  conn: MoqtConnection,
  namespace: readonly string[],
  track: string,
  expected: number,
  timeoutMs = 10_000,
): Promise<ReceivedObject[]> {
  const got: ReceivedObject[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });

  const sub = await conn.subscribeTrack(namespace.map((p) => te.encode(p)), te.encode(track), {
    onObject: (obj) => {
      if (obj.kind !== 'data') return;
      got.push({ groupId: obj.groupId, subgroupId: obj.subgroupId, objectId: obj.objectId, payload: obj.payload });
      if (got.length >= expected) resolveDone();
    },
  });

  try {
    await Promise.race([
      done,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(
        `timeout waiting for ${expected} ${track} objects (got ${got.length}: ${got.map((o) => td.decode(o.payload).slice(0, 24)).join(', ')})`,
      )), timeoutMs)),
    ]);
  } finally {
    await sub.unsubscribe().catch(() => { /* best effort */ });
  }
  return got;
}
