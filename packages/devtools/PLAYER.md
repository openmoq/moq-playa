# Optional live-player diagnostics

An ordinary `@openmoq/playa` import does not include this adapter, the capture
buffers, the extension, or the Probe runner. Import this entry explicitly in
an application that wants to expose diagnostics, in development or production.

Excluding this adapter does not make the core observation hooks byte-free.
The normal player still contains those hooks and shared playback code; bundle
exclusion proves that optional tooling is absent, not that the bundle has the
same size as an older player. Runtime overhead also depends on traffic and the
enabled observations. Registration, attachment and recording are separate
states; none implies a universal zero-cost guarantee.
The player's existing trace-recorder support is independent of this adapter
and can remain in an ordinary player bundle.

```ts
import { Player } from '@openmoq/playa';
import { DiagnosticRegistry, installDiagnosticBridge } from '@openmoq/devtools';
import { installPlayerDiagnostics } from '@openmoq/devtools/player';

// The application supplies its normal player elements and relay options.
const player = new Player(null, { url, namespace, video, canvas });
const registry = new DiagnosticRegistry();
const diagnostic = installPlayerDiagnostics(player, {
  registry,
  exposure: 'production',
  video, // Supply the active MSE video element; omit for LOC/Canvas playback.
});
const bridge = installDiagnosticBridge(registry);

// Application teardown:
diagnostic.dispose();
bridge.dispose();
registry.dispose();
await player.destroy();
```

The engine (`MoqtPlayer`) is also accepted. A facade and its engine represent
one source; installing both into the same registry is refused. `exposure` is
an explicit descriptive label, independent of bundler mode. The library reads
no environment variables, URL flags, local storage, or extension globals to
enable itself.

Registration alone does not install protocol observers, poll stats, read the
supplied clock, or start a recorder. An attachment starts collection and
samples stats and the supplied element at four Hz. The last detach removes
observers, cancels frame callbacks, and stops the timer. View Pause affects
painting only. Disposal also unregisters the source. Small bounded identity
indexes preserve track and session identities across reattachment; they do
not retain media. Detailed capture and its delivery queues have their own
explicit event, byte and age limits.

`sourceId` is stable for an engine lifetime; each connecting load attempt
uses a fresh `runId` after the previous capture ends. Pausing and resuming an
existing session does not start another run. A late attachment reads current
state; it cannot recover an unobserved handshake or startup history.

## Evidence and availability

