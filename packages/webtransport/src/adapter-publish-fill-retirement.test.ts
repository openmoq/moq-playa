import { expect, it, vi } from 'vitest';
import { createControlCodec, encodeFetchHeader18, encodeFillParameters, encodeSubgroupHeader18 } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';
import type { WebTransportLike } from './index.js';

for (const mode of ['reject-delayed', 'done-delayed', 'refused'] as const) {
  it(`draft23 discards a late PUBLISH fill: ${mode}`, async () => {
    const p = await connectedPair(23);
    const receiver = mode === 'refused' ? p.server : p.client;
    const sender = mode === 'refused' ? p.client : p.server;
    const tx = mode === 'refused' ? p.a : p.b;
    const rx = mode === 'refused' ? p.b : p.a;
    const createError = vi.fn((code: number) => Object.assign(new Error('cancelled'), { streamErrorCode: code }));
    (rx as WebTransportLike).createStreamError = createError;
    const objects: bigint[] = [];
    const terminals: string[] = [];
    receiver.onStreamClosed = (_id, _error, terminal) => { if (terminal) terminals.push(terminal); };
    receiver.onPublish = pub => { pub.onObject = object => { objects.push(object.objectId); }; };
    try {
      const live = await sender.publish(ns('live'), nm('video'), 8n);
      await flush(128); await receiver.acceptSubscribe(live, 8n);
      const id = await sender.publish(ns('fill'), nm('video'), 7n, {
        parameters: new Map([[0x23n, [encodeFillParameters()]]]),
      });
      await flush(128);
      const writer = (await tx.createUnidirectionalStream()).getWriter();
      const pipe = tx.uniOut.at(-1)!;
      if (mode !== 'refused') {
        pipe.faults.hold = true;
        await writer.write(encodeFetchHeader18(id));
      }
      if (mode === 'done-delayed') {
        await receiver.acceptSubscribe(id, 7n);
        await writer.close();
        tx.bidiOut.at(-1)!.out.injectRead(createControlCodec(23).encode({
          type: 'PUBLISH_DONE', requestId: id, statusCode: 0n, streamCount: 1n, errorReason: 'finished',
        }));
      } else {
        if (mode === 'reject-delayed') tx.bidiOut.at(-1)!.in.faults.hold = true;
        await receiver.rejectSubscribe(id, 3n, 'not supported');
      }
      await flush(128);
      expect(receiver.session.getIncomingSubscription(id)).toBeUndefined();
      if (mode === 'refused') await writer.write(encodeFetchHeader18(id));
      else pipe.releaseHeld();
      await flush(256);
      expect(receiver.session.state).toBe('established');
      // A coalesced header+FIN is already closed when reader.cancel runs.
      if (mode !== 'done-delayed') expect(pipe.readCancelled).toBe(true);
      expect(terminals).toContain('local-discard');
      expect(createError).toHaveBeenCalledWith(1, expect.any(Error));
      const sid = await sender.openSubgroup(8n, 1n, 0n);
      await sender.sendObject(sid, 0n, Uint8Array.of(1)); await sender.closeSubgroup(sid);
      await flush(128);
      expect(objects).toContain(0n); expect(p.errors).toEqual([]);
      writer.releaseLock();
    } finally { await p.client.close(); await p.server.close(); }
  });
}

for (const kind of ['expired', 'duplicate', 'unknown'] as const) {
  it(`draft23 keeps ${kind} fill headers invalid and expires retired records`, async () => {
    const p = await connectedPair(23, { clientOptions: { terminatedAliasTtlMs: 20 } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const id = await p.server.publish(ns('fill'), nm('video'), 7n, {
        parameters: new Map([[0x23n, [encodeFillParameters()]]]),
      });
      await flush(128);
      await p.client.rejectSubscribe(id, 3n, 'not supported');
      // Inspect only the bounded record: no publication state may be retained here.
      const records = (p.client as unknown as { publishFillDiscards: Map<bigint, unknown> }).publishFillDiscards;
      if (kind === 'expired') {
        expect(records.has(id)).toBe(true);
        await vi.advanceTimersByTimeAsync(21);
        expect(records.has(id)).toBe(false);
      }
      for (let n = 0; n < (kind === 'duplicate' ? 2 : 1); n++) {
        const writer = (await p.b.createUnidirectionalStream()).getWriter();
        await writer.write(encodeFetchHeader18(kind === 'unknown' ? 99n : id));
        await flush(128); writer.releaseLock();
        if (kind === 'duplicate' && n === 0) expect(p.client.session.state).toBe('established');
      }
      expect(p.a.closeInfo?.closeCode).toBe(3);
    } finally { await p.client.close(); await p.server.close(); vi.useRealTimers(); }
  });
}

for (const draft of [22, 23] as const) it(`draft${draft} still discards a refused PUBLISH's late subgroup`, async () => {
  const p = await connectedPair(draft);
  try {
    const id = await p.client.publish(ns('live'), nm('video'), 7n);
    await flush(128); await p.server.rejectSubscribe(id, 3n, 'not supported');
    const writer = (await p.a.createUnidirectionalStream()).getWriter();
    await writer.write(encodeSubgroupHeader18({ typeByte: 0x54, trackAlias: 7n, groupId: 0n,
      subgroupId: 0n, publisherPriority: 128, hasExtensions: false,
      isEndOfGroup: false, isFirstObjectInSubgroup: true }));
    await flush(128);
    expect(p.server.session.state).toBe('established');
    expect(p.a.uniOut.at(-1)!.readCancelled).toBe(true);
    expect(p.errors).toEqual([]); writer.releaseLock();
  } finally { await p.client.close(); await p.server.close(); }
});
