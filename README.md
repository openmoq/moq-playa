# Red5 Playa – Modular MOQ Player Framework for Scalable Real-Time Streaming

> **Pre-release.** The API surface is under active development and may change between minor versions. Pin to exact versions in production.

Reference implementation of **Media over QUIC Transport (MoQT)** in TypeScript, with browser WebTransport and experimental native QUIC support for Node.js.

Full stack from transport to viewport, published under one npm scope so you
pick the integration path that fits:

- **`@openmoq/*`** — the reference-implementation building blocks: protocol core, playback, and browser adapters, composed however you need.
- **`@openmoq/playa`** — the batteries-included, drop-in browser player built on `@openmoq/*`.

The previous `@moqt/*` names and `@playa/player` are retained as compatibility
re-exports. Use the new names for new integrations; see
[package compatibility](docs/package-compatibility.md) for migration details.

---

## Quick Start

### `@openmoq/playa` — Drop-in Player

```ts
import { Player } from '@openmoq/playa';

const player = new Player(document.getElementById('container')!, {
  url: 'https://relay.example.com/moq',
  namespace: 'live/broadcast',
});

await player.load();
player.play();
```

### React / Custom DOM

```tsx
const canvasRef = useRef<HTMLCanvasElement>(null);
const videoRef = useRef<HTMLVideoElement>(null);

const player = new Player(null, {
  url: 'https://relay.example.com/moq',
  namespace: 'live/broadcast',
  canvas: canvasRef.current!,   // WebCodecs path
  video: videoRef.current!,     // MSE/CMAF fallback path
});

await player.load();
player.play();
```

When elements are supplied directly the Player never touches the DOM — no `appendChild`, no `hidden` toggling, no style mutations.

### `@openmoq/player` — Protocol-Level API

```ts
import { MoqtPlayer } from '@openmoq/player';
import { MoqtConnection } from '@openmoq/webtransport';
import {
  createWebTransport, WebCodecsVideoDecoder, CanvasRenderer,
  WebCodecsAudioDecoder, WebAudioOutput, MseMediaSource,
} from '@openmoq/browser';

// Run from a user gesture so browser audio can start.
const audioContext = new AudioContext();
await audioContext.resume();

const player = new MoqtPlayer({
  url: 'https://relay.example.com/moq',
  namespace: 'live/broadcast',
  draftVersion: 16,
  createTransport: createWebTransport({ draftVersion: 16 }),
  createConnection: () => new MoqtConnection(16),
  createVideoDecoder: () => new WebCodecsVideoDecoder(),
  createRenderer: () => new CanvasRenderer(canvas),
  createAudioDecoder: () => new WebCodecsAudioDecoder(),
  createAudioOutput: () => new WebAudioOutput(audioContext),
  createMediaSource: () => new MseMediaSource(video),
});

player.on('catalog_received', ({ catalog }) => { /* inspect tracks */ });
player.on('first_frame', () => { /* start your UI */ });
player.on('error', ({ error }) => { /* structured error with severity + code */ });

await player.load();
player.play();
```

`canvas` and `video` are application-owned elements. Close the application-owned
`AudioContext` after `await player.destroy()` when playback is no longer needed.

---

## Browser & Codec Support

Browser playback requires WebTransport in a secure context. The selected media
path also needs these APIs:

| Path | Required browser APIs |
|------|-----------------------|
| LOC or LOCMAF frame mode | WebCodecs (`VideoDecoder` / `AudioDecoder` for the selected tracks), Canvas, Web Audio |
| CMAF or LOCMAF MSE mode | Media Source Extensions and an HTML video element |

H.264, HEVC and AV1 decoding depends on the browser, OS, hardware and codec
configuration. A browser version alone is not a codec-support guarantee.
The WebCodecs adapter probes `VideoDecoder.isConfigSupported()`; MSE checks the
selected codec's MIME type. Browser autoplay policy may require a user gesture
to start audio. `Player` exposes `audioActivation: 'gesture'` and
`prepareAudio()` / `unmute()` for application-controlled activation.

