/**
 * SUBSCRIPTION_FILTER decode (§5.1.2) — the third leg beside encode/validate.
 *
 * The publisher-side session stores the subscriber's filter so the joining
 * FETCH gate (§9.16.2: "only permitted when the associated Subscribe has the
 * Filter Type Largest Object") can be enforced. Decode returns the semantic
 * {@link SubscriptionFilter} with an ABSOLUTE `endGroup` on every draft (the
 * draft-18 wire delta is a codec detail, mirrored from the encoder).
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  encodeSubscriptionFilter,
  decodeSubscriptionFilter,
  type SubscriptionFilter,
} from './subscription-filter.js';

const ROUND_TRIPS: SubscriptionFilter[] = [
  { type: 'NextGroupStart' },
  { type: 'LargestObject' },
  { type: 'AbsoluteStart', startGroup: 5n, startObject: 2n },
  { type: 'AbsoluteRange', startGroup: 5n, startObject: 2n, endGroup: 9n },
];

describe('decodeSubscriptionFilter', () => {
  for (const draft of [16, 18]) {
    describe(`draft-${draft}`, () => {
      for (const filter of ROUND_TRIPS) {
        it(`round-trips ${filter.type}`, () => {
          const bytes = encodeSubscriptionFilter(filter, draft);
          expect(decodeSubscriptionFilter(bytes, draft)).toEqual(filter);
        });
      }

      it('throws on an unknown filter type', () => {
        expect(() => decodeSubscriptionFilter(new Uint8Array([0x09]), draft)).toThrow();
      });

      it('throws on empty bytes', () => {
        expect(() => decodeSubscriptionFilter(new Uint8Array(0), draft)).toThrow();
      });

      it('throws on trailing bytes', () => {
        const bytes = encodeSubscriptionFilter({ type: 'LargestObject' }, draft);
        const padded = new Uint8Array([...bytes, 0x00]);
        expect(() => decodeSubscriptionFilter(padded, draft)).toThrow();
      });
    });
  }

  it('draft-18 AbsoluteRange decodes the wire End Group DELTA back to an ABSOLUTE endGroup', () => {
    // encode writes delta = 9-5 = 4 on the wire (§5.1.2); decode must undo it.
    const bytes = encodeSubscriptionFilter(
      { type: 'AbsoluteRange', startGroup: 5n, startObject: 2n, endGroup: 9n }, 18);
    const decoded = decodeSubscriptionFilter(bytes, 18);
    expect(decoded).toEqual({ type: 'AbsoluteRange', startGroup: 5n, startObject: 2n, endGroup: 9n });
  });

  it('deprecated LatestObject alias encodes as 0x2 and decodes as LargestObject', () => {
    const bytes = encodeSubscriptionFilter({ type: 'LatestObject' }, 16);
    expect(decodeSubscriptionFilter(bytes, 16)).toEqual({ type: 'LargestObject' });
  });
});
