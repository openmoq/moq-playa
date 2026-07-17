/**
 * Joining-FETCH relay smoke (§10.12.2): one process, no browser.
 *
 * Proves the late-viewer warm start: after the publisher has finished a
 * group, a late viewer subscribes with the Largest Object filter (§5.1.2 —
 * live delivery starts AFTER the largest object, so the cache is NOT
 * replayed onto the subscription) and issues a relative Joining FETCH for
 * the current group. The relay resolves the range from its latest-group
 * cache and serves exactly that group's objects on the FETCH stream —
 * immediately, without waiting for the next group — and the subscription
 * delivers ZERO duplicates of them.
 *
 * Also asserts the loud failure paths: a standalone FETCH starting beyond
 * the largest cached object → REQUEST_ERROR INVALID_RANGE (§9.16.3), and a
 * FETCH for an unregistered track → REQUEST_ERROR DOES_NOT_EXIST.
 */
import { startRelayServer } from './server.js';
import { connectClient, beginSubscribe } from './client.js';
import { publishDemo } from './publisher.js';
import { certsExist } from './cert.js';
import { DEMO_NAMESPACE, DEMO_TRACK, DEMO_PAYLOADS, nsBytes, te, td } from './demo.js';
import { RequestError18, varint, type ControlMessage, type MoqtObject, type RequestErrorMsg } from '@moqt/transport';

const log = (...a: unknown[]) => console.log('[relay-fetch-smoke]', ...a);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `check()` is true (or fail after ~timeoutMs). */
async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

async function main(): Promise<number> {
  if (!certsExist()) {
    log('Missing ./certs — run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
    return 1;
  }

  const srv = await startRelayServer({ port: 0 });
  log(`relay up at ${srv.url}`);

  const pub = await connectClient(srv.url);
  const viewer = await connectClient(srv.url);

  try {
    // 1. Publisher completes a group (3 objects, group 0) BEFORE the viewer arrives.
    await publishDemo(pub.conn);
    await sleep(300); // let the relay cache settle

    // 2. Late viewer: Largest Object subscription — the relay must NOT replay
    //    the cached group onto it (§5.1.2). expected=0: we assert it stays empty.
    const sub = await beginSubscribe(viewer.conn, 0, {
      label: 'late-viewer', filter: { type: 'LargestObject' }, timeoutMs: 5_000,
    });
    // expected=0 means `collected` only times out — we assert on sub.objects
    // directly, so swallow that rejection instead of leaving it unhandled.
    sub.collected.catch(() => { /* expected: nothing should arrive */ });

    // 3. Joining FETCH for the current group head (relative, joiningStart 0).
    const fetched: MoqtObject[] = [];
    const errors: RequestErrorMsg[] = [];
    viewer.conn.onObject = (_sid, obj) => { fetched.push(obj); };
    viewer.conn.onMessage = (m: ControlMessage) => {
      if (m.type === 'REQUEST_ERROR') errors.push(m as RequestErrorMsg);
    };
    const fetchReqId = await viewer.conn.joiningFetch({
      joiningFetchType: 'relative', joiningRequestId: sub.requestId, joiningStart: 0n,
    });
    log(`joining FETCH sent (requestId=${fetchReqId}, joins subscribe ${sub.requestId})`);

    const data = () => fetched.filter((o) => o.kind === 'data');
    await waitFor(() => data().length >= DEMO_PAYLOADS.length, 'joining-FETCH pre-roll objects');

    // The fetch delivered EXACTLY the cached current group, in order.
    const got = data().map((o) => ({ g: o.groupId, id: o.objectId, p: td(o.payload) }));
    const wantPayloads = [...DEMO_PAYLOADS];
    if (got.length !== wantPayloads.length) throw new Error(`fetched ${got.length} objects, want ${wantPayloads.length}`);
    got.forEach((o, i) => {
      if (o.p !== wantPayloads[i] || o.g !== 0n || o.id !== BigInt(i)) {
        throw new Error(`fetched #${i} = ${JSON.stringify(o)} (want ${wantPayloads[i]} @ g0/o${i})`);
      }
    });
    log(`joining FETCH delivered ${got.length} object(s): ${JSON.stringify(got.map((o) => o.p))} ✓`);

    // 4. Zero duplicates: the Largest Object subscription received NOTHING
    //    (no cache replay; no new live objects were published).
    if (sub.objects.length !== 0) {
      throw new Error(`subscription received ${sub.objects.length} duplicate object(s): ${JSON.stringify(sub.objects)}`);
    }
    log('Largest Object subscription delivered zero duplicates ✓');

    // 5. Loud failures.
    // 5a. Standalone FETCH starting beyond the largest cached object → INVALID_RANGE.
    await viewer.conn.fetch(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK), {
      startGroup: 99n, startObject: 0n, endGroup: 100n, endObject: 0n,
    });
    await waitFor(
      () => errors.some((e) => e.errorCode === (RequestError18.INVALID_RANGE as bigint)),
      'INVALID_RANGE for an out-of-range standalone FETCH',
    );
    log('out-of-range standalone FETCH rejected with INVALID_RANGE ✓');

    // 5b. FETCH for an unregistered track → DOES_NOT_EXIST.
    await viewer.conn.fetch(nsBytes(DEMO_NAMESPACE), te('no-such-track'), {
      startGroup: varint(0n), startObject: varint(0n), endGroup: varint(1n), endObject: varint(0n),
    });
    await waitFor(
      () => errors.some((e) => e.errorCode === (RequestError18.DOES_NOT_EXIST as bigint)),
      'DOES_NOT_EXIST for an unregistered track FETCH',
    );
    log('unregistered-track FETCH rejected with DOES_NOT_EXIST ✓');

    log('RESULT: late viewer received the cached current group via joining FETCH, with zero FETCH/SUBSCRIBE duplicates. PASS.');
    return 0;
  } catch (err) {
    log('RESULT: FAIL —', (err as Error).message);
    return 1;
  } finally {
    await viewer.close().catch(() => { /* teardown */ });
    await pub.close().catch(() => { /* teardown */ });
    srv.stop();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[relay-fetch-smoke] fatal:', err);
  process.exit(1);
});
