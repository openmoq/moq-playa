import { expect, it, vi } from 'vitest';
import { SessionState, varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import type { WebTransportLike } from './types.js';
import { flush } from './testkit/loopback.js';

async function active(draft: 14 | 16 | 18 | 22 = 18) {
  const f = await connectedPair(draft);
  // The modeled binding owns the loopback's coded error representation.
  const transport: WebTransportLike = f.b;
  transport.createStreamError = (code, cause) => Object.assign(new Error('loopback reset', { cause }), { streamErrorCode: code });
  f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 7n); };
  const sub = await f.client.subscribeTrack(ns('reset'), nm('track'));
  await flush(64);
  const terminals: string[] = [];
  const received: Array<readonly [bigint, bigint]> = [];
  f.client.onStreamClosed = (_id, _error, terminal) => terminals.push(terminal);
  sub.onObject = object => { if (object.kind === 'data') received.push([object.groupId, object.objectId]); };
  const cleanup = async () => { await Promise.all([f.client.close(), f.server.close()]); await flush(32); };
  return { ...f, sub, terminals, received, cleanup };
}

it.each([14, 16, 18, 22] as const)('draft%s reset retires exactly one stream, joins close/reset and retains truthful accounting', async draft => {
  const f = await active(draft);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    expect(typeof f.server.resetSubgroup).toBe('function');
    const first = await f.server.openSubgroup(7n, 1n, 0n);
    const sibling = await f.server.openSubgroup(7n, 2n, 0n);
    await f.server.sendObject(first, 0n, Uint8Array.of(1));
    await f.server.sendObject(sibling, 0n, Uint8Array.of(2)); await flush(64);
    const reset = vi.fn(async (writer: WritableStreamDefaultWriter<Uint8Array>, reason: unknown) => {
      await gate; await writer.abort(reason);
    });
    Object.assign(f.b, { resetSendStream: reset });
    const outcome: string[] = [];
    const a = f.server.resetSubgroup(first).then(() => { outcome.push('reset'); });
    const b = f.server.resetSubgroup(first).then(() => { outcome.push('joined reset'); });
    const c = f.server.closeSubgroup(first).then(() => { outcome.push('joined close'); });
    await expect(f.server.sendObject(first, 1n, Uint8Array.of(3))).rejects.toThrow();
    await f.server.sendObject(sibling, 1n, Uint8Array.of(4));
    await f.server.closeSubgroup(sibling);
    await expect(f.server.publishDone(f.sub.requestId, varint(0n), 'done')).rejects.toThrow(/open/);
    await flush(64); expect(outcome).toEqual([]); expect(reset).toHaveBeenCalledTimes(1);
    release(); await Promise.all([a, b, c]); await flush(64);
    expect(f.terminals.sort()).toEqual(['fin', 'reset']);
    expect(f.received).toEqual([[1n, 0n], [2n, 0n], [2n, 1n]]);
    expect(f.server.session.getIncomingSubscription(f.sub.requestId)?.streamCount).toBe(2n);
    await f.server.publishDone(f.sub.requestId, varint(0n), 'done');
    expect(f.errors).toEqual([]);
  } finally { release(); await f.cleanup(); }
});

