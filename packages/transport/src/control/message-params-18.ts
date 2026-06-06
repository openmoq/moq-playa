/**
 * draft-18 Message Parameter codec (§10.2).
 *
 * Replaces the draft-16 KVP encoding. The wire form is a vi64 count followed by
 * that many `Message Parameter { Type Delta (vi64), Value (..) }`, serialized in
 * ascending Type order (delta = thisType - prevType, prevType starts at 0). The
 * value encoding is fixed per parameter Type:
 *   - uint8: a single byte
 *   - varint: a vi64  ← NOT the QUIC varint
 *   - location: two vi64 (group, object)
 *   - bytes: a vi64 length followed by that many bytes
 *
 * Because every parameter must be understood, there is no skip mechanism: an
 * unknown Type is a PROTOCOL_VIOLATION, and so is a cumulative Type that exceeds
 * 2^64-1. Decoding therefore requires a registry mapping Type → value kind.
 *
 * @see draft-ietf-moq-transport-18 §10.2
 * @module
 */

import { readVi64, writeVi64, vi64EncodingLength, MAX_VI64 } from '../primitives/vi64.js';
import { readUint8, writeUint8, validateTrackNamespacePrefix } from '../primitives/bytes.js';
import { ProtocolViolationError } from '../errors.js';
import { MessageParam18, type ParamValueKind } from './codes-18.js';

export type { ParamValueKind };

/** A decoded/encodable message-parameter value, tagged by its wire encoding. */
export type MessageParamValue =
  | { readonly kind: 'uint8'; readonly value: number }
  | { readonly kind: 'varint'; readonly value: bigint }
  | { readonly kind: 'location'; readonly group: bigint; readonly object: bigint }
  | { readonly kind: 'bytes'; readonly value: Uint8Array }
  // Track Namespace structure (§2.4.1): vi64 field count + vi64-length-prefixed
  // fields. The semantic value is the field list (e.g. TRACK_NAMESPACE_PREFIX).
  | { readonly kind: 'namespace'; readonly value: Uint8Array[] };

// ─── Track Namespace tuple (vi64 count + vi64-length-prefixed fields) ──

/**
 * Enforce the Track Namespace structural rules (§2.4.1) at the codec boundary:
 * every field is a Uint8Array, ≤32 fields, each field non-empty, total ≤4096
 * bytes. (A 0-field tuple is a valid prefix.)
 * @throws {ProtocolViolationError} on any violation.
 */
function assertNamespaceTuple(fields: readonly Uint8Array[]): void {
  for (let i = 0; i < fields.length; i++) {
    if (!(fields[i] instanceof Uint8Array)) {
      throw new ProtocolViolationError(`Track Namespace field ${i} is not a Uint8Array`);
    }
  }
  validateTrackNamespacePrefix(fields as Uint8Array[]); // ≤32 fields, non-empty, ≤4096 bytes
}

function namespaceTupleLength(fields: readonly Uint8Array[]): number {
  assertNamespaceTuple(fields);
  let len = vi64EncodingLength(BigInt(fields.length));
  for (const f of fields) len += vi64EncodingLength(BigInt(f.length)) + f.length;
  return len;
}

function writeNamespaceTuple(fields: readonly Uint8Array[], buf: Uint8Array, offset: number): number {
  let p = offset + writeVi64(BigInt(fields.length), buf, offset);
  for (const f of fields) {
    p += writeVi64(BigInt(f.length), buf, p);
    buf.set(f, p);
    p += f.length;
  }
  return p - offset;
}

function readNamespaceTuple(buf: Uint8Array, offset: number): { value: Uint8Array[]; bytesRead: number } {
  const count = readVi64(buf, offset);
  let p = offset + count.bytesRead;
  const fields: Uint8Array[] = [];
  for (let i = 0n; i < count.value; i++) {
    const len = readVi64(buf, p);
    p += len.bytesRead;
    const n = Number(len.value);
    if (p + n > buf.length) {
      throw new ProtocolViolationError('Track Namespace field exceeds buffer');
    }
    fields.push(buf.slice(p, p + n));
    p += n;
  }
  // Reject malformed wire structure (>32 fields, empty field, >4096 bytes) at the
  // namespace-kind boundary rather than deferring to the session.
  validateTrackNamespacePrefix(fields);
  return { value: fields, bytesRead: p - offset };
}

