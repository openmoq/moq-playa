/**
 * Subscription state machine tests.
 * @see draft-ietf-moq-transport-16 §5.1
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SubscriptionStateMachine } from './subscription.js';
import { SubscriptionState, ForwardState } from './types.js';
import { varint } from '../primitives/varint.js';

describe('SubscriptionStateMachine', () => {
  describe('subscriber side (outgoing SUBSCRIBE)', () => {
    let sub: SubscriptionStateMachine;

    beforeEach(() => {
      sub = SubscriptionStateMachine.createAsSubscriber(varint(0n));
    });

    it('starts in PENDING state', () => {
      expect(sub.state).toBe(SubscriptionState.PENDING);
      expect(sub.requestId).toBe(0n);
    });

    it('transitions to ESTABLISHED on SUBSCRIBE_OK', () => {
      sub.handleSubscribeOk(varint(42n)); // track alias

      expect(sub.state).toBe(SubscriptionState.ESTABLISHED);
      expect(sub.trackAlias).toBe(42n);
    });

    it('transitions to TERMINATED on REQUEST_ERROR', () => {
      sub.handleRequestError(varint(0x10n), 'Does not exist');

      expect(sub.state).toBe(SubscriptionState.TERMINATED);
      expect(sub.errorCode).toBe(0x10n);
      expect(sub.errorReason).toBe('Does not exist');
    });

    it('transitions to TERMINATED on PUBLISH_DONE', () => {
      sub.handleSubscribeOk(varint(1n));
      sub.handlePublishDone(varint(0x2n), 'Track ended');

      expect(sub.state).toBe(SubscriptionState.TERMINATED);
      expect(sub.terminationCode).toBe(0x2n);
    });

    it('cannot receive SUBSCRIBE_OK after already established', () => {
      sub.handleSubscribeOk(varint(1n));

      expect(() => sub.handleSubscribeOk(varint(2n))).toThrow();
    });

    it('cannot receive PUBLISH_DONE in PENDING state', () => {
      expect(() => sub.handlePublishDone(varint(0n), '')).toThrow();
    });
  });

  describe('publisher side (incoming SUBSCRIBE)', () => {
    let sub: SubscriptionStateMachine;

    beforeEach(() => {
      sub = SubscriptionStateMachine.createAsPublisher(varint(1n));
    });

    it('starts in PENDING state', () => {
      expect(sub.state).toBe(SubscriptionState.PENDING);
    });

    it('transitions to ESTABLISHED on sending SUBSCRIBE_OK', () => {
      sub.sendSubscribeOk(varint(100n)); // track alias

      expect(sub.state).toBe(SubscriptionState.ESTABLISHED);
      expect(sub.trackAlias).toBe(100n);
    });

    it('transitions to TERMINATED on sending REQUEST_ERROR', () => {
      sub.sendRequestError(varint(0x1n), 'Unauthorized');

      expect(sub.state).toBe(SubscriptionState.TERMINATED);
    });

    it('transitions to TERMINATED on receiving UNSUBSCRIBE', () => {
      sub.sendSubscribeOk(varint(1n));
      sub.handleUnsubscribe();

      expect(sub.state).toBe(SubscriptionState.TERMINATED);
    });

    it('transitions to TERMINATED on sending PUBLISH_DONE', () => {
      sub.sendSubscribeOk(varint(1n));
      sub.sendPublishDone(varint(0x3n), 'Subscription ended');

      expect(sub.state).toBe(SubscriptionState.TERMINATED);
    });
  });

  describe('forward state', () => {
    let sub: SubscriptionStateMachine;

    beforeEach(() => {
      sub = SubscriptionStateMachine.createAsSubscriber(varint(0n));
      sub.handleSubscribeOk(varint(1n));
    });

    it('defaults to ACTIVE (forward=1)', () => {
      expect(sub.forwardState).toBe(ForwardState.ACTIVE);
    });

    it('can be paused via REQUEST_UPDATE', () => {
      sub.updateForwardState(ForwardState.PAUSED);

      expect(sub.forwardState).toBe(ForwardState.PAUSED);
    });

    it('can be resumed via REQUEST_UPDATE', () => {
      sub.updateForwardState(ForwardState.PAUSED);
      sub.updateForwardState(ForwardState.ACTIVE);

      expect(sub.forwardState).toBe(ForwardState.ACTIVE);
    });

    it('cannot update forward state in PENDING', () => {
      const pending = SubscriptionStateMachine.createAsSubscriber(varint(2n));

      expect(() => pending.updateForwardState(ForwardState.PAUSED)).toThrow();
    });

    it('cannot update forward state in TERMINATED', () => {
      sub.handlePublishDone(varint(0n), '');

      expect(() => sub.updateForwardState(ForwardState.PAUSED)).toThrow();
    });
  });

  describe('duplicate subscription detection', () => {
    it('tracks track namespace and name', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
      const trackName = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]); // "video"

      const sub = SubscriptionStateMachine.createAsSubscriber(
        varint(0n),
        namespace,
        trackName,
      );

      expect(sub.trackNamespace).toEqual(namespace);
      expect(sub.trackName).toEqual(trackName);
    });

    it('generates consistent track key for duplicate detection', () => {
      const namespace = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const trackName = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const sub1 = SubscriptionStateMachine.createAsSubscriber(varint(0n), namespace, trackName);
      const sub2 = SubscriptionStateMachine.createAsSubscriber(varint(2n), namespace, trackName);

      expect(sub1.trackKey).toBe(sub2.trackKey);
    });

    it('different tracks have different keys', () => {
      const ns1 = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];
      const ns2 = [new Uint8Array([0x76, 0x6f, 0x64])]; // "vod"
      const name = new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f]);

      const sub1 = SubscriptionStateMachine.createAsSubscriber(varint(0n), ns1, name);
      const sub2 = SubscriptionStateMachine.createAsSubscriber(varint(2n), ns2, name);

      expect(sub1.trackKey).not.toBe(sub2.trackKey);
    });
  });

  describe('largest location tracking', () => {
    let sub: SubscriptionStateMachine;

    beforeEach(() => {
      sub = SubscriptionStateMachine.createAsSubscriber(varint(0n));
      sub.handleSubscribeOk(varint(1n));
    });

    it('starts with no largest location', () => {
      expect(sub.largestLocation).toBeUndefined();
    });

    it('updates largest location on object delivery', () => {
      sub.updateLargestLocation(varint(5n), varint(10n));

      expect(sub.largestLocation).toEqual({ groupId: 5n, objectId: 10n });
    });

    it('only updates if location is larger', () => {
      sub.updateLargestLocation(varint(5n), varint(10n));
      sub.updateLargestLocation(varint(5n), varint(5n)); // Same group, smaller object
      sub.updateLargestLocation(varint(4n), varint(100n)); // Smaller group

      expect(sub.largestLocation).toEqual({ groupId: 5n, objectId: 10n });
    });

    it('updates for larger group even with smaller object ID', () => {
      sub.updateLargestLocation(varint(5n), varint(10n));
      sub.updateLargestLocation(varint(6n), varint(0n)); // Larger group, smaller object

      expect(sub.largestLocation).toEqual({ groupId: 6n, objectId: 0n });
    });
  });

  describe('state queries', () => {
    it('isActive returns true only in ESTABLISHED with ACTIVE forward', () => {
      const sub = SubscriptionStateMachine.createAsSubscriber(varint(0n));

      expect(sub.isActive).toBe(false); // PENDING

      sub.handleSubscribeOk(varint(1n));
      expect(sub.isActive).toBe(true); // ESTABLISHED + ACTIVE

      sub.updateForwardState(ForwardState.PAUSED);
      expect(sub.isActive).toBe(false); // ESTABLISHED + PAUSED

      sub.updateForwardState(ForwardState.ACTIVE);
      sub.handlePublishDone(varint(0n), '');
      expect(sub.isActive).toBe(false); // TERMINATED
    });

    it('isPending returns true only in PENDING state', () => {
      const sub = SubscriptionStateMachine.createAsSubscriber(varint(0n));

      expect(sub.isPending).toBe(true);

      sub.handleSubscribeOk(varint(1n));
      expect(sub.isPending).toBe(false);
    });

    it('isTerminated returns true only in TERMINATED state', () => {
      const sub = SubscriptionStateMachine.createAsSubscriber(varint(0n));

      expect(sub.isTerminated).toBe(false);

      sub.handleRequestError(varint(0n), '');
      expect(sub.isTerminated).toBe(true);
    });
  });

  // ─── Stream Count (§9.15 PUBLISH_DONE) ──────────────────────────────

  describe('streamCount (§9.15)', () => {
    it('starts at 0', () => {
      const sub = SubscriptionStateMachine.createAsPublisher(varint(0n));
      expect(sub.streamCount).toBe(varint(0n));
    });

    it('increments correctly', () => {
      const sub = SubscriptionStateMachine.createAsPublisher(varint(0n));
      sub.incrementStreamCount();
      expect(sub.streamCount).toBe(varint(1n));
      sub.incrementStreamCount();
      expect(sub.streamCount).toBe(varint(2n));
      sub.incrementStreamCount();
      expect(sub.streamCount).toBe(varint(3n));
    });

    it('works for subscriber-side too', () => {
      const sub = SubscriptionStateMachine.createAsSubscriber(varint(0n));
      expect(sub.streamCount).toBe(varint(0n));
      sub.incrementStreamCount();
      expect(sub.streamCount).toBe(varint(1n));
    });
  });
});
