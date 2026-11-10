# Bounded diagnostic capture

`DiagnosticCapture` is an optional source for the Playa DevTools protocol.
It opens no connection and has no DOM, timer, or environment-variable dependency.
Application exposure is explicit and independent of development/production builds.
This primitive does not install transport/player observers or a page bridge.

```ts
const capture = new DiagnosticCapture({
  source: descriptor,
  clock: { id: 'page-performance', now: () => performance.now() },
  onActiveChange(active) {
    // Install/remove additive observers here. Emit current baseline facts on activation.
  },
});
const { lease, snapshot } = capture.attach(ownerId, requestId);
// Send snapshot, then periodically drain lease.pull(). Never await the panel from an observer.
// Send lease.refresh(requestId) frames in the returned order.
lease.close();
```

The host binds a lease to an actual port/context and correlates request replies
using the full target and requestId. An ownerId is not authentication. Source
and run identifiers must be unique in the host's registry; attachment IDs are
unique within that source/run. Closed leases are inert. Reattachment uses a
new attachment ID, the same clock and sequence, and freshly observed state.

`emit(fact, lane)` does nothing when unattached. When attached, it copies only
allowlisted fields. Producers must redact known text before calling it; a
structural allowlist cannot recognize secrets inside labels or error messages.
Invalid observations return false and are accounted as per-lane drops. The
`source_state` kind is reserved for capture's own lifecycle. Nested emissions
in the same activation return false. These diagnostic calls cannot authorize,
subscribe, fetch, or change playback.

A rejected observation consumes one sequence and appears in both source
evictions and each ready lease's delivery-drop count. These counters describe
different boundaries and must not be added together as distinct lost events.
An invalid lane consumes no sequence because it cannot be attributed to either
lane. Inactive or nested emissions also consume no sequence. A false return
does not by itself signal a producer bug; a true return means the observation
was accepted, not that every retention or delivery budget could retain it.

Current session/track/request/stream/metric/dial/recording/group-summary state
is coalesced by identity, separately from event history. Both stores have
independent count and serialized UTF-8 byte budgets. History also expires by
age on capture or refresh. Current state does not age out, but is bounded by
count and bytes. Coalescing, expiry, invalid observations, and release of the
last attachment increment source eviction counts. These are loss of diagnostic
history, not loss of media or network objects. The wire's retention totals
include both stores and one reserved terminal slot; maxAgeMs describes history.
Byte counters are conservative serialized-event sizes, not JavaScript heap measurements.

Each lease has an independent count/byte-bounded pending queue. A slow consumer
cannot make another lose deliveries. Batch intervals are contiguous from the
last delivered watermark and account for every sequence as a surviving event
or a dense/sparse delivery drop. Source retention and delivery drops are separate.
Every returned frame passes the shared codec and MAX_MESSAGE_BYTES limit.

The default pending queue admits up to 1024 events and 254 KiB of serialized
event data per lease. The remaining 2 KiB of the 256 KiB frame limit is reserved
for the batch envelope. This accommodates ordinary media-stage bursts between
the host's quarter-second polls; it is a bounded allowance, not lossless capture
at every traffic rate. A slower reader or larger burst still receives exact
delivery-drop counts. Applications may supply smaller explicit limits.

A source refresh returns any pending batch first, then its snapshot with an
equal or newer watermark. A detail refresh returns only a scoped snapshot;
it does not drain the queue or advance the stream cursor. Snapshots prioritize
terminal/current state then recent history, report omittedFacts, and return
whole observations in sequence order. Group detail uses the exact session,
alias, and group tuple. Track detail includes only explicitly attributed facts.
No implicit alias inference or extra subscriptions occur.

Construction throws on invalid source, clock identity, or limits. `attach()`
throws on invalid owner/request identities, attachment limits or identity
exhaustion, reentrant clock access, or an ended source (including termination
during activation). For an open lease, `refresh()` throws on an invalid request
identity/scope or reentrant clock access. It remains available after the source
ends, so the host can retrieve the terminal state. A closed lease returns `[]`
without validating the request. The host should catch attach/refresh errors at
its request boundary and return a sanitized protocol error.

Normal invalid producer observations and clock/activity callback failures are
contained by `emit()`/`dispose()`; `pull()` has no caller input to validate and
returns null when drained or closed. `close()` and `dispose()` are idempotent.
These calls do not intentionally throw for lifecycle or validation outcomes.

