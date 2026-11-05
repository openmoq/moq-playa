import { expect, it } from 'vitest';
import { buildChunk, SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { mediaSelectionMseFixture, mseMediaRefs } from '../test-support/media-selection-mse.js';

it('composes a later audio selection with the actual placement adopted by a program switch', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    void f.player.mediaTimelineReference; await f.sendOld(1_000_040_000n, 1n);
    const old = f.player.mediaTimelineReference;
    expect(old).not.toBeNull();
    const program = f.player.selectMedia({ renderGroup: 2,
      videoTrack: mseMediaRefs.nextVideo, audioTrack: mseMediaRefs.nextAudio }, { timeline: {
      kind: 'reference-map', referenceToken: old!.token,
      video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
      audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n },
    } });
    await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
    await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n); await program;
    expect(f.sourceAppends.filter(append => append.media === 'audio').at(-1)?.presentationTimeUs).toBe(80000n);

    const alternate = { name: 'audio', namespace: ['program', 'two', 'alternate-sound'] };
    const catalog = JSON.parse(new TextDecoder().decode(f.catalog));
    const target = catalog.tracks.find((track: { namespace: string }) => track.namespace === mseMediaRefs.nextAudio.namespace.join('/'));
    expect(target).toBeDefined();
    catalog.tracks.push({ ...target, name: alternate.name, namespace: alternate.namespace.join('/'), lang: 'es' });
    await f.wire.send(mseMediaRefs.catalog, new TextEncoder().encode(JSON.stringify(catalog)), 2n);
    await flush(512);
    const current = f.player.audioTimelineReference;
    expect(current).toMatchObject({ track: { name: mseMediaRefs.nextAudio.name,
      namespaceFields: mseMediaRefs.nextAudio.namespace }, observedSourceTimeUs: 900_080_000n });
    const selecting = f.player.selectAudioTrack(alternate, { timeline: { kind: 'reference-map', referenceToken: current!.token,
      sourceTimeUs: 700_000_000n, referenceTimeUs: 900_000_000n } });
    await flush(512); await f.wire.accept(alternate, 400n);
    const chunk = buildChunk({ trackId: 21, bmdt: 33_604_800n,
      samples: [{ duration: 960, size: 4, flags: SYNC_FLAGS }], mdat: Uint8Array.of(61, 2, 3, 4) });
    await f.wire.send(alternate, chunk, 2000n); await selecting;
    expect(f.player.selection.audio).toEqual({ name: alternate.name, namespaceFields: alternate.namespace });
    expect(f.sourceAppends.at(-1)).toMatchObject({ marker: 61, media: 'audio', presentationTimeUs: 100000n });
    expect(f.errors).toEqual([]); expect(f.transportCalls).toHaveLength(1);
  } finally { await f.destroy(); }
});
