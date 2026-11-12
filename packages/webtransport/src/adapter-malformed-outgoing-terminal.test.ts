import { expect, it } from 'vitest';
import { SessionState, varint, type ControlMessage } from '@openmoq/transport';
import type { MoqtConnection } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

type Api = { terminateMalformedPublication(id: bigint): Promise<{ status: 'done-written' | 'already-terminal' }> };
function api(connection: MoqtConnection): Api {
  const value = connection as MoqtConnection & Partial<Api>;
  expect(value.terminateMalformedPublication, 'proposed API missing, not a measured cleanup failure').toBeTypeOf('function');
  if (!value.terminateMalformedPublication) throw new Error('API unavailable');
  return { terminateMalformedPublication: value.terminateMalformedPublication.bind(connection) };
}

for (const draft of [18, 22] as const) {
  for (const phase of ['write', 'close', 'cancel'] as const) {
    for (const failure of ['reject', 'hold'] as const) {
      it(`draft ${draft} outgoing PUBLISH ${phase} ${failure} cannot report done-written`, async () => {
        const f = await connectedPair(draft);
        const original = f.b.createBidirectionalStream.bind(f.b);
        let armed = false;
        let observed = 0;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const fault = async () => {
          observed++;
          if (failure === 'reject') throw new Error('Injected local terminal failure');
          await held;
        };
        f.b.createBidirectionalStream = async () => {
          const stream = await original();
          const writer = stream.writable.getWriter();
          const reader = stream.readable.getReader();
          return {
            writable: new WritableStream<Uint8Array>({
              async write(bytes) { if (armed && phase === 'write') await fault(); await writer.write(bytes); },
              async close() { if (armed && phase === 'close') await fault(); await writer.close(); },
              abort: reason => writer.abort(reason),
            }),
            readable: new ReadableStream<Uint8Array>({
              async pull(controller) {
                const next = await reader.read();
                if (next.done && armed && phase === 'cancel') await held;
                try { if (next.done) controller.close(); else controller.enqueue(next.value); } catch { /* locally cancelled */ }
              },
              async cancel(reason) { if (armed && phase === 'cancel') await fault(); await reader.cancel(reason); },
            }),
          };
        };
        Object.assign(f.b, { createStreamError: (code: number) => Object.assign(new Error('malformed'), { streamErrorCode: code }) });
        f.client.onPublish = publication => { void f.client.acceptSubscribe(publication.requestId, publication.trackAlias); };
        try {
          const id = await f.server.publish(ns('terminal-proof'), nm('video'), 7n);
          await flush(128);
          expect(f.server.session.getOutgoingPublish(id)).toBeDefined();
          const method = api(f.server);
          armed = true;
          const start = performance.now();
          await expect(method.terminateMalformedPublication(id)).rejects.toThrow();
          expect(observed).toBeGreaterThan(0);
          expect(performance.now() - start).toBeLessThan(2000);
          expect(f.server.session.state).toBe(phase === 'cancel' || (phase === 'close' && failure === 'reject') ? SessionState.ESTABLISHED : SessionState.CLOSED);
        } finally {
          armed = false; release();
          await f.client.close(); await f.server.close();
        }
      });
    }
  }

  for (const first of ['ordinary', 'peer', 'session'] as const) {
    for (const malformedFirst of [false, true]) {
      it(`draft ${draft} ${first} crossing, malformed first=${malformedFirst}`, async () => {
        const f = await connectedPair(draft);
        const messages: ControlMessage[] = [];
        f.client.onMessage = message => messages.push(message);
        let id = -1n;
        f.server.onSubscribe = value => { id = value; };
        Object.assign(f.b, { createStreamError: (code: number) => Object.assign(new Error('malformed'), { streamErrorCode: code }) });
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        try {
          await f.client.subscribe(ns('race'), nm('video'));
          await flush(128); await f.server.acceptSubscribe(id, 7n); await flush(128);
          const sid = await f.server.openSubgroup(7n, 0n, 0n);
          await f.server.sendObject(sid, 0n, new Uint8Array([1]));
          await f.server.closeSubgroup(sid); await flush(128);
          const method = api(f.server);
          const other = () => first === 'ordinary' ? f.server.publishDone(id, varint(2n), 'ordinary winner')
            : first === 'peer' ? f.client.unsubscribe(id) : f.server.close();
          if (!malformedFirst) {
            await other(); await flush(128);
            expect(await method.terminateMalformedPublication(id)).toEqual({ status: 'already-terminal' });
          } else {
            // Hold a fresh registered stream's reset so the competing terminal really crosses.
            f.b.createUnidirectionalStream = async () => new WritableStream<Uint8Array>({ abort: () => held });
            await f.server.openSubgroup(7n, 1n, 0n);
            const operation = method.terminateMalformedPublication(id);
            const outcome = operation.then(value => ({ value }), error => ({ error }));
            await other().catch(() => {});
            release();
            const result = await outcome;
            if (first === 'session') expect(result).toHaveProperty('error');
            // Peer cancellation can win transport ownership; never invent a successful malformed DONE.
            await flush(128);
          }
          const done = messages.filter(message => message.type === 'PUBLISH_DONE');
          expect(done.length).toBeLessThanOrEqual(1);
          if (done[0]?.type === 'PUBLISH_DONE') {
            expect(BigInt(done[0].statusCode)).toBe(malformedFirst ? 0x12n : 2n);
          }
        } finally { release(); await f.client.close(); await f.server.close(); }
      });
    }
  }

}
