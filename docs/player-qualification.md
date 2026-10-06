# Player Qualification

This document tracks the baseline and acceptance evidence for completing Playa's
audio selection, VOD, timed metadata, and text playback. The overall sequence is
in `MOQ_PLAYA_PLAN.md` beside the repository. Update this record with the source
commit and test evidence when a capability changes.

## Baseline

Verified on 2026-10-06:

| Item | Value |
| --- | --- |
| Player work branch | `feat/player-completion` |
| Starting source commit | `4ceaa54a5787b69c6a771684af0a11de5fe11a51` |
| Starting source | Reviewed `integrate/draft22` work |
| Local main | `872f415a928096de0ff8130d326325c500b9ccc8` |
| Remote main | Same SHA, checked with `git ls-remote origin refs/heads/main` |
| Package version | `0.5.9` |
| Public packages | `@openmoq/*`, including `@openmoq/playa` |
| Test runtime | Node `v24.2.0`, pnpm `10.32.1`, macOS |
| Fresh focused baseline | 703 tests passed in 29 files; 24.34 seconds |
| Browser/media runs in this baseline | Not run |
| New player behavior in this milestone | None |

The worktree is `reports/player-completion/`. Other worktrees and the root's
uncommitted relay experiments remain separate. Main integration and remote
actions have not occurred. Starting from draft-22 allows the feature work to
exercise the intended upcoming baseline without moving main as part of setup.

The fresh tests use workspace source aliases. Dependencies were installed with
`pnpm install --frozen-lockfile --offline --ignore-scripts`; the lockfile did not
change. This setup covers the selected unit/simulation tests, not native QUIC or
the Node relay backend. Those need their own runtime and installation checks.

### Reproduce the focused baseline

Run from this worktree:

```bash
pnpm exec vitest run \
  packages/player/src/player.test.ts \
  packages/player/src/player-locmaf-frame.test.ts \
  packages/player/src/quality-controller.test.ts \
  packages/player/src/timeline-manager.test.ts \
  packages/player/src/packaging.test.ts \
  packages/player/src/support.test.ts \
  packages/playa/src/player.audio.test.ts \
  packages/playa/src/quality.test.ts \
  packages/playback/src/buffer-based-abr.sim.test.ts \
  packages/playback/src/bandwidth-adaptation.sim.test.ts \
  packages/playback/src/sync.test.ts \
  packages/locmaf/src
```

The setup run's full output is `/private/tmp/playa-completion-baseline-tests.log`.
That is a local, temporary artifact. The reproducible command and source SHA
above are the durable record. The earlier RFQ audit's 656 tests were run on main;
they are distinct from this branch's fresh 703-test baseline.

## Capability Evidence

`Implemented` describes a code path. `Partial` describes existing machinery that
does not yet complete the public workflow. `Missing` describes absent behavior.
This table records the M0 starting point. The M1a browser evidence below updates
only B1; other browser and independent-media rows remain unqualified here.

