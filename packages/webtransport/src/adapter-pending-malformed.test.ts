// Evaluation probes (scratch only). Loopback through the real adapter; faults are
// injected stream wrappers, not browser behavior.
import { expect, it, vi } from 'vitest';
import { SessionState, type ControlMessage } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
import { createLoopback, flush } from './testkit/loopback.js';
import type { WebTransportBidirectionalStream } from './types.js';

const ns = (s: string): Uint8Array[] => [new TextEncoder().encode(s)];
const nm = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Ctl { unsuppress?: () => void; suppressPeerFin?: boolean; cancelMode?: 'hold' | 'reject'; closeMode?: 'reject'; inject?: Uint8Array; armed: boolean; log: string[]; gateAfterWrite?: Promise<void>; gateBeforeWrite?: Promise<void>; peerGone: boolean; failWritesWhenPeerGone: boolean }

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
            if (c.inject) { const extra = c.inject; delete c.inject; controller.enqueue(extra); }
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

for (const draft of [18, 22] as const) for (const direction of ['subscribe', 'publish']) for (const decision of ['accept', 'reject']) {
  it(`pending d${draft} ${direction}: malformed rejection preserves later ${decision}`, async () => {
    const p = await pair(draft);
    try {
      let id = -1n;
      if (direction === 'subscribe') {
        p.server.onSubscribe = value => { id = value; };
        await p.client.subscribe(ns('pending'), nm('video'));
      } else {
        p.client.onPublish = () => {};
        id = await p.server.publish(ns('pending'), nm('video'), 7n);
      }
      await flush(128);
      const factory = vi.spyOn(p.b as typeof p.b & { createStreamError(code: number): Error }, 'createStreamError');
      await expect(p.server.terminateMalformedPublication(id)).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
      expect(p.server.session.state).toBe(SessionState.ESTABLISHED);
      expect(dones(p.messages)).toHaveLength(0);
      const receiver = direction === 'subscribe' ? p.server : p.client;
      if (decision === 'accept') await receiver.acceptSubscribe(id, 7n);
      else await receiver.rejectSubscribe(id, 400n, 'declined');
      await flush(128);
      expect(p.server.session.state).toBe(SessionState.ESTABLISHED);
      expect(dones(p.messages)).toHaveLength(0);
    } finally { await p.close(); }
  });
}
