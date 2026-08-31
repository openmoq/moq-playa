/**
 * Generic qlog file machinery per [QLOG-MAIN] draft-14.
 *
 * Protocol-agnostic: this module knows about files, traces, envelopes, and
 * event records. It knows nothing about MOQT, media playout, or recorder
 * retention policy — those live in their own layers and contribute events
 * through {@link QlogEventLog}.
 *
 * Two serializations are supported:
 *
 * - **contained** (`.qlog`, `application/qlog+json`) — one JSON document.
 *   Must be closed to parse, so it suits a completed capture.
 * - **sequential** (`.sqlog`, `application/qlog+json-seq`) — RFC 7464 JSON
 *   text sequences. Each record is independently framed, so the file appends
 *   cheaply and survives truncation of its final record.
 *
 * @see draft-ietf-quic-qlog-main-schema-14
 * @see RFC 7464 (JSON Text Sequences)
 * @module
 */

// ─── Constants ──────────────────────────────────────────────────────

/** File schema URI for the contained (single JSON document) form. */
export const QLOG_FILE_SCHEMA_CONTAINED = 'urn:ietf:params:qlog:file:contained';
/** File schema URI for the sequential (JSON-SEQ) form. */
export const QLOG_FILE_SCHEMA_SEQUENTIAL = 'urn:ietf:params:qlog:file:sequential';
/** Media type for the contained form. */
export const QLOG_FORMAT_JSON = 'application/qlog+json';
/** Media type for the sequential form. */
export const QLOG_FORMAT_JSON_SEQ = 'application/qlog+json-seq';

/** RFC 7464 record separator (0x1E). Prefixes every JSON-SEQ record. */
const RS = '\x1e';
/** Line feed (0x0A). Terminates every JSON-SEQ record. */
const LF = '\n';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * A single timestamped event record.
 *
 * `name` is `"<namespace>:<event_type>"` per [QLOG-MAIN] §7.2 — the namespace
 * identifies which event schema defines the record.
 */
export interface QlogEventRecord {
  /** Time on the trace's reference clock, in milliseconds. */
  readonly time: number;
  /** `"<namespace>:<event_type>"`. */
  readonly name: string;
  /** Schema-defined event payload. */
  readonly data: Record<string, unknown>;
  /**
   * Logical group this event belongs to. Used to keep separate sessions
   * distinguishable within one trace.
   * @see [QLOG-MAIN] §7.3
   */
  readonly group_id?: string;
}

/** Reference clock declaration. @see [QLOG-MAIN] §7.5 */
export interface QlogReferenceTime {
  readonly clock_type: 'system' | 'monotonic';
  /** RFC 3339 timestamp, or `'unknown'` for a monotonic clock with no epoch. */
  readonly epoch: string;
  readonly wall_clock_time?: string;
}

/** Field values shared by every event in a trace. @see [QLOG-MAIN] §7.5 */
export interface QlogCommonFields {
  readonly time_format?: 'relative_to_epoch' | 'relative_to_previous_event';
  readonly reference_time?: QlogReferenceTime;
  /** Applies to every event that does not carry its own `group_id`. */
  readonly group_id?: string;
  readonly [key: string]: unknown;
}

/** Observation perspective. @see [QLOG-MAIN] §7.4 */
export interface QlogVantagePoint {
  readonly type: 'client' | 'server' | 'network' | 'unknown';
  readonly name?: string;
  /** Required when `type` is `'network'`. */
  readonly flow?: 'client' | 'server' | 'unknown';
}

/** Everything describing a trace except its events. */
export interface QlogTraceSpec {
  readonly title?: string;
  readonly description?: string;
  /** Event schema URIs. Required — identifies the namespaces in use. */
  readonly event_schemas: readonly string[];
  readonly vantage_point?: QlogVantagePoint;
  readonly common_fields?: QlogCommonFields;
}

/** A trace inside a contained file — spec plus its events. */
export interface QlogContainedTrace extends QlogTraceSpec {
  readonly events: readonly QlogEventRecord[];
}

/** A contained qlog file. */
export interface QlogFileContained {
  readonly file_schema: typeof QLOG_FILE_SCHEMA_CONTAINED;
  readonly serialization_format: typeof QLOG_FORMAT_JSON;
  readonly title?: string;
  readonly description?: string;
  readonly traces: readonly QlogContainedTrace[];
}

