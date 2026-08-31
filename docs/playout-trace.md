# MOQ Playout Trace

Status: **approved design**. Revision 6 — steps 1 and 2 implemented,
step 3 onward pending.

## Problem

We cannot see what a user sees.

When someone reports "the picture froze," the artifacts we can collect are at
the wrong layer. A qlog captures transport observations: which objects were
parsed, when, in what order. It cannot show whether the picture moved, and the
two come apart. The late-keyframe defect fixed in `1d9d1c6` has a signature
that is invisible in a transport log: the source unit was observed, a
pre-decode scheduling decision classified it as late, and it was discarded
before it was ever submitted to the decoder — while later units that depended
on it were submitted without their reference.

The same gap exists between vendors. A publisher, a relay, and a player each
log in a private format at a different layer, so a freeze report cannot be
localized without a call.

### What a trace can and cannot establish

It can locate the **first observed delay or discard boundary at this client**.
It can distinguish "the unit was parsed before its playout deadline and then
discarded in the renderer" from "the client did not observe the required source
unit before its deadline."

It cannot assign upstream-versus-player ownership. `moqt:*` events are MOQT
parse observations, not evidence of when bytes reached the host. Subscription
timing, flow control and backpressure, delayed stream reads, main-thread
stalls, and adapter processing can all make a client's first observation late
for reasons that are the player's own. Localizing the boundary is the goal;
apportioning blame across the path requires evidence this trace does not have.

## Approach: extend qlog

qlog is designed for mixed extensible namespaces and we already emit it. Rather
than a parallel format with its own clock and tooling, MOQ Playout Trace defines
new event namespaces inside a qlog file, sharing one monotonic clock with the
transport events.

| Namespace | Content | Status |
|---|---|---|
| `moqt:*` | Transport observations | Implemented (draft-pardue-moq-qlog-moq-events-06) |
| `loglevel:*` | Our `LoggerLike` output | Standard qlog namespace; tee only |
| `moq_playout:*` | Media unit lifecycle, playout state | **Proposed here** |
| `playa:*` | Structured internals with no interoperable home | Private, minimal |

The logger tee uses qlog's standard `loglevel` namespace
(`urn:ietf:params:qlog:events:loglevel` — `error`, `warning`, `info`, `debug`,
`verbose`), which exists precisely so an implementation can replace its
free-form text log. `playa:*` is reserved for structured events that genuinely
have nowhere else to go, not used as a default dumping ground.

Non-IETF namespaces must not use the `urn:ietf:params:qlog:events:*` form;
private schemas use a domain URI with an `mmyyyy` datestamp. qlog main -14 §8
requires the URI to contain the namespace identifier, and one schema defines
exactly one namespace, so:

```text
https://openmoq.org/082026/moq_playout
```

The URI need not be dereferenceable, but its assignment must be authorized by
the domain owner near the embedded date. A `playa:*` schema URI containing
`playa` is defined only if and when such an event actually exists; it is not
listed before then. If the playout namespace proves itself, the IETF form can
be proposed later.

## The private `playa` schema

The recorder emits two events of its own, so the private schema exists now and
is listed in every dump:

```text
https://openmoq.org/082026/playa
```

qlog event schemas are immutable once assigned, so both shapes are fixed here.
Future fields go through the group sockets rather than by redefinition.

Per [QLOG-MAIN] §8.2 a schema defining data fields extends `$ProtocolEventData`.
Per §1.2 every time value is `float64` milliseconds. Per §11.2 every serialized
field name is lowercase.

