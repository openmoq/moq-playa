/**
 * Shared ordered Key-Value-Pair / Property wire core.
 *
 * This is the single production codec for a KVP/Property block across all three
 * wire profiles. Both the draft-14/16 Key-Value-Pair list ({@link ./kvp.js}) and
 * the draft-18 Track Properties block ({@link ../control/track-properties-18.js})
 * consume it — there is no second implementation of the property wire.
 *
 * The representation is an ORDERED list of entries, preserving occurrence order
 * AND duplicate ids losslessly (dedup / grouping is a caller concern). Ids and
 * even-typed values are `bigint` (never narrowed through `Number`). The generic
 * layer enforces only wire-format rules — parity/type, the 2^16-1 odd-value
 * length limit, delta-overflow, per-profile integer range, and canonical
 * (stable ascending-id) minimal encoding. Registry- or track-specific value
 * validation stays in the caller.
 *
 * @see draft-ietf-moq-transport-14 §1.4.2 (absolute)
 * @see draft-ietf-moq-transport-16 §1.4.2 (delta, QUIC varint)
 * @see draft-ietf-moq-transport-18 §1.4.3 (delta, vi64)
 * @module
 */

import { readVarint, writeVarint, varintEncodingLength } from './varint.js';
import { readVi64, writeVi64, vi64EncodingLength, MAX_VI64 } from './vi64.js';

/** A single entry's value: even id ⇒ integer (bigint), odd id ⇒ length-prefixed bytes. */
export type PropertyValue = bigint | Uint8Array;

/** One property, id and value both full-width. */
export interface PropertyEntry {
  readonly id: bigint;
  readonly value: PropertyValue;
}

/** An ordered property map — occurrence order and duplicate ids are significant. */
export type PropertyMap = readonly PropertyEntry[];

export type PropertyWireProfile = 'd14-absolute-varint' | 'd16-delta-varint' | 'd18-delta-vi64';

/** §1.4.3: the maximum length of an odd-type value is 2^16-1 bytes. */
export const MAX_ODD_VALUE_BYTES = 0xffff;

/** A property-wire error, categorised so callers/consumers map it uniformly. */
export type PropertyErrorCategory =
  | 'truncated' | 'length-overrun' | 'delta-overflow' | 'odd-value-too-long'
  | 'parity-mismatch' | 'value-out-of-range';

/**
 * A wire-format violation carrying a machine-readable {@link PropertyErrorCategory}.
 * Extends {@link RangeError} so existing callers whose tests assert `RangeError`
 * (the draft-14/16 KVP path) keep matching, while callers that require their own
 * error class (draft-18 Track Properties → `ProtocolViolationError`) catch it and
 * rethrow. Messages are worded to match the historical assertions of both.
 */
export class PropertyWireError extends RangeError {
  constructor(readonly category: PropertyErrorCategory, message: string) {
    super(message);
    this.name = 'PropertyWireError';
  }
}

interface IntCodec {
  read(buf: Uint8Array, off: number): { value: bigint; bytesRead: number };
  write(value: bigint, buf: Uint8Array, off: number): number;
  length(value: bigint): number;
  readonly max: bigint;
}

const QUIC: IntCodec = {
  read: (b, o) => { const r = readVarint(b, o); return { value: r.value as bigint, bytesRead: r.bytesRead }; },
  write: (v, b, o) => writeVarint(v, b, o), // throws RangeError above 2^62-1
  length: (v) => varintEncodingLength(v),
  max: 4611686018427387903n, // 2^62 - 1
};

const VI64: IntCodec = {
  read: (b, o) => readVi64(b, o),
  write: (v, b, o) => writeVi64(v, b, o),
  length: (v) => vi64EncodingLength(v),
  max: MAX_VI64,
};

function profileCodec(profile: PropertyWireProfile): { int: IntCodec; delta: boolean } {
  switch (profile) {
    case 'd14-absolute-varint': return { int: QUIC, delta: false };
    case 'd16-delta-varint': return { int: QUIC, delta: true };
    case 'd18-delta-vi64': return { int: VI64, delta: true };
  }
}

/**
 * Decode a property block, preserving occurrence order and duplicate ids. Reads
 * either exactly `count` entries or until `end` (default: end of `buf`). A
 * non-minimal integer encoding is legal on read.
 *
 * @throws {RangeError} on a truncated integer (an out-of-bounds read).
 * @throws {PropertyWireError} on delta overflow, an over-long odd value, or an
 *   odd-value length that exceeds the block.
 */