it('pending FIN reset uses backend proof and concurrent close joins the reset outcome', async () => {
  const f = await active();
  try {
    expect(typeof f.server.resetSubgroup).toBe('function');
    let rejectFin!: (error: unknown) => void;
    f.b.createUnidirectionalStream = async () => new WritableStream<Uint8Array>({
      start(controller) { controller.signal.addEventListener('abort', () => { rejectFin(controller.signal.reason); }); },
      close: () => new Promise<void>((_resolve, reject) => { rejectFin = reject; }),
    });
    const id = await f.server.openSubgroup(7n, 1n, 0n);
    const fin = f.server.closeSubgroup(id); const finOutcome = fin.catch(error => error);
    await flush(32);
    const reset = vi.fn(async (writer: WritableStreamDefaultWriter<Uint8Array>, reason: unknown, pendingFin?: Promise<void>) => {
      expect(pendingFin).toBeDefined();
      try { await writer.abort(reason); }
      catch (error) {
        if (error !== reason || !pendingFin || !await pendingFin.then(() => false, failure => failure === reason)) throw error;
      }
    });
    Object.assign(f.b, { resetSendStream: reset });
    await Promise.all([f.server.resetSubgroup(id), f.server.closeSubgroup(id)]);
    expect(await finOutcome).toBeInstanceOf(Error); expect(reset).toHaveBeenCalledTimes(1);
    expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
    await f.server.publishDone(f.sub.requestId, varint(0n), 'done');
  } finally { await f.cleanup(); }
});

it.each(['throw', 'reject', 'hang'] as const)('unproven single-stream reset fails closed (%s)', async mode => {
  const f = await active();
  try {
    expect(typeof f.server.resetSubgroup).toBe('function');
    const id = await f.server.openSubgroup(7n, 1n, 0n);
    const reset = vi.fn(() => {
      if (mode === 'throw') throw new Error('failed reset');
      return mode === 'reject' ? Promise.reject(new Error('failed reset')) : new Promise<void>(() => {});
    });
    Object.assign(f.b, { resetSendStream: reset }); vi.useFakeTimers();
    const result = f.server.resetSubgroup(id).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(1000); await flush(32);
    expect(await result).toBeInstanceOf(Error);
    expect(f.server.session.state).not.toBe(SessionState.ESTABLISHED);
    expect(reset).toHaveBeenCalledTimes(1); expect(f.terminals).not.toContain('fin');
  } finally { vi.useRealTimers(); await f.cleanup(); }
});

it('resetting a returned ID leaves another pending stream open operation owned', async () => {
  const f = await active(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    expect(typeof f.server.resetSubgroup).toBe('function');
    const first = await f.server.openSubgroup(7n, 1n, 0n);
    const create = f.b.createUnidirectionalStream.bind(f.b);
    f.b.createUnidirectionalStream = async () => { const stream = await create(); await gate; return stream; };
    const opening = f.server.openSubgroup(7n, 2n, 0n); await flush(32);
    await f.server.resetSubgroup(first);
    await expect(f.server.publishDone(f.sub.requestId, varint(0n), 'done')).rejects.toThrow(/in-flight/);
    release(); const second = await opening;
    await f.server.sendObject(second, 0n, Uint8Array.of(1)); await f.server.closeSubgroup(second);
    await flush(64); expect(f.received).toEqual([[2n, 0n]]); expect(f.terminals.sort()).toEqual(['fin', 'reset']);
    expect(f.errors).toEqual([]);
  } finally { release(); await f.cleanup(); }
});

it('request cancellation joins an already pending single-stream reset without invoking the backend twice', async () => {
  const f = await active(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const id = await f.server.openSubgroup(7n, 1n, 0n);
    const reset = vi.fn(async (writer: WritableStreamDefaultWriter<Uint8Array>, reason: unknown) => { await gate; await writer.abort(reason); });
    Object.assign(f.b, { resetSendStream: reset });
    const resetting = f.server.resetSubgroup(id);
    await f.client.unsubscribe(f.sub.requestId); await flush(64);
    expect(reset).toHaveBeenCalledTimes(1);
    release(); await resetting; await flush(64);
    expect(reset).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([]);
    expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
  } finally { release(); await f.cleanup(); }
});

