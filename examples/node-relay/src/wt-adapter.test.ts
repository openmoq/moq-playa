import { describe, expect, it, vi } from 'vitest';
import { nodeSessionToWebTransportLike, type NodeWebTransportSession } from './wt-adapter.js';

function fixture() {
  const closed = Promise.resolve({ closeCode: 0, reason: 'closed' });
  const datagrams = { readable: new ReadableStream<Uint8Array>() };
  const incomingUni = new ReadableStream<unknown>();
  const incomingBidi = new ReadableStream<unknown>();
  const writable = new WritableStream<Uint8Array>();
  const bidi = { readable: new ReadableStream<Uint8Array>(), writable };
  const close = vi.fn();
  const session: NodeWebTransportSession = {
    closed, datagrams,
    incomingUnidirectionalStreams: incomingUni,
    incomingBidirectionalStreams: incomingBidi,
    createBidirectionalStream: async () => bidi,
    createUnidirectionalStream: async () => writable,
    close,
  };
  return { session, binding: nodeSessionToWebTransportLike(session), bidi, writable, close };
}

function writer(abort: (reason: unknown) => Promise<void>): WritableStreamDefaultWriter<Uint8Array> {
  return {
    abort, close: async () => undefined, write: async () => undefined,
    releaseLock() {}, closed: Promise.resolve(), ready: Promise.resolve(), desiredSize: 1,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('Node WebTransport pending-FIN reset binding', () => {
  it('exposes the reset hook and preserves one fulfilled abort without requiring FIN', async () => {
    const { binding, close } = fixture();
    const reason = new Error('reset');
    const abort = vi.fn(async (_reason: unknown) => undefined);
    expect(binding.resetSendStream).toBeTypeOf('function');
    await binding.resetSendStream!(writer(abort), reason);
    expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
    expect(close).not.toHaveBeenCalled();
    // Fulfilled abort can be an already-terminal Streams no-op, not a reset witness.
  });

  it('waits for the same-reason FIN rejection before normalizing the abort rejection', async () => {
    const { binding, close } = fixture();
    const reason = new Error('reset');
    const fin = deferred();
    const abort = vi.fn((_reason: unknown) => Promise.reject(reason));
    let settled = false;
    const result = binding.resetSendStream!(writer(abort), reason, fin.promise);
    void result.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
    fin.reject(reason);
    await result;
    expect(settled).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it.each(['no-fin', 'different-abort', 'fulfilled-fin', 'different-fin', 'wrapped-reset', 'session-failure'] as const)(
    'preserves abort failure identity for %s', async mode => {
      const { binding, close } = fixture();
      const reason = new Error('reset');
      const failure = mode === 'different-abort' ? new Error('reset')
        : mode === 'wrapped-reset' ? new Error('reset not confirmed', { cause: reason })
        : mode === 'session-failure' ? new Error('Session closed') : reason;
      const fin = mode === 'no-fin' ? undefined : mode === 'fulfilled-fin' ? Promise.resolve()
        : Promise.reject(mode === 'different-fin' ? new Error('reset') : reason);
      void fin?.catch(() => undefined);
      const abort = vi.fn((_reason: unknown) => Promise.reject(failure));
      await expect(binding.resetSendStream!(writer(abort), reason, fin)).rejects.toBe(failure);
      expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
      expect(close).not.toHaveBeenCalled();
    },
  );

  it('does not settle while FIN remains pending', async () => {
    const { binding } = fixture();
    const reason = new Error('reset');
    const fin = deferred();
    const abort = vi.fn((_reason: unknown) => Promise.reject(reason));
    let outcome = 'pending';
    void binding.resetSendStream!(writer(abort), reason, fin.promise).then(
      () => { outcome = 'fulfilled'; }, () => { outcome = 'rejected'; },
    );
    await flush();
    expect(abort).toHaveBeenCalledExactlyOnceWith(reason);
    expect(outcome).toBe('pending');
  });

  it('passes streams, live getters, closed and close arguments through unchanged', async () => {
    const { session, binding, bidi, writable, close } = fixture();
    expect(binding.closed).toBe(session.closed);
    expect(binding.datagrams).toBe(session.datagrams);
    expect(binding.incomingUnidirectionalStreams).toBe(session.incomingUnidirectionalStreams);
    expect(binding.incomingBidirectionalStreams).toBe(session.incomingBidirectionalStreams);
    expect(await binding.createBidirectionalStream!()).toBe(bidi);
    expect(await binding.createUnidirectionalStream!()).toBe(writable);
    const replacement = Promise.resolve({ closeCode: 7, reason: 'replacement' });
    Object.defineProperty(session, 'closed', { get: () => replacement });
    expect(binding.closed).toBe(replacement);
    const info = { closeCode: 3, reason: 'stop' };
    binding.close(info);
    expect(close).toHaveBeenCalledExactlyOnceWith(info);
  });
});