Session identity follows the actual connection, including handover candidates
and retiring sessions. An accepted track alias comes from that session's own
validated subscription binding. Wire identities remain exact bytes; displayed
names never establish identity. Object facts report received metadata and
payload sizes, not decoding or presentation. Opaque receipt tokens correlate
explicit policy discards with the same delivery ID; they never join different
receipts merely because their wire locations match. Reasons currently emitted
are `subscription policy` (a reused subscription's range or Forward State) and
`late` (a receipt rejected by a terminal-alias guard). This is partial discard
coverage, not a total of dropped media or packets. Media-stage coverage is
declared separately for each supported path below. Stream IDs stay unavailable rather than exposing
adapter-assigned qlog numbers as QUIC stream IDs.

A FIN-derived end-of-group marker is a `group_bound`, never an Object and
never assigned a delivery ID. Its bound is exclusive after the last parsed
Object, or inclusive at the maximum uint64 Object ID to avoid overflow. An
empty flagged subgroup provides no numeric bound. Parsed wire-status Objects
remain Object facts. Application gap delivery is unchanged.

The optional video sampler uses real `requestVideoFrameCallback` metadata
when both registration and cancellation are supported. Its callback count,
media time and callback age are distinct from the advancing media playhead.
Pause, seeking and document visibility are sampled as context. For LOC/Canvas,
engine frame counters report decoder/render callbacks; an unused hidden video
element should not be supplied as if it were the active display.

Metrics include their definition, units and sampling window. End-to-end
latency stays unavailable without a verified clock relation. Arrival jitter
stays unavailable without an expected arrival cadence. Per-object stages are
not inferred from aggregate counters; inspect the source's capabilities to
see which observations are available.

The adapter's local limits include eight observed connections and 512 track
identities within a 256 KiB identity index. Change detection has a separate 512 KiB bound. Hitting these limits
reports `diagnostic_limit_events`; it does not cancel subscriptions, alter
wire limits, or prove media loss.

## Recording

Unless the app sets `recording: false`, attached DevTools owners may start an
independent bounded `TraceRecorder`. This does not take over an app recorder.
The owner alone may stop/export its recording; detach, source withdrawal and
owner destruction release it according to the registry contract.

Exports use the existing sequential qlog format and schema URIs. Sanitized
facts appear as `[devtools_observation:v1]` loglevel messages, with a metadata
baseline and declared encoding. Object/control observations use dense
retention; metrics/state use sparse retention, so object traffic does not
evict the low-rate state window. Retention and truncation are disclosed by
the recorder. Query strings, userinfo, tokens, init bytes and media payloads
are not copied into facts or recording data.

The baseline contains session, request and track state, not earlier media
receipts. An output observed during recording may refer to an input received
before recording began, so its delivery may have no Object fact in the file.
This is a recording-window boundary, not evidence of missing media. Start
recording before the input arrives to retain its complete observed chain.


## MediaSource append observations

`MediaSourceLike.observeAppends` is optional. The standard `MseMediaSource`
implements it; a custom adapter that does not implement it provides no append
completion evidence. A caller supplies a fresh opaque object as the fifth
`appendChunk` argument and registers its ownership before the call, since a
policy discard can be reported synchronously. Tokens carry no media or fields
and are not serialized. The player engine owns token-to-unit associations;
DevTools consumes engine stage observations rather than SourceBuffer tokens.

Successful `update` followed by the matching `updateend` proves `appended`.
It proves byte acceptance, not decoding, presentation, or continued residency.
An error or abort followed by `updateend` is `discarded`; a completion with no
positive or negative witness is `unavailable` with `completion unproven`.
That state must not become a fabricated append/discard fact. Without positive
success evidence, no replay-suppression timeline range is committed.

Queue entries and the serialized in-flight operation carry the token through
quota retries. Reset/retype/flush resolves discarded ownership when entries
are actually removed. A failed retry still owned by a queue has no terminal
until it really appends or is removed. Observers get copied metadata, with
listener failures contained. Unsubscribe is idempotent; last-listener detach
stops emission without stopping playback. There is no outcome history. Tokens
submitted while nobody observes are not retained. A later listener may observe
a future completion of an already token-bearing operation, but cannot recover
its unobserved history. Callers own observer cleanup, including after destroy.

The standard engine now associates original receipt identities with CMAF and
LOCMAF-MSE reconstruction and actual append outcomes. A legacy split pair can
have an unobserved half; known contributors keep their stages and
`diagnostic_unattributed_inputs` counts the unknown contributors. No identities
or unobserved history are invented. Transport receipt-to-delivery mappings live
independently of connection retirement, so queued appends may still terminate.
This does not expose MSE decoding or presentation as unit stages; browser frame
callbacks remain separate aggregate observations. LOC and LOCMAF frame mode
carry the original input receipt through the playback pipeline and native
decoder, creating a fresh unit at each actual decoded output. A synthetic
LOCMAF sample never invents a transport receipt.

The shared outcome vocabulary currently contains:

- Transport: `subscription policy`, `late`.
- Routing: `transform cancelled`, `dropped by transform`, `route retired`,
  `object processing failed`.
- Reconstruction and player policy: `track superseded`, `invalid media`,
  `orphaned media`, `epoch refused`, `superseded pending moof`, `paused`,
  `awaiting init`, `awaiting keyframe`, `not attached`, `stale group`.
- Buffered playback: `skipped`, `buffer full`, `buffer eviction`, `backlog shed`,
  `late frame`, `decoder policy` (shared reasons above retain the same meaning).
- MSE: `destroyed`, `not attached`, `stale group`, `treated as a replay`,
  `append error`, `append aborted`, `retype`, `flushed`, `decoder reset`.
- Dispatcher: `hold queue overflow`, `output failed` (plus shared reset/flush/destroy reasons).
- Canvas: `draw failed` (plus shared `late frame`, `flushed`, `destroyed`).
- Audio scheduling: `schedule failed` (plus shared `flushed`, `destroyed`).
- Unavailable evidence: `completion unproven`, which is not a media discard.

`decoder reset` names a reset of the media processing path, including MSE.
Reasons describe an observed local outcome; they do not infer publisher age or
prove that every copy of an Object was lost.

The explicit `@openmoq/player/diagnostics` entry exports
`createMediaDiagnostics`. Its implementation has no runtime dependencies and
is absent from the ordinary player bundle. The engine owns its lifetime and assembler integration; importing the factory
does not start observation by itself.

An observed unit keeps its original append source until its terminal outcome,
even if the current source changes. Retired source observers are released once
their outstanding units finish; changing targets never evicts pending ownership.
Storage is bounded by admitted units, with no timers. The factory separates
`evidenceLossCount` (refused admission or unproven completion) from
`unobservableAppendCount` (an adapter without append-observation support).
`unattributedInputCount` records reconstruction contributors or decoder outputs
whose input was not observed in that tracker lifetime, while known contributors
retain their stages. None of these counts
describes missing media. The host must replay currently owned
connections when a tracker subscribes; receipt history is never replayed.


LOC input observation follows actual jitter-buffer entry admission. A repeated
location rejects the new receipt without replacing the accepted entry's
identity. Eviction, reset, skip and decoder policy resolve identities only for
entries actually removed. Detaching or reassigning `inputObserver` ends evidence
for already buffered inputs without emitting terminal stages: buffered media
continues unchanged and a successor cannot acquire the old identities. Delayed
native output from the old lifetime cannot borrow a new receipt.

Pipeline input associations have an independent limit of 1024 per pipeline,
even when an application configures a larger media buffer. At the limit new
associations are refused and counted by `inputEvidenceLossCount`; admitted
ownership is preserved and media is still buffered and decoded normally. This
counter is diagnostic coverage, not lost media. The engine exposes its cumulative
current-lifetime value as `diagnostic_input_admission_refusals`, separate from
actual input discards and the decoded/reconstructed unit budget.

The engine installs native decoder input tokens and canvas/audio outcome
observers only with explicit media-stage observation. Video token retention
shares the decoder's 256-entry timestamp bound. Canvas presentation uses the
renderer's existing unambiguous draw witness. Audio `scheduled` means `start()`
returned successfully, and `released` only ends tracking at `onended`; neither
claims audible output. A suspended AudioContext can leave a node pending.
Last-observer detach suppresses events without stopping media or replaying
history; queued tokens are forgotten at their own terminal.

The source advertises `loc-video-stages` and `loc-audio-stages` when the engine
provides these hooks. Custom decoders that omit the token cannot prove input
identity; missing or previous-lifetime inputs increment
`diagnostic_unattributed_inputs` instead. Video supports decoded, scheduled,
presented and discarded stages. Audio supports decoded, scheduled and discarded;
its presentation is not observable. `released` retires audio ownership without a
stage. Capability describes the hook, not a guarantee that every custom adapter
provides every witness.

One 1024-unit limit is shared across reconstruction, video and audio.
`diagnostic_refused_reconstructed_units`, `diagnostic_refused_video_units` and
`diagnostic_refused_audio_units` identify the refused kind; aggregate
`diagnostic_evidence_loss` keeps its coverage meaning. Actual media discards do
not increment these counters. An unsupported target still permits a truthful
`decoded` fact with a fresh unit identity, but that identity is not retained and
consumes no pending-unit budget. `diagnostic_unobservable_video_outputs` and
`diagnostic_unobservable_audio_outputs` distinguish those capabilities from
append support. A throwing advertised observation hook counts as coverage loss,
rather than silently becoming an unsupported target. Retired render/audio
targets stay observed until their own admitted units terminate.

`video_decode_submissions` reports the engine-lifetime video command counter
after transforms and before native dispatch (the SDK's legacy `framesDecoded`
field). It does not prove decoder output. `frames_decoded` and
`audio_outputs_decoded` instead count actual decoder output callbacks in the
engine diagnostic tracker lifetime, including callbacks whose input identity or
unit admission could not be proven. A decoder can produce zero or multiple
outputs per submission; these counters do not infer one output per object or
chunk. MSE has no such callback, so these metrics are unavailable, never a
measured zero. Native-output counters are diagnostic metadata only and do not
change the SDK's legacy statistics or playback policy.
