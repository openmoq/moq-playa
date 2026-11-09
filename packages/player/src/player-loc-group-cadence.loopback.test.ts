import { describe, expect, it } from 'vitest';
import { liveLocFixture } from '../test-support/live-loc.js';
import type { MoqtPlayer } from './player.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { encodeFetchHeader, encodeFetchObject, FetchFlags, FetchSubgroupMode, varint } from '@openmoq/transport';
import { flush } from '../../webtransport/src/testkit/loopback.js';

// The private duration drives the existing buffered-Group approximation;
// these tests do not claim a rendered-buffer or ABR decision measurement.
const duration = (player: MoqtPlayer) =>
  (player as unknown as { readonly estimatedGopDurationUs: number }).estimatedGopDurationUs;

type Fixture = Awaited<ReturnType<typeof liveLocFixture>>;
type CachedStart = { group: bigint; timestamp?: bigint };
const payload = Uint8Array.of(0, 0, 0, 1, 0x65);
function headers(f: Fixture, timestamp?: bigint) {
  const extensions = encodeLocHeaders({ ...(timestamp === undefined ? {} : { captureTimestamp: timestamp }),
    videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: true,
      discardable: false, baseLayerSync: false, temporalId: 0 } },
  { wireProfile: locWireProfileForDraft(f.draft) });
  if (!extensions) throw new Error('Fixture expected LOC marking extensions');
  return extensions;
}
async function liveStart(f: Fixture, group: bigint, timestamp: bigint) {
  const stream = await f.server.openSubgroup(77n, group, 0n, { publisherPriority: 128, hasExtensions: true });
  await f.server.sendObject(stream, 0n, payload, headers(f, timestamp));
  await f.server.closeSubgroup(stream); await flush(256);
}

async function publicHistory(f: Fixture, rows: readonly CachedStart[]) {
  const receipts: Array<{ group: bigint; object: bigint }> = [];
  const stop = f.player.on('media_object', event => {
    if (event.trackName === 'v' && event.groupId >= 13n) receipts.push({ group: event.groupId, object: event.objectId });
  });
  const jobs: Promise<void>[] = [];
  const requests: bigint[] = [];
  f.server.onFetch = (id, message) => {
    const job = (async () => {
      requests.push(id);
      expect(message.fetch.fetchType).toBe(1);
      if (message.fetch.fetchType !== 1) throw new Error('Expected standalone public FETCH');
      expect(new TextDecoder().decode(message.fetch.trackName)).toBe('v');
      expect(message.fetch.trackNamespace.map(field => new TextDecoder().decode(field))).toEqual(['live']);
      expect(message.fetch.startLocation).toEqual({ group: 13n, object: 0n });
      expect(message.fetch.endLocation).toEqual({ group: 15n, object: 0n });
      await f.server.acceptFetch(id, { endOfTrack: 0,
        endLocation: { group: rows.at(-1)!.group, object: f.draft === 22 ? 0n : 1n } });
      if (f.draft === 16) {
        const writer = (await f.b.createUnidirectionalStream()).getWriter();
        await writer.write(encodeFetchHeader({ requestId: id }));
        for (const row of rows) await writer.write(encodeFetchObject({
          flags: varint(FetchFlags.GROUP_ID | FetchFlags.OBJECT_ID | FetchFlags.PRIORITY | FetchFlags.EXTENSIONS | FetchSubgroupMode.EXPLICIT),
          groupId: row.group, subgroupId: 0n, objectId: 0n, publisherPriority: 128,
          isDatagram: false, extensions: headers(f, row.timestamp), payload,
        }));
        await writer.close();
      } else {
        const stream = await f.server.openFetchStream(id);
        for (const row of rows) await f.server.sendFetchObject(stream, {
          groupId: row.group, subgroupId: 0n, objectId: 0n, publisherPriority: 128,
          extensions: headers(f, row.timestamp), payload,
        });
        await f.server.closeFetchStream(stream);
      }
    })();
    jobs.push(job); void job.catch(() => {});
  };
  try {
    const request = await f.player.fetch('v', { startGroup: 13, startObject: 0, endGroup: 15, endObject: 0 });
    await flush(256); await Promise.all(jobs); await flush(256);
    expect(requests).toEqual([request]);
    expect(receipts).toEqual(rows.map(row => ({ group: row.group, object: 0n })));
    expect(f.player.selection.video?.name).toBe('v');
  } finally { stop(); await Promise.all(jobs); }
}

