import { describe, expect, it } from 'vitest';
import { RequestIdAllocator } from './request-id.js';
import { getRequestPolicy } from './request-policy.js';
import { varint } from '../primitives/varint.js';

function credited(role: 'client' | 'server' = 'client', maximum = 100n) {
  const allocator = new RequestIdAllocator(role, undefined, getRequestPolicy(16));
  allocator.setOurMaxRequestId(varint(maximum));
  return allocator;
}

function rejects(action: () => void, code: string) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe('draft-16 cross-stream request admission', () => {
  it('allows arrival reordering by default while retaining credit', () => {
    expect(getRequestPolicy(16)).toEqual({
      hasCredit: true, allocationStep: 2n, inboundValidation: 'parity-and-duplicate',
    });
  });

  it.each(['client', 'server'] as const)('%s admits each peer ID once in either order', role => {
    const allocator = credited(role);
    const first = role === 'client' ? 1n : 0n;
    for (const id of [first + 2n, first, first + 6n, first + 4n]) {
      expect(() => allocator.validateIncoming(id)).not.toThrow();
    }
    for (const id of [first, first + 2n, first + 4n, first + 6n]) {
      rejects(() => allocator.validateIncoming(id), 'INVALID_REQUEST_ID');
    }
    rejects(() => allocator.validateIncoming(first ^ 1n), 'INVALID_REQUEST_ID');
  });

  it('enforces credit independently of the arrival-order policy', () => {
    const allocator = new RequestIdAllocator('client', undefined, {
      hasCredit: true, allocationStep: 2n, inboundValidation: 'parity-and-duplicate',
    });
    allocator.updatePeerMaxRequestId(varint(1000n));
    rejects(() => allocator.validateIncoming(1n), 'TOO_MANY_REQUESTS');
    allocator.setOurMaxRequestId(varint(3n));
    rejects(() => allocator.validateIncoming(3n), 'TOO_MANY_REQUESTS');
    allocator.setOurMaxRequestId(varint(8n));
    expect(() => allocator.validateIncoming(3n)).not.toThrow();
    expect(() => allocator.validateIncoming(1n)).not.toThrow();
  });

  it('keeps outgoing credit independent from incoming credit', () => {
    const allocator = credited();
    expect(() => allocator.validateIncoming(3n)).not.toThrow();
    expect(allocator.canAllocate()).toBe(false);
    allocator.updatePeerMaxRequestId(varint(2n));
    expect(allocator.allocate()).toBe(0n);
    expect(allocator.canAllocate()).toBe(false);
  });

  it('replenishes only after admitting an in-credit request', () => {
    const allocator = credited();
    rejects(() => allocator.validateIncoming(101n), 'TOO_MANY_REQUESTS');
    expect(allocator.shouldReplenish()).toBe(false);
    allocator.validateIncoming(99n);
    expect(allocator.shouldReplenish()).toBe(true);
    expect(allocator.nextReplenishValue()).toBe(1100n);
    allocator.commitReplenish();
    expect(() => allocator.validateIncoming(101n)).not.toThrow();
    expect(() => allocator.validateIncoming(1n)).not.toThrow();
  });

  it('preserves exact IDs near the draft-16 integer limit', () => {
    const maximum = (1n << 62n) - 1n;
    const allocator = credited('client', maximum);
    for (const id of [maximum - 2n, 1n, maximum - 4n]) {
      expect(() => allocator.validateIncoming(id)).not.toThrow();
    }
    rejects(() => allocator.validateIncoming(maximum - 2n), 'INVALID_REQUEST_ID');
    rejects(() => allocator.validateIncoming(maximum), 'TOO_MANY_REQUESTS');
  });

  it('compacts completed sequences without forgetting old duplicates', () => {
    const allocator = credited('client', 20_001n);
    for (let id = 1n; id < 10_001n; id += 2n) allocator.validateIncoming(id);
    rejects(() => allocator.validateIncoming(1n), 'INVALID_REQUEST_ID');
    rejects(() => allocator.validateIncoming(9999n), 'INVALID_REQUEST_ID');
  });

  it('bounds sparse tracking and does not consume an ID refused at capacity', () => {
    const allocator = credited('client', 20_001n);
    allocator.validateIncoming(1n);
    for (let i = 1n; i <= 1024n; i++) allocator.validateIncoming(4n * i + 1n);
    expect(() => allocator.validateIncoming(4101n)).toThrow(/tracking capacity/);
    allocator.validateIncoming(3n); // Completes the prefix through 5, freeing a range.
    expect(() => allocator.validateIncoming(4101n)).not.toThrow();
    rejects(() => allocator.validateIncoming(5n), 'INVALID_REQUEST_ID');
  });

  it('can advance a missing prefix at capacity without allocating another range', () => {
    const allocator = credited('client', 20_001n);
    allocator.validateIncoming(1n);
    for (let i = 0n; i < 1024n; i++) allocator.validateIncoming(9n + 4n * i);
    for (const id of [3n, 5n, 7n]) expect(() => allocator.validateIncoming(id)).not.toThrow();
    rejects(() => allocator.validateIncoming(9n), 'INVALID_REQUEST_ID');
  });

  it('keeps draft 14 sequential', () => {
    const allocator = new RequestIdAllocator('client', undefined, getRequestPolicy(14));
    allocator.setOurMaxRequestId(varint(100n));
    rejects(() => allocator.validateIncoming(3n), 'INVALID_REQUEST_ID');
    expect(() => allocator.validateIncoming(1n)).not.toThrow();
  });

  it.each([18, 22] as const)('draft %i still has no MAX_REQUEST_ID gate', draft => {
    const allocator = new RequestIdAllocator('client', undefined, getRequestPolicy(draft));
    expect(() => allocator.validateIncoming(3n)).not.toThrow();
    expect(() => allocator.validateIncoming(1n)).not.toThrow();
    rejects(() => allocator.validateIncoming(3n), 'INVALID_REQUEST_ID');
  });
});
