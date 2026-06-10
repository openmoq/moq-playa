/**
 * Toy media-relay smoke: multi-track selective fanout + late-join replay + ABR-style
 * per-subscription cleanup. One process, no browser, no real media.
 *
 *   - publisher publishes a 6-track ladder (catalog + 3 video + 2 audio);
 *   - viewer1 subscribes catalog + video-720 + audio-en; viewer2 subscribes
 *     catalog + video-360 + audio-en — assert EACH subscription receives ONLY its
 *     track's objects (correct routing);
 *   - a late viewer subscribes catalog AFTER publish and gets the cached group (replay);
 *   - viewer1 unsubscribes video-720 (ABR switch); a later video-720 group is NOT
 *     delivered to it, while its other subscriptions stay live (connection open).
 *
 * Forwarding failures surface as missing/extra objects → assertion/timeout → non-zero exit.
 */
import { startRelayServer } from './server.js';
import { connectClient, beginSubscribe, type Subscription } from './client.js';
import { publishTrack, publishGroupObjects } from './publisher.js';
import { certsExist } from './cert.js';
import { MEDIA_TRACKS, trackPayloads } from './demo.js';

const log = (...a: unknown[]) => console.log('[media-smoke]', ...a);

/** Publisher alias per ladder track (distinct, deterministic). */
const aliasOf = (track: string): bigint => 20n + BigInt(MEDIA_TRACKS.indexOf(track as never));

function assertExactly(name: string, sub: Subscription, expected: string[]): void {
  const got = sub.objects.map((o) => o.payload);
  if (got.length !== expected.length || !got.every((p, i) => p === expected[i])) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  }
}

async function main(): Promise<number> {
  if (!certsExist()) {
    log('Missing ./certs — run `pnpm --filter @moqt/example-node-relay gen-cert` first.');
    return 1;
  }

  const srv = await startRelayServer({ port: 0 });
  log(`relay up at ${srv.url}`);

  const viewer1 = await connectClient(srv.url);
  const viewer2 = await connectClient(srv.url);
  const publisher = await connectClient(srv.url);

  try {
    // Phase 1 — selective fanout. Subscribe BOTH viewers BEFORE publishing (live).
    const v1catalog = await beginSubscribe(viewer1.conn, 2, { track: 'catalog', label: 'v1' });
    const v1video = await beginSubscribe(viewer1.conn, 2, { track: 'video-720', label: 'v1' });
    const v1audio = await beginSubscribe(viewer1.conn, 2, { track: 'audio-en', label: 'v1' });
    const v2catalog = await beginSubscribe(viewer2.conn, 2, { track: 'catalog', label: 'v2' });
    const v2video = await beginSubscribe(viewer2.conn, 2, { track: 'video-360', label: 'v2' });
    const v2audio = await beginSubscribe(viewer2.conn, 2, { track: 'audio-en', label: 'v2' });

    for (const track of MEDIA_TRACKS) {
      await publishTrack(publisher.conn, track, aliasOf(track), trackPayloads(track));
    }

    await Promise.all([
      v1catalog.collected, v1video.collected, v1audio.collected,
      v2catalog.collected, v2video.collected, v2audio.collected,
    ]);

    assertExactly('viewer1 catalog', v1catalog, trackPayloads('catalog'));
    assertExactly('viewer1 video-720', v1video, trackPayloads('video-720'));
    assertExactly('viewer1 audio-en', v1audio, trackPayloads('audio-en'));
    assertExactly('viewer2 catalog', v2catalog, trackPayloads('catalog'));
    assertExactly('viewer2 video-360', v2video, trackPayloads('video-360'));
    assertExactly('viewer2 audio-en', v2audio, trackPayloads('audio-en'));
    log('selective fanout ✓ (each subscription received only its track)');

    // Phase 2 — publisher-before-viewer replay. video-1080 was published in Phase 1 but
    // had NO subscribers at publish time, so the relay must have created the track on
    // PUBLISH and cached its latest group. A viewer subscribing now gets that group.
    const viewer3 = await connectClient(srv.url);
    const v3video = await beginSubscribe(viewer3.conn, 2, { track: 'video-1080', label: 'v3-late' });
    await v3video.collected;
    assertExactly('viewer3 (late, publisher-first) video-1080', v3video, trackPayloads('video-1080'));
    log('publisher-before-viewer replay ✓ (video-1080 had no subscribers at publish; cached group delivered to the late viewer)');

    // Phase 3 — ABR cleanup: viewer1 drops video-720, then a later video-720 group must
    // NOT reach it, while its other subscriptions stay live (connection still open).
    await v1video.unsubscribe();
    await new Promise((r) => setTimeout(r, 200)); // let the relay observe onSubscribeClosed
    await publishGroupObjects(publisher.conn, aliasOf('video-720'), 1n, ['video-720#g1-0', 'video-720#g1-1']);
    await new Promise((r) => setTimeout(r, 300)); // give any (erroneous) forward time to arrive

    if (v1video.objects.length !== 2) {
      throw new Error(`ABR cleanup failed: viewer1 still received video-720 after unsubscribe (${v1video.objects.length} objects)`);
    }
    // viewer1's OTHER subscriptions are unaffected: republish catalog group 1 and confirm it arrives.
    await publishGroupObjects(publisher.conn, aliasOf('catalog'), 1n, ['catalog#g1-0']);
    await new Promise((r) => setTimeout(r, 300));
    if (v1catalog.objects.length !== 3) {
      throw new Error(`viewer1 catalog should stay live after the ABR switch (got ${v1catalog.objects.length} objects, want 3)`);
    }
    log('ABR cleanup ✓ (dropped only video-720; catalog/audio stayed live, connection open)');

    log('RESULT: multi-track selective fanout + late-join replay + ABR per-sub cleanup. PASS.');
    await viewer3.close();
    return 0;
  } catch (err) {
    log('RESULT: FAIL —', (err as Error).message);
    return 1;
  } finally {
    await viewer1.close();
    await viewer2.close();
    await publisher.close();
    srv.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('[media-smoke] crashed:', err); process.exit(1); });