**Decode paths:**
- **LOC (Low Overhead Container)** — WebCodecs direct path, lowest latency. H.264, HEVC, AV1. Parses LOC-04 and LOC-01 properties; preserves LOC-01 output unless `locVersion: 4` is selected.
- **CMAF (fragmented MP4)** — MSE + `<video>` path, broader compatibility.
- **LOCMAF (Low Overhead CMAF)** - reconstructs CMAF chunks for MSE by default,
  or extracts coded samples for WebCodecs with `locmafDecoding: 'frame'` in
  `MoqtPlayer` config (`moqtPlayerConfig` on `Player`).

---

## Package Structure

```
packages/
  transport/      @openmoq/transport     — Sans-I/O protocol core (draft-14 / -16 / -18 / -22)
  webtransport/   @openmoq/webtransport  — MoQT connection adapter and WebTransport binding
  quic/           @openmoq/quic          — Experimental native QUIC binding for Node.js (draft-18 / -22)
  loc/            @openmoq/loc           — Low Overhead Container (CaptureTimestamp, VideoFrameMarking)
  locmaf/         @openmoq/locmaf        - LOCMAF object encoding, CMAF reconstruction and coded-frame extraction
  msf/            @openmoq/msf           — MSF catalog parsing, track selection, timeline
  playback/       @openmoq/playback      — Jitter buffer, A/V sync, decoder state, gap detection
  player/         @openmoq/player        — Player orchestrator (connect, catalog, subscribe, decode, render)
  browser/        @openmoq/browser       — Browser adapters (WebCodecs, Canvas, WebAudio, MSE)
  playa/          @openmoq/playa         — Batteries-included player with simple API
```

### Architecture

The playback core (`@openmoq/playback`) has **no browser dependencies**. It produces `DecoderCommand` and `PlaybackEvent` objects. Browser adapters (`@openmoq/browser`) consume these. This separation enables testing in Node.js without WebCodecs/Canvas/WebAudio.

```
WebTransport ──────────────────────────┐
                                       ├─► @openmoq/webtransport ──► @openmoq/transport ──► @openmoq/player ──► @openmoq/playback
Native QUIC via @openmoq/quic ────────────┘
                                                            │
                                              DecoderCommand│PlaybackEvent
                                                            ▼
                                               @openmoq/browser (browser)
                                          WebCodecs / Canvas / WebAudio / MSE
```

---

## `@openmoq/playa` API

```ts
const player = new Player(container, options);

// Lifecycle
await player.load();        // connect, subscribe to catalog, subscribe to tracks
player.play();              // start rendering
player.pause();             // pause rendering
await player.seek(30_000);  // seek to 30s when a media timeline is loaded
await player.destroy();     // tear down connection and clean up

// State
player.state          // 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
player.currentTime    // ms
player.duration       // known timeline duration in ms, otherwise undefined
player.seekable       // true when media timeline entries are loaded
player.volume         // 0–1
player.muted          // boolean
player.levels         // available video quality levels
player.videoGroups    // catalog video altGroups, each with its track metadata
player.audioTracks    // available audio tracks
player.currentLevel   // active level index
player.activeMediaType  // 'canvas' | 'video' | null (before track selection)

// Quality (async — resolves when switch commits)
await player.setQuality(index);  // manual quality switch (disables ABR)
await player.setQuality('auto'); // re-enable ABR
player.levels;                   // available quality levels

// Events
player.on('ready',          ({ levels, audioTracks }) => console.log(levels, audioTracks));
player.on('timeupdate',     ({ currentTime }) => console.log(currentTime));
player.on('durationchange', ({ duration }) => console.log(duration));
player.on('seeking',        ({ targetTime }) => console.log(targetTime));
player.on('seeked',         ({ currentTime }) => console.log(currentTime));
player.on('qualitychange',  ({ level, auto }) => console.log(level, auto));
player.on('stall',          ({ durationMs }) => console.log(durationMs));
player.on('error',          ({ severity, code, message }) => console.error(severity, code, message));
player.on('statechange',    ({ state }) => console.log(state));
```