| Capability | Implementation | Evidence inspected or rerun | Remaining acceptance evidence |
| --- | --- | --- | --- |
| LOC-01/04 video/audio | Implemented | LOC header/profile handling and player/sync source | Real identified frames/audio through both relevant timestamp profiles |
| MSF-00/01 catalogs | Implemented | Player catalog tests in the focused baseline | Real bootstrap/init/delta playback in the maintained harness |
| CMSF/CMAF through MSE | Implemented | Packaging and player tests | Real decode/presentation, initialization, loop and eviction behavior |
| LOCMAF-01 through MSE | Implemented | LOCMAF codecs and player path tests | Browser reconstruction/append/render qualification |
| LOCMAF-01 frame mode | Implemented | `player-locmaf-frame.test.ts`, with mocked decoders | Real WebCodecs output and group-boundary recovery |
| Video quality selection/ABR | Implemented | Quality controllers and buffer/bandwidth simulations | Measured rendered transitions and adverse-network behavior |
| Audio activation/mute/volume | Implemented | 13 audio lifecycle tests | Actual browser output and autoplay checks |
| Audio-track switching | Missing | `Player.setAudioTrack()` only assigns the index; engine call is TODO | Audio A changes to distinguishable B; rollback and teardown |
| VOD timeline parsing/seek requests | Partial | Timeline manager and player tests | Real forward/backward seek, paused seek, completion and replay |
| Inline-template seeking | Partial | Catalog type support; engine path needs completion audit | Per-track template resolution through rendered seek destinations |
| Presentation-time API | Partial | Video uses element time; canvas uses playback-duration stats | Content-time mapping across pause/seek/discontinuity |
| Generic events | Partial | Raw events emitted when parsed | Separate scheduled events against presented media |
| Subtitle/caption rendering | Missing | Roles declared in MSF types; no text playback pipeline found | Agreed wire profile, selection, visible cues and lifecycle |
| Draft-22 transport | Implemented on this branch | Separate integration review/tests; not rerun by this baseline command | Independent peer qualification, especially disputed FETCH end framing |
| Optional CAT4MOQ | Implemented | Existing authorization source/tests; not rerun here | Auth-off baseline and credentials on newly selected auxiliary/media tracks |
| OBS publisher compatibility | Unqualified here | No version-pinned OBS media run in this audit | Actual OBS output through supported relay/browser rows |

These profiles are independent: a transport draft does not identify a catalog,
packaging, codec, browser, or authorization profile. Supported transport drafts
on the starting branch are 14, 16, 18, and 22; the default remains 16.

## Specification Pins

The files are in `../Spec/` relative to the repository, beside the overall plan.
SHA-256 values pin the copies read for this baseline, rather than assuming an
Internet-Draft filename alone establishes identical contents.

| File | SHA-256 |
| --- | --- |
| `draft-ietf-moq-transport-14.txt` | `1e6f59bd6d15c8d372932cfbb00dd1c8db7da10771eb57291b9732ea557582b8` |
| `draft-ietf-moq-transport-16.txt` | `2174e50090f20801df4d21e16b9ec21abe593e6ba2a84e43142aabdeb47b2c18` |
| `draft-ietf-moq-transport-18.txt` | `9e6b32cb7797c151e9e127374c1291af3ed546b2d453cd5bbb15946977eeeeb6` |
| `draft-ietf-moq-transport-22.txt` | `1a725f10db526d94f915b30db9004821d86e57afcdde10789c54fee64b3056b5` |
| `draft-ietf-moq-msf-00.txt` | `55bcc55a4b93a2e8bd707bb9b02a9cc7370a99cd20b493819bf62a50ad0aaf3f` |
| `draft-ietf-moq-msf-01.txt` | `c3e68aac09c36ae1db4afde6fd0600a949e7265348f592520304a31e993c35af` |
| `draft-ietf-moq-cmsf-00.txt` | `8dee5af3d6c028a3be8e808ac2afcf50f4aeaf6074a39f6804b2385814a68a86` |
| `draft-ietf-moq-cmsf-01.txt` | `c0ba68d09d6d42540ca0ac7f5df30b66aae7ede11fdc14e8338de977da9cc04d` |
| `draft-ietf-moq-loc-01.txt` | `2d2be396d29c442a924b10d21766bbea33349fff39ca49d8f528c33b77a2499f` |
| `draft-ietf-moq-loc-04.txt` | `fb29e2805be0511a188683b60fc830fb7fd3ecf19931968755d60d83707c3b47` |
| `draft-ietf-moq-c4m-01.txt` | `13c7694d05997776a012f96e0271df720b3560e2a1ce032e85b883007f5f4121` |
| `draft-einarsson-moq-locmaf-01.txt` | `f2e46e20fb308961fdc17f85a257ce54d9a36d3784f0024cf3727db980c394d9` |

