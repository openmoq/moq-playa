#!/usr/bin/env node
/**
 * prepare-fixture.mjs — offline CMAF fixture generator (FFmpeg is the packager).
 *
 *   node scripts/prepare-fixture.mjs <input.mp4> <outdir> [durationSec] [chunkMs]
 *   e.g. pnpm --filter @moqt/example-node-publisher prepare-fixture in.mp4 fixtures/my-video
 *
 * Per rendition (3 video + 2 audio) it runs one ffmpeg command that encodes and
 * packages CMAF via the DASH muxer: an init.mp4 + chunk-NNN.m4s files (each segment
 * a complete moof+mdat). Then it writes manifest.json (the contract in
 * src/fixture.ts), deriving codec strings from ffprobe of each generated init.
 *
 * Audio mapping: if the source has >= 2 audio streams, audio-en=first, audio-es=
 * second; with exactly 1, BOTH renditions encode the same stream (reported); with
 * none, audio renditions are skipped (reported).
 *
 * OVERWRITES the output: each rendition directory is cleared before generation so
 * a re-run (e.g. shorter duration → fewer chunks) never leaves stale chunk files.
 *
 * Requires ffmpeg + ffprobe on PATH. Runs OFFLINE — never invoked by tests/CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [input, outdirArg, durationArg, chunkMsArg] = process.argv.slice(2);
if (!input || !outdirArg) {
  console.error('usage: prepare-fixture <input.mp4> <outdir> [durationSec=2] [chunkMs=500]');
  process.exit(2);
}
const outdir = resolve(outdirArg);
const durationSec = Number(durationArg ?? 2);
const chunkMs = Number(chunkMsArg ?? 500);
const chunkSec = chunkMs / 1000;

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const ffprobeJson = (args) => JSON.parse(run('ffprobe', ['-v', 'quiet', '-print_format', 'json', ...args]));

for (const tool of ['ffmpeg', 'ffprobe']) {
  try { run(tool, ['-version']); } catch { console.error(`${tool} not found on PATH`); process.exit(2); }
}

// ── Inspect source audio streams ────────────────────────────────────────────
const probe = ffprobeJson(['-show_streams', input]);
const audioStreams = probe.streams.filter((s) => s.codec_type === 'audio');
console.log(`source: ${input} — ${probe.streams.filter((s) => s.codec_type === 'video').length} video, ${audioStreams.length} audio stream(s)`);

// ── Rendition table ─────────────────────────────────────────────────────────
const VIDEO = [
  // fallbackLevel: H.264 level byte used when ffprobe can't report one from an
  // init-only segment (it returns level=-99 there) — 4.0 / 3.1 / 3.0.
  { name: 'video-1080', w: 1920, h: 1080, bitrate: 6_000_000, fallbackLevel: 0x28 },
  { name: 'video-720', w: 1280, h: 720, bitrate: 3_000_000, fallbackLevel: 0x1f },
  { name: 'video-360', w: 640, h: 360, bitrate: 800_000, fallbackLevel: 0x1e },
];
const AUDIO = [];
if (audioStreams.length >= 2) {
  AUDIO.push({ name: 'audio-en', map: '0:a:0' }, { name: 'audio-es', map: '0:a:1' });
} else if (audioStreams.length === 1) {
  console.log('note: source has ONE audio stream — audio-en and audio-es both encode it');
  AUDIO.push({ name: 'audio-en', map: '0:a:0' }, { name: 'audio-es', map: '0:a:0' });
} else {
  console.log('note: source has NO audio — skipping audio renditions');
}

/** Clear + recreate a rendition directory so readdirSync never picks up stale
 *  chunk files from a previous (longer) run. Refuses suspicious paths. */
function freshDir(dir) {
  const r = resolve(dir);
  // Safety: must be at least two path segments deep and inside the fixture outdir.
  if (r === '/' || r.split('/').filter(Boolean).length < 2 || !r.startsWith(outdir + '/')) {
    throw new Error(`refusing to clear suspicious path: ${r}`);
  }
  rmSync(r, { recursive: true, force: true });
  mkdirSync(r, { recursive: true });
}

