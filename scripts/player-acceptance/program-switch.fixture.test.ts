/** Fixture byte/property controls. These constructed samples are not native playback evidence. */
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseLocHeaders } from '../../packages/loc/src/index.js';
import { parseLocmafTrackContext, readCmafChunkSamples } from '../../packages/locmaf/src/index.js';
import { videoInit, buildChunk, SYNC_FLAGS, NON_SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';
import { ascii, concat, fullBox, isoBox, u32 } from '../../packages/locmaf/test-support/bytes.js';
import { loadFixtureFromDisk } from '../../examples/node-publisher/src/fixture.js';
import { locFrameProperties, prepareLocTrack } from '../../examples/node-publisher/src/loc-fixture.js';
import { prepareProgramSwitchVariant } from './program-switch.fixture.mjs';
import { MEDIA_TRACKS } from '../../examples/node-relay/src/demo.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
function opusInit() {
  const fields = new Uint8Array(28), view = new DataView(fields.buffer);
  view.setUint16(6, 1); view.setUint16(16, 2); view.setUint32(24, 48000 << 16);
  return isoBox('moov', isoBox('trak',
    fullBox('tkhd', 0, 7, new Uint8Array(8), u32(2), new Uint8Array(64)),
    isoBox('mdia', fullBox('mdhd', 0, 0, new Uint8Array(8), u32(48000), new Uint8Array(8)),
      fullBox('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(12)),
      isoBox('minf', isoBox('stbl', fullBox('stsd', 0, 0, u32(1), isoBox('Opus', fields,
        isoBox('dOps', concat(Uint8Array.of(0, 2, 0, 0), u32(48000), Uint8Array.of(0, 0, 0))))))))),
    isoBox('mvex', fullBox('trex', 0, 0, u32(2), u32(1), u32(0), u32(0), u32(0))));
}
async function source(options: { spanishStart?: bigint; cto?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'playa-program-variant-')); folders.push(root);
  const input = join(root, 'input'), output = join(root, 'output'); await mkdir(input);
  const tracks = [];
  for (const [name, role, lang, scale, base, altGroup] of [
    ['video-360', 'video', undefined, 90000, 900000n, 1],
    ['audio-en', 'audio', 'en', 48000, 480000n, 2],
    ['audio-es', 'audio', 'es', 48000, options.spanishStart ?? 480000n, 3],
  ] as const) {
    await mkdir(join(input, name)); const video = role === 'video';
    await writeFile(join(input, name, 'init.mp4'), video ? videoInit() : opusInit());
    const chunks = ['chunk-1.m4s', 'chunk-2.m4s'];
    for (const [index, file] of chunks.entries()) {
      const duration = video ? 3750 : 960;
      await writeFile(join(input, name, file), buildChunk({ trackId: video ? 1 : 2, tfdtVersion: index === 0 ? 1 : 0,
        bmdt: base + BigInt(index * duration * 2), samples: [
          { duration, size: video ? 6 : 2, flags: SYNC_FLAGS, cto: options.cto ?? 0 },
          { duration, size: video ? 6 : 2, flags: video ? NON_SYNC_FLAGS : SYNC_FLAGS, cto: options.cto ?? 0 },
        ], mdat: video ? Uint8Array.of(0, 0, 0, 1, 0x65, index, 0, 0, 0, 1, 0x41, index)
          : Uint8Array.of(252, lang === 'en' ? 2 : 4, 252, index) }));
    }
    tracks.push({ name, role, lang, packaging: 'cmaf', codec: video ? 'avc1.42c01e' : 'opus',
      ...(video ? { width: 640, height: 360, bitrate: 100000 } : { samplerate: scale, channelConfig: '2' }),
      altGroup, init: 'init.mp4', chunks });
  }
  await writeFile(join(input, 'manifest.json'), JSON.stringify({ namespace: ['native-program-fixture'], renderGroup: 1, chunkDurationMs: 500, tracks }));
  return { input, output };
}

it('uses only explicitly registered relay track identities', async () => {
  const f = await source(), result = await prepareProgramSwitchVariant(f.input, f.output, {});
  for (const track of Object.values(result.programSelectionVariant.tracks)) expect(MEDIA_TRACKS).toContain(track.name);
});

it('creates two programs and a separate same-config view, with exact nonzero raw mappings read back from LOC properties', async () => {
  const f = await source(), result = await prepareProgramSwitchVariant(f.input, f.output, { audioCodec: 'opus' });
  const variant = result.programSelectionVariant, loaded = loadFixtureFromDisk(f.output);
  expect(loaded.tracks.map(({ meta }) => [meta.name, meta.renderGroup, meta.altGroup])).toEqual([
    ['video-360', 1, 1], ['audio-en', 1, 2], ['video-720', 1, 4], ['video-1080', 2, 11], ['audio-es', 2, 12],
  ]);
  expect(variant.maps).toEqual({
    program: { video: { sourceTimeUs: '100000000', referenceTimeUs: '10000000' },
      audio: { sourceTimeUs: '910000000', referenceTimeUs: '10000000' } },
    view: { video: { sourceTimeUs: '710000000', referenceTimeUs: '10000000' } },
  });
  expect(variant).toMatchObject({ kind: 'header-timing-rewrite', metadataOnly: false,
    mediaBytesUnchanged: false, encodedPayloadUnchanged: true });
  for (const definition of Object.values(variant.tracks)) {
    const track = loaded.tracks.find(track => track.meta.name === definition.name)!;
    const prepared = prepareLocTrack(track), properties = locFrameProperties(prepared, prepared.groups[0]!.frames[0]!, 0, 4, 'media', 0n);
    const actual = parseLocHeaders(properties, { wireProfile: 'd18-delta-vi64' });
    expect(actual.captureTimestamp).toBe(BigInt(definition.firstPresentationTimeUs));
    expect(definition.firstLocTimeUs).toBe(definition.firstPresentationTimeUs);
    expect(definition.compositionOffsetsTicks).toEqual([0, 0, 0, 0]);
    expect(definition.durationTicks).toEqual(Array(4).fill(track.meta.role === 'video' ? 3750 : 960));
    const next = parseLocHeaders(locFrameProperties(prepared, prepared.groups[0]!.frames[0]!, 1, 4, 'media', 0n), { wireProfile: 'd18-delta-vi64' });
    expect(next.timestamp! - actual.timestamp!).toBe(prepared.spanTicks);
  }
  expect(loaded.tracks.filter(track => track.meta.role === 'video').map(track => track.initData))
    .toEqual(Array(3).fill(loaded.tracks[0]!.initData));
  const original = loadFixtureFromDisk(f.input);
  expect(original.tracks.map(({ meta }) => meta.renderGroup)).toEqual([undefined, undefined, undefined]);
  const saved = JSON.parse(await readFile(join(f.output, 'provenance.json'), 'utf8'));
  expect(saved.programSelectionVariant).toEqual(variant);
});

it('preserves encoded payload, CTOs, durations and source files while changing only requested tfdt headers', async () => {
  const f = await source(), beforeFiles = new Map<string, Uint8Array>();
  for (const track of loadFixtureFromDisk(f.input).tracks) for (const file of [track.meta.init, ...track.meta.chunks]) {
    const name = `${track.meta.name}/${file}`; beforeFiles.set(name, await readFile(join(f.input, name)));
  }
  const result = await prepareProgramSwitchVariant(f.input, f.output, { alignment: 'input-fixture-only' });
  expect(result.sourceFixture).toEqual({ alignment: 'input-fixture-only' });
  expect(result).not.toHaveProperty('alignment');
  const variant = result.programSelectionVariant, hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  for (const track of loadFixtureFromDisk(f.output).tracks) {
    const definition = Object.values(variant.tracks).find(item => item.name === track.meta.name)!;
    const context = parseLocmafTrackContext(track.initData);
    expect(await readFile(join(f.output, track.meta.name, track.meta.init))).toEqual(await readFile(join(f.input, definition.sourceTrack, track.meta.init)));
    for (const file of track.meta.chunks) {
      const name = `${track.meta.name}/${file}`, sourceName = `${definition.sourceTrack}/${file}`;
      const before = await readFile(join(f.input, sourceName)), after = await readFile(join(f.output, name));
      const a = readCmafChunkSamples(before, context), b = readCmafChunkSamples(after, context);
      expect(b.effective.baseMediaDecodeTime - a.effective.baseMediaDecodeTime)
        .toBe(BigInt(definition.offsetUs) * BigInt(context.timescale) / 1_000_000n);
      expect(b.effective.compositionTimeOffsets).toEqual(a.effective.compositionTimeOffsets);
      expect(b.effective.durations).toEqual(a.effective.durations); expect(b.mdat).toEqual(a.mdat);
      expect(variant.fileHashes[name]).toEqual({ source: sourceName, beforeSha256: hash(before), afterSha256: hash(after) });
      expect(variant.encodedPayloadProof[name]).toEqual({ beforeSha256: hash(a.mdat), afterSha256: hash(b.mdat), bytes: b.mdat.byteLength });
      if (definition.offsetUs === '0') expect(before).toEqual(after);
      else expect(hash(before)).not.toBe(hash(after));
      expect(result.sha256[name]).toBe(hash(after));
    }
  }
  for (const [name, bytes] of beforeFiles) expect(await readFile(join(f.input, name))).toEqual(bytes);
});

it('refuses to claim a +900s audio relationship when the original presentation epochs differ', async () => {
  const f = await source({ spanishStart: 960000n });
  await expect(prepareProgramSwitchVariant(f.input, f.output, {})).rejects.toThrow(/wrong raw offset/);
});

it('refuses nonzero CTOs outside the LOC publisher profile instead of claiming unsupported native timing proof', async () => {
  const f = await source({ cto: 90 });
  await expect(prepareProgramSwitchVariant(f.input, f.output, {})).rejects.toThrow(/composition/);
});
