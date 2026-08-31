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

import type {
  ControlMessage,
  ParameterValue,
  TrackProperties,
} from '../control/messages.js';
import type { Location } from '../primitives/location.js';
import type { QlogEvent, QlogExtensionHeader } from './types.js';
import { serializeSeq, toContainedFile } from './file.js';
import type { QlogEventRecord, QlogFileContained, QlogTraceSpec } from './file.js';

/**
 * Event schema URI for the MOQT namespace.
 *
 * Pinned to -06 because that is the revision `types.ts` and this serializer
 * implement. Do not advance it without an event-by-event audit.
 *
 * @see draft-pardue-moq-qlog-moq-events-06
 */
export const MOQT_EVENT_SCHEMA = 'urn:ietf:params:qlog:events:moqt-06';

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
 * Schema URI: urn:ietf:params:qlog:events:moqt-06
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
    result.request_id = qlogUint64(msg.requestId);
  }
  if ('trackAlias' in msg && msg.trackAlias !== undefined) {
    result.track_alias = qlogUint64(msg.trackAlias);
  }
  if ('errorCode' in msg && msg.errorCode !== undefined) {
    result.error_code = qlogUint64(msg.errorCode);
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
    // RawInfo.payload_length counts wire bytes, not UTF-16 code units.
    result.new_session_uri = rawInfo(new TextEncoder().encode(msg.newSessionUri).length);
  }
  if ('statusCode' in msg && msg.statusCode !== undefined) {
    result.status_code = qlogUint64(msg.statusCode);
  }
  if ('streamCount' in msg && msg.streamCount !== undefined) {
    result.stream_count = qlogUint64(msg.streamCount);
  }
  if ('maxRequestId' in msg && msg.maxRequestId !== undefined) {
    result.request_id = qlogUint64(msg.maxRequestId);
  }
  if ('maximumRequestId' in msg && msg.maximumRequestId !== undefined) {
    result.maximum_request_id = qlogUint64(msg.maximumRequestId);
  }
  if ('existingRequestId' in msg && msg.existingRequestId !== undefined) {
    result.existing_request_id = qlogUint64(msg.existingRequestId);
  }
  if ('retryInterval' in msg && msg.retryInterval !== undefined) {
    result.retry_interval = qlogUint64(msg.retryInterval);
  }
  if ('endOfTrack' in msg && msg.endOfTrack !== undefined) {
    result.end_of_track = msg.endOfTrack;
  }

  // FETCH: -06 requires `fetch_type` and nests the variant-specific fields.
  if ('fetch' in msg && msg.fetch !== undefined) {
    const f = msg.fetch;
    result.fetch_type = FETCH_TYPE_NAMES[f.fetchType] ?? String(f.fetchType);
    if (f.fetchType === 0x1) {
      result.standalone_fetch = {
        track_namespace: f.trackNamespace.map(byteStringToQlog),
        track_name: byteStringToQlog(f.trackName),
        start_location: locationToQlog(f.startLocation),
        end_location: locationToQlog(f.endLocation),
      };
    } else {
      result.joining_fetch = {
        joining_request_id: qlogUint64(f.joiningRequestId),
        joining_start: qlogUint64(f.joiningStart),
      };
    }
  }
  if ('endLocation' in msg && msg.endLocation !== undefined) {
    result.end_location = locationToQlog(msg.endLocation);
  }

  // draft-18 Track Properties map onto -06 `track_extensions`.
  const properties = ('trackProperties' in msg ? msg.trackProperties : undefined)
    ?? ('trackExtensions' in msg ? msg.trackExtensions : undefined);
  if (properties !== undefined) {
    result.track_extensions = trackPropertiesToQlog(properties);
  }

  // Fields our transport drafts carry that -06 does not define. Emitting them
  // under standardized-looking names would misrepresent the message, and
  // dropping them would lose diagnostics, so they are kept and marked.
  const unmapped: Record<string, unknown> = {};
  if ('requestKind' in msg && msg.requestKind !== undefined) {
    unmapped.request_kind = String(msg.requestKind);
  }
  if ('subscribeOptions' in msg && msg.subscribeOptions !== undefined) {
    const name = SUBSCRIBE_OPTIONS_NAMES.get(msg.subscribeOptions);
    if (name !== undefined) {
      result.subscribe_options = name;
    } else {
      unmapped.subscribe_options = qlogUint64(msg.subscribeOptions);
    }
  }
  if ('timeout' in msg && msg.timeout !== undefined) {
    unmapped.timeout = qlogUint64(msg.timeout as bigint);
  }
  if ('redirect' in msg && msg.redirect !== undefined) {
    // draft-18 §10.6.2 Redirect has no -06 representation. Keep its detail: a
    // bare boolean would drop the target the operator needs to follow.
    const r = msg.redirect;
    unmapped.redirect = {
      connect_uri: rawInfo(r.connectUri.length),
      track_namespace: r.trackNamespace.map(byteStringToQlog),
      track_name: byteStringToQlog(r.trackName),
    };
  }
  if (Object.keys(unmapped).length > 0) {
    result.playa_unmapped = unmapped;
  }

  // Parameter-bearing messages require `number_of_parameters` in -06; setup
  // messages name the list `setup_parameters`, everything else `parameters`.
  if ('parameters' in msg && msg.parameters !== undefined) {
    const setup = isSetup(msg);
    const entries = parametersToQlog(msg.parameters, setup ? 'setup' : 'message');
    result.number_of_parameters = entries.length;
    result[setup ? 'setup_parameters' : 'parameters'] = entries;
  } else if ('setupOptions' in msg && msg.setupOptions !== undefined) {
    // draft-18 SETUP carries Setup Options rather than a parameter map.
    const entries = parametersToQlog(msg.setupOptions, 'setup');
    result.number_of_parameters = entries.length;
    result.setup_parameters = entries;
  }

  return conformOrPrivatize(result);
}

