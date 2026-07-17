/**
 * Joining FETCH range resolution (§9.16.2.1 / §10.12.2.1).
 *
 * The publisher receiving a Joining Fetch computes the standalone-equivalent
 * range from the associated subscription's Largest Location. These tests pin
 * the wire-encoding convention resolved from the drafts:
 *
 *   - End Location.Object is one-past-exclusive ("The end Location, plus 1",
 *     §9.16.3 / §10.12.3) — the last object DELIVERED is the Largest Object.
 *   - Relative (0x2): Start = {Largest.Group − Joining Start, 0}.
 *   - Absolute (0x3): Start = {Joining Start, 0}.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { resolveJoiningFetchRange } from './joining.js';

describe('resolveJoiningFetchRange', () => {
  const largest = { group: 10n, object: 7n };

  it('relative: start N groups before the largest group, object 0 (§9.16.2.1)', () => {
    const r = resolveJoiningFetchRange({ fetchType: 0x2, joiningStart: 3n }, largest);
    expect(r.startLocation).toEqual({ group: 7n, object: 0n });
  });

  it('relative joiningStart 0: start at the head of the current group', () => {
    const r = resolveJoiningFetchRange({ fetchType: 0x2, joiningStart: 0n }, largest);
    expect(r.startLocation).toEqual({ group: 10n, object: 0n });
  });

  it('end is the wire one-past encoding {Largest.Group, Largest.Object + 1}', () => {
    // §9.16.2.1 note: "the last Object included in the Joining FETCH response
    // is Subscribe Largest Location. The + 1 above indicates the equivalent
    // Standalone Fetch encoding."
    const r = resolveJoiningFetchRange({ fetchType: 0x2, joiningStart: 0n }, largest);
    expect(r.endLocation).toEqual({ group: 10n, object: 8n });
  });

  it('relative underflow clamps the start group to 0 (spec is silent; documented conservative choice)', () => {
    const r = resolveJoiningFetchRange({ fetchType: 0x2, joiningStart: 99n }, largest);
    expect(r.startLocation).toEqual({ group: 0n, object: 0n });
    expect(r.endLocation).toEqual({ group: 10n, object: 8n });
  });

  it('absolute: start at {Joining Start, 0} (§9.16.2.1)', () => {
    const r = resolveJoiningFetchRange({ fetchType: 0x3, joiningStart: 4n }, largest);
    expect(r.startLocation).toEqual({ group: 4n, object: 0n });
    expect(r.endLocation).toEqual({ group: 10n, object: 8n });
  });

  it('absolute start beyond the largest group throws (caller maps to INVALID_RANGE, §9.16.3)', () => {
    // "If Start Location is greater than the Largest Object the publisher
    // MUST return REQUEST_ERROR with error code INVALID_RANGE."
    expect(() => resolveJoiningFetchRange({ fetchType: 0x3, joiningStart: 11n }, largest))
      .toThrow(RangeError);
  });

  it('absolute start equal to the largest group is valid (fetches the current group head)', () => {
    const r = resolveJoiningFetchRange({ fetchType: 0x3, joiningStart: 10n }, largest);
    expect(r.startLocation).toEqual({ group: 10n, object: 0n });
  });
});
