/**
 * Trace recorder — bounded in-memory capture with a user-triggered dump.
 *
 * Collects namespaced qlog events from every lane (`moqt:*`, `loglevel:*`,
 * and later `moq_playout:*`) under one player run and clock, and serializes
 * them as a sequential qlog file.
 *
 * **This is not crash-safe.** The buffer lives in memory and dies with the
 * page; JSON-SEQ tolerates a truncated final record only for data already
 * persisted or streamed, so producing a blob on a button press gains nothing
 * from that resilience. Durable capture is a separate design.
 *
 * Recording is opt-in and off by default. When disabled, `record()` performs
 * no clock read, no formatting, and no allocation.
 *
 * @see docs/playout-trace.md
 * @module
 */

import {
  assertEventName,
  seqHeader,
  seqRecord,
  type QlogClock,
  type QlogEventRecord,
  type QlogTraceSpec,
} from '@moqt/transport';
import { isAbsoluteUri } from './absolute-uri.js';
import type { LoggerLike } from './logger.js';

// ─── Schema URIs ────────────────────────────────────────────────────

/**
 * Private schema for the recorder's own events.
 *
 * Every dump contains `playa:trace_window`, so this schema is always in use.
 * Non-IETF namespaces use a domain URI with an `mmyyyy` datestamp.
 *
 * @see [QLOG-MAIN] §8
 */
export const PLAYA_EVENT_SCHEMA = 'https://openmoq.org/082026/playa';

/** Standard schema for the logger tee. @see [QLOG-MAIN] §9.1 */
export const LOGLEVEL_EVENT_SCHEMA = 'urn:ietf:params:qlog:events:loglevel';

// ─── Limits ─────────────────────────────────────────────────────────

/**
 * Retention bounds.
 *
 * Age alone is not protective: logger strings, structured metadata, and bursts
 * can blow memory well inside the window, so every lane is bounded by bytes
 * and event count too. Byte bounds are UTF-8, matching the emitted file.
 */
export interface TraceLimits {
  /** Dense lane (per-unit events) — the expensive one. */
  readonly denseMaxAgeMs: number;
  readonly denseMaxEvents: number;
  readonly denseMaxBytes: number;
  /** Sparse lane (stalls, discards, state changes) — kept longer. */
  readonly sparseMaxAgeMs: number;
  readonly sparseMaxEvents: number;
  readonly sparseMaxBytes: number;
  /** Non-evictable metadata side table. */
  readonly metadataMaxEntries: number;
  readonly metadataMaxBytes: number;
  /** Hard upper bound on one formatted log message, truncation marker included. */
  readonly maxLogMessageChars: number;
}

/** Defaults: a recent, complete window rather than a sampled long one. */
export const DEFAULT_TRACE_LIMITS: TraceLimits = {
  denseMaxAgeMs: 30_000,
  denseMaxEvents: 50_000,
  denseMaxBytes: 8 * 1024 * 1024,
  sparseMaxAgeMs: 300_000,
  sparseMaxEvents: 10_000,
  sparseMaxBytes: 2 * 1024 * 1024,
  metadataMaxEntries: 512,
  metadataMaxBytes: 512 * 1024,
  maxLogMessageChars: 2_000,
};

/** Which retention lane an event belongs to. */
export type TraceLane = 'dense' | 'sparse';

const TRUNCATION_MARKER = '…[truncated]';

/**
 * Namespaces the recorder owns and whose schemas it declares.
 *
 * A caller-authored event here would make the header claim a schema that does
 * not define it, so `record()` rejects them; the logger tee uses the internal
 * path instead.
 */
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set(['playa', 'loglevel']);

/**
 * [QLOG-MAIN] §8 requires an absolute URI. An empty or relative value produces
 * a header our own parser rejects, so it is caught at construction.
 */
function validateSchemas(schemas: readonly string[]): readonly string[] {
  for (const uri of schemas) {
    if (typeof uri !== 'string' || !isAbsoluteUri(uri)) {
      throw new RangeError(
        `TraceRecorderOptions.eventSchemas must be absolute URIs (got ${describe(uri)})`,
      );
    }
  }
  // Copy only. Deduplication happens once, on the output path in schemas().
  return [...schemas];
}

