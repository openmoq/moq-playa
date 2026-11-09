/** Real draft-18 requests and CMAF assembly; the source supplies buffer-depth evidence, not native playback. */
import { expect, it } from 'vitest';
import type { AudioRef } from '../test-support/audio-selection.js';
import { identity } from '../test-support/audio-selection.js';
import { mediaSelectionMseFixture, mseMediaRefs } from '../test-support/media-selection-mse.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';

interface CatalogDocument {
  version: number;
  tracks: Array<{ name: string; namespace: string; [property: string]: unknown }>;
}
const higher = { name: 'video', namespace: [...mseMediaRefs.viewVideo.namespace, 'higher'] } as const;
const lower = { name: 'video', namespace: [...mseMediaRefs.viewVideo.namespace, 'lower'] } as const;
const sameRef = (a: AudioRef, b: AudioRef) => a.name === b.name && JSON.stringify(a.namespace) === JSON.stringify(b.namespace);
const sourceKey = (ref: AudioRef) => JSON.stringify([ref.namespace, ref.name]);

it.each([
  { buffer: 'empty', depthUs: 0, downshift: true },
  { buffer: 'healthy', depthUs: 2_000_000, downshift: false },
])('uses the adopted view ladder for automatic MSE adaptation with an $buffer buffer', async ({ depthUs, downshift }) => {
  const f = await mediaSelectionMseFixture({ timeoutMs: 1000 });
  try {
    const catalog = JSON.parse(new TextDecoder().decode(f.catalog)) as CatalogDocument;
    const view = catalog.tracks.find(track => track.namespace === mseMediaRefs.viewVideo.namespace.join('/'));
    if (!view) throw new Error('Fixture has no alternate view');
    catalog.tracks.push({ ...view, namespace: higher.namespace.join('/'), bitrate: 300_000 },
      { ...view, namespace: lower.namespace.join('/'), bitrate: 50_000 });
    await f.wire.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 2n);
    await flush(512);
    f.player.setAutoQuality(true);
    void f.player.mediaTimelineReference;
    await f.sendOld(1_000_040_000n, 1n);
    const reference = f.player.mediaTimelineReference;
    if (!reference) throw new Error('No accepted source reference');
    const audio = f.player.selection.audio, audioRequest = f.wire.request(mseMediaRefs.oldAudio).id;
    const selecting = f.player.selectMedia({ videoAltGroup: 12 }, { timeline: {
      kind: 'reference-map', referenceToken: reference.token,
      video: { sourceTimeUs: 700_000_000n, referenceTimeUs: 1_000_000_000n },
    } });
    void selecting.catch(() => {});
    await flush(512); await f.accept('viewVideo'); await f.send('viewVideo', 700_080_000n); await selecting;
    expect(f.player.selection.video).toEqual(identity(mseMediaRefs.viewVideo));
    expect(f.player.selection.videoAlternatives).toEqual([identity(higher), identity(mseMediaRefs.viewVideo), identity(lower)]);
    expect(f.player.selection.autoQuality).toBe(true);
    expect(f.player.selection.audio).toEqual(audio);
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'video', sourceKey: sourceKey(mseMediaRefs.viewVideo), presentationTimeUs: 80_000n });

    f.player.play();
    expect(f.player.state).toBe('playing');
    const before = f.wire.requests.length;
    f.source.getBufferAheadUs = () => depthUs;
    f.player.tick(); await flush(512);
    const requests = f.wire.requests.slice(before);
    if (downshift) {
      // The request must name the lower member's exact namespace, even though
      // every view member has the same basename as the retired initial video.
      expect(requests.map(({ name, namespace }) => ({ name, namespace }))).toEqual([lower]);
      expect(f.player.selection.video).toEqual(identity(mseMediaRefs.viewVideo));
      const appends = f.sourceAppends.length;
      await f.wire.accept(lower, 401n);
      await f.wire.send(lower, f.chunk('viewVideo', 700_100_000n), 1701n);
      await flush(512);
      expect(f.sourceAppends).toHaveLength(appends + 1);
      expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'video', sourceKey: sourceKey(lower), presentationTimeUs: 100_000n });
      expect(f.player.selection.video).toEqual(identity(lower));
      expect(f.wire.stopped).toContain(f.wire.request(mseMediaRefs.viewVideo).id);
    } else {
      expect(requests).toEqual([]);
      expect(f.player.selection.video).toEqual(identity(mseMediaRefs.viewVideo));
      await f.send('viewVideo', 700_100_000n, 1n);
      expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'video', sourceKey: sourceKey(mseMediaRefs.viewVideo), presentationTimeUs: 100_000n });
      expect(f.wire.stopped).not.toContain(f.wire.request(mseMediaRefs.viewVideo).id);
    }
    expect(f.player.selection.autoQuality).toBe(true);
    expect(f.player.selection.audio).toEqual(audio);
    expect(f.wire.requests.filter(request => sameRef(request, mseMediaRefs.oldAudio))).toHaveLength(1);
    expect(f.wire.stopped).not.toContain(audioRequest);
    await f.send('oldAudio', 1_000_120_000n, 2n);
    expect(f.sourceAppends.at(-1)).toMatchObject({ media: 'audio', sourceKey: sourceKey(mseMediaRefs.oldAudio), presentationTimeUs: 120_000n });
    expect(f.transportCalls).toHaveLength(1);
    expect(f.errors).toEqual([]); expect(f.wire.errors).toEqual([]);
  } finally { await f.destroy(); }
});
