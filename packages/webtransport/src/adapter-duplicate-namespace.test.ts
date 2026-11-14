import { expect, it } from 'vitest';
import { NamespaceState, SessionState } from '@openmoq/transport';
import { connectedPair, ns } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

for (const draft of [18, 22, 23] as const) {
  it(`draft${draft} duplicate PUBLISH_NAMESPACE survives either first withdrawal (§4.1)`, async () => {
    for (const first of [0, 1]) {
      const { client, server, errors } = await connectedPair(draft);
      const closed: bigint[] = [];
      client.onPublishNamespaceClosed = id => { closed.push(id); };
      server.onSubscribeNamespace = id => { void server.acceptSubscribeNamespace(id); };
      try {
        const subscription = await client.subscribeNamespace(ns('live'));
        await flush();
        const ids = [await server.publishNamespace(ns('live', 'video')), await server.publishNamespace(ns('live', 'video'))];
        await flush();
        const state = client.session.getNamespaceSubscription(subscription)!;
        expect(state.discoveredNamespaces).toEqual([ns('live', 'video'), ns('live', 'video')]);
        await server.publishNamespaceDone(ids[first]!);
        await flush();
        expect(closed).toEqual([ids[first]]);
        expect(state.discoveredNamespaces).toEqual([ns('live', 'video')]);
        expect(state.state).toBe(NamespaceState.ACTIVE);
        await server.publishNamespaceDone(ids[1 - first]!);
        await flush();
        expect(closed).toEqual([ids[first], ids[1 - first]]);
        expect(state.discoveredNamespaces).toEqual([]);
        expect(client.session.state).toBe(SessionState.ESTABLISHED);
        expect(errors).toEqual([]);
      } finally { await client.close(); await server.close(); }
    }
  });
}
