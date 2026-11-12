/** Real transport and player pipelines with modeled decoder/source outputs. */
import { describe, expect, it } from 'vitest';
import { MessageParam, type Fetch, type Parameters } from '@openmoq/transport';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { parseLocmafTrackContext, serializeLocmafObject } from '@openmoq/locmaf';
import { buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { audioSelectionFixture, refs } from '../test-support/audio-selection.js';

for (const path of ['cmaf', 'loc', 'locmaf-mse', 'locmaf-frame'] as const) {
  describe(`handover playback watermark: ${path}`, () => {
    it('backfills an old transform still pending after initial playback', async () => {
      const f = await audioSelectionFixture(18, { path });
      const next = f.peers[1]!;
      const fetches: Array<{ id: bigint; message: Fetch }> = [];
      next.server.onFetch = (id, message) => { fetches.push({ id, message }); };
      const count = () => path === 'cmaf' || path === 'locmaf-mse'
        ? f.sourceAppends.filter(item => item.media === 'audio').length : f.decodedAudio.length;
      const initial = count();
      expect(initial).toBeGreaterThan(0);
      const release = f.holdTransform(201n);
      const packet = (object: bigint) => {
        const pts = 10_000_000n + object * 20_000n;
        if (path === 'loc') return { payload: Uint8Array.of(0x48, 21, Number(object)),
          extensions: encodeLocHeaders({ captureTimestamp: pts }, { wireProfile: locWireProfileForDraft(18) }) };
        const context = parseLocmafTrackContext(f.headers.english);
        const bytes = buildChunk({ trackId: context.trackId, bmdt: pts * BigInt(context.timescale) / 1_000_000n,
          samples: [{ duration: context.timescale / 50, size: 4, flags: SYNC_FLAGS }],
          mdat: Uint8Array.of(21, Number(object), 3, 4) });
        return { payload: path === 'cmaf' ? bytes : serializeLocmafObject({ kind: 'rawBoxes', boxes: bytes }) };
      };
      try {
        await f.sendAudio('english', 70n, 1n, 10_020_000n);
        expect(count()).toBe(initial);
        const migrating = f.player.migrate(next.client);
        void migrating.catch(() => {});
        await flush(256);
        await next.accept(refs.catalog, 500n);
        await next.send(refs.catalog, f.catalog, 1n);
        await next.accept(refs.video, 300n);
        await next.server.acceptSubscribe(next.request(refs.english).id, 301n, {
          parameters: new Map([[MessageParam.LARGEST_OBJECT, [{ group: 70n, object: 1n }]]]) as Parameters,
        });
        await migrating;
        release(); await flush(256);
        expect(fetches).toHaveLength(1);
        expect(fetches[0]!.message.fetch).toMatchObject({ fetchType: 3, joiningStart: 70n });
        await next.server.acceptFetch(fetches[0]!.id, { endLocation: { group: 70n, object: 2n } });
        const history = await next.server.openFetchStream(fetches[0]!.id);
        await next.server.sendFetchObject(history, { groupId: 70n, subgroupId: 0n, objectId: 1n,
          publisherPriority: 128, ...packet(1n) });
        await next.server.closeFetchStream(history); await flush(256);
        const live = packet(2n);
        const stream = await next.server.openSubgroup(301n, 70n, 0n, { publisherPriority: 128, hasExtensions: 'extensions' in live });
        await next.server.sendObject(stream, 2n, live.payload, live.extensions);
        await next.server.closeSubgroup(stream); await flush(256); f.tick(2);
        expect(f.mediaObjects.filter(item => item.name === refs.english.name).map(item => item.object)).toEqual([0n, 1n, 2n]);
        expect(count()).toBe(initial + 2);
        expect(f.errors).toEqual([]);
      } finally { release(); await f.destroy(); }
    });
  });
}