Register event listeners before `load()` to observe startup events. The lifecycle,
state and event lines above illustrate separate API calls, not a playback script.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | — | WebTransport relay URL |
| `namespace` | string | — | Track namespace (e.g. `live/broadcast`) |
| `draftVersion` | 14 \| 16 \| 18 \| 22 | 16 | MOQT draft version |
| `certHash` | ArrayBuffer | — | SHA-256 hash for self-signed certs |
| `authorization` | credential provider | — | Opt-in CAT4MOQ token acquisition; see [authorization](docs/authorization.md) |
| `autoplay` | boolean | false | Start playback after load |
| `volume` | number | 1 | Initial volume 0–1 |
| `muted` | boolean | false | Start muted |
| `audioActivation` | 'auto' \| 'gesture' | 'auto' | Defer Web Audio activation until a user gesture when set to 'gesture' |
| `targetLatencyMs` | number | — | Live edge target latency |
| `autoQuality` | boolean | true | Enable ABR |
| `startLevel` | number \| 'auto' \| 'lowest' | 'auto' | Initial quality level |
| `videoAltGroup` | number | first video group | Initial video view; quality and ABR stay within it |
| `maxResolution` | `{width, height}` | — | Cap video quality |
| `canvas` | HTMLCanvasElement | — | Caller-owned canvas (framework mode) |
| `video` | HTMLVideoElement | — | Caller-owned video element (framework mode) |
| `moqtPlayerConfig` | `Partial<MoqtPlayerConfig>` | — | Advanced overrides, including `locmafDecoding` and `catalogBootstrap` |

### Video Views

A catalog can carry separate video views, such as landscape and portrait, in
different `altGroup`s. Set `videoAltGroup` on `Player` or `MoqtPlayer` to choose
one at tune-in. Group `0` is valid; an unknown group fails rather than falling
back to different content. Omission retains first-group selection.

```ts
const portrait = new Player(container, {
  url: relayUrl,
  namespace: 'live/stream',
  videoAltGroup: 0,
});
await portrait.load();
portrait.play();
```

`levels` and automatic quality selection only contain alternatives from that
view. `videoGroups` (`availableVideoGroups` on `MoqtPlayer`) lists the catalog's
supported video groups. Multiple players can select different groups independently.
To change views, destroy the old player and create another with the desired
group. `setQuality`/`selectVideoTrack` are quality switches within a view, not
cross-view timeline mappings: different groups need not share timestamps or
Group IDs. The player example's View selector stops and creates a fresh player
for the requested group; `?altGroup=0` selects its initial view. Stop also cancels
an in-progress retune. `videoAltGroup` cannot be combined with the catalog-free
`knownTracks` fast path when video is enabled.

---

## `@openmoq/player` MoqtPlayer API

```ts
// Hooks run synchronously: return the intent to proceed, or null to cancel.
player.hooks.beforeSubscribe.add((intent) => {
  if (shouldSkip(intent.trackName)) return null;
  return intent;
});

player.hooks.beforeQualitySwitch.add((intent) => {
  if (networkIsBad()) return null;
  return intent;
});

player.hooks.onRecovery.add((action) => {
  if (action.type === 'reduce_quality') return null;
  return action;
});

// Extension points
player.on('media_object', ({ mediaType, groupId, objectId, payload }) => console.log(mediaType, groupId, objectId, payload));
player.on('decoder_command', ({ command }) => console.log(command));
player.on('namespace_discovered', ({ namespaceSuffix }) => console.log(namespaceSuffix));
player.on('sap_event', ({ entries }) => console.log(entries));
player.on('catch_up_changed', ({ active, rate, latencyMs }) => console.log(active, rate, latencyMs));
```

`shouldSkip` and `networkIsBad` are application policy functions. Remove a hook
with `.remove(theSameFunction)`. `MoqtPlayer` errors carry a structured `error`
object; the higher-level `Player` instead emits `severity`, `code` and `message`.