/**
 * Message parameters keyed by Type. Values are arrays to allow parameter Types
 * that permit multiple instances (mirrors the draft-16 representation). Type is a
 * bigint to preserve the full vi64 range without precision loss.
 */
export type MessageParams18 = ReadonlyMap<bigint, readonly MessageParamValue[]>;

/** Registry mapping a parameter Type to the encoding kind of its value. */
export type MessageParamRegistry = ReadonlyMap<bigint, ParamValueKind>;

/** Default registry built from the draft-18 message-parameter type table (§10.2). */
export const DEFAULT_MESSAGE_PARAM_REGISTRY: MessageParamRegistry = new Map(
  Object.values(MessageParam18).map((d) => [BigInt(d.type), d.kind] as const),
);

// ─── value length / write / read ─────────────────────────────────────

function paramValueLength(v: MessageParamValue): number {
  switch (v.kind) {
    case 'uint8':
      return 1;
    case 'varint':
      return vi64EncodingLength(v.value);
    case 'location':
      return vi64EncodingLength(v.group) + vi64EncodingLength(v.object);
    case 'bytes':
      return vi64EncodingLength(BigInt(v.value.length)) + v.value.length;
    case 'namespace':
      return namespaceTupleLength(v.value);
  }
}

function writeParamValue(v: MessageParamValue, buf: Uint8Array, offset: number): number {
  switch (v.kind) {
    case 'uint8':
      return writeUint8(v.value, buf, offset);
    case 'varint':
      return writeVi64(v.value, buf, offset);
    case 'location': {
      let p = offset;
      p += writeVi64(v.group, buf, p);
      p += writeVi64(v.object, buf, p);
      return p - offset;
    }
    case 'bytes': {
      let p = offset;
      p += writeVi64(BigInt(v.value.length), buf, p);
      buf.set(v.value, p);
      p += v.value.length;
      return p - offset;
    }
    case 'namespace':
      return writeNamespaceTuple(v.value, buf, offset);
  }
}

function readParamValue(
  kind: ParamValueKind,
  buf: Uint8Array,
  offset: number,
): { value: MessageParamValue; bytesRead: number } {
  switch (kind) {
    case 'uint8': {
      const { value, bytesRead } = readUint8(buf, offset);
      return { value: { kind: 'uint8', value }, bytesRead };
    }
    case 'varint': {
      const { value, bytesRead } = readVi64(buf, offset);
      return { value: { kind: 'varint', value }, bytesRead };
    }
    case 'location': {
      const g = readVi64(buf, offset);
      const o = readVi64(buf, offset + g.bytesRead);
      return {
        value: { kind: 'location', group: g.value, object: o.value },
        bytesRead: g.bytesRead + o.bytesRead,
      };
    }
    case 'bytes': {
      const len = readVi64(buf, offset);
      const start = offset + len.bytesRead;
      const n = Number(len.value);
      if (start + n > buf.length) {
        throw new ProtocolViolationError('Message parameter bytes value exceeds buffer');
      }
      return {
        value: { kind: 'bytes', value: buf.slice(start, start + n) },
        bytesRead: len.bytesRead + n,
      };
    }
    case 'namespace': {
      const { value, bytesRead } = readNamespaceTuple(buf, offset);
      return { value: { kind: 'namespace', value }, bytesRead };
    }
  }
}

// ─── encode-side registry validation ────────────────────────────────

/**
 * Enforce that every parameter's Type is known to `registry` and that its value
 * uses that Type's registered wire kind. The generic codec owns this "known Type
 * uses the right wire kind" rule; duplicate-parameter and message-scope checks
 * belong to the message-specific layer above.
 *
 * @throws {ProtocolViolationError} on an unknown Type or a kind mismatch.
 */
