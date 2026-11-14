import { describe, expect, it } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { MessageParam, varint } from '@openmoq/transport';
import { Relay } from './relay.js';
import { DEMO_NAMESPACE, DEMO_TRACK, nsBytes, te } from './demo.js';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';

async function pair(draft: 18 | 22, relay: Relay) {
  const { a, b } = createLoopback();
  const client = new MoqtConnection(draft), server = new MoqtConnection(draft, { role: 'server' });
  relay.setupConnection(server);
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, server };
}

describe.each([18, 22] as const)('relay publication metadata draft %i', draft => {
  it('binds a transferring finite FETCH to the actual source head, not its finite end', async () => {
    const relay = new Relay();
    const upstream = await pair(draft, relay), downstream = await pair(draft, relay);
    let accept!: () => void;
    const accepted = new Promise<void>(resolve => { accept = resolve; });
    upstream.server.onPublish = publication => { void relay.handlePublish(upstream.server, publication).then(accept); };
    const namespace = nsBytes(DEMO_NAMESPACE), name = te(DEMO_TRACK);
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    let reachedFin!: () => void;
    const atFin = new Promise<void>(resolve => { reachedFin = resolve; });
    const closeFetch = downstream.server.closeFetchStream.bind(downstream.server);
    downstream.server.closeFetchStream = async id => { reachedFin(); await held; return closeFetch(id); };
    downstream.server.onFetch = (id, fetch) => { void relay.handleFetch(downstream.server, id, fetch); };
    const errors: unknown[] = [];
    for (const connection of [upstream.client, upstream.server, downstream.client, downstream.server]) connection.onError = error => errors.push(error);
    try {
      await upstream.client.publish(namespace, name, 9n);
      await accepted;
      const sid = await upstream.client.openSubgroup(9n, 1n, 0n);
      await upstream.client.sendObject(sid, 0n, Uint8Array.of(1));
      await upstream.client.sendObject(sid, 1n, Uint8Array.of(2));
      await upstream.client.sendObject(sid, 2n, Uint8Array.of(3));
      await upstream.client.closeSubgroup(sid);
      await flush(64);
      const id = await downstream.client.fetch(namespace, name, { startGroup: 1n, startObject: 0n, endGroup: 1n, endObject: 1n });
      await atFin;
      const confirmation = await downstream.client.requestUpdateConfirmed(id, { subscriberPriority: varint(3n), timeoutMs: 1000 });
      expect(confirmation.parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0]).toEqual({ group: 1n, object: 2n });
      expect(errors).toEqual([]);
    } finally {
      finish(); await flush(64);
      await Promise.all([upstream.client.close(), upstream.server.close(), downstream.client.close(), downstream.server.close()]);
    }
  });

  it('does not report an unbound request as an empty publication', async () => {
    const relay = new Relay(), { client, server } = await pair(draft, relay);
    try { expect(() => relay.currentLargestFor(server, 999n)).toThrow(); }
    finally { await Promise.all([client.close(), server.close()]); }
  });
});