export function decodePropertyBlock(
  buf: Uint8Array,
  offset: number,
  opts: { profile: PropertyWireProfile; count?: number; end?: number },
): { entries: PropertyEntry[]; bytesRead: number } {
  const { int, delta } = profileCodec(opts.profile);
  const end = opts.end ?? buf.length;
  // Validate the framing BEFORE decoding: an `end` past the buffer would let the
  // odd-value bounds check pass on bytes that are not there (Uint8Array.slice
  // silently truncates), silently accepting a truncated value; a reversed or
  // negative range must not decode as an empty success either.
  if (!Number.isInteger(offset) || !Number.isInteger(end) || offset < 0 || end < offset || end > buf.length) {
    throw new RangeError(`property block bounds out of range: offset ${offset}, end ${end}, buffer length ${buf.length}`);
  }
  if (opts.count !== undefined && (!Number.isInteger(opts.count) || opts.count < 0)) {
    throw new RangeError(`property block count must be a non-negative integer, got ${opts.count}`);
  }
  // Read through a view that ENDS at `end`, so no integer (id, length, or even
  // value) can be assembled from bytes beyond the declared block boundary — a
  // multi-byte integer that would cross `end` is a truncated block, not a silent
  // read into the following message bytes.
  const view = end < buf.length ? buf.subarray(0, end) : buf;
  const entries: PropertyEntry[] = [];
  let pos = offset;
  let prev = 0n;
  let i = 0;
  const more = (): boolean => (opts.count !== undefined ? i < opts.count : pos < end);

  while (more()) {
    const idField = int.read(view, pos);
    pos += idField.bytesRead;
    const id = delta ? prev + idField.value : idField.value;
    if (id < 0n || id > MAX_VI64) {
      throw new PropertyWireError('delta-overflow', `property id ${id} exceeds 2^64-1`);
    }
    prev = id;

    let value: PropertyValue;
    if ((id & 1n) === 1n) {
      const lenField = int.read(view, pos);
      pos += lenField.bytesRead;
      const n = Number(lenField.value);
      if (lenField.value > BigInt(MAX_ODD_VALUE_BYTES)) {
        throw new PropertyWireError('odd-value-too-long', `odd-property value length ${lenField.value} exceeds maximum ${MAX_ODD_VALUE_BYTES} (2^16-1)`);
      }
      if (pos + n > end) {
        throw new PropertyWireError('length-overrun', `odd-property value of ${n} bytes exceeds the block`);
      }
      value = buf.slice(pos, pos + n);
      pos += n;
    } else {
      const v = int.read(view, pos);
      pos += v.bytesRead;
      value = v.value;
    }
    entries.push({ id, value });
    i += 1;
  }
  return { entries, bytesRead: pos - offset };
}

/** Stable ascending-id order, preserving the relative order of equal ids. */
export function canonicalOrder(entries: PropertyMap): PropertyEntry[] {
  return entries
    .map((e, i) => [e, i] as const)
    .sort((a, b) => (a[0].id < b[0].id ? -1 : a[0].id > b[0].id ? 1 : a[1] - b[1]))
    .map(([e]) => e);
}

function assertParity(id: bigint, value: PropertyValue): void {
  if (id < 0n || id > MAX_VI64) throw new PropertyWireError('value-out-of-range', `property id ${id} exceeds 2^64-1`);
  const odd = (id & 1n) === 1n;
  if (odd) {
    if (!(value instanceof Uint8Array)) throw new PropertyWireError('parity-mismatch', `odd property id ${id} expects a bytes value`);
    if (value.length > MAX_ODD_VALUE_BYTES) throw new PropertyWireError('odd-value-too-long', `odd-property value length ${value.length} exceeds maximum ${MAX_ODD_VALUE_BYTES} (2^16-1)`);
  } else if (typeof value !== 'bigint') {
    throw new PropertyWireError('parity-mismatch', `even property id ${id} expects a varint value`);
  }
}

/** Wire length of the canonical encoding (0 for an empty map). */
export function propertyBlockEncodingLength(entries: PropertyMap, profile: PropertyWireProfile): number {
  const { int, delta } = profileCodec(profile);
  const ordered = canonicalOrder(entries);
  let len = 0;
  let prev = 0n;
  for (const { id, value } of ordered) {
    assertParity(id, value);
    // The wire field is the delta (or the absolute id for d14). Reject anything
    // outside the profile's integer range HERE, categorised, rather than letting
    // the primitive length function throw a bare RangeError.
    const idField = delta ? id - prev : id;
    if (idField < 0n || idField > int.max) {
      throw new PropertyWireError('value-out-of-range', `property id field ${idField} exceeds the ${profile} range`);
    }
    len += int.length(idField);
    prev = id;
    if ((id & 1n) === 1n) {
      const bytes = value as Uint8Array;
      len += int.length(BigInt(bytes.length)) + bytes.length;
    } else {
      if ((value as bigint) < 0n || (value as bigint) > int.max) {
        throw new PropertyWireError('value-out-of-range', `value ${value} exceeds the ${profile} range`);
      }
      len += int.length(value as bigint);
    }
  }
  return len;
}

/**
 * Encode a property map to its CANONICAL wire form: stable ascending-id order,
 * minimal integer encodings, duplicate relative order preserved.
 *
 * @throws {PropertyWireError} on a parity/type mismatch, an over-long odd value,
 *   or a value outside the profile's integer range.
 */
export function encodePropertyBlock(entries: PropertyMap, profile: PropertyWireProfile): Uint8Array {
  const { int, delta } = profileCodec(profile);
  const ordered = canonicalOrder(entries);
  const buf = new Uint8Array(propertyBlockEncodingLength(entries, profile));
  let pos = 0;
  let prev = 0n;
  for (const { id, value } of ordered) {
    pos += int.write(delta ? id - prev : id, buf, pos);
    prev = id;
    if ((id & 1n) === 1n) {
      const bytes = value as Uint8Array;
      pos += int.write(BigInt(bytes.length), buf, pos);
      buf.set(bytes, pos);
      pos += bytes.length;
    } else {
      try {
        pos += int.write(value as bigint, buf, pos);
      } catch (err) {
        if (err instanceof RangeError) throw new PropertyWireError('value-out-of-range', err.message);
        throw err;
      }
    }
  }
  return buf;
}
