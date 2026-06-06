/**
 * Namespace discovery state machine.
 *
 * Manages the lifecycle of a SUBSCRIBE_NAMESPACE from request to termination.
 * Supports both subscriber (outgoing) and publisher (incoming) perspectives.
 *
 * State transitions:
 * - PENDING: SUBSCRIBE_NAMESPACE sent/received, awaiting REQUEST_OK or REQUEST_ERROR
 * - ACTIVE: REQUEST_OK exchanged, receiving/sending NAMESPACE messages
 * - TERMINATED: REQUEST_ERROR received or NAMESPACE_DONE sent/received
 *
 * The subscriber discovers namespaces matching their prefix via NAMESPACE messages.
 * The publisher announces matching namespaces until sending NAMESPACE_DONE.
 *
 * @see draft-ietf-moq-transport-16 §6.1
 * @module
 */

import { NamespaceState, type NamespaceStateValue } from './types.js';

/**
 * Manages the state machine for a single namespace discovery request.
 */
export class NamespaceStateMachine {
  private _state: NamespaceStateValue = NamespaceState.PENDING;
  private _errorCode: bigint | undefined;
  private _errorReason: string | undefined;
  private _discoveredNamespaces: Uint8Array[][] = [];
  private _prefixKey: string;

  private constructor(
    private readonly _requestId: bigint,
    private readonly _isPublisher: boolean,
    private _namespacePrefix: Uint8Array[],
  ) {
    this._prefixKey = this.computePrefixKey(_namespacePrefix);
  }

  /**
   * Replace the Track Namespace Prefix (draft-18 §10.9.2). Used when a
   * REQUEST_UPDATE carrying TRACK_NAMESPACE_PREFIX is accepted — on either side:
   * the subscriber applies it on REQUEST_OK, the publisher applies it when it
   * accepts the peer's update. Recomputes the prefix key.
   */
  updatePrefix(newPrefix: Uint8Array[]): void {
    this._namespacePrefix = newPrefix;
    this._prefixKey = this.computePrefixKey(newPrefix);
  }

  /**
   * Create a namespace state machine as subscriber (sending SUBSCRIBE_NAMESPACE).
   */
  static createAsSubscriber(
    requestId: bigint,
    namespacePrefix: Uint8Array[],
  ): NamespaceStateMachine {
    return new NamespaceStateMachine(requestId, false, namespacePrefix);
  }

  /**
   * Create a namespace state machine as publisher (receiving SUBSCRIBE_NAMESPACE).
   */
  static createAsPublisher(
    requestId: bigint,
    namespacePrefix: Uint8Array[],
  ): NamespaceStateMachine {
    return new NamespaceStateMachine(requestId, true, namespacePrefix);
  }

  // ─── Getters ──────────────────────────────────────────────────────────

  /** Current namespace discovery state. */
  get state(): NamespaceStateValue {
    return this._state;
  }

  /** Request ID for this namespace discovery. */
  get requestId(): bigint {
    return this._requestId;
  }

  /** Namespace prefix being subscribed to. */
  get namespacePrefix(): Uint8Array[] {
    return this._namespacePrefix;
  }

  /** Error code if terminated with REQUEST_ERROR. */
  get errorCode(): bigint | undefined {
    return this._errorCode;
  }

  /** Error reason if terminated with REQUEST_ERROR. */
  get errorReason(): string | undefined {
    return this._errorReason;
  }

  /** Discovered namespace suffixes (subscriber side). */
  get discoveredNamespaces(): Uint8Array[][] {
    return this._discoveredNamespaces;
  }

  /** Unique key for this namespace prefix (for duplicate detection). */
  get prefixKey(): string {
    return this._prefixKey;
  }

  /** Whether this is the publisher side. */
  get isPublisher(): boolean {
    return this._isPublisher;
  }

  // ─── State Queries ────────────────────────────────────────────────────

  /** Whether namespace discovery is pending (awaiting response). */
  get isPending(): boolean {
    return this._state === NamespaceState.PENDING;
  }

  /** Whether namespace discovery is active (receiving/sending namespaces). */
  get isActive(): boolean {
    return this._state === NamespaceState.ACTIVE;
  }

  /** Whether namespace discovery is terminated. */
  get isTerminated(): boolean {
    return this._state === NamespaceState.TERMINATED;
  }

  // ─── Subscriber Side Transitions ──────────────────────────────────────

  /**
   * Handle REQUEST_OK received (subscriber side).
   * Transitions from PENDING to ACTIVE.
   */
  handleRequestOk(): void {
    this.assertState(NamespaceState.PENDING, 'handleRequestOk');
    this.assertNotPublisher('handleRequestOk');

    this._state = NamespaceState.ACTIVE;
  }

  /**
   * Handle REQUEST_ERROR received (subscriber side).
   * Transitions to TERMINATED.
   */
  handleRequestError(errorCode: bigint, errorReason: string): void {
    this.assertNotTerminated('handleRequestError');
    this.assertNotPublisher('handleRequestError');

    this._errorCode = errorCode;
    this._errorReason = errorReason;
    this._state = NamespaceState.TERMINATED;
  }