/** Render a rejected value without a second operation that can itself throw. */
function describe(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  return `${typeof v} value`;
}

/**
 * A cap smaller than the truncation marker cannot be honoured, so it is
 * rejected rather than silently exceeded. Exactly the marker length is
 * allowed: it yields the marker alone.
 *
 * Shared by the recorder's limit validation and the exported formatter, so the
 * public function enforces the bound it documents.
 */
function assertLogCap(cap: number): void {
  if (!Number.isSafeInteger(cap) || cap < TRUNCATION_MARKER.length) {
    throw new RangeError(
      `maxLogMessageChars must be a safe integer of at least ${TRUNCATION_MARKER.length} (got ${cap})`,
    );
  }
}

/**
 * Validate limits before any clock or wire-visible work.
 *
 * An unvalidated `NaN` or `Infinity` silently disables the bound it configures,
 * which would leave the recorder promising a window it does not enforce.
 */
function resolveLimits(partial: Partial<TraceLimits> | undefined): TraceLimits {
  const limits = { ...DEFAULT_TRACE_LIMITS, ...partial };
  const ages = ['denseMaxAgeMs', 'sparseMaxAgeMs'] as const;
  const counts = [
    'denseMaxEvents', 'denseMaxBytes', 'sparseMaxEvents', 'sparseMaxBytes',
    'metadataMaxEntries', 'metadataMaxBytes',
  ] as const;

  for (const key of ages) {
    const v = limits[key];
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(`TraceLimits.${key} must be a finite, non-negative number (got ${v})`);
    }
  }
  for (const key of counts) {
    const v = limits[key];
    if (!Number.isSafeInteger(v) || v <= 0) {
      throw new RangeError(`TraceLimits.${key} must be a positive safe integer (got ${v})`);
    }
  }
  assertLogCap(limits.maxLogMessageChars);
  return limits;
}

// ─── Options ────────────────────────────────────────────────────────

export interface TraceRecorderOptions {
  /** Clock timing this run. Its `clock_id` is declared in the dump. */
  readonly clock: QlogClock;
  /** Group id for the player run; events may override per session. */
  readonly runId: string;
  /**
   * Event schema URIs for the lanes the caller will contribute. The recorder's
   * own private schema is added automatically, as is the standard `loglevel`
   * schema once a log event is retained.
   */
  readonly eventSchemas: readonly string[];
  /** Start recording immediately. Defaults to false. */
  readonly enabled?: boolean;
  readonly limits?: Partial<TraceLimits>;
  /**
   * Number of media-unit lifecycles still open at dump time.
   *
   * Supplied by the instrumentation layer. When absent — or when it throws or
   * returns a value that is not a non-negative integer — the dump reports
   * `unknown` rather than implying zero.
   */
  readonly openLifecycles?: () => number;
  readonly title?: string;
}

// ─── Internals ──────────────────────────────────────────────────────

/** A serialized event awaiting dump. Framed once, at record time. */
interface StoredEvent {
  readonly time: number;
  /** Global insertion order, so equal timestamps keep causal order. */
  readonly seq: number;
  readonly framed: string;
  readonly bytes: number;
}

/**
 * A bounded FIFO with a head cursor.
 *
 * `Array.shift()` on a 50,000-element ring is O(n) per eviction, which would
 * let the diagnostic perturb the playback it is diagnosing.
 */
class EventRing {
  private items: StoredEvent[] = [];
  private head = 0;
  bytes = 0;
  evictedEvents = 0;
  evictedBytes = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  get oldest(): StoredEvent | undefined {
    return this.items[this.head];
  }

  push(e: StoredEvent): void {
    this.items.push(e);
    this.bytes += e.bytes;
  }

