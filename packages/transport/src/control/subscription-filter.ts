/**
 * SUBSCRIPTION_FILTER wire codec (§5.1.2).
 *
 * The SUBSCRIPTION_FILTER message parameter carries a Subscription Filter
 * structure: Filter Type, optional Start Location, optional End Group. The wire
 * form is version-specific:
 *   - draft-14/16: QUIC-varint internals, ABSOLUTE End Group.
 *   - draft-18:    vi64 internals (full uint64), and AbsoluteRange carries an
 *                  End Group DELTA (`endGroup - startGroup`) rather than the
 *                  absolute End Group (§5.1.2).
 *
 * The semantic {@link SubscriptionFilter} keeps `endGroup` ABSOLUTE for callers
 * across all drafts — the delta is purely a wire detail handled here. This lives
 * outside the sans-I/O session core so the session never imports a wire varint
 * primitive directly.
 *
 * @see draft-ietf-moq-transport-18 §5.1.2
 * @module
 */

import { varint, writeVarint, varintEncodingLength, readVarint } from '../primitives/varint.js';
import { readLocation } from '../primitives/location.js';
import { readVi64, writeVi64, vi64EncodingLength, MAX_VI64 } from '../primitives/vi64.js';
import { isDraft22, isRequestStreamDraft } from '../versions.js';

/**
 * Subscription filter — controls which objects pass through a subscription.
 * `AbsoluteRange.endGroup` is the ABSOLUTE end group in the semantic API for all
 * drafts; the wire codec serializes draft-18 as an End Group Delta and draft-14/16
 * as the absolute value. Integer fields are raw `bigint`: draft-18 carries the
 * full uint64 range, draft-14/16 a QUIC varint (range-guarded by the encoder).
 *
 * @see draft-ietf-moq-transport-18 §5.1.2 (Subscription Filters)
 * @see draft-ietf-moq-transport-18 §10.2.9 (SUBSCRIPTION_FILTER parameter)
 */
export type SubscriptionFilter =
  /** §5.1.2: Start at next group after Largest Object. */
  | { readonly type: 'NextGroupStart' }
  /** §5.1.2: Start after the Largest Object. */
  | { readonly type: 'LargestObject' }
  /** @deprecated Use 'LargestObject'. Alias kept for backward compatibility. */
  | { readonly type: 'LatestObject' }
  /** §5.1.2: Start at an explicit location (open-ended). */
  | { readonly type: 'AbsoluteStart'; readonly startGroup: bigint; readonly startObject: bigint }
  /**
   * §5.1.2: Explicit start and (absolute) end group. `endObject` (draft 22 only)
   * is the inclusive last object of the end group; without it the whole end
   * group is included.
   */
  | {
      readonly type: 'AbsoluteRange';
      readonly startGroup: bigint;
      readonly startObject: bigint;
      readonly endGroup: bigint;
      readonly endObject?: bigint;
    }
  /**
   * draft-22 §9.20.9 only: start `groups` groups back from the Next Group
   * (1 = the current group), open-ended. LOCATION_FILTER type 0x01.
   */
  | { readonly type: 'RelativeStart'; readonly groups: bigint };

const FILTER_TYPE: Record<Exclude<SubscriptionFilter['type'], 'RelativeStart'>, bigint> = {
  NextGroupStart: 0x1n,
  LargestObject: 0x2n,
  LatestObject: 0x2n, // deprecated alias
  AbsoluteStart: 0x3n,
  AbsoluteRange: 0x4n,
};

// ─── draft-22 typed LOCATION_FILTER (§9.20.9) ────────────────────────

/**
 * draft-22 Location Filter Types. The type selects which fields follow and
 * replaces draft 21's Length, so an absolute {0, 0} start (0x02) is no longer
 * the same bytes as the Next Object (0x05).
 */
const LocationFilterType = {
  NONE: 0x0n,
  RELATIVE_START: 0x1n,
  ABSOLUTE_START: 0x2n,
  ABSOLUTE_START_GROUP_END: 0x3n,
  ABSOLUTE_RANGE: 0x4n,
  NEXT_OBJECT: 0x5n,
} as const;

