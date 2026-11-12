import { describe, expect, it } from 'vitest';
import { SessionState, varint, type ControlMessage } from '@openmoq/transport';
import type { IncomingPublish, MoqtConnection } from './adapter.js';
import { connectedPair, ns, nm } from './testkit/pair.js';
import { flush } from './testkit/loopback.js';

type SourceResult = { readonly status: 'cancel-issued' | 'already-terminal' };
type PublicationResult = { readonly status: 'done-written' | 'already-terminal' };
interface ProposedApi {
  cancelMalformedIncomingPublish(publication: IncomingPublish): Promise<SourceResult>;
  terminateMalformedPublication(requestId: bigint): Promise<PublicationResult>;
}

// Explicit API-TDD boundary. This does not install a mock method or alter SDK runtime.
function proposed(connection: MoqtConnection): ProposedApi {
  const candidate = connection as MoqtConnection & Partial<ProposedApi>;
  expect(candidate.cancelMalformedIncomingPublish, 'proposed source API is absent on baseline').toBeTypeOf('function');
  expect(candidate.terminateMalformedPublication, 'proposed publisher API is absent on baseline').toBeTypeOf('function');
  if (!candidate.cancelMalformedIncomingPublish || !candidate.terminateMalformedPublication) {
    throw new Error('Proposed APIs unavailable');
  }
  return {
    cancelMalformedIncomingPublish: candidate.cancelMalformedIncomingPublish.bind(connection),
    terminateMalformedPublication: candidate.terminateMalformedPublication.bind(connection),
  };
}

async function fixture(draft: 18 | 22, direction: 'source' | 'subscribe' | 'publish') {
  const pair = await connectedPair(draft);
  const messages: ControlMessage[] = [];
  pair.client.onMessage = message => messages.push(message);
  const publications: IncomingPublish[] = [];
  let ownerId = -1n;
  let factoryCalls = 0;
  Object.assign(pair.b, {
    createStreamError(code: number) {
      factoryCalls++;
      return Object.assign(new Error('malformed track'), { streamErrorCode: code });
    },
  });
  if (direction === 'source') {
    pair.server.onPublish = publication => {
      publications.push(publication);
      void pair.server.acceptSubscribe(publication.requestId, publication.trackAlias);
    };
    ownerId = await pair.client.publish(ns('malformed-source'), nm('video'), 41n);
  } else if (direction === 'publish') {
    pair.client.onPublish = publication => {
      publications.push(publication);
      void pair.client.acceptSubscribe(publication.requestId, publication.trackAlias);
    };
    ownerId = await pair.server.publish(ns('malformed-output'), nm('video'), 7n);
  } else {
    pair.server.onSubscribe = id => { ownerId = id; };
    await pair.client.subscribe(ns('malformed-output'), nm('video'));
    await flush(128);
    await pair.server.acceptSubscribe(ownerId, 7n);
  }
  await flush(128);
  return {
    ...pair, messages, publications, ownerId,
    factoryCalls: () => factoryCalls,
    async dispose() { await pair.client.close(); await pair.server.close(); },
  };
}

for (const draft of [18, 22] as const) {
 describe(`draft ${draft} source cancellation`, () => {
    it('source cancellation settles local issue, fences live ownership, and is not a peer-ACK promise', async () => {
      const f = await fixture(draft, 'source');
      try {
        const publication = f.publications[0]!;
        const output: bigint[] = [];
        publication.onObject = object => output.push(object.objectId);
        const sid = await f.client.openSubgroup(41n, 7n, 0n);
        await f.client.sendObject(sid, 0n, new Uint8Array([1]));
        await flush(128);
        expect(output).toEqual([0n]);
        const api = proposed(f.server);
        const operation = api.cancelMalformedIncomingPublish(publication);
        await publication.closed;
        expect(await operation).toEqual({ status: 'cancel-issued' });
        await flush(128);
        expect(f.server.session.getIncomingSubscription(f.ownerId)).toBeUndefined();
        expect(f.factoryCalls()).toBe(1);
        expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
        expect(await api.cancelMalformedIncomingPublish(publication)).toEqual({ status: 'already-terminal' });
        expect(output).toEqual([0n]);
      } finally { await f.dispose(); }
    });

    it('a retired genuine handle is distinct from a cloned unknown handle', async () => {
      const f = await fixture(draft, 'source');
      try {
        const publication = f.publications[0]!;
        await f.client.publishDone(f.ownerId, varint(0n), 'already done');
        await publication.closed;
        const api = proposed(f.server);
        expect(await api.cancelMalformedIncomingPublish(publication)).toEqual({ status: 'already-terminal' });
        await expect(api.cancelMalformedIncomingPublish({ ...publication })).rejects.toThrow();
        expect(f.factoryCalls()).toBe(0);
      } finally { await f.dispose(); }
    });

    it.each(['absent', 'throw'] as const)('%s binding factory rejects before source mutation; wrapper must retain its invalid-generation fence', async mode => {
      const f = await fixture(draft, 'source');
      try {
        if (mode === 'absent') Reflect.deleteProperty(f.b, 'createStreamError');
        else Object.assign(f.b, { createStreamError() { throw new Error('factory failed'); } });
        const publication = f.publications[0]!;
        const api = proposed(f.server);
        let invalidGeneration = true;
        const outcomes: string[] = [];
        const fail = async () => {
          try {
            await api.cancelMalformedIncomingPublish(publication);
            outcomes.push('cancel-issued');
          } catch {
            outcomes.push('cancel-failed');
            // Relay must retain the fence, surface/escalate explicitly, never mark healthy.
            expect(invalidGeneration).toBe(true);
          }
        };
        await fail();
        expect(outcomes).toEqual(['cancel-failed']);
        expect(invalidGeneration).toBe(true);
        expect(f.server.session.getIncomingSubscription(f.ownerId)).toBeDefined();
        invalidGeneration = false; // fixture cleanup only, not a relay recovery rule
      } finally { await f.dispose(); }
    });
  });
}
