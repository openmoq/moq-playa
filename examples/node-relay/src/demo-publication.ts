import type { MoqtConnection } from '@openmoq/webtransport';
import { RequestError18 } from '@openmoq/transport';
import { publicationState } from '../../shared/publication-state.js';
import { DEMO_NAMESPACE, DEMO_TRACK, DEMO_PAYLOADS, DEMO_ALIAS, nsStr, td, te } from './demo.js';
const log = (...args: unknown[]) => console.log('[server]', ...args);

export async function serveDemoSubscribe(
  conn: MoqtConnection,
  requestId: bigint,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): Promise<void> {
  const wantNs = DEMO_NAMESPACE.join('/');
  const gotNs = nsStr(namespace);
  const gotName = td(trackName);
  if (gotNs !== wantNs || gotName !== DEMO_TRACK) {
    log(`SUBSCRIBE for ${gotNs}/${gotName} — not the demo track; rejecting`);
    await conn.rejectSubscribe(requestId, RequestError18.DOES_NOT_EXIST, 'unknown track');
    return;
  }

  try {
    const state = publicationState(conn);
    state.bind(requestId, DEMO_ALIAS);
    await conn.acceptSubscribe(requestId, DEMO_ALIAS);
    log(`accepted SUBSCRIBE ${gotNs}/${gotName} (alias=${DEMO_ALIAS}); publishing ${DEMO_PAYLOADS.length} objects`);

    // One subgroup (group 0, subgroup 0). Object 0 is the first object ever in this
    // subgroup, so set firstObject (draft-18 FIRST_OBJECT bit).
    const sid = await conn.openSubgroup(DEMO_ALIAS, 0n, 0n, { publisherPriority: 128, firstObject: true });
    for (let i = 0; i < DEMO_PAYLOADS.length; i++) {
      state.sent(DEMO_ALIAS, 0n, BigInt(i));
      await conn.sendObject(sid, BigInt(i), te(DEMO_PAYLOADS[i]!));
    }
    await conn.closeSubgroup(sid);
    log('published demo objects');
  } catch (err) {
    log('publish error:', (err as Error).message);
  }
}