/** A LOCATION_FILTER carries at most StartGroup, StartObject, EndGroupDelta, EndObject. */
const MAX_LOCATION_FIELDS = 4;

/** Fields that follow each draft-22 Location Filter Type. */
const TYPED_FIELD_COUNTS = [0, 1, 2, 3, 4, 0] as const;

/** The draft-22 typed LOCATION_FILTER value (type, then fields) for `filter`. */
function typedLocationFilterFields(filter: SubscriptionFilter): bigint[] {
  switch (filter.type) {
    case 'NextGroupStart':
      return [LocationFilterType.RELATIVE_START, 0n];
    case 'LargestObject':
    case 'LatestObject':
      return [LocationFilterType.NEXT_OBJECT];
    case 'RelativeStart':
      if (filter.groups < 1n) throw new RangeError(`RelativeStart groups ${filter.groups} < 1 (0 is NextGroupStart)`);
      return [LocationFilterType.RELATIVE_START, filter.groups];
    case 'AbsoluteStart':
      return [LocationFilterType.ABSOLUTE_START, filter.startGroup, filter.startObject];
    case 'AbsoluteRange': {
      if (filter.endGroup < filter.startGroup) {
        throw new RangeError(`AbsoluteRange endGroup ${filter.endGroup} < startGroup ${filter.startGroup}`);
      }
      if (filter.endGroup > MAX_VI64) {
        throw new RangeError(`AbsoluteRange endGroup ${filter.endGroup} exceeds 2^64-1`);
      }
      const delta = filter.endGroup - filter.startGroup;
      return filter.endObject === undefined
        ? [LocationFilterType.ABSOLUTE_START_GROUP_END, filter.startGroup, filter.startObject, delta]
        : [LocationFilterType.ABSOLUTE_RANGE, filter.startGroup, filter.startObject, delta, filter.endObject];
    }
  }
}

/** Encode a draft-22 typed LOCATION_FILTER value. */
export function encodeTypedLocationFilter(filter: SubscriptionFilter): Uint8Array {
  const values = typedLocationFilterFields(filter);
  let size = 0;
  for (const v of values) size += vi64EncodingLength(v);
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const v of values) offset += writeVi64(v, buf, offset);
  return buf;
}

/**
 * Validate a draft-22 typed LOCATION_FILTER value: a known type, exactly the
 * fields it selects, nothing after them, and StartGroup + EndGroupDelta within
 * 2^64-1.
 */
function validateTypedLocationFilter(bytes: Uint8Array): string | undefined {
  let pos = 0;
  const values: bigint[] = [];
  try {
    const type = readVi64(bytes, pos);
    pos += type.bytesRead;
    if (type.value > LocationFilterType.NEXT_OBJECT) return `unknown Location Filter Type ${type.value}`;
    values.push(type.value);
    for (let i = 0; i < TYPED_FIELD_COUNTS[Number(type.value)]!; i++) {
      const r = readVi64(bytes, pos);
      values.push(r.value);
      pos += r.bytesRead;
    }
  } catch {
    return 'LOCATION_FILTER has a truncated field';
  }
  if (pos !== bytes.length) return 'LOCATION_FILTER has bytes after its fields';
  if (values.length >= 4 && values[1]! + values[3]! > MAX_VI64) {
    return `LOCATION_FILTER overflows uint64: StartGroup ${values[1]} + EndGroupDelta ${values[3]}`;
  }
  return undefined;
}

/**
 * Encode a FETCH range as a LOCATION_FILTER. `fields` are the absolute
 * StartGroup, StartObject, EndGroupDelta and EndObject, so two to four fields
 * are types 0x02-0x04 and none is type 0x00 (no filter).
 */
export function encodeFetchLocationFilter(fields: readonly bigint[]): Uint8Array {
  if (fields.length > MAX_LOCATION_FIELDS || fields.length === 1) {
    throw new RangeError(`a FETCH LOCATION_FILTER has 0 or 2-4 fields, not ${fields.length}`);
  }
  const values = [BigInt(fields.length), ...fields];
  let size = 0;
  for (const v of values) size += vi64EncodingLength(v);
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const v of values) offset += writeVi64(v, buf, offset);
  return buf;
}

