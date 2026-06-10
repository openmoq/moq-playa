/**
 * Toy relay/fanout smoke: one process, no browser. Boot the relay server, connect a
 * publisher and TWO subscribers, subscribe both, publish 3 objects, and assert BOTH
 * subscribers receive exactly ["hello-0","hello-1","hello-2"]. Forwarding failures
 * surface as missing objects → timeout → non-zero exit (never silently passed).
 */
import { startRelayServer } from './server.js';
import { connectClient, beginSubscribe, type CollectedObject } from './client.js';
import { publishDemo } from './publisher.js';
import { certsExist } from './cert.js';
import { DEMO_PAYLOADS } from './demo.js';

const log = (...a: unknown[]) => console.log('[relay-smoke]', ...a);

/** Assert a subscriber received the 3 demo objects with the publisher's exact identity:
 *  payloads hello-0/1/2, groupId 0, subgroupId 0, objectId 0/1/2. */
function assertFanout(name: string, got: CollectedObject[]): void {
  const errs: string[] = [];
  if (got.length !== DEMO_PAYLOADS.length) errs.push(`count=${got.length} (want ${DEMO_PAYLOADS.length})`);
  got.forEach((o, i) => {
    if (o.payload !== DEMO_PAYLOADS[i]) errs.push(`#${i} payload=${JSON.stringify(o.payload)}`);
    if (o.groupId !== 0n) errs.push(`#${i} groupId=${o.groupId}`);
    if (o.subgroupId !== 0n) errs.push(`#${i} subgroupId=${o.subgroupId}`);
    if (o.objectId !== BigInt(i)) errs.push(`#${i} objectId=${o.objectId}`);
  });
  if (errs.length) throw new Error(`${name} mismatch: ${errs.join(', ')}`);
}

async function main(): Promise<number> {
  if (!certsExist()) {
    log('Missing ./certs — run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
    return 1;
  }

  const srv = await startRelayServer({ port: 0 });
  log(`relay up at ${srv.url}`);

  const subA = await connectClient(srv.url);
  const subB = await connectClient(srv.url);
  const pub = await connectClient(srv.url);

  try {
    const want = DEMO_PAYLOADS.length;
    // Subscribe BOTH before publishing — live fanout has no cache.
    const a = await beginSubscribe(subA.conn, want, { label: 'subA', timeoutMs: 15_000 });
    const b = await beginSubscribe(subB.conn, want, { label: 'subB', timeoutMs: 15_000 });

    await publishDemo(pub.conn);

    const [pa, pb] = await Promise.all([a.collected, b.collected]);
    assertFanout('subA', pa);
    assertFanout('subB', pb);

    const fmt = (g: CollectedObject[]) => g.map((o) => `${o.payload}@g${o.groupId}/sg${o.subgroupId}/o${o.objectId}`);
    log(`subA received ${JSON.stringify(fmt(pa))} ✓`);
    log(`subB received ${JSON.stringify(fmt(pb))} ✓`);
    log('RESULT: relay preserved group/subgroup/object IDs and fanned out to BOTH subscribers. PASS.');
    return 0;
  } catch (err) {
    log('RESULT: FAIL —', (err as Error).message);
    return 1;
  } finally {
    await subA.close();
    await subB.close();
    await pub.close();
    srv.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('[relay-smoke] crashed:', err); process.exit(1); });
