// @ts-check
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const hash = /** @param {Uint8Array} bytes */ bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Five unique LOC tracks from the existing 360p AVC + English/Spanish Opus fixture.
 * Only tfdt headers move; sample payloads, CTOs, durations and decoder configs do not.
 * The LOC publisher explicitly retains these on-disk origins, but paces from zero.
 * @param {string} source @param {string} destination
 * @param {Readonly<Record<string, unknown>>} provenance
 */
export async function prepareProgramSwitchVariant(source, destination, provenance) {
  /** @type {import('../../examples/node-publisher/src/fixture.js').FixtureManifest} */
  const original = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const video = original.tracks.find(track => track.name === 'video-360' && track.role === 'video');
  const english = original.tracks.find(track => track.role === 'audio' && track.lang === 'en');
  const spanish = original.tracks.find(track => track.role === 'audio' && track.lang === 'es');
  assert.ok(video && english && spanish, 'Program fixture needs 360p video and en/es audio');
  assert.ok(video.width === 640 && video.height === 360 && video.codec.startsWith('avc1.'), 'Program fixture needs native 640x360 AVC');
  assert.ok(english.codec === 'opus' && spanish.codec === 'opus', 'Program LOC fixture requires Opus alternatives');
  const { tsImport } = createRequire(new URL('../../examples/node-publisher/package.json', import.meta.url))('tsx/esm/api');
  /** @type {typeof import('../../packages/locmaf/src/index.js')} */
  const format = await tsImport('../../packages/locmaf/src/index.ts', import.meta.url);
  /** @type {typeof import('../../examples/node-publisher/src/cmaf-loop-rebase.js')} */
  const rebase = await tsImport('../../examples/node-publisher/src/cmaf-loop-rebase.ts', import.meta.url);
  /** @type {typeof import('../../examples/node-publisher/src/loc-fixture.js')} */
  const loc = await tsImport('../../examples/node-publisher/src/loc-fixture.ts', import.meta.url);
  /** @type {typeof import('../../packages/loc/src/index.js')} */
  const headers = await tsImport('../../packages/loc/src/index.ts', import.meta.url);
  // The demo relay's fixed names are opaque wire identifiers. Every video
  // clone still declares its actual 640x360 dimensions and identical AVC init;
  // the suffix never selects or relabels the encoded rendition.
  const definitions = /** @type {const} */ ([
    { key: 'oldVideo', input: video, name: 'video-360', renderGroup: 1, altGroup: 1, offsetUs: 0n },
    { key: 'oldAudio', input: english, name: 'audio-en', renderGroup: 1, altGroup: 2, offsetUs: 0n },
    { key: 'viewVideo', input: video, name: 'video-720', renderGroup: 1, altGroup: 4, offsetUs: 700_000_000n },
    { key: 'nextVideo', input: video, name: 'video-1080', renderGroup: 2, altGroup: 11, offsetUs: 90_000_000n },
    { key: 'nextAudio', input: spanish, name: 'audio-es', renderGroup: 2, altGroup: 12, offsetUs: 900_000_000n },
  ]);
  /** @type {import('../../examples/node-publisher/src/fixture.js').FixtureTrack[]} */
  const tracks = [];
  /** @type {Partial<import('./program-switch.fixture.mjs').ProgramSwitchVariant['tracks']>} */
  const timing = {};
  /** @type {import('./program-switch.fixture.mjs').ProgramSwitchVariant['fileHashes']} */
  const fileHashes = {};
  /** @type {import('./program-switch.fixture.mjs').ProgramSwitchVariant['encodedPayloadProof']} */
  const encodedPayloadProof = {};
  /** @type {Record<string, string>} */
  const sha256 = {};
  await mkdir(destination);
  for (const definition of definitions) {
    const { input, name, offsetUs } = definition;
    const initData = await readFile(join(source, input.name, input.init));
    const context = format.parseLocmafTrackContext(initData);
    const delta = offsetUs * BigInt(context.timescale) / 1_000_000n;
    assert.equal(delta * 1_000_000n, offsetUs * BigInt(context.timescale), `${name}: offset must be exact ticks`);
    const meta = { ...input, name, renderGroup: definition.renderGroup, altGroup: definition.altGroup,
      preserveMediaTimeOrigin: true };
    tracks.push(meta);
    await cp(join(source, input.name), join(destination, name), { recursive: true, errorOnExist: true, force: false });
    /** @type {Uint8Array[]} */
    const chunks = [];
    /** @type {number[]} */
    const compositionOffsetsTicks = [], durationTicks = [];
    /** @type {bigint | undefined} */
    let firstPresentation;
    for (const file of [input.init, ...input.chunks]) {
      const sourceName = `${input.name}/${file}`, outputName = `${name}/${file}`;
      const before = await readFile(join(source, sourceName));
      const after = file === input.init || delta === 0n ? before : rebase.rebaseTfdtCopy(before, delta);
      if (file !== input.init) {
        const a = format.readCmafChunkSamples(before, context), b = format.readCmafChunkSamples(after, context);
        assert.equal(b.effective.baseMediaDecodeTime - a.effective.baseMediaDecodeTime, delta);
        assert.deepEqual({ ...a.effective, baseMediaDecodeTime: 0n }, { ...b.effective, baseMediaDecodeTime: 0n }, `${name}: sample metadata changed`);
        assert.deepEqual(new Uint8Array(a.mdat), new Uint8Array(b.mdat), `${name}: encoded samples changed`);
        assert.deepEqual(rebase.rebaseTfdtCopy(after, -delta), new Uint8Array(before), `${name}: changed bytes outside tfdt`);
        firstPresentation ??= b.effective.baseMediaDecodeTime + BigInt(b.effective.compositionTimeOffsets[0] ?? 0);
        compositionOffsetsTicks.push(...b.effective.compositionTimeOffsets);
        durationTicks.push(...b.effective.durations);
        chunks.push(after);
        encodedPayloadProof[outputName] = { beforeSha256: hash(a.mdat), afterSha256: hash(b.mdat), bytes: b.mdat.byteLength };
      }
      await writeFile(join(destination, outputName), after);
      const disk = await readFile(join(destination, outputName));
      assert.deepEqual(new Uint8Array(disk), new Uint8Array(after), `${name}: written bytes differ`);
      fileHashes[outputName] = { source: sourceName, beforeSha256: hash(before), afterSha256: hash(disk) };
      sha256[outputName] = hash(disk);
    }
    assert.ok(firstPresentation !== undefined && durationTicks.length > 0, `${name}: no presentation samples`);
    assert.equal(firstPresentation * 1_000_000n % BigInt(context.timescale), 0n, `${name}: anchor must be exact microseconds`);
    const firstUs = firstPresentation * 1_000_000n / BigInt(context.timescale);
    const prepared = loc.prepareLocTrack({ meta, initData, chunks });
    const firstFrame = prepared.groups[0]?.frames[0]; assert.ok(firstFrame, `${name}: no LOC frame`);
    const properties = loc.locFrameProperties(prepared, firstFrame, 0, 4, 'media', 0n);
    const firstLocUs = headers.parseLocHeaders(properties, { wireProfile: 'd18-delta-vi64' }).captureTimestamp;
    assert.equal(firstLocUs, firstUs, `${name}: LOC publisher lost the on-disk raw presentation origin`);
    timing[definition.key] = { name, sourceTrack: input.name, role: input.role, renderGroup: definition.renderGroup,
      altGroup: definition.altGroup, offsetUs: String(offsetUs), firstPresentationTimeUs: String(firstUs),
      firstLocTimeUs: String(firstLocUs), timescale: context.timescale, samples: durationTicks.length,
      compositionOffsetsTicks, durationTicks };
  }
  const { oldVideo, oldAudio, viewVideo, nextVideo, nextAudio } = timing;
  assert.ok(oldVideo && oldAudio && viewVideo && nextVideo && nextAudio);
  for (const [target, origin, delta] of /** @type {const} */ ([[viewVideo, oldVideo, 700_000_000n], [nextVideo, oldVideo, 90_000_000n],
    [nextAudio, oldAudio, 900_000_000n]])) {
    assert.equal(BigInt(target.firstPresentationTimeUs) - BigInt(origin.firstPresentationTimeUs), delta, `${target.name}: wrong raw offset`);
    assert.deepEqual(target.durationTicks, origin.durationTicks, `${target.name}: pacing changed`);
    assert.deepEqual(target.compositionOffsetsTicks, origin.compositionOffsetsTicks, `${target.name}: CTOs changed`);
  }
  /** @type {import('./program-switch.fixture.mjs').ProgramSwitchVariant} */
  const variant = { kind: 'header-timing-rewrite', metadataOnly: false, mediaBytesUnchanged: false, encodedPayloadUnchanged: true,
    tracks: { oldVideo, oldAudio, viewVideo, nextVideo, nextAudio }, fileHashes, encodedPayloadProof,
    maps: {
      program: { video: { sourceTimeUs: nextVideo.firstPresentationTimeUs, referenceTimeUs: oldAudio.firstPresentationTimeUs },
        audio: { sourceTimeUs: nextAudio.firstPresentationTimeUs, referenceTimeUs: oldAudio.firstPresentationTimeUs } },
      view: { video: { sourceTimeUs: viewVideo.firstPresentationTimeUs, referenceTimeUs: oldAudio.firstPresentationTimeUs } },
    },
    timingEvidence: 'Read-back CMAF PTS (tfdt + CTO), sample fields, payload hashes and actual LOC04 first-frame properties; no native output claim' };
  // Original ladder/alignment metadata describes the INPUT fixture, not these
  // independent program/view sets. Keep it explicitly under sourceFixture.
  const result = { generator: 'player-acceptance-program-variant', sourceFixture: provenance,
    sha256, programSelectionVariant: variant };
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify({ ...original, tracks }, null, 2)}\n`);
  await writeFile(join(destination, 'provenance.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
