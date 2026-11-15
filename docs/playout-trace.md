# Playout Trace Recorder

`TraceRecorder` captures a bounded, in-memory window of namespaced
[qlog](https://datatracker.ietf.org/doc/draft-ietf-quic-qlog-main-schema/)
events for one player run and serializes it on demand as a sequential qlog file
(JSON-SEQ). It is meant for support traces: record while reproducing a problem,
then dump the window and attach the file to a report.

The simplest way to record is the [DevTools extension](../tools/devtools-extension/README.md):
[`@openmoq/devtools`](../packages/devtools/PLAYER.md) installs a recorder for an
opted-in player and the panel's Record button starts, stops and exports it.
Use `TraceRecorder` directly when you want to capture traces in your own
application.

```ts
import { MoqtPlayer, TraceRecorder } from '@openmoq/player';

const recorder = new TraceRecorder({
  clock: { clock_id: 'page', clock_type: 'monotonic', now: () => performance.now() },
  runId: crypto.randomUUID(),
  eventSchemas: [],
});

const player = new MoqtPlayer({
  // ...
  logLevel: 'info',
  logger: recorder.logger(console),  // player logs go to the console and the trace
});

recorder.start();
// ... reproduce the problem ...
recorder.stop();
const sqlog = recorder.dump();       // a JSON-SEQ string; save it as a .sqlog file
```

## Recording

Recording is off by default (`enabled: false`). While it is off, `record()`
returns at once without reading the clock or allocating.

- `start()` begins a new capture. It clears the previous window and keeps
  declared metadata, which describes the run rather than the window.
- `stop()` freezes the retained window at that instant.
- `clear()` discards everything, including metadata.
- `dump()` serializes the retained window. It is not re-entrant.

Recorder failures are contained: diagnostics never alter playback.

## Events

- **Log lines.** `recorder.logger(base, { lane })` returns a logger that
  forwards to `base` and records each line as a `loglevel:<level>` event (sparse
  lane by default). Arguments are formatted into one bounded message;
  `formatLogMessage` is the formatter.
- **Your own events.** `record(name, data, { lane, groupId })` records one event.
  `name` must be namespaced (`namespace:event`); the `playa` and `loglevel`
  namespaces belong to the recorder and are refused. Events go to the dense
  lane unless `lane: 'sparse'` is given. List the schema URIs for the
  namespaces you record in `eventSchemas`; the recorder adds its own
  (`PLAYA_EVENT_SCHEMA`) and, once a log line is retained, `LOGLEVEL_EVENT_SCHEMA`.
- **Metadata.** `declare(kind, data)` records interpretation metadata, such as
  capabilities, track definitions and run or session mappings. It is serialized
  at once, kept in a separately bounded table, and is never evicted by age, so a
  retained event never loses the metadata needed to read it.

Today a recorder sees the player only through its log lines, via the logger
tee. Transport-level qlog events are available separately through the player's
`onQlogEvent` option and `QlogTrace` in `@openmoq/transport`.

## Limits

Retention is bounded by age, event count and bytes, per lane.
`DEFAULT_TRACE_LIMITS`:

| Limit | Dense lane | Sparse lane |
|---|---|---|
| Age | 30 s | 5 min |
| Events | 50,000 | 10,000 |
| Bytes | 8 MiB | 2 MiB |

Metadata is capped at 512 entries and 512 KiB, and each log message at 2,000
characters. Override any of them with `limits`. Every dump includes a
`playa:trace_window` event recording the capture start, the dump cutoff, the
earliest retained time, eviction counts and any truncation, so a reader can
tell what the window does and does not cover.

## Durability

The buffer lives in memory and dies with the page. The recorder is **not**
crash-safe: a dump is produced on demand, not written as it goes.

## Privacy

A trace is sensitive. Log lines can contain the relay URL, namespaces, track
names, GOAWAY targets and error text. Review a trace before sharing it, and tell
users plainly what a file contains if your application lets them export one.
