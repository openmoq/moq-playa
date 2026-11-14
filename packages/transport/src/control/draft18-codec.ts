/**
 * Draft-18 control message codec.
 *
 * A pure wire codec for the draft-18 control plane: SETUP, the request/response
 * messages (SUBSCRIBE/SUBSCRIBE_OK, FETCH/FETCH_OK, PUBLISH, TRACK_STATUS,
 * PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, REQUEST_OK,
 * REQUEST_ERROR, REQUEST_UPDATE), the continuation messages (NAMESPACE,
 * NAMESPACE_DONE, PUBLISH_BLOCKED), and PUBLISH_DONE. Stream topology and request
 * correlation live in the I/O layer; truly unhandled message types throw an
 * explicit "not implemented" rather than falling back.
 *
 * Framing is `Type (vi64) + Length (16) + Payload` (the Length is a 16-bit field,
 * as in draft-16; the Type and the payload's integer fields use vi64). Response
 * messages OMIT the Request ID — SUBSCRIBE_OK/REQUEST_OK/REQUEST_ERROR/FETCH_OK
 * decode with `requestId === undefined`, to be stamped by the topology from stream
 * context (never a placeholder).
 *
 * Supported semantics:
 *   - Track Properties (§2.5) on PUBLISH / SUBSCRIBE_OK / FETCH_OK and a
 *     TRACK_STATUS_OK (REQUEST_OK) — see `track-properties-18.ts`. On a REQUEST_OK
 *     the codec decodes them context-free; the session enforces which contexts
 *     may carry them.
 *   - REQUEST_ERROR optional Redirect (§10.6.2), error code REDIRECT (0x34).
 *   - vi64 fields are full uint64 (Request ID, Track Alias, Locations, Redirect
 *     lengths, Track Property values). Non-Location `varint` message parameters
 *     are mapped through the QUIC `Varint` (≤ 2^62-1) at the current boundary;
 *     LARGEST_OBJECT (a Location) is full uint64.
 *
 * @see draft-ietf-moq-transport-18 §10 (control messages), §2.5 (Properties)
 * @module
 */

import type { ControlCodec, DecodedControlMessage } from './codec.js';
import type {
  ControlMessage,
  RequestId,
  Parameters,
  ParameterValue,
  Subscribe,
  SubscribeOk,
  RequestOk,
  RequestErrorMsg,
  Redirect,
  RequestUpdate,
  Fetch,
  FetchOk,
  StandaloneFetch,
  JoiningFetch,
  TrackStatus,
  PublishNamespace,
  Publish,
  PublishDone,
  SubscribeNamespace,
  PublishBlocked,
  Namespace,
  NamespaceDone,
  Goaway,
  SetupOptionMap,
  SetupOptionValue,
  TrackProperties,
} from './messages.js';
import type { Location } from '../primitives/location.js';
import { readVi64, writeVi64, vi64EncodingLength, MAX_VI64 } from '../primitives/vi64.js';
import { ControlMessageType18, ErrorDetail23, SetupOption18, SetupOption23 } from './codes-18.js';
import { MAX_CONTROL_MESSAGE_SIZE } from './control-message-size.js';
import { MessageParam } from './parameters.js';
import {
  encodeMessageParams18,
  decodeMessageParams18,
  messageParams18EncodingLength,
  DEFAULT_MESSAGE_PARAM_REGISTRY,
  DRAFT22_MESSAGE_PARAM_REGISTRY,
  DRAFT23_MESSAGE_PARAM_REGISTRY,
  type MessageParams18,
  type MessageParamRegistry,
  type MessageParamValue,
} from './message-params-18.js';
import { encodeFetchLocationFilter, decodeFetchLocationFilter } from './subscription-filter.js';
import {
  encodeTrackProperties18,
  decodeTrackProperties18,
  trackProperties18EncodingLength,
} from './track-properties-18.js';
import { ProtocolViolationError, SessionError } from '../errors.js';
import { validateTrackNamespacePrefix, validateFullTrackName, validateTrackNamespace } from '../primitives/bytes.js';
import type { RequestStreamDraft } from '../versions.js';
import { isDraft22, isDraft23 } from '../versions.js';

/** Error Code value that carries an optional Redirect structure (§10.6.2). */
const REDIRECT_ERROR_CODE = 0x34n;
/** Error Code that UNSUPPORTED_PROPERTY Error Details accompany (draft-23 §9.4.2.2). */
const UNSUPPORTED_EXTENSION_ERROR_CODE = 0x33n;
const ERROR_DETAIL_REDIRECT = BigInt(ErrorDetail23.REDIRECT);
const ERROR_DETAIL_UNSUPPORTED_PROPERTY = BigInt(ErrorDetail23.UNSUPPORTED_PROPERTY);
/** Error Details a sender must not repeat; UNSUPPORTED_PROPERTY may (§9.4.2). */
const ERROR_DETAIL_SINGLETONS = new Set<bigint>([ERROR_DETAIL_REDIRECT]);

/** Read a message's Track Properties, accepting the canonical `trackProperties`
 *  or the deprecated `trackExtensions` alias (empty if neither). */
function trackPropsOf(
  msg: { readonly trackProperties?: TrackProperties; readonly trackExtensions?: TrackProperties },
): TrackProperties {
  return msg.trackProperties ?? msg.trackExtensions ?? new Map();
}

// ─── vi64 field helpers (length-prefixed bytes, namespace tuple) ─────

function vi64BytesLength(bytes: Uint8Array): number {
  return vi64EncodingLength(BigInt(bytes.length)) + bytes.length;
}
function writeVi64Bytes(bytes: Uint8Array, buf: Uint8Array, offset: number): number {
  let p = offset + writeVi64(BigInt(bytes.length), buf, offset);
  buf.set(bytes, p);
  return p + bytes.length - offset;
}
function readVi64Bytes(buf: Uint8Array, offset: number): { value: Uint8Array; bytesRead: number } {
  const { value: len, bytesRead } = readVi64(buf, offset);
  const start = offset + bytesRead;
  const n = Number(len);
  if (start + n > buf.length) throw new ProtocolViolationError('vi64 length-prefixed bytes exceed buffer');
  return { value: buf.slice(start, start + n), bytesRead: bytesRead + n };
}

function vi64TupleLength(fields: Uint8Array[]): number {
  let len = vi64EncodingLength(BigInt(fields.length));
  for (const f of fields) len += vi64BytesLength(f);
  return len;
}
function writeVi64Tuple(fields: Uint8Array[], buf: Uint8Array, offset: number): number {
  let p = offset + writeVi64(BigInt(fields.length), buf, offset);
  for (const f of fields) p += writeVi64Bytes(f, buf, p);
  return p - offset;
}
function readVi64Tuple(buf: Uint8Array, offset: number): { value: Uint8Array[]; bytesRead: number } {
  let p = offset;
  const { value: count, bytesRead } = readVi64(buf, p);
  p += bytesRead;
  const fields: Uint8Array[] = [];
  for (let i = 0n; i < count; i++) {
    const r = readVi64Bytes(buf, p);
    fields.push(r.value);
    p += r.bytesRead;
  }
  return { value: fields, bytesRead: p - offset };
}
/** Encode a namespace tuple into a fresh buffer (used by NAMESPACE / NAMESPACE_DONE). */
function encodeTuple(fields: Uint8Array[]): Uint8Array {
  const buf = new Uint8Array(vi64TupleLength(fields));
  writeVi64Tuple(fields, buf, 0);
  return buf;
}

// ─── Location (two vi64: group, object — full uint64, no QUIC cap) ──────

function vi64LocationLength(loc: Location): number {
  return vi64EncodingLength(loc.group) + vi64EncodingLength(loc.object);
}
function writeVi64Location(loc: Location, buf: Uint8Array, offset: number): number {
  let p = offset + writeVi64(loc.group, buf, offset);
  p += writeVi64(loc.object, buf, p);
  return p - offset;
}
function readVi64Location(buf: Uint8Array, offset: number): { value: Location; bytesRead: number } {
  const g = readVi64(buf, offset);
  const o = readVi64(buf, offset + g.bytesRead);
  return { value: { group: g.value, object: o.value }, bytesRead: g.bytesRead + o.bytesRead };
}

// ─── reason phrase (vi64 length-prefixed UTF-8) ─────────────────────

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** §10.4: maximum New Session URI length; longer → PROTOCOL_VIOLATION. */
const GOAWAY_MAX_URI_LENGTH = 8192;

/** draft-22 LOCATION_FILTER (§9.20.9), the 0x21 message parameter. */
const LOCATION_FILTER_TYPE = 0x21n;

/** §1.4.2: maximum Reason Phrase length in bytes; longer → PROTOCOL_VIOLATION. */
const REASON_PHRASE_MAX_LENGTH = 1024;

