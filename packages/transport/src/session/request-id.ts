/**
 * Request ID allocation and tracking.
 *
 * Request IDs identify SUBSCRIBE, PUBLISH, FETCH, and other requests.
 * - Client-initiated requests have LSB = 0 (even numbers)
 * - Server-initiated requests have LSB = 1 (odd numbers)
 * - IDs increment by 2 (0, 2, 4... for client; 1, 3, 5... for server)
 * - Must be < MAX_REQUEST_ID from peer
 *
 * @see draft-ietf-moq-transport-16 §9.1, §9.5, §9.6
 * @module
 */

import { varint, type Varint } from '../primitives/varint.js';
import { EndpointRole, type EndpointRoleValue } from './types.js';
import type { RequestPolicy } from './request-policy.js';

/**
 * Error thrown when request ID allocation fails.
 */
export class RequestIdError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_REQUEST_ID' | 'TOO_MANY_REQUESTS' | 'PROTOCOL_VIOLATION',
  ) {
    super(message);
    this.name = 'RequestIdError';
  }
}

/**
 * Manages request ID allocation and peer MAX_REQUEST_ID tracking.
 *
 * @example
 * ```typescript
 * const allocator = new RequestIdAllocator('client');
 *
 * // Set peer's MAX_REQUEST_ID from SERVER_SETUP or MAX_REQUEST_ID message
 * allocator.updatePeerMaxRequestId(100n);
 *
 * // Allocate IDs for outgoing requests
 * const id1 = allocator.allocate(); // 0n
 * const id2 = allocator.allocate(); // 2n
 *
 * // Check if blocked
 * if (allocator.isBlocked()) {
 *   // Send REQUESTS_BLOCKED message
 * }
 * ```
 */
/** Default window size for MAX_REQUEST_ID auto-replenishment. */
const DEFAULT_WINDOW_SIZE = 1000;

/** Configuration for RequestIdAllocator. */
export interface RequestIdAllocatorConfig {
  /**
   * Window size for MAX_REQUEST_ID auto-replenishment.
   * When the peer consumes past 50% of the current window,
   * shouldReplenish() returns true and nextReplenishValue()
   * returns ourMaxRequestId + windowSize.
   *
   * @see draft-ietf-moq-transport-16 §9.5 (similar to MAX_STREAMS in RFC 9000 §4.6)
   */
  readonly windowSize?: number;
}

export class RequestIdAllocator {
  /** Next ID to allocate for outgoing requests. */
  private nextOutgoingId: bigint;

  /** Maximum request ID allowed by peer (exclusive). */
  private peerMaxRequestId: bigint = 0n;

  /** Highest incoming request ID seen from peer (initialized for +2 sequence check). */
  private highestIncomingId: bigint;

  /** Our MAX_REQUEST_ID sent to peer (exclusive). */
  private ourMaxRequestId: bigint = 0n;

  /** Whether we're currently blocked (want to send but can't). */
  private blocked: boolean = false;

  /** Window size for auto-replenishment. @see §9.5 */
  private readonly windowSize: bigint;

  /**
   * Whether outbound allocation is gated by a MAX_REQUEST_ID credit window
   * (draft-14/16). Draft-18 has no request credit — QUIC stream limits replace
   * it — so allocation is never gated and never becomes blocked.
   */
  private readonly hasCredit: boolean;

  /** Inbound validation mode (§10.1). 'strict-sequence' for draft-14/16 (credit
   *  window + exactly-next-in-sequence); 'parity-and-duplicate' for draft-18
   *  (no credit window; reject only wrong parity / duplicate Request IDs). */
  private readonly inboundValidation: 'strict-sequence' | 'parity-and-duplicate';

  /** Request IDs already seen from the peer — duplicate tracker for draft-18. */
  private readonly seenIncoming = new Set<bigint>();

  constructor(
    private readonly role: EndpointRoleValue,
    config?: RequestIdAllocatorConfig,
    policy?: RequestPolicy,
  ) {
    this.hasCredit = policy?.hasCredit ?? true;
    this.inboundValidation = policy?.inboundValidation ?? 'strict-sequence';
    // Client starts at 0 (even), server starts at 1 (odd)
    this.nextOutgoingId = role === EndpointRole.CLIENT ? 0n : 1n;

    // Initialize highestIncomingId so that first expected ID is peer's starting ID
    // Peer is opposite role: if we're client, peer is server (starts at 1); if we're server, peer is client (starts at 0)
    // First expected = highestIncomingId + 2, so highestIncomingId = peerStart - 2
    const peerStartId = role === EndpointRole.CLIENT ? 1n : 0n;
    this.highestIncomingId = peerStartId - 2n;

    this.windowSize = BigInt(config?.windowSize ?? DEFAULT_WINDOW_SIZE);
  }

