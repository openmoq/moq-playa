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

The following scenarios are mandatory:

| Scenario | Required result |
| --- | --- |
| Moving picture and 440 Hz audio | Healthy output for at least five seconds, including the fixture loop |
| Frozen picture, advancing timestamps and healthy audio | Only `picture-frozen` fails |
| Moving picture, output gain set to zero | Only `audio-missing` fails |
| CMAF and LOC relay handover | Old picture and audio continue while replacement media acceptance is held; accepted replacement plays without duplicate subscriptions |
| CMAF relay handover with changed video initialization | A replacement muxed at 60000 Hz instead of 12288 Hz keeps the ongoing presentation timeline and continuous audio |
| CMAF relay handover from a nonzero media origin with changed video initialization | Both publishers start at loop 3 (~18 s of media), and the replacement's 60000 Hz initialization keeps one buffered range, a forward playhead inside it and advancing buffered end |
| CMAF relay handover with a refused audio subscription | One recoverable diagnostic; the candidate closes and old picture/audio continue |
| CMAF relay handover after catalog retrieval times out | Subscription-only fallback cannot admit a CMSF-01 catalog; the candidate closes and old playback continues |
| 360p, 720p and 1080p, each with both language signals | Correct decoded dimensions, moving pixels, and 440 Hz (`en`) or 880 Hz (`es`) PCM |
| CMAF manual rendition switches from a nonzero origin | Native 1080p → 720p → 360p → 720p → 1080p frames with continuing 440 Hz audio and one advancing timeline |
| CMAF manual AVC-level retypes | The same sequence crosses levels 4.0 → 3.0 → 4.0 with two actual native retypes and preserved nonzero offsets |
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

The nonzero-origin case exists because every other scenario starts at decode
time zero: the relay replays its cached group 0 to the first subscriber, so a
retained media origin of zero rescales to zero and cannot discriminate a
timescale conversion. `--start-loop 3` begins BOTH publishers at loop
iteration 3, so each presentation starts near 18 seconds in its own timescale
(221184 ticks at 12288 Hz, 1080000 at 60000 Hz) while wall-clock pacing still
starts immediately — `loops` counts iterations to send, not a terminal group
number. Each publisher records the first decode time it emits, read back from
the bytes it is about to send, and the run retains those as `mediaOrigin`.
An origin is refused before the catalog is published when its rebased decode
times would not fit the fixture's tfdt fields, and an endless loop stops rather
than repeating a group number past exact integer range.
Its added assertions are forward media time, a single buffered range that
keeps extending, and a playhead inside what is buffered. The buffered START is
deliberately not asserted: normal back-buffer eviction advances it.

Handover cases run two independent local relays, each fed by a separate looping
publisher. Most use the same fixture on both sides; the reconfiguration case
uses FFmpeg to mux the replacement video at a different timescale, with both
the initialization and media timing changed consistently. Successful candidates retrieve their catalog
with SUBSCRIBE plus Joining FETCH before the target holds required media
acceptances for at least five seconds. The browser must keep displaying
moving pictures and producing PCM from the source throughout that interval;
the source must not see an unsubscribe. After release, successful adoption must
close the original transport, retain the replacement and continue output for
another seven seconds. A required audio rejection must instead close the
replacement, preserve the original and continue output. A separate negative
case holds catalog retrieval through its five-second timeout: the subsequent
subscription-only fallback must reject CMSF-01 rather than weaken its bootstrap
requirement. Per-relay request and
object counts, original transport close times and both output windows are
retained. These checks cover draft-18 handover and output continuity, not exact
sample alignment between the two publisher processes or arbitrary codec changes.

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

`cmaf-manual-rendition-switch` keeps one real Player and audio selection while
calling public `setQuality(1/2/1/0)`. Its three videos share codec/`altGroup`, but
their actual headers/fragments use IDs 1/3/4 and timescales 12288/60000/90000.
The publisher starts at loop 3. Parsed-field ID rewrites include tkhd, trex,
tfhd, sidx and mvhd's next ID; sample timing and coded bytes are read back.
Continuous native frame callbacks, decoded dimensions, playhead, PCM and audio
clock observations span every switch; each target then sustains a five-second
output window. Errors, stalls, split buffers and accumulated timeline drift fail.
This same-MIME arm requires zero actual native `SourceBuffer.changeType` calls.
`cmaf-manual-avc-level-switch` uses the same fixture pipeline, with 360p encoded
at baseline level 3.0 (`avc1.42c01e`) and 720p/1080p at baseline level 4.0
(`avc1.42c028`). Encoder level and expected codec are declared together; parsed
avcC read-back must match. This arm requires exactly two successful native calls,
to level 3.0 then level 4.0, on the original video buffer.
The observer never writes offsets. Both arms capture actual audio/video offsets
after startup (zero for this fixture) and require them unchanged during native
calls, playback and final read-back. Nonzero offset preservation remains covered
by units. Native error/waiting/stalled events are
recorded only between begin/finish, with one recording spanning all transitions.
This checks manual switching for this fixture, not the ABR selection algorithm.
Console evidence includes message locations; up to 32 HTTP errors retain URL and
status plus a total/truncated count. All HTTP errors, including 404, remain failures.
Add `--debug` only for diagnosis to enable existing engine/MSE logging; default is off.
After building the required packages, select either arm with:

```bash
PLAYER_TEST_BROWSER=chrome node scripts/player-acceptance/run.mjs --skip-build --case cmaf-manual-rendition-switch
PLAYER_TEST_BROWSER=chrome node scripts/player-acceptance/run.mjs --skip-build --case cmaf-manual-avc-level-switch
```

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
for the full campaign.


`pnpm test:player:audio-order` checks native audio samples when a later group's
head arrives before the preceding group's tail. It generates AAC-LC at 8 kHz,
with exact 1024-sample packet timing, and prepares four fresh browser contexts:
in-order twice, the real adapter receiving head then tail, and an omitted-tail
negative control. Actual native append bytes identify the packet order; append
observations must terminate exactly once. AudioWorklet captures every quantum,
including silence, through at least 4096 context-clock samples after media ends.
Capture starts only after the resumed context delivers eight contiguous quanta,
before `play()`: Chrome may advance `currentFrame` while its output device starts
(seen on headless CI output). Those pre-play gaps are retained as `preroll`
diagnostics; any gap after capture starts fails the case.
The candidate's active PCM span must match the healthy repeat within 16 samples,
while omission must lose one 1024-sample packet within that tolerance. Buffered
ranges are retained only as diagnostics because they can conceal missing audio.
This constrained fixture establishes output duration and native append ordering,
not arbitrary-codec fidelity, exact packet identity from decoded PCM or A/V sync.

`--zero-window-control` also tests the adapter with reordering disabled: its
committed-group guard discards the old tail and must show the expected deficit.
`--native-diagnostic` records raw MSE receiving reordered packets without assuming
that every browser must reproduce a particular loss. The media workflow runs the
mandatory gate and zero-window control. FFmpeg and Chrome are required; browser
selection uses the same `PLAYER_TEST_BROWSER` convention as the playback runner.
Reports and raw PCM are retained under `reports/player-acceptance/`.


Each player snapshot brackets the public `videoPlaybackQuality` read with two
native `getVideoPlaybackQuality()` reads. MSE video must report valid counters
within that native interval; canvas output must report null. Displayed frames
are the derived `totalVideoFrames - droppedVideoFrames`, not decoder output or
physical display evidence. This check does not change legacy frame counters.

Warm-start cases (`warm-start-cmaf`, `warm-start-loc`,
`warm-start-locmaf-mse`, `warm-start-locmaf-frame`) use an owned local
relay that holds the video Joining FETCH until the browser observes a live
video receipt and the driver acknowledges that exact witness. Send completion
alone is not treated as receipt evidence across independent QUIC streams.
The browser witnesses raw receipt order separately from the application's
contiguous processing of the saved prefix and subsequent live tail. Each
case also passes the normal moving-picture and audible-output assessment.
For LOCMAF, the full/delta format witness covers two complete live groups;
FETCH media is excluded because its stream carries a request id, not a track
alias. After initial output is ready, these cases wait at most 20 seconds for
that live-group evidence, report the wait separately, then run the normal
7.25-second playback window. Prefix ordering is witnessed independently.
`warm-start-disabled` verifies that the default path issues no media FETCH.
These runs demonstrate initial ordering and playback; they do not measure
physical A/V synchronization or certify a remote relay.

## Shaped-link ABR runs

`PLAYER_NET_SHAPE=<preset>` (or `--net-shape <preset>`) puts the userspace UDP
shaper in `scripts/net-shaper/` between the browser and each case's relay. It
is off by default; unset, every case runs exactly as above. Publishers still
dial the relay directly; only the browser's URL port changes, so the pinned
certificate hash is unchanged. The shaper queues, serializes and tail-drops real
QUIC packets, so the relay's congestion controller sees the bottleneck.

| Preset | Downlink (relay to browser) | Uplink |
| --- | --- | --- |
| `cap-1m` | 1 Mbps, 20 ms | 20 ms |
| `step-5m-1m` | 5 Mbps, 1 Mbps from 20 s after the first packet, 20 ms | 20 ms |
| `jitter` | 10 Mbps, 20 ms ± 30 ms, never reordered | 20 ms |
| `ample` | 30 Mbps, 20 ms | 20 ms |

Queues default to the larger of 100 ms at the initial rate and one BDP.
Without `--case`, a shaped run selects `abr-net-shape`: the three-rung
1080p/720p/360p CMAF ladder with ABR enabled for `PLAYER_NET_SHAPE_SECONDS`
(default 45). `--case abr-net-shape-loc` runs the same ladder as LOC-04 with
wall-clock capture timestamps, so delivery lag is observable. Either is a
calibration trace, not a quality gate: startup and clean teardown are required,
output defects are recorded. Other cases may be selected with a preset and keep
all their usual assertions; handover cases are refused. Each shaped case writes
`<case>-abr-trace.json` with the engine's `quality_switched` (from, to, reason),
`stall` and `stall_recovered` events, 1 Hz player stats, the shaper's per-direction
stats, and a summary on the shaper's time base. `PLAYER_NET_SHAPE_SEED` fixes
jitter and loss draws.

```bash
PLAYER_NET_SHAPE=step-5m-1m node scripts/player-acceptance/run.mjs --skip-build
node scripts/net-shaper/cli.mjs --upstream 127.0.0.1:4443 --down-rate 1500000 --down-delay 20 --stats-out stats.json
```
