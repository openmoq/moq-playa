/**
 * Real WebTransport load comparison for the relay's subgroup scheduler.
 *
 * Runs the same burst through a single-lane relay (the old effective behavior)
 * and the bounded concurrent scheduler. This is an operator benchmark, not a
 * timing-sensitive CI assertion: correctness is enforced in both runs and the
 * measured durations are printed for comparison.
 */
import type { MoqtConnection, TrackSubscription } from '@moqt/webtransport';
import { startRelayServer } from './server.js';
import { connectClient, type ClientHandle } from './client.js';
import { publishGroupObjects, publishTrack, PUB_ALIAS } from './publisher.js';
import { certsExist } from './cert.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te, withTimeout } from './demo.js';

const VIEWERS = 4;
const GROUPS = 96;
const PUBLISH_CONCURRENCY = 8;
const PAYLOAD = 'x'.repeat(16 * 1024);
const log = (...a: unknown[]) => console.log('[load-smoke]', ...a);

interface CountedSubscription {
  readonly done: Promise<void>;
  readonly groups: Set<bigint>;
  readonly sub: TrackSubscription;
}

async function subscribeCount(conn: MoqtConnection): Promise<CountedSubscription> {
  const groups = new Set<bigint>();
  let resolveDone!: () => void;
  const received = new Promise<void>((resolve) => { resolveDone = resolve; });
  const sub = await conn.subscribeTrack(nsBytes(DEMO_NAMESPACE), te(DEMO_TRACK), {
    onObject: (obj) => {
      if (obj.kind !== 'data') return;
      groups.add(obj.groupId);
      if (groups.size === GROUPS) resolveDone();
    },
  });
  return {
    groups,
    sub,
    done: withTimeout(received, 30_000, `receive ${GROUPS} load-smoke groups`),
  };
}

async function publishRemainingGroups(conn: MoqtConnection): Promise<void> {
  let nextGroup = 1;
  const worker = async (): Promise<void> => {
    for (;;) {
      const group = nextGroup++;
      if (group >= GROUPS) return;
      await publishGroupObjects(conn, PUB_ALIAS, BigInt(group), [PAYLOAD]);
    }
  };
  await Promise.all(Array.from({ length: PUBLISH_CONCURRENCY }, () => worker()));
}

async function closeAll(handles: ClientHandle[]): Promise<void> {
  await Promise.all(handles.map((handle) => handle.close()));
}

async function run(maxConcurrentSubgroupsPerSubscription: number): Promise<number> {
  const srv = await startRelayServer({
    port: 0,
    relayOptions: {
      maxConcurrentSubgroupsPerSubscription,
      maxPendingObjectsPerSubscription: GROUPS * 2,
    },
  });
  const viewers: ClientHandle[] = [];
  let publisher: ClientHandle | undefined;
  try {
    for (let i = 0; i < VIEWERS; i++) viewers.push(await connectClient(srv.url));
    publisher = await connectClient(srv.url);
    const subscriptions = await Promise.all(viewers.map((viewer) => subscribeCount(viewer.conn)));

    const started = performance.now();
    await publishTrack(publisher.conn, DEMO_TRACK, PUB_ALIAS, [PAYLOAD]);
    await publishRemainingGroups(publisher.conn);
    await Promise.all(subscriptions.map(({ done }) => done));
    const elapsedMs = performance.now() - started;

    for (const { groups } of subscriptions) {
      if (groups.size !== GROUPS) {
        throw new Error(`received ${groups.size}/${GROUPS} unique groups`);
      }
    }
    await Promise.all(subscriptions.map(({ sub }) => sub.unsubscribe()));
    return elapsedMs;
  } finally {
    await closeAll([...viewers, ...(publisher ? [publisher] : [])]);
    srv.stop();
  }
}

async function main(): Promise<number> {
  if (!certsExist()) {
    log('Missing ./certs; run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
    return 1;
  }
  const serialMs = await run(1);
  const concurrentMs = await run(8);
  log(`single lane: ${serialMs.toFixed(1)}ms`);
  log(`8 lanes: ${concurrentMs.toFixed(1)}ms`);
  log(`relative throughput: ${(serialMs / concurrentMs).toFixed(2)}x`);
  log(`RESULT: ${VIEWERS} viewers received all ${GROUPS} groups in both runs. PASS.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('[load-smoke] crashed:', err); process.exit(1); });