/**
 * The concrete shape of every standardized -06 control message.
 *
 * Derived field-by-field from the CDDL in §5.7 (`required` omits the `type`
 * discriminant itself). Checking both directions makes the policy fail closed:
 * a message is private if it lacks a required field *or* carries one the
 * concrete definition does not have. The latter matters because our transport
 * union spans drafts 14, 16, and 18 — a newer-draft message can have a
 * recognized discriminant and still not be a faithful instance of the -06
 * alternative of that name.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.7
 */
const MOQT06_SHAPES: ReadonlyMap<string, { required: readonly string[]; allowed: readonly string[] }> =
  new Map([
  ['client_setup', {
    required: ['number_of_parameters'],
    allowed: ['number_of_parameters', 'setup_parameters'],
  }],
  ['server_setup', {
    required: ['number_of_parameters'],
    allowed: ['number_of_parameters', 'setup_parameters'],
  }],
  ['goaway', {
    required: ['new_session_uri'],
    allowed: ['new_session_uri'],
  }],
  ['max_request_id', {
    required: ['request_id'],
    allowed: ['request_id'],
  }],
  ['requests_blocked', {
    required: ['maximum_request_id'],
    allowed: ['maximum_request_id'],
  }],
  ['request_ok', {
    required: ['request_id', 'number_of_parameters'],
    allowed: ['request_id', 'number_of_parameters', 'parameters'],
  }],
  ['request_error', {
    required: ['request_id', 'error_code', 'retry_interval'],
    allowed: ['request_id', 'error_code', 'retry_interval', 'reason', 'reason_bytes'],
  }],
  ['subscribe', {
    required: ['request_id', 'track_namespace', 'track_name', 'number_of_parameters'],
    allowed: ['request_id', 'track_namespace', 'track_name', 'number_of_parameters', 'parameters'],
  }],
  ['subscribe_ok', {
    required: ['request_id', 'track_alias', 'number_of_parameters'],
    allowed: ['request_id', 'track_alias', 'number_of_parameters', 'parameters', 'track_extensions'],
  }],
  ['request_update', {
    required: ['request_id', 'existing_request_id', 'number_of_parameters'],
    allowed: ['request_id', 'existing_request_id', 'number_of_parameters', 'parameters'],
  }],
  ['unsubscribe', {
    required: ['request_id'],
    allowed: ['request_id'],
  }],
  ['publish', {
    required: ['request_id', 'track_namespace', 'track_name', 'track_alias', 'number_of_parameters'],
    allowed: ['request_id', 'track_namespace', 'track_name', 'track_alias', 'number_of_parameters', 'parameters', 'track_extensions'],
  }],
  ['publish_ok', {
    required: ['request_id', 'number_of_parameters'],
    allowed: ['request_id', 'number_of_parameters', 'parameters'],
  }],
  ['publish_done', {
    required: ['request_id', 'status_code', 'stream_count'],
    allowed: ['request_id', 'status_code', 'stream_count', 'reason', 'reason_bytes'],
  }],
  ['fetch', {
    required: ['request_id', 'fetch_type', 'number_of_parameters'],
    allowed: ['request_id', 'fetch_type', 'number_of_parameters', 'standalone_fetch', 'joining_fetch', 'parameters'],
  }],
  ['fetch_ok', {
    required: ['request_id', 'end_of_track', 'end_location', 'number_of_parameters'],
    allowed: ['request_id', 'end_of_track', 'end_location', 'number_of_parameters', 'parameters', 'track_extensions'],
  }],
  ['fetch_cancel', {
    required: ['request_id'],
    allowed: ['request_id'],
  }],
  ['track_status', {
    required: ['request_id', 'track_namespace', 'track_name', 'number_of_parameters'],
    allowed: ['request_id', 'track_namespace', 'track_name', 'number_of_parameters', 'parameters'],
  }],
  ['publish_namespace', {
    required: ['request_id', 'track_namespace', 'number_of_parameters'],
    allowed: ['request_id', 'track_namespace', 'number_of_parameters', 'parameters'],
  }],
  ['namespace', {
    required: ['track_namespace_suffix'],
    allowed: ['track_namespace_suffix'],
  }],
  ['publish_namespace_done', {
    required: ['request_id'],
    allowed: ['request_id'],
  }],
  ['namespace_done', {
    required: ['track_namespace_suffix'],
    allowed: ['track_namespace_suffix'],
  }],
  ['publish_namespace_cancel', {
    required: ['request_id', 'error_code'],
    allowed: ['request_id', 'error_code', 'reason', 'reason_bytes'],
  }],
  ['subscribe_namespace', {
    required: ['request_id', 'track_namespace_prefix', 'subscribe_options', 'number_of_parameters'],
    allowed: ['request_id', 'track_namespace_prefix', 'subscribe_options', 'number_of_parameters', 'parameters'],
  }],
]);

