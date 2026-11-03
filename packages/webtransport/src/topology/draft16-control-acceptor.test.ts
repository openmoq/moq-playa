import { describe, expect, it } from 'vitest';
import { ProtocolViolationError } from '@openmoq/transport';
import type { WebTransportBidirectionalStream } from '../types.js';
import { LoopPipe, flush } from '../testkit/loopback.js';
import { Draft16ControlAcceptor } from './draft16-control-acceptor.js';

function source() {
  let controller!: ReadableStreamDefaultController<WebTransportBidirectionalStream>;
  let cancelled = 0;
  const stream = new ReadableStream<WebTransportBidirectionalStream>({
    start(value) { controller = value; }, cancel() { cancelled++; },
  });
  return { stream, controller, cancellations: () => cancelled };
}

function bidi() {
  const input = new LoopPipe();
  const output = new LoopPipe();
  return { stream: { readable: input.readable, writable: output.writable }, input, output,
    async send(bytes: number[]) {
      const writer = input.writable.getWriter();
      try { await writer.write(new Uint8Array(bytes)); } finally { writer.releaseLock(); }
    } };
}

describe('draft-16 initial control stream classification', () => {
  it('does not let stalled or namespace streams hide control and preserves coalesced bytes', async () => {
    const incoming = source();
    const stalled = bidi(), namespace = bidi(), control = bidi(), late = bidi();
    const acceptor = new Draft16ControlAcceptor();
    const ready = acceptor.start(incoming.stream);
    incoming.controller.enqueue(stalled.stream);
    incoming.controller.enqueue(namespace.stream);
    await namespace.send([0x11]);
    await control.send([0x20, 0, 2, 0, 0]);
    incoming.controller.enqueue(control.stream);
    incoming.controller.enqueue(late.stream);
    const selected = await ready;
    await flush(50);
    expect(selected.stream).toBe(control.stream);
    expect(selected.prefix).toEqual([new Uint8Array([0x20, 0, 2, 0, 0])]);
    for (const other of [stalled, namespace, late]) expect(other.input.readCancelled).toBe(true);
    expect(incoming.cancellations()).toBe(0);
    expect(incoming.stream.locked).toBe(false);
    await selected.reader.cancel();
    selected.reader.releaseLock();
  });

  it('recognizes a fragmented nonminimal type and hands off the original reader', async () => {
    const incoming = source(), control = bidi();
    const ready = new Draft16ControlAcceptor().start(incoming.stream);
    incoming.controller.enqueue(control.stream);
    for (const byte of [0xc0, 0, 0, 0, 0, 0, 0, 0x20]) await control.send([byte]);
    const selected = await ready;
    expect([...selected.prefix.flatMap(chunk => [...chunk])]).toEqual([0xc0, 0, 0, 0, 0, 0, 0, 0x20]);
    await control.send([0, 2, 0, 0]);
    expect(await selected.reader.read()).toEqual({ done: false, value: new Uint8Array([0, 2, 0, 0]) });
    await selected.reader.cancel();
    selected.reader.releaseLock();
  });

  it('rejects an invalid opener without cancelling the aggregate source', async () => {
    const incoming = source(), invalid = bidi();
    const ready = new Draft16ControlAcceptor().start(incoming.stream);
    const rejected = expect(ready).rejects.toBeInstanceOf(ProtocolViolationError);
    incoming.controller.enqueue(invalid.stream);
    await invalid.send([3]);
    await rejected;
    expect(invalid.input.readCancelled).toBe(true);
    expect(incoming.cancellations()).toBe(0);
    expect(incoming.stream.locked).toBe(false);
  });

  it('retirement wakes setup and releases incomplete classifiers', async () => {
    const incoming = source(), partial = bidi();
    const acceptor = new Draft16ControlAcceptor();
    const reason = new Error('connection closed');
    const ready = acceptor.start(incoming.stream);
    const rejected = expect(ready).rejects.toBe(reason);
    incoming.controller.enqueue(partial.stream);
    await partial.send([0xc0]);
    acceptor.retire(reason);
    await rejected;
    expect(partial.input.readCancelled).toBe(true);
    expect(incoming.cancellations()).toBe(0);
    expect(incoming.stream.locked).toBe(false);
  });

  it('bounds pending classifiers and reports resource exhaustion rather than bad peer syntax', async () => {
    const incoming = source();
    const streams = Array.from({ length: 33 }, () => bidi());
    const ready = new Draft16ControlAcceptor().start(incoming.stream);
    const result = ready.then(() => null, error => error);
    for (const stream of streams) incoming.controller.enqueue(stream.stream);
    const error: unknown = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProtocolViolationError);
    expect(String(error)).toMatch(/capacity/);
    await flush(50);
    for (const stream of streams) expect(stream.input.readCancelled).toBe(true);
    expect(incoming.cancellations()).toBe(0);
    expect(incoming.stream.locked).toBe(false);
  });

  it('allows an early stream reset and still finds control', async () => {
    const incoming = source(), abandoned = bidi(), control = bidi();
    const ready = new Draft16ControlAcceptor().start(incoming.stream);
    incoming.controller.enqueue(abandoned.stream);
    abandoned.input.reset();
    incoming.controller.enqueue(control.stream);
    await control.send([0x20]);
    const selected = await ready;
    expect(selected.stream).toBe(control.stream);
    await selected.reader.cancel();
    selected.reader.releaseLock();
  });

  it('rejects an ended source without a control stream', async () => {
    const incoming = source();
    const ready = new Draft16ControlAcceptor().start(incoming.stream);
    const rejected = expect(ready).rejects.toBeInstanceOf(ProtocolViolationError);
    incoming.controller.close();
    await rejected;
    expect(incoming.stream.locked).toBe(false);
  });
});
