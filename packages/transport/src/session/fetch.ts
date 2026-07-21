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

/** Joining Fetch fields carried by the state machine (§9.16.2). */
export interface JoiningFetchState {
  /** 0x2 = Relative Joining Fetch, 0x3 = Absolute Joining Fetch. */
  readonly fetchType: 0x2 | 0x3;
  /** Request ID of the subscription being joined. */
  readonly joiningRequestId: bigint;
  /** Relative group count (0x2) or absolute start group (0x3). */
  readonly joiningStart: bigint;
}

/**
 * Manages the state machine for a single fetch request.
 */
export class FetchStateMachine {
  private _state: FetchStateValue = FetchState.PENDING;
  private _errorCode: bigint | undefined;
  private _errorReason: string | undefined;
  private _wasCanceled: boolean = false;
  private _joining: JoiningFetchState | undefined;
  // §10.13: FETCH_OK and the data stream are INDEPENDENT — "the FETCH_OK or
  // REQUEST_ERROR can come at any time relative to object delivery." A fetcher's
  // fetch is fully done only after BOTH the response (FETCH_OK) AND the data stream
  // end have been observed, in either order.
  private _responseReceived = false;
  private _responseSent = false;
  private _dataFinished = false;

  private constructor(
    private readonly _requestId: bigint,
    private readonly _isPublisher: boolean,
    private _startGroup?: bigint,
    private _startObject?: bigint,
    private _endGroup?: bigint,
    private _endObject?: bigint,
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

  /**
   * Create a fetch state machine for an outgoing Joining Fetch (§9.16.2).
   *
   * A Relative Joining Fetch (0x2) stores no range — the publisher computes
   * it from the subscription's Largest Location, which this subscriber does
   * not know, so FETCH_OK end/start validation is skipped. An Absolute
   * Joining Fetch (0x3) has a known start `{joiningStart, 0}` (§9.16.2.1),
   * stored so the §9.16.3 "End Location MUST specify the same or a larger
   * Location than Start Location" check applies to its FETCH_OK.
   */
  static createAsJoiningFetcher(
    requestId: bigint,
    joining: JoiningFetchState,
  ): FetchStateMachine {
    const sm = joining.fetchType === 0x3
      ? new FetchStateMachine(requestId, false, joining.joiningStart, 0n)
      : new FetchStateMachine(requestId, false);
    sm._joining = joining;
    return sm;
  }

  /**
   * Create a fetch state machine for an incoming Joining Fetch (§9.16.2).
   * The range is unknown until the application supplies the subscription's
   * Largest Location via {@link setResolvedRange}.
   */
  static createAsJoiningPublisher(
    requestId: bigint,
    joining: JoiningFetchState,
  ): FetchStateMachine {
    const sm = new FetchStateMachine(requestId, true);
    sm._joining = joining;
    return sm;
  }

  // ─── Joining Fetch ────────────────────────────────────────────────────

  /** Whether this fetch is a Joining Fetch (0x2/0x3). */
  get isJoining(): boolean {
    return this._joining !== undefined;
  }

  /** Joining Fetch fields, or undefined for a standalone fetch. */
  get joining(): JoiningFetchState | undefined {
    return this._joining;
  }

  /**
   * Back-fill the publisher-side range once the application has resolved the
   * Joining Fetch against the subscription's Largest Location (§9.16.2.1).
   * The absolute start (if any) set at creation is overwritten by the
   * resolved values.
   *
   * @throws {Error} for a standalone fetch (its range came from the message).
   */
  setResolvedRange(
    startGroup: bigint,
    startObject: bigint,
    endGroup: bigint,
    endObject: bigint,
  ): void {
    if (this._joining === undefined) {
      throw new Error('setResolvedRange is only valid for a joining fetch');
    }
    this._startGroup = startGroup;
    this._startObject = startObject;
    this._endGroup = endGroup;
    this._endObject = endObject;
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
   * Handle FETCH_OK received (fetcher side). §10.13: it may arrive before OR after
   * the data stream. Records that the response was seen; a duplicate is a §5.2
   * violation. Moves PENDING → TRANSFERRING (unless the data already finished).
   */
  handleFetchOk(): void {
    this.assertNotPublisher('handleFetchOk');
    this.assertNotCompleted('handleFetchOk'); // §5.2: no FETCH_OK after REQUEST_ERROR / cancel
    if (this._responseReceived) {
      throw new Error('Cannot handleFetchOk: FETCH_OK already received (§5.2: one response)');
    }
    this._responseReceived = true;
    if (this._state === FetchState.PENDING) this._state = FetchState.TRANSFERRING;
  }

  /** Fetcher side: the FETCH_OK response has been received. */
  get responseReceived(): boolean {
    return this._responseReceived;
  }

  /** Fetcher side: the FETCH data stream has ended (FIN/reset). */
  get dataFinished(): boolean {
    return this._dataFinished;
  }

  /**
   * Fetcher side: whether BOTH the FETCH_OK response AND the data-stream end have
   * been observed (§10.13) — the fetch is then fully complete and reclaimable in
   * either arrival order.
   */
  get isFetcherComplete(): boolean {
    return this._responseReceived && this._dataFinished;
  }

  /** Fetcher side: record the FETCH data stream ended (FIN/reset), any order. */
  markDataFinished(): void {
    this._dataFinished = true;
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

    this._responseSent = true;
    this._state = FetchState.TRANSFERRING;
  }

  /** Publisher side: the FETCH_OK response has been sent. */
  get responseSent(): boolean {
    return this._responseSent;
  }

  /**
   * Publisher side: whether BOTH the FETCH_OK response AND the response-stream end
   * have been observed (§10.13) — the served fetch is then reclaimable, in either
   * order (a publisher may close the data stream before sending FETCH_OK).
   */
  get isPublisherComplete(): boolean {
    return this._responseSent && this._dataFinished;
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
   * Handle FETCH_CANCEL received (publisher side). draft-16 §9.18 permits the
   * fetcher to cancel from EITHER state — before FETCH_OK (PENDING) or during
   * transfer (TRANSFERRING) — so accept both; only a COMPLETED fetch is invalid.
   * Transitions to COMPLETED.
   */
  handleFetchCancel(): void {
    this.assertNotCompleted('handleFetchCancel');
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
