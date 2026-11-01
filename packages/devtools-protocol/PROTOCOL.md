# Playa diagnostic protocol

This package describes local observations shared by an optional page bridge,
the Probe runner and developer tools. It does not define MOQT wire messages
or authorize requests to a relay. It has no player, DOM or Chrome dependency.
Import the codec and types from `@openmoq/devtools-protocol`; synthetic
examples live in `@openmoq/devtools-protocol/fixtures`.

Applications choose whether to expose diagnostics. A production application
can expose them deliberately. `source.exposure` is the application's declared
mode, or null when undeclared; it is never inferred from bundling. Probe
sources have the same observation shape as attached sources but are owned by
the extension. Probe Start/Stop/configuration are not page-bridge commands.

## Encoding and compatibility

Messages are JSON strings. Call `encodeMessage` before sending and
`decodeMessage` before using received data. The codec copies declared fields
instead of returning raw source objects. Errors report a field path and a
generic reason, without echoing rejected input. Each message is limited to
262144 UTF-8 bytes. Individual fields and arrays also have limits.

`version.major` must match. Minor versions may add optional fields,
capabilities and fact kinds. Unknown fields are discarded. Unknown fact kinds
become `{kind: 'unknown', name: <original kind>}` without retaining their
payload; their sequence positions still count. A receiver must not draw an
unknown fact as measured media evidence. Changes to required shapes or the
meaning of existing enum values require a major version change. Unsupported
commands are rejected; capabilities prevent sending them to older sources.

MOQT integer identifiers and cumulative counters are canonical unsigned
64-bit decimal strings, including values above JavaScript's safe integer
limit. Do not convert them to Number for keys, sorting or grid coordinates.
Use BigInt where arithmetic is needed. Local counts bounded by array/byte
limits use safe nonnegative integers. Measured values must be finite.

Track identity preserves an ordered array of namespace fields and a track
name as lowercase hex bytes. Empty namespace and empty name are distinct
from an unavailable identity (`null`). No slash joining, Unicode conversion
or display label participates in identity comparison. These are diagnostic
representations; accepting one is not a statement that a particular draft
permits that identity on the wire.

## Ownership and commands

| Identity | Lifetime |
| --- | --- |
| `ownerId` | One DevTools document incarnation, freshly generated on reopen |
| `sourceId` | One registered player/source instance |
| `runId` | One playback/probe run; a successor never inherits stale commands |
| `attachmentId` | One attachment to that source/run |
| `sessionId` | One transport session within the run, including handover overlap |
| `deliveryId` | One observed delivery, separate from a MoQ object's identity |

IDs other than MOQT integers are opaque strings. Track and decoded-unit IDs
are run-scoped. Requests, aliases, streams and groups are session-scoped.
`sameTarget` compares all four attachment target fields. This comparison is
not authentication: the extension host binds a port to its actual DevTools
context and rejects messages from another context, regardless of supplied IDs.
Never route Probe control from a page message.

`discover` carries the requesting owner and returns `hello` with sources.
`attach` targets an owner/source/run and returns a `snapshot` with a fresh
attachment ID. `snapshot.request` reads retained evidence; `detach` releases
the attachment. Commands and replies carry an opaque correlation `requestId`,
separate from a MOQT request's numeric `requestId` inside an observation.
Hosts must check both that correlation and the bound target before accepting
a reply. A disposed owner cannot be revived by a late reply.

Keep the successful attach request's correlation for that attachment's lifetime.
If its source is withdrawn from the registry, the host receives one terminal
`error` with `code: not-found`, that original requestId, and the exact revoked
attachment target. It can arrive through polling or before a later command's
reply. If withdrawal happens during a command, that command can fail first and
the notice follows on the next exchange. Handle the notice idempotently for
that attachment. This means the attachment was withdrawn, not that the capture or
transport ended. Release its correlation on detach/withdrawal and never apply
the notification to a different attachment. Generic errors still require
their own outstanding request correlation; there is no magic `revoked` ID.

`record.start` returns `record.started` with a recording ID and owner token.
`record.stop` and `record.export` require that ID/token and the same attached
owner. The host enforces ownership; the codec only validates the shape. Shared
`recording` facts expose the owner attachment, never the token. App-owned
recordings remain separate. Disposing an owner stops its own recording.

Exports arrive as ordered `export.chunk` replies correlated with the request,
target and export ID. Indices start at zero and increase by one; `final` marks
completion. Hosts must enforce a total export budget and timeout, reject
missing/duplicate chunks and discard unfinished exports on detach. Per-message
validation alone does not bound a stream of messages. Chunks carry the existing
trace serialization; this protocol does not assign a new qlog event schema.

## Snapshots, batches and loss

A source snapshot contains state and bounded retained observations at an
inclusive `watermark`. Sequence zero is the initial empty watermark; events
start at one. Allocate a sequence for every captured fact before delivery
limits, so dropped observations remain countable. Sequence numbers never wrap;
exhaustion requires a new run. Batch intervals are inclusive and ordered.
Every position in `[fromSeq, toSeq]` is either an event or counted in
`dropped.dense` / `dropped.sparse`. Events inside the batch may have gaps, but
must be strictly increasing and the counts must account for the whole span.

`retention` reports source event/byte/age limits, current retained event/byte
counts and cumulative source evictions per lane for this run. `omittedFacts`
counts facts left out of this response because of snapshot response limits.
Neither is the same as delivery drops in a batch. Metadata/state facts can
appear in a snapshot alongside retained events; `facts.length` is therefore
not the source's retained event count. None of these losses means the peer
lost media. The UI must retain the distinction from its own coalescing or
panel-buffer overflow.

Use `cursorFromSnapshot` for a source-wide snapshot, then `advanceCursor` for
decoded batches. The latter:

- ignores another target and fully replayed intervals;
- requests a resnapshot on unaccounted sequence gaps, partial overlap or an
  undeclared clock, without advancing the cursor;
- accepts a fully accounted interval and reports `lost: true` if its source
  dropped observations. Retain/display the per-lane counts from that batch.

After a loss, request fresh state if needed, but do not erase the fact that
history was lost. A resnapshot restores retained/current state, not discarded
history. Bound pending requests and resnapshot frequency. A panel that loses
its own buffered batches while paused must resnapshot when resuming. Pause
only affects the panel; it is not a command to the page or recorder.

Snapshots can be scoped to `source`, `track`, `group` or `delivery`. Group
scope includes session and alias, not just a group number. Scoped responses
may include identifying context, but only retained evidence, never new media
subscriptions. They populate detail views and must not reset the source
stream cursor. Correlate resnapshot replies with the outstanding request,
then use `refreshCursor`: it refuses a different target, scoped response or
stale watermark. A new source/run/attachment is an explicit host transition,
using `cursorFromSnapshot` after binding it. Neither helper resets panel
controls or a run's loss history. Scoped snapshots must not feed retained
history back into live counters or overwrite newer request state.

Each snapshot declares its monotonic clocks in milliseconds; each fact refers
to one. Times are observation times, not batch send times. Clock identifiers
must remain distinct across runtimes. A new clock requires a new snapshot.
There is no clock synchronization record in this version: consumers must not
subtract times from different clocks or overlay them as if aligned.

## Evidence and presentation

The fact union describes sessions, tracks, requests, objects, processing
stages, subgroup streams, group bounds/summaries, control-message names,
metrics, dial attempts, failures and recording state. Supported capabilities
describe what the producer actually observes; they do not make unavailable
pipeline stages appear.

Minor 1 adds `source_state: ended` with reason `disposed`,
`sequence-exhausted`, or `clock-error`. It ends diagnostic capture, not any
observed transport session. The terminal fact remains drainable to existing
attachments; no later observation follows it in that run. A source reserves
its final sequence for this fact. A failed clock uses the last validated time,
not an invented wall-clock timestamp. Older consumers can skip the additive
fact but must not infer that a silent source is still producing observations.

Source refresh sends pending contiguous batches (including drop counts)
before its snapshot, whose watermark is at least the final batch sequence.
Scoped detail snapshots do not consume or advance streaming delivery. A fresh
attachment ID in the same run is a new lease, not a reset of sequence or clock.

Producers supply `object.trackId` whenever they can prove it. If it is null,
a consumer may use a proven request binding for the same session and alias;
alias numbers alone have no meaning across sessions. Unattributed objects
stay unattributed. A known track ID must never be overridden by a fallback.

Metric identity includes session, track and name. A point sample is not a
percentile; `windowMs` describes its measurement window and does not supply
samples or define an aggregation. Panel histories are bounded and keep
clock and identity boundaries. Show a median only when it is an explicitly
defined source measurement or a calculation over a disclosed sample window.

- A received object is not proof of decode or presentation. One object may
  contain many frames. Stages are independent observations associated by
  delivery and, when known, unit ID; no linear pipeline is inferred.
- A subgroup FIN is a stream fact, not an end-of-group or object-count
  witness. A reset does not identify a range of missing object IDs by itself.
  A terminal group bound and a count of observed objects are separate facts.
  `group_summary.completeCapture` describes completeness of the instrumented
  capture, not receipt of every object the publisher produced.
- `independence: expected-independent` is an expectation, not a parsed SAP or
  keyframe. Object zero must not automatically be labelled a keyframe.
- `metric.value: null` carries an explicit unavailability reason. Measured
  zero uses `value: 0, unavailable: null`. Metrics include a definition and
  optional window/uncertainty; end-to-end latency requires capture timing and
  a valid clock relation. Arrival offset is not lateness or path latency.
- Sessions report offered protocols, the selected codec draft and the
  evidence for that draft separately. Missing/empty negotiated protocol is
  null. This never waives the transport's negotiation requirements. Label it
  WebTransport subprotocol or QUIC ALPN according to the actual transport.
- MAX_REQUEST_ID is not applicable to drafts 18 and 22. Do not display an
  invented credit value there. Unknown future draft numbers may be reported
  without claiming that this package implements their wire protocol.
- Failure stage/outcome and attribution are separate. A generic dial error
  does not distinguish certificates, DNS, reachability, Origin policy or a
  relay refusal. Timeout and local cancellation are not peer refusals.

These distinctions follow the transport's byte-exact naming, separate
subgroup/group termination, sparse Object IDs and transport binding rules.
See draft-ietf-moq-transport-22 sections 2.4.1, 6.2.1, 10.9 and 11.1.1, and
draft-ietf-moq-transport-18's MAX_REQUEST_ID removal. They impose no extra
requirements on a relay or the media format.

## Privacy and resource ownership

The codec is a structural allowlist, not a free-text secret detector.
Producers must redact before encoding: no media bytes, CAT tokens, control
parameters, cookies, URL credentials, query strings or fragments. Error text
can contain those values and must be projected/redacted too. Endpoint paths
and track labels require deliberate application exposure. The schema's
string bounds do not make arbitrary text safe to publish.

Treat all received labels and text as untrusted text, never HTML or code.
Do not retain the raw message after decoding, and never retain skipped
unknown payloads. Token-bearing direct replies must not enter shared capture
or exports. Diagnostic ownership is not a confidentiality boundary from
other scripts running in the same exposed page.

The source/host must bound registrations, attachments, request rate, queues,
capture and exports independently of these message limits. Instrumentation
must not await consumers, retain media buffers, replace application callbacks
or backpressure playback. This package supplies validation and cursor rules;
the bridge and runner own those lifecycle and resource obligations.