`dispose()` ends diagnostics, not the transport. Open leases drain a final
`source_state` fact then return null; refresh still reports the terminal state.
No new attachment is allowed. The final uint64 sequence and a 512-byte slot
are reserved for termination, so exhaustion ends the run instead of wrapping.
A non-finite, throwing, regressing, or reentered clock ends capture with
`clock-error` using its last validated time. The clock must be synchronous and
side-effect-free; reentrant disposal uses the last validated time as well.
A new source/clock domain needs a new run, never an undeclared clock in a batch.

Activity notifications are synchronous, first/last only, and exceptions are
contained. They run after the attachment map is updated and can nest: a last
detach's `onActiveChange(false)` can reattach, invoking `onActiveChange(true)`
before the outer callback returns. Observer installation/removal must account
for this if it reenters the source. Promise rejections are contained too, but
an asynchronous callback is not awaited and cannot defer observer ownership.
Last detach releases retained observations and all queues. Disposal
deactivates observers immediately but preserves the bounded drainable data
until the host closes its leases. Host registrations, outbound port queues,
request rates, and exports need their own bounds.

## Page source registry

`DiagnosticRegistry` exposes only explicitly registered `kind: attached`
sources. It has no DOM, timers, transports or automatic attachment; Probe
sources stay local to their extension owner. `register(capture)` returns an
idempotent revoke function. Registration and discovery copy metadata without
reading a clock or activating capture. `open(ownerId)` returns a connection
object which the host must bind to an actual port/document. Duplicate active
owner IDs are refused; an owner string alone is not authority.

Each connection has at most one selected lease. Call `request(encoded)` with
a shared-protocol discover, attach, snapshot.request or detach command; a new
attach requires explicit detach. Recording commands currently return unsupported.
The future bridge/host must keep recording actions disabled until implemented.
`pull()` returns one pending encoded batch or withdrawal notification, or null.
No operation creates a network session or changes the observed player.

Revocation releases this registry's leases and queues one sanitized not-found
error using the original attach requestId and exact target. Polling returns it
once; if a valid owner command arrives first, an already queued notification
precedes its reply. Revocation during a refresh can instead fail that request
first and queue the notice for the next pull/exchange. Treat that later notice
idempotently for the same attachment. Keep the attach correlation until detach
or withdrawal. A refused initial attach has no bound attachment to withdraw. Registry
revocation does not dispose the application's capture; it can remain active
through another observer. A withdrawn attachment must not be shown as merely
quiet, nor as a transport close.

Malformed/oversize input, response messages used as commands, and reentrant
commands close the connection. `closedReason` states that local outcome; it
does not emit a source-ended fact. Closed handles are inert and cannot affect
later connections. Invalid owner/target commands receive sanitized errors
without changing another attachment. The host still owns carrier flow control,
idle expiry and connection-loss presentation.

The registry bounds active sources, aggregate UTF-8 descriptor bytes, connections,
and lifetime registrations (defaults: 32, 128 KiB, 8, 1024). Exact source/run
identity reuse is refused, including after revocation. Retired identities are
not evicted: forgetting one could validate a stale command if a fresh capture
reuses its attachment counter. At the lifetime limit, registration throws an
explicit limit error; diagnostics integration must handle it without stopping
playback. An application needing a new registry must close the old registry's
host bindings and continue with fresh run identities. `dispose()` closes the
registry's connections before cleanup callbacks run, without disposing captures.

`DiagnosticCarrier` wraps one such connection with reader credit and bounded
idle expiry. It is also DOM/timer-independent: the endpoint sends its returned
frames once and owns the timer. See `@openmoq/devtools-protocol/CARRIER.md` for
the envelope, bootstrap, limits and close-state distinctions.

## Opt-in page endpoint

```ts
const registry = new DiagnosticRegistry();
const revoke = registry.register(capture);
const bridge = installDiagnosticBridge(registry);
// The application chooses exposure in development or production.
// Later, on application teardown:
bridge.dispose();
revoke();
registry.dispose();
```

Importing the package installs nothing. `installDiagnosticBridge` requires a
top-level window with a nonopaque origin, and refuses a second installed bridge
in that realm. It owns only its registry connections and timers, not captures,
media pipelines, or an application's own observers. It accepts same-window,
same-origin discovery with exactly one transferred MessagePort; responses use
that port, never window broadcasts. Unrelated window messages are ignored.