  /**
   * Handle NAMESPACE received (subscriber side).
   * Records the discovered namespace suffix.
   */
  handleNamespace(namespaceSuffix: Uint8Array[]): void {
    this.assertState(NamespaceState.ACTIVE, 'handleNamespace');
    this.assertNotPublisher('handleNamespace');

    this._discoveredNamespaces.push(namespaceSuffix);
  }

  /**
   * Check whether a suffix was previously announced via NAMESPACE.
   * Used by session to enforce §6.1 ordering: NAMESPACE_DONE requires prior NAMESPACE.
   * @see draft-ietf-moq-transport-16 §6.1
   */
  hasDiscoveredSuffix(suffix: Uint8Array[]): boolean {
    return this._discoveredNamespaces.some(
      (discovered) => this.suffixEquals(discovered, suffix),
    );
  }

  /**
   * Withdraw a previously discovered namespace (per-namespace removal).
   *
   * Used when PUBLISH_NAMESPACE_DONE or PUBLISH_NAMESPACE_CANCEL arrives
   * for a specific namespace. The subscription stays ACTIVE — new
   * PUBLISH_NAMESPACE messages can still arrive for other namespaces.
   *
   * @see draft-ietf-moq-transport-14 §9.26: "withdraws a previous
   *   PUBLISH_NAMESPACE, although it is not a protocol error for the
   *   subscriber to send a SUBSCRIBE or FETCH message for a track in a
   *   namespace after receiving a PUBLISH_NAMESPACE_DONE."
   */
  withdrawNamespace(namespace: Uint8Array[]): void {
    this.assertState(NamespaceState.ACTIVE, 'withdrawNamespace');

    const idx = this._discoveredNamespaces.findIndex(
      (discovered) => this.suffixEquals(discovered, namespace),
    );
    if (idx !== -1) {
      this._discoveredNamespaces.splice(idx, 1);
    }
  }

  /**
   * Handle NAMESPACE_DONE received (subscriber side).
   * Transitions from ACTIVE to TERMINATED.
   */
  handleNamespaceDone(): void {
    this.assertState(NamespaceState.ACTIVE, 'handleNamespaceDone');
    this.assertNotPublisher('handleNamespaceDone');

    this._state = NamespaceState.TERMINATED;
  }

  // ─── Publisher Side Transitions ───────────────────────────────────────

  /**
   * Send REQUEST_OK (publisher side).
   * Transitions from PENDING to ACTIVE.
   */
  sendRequestOk(): void {
    this.assertState(NamespaceState.PENDING, 'sendRequestOk');
    this.assertPublisher('sendRequestOk');

    this._state = NamespaceState.ACTIVE;
  }

  /**
   * Send REQUEST_ERROR (publisher side).
   * Transitions to TERMINATED.
   */
  sendRequestError(errorCode: bigint, errorReason: string): void {
    this.assertNotTerminated('sendRequestError');
    this.assertPublisher('sendRequestError');

    this._errorCode = errorCode;
    this._errorReason = errorReason;
    this._state = NamespaceState.TERMINATED;
  }

  /**
   * Send NAMESPACE (publisher side).
   * Announces a namespace matching the prefix.
   */
  sendNamespace(namespaceSuffix: Uint8Array[]): void {
    this.assertState(NamespaceState.ACTIVE, 'sendNamespace');
    this.assertPublisher('sendNamespace');

    // Publisher tracks what was sent (for completeness)
    this._discoveredNamespaces.push(namespaceSuffix);
  }

  /**
   * Send NAMESPACE_DONE (publisher side).
   * Transitions from ACTIVE to TERMINATED.
   */
  sendNamespaceDone(): void {
    this.assertState(NamespaceState.ACTIVE, 'sendNamespaceDone');
    this.assertPublisher('sendNamespaceDone');

    this._state = NamespaceState.TERMINATED;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private assertState(expected: NamespaceStateValue, operation: string): void {
    if (this._state !== expected) {
      throw new Error(
        `Cannot ${operation} in state ${this._state}; expected ${expected}`,
      );
    }
  }

  private assertNotTerminated(operation: string): void {
    if (this._state === NamespaceState.TERMINATED) {
      throw new Error(`Cannot ${operation} in TERMINATED state`);
    }
  }

  private assertPublisher(operation: string): void {
    if (!this._isPublisher) {
      throw new Error(`${operation} is only valid for publisher side`);
    }
  }

  private assertNotPublisher(operation: string): void {
    if (this._isPublisher) {
      throw new Error(`${operation} is only valid for subscriber side`);
    }
  }

  private computePrefixKey(prefix: Uint8Array[]): string {
    const parts: string[] = [];
    for (const segment of prefix) {
      parts.push(this.bytesToHex(segment));
    }
    return parts.join('/');
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Compare two namespace suffixes (arrays of Uint8Array segments) for equality.
   */
  private suffixEquals(a: Uint8Array[], b: Uint8Array[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const sa = a[i]!, sb = b[i]!;
      if (sa.length !== sb.length) return false;
      for (let j = 0; j < sa.length; j++) {
        if (sa[j] !== sb[j]) return false;
      }
    }
    return true;
  }
}
