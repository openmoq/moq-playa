import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const exec = promisify(execFile);

export async function prepareFixture(directory, namespace, frozen = false, signal) {
  const commands = [];
  const timing = {};
  const tracks = [];
  const duration = 6;
  const definitions = [
    {
      name: 'video-360', role: 'video', codec: 'avc1.42c01e',
      source: frozen
        ? 'testsrc2=size=640x360:rate=24,trim=end_frame=1,loop=loop=-1:size=1:start=0,setpts=N/(24*TB)'
        : 'testsrc2=size=640x360:rate=24',
      encoding: ['-an', '-vf', 'drawbox=x=0:y=0:w=48:h=48:color=0x00ff00:t=fill',
        '-c:v', 'libx264', '-profile:v', 'baseline', '-level:v', '3.0', '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast', '-b:v', '800k', '-g', '12', '-keyint_min', '12', '-sc_threshold', '0', '-bf', '0'],
      metadata: { width: 640, height: 360, framerate: 24, bitrate: 800000 },
    },
    {
      name: 'audio-en', role: 'audio', codec: 'mp4a.40.2',
      source: 'sine=frequency=440:sample_rate=48000',
      encoding: ['-vn', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
      metadata: { samplerate: 48000, channelConfig: '2', bitrate: 128000 },
    },
  ];
  const hashes = {};
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
    const { tsImport } = createRequire(new URL('../../examples/node-publisher/package.json', import.meta.url))('tsx/esm/api');
    const { analyzeCmafTimeline } = await tsImport('../../examples/node-publisher/src/cmaf-loop-rebase.ts', import.meta.url);
    timing[track.name] = analyzeCmafTimeline(await readFile(join(trackDir, 'init.mp4')),
      await Promise.all(chunks.map((name) => readFile(join(trackDir, name)))));
    if (!timing[track.name]) throw new Error(`${track.name}: missing CMAF timing`);
    tracks.push({ name: track.name, packaging: 'cmaf', role: track.role, codec: track.codec,
      init: 'init.mp4', chunks, ...track.metadata });
  }
  const fixture = { namespace: [namespace], renderGroup: 1, chunkDurationMs: 500, tracks };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  const ffmpeg = (await exec('ffmpeg', ['-version'], { timeout: 10000, signal })).stdout.split('\n')[0];
  const provenance = { generator: 'player-acceptance', source: 'FFmpeg synthetic testsrc2 and 440 Hz sine',
    sourceRights: 'Synthetic test signals; no third-party media', ffmpeg, durationS: duration,
    frozen, commands, sha256: hashes, timing, expected: { videoMarker: 'green top-left 48x48', audioHz: 440, videoFps: 24 } };
  await writeFile(join(directory, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}
