import { expect, it } from 'vitest';
import { buildChunk, NON_SYNC_FLAGS } from '../../locmaf/test-support/cmaf.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { mediaSelectionMseFixture, mseMediaRefs, mseMediaTracks } from '../test-support/media-selection-mse.js';

it('keeps reordered target media before the prepared access point out of the adopted MSE output', async () => {
  const f = await mediaSelectionMseFixture();
  try {
    expect(f.player.mediaTimelineReference).toBeNull();
    await f.sendOld(1_000_040_000n, 1n);
    const reference = f.player.mediaTimelineReference;
    expect(reference).not.toBeNull();
    const selecting = f.player.selectMedia({ renderGroup: 2,
      videoTrack: mseMediaRefs.nextVideo, audioTrack: mseMediaRefs.nextAudio }, { timeline: {
      kind: 'reference-map', referenceToken: reference!.token,
      video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
      audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n },
    } });
    await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
    await f.send('nextVideo', 90_080_000n); await f.send('nextAudio', 900_080_000n);
    await selecting;
    const before = f.sourceAppends.length;
    // This source intentionally exposes no getCommittedGroupFloor. Preparation
    // owns its chosen access point even before native append completion exists.
    const earlier = buildChunk({ trackId: 11, bmdt: 8_105_400n,
      samples: [{ duration: 1800, size: 4, flags: NON_SYNC_FLAGS }], mdat: Uint8Array.of(31, 99, 3, 4) });
    await f.wire.send(mseMediaRefs.nextVideo, earlier, mseMediaTracks.nextVideo.group - 1n, 1n);
    await flush(512);
    expect(f.sourceAppends.slice(before)).toEqual([]);
    await f.send('nextVideo', 90_100_000n, 1n);
    expect(f.sourceAppends.slice(before)).toHaveLength(1);
    expect(f.sourceAppends.at(-1)).toMatchObject({ marker: 31, presentationTimeUs: 100000n });
    expect(f.errors).toEqual([]); expect(f.transportCalls).toHaveLength(1);
  } finally { await f.destroy(); }
});

it.each([false, true])('keeps adopted output after an obsolete held transform settles: rejection=%s', async rejectOld => {
  const f = await mediaSelectionMseFixture({ transform: object => {
    if (rejectOld && object.trackAlias === mseMediaTracks.nextVideo.alias && object.groupId < mseMediaTracks.nextVideo.group) {
      throw new Error('Obsolete input transform failed');
    }
    return object;
  } });
  try {
    f.player.play(); void f.player.mediaTimelineReference; await f.sendOld(1_000_040_000n, 1n);
    const reference = f.player.mediaTimelineReference;
    expect(reference).not.toBeNull();
    const selecting = f.player.selectMedia({ renderGroup: 2,
      videoTrack: mseMediaRefs.nextVideo, audioTrack: mseMediaRefs.nextAudio }, { timeline: {
      kind: 'reference-map', referenceToken: reference!.token,
      video: { sourceTimeUs: 90_000_000n, referenceTimeUs: 1_000_000_000n },
      audio: { sourceTimeUs: 900_000_000n, referenceTimeUs: 1_000_000_000n },
    } });
    await flush(512); await f.accept('nextVideo'); await f.accept('nextAudio');
    await f.send('nextVideo', 90_080_000n);
    const release = f.hold('nextVideo');
    await f.wire.send(mseMediaRefs.nextVideo, f.chunk('nextVideo', 90_060_000n), mseMediaTracks.nextVideo.group - 1n, 0n);
    await flush(512); await f.send('nextAudio', 900_080_000n); await selecting;
    const adopted = f.player.selection, before = f.sourceAppends.length;
    release(); await flush(1024);
    expect(f.sourceAppends).toHaveLength(before); expect(f.player.selection).toEqual(adopted);
    expect(f.wire.stopped).not.toContain(f.wire.request(mseMediaRefs.nextVideo).id);
    expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});
