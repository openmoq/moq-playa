# @moqt/example-node-relay (example)

A **Node WebTransport MoQT relay demo**: Playa's sans-I/O core (`@moqt/transport`)
plus the WebTransport adapter (`@moqt/webtransport`) driving
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
`groupId`/`subgroupId`/`objectId`. It supports multiple subscriptions per viewer
connection (one alias each), a tiny latest-group cache replayed to late joiners, and
per-subscription cleanup when a viewer unsubscribes one track (ABR switch) without
closing the connection.

```bash
# standalone relay-mode server (what the publisher example connects to):
PORT=4433 pnpm --filter @moqt/example-node-relay relay-server

# self-contained smokes:
pnpm --filter @moqt/example-node-relay relay-smoke        # 1 publisher → 2 subscribers, IDs preserved
pnpm --filter @moqt/example-node-relay relay-media-smoke  # multi-track fanout + late join + ABR cleanup
```

## Use with the publisher and browser player

See [`examples/node-publisher`](../node-publisher/README.md) for the full demo:
generate a CMAF fixture from an MP4, publish it (optionally looped) into
`relay-server`, and watch it in the browser Playa player.

## Limitations (toy relay, not production)

- **Live, latest-group cache only** — a late joiner gets the most-recent group, not
  history (no DVR, no init-segment retention policy).
- **Fixed track registry** — only the names above are routed; a catalog-driven
  registry is a possible follow-up.
- **Data objects only** — gap/status objects (incl. `END_OF_GROUP`) are not relayed.
- **No route authorization, backpressure/fairness, reconnect/migration, or persistence.**
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