/**
 * Keep standardized type names honest.
 *
 * We support transport drafts 14, 16, and 18 while -06 tracks a single
 * revision, so a semantically valid message can lack a field the standardized
 * definition of the same name requires — draft-14 `PUBLISH_NAMESPACE_DONE`
 * carries a Track Namespace where -06 requires a Request ID. Presenting that
 * as the recognized structure would misrepresent it, and dropping it would
 * lose the diagnostic, so the type is marked private and the reason recorded.
 */
function conformOrPrivatize(result: Record<string, unknown>): Record<string, unknown> {
  const type = result.type as string;

  const shape = MOQT06_SHAPES.get(type);
  if (shape === undefined) {
    return { ...result, type: `playa_${type}`, playa_reason: 'not defined by moqt-06' };
  }

  const present = Object.keys(result).filter(k => k !== 'type' && result[k] !== undefined);
  const missing = shape.required.filter(field => result[field] === undefined);
  // Name the fields that actually caused this, not the container they sit in.
  const extra = present
    .filter(field => !shape.allowed.includes(field))
    .flatMap(field =>
      field === 'playa_unmapped'
        ? Object.keys(result.playa_unmapped as Record<string, unknown>)
        : [field],
    );

  if (missing.length === 0 && extra.length === 0) return result;

  const reason = [
    missing.length > 0 ? `missing moqt-06 required field(s): ${missing.join(', ')}` : '',
    extra.length > 0 ? `field(s) outside the moqt-06 shape: ${extra.join(', ')}` : '',
  ].filter(Boolean).join('; ');

  return { ...result, type: `playa_${type}`, playa_reason: reason };
}

