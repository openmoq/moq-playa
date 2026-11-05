import { describe, expect, it, vi } from 'vitest';
import { flush } from '../../webtransport/src/testkit/loopback.js';
import { mediaRefs, mediaSelectionFixture } from '../test-support/media-selection.js';

describe('canonical media source reference', () => {
  it.each([false, true])('returns unavailable when a clock callback pauses and resumes its owner: videoOnly=%s', async videoOnly => {
    const f = await mediaSelectionFixture(18, { videoOnly });
    try {
      f.player.play(); void f.player.mediaTimelineReference;
      await f.sendOld(10_040_000n, 1n);
      expect(f.player.mediaTimelineReference).not.toBeNull();
      const now = f.clock.now;
      const read = vi.spyOn(f.clock, 'now').mockImplementationOnce(() => {
        f.player.pause(); f.player.play(); return now();
      });
      try { expect(f.player.mediaTimelineReference).toBeNull(); }
      finally { read.mockRestore(); }
    } finally { await f.destroy(); }
  });

  it.each([false, true])('refuses a reference when its clock callback destroys its owner: videoOnly=%s', async videoOnly => {
    const f = await mediaSelectionFixture(18, { videoOnly });
    try {
      void f.player.mediaTimelineReference; await f.sendOld(10_040_000n, 1n);
      expect(f.player.mediaTimelineReference).not.toBeNull();
      const now = f.clock.now;
      let destroyed: Promise<void> | undefined;
      const read = vi.spyOn(f.clock, 'now').mockImplementationOnce(() => {
        destroyed = f.player.destroy(); return now();
      });
      expect(f.player.mediaTimelineReference).toBeNull();
      await destroyed; read.mockRestore();
    } finally { await f.destroy(); }
  });

  it('observes video only on request and keeps the owner token across ordinary source progress', async () => {
    const f = await mediaSelectionFixture(18, { videoOnly: true });
    try {
      expect(f.player.audioTimelineReference).toBeNull();
      expect(f.player.mediaTimelineReference).toBeNull();
      await f.sendOld(10_040_000n, 1n);
      const first = f.player.mediaTimelineReference;
      expect(first).toMatchObject({ track: { name: mediaRefs.oldVideo.name, namespaceFields: mediaRefs.oldVideo.namespace },
        observedSourceTimeUs: 10_040_000n, domain: 'media-time' });
      await f.sendOld(10_060_000n, 2n);
      expect(f.player.mediaTimelineReference?.token).toBe(first?.token);
      expect(f.player.mediaTimelineReference?.observedSourceTimeUs).toBe(10_060_000n);
    } finally { await f.destroy(); }
    expect(f.player.mediaTimelineReference).toBeNull();
  });

  it('maps a video-only view into its adopted video reference without creating audio', async () => {
    const f = await mediaSelectionFixture(18, { videoOnly: true });
    try {
      void f.player.mediaTimelineReference; await f.sendOld(10_040_000n, 1n);
      const reference = f.player.mediaTimelineReference;
      if (!reference) throw new Error('No observed video reference');
      const selecting = f.player.selectMedia({ videoTrack: mediaRefs.viewVideo }, { timeline: {
        kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: 700_000_000n, referenceTimeUs: 10_000_000n } } });
      await flush(512); await f.accept('viewVideo'); await f.send('viewVideo', 700_060_000n); f.tick(0);
      await selecting;
      expect(f.player.selection.video).toEqual({ name: mediaRefs.viewVideo.name, namespaceFields: mediaRefs.viewVideo.namespace });
      expect(f.player.selection.audio).toBeNull();
      expect(f.enqueuedVideo.at(-1)?.rawTimestampUs).toBe(700_060_000);
      expect(f.scheduledAudio).toEqual([]);
      expect(f.player.mediaTimelineReference?.token).not.toBe(reference.token);
      await expect(f.player.selectMedia({ videoTrack: mediaRefs.oldVideo }, { timeline: {
        kind: 'reference-map', referenceToken: reference.token,
        video: { sourceTimeUs: 10_000_000n, referenceTimeUs: 700_000_000n } } })).rejects.toThrow(/stale/);
      expect(f.errors).toEqual([]);
    } finally { await f.destroy(); }
  });

  it('prefers the adopted audio domain while both outputs are established', async () => {
    const f = await mediaSelectionFixture();
    try {
      expect(f.player.mediaTimelineReference).toBeNull();
      await f.sendOld(10_040_000n, 1n);
      expect(f.player.mediaTimelineReference?.track).toEqual({ name: mediaRefs.oldAudio.name, namespaceFields: mediaRefs.oldAudio.namespace });
      expect(f.player.mediaTimelineReference?.token).toBe(f.player.audioTimelineReference?.token);
    } finally { await f.destroy(); }
  });
});
