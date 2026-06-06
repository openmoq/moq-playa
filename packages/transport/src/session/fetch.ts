/**
 * Fetch state machine.
 *
 * Manages the lifecycle of a fetch request from FETCH to completion.
 * Supports both fetcher (outgoing) and publisher (incoming) perspectives.
 *
 * State transitions:
 * - PENDING: FETCH sent/received, awaiting FETCH_OK or REQUEST_ERROR
 * - TRANSFERRING: FETCH_OK exchanged, data stream active
 * - COMPLETED: Stream finished, FETCH_CANCEL, or REQUEST_ERROR
 *
 * Exactly one response rule: A FETCH receives either FETCH_OK or REQUEST_ERROR,
 * never both. Once in TRANSFERRING or COMPLETED state, no further responses allowed.
 *
 * @see draft-ietf-moq-transport-16 §5.2
 * @module
 */

import { FetchState, type FetchStateValue } from './types.js';

/**
 * Manages the state machine for a single fetch request.
 */
export class FetchStateMachine {
  private _state: FetchStateValue = FetchState.PENDING;
  private _errorCode: bigint | undefined;
  private _errorReason: string | undefined;
  private _wasCanceled: boolean = false;

  private constructor(
    private readonly _requestId: bigint,
    private readonly _isPublisher: boolean,
    private readonly _startGroup?: bigint,
    private readonly _startObject?: bigint,
    private readonly _endGroup?: bigint,
    private readonly _endObject?: bigint,
  ) {}

  /**
   * Create a fetch state machine as fetcher (sending FETCH).
   */
  static createAsFetcher(
    requestId: bigint,
    startGroup?: bigint,
    startObject?: bigint,
    endGroup?: bigint,
    endObject?: bigint,
  ): FetchStateMachine {
    return new FetchStateMachine(
      requestId,
      false,
      startGroup,
      startObject,
      endGroup,
      endObject,
    );
  }

  /**
   * Create a fetch state machine as publisher (receiving FETCH).
   */
  static createAsPublisher(
    requestId: bigint,
    startGroup?: bigint,
    startObject?: bigint,
    endGroup?: bigint,
    endObject?: bigint,
  ): FetchStateMachine {
    return new FetchStateMachine(
      requestId,
      true,
      startGroup,
      startObject,
      endGroup,
      endObject,
    );
  }

  // ─── Getters ──────────────────────────────────────────────────────────

  /** Current fetch state. */
  get state(): FetchStateValue {
    return this._state;
  }

  /** Request ID for this fetch. */
  get requestId(): bigint {
    return this._requestId;
  }

  /** Error code if completed with REQUEST_ERROR. */
  get errorCode(): bigint | undefined {
    return this._errorCode;
  }

  /** Error reason if completed with REQUEST_ERROR. */
  get errorReason(): string | undefined {
    return this._errorReason;
  }

  /** Whether this fetch was canceled via FETCH_CANCEL. */
  get wasCanceled(): boolean {
    return this._wasCanceled;
  }

  /** Whether this is the publisher side. */
  get isPublisher(): boolean {
    return this._isPublisher;
  }

  /** Start group of the fetch range. */
  get startGroup(): bigint | undefined {
    return this._startGroup;
  }

  /** Start object of the fetch range. */
  get startObject(): bigint | undefined {
    return this._startObject;
  }

  /** End group of the fetch range. */
  get endGroup(): bigint | undefined {
    return this._endGroup;
  }

  /** End object of the fetch range. */
  get endObject(): bigint | undefined {
    return this._endObject;
  }

  // ─── State Queries ────────────────────────────────────────────────────

  /** Whether fetch is pending (awaiting response). */
  get isPending(): boolean {
    return this._state === FetchState.PENDING;
  }

  /** Whether fetch is actively transferring data. */
  get isTransferring(): boolean {
    return this._state === FetchState.TRANSFERRING;
  }

  /** Whether fetch is completed. */
  get isCompleted(): boolean {
    return this._state === FetchState.COMPLETED;
  }

  // ─── Fetcher Side Transitions ─────────────────────────────────────────