/**
 * Decode a FETCH's LOCATION_FILTER into its fields (StartGroup, StartObject,
 * EndGroupDelta, EndObject; as many as the type carries). A relative start
 * keeps its one field and the Next Object (0x05) is {0, 0}; the FETCH mapping
 * leaves either to the receiver to resolve against the Largest Object.
 * @throws {RangeError} on malformed bytes.
 */
export function decodeFetchLocationFilter(bytes: Uint8Array): bigint[] {
  const reason = validateTypedLocationFilter(bytes);
  if (reason !== undefined) throw new RangeError(`decodeFetchLocationFilter: ${reason}`);
  const values: bigint[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const r = readVi64(bytes, pos);
    values.push(r.value);
    pos += r.bytesRead;
  }
  return values[0] === LocationFilterType.NEXT_OBJECT ? [0n, 0n] : values.slice(1);
}

/** The {@link SubscriptionFilter} a draft-22 typed LOCATION_FILTER expresses. */
function filterFromTypedLocationFilter(bytes: Uint8Array): SubscriptionFilter {
  const values: bigint[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const r = readVi64(bytes, pos);
    values.push(r.value);
    pos += r.bytesRead;
  }
  const [type, a, b, c, d] = values;
  switch (type) {
    case LocationFilterType.NONE:
      return { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n };
    case LocationFilterType.RELATIVE_START:
      return a === 0n ? { type: 'NextGroupStart' } : { type: 'RelativeStart', groups: a! };
    case LocationFilterType.ABSOLUTE_START:
      return { type: 'AbsoluteStart', startGroup: a!, startObject: b! };
    case LocationFilterType.ABSOLUTE_START_GROUP_END:
      return { type: 'AbsoluteRange', startGroup: a!, startObject: b!, endGroup: a! + c! };
    case LocationFilterType.ABSOLUTE_RANGE:
      return { type: 'AbsoluteRange', startGroup: a!, startObject: b!, endGroup: a! + c!, endObject: d! };
    default:
      return { type: 'LargestObject' };
  }
}

/**
 * The FILL_PARAMETERS value (§9.20.15) for a fill over `filter`: a bare
 * parameter sequence (no count, bounded by the Length) holding its typed
 * LOCATION_FILTER, which has no Length of its own (§9.20.9). With no filter the
 * value is empty, a fill of the whole track.
 */
export function encodeFillParameters(filter?: SubscriptionFilter): Uint8Array {
  if (filter === undefined) return new Uint8Array(0);
  const value = encodeTypedLocationFilter(filter);
  const type = 0x21n; // LOCATION_FILTER; the first Type delta is from 0
  const buf = new Uint8Array(vi64EncodingLength(type) + value.length);
  const offset = writeVi64(type, buf, 0);
  buf.set(value, offset);
  return buf;
}

/**
 * Encode a {@link SubscriptionFilter} into the inner wire bytes of a
 * SUBSCRIPTION_FILTER parameter (the message-parameter codec adds the outer
 * length prefix).
 *
 * @throws {RangeError} on draft-14/16 if a field exceeds the QUIC-varint range;
 *   on any draft if an AbsoluteRange `endGroup` is below its `startGroup`; or on
 *   draft-18 if the absolute `endGroup` exceeds 2^64-1 (the wire delta would be
 *   valid but `Start Group + Delta` overflows uint64).
 */
