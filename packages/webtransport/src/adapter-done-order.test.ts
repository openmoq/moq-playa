// Loopback through the real adapter with injected stream faults.
import { expect, it, vi } from 'vitest';
import { SessionState, varint, createControlCodec, type ControlMessage } from '@openmoq/transport';
import { MoqtConnection, type IncomingPublish } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import type { WebTransportBidirectionalStream } from './types.js';

const ns = (s: string): Uint8Array[] => [new TextEncoder().encode(s)];
const nm = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Ctl { unsuppress?: () => void; suppressPeerFin?: boolean; cancelMode?: 'hold' | 'reject'; closeMode?: 'reject'; inject?: Uint8Array; armed: boolean; log: string[]; gateAfterWrite?: Promise<void>; gateBeforeWrite?: Promise<void>; peerGone: boolean; failWritesWhenPeerGone: boolean }
function ctl(): Ctl { return { armed: false, log: [], peerGone: false, failWritesWhenPeerGone: false }; }

function instrument(stream: WebTransportBidirectionalStream, c: Ctl, tag: string): WebTransportBidirectionalStream {
  const w = stream.writable.getWriter();
  const r = stream.readable.getReader();
  return {
    writable: new WritableStream<Uint8Array>({
      async write(chunk) {
        if (c.armed) c.log.push(`${tag}:write`);
        if (c.armed && c.gateBeforeWrite) await c.gateBeforeWrite;
        if (c.failWritesWhenPeerGone && c.peerGone) throw new Error('peer STOP_SENDING');
        await w.write(chunk);
        if (c.armed && c.gateAfterWrite) await c.gateAfterWrite;
        if (c.failWritesWhenPeerGone && c.peerGone) throw new Error('peer STOP_SENDING');
      },
      async close() {
        if (c.armed) c.log.push(`${tag}:fin`);
        if (c.armed && c.closeMode === 'reject') throw new Error('FIN refused');
        await w.close();
      },
      async abort(reason) { if (c.armed) c.log.push(`${tag}:reset`); await w.abort(reason); },
    }),
    readable: new ReadableStream<Uint8Array>({
      async pull(controller) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await r.read(); if (next.done && c.suppressPeerFin) await new Promise<void>(res => { c.unsuppress = res; }); }
        catch (error) { c.peerGone = true; try { controller.error(error); } catch { /* cancelled */ } return; }
        try {
          if (next.done) controller.close();
          else {
            controller.enqueue(next.value);
            if (c.inject) { const extra = c.inject; c.inject = undefined; controller.enqueue(extra); }
          }
        } catch { /* cancelled locally */ }
      },
      async cancel(reason) {
        if (c.armed) c.log.push(`${tag}:stop_sending`);
        if (c.armed && c.cancelMode === 'hold') await new Promise(() => {});
        if (c.armed && c.cancelMode === 'reject') throw new Error('STOP_SENDING refused');
        await r.cancel(reason);
      },
    }),
  };
}

async function pair(draft: 18 | 22, c?: Ctl) {
  const { a, b } = createLoopback();
  if (c) {
    const incoming = b.incomingBidirectionalStreams.pipeThrough(new TransformStream<WebTransportBidirectionalStream, WebTransportBidirectionalStream>({
      transform(stream, controller) { controller.enqueue(instrument(stream, c, 'in')); },
    }));
    Object.defineProperty(b, 'incomingBidirectionalStreams', { value: incoming });
    const create = b.createBidirectionalStream.bind(b);
    b.createBidirectionalStream = async () => instrument(await create(), c, 'out');
  }
  const client = new MoqtConnection(draft);
  const server = new MoqtConnection(draft, { role: 'server' });
  await Promise.all([client.connect(a), server.connect(b)]);
  Object.assign(b, { createStreamError: (code: number, cause?: unknown) => Object.assign(new Error('coded', { cause }), { streamErrorCode: code }) });
  const messages: ControlMessage[] = [];
  client.onMessage = m => messages.push(m);
  return { a, b, client, server, messages, close: async () => { await client.close(); await server.close(); } };
}

const dones = (m: ControlMessage[]) => m.filter(x => x.type === 'PUBLISH_DONE') as Extract<ControlMessage, { type: 'PUBLISH_DONE' }>[];

for (const draft of [18, 22] as const) {
  // ordinary PUBLISH_DONE wire order on both request-stream directions.
  for (const direction of ['subscribe', 'publish'] as const) {
    it(`d${draft} ordinary publishDone ${direction}: order of DONE write, FIN, STOP_SENDING`, async () => {
      const c = ctl();
      const p = await pair(draft, c);
      try {
        let id = -1n;
        if (direction === 'subscribe') {
          p.server.onSubscribe = rid => { id = rid; void p.server.acceptSubscribe(rid, 7n); };
          await p.client.subscribeTrack(ns('order'), nm('video'));
        } else {
          p.client.onPublish = pub => { void p.client.acceptSubscribe(pub.requestId, pub.trackAlias); };
          id = await p.server.publish(ns('order'), nm('video'), 7n);
        }
        await flush(128);
        c.suppressPeerFin = true; c.armed = true;
        const r = await p.server.publishDone(id, varint(2n), 'done').then(() => 'resolved', e => `rejected ${e}`);
        await flush(128);
        expect(r).toBe('resolved'); expect(dones(p.messages)).toHaveLength(1);
        const tag = direction === 'subscribe' ? 'in' : 'out';
        expect(c.log).toEqual([`${tag}:write`, `${tag}:fin`, `${tag}:stop_sending`]);
      } finally { c.unsuppress?.(); await p.close(); }
    });
  }

}