The LOCMAF text was retrieved from the [IETF archive](https://www.ietf.org/archive/id/draft-einarsson-moq-locmaf-01.txt)
for this qualification. Its version field is `0.3`. Section 3 specifically requires
all objects in a group to share one subgroup stream, overriding the generic MSF
one-stream-per-object mapping for this packaging. Section 6 uses CMSF
`initDataList`/`initRef` carriage.
Browser timing/rendering standards and WebVTT/IMSC carriage references must be
pinned before their implementation slices. They have not been reviewed here.

## Requirements Ledger

Tests named below are existing anchors or proposed acceptance scenarios. A
proposed scenario is not a test result. Add exact test names and artifact paths
when implementing each requirement.

| ID | Source and level | Decision / owner | Existing anchor | Required discriminator / status |
| --- | --- | --- | --- | --- |
| CAT-01 | MSF-01 5.2.11, SHOULD | Honor intended render groups during selection; player | `quality-controller.ts` | Two unrelated render groups do not mix output; pending |
| CAT-02 | MSF-01 5.2.12, MUST | Alternate tracks have matching media-time sequences; catalog/fixture validation | `quality-controller.test.ts` | Reject or exclude an invalid switching fixture; pending browser qualification |
| CMAF-01 | CMSF-01 3.1, MUST | Modern catalog carries inline initDataList entries referenced by initRef; fixture publisher | `buildFixtureCatalog()` | Actual init resolution before decode; pending browser run |
| CMAF-02 | CMSF-01 3.2, MUST | Shared altGroup and aligned group/sample starts within a switching set; fixture/publisher | Fixture generator and catalog builder | Measure alignment, then switch identifiable renditions; missing fixture metadata |
| CMAF-03 | CMSF-01 3.3/3.4, MUST | Single-track chunk payloads and groups starting at SAP 1/2; publisher/parser | `validateFixtureBoxes()` checks top-level boxes only | Check samples/SAPs and browser decoding; deeper fixture qualification pending |
| VOD-01 | MSF-01 7/7.1.1, optional facility with MUST field semantics | Map media PTS in integral milliseconds to the correct track location; MSF/player | `timeline-manager.test.ts` | Real seek with unequal A/V group layouts; pending |
| VOD-02 | MSF-01 7.2/7.3, MUST | Dependency-qualified histories, independent first object and incremental successors; MSF/player | Timeline state/parser tests | Snapshot/update and multiple-timeline cases; completion audit pending |
| VOD-03 | MSF-01 5.2.15/7.4, MAY and MUST constraints | Allow independent track templates; fixed-duration only; six ordered fields and immutable values; MSF/player | Catalog template types | Independent A/V templates, invalid variable-duration use; pending |
| EVT-01 | MSF-01 8.1, MUST | Exactly one time/location reference plus data per event; MSF | Event parsing and raw player events | Each reference form maps correctly; scheduling pending |
| EVT-02 | MSF-01 8.2/8.3, MUST | Track declares dependencies/type/MIME; snapshot and incremental history; MSF/player | Auxiliary track subscription paths | Duplicate histories and wrong render group; pending |
| TXT-01 | MSF-01 3/5.2.6/10.5, capability and signaling | First text milestone targets WebVTT; exact referenced carriage still to pin; player/browser | MSF role types | Visible cue entry/exit and off/language controls; missing |
| CLK-01 | Player API policy; browser standard review pending | Report presented content time with explicit clock mapping; player/browser | Playa time controller, sync tests | Pause/seek/nonzero PTS on canvas and MSE; pending |
| AUD-01 | Player API policy; MSF selection relationships apply | Audio selection becomes authoritative only after a real transition; player/Playa | Stub `setAudioTrack()`, audio activation tests | A-to-B output identity and failed-switch rollback; missing |
| LIFE-01 | Existing lifecycle contracts plus applicable draft rules | Cancel stale operations and preserve transport ownership; all changed owners | Existing lifecycle and teardown suites | Repeated load/switch/seek/destroy with no late output; pending browser gate |

The normative requirements above apply when implementing or emitting the named
profile. They do not turn optional MSF timelines or text tracks into mandatory
tracks for every broadcast. Presentation latency targets, seek completion, and
audio switching API semantics require explicit implementation contracts.

### Open interpretation points

- MSF-01 7.2 says a timeline carries a `type` identifier, while 5.2.4 and the
  catalog examples use `packaging`. Preserve the existing supported shape until
  the timeline slice records a reasoned decision; do not add a guessed wire key.
- Draft-22 FETCH End-of-Range framing remains an explicit interoperability choice
  documented in [Transport Draft Development](draft-development.md). Keep the
  older-draft framing regressions. Independent peers are still needed.
- MSF-01 15.2 references `suhasHere/webvtt-msf` and `suhasHere/imsc1-msf` for text
  carriage. Do not invent carriage from the catalog's subtitle role alone.
- WebVTT is the first text target. IMSC and embedded CEA profiles are later scope
  decisions; WebVTT completion will not be described as universal caption support.

## Existing Harness and Fixture Inventory

| Existing asset | Reuse | Gap before acceptance |
| --- | --- | --- |
| `examples/node-publisher/scripts/prepare-fixture.mjs` | FFmpeg packaging and per-track chunk generation | One source audio stream produces two identical tracks; no identifiable audio-switch control or fixture provenance manifest |
| `examples/node-publisher/src/fixture.ts` | File/layout checks and loading | FixtureTrack does not currently carry altGroup; top-level box checks do not establish alignment, duration, SAPs or sample correctness |
| `examples/node-publisher/src/publisher.ts` | MSF-00/CMSF-01 catalogs, CMAF and LOCMAF publishing, looping | No finite-VOD timeline fixture; catalog delta clone has no media and cannot prove a quality switch |
| `examples/node-relay/src/relay-media-smoke.ts` | Transport routing, subscriptions and cleanup | Synthetic payloads; no decode or rendered media proof |
| Player loopbacks and simulations | Deterministic protocol/decoder/clock fault injection | Mocked decoders/output do not establish browser codec behavior |
| Existing stall-lab scripts in a separate local worktree | Frame/time observations, traces, fixture comparisons | Scratch code, local paths, limited controls and overly strong attribution assumptions |
| `tools/moq-interop-client` | Setup/request/cancellation/close interop | Six control cases do not exercise playback |
| `ci.yml`, `nightly.yml` | Existing unit/build/type/export/soak/fuzz gates | No maintained Playwright media gate in these workflows |

Useful local scratch sources are in `moq-playa-stall-lab/_stall-lab/`:
`stall-meter.mjs`, `trace-run.mjs`, and `verdict.mjs`. Inspect and adapt useful
measurements when building the harness. Do not copy their conclusions: advancing
currentTime does not prove an advancing picture, the last buffered endpoint does
not prove contiguous headroom, and buffered data alone does not identify who
caused a freeze. Retain raw evidence and test the measurement with controls.

The old fixture README says media is uncommitted and lists a fixed relay
registry; the draft-22 branch contains `fixtures/testsrc.mp4` and the relay has
evolved. Read current source before adopting those documentation claims.

## Required Media Rows

Rows start as NOT RUN; B1 now has the M1a evidence below. Use a local controlled transport/relay and synthetic
redistributable source content. Pin browser, fixture, publisher, relay, source SHA,
catalog version, transport draft and decoder mode in each result.

| Row | Format and output | Required observation | Promotion |
| --- | --- | --- | --- |
| B1 | CMSF-01, CMAF, H.264/AAC, MSE | Identifiable advancing video, audio A, actual init/catalog delivery and bounded teardown | First M1 slice |
| B2 | Same source with two distinct audio tracks and valid video alternatives | Detect A versus B and each rendition; intentionally unchanged output fails | Before audio/ABR acceptance |
| B3 | LOC-01 and LOC-04, H.264/Opus, WebCodecs | Real decoded/presented frames/audio with correct time-domain handling | Before shared-clock changes are accepted |
| B4 | LOCMAF-01, same CMAF source, MSE | Reconstructed chunk output matches expected content | Before VOD/ABR changes affect this path |
| B5 | LOCMAF-01, frame mode | Real sample decode/render and group transitions | Before shared-clock changes are accepted |
| B6 | Finite source with explicit per-track timelines | Start, completion, forward/backward/paused seek and replay | M4 acceptance |
| B7 | Finite fixed-duration source with per-track templates | Same seek workflow and correct bounds | M4 acceptance |
| B8 | Event references by media PTS, wallclock and location | Scheduled visible events with measured timing | M5 acceptance |
| B9 | Agreed WebVTT carriage | Known cues visibly enter/leave, language switch/off and seek behavior | M6a acceptance |

B1 starts with draft-18 because the maintained local relay/publisher path already
uses it. The libraries retain their current default. Add a draft-22 peer row when
a suitable peer is available; a same-codec loopback does not settle its framing
ambiguity. Codec availability failures must be reported as blocked/unsupported
with evidence, rather than making the row disappear.

## M1a: CMAF Browser Baseline

Implemented on 2026-10-06 and committed locally as `41f1ec3`
(`Add browser playback acceptance checks`) on `feat/player-completion`:

- Command: `pnpm test:player:browser`; prerequisites and interpretation are in
  [Browser Playback Acceptance](../scripts/player-acceptance/README.md).
- Real local draft-18 QUIC relay/publisher, CMSF-01 catalog, H.264/AAC CMAF,
  public `@openmoq/playa` load/play/destroy, Chrome MSE output. No core player
  behavior changed.
- FFmpeg synthetic test pattern with a green marker and 440 Hz audio; fixture
  arguments, version, source rights, and binary hashes are retained per run.
- Three mandatory browser scenarios passed: advancing identified pixels and
  audio; frozen picture detected despite advancing timestamps/frame callbacks;
  silenced output detected despite continuing video. The controls must fail
  exactly their intended output check while lifecycle checks still pass.
- Fourteen deterministic assessment tests pass. The initial unconditional-pass
  implementation failed twelve assertions before the assessment was written.
  Disabling picture detection fails two tests; disabling the audio-presence
  check fails its missing-audio test. Both mutations were restored to green.
  The review fixes extend assessment coverage to seventeen tests, adding minimum
  presentation rate, rolling interruption checks, and sustained audio-hole rejection.
- The cold review identified five defects; all have RED-before-fix regressions:
  shared cert paths, missed destruction errors, ignored process exit failures,
  multi-object stream mapping, and nominal instead of timestamp-based pacing.
  Certificate generation supports run-owned output; terminal events are checked
  after destruction; process exits are verified, including requested SIGTERM/143.
  Both MSF-00/01 section 6 require one stream per object; the publisher now honors
  that mapping for both catalog modes. Payload and group/object identities remain
  unchanged. Timestamp pacing is opt-in for other example users and mandatory here.
- New fixture video fragments contain 500 ms of media; actual per-track offsets,
  timescales and durations drive pacing and are retained as evidence. No common
  500 ms assumption is applied to AAC's unequal fragment lengths.
- Re-review found two related defects. Every chunk is now checked with the
  actual loop rebaser before publication, including intermediate fragments that
  depend on unsupported `trex`-only durations. Decoded objects expose additive
  `isFirstObjectInSubgroup` evidence; the relay preserves it through live
  forwarding and cache replay instead of inferring it from object ID zero.
  Tests cover nonzero first IDs, false evidence, later objects, and a real
  end-of-group gap with a derived subgroup ID. Removing gap propagation fails
  its discriminator. Payloads and delivery order are unchanged.
- Fresh full suite: 6667 passed, one existing prepared-fixture test skipped,
  245 files. Workspace build, test typecheck, examples build, built-export smoke,
  and new workflow actionlint passed.
- Final independent re-review found no blocking findings against this M0/M1a
  source and verified the final browser artifact and relevant source hashes.
- Every browser case ended with the original transport `closed` promise
  fulfilled, observer AudioContext closed, MediaSource URL detached, and no
  uncaught browser/player error. Processes use separate OS-assigned ports and
  are terminated under bounds.
- The example relay still logs a closed-writer diagnostic during some viewer
  teardowns. Raw logs preserve it; this slice does not fix or erase that issue.
- CI owner: `.github/workflows/player-media.yml` runs the command with Chrome
  on Ubuntu and uploads evidence. That remote job has **not run**; local evidence
  is macOS arm64, Node v24.2.0, Chrome 155.0.8059.40.

Evidence is under this worktree's `reports/player-acceptance/`. Each run records
the starting commit `4ceaa54`, dirty status, and exact source-file hashes so an
uncommitted run is not mistaken for evidence against the clean commit alone.
Browser results establish digital post-gain PCM, not physical speaker output.
The original local run `2026-10-06T19-08-57-250Z-997422cc/result.json` is superseded
by the review fixes. Corrected concurrent runs
`2026-10-06T20-17-22-324Z-9a02eef4/result.json` and
`2026-10-06T20-17-28-046Z-64e73ba5/result.json` both passed all three scenarios.
Their source manifests identify the exact reviewed versions; later code revisions
require their own retained run. The default certificate/key hashes were unchanged.
The maintained command, including its build step, passed all three scenarios
again after the follow-up runtime fixes in
`2026-10-06T20-34-52-309Z-a8d12e97/result.json`. The final source and corrected
test-fixture capture, `2026-10-06T20-40-25-006Z-378476c0/result.json`, also passed
all three scenarios. These runs record the certificate SHA-256 used by both
media processes and the browser. All 765 runtime/configuration file hashes in
the final manifest matched the tested source after the run.

M1 remains incomplete. Real LOC and LOCMAF output remains required before
shared-clock changes; VOD, event and text rows follow their specification slices.

## Identifiable Media Alternatives

The next uncommitted slice adds three H.264 video renditions (640x360, 1280x720,
1920x1080) and two AAC test signals (440 Hz `en`, 880 Hz `es`) to the maintained
browser command. The videos encode the same synthetic 1080p source, with the
green marker applied before scaling, a common `altGroup`, matching sample times,
and a shared `renderGroup`. The audio content is distinct and uses separate
groups, with explicit language/test-signal labels.

Sample validation uses the existing CMAF parser and frame slicer, records every
sample's decode and presentation ticks, duration and sync flag, and compares
time with exact cross-multiplication across timescales. Missing fragments,
one-tick offsets, composition-time differences, non-sync starts, internal holes,
and unsupported chunks fail. The signaled independence checks and actual browser
decode are not independent codec-level SAP or complete CMAF conformance proof.

All six initial video/audio combinations use public Playa options against the
same five-track catalog. Decoded dimensions, pixel motion/marker RGB, and
post-gain PCM tone establish output identity. Each capture is also assessed
against a different rendition and tone and must fail exactly the respective
identity check. This establishes wrong/unchanged-output detection, not live
audio or ABR switching. Startup has a twenty-second observable audiovisual
readiness bound; the measurement window then checks steady-state output.

Two narrow public-library changes support the fixtures: the catalog builder
now preserves optional `altGroup`, `lang`, and `label`; Playa maps catalog `lang`
to public `AudioTrack.language` instead of reading an absent `language` key.
The latter failed both legacy and modern catalog regression tests before the
one-line correction. No playback, scheduling, or track-switch implementation
changed.

Final local browser evidence is
`reports/player-acceptance/2026-10-06T21-28-52-361Z-9fb2a4d8/result.json`:
nine cases passed on macOS arm64, Node v24.2.0, Chrome 155.0.8059.40, including
all twelve counterfactual identity checks. Every transport `closed` promise
fulfilled, observer AudioContext closed, player returned to idle, and no browser
or player error occurred. All 423 runtime/configuration hashes checked against
that capture matched the source at that checkpoint. The LOC extension below has
its own capture; the nine-case artifact is not evidence for later runtime changes.

The full suite passed 6686 tests in 247 files, with one existing prepared-fixture
skip. Workspace build, example build, test/publisher/MSF typechecks, and
built-export smoke passed. Focused coverage is 53 tests: 21 output-policy,
10 alignment, 10 builder, 10 publisher, and two language-mapper tests.
Deleting dimension comparisons fails the unchanged-video discriminator;
hardcoding 440 Hz fails both the second-signal positive and unchanged-audio
negative; disabling exact time comparisons fails offset, composition-time and
per-sample-duration tests. All mutations were restored to green.
Final independent read-only review found no blockers in the restored source,
tests, documentation or nine-case browser artifact.

At that checkpoint, audio codec/configuration-change fixtures, real switching,
A/V sync, LOC and LOCMAF qualification remained outstanding.

## LOC Browser Output

The next uncommitted extension adds LOC-01 wall-clock, LOC-04 wall-clock and
LOC-04 media-time H.264/Opus rows, plus LOC-04 frozen-picture and muted-audio
controls. All use the default public Playa decoder, scheduler, clocks and
buffers through a local draft-18 WebTransport publisher/relay.

The synthetic publisher extracts H.264 access units and Opus packets from
the generated MP4 fixtures. It rejects composition offsets, noncontiguous
samples, dependent video starts, and Opus outside the declared single-frame
20 ms profile. Each object has its own subgroup stream as MSF-00/01 section 6
requires; video groups start at keyframes, audio uses one packet per group.
LOC-01 carries Unix-epoch microseconds; LOC-04 covers both that domain and
media ticks at the fixture's actual timescale, with application epoch zero.
Keyframes carry AVC configuration. MP4's final partial duration does not trim
the transmitted elementary Opus packet: its full 960 samples count toward the
next loop. The resulting Opus span is 6.020 seconds versus video's 6.000;
this fixture does not qualify A/V synchronization.

Observers preserve the native canvas draw and audio speaker connections.
They count the final VideoFrame draw per animation-frame callback rather than
overwritten decode bursts, and tee post-gain PCM from the player's existing
AudioContext. Canvas frame metadata and pixels establish real rendered output
at refresh opportunities, not physical display/compositor presentation.
Canvas `bufferedRanges` stays null, and currentTime remains the existing
playback-duration statistic rather than a newly qualified content-position clock.
Raw normalized timestamps must agree with their declared epoch/domain and
progress near real time. Unit discriminators reject nonfinite timestamps,
wrong epochs, 1000x clocks, wrong output surfaces and invented canvas buffering.

Real playback exposed a relay defect: it dropped the delivering subgroup's
END_OF_GROUP flag, causing the player to wait for a GOP-completion timeout
and fall below the unchanged 24 fps acceptance threshold. Additive decoded
`subgroupContainsEndOfGroup` metadata now preserves that header bit through
live forwarding and cache replay. It means the subgroup contains the group's
largest object, not that every delivered object is the last object. FIN still
completes the subgroup. Loopbacks cover true/false evidence on drafts 14, 16,
18 and 22; relay tests cover live/cache delivery and FIN. No core scheduling,
decoding, timing or recovery policy changed.

The cancellation review also found that the relay's old retirement helper
sent FIN on unfinished subgroups. Cancellation now aborts queued forwarding;
the adapter owns RESET of that request's streams (Transport-18 sections 5.1.1
and 11.4.3). Three regressions failed before the correction: a blocked-write
case detects unwanted queued sends/FIN, and real-adapter cases on drafts 18/22
assert the original outgoing pipe was reset, not closed with FIN. The unused forced-FIN
retirement helper was removed; ordinary upstream completion still forwards FIN.

