import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const exec = promisify(execFile);

export async function prepareFixture(directory, namespace, frozen = false, signal, alternatives = false, audioCodec = 'aac', views = false) {
  const commands = [];
  const timing = {};
  const tracks = [];
  const duration = 6;
  const videoDefinitions = alternatives
    ? [[640, 360, 800000], [1280, 720, 1800000], [1920, 1080, 3500000]]
    : [[640, 360, 800000]];
  const definitions = videoDefinitions.map(([width, height, bitrate]) => ({
    name: `video-${height}`, role: 'video', codec: alternatives ? 'avc1.42c028' : 'avc1.42c01e',
    source: frozen
      ? 'testsrc2=size=640x360:rate=24,trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/(24*TB)'
      : `testsrc2=size=${alternatives ? '1920x1080' : '640x360'}:rate=24`,
    encoding: ['-an', '-vf', `drawbox=x=0:y=0:w=${alternatives ? 144 : 48}:h=${alternatives ? 144 : 48}:color=0x00ff00:t=fill,scale=${width}:${height}`,
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', alternatives ? '4.0' : '3.0', '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast', '-b:v', String(bitrate), '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-bf', '0'],
    metadata: { width, height, framerate: 24, bitrate, altGroup: 1, label: `${height}p synthetic video` },
  }));
  if (views) definitions.push({
    name: 'video-portrait', role: 'video', codec: 'avc1.42c01e',
    source: 'testsrc2=size=360x640:rate=24',
    encoding: ['-an', '-vf', 'drawbox=x=0:y=0:w=27:h=48:color=0x00ff00:t=fill',
      '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.0', '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast', '-b:v', '800000', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-bf', '0'],
    metadata: { width: 360, height: 640, framerate: 24, bitrate: 800000, altGroup: 0, label: 'Portrait' },
  });
  for (const [lang, frequency] of (alternatives ? [['en', 440], ['es', 880]] : [['en', 440]])) {
    definitions.push({
      name: `audio-${lang}`, role: 'audio', codec: audioCodec === 'opus' ? 'opus' : 'mp4a.40.2',
      source: `sine=frequency=${frequency}:sample_rate=48000`,
      encoding: ['-vn', '-c:a', audioCodec === 'opus' ? 'libopus' : 'aac',
        ...(audioCodec === 'opus' ? ['-frame_duration', '20'] : []), '-b:a', '128k', '-ar', '48000', '-ac', '2'],
      // Different language signals are distinct content, not a CMAF switching set.
      metadata: { samplerate: 48000, channelConfig: '2', bitrate: 128000, lang,
        altGroup: lang === 'en' ? 2 : 3, label: `${lang}: ${frequency} Hz test signal (not speech)` },
    });
  }
  const hashes = {};
  const loaded = [];
  const { tsImport } = createRequire(new URL('../../examples/node-publisher/package.json', import.meta.url))('tsx/esm/api');
  const { analyzeCmafTimeline } = await tsImport('../../examples/node-publisher/src/cmaf-loop-rebase.ts', import.meta.url);
  const { inspectAlternatives } = await tsImport('./alignment.ts', import.meta.url);
  const { inspectLocmafTrack } = await tsImport('./locmaf.ts', import.meta.url);
  for (const track of definitions) {
    const trackDir = join(directory, track.name);
    await mkdir(trackDir, { recursive: true });
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', track.source, '-t', String(duration),
      ...track.encoding, '-f', 'dash', '-dash_segment_type', 'mp4', '-seg_duration', '0.5',
      '-frag_duration', '0.5', '-use_template', '1', '-use_timeline', '0',
      '-init_seg_name', 'init.mp4', '-media_seg_name', 'chunk-$Number%03d$.m4s', join(trackDir, 'manifest.mpd')];
    await exec('ffmpeg', args, { timeout: 60000, signal });
    commands.push({ tool: 'ffmpeg', args });
    const chunks = (await readdir(trackDir)).filter((name) => /^chunk-\d+\.m4s$/.test(name)).sort();
    if (chunks.length < 4) throw new Error(`${track.name}: insufficient generated chunks`);
    for (const file of ['init.mp4', ...chunks]) {
      hashes[`${track.name}/${file}`] = createHash('sha256').update(await readFile(join(trackDir, file))).digest('hex');
    }
    const initData = await readFile(join(trackDir, 'init.mp4'));
    const chunkBytes = await Promise.all(chunks.map((name) => readFile(join(trackDir, name))));
    timing[track.name] = analyzeCmafTimeline(initData, chunkBytes);
    if (!timing[track.name]) throw new Error(`${track.name}: missing CMAF timing`);
    tracks.push({ name: track.name, packaging: 'cmaf', role: track.role, codec: track.codec,
      init: 'init.mp4', chunks, ...track.metadata });
    loaded.push({ meta: tracks.at(-1), initData, chunks: chunkBytes });
  }
  const fixture = { namespace: [namespace], renderGroup: 1, chunkDurationMs: 500, tracks };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  const ffmpeg = (await exec('ffmpeg', ['-version'], { timeout: 10000, signal })).stdout.split('\n')[0];
  const alignment = inspectAlternatives(loaded);
  const locmaf = audioCodec === 'aac' ? loaded.map((track) => inspectLocmafTrack(track)) : undefined;
  let elementaryLoc;
  if (audioCodec === 'opus') {
    const { prepareLocTrack } = await tsImport('../../examples/node-publisher/src/loc-fixture.ts', import.meta.url);
    elementaryLoc = loaded.map((track) => {
      const prepared = prepareLocTrack(track);
      return { name: prepared.name, timescale: prepared.timescale, spanTicks: String(prepared.spanTicks),
        packets: prepared.groups.reduce((count, group) => count + group.frames.length, 0),
        groups: prepared.groups.length, videoConfigSha256: prepared.videoConfig
          ? createHash('sha256').update(prepared.videoConfig).digest('hex') : null };
    });
  }
  const provenance = { generator: 'player-acceptance', source: 'FFmpeg synthetic testsrc2 and sine signals',
    sourceRights: 'Synthetic test signals; no third-party media', ffmpeg, durationS: duration,
    frozen, alternatives, views, audioCodec, commands, sha256: hashes, timing, alignment,
    ...(locmaf ? { locmaf, locmafProof: 'local encoder/decoder equality, not an independent conformance oracle' } : {}),
    ...(elementaryLoc ? { elementaryLoc, opusTiming: 'single-frame 20ms packets; MP4 final trim not carried into LOC' } : {}),
    expected: { videoMarker: 'green top-left square covering 7.5% of width', videoFps: 24,
      videos: definitions.filter(track => track.role === 'video')
        .map(track => ({ name: track.name, width: track.metadata.width, height: track.metadata.height, altGroup: track.metadata.altGroup })),
      audio: alternatives ? { 'audio-en': 440, 'audio-es': 880 } : { 'audio-en': 440 } } };
  await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}