function reasonPhrase18Length(s: string): number {
  const bytes = TEXT_ENCODER.encode(s);
  if (bytes.length > REASON_PHRASE_MAX_LENGTH) {
    throw new ProtocolViolationError(`Reason Phrase length ${bytes.length} exceeds maximum ${REASON_PHRASE_MAX_LENGTH} bytes`);
  }
  return vi64BytesLength(bytes);
}
function writeReasonPhrase18(s: string, buf: Uint8Array, offset: number): number {
  const bytes = TEXT_ENCODER.encode(s);
  if (bytes.length > REASON_PHRASE_MAX_LENGTH) {
    throw new ProtocolViolationError(`Reason Phrase length ${bytes.length} exceeds maximum ${REASON_PHRASE_MAX_LENGTH} bytes`);
  }
  return writeVi64Bytes(bytes, buf, offset);
}
function readReasonPhrase18(buf: Uint8Array, offset: number): { value: string; bytesRead: number } {
  const { value, bytesRead } = readVi64Bytes(buf, offset);
  if (value.length > REASON_PHRASE_MAX_LENGTH) {
    throw new ProtocolViolationError(`Reason Phrase length ${value.length} exceeds maximum ${REASON_PHRASE_MAX_LENGTH} bytes`);
  }
  return { value: TEXT_DECODER.decode(value), bytesRead };
}

// ─── Setup Options (KVP, vi64, span the whole payload, no count) ─────
//
// Unlike Message Parameters, Setup Options are self-describing via Type parity
// (even → vi64 value, odd → length-prefixed bytes), so no registry is needed and
// unknown options decode fine — the session decides which to honor/ignore. Types
// are delta-encoded and ascending; the block spans the payload. Even-Type values
// are full-uint64 vi64 (NOT QUIC-Varint-capped).

/** Known singleton Setup Options — MUST NOT be repeated. AUTHORIZATION_TOKEN
 *  (0x03) may repeat; unknown Option Types may repeat. */
const SETUP_SINGLETONS = new Set<bigint>([
  BigInt(SetupOption18.PATH),
  BigInt(SetupOption18.AUTHORITY),
  BigInt(SetupOption18.MAX_AUTH_TOKEN_CACHE_SIZE),
  BigInt(SetupOption18.MOQT_IMPLEMENTATION),
  BigInt(SetupOption23.MAX_CONTROL_MESSAGE_SIZE),
]);

function setupValueLength(type: bigint, value: SetupOptionValue): number {
  if (type % 2n === 0n) {
    if (typeof value !== 'bigint') {
      throw new ProtocolViolationError(`Setup Option 0x${type.toString(16)} (even) requires a vi64 value`);
    }
    return vi64EncodingLength(value); // full uint64 — not QUIC-range capped
  }
  if (!(value instanceof Uint8Array)) {
    throw new ProtocolViolationError(`Setup Option 0x${type.toString(16)} (odd) requires a byte value`);
  }
  return vi64BytesLength(value);
}

function writeSetupValue(type: bigint, value: SetupOptionValue, buf: Uint8Array, offset: number): number {
  return type % 2n === 0n
    ? writeVi64(value as bigint, buf, offset)
    : writeVi64Bytes(value as Uint8Array, buf, offset);
}

function encodeSetupOptionMap18(options: SetupOptionMap): Uint8Array {
  return encodeKvps18(options, SETUP_SINGLETONS, 'Setup Option');
}

/**
 * Encode delta-typed Key-Value-Pairs (draft-23 §8.3): even Types carry a vi64,
 * odd Types length-prefixed bytes. Setup Options and Error Details use it.
 */
function encodeKvps18(options: SetupOptionMap, singletons: ReadonlySet<bigint>, what: string): Uint8Array {
  const entries = [...options.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const flat: { delta: bigint; type: bigint; value: SetupOptionValue }[] = [];
  let prev = 0n;
  let len = 0;
  for (const [type, values] of entries) {
    // Sender-side duplicate validation: known singletons must not repeat.
    if (singletons.has(type) && values.length > 1) {
      throw new ProtocolViolationError(`${what} 0x${type.toString(16)} must not be repeated`);
    }
    for (const value of values) {
      const delta = type - prev;
      prev = type;
      flat.push({ delta, type, value });
      len += vi64EncodingLength(delta) + setupValueLength(type, value);
    }
  }
  const buf = new Uint8Array(len);
  let p = 0;
  for (const { delta, type, value } of flat) {
    p += writeVi64(delta, buf, p);
    p += writeSetupValue(type, value, buf, p);
  }
  return buf;
}

function decodeSetupOptionMap18(payload: Uint8Array, offset = 0): SetupOptionMap {
  const out: SetupOptionMap = new Map();
  let p = offset;
  let prev = 0n;
  while (p < payload.length) {
    const dt = readVi64(payload, p);
    p += dt.bytesRead;
    const type = prev + dt.value;
    if (type > MAX_VI64) {
      throw new ProtocolViolationError(`Setup Option type ${type} exceeds 2^64-1`, Number(SessionError.DELTA_ENCODING_OVERFLOW));
    }
    prev = type;
    let value: SetupOptionValue;
    if (type % 2n === 0n) {
      const v = readVi64(payload, p);
      p += v.bytesRead;
      value = v.value; // full-uint64 vi64 (no Varint cap)
    } else {
      const b = readVi64Bytes(payload, p);
      p += b.bytesRead;
      value = b.value;
    }
    const arr = out.get(type);
    if (arr) arr.push(value);
    else out.set(type, [value]);
  }
  return out;
}

// ─── parameter bridge (semantic Parameters ↔ typed MessageParams18) ──

function isLocation(v: ParameterValue): v is Location {
  return typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !Array.isArray(v);
}

function toTypedParam(type: bigint, v: ParameterValue, registry: MessageParamRegistry): MessageParamValue {
  const kind = registry.get(type);
  if (kind === undefined) {
    throw new ProtocolViolationError(`Unknown draft-18 message parameter 0x${type.toString(16)}`);
  }
  switch (kind) {
    case 'uint8':
      if (typeof v !== 'bigint') throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} expects uint8`);
      // uint8 wire field is a single byte; reject out-of-range rather than masking.
      if (v < 0n || v > 255n) {
        throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} uint8 value out of range (0..255): ${v}`);
      }
      return { kind: 'uint8', value: Number(v) };
    case 'varint':
      if (typeof v !== 'bigint') throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} expects varint`);
      // draft-18 message-parameter varints are vi64 (full uint64), NOT the QUIC
      // Varint range — only reject negative / above 2^64-1.
      if (v < 0n || v > MAX_VI64) {
        throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} varint value out of range (0..2^64-1): ${v}`);
      }
      return { kind: 'varint', value: v };
    case 'bytes':
      if (!(v instanceof Uint8Array)) throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} expects bytes`);
      return { kind: 'bytes', value: v };
    case 'locationFilter':
      if (!(v instanceof Uint8Array)) throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} expects a LOCATION_FILTER`);
      return { kind: 'locationFilter', value: v };
    case 'paramBlock': {
      // The semantic value is the counted parameter block draft 22 carries in
      // its FILL_PARAMETERS; draft 23 writes it with no Length, so it must be
      // exactly one well-formed block.
      if (!(v instanceof Uint8Array)) throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} expects a parameter block`);
      if (decodeMessageParams18(v, 0, registry).bytesRead !== v.length) {
        throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} block has trailing bytes`);
      }
      return { kind: 'paramBlock', value: v };
    }
    case 'location':
      if (!isLocation(v)) throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} expects Location`);
      return { kind: 'location', group: v.group, object: v.object };
    case 'namespace': {
      if (!Array.isArray(v)) throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} expects a Track Namespace tuple`);
      const fields = v as readonly unknown[];
      if (!fields.every((e) => e instanceof Uint8Array)) {
        throw new ProtocolViolationError(`Parameter 0x${type.toString(16)} Track Namespace tuple has a non-Uint8Array field`);
      }
      return { kind: 'namespace', value: [...(fields as readonly Uint8Array[])] };
    }
  }
}

/** draft-23 PAUSED (§9.19.18): FORWARD's successor, with the value inverted. */
const PAUSED_TYPE = 0x11n;

/**
 * Whether `registry` speaks PAUSED rather than FORWARD (draft 23). The session
 * keeps the semantic FORWARD parameter on every draft; this bridge rewrites it.
 */
function usesPaused(registry: MessageParamRegistry): boolean {
  return registry.has(PAUSED_TYPE) && !registry.has(MessageParam.FORWARD as bigint);
}

