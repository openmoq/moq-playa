# Playa DevTools extension

A Chrome DevTools panel that observes a Playa instance on the inspected page
(**Attach**) or dials a relay on its own through the backend's probe runner
(**Probe**). This directory is the extension only; the diagnostic protocol
(`@openmoq/devtools-protocol`), the page bridge, capture and player adapter
(`@openmoq/devtools`, `@openmoq/devtools/player`) and the probe runner
(`@openmoq/devtools-probe`) are backend packages and are not here.

**Status: attachment, Record, owner-local Probe and LIVE PLAYER observation are built and gated.** A real `@openmoq/playa` player with `installPlayerDiagnostics` + `installDiagnosticBridge` is observed end to end by `pnpm test:browser:live` (CMAF, LOCMAF-MSE and genuine LOC/canvas arms) and `pnpm test:browser:live:production`: sessions, requests, exact object cells, FIN-derived group bounds, rVFC/engine progress, recording read-back and detach. MEDIA STAGES are measured on both packagings: CMAF-MSE reports `reconstructed` (assembler output) and `appended` (SourceBuffer success with the MSE `update` witness) on the object's own delivery id; LOC reports `decoded` (actual decoder output), `scheduled` (renderer/audio admission) and, for video only, `presented` (the renderer's own draw witness) — audio presentation is not observable and is never inferred; every drop is a named `discarded` reason from the shared list in `@openmoq/devtools` PLAYER.md. MSE never claims decode or presentation from an append. The DevTools document (`src/owner.js` → `dist/devtools.js`) runs the attach flow as one attempt at a time with immutable origin intent, re-checked after every await and cancelled by navigation, user disconnect or DevTools close; it owns the relay Port and the carrier credit loop (`src/host-core.ts`, a pure state machine: one exchange outstanding, each receipt echoed once, every frame correlated to its exchange before it is adopted or forwarded, owner timeout that relinquishes the channel). `src/relay.js` is injected into the inspected top frame's isolated world only after the user grants that origin from the panel's Attach click; it validates outer carrier shape, direction and one-reply-per-exchange credit and forwards inner frames untouched. The panel is a view over an authenticated, per-view-bounded runtime port. Gates: `pnpm test` (unit), `pnpm test:owner` (built owner + relay in node:vm), `pnpm test:readiness` and `pnpm test:trace` (helper tests with controlled inputs), `pnpm test:browser` / `test:browser:negative` / `test:browser:slow-frontend` (renderer in a real DevTools tab), `pnpm test:browser:tab` (attachment, Record, Probe negative controls, quarantine), `pnpm test:browser:probe` (Probe object gate + moved-start control), `pnpm test:browser:live` / `live:production`. The real-tab gates use a labelled TEST BUILD that pre-declares the loopback origin — the native permission prompt is a manual check. What the panel shows live is exactly what a page's `DiagnosticCapture` emits.

- `src/adapter.ts` — `ProtocolSource`, the default. It consumes **decoded**
  `@openmoq/devtools-protocol` messages (hello, snapshot, batch), follows the
  protocol's own cursor rules (`refreshCursor`, `advanceCursor`), and keeps
  everything it retains inside explicit, validated `Budgets` — a total bound
  on every fact kind, evicted in observation order — so a peer-chosen
  identifier never sizes an allocation. Panel eviction is disclosed apart
  from source loss. In a real DevTools window it is fed by the owner over the
  view port once attached to a page that installs the diagnostic bridge
  (page lane: the first Attach click grants the origin; a granted origin then
  attaches by itself whenever the panel is open on it, selecting the only
  exposed source, until the user presses Detach) or once the user starts an
  owner-local Probe (probe lane). Record is
  offered on sources that declare the `recording` capability; the Probe strip
  dials only on an explicit Start.
- `src/mock-source.js` — `MockSource`, an explicit preview (`?source=mock`)
  porting the mockup's generator for layout work. The header says
  `MOCK DATA` and the title says `Playa · MOCK` while it is in use. It
  observes no page and opens no connection. The Probe strip's Subscribe is
  disabled in both.

The layout follows the `Playa DevTools Tab` mockup with the corrections agreed
in review: `subprotocol` (WebTransport) not `alpn`; `max_req_id` is
`not applicable` on drafts 18 and 22; `setup duration`, not RTT; a per-group
**observed count** with any terminal bound shown as its own fact, never an
invented denominator; **arrival offset** bands instead of "late"; the latency
chart `unavailable` with the source's stated reason; sparklines are the
retained sample history of one series (same session, track and metric),
bounded by the `sparkSamples` budget, scaled to that series' own peak and
labelled with the sample count and peak — never interpolated; "independent / expected"
instead of "keyframe"; FIN and reset are stream facts; accounted delivery
drops and source evictions are displayed as diagnostics loss, never as
missing media; unknown fact kinds are counted and never drawn; a source's
own `source_state: ended` (protocol minor 1) is shown as "diagnostic capture
ended" with its reason, leaving the last observed session state in place and
implying no transport close.

