import type { PlaybackPipeline } from '@openmoq/playback';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveLocFixture } from '../test-support/live-loc.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([false, true])('synchronous media_object: mode ABA=%s must preserve playback without reseeding retired cadence', async modeABA => {
  const f = await liveLocFixture({ disableAudio: true });
  const delivered: bigint[] = [];
  f.player.on('media_object', event => {
    if (event.mediaType !== 'video') return;
    delivered.push(event.groupId);
    if (modeABA && event.groupId === 1n) { f.player.setAutoQuality(false); f.player.setAutoQuality(true); }
  });
  const seam = f.player as unknown as {
    estimatedGopDurationUs: number;
    videoPipeline: Pick<PlaybackPipeline, 'pushObject'>;
    subscriptionManager: { mediaInputGeneration: object };
    videoMeasurementMode: object;
  };
  async function send(group: bigint, timestamp: bigint) {
    const stream = await f.server.openSubgroup(77n, group, 0n, { publisherPriority: 128, hasExtensions: true });
    const extensions = encodeLocHeaders({ captureTimestamp: timestamp,
      videoFrameMarking: { startOfFrame: true, endOfFrame: true, independent: true,
        discardable: false, baseLayerSync: false, temporalId: 0 } }, { wireProfile: locWireProfileForDraft(18) });
    await f.server.sendObject(stream, 0n, Uint8Array.of(0, 0, 0, 1, 0x65), extensions);
    await f.server.closeSubgroup(stream); await flush(256);
  }
  try {
    f.player.play(); f.player.setAutoQuality(true);
    const pushed = vi.spyOn(seam.videoPipeline, 'pushObject');
    const generation = seam.subscriptionManager.mediaInputGeneration, mode = seam.videoMeasurementMode;
    await send(1n, 1_000_000n);
    expect(seam.subscriptionManager.mediaInputGeneration).toBe(generation);
    expect(seam.videoMeasurementMode === mode).toBe(!modeABA);
    // Measurement retirement must not suppress otherwise valid playback.
    expect(delivered).toEqual([1n]);
    await send(2n, 1_500_000n);
    expect(delivered).toEqual([1n, 2n]); expect(f.errors).toEqual([]);
    expect(pushed.mock.calls.map(call => call[0].groupId)).toEqual([1n, 2n]);
    expect(seam.estimatedGopDurationUs,
      'only fresh post-mode starts may seed cadence; reset-initiating work must still play')
      .toBe(modeABA ? 2_000_000 : 500_000);
    await send(3n, 2_000_000n);
    expect(seam.estimatedGopDurationUs).toBe(500_000);
  } finally { await f.close(); }
});