  shift(): void {
    const e = this.items[this.head];
    if (e === undefined) return;
    this.head++;
    this.bytes -= e.bytes;
    this.evictedEvents++;
    this.evictedBytes += e.bytes;
    // Amortized compaction: reclaim once the dead prefix dominates.
    if (this.head > 32 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }

  toArray(): StoredEvent[] {
    return this.items.slice(this.head);
  }

  clear(): void {
    this.items = [];
    this.head = 0;
    this.bytes = 0;
    this.evictedEvents = 0;
    this.evictedBytes = 0;
  }
}

/** UTF-8 byte length — a JSON-SEQ file is UTF-8, not UTF-16. */
const utf8 = new TextEncoder();
function utf8Bytes(s: string): number {
  return utf8.encode(s).length;
}

// ─── Recorder ───────────────────────────────────────────────────────

export class TraceRecorder {
  private readonly clock: QlogClock;
  private readonly runId: string;
  private readonly callerSchemas: readonly string[];
  private readonly limits: TraceLimits;
  private readonly openLifecycles: (() => number) | undefined;
  private readonly title: string | undefined;

  private readonly dense = new EventRing();
  private readonly sparse = new EventRing();
  private seq = 0;
  private sawLogEvent = false;

  /** Non-evictable interpretation metadata, serialized at declaration. */
  private metadata: StoredEvent[] = [];
  private metadataBytes = 0;
  private metadataDropped = 0;

  private recording: boolean;
  private captureStart: number | null = null;
  /** Clock value when recording stopped, so a stopped window stays frozen. */
  private captureEnd: number | null = null;
  private recorderFaults = 0;
  private dumping = false;

  constructor(opts: TraceRecorderOptions) {
    this.limits = resolveLimits(opts.limits);
    this.clock = opts.clock;
    this.runId = opts.runId;
    // Validate and copy: never retain a mutable caller-owned array. Dedupe
    // happens on the output path.
    this.callerSchemas = validateSchemas(opts.eventSchemas);
    this.openLifecycles = opts.openLifecycles;
    this.title = opts.title;
    this.recording = opts.enabled ?? false;
    if (this.recording) this.captureStart = this.clock.now();
  }

  /** Whether events are being captured. */
  get enabled(): boolean {
    return this.recording;
  }

  /**
   * Begin capturing.
   *
   * Restarting begins a **new** capture: the previous evictable window is
   * cleared, because retaining pre-start events while claiming the later start
   * as the capture boundary would make the window metadata self-contradictory.
   * Pinned metadata is kept, since it describes the run rather than the window.
   */
  start(): void {
    if (this.recording) return;
    this.dense.clear();
    this.sparse.clear();
    this.sawLogEvent = false;
    this.recording = true;
    this.captureStart = this.clock.now();
    this.captureEnd = null;
  }

  /** Stop capturing. The retained window freezes at this instant. */
  stop(): void {
    if (!this.recording) return;
    this.recording = false;
    this.captureEnd = this.clock.now();
    this.evictAll(this.captureEnd);
  }

  /** Discard everything, including metadata. */
  clear(): void {
    this.dense.clear();
    this.sparse.clear();
    this.metadata = [];
    this.metadataBytes = 0;
    this.metadataDropped = 0;
    this.recorderFaults = 0;
    this.sawLogEvent = false;
    this.captureStart = this.recording ? this.clock.now() : null;
    this.captureEnd = null;
  }

  /**
   * Record one event.
   *
   * The lane is declared by the caller rather than guessed from the name:
   * density is a property of the event type, not of its namespace, and a
   * single namespace legitimately carries both per-unit rows and sparse state.
   *
   * Returns immediately when disabled, without reading the clock or
   * allocating. Recorder failures are contained — diagnostics must never
   * alter playback.
   */
  record(
    name: string,
    data: Record<string, unknown>,
    opts?: { lane?: TraceLane; groupId?: string },
  ): void {
    if (!this.recording) return;
    try {
      assertEventName(name);
      if (RESERVED_NAMESPACES.has(name.slice(0, name.indexOf(':')))) {
        throw new RangeError(`qlog: "${name}" is in a recorder-owned namespace`);
      }
      const record: QlogEventRecord = {
        time: this.clock.now(),
        name,
        data,
        group_id: opts?.groupId ?? this.runId,
      };
      const framed = seqRecord(record);
      const lane = opts?.lane === 'sparse' ? this.sparse : this.dense;
      lane.push({
        time: record.time,
        seq: this.seq++,
        framed,
        bytes: utf8Bytes(framed),
      });
      this.evictAll(record.time);
    } catch {
      this.recorderFaults++;
    }
  }

