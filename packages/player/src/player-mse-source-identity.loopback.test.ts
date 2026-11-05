import { expect, it } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import type { MediaSourceLike } from './interfaces.js';
import { audioSelectionFixture, refs } from '../test-support/audio-selection.js';

it('keeps exact source identities when legacy audio selection uses a capable MSE chain', async () => {
  const appends: Array<{ media: string; name: string; sourceKey: string | undefined }> = [];
  const offsets = new Map<string, number>();
  const source: MediaSourceLike = {
    supportsTrackIdentity: true, initialize() { return true; },
    appendChunk(media, _bytes, name, _group, _token, sourceKey) { appends.push({ media, name, sourceKey }); },
    getTimestampOffset: media => offsets.get(media), setTimestampOffset(media, value) { offsets.set(media, value); },
    async changeType() {}, reset() {}, endOfStream() {}, destroy() {}, attached: true,
    mediaElement: null, onFirstFrame: null, onError: null, onStall: null,
  };
  const f = await audioSelectionFixture(18, { path: 'cmaf', crossSet: true, config: { createMediaSource: () => source } });
  try {
    expect(appends.at(-1)).toEqual({ media: 'audio', name: refs.english.name, sourceKey: JSON.stringify([refs.english.namespace, refs.english.name]) });
    void f.player.audioTimelineReference; await f.sendAudio('english', 70n, 1n, 10_040_000n);
    const reference = f.player.audioTimelineReference;
    if (!reference) throw new Error('No accepted audio reference');
    const selecting = f.player.selectAudioTrack(refs.spanish, { timeline: { kind: 'reference-map', referenceToken: reference.token,
      sourceTimeUs: 90_000_000n, referenceTimeUs: 10_000_000n } });
    await flush(512); await f.wire.accept(refs.spanish, 301n); await f.sendAudio('spanish', 300n, 0n, 90_080_000n);
    await selecting;
    expect(appends.at(-1)).toEqual({ media: 'audio', name: refs.spanish.name, sourceKey: JSON.stringify([refs.spanish.namespace, refs.spanish.name]) });
    const count = appends.length; await f.sendAudio('spanish', 301n, 0n, 90_100_000n);
    expect(appends).toHaveLength(count + 1); expect(f.errors).toEqual([]);
  } finally { await f.destroy(); }
});