/**
 * Subscribe Options values to their -06 `$MOQTSubscribeOptions` names.
 *
 * Values per transport draft-16 §9.25: PUBLISH = 0x00, NAMESPACE = 0x01,
 * both = 0x02. An unrecognized value falls through to `playa_unmapped`.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.7.24
 */
const SUBSCRIBE_OPTIONS_NAMES: ReadonlyMap<bigint, string> = new Map([
  [0x00n, 'publish'],
  [0x01n, 'namespace'],
  [0x02n, 'both'],
]);

/** Fetch Type code to the -06 `$MOQTFetchType` name. */
const FETCH_TYPE_NAMES: Record<number, string> = {
  0x1: 'standalone',
  0x2: 'relative_joining',
  0x3: 'absolute_joining',
};

/** Convert a Location to the -06 `MOQTLocation` form. */
function locationToQlog(loc: Location): Record<string, unknown> {
  return { group: qlogUint64(loc.group), object: qlogUint64(loc.object) };
}

/**
 * Convert draft-18 Track Properties to -06 `track_extensions`.
 *
 * Even Property Types carry an integer (`header_value`); odd Types carry bytes
 * (`payload`).
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.7 (MOQTExtensionHeader)
 */
function trackPropertiesToQlog(props: TrackProperties): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [type, values] of props) {
    for (const value of values) {
      out.push(
        value instanceof Uint8Array
          ? { header_type: qlogUint64(type), payload: { payload_length: value.length } }
          : { header_type: qlogUint64(type), header_value: qlogUint64(value) },
      );
    }
  }
  return out;
}

/** True for the messages whose parameter list -06 names `setup_parameters`. */
function isSetup(msg: ControlMessage): boolean {
  return msg.type === 'CLIENT_SETUP' || msg.type === 'SERVER_SETUP' || msg.type === 'SETUP';
}

/**
 * Setup parameter types to their -06 names.
 *
 * The wire type is the protocol registry key, so this is a lookup, not an
 * inference. Types whose -06 shape we cannot faithfully produce (notably
 * `authorization_token`, whose definition requires an `alias_type` we do not
 * decode) are deliberately absent and fall through to the `unknown` form.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.4
 */
const SETUP_PARAM_NAMES: ReadonlyMap<bigint, { name: string; text?: boolean }> = new Map([
  [0x01n, { name: 'path', text: true }],
  [0x02n, { name: 'max_request_id' }],
  [0x04n, { name: 'max_auth_token_cache_size' }],
  [0x05n, { name: 'authority', text: true }],
  [0x07n, { name: 'implementation', text: true }],
]);

/**
 * Message parameter types to their -06 names.
 *
 * Absent by design: `authorization_token` (0x03) and `subscription_filter`
 * (0x21) have structured -06 values we cannot produce without more negotiated
 * context, and `rendezvous_timeout` (0x04), `subgroup_delivery_timeout`
 * (0x06), `fill_timeout` (0x0a), and `track_namespace_prefix` (0x34) have no
 * -06 definition at all. Those use the `unknown` form. Known scalars are not
 * relabelled unknown merely because their neighbours need more context.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.5
 */
