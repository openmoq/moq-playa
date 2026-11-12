import { expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

interface CapturedContext {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  closed?: Promise<void>;
}

for (const draft of [18, 22] as const) {
  for (const [direction, phase] of [ ['outgoing', 'write'], ['outgoing', 'close'], ['incoming', 'close'] ] as const) {
    for (const fails of [false, true]) {
      it(`draft ${draft} ordinary ${direction} DONE ${phase} failure=${fails} retains cleanup ownership without forced join`, async () => {
        const f = await connectedPair(draft);
        const internal = f.server as unknown as {
          uniPair: { contexts: Map<bigint, CapturedContext> };
          inboundRequestContexts: Map<bigint, CapturedContext>;
        };
        let id = -1n;
        let fault: { mockRestore(): void } | undefined;
        let cancel: { mockRestore(): void } | undefined;
        const originalFailure = new Error('ordinary terminal write/close failed');
        try {
          if (direction === 'outgoing') {
            f.client.onPublish = p => { void f.client.acceptSubscribe(p.requestId, p.trackAlias); };
            id = await f.server.publish(ns('ordinary-cleanup'), nm('video'), 7n);
          } else {
            f.server.onSubscribe = value => { id = value; };
            await f.client.subscribe(ns('ordinary-cleanup'), nm('video'));
            await flush(128); await f.server.acceptSubscribe(id, 7n);
          }
          await flush(128);
          const context = direction === 'outgoing' ? internal.uniPair.contexts.get(id)! : internal.inboundRequestContexts.get(id)!;
          expect(context).toBeDefined();
          // Hold the peer's EOF so only our own cancellation can settle the pending read.
          const peerPipe = direction === 'outgoing' ? f.b.bidiOut.at(-1)!.in : f.a.bidiOut.at(-1)!.out;
          peerPipe.faults.hold = true;
          cancel = vi.spyOn(context.reader, 'cancel');
          if (fails) fault = vi.spyOn(context.writer, phase).mockRejectedValue(originalFailure);
          const outcome = await f.server.publishDone(id, varint(2n), 'ordinary terminal').then(
            () => ({ success: true }), error => ({ error }),
          );
          await flush(128);
          if (fails) expect(outcome).toEqual({ error: originalFailure });
          else expect(outcome).toEqual({ success: true });
          expect.soft(cancel, 'ordinary failure must not strand its still-pending reader').toHaveBeenCalledTimes(1);
          expect.soft(peerPipe.readCancelled).toBe(true);
        } finally {
          fault?.mockRestore(); cancel?.mockRestore();
          for (const stream of [...f.a.bidiOut, ...f.b.bidiOut]) { stream.out.releaseHeld(); stream.in.releaseHeld(); }
          await f.client.close(); await f.server.close();
        }
      });
    }
  }
}