/** The header record of a sequential qlog file. */
export interface QlogFileSeqHeader {
  readonly file_schema: typeof QLOG_FILE_SCHEMA_SEQUENTIAL;
  readonly serialization_format: typeof QLOG_FORMAT_JSON_SEQ;
  readonly title?: string;
  readonly description?: string;
  /** Exactly one trace; its events follow as separate records. */
  readonly trace: QlogTraceSpec;
}

/** Optional file-level title/description. */
export interface QlogFileMeta {
  readonly title?: string;
  readonly description?: string;
}

// ─── Serialization ──────────────────────────────────────────────────

/**
 * Build a contained qlog file object.
 *
 * `JSON.stringify` it to produce a `.qlog`.
 */
export function toContainedFile(
  spec: QlogTraceSpec,
  events: readonly QlogEventRecord[],
  fileMeta: QlogFileMeta = {},
): QlogFileContained {
  return {
    file_schema: QLOG_FILE_SCHEMA_CONTAINED,
    serialization_format: QLOG_FORMAT_JSON,
    ...(fileMeta.title !== undefined ? { title: fileMeta.title } : {}),
    ...(fileMeta.description !== undefined ? { description: fileMeta.description } : {}),
    traces: [{ ...spec, events }],
  };
}

/**
 * Serialize the header record of a sequential qlog file.
 *
 * Returned already framed: RS-prefixed and LF-terminated.
 */
export function seqHeader(spec: QlogTraceSpec, fileMeta: QlogFileMeta = {}): string {
  const header: QlogFileSeqHeader = {
    file_schema: QLOG_FILE_SCHEMA_SEQUENTIAL,
    serialization_format: QLOG_FORMAT_JSON_SEQ,
    ...(fileMeta.title !== undefined ? { title: fileMeta.title } : {}),
    ...(fileMeta.description !== undefined ? { description: fileMeta.description } : {}),
    trace: spec,
  };
  return frame(header);
}

/** Serialize one event as a framed JSON-SEQ record. */
export function seqRecord(event: QlogEventRecord): string {
  return frame(event);
}

/** Serialize a complete sequential qlog file. */
export function serializeSeq(
  spec: QlogTraceSpec,
  events: readonly QlogEventRecord[],
  fileMeta: QlogFileMeta = {},
): string {
  return seqHeader(spec, fileMeta) + events.map(seqRecord).join('');
}

/**
 * RS-prefix and LF-terminate one JSON value.
 *
 * `JSON.stringify` escapes control characters below 0x20, so a literal RS can
 * never appear inside the payload and records stay unambiguously separable.
 */
function frame(value: unknown): string {
  return RS + JSON.stringify(value) + LF;
}

// ─── Parsing ────────────────────────────────────────────────────────

/** Result of parsing a sequential qlog file. */
export interface QlogSeqParseResult {
  readonly header: QlogFileSeqHeader;
  readonly events: readonly QlogEventRecord[];
  /**
   * True when the final record was cut short before its terminator and was
   * discarded — the normal outcome for a capture that stopped mid-write.
   * Completely framed but malformed records are corruption and throw.
   */
  readonly truncated: boolean;
}

/**
 * Parse a sequential qlog file.
 *
 * A **final** record missing its terminator is treated as truncation: the
 * partial record is dropped and `truncated` is set. Any record that is framed
 * completely but holds invalid JSON is corruption and throws, wherever it sits
 * — including last, since a written terminator means the record was not cut
 * short. A damaged record is therefore never silently accepted.
 */
export function parseSeq(text: string): QlogSeqParseResult {
  if (!text.startsWith(RS)) {
    throw new Error('qlog: JSON-SEQ input does not begin with a record separator');
  }

  // The leading RS produces an empty first chunk; drop it.
  const chunks = text.split(RS).slice(1);
  if (chunks.length === 0) {
    throw new Error('qlog: JSON-SEQ input contains no records');
  }

  const values: unknown[] = [];
  let truncated = false;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;

    if (!chunk.endsWith(LF)) {
      if (!isLast) {
        throw new Error(`qlog: record ${i} is missing its terminator (corrupt, not truncated)`);
      }
      truncated = true;
      continue;
    }

    // The terminator is present, so the record was written in full. Invalid
    // JSON here is corruption even when it is last — treating it as truncation
    // would silently drop a completely written event.
    try {
      values.push(JSON.parse(chunk));
    } catch (cause) {
      throw new Error(`qlog: record ${i} is not valid JSON (corrupt, not truncated)`, { cause });
    }
  }

  const [header, ...events] = values;
  if (header === undefined) {
    throw new Error('qlog: JSON-SEQ input has no header record');
  }

  return {
    header: assertSeqHeader(header),
    events: events as QlogEventRecord[],
    truncated,
  };
}