```cddl
PlayaEventData = PlayaMetadata / PlayaTraceWindow
$ProtocolEventData /= PlayaEventData

; Event name: "playa:metadata"
; Interpretation metadata, pinned outside the evictable window and
; timestamped when declared. One event per declaration.
PlayaMetadata = {
  kind: text                  ; e.g. "trace_capabilities", "track_declared"
  data: { * text => any }     ; kind-specific payload
  * $$playa-metadata-extension
}

; Event name: "playa:trace_window"
; Emitted once, last, describing what the dump does and does not contain.
; Its event `time` is when the dump was produced.
PlayaTraceWindow = {
  clock_id: text
  clock_type: "monotonic" / "system"
  capture_start: float64 / null
  capture_end: float64 / null      ; set once recording stopped
  dump_time: float64               ; when this window event was produced
  retention_cutoff: float64        ; edge retention was applied against
  earliest_retained: float64 / null
  recording: bool
  dense: PlayaLaneStats
  sparse: PlayaLaneStats
  limits: PlayaTraceLimits
  metadata_entries: uint64
  metadata_bytes: uint64
  metadata_truncated: bool
  metadata_dropped: uint64
  recorder_faults: uint64
  open_lifecycles: uint64 / "unknown"
  * $$playa-trace-window-extension
}

PlayaLaneStats = {
  retained: uint64
  bytes: uint64                    ; UTF-8
  evicted_events: uint64
  evicted_bytes: uint64
  evicted: bool
  * $$playa-lane-stats-extension
}

PlayaTraceLimits = {
  dense_max_age_ms: float64
  dense_max_events: uint64
  dense_max_bytes: uint64
  sparse_max_age_ms: float64
  sparse_max_events: uint64
  sparse_max_bytes: uint64
  metadata_max_entries: uint64
  metadata_max_bytes: uint64
  max_log_message_chars: uint64
  * $$playa-trace-limits-extension
}
```

Carrying the discriminant *inside* `PlayaMetadata`, rather than minting an
event name per kind, keeps the schema a bounded contract while leaving `data`
open.

`dump_time` and `retention_cutoff` differ for a stopped capture: retention
froze at `capture_end` while the dump happened later.

Both namespaces the recorder declares — `playa` and the standard `loglevel` —
are reserved: the public `record()` refuses events in them, because a
caller-authored event would make the header claim a schema that does not define
it.

## Design principle: record observations, derive metrics

Events record **observed decisions with timestamps**. They never record
computed metrics. Freeze duration, starvation-versus-policy attribution, drift
statistics — all computed by the analyzer from stored rows.

This follows directly from our simulation work, where essentially every defect
found in review was a derivation defect: a reference that moved with the policy
under test, a double-counted baseline, a gate that could not fail. Derivations
in an analyzer are re-runnable against a stored trace. Derivations in a recorder
mean asking a user to reproduce the bug again.

The recorder must be dumb enough to be obviously correct.

A specific consequence: **the recorder must never log an inference.** A unit
discarded for a reason the code did not actually observe is recorded as
`unknown`, not as a plausible guess.

## Identity

The join key is the hard part and it drives the schema.

- **`track_id`** — required on every track-scoped event. A trace-local stable
  ID. Track alias is *not* suitable: it can be reused after unsubscribe,
  migration, or recovery.
- **`media_unit_id`** — monotonic per `track_id`, assigned at first
  observation.
- **`unit_kind`** — required. Initially `encoded_frame`, `audio_chunk`,
  `cmaf_fragment`.
- **`source_objects`** — zero or more transport associations, each carrying
  connection/session ID, subscription/request generation, track alias, group,
  subgroup where known, and object ID.

`source_objects` is an array, not a single coordinate, because the relationship
is genuinely many-to-many: LOC currently maps an encoded frame to an Object,
but CMSF permits an Object to contain one or more CMAF Chunks, each with
multiple samples. Recording only the first coordinate would discard exactly the
structure this trace exists to capture. Where the association is not
one-to-one, use explicit association events.

The universal unit is deliberately not called a frame.

`media_unit_id` must survive the decoder, which does not return the object it
was given. The video path currently correlates output through a
timestamp-keyed map, which needs tests for duplicate timestamps, reordering,
resets, and codec switches before it can be trusted as an identity carrier.

### Time

Two independent time domains, never conflated:

