import { describe, expect, it, vi } from 'vitest';
import { createControlCodec } from '@moqt/transport';
import { IncomingUniRouter, type RoutedIncomingUniStream } from './incoming-uni.js';
import { flush } from '../testkit/stream-sim.js';

const setup = createControlCodec(18).encode({ type: 'SETUP', setupOptions: new Map() });

function controlledStream(): {
  stream: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
  error(reason: Error): void;
  cancelled(): boolean;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { wasCancelled = true; },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
    error: (reason) => controller.error(reason),
    cancelled: () => wasCancelled,
  };
}

function streamSource(): {
  source: ReadableStream<ReadableStream<Uint8Array>>;
  push(stream: ReadableStream<Uint8Array>): void;
  close(): void;
  cancelled(): boolean;
} {
  let controller!: ReadableStreamDefaultController<ReadableStream<Uint8Array>>;
  let wasCancelled = false;
  return {
    source: new ReadableStream({
      start(value) { controller = value; },
      cancel() { wasCancelled = true; },
    }),
    push: (stream) => controller.enqueue(stream),
    close: () => controller.close(),
    cancelled: () => wasCancelled,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function handlers() {
  const data: RoutedIncomingUniStream[] = [];
  const setups: Uint8Array[] = [];
  const violations: string[] = [];
  const transportErrors: Error[] = [];
  return {
    data,
    setups,
    violations,
    transportErrors,
    callbacks: {
      onSetup: async (stream: ReadableStream<Uint8Array>) => { setups.push(await readAll(stream)); },
      onData: (stream: RoutedIncomingUniStream) => { data.push(stream); },
      onViolation: (reason: string) => { violations.push(reason); },
      onTransportError: (error: Error) => { transportErrors.push(error); },
    },
  };
}

describe('IncomingUniRouter', () => {
  it('holds early Object streams until a fragmented SETUP is accepted', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);

    const object = controlledStream();
    object.push(new Uint8Array([0x10, 0x01]));
    input.push(object.stream);
    await flush();
    expect(h.data).toEqual([]);

    const control = controlledStream();
    input.push(control.stream);
    control.push(setup.subarray(0, 1));
    await flush();
    expect(h.setups).toEqual([]);
    control.push(setup.subarray(1));
    control.close();

    await ready;
    expect(h.setups).toEqual([setup]);
    expect(h.data).toEqual([]);

    router.releaseData();
    expect(h.data).toHaveLength(1);
    expect(h.data[0]!.prefix).toEqual(new Uint8Array([0x10, 0x01]));
    expect(h.violations).toEqual([]);
  });

  it('aborts locally without reporting a peer protocol violation', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);
    const object = controlledStream();
    input.push(object.stream);
    object.push(new Uint8Array([0x10, 0x01]));
    await flush();

    const failure = new Error('local SETUP write failed');
    router.abort(failure);

    await expect(ready).rejects.toBe(failure);
    await flush();
    expect(object.cancelled()).toBe(true);
    expect(input.cancelled()).toBe(true);
    expect(h.violations).toEqual([]);
    expect(h.transportErrors).toEqual([]);
  });

  it('retires child work without cancelling the transport-owned source', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);
    const pending = controlledStream();
    input.push(pending.stream);
    await flush();

    const failure = new Error('session terminated');
    router.retire(failure);

    await expect(ready).rejects.toBe(failure);
    await flush();
    expect(pending.cancelled()).toBe(true);
    expect(input.cancelled()).toBe(false);
    input.close();
  });

  it('cancels a stream whose type is still pending when aborted', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);
    const pending = controlledStream();
    input.push(pending.stream);
    await flush();

    const failure = new Error('session terminated');
    router.abort(failure);

    await expect(ready).rejects.toBe(failure);
    await flush();
    expect(pending.cancelled()).toBe(true);
    expect(h.data).toEqual([]);
    expect(h.violations).toEqual([]);
  });

  it('rejects a second SETUP stream', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);

    for (let i = 0; i < 2; i++) {
      const control = controlledStream();
      input.push(control.stream);
      control.push(setup);
      control.close();
      if (i === 0) await ready;
    }
    await flush();

    expect(h.violations).toEqual([expect.stringMatching(/more than one SETUP/)]);
  });

  it('rejects unknown stream types instead of treating them as data', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);
    const unknown = controlledStream();
    input.push(unknown.stream);
    unknown.push(new Uint8Array([0x08]));

    await expect(ready).rejects.toThrow(/unknown draft-18/);
    expect(h.violations).toEqual([expect.stringMatching(/unknown draft-18/)]);
    expect(h.data).toEqual([]);
    expect(input.cancelled()).toBe(false);
    input.close();
  });

  it('rejects a clean FIN before the required stream type', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);
    const empty = controlledStream();
    input.push(empty.stream);
    empty.close();

    await expect(ready).rejects.toThrow(/FIN received before stream type/);
    expect(h.data).toEqual([]);
    expect(h.violations).toEqual([expect.stringMatching(/FIN received before stream type/)]);
  });

  it('routes RESET_STREAM before the type through the data lifecycle', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);
    const reset = controlledStream();
    const resetError = Object.assign(new Error('cancelled'), { streamErrorCode: 1 });
    input.push(reset.stream);
    reset.error(resetError);
    await flush();

    const control = controlledStream();
    input.push(control.stream);
    control.push(setup);
    control.close();
    await ready;
    router.releaseData();

    expect(h.data).toHaveLength(1);
    await expect(h.data[0]!.reader.read()).rejects.toBe(resetError);
    expect(h.violations).toEqual([]);
  });

  it('rejects a clean FIN in the middle of a multi-byte stream type', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks);
    const ready = router.start(input.source);
    const partial = controlledStream();
    input.push(partial.stream);
    partial.push(setup.subarray(0, 1));
    partial.close();

    await expect(ready).rejects.toThrow(/FIN received mid-type/);
    expect(h.violations).toEqual([expect.stringMatching(/FIN received mid-type/)]);
  });

  it('bounds streams waiting for SETUP and cancels the excess stream', async () => {
    const input = streamSource();
    const h = handlers();
    const router = new IncomingUniRouter(h.callbacks, { maxPendingStreams: 1 });
    const ready = router.start(input.source);
    const first = controlledStream();
    const second = controlledStream();
    input.push(first.stream);
    first.push(new Uint8Array([0x10]));
    await flush();
    input.push(second.stream);

    await expect(ready).rejects.toThrow(/too many incoming streams/);
    expect(second.cancelled()).toBe(true);
    expect(h.violations).toHaveLength(1);
  });

  it('surfaces stream-source failures separately from protocol violations', async () => {
    const failure = new Error('accept failed');
    const h = handlers();
    const source = new ReadableStream<ReadableStream<Uint8Array>>({
      start(controller) { controller.error(failure); },
    });
    const router = new IncomingUniRouter(h.callbacks);

    await expect(router.start(source)).rejects.toBe(failure);
    expect(h.transportErrors).toEqual([failure]);
    expect(h.violations).toEqual([]);
  });

  it('validates its bound before owning a stream source', () => {
    expect(() => new IncomingUniRouter(handlers().callbacks, { maxPendingStreams: 0 })).toThrow(RangeError);
    expect(() => new IncomingUniRouter(handlers().callbacks, { maxPendingStreams: 1.5 })).toThrow(RangeError);
  });

  it('can only start once', () => {
    const input = streamSource();
    const router = new IncomingUniRouter(handlers().callbacks);
    void router.start(input.source);
    expect(() => router.start(input.source)).toThrow(/only be called once/);
  });
});