it('an in-flight object write stays pending until reset starts, while further sends and FIN are refused', async () => {
  const f = await active(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    let writes = 0, rejectWrite!: (error: unknown) => void;
    f.b.createUnidirectionalStream = async () => new WritableStream<Uint8Array>({
      start(controller) { controller.signal.addEventListener('abort', () => { rejectWrite(controller.signal.reason); }); },
      write: () => ++writes === 1 ? undefined : new Promise<void>((_ok, fail) => { rejectWrite = fail; }),
    });
    const id = await f.server.openSubgroup(7n, 1n, 0n);
    let writeSettled = false;
    const writing = f.server.sendObject(id, 0n, Uint8Array.of(1)).then(() => { writeSettled = true; return null; }, error => { writeSettled = true; return error; });
    await flush(32); expect(writes).toBe(2);
    Object.assign(f.b, { resetSendStream: async (writer: WritableStreamDefaultWriter<Uint8Array>, reason: unknown) => { await gate; await writer.abort(reason); } });
    const resetting = f.server.resetSubgroup(id);
    const closing = f.server.closeSubgroup(id);
    await expect(f.server.sendObject(id, 1n, Uint8Array.of(2))).rejects.toThrow();
    await flush(32); expect(writeSettled).toBe(false); expect(writes).toBe(2);
    release(); await Promise.all([resetting, closing]); expect(await writing).toBeInstanceOf(Error);
    expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
    await f.server.publishDone(f.sub.requestId, varint(0n), 'done');
  } finally { release(); await f.cleanup(); }
});

it('a pending FIN abort rejection without a backend proof is not normalized into reset success', async () => {
  const f = await active();
  try {
    let rejectFin!: (error: unknown) => void;
    f.b.createUnidirectionalStream = async () => new WritableStream<Uint8Array>({
      start(controller) { controller.signal.addEventListener('abort', () => { rejectFin(controller.signal.reason); }); },
      close: () => new Promise<void>((_ok, fail) => { rejectFin = fail; }),
    });
    const id = await f.server.openSubgroup(7n, 1n, 0n);
    const fin = f.server.closeSubgroup(id).catch(error => error); await flush(32);
    await expect(f.server.resetSubgroup(id)).rejects.toThrow(/Could not prove/);
    expect(await fin).toBeInstanceOf(Error);
    expect(f.server.session.state).not.toBe(SessionState.ESTABLISHED);
  } finally { await f.cleanup(); }
});

it('the binding factory owns code and reason identity', async () => {
  const f = await active();
  const transport: WebTransportLike = f.b;
  try {
    const id = await f.server.openSubgroup(7n, 1n, 0n);
    const reason = new Error('binding-owned cancellation');
    const factory = vi.fn(function (this: WebTransportLike, code: number, cause?: unknown) {
      expect(this).toBe(transport); expect(code).toBe(1); expect(cause).toBeInstanceOf(Error);
      return reason;
    });
    transport.createStreamError = factory;
    const reset = vi.fn(async (writer: WritableStreamDefaultWriter<Uint8Array>, received: unknown) => {
      expect(received).toBe(reason); await writer.abort(received);
    });
    transport.resetSendStream = reset;
    const first = f.server.resetSubgroup(id);
    expect(f.server.resetSubgroup(id)).toBe(first);
    await first;
    expect(factory).toHaveBeenCalledOnce(); expect(reset).toHaveBeenCalledOnce();
    expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
  } finally { await f.cleanup(); }
});

it.each(['absent', 'throw'] as const)('unavailable binding error construction rejects without changing ownership (%s)', async mode => {
  const f = await active();
  const transport: WebTransportLike = f.b;
  try {
    const id = await f.server.openSubgroup(7n, 1n, 0n);
    if (mode === 'absent') delete transport.createStreamError;
    else if (mode === 'throw') transport.createStreamError = () => { throw new Error('factory failure'); };
    const reset = vi.fn(async () => {}); transport.resetSendStream = reset;
    await expect(f.server.resetSubgroup(id)).rejects.toThrow();
    expect(reset).not.toHaveBeenCalled();
    expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
    await f.server.sendObject(id, 0n, Uint8Array.of(1));
  } finally { await f.cleanup(); }
});
