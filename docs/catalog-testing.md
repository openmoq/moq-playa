# Catalog Testing

This project includes a real-browser integration harness for validating MOQT catalog subscription over WebTransport against a live server.

The harness exercises:

- WebTransport connection setup
- MOQT `CLIENT_SETUP` / `SERVER_SETUP`
- `SUBSCRIBE` to the namespace catalog track
- Catalog JSON reception
- MSF catalog parsing
- MSF delta application
- catalogformat-01 parsing and JSON Patch delta handling
- CMSF-related catalog fields such as `packaging: "cmaf"` and SAP metadata

## Use Case

Use this when you want to verify that a relay or publisher:

- accepts WebTransport connections
- negotiates the expected MOQT draft version
- exposes a valid `catalog` track for a namespace
- publishes catalog objects as JSON
- emits catalog data compatible with the MSF and CMSF expectations used by this client

## Prerequisites

- Node.js 20+
- `pnpm`
- A Chromium-based browser with WebTransport support
- A reachable MOQT relay or publisher URL
- Optionally, the relay certificate SHA-256 hash if using a self-signed certificate

## Start The Examples App

From the repository root:

```bash
pnpm --filter @moqt/examples dev
```

Vite will print a local URL, typically:

```text
http://localhost:5173/
```

## Open The Catalog Harness

Open this path in the browser:

```text
http://localhost:5173/catalog/
```

The page includes a form for:

- relay URL
- namespace
- draft version override
- optional certificate hash

## URL Parameters

You can also prefill the harness with query parameters:

```text
/catalog/?url=https://relay.example.com/moq&ns=live/channel&v=16&hash=<sha256hex>
```

Supported parameters:

- `url`
  - Full WebTransport relay URL
- `ns`
  - Broadcast namespace
- `v`
  - Optional MOQT draft version; `14`, `16`, or `18`
- `hash`
  - Optional SHA-256 certificate hash in hex for self-signed TLS

## Typical Test Flow

1. Start the examples app with `pnpm --filter @moqt/examples dev`.
2. Open `/catalog/` in a supported browser.
3. Enter the relay URL and target namespace.
4. Enter the certificate hash if the relay is using a self-signed certificate.
5. Select the draft version only if you need to force `14`, `16`, or `18`; otherwise leave it on auto.
6. Click `Run Integration Test`.

## Expected Output

The page has three panels:

- `Protocol Log`
  - shows WebTransport connection, MOQT control messages, subscribe status, and any gaps or errors
- `Raw Catalog JSON`
  - shows each received catalog object exactly as published
- `MSF/CMSF State`
  - shows the materialized catalog state after applying independent catalogs and deltas

On success, you should see:

- WebTransport connected
- MOQT session established
- subscribed to `<namespace>/catalog`
- one or more catalog objects received
- parsed catalog state with track count

If the broadcast uses CMSF/CMAF packaging, the `MSF/CMSF State` panel will also summarize tracks with:

- `packaging=cmaf`
- codec and MIME information when present
- `initTrack` when present
- `maxGrpSapStartingType` when present
- `maxObjSapStartingType` when present

## Notes On Spec Coverage

This harness is aimed at catalog validation, not full playback.

It validates the catalog path used by this client stack:

- MOQT transport over WebTransport
- catalog track subscription using the fixed track name `catalog`
- MSF independent catalogs and delta updates
- catalogformat-01 compatibility for older servers
- CMSF extensions carried inside the catalog

It does not validate:

- decoding media objects
- rendering audio/video
- CMAF segment assembly
- end-to-end playback timing

For those paths, use the other examples such as `/video/`, `/player/`, or `/simple/`.

## Common Failures

`WebTransport is not available`

- Use a recent Chromium-based browser.

`Integration test failed: WebTransport connection failed`

- Check the relay URL.
- Check TLS and certificate trust.
- Provide `hash=` if the relay uses a self-signed certificate.

`REQUEST_ERROR`

- The server rejected the request.
- Check namespace, draft version, auth requirements, and whether the server exposes a catalog track.

`Catalog payload was JSON, but not a valid object or patch array`

- The server published invalid catalog content or the wrong track was subscribed.

`Received MSF delta catalog before the initial independent catalog`

- The publisher is violating catalog ordering expectations.

## Recommended Verification Before Committing Changes

Run:

```bash
pnpm build
```

If you changed only the examples app, at minimum run:

```bash
pnpm --filter @moqt/examples build
```

## H.264 Debug Tool

For debugging `avc1` catalog metadata and payload structure, use:

```bash
pnpm debug:h264 -- --initdata-base64 'AULAH//hABhnQsAf2QCgL7ARAAADAAEAAAMAPA8YMkgBAARoy4yy'
```

This prints the parsed AVCDecoderConfigurationRecord:

- profile / compatibility / level
- AVCC NAL length size
- SPS and PPS counts
- SPS and PPS byte lengths

To inspect an encoded sample:

```bash
pnpm debug:h264 -- --initdata-base64 '<avcc-base64>' --sample-file /path/to/sample.bin
```

Optional sample arguments:

- `--sample-base64 <base64>`
- `--sample-hex <hex>`
- `--sample-file <path>`
- `--format avcc|annexb`
- `--length-size 1|2|4`

The tool reports:

- whether the sample parses cleanly
- NAL unit count
- NAL offsets and lengths
- NAL types such as SPS, PPS, IDR, non-IDR, SEI, AUD

This is useful for checking whether:

- `initData` is valid `avcC`
- the advertised `avcC` length size matches the sample framing
- the first key sample really contains an IDR
- the publisher is emitting malformed AVCC or Annex B payloads

### Example: Red5 `video0` initData

For the catalog value:

```text
AULAH//hABhnQsAf2QCgL7ARAAADAAEAAAMAPA8YMkgBAARoy4yy
```

the tool reports:

```text
AVCDecoderConfigurationRecord
  bytes: 39
  configurationVersion: 1
  profileIndication: 0x42
  profileCompatibility: 0xc0
  levelIndication: 0x1f
  nalLengthSize: 4
  spsCount: 1
  sps[0]: 24 bytes, header=0x67, type=SPS
  ppsCount: 1
  pps[0]: 4 bytes, header=0x68, type=PPS
  trailingBytes: 0
```

Important:

- `nalLengthSize: 4` means AVCC samples use a 4-byte NAL length prefix
- it does **not** mean the SPS/PPS data is 4 bytes total
- in this example, the SPS is 24 bytes and the PPS is 4 bytes
