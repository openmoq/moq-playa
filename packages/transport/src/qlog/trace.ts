/**
 * QlogTrace — collects qlog events and exports as JSON per [QLOG-MAIN].
 *
 * Usage:
 * ```
 * const trace = new QlogTrace('session-123');
 * trace.record(event);          // add events
 * const json = trace.toJSON();  // export as spec-compliant object
 * console.log(trace.toString());// export as JSON string
 * ```
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §1
 * @see [QLOG-MAIN] draft-ietf-quic-qlog-main-schema
 * @module
 */

import type { ControlMessage } from '../control/messages.js';
import type { QlogEvent, QlogExtensionHeader } from './types.js';

// ─── Exported Types ─────────────────────────────────────────────────

/**
 * A single timestamped qlog event in the trace.
 * @see [QLOG-MAIN] §3.3
 */
export interface QlogTraceEvent {
  /** Milliseconds since trace start (relative time). */
  readonly time: number;
  /** Event name in "moqt:<event_type>" format. */
  readonly name: string;
  /** Event data. */
  readonly data: Record<string, unknown>;
}

/**
 * Complete qlog JSON output per [QLOG-MAIN].
 *
 * Schema URI: urn:ietf:params:qlog:events:moqt-04
 * @see [QLOG-MAIN] §3.1
 */
export interface QlogTraceJson {
  readonly qlog_version: '0.4';
  readonly qlog_format: 'JSON';
  readonly title?: string;
  readonly traces: readonly [QlogTraceEntry];
}

/** A single trace entry within the qlog output. */
export interface QlogTraceEntry {
  readonly common_fields: {
    readonly group_id: string;
    readonly protocol_type: readonly ['moqt'];
  };
  readonly vantage_point: {
    readonly type: 'client';
  };
  readonly events: readonly QlogTraceEvent[];
}

// ─── ControlMessage → qlog $MOQTControlMessage ─────────────────────

/**
 * Convert a ControlMessage to the qlog $MOQTControlMessage format.
 *
 * Maps our UPPER_CASE type discriminants to the lowercase names
 * defined in draft-pardue-moq-qlog-moq-events-06 §5.6.
 *
 * Byte arrays (trackNamespace, trackName) are converted to the
 * MOQTByteString format: `{ value: string }` for UTF-8 decodable
 * strings, or `{ value_bytes: hexstring }` for raw bytes.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.6
 */
function controlMessageToQlog(msg: ControlMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: msg.type.toLowerCase(),
  };

  // Add common fields based on what's present on the message
  if ('requestId' in msg && msg.requestId !== undefined) {
    result.request_id = bigintToNumber(msg.requestId);
  }
  if ('trackAlias' in msg && msg.trackAlias !== undefined) {
    result.track_alias = bigintToNumber(msg.trackAlias);
  }
  if ('errorCode' in msg && msg.errorCode !== undefined) {
    result.error_code = bigintToNumber(msg.errorCode);
  }
  if ('errorReason' in msg && msg.errorReason !== undefined) {
    result.reason = msg.errorReason;
  }
  if ('trackNamespace' in msg && msg.trackNamespace !== undefined) {
    result.track_namespace = (msg.trackNamespace as Uint8Array[]).map(byteStringToQlog);
  }
  if ('trackName' in msg && msg.trackName !== undefined) {
    result.track_name = byteStringToQlog(msg.trackName as Uint8Array);
  }
  if ('trackNamespaceSuffix' in msg && msg.trackNamespaceSuffix !== undefined) {
    result.track_namespace_suffix = (msg.trackNamespaceSuffix as Uint8Array[]).map(byteStringToQlog);
  }
  if ('trackNamespacePrefix' in msg && msg.trackNamespacePrefix !== undefined) {
    result.track_namespace_prefix = (msg.trackNamespacePrefix as Uint8Array[]).map(byteStringToQlog);
  }
  if ('newSessionUri' in msg && msg.newSessionUri !== undefined) {
    result.new_session_uri = { payload_length: msg.newSessionUri.length };
  }
  if ('statusCode' in msg && msg.statusCode !== undefined) {
    result.status_code = bigintToNumber(msg.statusCode);
  }
  if ('streamCount' in msg && msg.streamCount !== undefined) {
    result.stream_count = bigintToNumber(msg.streamCount);
  }
  if ('maxRequestId' in msg && msg.maxRequestId !== undefined) {
    result.request_id = bigintToNumber(msg.maxRequestId);
  }
  if ('maximumRequestId' in msg && msg.maximumRequestId !== undefined) {
    result.maximum_request_id = bigintToNumber(msg.maximumRequestId);
  }
  if ('existingRequestId' in msg && msg.existingRequestId !== undefined) {
    result.subscription_request_id = bigintToNumber(msg.existingRequestId);
  }
  if ('retryInterval' in msg && msg.retryInterval !== undefined) {
    result.retry_interval = bigintToNumber(msg.retryInterval);
  }
  if ('endOfTrack' in msg && msg.endOfTrack !== undefined) {
    result.end_of_track = msg.endOfTrack;
  }

  return result;
}