- **qlog event time** — float64 milliseconds on the trace's monotonic clock.
- **Media time** — presentation timestamp (and decode timestamp where
  relevant), with **explicit units and timescale on every event**. Our LOC and
  scheduling code uses microseconds; qlog uses milliseconds. No field may
  silently switch domains.

There is no third domain. A scheduled presentation time is normalized into the
qlog-relative monotonic domain. An actual presentation timestamp supplied by a
browser API may be retained only alongside its source and clock mapping — never
as an unlabeled local-clock epoch sitting next to the other two.

**Duration availability is required; a numeric duration is not.** Cadence
matters because without it the analyzer derives it from adjacent *presented*
units, which subtracts absent media from the expected timeline — a missing GOP
then reads as zero freeze. That defect was already found and fixed once in the
simulation harness.

But the current LOC path cannot supply a number. `LocHeaders` has no duration
field; `duration` is optional on `VideoChunkInit`/`AudioChunkInit`
(`packages/loc/src/types.ts:159,179`) and is never populated by
`toVideoChunkInit()`/`toAudioChunkInit()` (`packages/loc/src/headers.ts`).
Requiring a value would force the recorder to invent one, violating its own
rule against logging inferences. So the schema records availability:

```ts
duration:
  | { status: 'known'; value: number; unit: 'microseconds';
      source: 'encoded_chunk' | 'container' }
  | { status: 'unknown' }
```

Catalog `framerate` — itself optional, and unable to describe variable-rate
media — is recorded separately as track metadata. The analyzer may derive a
nominal estimate from it and must label it as such; the recorder must never
promote that estimate to source duration. Where exact cadence is unknown,
freeze duration is reported as unknown or as a defensible bound, never
reconstructed from adjacent presented units. CMAF sample durations can be known
from parsed container timing; LOC frequently cannot offer the same proof.

## Observability lanes

The two playback paths have genuinely different observability. One generic
table is implementable for LOC/WebCodecs and dishonest for MSE, where the
browser owns decode and presentation internally.

### LOC / WebCodecs lane

1. source object observed and associated to a media unit, including the
   observed Video Frame Marking fields — and explicitly recording marking that
   is **absent**, since absence is what makes a discard unsafe;
2. the pre-decode timing decision: its inputs, its verdict, and its exact
   disposition. Without this the analyzer cannot separate the dependency break
   fixed in `1d9d1c6` from a legitimate drop of a sender-marked discardable
   frame;
3. decode **submitted**, with a queue-depth snapshot;
4. decoder output;
5. presentation scheduled, with the cushion that produced it;
6. presented, or a terminal disposition;
7. reset / flush / visibility / page-lifecycle / playback-intent state needed to
   interpret the above.

Presentation records both scheduled and actual time, never a precomputed
drift. The renderer reports its exact scheduled time as of `1d9d1c6`.

### Audio coupling (required in the LOC video slice)

Audio's *own* lifecycle is deferred (see phase 5). Audio's *effect on video* is
not, because video scheduling and video disposal are both derived from the sync
reference, and a video-only trace would record video outcomes with their gating
state missing.

Three couplings make this concrete:

- **The sync reference governs video scheduling.** `sync.ts` implements an
  audio-master model: the first audio sample establishes the reference and
  video render times are computed against it. A `frame_scheduled` row without
  the reference it derived from is an unexplained number.
- **Video is held and evicted on reference state.** `CommandDispatcher` holds
  decoded video while `hasSyncReference()` is false and evicts the oldest at
  `MAX_HOLD_QUEUE = 30`.
- **The playback clock changes source.** `AudioAlignedClock` reads the audio
  hardware clock via `getOutputTimestamp()` when available and otherwise uses
  `performance.now()`.

Each needs care, because the observed condition is narrower than the tempting
explanation.

