// Loopback through the real adapter with injected stream faults.
import { expect, it } from 'vitest';
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


for (const draft of [18, 22] as const) {
  // the peer's PUBLISH_DONE lands while our PUBLISH_OK write promise is pending.
  it(`d${draft} acceptSubscribe of incoming PUBLISH when the peer ends it during PUBLISH_OK`, async () => {
    const c = ctl();
    const p = await pair(draft, c);
    try {
      let release!: () => void;
      c.gateAfterWrite = new Promise<void>(res => { release = res; });
      let accept: Promise<unknown> | undefined;
      let pub: IncomingPublish | undefined;
      p.server.onPublish = x => { pub = x; c.armed = true; accept = p.server.acceptSubscribe(x.requestId, x.trackAlias).then(() => 'resolved', e => `rejected ${e}`); };
      const id = await p.client.publish(ns('accept-race'), nm('video'), 41n);
      await flush(128);
      await p.client.publishDone(id, varint(2n), 'short publication').catch(e => console.log('client publishDone', String(e)));
      await flush(128);
      const goneBefore = p.server.session.getIncomingSubscription(id) === undefined;
      release();
      const r = await accept;
      let closed = false; void pub?.closed.then(() => { closed = true; });
      await flush(32);
      expect(r).toBe('resolved'); expect(goneBefore).toBe(true); expect(closed).toBe(true); expect(p.server.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await p.close(); }
  });
}

// no gate; a PUBLISH_DONE arrives in the same receive as the PUBLISH (injected).
for (const draft of [18, 22] as const) {
  it(`d${draft} acceptSubscribe when PUBLISH and PUBLISH_DONE arrive together`, async () => {
    const c = ctl();
    c.inject = createControlCodec(draft).encode({ type: 'PUBLISH_DONE', requestId: 0n, statusCode: 2n, streamCount: 0n, errorReason: 'short' } as ControlMessage);
    const p = await pair(draft, c);
    try {
      let accept: Promise<unknown> | undefined;
      let errors: string[] = [];
      p.server.onError = e => errors.push(String(e));
      p.server.onPublish = x => { accept = p.server.acceptSubscribe(x.requestId, x.trackAlias).then(() => 'resolved', e => `rejected ${e}`); };
      void p.client.publish(ns('accept-race'), nm('video'), 41n).catch(() => {});
      await flush(256);
      expect(await accept).toBe('resolved'); expect(errors).toEqual([]); expect(p.server.session.state).toBe(SessionState.ESTABLISHED);
    } finally { await p.close(); }
  });
}
