/**
 * Subscription state machine.
 *
 * Manages the lifecycle of a subscription from SUBSCRIBE to termination.
 * Supports both subscriber (outgoing) and publisher (incoming) perspectives.
 *
 * State transitions:
 * - PENDING: Request sent/received, awaiting response
 * - ESTABLISHED: SUBSCRIBE_OK/PUBLISH_OK exchanged, active
 * - TERMINATED: Ended via UNSUBSCRIBE, PUBLISH_DONE, or REQUEST_ERROR
 *
 * Forward state is separate and controls object delivery:
 * - ACTIVE (1): Objects are forwarded (default)
 * - PAUSED (0): Objects are not forwarded
 *
 * @see draft-ietf-moq-transport-16 §5.1
 * @module
 */

import { varint, type Varint } from '../primitives/varint.js';
import type { Parameters } from '../control/messages.js';
import {
  SubscriptionState,
  ForwardState,
  type SubscriptionStateValue,
  type ForwardStateValue,
} from './types.js';

/**
 * Location within a track (group + object ID).
 */
export interface Location {
  readonly groupId: Varint;
  readonly objectId: Varint;
}

/**
 * Manages the state machine for a single subscription.
 */
export class SubscriptionStateMachine {
  private _state: SubscriptionStateValue = SubscriptionState.PENDING;
  private _forwardState: ForwardStateValue = ForwardState.ACTIVE;
  private _trackAlias: bigint | undefined;
  private _errorCode: bigint | undefined;
  private _errorReason: string | undefined;
  // PUBLISH_DONE Status Code — vi64 (full uint64) on draft-18, so `bigint`.
  private _terminationCode: bigint | undefined;
  private _largestLocation: Location | undefined;
  private _trackKey: string | undefined;
  /**
   * Number of data streams opened by the publisher for this subscription.
   * Used in PUBLISH_DONE streamCount field.
   * @see draft-ietf-moq-transport-16 §9.15
   */
  private _streamCount: bigint = 0n;
  /**
   * Last-sent SUBSCRIPTION_FILTER bytes for this subscription.
   * Used by draft-14 codec to replay filter in SUBSCRIBE_UPDATE when
   * no new filter is specified (draft-14 inline fields are mandatory).
   * @see draft-ietf-moq-transport-14 §9.10
   */
  private _currentFilter: Uint8Array | undefined;
  /**
   * Last-sent SUBSCRIBER_PRIORITY for this subscription.
   * Used by draft-14 to replay unchanged values in SUBSCRIBE_UPDATE.
   * @see draft-ietf-moq-transport-14 §9.10
   */
  private _currentPriority: Varint | undefined;
  /**
   * Whether this subscription was initiated by a PUBLISH message.
   * Used in draft-14 to determine response type (PUBLISH_OK vs SUBSCRIBE_OK).
   * @see draft-ietf-moq-transport-14 §9.13
   */
  private _publishInitiated = false;

  /**
   * Parameters from the inbound PUBLISH message.
   * Retained so the session layer can derive the initial PUBLISH_OK response
   * without losing version-specific inline state such as draft-14 GROUP_ORDER.
   * @see draft-ietf-moq-transport-14 §9.13, §9.14
   */
  private _publishParameters: Parameters = new Map();

  private constructor(
    private readonly _requestId: bigint,
    private readonly _isPublisher: boolean,
    private readonly _trackNamespace?: Uint8Array[],
    private readonly _trackName?: Uint8Array,
  ) {
    // Compute track key for duplicate detection
    if (_trackNamespace && _trackName) {
      this._trackKey = this.computeTrackKey(_trackNamespace, _trackName);
    }
  }

  /**
   * Create a subscription state machine as subscriber (sending SUBSCRIBE).
   */
  static createAsSubscriber(
    requestId: bigint,
    trackNamespace?: Uint8Array[],
    trackName?: Uint8Array,
  ): SubscriptionStateMachine {
    return new SubscriptionStateMachine(requestId, false, trackNamespace, trackName);
  }

  /**
   * Create a subscription state machine as publisher (receiving SUBSCRIBE).
   */
  static createAsPublisher(
    requestId: bigint,
    trackNamespace?: Uint8Array[],
    trackName?: Uint8Array,
  ): SubscriptionStateMachine {
    return new SubscriptionStateMachine(requestId, true, trackNamespace, trackName);
  }

  /**
   * Create a subscription state machine for an incoming PUBLISH.
   * Draft-14 §9.13: Publisher sends PUBLISH to announce publication.
   * Subscriber responds with PUBLISH_OK or PUBLISH_ERROR.
   * @see draft-ietf-moq-transport-14 §9.13
   */
  static createFromPublish(
    requestId: bigint,
    trackNamespace?: Uint8Array[],
    trackName?: Uint8Array,
    parameters?: Parameters,
  ): SubscriptionStateMachine {
    const sm = new SubscriptionStateMachine(requestId, true, trackNamespace, trackName);
    sm._publishInitiated = true;
    if (parameters) {
      sm._publishParameters = parameters;
    }
    return sm;
  }

