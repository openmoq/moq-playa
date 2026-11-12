// Loopback through the real adapter with injected stream faults.
import { expect, it, vi } from 'vitest';
import { SessionState, type ControlMessage } from '@openmoq/transport';
import { MoqtConnection } from './adapter.js';
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

const dones = (m: ControlMessage[]) => m.filter(x => x.type === 'PUBLISH_DONE') as Extract<ControlMessage, { type: 'PUBLISH_DONE' }>[];

// UPDATE_FAILED DONE with a held/rejected STOP_SENDING, or a refused FIN (B25, C2).
for (const draft of [18, 22] as const) {
  for (const fault of ['cancel-hold'] as const) {
    it(`d${draft} UPDATE_FAILED with ${fault}`, async () => {
      const c = ctl();
      const p = await pair(draft, c);
      try {
        let id = -1n;
        p.server.onSubscribe = rid => { id = rid; };
        const requestId = await p.client.subscribe(ns('uf'), nm('video'));
        await flush(128); await p.server.acceptSubscribe(id, 7n); await flush(128);
        const owner = id;
        // sibling
        const received: bigint[] = [];
        p.server.onSubscribe = rid => { void p.server.acceptSubscribe(rid, 8n); };
        await p.client.subscribeTrack(ns('uf'), nm('sibling'), { onObject: o => received.push(o.objectId) });
        await flush(128);
        p.server.setLargestLocationProvider(v => { if (v !== owner) return { group: 0n, object: 0n }; return { group: 5n, object: 1n }; });
        await p.client.requestUpdate(requestId, { forward: 0 });
        await flush(128);
        p.server.setLargestLocationProvider(v => { if (v === owner) throw new Error('Exact source unavailable'); return { group: 0n, object: 0n }; });
        if (fault === 'cancel-hold') c.cancelMode = 'hold';
        c.suppressPeerFin = true;
        c.armed = true;
        vi.useFakeTimers();
        await p.client.requestUpdate(requestId, { forward: 1 }).catch(() => {});
        await vi.advanceTimersByTimeAsync(3000);
        vi.useRealTimers();
        await flush(128);
        const state = p.server.session.state;
        let sibling = 'n/a';
        if (state === SessionState.ESTABLISHED) {
          const sid = await p.server.openSubgroup(8n, 1n, 0n);
          await p.server.sendObject(sid, 0n, new Uint8Array([1]));
          await flush(128);
          sibling = received.join(',');
        }
        expect(dones(p.messages).map(d => String(d.statusCode))).toEqual(['8']);
        expect(state).toBe(SessionState.ESTABLISHED); expect(sibling).toBe('0');
        expect(c.log.filter(x => x.startsWith('in:')).slice(-3)).toEqual(['in:write', 'in:fin', 'in:stop_sending']);
      } finally { vi.useRealTimers(); c.armed = false; c.unsuppress?.(); await p.close(); }
    });
  }
}