## Layout

| Path | Role |
| --- | --- |
| `static/manifest.json` | MV3: `devtools_page`, `permissions: ["scripting"]`, `optional_host_permissions` for http/https (requested per origin from the panel's Attach click), no service worker, no `tabs`, no declared content scripts, default CSP. Automation discovers the extension id through browser-level CDP target discovery. |
| `static/devtools.html` + `src/owner.js` → `dist/devtools.js` | The DevTools document, the OWNER. Mints a fresh owner id per DevTools window (never derived from the tab), registers the panel, runs the one-attempt attach flow (capability check, constant `location.origin` read, permission check, `tabs.get` origin verification, `scripting.executeScript` into `frameIds: [0]`, `tabs.connect` by `documentId`), owns the relay Port and the carrier credit loop, and serves the panel over an authenticated, per-view-bounded `view:<ownerId>` port. |
| `src/host-core.ts` | The pure owner-side carrier state machine: one exchange outstanding, each receipt echoed once, strict correlation of every frame to its exchange and lease, protocol violations close the carrier, owner timeout relinquishes the channel. |
| `src/relay.js` → `dist/relay.js` | The content relay, injected into the inspected top frame's isolated world after the grant. Creates the MessageChannel, transfers one end with the owner's `discover`, validates outer carrier shape/direction/one-reply credit, forwards inner frames untouched, closes explicitly. |
| `static/panel.{html,css}` + `src/panel.js` | The Playa tab, a VIEW. Paints a view model, forwards panel-local actions, sends host actions (Attach/Detach/Reconnect, source pick, instance switch, resnapshot refresh) to the owner, acknowledges every owner message by category, and renders the host states (not attached, attaching, connected, attached, source withdrawn, carrier closed, carrier lost, owner lost) beside the adapter's capture-ended notice. `?source=mock` is the explicit preview. |
| `src/adapter.ts` | Protocol → view model. MOQT identities stay decimal strings (BigInt for ordering); the grid is a bounded window over sparse ids; alias bindings are session-scoped and never override explicit track identity; panel eviction is disclosed separately from source loss. Overlapping connections are kept apart on screen: when retained requests come from more than one session each request row names its session, when a track's groups come from more than one (session, alias) each row and the selected object name theirs, and the session header names the session it describes. |
| `src/adapter.test.ts`, `src/adapter-boundaries.test.ts`, `src/adapter-retention.test.ts` | The adapter against the protocol package's fixtures through `encodeMessage`/`decodeMessage`; the boundary suite (allocation, isolation, snapshot refresh, counts, metrics, disposal); and total retention (validated budgets for every fact kind, observation-order eviction, scoped metrics, source-scoped run identity, uint64 window bounds). |

## Build, test, load

From a clean checkout, first install and build the extension's workspace dependencies:

```
# repository root
pnpm install --frozen-lockfile
pnpm --filter playa-devtools-extension... build
cd tools/devtools-extension
```

The commands below run from `tools/devtools-extension`. Its local `build` bundles
the extension only; it does not build missing backend package exports.

```
pnpm build                 # copies static/ and bundles panel.js (esm), owner.js → devtools.js and relay.js (classic) into dist/
pnpm test                  # root vitest config, scoped to this directory (adapter, host-core, gate verdict)
pnpm test:owner            # built owner + relay in node:vm with controlled chrome APIs (attempt ownership, hop auth, hop bounds)
pnpm test:readiness        # the DevTools-frontend readiness helper against a fake frontend and a controlled clock (late success refused)
pnpm test:object-wait      # Probe object/cell deadline judged when the sample read returns
pnpm test:trace            # the recording parser: marker + one JSON value per observation, stage correlation per (deliveryId, unitId), track-aware, with negative controls
pnpm test:element-metrics  # the explicit media-element metric list the canvas arm must not see (engine counters sharing the video_ prefix are not element metrics)
pnpm test:browser          # renderer gate: the built dist inside a REAL DevTools window with synthetic frames (see below)
pnpm test:browser:negative # the renderer gate against a mutated copy; exits 0 only when exactly the intended regression is detected
pnpm test:browser:slow-frontend # the renderer gate with the DevTools host CPU throttled 20x from attach; passes only if the frontend was pending on arrival
pnpm test:browser:tab      # the real-tab attachment gate against a page installing the built page bridge (see below)
pnpm test:browser:probe    # the Probe OBJECT gate: toy relay + synthetic publisher on loopback, pinned cert, real objects through the Probe lane
pnpm test:typecheck:live   # the live page is a typed consumer of the public packages (built declarations)
pnpm test:browser:live     # the LIVE PLAYER gate: a real Playa player with explicitly installed diagnostics; arms cmaf, locmaf-mse, loc; recording read back
pnpm test:browser:live:production   # ONE minified production-built CMAF arm (vite build of the same page, exposure 'production')
```

### Browser gate

`test/real-panel.mjs` loads the built `dist/` into a fresh headed Chrome for
Testing profile (the root workspace's Playwright; run
`pnpm exec playwright install chromium` once), opens DevTools on a `data:`
page with no Playa and no relay traffic, finds the real DevTools host over
browser-level CDP, asks its `InspectorView` to show the registered Playa
panel, attaches to the actual panel iframe, pushes synthetic fixtures through
the real codec and asserts DOM row widths `[4,1] → [4,2]`, then screenshots
the DevTools window. It then adds a row whose window holds the full 256 ids at
the top of the uint64 domain plus a long exact track label, undocks DevTools
through its own `DockController` (a real dock state, not emulation) and sizes
the DevTools window into the three breakpoint regions (about 1200, 800 and
550 CSS px; the window-chrome inset is derived once and the actual panel
`innerWidth` is recorded). At each width the group/object grid must intersect
the viewport at `scrollTop 0`, a real click must select a cell and leave the
selected-object details reachable, the document must not overflow
horizontally, no cell may collapse below `--cellMin`, every 256-column row
must scroll inside itself, and in the single-column region the order must be
grid → metadata → charts. One screenshot is saved per width
(`actual-devtools-1200.png`, `-800.png`, `-550.png`) for visual review.
Before the width passes it applies a snapshot with a second session reusing
the same request id, alias and group, and checks the DOM itself: each request
row names its owning session, both `g 2` rows name session and alias while
keeping distinct cell keys, and the session header names the displayed
session; then the base snapshot is restored. It refuses a manifest with a background owner, hashes the
copied build into `report.json`, and exits nonzero on a missing host/panel,
a codec or renderer error, a missing paint or wrong growth. It needs a
display: headed Chromium, so Xvfb on Linux CI. The DevTools frontend internals
it touches are test-only; when they change, the gate fails visibly rather than
degrading to an extension-page check.

The verdict is a pure helper, `src/gate-verdict.mjs`, with its own tests.
A positive run passes only with the right DOM growth **and zero**
`Runtime.exceptionThrown` / `console.error` events on the panel (listeners are
registered before `Runtime.enable`; errors are counted beyond the bound on
stored text). Harness failures — launch, missing host or panel, timeouts,
missing mutation anchors — fail in every mode.

Discriminators, each applied to the **temporary copy only** (the shipping
`dist/` and the tree are never modified):

- `--mutate-row-cache` reverts the renderer's per-row node cache to the
  widest-row count. It passes only if *that* failure occurs at the narrow-row
  append after a correct `[4,1]` setup; an unrelated fatal does not satisfy it.
- `--control=missing-registration` empties `devtools.js` so no panel
  registers. It must fail in both modes.
- `--control=async-error` wraps `applyEncoded` to throw asynchronously after
  a correct render. It must fail the positive run, and it also disqualifies
  the negative one: the negative passes only on the intended failure with no
  other panel exceptions.

This gate proves codec + adapter + renderer in the real tab with SYNTHETIC
observations pushed straight into the panel. Live messaging is the next gate.

### Real-tab attachment gate

`test/real-tab.mjs` loads a labelled TEST BUILD of `dist/` (manifest
pre-declares `http://127.0.0.1/*` so `permissions.contains` is true without
the native prompt) and two loopback origins serving a page that installs
`DiagnosticRegistry` + two `DiagnosticCapture`s + `installDiagnosticBridge`
from the BUILT backend packages. With real `Input` clicks it proves: owner and
panel identity matching; automatic attachment of the pre-granted origin as soon
as the panel is open (one injection, both sources discovered, nothing selected
because there are two, capture inert, compact one-row pick cards whose attach
label has no button background), and that a user Detach keeps the origin
detached; a denial control (an API wrapper returning `false`, not the native
prompt); the fresh-owner injection race (the re-arming Attach held,
same-origin replacement, the cancelled attempt released → zero connects, the
replacement document's own automatic attempt released → discovered); discovery
without activating capture; attach with batches applied and painted; instance
switch holding one lease at a time; the Probe negative control (owner-local dial
to a closed loopback port fails with its own facts, mode switch is view-only); Record start/stop/export/download against
a real `TraceRecorder` installed through the registry hook, another owner's
active recording shown and released, cleanup on detach; panel reload receiving hello + a baseline
without a new lease; actual resnapshot recovery after one dropped owner→view
batch; user detach releasing the page lease and turning the indicator off;
the injection race after an attachment across two granted origins; fresh
attach on the second origin; a held stale frame replayed after a new
generation applying nothing; the view losing its owner port. The verdict is
computed after browser shutdown from the total error count; the report carries
the extension and backend hashes.

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked. Open
DevTools on any page; the **Playa** tab appears. For automation use
Playwright's Chromium with `launchPersistentContext` and `--load-extension`;
branded Chrome ≥137 no longer honours that flag.

### Mandatory gates

The `devtools-browser` CI job (`.github/workflows/ci.yml`) builds the Probe,
extension, publisher and relay graph, checks the native WebTransport backend
loads, typechecks the live-page consumers, runs the five helper suites
(frontend readiness, Probe object wait, parsed traces, element metrics, fact counter), the owner
and relay boundary checks, the page-bridge MessageChannel gate, the renderer
gate in its positive, slow-frontend and intended-negative modes, the real-tab
attachment gate, the Probe gate with its moved-start negative, and the live
player gates (source and minified production). Headed browser gates use Xvfb
on Linux with the pinned Playwright Chromium (attachment/renderer) and the
pinned Chrome for Testing 151 (`PLAYA_DEVTOOLS_PROBE_BROWSER`,
`PLAYA_DEVTOOLS_LIVE_BROWSER`) for WebTransport and media; `ffmpeg` is
required for the generated LOC fixture. Bounded reports and screenshots are
retained. The same full set, locally (repo root unless stated; a display and
a codec-capable Chromium are required for the browser gates):

```
# repo root
pnpm --filter @openmoq/devtools-probe... --filter playa-devtools-extension... --filter @moqt/example-node-publisher... --filter @moqt/example-node-relay... build
pnpm --filter @moqt/example-node-relay exec node --input-type=module -e 'import { quicheLoaded } from "@fails-components/webtransport"; await quicheLoaded;'
pnpm --filter playa-devtools-extension test:typecheck:live
# pnpm runs ONE script per invocation (extra words become that script's arguments): one command per gate
pnpm --filter playa-devtools-extension test:readiness && pnpm --filter playa-devtools-extension test:trace \
  && pnpm --filter playa-devtools-extension test:object-wait \
  && pnpm --filter playa-devtools-extension test:element-metrics && pnpm --filter playa-devtools-extension test:fact-counter
pnpm --filter playa-devtools-extension test && pnpm --filter playa-devtools-extension test:owner
pnpm --filter @openmoq/devtools test:browser                       # page bridge over real MessageChannels
cd tools/devtools-extension                                        # browser gates; each needs a display
pnpm test:browser && pnpm test:browser:slow-frontend && pnpm test:browser:negative
pnpm test:browser:tab
pnpm test:browser:probe && node test/real-tab-probe.mjs --control=moved-start
pnpm test:browser:live && pnpm test:browser:live:production      # ffmpeg for the LOC fixture
pnpm test:typecheck:negatives && pnpm test:browser:live:negatives
for c in discoverable-plain swap-identity objects-on-silent no-pause; do node test/real-tab-live-negatives.mjs --control=$c || exit 1; done
```

The real-tab attachment report records the platform, architecture, Node version,
browser version and the extension/backend hashes it ran against.

Selecting another DevTools tab stops Playa's streaming DOM updates. The owner
continues capture, recording and message acknowledgements under the same bounds;
showing Playa again paints its latest view without attaching again. Chrome's
panel show/hide events drive this policy, since the iframe's `document.hidden`
does not reliably reflect the selected DevTools tab. Owner loss still clears the
live indicator once, even if the view was hidden. The renderer gate checks
hidden consumption and catch-up; the owner gate checks coalescing and lease
preservation.

### Live player gate

`test/real-tab-live.mjs` (`pnpm test:browser:live`) is the gate for the last
item that was "not done": real player data. `test/live-page/` is a page that
creates a REAL `@openmoq/playa` `Player` and installs diagnostics exactly as
an application would — `installPlayerDiagnostics(player, { registry,
exposure, video? })` from `@openmoq/devtools/player` and
`installDiagnosticBridge(registry)` from `@openmoq/devtools`, using the
facade's typed `ready`/`statechange`/`error` events — then plays this repo's
fixtures through the toy relay on loopback (the page pins the relay
certificate with the player's own `certHash`; the extension needs no pin).
The page is a mandatory typed consumer (`pnpm test:typecheck:live`). Three
arms, each with a fresh relay and publisher: `cmaf` (MSE into `<video>`),
`locmaf-mse` (LOCMAF objects, MSE decoding) and `loc` (LOC-04 media timing
through the genuine WebCodecs/canvas path; no media element is passed to the
adapter, so no media-element metric from the explicit element-metric list may
appear, while engine counters such as `video_decode_submissions` do). Evidence rules: MSE arms must
show increasing real `requestVideoFrameCallback` frames and media time, the
LOC arm advancing engine rendered frames and `Player.videoPresentation`
draws on a visible canvas; Detach is proven by progress AFTER detach on the
same evidence, never by a state string. With real clicks the gate proves the
page's one source discovered with its real `sourceId`/`runId` and exposure,
capabilities session/requests/objects/metrics/recording, `synthetic: false`;
a ready draft-18 session with the relay's origin and path only (the pin never
appears in any fact); the catalog's tracks; accepted SUBSCRIBEs bound to
tracks; real object facts, one of the selected track's objects found as a
rendered cell by exact identity; the adapter's metrics increasing over time;
Record → Stop → Save producing a `.moqtrace` read back from disk (JSON-SEQ,
sequential qlog schema, the `diagnostic_baseline` declaration, hundreds of
`[devtools_observation:v1]` records, no pin, no page query). Group bounds
are checked on every arm (a `group_bound` is never also an `object` fact at
the same alias/group/id) and required on the LOC arm, whose fixture flags
end-of-group on every group's last frame. MEDIA STAGES: on the MSE arms the
source must declare `cmaf-append-stages`, and an object of the selected
track must carry both a `reconstructed` and an `appended` stage with the
same deliveryId as its object fact and one shared unitId (`appended` > 0 is
also the proof that Chromium fires the MSE `update` witness); no `decoded`,
`scheduled` or `presented` stage may appear (MSE cannot observe them);
every stage names an object the panel holds; every discard reason is a
documented string; the engine's `diagnostic_evidence_loss` and
`diagnostic_unobservable_appends` are 0 on this fixture; the recording
carries both stage records; nothing reaches the panel after detach. The
LOC canvas arm has no append path and shows none of this. The legend states
the coverage in words per declared capability: `cmaf-append-stages` →
"append stages reported when the media source supports append observation"
or "appends unobservable (N)" when the bound adapter cannot report
completion; `loc-video-stages` → "video: decoded · scheduled · presented
reported from the renderer's own draw witness" or "video presentation
unobservable (N)"; `loc-audio-stages` → "audio: decoded · scheduled
reported; presentation is not observable (no audible witness) and is never
inferred" or "audio scheduling unobservable (N)". A "received" cell is then
never evidence of a missing stage. All three capabilities are advertised by
the player adapter and measured by the live gate. The served
BACKEND sources are fingerprinted before and after all arms and a change
fails the run; teardown is proven per process group.
`pnpm test:browser:live:production` builds the same page with `vite build`
(minified) and runs ONE CMAF arm with `exposure: 'production'` from a static
server, so production bundling failures stay attributable. Browsers: the
pinned Playwright Chromium by default; `PLAYA_DEVTOOLS_LIVE_BROWSER` names a
codec-capable executable (Linux Playwright Chromium has no H.264/AAC; CI uses
a checksum-pinned Chrome for Testing). The page's codec preflight fails fast
naming the missing codec. Honest limits: the toy relay confirms no
subprotocol, so `negotiatedProtocol` reads "not observed"; media correctness
is the player acceptance harness's job, not this gate's.

### Live negatives gate

`test/real-tab-live-negatives.mjs` (`pnpm test:browser:live:negatives`) applies
the live gate's recipe to four controlled conditions the positive arms cannot
show, each with a real player. **plain**: a minified production build of
`test/live-page/plain.html` (real player, no diagnostics import or install);
the emitted Rollup module graph holds no `@openmoq/devtools*` package and no
optional media-tracker implementation (the core lazy observer host and the
player's existing trace-recorder export are disclosed with their rendered
bytes, not forbidden), Attach ends in `carrier lost · no reply` without any
source being discovered, the engine's public snapshot never gains a
media-stage tracker, the page constructs exactly one `WebTransport`, no fact
reaches the panel and playback keeps progressing. **two-players**:
`test/live-page/two-players.html` runs two real players on separate
namespaces in one registry; the attached source's data envelopes carry its own
source and run identity and its track facts only its own exact namespace, a
switch isolates the second after completion (pre-completion frames are the
previous lease's disclosed drain), and registering player A again through its
facade and through its engine is refused by the real API with A's identity
intact and both players still playing. **silent**: `test/silent-publisher.ts`
(test-only, run with `tsx` from the example publisher) publishes the real
catalog, establishes every media track and sends no audio or video object;
the panel shows accepted video and audio requests with zero object or stage
facts, invents no group row, the playhead is a measurable 0, a recording holds
no media object facts, and the engine's own startup fault is then observed
and recorded (whether or not it happens inside the 15 s window). **freeze**:
on the MSE arm `video.pause()` is an app-induced freeze; inside the stable
frozen interval (bounded by the page's own `performance.now`, the clock the
source declares and stamps every observation with) video object receipts and
correlated `appended` units keep arriving — judged by the source's own
`timeMs`, never by batch order (`windowedChain` in `test/trace-facts.mjs`) —
while the playhead, rVFC and the reported presented-frames metric (a finite
observed value) stay at their last values, and `play()` resumes. Intended assertions are typed witnesses; the verdict is
the pure `src/negatives-verdict.mjs` (tested in `src/negatives-verdict.test.ts`):
both modes require a completed run, zero page/owner/panel exceptions,
unchanged backend source, unchanged gate inputs (its pages, the publisher
helper, the gate and its helpers are hashed before and after) and proven
cleanup of the browser, static server and every child process group. Every
absence claim (no fact, no foreign envelope, no media object) is admitted only
when the test-only frame ring still covers the judged interval: each retained
frame carries a monotonic index and the eviction count is checked
(`ringCoverage` in `test/fact-counter.mjs`). Controls each induce one real condition and pass
only when their case fails on the NAMED witness after its setup step:
`--control=discoverable-plain` (diagnostics page in place of the plain one),
`--control=swap-identity` (the other player is expected), `--control=objects-on-silent`
(the publisher sends one video object only after attach and accepted
requests, through a file trigger, with a send witness in its log) and
`--control=no-pause`. `pnpm test:typecheck:negatives` typechecks the publisher
helper against the example publisher's configuration; the two pages are in
`test:typecheck:live`. Test-only instrumentation is named in the report:
the panel frame ring and fact counter, the plain page's `WebTransport`
construction counter, the control's file trigger.

### Manual check: the native permission prompt

The automated gates never see Chrome's own permission dialog (they run a
labelled test build that pre-grants the loopback origin). This check takes
about two minutes and is the only way to close that gap:

1. `pnpm build`, then in branded Chrome or Chrome for Testing open
   `chrome://extensions`, enable Developer mode, **Load unpacked** → this
   directory's `dist/` (the SHIPPING manifest: `scripting` + optional host
   permissions, nothing pre-granted).
2. Open any `http(s)` page that installs the diagnostic bridge (for a page
   without Playa, `node test/real-tab.mjs` prints the two loopback origins it
   serves; or serve the gate page yourself), open DevTools → **Playa**.
3. The host line reads `not attached · Attach asks Chrome for access to
   <origin>` and the body `Not attached to this page.` Click **Attach to
   page**. Chrome shows its prompt naming that origin.
   - **Deny** → the host line reads `not attached · access to <origin> was
     not granted`; nothing is injected (the page's capture stays inert).
   - Click Attach again and **Allow** → with one exposed source the panel
     attaches to it at once (the grid fills); with several, the pick list
     appears and you pick one.
4. Reload the page: the panel shows `the page navigated`, then attaches BY
   ITSELF once the page has loaded, WITHOUT a second prompt (the grant is
   remembered per origin; the prompt itself always needs a click). Press
   **Detach**: the panel stays detached for that origin, across reloads, until
   you press Attach again (this is per DevTools window; closing and reopening
   DevTools attaches by itself again).
5. `chrome://extensions` → Playa DevTools → Details → Site access shows that
   origin only; remove it and Attach prompts again.

Record the Chrome version and the outcome of steps 3–5 in the review notes.

### Record

Record is a HOST action. The DevTools owner sends `record.start` and keeps the
returned recording id and token to itself (the token never reaches a view, a
fact, a log or the download); `record.stop` is acknowledged and the stopped
recording stays held; `record.export` returns chunks under one correlation —
the first in the request exchange, then one per poll with credit yielded
immediately — which the owner reassembles in index order and hands to the
panel once, which downloads it as `playa-<recordingId>.moqtrace` (UTF-8 of the
joined text; the gate reads the saved file back and checks its size and
JSON-SEQ records). A chunk gap or duplicate is the page's fault (protocol
violation, carrier closed); a page `error` drops only that export and keeps
the lease; OUR 8 MiB budget or 60 s deadline closes the carrier with a
`local-policy` reason, since the wire has no cancel command and a drain would
be unbounded. The action is offered only when the source declares the
`recording` capability. The button follows one rule: `Record .moqtrace` →
`Recording` (stop) → `Save .moqtrace` (export) → `Exporting · n chunks · k KiB`;
`Recording (another owner)` is disabled when the shared `recording` fact names
another attachment. Elapsed time appears only when a fact supplies it. Detach,
withdrawal, carrier loss and DevTools close release the recording and abort an
export. **Available for pages that install the recorder hook**
(`registry.register(capture, { createRecorder })` from `@openmoq/devtools`,
with `recording` in the source's declared capabilities): the real-tab gate
proves start, stop, a multi-chunk export and download, another owner's active
recording, and cleanup on detach against a real `TraceRecorder`.
`installPlayerDiagnostics` installs that hook for a real Playa player unless
the application passes `recording: false`; the live gate records a real
player on every arm and reads the saved file back (see "Live player data").
A source that declares no `recording` capability answers `unsupported` and
the panel shows the refused command.

### Probe

Probe is OWNER-LOCAL: the DevTools document dials the relay itself through
`@openmoq/devtools-probe` (`src/probe-owner.js`), with no page involved. Its
capture is admitted into a probe-kind registry and the ordinary diagnostic
carrier + host-core loop runs in-process, so the panel's probe lane consumes
the same frames as a page source. Nothing is dialled until you press Start;
the config is exactly what you typed: WebTransport URL (`https://` or
`moqt://`, credentials and fragments refused), the namespace tuple (one field
per comma, sent as typed), optional explicit track names (≤ 4; none means
session setup only and no objects are observed, which the status line says),
the draft to offer (16, 18 or 22, no auto-detection) and the policy (strict
refuses a relay that does not confirm the `moqt-N` subprotocol before SETUP;
compatibility is labelled and accepts only a MISSING observation). Presets are
fetched only on an explicit click from a URL you see. Stop ends the run and
its transport; a view reload never owns or stops a run; one run at a time.
Namespace fields and track names are never trimmed and empty entries are not
dropped. A completely blank input means no entries. For exact boundaries, use a
JSON string array, for example `["live,show", "", " camera "]`; this also lets
you express literal commas and opening brackets. Malformed arrays are refused
before any Start request reaches the owner. Presets fill the namespace as a
single exact field using that array syntax.

A failed run keeps its facts inspectable (dial/setup failures and the session
rows) and its local loop is released before a replacement. There is ONE runner
per DevTools owner: a rejected handshake (whose native `closed` promise rejects,
a settled closure) permits a retry on it at once, while a transport whose
close never settles within the runner's bound quarantines it — no successor,
until DevTools closes. The owner learns that from the runner's own `stop()`
rejecting and publishes it as `blocked` (reason `unproven-close`, the stop
error as detail) next to the run's original handshake failure and the
teardown fact; the panel then offers no Start (the control is disabled, the
status line reads `failed · <handshake failure> · quarantined: … close and
reopen DevTools to probe again`), a press sends nothing, and a Start that
reached the owner anyway is refused before any generation or factory step.
Nothing resets the runner: no retry, no second transport, no relaxed bound.
The WebTransport factory constructs exactly once per dial with the offered
subprotocols and never retries without them; a constructor error is a
structured dial failure.

Evidence: `pnpm test:owner` covers Start/refused handshake/Stop/retry on the
same runner, quarantine on an unsettled close, single transport construction,
overlap refusal, view reload independence, destroy-time release and config
refusal with a fake WebTransport, plus two controls on the real ordering (a
held teardown keeps the run `starting` — the runner rejects `ready` only
after its stop settles — and a settled failure retries at once) and the
quarantine itself (blocked published, owner refusal, clean destroy); the
real-tab gate's negative control dials a closed loopback port and shows the
dial failure, and its quarantine control holds the next transport's `closed`
(test-only wrapper) past the bound and asserts the disabled Start, the status
text, that a real press sends nothing and the page lane is untouched. **`pnpm test:browser:probe`
is the OBJECT gate**, local only: it generates a short-lived certificate,
starts this repo's toy relay (`examples/node-relay`, draft 18) and synthetic
publisher on loopback, pins the certificate with a TEST-ONLY
`serverCertificateHashes` wrapper installed into the DevTools document over
CDP (no skip-verification code ships), and through the real Probe strip
proves: SETUP, an accepted SUBSCRIBE for `video-360` whose panel request id
equals the relay-side request id, objects observed with exact
session/alias/group and object identities in decoded facts and visible cells
(judged only once one group of that subscription has its FIN-derived END_OF_GROUP
reported as a `group_bound` fact — exclusive at id 4, evidence end-of-group —
so DATA objects 0..3 with payload, the bound, the absence of any status
`object` fact and of any cell at the bound id, and the row label
`ends o4 (excl.)` are all checked every run; a producer that reported the
FIN-derived end as a parsed Object would fail), the adapter's group and cell
windows respected, a panel reload with no new
transport construction and no new relay SETUP, Stop with the relay logging
the disconnect, a WRONG pin failing at dial with no relay SETUP, and a
REJECTED track name failing at subscribe after SETUP. The toy relay does not
confirm the `moqt-18` subprotocol, so the gate falls back once to the
explicitly labelled compatibility policy and records that. The browser is
the pinned Playwright Chromium by default; `PLAYA_DEVTOOLS_PROBE_BROWSER`
names another executable (root CI chooses the same checksum-pinned Chrome
for Testing build it uses for the live gates) and the report records
`runtime.browserExecutable`; there is no fallback and no retry. A startup
timeout records the owner state, the refusal, the rendered Start button, the
config, the generation waited past, the construction count and the
failure/session/dial facts under `startupTimeout` in the report. The labelled arm
`node test/real-tab.mjs --probe-relay=<url> [--probe-namespace=a,b]
[--probe-tracks=x] [--probe-draft=16|18|22] [--probe-compat]` runs a REAL
probe against a relay you name; it is never part of CI. When track names are
given, the arm requires a decoded `object` fact (never a SUBSCRIBE acceptance
or a group bound) on the accepted request's session and alias AND the rendered
cell with the same identity within a 20 s wall deadline, and records
non-delivery as a failure. Against the public test relay on 2026-10-30: draft
16 (strict and compatibility) reached a ready session with the subprotocol
observed and SETUP in about 7 ms, then stopped cleanly; draft 22 strict
stopped because the `moqt-22` protocol was NOT OBSERVED on the transport (an
unavailable property, not peer evidence of a rejection); drafts 22 and 18 in
compatibility reached SETUP, which timed out after 10 s. On 2026-10-31 one
bounded run (`--probe-namespace=night --probe-tracks=catalog --probe-draft=16
--probe-compat`, ordinary certificate verification) observed a REAL OBJECT:
SETUP 11 ms with `moqt-16` observed, SUBSCRIBE for `catalog` accepted (request
0, alias 1), object group 0 / object 0 with 2,139 payload bytes and its exact
rendered cell observed 260 ms into the gate's post-ready wait. This is not
network latency or a Start-to-receipt measurement. One FIN-derived
group bound, then Stop settled `stopped`. The payload is a catalog, not decoded
media, and it is excluded from the diagnostic projection as always.

### Opening the panel: DevTools frontend readiness

Every browser gate opens the Playa panel through the frontend's own
`InspectorView` singleton, and only after the frontend's own bootstrap
promise (`MainImpl.instanceForTest.readyForTest()`) has resolved
(`test/devtools-frontend.mjs`). Asking for the singleton earlier CONSTRUCTS a
view in a document whose locale data is not registered yet and throws
`No locale data registered for 'en-US'`; that is a harness race, not a
renderer failure, and it was what the first renderer gate hit on a clean
Linux x64 container. The helper never sleeps, retries after an exception or
swallows the locale error: missing internals fail loudly as Chrome drift.
Initialisation is non-blocking (the frontend's thread is never awaited inside
a CDP call; the driver polls a small state object), every call it makes
carries its own scoped 15 s bound, the overall readiness wait (20 s) and the
Playa tab's registration (10 s) are bounded separately, judged on the time
each call RETURNED (a reply that says ready after the deadline is refused;
`pnpm test:readiness` proves it with a controlled clock) and reported
distinctly, and each report records `frontend` (whether the frontend was
still pending when its bootstrap promise became observable, the import time,
the time until ready, the tab polls). `pnpm test:browser:slow-frontend` throttles
the DevTools host CPU from the moment of attach (`--throttle=N`, default 20x;
the chosen rate is recorded under `frontend.throttleRate`) and passes only if
the frontend was pending on arrival and the run still passes, so a fast
machine cannot make the wait vacuous. A heavier host (an emulated x64
container, for instance) may name a fixed lower rate explicitly; there is no
automatic calibration, and the 20 s readiness deadline is never waived.

### Native clicks in the browser gates

Every button press in the real-tab, Probe and live gates goes through
`test/native-click.mjs`: a genuine `Input.dispatchMouseEvent` sequence (user
gesture, never DOM `.click()`), but the element is scrolled into view, the
layout must be stable for two frames with the centre hit-testing to the
element BEFORE dispatch, and a capture-phase document listener records at
dispatch time whether the event target was the announced element (before any
handler can rebuild rows). Exactly one click must be recorded and it must
match; otherwise the gate fails loudly naming the control that was hit — a
misdirected click is a harness interaction failure, never a retry and never
a Probe timeout. `node test/real-tab-probe.mjs --control=moved-start` hides
the Start button between measurement and dispatch and passes only if the
helper refuses that click and no Start is recorded as completed. This
replaced a helper that dispatched at a rect measured before scrolling; on
Linux x64 that click landed on the Attach tab and the Probe gate reported a
startup timeout.

### Stages and what they mean

`reconstructed` = the CMAF assembler produced the segment from the listed
object(s); `appended` = the SourceBuffer accepted those bytes at a
successful `updateend` with the MSE `update` witness; `decoded` = a real
WebCodecs output whose input identity was proven (video by the decoder's
own unique source-time decision, audio by a unique timing record);
`scheduled` = the renderer accepted the frame into its queue, or the audio
buffer source's `start()` returned; `presented` = the canvas renderer's
unambiguous successful draw (video only); `discarded (reason)` = the object
or unit was dropped by a named policy. Decode and presentation are not
observable through MSE and are never inferred from an append; audio
presentation is not observable anywhere (Web Audio offers no audible
witness) and `released` ends tracking without a stage. A stage a source
never reports reads "not observed"; counters (`diagnostic_evidence_loss`,
`diagnostic_unobservable_*`, `diagnostic_refused_*`,
`diagnostic_input_admission_refusals`, `diagnostic_unattributed_*`) say
when evidence could not be obtained, and never mean lost media. Decode
counters are three different things and are labelled as such:
`video_decode_submissions` (the engine's decode commands before native
dispatch, engine lifetime), `frames_decoded` and `audio_outputs_decoded`
(actual decoder output callbacks during the diagnostic tracker lifetime,
unavailable as `unsupported` on MSE where the browser decodes internally).
A decoder may emit zero or several outputs per submission, so their
difference is never shown or read as drops.

## Not yet

The native optional-permission prompt,
which remains a MANUAL check (the automated attachment gate uses a labelled
test build that pre-grants the loopback origin and a denial control that
wraps the API); a GitHub Actions run of the wired CI (never dispatched; all
evidence above is local macOS plus Codex's clean Linux containers on earlier
candidates); and media correctness itself, which is the player acceptance
harness's job, not this panel's.