  // ─── Getters ──────────────────────────────────────────────────────────

  /** Current subscription state. */
  get state(): SubscriptionStateValue {
    return this._state;
  }

  /** Current forward state (ACTIVE or PAUSED). */
  get forwardState(): ForwardStateValue {
    return this._forwardState;
  }

  /** Request ID for this subscription. */
  get requestId(): bigint {
    return this._requestId;
  }

  /** Track alias assigned on SUBSCRIBE_OK. */
  get trackAlias(): bigint | undefined {
    return this._trackAlias;
  }

  /** Error code if terminated with REQUEST_ERROR. */
  get errorCode(): bigint | undefined {
    return this._errorCode;
  }

  /** Error reason if terminated with REQUEST_ERROR. */
  get errorReason(): string | undefined {
    return this._errorReason;
  }

  /** Termination code if terminated with PUBLISH_DONE (vi64, full uint64 on draft-18). */
  get terminationCode(): bigint | undefined {
    return this._terminationCode;
  }

  /** Largest location seen on this subscription. */
  get largestLocation(): Location | undefined {
    return this._largestLocation;
  }

  /**
   * Number of data streams opened by the publisher for this subscription.
   * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
   */
  get streamCount(): Varint {
    return varint(this._streamCount);
  }

  /**
   * Increment the stream count when a data stream is opened for this subscription.
   * Called by the adapter layer when it opens a unidirectional data stream.
   * @see draft-ietf-moq-transport-16 §9.15 (PUBLISH_DONE)
   */
  incrementStreamCount(): void {
    this._streamCount++;
  }

  /** Track namespace segments. */
  get trackNamespace(): Uint8Array[] | undefined {
    return this._trackNamespace;
  }

  /** Track name. */
  get trackName(): Uint8Array | undefined {
    return this._trackName;
  }

  /** Unique key for duplicate detection. */
  get trackKey(): string | undefined {
    return this._trackKey;
  }

  /** Whether this subscription was initiated via PUBLISH (draft-14). */
  get isPublishInitiated(): boolean {
    return this._publishInitiated;
  }

  /** Parameters from the inbound PUBLISH, for PUBLISH_OK response. */
  get publishParameters(): Parameters {
    return this._publishParameters;
  }

  /** Last-sent SUBSCRIPTION_FILTER bytes (for draft-14 SUBSCRIBE_UPDATE replay). */
  get currentFilter(): Uint8Array | undefined {
    return this._currentFilter;
  }

  /** Store the SUBSCRIPTION_FILTER bytes sent with SUBSCRIBE or REQUEST_UPDATE. */
  set currentFilter(filter: Uint8Array | undefined) {
    this._currentFilter = filter;
  }

  /** Last-sent SUBSCRIBER_PRIORITY. */
  get currentPriority(): Varint | undefined {
    return this._currentPriority;
  }

  /** Store the SUBSCRIBER_PRIORITY sent with SUBSCRIBE or REQUEST_UPDATE. */
  set currentPriority(priority: Varint | undefined) {
    this._currentPriority = priority;
  }

  /** Whether this is the publisher side. */
  get isPublisher(): boolean {
    return this._isPublisher;
  }

  // ─── State Queries ────────────────────────────────────────────────────

  /** Whether subscription is pending (awaiting response). */
  get isPending(): boolean {
    return this._state === SubscriptionState.PENDING;
  }

  /** Whether subscription is established and forwarding objects. */
  get isActive(): boolean {
    return (
      this._state === SubscriptionState.ESTABLISHED &&
      this._forwardState === ForwardState.ACTIVE
    );
  }

  /** Whether subscription is terminated. */
  get isTerminated(): boolean {
    return this._state === SubscriptionState.TERMINATED;
  }

  // ─── Subscriber Side Transitions ──────────────────────────────────────

  /**
   * Handle SUBSCRIBE_OK received (subscriber side).
   * Transitions from PENDING to ESTABLISHED.
   */
  handleSubscribeOk(trackAlias: bigint): void {
    this.assertState(SubscriptionState.PENDING, 'handleSubscribeOk');
    this.assertNotPublisher('handleSubscribeOk');

    this._trackAlias = trackAlias;
    this._state = SubscriptionState.ESTABLISHED;
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
    this._state = SubscriptionState.TERMINATED;
  }

  /**
   * Handle PUBLISH_DONE received (subscriber side).
   * Transitions from ESTABLISHED to TERMINATED.
   */
  handlePublishDone(statusCode: bigint, errorReason: string): void {
    this.assertState(SubscriptionState.ESTABLISHED, 'handlePublishDone');
    this.assertNotPublisher('handlePublishDone');

    this._terminationCode = statusCode;
    this._errorReason = errorReason;
    this._state = SubscriptionState.TERMINATED;
  }

