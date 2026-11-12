import { describe, expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

// Oracle A2: an unknown head is not an empty track; refusal ends only its owner.
describe.each([16, 18, 22] as const)('draft-%i update head', draft => {
  it.each(['missing', 'throw', 'invalid'] as const)('refuses %s head with ERROR then DONE', async mode => {
    const f = await connectedPair(draft);
    const received: string[] = [];
    f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, id + 40n); };
    f.client.onMessage = m => { received.push(m.type); };
    try {
      const id = await f.client.subscribe(ns('head'), nm('video'));
      await flush(128);
      if (mode !== 'missing') f.server.setLargestLocationProvider(() => {
        if (mode === 'throw') throw new Error('source gone');
        return false as never;
      });
      await f.client.requestUpdate(id, { subscriberPriority: 7n });
      await flush(256);
      expect(received.filter(t => t === 'REQUEST_ERROR' || t === 'PUBLISH_DONE')).toEqual(['REQUEST_ERROR', 'PUBLISH_DONE']);
      expect(f.client.session.getSubscription(id)?.isTerminated ?? true).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.client.close(); await f.server.close(); }
  });
});
