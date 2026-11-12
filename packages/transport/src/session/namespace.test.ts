/**
 * Namespace discovery state machine tests.
 * @see draft-ietf-moq-transport-16 §6.1
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NamespaceStateMachine } from './namespace.js';
import { NamespaceState } from './types.js';
import { MoqtConnection } from '../../../webtransport/src/adapter.js';
import { connectedPair } from '../../../webtransport/src/testkit/pair.js';
import { createLoopback, flush } from '../../../webtransport/src/testkit/loopback.js';
import { createControlCodec } from '../control/codec.js';
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

    it('terminates on local subscriber teardown', () => {
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

    it('terminates on local publisher teardown', () => {
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

// d16 serving is unsupported by the SDK: inject peer bytes into its real reader.
// d18/d22 use two real SDK endpoints for announcements and withdrawals.
async function namespacePeer(draft: 16 | 18 | 22) {
  const codec = createControlCodec(draft), suffix = [new TextEncoder().encode('x')];
  if (draft === 16) {
    const { a } = createLoopback(), client = new MoqtConnection(16);
    const connecting = client.connect(a); await flush(64);
    a.bidiOut[0]!.in.injectRead(codec.encode({ type: 'SERVER_SETUP',
      parameters: new Map([[varint(2), [varint(100)]]]) }));
    await connecting;
    const id = await client.subscribeNamespace([new TextEncoder().encode('live')]);
    const stream = a.bidiOut[1]!;
    stream.in.injectRead(codec.encode({ type: 'REQUEST_OK', requestId: varint(id), parameters: new Map() }));
    await flush(64);
    return { client, id, suffix, transport: a,
      async send(type: 'NAMESPACE' | 'NAMESPACE_DONE', value = suffix) {
        stream.in.injectRead(codec.encode({ type, trackNamespaceSuffix: value })); await flush(64);
      },
      async close() { await client.close(); },
    };
  }
  const { client, server, a } = await connectedPair(draft);
  let incoming: bigint | undefined;
  server.onSubscribeNamespace = id => { incoming = id; };
  const id = await client.subscribeNamespace([new TextEncoder().encode('live')]); await flush(64);
  expect(incoming).toBe(id);
  await server.acceptSubscribeNamespace(id); await flush(64);
  return { client, id, suffix, transport: a,
    async send(type: 'NAMESPACE' | 'NAMESPACE_DONE', value = suffix) {
      if (type === 'NAMESPACE') await server.sendNamespace(id, value);
      else await server.sendNamespaceDone(id, value);
      await flush(64);
    },
    async close() { await client.close(); await server.close(); },
  };
}

describe.each([16, 18, 22] as const)('namespace withdrawal draft%i', draft => {
  it('delivers two publisher restarts on one active subscription and still cancels', async () => {
    const f = await namespacePeer(draft), seen: string[] = [];
    f.client.onNamespaceMessage = (id, msg) => {
      expect(id).toBe(f.id);
      if (msg.type === 'NAMESPACE' || msg.type === 'NAMESPACE_DONE') seen.push(msg.type);
    };
    try {
      const other = [new TextEncoder().encode('y')];
      await f.send('NAMESPACE', other);
      await f.send('NAMESPACE');
      expect(f.client.session.getNamespaceSubscription(f.id)?.discoveredNamespaces).toEqual([other, f.suffix]);
      for (let restart = 0; restart < 2; restart++) {
        await f.send('NAMESPACE_DONE');
        const subscription = f.client.session.getNamespaceSubscription(f.id);
        expect(subscription?.state).toBe('active');
        expect(subscription?.discoveredNamespaces).toEqual([other]);
        await f.send('NAMESPACE');
        expect(subscription?.discoveredNamespaces).toEqual([other, f.suffix]);
      }
      expect(seen).toEqual(['NAMESPACE', 'NAMESPACE', 'NAMESPACE_DONE', 'NAMESPACE', 'NAMESPACE_DONE', 'NAMESPACE']);
      expect(f.client.session.state).toBe('established');
      await expect(f.client.cancelNamespace(f.id)).resolves.toBeUndefined(); await flush(64);
      expect(f.transport.bidiOut.at(-1)!.out.writeClosed).toBe(true);
      expect(f.client.session.state).toBe('established');
    } finally { await f.close(); }
  });

  it('rejects a repeated DONE as well as a DONE before any announcement', async () => {
    // Healthy control first: an unknown suffix already violates the protocol.
    for (const announced of [false, true]) {
      const f = await namespacePeer(draft);
      try {
        if (announced) { await f.send('NAMESPACE'); await f.send('NAMESPACE_DONE'); }
        await f.send('NAMESPACE_DONE');
        expect(f.transport.closeInfo?.closeCode).toBe(0x3);
        expect(f.client.session.state).toBe('closed');
      } finally { await f.close(); }
    }
  });
});

describe.each([16, 18, 22] as const)('namespace stream retirement draft%i', draft => {
  it('retires discovery after withdrawal on FIN, cancellation and reset', async () => {
    for (const ending of ['fin', 'cancel', 'reset'] as const) {
      const f = await namespacePeer(draft);
      try {
        await f.send('NAMESPACE'); await f.send('NAMESPACE_DONE');
        expect(f.client.session.getNamespaceSubscription(f.id)?.state).toBe('active');
        const pipe = f.transport.bidiOut.at(-1)!.in;
        if (ending === 'cancel') await f.client.cancelNamespace(f.id);
        else if (ending === 'reset') pipe.reset();
        else if (draft === 16) await pipe.writable.getWriter().close();
        else {
          // The real server owns the response writer: end its next delivery with FIN.
          pipe.faults.finAfterBytes = 0;
          await f.send('NAMESPACE');
        }
        await flush(256);
        expect.soft(f.client.session.getNamespaceSubscription(f.id)?.isActive ?? false, ending).toBe(false);
        expect(f.client.session.state).toBe('established');
      } finally { await f.close(); }
    }
  });
});

describe.each(['NAMESPACE', 'NAMESPACE_DONE'] as const)('draft16 cancellation with late %s', late => {
  it('stops the receive side and ignores a message in flight, while active discovery still delivers', async () => {
    for (const cancel of [false, true]) {
      const f = await namespacePeer(16), seen: string[] = [], errors: Error[] = [];
      f.client.onError = error => { errors.push(error); };
      try {
        await f.send('NAMESPACE');
        f.client.onNamespaceMessage = (_id, msg) => { seen.push(msg.type); };
        if (cancel) await f.client.cancelNamespace(f.id);
        await f.send(late, late === 'NAMESPACE' ? [new TextEncoder().encode('y')] : f.suffix);
        expect(f.client.session.state).toBe('established');
        expect(f.transport.closeInfo).toBeUndefined();
        expect(errors).toEqual([]);
        expect(seen).toEqual(cancel ? [] : [late]);
        expect(f.transport.bidiOut[1]!.in.readCancelled).toBe(cancel);
        expect(f.client.session.getNamespaceSubscription(f.id)?.isActive ?? false).toBe(!cancel);
      } finally { await f.close(); }
    }
  });
});

it('draft16 cancellation suppresses remaining messages already parsed from the same read', async () => {
  const f = await namespacePeer(16), codec = createControlCodec(16), seen: string[] = [];
  let cancelled: Promise<void> | undefined;
  try {
    f.client.onNamespaceMessage = (_id, msg) => {
      seen.push(msg.type);
      cancelled ??= f.client.cancelNamespace(f.id);
    };
    const announce = codec.encode({ type: 'NAMESPACE', trackNamespaceSuffix: f.suffix });
    const withdraw = codec.encode({ type: 'NAMESPACE_DONE', trackNamespaceSuffix: f.suffix });
    f.transport.bidiOut[1]!.in.injectRead(new Uint8Array([...announce, ...withdraw]));
    await flush(128); await cancelled; await flush(64);
    expect(seen).toEqual(['NAMESPACE']);
    expect(f.client.session.state).toBe('established');
    expect(f.client.session.getNamespaceSubscription(f.id)).toBeUndefined();
    expect(f.transport.bidiOut[1]!.in.readCancelled).toBe(true);
  } finally { await f.close(); }
});