const MESSAGE_PARAM_NAMES: ReadonlyMap<bigint, { name: string; location?: boolean }> = new Map([
  [0x02n, { name: 'delivery_timeout' }],
  [0x08n, { name: 'expires' }],
  [0x09n, { name: 'largest_object', location: true }],
  [0x10n, { name: 'forward' }],
  [0x20n, { name: 'subscriber_priority' }],
  [0x22n, { name: 'group_order' }],
  [0x32n, { name: 'new_group_request' }],
]);

/** RawInfo for a byte string we do not reproduce verbatim. */
function rawInfo(byteLength: number): Record<string, unknown> {
  return { length: byteLength, payload_length: byteLength };
}

/** True for a Location-shaped parameter value. */
function isLocation(v: ParameterValue): v is Location {
  return typeof v === 'object' && v !== null && !ArrayBuffer.isView(v) && !Array.isArray(v);
}

/**
 * Convert one parameter value to the `unknown` parameter form.
 *
 * `$MOQTUnknownParameter` carries `name_bytes` plus an optional scalar `value`
 * or `value_bytes` RawInfo. Values it cannot express — a Location or a Track
 * Namespace — are additionally carried under a clearly private `playa_value`
 * so the diagnostic is not lost while the standard fields stay correct.
 */
function unknownParameter(type: bigint, value: ParameterValue): Record<string, unknown> {
  const out: Record<string, unknown> = { name: 'unknown', name_bytes: qlogUint64(type) };
  if (typeof value === 'bigint') {
    out.value = qlogUint64(value);
  } else if (value instanceof Uint8Array) {
    out.value_bytes = rawInfo(value.length);
  } else if (isLocation(value)) {
    out.playa_value = locationToQlog(value);
  } else {
    // NamespaceTuple — a list of namespace fields.
    const fields = value as readonly Uint8Array[];
    out.playa_value = { track_namespace: fields.map(byteStringToQlog) };
  }
  return out;
}

/**
 * Convert a parameter or Setup Option map to qlog `$MOQTParameter` entries.
 *
 * Recognized types use their registered -06 name and value shape; everything
 * else uses the specified `unknown` form rather than a plausible-looking
 * invention. A type permitting repeated values contributes one entry per
 * value, so the emitted count matches the wire.
 *
 * @see draft-pardue-moq-qlog-moq-events-06 §5.4, §5.5
 */
function parametersToQlog(
  params: ReadonlyMap<bigint, readonly ParameterValue[]>,
  kind: 'setup' | 'message',
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [type, values] of params) {
    for (const value of values) {
      out.push(convertParameter(type, value, kind));
    }
  }
  return out;
}

function convertParameter(
  type: bigint,
  value: ParameterValue,
  kind: 'setup' | 'message',
): Record<string, unknown> {
  if (kind === 'setup') {
    const known = SETUP_PARAM_NAMES.get(type);
    if (known === undefined) return unknownParameter(type, value);
    if (known.text) {
      if (!(value instanceof Uint8Array)) return unknownParameter(type, value);
      // qlog is emitted before semantic session handling, so malformed bytes
      // can reach here. A lossy decode would silently change the observed
      // bytes and claim a valid standard text value.
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
        return { name: known.name, value: text };
      } catch {
        return unknownParameter(type, value);
      }
    }
    if (typeof value !== 'bigint') return unknownParameter(type, value);
    return { name: known.name, value: qlogUint64(value) };
  }

  const known = MESSAGE_PARAM_NAMES.get(type);
  if (known === undefined) return unknownParameter(type, value);
  if (known.location) {
    if (!isLocation(value)) return unknownParameter(type, value);
    return { name: known.name, value: locationToQlog(value) };
  }
  if (typeof value !== 'bigint') return unknownParameter(type, value);
  return { name: known.name, value: qlogUint64(value) };
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

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Serialize a uint64 for JSON output.
 *
 * Values through `Number.MAX_SAFE_INTEGER` are emitted as JSON numbers.
 * Larger values cannot round-trip through a double, so they are emitted as
 * decimal strings; parsers accept either form.
 *
 * @see [QLOG-MAIN] §11.3 (uint64 and I-JSON)
 */