The fixture/observer findings were tested before fixing them. Removing relay
flag preservation fails its live-delivery regression; counting raw canvas draws
instead of refresh opportunities fails the observer test. Both mutations were
restored. LOC publisher tests also discriminate full-packet loop timing from
the MP4-trimmed duration.

Final local evidence is
`reports/player-acceptance/2026-10-06T22-11-04-309Z-1587fb7d/result.json`:
all fourteen cases passed with exact intended failures in the four output
controls, all twelve rendition/tone counterfactual checks, fulfilled original
transport `closed` promises, closed AudioContexts, idle players and zero page
errors. This is macOS arm64, Node v24.2.0, Chrome 155.0.8059.40 against source
`41f1ec3` plus the captured uncommitted diff. Captured runtime/configuration
hashes, including the browser observer page, match the final capture.

The full suite passes 6712 tests in 249 files, with one existing fixture-dependent
skip. Workspace and examples builds, example/test/publisher/relay typechecks,
and built-export smoke passed. The new workflow has not run remotely.
Final independent re-review found no remaining findings and separately passed
170 relay/adapter tests, including the cancellation RESET/no-FIN regressions.
LOCMAF MSE/frame browser rows are next. A/V synchronization, codec/configuration
changes, live audio/ABR switching and independent producer/relay/browser profiles
remain unqualified. Nothing committed in this extension, pushed or published.

