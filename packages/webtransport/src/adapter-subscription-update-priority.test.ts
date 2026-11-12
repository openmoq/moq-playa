import { expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

// Evaluation probes P3/P5: validation must precede both allocation and emission.
for (const draft of [16, 18, 22] as const) {
  for (const confirmed of [false, true]) {
    it(`draft${draft} refuses subscription outside 0-255 before sending; confirmed=${confirmed}`, async () => {
      const f = await connectedPair(draft);
      const updates: bigint[] = [], admitted: bigint[] = [];
      f.server.onMessage = message => { if (message.type === 'REQUEST_UPDATE') updates.push(message.requestId); };
      f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, 41n); };
      f.server.setLargestLocationProvider(() => null);
      try {
        const id = await f.client.subscribe(ns('priority'), nm('video'));
        await flush(128);
        const bytes = () => f.a.bidiOut.map(stream => [...stream.out.writtenBytes()]);
        const before = bytes();
        for (const priority of [-1n, 256n]) {
          if (confirmed) {
            await expect(f.client.requestUpdateConfirmed(id, {
              subscriberPriority: priority, timeoutMs: 200, onRequestId: id => admitted.push(id),
            })).rejects.toMatchObject({ disposition: 'not-sent', cause: expect.any(RangeError) });
          } else {
            await expect(f.client.requestUpdate(id, { subscriberPriority: priority })).rejects.toBeInstanceOf(RangeError);
          }
        }
        await flush(128);
        expect(bytes()).toEqual(before);
        expect(updates).toEqual([]);
        expect(admitted).toEqual([]);
        expect(f.client.session.state).toBe('established');
        expect(f.server.session.state).toBe('established');
        const next = await f.client.requestUpdateConfirmed(id, { subscriberPriority: 7n, timeoutMs: 1000 });
        expect(next.requestId).toBe(id + 2n);
        expect(f.client.session.getSubscription(id)?.currentPriority).toBe(7n);
      } finally { await f.client.close(); await f.server.close(); }
    });
  }
}