### Key config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `draftVersion` | 14 \| 16 \| 18 \| 22 | 16 | Protocol version; select the draft supported by your relay |
| `maxRequestId` | number | 10,000 | Initial MOQT MAX_REQUEST_ID on legacy drafts (auto-replenished) |
| `knownTracks` | object | — | Pre-known codec metadata for TTFF optimization |
| `catalog` | `{tracks}` | — | Inject catalog externally, skip catalog subscription |
| `targetLatencyMs` | number | — | Live catch-up target |
| `maxCatchUpRate` | number | 1.0 | Max playback rate for catch-up |
| `authority` | string | — | CLIENT_SETUP AUTHORITY for tenant-routed relays (interop override; spec prohibits it over WebTransport) |
| `warmStartCurrentGroup` | boolean | false | Join live LOC tracks mid-group via Joining FETCH on drafts 14/16/18, or a fill on draft 22; non-fatal if refused |
| `catalogBootstrap` | 'auto' \| 'joining-fetch' \| 'strict' \| 'subscribe' | 'auto' | Catalog bootstrap policy; draft 22 uses fills rather than Joining FETCH |
| `locmafDecoding` | 'mse' \| 'frame' | 'mse' | Reconstruct CMAF for MSE or decode LOCMAF samples through WebCodecs |
| `authorization` | credential provider | — | Opt-in token acquisition for SETUP and authorized requests |
| `objectTransform` | function | — | Per-object transform (e.g. decryption) |
| `extensionParser` | function | — | Custom LOC extension parser |
| `onQlogEvent` | function | — | qlog event stream |
| `logLevel` | string | 'none' | Logging: 'none' \| 'error' \| 'warn' \| 'info' \| 'debug' |

---

## Protocol Support

- **draft-ietf-moq-transport-22** - opt-in (`draftVersion: 22` / `moqt-22`)
- **draft-ietf-moq-transport-18** — uni control-stream pair + per-request bidi streams (`draftVersion: 18` / `moqt-18`)
- **draft-ietf-moq-transport-16** — default supported transport draft
- **draft-ietf-moq-transport-14** — Red5/moq-rs interop (`draftVersion: 14`)
- **draft-ietf-moq-msf-00** — Catalog, track selection, ABR (`altGroup`), timeline
- **draft-ietf-moq-msf-01** - Independent catalogs, op-array deltas and referenced initialization data; catalog bootstrap uses Joining FETCH on drafts 14/16/18 and fills on draft 22
- **draft-ietf-moq-loc-04** — Low Overhead Container (Timestamp + Timescale, Video Frame Marking, Audio Config); `locVersion: 4` to emit
- **draft-ietf-moq-loc-01** — Low Overhead Container (CaptureTimestamp, VideoFrameMarking); auto-detected on parse, default on encode
- **draft-ietf-moq-cmsf-00** — CMAF Streaming Format (moof+mdat, MSE path)
- **draft-ietf-moq-cmsf-01** - CMAF catalogs with MSF-01 initialization references and SAP event timelines
- **draft-einarsson-moq-locmaf-01** - LOCMAF object reconstruction, MSE and coded-frame interfaces, including event-only tracks

CAT4MOQ bearer-token carriage is opt-in, not required for anonymous playback or
broadcast. The application obtains credentials; the relay enforces permissions.
DPoP signing is not built in. See [authorization](docs/authorization.md) for the
supported profiles and security boundaries.

### Draft version selection

LOC and transport versions are independent. The broadcast example explicitly
selects LOC-04; `?loc=1` selects LOC-01. Library encoding remains LOC-01 by
default. A LOC-04 Timescale makes timestamps media-relative; conversion to
LOC-01 requires an application-provided wall-clock anchor, not just unit scaling.
LOC support here covers public properties and clear payloads. Secure Objects,
encrypted/private properties, and automatic transport track-property delivery
are not implemented. Callers with track-scoped defaults can pass `track` to
`parseLocHeaders()`.

Browser WebTransport may expose `transport.protocol`, enabling automatic draft detection from the negotiated `WT-Available-Protocols`:

- `moqt-22` → draft 22
- `moqt-18` → draft 18
- `moqt-16` → draft 16
- `moq-00` → draft 14

Without an explicit draft, a recognized `transport.protocol` selects the wire
codec; otherwise the adapter defaults to draft 16. An explicit
`new MoqtConnection(18)` selects draft 18. Keep that choice and the transport
factory's `draftVersion` aligned. The browser factory offers `["moqt-16"]` by
default, not every supported draft. Opt into 18 or 22 explicitly (or use
`?v=18` / `?v=22` in the examples). Draft 22 requires a readable negotiated
`moqt-22` protocol and does not retry without the protocol offer.

