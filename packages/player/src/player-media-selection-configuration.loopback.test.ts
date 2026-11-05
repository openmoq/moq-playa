import { expect, it } from 'vitest';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';
import { mediaRefs, mediaTracks, mediaSelectionFixture } from '../test-support/media-selection.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

it.each([false, true])('preflights replayed pre-RAP configuration before retiring old output: changed=%s', async changed => {
  const f = await mediaSelectionFixture();
  try {
    void f.player.mediaTimelineReference; await f.sendOld(10_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!;
    const before = f.player.selection;
    const configurations = () => f.decoderEvents.flatMap(event => event.media === 'video' && event.kind === 'configure' ? [event.bytes] : []);
    const original = configurations().at(-1)!.slice(), config = original.slice();
    if (changed) config[3] = config[3]! ^ 1;
    const state = { status: 'pending', error: undefined as unknown };
    const selecting = f.player.selectMedia({ videoAltGroup: 12 }, { timeline: { kind: 'reference-map', referenceToken: reference.token,
      video: { sourceTimeUs: 700_000_000n, referenceTimeUs: 10_000_000n } } });
    void selecting.then(() => { state.status = 'fulfilled'; }, error => { state.status = 'rejected'; state.error = error; });
    await flush(512); await f.accept('viewVideo');
    await f.wire.send(mediaRefs.viewVideo, Uint8Array.of(0, 0, 0, 1, 0x41, mediaTracks.viewVideo.marker),
      mediaTracks.viewVideo.group, 1n, encodeLocHeaders({ timestamp: 31_502_700n, timescale: 45_000n, videoConfig: config,
        videoFrameMarking: { independent: false, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) }));
    // The late join omitted the preceding independent Object 0. The next
    // group begins with its own independently decodable Object 0 (LOC-04).
    await flush(512);
    await f.wire.send(mediaRefs.viewVideo, Uint8Array.of(0, 0, 0, 1, 0x65, mediaTracks.viewVideo.marker),
      mediaTracks.viewVideo.group + 1n, 0n, encodeLocHeaders({ timestamp: 31_503_600n, timescale: 45_000n,
        videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
          discardable: false, baseLayerSync: false, temporalId: 0 } }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) }));
    f.tick(0); await flush(512);
    if (changed) {
      expect.soft(state.status, String(state.error)).toBe('rejected');
      expect.soft(configurations().some(bytes => bytes.length === config.length && bytes.every((v, i) => v === config[i]))).toBe(false);
      expect.soft(f.player.selection).toEqual(before);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.oldVideo).id);
    } else {
      expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
      expect(f.enqueuedVideo.at(-1)?.key).toBe('viewVideo');
      expect(f.errors).toEqual([]);
    }
  } finally { await f.destroy(); }
});

it.each([false, true])('preflights a later valid RAP config while both outputs are required: changed=%s', async changed => {
  const f = await mediaSelectionFixture();
  try {
    void f.player.mediaTimelineReference; await f.sendOld(10_040_000n, 1n);
    const reference = f.player.mediaTimelineReference!, before = f.player.selection;
    const configurations = () => f.decoderEvents.flatMap(event => event.media === 'video' && event.kind === 'configure' ? [event.bytes] : []);
    const original = configurations().at(-1)!.slice(), config = original.slice();
    if (changed) config[3] = config[3]! ^ 1;
    const release = f.hold('nextAudio'), state = { status: 'pending', error: undefined as unknown };
    const selecting = f.player.selectMedia({ renderGroup: 2, videoTrack: mediaRefs.nextVideo, audioTrack: mediaRefs.nextAudio },
      { timeline: { kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 10_000_000n },
        audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 10_000_000n } } });
    void selecting.then(() => { state.status = 'fulfilled'; }, error => { state.status = 'rejected'; state.error = error; });
    await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
    for (const [group, ticks, bytes] of [
      [mediaTracks.nextVideo.group, 5_403_600n, original],
      [mediaTracks.nextVideo.group + 1n, 5_404_800n, config],
    ] as const) {
      const stream = await f.wire.server.openSubgroup(mediaTracks.nextVideo.alias, group, 0n,
        { publisherPriority: 128, hasExtensions: true, endOfGroup: true });
      await f.wire.server.sendObject(stream, 0n, Uint8Array.of(0, 0, 0, 1, 0x65, mediaTracks.nextVideo.marker),
        encodeLocHeaders({ timestamp: ticks, timescale: 60_000n, videoConfig: bytes,
          videoFrameMarking: { independent: true, startOfFrame: true, endOfFrame: true,
            discardable: false, baseLayerSync: false, temporalId: 0 } }, { locVersion: 4, wireProfile: locWireProfileForDraft(18) }));
      await f.wire.server.closeSubgroup(stream); await flush(512);
    }
    await f.send('nextAudio', 900_080_000n);
    expect(state.status).toBe('pending'); expect(f.player.selection).toEqual(before);
    expect(f.decodedVideo.filter(point => point.key === 'nextVideo')).toHaveLength(0);
    release(); await flush(512); f.tick(0); await flush(512);
    if (changed) {
      expect.soft(state.status, String(state.error)).toBe('rejected');
      expect.soft(configurations().some(bytes => bytes.length === config.length && bytes.every((v, i) => v === config[i]))).toBe(false);
      expect.soft(f.player.selection).toEqual(before);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.oldVideo).id);
      expect(f.wire.stopped).not.toContain(f.wire.request(mediaRefs.oldAudio).id);
    } else {
      expect(state.status, String(state.error)).toBe('fulfilled'); await selecting;
      expect(f.decodedVideo.filter(point => point.key === 'nextVideo')).toHaveLength(2);
      expect(f.scheduledAudio.at(-1)?.key).toBe('nextAudio');
      expect(f.errors).toEqual([]);
    }
  } finally { await f.destroy(); }
});
