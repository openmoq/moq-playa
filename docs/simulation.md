# Simulation & Protocol-Confidence Harness

Playa's deterministic test harness for the MoQT transport. This is the layer that
proves the draft-14/16/18 implementation behaves correctly **before** it meets a
real relay or browser — it catches session-state, codec, and topology bugs in
fully deterministic, in-process runs (no network, no timers, no randomness that
isn't seeded).

It is the Playa equivalent of LibMoQ's `docs/simulation.md`, adapted to a
sans-I/O TypeScript core: the protocol logic (`@moqt/transport`) is driven through
an in-memory loopback (`@moqt/webtransport`) so the same code paths that run in
production are exercised under a controlled, repeatable schedule.

## Why it exists

Real integrations are slow, flaky, and non-deterministic; a wire/state bug found
against a live server is expensive to reproduce. This harness moves that feedback
to `pnpm test`:

- **Exact-byte regression** against committed wire vectors (incl. a cross-impl
  draft-16 corpus from LibMoQ).
- **Codec invariants** under randomized-but-seeded inputs with shrinking.
- **Session/topology behavior** under seeded operation schedules over two real
  endpoints, checked against a shadow model after every step.

Every failure is reproducible from a printed seed; nothing here depends on wall
clock, network, or `Math.random`.

## Test layers

| Layer | What it proves | Where |
| --- | --- | --- |
| **Golden vectors** | Committed bytes still decode and re-encode identically; the d16 codec matches LibMoQ-authored bytes | `packages/transport/vectors/` (`d16-libmoq/` 39 vectors, `d18/` 16 vectors), `packages/transport/src/vectors/*.test.ts` |
| **Codec properties** | Pure encode→decode→re-encode round-trips and out-of-range rejection over boundary-biased inputs (fast-check, with shrinking) | `packages/transport/src/**/*.properties.test.ts`, `packages/transport/src/primitives/codec-properties.test.ts`, arbitraries in `packages/transport/src/testkit/arbitraries.ts` |
| **Parser crash fuzz** | Arbitrary/truncated/malformed byte strings into every draft-14/16/18 control + data parser entrypoint never hard-crash (only `ProtocolViolationError`/`RangeError`, never a `TypeError`/plain `Error`, never `bytesRead` out of bounds) | `packages/transport/src/control/parser-crash.properties.test.ts`, `packages/transport/src/data/parser-crash.properties.test.ts` |
| **Deterministic loopback** | Two real `MoqtConnection` endpoints establish and exchange messages over an in-memory transport | `packages/webtransport/src/testkit/loopback.ts`, `pair.ts` |
| **Scenario runner** | Session/topology invariants hold over seeded clean operation schedules; double-run trace-hash determinism | `packages/webtransport/src/testkit/scenario.ts`, `scenario-d18.test.ts`, `scenario-legacy.test.ts` |
| **Fault injection** | Deterministic transport chaos — write chunking (incl. 1 byte/read), mid-stream RESET, and truncating FIN — with precise close/error + cleanup oracles. Chunking is semantically transparent (trace hash unchanged); a request-stream RESET/FIN fails only that request; a data-stream RESET is benign; a truncated object or malformed header closes the session with PROTOCOL_VIOLATION. d18 plus a draft-14/16 chunking + control-stream-FIN smoke. | `packages/webtransport/src/testkit/loopback.ts` (`PipeFaults`), `scenario-faults-d18.test.ts`, `scenario-faults-legacy.test.ts` |
| **Soak mode** | The above at higher seed/step/run counts, env-gated so the default suite stays fast | `SCENARIO_*` and `FC_*` env knobs (below) |

### Golden vectors

`.bin` fixtures plus a `manifest.json` (`{ file, type, wire_hex, expected }`).
The default run is **read-only**: it decodes each committed vector, asserts the
decoder consumes every byte, and re-encodes to the exact frozen bytes. Fixtures
are only (re)written under an explicit generation command (`GEN_VECTORS=1`), so
the committed corpus is the source of truth and never drifts silently. The d16
corpus is vendored from LibMoQ and cross-validates Playa's draft-16 codec; the
d18 corpus is Playa-authored, spec-anchored to draft-18.

### Codec properties

fast-check is a **devDependency only** (never shipped). Generators are
*valid-first*: they produce values inside the documented semantic range so
round-trips are meaningful, with targeted invalid arbitraries for the
"out-of-range throws" properties. Default `FC_RUNS=200` per property keeps the
suite fast; both the iteration count and the seed are env-overridable.

- `FC_RUNS` — iterations per property (default 200).
- `FC_SEED` — fixed seed for exact reproduction. On failure fast-check prints the
  seed, the shrunk counterexample, and a replay path.

## Scenario runner model

The scenario runner drives a **seeded** sequence of operations over a connected
CLIENT+SERVER pair and asserts a fixed invariant set after every step and at
quiescence. Random schedules are "clean" by default (no injected I/O errors), so
any violation is a genuine protocol/session bug; the **Fault injection** layer
drives the same runner with an optional deterministic transport-fault config (and
adds hand-authored fault scenarios).

**Files**

- `packages/webtransport/src/testkit/pair.ts` — `connectedPair(version)` builds
  two real `MoqtConnection` endpoints over the loopback and establishes them
  (granting the server-side MAX_REQUEST_ID credit window for draft-14/16).
- `packages/webtransport/src/testkit/scenario.ts` — the seeded runner: a
  splitmix64 PRNG, a shadow model of expected session state, the invariant
  oracle, a bounded `quiesce()`, and an FNV-1a 64-bit trace hash folded over the
  operation log.
- `packages/webtransport/src/scenario-d18.test.ts` — the draft-18 suite
  (defaults: 8 seeds × 40 steps) plus hand-authored preludes.
- `packages/webtransport/src/scenario-legacy.test.ts` — the draft-14/16 suite
  (defaults: 4 seeds × 30 steps) plus hand-authored preludes.

**Drafts covered:** 14, 16, 18.

**Operation set:** the subscriber lifecycle — `SUBSCRIBE` / `ACCEPT` / `REJECT` /
`SEND` / `UNSUBSCRIBE` / `QUIESCE` — runs on every draft. **draft-18** additionally
runs the FETCH family (`FETCH` / `ACCEPT_FETCH` / `REJECT_FETCH` /
`OPEN_FETCH_STREAM` / `SEND_FETCH_OBJECT` / `SEND_FETCH_EOR` / `CANCEL_FETCH`), the
outbound PUBLISH family (`PUBLISH` / `ACCEPT_PUBLISH` / `REJECT_PUBLISH` /
`SEND_PUBLISH_OBJECT` / `PUBLISH_DONE`), and the continuing-stream families —
SUBSCRIBE_NAMESPACE (`SUBSCRIBE_NAMESPACE` / `ACCEPT_NAMESPACE` / `REJECT_NAMESPACE`
/ `SEND_NAMESPACE` / `SEND_NAMESPACE_DONE` / `CANCEL_NAMESPACE`) and SUBSCRIBE_TRACKS
(`SUBSCRIBE_TRACKS` / `ACCEPT_TRACKS` / `REJECT_TRACKS` / `SEND_PUBLISH_BLOCKED` /
`CANCEL_TRACKS`). Legacy FETCH/PUBLISH/continuing scenarios are a later slice. The
topology differs underneath: draft-18 uses a uni control-stream pair + per-request
bidi streams; draft-14/16 multiplex requests on a single bidi control stream.

**Invariants** (checked after each step, and tightened at quiescence):

- No `onError` on either endpoint.
- Both sessions stay `ESTABLISHED` (no unexpected close).
- Request-ID parity and uniqueness (client allocates even IDs).
- Track-alias binding while active, and alias cleanup after unsubscribe/reject
  (a freed alias routes nothing).
- **draft-18 only:** no post-SETUP bytes on the uni control stream (requests ride
  per-request streams). Gated off for draft-14/16, where requests legitimately
  use the shared bidi control stream.
- Delivered objects ⊆ sent objects per subscription, and **exact** equality once
  drained at quiescence.
- Terminated subscriptions are never `ESTABLISHED`.
- **FETCH (draft-18):** request IDs share the client even sequence and stay unique
  across subscriptions + fetches; FETCH_OK / REQUEST_ERROR correlate to the right
  request; fetch data + End-of-Range gaps deliver only via the fetch path (the
  connection `onObject`, never an alias-based subscription); delivered ⊆ sent
  mid-step and exact after quiescence for live fetches; a rejected fetch delivers
  nothing; `CANCEL_FETCH` tears the fetch down (late data is not delivered).
- **outbound PUBLISH (draft-18):** request IDs stay globally unique across
  subscribe/fetch/publish; publisher-chosen track aliases are unique and disjoint
  from subscription aliases; PUBLISH_OK / REQUEST_ERROR correlate to the right
  publish (accept → publisher ESTABLISHED, reject → publisher state removed,
  delivered nothing); published objects deliver ONLY to the peer's
  `IncomingPublish.onObject` (a leak detector asserts the peer's generic `onObject`
  stays empty); delivered ⊆ sent and exact after quiescence; `PUBLISH_DONE` removes
  the publisher's outgoing state (the runner never sends after DONE — draft-18 keeps
  the peer alias routing alive for late/in-flight data, pinned by a prelude).