draft-18 is an architectural change, not just a wire bump: the control stream becomes a **unidirectional pair**, each request rides its **own bidirectional stream** (responses correlate by stream, not Request ID), and integers use the full-uint64 `vi64` encoding.

For **draft-14 relays** (moq-rs, Red5, moqtail), you must explicitly specify the version:

```ts
const conn = new MoqtConnection(14); // required — CLIENT_SETUP is draft-specific
```

`MoqtConnection` auto-detects the draft from **any** `WebTransportLike` whose `protocol` exposes a supported token (`moqt-22`, `moqt-18`, `moqt-16`, or `moq-00`) — there's nothing factory-specific about detection. The browser transport factory is just the convenience that sets the WebTransport `protocols` offer for you. If you construct your own `WebTransport`, pass the appropriate `protocols` option yourself and make sure `transport.protocol` is readable; Playa reads it the same way. Some Node/polyfill transports may not support `protocols` yet.

Node applications can use the experimental native QUIC binding for drafts 18
and 22. Draft 18 is the default:

```ts
import { connectQuic } from '@openmoq/quic';
import { MoqtConnection } from '@openmoq/webtransport';

const transport = await connectQuic('moqt://relay.example.com:443/moq');
const connection = new MoqtConnection(18);
await connection.connect(transport);
```

`@openmoq/quic` requires Node >=26.8.1 built with QUIC support and launched with
`--experimental-quic`. It offers `moqt-18` by default, or `moqt-22` with
`{ draft: 22 }`, requires QUIC
DATAGRAM negotiation, disables 0-RTT, and does not fall back to WebTransport.

#### draft 22

Draft 22 (`new MoqtConnection(22)`, `draftVersion: 22`, ALPN/WT protocol `moqt-22`) keeps the draft-18 stream model and adds the features below. It replaces the experimental draft-21 implementation. LOCATION_FILTER now starts with a type (0x00-0x05) selecting its fields, rather than a length. Some encodings coincide, but the two drafts are not wire-compatible.

- **Location filters.** SUBSCRIBE and FETCH carry their range in LOCATION_FILTER. `SubscriptionFilter` gains `RelativeStart` (`groups: N` starts at group Largest + 1 - N, so 1 is the current group) and an optional inclusive `endObject` on `AbsoluteRange`.
- **Fills instead of Joining FETCH.** Draft 22 has no Joining FETCH. `subscribe()` / `subscribeTrack()` take `fill: { filter?: SubscriptionFilter, groupOrder?: GroupOrder }`. Omitted fields inherit the subscription policy. The fill is bounded by the Largest Location in its response; Forward=0 or an empty range opens no fill stream. Its FETCH_HEADER carries the SUBSCRIBE's or REQUEST_UPDATE's Request ID. There is no FETCH_OK: FIN completes the fill and reset fails it. `cancelFill(requestId)` stops a fill without cancelling live delivery; passing the subscription ID stops all of its fills. The publisher uses `openFillStream(requestId)` to serve it.
- **Player.** The MSF-01 catalog bootstrap and warm start ask for the current group as a fill (`RelativeStart` with `groups: 1`). A SUBSCRIBE_OK without a Largest Object means an empty track, so the player waits for the first live catalog object and does not expect a fill.
- **Other changes.** PUBLISH_STATE_NOTIFY on the subscription stream advances the Largest Location. GOAWAY has no Request ID. The End of Timed-Out Range fetch marker (`0x20C`) is accepted. PUBLISH_DONE `0x3` no longer exists.

- **REQUEST_UPDATE.** `requestUpdate()` also takes `fill`; that fill stream carries the update's Request ID. `SetupOptions.maxRequestUpdates` advertises MAX_REQUEST_UPDATES. Updates never exceed the peer's limit, and a peer that exceeds ours closes the session with TOO_MANY_REQUEST_UPDATES.
- **Several subscriptions to one track.** Draft 22 allows them, and a publisher may give them one Track Alias. Each subscription's filter controls delivery. Ending one leaves the others running. Publisher calls to `openSubgroup()` and `sendDatagram()` must supply `requestId` when the alias has several active owners, so cancellation and terminal stream counts remain attributable to the right request.
- **Native QUIC.** `connectQuic(uri, { draft: 22 })` offers `moqt-22`.

