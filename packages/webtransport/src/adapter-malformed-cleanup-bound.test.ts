import { expect, it, vi } from 'vitest';
import { SessionState, varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

interface Context {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  closed?: Promise<void>;
}

for (const draft of [18, 22] as const) {
  for (const direction of ['incoming', 'outgoing'] as const) {
    for (const fault of ['reader-reject', 'reader-hold', 'reset-reject', 'reset-hold'] as const) {
      it(`draft ${draft} ordinary ${direction} failed write plus ${fault} preserves error and settles within its bound`, async () => {
        const f = await connectedPair(draft);
        const internal = f.server as unknown as {
          uniPair: { contexts: Map<bigint, Context> };
          inboundRequestContexts: Map<bigint, Context>;
        };
        const terminalError = new Error('original failed DONE write');
        const cleanupError = new Error('secondary failed cleanup');
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let undoWrite: { mockRestore(): void } | undefined;
        let undoCleanup: { mockRestore(): void } | undefined;
        try {
          let id = -1n;
          if (direction === 'outgoing') {
            f.client.onPublish = p => { void f.client.acceptSubscribe(p.requestId, p.trackAlias); };
            id = await f.server.publish(ns('cleanup-bound'), nm('video'), 7n);
          } else {
            f.server.onSubscribe = value => { id = value; };
            await f.client.subscribe(ns('cleanup-bound'), nm('video'));
            await flush(128); await f.server.acceptSubscribe(id, 7n);
          }
          await flush(128);
          const context = direction === 'outgoing' ? internal.uniPair.contexts.get(id)! : internal.inboundRequestContexts.get(id)!;
          undoWrite = vi.spyOn(context.writer, 'write').mockRejectedValue(terminalError);
          let cleanupCalls = 0;
          const failCleanup = () => { cleanupCalls++; return fault.endsWith('hold') ? held : Promise.reject(cleanupError); };
          if (fault.startsWith('reader')) undoCleanup = vi.spyOn(context.reader, 'cancel').mockImplementation(failCleanup);
          else undoCleanup = vi.spyOn(context.writer, 'abort').mockImplementation(failCleanup);
          const started = performance.now();
          const outcome = await f.server.publishDone(id, varint(2n), 'ordinary').then(
            () => ({ success: true }), error => ({ error }),
          );
          expect(outcome).toEqual({ error: terminalError });
          expect(cleanupCalls).toBe(1);
          expect(performance.now() - started).toBeLessThan(2000);
          expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
        } finally {
          release(); undoWrite?.mockRestore(); undoCleanup?.mockRestore();
          await f.client.close(); await f.server.close();
        }
      });
    }
  }
}