- **continuing streams (draft-18):** request IDs stay globally unique across every
  family; SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS REQUEST_OK / REQUEST_ERROR
  correlate to the right continuing request; NAMESPACE / NAMESPACE_DONE reach only
  the matching namespace subscription and PUBLISH_BLOCKED only the matching tracks
  subscription (routed by Request ID); announced-suffix / blocked-track accounting
  is delivered ⊆ sent mid-step and exact after quiescence; a rejected continuing
  request receives no continuation; `NAMESPACE_DONE` terminates the namespace
  subscription (§6.1 — not a per-suffix withdrawal); `CANCEL_NAMESPACE` /
  `CANCEL_TRACKS` close the continuing stream and suppress later continuation
  (pinned by preludes).
- Deterministic replay: the same seed produces the same trace hash and log length
  across two runs (delivery totals for every family fold into the hash, so a
  routing/delivery divergence changes it).

**Coverage statement:** for draft-18, these layers cover the implemented public
transport surface end to end. Automatic Redirect-following is intentionally
**application policy**, not transport behavior — the codec/session decode and
surface a Redirect, but the harness does not (and the library does not) auto-
reconnect or re-issue the request.

## Reproduction commands

```bash
# Everything (default: bounded, deterministic, fast)
pnpm test

# Scenario suites only (all drafts)
pnpm test packages/webtransport/src/scenario-d18.test.ts \
          packages/webtransport/src/scenario-legacy.test.ts

# Scenario soak — wider seed sweep / longer schedules (env-gated)
SCENARIO_SEEDS=2000 SCENARIO_STEPS=200 npx vitest run scenario-d18.test.ts
SCENARIO_SEEDS=300  SCENARIO_STEPS=120 npx vitest run scenario-legacy.test.ts
SCENARIO_SEED_START=5000 SCENARIO_SEEDS=50 npx vitest run scenario-d18.test.ts
pnpm test:soak          # SCENARIO_SEEDS=2000 SCENARIO_STEPS=200 over the d18 suite
pnpm test:soak:legacy   # SCENARIO_SEEDS=300  SCENARIO_STEPS=120 over the draft-14/16 suite

# Codec property soak (more iterations / a fixed seed for replay)
FC_RUNS=5000 npx vitest run packages/transport/src/data/draft18-data.properties.test.ts
FC_RUNS=5000 npx vitest run packages/transport/src/control/draft18-codec.properties.test.ts
FC_SEED=42 FC_RUNS=1000 npx vitest run packages/transport/src/primitives/codec-properties.test.ts

# Parser crash-fuzz soak (arbitrary/malformed bytes; same FC_RUNS / FC_SEED knobs)
FC_RUNS=5000 npx vitest run packages/transport/src/control/parser-crash.properties.test.ts
FC_RUNS=5000 npx vitest run packages/transport/src/data/parser-crash.properties.test.ts
FC_SEED=123 npx vitest run packages/transport/src/data/parser-crash.properties.test.ts  # replay a seed
pnpm test:soak:fuzz  # FC_RUNS=5000 over all 7 property + parser-crash-fuzz suites

# Golden vectors (read-only by default). Regeneration is explicit and reviewed:
GEN_VECTORS=1 npx vitest run packages/transport/src/vectors/vectors-d18.test.ts
```