function assertParamsMatchRegistry(params: MessageParams18, registry: MessageParamRegistry): void {
  for (const [type, values] of params) {
    const kind = registry.get(type);
    if (kind === undefined) {
      throw new ProtocolViolationError(`Cannot encode unknown message parameter Type 0x${type.toString(16)}`);
    }
    for (const value of values) {
      if (value.kind !== kind) {
        throw new ProtocolViolationError(
          `Message parameter Type 0x${type.toString(16)} expects ${kind}, got ${value.kind}`,
        );
      }
    }
  }
}

// ─── flatten (ascending type, delta-encoded) ─────────────────────────

interface FlatParam {
  readonly delta: bigint;
  readonly value: MessageParamValue;
}

function flatten(params: MessageParams18): FlatParam[] {
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: FlatParam[] = [];
  let prev = 0n;
  for (const [type, values] of entries) {
    for (const value of values) {
      out.push({ delta: type - prev, value });
      prev = type;
    }
  }
  return out;
}

// ─── public codec ────────────────────────────────────────────────────

/** Wire length of the encoded parameter block (including the count prefix). */
export function messageParams18EncodingLength(
  params: MessageParams18,
  registry: MessageParamRegistry = DEFAULT_MESSAGE_PARAM_REGISTRY,
): number {
  assertParamsMatchRegistry(params, registry);
  const flat = flatten(params);
  let len = vi64EncodingLength(BigInt(flat.length));
  for (const { delta, value } of flat) {
    len += vi64EncodingLength(delta) + paramValueLength(value);
  }
  return len;
}

/**
 * Encode message parameters to their draft-18 wire form.
 * @param registry Type→kind registry used to validate that each known Type uses
 *   its correct wire kind (defaults to the standard draft-18 parameter table).
 * @throws {ProtocolViolationError} on an unknown Type or a value/kind mismatch.
 */
export function encodeMessageParams18(
  params: MessageParams18,
  registry: MessageParamRegistry = DEFAULT_MESSAGE_PARAM_REGISTRY,
): Uint8Array {
  assertParamsMatchRegistry(params, registry);
  const flat = flatten(params);
  const buf = new Uint8Array(
    vi64EncodingLength(BigInt(flat.length)) +
      flat.reduce((n, { delta, value }) => n + vi64EncodingLength(delta) + paramValueLength(value), 0),
  );
  let p = writeVi64(BigInt(flat.length), buf, 0);
  for (const { delta, value } of flat) {
    p += writeVi64(delta, buf, p);
    p += writeParamValue(value, buf, p);
  }
  return buf;
}

/**
 * Decode message parameters from `buf` at `offset`, using `registry` to learn
 * each Type's value encoding.
 * @throws {ProtocolViolationError} on an unknown Type or a Type exceeding 2^64-1.
 */
export function decodeMessageParams18(
  buf: Uint8Array,
  offset: number,
  registry: MessageParamRegistry,
): { params: MessageParams18; bytesRead: number } {
  let p = offset;
  const count = readVi64(buf, p);
  p += count.bytesRead;

  const params = new Map<bigint, MessageParamValue[]>();
  let prevType = 0n;
  for (let i = 0n; i < count.value; i++) {
    const delta = readVi64(buf, p);
    p += delta.bytesRead;
    const type = prevType + delta.value;
    if (type > MAX_VI64) {
      throw new ProtocolViolationError(`Message parameter Type ${type} exceeds 2^64-1`);
    }
    prevType = type;

    const kind = registry.get(type);
    if (kind === undefined) {
      throw new ProtocolViolationError(`Unknown message parameter Type 0x${type.toString(16)}`);
    }
    const { value, bytesRead } = readParamValue(kind, buf, p);
    p += bytesRead;

    const existing = params.get(type);
    if (existing) existing.push(value);
    else params.set(type, [value]);
  }

  return { params, bytesRead: p - offset };
}
