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
  expect(candidate.terminateMalformedPublication, 'proposed publisher API is absent on baseline').toBeTypeOf('function');
  if (!candidate.terminateMalformedPublication) {
    throw new Error('Proposed APIs unavailable');
  }
  return {
    cancelMalformedIncomingPublish: candidate.cancelMalformedIncomingPublish?.bind(connection) as ProposedApi['cancelMalformedIncomingPublish'],
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
 describe(`draft ${draft} malformed publisher termination`, () => {
    for (const direction of ['subscribe', 'publish'] as const) {
      it(`${direction}: open data streams close before exactly one malformed DONE`, async () => {
        const f = await fixture(draft, direction);
        try {
          const sid = await f.server.openSubgroup(7n, 0n, 0n);
          await f.server.sendObject(sid, 0n, new Uint8Array([1]));
          await flush(128);
          const pipe = f.b.uniOut.at(-1)!;
          expect(pipe.writeAborted).toBe(false);
          const api = proposed(f.server);
          const operation = api.terminateMalformedPublication(f.ownerId);
          await expect(f.server.openSubgroup(7n, 1n, 0n)).rejects.toThrow();
          expect(await operation).toEqual({ status: 'done-written' });
          await flush(128);
          expect(pipe.writeAborted).toBe(true);
          const done = f.messages.filter(message => message.type === 'PUBLISH_DONE');
          expect(done).toHaveLength(1);
          if (done[0]?.type === 'PUBLISH_DONE') expect(BigInt(done[0].statusCode)).toBe(0x12n);
          expect(f.server.session.state).toBe(SessionState.ESTABLISHED);
        } finally { await f.dispose(); }
      });

      it(`${direction}: known ordinary terminal wins; unknown ID is not proven terminal`, async () => {
        const f = await fixture(draft, direction);
        try {
          await f.server.publishDone(f.ownerId, varint(2n), 'normal end');
          await flush(128);
          const api = proposed(f.server);
          expect(await api.terminateMalformedPublication(f.ownerId)).toEqual({ status: 'already-terminal' });
          await expect(api.terminateMalformedPublication(999_999n)).rejects.toThrow();
          const done = f.messages.filter(message => message.type === 'PUBLISH_DONE');
          expect(done).toHaveLength(1);
          if (done[0]?.type === 'PUBLISH_DONE') expect(BigInt(done[0].statusCode)).toBe(2n);
          expect(f.factoryCalls()).toBe(0);
        } finally { await f.dispose(); }
      });
    }

    it('an incoming PUBLISH is wrong direction for downstream termination and remains deliverable', async () => {
      const f = await fixture(draft, 'source');
      try {
        const api = proposed(f.server);
        await expect(api.terminateMalformedPublication(f.ownerId)).rejects.toThrow();
        expect(f.factoryCalls()).toBe(0);
        const output: bigint[] = [];
        f.publications[0]!.onObject = object => output.push(object.objectId);
        const sid = await f.client.openSubgroup(41n, 7n, 0n);
        await f.client.sendObject(sid, 0n, new Uint8Array([1]));
        await flush(128);
        expect(output).toEqual([0n]);
      } finally { await f.dispose(); }
    });

  });
}