  /**
   * Record an event in a recorder-owned namespace.
   *
   * Separate from {@link record} so callers cannot author events the declared
   * private and `loglevel` schemas do not define.
   */
  private recordOwned(name: string, data: Record<string, unknown>, lane: TraceLane): void {
    if (!this.recording) return;
    try {
      const time = this.clock.now();
      const framed = seqRecord({ time, name, data, group_id: this.runId });
      const ring = lane === 'sparse' ? this.sparse : this.dense;
      ring.push({ time, seq: this.seq++, framed, bytes: utf8Bytes(framed) });
      if (name.startsWith('loglevel:')) this.sawLogEvent = true;
      this.evictAll(time);
    } catch {
      this.recorderFaults++;
    }
  }

  /**
   * Declare interpretation metadata: capabilities, track definitions, run and
   * session mappings, clock provenance.
   *
   * These are emitted once but needed by every retained event, so they are not
   * subject to age eviction. The store is bounded separately and truncation is
   * reported in the dump.
   *
   * The value is serialized here rather than retained by reference: a caller
   * that mutates the object afterwards must not be able to change the dump,
   * bypass the byte cap, or make the dump throw.
   */
  declare(kind: string, data: Record<string, unknown>): void {
    if (!this.recording) return;
    try {
      const time = this.clock.now();
      const framed = seqRecord({
        time,
        name: 'playa:metadata',
        data: { kind, data },
        group_id: this.runId,
      });
      const bytes = utf8Bytes(framed);
      // Declaration is a timestamped recorder operation like any other, so it
      // advances retention — whether or not the independent metadata store had
      // capacity for this particular row.
      this.evictAll(time);
      if (
        this.metadata.length >= this.limits.metadataMaxEntries ||
        this.metadataBytes + bytes > this.limits.metadataMaxBytes
      ) {
        this.metadataDropped++;
        return;
      }
      this.metadata.push({ time, seq: this.seq++, framed, bytes });
      this.metadataBytes += bytes;
    } catch {
      this.recorderFaults++;
    }
  }

  /**
   * Wrap a logger so its output is teed into the trace as `loglevel:*` events.
   *
   * The base logger is called **first**, with the original arguments, so its
   * normal behaviour — including throwing — is untouched by the presence of a
   * trace. Formatting happens afterwards, only while recording, and entirely
   * inside fault containment: a hostile value degrades to a placeholder and
   * increments `recorder_faults` rather than reaching playback.
   *
   * The recorded message preserves the *call shape* — the format string and
   * its arguments joined — not the console-rendered result. `%s`/`%d`
   * placeholders are left as written.
   */
  logger(base: LoggerLike): LoggerLike {
    const tee = (level: 'error' | 'warning' | 'info' | 'debug') =>
      (msg: string, args: readonly unknown[]): void => {
        if (!this.recording) return;
        let message: string;
        try {
          message = formatLogMessage(msg, args, this.limits.maxLogMessageChars);
        } catch {
          this.recorderFaults++;
          message = '[unformattable log arguments]';
        }
        this.recordOwned(`loglevel:${level}`, { message }, 'sparse');
      };
    const err = tee('error');
    const warn = tee('warning');
    const info = tee('info');
    const debug = tee('debug');
    return {
      error: (m, ...a) => { base.error(m, ...a); err(m, a); },
      warn: (m, ...a) => { base.warn(m, ...a); warn(m, a); },
      info: (m, ...a) => { base.info(m, ...a); info(m, a); },
      debug: (m, ...a) => { base.debug(m, ...a); debug(m, a); },
    };
  }

  /** Retained event count, for tests and UI. */
  get size(): number {
    return this.dense.length + this.sparse.length;
  }

