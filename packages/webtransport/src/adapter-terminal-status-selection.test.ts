import { describe, expect, it, vi } from 'vitest';
import { createControlCodec, encodeObjectDatagram18, varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

describe.each([16, 18, 22, 23] as const)('draft %i status-selective terminal drain', draft => {
  it.each([2n, 3n, 0n, 1n, 4n, 5n, 6n, 8n, 9n, 18n])('selects only normal completion code %s', async code => {
    const h = await connectedPair(draft, { clientOptions: { terminatedAliasTtlMs: 20 } });
    const drained = vi.fn();
    try {
      const id = await h.client.subscribe(ns('finite'), nm('video'), {
        terminalDelivery: 'drain', terminalDeliveryStatuses: draft === 22 ? [2n] : [2n, 3n], onDrained: drained,
      });
      await flush(64); await h.server.acceptSubscribe(id, 7n); await flush(64);
      await h.server.publishDone(id, varint(code), 'test'); await flush(64);
      await new Promise(resolve => setTimeout(resolve, 40)); await flush(64);
      expect(drained.mock.calls).toEqual(code === 2n || code === 3n && draft !== 22 ? [[id]] : []);
      expect(h.errors).toEqual([]);
      expect((h.client as unknown as { drainConfigs: Map<bigint, unknown> }).drainConfigs.size).toBe(0);
    } finally { await h.client.close(); await h.server.close(); }
  });
});

it('validates terminal status selection before allocating or emitting a request', async () => {
  const h = await connectedPair(18);
  try {
    const streams = h.a.bidiOut.length;
    await expect(h.client.subscribe(ns('finite'), nm('video'), { terminalDeliveryStatuses: [2n] })).rejects.toThrow(/requires|require/);
    await expect(h.client.subscribe(ns('finite'), nm('video'), { terminalDelivery: 'drain', terminalDeliveryStatuses: [-1n] })).rejects.toThrow(/unsigned bigint/);
    await expect(h.client.subscribe(ns('finite'), nm('video'), { terminalDeliveryCompletion: 'streams' })).rejects.toThrow(/require/);
    await expect(h.client.subscribe(ns('finite'), nm('video'), { terminalDelivery: 'drain', terminalDeliveryCompletion: 'bad' as never })).rejects.toThrow(/must be streams/);
    expect(h.a.bidiOut).toHaveLength(streams);
  } finally { await h.client.close(); await h.server.close(); }
});

describe.each([16, 18, 22, 23] as const)('draft %i exact processed-stream completion', draft => {
  it('retains fresh-alias stream evidence when data overtakes SUBSCRIBE_OK', async () => {
    const h = await connectedPair(draft);
    const drained = vi.fn(), objects = vi.fn();
    try {
      const id = await h.client.subscribe(ns('finite'), nm('video'), {
        terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams', onDrained: drained,
      });
      await flush(128);
      const response = h.a.bidiOut[0]!.in; response.faults.hold = true;
      await h.server.acceptSubscribe(id, 7n); await flush(128);
      h.client.onObject = objects;
      const sid = await h.server.openSubgroup(7n, 0n, 0n);
      await h.server.sendObject(sid, 0n, Uint8Array.of(1)); await h.server.closeSubgroup(sid); await flush(256);
      response.releaseHeld(); await flush(256);
      await h.server.publishDone(id, varint(2n), 'finite'); await flush(256);
      expect(objects).toHaveBeenCalledOnce();
      expect(drained).toHaveBeenCalledExactlyOnceWith(id); expect(h.errors).toEqual([]);
    } finally { await h.client.close(); await h.server.close(); }
  });

  it.each(['before-done', 'after-done', 'held-fin'] as const)('finishes after all streams are processed: %s', async order => {
    const h = await connectedPair(draft);
    const events: string[] = [];
    h.client.onMessage = message => { if (message.type === 'PUBLISH_DONE') events.push('done'); };
    h.client.onObject = () => events.push('object');
    try {
      const id = await h.client.subscribe(ns('finite'), nm('video'), {
        terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams', onDrained: () => events.push('drained'),
      });
      await flush(128); await h.server.acceptSubscribe(id, 7n); await flush(128);
      const sid = await h.server.openSubgroup(7n, 0n, 0n);
      const pipe = h.b.uniOut.at(-1)!;
      if (order === 'after-done') pipe.faults.hold = true;
      await h.server.sendObject(sid, 0n, Uint8Array.of(1)); await flush(128);
      if (order === 'held-fin') pipe.faults.hold = true;
      await h.server.closeSubgroup(sid); await flush(128);
      await h.server.publishDone(id, varint(2n), 'finite'); await flush(256);
      if (order !== 'before-done') {
        expect(events).not.toContain('drained');
        pipe.releaseHeld(); await flush(256);
      }
      expect(events.filter(event => event === 'object')).toHaveLength(1);
      expect(events.filter(event => event === 'drained')).toHaveLength(1);
      expect(events.indexOf('drained')).toBeGreaterThan(events.indexOf('done'));
      expect(events.indexOf('drained')).toBeGreaterThan(events.indexOf('object'));
      expect(pipe.readCancelled).toBe(false); expect(h.errors).toEqual([]);
    } finally { await h.client.close(); await h.server.close(); }
  });

  it.each(['zero', 'unknown', 'unmet'] as const)('retains the timeout for %s count', async kind => {
    const h = await connectedPair(draft);
    const drained = vi.fn();
    try {
      const id = await h.client.subscribe(ns('finite'), nm('video'), {
        terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams', onDrained: drained,
      });
      await flush(128); await h.server.acceptSubscribe(id, 7n); await flush(128);
      vi.useFakeTimers();
      const streamCount = kind === 'zero' ? 0n : kind === 'unmet' ? 1n
        : draft === 22 ? 0xffffffffffffffffn : (1n << 62n) - 1n;
      h.a.bidiOut[0]!.in.injectRead(createControlCodec(draft).encode({ type: 'PUBLISH_DONE', requestId: varint(id),
        statusCode: varint(2n), streamCount, errorReason: 'finite' }));
      await flush(256); await vi.advanceTimersByTimeAsync(1500);
      expect(drained).not.toHaveBeenCalled();
      if (kind === 'zero' && draft !== 16) {
        const datagrams = vi.fn(); h.client.onDatagram = datagrams;
        const writer = h.b.datagrams.writable!.getWriter();
        await writer.write(encodeObjectDatagram18({ typeByte: 0x00, trackAlias: 7n, groupId: 0n, objectId: 0n,
          publisherPriority: 128, isEndOfGroup: false, extensions: undefined, payload: Uint8Array.of(1), status: undefined }));
        writer.releaseLock(); await flush(256);
        expect(datagrams).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(8501); await flush(256);
      expect(drained).toHaveBeenCalledExactlyOnceWith(id); expect(h.errors).toEqual([]);
    } finally { vi.useRealTimers(); await h.client.close(); await h.server.close(); }
  });
});

describe.each([16, 18, 22, 23] as const)('draft %i terminal grace cancellation ownership', draft => {
  it('waits for held subgroup cancellation before publishing drained', async () => {
    const h = await connectedPair(draft, { clientOptions: { terminatedAliasTtlMs: 20 } });
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      const id = await h.client.subscribe(ns('finite'), nm('video'), {
        terminalDelivery: 'drain', terminalDeliveryCompletion: 'streams',
        terminalDeliveryStatuses: [2n], onDrained: () => events.push('drained'),
      });
      await flush(128); await h.server.acceptSubscribe(id, 7n); await flush(128);
      const stream = await h.server.openSubgroup(7n, 0n, 0n);
      await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
      const internals = h.client as unknown as {
        incomingSubgroupAliases: Map<bigint, bigint>;
        dataStreamReaders: Map<bigint, ReadableStreamDefaultReader<Uint8Array>>;
      };
      const incoming = [...internals.incomingSubgroupAliases].find(([, alias]) => alias === 7n)?.[0];
      expect(incoming).toBeDefined();
      const reader = internals.dataStreamReaders.get(incoming!)!;
      const cancel = reader.cancel.bind(reader);
      reader.cancel = async reason => {
        events.push('cancel-start'); await held; await cancel(reason); events.push('cancel-settled');
      };
      h.b.uniOut.at(-1)!.faults.hold = true;
      await h.server.closeSubgroup(stream); // Sender FIN precedes DONE; receiver FIN is held.
      vi.useFakeTimers();
      await h.server.publishDone(id, varint(2n), 'finite'); await flush(256);
      await vi.advanceTimersByTimeAsync(21); await flush(128);
      expect.soft(events).toEqual(['cancel-start']);
      release(); await flush(256);
      expect(events).toEqual(['cancel-start', 'cancel-settled', 'drained']);
      expect(h.errors).toEqual([]);
    } finally { release(); vi.useRealTimers(); await h.client.close(); await h.server.close(); }
  });
});

it.each([100, 250])('a shared-alias drain keeps its own deadline when the earlier member ends %ims sooner', delay => {
  return (async () => {
    const h = await connectedPair(22, { clientOptions: { terminatedAliasTtlMs: 200 } });
    const drained: bigint[] = [];
    try {
      const options = { terminalDelivery: 'drain' as const, terminalDeliveryCompletion: 'streams' as const,
        onDrained: (id: bigint) => drained.push(id) };
      const first = await h.client.subscribe(ns('finite'), nm('video'), options);
      await flush(128); await h.server.acceptSubscribe(first, 7n); await flush(128);
      const last = await h.client.subscribe(ns('finite'), nm('video'), options);
      await flush(128); await h.server.acceptSubscribe(last, 7n); await flush(128);
      const stream = await h.server.openSubgroup(7n, 0n, 0n, { requestId: last });
      await h.server.sendObject(stream, 0n, Uint8Array.of(1)); await flush(128);
      const pipe = h.b.uniOut.at(-1)!;
      vi.useFakeTimers();
      await h.server.publishDone(first, varint(2n), 'first ended'); await flush(128);
      await vi.advanceTimersByTimeAsync(delay); await flush(128);
      expect(drained).toEqual(delay < 200 ? [] : [first]);
      pipe.faults.hold = true;
      await h.server.closeSubgroup(stream); // Sender FIN precedes the final DONE.
      await h.server.publishDone(last, varint(2n), 'last ended'); await flush(128);
      await vi.advanceTimersByTimeAsync(199); await flush(128);
      expect.soft(drained).toEqual(delay < 200 ? [] : [first]);
      expect.soft(pipe.readCancelled).toBe(false);
      await vi.advanceTimersByTimeAsync(2); await flush(256);
      expect(drained).toEqual([first, last]); expect(pipe.readCancelled).toBe(true);
      expect(h.errors).toEqual([]);
    } finally { vi.useRealTimers(); await h.client.close(); await h.server.close(); }
  })();
});