export function encodeSubscriptionFilter(filter: SubscriptionFilter, draftVersion: number): Uint8Array {
  // draft-22 §9.20.9: the 0x21 parameter is a typed LOCATION_FILTER.
  if (isDraft22(draftVersion)) return encodeTypedLocationFilter(filter);
  if (filter.type === 'RelativeStart') {
    throw new RangeError(`RelativeStart has no draft-${draftVersion} SUBSCRIPTION_FILTER form`);
  }
  if (filter.type === 'AbsoluteRange' && filter.endObject !== undefined) {
    throw new RangeError(`AbsoluteRange endObject has no draft-${draftVersion} SUBSCRIPTION_FILTER form`);
  }
  const filterType = FILTER_TYPE[filter.type];

  // draft-18 §5.1.2: vi64 internals; AbsoluteRange carries an End Group DELTA.
  if (isRequestStreamDraft(draftVersion)) {
    let endGroupDelta = 0n;
    if (filter.type === 'AbsoluteRange') {
      if (filter.endGroup < filter.startGroup) {
        throw new RangeError(`AbsoluteRange endGroup ${filter.endGroup} < startGroup ${filter.startGroup}`);
      }
      // The semantic endGroup is ABSOLUTE; the wire carries only the delta, so the
      // absolute end group must itself fit uint64 — otherwise the encoded bytes
      // (Start Group + Delta) would overflow and the receiver would reject them.
      if (filter.endGroup > MAX_VI64) {
        throw new RangeError(`AbsoluteRange endGroup ${filter.endGroup} exceeds 2^64-1`);
      }
      endGroupDelta = filter.endGroup - filter.startGroup;
    }
    let size = vi64EncodingLength(filterType);
    if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
      size += vi64EncodingLength(filter.startGroup) + vi64EncodingLength(filter.startObject);
    }
    if (filter.type === 'AbsoluteRange') size += vi64EncodingLength(endGroupDelta);

    const buf = new Uint8Array(size);
    let offset = writeVi64(filterType, buf, 0);
    if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
      offset += writeVi64(filter.startGroup, buf, offset);
      offset += writeVi64(filter.startObject, buf, offset);
    }
    if (filter.type === 'AbsoluteRange') writeVi64(endGroupDelta, buf, offset);
    return buf;
  }

  // draft-14/16: QUIC-varint internals, ABSOLUTE End Group. writeVarint /
  // varintEncodingLength range-guard, so an above-QUIC field throws here.
  const ft = varint(filterType);
  let size = varintEncodingLength(ft);
  if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
    size += varintEncodingLength(filter.startGroup);
    size += varintEncodingLength(filter.startObject);
  }
  if (filter.type === 'AbsoluteRange') {
    size += varintEncodingLength(filter.endGroup);
  }

  const buf = new Uint8Array(size);
  let offset = writeVarint(ft, buf, 0);
  if (filter.type === 'AbsoluteStart' || filter.type === 'AbsoluteRange') {
    offset += writeVarint(filter.startGroup, buf, offset);
    offset += writeVarint(filter.startObject, buf, offset);
  }
  if (filter.type === 'AbsoluteRange') {
    writeVarint(filter.endGroup, buf, offset);
  }
  return buf;
}

/**
 * Decode the inner bytes of a SUBSCRIPTION_FILTER parameter (§5.1.2) into the
 * semantic {@link SubscriptionFilter}. The third leg beside encode/validate —
 * the publisher-side session stores the subscriber's decoded filter so the
 * joining FETCH gate (§9.16.2) can be enforced against it.
 *
 * `AbsoluteRange.endGroup` is returned ABSOLUTE on every draft (the draft-18
 * wire delta is undone here, mirroring the encoder). The deprecated
 * `LatestObject` alias decodes as `LargestObject` (same wire type 0x2).
 *
 * @throws {RangeError} on malformed bytes — validate with
 *   {@link validateSubscriptionFilter} first when a graceful reason string is
 *   needed instead of an exception.
 */
