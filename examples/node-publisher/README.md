# @moqt/example-node-publisher (example)

A **Node media-origin publisher demo** for MoQT draft-18: FFmpeg packages a normal
MP4 into a prepared per-track CMAF fixture (offline), and this publisher loads it
and publishes an MSF catalog (init segments inline as base64 `initData`) plus the
media tracks into the [`examples/node-relay`](../node-relay/README.md) relay — where
a Node smoke or the browser Playa player can watch.

**Example-only, not a production packager/encoder.** No fixture, cert, or media
bytes are committed — generated fixtures are gitignored (`fixtures/*/`).

## 1. Generate a prepared CMAF fixture

Requires `ffmpeg` + `ffprobe` on PATH. Output: 3 H.264 video renditions + up to 2
AAC audio tracks, CMAF-chunked (`init.mp4` + `chunk-NNN.m4s` per track, each chunk a
complete `moof`+`mdat` = one MoQT object). Non-16:9 sources are letterboxed, never
stretched. Re-running **overwrites** the output directory. See
[`fixtures/README.md`](fixtures/README.md) for the layout/manifest contract.

```bash
# <input.mp4> <outdir> [durationSec=2] [chunkMs=500]
pnpm --filter @moqt/example-node-publisher prepare-fixture input.mp4 fixtures/my-video 10 500

# layout + box-level checks (init=ftyp+moov, chunks contain moof+mdat):
pnpm --filter @moqt/example-node-publisher validate-fixture fixtures/my-video
```

## 2. Publish one-shot

```bash
PORT=4433 pnpm --filter @moqt/example-node-relay relay-server                        # terminal 1
PACE_MS=500 pnpm --filter @moqt/example-node-publisher publish-fixture https://127.0.0.1:4433/moq fixtures/my-video
```

`PACE_MS` paces chunk sends like a live origin (default = the manifest's
`chunkDurationMs`; `PACE_MS=0` sends as fast as possible). The whole fixture is sent
as group 0; the relay caches it for late joiners. One-time prerequisite: generate
the relay's cert (`pnpm --filter @moqt/example-node-relay gen-cert`) — the publisher
pins its hash to connect (`RELAY_CERT` env to override the cert path).

## 3. Publish in loop mode (endless live demo)

`--loop` publishes the catalog once, establishes each media track once, then keeps
re-sending the chunks as **new groups** (groupId 0, 1, 2, …; object IDs 0..N-1 within
each group), so a tiny fixture plays indefinitely with a sane timeline.
`--loop-count N` sends exactly N groups (finite smoke/debug).

```bash
pnpm --filter @moqt/example-node-publisher prepare-fixture /Users/Shared/Examples/Videos/test-1080p-h264-24fps-300s-1M.mp4 fixtures/test-pattern 4 500
pnpm --filter @moqt/example-node-publisher validate-fixture fixtures/test-pattern
PORT=4433 pnpm --filter @moqt/example-node-relay relay-server                        # terminal 1
pnpm --filter @moqt/example-node-publisher publish-fixture --loop https://127.0.0.1:4433/moq fixtures/test-pattern
```

(`fixtures/test-pattern` is generated locally and gitignored — do not commit it.)

## 4. Browser Playa playback

```bash
pnpm install && pnpm build                                  # one-time
pnpm --filter @moqt/example-node-relay gen-cert             # copy the printed SHA-256 HEX
# prepare + relay-server + publish-fixture as above (loop mode is ideal here)
pnpm --filter @moqt/examples dev                            # browser examples app
```

Open Chrome to:

```text
http://localhost:5173/player/?url=https://127.0.0.1:4433/moq&hash=<SHA256_HEX_FROM_GEN_CERT>&ns=demo&v=18
```

- **`v=18`, not `draft=18`** — the player reads `?v=` for the explicit MoQT draft.
  Explicit 18 is required because the Node backend doesn't echo `moqt-18`.
- **`ns=demo`** — matches the fixture namespace and the relay's registry
  (`catalog`, `video-1080/720/360`, `audio-en/es`).
- If Vite picks a port other than 5173, use that port.
- Click the center play button; audio needs the gesture (autoplay policy).

What to expect: the relay logs `subscriber joined catalog` plus one video + one
audio SUBSCRIBE; the `<video>` element renders; a quality switch (the player's ABR
can trigger one on its own) makes the relay log `subscription requestId=…
unsubscribed` while the connection stays live. The manual quality **dropdown** stays
hidden with this catalog — it does not yet emit `altGroup`, a known follow-up.

Troubleshooting:

- **Handshake fails immediately:** `hash=` is missing/stale — re-run `gen-cert` and
  reload with the new hex.
- **Connects but no catalog:** check `ns=demo` and that you published the real
  fixture (not synthetic bytes).
- **Catalog parses but MSE rejects media:** re-run `validate-fixture`; if valid,
  inspect Chrome's media error and keep the fixture for a focused debug pass.

## 5. Protocol smoke (synthetic bytes)

`pnpm --filter @moqt/example-node-publisher smoke` spawns a relay child process,
publishes a catalog + 5 **synthetic** tracks (fake bytes, same shapes/IDs as a real
fixture — not decodable by MSE), then verifies the parsed catalog and every chunk's
payload + group/object IDs through the relay. Useful as a fast end-to-end protocol
check with no FFmpeg involved. `probe` prints which `@moqt/*` capabilities the
publisher uses; `typecheck` runs `tsc --noEmit`.

## Limitations / development notes

- Out of scope: arbitrary/progressive MP4 demux or transmuxing, encryption/DRM,
  DVR/seek, full ABR validation, CI integration.
- Audio mapping: `audio-en`/`audio-es` take the source's first two audio streams;
  with one stream both encode it; with none, audio is skipped (reported).
- The script is named `prepare-fixture` (not `prepare` — that's an npm lifecycle
  hook that would auto-run on install).
- The small Node WebTransport adapter/cert helpers are deliberately duplicated from
  node-relay rather than coupling two private examples; the only cross-example
  touchpoint is reading the relay's generated cert to pin its hash.