function paramsToTyped(params: Parameters, registry: MessageParamRegistry): MessageParams18 {
  const out = new Map<bigint, MessageParamValue[]>();
  for (const [type, values] of params) {
    if (type === MessageParam.FORWARD) {
      const value = values[0];
      if (values.length !== 1 || typeof value !== 'bigint'
          || (value !== 0n && value !== 1n)) {
        throw new ProtocolViolationError('FORWARD must be exactly one value, 0 or 1');
      }
      if (usesPaused(registry)) {
        // Absent FORWARD and absent PAUSED both mean "delivering", so only a
        // present value needs rewriting: PAUSED = 1 - FORWARD.
        out.set(PAUSED_TYPE, [{ kind: 'uint8', value: value === 0n ? 1 : 0 }]);
        continue;
      }
    }
    out.set(type, values.map((v) => toTypedParam(type, v, registry)));
  }
  return out;
}

function fromTypedParam(v: MessageParamValue): ParameterValue {
  switch (v.kind) {
    case 'uint8':
      return BigInt(v.value);
    case 'varint':
      // draft-18 varint params are vi64 (full uint64); return the raw bigint
      // rather than re-capping through the QUIC Varint range.
      return v.value;
    case 'bytes':
    case 'locationFilter':
    case 'paramBlock':
      return v.value;
    case 'location':
      return { group: v.group, object: v.object };
    case 'namespace':
      return v.value; // Uint8Array[] — a Track Namespace tuple (NamespaceTuple)
  }
}

function typedToParams(typed: MessageParams18): Parameters {
  const out: Parameters = new Map();
  for (const [type, values] of typed) {
    if (type === PAUSED_TYPE) {
      // Only a draft-23 registry decodes 0x11. Expose it as the semantic
      // FORWARD; a repeated or out-of-range PAUSED is INVALID_PARAMETER.
      const v = values[0];
      if (values.length !== 1 || v?.kind !== 'uint8' || v.value > 1) {
        throw new ProtocolViolationError('PAUSED must be exactly one value, 0 or 1', Number(SessionError.INVALID_PARAMETER));
      }
      out.set(MessageParam.FORWARD as bigint, [BigInt(1 - v.value)]);
      continue;
    }
    out.set(type, values.map(fromTypedParam));
  }
  return out;
}

// ─── codec ───────────────────────────────────────────────────────────

const notImplemented = (what: string): never => {
  throw new ProtocolViolationError(`Draft18Codec: ${what} is not yet implemented`);
};

export { MAX_CONTROL_MESSAGE_SIZE };

const MALFORMED_MESSAGE = Number(SessionError.MALFORMED_MESSAGE);

const unexpectedMessage = (type: bigint): never => {
  throw new ProtocolViolationError(
    `Unknown draft-23 control message type 0x${type.toString(16)}`,
    Number(SessionError.UNEXPECTED_MESSAGE),
  );
};

export class Draft18Codec implements ControlCodec {
  /**
   * @param version 18, or 22 for the draft-22 variant of the same stream
   *   model (its differing messages branch on this).
   */
  constructor(readonly version: RequestStreamDraft = 18) {}

  /** The message-parameter table of this codec's draft. */
  private get paramRegistry(): MessageParamRegistry {
    if (isDraft23(this.version)) return DRAFT23_MESSAGE_PARAM_REGISTRY;
    return isDraft22(this.version) ? DRAFT22_MESSAGE_PARAM_REGISTRY : DEFAULT_MESSAGE_PARAM_REGISTRY;
  }

  /** Full Track Name rules: draft 23 forbids an empty Track Name (§2.4.1). */
  private get fullTrackNameRules(): { allowEmptyNamespace: true; forbidEmptyTrackName: boolean } {
    return { allowEmptyNamespace: true, forbidEmptyTrackName: isDraft23(this.version) };
  }

  encode(msg: ControlMessage): Uint8Array {
    switch (msg.type) {
      case 'SETUP':
        return this.frame(ControlMessageType18.SETUP, encodeSetupOptionMap18(msg.setupOptions));
      case 'SUBSCRIBE':
        return this.frame(ControlMessageType18.SUBSCRIBE, this.encodeSubscribe(msg));
      case 'REQUEST_UPDATE':
        return this.frame(ControlMessageType18.REQUEST_UPDATE, this.encodeRequestUpdate(msg));
      case 'SUBSCRIBE_OK':
        return this.frame(ControlMessageType18.SUBSCRIBE_OK, this.encodeSubscribeOk(msg));
      case 'REQUEST_OK':
        return this.frame(ControlMessageType18.REQUEST_OK, this.encodeRequestOk(msg));
      case 'REQUEST_ERROR':
        return this.frame(ControlMessageType18.REQUEST_ERROR, this.encodeRequestError(msg));
      case 'FETCH':
        return this.frame(ControlMessageType18.FETCH, isDraft22(this.version) ? this.encodeFetch22(msg) : this.encodeFetch(msg));
      case 'FETCH_OK':
        if (isDraft23(this.version)) {
          // draft-23 §9.3: a FETCH is answered with REQUEST_OK; 0x18 is reserved.
          throw new ProtocolViolationError('Draft18Codec: draft 23 answers a FETCH with REQUEST_OK, not FETCH_OK');
        }
        return this.frame(ControlMessageType18.FETCH_OK, this.encodeFetchOk(msg));
      case 'TRACK_STATUS':
        return this.frame(ControlMessageType18.TRACK_STATUS, this.encodeTrackStatus(msg));
      case 'PUBLISH_NAMESPACE':
        return this.frame(ControlMessageType18.PUBLISH_NAMESPACE, this.encodePublishNamespace(msg));
      case 'PUBLISH':
        return this.frame(ControlMessageType18.PUBLISH, this.encodePublish(msg));
      case 'PUBLISH_DONE':
        return this.frame(ControlMessageType18.PUBLISH_DONE, this.encodePublishDone(msg));
      case 'SUBSCRIBE_NAMESPACE':
        return this.frame(ControlMessageType18.SUBSCRIBE_NAMESPACE, this.encodeSubscribeNamespace(msg));
      case 'SUBSCRIBE_TRACKS':
        return this.frame(ControlMessageType18.SUBSCRIBE_TRACKS, this.encodeNamespacePrefixRequest(msg.requestId, msg.trackNamespacePrefix, msg.parameters));
      case 'NAMESPACE':
        return this.frame(ControlMessageType18.NAMESPACE, this.encodeNamespace(msg));
      case 'NAMESPACE_DONE':
        return this.frame(ControlMessageType18.NAMESPACE_DONE, encodeTuple(msg.trackNamespaceSuffix));
      case 'PUBLISH_BLOCKED':
        return this.frame(ControlMessageType18.PUBLISH_BLOCKED, this.encodePublishBlocked(msg));
      case 'GOAWAY':
        return this.frame(ControlMessageType18.GOAWAY, this.encodeGoaway(msg));
      case 'PUBLISH_STATE_NOTIFY':
        if (!isDraft22(this.version)) {
          throw new ProtocolViolationError('Draft18Codec: PUBLISH_STATE_NOTIFY exists only in draft 22');
        }
        return this.frame(ControlMessageType18.PUBLISH_STATE_NOTIFY, this.encodeParamsOnly(msg.parameters));
      case 'PUBLISH_NAMESPACE_DONE':
        // draft-18 §3.3.2 removed this message — withdrawal is a request-stream
        // cancellation. It must never reach the wire.
        throw new ProtocolViolationError('Draft18Codec: PUBLISH_NAMESPACE_DONE was removed in draft-18');
      default:
        return notImplemented(`encode of ${msg.type}`);
    }
  }

  decode(buf: Uint8Array, offset: number): { message: DecodedControlMessage; bytesRead: number } {
    const header = this.readHeader(buf, offset);
    if (header === undefined) {
      throw new ProtocolViolationError('draft-18 control frame: truncated length', MALFORMED_MESSAGE);
    }
    if (header.payloadOff + header.payloadLen > buf.length) {
      throw new ProtocolViolationError('draft-18 control frame: truncated payload', MALFORMED_MESSAGE);
    }
    const payload = buf.subarray(header.payloadOff, header.payloadOff + header.payloadLen);
    const bytesRead = header.payloadOff + header.payloadLen - offset;
    if (!isDraft23(this.version)) return { message: this.decodeBody(header.type, payload), bytesRead };
    try {
      return { message: this.decodeBody(header.type, payload), bytesRead };
    } catch (err) {
      // draft-23 §9: a body that does not parse, or does not fill the Length, is
      // MALFORMED_MESSAGE unless a more specific code was already attached.
      if (err instanceof ProtocolViolationError && err.code !== undefined) throw err;
      if (err instanceof ProtocolViolationError || err instanceof RangeError) {
        throw new ProtocolViolationError(err.message, MALFORMED_MESSAGE);
      }
      throw err;
    }
  }

