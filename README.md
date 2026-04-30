# Red5 Playa – Modular MOQ Player Framework for Scalable Real-Time Streaming

> **Pre-release.** The API surface is under active development and may change between minor versions. Pin to exact versions in production.

Reference implementation of **Media over QUIC Transport (MoQT)** in TypeScript — the next-generation live media streaming protocol built on WebTransport.

Full stack from WebTransport to viewport, with two integration paths:

- **`@moqt/*`** — Reference implementation toolkit: protocol, playback, browser adapters
- **`@playa/player`** — Batteries-included drop-in player built on `@moqt/*`

---

## Quick Start

### `@playa/player` — Drop-in Player

```ts
import { Player } from '@playa/player';

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

### `@moqt/player` — Protocol-Level API

```ts
import { MoqtPlayer } from '@moqt/player';
import { MoqtConnection } from '@moqt/webtransport';
import {
  createWebTransport, WebCodecsVideoDecoder, CanvasRenderer,
  WebCodecsAudioDecoder, WebAudioOutput,
} from '@moqt/browser';

const player = new MoqtPlayer({
  url: 'https://relay.example.com/moq',
  namespace: 'live/broadcast',
  draftVersion: 16,
  createTransport: createWebTransport(),
  createConnection: () => new MoqtConnection(16),
  createVideoDecoder: () => new WebCodecsVideoDecoder(),
  createRenderer: () => new CanvasRenderer(canvas),
  createAudioDecoder: () => new WebCodecsAudioDecoder(),
  createAudioOutput: () => new WebAudioOutput(),
});

player.on('catalog_received', ({ catalog }) => { /* inspect tracks */ });
player.on('first_frame', () => { /* start your UI */ });
player.on('error', ({ error }) => { /* structured error with severity + code */ });

await player.load();
player.play();
```

---

## Browser & Codec Support

| Browser | H.264 | HEVC | AV1 | MSE/CMAF |
|---------|-------|------|-----|----------|
| Chrome 120+ | ✅ | ✅ (hardware) | ✅ | ✅ |
| Firefox 120+ | ✅ | ❌ | ✅ | ✅ |
| Safari 26.4+ | ✅ | ✅ | ❌ | ✅ |
| Edge 120+ | ✅ | ✅ | ✅ | ✅ |

`VideoDecoder.isConfigSupported()` is checked before configuring each codec. When a codec is unsupported the decoder shuts down cleanly — no decode-error loops, no frozen frames.

**Decode paths:**
- **LOC (Low Overhead Container)** — WebCodecs direct path, lowest latency. H.264, HEVC, AV1.
- **CMAF (fragmented MP4)** — MSE + `<video>` path, broader compatibility.

---

## Package Structure

```
packages/
  transport/      @moqt/transport     — Sans-I/O protocol core (draft-14 + draft-16)
  webtransport/   @moqt/webtransport  — MoQT connection over WebTransport
  loc/            @moqt/loc           — Low Overhead Container (CaptureTimestamp, VideoFrameMarking)
  msf/            @moqt/msf           — MSF catalog parsing, track selection, timeline
  playback/       @moqt/playback      — Jitter buffer, A/V sync, decoder state, gap detection
  player/         @moqt/player        — Player orchestrator (connect, catalog, subscribe, decode, render)
  browser/        @moqt/browser       — Browser adapters (WebCodecs, Canvas, WebAudio, MSE)
  playa/          @playa/player       — Batteries-included player with simple API
```

### Architecture

The playback core (`@moqt/playback`) has **no browser dependencies**. It produces `DecoderCommand` and `PlaybackEvent` objects. Browser adapters (`@moqt/browser`) consume these. This separation enables testing in Node.js without WebCodecs/Canvas/WebAudio.

```
WebTransport ──► @moqt/transport ──► @moqt/player ──► @moqt/playback
                                                            │
                                              DecoderCommand│PlaybackEvent
                                                            ▼
                                               @moqt/browser (browser)
                                          WebCodecs / Canvas / WebAudio / MSE
```

---

## `@playa/player` API

```ts
const player = new Player(container, options);

// Lifecycle
await player.load();        // connect, subscribe to catalog, subscribe to tracks
player.play();              // start rendering
player.pause();             // pause rendering
await player.seek(30_000);  // seek to 30s (VOD only, requires timeline track)
player.destroy();           // tear down connection and clean up

// State
player.state          // 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'
player.currentTime    // ms
player.duration       // ms, undefined for live
player.seekable       // true when timeline track is available
player.volume         // 0–1
player.muted          // boolean
player.levels         // available video quality levels
player.audioTracks    // available audio tracks
player.currentLevel   // active level index
player.activeMediaType  // 'canvas' | 'video' — which element is rendering

// Quality (async — resolves when switch commits)
await player.setQuality(index);  // manual quality switch (disables ABR)
await player.setQuality('auto'); // re-enable ABR
player.levels;                   // available quality levels

