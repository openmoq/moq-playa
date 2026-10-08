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

The command generates six seconds of synthetic H.264/AAC CMAF and H.264/Opus
elementary LOC, starts a local relay and publisher, then drives `@openmoq/playa`
through load/play/destroy in
Playwright. Each scenario has its own relay, OS-assigned port, browser context,
and unique namespace. It uses a run-owned short-lived pinned local certificate and never
contacts a public relay. The observer samples decoded pixels, frame callbacks,
playhead time, all buffered ranges, and audio PCM after gain every 250 ms.
Video fragments target 500 ms; actual audio/video offsets, durations, and
timescales are parsed from their CMAF headers/chunks and retained. The publisher
uses those timestamps, not the manifest's nominal chunk duration, for pacing.
CMAF and LOC use one stream per object (MSF section 6). LOCMAF keeps all
objects of a group on one ordered subgroup stream (LOCMAF section 3).

Twenty-seven scenarios are mandatory:

| Scenario | Required result |
| --- | --- |
| Moving picture and 440 Hz audio | Healthy output for at least five seconds, including the fixture loop |
| Frozen picture, advancing timestamps and healthy audio | Only `picture-frozen` fails |
| Moving picture, output gain set to zero | Only `audio-missing` fails |
| 360p, 720p and 1080p, each with both language signals | Correct decoded dimensions, moving pixels, and 440 Hz (`en`) or 880 Hz (`es`) PCM |
| LOC-01 wall-clock, LOC-04 wall-clock and LOC-04 media time | Moving canvas output, decoded H.264 dimensions, 440 Hz Opus PCM, correct timestamp domain and progress across a loop |
| LOC-04 media time with a frozen picture | Only `picture-frozen` fails |
| LOC-04 media time with muted output | Only `audio-missing` fails |
| LOCMAF-01 MSE and frame mode, each with moving video and AAC | Healthy video/audio across a loop, with full and delta header evidence |
| Each LOCMAF mode with a frozen picture or muted output | Only `picture-frozen` or `audio-missing` fails, respectively |
| Default view and portrait alternatives in CMAF and LOC | Selected view identity, dimensions and healthy output |
| CMAF and LOC view selection through the demo controls | Correct output after selection and clean stop/retry |
| CMAF video with LOC audio, and LOC video with CMAF audio | Moving output, nonzero PCM, quarter-volume attenuation, mute and unmute |

The fault controls passing means the harness correctly rejected their output, not
that frozen or silent playback was accepted. Every scenario also requires clean
player teardown, settlement of the original transport's `closed` promise, no
uncaught browser/player errors including during destruction, and graceful
termination of owned processes. Unexpected nonzero exits fail the campaign;
requested SIGTERM, including wrapper exit 143, is accepted.
No decoding/rendering implementation is replaced by a test double.

The video alternatives encode the same deterministic 1080p source at three
resolutions, with the marker applied before scaling and a shared `altGroup`.
Each language signal is different content and has its own `altGroup`; the labels
say explicitly that these are test tones, not speech. All tracks share a
`renderGroup`. The fixture validator records every sample's decode/presentation
time, duration and sync flag and requires exact rational alignment within each
media type. It checks contiguous positive durations, independently signaled
fragment starts, and compatibility with the publisher's actual loop rebaser.
These are constrained-fixture checks, not an independent codec-level SAP or
complete CMAF conformance validator.

Each of the six alternative cases starts a fresh player with public `startLevel`
and `moqtPlayerConfig.audioConstraints.lang` options. The actual output must pass
its expected dimensions/tone, then fail with exactly `video-identity` or
`audio-identity` when reassessed against the other output identity. These
counterfactual checks prove the detector rejects unchanged/wrong output; they do
not request or establish a live track switch. Catalog labels alone cannot pass.

The LOC publisher extracts no-B-frame H.264 and single-frame 20 ms Opus packets
from the generated fixtures. Video groups follow keyframes; audio groups carry
one packet each. Every object uses its own subgroup stream, with the final
video object and each audio packet carrying the end-of-group header flag.
The relay preserves this header evidence on live and cached delivery, rather
than inventing group completion from an object ID. LOC carries full elementary
packets, so MP4 trimming of the final Opus packet does not shorten the next loop's
offset. The measured Opus loop lasts 6.020 seconds, video 6.000 seconds; this
fixture does not establish A/V synchronization.