## LOCMAF Browser Output and Reset Recovery

The next uncommitted extension qualifies clear H.264/AAC LOCMAF `0.3` through
both public `locmafDecoding: 'mse'` and `'frame'` paths. The pinned LOCMAF-01
text requires one ordered subgroup stream per group (section 3), CMSF inline
initialization references (section 6), and full-header recovery after a missing
object or RESET. The example publisher now follows that mapping in finite and
looped publication and defaults LOCMAF to the modern catalog. Explicit legacy
catalog selection fails before connection. Plain CMAF retains its existing mapping.

Generated fixture evidence compares canonical reconstructed chunks, coded sample
bytes, decode/presentation ticks, duration and flags across two groups. Full
headers and real deltas are required; raw fallback cannot satisfy this fixture.
Browser observers independently check the received catalog, initialization
references, per-track full/delta objects, and one stream per group. Wrong versions,
missing init references, plain CMAF payloads and split streams fail their tests.
The fixture round trip uses our own encoder/decoder, not an independent oracle.

Qualification and review found several narrow defects, each with RED-before-fix
regressions:

- Loop rebasing now copies Node Buffer inputs instead of mutating the original.
- Frame delivery preserves each sample's duration in microseconds, including
  variable durations and nonzero composition offsets.
- Raw-box initialization shortcuts validate exact box coverage and reject size
  escapes before caching or decoding. Repeated raw headers invalidate delta state;
  malformed raw objects use the existing failed-group accounting and track limit.
