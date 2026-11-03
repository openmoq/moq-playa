import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function prepareAudioOrderFixture(root, out) {
  await mkdir(out, { recursive: true });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const { tsImport } = createRequire(join(root, 'examples/node-publisher/package.json'))('tsx/esm/api');
  const { childBoxes } = await tsImport(join(root, 'packages/locmaf/src/iso-box.ts'), import.meta.url);
  const { parseLocmafTrackContext, readCmafChunkSamples, sliceFrames, codecDescriptionFromInit } =
    await tsImport(join(root, 'packages/locmaf/src/index.ts'), import.meta.url);
  const { buildChunk } = await tsImport(join(root, 'packages/locmaf/test-support/cmaf.ts'), import.meta.url);
  const args = ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=8000:duration=3.072', '-map', '0:a:0',
    '-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '8000', '-ac', '1', '-b:a', '24k',
    '-avoid_negative_ts', 'make_zero', '-use_editlist', '0',
    '-movflags', '+empty_moov+default_base_moof+frag_every_frame+skip_trailer', '-f', 'mp4', join(out, 'source.mp4')];
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
  const encoding = await promisify(execFile)(ffmpeg, args, { encoding: 'utf8', timeout: 30000 });
  await writeFile(join(out, 'ffmpeg.log'), encoding.stderr);
  const source = new Uint8Array(await readFile(join(out, 'source.mp4')));
  const top = childBoxes(source, 0, source.length, 'fixture');
  const firstMoof = top.findIndex(box => box.type === 'moof');
  assert.ok(firstMoof > 0);
  const init = source.slice(0, top[firstMoof].start);
  const initBoxes = childBoxes(init, 0, init.length, 'fixture');
  const moov = initBoxes.find(box => box.type === 'moov');
  assert.ok(moov);
  for (const trak of childBoxes(init, moov.contentStart, moov.end, 'fixture').filter(box => box.type === 'trak')) {
    assert.ok(!childBoxes(init, trak.contentStart, trak.end, 'fixture').some(box => box.type === 'edts'), 'fixture must not hide AAC priming in an edit list');
  }
  const context = parseLocmafTrackContext(init);
  assert.equal(context.timescale, 8000);
  assert.equal(context.handlerType, 'soun');
  assert.equal(context.codecFourcc, 'mp4a');
  const asc = codecDescriptionFromInit(init);
  assert.ok(asc?.length >= 2);
  assert.equal(asc[0] >> 3, 2, 'AAC LC');
  assert.equal(((asc[0] & 7) << 1) | (asc[1] >> 7), 11, '8000 Hz ASC');
  assert.equal((asc[1] >> 3) & 15, 1, 'mono ASC');
  assert.equal(asc[1] & 4, 0, '1024-sample frameLengthFlag');
  const frames = [];
  for (let i = firstMoof; i < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    assert.equal(top[i + 1]?.type, 'mdat');
    const chunk = source.slice(top[i].start, top[i + 1].end);
    const parsed = readCmafChunkSamples(chunk, context);
    frames.push(...sliceFrames(parsed.effective, parsed.mdat));
  }
  assert.ok(frames.length >= 20);
  const selected = frames.slice(0, 20);
  const rows = [];
  const exactUs = ticks => {
    const numerator = BigInt(ticks) * 1_000_000n;
    assert.equal(numerator % BigInt(context.timescale), 0n, 'fixture timing must have exact integer microseconds');
    return String(numerator / BigInt(context.timescale));
  };
  for (const [i, frame] of selected.entries()) {
    assert.equal(frame.decodeTime, BigInt(i * 1024));
    assert.equal(frame.presentationTime, frame.decodeTime);
    assert.equal(frame.duration, 1024);
    assert.ok(frame.isSync && frame.data.length > 0 && frame.cenc === null);
    const fragment = buildChunk({ trackId: context.trackId, bmdt: frame.decodeTime, sequenceNumber: i + 1,
      samples: [{ duration: frame.duration, size: frame.data.length, flags: frame.flags }], mdat: frame.data });
    const readBack = readCmafChunkSamples(fragment, context);
    assert.equal(readBack.effective.durations.length, 1);
    assert.equal(readBack.effective.baseMediaDecodeTime, frame.decodeTime);
    assert.deepEqual(readBack.mdat, frame.data);
    assert.equal(readBack.effective.durations[0], 1024);
    assert.equal(readBack.effective.flags[0], frame.flags);
    const file = `frame-${String(i).padStart(2, '0')}.m4s`;
    await writeFile(join(out, file), fragment);
    rows.push({ index: i, file, group: i <= 8 ? '7' : '8', bmd: String(readBack.effective.baseMediaDecodeTime),
      dtsUs: exactUs(readBack.effective.baseMediaDecodeTime), duration: readBack.effective.durations[0],
      durationUs: exactUs(readBack.effective.durations[0]), flags: frame.flags, sampleBytes: frame.data.length,
      sampleSha256: hash(frame.data), fragmentSha256: hash(fragment) });
  }
  await writeFile(join(out, 'init.mp4'), init);
  const witness = {
    packets: rows.slice(8, 11),
    nextMinusTailUs: String(BigInt(rows[10].dtsUs) - BigInt(rows[8].dtsUs)),
    twiceTailDurationUs: String(2n * BigInt(rows[8].durationUs)),
    rationale: 'AAC LC at 8 kHz has 1024 ticks = 128000 exact integer microseconds. At 48 kHz, 21333.333... us rounding can turn next-tail into >2d and cause another parser discontinuity, changing the local interval prediction.',
    localIntervalAnalysis: {
      reorderedAfterTail: [[0, 1.280]], reorderedAfterNext: [[0, 1.152], [1.280, 1.408]],
      originalFloorAfterNext: [[0, 1.024], [1.152, 1.408]],
      note: 'Non-normative local interpretation of W3C MSE 5.5.8 steps 6,14,19. These predicted intervals do not establish actual browser behavior, coded-packet attribution, or native sample residency.',
    },
  };
  assert.equal(witness.nextMinusTailUs, witness.twiceTailDurationUs);
  const manifest = { source: 'FFmpeg sine, AAC LC mono 8 kHz', codec: 'mp4a.40.2', timescale: 8000, witness,
    ascHex: Buffer.from(asc).toString('hex'), sourceSha256: hash(source), initSha256: hash(init),
    ffmpeg: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0],
    command: args, frames: rows, prefix: [0, 1, 2, 3, 4, 5, 6, 7], tail: 8, head: 9, next: 10 };
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
