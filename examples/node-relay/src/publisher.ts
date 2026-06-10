/**
 * Node WebTransport MoQT demo PUBLISHER (browser-free).
 *
 * Opens a PUBLISH for the demo track, waits for the relay to accept it, then sends the
 * three demo payloads as one subgroup. All via the public publish/openSubgroup/
 * sendObject/closeSubgroup API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { fileURLToPath } from 'node:url';
import type { MoqtConnection } from '@moqt/webtransport';
import { connectClient } from './client.js';
import { DEMO_NAMESPACE, DEMO_TRACK, DEMO_PAYLOADS, nsBytes, te } from './demo.js';

const log = (...a: unknown[]) => console.log('[publisher]', ...a);

/** The Track Alias this publisher advertises for the demo track. */
export const PUB_ALIAS = 9n;

/** Wait for the PUBLISH to be accepted (REQUEST_OK for our request id) before sending
 *  objects — this guarantees the relay has attached its object handler. Restores the
 *  previous onMessage so sequential multi-track publishing doesn't accumulate handlers. */
function waitForPublishAccept(conn: MoqtConnection, requestId: bigint, timeoutMs = 10_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const prev = conn.onMessage;
    const restore = () => { conn.onMessage = prev ?? (() => { /* no prior handler */ }); };
    const timer = setTimeout(() => { restore(); reject(new Error('PUBLISH not accepted in time')); }, timeoutMs);
    conn.onMessage = (m) => {
      prev?.(m);
      if (m.type === 'REQUEST_OK' && (m as any).requestId === requestId) {
        clearTimeout(timer);
        restore();
        resolve();
      }
    };
  });
}

/**
 * Publish one track as a single subgroup (group 0, subgroup 0) on an established
 * connection: PUBLISH → await acceptance → send `payloads` → close. `endOfGroup`
 * marks the subgroup as the group's last (the relay forwards that as a subgroup FIN).
 */
export async function publishTrack(
  conn: MoqtConnection,
  trackName: string,
  alias: bigint,
  payloads: string[],
  opts: { endOfGroup?: boolean } = {},
): Promise<void> {
  const requestId = await conn.publish(nsBytes(DEMO_NAMESPACE), te(trackName), alias);
  await waitForPublishAccept(conn, requestId);
  const sid = await conn.openSubgroup(alias, 0n, 0n, {
    publisherPriority: 128, firstObject: true, endOfGroup: opts.endOfGroup ?? false,
  });
  for (let i = 0; i < payloads.length; i++) {
    await conn.sendObject(sid, BigInt(i), te(payloads[i]!));
  }
  await conn.closeSubgroup(sid);
  log(`published ${payloads.length} objects to ${trackName} (alias=${alias})`);
}

/** Send another group's objects on an ALREADY-published alias (no new PUBLISH). Used to
 *  prove an unsubscribed viewer no longer receives later groups. */
export async function publishGroupObjects(
  conn: MoqtConnection,
  alias: bigint,
  groupId: bigint,
  payloads: string[],
): Promise<void> {
  const sid = await conn.openSubgroup(alias, groupId, 0n, { publisherPriority: 128, firstObject: true });
  for (let i = 0; i < payloads.length; i++) {
    await conn.sendObject(sid, BigInt(i), te(payloads[i]!));
  }
  await conn.closeSubgroup(sid);
}

/** Publish the simple demo track (used by the publisher CLI and relay-smoke). */
export async function publishDemo(conn: MoqtConnection): Promise<void> {
  log(`publishing ${DEMO_NAMESPACE.join('/')}/${DEMO_TRACK}`);
  await publishTrack(conn, DEMO_TRACK, PUB_ALIAS, [...DEMO_PAYLOADS]);
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.argv[2] ?? process.env.URL ?? 'https://127.0.0.1:4433/moq';
  log('connecting to', url);
  connectClient(url)
    .then(async (h) => {
      await publishDemo(h.conn);
      await h.close();
      process.exit(0);
    })
    .catch((err) => { log('failed:', (err as Error).message); process.exit(1); });
}