export function decodeSubscriptionFilter(bytes: Uint8Array, draftVersion: number): SubscriptionFilter {
  const reason = validateSubscriptionFilter(bytes, draftVersion);
  if (reason !== undefined) {
    throw new RangeError(`decodeSubscriptionFilter: ${reason}`);
  }
  if (isDraft22(draftVersion)) return filterFromTypedLocationFilter(bytes);

  const read = isRequestStreamDraft(draftVersion)
    ? (pos: number) => readVi64(bytes, pos)
    : (pos: number) => {
        const { value, bytesRead } = readVarint(bytes, pos);
        return { value: value as bigint, bytesRead };
      };

  let pos = 0;
  const ft = read(pos);
  pos += ft.bytesRead;

  if (ft.value === 1n) return { type: 'NextGroupStart' };
  if (ft.value === 2n) return { type: 'LargestObject' };

  const g = read(pos);
  pos += g.bytesRead;
  const o = read(pos);
  pos += o.bytesRead;

  if (ft.value === 3n) {
    return { type: 'AbsoluteStart', startGroup: g.value, startObject: o.value };
  }

  // AbsoluteRange (0x4): draft-18 carries an End Group DELTA, 14/16 the absolute value.
  const e = read(pos);
  const endGroup = isRequestStreamDraft(draftVersion) ? g.value + e.value : e.value;
  return { type: 'AbsoluteRange', startGroup: g.value, startObject: o.value, endGroup };
}

/**
 * Validate the inner bytes of a SUBSCRIPTION_FILTER parameter (§5.1.2).
 * @returns a violation reason string if malformed, or `undefined` if valid.
 *   The caller maps a returned reason to a PROTOCOL_VIOLATION close.
 */
export function validateSubscriptionFilter(bytes: Uint8Array, draftVersion: number): string | undefined {
  if (isDraft22(draftVersion)) return validateTypedLocationFilter(bytes);
  return isRequestStreamDraft(draftVersion)
    ? validateSubscriptionFilter18(bytes)
    : validateSubscriptionFilterLegacy(bytes);
}

/** draft-14/16: QUIC-varint internals, ABSOLUTE End Group (≥ Start Group). */
function validateSubscriptionFilterLegacy(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return 'SUBSCRIPTION_FILTER is empty';

  let pos = 0;
  let filterType: bigint;
  try {
    const { value, bytesRead } = readVarint(bytes, pos);
    filterType = value as bigint;
    pos += bytesRead;
  } catch {
    return 'SUBSCRIPTION_FILTER has malformed Filter Type varint';
  }

  if (filterType < 1n || filterType > 4n) {
    return `SUBSCRIPTION_FILTER has unknown Filter Type ${filterType}`;
  }

  if (filterType === 1n || filterType === 2n) {
    return pos === bytes.length
      ? undefined
      : `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for Filter Type ${filterType}`;
  }

  let startGroup: bigint;
  try {
    const { value: loc, bytesRead } = readLocation(bytes, pos);
    startGroup = loc.group as bigint;
    pos += bytesRead;
  } catch {
    return 'SUBSCRIPTION_FILTER has malformed Start Location';
  }

  if (filterType === 3n) {
    return pos === bytes.length
      ? undefined
      : `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for AbsoluteStart`;
  }

  let endGroup: bigint;
  try {
    const { value, bytesRead } = readVarint(bytes, pos);
    endGroup = value as bigint;
    pos += bytesRead;
  } catch {
    return 'SUBSCRIPTION_FILTER has malformed End Group varint for AbsoluteRange';
  }

  if (pos !== bytes.length) {
    return `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for AbsoluteRange`;
  }

  // §5.1.2: "End Group MUST specify the same or a larger Group than Start Location"
  if (endGroup < startGroup) {
    return `SUBSCRIPTION_FILTER AbsoluteRange End Group ${endGroup} < Start Group ${startGroup}`;
  }

  return undefined;
}

/**
 * draft-18 §5.1.2: vi64 internals; AbsoluteRange carries an End Group DELTA, not
 * an absolute End Group. Delta 0 is valid (deliver the remainder of the start
 * group). The absolute End Group (Start Group + Delta) MUST NOT exceed 2^64-1.
 */