describe.each([16, 18, 22] as const)('LOC cadence through draft %i routing', draft => {
  it('uses half-second source Group spacing instead of the two-second fallback', async () => {
    const f = await liveLocFixture({ disableAudio: true }, draft);
    try {
      f.player.play(); f.player.setAutoQuality(true);
      await f.send('v', 1n); expect(duration(f.player)).toBe(2_000_000);
      f.tick(25); await f.send('v', 2n);
      expect(duration(f.player)).toBe(500_000);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps the fallback with no consecutive source timestamp pair', async () => {
    const f = await liveLocFixture({ disableAudio: true }, draft);
    try {
      f.player.play(); f.player.setAutoQuality(true);
      await f.send('v', 1n); f.tick(25); await f.send('v', 3n);
      expect(duration(f.player)).toBe(2_000_000);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it('retires measured cadence on a mode roundtrip while an idempotent mode call preserves it', async () => {
    const f = await liveLocFixture({ disableAudio: true }, draft);
    try {
      f.player.play(); f.player.setAutoQuality(true);
      await f.send('v', 1n); f.tick(25); await f.send('v', 2n);
      expect(duration(f.player)).toBe(500_000);
      f.player.setAutoQuality(true); expect(duration(f.player)).toBe(500_000);
      f.player.setAutoQuality(false); f.player.setAutoQuality(true);
      expect(duration(f.player)).toBe(2_000_000);
      f.tick(25); await f.send('v', 3n); expect(duration(f.player)).toBe(2_000_000);
      f.tick(25); await f.send('v', 4n); expect(duration(f.player)).toBe(500_000);
    } finally { await f.close(); }
  });

  it('retires measured cadence when paused even without another media object', async () => {
    const f = await liveLocFixture({ disableAudio: true }, draft);
    try {
      f.player.play(); f.player.setAutoQuality(true);
      await f.send('v', 1n); f.tick(25); await f.send('v', 2n);
      expect(duration(f.player)).toBe(500_000);
      f.player.pause(); expect(duration(f.player)).toBe(2_000_000);
      await flush(128);
      const request = f.requestOf('v');
      expect(request).toBeDefined();
      expect(f.server.session.getIncomingSubscription(request!.id)?.forwardState).toBe(0);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(['timestamp-pair', 'missing-timestamps', 'single-start'] as const)
  ('public FETCH %s cannot replace live cadence or suppress later live Groups', async mode => {
    const f = await liveLocFixture({ disableAudio: true }, draft);
    try {
      f.player.play(); f.player.setAutoQuality(true);
      await liveStart(f, 1n, 1_000_000n); await liveStart(f, 2n, 1_500_000n);
      expect(duration(f.player), 'premise: actual live Object0 pair established 500ms').toBe(500_000);
      const rows: CachedStart[] = mode === 'timestamp-pair'
        ? [{ group: 13n, timestamp: 5_000_000n }, { group: 14n, timestamp: 7_000_000n }]
        : mode === 'missing-timestamps' ? [{ group: 13n }, { group: 14n }]
          : [{ group: 13n, timestamp: 5_000_000n }];
      await publicHistory(f, rows);
      expect.soft(duration(f.player), 'historical input cannot change or clear the live measurement').toBe(500_000);
      await liveStart(f, 3n, 2_300_000n);
      expect.soft(duration(f.player), 'cached high Groups cannot suppress the next live source-time pair').toBe(800_000);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

});