  // ─── Publisher Side Transitions ───────────────────────────────────────

  /**
   * Send SUBSCRIBE_OK (publisher side).
   * Transitions from PENDING to ESTABLISHED.
   */
  sendSubscribeOk(trackAlias: bigint): void {
    this.assertState(SubscriptionState.PENDING, 'sendSubscribeOk');
    this.assertPublisher('sendSubscribeOk');

    this._trackAlias = trackAlias;
    this._state = SubscriptionState.ESTABLISHED;
  }

  /**
   * Record the Track Alias we advertise in an OUTBOUND PUBLISH (publisher side,
   * draft-18 §10.10). The alias is chosen by the publisher and carried on the
   * PUBLISH; the subscription stays PENDING until the peer's REQUEST_OK.
   */
  setOutboundPublishAlias(trackAlias: bigint): void {
    this.assertState(SubscriptionState.PENDING, 'setOutboundPublishAlias');
    this.assertPublisher('setOutboundPublishAlias');

    this._trackAlias = trackAlias;
    this._publishInitiated = true;
  }

  /**
   * Peer accepted our OUTBOUND PUBLISH with REQUEST_OK (PUBLISH_OK shorthand,
   * draft-18 §10.10). Transitions PENDING → ESTABLISHED; the alias was already set
   * via {@link setOutboundPublishAlias}.
   */
  acceptOutboundPublish(): void {
    this.assertState(SubscriptionState.PENDING, 'acceptOutboundPublish');
    this.assertPublisher('acceptOutboundPublish');

    this._state = SubscriptionState.ESTABLISHED;
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
    this._state = SubscriptionState.TERMINATED;
  }

  /**
   * Send UNSUBSCRIBE (subscriber side).
   * Transitions from ESTABLISHED to TERMINATED.
   * @see draft-ietf-moq-transport-16 §2.4.2 (Malformed Track → MUST UNSUBSCRIBE)
   */
  sendUnsubscribe(): void {
    this.assertState(SubscriptionState.ESTABLISHED, 'sendUnsubscribe');
    this.assertNotPublisher('sendUnsubscribe');

    this._state = SubscriptionState.TERMINATED;
  }

  /**
   * Handle UNSUBSCRIBE received (publisher side).
   * Transitions from ESTABLISHED to TERMINATED.
   */
  handleUnsubscribe(): void {
    this.assertState(SubscriptionState.ESTABLISHED, 'handleUnsubscribe');
    this.assertPublisher('handleUnsubscribe');

    this._state = SubscriptionState.TERMINATED;
  }

  /**
   * Send PUBLISH_DONE (publisher side).
   * Transitions from ESTABLISHED to TERMINATED.
   */
  sendPublishDone(statusCode: Varint, errorReason: string): void {
    this.assertState(SubscriptionState.ESTABLISHED, 'sendPublishDone');
    this.assertPublisher('sendPublishDone');

    this._terminationCode = statusCode;
    this._errorReason = errorReason;
    this._state = SubscriptionState.TERMINATED;
  }

  // ─── Forward State ────────────────────────────────────────────────────

  /**
   * Update forward state via REQUEST_UPDATE.
   * Only valid in ESTABLISHED state.
   */
  updateForwardState(forward: ForwardStateValue): void {
    this.assertState(SubscriptionState.ESTABLISHED, 'updateForwardState');
    this._forwardState = forward;
  }

  // ─── Location Tracking ────────────────────────────────────────────────

  /**
   * Update largest location seen on this subscription.
   * Only updates if the new location is larger.
   */
  updateLargestLocation(groupId: Varint, objectId: Varint): void {
    if (!this._largestLocation) {
      this._largestLocation = { groupId, objectId };
      return;
    }

    // Only update if larger (group takes precedence)
    if (
      groupId > this._largestLocation.groupId ||
      (groupId === this._largestLocation.groupId && objectId > this._largestLocation.objectId)
    ) {
      this._largestLocation = { groupId, objectId };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private assertState(expected: SubscriptionStateValue, operation: string): void {
    if (this._state !== expected) {
      throw new Error(
        `Cannot ${operation} in state ${this._state}; expected ${expected}`,
      );
    }
  }

  private assertNotTerminated(operation: string): void {
    if (this._state === SubscriptionState.TERMINATED) {
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

  private computeTrackKey(namespace: Uint8Array[], name: Uint8Array): string {
    // Create a unique key by joining namespace segments and name
    const parts: string[] = [];
    for (const segment of namespace) {
      parts.push(this.bytesToHex(segment));
    }
    parts.push(this.bytesToHex(name));
    return parts.join('/');
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
