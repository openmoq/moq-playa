/**
 * RequestIdAllocator credit policy (draft-14/16 vs draft-18).
 *
 * draft-14/16 gate outbound allocation on the peer's MAX_REQUEST_ID credit;
 * draft-18 has no request credit (QUIC stream limits replace it), so allocation
 * is never gated and the allocator never becomes blocked. allocate() returns a
 * semantic bigint (no hidden QUIC-varint cap); 14/16 wire range is enforced by
 * the encoders.
 */
import { describe, it, expect } from 'vitest';
import { RequestIdAllocator, RequestIdError } from './request-id.js';
import { EndpointRole } from './types.js';
import { getRequestPolicy } from './request-policy.js';
import { varint } from '../primitives/varint.js';

const credited = () => new RequestIdAllocator(EndpointRole.CLIENT, undefined, getRequestPolicy(16));
const streamLimited = (role = EndpointRole.CLIENT) =>
  new RequestIdAllocator(role, undefined, getRequestPolicy(18));

describe('draft-14/16 (credited)', () => {
  it('throws when allocating without peer credit (peerMaxRequestId = 0)', () => {
    expect(() => credited().allocate()).toThrow(RequestIdError);
  });

  it('allocates within the peer credit window', () => {
    const a = credited();
    a.updatePeerMaxRequestId(varint(10n));
    expect(a.allocate()).toBe(0n);
    expect(a.allocate()).toBe(2n);
  });

  it('defaults to credited when no policy is given (backward compatible)', () => {
    const a = new RequestIdAllocator(EndpointRole.CLIENT);
    expect(() => a.allocate()).toThrow(RequestIdError);
  });
});

describe('draft-18 (no credit)', () => {
  it('allocates 0, 2, 4 with no MAX_REQUEST_ID set', () => {
    const a = streamLimited();
    expect(a.allocate()).toBe(0n);
    expect(a.allocate()).toBe(2n);
    expect(a.allocate()).toBe(4n);
  });

  it('never becomes blocked and always canAllocate', () => {
    const a = streamLimited();
    a.allocate();
    a.allocate();
    expect(a.isBlocked()).toBe(false);
    expect(a.canAllocate()).toBe(true);
  });

  it('server allocates odd IDs 1, 3, 5', () => {
    const a = streamLimited(EndpointRole.SERVER);
    expect(a.allocate()).toBe(1n);
    expect(a.allocate()).toBe(3n);
    expect(a.allocate()).toBe(5n);
  });

  it('returns a plain bigint', () => {
    expect(typeof streamLimited().allocate()).toBe('bigint');
  });
});

describe('draft-18 inbound validation (parity-and-duplicate)', () => {
  it('accepts in-order and OUT-OF-ORDER peer Request IDs (no strict sequence)', () => {
    const a = streamLimited(); // client → peer (server) IDs are odd
    expect(() => a.validateIncoming(1n)).not.toThrow();
    // Skipping 3 and accepting 5 out of order is fine in draft-18.
    expect(() => a.validateIncoming(5n)).not.toThrow();
    expect(() => a.validateIncoming(3n)).not.toThrow();
  });

  it('rejects a wrong-parity incoming Request ID', () => {
    const a = streamLimited();
    expect(() => a.validateIncoming(2n)).toThrow(RequestIdError); // even = our parity, not peer's
  });

  it('rejects a DUPLICATE incoming Request ID', () => {
    const a = streamLimited();
    a.validateIncoming(1n);
    expect(() => a.validateIncoming(1n)).toThrow(/duplicate/i);
  });

  it('does not gate on a MAX_REQUEST_ID window (QUIC stream limits replace it)', () => {
    const a = streamLimited();
    // A large odd Request ID is accepted with no credit window.
    expect(() => a.validateIncoming((1n << 40n) + 1n)).not.toThrow();
  });
});
