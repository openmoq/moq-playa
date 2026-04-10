/**
 * Tests for player-wiring.ts — adapter callback wiring.
 *
 * @see draft-ietf-moq-transport-16 §3.2 (Control stream)
 * @see draft-ietf-moq-transport-16 §10.3 (Datagrams)
 * @see draft-ietf-moq-transport-16 §10.4 (Stream lifecycle)
 * @see draft-ietf-moq-transport-16 §10.4.4 (Fetch streams)
 * @see draft-ietf-moq-transport-16 §6.1 (Namespace discovery)
 * @module
 */

import { describe, it, expect, vi } from 'vitest';
import { varint } from '@moqt/transport';
import type { ObjectDatagram, DataStreamHeader, ControlMessage } from '@moqt/transport';
import {
  wireConnectionCallbacks,
  type ConnectionHandlers,
} from './player-wiring.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function createMockAdapter() {
  return {
    onMessage: null as any,
    onClose: null as any,
    onError: null as any,
    onObject: null as any,
    onStreamClosed: null as any,
    onDataStream: null as any,
    onNamespaceMessage: null as any,
    onDatagram: null as any,
    onQlogEvent: undefined as any,
  };
}

function createHandlers(overrides: Partial<ConnectionHandlers> = {}): ConnectionHandlers {
  return {
    onControlMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    onObject: vi.fn(),
    onStreamClosed: vi.fn(),
    onDataStream: vi.fn(),
    onNamespaceMessage: vi.fn(),
    onDatagram: vi.fn(),
    ...overrides,
  };
}

// ─── wireConnectionCallbacks ───────────────────────────────────────────

describe('wireConnectionCallbacks', () => {
  it('sets onMessage handler for control messages (§3.2)', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    const msg = { type: 'GOAWAY', newSessionUri: 'x' } as ControlMessage;
    adapter.onMessage(msg);
    expect(handlers.onControlMessage).toHaveBeenCalledWith(msg);
  });

  it('sets onClose handler', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    adapter.onClose(0x1, 'session ending');
    expect(handlers.onClose).toHaveBeenCalledWith(0x1, 'session ending');
  });

  it('sets onError handler', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    const err = new Error('connection lost');
    adapter.onError(err);
    expect(handlers.onError).toHaveBeenCalledWith(err);
  });

  it('routes objects to onObject handler (§10.2)', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    const obj = { kind: 'data', trackAlias: varint(1n) } as any;
    adapter.onObject(5n, obj);
    expect(handlers.onObject).toHaveBeenCalledWith(5n, obj);
  });

  it('routes stream close to onStreamClosed (§10.4)', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    adapter.onStreamClosed(10n, 0x1);
    expect(handlers.onStreamClosed).toHaveBeenCalledWith(10n, 0x1);
  });

  it('routes data stream headers to onDataStream (§10.4.4)', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    const header = { type: 'fetch', header: { requestId: varint(1n) } } as any;
    adapter.onDataStream(3n, header);
    expect(handlers.onDataStream).toHaveBeenCalledWith(3n, header);
  });

  it('routes namespace messages (§6.1)', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    const msg = { type: 'NAMESPACE', trackNamespaceSuffix: [] } as any;
    adapter.onNamespaceMessage(7n, msg);
    expect(handlers.onNamespaceMessage).toHaveBeenCalledWith(7n, msg);
  });

  it('routes datagrams to onDatagram (§10.3)', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    const dg = { trackAlias: varint(1n), groupId: varint(0n), objectId: varint(0n), payload: new Uint8Array(10) } as ObjectDatagram;
    adapter.onDatagram(dg);
    expect(handlers.onDatagram).toHaveBeenCalledWith(dg);
  });

  it('sets onQlogEvent when provided', () => {
    const adapter = createMockAdapter();
    const qlogFn = vi.fn();
    const handlers = createHandlers({ onQlogEvent: qlogFn });
    wireConnectionCallbacks(adapter as any, handlers);

    expect(adapter.onQlogEvent).toBe(qlogFn);
  });

  it('does not set onQlogEvent when not provided', () => {
    const adapter = createMockAdapter();
    const handlers = createHandlers();
    wireConnectionCallbacks(adapter as any, handlers);

    expect(adapter.onQlogEvent).toBeUndefined();
  });
});
