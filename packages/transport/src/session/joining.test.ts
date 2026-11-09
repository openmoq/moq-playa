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
import { MAX_VARINT } from '../primitives/varint.js';
import { MAX_VI64 } from '../primitives/vi64.js';
import type { DraftVersion } from '../versions.js';
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


describe('Joining FETCH integer domains', () => {
  it.each([[14, MAX_VARINT], [16, MAX_VARINT], [18, MAX_VI64]] as const)('uses the draft%i endpoint width', (draftVersion, maximum) => {
    const joining = { fetchType: 0x3 as const, joiningStart: 3n };
    expect(resolveJoiningFetchRange(joining, { group: 3n, object: maximum - 1n }, { draftVersion }).endLocation)
      .toEqual({ group: 3n, object: maximum });
    expect(resolveJoiningFetchRange(joining, { group: 3n, object: maximum }, { draftVersion }).endLocation)
      .toEqual({ group: 3n, object: 0n });
  });

  it('keeps ordinary two-argument vi64 arithmetic at the legacy maximum', () => {
    const joining = { fetchType: 0x2 as const, joiningStart: 0n };
    expect(resolveJoiningFetchRange(joining, { group: 3n, object: MAX_VARINT }).endLocation)
      .toEqual({ group: 3n, object: MAX_VARINT + 1n });
    expect(resolveJoiningFetchRange(joining, { group: 3n, object: MAX_VARINT }, { draftVersion: 18 }).endLocation)
      .toEqual({ group: 3n, object: MAX_VARINT + 1n });
  });

  it('uses the whole-Group endpoint at the default vi64 maximum', () => {
    const joining = { fetchType: 0x2 as const, joiningStart: 0n };
    expect(resolveJoiningFetchRange(joining, { group: MAX_VI64, object: MAX_VI64 - 1n }).endLocation)
      .toEqual({ group: MAX_VI64, object: MAX_VI64 });
    expect(resolveJoiningFetchRange(joining, { group: MAX_VI64, object: MAX_VI64 }).endLocation)
      .toEqual({ group: MAX_VI64, object: 0n });
  });

  it.each([14, 16, 18] as const)('validates draft%i Group/Object/start values before calculating', draftVersion => {
    const maximum = draftVersion < 18 ? MAX_VARINT : MAX_VI64;
    const joining = { fetchType: 0x2 as const, joiningStart: 0n };
    for (const largest of [{ group: -1n, object: 0n }, { group: 0n, object: -1n },
      { group: maximum + 1n, object: 0n }, { group: 0n, object: maximum + 1n }]) {
      expect(() => resolveJoiningFetchRange(joining, largest, { draftVersion })).toThrow(RangeError);
    }
    for (const joiningStart of [-1n, maximum + 1n]) {
      expect(() => resolveJoiningFetchRange({ fetchType: 0x2, joiningStart }, { group: 3n, object: 2n }, { draftVersion }))
        .toThrow(RangeError);
    }
  });

  it.each([{}, null, 16, { draftVersion: 17 }, { draftVersion: 22 }])('does not guess from an invalid explicit context %j', context => {
    expect(() => Reflect.apply(resolveJoiningFetchRange, undefined,
      [{ fetchType: 0x2, joiningStart: 0n }, { group: 3n, object: 2n }, context])).toThrow();
  });

  it('treats an omitted or undefined context as the same default', () => {
    const joining = { fetchType: 0x2 as const, joiningStart: 0n }, largest = { group: 3n, object: 2n };
    expect(resolveJoiningFetchRange(joining, largest, undefined)).toEqual(resolveJoiningFetchRange(joining, largest));
  });

  it('rejects non-bigint fields and unknown JOIN types at the JavaScript boundary', () => {
    for (const args of [
      [{ fetchType: 0x2, joiningStart: 0 }, { group: 3n, object: 2n }],
      [{ fetchType: 0x2, joiningStart: 0n }, { group: 3, object: 2n }],
      [{ fetchType: 0x2, joiningStart: 0n }, { group: 3n, object: '2' }],
      [{ fetchType: 0x4, joiningStart: 0n }, { group: 3n, object: 2n }],
    ]) expect(() => Reflect.apply(resolveJoiningFetchRange, undefined, args)).toThrow();
  });

  it('snapshots each caller field once instead of rereading getters during arithmetic', () => {
    const reads = { draft: 0, type: 0, start: 0, group: 0, object: 0 };
    const context = { get draftVersion(): DraftVersion { return ++reads.draft === 1 ? 16 : 18; } };
    const joining = { get fetchType(): 0x2 | 0x3 { return ++reads.type === 1 ? 0x2 : 0x3; },
      get joiningStart() { return ++reads.start === 1 ? 1n : 100n; } };
    const largest = { get group() { return ++reads.group === 1 ? 10n : 0n; },
      get object() { return ++reads.object === 1 ? MAX_VARINT : 2n; } };
    expect(resolveJoiningFetchRange(joining, largest, context))
      .toEqual({ startLocation: { group: 9n, object: 0n }, endLocation: { group: 10n, object: 0n } });
    expect(reads).toEqual({ draft: 1, type: 1, start: 1, group: 1, object: 1 });
  });
});
