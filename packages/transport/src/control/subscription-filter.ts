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
import { isDraft21, isRequestStreamDraft } from '../versions.js';

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
   * §5.1.2: Explicit start and (absolute) end group. `endObject` (draft 21 only)
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
   * draft-21 §9.20.10 only: start `groups` groups back from the Next Group
   * (1 = the current group), open-ended. The one-field LOCATION_FILTER.
   */
  | { readonly type: 'RelativeStart'; readonly groups: bigint };

const FILTER_TYPE: Record<Exclude<SubscriptionFilter['type'], 'RelativeStart'>, bigint> = {
  NextGroupStart: 0x1n,
  LargestObject: 0x2n,
  LatestObject: 0x2n, // deprecated alias
  AbsoluteStart: 0x3n,
  AbsoluteRange: 0x4n,
};

// ─── draft-21 LOCATION_FILTER (§9.20.10) ─────────────────────────────

/** A LOCATION_FILTER carries at most StartGroup, StartObject, EndGroupDelta, EndObject. */
const MAX_LOCATION_FIELDS = 4;

/** Encode 0-4 LOCATION_FILTER fields: bare vi64s, the count implied by the length. */
export function encodeLocationFilterFields(fields: readonly bigint[]): Uint8Array {
  if (fields.length > MAX_LOCATION_FIELDS) {
    throw new RangeError(`LOCATION_FILTER has ${fields.length} fields; at most ${MAX_LOCATION_FIELDS}`);
  }
  let size = 0;
  for (const f of fields) size += vi64EncodingLength(f);
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const f of fields) offset += writeVi64(f, buf, offset);
  return buf;
}

/**
 * Decode LOCATION_FILTER fields. The Length decides how many are present; more
 * than four, a truncated field, or StartGroup + EndGroupDelta above 2^64-1 is
 * malformed.
 * @throws {RangeError} on malformed bytes.
 */
export function decodeLocationFilterFields(bytes: Uint8Array): bigint[] {
  const reason = validateLocationFilter(bytes);
  if (reason !== undefined) throw new RangeError(`decodeLocationFilterFields: ${reason}`);
  const fields: bigint[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const r = readVi64(bytes, pos);
    fields.push(r.value);
    pos += r.bytesRead;
  }
  return fields;
}

function validateLocationFilter(bytes: Uint8Array): string | undefined {
  const fields: bigint[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (fields.length === MAX_LOCATION_FIELDS) return 'LOCATION_FILTER has more than four fields';
    try {
      const r = readVi64(bytes, pos);
      fields.push(r.value);
      pos += r.bytesRead;
    } catch {
      return 'LOCATION_FILTER has a truncated field';
    }
  }
  if (fields.length >= 3 && fields[0]! + fields[2]! > MAX_VI64) {
    return `LOCATION_FILTER overflows uint64: StartGroup ${fields[0]} + EndGroupDelta ${fields[2]}`;
  }
  return undefined;
}

/** The LOCATION_FILTER fields for a {@link SubscriptionFilter} (draft 21). */
function locationFilterFields(filter: SubscriptionFilter): bigint[] {
  switch (filter.type) {
    case 'NextGroupStart':
      return [0n];
    case 'LargestObject':
    case 'LatestObject':
      return [0n, 0n]; // the Next Object
    case 'RelativeStart':
      if (filter.groups < 1n) throw new RangeError(`RelativeStart groups ${filter.groups} < 1 (0 is NextGroupStart)`);
      return [filter.groups];
    case 'AbsoluteStart':
      // {0, 0} as two fields would mean the Next Object; an open filter from the
      // start of the track is the zero-length "no filter" instead.
      return filter.startGroup === 0n && filter.startObject === 0n ? [] : [filter.startGroup, filter.startObject];
    case 'AbsoluteRange': {
      if (filter.endGroup < filter.startGroup) {
        throw new RangeError(`AbsoluteRange endGroup ${filter.endGroup} < startGroup ${filter.startGroup}`);
      }
      if (filter.endGroup > MAX_VI64) {
        throw new RangeError(`AbsoluteRange endGroup ${filter.endGroup} exceeds 2^64-1`);
      }
      const fields = [filter.startGroup, filter.startObject, filter.endGroup - filter.startGroup];
      if (filter.endObject !== undefined) fields.push(filter.endObject);
      return fields;
    }
  }
}

/** The {@link SubscriptionFilter} a draft-21 LOCATION_FILTER expresses. */
function filterFromLocationFields(fields: readonly bigint[]): SubscriptionFilter {
  switch (fields.length) {
    case 0:
      return { type: 'AbsoluteStart', startGroup: 0n, startObject: 0n };
    case 1:
      return fields[0] === 0n ? { type: 'NextGroupStart' } : { type: 'RelativeStart', groups: fields[0]! };
    case 2:
      return fields[0] === 0n && fields[1] === 0n
        ? { type: 'LargestObject' }
        : { type: 'AbsoluteStart', startGroup: fields[0]!, startObject: fields[1]! };
    default: {
      const range = {
        type: 'AbsoluteRange' as const,
        startGroup: fields[0]!,
        startObject: fields[1]!,
        endGroup: fields[0]! + fields[2]!,
      };
      return fields.length === 4 ? { ...range, endObject: fields[3]! } : range;
    }
  }
}

/**
 * The FILL_PARAMETERS value (draft-21 §9.20.16) for a fill over `filter`: a bare
 * parameter sequence (no count, bounded by the Length) holding its
 * LOCATION_FILTER. With no filter the value is empty, a fill of the whole track.
 */
export function encodeFillParameters(filter?: SubscriptionFilter): Uint8Array {
  if (filter === undefined) return new Uint8Array(0);
  const value = encodeLocationFilterFields(locationFilterFields(filter));
  const type = 0x21n; // LOCATION_FILTER; the first Type delta is from 0
  const buf = new Uint8Array(vi64EncodingLength(type) + vi64EncodingLength(BigInt(value.length)) + value.length);
  let offset = writeVi64(type, buf, 0);
  offset += writeVi64(BigInt(value.length), buf, offset);
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
  // draft-21 §9.20.10: the 0x21 parameter is a LOCATION_FILTER.
  if (isDraft21(draftVersion)) return encodeLocationFilterFields(locationFilterFields(filter));
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
  if (isDraft21(draftVersion)) return filterFromLocationFields(decodeLocationFilterFields(bytes));

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
  if (isDraft21(draftVersion)) return validateLocationFilter(bytes);
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

// ─── Subscription windows (draft-21 §3.1 shared Track Aliases) ────────

/** The absolute Locations a subscription's filter selects. `end` is inclusive; without `end.object` the whole end group. */
export interface SubscriptionWindow {
  readonly start: { readonly group: bigint; readonly object: bigint };
  readonly end?: { readonly group: bigint; readonly object?: bigint };
}

/**
 * Resolve a subscription's Location filter against the Largest Object it was
 * established with (SUBSCRIBE_OK's LARGEST_OBJECT; `undefined` for an empty
 * track). A subscriber sharing one Track Alias across several subscriptions to
 * the same track re-applies each window to attribute an object (draft-21 §3.1).
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