Range Filters beyond LOCATION_FILTER are not implemented. The endpoint advertises
the default MAX_FILTER_RANGES=0 and rejects requests that exceed it with
INVALID_FILTER rather than ignoring the filter.

Draft 22 does not change the default version or the framing of drafts 14/16/18.
See [draft development](docs/draft-development.md) for compatibility policy and
the unresolved FETCH End-of-Range framing question.

#### draft-18 known gaps (non-blocking)

draft-18 support is functional for the subscriber and publisher paths. The deliberately deferred edges are documented as intentional gaps rather than silently dropped:

- **Redirect** (`REQUEST_ERROR` code `0x34`) is decoded, context-validated, and surfaced — but automatic redirect-follow is **not** implemented; the application decides whether to reconnect.
- **GOAWAY** (§10.4) is handled in both forms. On the **control stream** it transitions the session to `DRAINING` (no new local requests). On a **request stream** it is parsed and handled as a per-request **migration** signal — never FIFO-matched as a response and never a session close: the affected request is settled (a pending `subscribeTrack()` rejects with a non-fatal `MoqtConnectionError`) and the GOAWAY is surfaced via `onMessage`. Automatic re-issue/reconnect of that request is **not** implemented; it remains application policy.
- **`PUBLISH_OK` (`0x1E`)** is intentionally **rejected** on draft-18: the changelog defines `PUBLISH_OK` as a `REQUEST_OK` alias and removed the standalone message, so draft-18 has no `0x1E` control type (the value is a data-stream type) despite a stale registry table entry. Peers that emit a literal `0x1E` control message are non-conformant; respond with `REQUEST_OK`.

Inbound **Track Namespace / Full Track Name** fields are validated per §2.4.1 (0–32 namespace fields, each non-empty; an empty namespace is permitted; Track Namespace and Full Track Name each ≤ 4096 bytes). A violation closes the session with `PROTOCOL_VIOLATION`, enforced both at the wire codec (decode/encode) and defensively in the session before any request/alias state is created.

Track Properties (§2.5) are fully wired in both directions: received on `SUBSCRIBE_OK` / `FETCH_OK` / `TRACK_STATUS_OK` / `PUBLISH`, and sent via the `trackProperties` option on `acceptSubscribe()`, `acceptFetch()`, `acceptTrackStatus()`, and `publish()`. (The send API is draft-18-only; supplying non-empty Track Properties on draft-14/16 throws.)

`REQUEST_UPDATE` is supported on the request streams that allow it: `SUBSCRIBE` and outbound `PUBLISH` (subscription updates), and `SUBSCRIBE_NAMESPACE` / `SUBSCRIBE_TRACKS` (§10.9.2 Track Namespace Prefix updates, with per-type prefix-overlap enforcement). It is **not** valid on a one-shot `TRACK_STATUS` stream.

After `publishNamespace(ns)`, wait for acceptance via `onMessage` before calling `publishNamespaceDone(requestId)`:
- **v18**: `REQUEST_OK` on the PUBLISH_NAMESPACE request stream. The advertisement is persistent: `publishNamespaceDone(requestId)` withdraws it by closing/resetting that request stream — it does **not** emit a `PUBLISH_NAMESPACE_DONE` message (that message was removed in draft-18).
- **v16**: `REQUEST_OK` with the matching `requestId`. `publishNamespaceDone(requestId)` emits `PUBLISH_NAMESPACE_DONE` on the control stream.
- **v14**: `PUBLISH_NAMESPACE_OK` with the matching `requestId`. `publishNamespaceDone(requestId)` emits `PUBLISH_NAMESPACE_DONE` on the control stream.

Do not use a fixed sleep. If `onClose` fires before acceptance, treat the operation as failed.

### Transport robustness