**Reference unavailability is observed; "audio never arrived" is not.** The
dispatcher observes only `hasSyncReference() === false`. A reference can be
unavailable after a coordinated reset, because the audio object or timestamp is
delayed or missing, because routing has not reached that pipeline, or from a
local state or ordering defect. Conversely `setAudioReference()` runs when the
audio pipeline processes its first LOC object carrying a CaptureTimestamp —
before audio decode or output — so gesture-deferred output can be silent while
the reference already exists. And `setVideoReference()` (`sync.ts:216`) means
video-only playback establishes a *video* reference, which must never be
diagnosed as missing audio.

So the slice records:

- `sync_reference_established` — source kind (`audio` or `video`),
  source-object association where available, capture timestamp, local baseline,
  `clock_id`;
- `sync_reference_reset` — the exact observed initiator and reason;
- hold-queue enter, evict, release, reset, flush, destroy — each with the
  observed reference state and the affected video unit IDs.

The analyzer may then state that video was held or evicted while the sync
reference was unavailable. It may state *why* only where the trace carries the
source evidence for that conclusion. The gating condition is observed; the
upstream cause is not.

**Record the A/V pair, not a computed skew.** The runtime `sync_skew` event is
already a subtraction (rendered video capture timestamp minus audio playhead),
and storing it would break the rule that the recorder observes and the analyzer
derives. Store one paired observation at a single instant: the rendered video
unit's ID and capture timestamp, the audio playhead capture timestamp *or an
explicit unavailable status*, the qlog observation time, and the clock and
source IDs needed to interpret both. The analyzer computes and labels skew.
This keeps a null playhead from becoming a fabricated zero, and lets the
formula change later without another reproduction.

**The clock changes source, not domain.** `AudioAlignedClock` maps the audio
hardware clock *into* the `performance.now()` coordinate system via
`anchorOffsetUs = perfTimeUs - audioTimeUs`, preserving continuity at the
anchor and enforcing monotonic output. It introduces no unlabeled epoch. Nor is
`attachAudioContext()` the transition: the switch happens lazily on the first
`now()` whose `getOutputTimestamp()` yields valid nonzero `contextTime` and
`performanceTime`, and detach or suspend causes the fallback.

Two compositions must both work. `@playa/player` injects its
`AudioAlignedClock` as `MoqtPlayerConfig.clock`, so playback and recorder may
deliberately share it. Bare `@moqt/player` defaults to `performance.now()` and
accepts an arbitrary opaque `ClockSource`, where provenance may simply be
unavailable.

The trace therefore carries a `clock_id` plus capability metadata stating
whether the playback and recorder clocks are the same. Where provenance is
observable, record actual source transitions (`performance` <->
`audio_hardware`), AudioContext state, and the correlated values and anchor
mapping that justify continuity. Where the injected clock is opaque, declare
provenance unavailable and have the analyzer return unknown. If the recorder
and playback clocks differ, scheduled timestamps require an explicit
correlation mapping before they can be normalized into qlog-relative time.

Browser-specific AudioContext knowledge stays out of the generic
`@moqt/transport` machinery: the foundation carries generic clock IDs and
metadata, and `@moqt/browser`/`@playa/player` supply the audio-source
observations. Provenance callbacks and recorder failures preserve the
zero-cost-disabled contract.

None of this models audio units, audio decode, or audio output. It is the
observed control state needed to interpret video, and it localizes a freeze to
the sync/reference boundary rather than claiming to explain why a reference was
absent.

#### Required discriminators

- **A/V track** — the first processed audio LOC object establishes a reference;
  held video releases with the same identities and no duplicate terminal state.
- **Reference stays absent** — 31 decoded video frames produce exactly one
  observed capacity eviction, with no assertion that audio transport or output
  was absent.
- **Video-only track** — video establishes the reference and no audio
  attribution is emitted.
- **Gesture-deferred output** — a reference exists while audio output remains
  inactive, proving the two states are not conflated.
- **Reset / re-anchor** — the exact reset initiator and next reference source
  are recorded, and the coordinated-reset path cannot manufacture a double
  reset.
- **A/V observation** — the raw pair reproduces the existing skew figure, and
  an unavailable playhead stays unavailable.
