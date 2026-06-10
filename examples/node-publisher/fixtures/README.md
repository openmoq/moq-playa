# Fixtures

A fixture is a directory of **prepared per-track CMAF files** plus a `manifest.json`.
The publisher does no media parsing: each chunk file is published as one MoQT object,
and init segments ride in the MSF catalog as base64 `initData`.

## Layout

```
fixtures/bbb-2s/                  # ~2 seconds is plenty; keep fixtures tiny
  manifest.json
  video-1080/init.mp4  chunk-000.m4s  chunk-001.m4s ...
  video-720/ init.mp4  chunk-000.m4s ...
  video-360/ init.mp4  chunk-000.m4s ...
  audio-en/  init.mp4  chunk-000.m4s ...
  audio-es/  init.mp4  chunk-000.m4s ...
```

Each `chunk-NNN.m4s` must be one complete CMAF chunk (`moof` followed by `mdat`) —
that is what the Playa player's CMAF/MSE pipeline expects per object (CMSF §3.3).

## manifest.json

```json
{
  "namespace": ["demo"],
  "renderGroup": 1,
  "chunkDurationMs": 500,
  "tracks": [
    {
      "name": "video-720",
      "packaging": "cmaf",
      "role": "video",
      "codec": "avc1.64001f",
      "width": 1280, "height": 720, "bitrate": 3000000,
      "init": "init.mp4",
      "chunks": ["chunk-000.m4s", "chunk-001.m4s", "chunk-002.m4s", "chunk-003.m4s"]
    },
    {
      "name": "audio-en",
      "packaging": "cmaf",
      "role": "audio",
      "codec": "mp4a.40.2",
      "samplerate": 48000, "channelConfig": "2",
      "init": "init.mp4",
      "chunks": ["chunk-000.m4s", "chunk-001.m4s", "chunk-002.m4s", "chunk-003.m4s"]
    }
  ]
}
```

Track `name`s **must match node-relay's fixed registry**: `catalog` (published by
the publisher itself) and the media tracks
`video-1080`/`video-720`/`video-360`/`audio-en`/`audio-es`. The relay rejects
anything else.

## Generating a fixture

`../scripts/prepare-fixture.mjs` is the working generator (H.264 + AAC, three video
renditions, two audio languages, CMAF-chunked via ffmpeg's DASH muxer, manifest.json
written with codec strings derived from ffprobe). Run it offline with a source clip.
It is NOT run by any test or CI, and generated fixtures are gitignored by default.

```bash
pnpm --filter @moqt/example-node-publisher prepare-fixture input.mp4 fixtures/my-video
pnpm --filter @moqt/example-node-publisher validate-fixture fixtures/my-video
```
