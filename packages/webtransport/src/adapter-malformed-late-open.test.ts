import { describe, expect, it } from 'vitest';
import { SessionState, type ControlMessage } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

/** Existing public failed-update path: no proposed API is involved. */
for (const draft of [18, 22] as const) {
  describe(`draft ${draft} reserved publisher allocation reset proof`, () => {
    for (const resetRejects of [false, true]) {
      it(`a late allocated writer must prove reset before UPDATE_FAILED DONE (reject=${resetRejects})`, async () => {
        const pair = await connectedPair(draft);
        const { client, server, b } = pair;
        const messages: ControlMessage[] = [];
        client.onMessage = message => messages.push(message);
        let inbound = -1n;
        server.onSubscribe = id => { inbound = id; };
        let release!: () => void;
        let pending: Promise<unknown> | undefined;
        let backendWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
        let resetCalls = 0;
        let nativeHeaderWrites = 0;
        try {
          const requestId = await client.subscribe(ns('malformed-proof'), nm('video'), { forward: 1 });
          await flush(128);
          await server.acceptSubscribe(inbound, 7n);
          await flush(128);
          const owner = server.session.getIncomingSubscription(inbound);
          expect(owner).toBeDefined();
          server.setLargestLocationProvider(id => {
            if (id !== inbound || server.session.getIncomingSubscription(id) !== owner) {
              throw new Error('No fixture-owned publication');
            }
            return { group: 5n, object: 1n };
          });
          const original = b.createUnidirectionalStream.bind(b);
          b.createUnidirectionalStream = () => new Promise(resolve => {
            release = () => {
              void original().then(stream => {
                backendWriter = stream.getWriter();
                resolve(new WritableStream<Uint8Array>({
                  write(bytes) {
                    nativeHeaderWrites++;
                    return backendWriter!.write(bytes);
                  },
                  async abort(reason) {
                    resetCalls++;
                    if (resetRejects) throw new Error('Backend refused reset');
                    await backendWriter!.abort(reason);
                  },
                }));
              });
            };
          });
          pending = server.openSubgroup(7n, 0n, 0n).then(
            () => ({ unexpectedSuccess: true }), error => ({ error }),
          );
          await flush(128);
          await client.requestUpdate(requestId, { forward: 0 });
          await flush(128);
          server.setLargestLocationProvider(() => { throw new Error('Fixture source withdrawn'); });
          await client.requestUpdate(requestId, { forward: 1 });
          await flush(128);
          expect(messages.some(message => message.type === 'REQUEST_ERROR')).toBe(true);
          expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toHaveLength(0);
          expect(resetCalls).toBe(0);
          await expect(server.openSubgroup(7n, 1n, 0n)).rejects.toThrow();
          release();
          const result = await pending;
          expect(result).toHaveProperty('error');
          for (let i = 0; i < 16; i++) await flush(128);
          expect(resetCalls).toBe(1);
          expect(nativeHeaderWrites).toBe(0);
          const done = messages.filter(message => message.type === 'PUBLISH_DONE');
          expect.soft(done, 'rejected reset must not become successful operation-barrier proof')
            .toHaveLength(resetRejects ? 0 : 1);
          expect.soft(server.session.state).toBe(resetRejects ? SessionState.CLOSED : SessionState.ESTABLISHED);
          if (!resetRejects) {
            expect(done[0]?.type).toBe('PUBLISH_DONE');
            if (done[0]?.type === 'PUBLISH_DONE') expect(BigInt(done[0].statusCode)).toBe(0x8n);
            expect(pair.errors).toEqual([]);
          }
        } finally {
          if (backendWriter) await backendWriter.abort().catch(() => {});
          await client.close();
          await server.close();
        }
      });
    }
  });
}
