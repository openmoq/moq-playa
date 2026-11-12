import { describe, expect, it } from 'vitest';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

describe.each([18, 22] as const)('draft-%i terminal crossing', draft => {
  it('keeps sessions and sibling delivery alive when DONE crosses an update', async () => {
    const f = await connectedPair(draft);
    f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, id + 40n); };
    f.server.setLargestLocationProvider(() => null);
    try {
      const sub = await f.client.subscribeTrack(ns('cross'), nm('a'));
      const pipe = f.a.bidiOut.at(-1)!;
      const sibling = await f.client.subscribeTrack(ns('cross'), nm('b'));
      let delivered = 0;
      sibling.onObject = () => { delivered++; };
      pipe.out.faults.hold = true;
      await f.client.requestUpdate(sub.requestId, { subscriberPriority: 9n });
      await f.server.publishDone(sub.requestId, 0n, 'ended'); await flush(128);
      pipe.out.releaseHeld(); await flush(128);
      const stream = await f.server.openSubgroup(sibling.trackAlias, 1n, 0n);
      await f.server.sendObject(stream, 0n, Uint8Array.of(1)); await f.server.closeSubgroup(stream);
      await flush(128);
      expect(delivered).toBe(1);
      expect(f.client.session.state).toBe('established');
      expect(f.server.session.state).toBe('established');
      expect(f.errors).toEqual([]);
      await expect(f.client.requestUpdate(sub.requestId, {})).rejects.toThrow();
    } finally { await f.client.close(); await f.server.close(); }
  });
});