  /**
   * Serialize the retained window as a sequential qlog file.
   *
   * Both lanes are merged and ordered by timestamp, then by global insertion
   * sequence so equal-timestamp events keep causal order across lanes.
   */
  dump(): string {
    if (this.dumping) {
      throw new Error('TraceRecorder.dump() is not re-entrant');
    }
    this.dumping = true;
    try {
      // The provider is arbitrary instrumentation and may mutate the recorder,
      // so it runs to completion *before* anything is snapshotted. Everything
      // serialized below comes from one consistent observation.
      const openLifecycles = this.readOpenLifecycles();

      const dumpTime = this.clock.now();
      const retentionCutoff = this.captureEnd ?? dumpTime;
      this.evictAll(retentionCutoff);

      const rows = [
        ...this.metadata,
        ...this.dense.toArray(),
        ...this.sparse.toArray(),
      ].sort((a, b) => a.time - b.time || a.seq - b.seq);

      const retained = [...this.dense.toArray(), ...this.sparse.toArray()];
      const earliest = retained.length > 0
        ? retained.reduce((m, e) => (e.time < m ? e.time : m), retained[0]!.time)
        : null;

      const spec: QlogTraceSpec = {
        ...(this.title !== undefined ? { title: this.title } : {}),
        event_schemas: this.schemas(),
        vantage_point: { type: 'client' },
        common_fields: {
          group_id: this.runId,
          time_format: 'relative_to_epoch',
          reference_time: { clock_type: this.clock.clock_type, epoch: 'unknown' },
        },
      };

      // The window describes the dump, so it happened last and is stamped and
      // ordered accordingly.
      const window = seqRecord({
        time: dumpTime,
        name: 'playa:trace_window',
        data: this.windowMetadata(dumpTime, retentionCutoff, earliest, openLifecycles),
        group_id: this.runId,
      });

      return seqHeader(spec) + rows.map(e => e.framed).join('') + window;
    } finally {
      this.dumping = false;
    }
  }

  /** Schemas actually in use, per [QLOG-MAIN] §8. */
  private schemas(): readonly string[] {
    const all = [...this.callerSchemas, PLAYA_EVENT_SCHEMA];
    if (this.sawLogEvent) all.push(LOGLEVEL_EVENT_SCHEMA);
    return [...new Set(all)];
  }

  /**
   * What this dump does and does not contain.
   *
   * Age eviction can retain a terminal event whose start aged out, or a start
   * whose unit is still in flight. The analyzer must gate its conclusions on
   * this record rather than treat absence as a discard.
   */
  private windowMetadata(
    dumpTime: number,
    retentionCutoff: number,
    earliest: number | null,
    openLifecycles: number | string,
  ): Record<string, unknown> {
    return {
      clock_id: this.clock.clock_id,
      clock_type: this.clock.clock_type,
      capture_start: this.captureStart,
      capture_end: this.captureEnd,
      /** When this dump was produced. */
      dump_time: dumpTime,
      /** Window edge retention was applied against: `capture_end` if stopped. */
      retention_cutoff: retentionCutoff,
      earliest_retained: earliest,
      recording: this.recording,
      dense: laneStats(this.dense),
      sparse: laneStats(this.sparse),
      limits: limitsToQlog(this.limits),
      metadata_entries: this.metadata.length,
      metadata_bytes: this.metadataBytes,
      metadata_truncated: this.metadataDropped > 0,
      metadata_dropped: this.metadataDropped,
      recorder_faults: this.recorderFaults,
      open_lifecycles: openLifecycles,
    };
  }

  /** Instrumentation is contained: a bad provider yields `unknown`. */
  private readOpenLifecycles(): number | string {
    if (this.openLifecycles === undefined) return 'unknown';
    try {
      const n = this.openLifecycles();
      if (!Number.isSafeInteger(n) || n < 0) {
        this.recorderFaults++;
        return 'unknown';
      }
      return n;
    } catch {
      this.recorderFaults++;
      return 'unknown';
    }
  }

  /**
   * Sweep both lanes against one timestamp.
   *
   * Every successful recorder operation goes through here, so the retention
   * invariant cannot drift apart between paths again.
   */
  private evictAll(time: number): void {
    this.evict(this.dense, false, time);
    this.evict(this.sparse, true, time);
  }

