/** Fixture metadata/timing guard only. These bytes are not native PCM evidence. */
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseLocmafTrackContext, readCmafChunkSamples } from '../../packages/locmaf/src/index.js';
import { prepareAudioSwitchVariant } from './audio-switch.fixture.mjs';
import { buildChunk, buildInit, SYNC_FLAGS } from '../../packages/locmaf/test-support/cmaf.js';
import { ascii, concat, fullBox, isoBox, u32 } from '../../packages/locmaf/test-support/bytes.js';
import { prepareLocTrack } from '../../examples/node-publisher/src/loc-fixture.js';

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
async function source(englishStart = 0n, spanishStart = 0n, opus = false) {
  const root = await mkdtemp(join(tmpdir(), 'playa-audio-variant-')); folders.push(root);
  const input = join(root, 'input'), output = join(root, 'output');
  await mkdir(input);
  const tracks = [];
  for (const [language, base, altGroup] of [['en', englishStart, 2], ['es', spanishStart, 3]] as const) {
    const name = `audio-${language}`; await mkdir(join(input, name));
    await writeFile(join(input, name, 'init.mp4'), opus ? opusInit() : buildInit({ trackId: 2, timescale: 48000, handler: 'soun' }));
    const chunks = ['chunk-1.m4s', 'chunk-2.m4s'];
    for (const [index, file] of chunks.entries()) {
      await writeFile(join(input, name, file), buildChunk({ trackId: 2, bmdt: base + BigInt(index * (opus ? 1920 : 1440)),
        tfdtVersion: index === 0 ? 1 : 0,
        samples: opus ? [{ duration: 960, size: 2, flags: SYNC_FLAGS }, { duration: 960, size: 2, flags: SYNC_FLAGS }]
          : [{ duration: 960, size: 4, flags: SYNC_FLAGS, cto: 240 }, { duration: 480, size: 3, flags: SYNC_FLAGS, cto: -120 }],
        mdat: opus ? Uint8Array.of(252, language === 'en' ? 2 : 4, 252, index)
          : Uint8Array.of(1, 2, 3, language === 'en' ? 4 : 5, 6, 7, index) }));
    }
    tracks.push({ name, role: 'audio', packaging: 'cmaf', lang: language, altGroup, init: 'init.mp4', chunks });
  }
  await writeFile(join(input, 'manifest.json'), JSON.stringify({ tracks }));
  await writeFile(join(input, 'provenance.json'), '{}');
  return { input, output };
}

it('creates a new declared altGroup 3 without changing source metadata or encoded bytes', async () => {
  const f = await source(); const result = await prepareAudioSwitchVariant(f.input, f.output, {}, true);
  const before = JSON.parse(await readFile(join(f.input, 'manifest.json'), 'utf8'));
  const after = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  expect(before.tracks.map((track: { altGroup: number }) => track.altGroup)).toEqual([2, 3]);
  expect(after.tracks.map((track: { altGroup: number }) => track.altGroup)).toEqual([3, 3]);
  for (const lang of ['en', 'es']) for (const file of ['init.mp4', 'chunk-1.m4s', 'chunk-2.m4s']) {
    expect(await readFile(join(f.output, `audio-${lang}`, file))).toEqual(await readFile(join(f.input, `audio-${lang}`, file)));
  }
  expect(result.audioSelectionVariant).toMatchObject({ metadataOnly: true, mediaBytesUnchanged: true, audioSamples: 4 });
});

it('refuses to declare a same set when raw presentation origins differ', async () => {
  const f = await source(480000n, 4320000n);
  await expect(prepareAudioSwitchVariant(f.input, f.output, {}, true)).rejects.toThrow(/raw presentation origins/);
});

