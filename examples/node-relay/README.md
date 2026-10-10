# @moqt/example-node-relay (example)

A **Node WebTransport MoQT relay demo**: Playa's sans-I/O core (`@openmoq/transport`)
plus the WebTransport adapter (`@openmoq/webtransport`) driving
`MoqtConnection(18, { role: 'server' })` over a real Node QUIC/HTTP3 session — no
browser required. It runs the full draft-18 path: SETUP → SUBSCRIBE/PUBLISH → object
fanout.

It uses the [`@fails-components/webtransport`](https://www.npmjs.com/package/@fails-components/webtransport)
Node backend **directly** (no Socket.IO framing) and is **example-only — not
production relay support**.

## Setup

**Native backend.** The HTTP/3 backend is a native addon. pnpm blocks dependency
build scripts by default, so this repo's `pnpm-workspace.yaml` allowlists exactly
that one package (`onlyBuiltDependencies`). A fresh `pnpm install` fetches a prebuilt
binary for common platforms; if you installed before the allowlist existed, run
`pnpm install --force` once (or `pnpm approve-builds` then reinstall). Platforms
without a prebuilt fall back to a source build needing `cmake` + a C++ toolchain.

**Certificate.** WebTransport requires TLS. Generate a short-lived (<14 days, as
Chromium requires) P-256 self-signed cert into `./certs` (gitignored — never
committed):

```bash
pnpm --filter @moqt/example-node-relay gen-cert
```

For an isolated run, pass `gen-cert --out-dir /path/to/run/certs`, then set
`RELAY_CERT=/path/to/run/certs/cert.pem` and `RELAY_KEY=/path/to/run/certs/key.pem`
on the relay process. The publisher's `RELAY_CERT` selects the same certificate.
The default cert paths remain unchanged; the browser acceptance harness never
overwrites them.

It prints the cert's SHA-256 — clients pin it via `serverCertificateHashes`
(the browser player's `?hash=` takes the hex form).

## Run the simple server/client smoke

The default server mode is a toy publisher: it answers a SUBSCRIBE for the fixed
demo track `demo`/`objects` with three small objects.

```bash
# self-contained: server + Node client in one process, exits non-zero on failure
pnpm --filter @moqt/example-node-relay smoke

# or run the halves separately:
pnpm --filter @moqt/example-node-relay server      # HOST/PORT/MOQ_PATH env (default 127.0.0.1:4433/moq)
pnpm --filter @moqt/example-node-relay client https://127.0.0.1:4433/moq
```

## Run the toy relay/fanout

Relay mode forwards objects from **one publisher** to **many subscribers** over a
registered track set (a toy ABR ladder: `catalog`, `video-1080/720/360`,
`audio-en/es`, plus the demo track), preserving each object's
`groupId`/`subgroupId`/`objectId` and raw Object Properties/Extensions, while
mirroring each graceful subgroup FIN. It
supports multiple subscriptions per viewer connection (one alias each), a tiny
latest-group cache replayed to late joiners, and per-subscription cleanup when a
viewer unsubscribes one track (ABR switch) without closing the connection.

Namespace registration defaults to the `['demo']` tuple. An embedded relay can
set `RelayOptions.registeredNamespaces` to accept additional exact tuples;
namespace fields and track names are compared byte-for-byte.

The relay also answers **FETCH** from the latest-group cache (§9.16 / draft-18
§10.12): standalone FETCH serves `cache ∩ [start, end)` with proper
`INVALID_RANGE` / `DOES_NOT_EXIST` rejections, and a **relative joining FETCH**
resolves its range from the joined subscription's largest cached object — the
warm-start path a Largest Object subscriber uses to get the current group's
head immediately. Largest Object subscriptions do **not** get the unconditional
cache replay (that would violate the filter, §5.1.2); the joining FETCH is the
way to backfill the current group.

```bash
# standalone relay-mode server (what the publisher example connects to):
PORT=4433 pnpm --filter @moqt/example-node-relay relay-server

# self-contained smokes:
pnpm --filter @moqt/example-node-relay relay-smoke        # 1 publisher → 2 subscribers, IDs + Properties preserved
pnpm --filter @moqt/example-node-relay relay-load-smoke   # compare 1 vs 8 downstream subgroup lanes over real QUIC
pnpm --filter @moqt/example-node-relay relay-namespace-load-smoke # compare 1 vs 8 namespaces, one publisher + subscriber each
pnpm --filter @moqt/example-node-relay relay-media-smoke  # multi-track fanout + late join + ABR cleanup
pnpm --filter @moqt/example-node-relay relay-fetch-smoke  # late viewer gets the current group via joining FETCH
```

`relay-namespace-load-smoke` runs the relay in a separate process and defaults to
10 seconds of 2 Mbps traffic at 20 groups per second for each namespace. It
requires every expected group and subgroup FIN, rejects duplicate or cross-routed
delivery and incomplete shutdown, and reports delivery lag, arrival gaps,
publisher drift, and per-namespace stalls. Duplicate observation continues for one second after all
expected FINs; configure it with `LOAD_DUPLICATE_OBSERVATION_MS`. Timing is
diagnostic rather than a pass threshold because host capacity varies. Relay CPU
and event-loop telemetry covers the child process's complete lifecycle, including setup and
teardown, rather than only the publishing interval. The workload is configurable:

```bash
LOAD_PAIRS=8 LOAD_DURATION_MS=30000 LOAD_GROUPS_PER_SECOND=20 \
LOAD_BITS_PER_SECOND=2000000 LOAD_DUPLICATE_OBSERVATION_MS=1000 \
pnpm --filter @moqt/example-node-relay relay-namespace-load-smoke
```

## Use with the publisher and browser player

See [`examples/node-publisher`](../node-publisher/README.md) for the full demo:
generate a CMAF fixture from an MP4, publish it (optionally looped) into
`relay-server`, and watch it in the browser Playa player.

## Limitations (toy relay, not production)

- **Development scale only** — intended for one publisher and a handful of
  subscribers. Independent subgroup streams are forwarded concurrently (up to
  8 per subscription); a subscription retaining more than 256 objects or 4 MiB
  of payload is treated as a slow consumer and its connection is closed rather
  than allowing latency and memory to grow without limit. This single-process
  example still runs on one Node event loop; sustained CPU saturation requires more
  capacity or a production relay. The namespace smoke measures a synthetic local
  workload, not browser playback quality or production capacity.
- **Live, latest-group cache only** — a late joiner gets the most-recent group, not
  history (no DVR, no init-segment retention policy). FETCH is served from the same
  single-group cache: ranges reaching further back truncate honestly (gaps in the
  response indicate objects that no longer exist, §9.16.3). The cache has no
  configurable byte limit.
- **Fixed track registry** — only the names above are routed; a catalog-driven
  registry is a possible follow-up.
- **Data objects and subgroup header flags** — the incoming `END_OF_GROUP` flag
  is preserved for live forwarding and cached replay. Graceful FIN is mirrored,
  so the receiver observes completion and downstream stream credit is returned.
  Viewer cancellation drops queued forwarding; the adapter resets unfinished
  streams rather than sending a misleading completion FIN.
  Explicit wire gap/status objects are still not relayed.
- **Property presence is inferred from the first object in each subgroup** — if
  properties first appear on a later object, the relay reports and drops that
  object because the outgoing subgroup header is already fixed. LOC streams that
  carry frame marking on every object do not hit this limitation.
- **No route authorization, publisher-facing flow-control coordination,
  cross-subscription fairness, reconnect/migration, or persistence.**
- The FAILS backend does not echo an application protocol, so endpoints construct
  `MoqtConnection(18)` **explicitly** (draft auto-negotiation would fall back to 16).

## Troubleshooting

- **Client handshake fails:** the pinned cert hash is stale — re-run `gen-cert` and
  use the newly printed hash.
- **`Cannot find module ...webtransport.node`:** the native addon isn't built — see
  Setup above.
- **`Lib quiche loading attempt did not end`:** the native lib loads asynchronously;
  the example entrypoints `await quicheLoaded` before constructing transports — do
  the same in your own scripts.
- **Server logs `client disconnected` (or `onClose code=3`) after a clean run:** a
  peer closing its WebTransport session ends the draft-18 control stream, which the
  still-established side reports as a §3.3 close. The examples close via
  `conn.close()` first so their own shutdown is clean; a fully graceful peer-initiated
  shutdown handshake is future core work.