  /**
   * Handle FETCH_OK received (fetcher side).
   * Transitions from PENDING to TRANSFERRING.
   */
  handleFetchOk(): void {
    this.assertState(FetchState.PENDING, 'handleFetchOk');
    this.assertNotPublisher('handleFetchOk');

    this._state = FetchState.TRANSFERRING;
  }

  /**
   * Handle REQUEST_ERROR received (fetcher side).
   * Transitions to COMPLETED.
   */
  handleRequestError(errorCode: bigint, errorReason: string): void {
    this.assertNotCompleted('handleRequestError');
    this.assertNotTransferring('handleRequestError');
    this.assertNotPublisher('handleRequestError');

    this._errorCode = errorCode;
    this._errorReason = errorReason;
    this._state = FetchState.COMPLETED;
  }

  // ─── Publisher Side Transitions ───────────────────────────────────────

  /**
   * Send FETCH_OK (publisher side).
   * Transitions from PENDING to TRANSFERRING.
   */
  sendFetchOk(): void {
    this.assertState(FetchState.PENDING, 'sendFetchOk');
    this.assertPublisher('sendFetchOk');

    this._state = FetchState.TRANSFERRING;
  }

  /**
   * Send REQUEST_ERROR (publisher side).
   * Transitions to COMPLETED.
   */
  sendRequestError(errorCode: bigint, errorReason: string): void {
    this.assertNotCompleted('sendRequestError');
    this.assertNotTransferring('sendRequestError');
    this.assertPublisher('sendRequestError');

    this._errorCode = errorCode;
    this._errorReason = errorReason;
    this._state = FetchState.COMPLETED;
  }

  /**
   * Handle FETCH_CANCEL received (publisher side).
   * Transitions from TRANSFERRING to COMPLETED.
   */
  handleFetchCancel(): void {
    this.assertState(FetchState.TRANSFERRING, 'handleFetchCancel');
    this.assertPublisher('handleFetchCancel');

    this._wasCanceled = true;
    this._state = FetchState.COMPLETED;
  }

  // ─── Fetcher Side Cancel ─────────────────────────────────────────────

  /**
   * Send FETCH_CANCEL (fetcher side).
   *
   * §5.2: "A subscriber keeps FETCH state until it sends FETCH_CANCEL,
   * receives REQUEST_ERROR, or receives a FIN or RESET_STREAM for the
   * FETCH data stream."
   *
   * Can be sent from PENDING (before FETCH_OK) or TRANSFERRING.
   * Transitions to COMPLETED.
   *
   * @see draft-ietf-moq-transport-16 §5.2, §9.18
   */
  sendFetchCancel(): void {
    this.assertNotCompleted('sendFetchCancel');
    this.assertNotPublisher('sendFetchCancel');

    this._wasCanceled = true;
    this._state = FetchState.COMPLETED;
  }

  // ─── Common Transitions ───────────────────────────────────────────────

  /**
   * Handle stream finish (data transfer complete).
   * Transitions from TRANSFERRING to COMPLETED.
   * Valid for both fetcher (received all data) and publisher (sent all data).
   */
  handleStreamFinish(): void {
    this.assertState(FetchState.TRANSFERRING, 'handleStreamFinish');

    this._state = FetchState.COMPLETED;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private assertState(expected: FetchStateValue, operation: string): void {
    if (this._state !== expected) {
      throw new Error(
        `Cannot ${operation} in state ${this._state}; expected ${expected}`,
      );
    }
  }

  private assertNotCompleted(operation: string): void {
    if (this._state === FetchState.COMPLETED) {
      throw new Error(`Cannot ${operation} in COMPLETED state`);
    }
  }

  private assertNotTransferring(operation: string): void {
    if (this._state === FetchState.TRANSFERRING) {
      throw new Error(`Cannot ${operation} in TRANSFERRING state`);
    }
  }

  private assertPublisher(operation: string): void {
    if (!this._isPublisher) {
      throw new Error(`${operation} is only valid for publisher side`);
    }
  }

  private assertNotPublisher(operation: string): void {
    if (this._isPublisher) {
      throw new Error(`${operation} is only valid for fetcher side`);
    }
  }
}
