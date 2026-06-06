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
  /** §5.1.2: Explicit start and (absolute) end group. */
  | { readonly type: 'AbsoluteRange'; readonly startGroup: bigint; readonly startObject: bigint; readonly endGroup: bigint };

const FILTER_TYPE: Record<SubscriptionFilter['type'], bigint> = {
  NextGroupStart: 0x1n,
  LargestObject: 0x2n,
  LatestObject: 0x2n, // deprecated alias
  AbsoluteStart: 0x3n,
  AbsoluteRange: 0x4n,
};

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
  const filterType = FILTER_TYPE[filter.type];

  // draft-18 §5.1.2: vi64 internals; AbsoluteRange carries an End Group DELTA.
  if (draftVersion === 18) {
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
 * Validate the inner bytes of a SUBSCRIPTION_FILTER parameter (§5.1.2).
 * @returns a violation reason string if malformed, or `undefined` if valid.
 *   The caller maps a returned reason to a PROTOCOL_VIOLATION close.
 */
export function validateSubscriptionFilter(bytes: Uint8Array, draftVersion: number): string | undefined {
  return draftVersion === 18
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