function qlogUint64(v: bigint | number): number | string {
  if (typeof v === 'number') return v;
  return v > MAX_SAFE_BIGINT ? v.toString(10) : Number(v);
}

// ─── Event Serialization ────────────────────────────────────────────

/**
 * Convert a QlogEvent to its JSON-serializable data representation.
 *
 * - bigint → number, or decimal string above 2^53-1 (JSON has no bigint)
 * - ControlMessage → $MOQTControlMessage format
 * - Extension headers → qlog format
 */
function eventToData(event: QlogEvent): Record<string, unknown> {
  switch (event.type) {
    case 'control_message_created':
    case 'control_message_parsed': {
      const data: Record<string, unknown> = {
        stream_id: qlogUint64(event.stream_id),
        message: controlMessageToQlog(event.message),
      };
      if (event.length !== undefined) data.length = event.length;
      if (event.raw !== undefined) data.raw = event.raw;
      return data;
    }

    case 'stream_type_set': {
      const data: Record<string, unknown> = {
        stream_id: qlogUint64(event.stream_id),
        stream_type: event.stream_type,
      };
      if (event.owner !== undefined) data.owner = event.owner;
      return data;
    }

    case 'object_datagram_parsed': {
      const data: Record<string, unknown> = {
        track_alias: qlogUint64(event.track_alias),
        group_id: qlogUint64(event.group_id),
        end_of_group: event.end_of_group,
      };
      // -06 §4.5: publisher_priority optional (inherits from subscription)
      if (event.publisher_priority !== undefined) data.publisher_priority = event.publisher_priority;
      if (event.object_id !== undefined) data.object_id = qlogUint64(event.object_id);
      if (event.extension_headers_length !== undefined) data.extension_headers_length = event.extension_headers_length;
      if (event.extension_headers !== undefined) data.extension_headers = event.extension_headers.map(extensionHeaderToJson);
      if (event.object_status !== undefined) data.object_status = qlogUint64(event.object_status);
      if (event.object_payload !== undefined) data.object_payload = event.object_payload;
      return data;
    }

    case 'subgroup_header_parsed': {
      // -06 §4.7: subgroup_id_mode required, publisher_priority optional
      const data: Record<string, unknown> = {
        stream_id: qlogUint64(event.stream_id),
        track_alias: qlogUint64(event.track_alias),
        group_id: qlogUint64(event.group_id),
        subgroup_id_mode: event.subgroup_id_mode,
        contains_end_of_group: event.contains_end_of_group,
        extensions_present: event.extensions_present,
      };
      if (event.subgroup_id !== undefined) data.subgroup_id = qlogUint64(event.subgroup_id);
      if (event.publisher_priority !== undefined) data.publisher_priority = event.publisher_priority;
      return data;
    }

    case 'subgroup_object_parsed': {
      // -06 §4.9: object_id_delta replaces object_id; group_id, subgroup_id,
      // extension_headers_length removed
      const data: Record<string, unknown> = {
        stream_id: qlogUint64(event.stream_id),
        object_id_delta: qlogUint64(event.object_id_delta),
        object_payload_length: event.object_payload_length,
      };
      if (event.extension_headers !== undefined) data.extension_headers = event.extension_headers.map(extensionHeaderToJson);
      if (event.object_status !== undefined) data.object_status = qlogUint64(event.object_status);
      if (event.object_payload !== undefined) data.object_payload = event.object_payload;
      return data;
    }

    case 'fetch_header_parsed': {
      return {
        stream_id: qlogUint64(event.stream_id),
        request_id: qlogUint64(event.request_id),
      };
    }

    case 'fetch_object_parsed': {
      // -06 §4.13: datagram, end_of_nonexistent_range, end_of_unknown_range required;
      // group_id, subgroup_id, object_id, publisher_priority, extension_headers_length optional
      const data: Record<string, unknown> = {
        stream_id: qlogUint64(event.stream_id),
        datagram: event.datagram,
        end_of_nonexistent_range: event.end_of_nonexistent_range,
        end_of_unknown_range: event.end_of_unknown_range,
        object_payload_length: event.object_payload_length,
      };
      if (event.subgroup_id_bits !== undefined) data.subgroup_id_bits = event.subgroup_id_bits;
      if (event.group_id !== undefined) data.group_id = qlogUint64(event.group_id);
      if (event.subgroup_id !== undefined) data.subgroup_id = qlogUint64(event.subgroup_id);
      if (event.object_id !== undefined) data.object_id = qlogUint64(event.object_id);
      if (event.publisher_priority !== undefined) data.publisher_priority = event.publisher_priority;
      if (event.extension_headers_length !== undefined) data.extension_headers_length = event.extension_headers_length;
      if (event.extension_headers !== undefined) data.extension_headers = event.extension_headers.map(extensionHeaderToJson);
      if (event.object_status !== undefined) data.object_status = qlogUint64(event.object_status);
      if (event.object_payload !== undefined) data.object_payload = event.object_payload;
      return data;
    }
  }
}