// ── Encode + package one rendition (ffmpeg DASH muxer → init + .m4s chunks) ──
function rendition(name, mapArgs, codecArgs) {
  const dir = join(outdir, name);
  freshDir(dir); // deterministic output: no stale chunks survive a re-run
  run('ffmpeg', [
    '-y', '-v', 'error', '-t', String(durationSec), '-i', input,
    ...mapArgs, ...codecArgs,
    // keyframe at every chunk boundary so each segment is independently decodable
    '-force_key_frames', `expr:gte(t,n_forced*${chunkSec})`,
    '-f', 'dash', '-dash_segment_type', 'mp4',
    '-seg_duration', String(chunkSec), '-frag_duration', String(chunkSec),
    '-use_template', '1', '-use_timeline', '0', '-single_file', '0',
    '-init_seg_name', 'init.mp4', '-media_seg_name', 'chunk-$Number%03d$.m4s',
    join(dir, 'manifest.mpd'),
  ]);
  rmSync(join(dir, 'manifest.mpd'), { force: true }); // keep only init + chunks
  const chunks = readdirSync(dir).filter((f) => /^chunk-\d+\.m4s$/.test(f)).sort();
  if (chunks.length === 0) throw new Error(`${name}: ffmpeg produced no chunks`);
  return chunks;
}

/** avc1.PPCCLL from ffprobe profile/level of the generated init. ffprobe reports
 *  level=-99 ("unknown") for an init-only segment, so invalid levels fall back to
 *  the rendition's expected level. */
function videoCodecString(initPath, fallbackLevel) {
  try {
    const s = ffprobeJson(['-show_streams', initPath]).streams[0];
    const profiles = { Baseline: '42', 'Constrained Baseline': '42', Main: '4d', High: '64' };
    const pp = profiles[s.profile] ?? '64';
    const probed = Number(s.level);
    const level = Number.isInteger(probed) && probed > 0 && probed <= 0xff ? probed : fallbackLevel;
    return `avc1.${pp}00${level.toString(16).padStart(2, '0')}`;
  } catch { return `avc1.6400${fallbackLevel.toString(16).padStart(2, '0')}`; }
}

const tracks = [];
for (const v of VIDEO) {
  // Letterbox to the exact ladder dimensions (never distort a non-16:9 source).
  const fit = `scale=${v.w}:${v.h}:force_original_aspect_ratio=decrease,pad=${v.w}:${v.h}:(ow-iw)/2:(oh-ih)/2`;
  const chunks = rendition(v.name, ['-map', '0:v:0', '-an'], [
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast',
    '-b:v', String(v.bitrate), '-vf', fit,
  ]);
  const init = join(outdir, v.name, 'init.mp4');
  const st = ffprobeJson(['-show_streams', init]).streams[0] ?? {};
  const fps = (() => {
    const m = /^(\d+)\/(\d+)$/.exec(st.avg_frame_rate ?? st.r_frame_rate ?? '');
    return m && Number(m[2]) > 0 ? Math.round(Number(m[1]) / Number(m[2])) : 30;
  })();
  tracks.push({
    name: v.name, packaging: 'cmaf', role: 'video', codec: videoCodecString(init, v.fallbackLevel),
    width: v.w, height: v.h, framerate: fps,
    bitrate: v.bitrate, init: 'init.mp4', chunks,
  });
  console.log(`${v.name}: ${chunks.length} chunks`);
}
for (const a of AUDIO) {
  const chunks = rendition(a.name, ['-map', a.map, '-vn'], ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']);
  tracks.push({
    name: a.name, packaging: 'cmaf', role: 'audio', codec: 'mp4a.40.2',
    samplerate: 48_000, channelConfig: '2', init: 'init.mp4', chunks,
  });
  console.log(`${a.name}: ${chunks.length} chunks`);
}

// ── Manifest ────────────────────────────────────────────────────────────────
const manifest = { namespace: ['demo'], renderGroup: 1, chunkDurationMs: chunkMs, tracks };
writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ── Summary ─────────────────────────────────────────────────────────────────
let files = 1, bytes = statSync(join(outdir, 'manifest.json')).size;
for (const t of tracks) {
  for (const f of ['init.mp4', ...t.chunks]) {
    files++; bytes += statSync(join(outdir, t.name, f)).size;
  }
}
console.log(`\nfixture written: ${outdir}`);
console.log(`  tracks=${tracks.length}  files=${files}  total=${(bytes / 1024).toFixed(1)} KiB`);
console.log('next: pnpm --filter @moqt/example-node-publisher validate-fixture ' + outdirArg);
