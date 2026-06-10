/**
 * Publisher smoke: publish the synthetic fixture through a REAL node-relay and verify
 * it end-to-end. Three processes-worth of roles, one orchestrator:
 *
 *   - SPAWNS the relay as a CHILD PROCESS (examples stay decoupled — no code import;
 *     we run node-relay's `relay-server` entrypoint via tsx and parse its
 *     "listening on <url>" line);
 *   - connects the PUBLISHER, publishes catalog + 5 media tracks (synthetic chunks);
 *   - connects a VERIFICATION SUBSCRIBER, subscribes the catalog, parses it with
 *     @moqt/msf parseCatalogAuto, asserts the track list + per-track initData; then
 *     subscribes EVERY media track and asserts the exact synthetic chunk payloads
 *     and group/object IDs arrive.
 *
 * Exits non-zero on any miss/timeout. Requires node-relay's cert (gen-cert) since
 * the relay child loads it and we pin its hash.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalogAuto } from '@moqt/msf';
import { connectClient, subscribeCollect } from './client.js';
import { publishFixture } from './publisher.js';
import { loadSyntheticFixture, syntheticChunkPayload, CHUNKS_PER_TRACK } from './synthetic-fixture.js';
import { relayCertExists, RELAY_CERT_PATH } from './cert.js';

const log = (...a: unknown[]) => console.log('[pub-smoke]', ...a);
const td = new TextDecoder();
const here = dirname(fileURLToPath(import.meta.url));

/** Spawn node-relay's relay-server entrypoint as a child; resolve its URL. */
function spawnRelay(): Promise<{ child: ChildProcess; url: string }> {
  const relayDir = resolve(join(here, '..', '..', 'node-relay'));
  const tsx = resolve(join(here, '..', 'node_modules', '.bin', 'tsx'));
  const child = spawn(tsx, [join(relayDir, 'src', 'relay-server.ts')], {
    cwd: relayDir,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); rej(new Error('relay child did not report a listening URL in time')); }, 20_000);
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      process.stdout.write(d); // surface relay logs in the smoke output
      const m = buf.match(/listening on (https:\/\/\S+)/);
      if (m) { clearTimeout(timer); res({ child, url: m[1]! }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`relay child exited early (code ${code})`)); });
  });
}

async function main(): Promise<number> {
  if (!relayCertExists()) {
    log(`relay cert missing (${RELAY_CERT_PATH}) — run \`pnpm --filter @moqt/example-node-relay gen-cert\` first.`);
    return 1;
  }

  const fixture = loadSyntheticFixture();
  const ns = fixture.manifest.namespace;
  const { child, url } = await spawnRelay();
  log(`relay child up at ${url}`);

  let publisher: Awaited<ReturnType<typeof connectClient>> | null = null;
  let viewer: Awaited<ReturnType<typeof connectClient>> | null = null;
  try {
    publisher = await connectClient(url, 'publisher');
    await publishFixture(publisher.conn, fixture); // unpaced for the smoke

    viewer = await connectClient(url, 'viewer');

    // 1. Catalog: subscribe, parse, assert track list + initData round-trip.
    const catObjs = await subscribeCollect(viewer.conn, ns, 'catalog', 1);
    const catalog = parseCatalogAuto(catObjs[0]!.payload);
    const wantNames = fixture.tracks.map((t) => t.meta.name);
    const gotNames = catalog.tracks.map((t) => t.name);
    if (JSON.stringify(gotNames) !== JSON.stringify(wantNames)) {
      throw new Error(`catalog track list mismatch: got ${JSON.stringify(gotNames)}, want ${JSON.stringify(wantNames)}`);
    }
    for (const t of fixture.tracks) {
      const ct = catalog.tracks.find((c) => c.name === t.meta.name)!;
      const wantInit = Buffer.from(t.initData).toString('base64');
      if (ct.initData !== wantInit) throw new Error(`catalog initData mismatch for ${t.meta.name}`);
      if (ct.codec !== t.meta.codec) throw new Error(`catalog codec mismatch for ${t.meta.name}`);
    }
    log(`catalog ✓ (${gotNames.length} tracks: ${gotNames.join(', ')}; initData + codec round-trip)`);

    // 2. Every media track: assert the exact synthetic chunks, in order, with IDs.
    for (const t of fixture.tracks) {
      const objs = await subscribeCollect(viewer.conn, ns, t.meta.name, CHUNKS_PER_TRACK);
      objs.forEach((o, i) => {
        const want = syntheticChunkPayload(t.meta.name, 0n, i);
        if (td.decode(o.payload) !== td.decode(want)) {
          throw new Error(`${t.meta.name} chunk ${i}: payload mismatch (got ${JSON.stringify(td.decode(o.payload).slice(0, 40))})`);
        }
        if (o.groupId !== 0n || o.subgroupId !== 0n || o.objectId !== BigInt(i)) {
          throw new Error(`${t.meta.name} chunk ${i}: id mismatch (g${o.groupId} sg${o.subgroupId} o${o.objectId})`);
        }
      });
      log(`${t.meta.name} ✓ (${objs.length} chunks, payload + g/sg/o IDs exact)`);
    }

    log('RESULT: catalog + 5 synthetic media tracks published through node-relay and verified. PASS.');
    return 0;
  } catch (err) {
    log('RESULT: FAIL —', (err as Error).message);
    return 1;
  } finally {
    if (viewer) await viewer.close();
    if (publisher) await publisher.close();
    child.kill('SIGTERM');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('[pub-smoke] crashed:', err); process.exit(1); });
