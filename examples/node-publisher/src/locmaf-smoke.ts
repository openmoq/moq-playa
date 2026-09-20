/**
 * LOCMAF smoke: publish a REAL prepared fixture as LOCMAF through a REAL node-relay
 * and reconstruct every object on the far side.
 *
 *   - SPAWNS the relay as a child process (as `smoke.ts` does);
 *   - connects a VERIFICATION SUBSCRIBER and subscribes every media track first;
 *   - connects the PUBLISHER and publishes the fixture, paced, with `packaging: locmaf`
 *     (CMSF-01 catalog, init by reference);
 *   - the subscriber then parses the catalog, asserts every track is
 *     `packaging: "locmaf"` with a supported `locmafVersion` and that its referenced
 *     CMAF Header is the fixture's init, and feeds every received media object to a
 *     `LocmafTrackDecoder` seeded from that header, asserting object
 *     ids, a sync first sample on video, increasing decode times, and an mdat payload
 *     byte-identical to the fixture chunk it came from.
 *
 * Needs a real fixture (the synthetic one has no CMAF Header):
 *   pnpm --filter @moqt/example-node-publisher prepare-fixture   (once)
 *   pnpm --filter @moqt/example-node-publisher smoke:locmaf [fixture-dir]
 *
 * @see draft-einarsson-moq-locmaf-01 sections 3, 5, 6, 15
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTrackPackagingSupported, parseCatalogAuto } from '@moqt/msf';
import { LocmafTrackDecoder } from '@moqt/locmaf';
import { connectClient, subscribeCollect } from './client.js';
import { publishFixture } from './publisher.js';
import { loadFixtureFromDisk } from './fixture.js';
import { relayCertExists, RELAY_CERT_PATH } from './cert.js';

const log = (...a: unknown[]) => console.log('[locmaf-smoke]', ...a);
const here = dirname(fileURLToPath(import.meta.url));
/** Per-object publish pacing: keeps live forwarding under node-relay's per-subscriber backlog. */
const PACE_MS = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      const m = buf.match(/listening on (https:\/\/\S+)/);
      if (m) { clearTimeout(timer); res({ child, url: m[1]! }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`relay child exited early (code ${code})`)); });
  });
}

/** The payload of the first top-level mdat box, or null. */
function mdatPayload(bytes: Uint8Array): Uint8Array | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 8 <= bytes.byteLength) {
    let size = dv.getUint32(off);
    let header = 8;
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    if (size === 1) {
      if (off + 16 > bytes.byteLength) return null;
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = bytes.byteLength - off;
    }
    if (size < header || off + size > bytes.byteLength) return null;
    if (type === 'mdat') return bytes.subarray(off + header, off + size);
    off += size;
  }
  return null;
}

