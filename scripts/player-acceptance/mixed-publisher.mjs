import { createRequire } from 'node:module';

const { tsImport } = createRequire(new URL('../../examples/node-publisher/package.json', import.meta.url))('tsx/esm/api');
const { connectClient } = await tsImport('../../examples/node-publisher/src/client.ts', import.meta.url);
const { loadFixtureFromDisk } = await tsImport('../../examples/node-publisher/src/fixture.ts', import.meta.url);
const { publishObjects, establishTrack, buildFixtureCatalog } = await tsImport('../../examples/node-publisher/src/publisher.ts', import.meta.url);
const { prepareLocTrack, locFrameProperties } = await tsImport('../../examples/node-publisher/src/loc-fixture.ts', import.meta.url);
const { TrackObjectSource } = await tsImport('../../examples/node-publisher/src/track-packager.ts', import.meta.url);
const { analyzeCmafTimeline } = await tsImport('../../examples/node-publisher/src/cmaf-loop-rebase.ts', import.meta.url);

const [url, cmafDirectory, locDirectory, cmafRole] = process.argv.slice(2);
if (!url || !cmafDirectory || !locDirectory || !['video', 'audio'].includes(cmafRole)) {
  throw new Error('Usage: mixed-publisher relay cmaf-fixture loc-fixture video|audio');
}
const cmafFixture = loadFixtureFromDisk(cmafDirectory);
const locFixture = loadFixtureFromDisk(locDirectory);
const cmaf = cmafFixture.tracks.find(t => t.meta.role === cmafRole);
const loc = locFixture.tracks.find(t => t.meta.role !== cmafRole);
if (!cmaf || !loc) throw new Error('Missing selected fixture track');
const raw = JSON.parse(new TextDecoder().decode(buildFixtureCatalog({ ...cmafFixture, tracks: [cmaf] }, 'cmsf-01')));
raw.tracks.push({ ...loc.meta, packaging: 'loc', isLive: true, renderGroup: locFixture.manifest.renderGroup });
const elementary = prepareLocTrack(loc);
const source = new TrackObjectSource(cmaf, 'cmaf');
const timeline = analyzeCmafTimeline(cmaf.initData, cmaf.chunks);
if (!timeline) throw new Error('Missing CMAF timing');
const cancelled = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => cancelled.abort());
async function wait(target) {
  cancelled.signal.throwIfAborted();
  const delay = target - performance.now();
  if (delay > 0) {
    let timer;
    const signal = cancelled.signal;
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  cancelled.signal.throwIfAborted();
}
const client = await connectClient(url, 'mixed publisher');
try {
  await publishObjects(client.conn, cmafFixture.manifest.namespace, 'catalog', 10n, [new TextEncoder().encode(JSON.stringify(raw))], 0);
  await establishTrack(client.conn, cmafFixture.manifest.namespace, cmaf.meta.name, 11n);
  await establishTrack(client.conn, cmafFixture.manifest.namespace, loc.meta.name, 12n);
  const start = performance.now();
  const epochUs = BigInt(Date.now()) * 1000n;
  console.log(`loop mode: 2 tracks established; mixed CMAF/LOC; epoch_us=${epochUs}`);
  await Promise.all([
    (async () => {
      for (let group = 0; ; group++) {
        const chunks = source.objectsForGroup(group);
        for (let object = 0; object < chunks.length; object++) {
          await wait(start + group * timeline.durationMs + timeline.offsetsMs[object]);
          const stream = await client.conn.openSubgroup(11n, BigInt(group), BigInt(object), {
            firstObject: true, endOfGroup: object === chunks.length - 1,
          });
          await client.conn.sendObject(stream, BigInt(object), chunks[object]);
          await client.conn.closeSubgroup(stream);
        }
      }
    })(),
    (async () => {
      for (let loop = 0; ; loop++) for (let g = 0; g < elementary.groups.length; g++) {
        const frames = elementary.groups[g].frames;
        for (let object = 0; object < frames.length; object++) {
          const frame = frames[object];
          await wait(start + Number(BigInt(loop) * elementary.spanTicks + frame.offsetTicks) / elementary.timescale * 1000);
          const stream = await client.conn.openSubgroup(12n, BigInt(loop * elementary.groups.length + g), BigInt(object), {
            hasExtensions: true, firstObject: true, endOfGroup: object === frames.length - 1,
          });
          await client.conn.sendObject(stream, BigInt(object), frame.payload, locFrameProperties(elementary, frame, loop, 4, 'media', epochUs));
          await client.conn.closeSubgroup(stream);
        }
      }
    })(),
  ]);
} catch (error) {
  if (!cancelled.signal.aborted) throw error;
} finally { await client.close(); }
