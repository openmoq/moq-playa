/**
 * Fetch state machine tests.
 * @see draft-ietf-moq-transport-16 §5.2
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FetchStateMachine } from './fetch.js';
import { FetchState } from './types.js';
import { varint } from '../primitives/varint.js';

describe('FetchStateMachine', () => {
  describe('fetcher side (outgoing FETCH)', () => {
    let fetch: FetchStateMachine;

    beforeEach(() => {
      fetch = FetchStateMachine.createAsFetcher(varint(0n));
    });

    it('starts in PENDING state', () => {
      expect(fetch.state).toBe(FetchState.PENDING);
      expect(fetch.requestId).toBe(0n);
    });

    it('transitions to TRANSFERRING on FETCH_OK', () => {
      fetch.handleFetchOk();

      expect(fetch.state).toBe(FetchState.TRANSFERRING);
    });

    it('transitions to COMPLETED on REQUEST_ERROR', () => {
      fetch.handleRequestError(varint(0x10n), 'Does not exist');

      expect(fetch.state).toBe(FetchState.COMPLETED);
      expect(fetch.errorCode).toBe(0x10n);
      expect(fetch.errorReason).toBe('Does not exist');
    });

    it('transitions to COMPLETED on stream finish', () => {
      fetch.handleFetchOk();
      fetch.handleStreamFinish();

      expect(fetch.state).toBe(FetchState.COMPLETED);
    });

    it('cannot receive FETCH_OK after already transferring', () => {
      fetch.handleFetchOk();

      expect(() => fetch.handleFetchOk()).toThrow();
    });

    it('cannot receive FETCH_OK after completed', () => {
      fetch.handleRequestError(varint(0n), '');

      expect(() => fetch.handleFetchOk()).toThrow();
    });

    it('cannot finish stream in PENDING state', () => {
      expect(() => fetch.handleStreamFinish()).toThrow();
    });
  });

  describe('publisher side (incoming FETCH)', () => {
    let fetch: FetchStateMachine;

    beforeEach(() => {
      fetch = FetchStateMachine.createAsPublisher(varint(1n));
    });

    it('starts in PENDING state', () => {
      expect(fetch.state).toBe(FetchState.PENDING);
    });

    it('transitions to TRANSFERRING on sending FETCH_OK', () => {
      fetch.sendFetchOk();

      expect(fetch.state).toBe(FetchState.TRANSFERRING);
    });

    it('transitions to COMPLETED on sending REQUEST_ERROR', () => {
      fetch.sendRequestError(varint(0x1n), 'Unauthorized');

      expect(fetch.state).toBe(FetchState.COMPLETED);
    });

    it('transitions to COMPLETED on receiving FETCH_CANCEL', () => {
      fetch.sendFetchOk();
      fetch.handleFetchCancel();

      expect(fetch.state).toBe(FetchState.COMPLETED);
    });

    it('transitions to COMPLETED on stream finish (data sent)', () => {
      fetch.sendFetchOk();
      fetch.handleStreamFinish();

      expect(fetch.state).toBe(FetchState.COMPLETED);
    });

    it('CAN handle FETCH_CANCEL in PENDING state (draft-16 §9.18: cancel before FETCH_OK)', () => {
      expect(() => fetch.handleFetchCancel()).not.toThrow();
      expect(fetch.state).toBe(FetchState.COMPLETED);
      expect(fetch.wasCanceled).toBe(true);
    });

    it('cannot send FETCH_OK after already transferring', () => {
      fetch.sendFetchOk();

      expect(() => fetch.sendFetchOk()).toThrow();
    });
  });

  describe('role enforcement', () => {
    it('fetcher cannot send FETCH_OK', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      expect(() => fetch.sendFetchOk()).toThrow();
    });

    it('fetcher cannot send REQUEST_ERROR', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      expect(() => fetch.sendRequestError(varint(0n), '')).toThrow();
    });

    it('publisher cannot handle FETCH_OK', () => {
      const fetch = FetchStateMachine.createAsPublisher(varint(1n));
      expect(() => fetch.handleFetchOk()).toThrow();
    });

    it('publisher cannot handle REQUEST_ERROR', () => {
      const fetch = FetchStateMachine.createAsPublisher(varint(1n));
      expect(() => fetch.handleRequestError(varint(0n), '')).toThrow();
    });

    it('fetcher cannot handle FETCH_CANCEL', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      fetch.handleFetchOk();
      expect(() => fetch.handleFetchCancel()).toThrow();
    });
  });

  describe('state queries', () => {
    it('isPending returns true only in PENDING state', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));

      expect(fetch.isPending).toBe(true);

      fetch.handleFetchOk();
      expect(fetch.isPending).toBe(false);
    });

    it('isTransferring returns true only in TRANSFERRING state', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));

      expect(fetch.isTransferring).toBe(false);

      fetch.handleFetchOk();
      expect(fetch.isTransferring).toBe(true);

      fetch.handleStreamFinish();
      expect(fetch.isTransferring).toBe(false);
    });

    it('isCompleted returns true only in COMPLETED state', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));

      expect(fetch.isCompleted).toBe(false);

      fetch.handleRequestError(varint(0n), '');
      expect(fetch.isCompleted).toBe(true);
    });

    it('isPublisher returns role correctly', () => {
      const fetcher = FetchStateMachine.createAsFetcher(varint(0n));
      const publisher = FetchStateMachine.createAsPublisher(varint(1n));

      expect(fetcher.isPublisher).toBe(false);
      expect(publisher.isPublisher).toBe(true);
    });
  });

  describe('fetch range tracking', () => {
    it('stores start and end locations', () => {
      const startGroup = varint(5n);
      const startObject = varint(0n);
      const endGroup = varint(10n);
      const endObject = varint(100n);

      const fetch = FetchStateMachine.createAsFetcher(
        varint(0n),
        startGroup,
        startObject,
        endGroup,
        endObject,
      );

      expect(fetch.startGroup).toBe(5n);
      expect(fetch.startObject).toBe(0n);
      expect(fetch.endGroup).toBe(10n);
      expect(fetch.endObject).toBe(100n);
    });

    it('can be created without range (uses defaults)', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));

      expect(fetch.startGroup).toBeUndefined();
      expect(fetch.startObject).toBeUndefined();
      expect(fetch.endGroup).toBeUndefined();
      expect(fetch.endObject).toBeUndefined();
    });
  });

  describe('exactly one response rule', () => {
    it('fetcher: FETCH_OK then REQUEST_ERROR throws', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      fetch.handleFetchOk();

      expect(() => fetch.handleRequestError(varint(0n), '')).toThrow();
    });

    it('fetcher: REQUEST_ERROR then FETCH_OK throws', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      fetch.handleRequestError(varint(0n), '');

      expect(() => fetch.handleFetchOk()).toThrow();
    });

    it('publisher: FETCH_OK then REQUEST_ERROR throws', () => {
      const fetch = FetchStateMachine.createAsPublisher(varint(1n));
      fetch.sendFetchOk();

      expect(() => fetch.sendRequestError(varint(0n), '')).toThrow();
    });

    it('publisher: REQUEST_ERROR then FETCH_OK throws', () => {
      const fetch = FetchStateMachine.createAsPublisher(varint(1n));
      fetch.sendRequestError(varint(0n), '');

      expect(() => fetch.sendFetchOk()).toThrow();
    });
  });

  describe('FETCH_CANCEL handling (publisher receives)', () => {
    it('can cancel during TRANSFERRING', () => {
      const fetch = FetchStateMachine.createAsPublisher(varint(1n));
      fetch.sendFetchOk();
      fetch.handleFetchCancel();

      expect(fetch.state).toBe(FetchState.COMPLETED);
      expect(fetch.wasCanceled).toBe(true);
    });

    it('cannot cancel after completed', () => {
      const fetch = FetchStateMachine.createAsPublisher(varint(1n));
      fetch.sendFetchOk();
      fetch.handleStreamFinish();

      expect(() => fetch.handleFetchCancel()).toThrow();
    });

    it('tracks cancel state', () => {
      const fetchNormal = FetchStateMachine.createAsFetcher(varint(0n));
      fetchNormal.handleFetchOk();
      fetchNormal.handleStreamFinish();

      const fetchCanceled = FetchStateMachine.createAsPublisher(varint(1n));
      fetchCanceled.sendFetchOk();
      fetchCanceled.handleFetchCancel();

      expect(fetchNormal.wasCanceled).toBe(false);
      expect(fetchCanceled.wasCanceled).toBe(true);
    });
  });

  /**
   * §5.2: "A subscriber keeps FETCH state until it sends FETCH_CANCEL,
   * receives REQUEST_ERROR, or receives a FIN or RESET_STREAM for the
   * FETCH data stream."
   *
   * The subscriber can send FETCH_CANCEL from both PENDING and TRANSFERRING.
   * @see draft-ietf-moq-transport-16 §5.2, §9.18
   */
  describe('sendFetchCancel (fetcher sends §9.18)', () => {
    it('transitions from PENDING to COMPLETED', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      fetch.sendFetchCancel();

      expect(fetch.state).toBe(FetchState.COMPLETED);
      expect(fetch.wasCanceled).toBe(true);
    });

    it('transitions from TRANSFERRING to COMPLETED', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      fetch.handleFetchOk();
      fetch.sendFetchCancel();

      expect(fetch.state).toBe(FetchState.COMPLETED);
      expect(fetch.wasCanceled).toBe(true);
    });

    it('throws in COMPLETED state', () => {
      const fetch = FetchStateMachine.createAsFetcher(varint(0n));
      fetch.handleRequestError(varint(0n), '');

      expect(() => fetch.sendFetchCancel()).toThrow('COMPLETED');
    });

    it('throws on publisher side', () => {
      const fetch = FetchStateMachine.createAsPublisher(varint(1n));

      expect(() => fetch.sendFetchCancel()).toThrow('fetcher');
    });
  });
});