An idle timer releases a vanished reader even if its browser has no MessagePort
close notification. pagehide closes current carriers; a restored page requires
fresh discovery. `dispose()` removes listeners and closes only this endpoint's
connections. It is idempotent; it does not dispose the registry. Registering or
installing can throw on invalid options, unsupported context, identity/limit
exhaustion, or duplicate installation. Applications must contain optional
diagnostic setup failures rather than letting them interrupt playback.

The browser gate runs against built packages and real Chrome MessageChannels:

```sh
pnpm --filter @openmoq/devtools... build
pnpm --filter @openmoq/devtools test:browser
```

Its eight cases cover private discovery, ordered refresh, ownership, replayed
credit, rebootstrap, child-window rejection, cleanup and real idle expiry.
pagehide/pageshow are explicit lifecycle events, not a bfcache navigation test.
No extension permission prompt, relay, media playback, recording, or Probe is
covered here. JSON reports retain the tested build hash and bounded errors.
`test:browser --mutate-receipt` serves a modified copy from memory and must exit
nonzero on "Replayed receipt accepted" after the first three checkpoints; it
changes no source or dist file. CI runs the positive gate and retains its report.

## Optional recording hook

`registry.register(capture, { createRecorder })` enables owner-controlled recording
for that registration. The application must also declare `recording` in the
capture's capabilities; the registry does not rewrite source metadata. The
factory runs only on an accepted `record.start` and receives `{maxBytes}`. It
returns an independent recorder with `start`, `stop`, `dump` and `dispose`.
It must bound retained data within that budget, including metadata, and reserve
room for serialization overhead. Existing app-owned recorders remain independent.

One recorder may be active per registration, with at most eight retained owner
recordings. Stop preserves that owner's data for export; a new start replaces
only the same attachment's stopped recording. Detach, withdrawal and connection
closure dispose its recorder and cancel its export. Shared start/stop facts carry
the attachment identity, never its private token. A failed dump can be retried.
Exports are limited to 8 MiB of UTF-8 text, paged under carrier credit; pending
live batches interleave. The recorder hook and source capabilities are opt-in.

## Retained ended evidence

New attachments to ended captures are refused by default. The explicit
`allowEndedAttachments: true` option permits read-only inspection while an
existing lease still retains the ended evidence. Historical attachment does not
read a clock, reactivate observers, allocate observation sequences or resume
emission. The snapshot includes the original source-end fact. Ordinary lease
and wire budgets apply. Once the last retaining lease closes, history is
released and another ended attachment is refused. The Probe owner uses this
option so a failure that precedes panel attachment remains inspectable.

`new DiagnosticRegistry({sourceKind: 'probe'})` admits only owner-local Probe
sources; the default registry admits attached page sources. A Probe registry
cannot be installed through `installDiagnosticBridge`.


### CMAF append-stage capability

`cmaf-append-stages` declares that the source's player engine supports the
receipt-to-reconstruction-to-append observation interface. It is a static
capability, not a claim that every configured packaging or custom adapter
provides append evidence. Standard CMAF and LOCMAF-MSE paths report
`reconstructed`, actual `appended`, and observed `discarded` outcomes. A
custom MediaSource without `observeAppends` increments
`diagnostic_unobservable_appends`; it never fabricates append success or a
media discard. LOC canvas playback does not use this append path and therefore
has no append stages and no unobservable-append count from merely being LOC.
MSE decode, scheduling and presentation are not inferred from append success.

The adapter reports `diagnostic_unattributed_stages` when it did not observe a
stage input's receipt in its own capture lifetime. The engine separately
reports `diagnostic_unattributed_inputs` for unknown reconstruction contributors,
`diagnostic_evidence_loss` for refused admission or unproven completion, and
`diagnostic_unobservable_appends` for a missing adapter capability. These
counts describe diagnostic coverage, not missing media Objects.


Ending or reassigning a pipeline input observer forgets buffered diagnostic
identities, not buffered media. No terminal media-discard outcome is invented
for that observation boundary; a later observer cannot acquire that history.
Actual pipeline removal reasons are listed with the transport, assembler and
append reasons in PLAYER.md.