/**
 * Convert a Uint8Array to qlog MOQTByteString format (§5.4).
 *
 * Attempts UTF-8 decode; falls back to hex if invalid.
 * @see draft-pardue-moq-qlog-moq-events-06 §5.4
 */
function byteStringToQlog(bytes: Uint8Array): { value?: string; value_bytes?: string } {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { value };
  } catch {
    return { value_bytes: bytesToHex(bytes) };
  }
}

/** Convert a Uint8Array to a hex string. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Safely convert bigint to number for JSON (qlog uses uint64 as number). */
function bigintToNumber(v: bigint | number): number {
  return typeof v === 'number' ? v : Number(v);
}

// ─── Event Serialization ────────────────────────────────────────────

/**
 * Convert a QlogEvent to its JSON-serializable data representation.
 *
 * - bigint → number (JSON doesn't support bigint)
 * - ControlMessage → $MOQTControlMessage format
 * - Extension headers → qlog format
 */
function eventToData(event: QlogEvent): Record<string, unknown> {
  switch (event.type) {
    case 'control_message_created':
    case 'control_message_parsed': {
      const data: Record<string, unknown> = {
        stream_id: bigintToNumber(event.stream_id),
        message: controlMessageToQlog(event.message),
      };
      if (event.length !== undefined) data.length = event.length;
      if (event.raw !== undefined) data.raw = event.raw;
      return data;
    }

    case 'stream_type_set': {
      const data: Record<string, unknown> = {
        stream_id: bigintToNumber(event.stream_id),
        stream_type: event.stream_type,
      };
      if (event.owner !== undefined) data.owner = event.owner;
      return data;
    }

    case 'object_datagram_parsed': {
      const data: Record<string, unknown> = {
        track_alias: bigintToNumber(event.track_alias),
        group_id: bigintToNumber(event.group_id),
        end_of_group: event.end_of_group,
      };
      // -06 §4.5: publisher_priority optional (inherits from subscription)
      if (event.publisher_priority !== undefined) data.publisher_priority = event.publisher_priority;
      if (event.object_id !== undefined) data.object_id = bigintToNumber(event.object_id);
      if (event.extension_headers_length !== undefined) data.extension_headers_length = event.extension_headers_length;
      if (event.extension_headers !== undefined) data.extension_headers = event.extension_headers.map(extensionHeaderToJson);
      if (event.object_status !== undefined) data.object_status = bigintToNumber(event.object_status);
      if (event.object_payload !== undefined) data.object_payload = event.object_payload;
      return data;
    }

    case 'subgroup_header_parsed': {
      // -06 §4.7: subgroup_id_mode required, publisher_priority optional
      const data: Record<string, unknown> = {
        stream_id: bigintToNumber(event.stream_id),
        track_alias: bigintToNumber(event.track_alias),
        group_id: bigintToNumber(event.group_id),
        subgroup_id_mode: event.subgroup_id_mode,
        contains_end_of_group: event.contains_end_of_group,
        extensions_present: event.extensions_present,
      };
      if (event.subgroup_id !== undefined) data.subgroup_id = bigintToNumber(event.subgroup_id);
      if (event.publisher_priority !== undefined) data.publisher_priority = event.publisher_priority;
      return data;
    }

    case 'subgroup_object_parsed': {
      // -06 §4.9: object_id_delta replaces object_id; group_id, subgroup_id,
      // extension_headers_length removed
      const data: Record<string, unknown> = {
        stream_id: bigintToNumber(event.stream_id),
        object_id_delta: bigintToNumber(event.object_id_delta),
        object_payload_length: event.object_payload_length,
      };
      if (event.extension_headers !== undefined) data.extension_headers = event.extension_headers.map(extensionHeaderToJson);
      if (event.object_status !== undefined) data.object_status = bigintToNumber(event.object_status);
      if (event.object_payload !== undefined) data.object_payload = event.object_payload;
      return data;
    }

    case 'fetch_header_parsed': {
      return {
        stream_id: bigintToNumber(event.stream_id),
        request_id: bigintToNumber(event.request_id),
      };
    }

    case 'fetch_object_parsed': {
      // -06 §4.13: datagram, end_of_nonexistent_range, end_of_unknown_range required;
      // group_id, subgroup_id, object_id, publisher_priority, extension_headers_length optional
      const data: Record<string, unknown> = {
        stream_id: bigintToNumber(event.stream_id),
        datagram: event.datagram,
        end_of_nonexistent_range: event.end_of_nonexistent_range,
        end_of_unknown_range: event.end_of_unknown_range,
        object_payload_length: event.object_payload_length,
      };
      if (event.subgroup_id_bits !== undefined) data.subgroup_id_bits = event.subgroup_id_bits;
      if (event.group_id !== undefined) data.group_id = bigintToNumber(event.group_id);
      if (event.subgroup_id !== undefined) data.subgroup_id = bigintToNumber(event.subgroup_id);
      if (event.object_id !== undefined) data.object_id = bigintToNumber(event.object_id);
      if (event.publisher_priority !== undefined) data.publisher_priority = event.publisher_priority;
      if (event.extension_headers_length !== undefined) data.extension_headers_length = event.extension_headers_length;
      if (event.extension_headers !== undefined) data.extension_headers = event.extension_headers.map(extensionHeaderToJson);
      if (event.object_status !== undefined) data.object_status = bigintToNumber(event.object_status);
      if (event.object_payload !== undefined) data.object_payload = event.object_payload;
      return data;
    }
  }
}

