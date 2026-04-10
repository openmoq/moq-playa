/**
 * Request ID allocator tests.
 * @see draft-ietf-moq-transport-16 §9.1, §9.5, §9.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RequestIdAllocator, RequestIdError } from './request-id.js';
import { varint } from '../primitives/varint.js';

describe('RequestIdAllocator', () => {
  describe('client role', () => {
    let allocator: RequestIdAllocator;

    beforeEach(() => {
      allocator = new RequestIdAllocator('client');
    });

    it('starts with correct parity (even = 0)', () => {
      expect(allocator.parityBit).toBe(0n);
      expect(allocator.peerParityBit).toBe(1n);
    });

    it('cannot allocate before MAX_REQUEST_ID is set', () => {
      expect(allocator.canAllocate()).toBe(false);
      expect(() => allocator.allocate()).toThrow(RequestIdError);
    });

    it('allocates even IDs in sequence', () => {
      allocator.updatePeerMaxRequestId(varint(100n));

      expect(allocator.allocate()).toBe(0n);
      expect(allocator.allocate()).toBe(2n);
      expect(allocator.allocate()).toBe(4n);
      expect(allocator.allocate()).toBe(6n);
    });

    it('blocks when reaching MAX_REQUEST_ID', () => {
      allocator.updatePeerMaxRequestId(varint(4n)); // Allows 0, 2

      expect(allocator.allocate()).toBe(0n);
      expect(allocator.allocate()).toBe(2n);
      expect(allocator.canAllocate()).toBe(false);
      expect(allocator.isBlocked()).toBe(false); // Not blocked until we try

      expect(() => allocator.allocate()).toThrow(RequestIdError);
      expect(allocator.isBlocked()).toBe(true);
      expect(allocator.getBlockedRequestId()).toBe(4n);
    });

    it('unblocks when MAX_REQUEST_ID increases', () => {
      allocator.updatePeerMaxRequestId(varint(2n));
      allocator.allocate(); // 0
      expect(() => allocator.allocate()).toThrow();
      expect(allocator.isBlocked()).toBe(true);

      allocator.updatePeerMaxRequestId(varint(10n));
      expect(allocator.isBlocked()).toBe(false);
      expect(allocator.allocate()).toBe(2n);
    });

    it('throws if MAX_REQUEST_ID does not increase', () => {
      allocator.updatePeerMaxRequestId(varint(100n));

      expect(() => allocator.updatePeerMaxRequestId(varint(100n))).toThrow(RequestIdError);
      expect(() => allocator.updatePeerMaxRequestId(varint(50n))).toThrow(RequestIdError);
    });
  });

  describe('server role', () => {
    let allocator: RequestIdAllocator;

    beforeEach(() => {
      allocator = new RequestIdAllocator('server');
    });

    it('starts with correct parity (odd = 1)', () => {
      expect(allocator.parityBit).toBe(1n);
      expect(allocator.peerParityBit).toBe(0n);
    });

    it('allocates odd IDs in sequence', () => {
      allocator.updatePeerMaxRequestId(varint(100n));

      expect(allocator.allocate()).toBe(1n);
      expect(allocator.allocate()).toBe(3n);
      expect(allocator.allocate()).toBe(5n);
      expect(allocator.allocate()).toBe(7n);
    });
  });

  describe('incoming request validation', () => {
    let clientAllocator: RequestIdAllocator;

    beforeEach(() => {
      clientAllocator = new RequestIdAllocator('client');
      clientAllocator.setOurMaxRequestId(varint(100n));
    });

    it('accepts valid incoming IDs with correct parity', () => {
      // Client receives server requests (odd parity)
      expect(() => clientAllocator.validateIncoming(varint(1n))).not.toThrow();
      expect(() => clientAllocator.validateIncoming(varint(3n))).not.toThrow();
      expect(() => clientAllocator.validateIncoming(varint(5n))).not.toThrow();
    });

    it('rejects incoming IDs with wrong parity', () => {
      // Client should not receive even IDs from server
      expect(() => clientAllocator.validateIncoming(varint(0n))).toThrow(RequestIdError);
      expect(() => clientAllocator.validateIncoming(varint(2n))).toThrow(RequestIdError);
    });

    it('rejects incoming IDs that exceed our MAX_REQUEST_ID', () => {
      expect(() => clientAllocator.validateIncoming(varint(101n))).toThrow(RequestIdError);
    });

    it('requires incoming IDs to be next in sequence (+2)', () => {
      // Client receives from server: first should be 1 (server starts at odd)
      clientAllocator.validateIncoming(varint(1n));

      // Next must be 3 (exactly +2)
      expect(() => clientAllocator.validateIncoming(varint(5n))).toThrow(RequestIdError); // Skipped 3
      expect(() => clientAllocator.validateIncoming(varint(1n))).toThrow(RequestIdError); // Same ID
      expect(() => clientAllocator.validateIncoming(varint(7n))).toThrow(RequestIdError); // Skipped too far

      // Correct sequence: 3
      expect(() => clientAllocator.validateIncoming(varint(3n))).not.toThrow();

      // Then 5
      expect(() => clientAllocator.validateIncoming(varint(5n))).not.toThrow();
    });
  });

  describe('our request ID validation (for responses)', () => {
    let clientAllocator: RequestIdAllocator;

    beforeEach(() => {
      clientAllocator = new RequestIdAllocator('client');
      clientAllocator.updatePeerMaxRequestId(varint(100n));
    });

    it('accepts responses for allocated IDs', () => {
      const id1 = clientAllocator.allocate(); // 0
      const id2 = clientAllocator.allocate(); // 2

      expect(() => clientAllocator.validateOurRequestId(id1)).not.toThrow();
      expect(() => clientAllocator.validateOurRequestId(id2)).not.toThrow();
    });

    it('rejects responses with wrong parity', () => {
      clientAllocator.allocate();

      // Odd ID is not ours (client uses even)
      expect(() => clientAllocator.validateOurRequestId(varint(1n))).toThrow(RequestIdError);
    });

    it('rejects responses for unallocated IDs', () => {
      clientAllocator.allocate(); // 0

      // ID 2 was never allocated (next would be 2)
      expect(() => clientAllocator.validateOurRequestId(varint(2n))).toThrow(RequestIdError);
    });
  });

  describe('our MAX_REQUEST_ID management', () => {
    let allocator: RequestIdAllocator;

    beforeEach(() => {
      allocator = new RequestIdAllocator('server');
    });

    it('tracks our MAX_REQUEST_ID', () => {
      expect(allocator.getOurMaxRequestId()).toBe(0n);

      allocator.setOurMaxRequestId(varint(50n));
      expect(allocator.getOurMaxRequestId()).toBe(50n);
    });

    it('requires our MAX_REQUEST_ID to strictly increase', () => {
      allocator.setOurMaxRequestId(varint(50n));

      expect(() => allocator.setOurMaxRequestId(varint(50n))).toThrow();
      expect(() => allocator.setOurMaxRequestId(varint(25n))).toThrow();

      expect(() => allocator.setOurMaxRequestId(varint(100n))).not.toThrow();
    });
  });

  describe('auto-replenishment (§9.5 sliding window)', () => {
    let allocator: RequestIdAllocator;

    beforeEach(() => {
      allocator = new RequestIdAllocator('client');
      // Grant peer 1000 IDs (default window)
      allocator.setOurMaxRequestId(varint(1000n));
    });

    it('does not signal replenish before threshold', () => {
      // Consume first incoming request ID (server sends odd: 1)
      allocator.validateIncoming(varint(1n));
      expect(allocator.shouldReplenish()).toBe(false);
    });

    it('signals replenish when peer consumes past 50% of window', () => {
      // Window is 1000. Peer IDs are odd: 1, 3, 5, ...
      // 50% of 1000 = 500 IDs consumed. Peer increments by 2, so
      // after 250 incoming requests the peer has used IDs 1..499 (250 IDs).
      // After 500 incoming requests the peer has used IDs 1..999 (500 IDs).
      // But the threshold is based on ID space consumed, not count.
      // At halfway: highestIncomingId >= ourMaxRequestId / 2
      // Let's consume enough to cross the threshold.
      // IDs: 1, 3, 5, ... need to get past 500
      for (let id = 1n; id < 500n; id += 2n) {
        allocator.validateIncoming(varint(id));
      }
      expect(allocator.shouldReplenish()).toBe(false);

      // Cross the threshold
      allocator.validateIncoming(varint(501n));
      expect(allocator.shouldReplenish()).toBe(true);
    });

    it('returns the next MAX_REQUEST_ID value to send', () => {
      // Initial grant: 1000. Window size: 1000.
      // After replenish: should extend by the window size → 2000.
      for (let id = 1n; id <= 501n; id += 2n) {
        allocator.validateIncoming(varint(id));
      }
      expect(allocator.shouldReplenish()).toBe(true);
      expect(allocator.nextReplenishValue()).toBe(2000n);
    });

    it('replenish clears the signal and updates ourMaxRequestId', () => {
      for (let id = 1n; id <= 501n; id += 2n) {
        allocator.validateIncoming(varint(id));
      }
      expect(allocator.shouldReplenish()).toBe(true);

      allocator.commitReplenish();
      expect(allocator.shouldReplenish()).toBe(false);
      expect(allocator.getOurMaxRequestId()).toBe(2000n);
    });

    it('signals replenish again after second window is half consumed', () => {
      // Exhaust first window past threshold
      for (let id = 1n; id <= 501n; id += 2n) {
        allocator.validateIncoming(varint(id));
      }
      allocator.commitReplenish(); // now max = 2000

      // Consume past 50% of second window (threshold at 1500)
      for (let id = 503n; id <= 1501n; id += 2n) {
        allocator.validateIncoming(varint(id));
      }
      expect(allocator.shouldReplenish()).toBe(true);
      expect(allocator.nextReplenishValue()).toBe(3000n);
    });

    it('uses custom window size when provided', () => {
      const small = new RequestIdAllocator('client', { windowSize: 100 });
      small.setOurMaxRequestId(varint(100n));

      // Consume past 50% (threshold at 50)
      for (let id = 1n; id <= 51n; id += 2n) {
        small.validateIncoming(varint(id));
      }
      expect(small.shouldReplenish()).toBe(true);
      expect(small.nextReplenishValue()).toBe(200n);
    });

    it('defaults window size to 1000', () => {
      const def = new RequestIdAllocator('client');
      def.setOurMaxRequestId(varint(1000n));

      for (let id = 1n; id <= 501n; id += 2n) {
        def.validateIncoming(varint(id));
      }
      expect(def.shouldReplenish()).toBe(true);
      expect(def.nextReplenishValue()).toBe(2000n);
    });
  });

  describe('peek functionality', () => {
    it('peekNextId returns next ID without consuming it', () => {
      const allocator = new RequestIdAllocator('client');
      allocator.updatePeerMaxRequestId(varint(100n));

      expect(allocator.peekNextId()).toBe(0n);
      expect(allocator.peekNextId()).toBe(0n); // Still 0

      allocator.allocate();
      expect(allocator.peekNextId()).toBe(2n);
    });
  });

  describe('error codes', () => {
    it('throws INVALID_REQUEST_ID for parity errors', () => {
      const allocator = new RequestIdAllocator('client');
      allocator.setOurMaxRequestId(varint(100n));

      try {
        allocator.validateIncoming(varint(0n)); // Wrong parity
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RequestIdError);
        expect((e as RequestIdError).code).toBe('INVALID_REQUEST_ID');
      }
    });

    it('throws TOO_MANY_REQUESTS when exceeding MAX_REQUEST_ID', () => {
      const allocator = new RequestIdAllocator('client');
      allocator.updatePeerMaxRequestId(varint(2n));
      allocator.allocate(); // 0

      try {
        allocator.allocate(); // Would be 2, but max is 2 (exclusive)
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RequestIdError);
        expect((e as RequestIdError).code).toBe('TOO_MANY_REQUESTS');
      }
    });
  });
});