LOC observations wrap the real canvas's native `drawImage`, preserving frame
ownership and arguments. They count only the final VideoFrame draw available
per animation-frame callback, not every overwritten draw in a decode burst.
This measures canvas output at refresh opportunities, not physical display or
compositor presentation. An analyser tees the player's existing post-gain
speaker connection without rerouting it or creating a replacement AudioContext.
LOC retains the default decoder, audio scheduler, clock and buffer settings.

Mixed-format cases exercise the actual element and Web Audio output graphs,
including gesture-scoped unmute. They establish output and volume control, not
precise synchronization between the independently scheduled media paths.

LOC-01 timestamps are Unix-epoch microseconds. LOC-04 tests both that domain
and media ticks with explicit non-microsecond timescales and an application
epoch of zero. The assessment checks normalized frame timestamps against the
publisher epoch/local wall clock with a two-second lag bound, and requires
presentation-time progress between 80% and 120% of elapsed time. These checks
catch epoch/unit mistakes, not precise latency or cross-track synchronization.
Canvas observations report `bufferedRanges: null`, not invented MSE residency;
the currentTime observation is Playa's existing playback-duration value, not a
qualified content-position clock.

LOCMAF uses the same H.264/AAC source as CMAF. Its `0.3` version is signaled
with CMSF init references. Each group starts with a full header, followed by
actual deltas on the same stream. Fixture provenance records object, canonical
chunk and coded-sample hashes across two groups, and checks exact sample bytes,
decode/presentation times, durations and flags. This local encoder/decoder
comparison is not an independent conformance oracle. Both public
`locmafDecoding: 'mse'` and `'frame'` paths are tested with real output; frame
timestamps are media microseconds. Protected media, changing initialization,
and a real-browser loss/reset campaign are not covered by these clear fixtures.

Startup is bounded at twenty seconds and requires both presented video and
nonzero post-gain PCM before the observation window starts. The measured
`outputReadyAfterMs` is retained; this steady-state test does not impose a tighter
startup-latency requirement. The silence control mutes only after this readiness
check, so it cannot pass because audio never started.

Artifacts are written to `reports/player-acceptance/<run>/`: JSON observations,
screenshots, browser/relay/publisher logs, fixture files and their hashes, FFmpeg
arguments/version, source commit/dirty status, a source-file hash manifest, and
the tracked working diff. Untracked source is hashed but not copied into the
patch; retain the worktree or commit for reproduction. `result.json` records the
verdict and teardown evidence even on failure. Reports are gitignored.

The motion/green-marker and 440/880 Hz thresholds are specific to these fixtures.
They are not general-purpose judgments about static content or audio quality.
The 24 fps fixture must sustain at least 80% of its expected presentation rate;
rolling windows reject severe interruptions, and 500 ms of sustained silence
fails even if the whole-window audio percentage would otherwise pass.
Post-gain PCM proves the browser output graph, not physical speaker output.
The test does not establish audio switching, ABR, VOD, subtitles,
audio codec/configuration changes, A/V synchronization, independent-relay
compatibility, or draft-22 wire behavior.

The current example relay may log `SUBGROUP CLOSE ERROR: ... WritableStream is
closed` during viewer teardown. The browser's own errors and transport outcomes
remain strict; the raw relay diagnostic is retained without attributing it to a
playback failure or describing the relay as error-free.

`assessment.test.ts` owns deterministic output-policy tests in the unit gate.
`alignment.test.ts` owns sample timing and malformed-fixture discriminators.
`locmaf.test.ts` owns reconstructed sample/timing and full/delta discriminators.
`sinks.test.ts` covers native observer contracts, and the publisher's
`loc-fixture.test.ts` covers elementary grouping, timestamps and loop pacing.
`.github/workflows/player-media.yml` owns the real-media Chrome gate and retains
artifacts for fourteen days. A local macOS result is not a Linux CI result.

For a diagnostic rerun, add `--case loc-4-media` to select one exact scenario.
The retained result records this selection; a selected-case pass is not a pass
for the full twenty-seven-case campaign.