/** Convert a QlogExtensionHeader to JSON-serializable format. */
function extensionHeaderToJson(h: QlogExtensionHeader): Record<string, unknown> {
  const result: Record<string, unknown> = {
    header_type: bigintToNumber(h.header_type),
  };
  if (h.header_value !== undefined) result.header_value = bigintToNumber(h.header_value);
  if (h.header_length !== undefined) result.header_length = bigintToNumber(h.header_length);
  if (h.payload !== undefined) result.payload = h.payload;
  return result;
}

// ─── QlogTrace ──────────────────────────────────────────────────────

/**
 * Collects qlog events and exports as JSON per [QLOG-MAIN].
 *
 * Timestamps are relative to trace construction time using an
 * injectable clock (defaults to `performance.now()`).
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §1
 * @see [QLOG-MAIN] draft-ietf-quic-qlog-main-schema
 */
export class QlogTrace {
  private readonly events: QlogTraceEvent[] = [];
  private readonly startTime: number;

  /**
   * @param sessionId Globally unique session identifier (used as group_id).
   * @param clock Injectable time source returning milliseconds. Defaults to performance.now().
   */
  constructor(
    private readonly sessionId: string,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.startTime = this.clock();
  }

  /**
   * Record a qlog event with current timestamp.
   *
   * The event is timestamped relative to trace start and stored
   * for later export via toJSON()/toString().
   */
  record(event: QlogEvent): void {
    const time = this.clock() - this.startTime;
    this.events.push({
      time,
      name: `moqt:${event.type}`,
      data: eventToData(event),
    });
  }

  /**
   * Export as qlog JSON object per [QLOG-MAIN].
   *
   * Output structure:
   * - qlog_version: "0.4"
   * - qlog_format: "JSON"
   * - traces[0].common_fields.protocol_type: ["moqt"]
   * - traces[0].vantage_point.type: "client"
   * - traces[0].events: recorded events with moqt: namespace
   *
   * @see [QLOG-MAIN] §3.1
   */
  toJSON(): QlogTraceJson {
    return {
      qlog_version: '0.4',
      qlog_format: 'JSON',
      traces: [{
        common_fields: {
          group_id: this.sessionId,
          protocol_type: ['moqt'] as const,
        },
        vantage_point: {
          type: 'client' as const,
        },
        events: [...this.events],
      }],
    };
  }

  /**
   * Export as JSON string.
   *
   * Uses 2-space indentation for human readability.
   */
  toString(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /** Number of recorded events. */
  get length(): number {
    return this.events.length;
  }

  /** Clear all recorded events. Timestamps continue from original start time. */
  clear(): void {
    this.events.length = 0;
  }
}
