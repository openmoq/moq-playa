# Browser Playback Acceptance

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chrome
pnpm test:player:browser
```

FFmpeg, OpenSSL, and Chrome are required. On Linux, install Chrome dependencies
with `pnpm exec playwright install --with-deps chrome`. The Node publisher and
relay use the workspace's native WebTransport backend; an unsupported native
runtime fails the run rather than skipping it. `--skip-build` is available after
building the relevant workspace packages. `PLAYER_TEST_BROWSER=chromium` selects
Playwright Chromium instead of Chrome; record that as a separate browser row.

The command generates six seconds of synthetic H.264/AAC CMAF, starts a local
relay and publisher, then drives `@openmoq/playa` through load/play/destroy in
Playwright. Each scenario has its own relay, OS-assigned port, browser context,
and unique namespace. It uses a run-owned short-lived pinned local certificate and never
contacts a public relay. The observer samples decoded pixels, frame callbacks,
playhead time, all buffered ranges, and audio PCM after gain every 250 ms.
Video fragments target 500 ms; actual audio/video offsets, durations, and
timescales are parsed from their CMAF headers/chunks and retained. The publisher
uses those timestamps, not the manifest's nominal chunk duration, for pacing.
Every object gets its own stream (MSF-00/01 section 6, CMSF-01 section 2).

Three scenarios are mandatory:

| Scenario | Required result |
| --- | --- |
| Moving picture and 440 Hz audio | Healthy output for at least five seconds, including the fixture loop |
| Frozen picture, advancing timestamps and healthy audio | Only `picture-frozen` fails |
| Moving picture, output gain set to zero | Only `audio-missing` fails |

The two controls passing means the harness correctly rejected their output, not
that frozen or silent playback was accepted. Every scenario also requires clean
player teardown, settlement of the original transport's `closed` promise, no
uncaught browser/player errors including during destruction, and graceful
termination of owned processes. Unexpected nonzero exits fail the campaign;
requested SIGTERM, including wrapper exit 143, is accepted.
No decoding/rendering implementation is replaced by a test double.

Artifacts are written to `reports/player-acceptance/<run>/`: JSON observations,
screenshots, browser/relay/publisher logs, fixture files and their hashes, FFmpeg
arguments/version, source commit/dirty status, a source-file hash manifest, and
the tracked working diff. Untracked source is hashed but not copied into the
patch; retain the worktree or commit for reproduction. `result.json` records the
verdict and teardown evidence even on failure. Reports are gitignored.

The motion/green-marker and 440 Hz thresholds are specific to these fixtures.
They are not general-purpose judgments about static content or audio quality.
The 24 fps fixture must sustain at least 80% of its expected presentation rate;
rolling windows reject severe interruptions, and 500 ms of sustained silence
fails even if the whole-window audio percentage would otherwise pass.
Post-gain PCM proves the browser output graph, not physical speaker output.
The test does not establish audio switching, ABR, LOC/LOCMAF, VOD, subtitles,
independent-relay compatibility, or draft-22 wire behavior.

The current example relay may log `SUBGROUP CLOSE ERROR: ... WritableStream is
closed` during viewer teardown. The browser's own errors and transport outcomes
remain strict; the raw relay diagnostic is retained without attributing it to a
playback failure or describing the relay as error-free.

`assessment.test.ts` owns deterministic output-policy tests in the unit gate.
`.github/workflows/player-media.yml` owns the real-media Chrome gate and retains
artifacts for fourteen days. A local macOS result is not a Linux CI result.