  /** Drop from the front until every bound for this lane holds. */
  private evict(lane: EventRing, sparse: boolean, cutoff: number): void {
    const maxAge = sparse ? this.limits.sparseMaxAgeMs : this.limits.denseMaxAgeMs;
    const maxEvents = sparse ? this.limits.sparseMaxEvents : this.limits.denseMaxEvents;
    const maxBytes = sparse ? this.limits.sparseMaxBytes : this.limits.denseMaxBytes;

    while (lane.length > 0) {
      const oldest = lane.oldest!;
      const tooOld = cutoff - oldest.time > maxAge;
      const tooMany = lane.length > maxEvents;
      const tooBig = lane.bytes > maxBytes;
      if (!tooOld && !tooMany && !tooBig) break;
      lane.shift();
    }
  }
}

/**
 * Serialize limits with qlog field naming.
 *
 * [QLOG-MAIN] §11.2: all qlog field names MUST be lowercase when serialized to
 * JSON-SEQ, so the option object's camelCase keys cannot go on the wire.
 * Age bounds are float64 milliseconds per §1.2; counts and caps are integers.
 */
function limitsToQlog(l: TraceLimits): Record<string, unknown> {
  return {
    dense_max_age_ms: l.denseMaxAgeMs,
    dense_max_events: l.denseMaxEvents,
    dense_max_bytes: l.denseMaxBytes,
    sparse_max_age_ms: l.sparseMaxAgeMs,
    sparse_max_events: l.sparseMaxEvents,
    sparse_max_bytes: l.sparseMaxBytes,
    metadata_max_entries: l.metadataMaxEntries,
    metadata_max_bytes: l.metadataMaxBytes,
    max_log_message_chars: l.maxLogMessageChars,
  };
}

function laneStats(lane: EventRing): Record<string, unknown> {
  return {
    retained: lane.length,
    bytes: lane.bytes,
    evicted_events: lane.evictedEvents,
    evicted_bytes: lane.evictedBytes,
    evicted: lane.evictedEvents > 0,
  };
}

// ─── Safe log formatting ────────────────────────────────────────────

/**
 * Render a log call as one bounded string.
 *
 * `LoggerLike` accepts arbitrary `unknown[]`, so a blind `JSON.stringify`
 * would throw on cycles and BigInts, and could serialize a very large object
 * into the ring. Known types are formatted explicitly and everything else is
 * summarized rather than expanded.
 *
 * The result never exceeds `maxChars`, truncation marker included.
 */
export function formatLogMessage(msg: string, args: readonly unknown[], maxChars: number): string {
  assertLogCap(maxChars);
  const parts = [safeString(msg), ...args.map(formatValue)];
  const joined = parts.join(' ');
  if (joined.length <= maxChars) return joined;
  return joined.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

/** Even the format string can be a hostile object at runtime. */
function safeString(v: unknown): string {
  return typeof v === 'string' ? v : formatValue(v);
}

function formatValue(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
    case 'boolean':
      return String(v);
    case 'bigint':
      return `${v}n`;
    case 'undefined':
      return 'undefined';
    case 'function':
      return '[function]';
    case 'symbol':
      return safeToString(v);
  }
  if (v === null) return 'null';
  // Every branch below touches a property that a Proxy trap or getter can
  // make throw, so the whole inspection is contained.
  try {
    if (v instanceof Error) return `${safeToString(v.name)}: ${safeToString(v.message)}`;
    if (ArrayBuffer.isView(v)) return `[${ctorName(v as object)} byteLength=${v.byteLength}]`;
    if (v instanceof Map) return `[Map size=${v.size}]`;
    if (v instanceof Set) return `[Set size=${v.size}]`;
    if (Array.isArray(v)) return `[Array length=${v.length}]`;
    // A plain object could be cyclic, enormous, or carry throwing getters.
    // Name its shape rather than expanding its contents.
    return `[${ctorName(v as object)}]`;
  } catch {
    return '[unreadable]';
  }
}

function ctorName(v: object): string {
  try {
    return v.constructor?.name ?? 'Object';
  } catch {
    return 'Object';
  }
}

function safeToString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return '[unreadable]';
  }
}
