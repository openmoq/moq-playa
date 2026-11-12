import { expect, it } from 'vitest';
import { SessionState, type ControlMessage } from '@openmoq/transport';
import type { MalformedPublicationTerminationResult } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [18, 22] as const) {
  for (const malformedFirst of [false, true]) {
    it(`draft ${draft} malformed versus failed update has one terminal cause, malformedFirst=${malformedFirst}`, async () => {
      const f = await connectedPair(draft);
      let id = -1n;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const messages: ControlMessage[] = [];
      f.server.onSubscribe = value => { id = value; };
      f.client.onMessage = message => messages.push(message);
      try {
        const requestId = await f.client.subscribe(ns('terminal-cause'), nm('video'));
        await flush(128); await f.server.acceptSubscribe(id, 7n); await flush(128);
        const owner = f.server.session.getIncomingSubscription(id);
        f.server.setLargestLocationProvider(value => {
          if (value !== id || f.server.session.getIncomingSubscription(id) !== owner) throw new Error('Owner unavailable');
          return { group: 5n, object: 1n };
        });
        await f.server.openSubgroup(7n, 0n, 0n);
        await f.client.requestUpdate(requestId, { forward: 0 });
        await flush(128);
        f.server.setLargestLocationProvider(() => { throw new Error('Exact source unavailable'); });
        let resetCalls = 0;
        let factoryCalls = 0;
        Object.assign(f.b, {
          createStreamError(code: number) { factoryCalls++; return Object.assign(new Error('malformed'), { streamErrorCode: code }); },
          async resetSendStream(writer: WritableStreamDefaultWriter<Uint8Array>, reason: unknown) {
            resetCalls++; await held; await writer.abort(reason);
          },
        });
        let malformed: Promise<MalformedPublicationTerminationResult>;
        if (malformedFirst) {
          malformed = f.server.terminateMalformedPublication(id);
          await f.client.requestUpdate(requestId, { forward: 1 });
        } else {
          await f.client.requestUpdate(requestId, { forward: 1 });
          await flush(128);
          expect(resetCalls).toBe(1);
          malformed = f.server.terminateMalformedPublication(id);
        }
        await flush(128);
        expect(resetCalls).toBe(1);
        expect(messages.filter(message => message.type === 'PUBLISH_DONE')).toHaveLength(0);
        release();
        expect(await malformed).toEqual({ status: 'done-written' });
        await flush(128);
        const done = messages.filter(message => message.type === 'PUBLISH_DONE');
        expect(done).toHaveLength(1);
        if (done[0]?.type === 'PUBLISH_DONE') expect(BigInt(done[0].statusCode)).toBe(malformedFirst ? 0x12n : 0x8n);
        expect(factoryCalls).toBe(malformedFirst ? 1 : 0);
        expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
        // A separate accepted owner still has a working data path after the terminal.
        const received: bigint[] = [];
        const next = f.client.subscribeTrack(ns('terminal-cause'), nm('sibling'), { onObject: object => received.push(object.objectId) });
        await flush(128); await f.server.acceptSubscribe(id, 8n); await next;
        const sid = await f.server.openSubgroup(8n, 9n, 0n);
        await f.server.sendObject(sid, 0n, new Uint8Array([1]));
        await flush(128);
        expect(received).toEqual([0n]);
      } finally { release(); await f.client.close(); await f.server.close(); }
    });
  }
}
