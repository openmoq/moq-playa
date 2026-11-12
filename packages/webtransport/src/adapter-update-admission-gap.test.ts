// RED for repair R1: draft-16 requestUpdateConfirmed whose onRequestId re-entrantly
// allocates another request and then refuses. The update's ID cannot be reclaimed, so
// continuing would put a non-sequential Request ID on the wire (d16 §9.1). Base's
// SUBSCRIBE/FETCH onRequestId closes locally with INTERNAL_ERROR in this case.
import { expect, it } from 'vitest';
import { SessionError } from '@openmoq/transport';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

it('d16 confirmed update: an unreclaimable ID after re-entrant allocation closes locally with INTERNAL_ERROR', async () => {
  const f = await connectedPair(16);
  const ids: bigint[] = [];
  const closes: Array<number | undefined> = [];
  f.client.onClose = code => { closes.push(code); };
  f.server.onMessage = m => { if (m.type === 'SUBSCRIBE') ids.push(BigInt(m.requestId)); };
  f.server.onSubscribe = id => { void f.server.acceptSubscribe(id, id + 40n); };
  f.server.setLargestLocationProvider(() => null);
  try {
    const id = await f.client.subscribe(ns('p'), nm('a'));
    await flush(128);
    let nested: Promise<unknown> | undefined;
    const outcome = await f.client.requestUpdateConfirmed(id, {
      subscriberPriority: 7n, timeoutMs: 1000,
      onRequestId: () => { nested = f.client.subscribe(ns('p'), nm('b')).catch(() => undefined); throw new Error('refuse'); },
    }).then(() => 'resolved', (e: { disposition?: string }) => `rejected:${e.disposition}`);
    await nested; await flush(256);
    expect(outcome).toBe('rejected:not-sent');
    expect(f.client.session.state).toBe('closed');
    expect(closes).toEqual([Number(SessionError.INTERNAL_ERROR)]);
    // No further request continues the broken sequence.
    await expect(f.client.subscribe(ns('p'), nm('c'))).rejects.toThrow();
    expect(ids).toEqual([0n, 4n]);
  } finally { await f.client.close(); await f.server.close(); }
});