- **Clock source** — attach before a valid output timestamp records no switch;
  the first valid sample records one audio-source transition; detach records one
  fallback; values stay monotonic under a single clock ID and mapping.

### CMAF / MSE lane

1. object received, fragment assembled;
2. append queued / started / completed / errored, with source refs and decode
   ranges;
3. SourceBuffer and media-element buffered-range snapshots on meaningful
   mutation;
4. media-element `play` / `pause` / `seeking` / `waiting` / `stalled` /
   `error` / visibility state;
5. bounded `currentTime`, `readyState`, playback-rate observations;
6. `requestVideoFrameCallback` presentation observations where available —
   explicitly noting these may not correlate to a single source fragment or
   sample.

### Declared capabilities

A `trace_capabilities` event states what this implementation can actually
observe: per-unit LOC lifecycle, MSE append lifecycle, frame presentation
callbacks, audio output observation, transport correlation. The analyzer must
report **"unknown: evidence unavailable"** rather than produce the same
confident attribution regardless of what was recorded.

## Terminal dispositions

Every observed discard is recorded where the implementation knows the affected
unit, using `media_unit_discarded` with the **concrete decision the code
actually made** and the stage at which it was made. Known sites include: stale
or reset object rejection, partial group abandonment, backlog shed, late
discardable video, keyframe gating, sync-hold queue eviction, reset/flush/
destroy of hold, render, and audio queues, renderer late drop and flush,
decoder state and queue-overflow drops, codec strategy drops, decoder error,
absent consumer, and on the MSE path assembly drops, contained-range replay
suppression, append error, quota recovery, buffer flush, and gap jump.

Three rules:

- **Batch operations** (reset, flush, track switch, seek, destroy) use a batch
  event listing affected IDs where known, and explicitly report that affected
  identities are unknown where the platform does not expose them.
- **Absent source material** is a `source_gap_observed` range event. It is not
  a fabricated discarded unit — there is no unit, and inventing one to carry a
  `gap` reason corrupts the partition.
- **`unknown` and `other` are first-class values.** Forcing an invented cause is
  worse than recording that we did not know.

Deliberately excluded from the earlier draft's enum: `missing_dependency`
(normally an inference, not an observation) and `policy` (too vague to
diagnose).

### Lifecycle invariant

Each fully observed unit has exactly one terminal state: presented, discarded
by an observed operation — with a concrete reason where known and explicitly
`unknown` otherwise — or outstanding at the capture boundary. This is
testable, and no analyzer conclusion may rest on a partition that is vacuous or
incomplete.

## Recorder contract

### Retention and durability

Phase 1 is a **bounded in-memory buffer with user-triggered dump. It is not
crash-safe.** JSON-SEQ tolerates a truncated final record only for data already
persisted or streamed; a 30-second in-memory ring dies with the tab. Producing
a `.sqlog` blob on a button press gains nothing from the format's resilience.

Unload-time persistence is **not** a cheap substitute. `pagehide` does not run
on a renderer or browser crash — the exact failure mode at issue;
`visibilitychange` fires on ordinary backgrounding, so serializing a
multi-megabyte ring there can perturb the playback being diagnosed; an
IndexedDB transaction opened during teardown is not a guaranteed commit
barrier; and `sessionStorage` is synchronous, quota-limited, and dies with the
page session. It would buy a main-thread stall and no crash recovery.

Page-lifecycle and visibility transitions are recorded in the ring, because
they help interpret playback. Real partial durability means chunked,
checkpointed writes during normal operation with versioning, cadence,
backpressure, quota, retention, privacy, and recovery all specified — that is
the deferred persistence design, not an unload handler.

Bound the buffer by **bytes and event count as well as age**. Logger strings,
structured metadata, and bursts make a time-only bound non-protective. If
sparse events use a second longer-window buffer, cap it too, retain original
timestamps, and sort the merged set before serializing.