/**
 * Validate the required draft-14 sequential header envelope.
 *
 * Event payload shapes are an analyzer concern, but the parser must not hand
 * back a typed `QlogFileSeqHeader` for something that is not one.
 */
function assertSeqHeader(value: unknown): QlogFileSeqHeader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('qlog: JSON-SEQ header record is not an object');
  }
  const h = value as Record<string, unknown>;

  if (h.file_schema !== QLOG_FILE_SCHEMA_SEQUENTIAL) {
    throw new Error(`qlog: unexpected file_schema ${String(h.file_schema)}`);
  }
  // The spec treats media types case-insensitively.
  if (
    typeof h.serialization_format !== 'string' ||
    h.serialization_format.toLowerCase() !== QLOG_FORMAT_JSON_SEQ
  ) {
    throw new Error(`qlog: unexpected serialization_format ${String(h.serialization_format)}`);
  }

  const trace = h.trace;
  if (typeof trace !== 'object' || trace === null || Array.isArray(trace)) {
    throw new Error('qlog: JSON-SEQ header has no trace object');
  }
  const schemas = (trace as Record<string, unknown>).event_schemas;
  if (
    !Array.isArray(schemas) ||
    schemas.length === 0 ||
    !schemas.every(u => typeof u === 'string' && u.length > 0)
  ) {
    throw new Error('qlog: trace.event_schemas must be a non-empty array of URI strings');
  }

  // Normalize so the returned value actually matches the canonical literal
  // its type promises.
  return { ...h, serialization_format: QLOG_FORMAT_JSON_SEQ } as unknown as QlogFileSeqHeader;
}

// ─── Event log ──────────────────────────────────────────────────────

/** URI-unreserved characters, per [QLOG-MAIN] §8 namespace identifiers. */
const NAMESPACE_PATTERN = /^[A-Za-z0-9._~-]+$/;

/**
 * Validate an event name.
 *
 * [QLOG-MAIN] §8 requires `"<namespace>:<event_type>"` with a non-empty
 * namespace drawn from the URI-unreserved set and a non-empty event type. The
 * event type may itself contain colons, so only the first separator counts.
 */
export function assertEventName(name: string): void {
  const sep = name.indexOf(':');
  if (sep < 0) {
    throw new Error(`qlog: event name "${name}" must be "<namespace>:<event_type>"`);
  }
  const namespace = name.slice(0, sep);
  const eventType = name.slice(sep + 1);
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `qlog: event name "${name}" has an invalid namespace — must be non-empty and URI-unreserved`,
    );
  }
  if (eventType.length === 0) {
    throw new Error(`qlog: event name "${name}" has an empty event type`);
  }
}

/** Monotonic clock supplying trace timestamps, in milliseconds. */
export interface QlogClock {
  /** Trace-local identifier, so consumers can tell which clock timed a run. */
  readonly clock_id: string;
  readonly clock_type: 'system' | 'monotonic';
  /** Milliseconds since the trace reference point. Must be non-decreasing. */
  now(): number;
}

/**
 * Collects namespaced event records under one trace and clock.
 *
 * Deliberately unbounded: retention, eviction, and dump policy belong to the
 * recorder layer, not to the file machinery.
 */
export class QlogEventLog {
  private readonly clock: QlogClock;
  private readonly records: QlogEventRecord[] = [];
  private readonly defaultGroupId: string | undefined;

  constructor(opts: { clock: QlogClock; defaultGroupId?: string }) {
    this.clock = opts.clock;
    this.defaultGroupId = opts.defaultGroupId;
  }

  /** Identifier of the clock timing this log. */
  get clockId(): string {
    return this.clock.clock_id;
  }

  /** Events recorded so far, in insertion order. */
  get events(): readonly QlogEventRecord[] {
    return this.records;
  }

  /**
   * Record one event.
   *
   * `name` must be `"<namespace>:<event_type>"`. `groupId` overrides the log's
   * default and distinguishes, for example, transport sessions across a
   * migration within a single trace.
   */
  record(name: string, data: Record<string, unknown>, groupId?: string): void {
    assertEventName(name);
    const group = groupId ?? this.defaultGroupId;
    this.records.push({
      time: this.clock.now(),
      name,
      data,
      ...(group !== undefined ? { group_id: group } : {}),
    });
  }

  /** Namespaces observed so far, derived from recorded event names. */
  namespaces(): readonly string[] {
    const seen = new Set<string>();
    for (const r of this.records) seen.add(r.name.slice(0, r.name.indexOf(':')));
    return [...seen];
  }
}