  private decodeBody(type: bigint, payload: Uint8Array): DecodedControlMessage {
    switch (Number(type)) {
      case ControlMessageType18.SETUP:
        return { type: 'SETUP', setupOptions: decodeSetupOptionMap18(payload) };
      case ControlMessageType18.SUBSCRIBE:
        return this.decodeSubscribe(payload);
      case ControlMessageType18.REQUEST_UPDATE:
        return this.decodeRequestUpdate(payload);
      case ControlMessageType18.SUBSCRIBE_OK:
        return this.decodeSubscribeOk(payload);
      case ControlMessageType18.REQUEST_OK:
        return this.decodeRequestOk(payload);
      case ControlMessageType18.REQUEST_ERROR:
        return this.decodeRequestError(payload);
      case ControlMessageType18.FETCH:
        return isDraft22(this.version) ? this.decodeFetch22(payload) : this.decodeFetch(payload);
      case ControlMessageType18.FETCH_OK:
        // draft-23 §9: 0x18 is reserved; a FETCH is answered with REQUEST_OK.
        if (isDraft23(this.version)) return unexpectedMessage(type);
        return this.decodeFetchOk(payload);
      case ControlMessageType18.TRACK_STATUS:
        return this.decodeTrackStatus(payload);
      case ControlMessageType18.PUBLISH_NAMESPACE:
        return this.decodePublishNamespace(payload);
      case ControlMessageType18.PUBLISH:
        return this.decodePublish(payload);
      case ControlMessageType18.PUBLISH_DONE:
        return this.decodePublishDone(payload);
      case ControlMessageType18.SUBSCRIBE_NAMESPACE:
        return this.decodeSubscribeNamespace(payload);
      case ControlMessageType18.SUBSCRIBE_TRACKS:
        return this.decodeSubscribeTracks(payload);
      case ControlMessageType18.NAMESPACE:
        return isDraft23(this.version) ? this.decodeNamespace23(payload) : this.decodeNamespaceSuffix('NAMESPACE', payload);
      case ControlMessageType18.NAMESPACE_DONE:
        return this.decodeNamespaceSuffix('NAMESPACE_DONE', payload);
      case ControlMessageType18.PUBLISH_BLOCKED:
        return this.decodePublishBlocked(payload);
      case ControlMessageType18.GOAWAY:
        return this.decodeGoaway(payload);
      case ControlMessageType18.PUBLISH_STATE_NOTIFY:
        if (!isDraft22(this.version)) return this.unknownMessage(type);
        return { type: 'PUBLISH_STATE_NOTIFY', parameters: this.decodeParamsOnly(payload, 'PUBLISH_STATE_NOTIFY') };
      default:
        return this.unknownMessage(type);
    }
  }

  /** An unknown message type: UNEXPECTED_MESSAGE on draft 23 (§9). */
  private unknownMessage(type: bigint): never {
    if (isDraft23(this.version)) return unexpectedMessage(type);
    return notImplemented(`decode of type 0x${type.toString(16)}`);
  }

  peekFrameSize(buf: Uint8Array): number | undefined {
    const header = this.readHeader(buf, 0);
    return header === undefined ? undefined : header.payloadOff + header.payloadLen;
  }

  // ── framing ──────────────────────────────────────────────────────
  // Type (vi64) + Length + Payload. The Length is 16 bits through draft 22 and
  // a vi64 from draft 23 (§9), bounded by MAX_CONTROL_MESSAGE_SIZE.

  /**
   * Read a frame header at `offset`, or `undefined` if its bytes have not all
   * arrived. The payload itself may still be incomplete.
   * @throws {ProtocolViolationError} FIELD_LENGTH_EXCEEDED for a draft-23 Length
   *   above our MAX_CONTROL_MESSAGE_SIZE, before any of the payload is buffered.
   */
  private readHeader(buf: Uint8Array, offset: number): { type: bigint; payloadOff: number; payloadLen: number } | undefined {
    let type: { value: bigint; bytesRead: number };
    try {
      type = readVi64(buf, offset);
    } catch {
      return undefined; // not enough bytes for the type vi64 yet
    }
    const lenOff = offset + type.bytesRead;
    if (!isDraft23(this.version)) {
      if (lenOff + 2 > buf.length) return undefined;
      return { type: type.value, payloadOff: lenOff + 2, payloadLen: (buf[lenOff]! << 8) | buf[lenOff + 1]! };
    }
    let len: { value: bigint; bytesRead: number };
    try {
      len = readVi64(buf, lenOff);
    } catch {
      return undefined;
    }
    if (len.value > BigInt(MAX_CONTROL_MESSAGE_SIZE)) {
      throw new ProtocolViolationError(
        `control message Length ${len.value} exceeds MAX_CONTROL_MESSAGE_SIZE ${MAX_CONTROL_MESSAGE_SIZE}`,
        Number(SessionError.FIELD_LENGTH_EXCEEDED),
      );
    }
    return { type: type.value, payloadOff: lenOff + len.bytesRead, payloadLen: Number(len.value) };
  }

  private frame(type: number, payload: Uint8Array): Uint8Array {
    if (isDraft23(this.version)) {
      // §9: never send more than the peer's MAX_CONTROL_MESSAGE_SIZE. We never
      // need more than the default, which every peer must accept (§9.1.8).
      if (payload.length > MAX_CONTROL_MESSAGE_SIZE) {
        throw new ProtocolViolationError(`draft-23 control payload exceeds MAX_CONTROL_MESSAGE_SIZE ${MAX_CONTROL_MESSAGE_SIZE}`);
      }
      const length = BigInt(payload.length);
      const out = new Uint8Array(vi64EncodingLength(BigInt(type)) + vi64EncodingLength(length) + payload.length);
      let p = writeVi64(BigInt(type), out, 0);
      p += writeVi64(length, out, p);
      out.set(payload, p);
      return out;
    }
    if (payload.length > 0xffff) throw new ProtocolViolationError('draft-18 control payload exceeds 2^16-1');
    const out = new Uint8Array(vi64EncodingLength(BigInt(type)) + 2 + payload.length);
    let p = writeVi64(BigInt(type), out, 0);
    out[p++] = (payload.length >> 8) & 0xff;
    out[p++] = payload.length & 0xff;
    out.set(payload, p);
    return out;
  }

  // ── SUBSCRIBE (request, §10.7) ──────────────────────────────────────