describe('joining fetch state (§9.16.2)', () => {
  it('relative joining fetcher stores joining fields and NO range', () => {
    const fetch = FetchStateMachine.createAsJoiningFetcher(varint(0n), {
      fetchType: 0x2, joiningRequestId: 4n, joiningStart: 2n,
    });
    expect(fetch.isJoining).toBe(true);
    expect(fetch.joining).toEqual({ fetchType: 0x2, joiningRequestId: 4n, joiningStart: 2n });
    expect(fetch.startGroup).toBeUndefined(); // publisher-computed, unknown here
  });

  it('absolute joining fetcher exposes start {joiningStart, 0} for FETCH_OK validation (§9.16.3)', () => {
    const fetch = FetchStateMachine.createAsJoiningFetcher(varint(0n), {
      fetchType: 0x3, joiningRequestId: 4n, joiningStart: 7n,
    });
    expect(fetch.startGroup).toBe(7n);
    expect(fetch.startObject).toBe(0n);
  });

  it('setResolvedRange back-fills the publisher-side range', () => {
    const fetch = FetchStateMachine.createAsJoiningPublisher(varint(2n), {
      fetchType: 0x2, joiningRequestId: 0n, joiningStart: 1n,
    });
    fetch.setResolvedRange(9n, 0n, 10n, 8n);
    expect(fetch.startGroup).toBe(9n);
    expect(fetch.endGroup).toBe(10n);
    expect(fetch.endObject).toBe(8n);
  });

  it('setResolvedRange throws for a standalone fetch (range came from the message)', () => {
    const fetch = FetchStateMachine.createAsPublisher(varint(2n), 0n, 0n, 1n, 0n);
    expect(fetch.isJoining).toBe(false);
    expect(() => fetch.setResolvedRange(0n, 0n, 1n, 0n)).toThrow('joining');
  });
});