- RESET invalidates the affected LOCMAF group immediately. Parked pre-alias objects
  preserve reset order through replacement streams, ownership filtering and
  terminal-record pressure. FIN does not invalidate the reference. Old sessions
  cannot invalidate a new session's matching alias/group.
- Deferred application transforms cannot re-anchor a group after RESET, raw-header
  replacement, unregistration or shutdown. Guards are bounded to 256 inputs and
  8 MiB per manager; invalidated work keeps its charge until it settles. Reentrant
  reset, late rejection, capacity exhaustion and subsequent recovery have tests.
  This does not introduce transform ordering or qualify encrypted media.

Final local evidence is
`reports/player-acceptance/2026-10-06T22-59-57-285Z-8f047903/result.json`.
All twenty scenarios passed: the prior fourteen plus healthy, frozen-picture and
muted-audio LOCMAF cases on each path. The twelve wrong-output rendition/tone
checks also passed. Original transport `closed` promises fulfilled, AudioContexts
closed, players returned to idle, and no browser/player errors occurred. The run
used macOS arm64, Node v24.2.0 and Chrome 155.0.8059.40 against `41f1ec3` plus the
captured diff. All 508 checked runtime/configuration hashes match that source.

The full suite passed 6786 tests in 252 files with one existing prepared-fixture
skip. Workspace/example builds, test/publisher/relay typechecks, built-export
smoke and workflow actionlint passed. Final independent cold review found no
remaining blocking findings in this bounded qualification/reset scope.

Protected media, changing initialization, real-browser loss/reset injection,
A/V synchronization, live audio/ABR switching, independent producer/relay rows
and Linux CI remain unqualified. These results are not complete LOCMAF conformance.
The canvas content-position clock remains a separate API audit. Nothing in this
extension is committed, pushed or published.
