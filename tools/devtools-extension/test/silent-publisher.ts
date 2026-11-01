// TEST-ONLY publisher for the negatives gate: publishes a real CMAF fixture CATALOG and establishes every media
// track (PUBLISH → accepted) through the example publisher's public helpers over `MoqtConnection`, then sends NO
// audio/video objects and keeps the session alive until stopped. A subscriber therefore sees accepted media
// subscriptions that never deliver. Run with tsx from examples/node-publisher (its dependencies):
//   pnpm --filter @moqt/example-node-publisher exec tsx <this file> https://relay/moq fixture-directory [--trigger=path]
// `--trigger=path` is the gate's CONTROL hook: when that file appears (the gate creates it only after the player is
// attached and its media requests are accepted), exactly ONE video object (the track's init segment bytes as a
// payload) is sent and a send witness line is logged, so the silent assertions must fail on a real later receipt.
import { existsSync } from 'node:fs';
import { connectClient } from '../../../examples/node-publisher/src/client.js';
import { loadFixtureFromDisk } from '../../../examples/node-publisher/src/fixture.js';
import { buildFixtureCatalog, establishTrack, publishObjects } from '../../../examples/node-publisher/src/publisher.js';

const [url, directory, ...flags] = process.argv.slice(2);
if (!url?.startsWith('https://') || !directory) throw new Error('Usage: silent-publisher https://relay/moq fixture-directory [--trigger=path]');
const trigger = flags.find(f => f.startsWith('--trigger='))?.slice('--trigger='.length) ?? null;
const fixture = loadFixtureFromDisk(directory);
const client = await connectClient(url, 'silent publisher');
const log = (...a: unknown[]) => console.log('[silent]', ...a);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
try {
  const catalog = buildFixtureCatalog(fixture, 'cmsf-01', 'cmaf');
  await publishObjects(client.conn, fixture.manifest.namespace, 'catalog', 10n, [catalog], 0);
  for (let i = 0; i < fixture.tracks.length; i++) {
    const track = fixture.tracks[i]!;
    await establishTrack(client.conn, fixture.manifest.namespace, track.meta.name, BigInt(11 + i));
    log(`established ${track.meta.name} (alias ${11 + i}); no objects will follow`);
  }
  log('tracks established'); // the gate waits for this exact line
  let stopped = false;
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => { stopped = true; });
  while (!stopped) {
    if (trigger !== null && existsSync(trigger)) {
      const index = fixture.tracks.findIndex(t => /video/.test(t.meta.name));
      const t = fixture.tracks[index === -1 ? 0 : index]!;
      const alias = BigInt(11 + (index === -1 ? 0 : index));
      const sid = await client.conn.openSubgroup(alias, 0n, 0n, { publisherPriority: 128, firstObject: true, endOfGroup: true });
      await client.conn.sendObject(sid, 0n, t.initData); await client.conn.closeSubgroup(sid);
      log(`CONTROL: sent one object on ${t.meta.name} (alias ${alias}) group 0 object 0, ${t.initData.byteLength} bytes`); // send witness
      while (!stopped) await sleep(200);
      break;
    }
    await sleep(200);
  }
} finally { await client.close(); }
