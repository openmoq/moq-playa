/**
 * RequestPolicy — verifies per-draft request-admission configuration.
 *
 * All drafts allocate request IDs with client-even/server-odd parity and a +2
 * step (draft-18 §10.1 keeps this). The axes that vary per draft are:
 *   - credit: draft-14/16 gate on MAX_REQUEST_ID; draft-18 uses QUIC stream limits.
 *   - inbound validation: draft-14/16 require strict next-in-sequence; draft-18
 *     allows out-of-order arrival (per-request streams) and only rejects on wrong
 *     parity or duplicate ID.
 */
import { describe, it, expect } from 'vitest';
import { getRequestPolicy } from './request-policy.js';

describe('getRequestPolicy', () => {
  it('draft-14/16 → credit + strict-sequence', () => {
    for (const v of [14, 16] as const) {
      expect(getRequestPolicy(v)).toEqual({
        hasCredit: true,
        allocationStep: 2n,
        inboundValidation: 'strict-sequence',
      });
    }
  });

  it('draft-18 → no credit + parity-and-duplicate', () => {
    expect(getRequestPolicy(18)).toEqual({
      hasCredit: false,
      allocationStep: 2n,
      inboundValidation: 'parity-and-duplicate',
    });
  });

  it('allocation step is always 2 (parity preserved across all drafts)', () => {
    for (const v of [14, 16, 18] as const) {
      expect(getRequestPolicy(v).allocationStep).toBe(2n);
    }
  });

  it('defaults to draft-16 policy', () => {
    expect(getRequestPolicy()).toEqual(getRequestPolicy(16));
  });
});