async function main(): Promise<number> {
  if (!relayCertExists()) {
    log(`relay cert missing (${RELAY_CERT_PATH}) — run \`pnpm --filter @moqt/example-node-relay gen-cert\` first.`);
    return 1;
  }
  const fixtureDir = resolve(process.argv[2] ?? join(here, '..', 'fixtures', 'testsrc'));
  if (!existsSync(join(fixtureDir, 'manifest.json'))) {
    log(`no prepared fixture at ${fixtureDir} — run \`pnpm --filter @moqt/example-node-publisher prepare-fixture\` first.`);
    return 1;
  }

  const fixture = loadFixtureFromDisk(fixtureDir);
  const ns = fixture.manifest.namespace;
  const { child, url } = await spawnRelay();
  log(`relay child up at ${url}`);

  let publisher: Awaited<ReturnType<typeof connectClient>> | null = null;
  let viewer: Awaited<ReturnType<typeof connectClient>> | null = null;
  try {
    publisher = await connectClient(url, 'publisher');
    viewer = await connectClient(url, 'viewer');

    // Subscribe every media track BEFORE publishing so its objects are forwarded
    // live. A late join makes node-relay replay the whole cached group at once, and
    // a 1080p group is larger than its per-subscriber forwarding backlog, so it
    // closes the viewer's connection (the same happens with CMAF; it is not LOCMAF).
    const viewerConn = viewer.conn;
    const collections = fixture.tracks.map((t) => ({
      track: t,
      objects: subscribeCollect(viewerConn, ns, t.meta.name, t.chunks.length, 60_000),
    }));
    for (const c of collections) c.objects.catch(() => { /* surfaced when awaited below */ });
    await sleep(500); // let every SUBSCRIBE land before the first object is published
    await publishFixture(publisher.conn, fixture, { packaging: 'locmaf', catalogFormat: 'cmsf-01', paceMs: PACE_MS });

    // 1. Catalog: every track LOCMAF, supported version, init by reference = fixture init.
    const catObjs = await subscribeCollect(viewer.conn, ns, 'catalog', 1);
    const catalog = parseCatalogAuto(catObjs[0]!.payload);
    const inits = new Map<string, Uint8Array>();
    for (const t of fixture.tracks) {
      const ct = catalog.tracks.find((c) => c.name === t.meta.name);
      if (!ct) throw new Error(`catalog is missing track ${t.meta.name}`);
      if (ct.packaging !== 'locmaf') throw new Error(`${t.meta.name}: packaging ${ct.packaging}, want locmaf`);
      if (!isTrackPackagingSupported(ct)) throw new Error(`${t.meta.name}: unsupported locmafVersion ${ct.locmafVersion}`);
      const entry = catalog.initDataList?.find((e) => e.id === ct.initRef);
      const b64 = entry?.data ?? ct.initData;
      if (b64 === undefined) throw new Error(`${t.meta.name}: no CMAF Header in the catalog`);
      const init = new Uint8Array(Buffer.from(b64, 'base64'));
      if (Buffer.compare(init, t.initData) !== 0) throw new Error(`${t.meta.name}: catalog CMAF Header differs from the fixture init`);
      inits.set(t.meta.name, init);
    }
    log(`catalog ✓ (${fixture.tracks.length} locmaf tracks, locmafVersion + CMAF Header round-trip)`);

    // 2. Every media track: reconstruct each object and compare its media bytes.
    for (const { track: t, objects } of collections) {
      const objs = await objects;
      const decoder = new LocmafTrackDecoder(inits.get(t.meta.name)!);
      let previousBmdt: bigint | null = null;
      objs.forEach((o, i) => {
        if (o.groupId !== 0n || o.objectId !== BigInt(i)) {
          throw new Error(`${t.meta.name} object ${i}: id mismatch (g${o.groupId} o${o.objectId})`);
        }
        const r = decoder.push(o.groupId, o.objectId, o.payload);
        if (r.kind !== 'chunk') {
          throw new Error(`${t.meta.name} object ${i}: decoded to ${r.kind}${r.kind === 'rejected' ? ` (${r.error.message})` : ''}`);
        }
        if (t.meta.role === 'video' && i === 0 && !r.startsWithSync) {
          throw new Error(`${t.meta.name}: group does not start on a sync sample`);
        }
        if (previousBmdt !== null && r.baseMediaDecodeTime <= previousBmdt) {
          throw new Error(`${t.meta.name} object ${i}: decode time ${r.baseMediaDecodeTime} not after ${previousBmdt}`);
        }
        previousBmdt = r.baseMediaDecodeTime;
        const got = mdatPayload(r.bytes);
        const want = mdatPayload(t.chunks[i]!);
        if (!got || !want || Buffer.compare(got, want) !== 0) {
          throw new Error(`${t.meta.name} object ${i}: reconstructed mdat payload differs from the fixture chunk`);
        }
      });
      log(`${t.meta.name} ✓ (${objs.length} objects reconstructed; ids, sync start, decode times, mdat bytes exact)`);
    }

    log(`RESULT: ${fixture.tracks.length} LOCMAF tracks published through node-relay and reconstructed. PASS.`);
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
  .catch((err) => { console.error('[locmaf-smoke] crashed:', err); process.exit(1); });
