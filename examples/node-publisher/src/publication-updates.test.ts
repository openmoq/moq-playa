import { describe, expect, it } from 'vitest';
import { MoqtConnection } from '@openmoq/webtransport';
import { MessageParam, varint } from '@openmoq/transport';
import { createLoopback, flush } from '../../../packages/webtransport/src/testkit/loopback.js';
import { publishFixture } from './publisher.js';
import { videoInit, buildChunk, SYNC_FLAGS } from '../../../packages/locmaf/test-support/cmaf.js';
import type { LoadedFixture } from './fixture.js';

const fixture: LoadedFixture = {
  manifest: { namespace: ['demo'], renderGroup: 1, chunkDurationMs: 1000, tracks: [] },
  tracks: [{ meta: { name: 'video', packaging: 'cmaf', role: 'video', codec: 'avc1.42c01e', init: 'init.mp4', chunks: [] },
    initData: videoInit(), chunks: [buildChunk({ bmdt: 0, samples: [{ duration: 90000, size: 8, flags: SYNC_FLAGS }], mdat: new Uint8Array(8) })] }],
};

describe.each([18, 22] as const)('actual fixture publication metadata draft %i', draft => {
  it('confirms priority and pause/resume with the source head after publishing group one', async () => {
    const { a, b } = createLoopback();
    const publisher = new MoqtConnection(draft), subscriber = new MoqtConnection(draft, { role: 'server' });
    const requests = new Map<string, bigint>();
    const received: { alias: bigint; group: bigint; object: bigint }[] = [];
    const errors: unknown[] = [];
    publisher.onError = subscriber.onError = error => errors.push(error);
    subscriber.onPublish = publication => {
      requests.set(new TextDecoder().decode(publication.trackName), publication.requestId);
      publication.onObject = object => { if (object.kind === 'data') received.push({ alias: object.trackAlias, group: object.groupId, object: object.objectId }); };
      // Existing establishTrack installs its acceptance waiter after publish returns.
      // Keep that separately recorded registration race out of this metadata test.
      setImmediate(() => { void subscriber.acceptSubscribe(publication.requestId, publication.trackAlias); });
    };
    await Promise.all([publisher.connect(a), subscriber.connect(b)]);
    try {
      await publishFixture(publisher, fixture, { startLoop: 1 });
      await flush(64);
      expect(received.filter(object => object.alias === 11n)).toEqual([{ alias: 11n, group: 1n, object: 0n }]);
      const id = requests.get('video')!;
      for (const change of [{ subscriberPriority: varint(7n) }, { forward: 0 }, { forward: 1 }] as const) {
        const result = await subscriber.requestUpdateConfirmed(id, { ...change, timeoutMs: 1000 });
        expect(result.parameters.get(MessageParam.LARGEST_OBJECT as bigint)?.[0]).toEqual({ group: 1n, object: 0n });
      }
      expect(publisher.session.getOutgoingPublish(id)?.isTerminated).toBe(false);
      expect(errors).toEqual([]);
    } finally { await Promise.all([publisher.close(), subscriber.close()]); }
  });
});
