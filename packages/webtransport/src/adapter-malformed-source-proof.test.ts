import { expect, it, vi } from 'vitest';
import { SessionState } from '@openmoq/transport';
import type { IncomingPublish } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [18, 22] as const) {
  for (const target of ['request', 'data-reader'] as const) {
    for (const outcome of ['ok', 'reject', 'hold'] as const) {
      it(`draft ${draft} source ${target} cancellation ${outcome} is local settlement, not owner-removal success`, async () => {
        const f = await connectedPair(draft);
        let publication: IncomingPublish | undefined;
        f.server.onPublish = p => { publication = p; void f.server.acceptSubscribe(p.requestId, p.trackAlias); };
        Object.assign(f.b, { createStreamError: (code: number) => Object.assign(new Error('malformed'), { streamErrorCode: code }) });
        let restore: { mockRestore(): void } | undefined;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        try {
          const id = await f.client.publish(ns('source-proof'), nm('video'), 41n);
          const sid = await f.client.openSubgroup(41n, 7n, 0n);
          await f.client.sendObject(sid, 0n, new Uint8Array([1]));
          await flush(128);
          expect(publication!.largestLocation).toEqual({ groupId: 7n, objectId: 0n });
          const internal = f.server as unknown as {
            inboundRequestContexts: Map<bigint, { reader: ReadableStreamDefaultReader<Uint8Array> }>;
            incomingSubgroupAliases: Map<bigint, bigint>;
            dataStreamReaders: Map<bigint, ReadableStreamDefaultReader<Uint8Array>>;
          };
          const incomingId = [...internal.incomingSubgroupAliases].find(([, alias]) => alias === 41n)?.[0];
          expect(incomingId).toBeDefined();
          const reader = target === 'request' ? internal.inboundRequestContexts.get(id)!.reader
            : internal.dataStreamReaders.get(incomingId!)!;
          const cancel = reader.cancel.bind(reader);
          let calls = 0;
          restore = vi.spyOn(reader, 'cancel').mockImplementation(async reason => {
            calls++;
            if (outcome === 'reject') throw new Error('local cancellation refused');
            if (outcome === 'hold') await held;
            await cancel(reason);
          });
          let logicallyClosed = false;
          void publication!.closed.then(() => { logicallyClosed = true; });
          const started = performance.now();
          const result = f.server.cancelMalformedIncomingPublish(publication!).then(value => ({ value }), error => ({ error }));
          await flush(128);
          expect(logicallyClosed).toBe(true);
          expect(f.server.session.getIncomingSubscription(id)).toBeUndefined();
          const final = await result;
          expect(calls).toBe(1);
          if (outcome === 'ok') {
            expect(final).toEqual({ value: { status: 'cancel-issued' } });
            expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
          } else {
            expect(final).toHaveProperty('error');
            expect(f.server.session.state).toBe(target === 'request' ? SessionState.CLOSED : SessionState.ESTABLISHED);
            if (target === 'request') expect(f.b.closeInfo?.closeCode).toBe(1);
            expect(performance.now() - started).toBeLessThan(2000);
          }
        } finally { release(); restore?.mockRestore(); await f.client.close(); await f.server.close(); }
      });
    }
  }
}
