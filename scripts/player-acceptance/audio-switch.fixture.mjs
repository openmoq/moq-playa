// @ts-check
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** @typedef {{name: string, role: string, lang?: string, altGroup: number, init: string, chunks: string[]}} FixtureTrack */
const hash = /** @param {Uint8Array} bytes */ bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Clone only: same-set changes catalog metadata; explicit-map shifts Spanish
 * tfdt by 90s. Coded payload, CTOs and durations are verified separately.
 * @param {string} source
 * @param {string} destination
 * @param {Readonly<Record<string, unknown>>} provenance
 * @param {boolean} sameSet
 */
export async function prepareAudioSwitchVariant(source, destination, provenance, sameSet) {
  /** @type {{tracks: FixtureTrack[]}} */
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  const english = manifest.tracks.find(track => track.role === 'audio' && track.lang === 'en');
  const spanish = manifest.tracks.find(track => track.role === 'audio' && track.lang === 'es');
  assert.ok(english && spanish, 'Audio selection fixture needs English and Spanish tracks');
  const { tsImport } = createRequire(new URL('../../examples/node-publisher/package.json', import.meta.url))('tsx/esm/api');
  /** @type {typeof import('../../packages/locmaf/src/index.js')} */
  const format = await tsImport('../../packages/locmaf/src/index.ts', import.meta.url);
  const { parseLocmafTrackContext, readCmafChunkSamples } = format;
  /** @type {typeof import('../../examples/node-publisher/src/cmaf-loop-rebase.js')} */
  const rebase = await tsImport('../../examples/node-publisher/src/cmaf-loop-rebase.ts', import.meta.url);
  /** @param {string} directory @param {FixtureTrack} track */
  const timing = async (directory, track) => {
    const context = parseLocmafTrackContext(await readFile(join(directory, track.name, track.init)));
    /** @type {Array<{presentation: bigint, duration: number}>} */
    const samples = [];
    for (const file of track.chunks) {
      const effective = readCmafChunkSamples(await readFile(join(directory, track.name, file)), context).effective;
      let decode = effective.baseMediaDecodeTime;
      for (const [i, duration] of effective.durations.entries()) {
        samples.push({ presentation: decode + BigInt(effective.compositionTimeOffsets[i] ?? 0), duration });
        decode += BigInt(duration);
      }
    }
    const first = samples[0];
    assert.ok(first, 'Audio fixture needs actual CMAF samples');
    return { context, scale: context.timescale, first: first.presentation,
      relative: samples.map(sample => ({ pts: String(sample.presentation - first.presentation), duration: sample.duration })) };
  };
  const reference = await timing(source, english), target = await timing(source, spanish);
  assert.equal(reference.scale, target.scale, 'Fixture audio timescales must match');
  assert.deepEqual(reference.relative, target.relative, 'Fixture audio must have identical presentation pacing and sample durations');
  if (sameSet) assert.equal(reference.first, target.first, 'A declared shared audio set needs equal raw presentation origins');
  else assert.equal(reference.first, target.first, 'The +90s mapped fixture requires equal original presentation origins');
  const deltaTicks = 90n * BigInt(target.scale);
  const originalSets = [english.altGroup, spanish.altGroup];
  if (!sameSet) assert.notEqual(english.altGroup, spanish.altGroup, 'Explicit-map control must keep distinct declared audio sets');
  if (sameSet) { english.altGroup = 3; spanish.altGroup = 3; }
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  /** @type {Record<string, string>} */
  const sha256 = {};
  /** @type {import('./audio-switch.fixture.mjs').AudioSwitchVariant['fileHashes']} */
  const fileHashes = {};
  /** @type {import('./audio-switch.fixture.mjs').AudioSwitchVariant['encodedPayloadProof']} */
  const encodedPayloadProof = {};
  for (const track of manifest.tracks) for (const file of [track.init, ...track.chunks]) {
    const name = `${track.name}/${file}`;
    const before = await readFile(join(source, name));
    const rewrite = !sameSet && track.name === spanish.name && file !== track.init;
    if (rewrite) await writeFile(join(destination, name), rebase.rebaseTfdtCopy(before, deltaTicks));
    const after = await readFile(join(destination, name));
    if (rewrite) {
      assert.ok(!before.equals(after), `Spanish timing rewrite did not change bytes: ${name}`);
      const original = readCmafChunkSamples(before, target.context), rewritten = readCmafChunkSamples(after, target.context);
      assert.equal(rewritten.effective.baseMediaDecodeTime - original.effective.baseMediaDecodeTime, deltaTicks,
        `Spanish tfdt did not advance by exactly 90s: ${name}`);
      assert.deepEqual({ ...rewritten.effective, baseMediaDecodeTime: 0n }, { ...original.effective, baseMediaDecodeTime: 0n },
        `Timing rewrite changed CTOs, durations or other sample fields: ${name}`);
      assert.deepEqual(rewritten.mdat, original.mdat, `Timing rewrite changed coded payload: ${name}`);
      assert.deepEqual(rebase.rebaseTfdtCopy(after, -deltaTicks), new Uint8Array(before),
        `Timing rewrite changed bytes outside tfdt: ${name}`);
      encodedPayloadProof[name] = { beforeSha256: hash(original.mdat), afterSha256: hash(rewritten.mdat), bytes: original.mdat.byteLength };
    } else assert.ok(before.equals(after), `Unrequested encoded byte change: ${name}`);
    fileHashes[name] = { beforeSha256: hash(before), afterSha256: hash(after) };
    sha256[name] = hash(after);
  }
  // Anchor read-back happens AFTER the rewrite, from the bytes the publisher
  // will actually load. Neither tfdt alone nor a promised offset is evidence.
  const emittedReference = await timing(destination, english), emittedTarget = await timing(destination, spanish);
  assert.deepEqual(emittedTarget.relative, target.relative, 'Rewritten presentation pacing or durations changed');
  assert.equal(emittedReference.first, reference.first, 'English raw presentation origin changed');
  assert.equal(emittedTarget.first - emittedReference.first, sameSet ? 0n : deltaTicks, 'Variant must have its declared raw 0s/90s separation');
  const scale = BigInt(emittedReference.scale);
  assert.equal(emittedReference.first * 1_000_000n % scale, 0n, 'Reference anchor must be exact microseconds');
  assert.equal(emittedTarget.first * 1_000_000n % scale, 0n, 'Source anchor must be exact microseconds');
  /** @type {import('./audio-switch.fixture.mjs').AudioSwitchVariant} */
  const variant = { kind: sameSet ? 'metadata-only' : 'header-timing-rewrite', sameDeclaredAltGroup: sameSet ? 3 : null,
    originalSets, metadataOnly: sameSet, mediaBytesUnchanged: sameSet, encodedPayloadUnchanged: true,
    fileHashes, encodedPayloadProof, audioSamples: reference.relative.length,
    timingRewrite: sameSet ? null : { field: 'tfdt', track: spanish.name, offsetUs: '90000000', offsetTicks: String(deltaTicks) },
    referenceMap: { sourceTimeUs: String(emittedTarget.first * 1_000_000n / scale),
      referenceTimeUs: String(emittedReference.first * 1_000_000n / scale) },
    timingEvidence: 'On-disk CMAF presentation times (tfdt + CTO) and durations; header timing rewrite preserves coded payload bytes' };
  const result = { ...provenance, sha256, audioSelectionVariant: variant };
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(destination, 'provenance.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
