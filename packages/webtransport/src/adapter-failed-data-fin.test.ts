import { expect, it, vi } from 'vitest';
import { SessionState, varint, type ControlMessage } from '@openmoq/transport';
import { acceptCatalogSubscribe } from '../../../examples/broadcast/catalog-publisher.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [14, 16, 18, 22] as const) {
  for (const resetMode of ['prove', 'reject', 'hold'] as const) {
    it(`draft ${draft} failed subgroup FIN resets before ordinary DONE, reset=${resetMode}`, async () => {
      const f = await connectedPair(draft);
      const messages: ControlMessage[] = [];
      f.client.onMessage = message => messages.push(message);
      f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 7n); };
      const sub = await f.client.subscribeTrack(ns('fin'), nm('video'));
      const create = f.b.createUnidirectionalStream.bind(f.b);
      let raw!: WritableStreamDefaultWriter<Uint8Array>;
      const failure = new Error('FIN failed before transport');
      f.b.createUnidirectionalStream = async () => {
        raw = (await create()).getWriter();
        return new WritableStream<Uint8Array>({ write: bytes => raw.write(bytes), close: () => Promise.reject(failure) });
      };
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const reason = new Error('binding reset');
      const factory = vi.fn(() => reason);
      const reset = vi.fn(async (_writer: WritableStreamDefaultWriter<Uint8Array>, received: unknown, fin?: Promise<void>) => {
        expect(received).toBe(reason);
        // The binding must receive the physical FIN, not completion waiting on this reset.
        await expect(fin).rejects.toBe(failure);
        await gate;
        if (resetMode === 'reject') throw new Error('reset refused');
        await raw.abort(received);
      });
      Object.assign(f.b, { createStreamError: factory, resetSendStream: reset });
      try {
        const sid = await f.server.openSubgroup(7n, 0n, 0n);
        vi.useFakeTimers();
        let settled = false;
        const closing = f.server.closeSubgroup(sid).catch(error => { settled = true; return error; });
        await flush(64);
        expect(reset).toHaveBeenCalledOnce(); expect(factory).toHaveBeenCalledOnce(); expect(settled).toBe(false);
        await expect(f.server.publishDone(sub.requestId, varint(0n), 'failed')).rejects.toThrow(/open/);
        if (resetMode !== 'hold') release();
        await vi.advanceTimersByTimeAsync(1100);
        expect(await closing).toBe(failure);
        if (resetMode === 'prove') {
          expect(f.b.uniOut.at(-1)!.writeAborted).toBe(true);
          await expect(f.server.closeSubgroup(sid)).resolves.toBeUndefined();
          await f.server.publishDone(sub.requestId, varint(0n), 'failed');
          await flush(64);
          expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toHaveLength(1);
          expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
        } else {
          expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toHaveLength(0);
          expect(f.server.session.state).toBe(SessionState.CLOSED);
        }
      } finally { release(); vi.useRealTimers(); await f.client.close(); await f.server.close(); }
    });
  }

  if (draft !== 14) it(`draft ${draft} catalog FIN failure resets its subgroup and sends INTERNAL_ERROR DONE without closing the session`, async () => {
    const f = await connectedPair(draft);
    let id = -1n;
    f.server.onSubscribe = value => { id = value; };
    const messages: ControlMessage[] = [];
    f.client.onMessage = message => messages.push(message);
    const create = f.b.createUnidirectionalStream.bind(f.b);
    let raw!: WritableStreamDefaultWriter<Uint8Array>;
    f.b.createUnidirectionalStream = async () => {
      raw = (await create()).getWriter();
      return new WritableStream<Uint8Array>({ write: bytes => raw.write(bytes), close: () => Promise.reject(new Error('catalog FIN failed')) });
    };
    const reset = vi.fn(async (_writer: WritableStreamDefaultWriter<Uint8Array>, reason: unknown) => { await raw.abort(reason); });
    Object.assign(f.b, { createStreamError: () => new Error('binding reset'), resetSendStream: reset });
    try {
      await f.client.subscribe(ns('broadcast'), nm('catalog')); await flush(64);
      await expect(acceptCatalogSubscribe(f.server, id, 7n, {
        videoCodec: 'avc1.42001f', width: 1280, height: 720, fps: 30, videoBitrate: 2_000_000,
      }, { draft })).rejects.toThrow('catalog FIN failed');
      await flush(128);
      expect(reset).toHaveBeenCalledOnce(); expect(f.b.uniOut.at(-1)!.writeAborted).toBe(true);
      expect(f.errors).toEqual([]);
      expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
      expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toEqual([
        expect.objectContaining({ statusCode: 0n, streamCount: 1n }),
      ]);
      expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await f.client.close(); await f.server.close(); }
  });
}