  private encodeSubscribe(msg: Subscribe): Uint8Array {
    // §2.4.1: Track Namespace (0-32 non-empty fields) + Full Track Name ≤ 4096 bytes.
    validateFullTrackName(msg.trackNamespace, msg.trackName, this.fullTrackNameRules);
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const len =
      vi64EncodingLength(msg.requestId) +
      vi64TupleLength(msg.trackNamespace) +
      vi64BytesLength(msg.trackName) +
      messageParams18EncodingLength(typed, this.paramRegistry);
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.requestId, buf, 0);
    p += writeVi64Tuple(msg.trackNamespace, buf, p);
    p += writeVi64Bytes(msg.trackName, buf, p);
    buf.set(encodeMessageParams18(typed, this.paramRegistry), p);
    return buf;
  }

  private decodeSubscribe(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const ns = readVi64Tuple(payload, p); p += ns.bytesRead;
    const name = readVi64Bytes(payload, p); p += name.bytesRead;
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    // SUBSCRIBE has no field after Parameters; any trailing bytes are malformed.
    if (p !== payload.length) {
      throw new ProtocolViolationError('SUBSCRIBE: unexpected trailing bytes after parameters');
    }
    // §2.4.1: validate Track Namespace (0-32 non-empty fields) + Full Track Name ≤ 4096.
    validateFullTrackName(ns.value, name.value, this.fullTrackNameRules);
    return {
      type: 'SUBSCRIBE',
      requestId: rid.value,
      trackNamespace: ns.value,
      trackName: name.value,
      parameters: typedToParams(params.params),
    };
  }

  // ── TRACK_STATUS (request, §10.14 — same body as SUBSCRIBE) ─────────
  // First and only message on a new request stream; carries no delivery params.
  // Response is REQUEST_OK (a.k.a. TRACK_STATUS_OK) / REQUEST_ERROR.

  private encodeTrackStatus(msg: TrackStatus): Uint8Array {
    // §2.4.1: Track Namespace (0-32 non-empty fields) + Full Track Name ≤ 4096 bytes.
    validateFullTrackName(msg.trackNamespace, msg.trackName, this.fullTrackNameRules);
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const len =
      vi64EncodingLength(msg.requestId) +
      vi64TupleLength(msg.trackNamespace) +
      vi64BytesLength(msg.trackName) +
      messageParams18EncodingLength(typed, this.paramRegistry);
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.requestId, buf, 0);
    p += writeVi64Tuple(msg.trackNamespace, buf, p);
    p += writeVi64Bytes(msg.trackName, buf, p);
    buf.set(encodeMessageParams18(typed, this.paramRegistry), p);
    return buf;
  }

  private decodeTrackStatus(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const ns = readVi64Tuple(payload, p); p += ns.bytesRead;
    const name = readVi64Bytes(payload, p); p += name.bytesRead;
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError('TRACK_STATUS: unexpected trailing bytes after parameters');
    }
    // §2.4.1: validate Track Namespace (0-32 non-empty fields) + Full Track Name ≤ 4096.
    validateFullTrackName(ns.value, name.value, this.fullTrackNameRules);
    return {
      type: 'TRACK_STATUS',
      requestId: rid.value,
      trackNamespace: ns.value,
      trackName: name.value,
      parameters: typedToParams(params.params),
    };
  }

  // ── PUBLISH_NAMESPACE (request, §10.15) ────────────────────────────
  // First and only message on a new request stream: Request ID, namespace tuple
  // (NO track name), params. Response is REQUEST_OK (PUBLISH_NAMESPACE_OK) /
  // REQUEST_ERROR.

  private encodePublishNamespace(msg: PublishNamespace): Uint8Array {
    // §2.4.1: PUBLISH_NAMESPACE carries a full Track Namespace (no track name):
    // 0-32 non-empty fields, total ≤ 4096 bytes.
    validateTrackNamespace(msg.trackNamespace, { allowEmpty: true });
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const len =
      vi64EncodingLength(msg.requestId) +
      vi64TupleLength(msg.trackNamespace) +
      messageParams18EncodingLength(typed, this.paramRegistry);
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.requestId, buf, 0);
    p += writeVi64Tuple(msg.trackNamespace, buf, p);
    buf.set(encodeMessageParams18(typed, this.paramRegistry), p);
    return buf;
  }

  private decodePublishNamespace(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const ns = readVi64Tuple(payload, p); p += ns.bytesRead;
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError('PUBLISH_NAMESPACE: unexpected trailing bytes after parameters');
    }
    // §2.4.1: PUBLISH_NAMESPACE carries a full Track Namespace (no track name).
    validateTrackNamespace(ns.value, { allowEmpty: true });
    return {
      type: 'PUBLISH_NAMESPACE',
      requestId: rid.value,
      trackNamespace: ns.value,
      parameters: typedToParams(params.params),
    };
  }

  // ── PUBLISH (request, §10.10) ──────────────────────────────────────
  // First message on a new INBOUND bidi stream (publisher → subscriber):
  // Request ID + namespace tuple + Track Name + Track Alias (vi64) + params +
  // Track Properties (§2.5, trailing field; empty → zero bytes).

  private encodePublish(msg: Publish): Uint8Array {
    // §2.4.1: Track Namespace (0-32 non-empty fields) + Full Track Name ≤ 4096 bytes.
    validateFullTrackName(msg.trackNamespace, msg.trackName, this.fullTrackNameRules);
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const len =
      vi64EncodingLength(msg.requestId) +
      vi64TupleLength(msg.trackNamespace) +
      vi64BytesLength(msg.trackName) +
      vi64EncodingLength(msg.trackAlias) +
      messageParams18EncodingLength(typed, this.paramRegistry) +
      trackProperties18EncodingLength(trackPropsOf(msg));
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.requestId, buf, 0);
    p += writeVi64Tuple(msg.trackNamespace, buf, p);
    p += writeVi64Bytes(msg.trackName, buf, p);
    p += writeVi64(msg.trackAlias, buf, p);
    const params = encodeMessageParams18(typed, this.paramRegistry);
    buf.set(params, p); p += params.length;
    buf.set(encodeTrackProperties18(trackPropsOf(msg)), p);
    return buf;
  }

  private decodePublish(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const ns = readVi64Tuple(payload, p); p += ns.bytesRead;
    const name = readVi64Bytes(payload, p); p += name.bytesRead;
    const alias = readVi64(payload, p); p += alias.bytesRead;
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    const props = decodeTrackProperties18(payload, p); // remaining bytes (empty → {})
    p += props.bytesRead;
    // §2.4.1: validate Track Namespace (0-32 non-empty fields) + Full Track Name ≤ 4096.
    validateFullTrackName(ns.value, name.value, this.fullTrackNameRules);
    return {
      type: 'PUBLISH',
      requestId: rid.value,
      trackNamespace: ns.value,
      trackName: name.value,
      trackAlias: alias.value,
      parameters: typedToParams(params.params),
      trackProperties: props.properties, trackExtensions: props.properties,
    };
  }

  // ── PUBLISH_DONE (response on PUBLISH stream, §10.11 — no Request ID) ──
  // Status Code (vi64) + Stream Count (vi64) + Error Reason. The Request ID is
  // supplied by the inbound PUBLISH stream context.

  private encodePublishDone(msg: PublishDone): Uint8Array {
    // statusCode/streamCount are vi64 (full uint64); writeVi64/vi64EncodingLength
    // range-check (0..2^64-1), so no QUIC-Varint cap here.
    const len =
      vi64EncodingLength(msg.statusCode) +
      vi64EncodingLength(msg.streamCount) +
      reasonPhrase18Length(msg.errorReason);
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.statusCode, buf, 0);
    p += writeVi64(msg.streamCount, buf, p);
    writeReasonPhrase18(msg.errorReason, buf, p);
    return buf;
  }

  private decodePublishDone(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const sc = readVi64(payload, p); p += sc.bytesRead;
    const cnt = readVi64(payload, p); p += cnt.bytesRead;
    const reason = readReasonPhrase18(payload, p); p += reason.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError('PUBLISH_DONE: unexpected trailing bytes after Error Reason');
    }
    // Response: Request ID omitted on the wire (stream context stamps it).
    // statusCode/streamCount are vi64 (full uint64) — return the raw bigints.
    return {
      type: 'PUBLISH_DONE',
      statusCode: sc.value,
      streamCount: cnt.value,
      errorReason: reason.value,
    };
  }

  // ── SUBSCRIBE_NAMESPACE (request, §10.18) ──────────────────────────
  // First message on a CONTINUING request stream: Request ID, namespace prefix
  // tuple (0–32 fields), params. After REQUEST_OK the same stream carries
  // NAMESPACE / NAMESPACE_DONE messages (decoded below, no Request ID).

  /** Shared body for the prefix-based requests (Request ID + prefix + params). */
  private encodeNamespacePrefixRequest(
    requestId: RequestId,
    prefix: Uint8Array[],
    parameters: Parameters,
  ): Uint8Array {
    const typed = paramsToTyped(parameters, this.paramRegistry);
    const len =
      vi64EncodingLength(requestId) +
      vi64TupleLength(prefix) +
      messageParams18EncodingLength(typed, this.paramRegistry);
    const buf = new Uint8Array(len);
    let p = writeVi64(requestId, buf, 0);
    p += writeVi64Tuple(prefix, buf, p);
    buf.set(encodeMessageParams18(typed, this.paramRegistry), p);
    return buf;
  }

  /** Shared decode for the prefix-based requests; returns the common fields. */
  private decodeNamespacePrefixRequest(
    name: 'SUBSCRIBE_NAMESPACE' | 'SUBSCRIBE_TRACKS',
    payload: Uint8Array,
  ): { requestId: RequestId; prefix: Uint8Array[]; parameters: Parameters } {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const prefix = readVi64Tuple(payload, p); p += prefix.bytesRead; // 0 fields allowed
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError(`${name}: unexpected trailing bytes after parameters`);
    }
    return { requestId: rid.value, prefix: prefix.value, parameters: typedToParams(params.params) };
  }

  private encodeSubscribeNamespace(msg: SubscribeNamespace): Uint8Array {
    return this.encodeNamespacePrefixRequest(msg.requestId, msg.trackNamespacePrefix, msg.parameters);
  }

  private decodeSubscribeNamespace(payload: Uint8Array): DecodedControlMessage {
    const { requestId, prefix, parameters } = this.decodeNamespacePrefixRequest('SUBSCRIBE_NAMESPACE', payload);
    return { type: 'SUBSCRIBE_NAMESPACE', requestId, trackNamespacePrefix: prefix, parameters };
  }

  // ── SUBSCRIBE_TRACKS (request, §10.19) / PUBLISH_BLOCKED (§10.20) ────
  // SUBSCRIBE_TRACKS shares the prefix-request body. PUBLISH_BLOCKED rides the
  // SUBSCRIBE_TRACKS response stream (no Request ID): suffix tuple + Track Name.

  private decodeSubscribeTracks(payload: Uint8Array): DecodedControlMessage {
    const { requestId, prefix, parameters } = this.decodeNamespacePrefixRequest('SUBSCRIBE_TRACKS', payload);
    return { type: 'SUBSCRIBE_TRACKS', requestId, trackNamespacePrefix: prefix, parameters };
  }

  private encodePublishBlocked(msg: PublishBlocked): Uint8Array {
    const len = vi64TupleLength(msg.trackNamespaceSuffix) + vi64BytesLength(msg.trackName);
    const buf = new Uint8Array(len);
    let p = writeVi64Tuple(msg.trackNamespaceSuffix, buf, 0);
    p += writeVi64Bytes(msg.trackName, buf, p);
    return buf;
  }

  private decodePublishBlocked(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const suffix = readVi64Tuple(payload, p); p += suffix.bytesRead;
    const name = readVi64Bytes(payload, p); p += name.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError('PUBLISH_BLOCKED: unexpected trailing bytes after Track Name');
    }
    return { type: 'PUBLISH_BLOCKED', trackNamespaceSuffix: suffix.value, trackName: name.value };
  }

  // ── GOAWAY (0x10) — §10.4: URI (vi64-len), Timeout (vi64), [Request ID (vi64)] ──

  private encodeGoaway(msg: Goaway): Uint8Array {
    const uri = TEXT_ENCODER.encode(msg.newSessionUri);
    if (uri.length > GOAWAY_MAX_URI_LENGTH) {
      throw new ProtocolViolationError(`GOAWAY New Session URI length ${uri.length} exceeds maximum ${GOAWAY_MAX_URI_LENGTH} bytes`);
    }
    const timeout = msg.timeout ?? 0n;
    // draft-22 §9.2 dropped the Request ID.
    const requestId = isDraft22(this.version) ? undefined : msg.requestId;
    let len = vi64BytesLength(uri) + vi64EncodingLength(timeout);
    if (requestId !== undefined) len += vi64EncodingLength(requestId);
    const buf = new Uint8Array(len);
    let p = writeVi64Bytes(uri, buf, 0);
    p += writeVi64(timeout, buf, p);
    if (requestId !== undefined) writeVi64(requestId, buf, p);
    return buf;
  }

  private decodeGoaway(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const uri = readVi64Bytes(payload, p); p += uri.bytesRead;
    if (uri.value.length > GOAWAY_MAX_URI_LENGTH) {
      throw new ProtocolViolationError(`GOAWAY New Session URI length ${uri.value.length} exceeds maximum ${GOAWAY_MAX_URI_LENGTH} bytes`);
    }
    const timeout = readVi64(payload, p); p += timeout.bytesRead;
    // Request ID is present only on the control stream (§10.4). The codec is
    // context-free: read it iff bytes remain, and expose it optionally.
    let requestId: bigint | undefined;
    if (p < payload.length && !isDraft22(this.version)) {
      const rid = readVi64(payload, p); p += rid.bytesRead;
      requestId = rid.value;
    }
    if (p !== payload.length) {
      throw new ProtocolViolationError(isDraft22(this.version)
        ? `GOAWAY: ${payload.length - p} trailing bytes after Timeout`
        : `GOAWAY: ${payload.length - p} trailing bytes after Request ID`);
    }
    const msg: Goaway = {
      type: 'GOAWAY',
      newSessionUri: TEXT_DECODER.decode(uri.value),
      timeout: timeout.value,
      ...(requestId !== undefined ? { requestId } : {}),
    };
    return msg;
  }

  // ── NAMESPACE (0x08) / NAMESPACE_DONE (0x0E) — suffix tuple only, no ID ──

  private decodeNamespaceSuffix(
    type: 'NAMESPACE' | 'NAMESPACE_DONE',
    payload: Uint8Array,
  ): DecodedControlMessage {
    const suffix = readVi64Tuple(payload, 0);
    if (suffix.bytesRead !== payload.length) {
      throw new ProtocolViolationError(`${type}: unexpected trailing bytes after namespace suffix`);
    }
    return { type, trackNamespaceSuffix: suffix.value } as Namespace | NamespaceDone;
  }

  /** NAMESPACE: the suffix, then (draft 23, §9.15) a Parameters block. */
  private encodeNamespace(msg: Namespace): Uint8Array {
    const suffix = encodeTuple(msg.trackNamespaceSuffix);
    if (!isDraft23(this.version)) return suffix;
    const params = encodeMessageParams18(paramsToTyped(msg.parameters ?? new Map(), this.paramRegistry), this.paramRegistry);
    const buf = new Uint8Array(suffix.length + params.length);
    buf.set(suffix, 0);
    buf.set(params, suffix.length);
    return buf;
  }

  private decodeNamespace23(payload: Uint8Array): DecodedControlMessage {
    const suffix = readVi64Tuple(payload, 0);
    const params = decodeMessageParams18(payload, suffix.bytesRead, this.paramRegistry);
    if (suffix.bytesRead + params.bytesRead !== payload.length) {
      throw new ProtocolViolationError('NAMESPACE: unexpected trailing bytes after Parameters');
    }
    return { type: 'NAMESPACE', trackNamespaceSuffix: suffix.value, parameters: typedToParams(params.params) };
  }

  // ── REQUEST_UPDATE (request, §10.9) ─────────────────────────────────
  // Keeps its OWN Request ID; the "Existing Request ID" (target) is omitted —
  // the bidirectional request stream it is sent on identifies the target.

  private encodeRequestUpdate(msg: RequestUpdate): Uint8Array {
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const len = vi64EncodingLength(msg.requestId) + messageParams18EncodingLength(typed, this.paramRegistry);
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.requestId, buf, 0);
    buf.set(encodeMessageParams18(typed, this.paramRegistry), p);
    return buf;
  }

  private decodeRequestUpdate(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError('REQUEST_UPDATE: unexpected trailing bytes after parameters');
    }
    // existingRequestId is supplied later from the request stream's context.
    return { type: 'REQUEST_UPDATE', requestId: rid.value, parameters: typedToParams(params.params) };
  }

  // ── SUBSCRIBE_OK (response, §10.8 — no Request ID) ─────────────────

  private encodeSubscribeOk(msg: SubscribeOk): Uint8Array {
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const len =
      vi64EncodingLength(msg.trackAlias) +
      messageParams18EncodingLength(typed, this.paramRegistry) +
      trackProperties18EncodingLength(trackPropsOf(msg));
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.trackAlias, buf, 0);
    const params = encodeMessageParams18(typed, this.paramRegistry);
    buf.set(params, p); p += params.length;
    buf.set(encodeTrackProperties18(trackPropsOf(msg)), p);
    return buf;
  }

  private decodeSubscribeOk(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const alias = readVi64(payload, p); p += alias.bytesRead;
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    const props = decodeTrackProperties18(payload, p); // remaining bytes (empty → {})
    p += props.bytesRead;
    // Response: Request ID is omitted on the wire (topology stamps it).
    return {
      type: 'SUBSCRIBE_OK',
      trackAlias: alias.value,
      parameters: typedToParams(params.params),
      trackProperties: props.properties, trackExtensions: props.properties,
    };
  }

  // ── REQUEST_OK (response, §10.5 — no Request ID) ───────────────────

  private encodeRequestOk(msg: RequestOk): Uint8Array {
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const props = trackPropsOf(msg);
    const params = encodeMessageParams18(typed, this.paramRegistry);
    const propBytes = encodeTrackProperties18(props);
    const buf = new Uint8Array(params.length + propBytes.length);
    buf.set(params, 0);
    buf.set(propBytes, params.length);
    return buf;
  }

  private decodeRequestOk(payload: Uint8Array): DecodedControlMessage {
    const params = decodeMessageParams18(payload, 0, this.paramRegistry);
    // Track Properties are CONTEXT-dependent on a REQUEST_OK: valid for a
    // TRACK_STATUS_OK, but not for PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE /
    // SUBSCRIBE_TRACKS responses. The codec is context-free, so it decodes them
    // unconditionally; the session validates them against the request-stream
    // context (which request this REQUEST_OK answers).
    const props = decodeTrackProperties18(payload, params.bytesRead);
    // Response: Request ID omitted on the wire (topology stamps it).
    return { type: 'REQUEST_OK', parameters: typedToParams(params.params), trackProperties: props.properties, trackExtensions: props.properties };
  }

  // ── REQUEST_ERROR (response, §10.6 — no Request ID) ────────────────

  private encodeRequestError(msg: RequestErrorMsg): Uint8Array {
    if (isDraft23(this.version)) return this.encodeRequestError23(msg);
    // §10.6.2: Error Code and Retry Interval are vi64 (full uint64, NOT QUIC-capped).
    // §10.6.2: a Redirect is present iff the Error Code is REDIRECT (0x34).
    const isRedirect = msg.errorCode === REDIRECT_ERROR_CODE;
    if (msg.redirect && !isRedirect) {
      throw new ProtocolViolationError('REQUEST_ERROR carries a Redirect but Error Code is not REDIRECT (0x34)');
    }
    if (isRedirect && !msg.redirect) {
      throw new ProtocolViolationError('REQUEST_ERROR with Error Code REDIRECT (0x34) requires a Redirect structure');
    }
    let redirectLen = 0;
    if (msg.redirect) {
      validateTrackNamespacePrefix(msg.redirect.trackNamespace); // size limits (0-32 fields, ≤4096 bytes)
      redirectLen =
        vi64BytesLength(msg.redirect.connectUri) +
        vi64TupleLength(msg.redirect.trackNamespace) +
        vi64BytesLength(msg.redirect.trackName);
    }

    const len =
      vi64EncodingLength(msg.errorCode) +
      vi64EncodingLength(msg.retryInterval) +
      reasonPhrase18Length(msg.errorReason) +
      redirectLen;
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.errorCode, buf, 0);
    p += writeVi64(msg.retryInterval, buf, p);
    p += writeReasonPhrase18(msg.errorReason, buf, p);
    if (msg.redirect) {
      p += writeVi64Bytes(msg.redirect.connectUri, buf, p);
      p += writeVi64Tuple(msg.redirect.trackNamespace, buf, p);
      writeVi64Bytes(msg.redirect.trackName, buf, p);
    }
    return buf;
  }

  private decodeRequestError(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const ec = readVi64(payload, p); p += ec.bytesRead;
    const ri = readVi64(payload, p); p += ri.bytesRead;
    const reason = readReasonPhrase18(payload, p); p += reason.bytesRead;
    if (isDraft23(this.version)) return this.decodeRequestError23(ec.value, ri.value, reason.value, payload, p);

    // §10.6.2: the optional Redirect is present iff Error Code is REDIRECT (0x34).
    // A truncated Redirect throws via the vi64 helpers; other contexts are decided
    // by the session (the response stream knows which request this answers).
    let redirect: { connectUri: Uint8Array; trackNamespace: Uint8Array[]; trackName: Uint8Array } | undefined;
    if (ec.value === REDIRECT_ERROR_CODE) {
      const uri = readVi64Bytes(payload, p); p += uri.bytesRead;
      const ns = readVi64Tuple(payload, p); p += ns.bytesRead;
      const name = readVi64Bytes(payload, p); p += name.bytesRead;
      if (p !== payload.length) {
        throw new ProtocolViolationError('REQUEST_ERROR Redirect: unexpected trailing bytes after Track Name');
      }
      validateTrackNamespacePrefix(ns.value); // size limits (0-32 fields, ≤4096 bytes)
      redirect = { connectUri: uri.value, trackNamespace: ns.value, trackName: name.value };
    } else if (p < payload.length) {
      // Trailing bytes on a non-REDIRECT error are a Redirect that does not belong.
      throw new ProtocolViolationError('REQUEST_ERROR: trailing bytes (a Redirect is only valid with Error Code REDIRECT)');
    }

    return {
      type: 'REQUEST_ERROR',
      // §10.6.2: Error Code / Retry Interval are vi64 (full uint64) — accepted raw,
      // not folded through the QUIC-Varint range.
      errorCode: ec.value,
      retryInterval: ri.value,
      errorReason: reason.value,
      ...(redirect ? { redirect } : {}),
    };
  }

  // draft-23 §9.4.2: Error Details are Key-Value-Pairs to the end of the
  // message. REDIRECT (0x01) holds draft 22's Redirect fields;
  // UNSUPPORTED_PROPERTY (0x02) a Property Type, and may repeat.

  private encodeRequestError23(msg: RequestErrorMsg): Uint8Array {
    const isRedirect = msg.errorCode === REDIRECT_ERROR_CODE;
    if (msg.redirect && !isRedirect) {
      throw new ProtocolViolationError('REQUEST_ERROR carries a Redirect but Error Code is not REDIRECT (0x34)');
    }
    if (isRedirect && !msg.redirect) {
      throw new ProtocolViolationError('REQUEST_ERROR with Error Code REDIRECT (0x34) requires a REDIRECT Error Detail');
    }
    const details: SetupOptionMap = new Map();
    for (const [type, values] of msg.errorDetails ?? []) {
      if (type !== ERROR_DETAIL_REDIRECT && type !== ERROR_DETAIL_UNSUPPORTED_PROPERTY) details.set(type, [...values]);
    }
    if (msg.redirect) {
      validateTrackNamespacePrefix(msg.redirect.trackNamespace);
      const r = msg.redirect;
      const bytes = new Uint8Array(vi64BytesLength(r.connectUri) + vi64TupleLength(r.trackNamespace) + vi64BytesLength(r.trackName));
      let q = writeVi64Bytes(r.connectUri, bytes, 0);
      q += writeVi64Tuple(r.trackNamespace, bytes, q);
      writeVi64Bytes(r.trackName, bytes, q);
      details.set(ERROR_DETAIL_REDIRECT, [bytes]);
    }
    if (msg.unsupportedProperties && msg.unsupportedProperties.length > 0) {
      details.set(ERROR_DETAIL_UNSUPPORTED_PROPERTY, [...msg.unsupportedProperties]);
    }
    const detailBytes = encodeKvps18(details, ERROR_DETAIL_SINGLETONS, 'Error Detail');
    const buf = new Uint8Array(
      vi64EncodingLength(msg.errorCode) + vi64EncodingLength(msg.retryInterval)
        + reasonPhrase18Length(msg.errorReason) + detailBytes.length,
    );
    let p = writeVi64(msg.errorCode, buf, 0);
    p += writeVi64(msg.retryInterval, buf, p);
    p += writeReasonPhrase18(msg.errorReason, buf, p);
    buf.set(detailBytes, p);
    return buf;
  }

  private decodeRequestError23(
    errorCode: bigint,
    retryInterval: bigint,
    errorReason: string,
    payload: Uint8Array,
    offset: number,
  ): DecodedControlMessage {
    const details = decodeSetupOptionMap18(payload, offset);
    // Known details on an Error Code they are not defined for are ignored.
    let redirect: Redirect | undefined;
    if (errorCode === REDIRECT_ERROR_CODE) {
      const values = details.get(ERROR_DETAIL_REDIRECT);
      if (!values || values.length !== 1) {
        throw new ProtocolViolationError('REQUEST_ERROR REDIRECT needs exactly one REDIRECT Error Detail', MALFORMED_MESSAGE);
      }
      const bytes = values[0] as Uint8Array;
      let p = 0;
      const uri = readVi64Bytes(bytes, p); p += uri.bytesRead;
      const ns = readVi64Tuple(bytes, p); p += ns.bytesRead;
      const name = readVi64Bytes(bytes, p); p += name.bytesRead;
      if (p !== bytes.length) {
        throw new ProtocolViolationError('REDIRECT Error Detail: unexpected trailing bytes after Track Name', MALFORMED_MESSAGE);
      }
      validateTrackNamespacePrefix(ns.value);
      redirect = { connectUri: uri.value, trackNamespace: ns.value, trackName: name.value };
    }
    const unsupported = errorCode === UNSUPPORTED_EXTENSION_ERROR_CODE
      ? details.get(ERROR_DETAIL_UNSUPPORTED_PROPERTY) as bigint[] | undefined
      : undefined;
    return {
      type: 'REQUEST_ERROR',
      errorCode,
      retryInterval,
      errorReason,
      ...(redirect ? { redirect } : {}),
      ...(unsupported ? { unsupportedProperties: unsupported } : {}),
      ...(details.size > 0 ? { errorDetails: details } : {}),
    };
  }

  // ── FETCH (request, §10.12) ─────────────────────────────────────────
  // First message on a new bidi request stream. Keeps its Request ID. The
  // Standalone body uses vi64 Location fields (full uint64, no QUIC cap).

  private encodeFetch(msg: Fetch): Uint8Array {
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const f = msg.fetch;
    let bodyLen: number;
    if (f.fetchType === 0x1) {
      // §2.4.1: a standalone FETCH carries a Full Track Name (≤ 4096 bytes, 0-32
      // non-empty namespace fields). Joining fetches carry no name.
      validateFullTrackName(f.trackNamespace, f.trackName, this.fullTrackNameRules);
      bodyLen =
        vi64TupleLength(f.trackNamespace) +
        vi64BytesLength(f.trackName) +
        vi64LocationLength(f.startLocation) +
        vi64LocationLength(f.endLocation);
    } else {
      // Joining Start is vi64 (full uint64) in draft-18 — no QUIC-range cap.
      bodyLen = vi64EncodingLength(f.joiningRequestId) + vi64EncodingLength(f.joiningStart);
    }
    const len =
      vi64EncodingLength(msg.requestId) +
      vi64EncodingLength(BigInt(f.fetchType)) +
      bodyLen +
      messageParams18EncodingLength(typed, this.paramRegistry);
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.requestId, buf, 0);
    p += writeVi64(BigInt(f.fetchType), buf, p);
    if (f.fetchType === 0x1) {
      p += writeVi64Tuple(f.trackNamespace, buf, p);
      p += writeVi64Bytes(f.trackName, buf, p);
      p += writeVi64Location(f.startLocation, buf, p);
      p += writeVi64Location(f.endLocation, buf, p);
    } else {
      p += writeVi64(f.joiningRequestId, buf, p);
      p += writeVi64(f.joiningStart, buf, p);
    }
    buf.set(encodeMessageParams18(typed, this.paramRegistry), p);
    return buf;
  }

  private decodeFetch(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const ft = readVi64(payload, p); p += ft.bytesRead;
    const fetchType = Number(ft.value);

    let fetch: StandaloneFetch | JoiningFetch;
    if (fetchType === 0x1) {
      const ns = readVi64Tuple(payload, p); p += ns.bytesRead;
      const name = readVi64Bytes(payload, p); p += name.bytesRead;
      const start = readVi64Location(payload, p); p += start.bytesRead;
      const end = readVi64Location(payload, p); p += end.bytesRead;
      // §2.4.1: a standalone FETCH carries a Full Track Name (≤ 4096 bytes, 0-32
      // non-empty namespace fields).
      validateFullTrackName(ns.value, name.value, this.fullTrackNameRules);
      fetch = {
        fetchType: 0x1,
        trackNamespace: ns.value,
        trackName: name.value,
        startLocation: start.value,
        endLocation: end.value,
      };
    } else if (fetchType === 0x2 || fetchType === 0x3) {
      const jrid = readVi64(payload, p); p += jrid.bytesRead;
      const jstart = readVi64(payload, p); p += jstart.bytesRead;
      // Joining Start is full-uint64 vi64 in draft-18 — kept as a raw bigint.
      fetch = { fetchType, joiningRequestId: jrid.value, joiningStart: jstart.value };
    } else {
      throw new ProtocolViolationError(`FETCH: invalid Fetch Type 0x${ft.value.toString(16)}`);
    }

    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError('FETCH: unexpected trailing bytes after parameters');
    }
    return { type: 'FETCH', requestId: rid.value, fetch, parameters: typedToParams(params.params) };
  }

  // ── draft-22 FETCH (§9.11): Request ID, Full Track Name, Parameters ──
  // The range is a LOCATION_FILTER parameter. A StandaloneFetch's draft-18
  // range maps onto it: the draft-18 End Location's Object is exclusive, with 0
  // meaning the whole End Group, while the LOCATION_FILTER's EndObject is
  // inclusive and omitted for a whole group. There is no Joining FETCH: a
  // subscriber asks for the prefix with FILL_PARAMETERS on its SUBSCRIBE.

  private encodeFetch22(msg: Fetch): Uint8Array {
    const f = msg.fetch;
    if (f.fetchType !== 0x1) {
      throw new ProtocolViolationError('draft-22 has no Joining FETCH; request the prefix with FILL_PARAMETERS');
    }
    validateFullTrackName(f.trackNamespace, f.trackName, this.fullTrackNameRules);
    const parameters = new Map(msg.parameters);
    if (!parameters.has(LOCATION_FILTER_TYPE)) {
      const { startLocation: start, endLocation: end } = f;
      if (end.group < start.group) {
        throw new ProtocolViolationError(`FETCH End Group ${end.group} < Start Group ${start.group}`);
      }
      const fields = [start.group, start.object, end.group - start.group];
      if (end.object > 0n) fields.push(end.object - 1n);
      parameters.set(LOCATION_FILTER_TYPE, [encodeFetchLocationFilter(fields)]);
    }
    const typed = paramsToTyped(parameters, this.paramRegistry);
    const len =
      vi64EncodingLength(msg.requestId) +
      vi64TupleLength(f.trackNamespace) +
      vi64BytesLength(f.trackName) +
      messageParams18EncodingLength(typed, this.paramRegistry);
    const buf = new Uint8Array(len);
    let p = writeVi64(msg.requestId, buf, 0);
    p += writeVi64Tuple(f.trackNamespace, buf, p);
    p += writeVi64Bytes(f.trackName, buf, p);
    buf.set(encodeMessageParams18(typed, this.paramRegistry), p);
    return buf;
  }

  /**
   * Decodes a draft-22 FETCH into a StandaloneFetch. An absolute LOCATION_FILTER
   * with an end maps back to the draft-18 range; a filter that depends on the
   * Largest Object (one field, or two fields with no end) or no filter at all
   * gets a start of {0, 0} or its StartGroup/StartObject and an open end
   * ({2^64-1, 0}), and the LOCATION_FILTER stays in `parameters` for the
   * receiver to resolve.
   */
  private decodeFetch22(payload: Uint8Array): DecodedControlMessage {
    let p = 0;
    const rid = readVi64(payload, p); p += rid.bytesRead;
    const ns = readVi64Tuple(payload, p); p += ns.bytesRead;
    const name = readVi64Bytes(payload, p); p += name.bytesRead;
    validateFullTrackName(ns.value, name.value, this.fullTrackNameRules);
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    if (p !== payload.length) {
      throw new ProtocolViolationError('FETCH: unexpected trailing bytes after parameters');
    }
    const parameters = typedToParams(params.params);
    const filter = parameters.get(LOCATION_FILTER_TYPE)?.[0];
    let fields: bigint[] = [];
    if (filter !== undefined) {
      if (!(filter instanceof Uint8Array)) throw new ProtocolViolationError('FETCH: LOCATION_FILTER is not bytes');
      try {
        fields = decodeFetchLocationFilter(filter);
      } catch (e) {
        throw new ProtocolViolationError(`FETCH: ${(e as Error).message}`);
      }
    }
    const openEnd = { group: MAX_VI64, object: 0n };
    let startLocation = { group: 0n, object: 0n };
    let endLocation = openEnd;
    if (fields.length === 2) {
      startLocation = { group: fields[0]!, object: fields[1]! };
    } else if (fields.length >= 3) {
      startLocation = { group: fields[0]!, object: fields[1]! };
      const endGroup = fields[0]! + fields[2]!;
      endLocation = { group: endGroup, object: fields.length === 4 ? fields[3]! + 1n : 0n };
    }
    return {
      type: 'FETCH',
      requestId: rid.value,
      fetch: { fetchType: 0x1, trackNamespace: ns.value, trackName: name.value, startLocation, endLocation },
      parameters,
    };
  }

  // ── draft-22 PUBLISH_STATE_NOTIFY (§9.10): Parameters only ──────────

  private encodeParamsOnly(parameters: Parameters): Uint8Array {
    const typed = paramsToTyped(parameters, this.paramRegistry);
    return encodeMessageParams18(typed, this.paramRegistry);
  }

  private decodeParamsOnly(payload: Uint8Array, what: string): Parameters {
    const params = decodeMessageParams18(payload, 0, this.paramRegistry);
    if (params.bytesRead !== payload.length) {
      throw new ProtocolViolationError(`${what}: unexpected trailing bytes after parameters`);
    }
    return typedToParams(params.params);
  }

  // ── FETCH_OK (response, §10.13 — no Request ID) ────────────────────
  // Sent as the first message on the same bidi stream; the topology stamps the
  // Request ID from the stream context. Track Properties (§2.5) trail the params.

  private encodeFetchOk(msg: FetchOk): Uint8Array {
    if (msg.endOfTrack !== 0 && msg.endOfTrack !== 1) {
      throw new ProtocolViolationError(`FETCH_OK End Of Track must be 0 or 1, got ${msg.endOfTrack}`);
    }
    const typed = paramsToTyped(msg.parameters, this.paramRegistry);
    const len =
      1 + vi64LocationLength(msg.endLocation) +
      messageParams18EncodingLength(typed, this.paramRegistry) +
      trackProperties18EncodingLength(trackPropsOf(msg));
    const buf = new Uint8Array(len);
    let p = 0;
    buf[p++] = msg.endOfTrack;
    p += writeVi64Location(msg.endLocation, buf, p);
    const params = encodeMessageParams18(typed, this.paramRegistry);
    buf.set(params, p); p += params.length;
    buf.set(encodeTrackProperties18(trackPropsOf(msg)), p);
    return buf;
  }

  private decodeFetchOk(payload: Uint8Array): DecodedControlMessage {
    if (payload.length < 1) throw new ProtocolViolationError('FETCH_OK: truncated');
    let p = 0;
    const endOfTrack = payload[p++]!;
    if (endOfTrack !== 0 && endOfTrack !== 1) {
      throw new ProtocolViolationError(`FETCH_OK End Of Track must be 0 or 1, got ${endOfTrack}`);
    }
    const end = readVi64Location(payload, p); p += end.bytesRead;
    const params = decodeMessageParams18(payload, p, this.paramRegistry);
    p += params.bytesRead;
    const props = decodeTrackProperties18(payload, p); // remaining bytes (empty → {})
    p += props.bytesRead;
    // Response: Request ID omitted on the wire (topology stamps it).
    return {
      type: 'FETCH_OK',
      endOfTrack,
      endLocation: end.value,
      parameters: typedToParams(params.params),
      trackProperties: props.properties, trackExtensions: props.properties,
    };
  }
}