Scenario env knobs: `SCENARIO_SEEDS` (number of seeds), `SCENARIO_SEED_START`
(first seed), `SCENARIO_STEPS` (steps per scenario). Property env knobs:
`FC_RUNS`, `FC_SEED`. Vector regeneration: `GEN_VECTORS=1` (only rewrites the
committed `.bin` + `manifest.json` after an intentional wire change).

## What the harness has already found

Factual log of real bugs caught before any live integration:

- **draft-18 unsubscribe** incorrectly tried to encode an `UNSUBSCRIBE` message,
  which draft-18 removed (cancellation is request-stream teardown).
- **draft-14 SERVER_SETUP** encoding was missing (the codec had only ever run as a
  client), so a draft-14 server could not establish.
- **draft-14 outbound specific-error encoding** was missing: the session emits a
  unified `REQUEST_ERROR`, but draft-14 needs the specific wire type
  (`SUBSCRIBE_ERROR`, etc.), so a draft-14 server could not reject a request.
- **draft-18 empty FETCH object** encoder wrote an extra Object Status byte that
  the decoder never consumed, misaligning the next object in a fetch stream.
- **non-first FETCH object with no prior context** (draft-14/16 and draft-18) hard-
  crashed with a `TypeError` instead of rejecting cleanly; the decoders now throw
  `ProtocolViolationError`. Found by the parser crash-fuzz layer.
- **duplicate `onError` on a request-stream failure** — a peer reset surfaced via
  both the response-consumer and `onStreamError` paths (same Error instance); the
  adapter now de-dupes by identity so one failure fires `onError` once. Found by
  the fault-injection layer.
- **legacy session close left `subscribeTrack()` unresolved** — a draft-14/16
  caller awaiting a subscribe could hang forever after the shared control stream
  closed mid-response (an API lifecycle bug). The adapter now rejects and clears
  pending raw subscription state on a terminal control failure / session close.
  Found by the fault-injection layer.

## Non-goals / future work

- **Fault injection** covers write chunking, mid-stream RESET, and truncating FIN
  today (d18 + a draft-14/16 smoke). Still to come: STOP_SENDING / FIN-vs-data
  races, datagram-corruption-is-dropped, and applying the full fault matrix to
  draft-14/16 beyond the chunking + control-FIN smoke.
- **Virtual time** is not modeled; delivery is driven by a microtask pump, not a
  simulated clock.
- **Automatic Redirect-follow** is intentionally not provided — following a
  Redirect is application policy.
- LibMoQ's **OOM/allocation testing** does not map directly to JS; we substitute
  state-leak invariants (no dangling subscriptions/aliases after teardown,
  endpoints converge with no pending requests at quiescence).
