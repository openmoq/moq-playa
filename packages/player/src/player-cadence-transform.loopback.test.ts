import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveLocFixture } from '../test-support/live-loc.js';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { encodeLocHeaders, locWireProfileForDraft } from '@openmoq/loc';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([false, true])('held LOC transform: mode ABA=%s must not seed a retired cadence lifetime', async modeABA => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const f = await liveLocFixture({ disableAudio: true, objectTransform: async obj => {
    if (obj.trackAlias === 77n && obj.groupId === 1n) { entered = true; await gate; }
    return obj;
  } });
  const delivered: bigint[] = [];
  f.player.on('media_object', event => { if (event.mediaType === 'video') delivered.push(event.groupId); });
  const seam = f.player as unknown as {
    estimatedGopDurationUs: number;
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
    const generation = seam.subscriptionManager.mediaInputGeneration, mode = seam.videoMeasurementMode;
    await send(1n, 1_000_000n);
    expect(entered).toBe(true); expect(delivered).toEqual([]);
    if (modeABA) { f.player.setAutoQuality(false); f.player.setAutoQuality(true); }
    expect(seam.subscriptionManager.mediaInputGeneration).toBe(generation);
    expect(seam.videoMeasurementMode === mode).toBe(!modeABA);
    release(); await flush(256);
    // Measurement retirement must not suppress otherwise valid playback.
    expect(delivered).toEqual([1n]);
    await send(2n, 1_500_000n);
    expect(delivered).toEqual([1n, 2n]); expect(f.errors).toEqual([]);
    expect(seam.estimatedGopDurationUs,
      'only fresh post-mode starts may seed cadence; held pre-mode work may still play')
      .toBe(modeABA ? 2_000_000 : 500_000);
    await send(3n, 2_000_000n);
    expect(seam.estimatedGopDurationUs).toBe(500_000);
  } finally { release(); await f.close(); }
});
