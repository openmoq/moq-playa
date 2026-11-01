# Owner-local diagnostic Probe

`createProbeRunner({ownerId, clock, transportFactory})` creates an inert runner.
Only `start({url, namespace, draft, trackHints?, policy?})` opens a transport.
The DevTools document owns the runner; hiding or reloading its panel does not
start or stop a run. The caller stops/disposes it on explicit Stop or owner
destruction. No worker, environment lookup, global installation or relay preset
fetch is performed here.

The returned run provides `source`, `capture`, `ready` and idempotent `stop()`.
Register its capture in `new DiagnosticRegistry({sourceKind: 'probe'})` and use
the ordinary diagnostic carrier locally. Page bridges reject Probe registries.
The runner retains a bounded owner collection lease until disposal or replacement
so observations survive a hidden view and startup failures remain inspectable.

Supported drafts are 16, 18 and 22. The factory receives the exact HTTPS URL,
one offered `moqt-N` protocol, and an AbortSignal. It must return a WebTransport
binding promptly, optionally with a `ready` promise; honour abort during any
asynchronous creation. A `moqt:` input is converted to `https:` as described in
transport draft-22 §6.2.1, preserving authority, path and query. Credentials and
fragments in the URL are refused. The namespace is an ordered tuple, never
split or joined. Namespace and full-name validation reuse the transport core.
The string API encodes UTF-8 without normalization and rejects ill-formed text;
it also applies a local 1 KiB budget per field/name, below the wire's total bound.

Strict policy refuses missing or mismatched observed protocol before sending
SETUP. Explicit `policy: 'compatibility'` permits a missing observation and
retains null as the negotiated value. A mismatched observation is always refused.
Session readiness requires actual MoQT SETUP completion. With explicit track
names, it additionally waits for each SUBSCRIBE response. With no names, the
probe measures session setup only: no catalog discovery or media subscription
is implied. Up to four named tracks can be observed; no automatic track scan,
publisher operation, reconnect or playback is performed.

Facts include session, control-message type/direction, accepted subscription
and delivered stream-object metadata. Payloads are not retained in diagnostic
facts. Object identifiers stay decimal uint64 strings, stream IDs unavailable
from this callback stay null, and independence stays unknown. Delivery does
not claim decoding or presentation. A FIN-derived end-of-group marker emits a
`group_bound`, with no Object fact or delivery ID. The bound is exclusive after
the last parsed Object, or inclusive at uint64 maximum; an empty subgroup
provides no numeric bound. An actual parsed status Object remains an Object.
The distinction uses the receipt's origin, never the status value alone.
Diagnostic storage has the capture's
ordinary explicit bounds; this is not a new limit on the adapter's wire decoder.

Dial, transport-ready, SETUP and each subscription operation have finite
timeouts (10 s per operation by default). Stop also waits for the exact
transport's closed promise under a 3 s per-await bound. A resolved or rejected
closed promise proves termination; rejection retains the transport failure
without inventing a second teardown failure. Non-settlement and cleanup errors
remain teardown failures and prevent another run on that runner. Cancelling a pending
factory returns promptly and closes a late result once when it appears.
Failure of a factory to honour abort is not proof that it released resources.
The caller must retain/handle ready and stop results; the runner also owns
their rejection internally to prevent an abandoned view's unhandled rejection.

This package imports transport, webtransport and diagnostic capture only.
The browser bundle graph gate rejects player, playback and rendering modules.
Real-browser Probe controls and relay evidence require their separate gate.

If an application object callback lacks its observed transport receipt origin,
the Probe refuses to invent an object or group-bound identity and increments
`diagnostic_unattributed_deliveries`. This source-wide, per-run counter is
reported as a metric, starts at zero, and saturates at the largest safe integer.
It measures diagnostic coverage, not missing media. Valid callbacks still get
exact object identities; no additional sampling timer or media buffer is used.
