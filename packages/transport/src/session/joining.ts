/**
 * Joining FETCH range resolution (§9.16.2.1 / draft-18 §10.12.2.1).
 *
 * A Joining Fetch carries no explicit range — the publisher computes the
 * standalone-equivalent range from the associated subscription's Largest
 * Location (draft-18: "Joining Location") so that the FETCH and SUBSCRIBE
 * deliver contiguous, non-overlapping objects:
 *
 *   - End Location = {Largest.Group, Largest.Object + 1}. The Object
 *     component uses the FETCH wire convention ("The end Location, plus 1",
 *     §9.16.3): the last object DELIVERED by the fetch is the Largest Object
 *     itself, and a Largest Object subscription starts delivery at
 *     {Largest.Group, Largest.Object + 1} (§5.1.2) — zero overlap by
 *     construction.
 *     At the draft's maximum Object ID, Object 0 denotes the entire end
 *     Group instead (§9.16.1 / draft-18 §10.13); no larger Object exists.
 *   - Relative (0x2): Start = {Largest.Group − Joining Start, 0}.
 *   - Absolute (0x3): Start = {Joining Start, 0}.
 *
 * This module is pure (sans-I/O, sans-session-state) so the arithmetic is
 * testable in isolation and reusable by both the session convenience API and
 * publisher applications.
 *
 * @see draft-ietf-moq-transport-16 §9.16.2.1 (Joining Fetch Range Calculation)
 * @see draft-ietf-moq-transport-18 §10.12.2.1
 * @module
 */

import type { Location } from '../primitives/location.js';
import { MAX_VARINT } from '../primitives/varint.js';
import type { DraftVersion } from '../versions.js';

// Semantic Location ceiling; session arithmetic does not import wire codecs.
const MAX_LOCATION_COMPONENT = (1n << 64n) - 1n;

/** The joining-specific fields of a FETCH message (§9.16.2). */
export interface JoiningFetchFields {
  /** 0x2 = Relative Joining Fetch, 0x3 = Absolute Joining Fetch. */
  readonly fetchType: 0x2 | 0x3;
  /** Relative group count (0x2) or absolute start group (0x3). */
  readonly joiningStart: bigint;
}

/**
 * Compute the standalone-equivalent range for a Joining Fetch.
 *
 * @param joining The fetch type and Joining Start from the FETCH message.
 * @param largest The associated subscription's Largest Location, saved when
 *   the subscription started (§9.16.2.1; draft-18 "Joining Location").
 * @param options The connected draft, when known. Omitted means draft-18's
 *   vi64 domain for compatibility with two-argument callers, not negotiation.
 *   Draft 22 uses FILL and cannot resolve a Joining FETCH here.
 * @returns `startLocation` and `endLocation` in the FETCH wire convention
 *   (endLocation.object is one-past the last delivered object, or 0 for
 *   the entire end Group at the draft's maximum Object ID).
 * @throws {TypeError} for non-bigint locations or a malformed context.
 * @throws {RangeError} for unsupported drafts, FETCH types or integer domains.
 * @throws {RangeError} for an Absolute Joining Fetch whose start group is
 *   beyond the largest group — §9.16.3: "If Start Location is greater than
 *   the Largest Object the publisher MUST return REQUEST_ERROR with error
 *   code INVALID_RANGE." The caller maps this to that REQUEST_ERROR.
 *
 * Relative underflow (Joining Start exceeding the largest group) is not
 * addressed by either draft; the start clamps to group 0, delivering from
 * the beginning of the track — the conservative reading of "fill a playback
 * buffer with a certain number of groups prior to the live edge" (§9.16.2).
 */
export function resolveJoiningFetchRange(
  joining: JoiningFetchFields,
  largest: Location,
  options?: { readonly draftVersion: DraftVersion },
): { startLocation: Location; endLocation: Location } {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError('Joining FETCH context must be an object');
  }
  const draft = options === undefined ? 18 : options.draftVersion;
  if (draft !== 14 && draft !== 16 && draft !== 18) {
    throw new RangeError('Joining FETCH requires draft 14, 16 or 18');
  }
  const maximum = draft < 18 ? MAX_VARINT : MAX_LOCATION_COMPONENT;
  const fetchType = joining.fetchType;
  const joiningStart = joining.joiningStart;
  const group = largest.group;
  const object = largest.object;
  if (fetchType !== 0x2 && fetchType !== 0x3) {
    throw new RangeError('Joining FETCH requires relative or absolute fetch type');
  }
  for (const value of [joiningStart, group, object]) {
    if (typeof value !== 'bigint') throw new TypeError('Joining FETCH locations must be bigint');
    if (value < 0n || value > maximum) throw new RangeError('Joining FETCH location exceeds the draft integer range');
  }
  const endLocation: Location = {
    group,
    object: object === maximum ? 0n : object + 1n,
  };

  if (fetchType === 0x3) {
    if (joiningStart > group) {
      throw new RangeError(
        `Absolute Joining Fetch start group ${joiningStart} > largest group ${group} — §9.16.3 INVALID_RANGE`,
      );
    }
    return { startLocation: { group: joiningStart, object: 0n }, endLocation };
  }

  const startGroup = joiningStart > group
    ? 0n // spec-silent underflow: clamp to the beginning of the track
    : group - joiningStart;
  return { startLocation: { group: startGroup, object: 0n }, endLocation };
}
