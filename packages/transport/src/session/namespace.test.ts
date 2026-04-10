/**
 * Namespace discovery state machine tests.
 * @see draft-ietf-moq-transport-16 §6.1
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NamespaceStateMachine } from './namespace.js';
import { NamespaceState } from './types.js';
import { varint } from '../primitives/varint.js';

describe('NamespaceStateMachine', () => {
  describe('subscriber side (outgoing SUBSCRIBE_NAMESPACE)', () => {
    let ns: NamespaceStateMachine;
    const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"

    beforeEach(() => {
      ns = NamespaceStateMachine.createAsSubscriber(varint(0n), prefix);
    });

    it('starts in PENDING state', () => {
      expect(ns.state).toBe(NamespaceState.PENDING);
      expect(ns.requestId).toBe(0n);
    });

    it('stores namespace prefix', () => {
      expect(ns.namespacePrefix).toEqual(prefix);
    });

    it('transitions to ACTIVE on REQUEST_OK', () => {
      ns.handleRequestOk();

      expect(ns.state).toBe(NamespaceState.ACTIVE);
    });

    it('transitions to TERMINATED on REQUEST_ERROR', () => {
      ns.handleRequestError(varint(0x10n), 'Namespace not found');

      expect(ns.state).toBe(NamespaceState.TERMINATED);
      expect(ns.errorCode).toBe(0x10n);
      expect(ns.errorReason).toBe('Namespace not found');
    });

    it('transitions to TERMINATED on NAMESPACE_DONE', () => {
      ns.handleRequestOk();
      ns.handleNamespaceDone();

      expect(ns.state).toBe(NamespaceState.TERMINATED);
    });

    it('tracks discovered namespaces', () => {
      ns.handleRequestOk();

      const suffix1 = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])]; // "video"
      const suffix2 = [new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f])]; // "audio"

      ns.handleNamespace(suffix1);
      ns.handleNamespace(suffix2);

      expect(ns.discoveredNamespaces.length).toBe(2);
      expect(ns.discoveredNamespaces[0]).toEqual(suffix1);
      expect(ns.discoveredNamespaces[1]).toEqual(suffix2);
    });

    it('cannot receive REQUEST_OK after already active', () => {
      ns.handleRequestOk();

      expect(() => ns.handleRequestOk()).toThrow();
    });

    it('cannot receive NAMESPACE in PENDING state', () => {
      const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])];

      expect(() => ns.handleNamespace(suffix)).toThrow();
    });

    it('cannot receive NAMESPACE_DONE in PENDING state', () => {
      expect(() => ns.handleNamespaceDone()).toThrow();
    });
  });

  describe('publisher side (incoming SUBSCRIBE_NAMESPACE)', () => {
    let ns: NamespaceStateMachine;
    const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];

    beforeEach(() => {
      ns = NamespaceStateMachine.createAsPublisher(varint(1n), prefix);
    });

    it('starts in PENDING state', () => {
      expect(ns.state).toBe(NamespaceState.PENDING);
    });

    it('transitions to ACTIVE on sending REQUEST_OK', () => {
      ns.sendRequestOk();

      expect(ns.state).toBe(NamespaceState.ACTIVE);
    });

    it('transitions to TERMINATED on sending REQUEST_ERROR', () => {
      ns.sendRequestError(varint(0x1n), 'Unauthorized');

      expect(ns.state).toBe(NamespaceState.TERMINATED);
    });

    it('sends NAMESPACE messages in ACTIVE state', () => {
      ns.sendRequestOk();

      const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])];
      expect(() => ns.sendNamespace(suffix)).not.toThrow();
    });

    it('transitions to TERMINATED on sending NAMESPACE_DONE', () => {
      ns.sendRequestOk();
      ns.sendNamespaceDone();

      expect(ns.state).toBe(NamespaceState.TERMINATED);
    });

    it('cannot send NAMESPACE in PENDING state', () => {
      const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])];

      expect(() => ns.sendNamespace(suffix)).toThrow();
    });

    it('cannot send NAMESPACE_DONE in PENDING state', () => {
      expect(() => ns.sendNamespaceDone()).toThrow();
    });
  });

  describe('role enforcement', () => {
    it('subscriber cannot send REQUEST_OK', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      expect(() => ns.sendRequestOk()).toThrow();
    });

    it('subscriber cannot send REQUEST_ERROR', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      expect(() => ns.sendRequestError(varint(0n), '')).toThrow();
    });

    it('subscriber cannot send NAMESPACE', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      ns.handleRequestOk();
      expect(() => ns.sendNamespace([])).toThrow();
    });

    it('subscriber cannot send NAMESPACE_DONE', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      ns.handleRequestOk();
      expect(() => ns.sendNamespaceDone()).toThrow();
    });

    it('publisher cannot handle REQUEST_OK', () => {
      const ns = NamespaceStateMachine.createAsPublisher(varint(1n), []);
      expect(() => ns.handleRequestOk()).toThrow();
    });

    it('publisher cannot handle REQUEST_ERROR', () => {
      const ns = NamespaceStateMachine.createAsPublisher(varint(1n), []);
      expect(() => ns.handleRequestError(varint(0n), '')).toThrow();
    });

    it('publisher cannot handle NAMESPACE', () => {
      const ns = NamespaceStateMachine.createAsPublisher(varint(1n), []);
      ns.sendRequestOk();
      expect(() => ns.handleNamespace([])).toThrow();
    });

    it('publisher cannot handle NAMESPACE_DONE', () => {
      const ns = NamespaceStateMachine.createAsPublisher(varint(1n), []);
      ns.sendRequestOk();
      expect(() => ns.handleNamespaceDone()).toThrow();
    });
  });

  describe('state queries', () => {
    it('isPending returns true only in PENDING state', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);

      expect(ns.isPending).toBe(true);

      ns.handleRequestOk();
      expect(ns.isPending).toBe(false);
    });

    it('isActive returns true only in ACTIVE state', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);

      expect(ns.isActive).toBe(false);

      ns.handleRequestOk();
      expect(ns.isActive).toBe(true);

      ns.handleNamespaceDone();
      expect(ns.isActive).toBe(false);
    });

    it('isTerminated returns true only in TERMINATED state', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);

      expect(ns.isTerminated).toBe(false);

      ns.handleRequestError(varint(0n), '');
      expect(ns.isTerminated).toBe(true);
    });

    it('isPublisher returns role correctly', () => {
      const subscriber = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      const publisher = NamespaceStateMachine.createAsPublisher(varint(1n), []);

      expect(subscriber.isPublisher).toBe(false);
      expect(publisher.isPublisher).toBe(true);
    });
  });

  describe('namespace prefix validation', () => {
    it('validates namespace suffix against prefix', () => {
      const prefix = [
        new Uint8Array([0x6c, 0x69, 0x76, 0x65]), // "live"
      ];
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), prefix);
      ns.handleRequestOk();

      // Valid suffix extends the prefix
      const validSuffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])]; // "video"
      expect(() => ns.handleNamespace(validSuffix)).not.toThrow();

      expect(ns.discoveredNamespaces.length).toBe(1);
    });
  });

  describe('withdrawNamespace (draft-14 per-namespace withdrawal)', () => {
    /**
     * draft-ietf-moq-transport-14 §9.26: PUBLISH_NAMESPACE_DONE "withdraws a
     * previous PUBLISH_NAMESPACE" but does NOT terminate the subscription.
     * The subscription stays ACTIVE — new PUBLISH_NAMESPACE messages can arrive.
     */

    it('removes a previously discovered namespace, stays ACTIVE', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      ns.handleRequestOk();

      const suffix1 = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])]; // "video"
      const suffix2 = [new Uint8Array([0x61, 0x75, 0x64, 0x69, 0x6f])]; // "audio"
      ns.handleNamespace(suffix1);
      ns.handleNamespace(suffix2);

      ns.withdrawNamespace(suffix1);

      expect(ns.state).toBe(NamespaceState.ACTIVE); // NOT terminated
      expect(ns.discoveredNamespaces.length).toBe(1);
      expect(ns.discoveredNamespaces[0]).toEqual(suffix2);
    });

    it('no-ops if namespace not found (not a protocol error)', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      ns.handleRequestOk();

      const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])];
      // Withdraw something never discovered — spec says "it is not a protocol
      // error for the subscriber to send a SUBSCRIBE or FETCH message for a
      // track in a namespace after receiving a PUBLISH_NAMESPACE_DONE"
      expect(() => ns.withdrawNamespace(suffix)).not.toThrow();
      expect(ns.state).toBe(NamespaceState.ACTIVE);
    });

    it('throws if not in ACTIVE state', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])];

      // PENDING state
      expect(() => ns.withdrawNamespace(suffix)).toThrow();
    });

    it('hasDiscoveredSuffix returns false after withdrawal', () => {
      const ns = NamespaceStateMachine.createAsSubscriber(varint(0n), []);
      ns.handleRequestOk();

      const suffix = [new Uint8Array([0x76, 0x69, 0x64, 0x65, 0x6f])];
      ns.handleNamespace(suffix);
      expect(ns.hasDiscoveredSuffix(suffix)).toBe(true);

      ns.withdrawNamespace(suffix);
      expect(ns.hasDiscoveredSuffix(suffix)).toBe(false);
    });
  });

  describe('namespace key generation', () => {
    it('generates unique key for namespace prefix', () => {
      const prefix1 = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])]; // "live"
      const prefix2 = [new Uint8Array([0x76, 0x6f, 0x64])]; // "vod"

      const ns1 = NamespaceStateMachine.createAsSubscriber(varint(0n), prefix1);
      const ns2 = NamespaceStateMachine.createAsSubscriber(varint(2n), prefix2);

      expect(ns1.prefixKey).not.toBe(ns2.prefixKey);
    });

    it('generates consistent key for same prefix', () => {
      const prefix = [new Uint8Array([0x6c, 0x69, 0x76, 0x65])];

      const ns1 = NamespaceStateMachine.createAsSubscriber(varint(0n), prefix);
      const ns2 = NamespaceStateMachine.createAsSubscriber(varint(2n), prefix);

      expect(ns1.prefixKey).toBe(ns2.prefixKey);
    });
  });
});