- **Legacy MAX_REQUEST_ID sliding window** - the player advertises 10,000 initially and replenishes credit in increments of 1,000. Drafts 18/22 use QUIC request-stream limits instead.
- **Stream limit handling** — `createUnidirectionalStream()` failures caught and surfaced as non-fatal `MoqtConnectionError` (relevant to relays with WT_MAX_STREAMS limits)
- **Legacy REQUESTS_BLOCKED** - peer notified via MAX_REQUEST_ID when blocked

---

## Running the Examples

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start the dev server (examples at http://localhost:5173)
cd examples && npx vite dev
```

Example pages:

| Path | Description |
|------|-------------|
| `/player/` | Player with stats, video-view and quality selectors, and settings |
| `/simple/` | Minimal player — connect, play, done |
| `/connect/` | Protocol explorer — raw message log |
| `/catalog/` | Catalog browser |
| `/broadcast/` | Camera/screen publisher example with opt-in CAT4MOQ |
| `/video/` | Video-only player |

The `/player/` page takes URL parameters: `?url=` (relay), `?ns=` / `?nsField=`
(namespace), `?hash=` (cert hash), `?v=14|16|18|22` (draft), `?authority=`
(tenant-routed relays), `?warmStart=1` (join live LOC tracks mid-group via
Joining FETCH or draft-22 fills; needs `isLive: true` in the catalog and relay
support; degrades to a normal live join otherwise), `?log=info|debug`
(player logs on the console), `?catalog=<base64 JSON>` (inject a catalog),
`?fetchCatalog=1` (FETCH the catalog before injecting it into the player),
`?catalogBootstrap=auto|joining-fetch|strict|subscribe` (bootstrap policy),
`?altGroup=0` (initial video view), and `?locmaf=mse|frame` (LOCMAF decode path).

`?url=` is the complete WebTransport endpoint, including its deployment-specific
path. For example, use `?url=https%3A%2F%2Frelay.example.com%3A4433%2Fmoq-relay`
when a relay is mounted at `/moq-relay`. When omitted, the browser examples
discover the endpoint by probing `https://<page-host>:4433` at `/moq`,
`/moq-relay`, then `/` and selecting the first successful path in that order.
`/moq` and `/moq-relay` are deployment conventions, not
MOQT-standard paths (a relay that accepts any path simply matches on `/moq`).
Discovery is a convenience for these examples: a deployed application knows its
relay endpoint and should configure the complete URL.

---

## Testing

```bash
# Run unit, loopback, codec-property and scenario tests
pnpm test

# Watch mode
pnpm test:watch

# Typecheck test sources
pnpm typecheck:tests

# Check published exports and legacy compatibility wrappers (build first)
pnpm build
pnpm smoke:exports

# Browser playback acceptance (requires ffmpeg and installed Google Chrome)
pnpm test:player:browser
```

Browser acceptance runs against a private local WebTransport relay with generated
media. It checks moving video, browser audio-output samples, quality/view
selection, LOC timing domains, mixed packaging, and both LOCMAF paths. Frozen
picture and missing-audio controls must be detected as failures. JSON evidence,
screenshots and logs are written under `reports/player-acceptance/`; this does
not claim physical-speaker output or interoperability with every remote relay.
Set `PLAYER_TEST_BROWSER=chromium` to use an installed Playwright Chromium build
instead of Google Chrome.

---

## Docs

- [Simulation](docs/simulation.md) — Deterministic protocol-confidence harness (golden vectors, codec property tests, seeded scenario runner) for MoQT drafts 14/16/18
- [Catalog Testing](docs/catalog-testing.md) — Integration harness for validating catalog subscription against a live relay
- [Authorization](docs/authorization.md) — CAT4MOQ credential providers for players and connections
- [Package Compatibility](docs/package-compatibility.md) - Legacy package re-exports and release ordering
- [Draft Development](docs/draft-development.md) - Draft-22 support and compatibility policy
- [Playout Trace](docs/playout-trace.md) - Bounded qlog recorder, event design and instrumentation status

---

## Related Content
- [Learn more about Playa player](https://www.red5.net/blog/consensus-on-a-moq-media-layer-player-framework/#the-playa-connection)
- [Start streaming with MOQ ](https://www.red5.net/media-over-quic-moq/)

## Author

Raymond Lucke and the Red5 Team

## License

Apache 2.0