it('rebases Spanish by 90s and derives nonzero application anchors from actual presentation bytes', async () => {
  const f = await source(480000n, 480000n);
  const sourceSpanish = await readFile(join(f.input, 'audio-es', 'chunk-1.m4s'));
  const result = await prepareAudioSwitchVariant(f.input, f.output, {}, false);
  const after = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  expect(after.tracks.map((track: { altGroup: number }) => track.altGroup)).toEqual([2, 3]);
  const context = parseLocmafTrackContext(await readFile(join(f.output, 'audio-es', 'init.mp4')));
  const first = readCmafChunkSamples(await readFile(join(f.output, 'audio-es', 'chunk-1.m4s')), context).effective;
  // This assertion fails causally if the mapped fixture merely copies bytes
  // and supplies a zero-offset map. Nonzero CTO must remain part of the anchor.
  expect(first.baseMediaDecodeTime).toBe(480000n + 90n * BigInt(context.timescale));
  expect(result.audioSelectionVariant.referenceMap).toEqual({ sourceTimeUs: '100005000', referenceTimeUs: '10005000' });
  expect(BigInt(result.audioSelectionVariant.referenceMap.sourceTimeUs)
    - BigInt(result.audioSelectionVariant.referenceMap.referenceTimeUs)).toBe(90_000_000n);
  expect(result.audioSelectionVariant).toMatchObject({ kind: 'header-timing-rewrite', metadataOnly: false,
    mediaBytesUnchanged: false, encodedPayloadUnchanged: true,
    timingRewrite: { field: 'tfdt', track: 'audio-es', offsetUs: '90000000', offsetTicks: '4320000' } });
  for (const file of ['chunk-1.m4s', 'chunk-2.m4s']) {
    const name = `audio-es/${file}`;
    const beforeBytes = await readFile(join(f.input, name)), afterBytes = await readFile(join(f.output, name));
    const before = readCmafChunkSamples(beforeBytes, context), rewritten = readCmafChunkSamples(afterBytes, context);
    expect(rewritten.effective.baseMediaDecodeTime - before.effective.baseMediaDecodeTime).toBe(4_320_000n);
    expect(rewritten.effective.compositionTimeOffsets).toEqual([240, -120]);
    expect(rewritten.effective.durations).toEqual(before.effective.durations);
    expect(rewritten.effective.sizes).toEqual(before.effective.sizes);
    expect(rewritten.mdat).toEqual(before.mdat);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    expect(result.audioSelectionVariant.fileHashes[name]).toEqual({ beforeSha256: hash(beforeBytes), afterSha256: hash(afterBytes) });
    expect(result.audioSelectionVariant.fileHashes[name]?.beforeSha256).not.toBe(result.audioSelectionVariant.fileHashes[name]?.afterSha256);
    expect(result.audioSelectionVariant.encodedPayloadProof[name]).toEqual({ beforeSha256: hash(before.mdat),
      afterSha256: hash(rewritten.mdat), bytes: before.mdat.byteLength });
  }
  expect(await readFile(join(f.input, 'audio-es', 'chunk-1.m4s'))).toEqual(sourceSpanish);
  for (const name of ['audio-en/init.mp4', 'audio-en/chunk-1.m4s', 'audio-en/chunk-2.m4s', 'audio-es/init.mp4']) {
    expect(await readFile(join(f.output, name))).toEqual(await readFile(join(f.input, name)));
  }
  const saved = JSON.parse(await readFile(join(f.output, 'provenance.json'), 'utf8'));
  expect(saved.audioSelectionVariant).toEqual(result.audioSelectionVariant);
});

it('requires aligned source origins before claiming an exact 90s mapped-fixture separation', async () => {
  const f = await source(480000n, 4320000n);
  await expect(prepareAudioSwitchVariant(f.input, f.output, {}, false)).rejects.toThrow(/original presentation origins/);
});

it('clones equal-PTS Opus alternatives into a declared set while preserving real LOC04 packet preparation', async () => {
  const f = await source(480000n, 480000n, true);
  const result = await prepareAudioSwitchVariant(f.input, f.output, { audioCodec: 'opus' }, true);
  expect(result.audioSelectionVariant).toMatchObject({ kind: 'metadata-only', metadataOnly: true,
    mediaBytesUnchanged: true, sameDeclaredAltGroup: 3, timingRewrite: null,
    referenceMap: { sourceTimeUs: '10000000', referenceTimeUs: '10000000' } });
  const original = JSON.parse(await readFile(join(f.input, 'manifest.json'), 'utf8'));
  const variant = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
  expect(original.tracks.map((track: { altGroup: number }) => track.altGroup)).toEqual([2, 3]);
  expect(variant.tracks.map((track: { altGroup: number }) => track.altGroup)).toEqual([3, 3]);
  const prepared = [];
  for (const lang of ['en', 'es']) {
    const name = `audio-${lang}`;
    const initData = await readFile(join(f.output, name, 'init.mp4'));
    expect(parseLocmafTrackContext(initData).codecFourcc).toBe('Opus');
    const chunks = await Promise.all(['chunk-1.m4s', 'chunk-2.m4s'].map(file => readFile(join(f.output, name, file))));
    const track = prepareLocTrack({ meta: { name, packaging: 'cmaf', role: 'audio', codec: 'opus', samplerate: 48000,
      channelConfig: '2', init: 'init.mp4', chunks: ['chunk-1.m4s', 'chunk-2.m4s'] }, initData, chunks });
    prepared.push(track.groups.flatMap(group => group.frames.map(frame => frame.offsetTicks)));
    expect(track.groups.flatMap(group => group.frames)).toHaveLength(4);
    expect(track.spanTicks).toBe(3840n);
    for (const file of ['init.mp4', 'chunk-1.m4s', 'chunk-2.m4s']) {
      expect(await readFile(join(f.output, name, file))).toEqual(await readFile(join(f.input, name, file)));
    }
  }
  expect(prepared[0]).toEqual(prepared[1]);
  expect(prepared[0]).toEqual([0n, 960n, 1920n, 2880n]);
});
