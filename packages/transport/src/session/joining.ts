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
 * @returns `startLocation` and `endLocation` in the FETCH wire convention
 *   (endLocation.object is one-past the last delivered object).
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
): { startLocation: Location; endLocation: Location } {
  const endLocation: Location = {
    group: largest.group,
    object: largest.object + 1n,
  };

  if (joining.fetchType === 0x3) {
    if (joining.joiningStart > largest.group) {
      throw new RangeError(
        `Absolute Joining Fetch start group ${joining.joiningStart} > largest group ${largest.group} — §9.16.3 INVALID_RANGE`,
      );
    }
    return { startLocation: { group: joining.joiningStart, object: 0n }, endLocation };
  }

  const startGroup = joining.joiningStart > largest.group
    ? 0n // spec-silent underflow: clamp to the beginning of the track
    : largest.group - joining.joiningStart;
  return { startLocation: { group: startGroup, object: 0n }, endLocation };
}