  /**
   * Get the endpoint role.
   */
  get endpointRole(): EndpointRoleValue {
    return this.role;
  }

  /**
   * Get the parity bit for this endpoint's outgoing requests.
   * Client = 0 (even), Server = 1 (odd).
   */
  get parityBit(): 0n | 1n {
    return this.role === EndpointRole.CLIENT ? 0n : 1n;
  }

  /**
   * Get the peer's parity bit for incoming requests.
   */
  get peerParityBit(): 0n | 1n {
    return this.role === EndpointRole.CLIENT ? 1n : 0n;
  }

  /**
   * Update peer's MAX_REQUEST_ID.
   * Called when receiving SERVER_SETUP (client) or CLIENT_SETUP (server),
   * and when receiving MAX_REQUEST_ID messages.
   *
   * @param maxRequestId New maximum (exclusive) - IDs must be < this value
   * @throws {RequestIdError} If new value is not strictly greater than previous
   * @see draft-ietf-moq-transport-16 §9.5
   */
  updatePeerMaxRequestId(maxRequestId: Varint): void {
    // §9.5: MAX_REQUEST_ID must strictly increase; violation is PROTOCOL_VIOLATION
    if (maxRequestId <= this.peerMaxRequestId) {
      throw new RequestIdError(
        `MAX_REQUEST_ID must strictly increase: ${maxRequestId} <= ${this.peerMaxRequestId}`,
        'PROTOCOL_VIOLATION',
      );
    }
    this.peerMaxRequestId = maxRequestId;

    // Clear blocked state if we can now allocate
    if (this.nextOutgoingId < this.peerMaxRequestId) {
      this.blocked = false;
    }
  }

  /**
   * Get our MAX_REQUEST_ID to send to peer.
   */
  getOurMaxRequestId(): Varint {
    return varint(this.ourMaxRequestId);
  }

  /**
   * Set our MAX_REQUEST_ID (to be sent to peer).
   * Must only increase.
   *
   * @param maxRequestId New maximum (exclusive)
   * @throws {Error} If new value is not strictly greater than previous
   */
  setOurMaxRequestId(maxRequestId: Varint): void {
    if (maxRequestId <= this.ourMaxRequestId) {
      throw new Error(
        `Our MAX_REQUEST_ID must strictly increase: ${maxRequestId} <= ${this.ourMaxRequestId}`,
      );
    }
    this.ourMaxRequestId = maxRequestId;
  }

  /**
   * Check if we can allocate more request IDs.
   * Returns false if next ID would exceed peer's MAX_REQUEST_ID.
   */
  canAllocate(): boolean {
    return !this.hasCredit || this.nextOutgoingId < this.peerMaxRequestId;
  }

  /**
   * Check if we're blocked (want to send but can't).
   * If true, should send REQUESTS_BLOCKED message.
   */
  isBlocked(): boolean {
    return this.blocked;
  }

  /**
   * Get the request ID to report in REQUESTS_BLOCKED message.
   * This is the ID we want to use but cannot.
   */
  getBlockedRequestId(): Varint {
    return varint(this.nextOutgoingId);
  }

  /**
   * Allocate the next request ID for an outgoing request.
   *
   * @returns The allocated request ID
   * @throws {RequestIdError} If allocation would exceed MAX_REQUEST_ID
   * @see draft-ietf-moq-transport-16 §9.1
   */
  allocate(): bigint {
    // draft-14/16: gated by the peer's MAX_REQUEST_ID credit window. draft-18
    // (hasCredit = false): no credit gate, and we never become blocked.
    if (this.hasCredit && this.nextOutgoingId >= this.peerMaxRequestId) {
      this.blocked = true;
      throw new RequestIdError(
        `Cannot allocate request ID ${this.nextOutgoingId}: exceeds peer MAX_REQUEST_ID ${this.peerMaxRequestId}`,
        'TOO_MANY_REQUESTS',
      );
    }

    // Return a semantic bigint request ID (no QUIC-varint cap); the draft-14/16
    // encoders enforce the QUIC range on the wire.
    const id = this.nextOutgoingId;
    this.nextOutgoingId += 2n; // Increment by 2 to maintain parity
    return id;
  }

