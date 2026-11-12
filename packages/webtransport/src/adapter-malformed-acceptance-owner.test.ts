import { expect, it, vi } from 'vitest';
import { varint } from '@openmoq/transport';
import type { IncomingPublish } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { streamHeader } from './testkit/object-reception.js';
import { flush } from './testkit/loopback.js';

for (const draft of [18, 22] as const) {
  for (const releaseBeforeCancel of [false, true]) {
    it(`draft ${draft} held acceptance cannot overwrite replacement alias policy, releaseBeforeCancel=${releaseBeforeCancel}`, async () => {
      const f = await connectedPair(draft, { serverOptions: { terminatedAliasTtlMs: 20 } });
      const pubs: IncomingPublish[] = [];
      f.server.onPublish = p => { pubs.push(p); };
      Object.assign(f.b, { createStreamError: (code: number) => Object.assign(new Error('malformed'), { streamErrorCode: code }) });
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let writeSpy: { mockRestore(): void } | undefined;
      try {
        const firstPublish = f.client.publish(ns('acceptance-owner'), nm('video'), 41n);
        const firstOutcome = firstPublish.then(value => ({ value }), error => ({ error }));
        await flush(128);
        expect(pubs).toHaveLength(1);
        const old = pubs[0]!;
        const internal = f.server as unknown as {
          inboundRequestContexts: Map<bigint, { writer: WritableStreamDefaultWriter<Uint8Array> }>;
        };
        const writer = internal.inboundRequestContexts.get(old.requestId)!.writer;
        const originalWrite = writer.write.bind(writer);
        let entered = false;
        writeSpy = vi.spyOn(writer, 'write').mockImplementation(async bytes => {
          await originalWrite(bytes); // Actual response bytes reached the peer; local completion is held.
          entered = true;
          await held;
        });
        const acceptance = f.server.acceptSubscribe(old.requestId, 41n, draft === 18 ? {
          parameters: new Map([[0x02n, [varint(17n)]]]),
        } : {}).then(() => ({ accepted: true }), error => ({ error }));
        await flush(128);
        if (!entered) expect(await acceptance).toEqual({ accepted: true });
        expect(entered).toBe(true);
        expect(await firstOutcome).toHaveProperty('value');
        expect(f.server.session.getIncomingSubscription(old.requestId)?.isPending).toBe(false);
        if (releaseBeforeCancel) { release(); expect(await acceptance).toEqual({ accepted: true }); }
        expect(await f.server.cancelMalformedIncomingPublish(old)).toEqual({ status: 'cancel-issued' });
        await old.closed;
        await flush(128);
        writeSpy.mockRestore();
        f.server.onPublish = p => {
          pubs.push(p);
          void f.server.acceptSubscribe(p.requestId, p.trackAlias, draft === 18 ? { parameters: new Map([[0x02n, [varint(3000n)]]]) } : {});
        };
        await f.client.publish(ns('acceptance-owner'), nm('video'), 41n);
        await flush(128);
        expect(pubs).toHaveLength(2);
        const replacement = pubs[1]!;
        const output: bigint[] = [];
        replacement.onObject = item => output.push(item.objectId);
        const sid = await f.client.openSubgroup(41n, 8n, 0n);
        await f.client.sendObject(sid, 0n, new Uint8Array([1]));
        await flush(128);
        expect(output).toEqual([0n]);
        release();
        const settledAcceptance = await acceptance;
        if (!releaseBeforeCancel) expect.soft(settledAcceptance).toHaveProperty('error');
        await flush(128);
        await f.client.sendObject(sid, 1n, new Uint8Array([2]));
        await flush(128);
        expect(output).toEqual([0n, 1n]);
        expect(await f.server.cancelMalformedIncomingPublish(old)).toEqual({ status: 'already-terminal' });
        expect(f.server.session.getIncomingSubscription(replacement.requestId)).toBeDefined();
        await f.client.closeSubgroup(sid);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await f.server.cancelMalformedIncomingPublish(replacement);
        await flush(128);
        await vi.advanceTimersByTimeAsync(25);
        const late = (await f.a.createUnidirectionalStream()).getWriter();
        const pipe = f.a.uniOut.at(-1)!;
        await late.write(streamHeader(draft, { trackAlias: 41n, groupId: 9n }));
        await flush(128);
        expect(pipe.readCancelled).toBe(draft === 18);
        await late.abort().catch(() => {});
      } finally { vi.useRealTimers(); release(); writeSpy?.mockRestore(); await f.client.close(); await f.server.close(); }
    });
  }
}