/** Convert a QlogExtensionHeader to JSON-serializable format. */
function extensionHeaderToJson(h: QlogExtensionHeader): Record<string, unknown> {
  const result: Record<string, unknown> = {
    header_type: qlogUint64(h.header_type),
  };
  if (h.header_value !== undefined) result.header_value = qlogUint64(h.header_value);
  if (h.header_length !== undefined) result.header_length = qlogUint64(h.header_length);
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
   * Export in the legacy qlog 0.4 shape.
   *
   * Retained unchanged for existing consumers. That shape predates the
   * current schema — it carries `qlog_version`/`protocol_type` where draft-14
   * expects `file_schema`, `serialization_format`, and a per-trace
   * `event_schemas` array — so new code should use {@link toContained} or
   * {@link toSeq}.
   *
   * @deprecated Use {@link toContained} (`.qlog`) or {@link toSeq} (`.sqlog`).
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
   * Export as JSON string in the legacy 0.4 shape.
   *
   * Uses 2-space indentation for human readability.
   *
   * @deprecated Use {@link toContained} or {@link toSeq}.
   */
  toString(): string {
    return JSON.stringify(this.toJSON(), null, 2);
  }

  /**
   * Trace declaration for the current schema.
   *
   * The session identifier is the trace-wide `group_id`, per MOQT qlog -06
   * §1.1, so events from separate sessions stay distinguishable when several
   * are logged together.
   */
  traceSpec(): QlogTraceSpec {
    return {
      event_schemas: [MOQT_EVENT_SCHEMA],
      vantage_point: { type: 'client' },
      common_fields: {
        group_id: this.sessionId,
        time_format: 'relative_to_epoch',
        reference_time: { clock_type: 'monotonic', epoch: 'unknown' },
      },
    };
  }

  /** Recorded events as generic qlog records. */
  toRecords(): readonly QlogEventRecord[] {
    return this.events.map(e => ({ time: e.time, name: e.name, data: e.data }));
  }

  /**
   * Export as a contained qlog file (`.qlog`) per draft-14.
   *
   * @see draft-ietf-quic-qlog-main-schema-14
   */
  toContained(): QlogFileContained {
    return toContainedFile(this.traceSpec(), this.toRecords());
  }

  /**
   * Export as a sequential qlog file (`.sqlog`) per draft-14 and RFC 7464.
   *
   * Every record is RS-prefixed and LF-terminated, so the output appends
   * cleanly and a capture cut short still parses up to the cut.
   */
  toSeq(): string {
    return serializeSeq(this.traceSpec(), this.toRecords());
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