  /**
   * Validate an incoming request ID from peer.
   *
   * Rules per §9.1:
   * - Must have correct parity (peer's parity bit)
   * - Must be < our MAX_REQUEST_ID
   * - Must be exactly next in sequence (+2 from previous)
   *
   * @param requestId The incoming request ID
   * @throws {RequestIdError} If validation fails
   */
  validateIncoming(requestId: bigint): void {
    // Check parity (both modes): peer Request IDs must have the peer's parity.
    const parity = requestId & 1n;
    if (parity !== this.peerParityBit) {
      throw new RequestIdError(
        `Invalid request ID parity: ${requestId} has LSB=${parity}, expected ${this.peerParityBit} from peer`,
        'INVALID_REQUEST_ID',
      );
    }

    if (this.inboundValidation === 'parity-and-duplicate') {
      // draft-18 §10.1: each request rides its own stream, so requests can arrive
      // out of order. QUIC stream limits replace the MAX_REQUEST_ID window, so we
      // only reject a wrong parity (above) or a DUPLICATE Request ID.
      if (this.seenIncoming.has(requestId)) {
        throw new RequestIdError(`Duplicate incoming Request ID ${requestId}`, 'INVALID_REQUEST_ID');
      }
      this.seenIncoming.add(requestId);
      if (requestId > this.highestIncomingId) this.highestIncomingId = requestId;
      return;
    }

    // strict-sequence (draft-14/16): credit window + exactly-next-in-sequence.
    // §9.5: receiving a request ID >= our MAX_REQUEST_ID is TOO_MANY_REQUESTS
    if (requestId >= this.ourMaxRequestId) {
      throw new RequestIdError(
        `Request ID ${requestId} exceeds our MAX_REQUEST_ID ${this.ourMaxRequestId}`,
        'TOO_MANY_REQUESTS',
      );
    }

    // Check next in sequence: must be exactly +2 from previous (§9.1)
    const expectedNext = this.highestIncomingId + 2n;
    if (requestId !== expectedNext) {
      throw new RequestIdError(
        `Request ID ${requestId} not next in sequence: expected ${expectedNext}`,
        'INVALID_REQUEST_ID',
      );
    }

    this.highestIncomingId = requestId;
  }

  /**
   * Validate that a request ID matches our parity (for responses to our requests).
   * Used when receiving SUBSCRIBE_OK, FETCH_OK, REQUEST_ERROR, etc.
   *
   * @param requestId The request ID in the response
   * @throws {RequestIdError} If parity doesn't match our outgoing requests
   */
  validateOurRequestId(requestId: bigint): void {
    const parity = requestId & 1n;
    if (parity !== this.parityBit) {
      throw new RequestIdError(
        `Response has wrong parity: ${requestId} has LSB=${parity}, expected ${this.parityBit} for our requests`,
        'INVALID_REQUEST_ID',
      );
    }

    // Must be less than our next ID (we must have allocated it)
    if (requestId >= this.nextOutgoingId) {
      throw new RequestIdError(
        `Response for unknown request ID ${requestId}: next outgoing is ${this.nextOutgoingId}`,
        'INVALID_REQUEST_ID',
      );
    }
  }

  /**
   * Get the next outgoing request ID without allocating it.
   * Useful for checking if allocation would succeed.
   */
  peekNextId(): Varint {
    return varint(this.nextOutgoingId);
  }

  /**
   * Get the current peer MAX_REQUEST_ID.
   */
  getPeerMaxRequestId(): Varint {
    return varint(this.peerMaxRequestId);
  }

  // ─── Auto-replenishment (§9.5 sliding window) ─────────────────

  /**
   * Check if we should send a new MAX_REQUEST_ID to the peer.
   *
   * Returns true when the peer has consumed past 50% of the current
   * window (measured from the last replenish base to ourMaxRequestId).
   *
   * @see draft-ietf-moq-transport-16 §9.5
   */
  shouldReplenish(): boolean {
    if (this.ourMaxRequestId === 0n) return false;
    // The peer's usable window runs from 0 (or previous max) up to ourMaxRequestId.
    // Trigger replenishment when they've consumed past the midpoint.
    const threshold = this.ourMaxRequestId / 2n;
    return this.highestIncomingId >= threshold;
  }

  /**
   * Get the next MAX_REQUEST_ID value to send to the peer.
   * Extends the window by windowSize from the current ourMaxRequestId.
   */
  nextReplenishValue(): Varint {
    return varint(this.ourMaxRequestId + this.windowSize);
  }

  /**
   * Commit the replenishment — updates ourMaxRequestId and resets
   * the replenish base. Call this after sending MAX_REQUEST_ID.
   */
  commitReplenish(): void {
    const newMax = this.ourMaxRequestId + this.windowSize;
    this.ourMaxRequestId = newMax;
  }
}
