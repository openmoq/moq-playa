/**
 * RequestPolicy — per-draft request-admission configuration.
 *
 * Outbound allocation is the same across all drafts: client-even / server-odd
 * Request IDs incrementing by 2 (draft-18 §10.1 retains this). What changes per
 * draft is (a) whether new requests are gated by a MAX_REQUEST_ID credit window
 * and (b) how inbound Request IDs are validated:
 *
 *   - draft-14/16: gated by MAX_REQUEST_ID; inbound IDs must be exactly the next
 *     value in sequence ("strict-sequence"), matching `RequestIdAllocator`.
 *   - draft-18: QUIC stream limits replace the credit window. Because each
 *     request rides its own bidirectional stream, requests can arrive out of
 *     order, so the receiver only closes on wrong parity or a duplicate Request
 *     ID ("parity-and-duplicate"). The duplicate tracker that implements this is
 *     wired when draft-18 inbound lands; this object just declares the policy.
 *
 * @see draft-ietf-moq-transport-16 §9.1, §9.5
 * @see draft-ietf-moq-transport-18 §10.1
 * @module
 */

import type { DraftVersion } from '../versions.js';

/** How a receiver validates an inbound Request ID. */
export type InboundValidation = 'strict-sequence' | 'parity-and-duplicate';

/** Per-draft request-admission knobs. */
export interface RequestPolicy {
  /** Whether new outbound requests are gated by a MAX_REQUEST_ID credit window. */
  readonly hasCredit: boolean;
  /** Request ID increment between successive local allocations. Always 2. */
  readonly allocationStep: 2n;
  /** Inbound Request ID validation strategy. */
  readonly inboundValidation: InboundValidation;
}

const CREDITED: RequestPolicy = {
  hasCredit: true,
  allocationStep: 2n,
  inboundValidation: 'strict-sequence',
};

const STREAM_LIMITED: RequestPolicy = {
  hasCredit: false,
  allocationStep: 2n,
  inboundValidation: 'parity-and-duplicate',
};

/**
 * Resolve the {@link RequestPolicy} for a draft version.
 * @param version Draft version (default: 16).
 */
export function getRequestPolicy(version: DraftVersion = 16): RequestPolicy {
  return version === 18 ? STREAM_LIMITED : CREDITED;
}