// Events
player.on('ready',          ({ levels, audioTracks }) => { ... });
player.on('timeupdate',     ({ currentTime }) => { ... });
player.on('durationchange', ({ duration }) => { ... });
player.on('seeking',        ({ targetTime }) => { ... });
player.on('seeked',         ({ actualTime }) => { ... });
player.on('qualitychange',  ({ level }) => { ... });
player.on('stall',          ({ duration }) => { ... });
player.on('error',          ({ error }) => { ... });
player.on('statechange',    ({ from, to }) => { ... });
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | — | WebTransport relay URL |
| `namespace` | string | — | Track namespace (e.g. `live/broadcast`) |
| `draftVersion` | 14 \| 16 | 16 | MOQT draft version |
| `certHash` | ArrayBuffer | — | SHA-256 hash for self-signed certs |
| `autoplay` | boolean | false | Start playback after load |
| `volume` | number | 1 | Initial volume 0–1 |
| `muted` | boolean | false | Start muted |
| `targetLatencyMs` | number | — | Live edge target latency |
| `autoQuality` | boolean | true | Enable ABR |
| `startLevel` | number \| 'auto' \| 'lowest' | 'auto' | Initial quality level |
| `maxResolution` | `{width, height}` | — | Cap video quality |
| `canvas` | HTMLCanvasElement | — | Caller-owned canvas (framework mode) |
| `video` | HTMLVideoElement | — | Caller-owned video element (framework mode) |

---

## `@moqt/player` MoqtPlayer API

```ts
// Hooks — intercept and override decisions
player.hooks.beforeSubscribe.use(async (intent, next) => {
  if (shouldSkip(intent.trackName)) return; // cancel
  return next(intent); // or return next(modifiedIntent);
});

player.hooks.beforeQualitySwitch.use(async (intent, next) => {
  if (networkIsBad()) return; // suppress switch
  return next(intent);
});

player.hooks.onRecovery.use(async (action, next) => {
  if (action.type === 'quality_down') return; // suppress quality drop
  return next(action);
});

// Extension points
player.on('media_object', ({ mediaType, groupId, objectId, payload }) => { ... });
player.on('decoder_command', ({ command }) => { ... }); // every WebCodecs command
player.on('namespace_discovered', ({ namespaceSuffix }) => { ... });
player.on('sap_event', ({ entries }) => { ... }); // CMAF seek points
player.on('catch_up_changed', ({ active, rate, latencyMs }) => { ... });
```

### Key config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `draftVersion` | 14 \| 16 | 16 | Protocol version (14 for moq-rs / Red5 compat) |
| `maxRequestId` | number | 100 | Initial MOQT MAX_REQUEST_ID (auto-replenished) |
| `knownTracks` | object | — | Pre-known codec metadata for TTFF optimization |
| `catalog` | `{tracks}` | — | Inject catalog externally, skip catalog subscription |
| `targetLatencyMs` | number | — | Live catch-up target |
| `maxCatchUpRate` | number | 1.0 | Max playback rate for catch-up |
| `objectTransform` | function | — | Per-object transform (e.g. decryption) |
| `extensionParser` | function | — | Custom LOC extension parser |
| `onQlogEvent` | function | — | qlog event stream |
| `logLevel` | string | 'none' | Logging: 'none' \| 'error' \| 'warn' \| 'info' \| 'debug' |

---

## Protocol Support

- **draft-ietf-moq-transport-16** — default supported transport draft
- **draft-ietf-moq-transport-14** — Red5/moq-rs interop (`draftVersion: 14`)
- **draft-ietf-moq-msf-00** — Catalog, track selection, ABR (`altGroup`), timeline
- **draft-ietf-moq-loc-01** — Low Overhead Container (CaptureTimestamp, VideoFrameMarking)
- **draft-ietf-moq-cmsf-00** — CMAF Streaming Format (moof+mdat, MSE path)

### Draft version selection

Browser WebTransport may expose `transport.protocol` (e.g., `'moqt-16'`), enabling automatic draft detection. Node/polyfill WebTransport typically has `protocol` undefined — the connection defaults to **draft 16**.

For **draft-14 relays** (moq-rs, Red5, moqtail), you must explicitly specify the version:

```ts
const conn = new MoqtConnection(14); // required — CLIENT_SETUP is draft-specific
```

If you provide your own `WebTransport` instance, construct it with the appropriate `protocols` option; Playa can only auto-negotiate when using its transport factory. Some Node/polyfill transports may not support `protocols` yet.

After `publishNamespace(ns)`, wait for acceptance via `onMessage` before calling `publishNamespaceDone(requestId)`:
- **v16**: `REQUEST_OK` with the matching `requestId`
- **v14**: `PUBLISH_NAMESPACE_OK` with the matching `requestId`

Do not use a fixed sleep. If `onClose` fires before acceptance, treat the operation as failed.

### Transport robustness

- **MAX_REQUEST_ID sliding window** — auto-replenishes as subscriptions are consumed; starts at 100, extends by 1000 per window
- **Stream limit handling** — `createUnidirectionalStream()` failures caught and surfaced as non-fatal `MoqtConnectionError` (relevant to relays with WT_MAX_STREAMS limits)
- **REQUESTS_BLOCKED** — handled; peer notified via MAX_REQUEST_ID when blocked

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
| `/player/` | Full-featured player with stats overlay, quality selector, settings |
| `/simple/` | Minimal player — connect, play, done |
| `/connect/` | Protocol explorer — raw message log |
| `/catalog/` | Catalog browser |
| `/broadcast/` | Publisher example |
| `/video/` | Video-only player |

---

## Testing

```bash
# Run all tests (2400+ tests across all packages)
pnpm test

# Watch mode
pnpm test:watch

# Type check
npx tsc --noEmit -p packages/browser/tsconfig.json
```

---

## Docs

- [Catalog Testing](docs/catalog-testing.md) — Integration harness for validating catalog subscription against a live relay

---

## Related Content
- [Learn more about Playa player](https://www.red5.net/blog/consensus-on-a-moq-media-layer-player-framework/#the-playa-connection)
- [Start streaming with MOQ ](https://www.red5.net/media-over-quic-moq/)

## Author

Raymond Lucke and the Red5 Team

## License

MIT