function validateSubscriptionFilter18(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return 'SUBSCRIPTION_FILTER is empty';

  let pos = 0;
  let filterType: bigint;
  try {
    const r = readVi64(bytes, pos);
    filterType = r.value;
    pos += r.bytesRead;
  } catch {
    return 'SUBSCRIPTION_FILTER has malformed Filter Type';
  }

  if (filterType < 1n || filterType > 4n) {
    return `SUBSCRIPTION_FILTER has unknown Filter Type ${filterType}`;
  }

  if (filterType === 1n || filterType === 2n) {
    return pos === bytes.length
      ? undefined
      : `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for Filter Type ${filterType}`;
  }

  // AbsoluteStart (0x3) / AbsoluteRange (0x4): Start Location = two integers.
  let startGroup: bigint;
  try {
    const g = readVi64(bytes, pos);
    startGroup = g.value;
    pos += g.bytesRead;
    const o = readVi64(bytes, pos); // Start Object (shape only)
    pos += o.bytesRead;
  } catch {
    return 'SUBSCRIPTION_FILTER has malformed Start Location';
  }

  if (filterType === 3n) {
    return pos === bytes.length
      ? undefined
      : `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for AbsoluteStart`;
  }

  // AbsoluteRange (0x4): End Group DELTA. Delta 0 is valid.
  let endGroupDelta: bigint;
  try {
    const d = readVi64(bytes, pos);
    endGroupDelta = d.value;
    pos += d.bytesRead;
  } catch {
    return 'SUBSCRIPTION_FILTER has malformed End Group Delta for AbsoluteRange';
  }

  if (pos !== bytes.length) {
    return `SUBSCRIPTION_FILTER length mismatch: ${bytes.length - pos} trailing bytes for AbsoluteRange`;
  }

  // §5.1.2: Start Group + End Group Delta MUST NOT overflow 2^64-1.
  if (startGroup + endGroupDelta > MAX_VI64) {
    return `SUBSCRIPTION_FILTER AbsoluteRange overflows uint64: Start Group ${startGroup} + End Group Delta ${endGroupDelta}`;
  }

  return undefined;
}

// ─── Subscription windows (draft-22 §3.1 shared Track Aliases) ────────

/** The absolute Locations a subscription's filter selects. `end` is inclusive; without `end.object` the whole end group. */
export interface SubscriptionWindow {
  readonly start: { readonly group: bigint; readonly object: bigint };
  readonly end?: { readonly group: bigint; readonly object?: bigint };
}

/**
 * Resolve a subscription's Location filter against the Largest Object it was
 * established with (SUBSCRIBE_OK's LARGEST_OBJECT; `undefined` for an empty
 * track). A subscriber sharing one Track Alias across several subscriptions to
 * the same track re-applies each window to attribute an object (draft-22 §3.1).
 * No filter selects the whole track.
 */
export function subscriptionWindow(
  filter: SubscriptionFilter | undefined,
  largest: { readonly group: bigint; readonly object: bigint } | undefined,
): SubscriptionWindow {
  const origin = { group: 0n, object: 0n };
  switch (filter?.type) {
    case undefined:
      return { start: origin };
    case 'NextGroupStart':
      return { start: largest ? { group: largest.group + 1n, object: 0n } : origin };
    case 'LargestObject':
    case 'LatestObject':
      return { start: largest ? { group: largest.group, object: largest.object + 1n } : origin };
    case 'RelativeStart': {
      if (!largest) return { start: origin };
      const group = largest.group + 1n - filter.groups;
      return { start: { group: group > 0n ? group : 0n, object: 0n } };
    }
    case 'AbsoluteStart':
      return { start: { group: filter.startGroup, object: filter.startObject } };
    case 'AbsoluteRange':
      return {
        start: { group: filter.startGroup, object: filter.startObject },
        end: filter.endObject === undefined
          ? { group: filter.endGroup }
          : { group: filter.endGroup, object: filter.endObject },
      };
  }
}

/** Whether Location {group, object} falls inside `window`. */
export function windowContains(window: SubscriptionWindow, group: bigint, object: bigint): boolean {
  const { start, end } = window;
  if (group < start.group || (group === start.group && object < start.object)) return false;
  if (end === undefined) return true;
  if (group > end.group) return false;
  return group < end.group || end.object === undefined || object <= end.object;
}