Retention is by age, so a window edge can retain a terminal event whose parse
aged out, or a parse event for a unit still in flight at dump. **The analyzer
must never classify either as a discard.** Every dump therefore carries window
metadata: capture start, dump cutoff, earliest retained time, event and byte
eviction counts, overflow/truncation flags, and open-lifecycle count. Analyzer
conclusions are gated to lifecycles whose required evidence is present.

Leaving this implicit would repeat precisely the unfinished-work-classified-as-
outcome mistake we rejected in the simulation harness.

### Interpretation metadata must not be evictable

`trace_capabilities`, track declarations, and run-to-session mappings are
emitted once at startup, so under age-bounded retention they age out while the
events that depend on them remain. A retained lifecycle would then be
uninterpretable despite being intact.

These live in a **bounded, non-evictable metadata side table**, materialized
into every dump. It carries at minimum:

- trace capabilities and the recorder/export policy in force;
- definitions for every retained `track_id`;
- player-run and MOQT session/generation mappings;
- timing and reference-clock metadata needed by retained records.

Bound it independently and report metadata truncation. Where metadata for a
retained event is unavailable, the analyzer returns unknown. Window metadata is
correctly produced at dump time; capabilities and identity declarations need
this stronger retention guarantee instead of ordinary ring semantics.

### The logger tee

`LoggerLike` accepts arbitrary `unknown[]` — Error objects, BigInts, typed
arrays, cyclic structures, very large values. Never blindly stringify. Produce
one bounded text message, safely format known primitives, redact or suppress
unsafe values, and contain recorder failures so that diagnostics cannot alter
playback.

### Disabled path

Off by default. When disabled: no hot-path allocations and no clock reads.

## Privacy

**A support trace is sensitive.** Player logs contain the connection URL,
GOAWAY URIs and reasons, track names and namespaces, and arbitrary error
content. The MOQT qlog types permit raw control, object, and extension data
even though the adapter normally emits lengths only.

"No payloads" must therefore be **enforced by recorder and export policy**, not
inferred from the playout schema lacking a payload field. Any UI that dumps a
trace states plainly what the file contains, because the entire point is that
users will send these to us.

## qlog foundation work

Our envelope predates the current schema and cannot express a multi-namespace
file. Current is `draft-ietf-quic-qlog-main-schema-14` (July 2026):

- **Contained:** top-level `file_schema:
  urn:ietf:params:qlog:file:contained`, `serialization_format:
  application/qlog+json`, `event_schemas` inside each `Trace`.
- **Sequential:** a first RS-prefixed `QlogFileSeq` record with `file_schema:
  urn:ietf:params:qlog:file:sequential`, `serialization_format:
  application/qlog+json-seq`, one `trace` (`TraceSeq`) carrying
  `event_schemas`; every later event its own RS-prefixed, LF-terminated record.
- `common_fields` declares `time_format: relative_to_epoch` and a monotonic
  `reference_time` with `epoch: unknown`.

**Connection grouping is foundation work, not a later concern.** One player run
produces one `TraceSeq` on one recorder clock, but migration and recovery each
create a new connection with a **new `onQlogEvent` binding** — the public
callback is only `onQlogEvent(event: QlogEvent)` and carries no session
identity. The recorder must capture the connection/session generation at bind
time, before the event reaches arbitrary user code, and serialize it as the
qlog `group_id`, with a declaration linking each transport group to the player
run. qlog main -14 §7.3 defines per-event `group_id` for exactly this mixing of
logical groups in one trace, and MOQT qlog -07 §1.1 recommends a globally
unique identifier per MOQT session used as that `group_id` when MOQT is logged
without related QUIC events — so there is no equivalent to choose between.
Player-wide `moq_playout:*` rows carry the player run's group ID; source
associations and the pinned mapping table link them to their MOQT session
groups. A session-scoped playout or log event may use the session group
directly where its scope is unambiguous. Pre- and post-migration events
must not collapse into one session merely because they share a trace and a
clock. This shapes the generic sink and the `onQlogEvent` compatibility path,
so it belongs in step 1.

We currently emit `qlog_version: "0.4"` with `protocol_type: ["moqt"]` and
plain JSON only. `QlogTrace.toJSON()` is a public export, so the old shape must
be deliberately versioned or given an explicit compatibility path — not
silently replaced.

Two further items:

- **`bigintToNumber()` (`packages/transport/src/qlog/trace.ts:152`) silently
  narrows.** It is `Number(v)`, which loses request, alias, group, and object
  IDs above 2^53−1. We have real 2^62 varint coverage, so this is a live
  defect, not a theoretical one. Schema -14 permits uint64 as decimal JSON
  strings for I-JSON; parsers should accept both forms.
- The MOQT events draft is now `-07` (July 2026) while our types and serializer
  implement `-06`. Advertising `moqt-06` is correct **only** if we certify that
  implementation; the URI must not be bumped without an event-by-event audit.
  Stale `-04` references in player config and index comments should be cleaned
  up in the same pass.

## Implementation sequence

1. **qlog foundation** (isolated commit) — contained envelope plus sequential
   serializer; generic namespaced event sink; one monotonic clock; safe uint64
   encoding; exact RS **and** LF framing tests plus truncated-final-record
   recovery; preserve or explicitly version the existing public export.
2. **Recorder** — opt-in, bounded by byte/event/time, window and coverage
   metadata, safe `loglevel:*` tee, deterministic dump, zero-cost disabled
   path. Documented as not crash-durable.
3. **LOC video vertical slice** — thread `track_id`/`media_unit_id` from object
   parse through decoder and renderer; instrument every terminal path; analyzer
   whose conclusions are explicitly LOC-video-only. Tests: B-frame reorder,
   duplicate timestamps, reset/flush, hold-queue eviction, renderer late drop,
   track switch, migration, ring-edge lifecycles, in-flight dump.
4. **MSE/CMAF vertical slice** — fragment, append, buffer, and media-element
   events plus `requestVideoFrameCallback` where available; analyzer reports
   the weaker correlation honestly.
5. **Audio as a subject, then publisher tracing** — the audio *unit*
   lifecycle: decode, output, underrun, resampling, drift correction, device
   change. Separate schemas and lifecycles, only after their actual
   observability is specified. Note this is deferral of audio's own failure
   modes, not of the audio/video coupling above, which is required in step 3.

A schedule/present-only first cut is **rejected as a diagnostic product**: it
begins after several real discard sites and has no identity to join back to
transport, so it can produce neither a discard census nor arrival-versus-
presentation localization. It may serve as an internal serializer smoke test.

### Package ownership

Generic qlog file machinery in `@moqt/transport`; interoperable playout event
types in `@moqt/playback`; browser-specific emission in `@moqt/browser`;
recorder, dump, and analyzer orchestration in `@moqt/player`, with the demo
control in `examples/shared`.

## What this does not do

It makes freezes **legible**, not **explained**. The `1d9d1c6` defect has an
unmistakable signature in a discard census: a unit observed, classified late by
the pre-decode gate, and discarded before decode submission without sender
marking establishing that discarding it was safe — followed by dependent units
submitted without their reference. Presentation-stage late drops are a
different, also-real disposition, and both must be instrumented distinctly.

It says nothing about whether the render cushion policy is correctly tuned;
that question needs the simulation harness.

It is also not a QoE metrics pipeline: high detail, short window, opt-in, sent
by hand.

## Deferred scope

**Audio as a subject.** Audio's own failure modes — underrun, resampling, drift
correction, device change — need their own events rather than borrowed unit
ones, and are deferred to phase 5 rather than guessed at now. The audio/video
coupling observations are *not* deferred: they are required in step 3.

## Open questions

1. **Publisher side.** The same argument applies to capture and encode; the
   namespace should not be named so as to exclude it.
2. **Standardization.** Ship private, prove it on real reports, then propose.
