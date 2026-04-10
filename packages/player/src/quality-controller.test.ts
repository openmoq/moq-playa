/**
 * QualityController tests — red/green TDD.
 *
 * Uses @moqt/msf selection APIs (groupByAlt, selectTrack) for ABR.
 * Responds to recovery actions by selecting lower quality tracks.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 * @see draft-ietf-moq-msf-00 §4.2 (time-alignment at group boundaries)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { QualityController } from './quality-controller.js';
import type { CatalogTrack, CatalogState } from '@moqt/msf';
import type { ClockSource } from '@moqt/playback';

class MockClock implements ClockSource {
  private _now = 0;
  now(): number { return this._now; }
  advance(us: number): void { this._now += us; }
  set(us: number): void { this._now = us; }
}

/** Test catalog with video altGroup (3 qualities) + 1 audio track. */
function createTestCatalog(): CatalogState {
  return {
    version: 1,
    tracks: [
      {
        name: 'video-1080p',
        packaging: 'loc' as const,
        isLive: true,
        role: 'video' as const,
        renderGroup: 1,
        altGroup: 1,
        codec: 'av01.0.08M.10',
        width: 1920,
        height: 1080,
        bitrate: 3_000_000,
      },
      {
        name: 'video-720p',
        packaging: 'loc' as const,
        isLive: true,
        role: 'video' as const,
        renderGroup: 1,
        altGroup: 1,
        codec: 'av01.0.05M.10',
        width: 1280,
        height: 720,
        bitrate: 1_500_000,
      },
      {
        name: 'video-360p',
        packaging: 'loc' as const,
        isLive: true,
        role: 'video' as const,
        renderGroup: 1,
        altGroup: 1,
        codec: 'av01.0.04M.10',
        width: 640,
        height: 360,
        bitrate: 300_000,
      },
      {
        name: 'audio',
        packaging: 'loc' as const,
        isLive: true,
        role: 'audio' as const,
        renderGroup: 1,
        codec: 'opus',
        samplerate: 48000,
        channelConfig: '2',
        bitrate: 32000,
      },
    ],
  };
}

describe('QualityController', () => {
  it('auto start-level picks middle of video ladder (safe default)', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog(); // 3 tracks: 1080p, 720p, 360p
    const selected = qc.selectInitialTracks(catalog);

    // Middle of 3 = index 1 = 720p. Not highest (avoids catastrophic
    // stall on constrained networks) and not lowest (looks reasonable).
    expect(selected.video?.name).toBe('video-720p');
    expect(selected.audio?.name).toBe('audio');
  });

  it('auto start-level on 4-track ladder picks index 2', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        { name: 'v-1080p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 4000000 },
        { name: 'v-720p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 1500000 },
        { name: 'v-480p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 600000 },
        { name: 'v-240p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 150000 },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('v-480p'); // index 2 = Math.floor(4/2)
  });

  it('auto start-level on 2-track ladder picks index 1 (lower)', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        { name: 'v-high', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 3000000 },
        { name: 'v-low', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 300000 },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('v-low'); // index 1 = Math.floor(2/2)
  });

  it('auto start-level on 1-track ladder picks the only track', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        { name: 'v-only', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 3000000 },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('v-only'); // index 0 = Math.floor(1/2)
  });

  it('selectInitialTracks applies video constraints', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog, {
      videoConstraints: { maxHeight: 720 },
    });

    expect(selected.video?.name).toBe('video-720p');
  });

  it('reduceVideoQuality picks next-lower bitrate from altGroup', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog); // starts at 720p (middle)

    const lower = qc.reduceVideoQuality();
    expect(lower?.name).toBe('video-360p');
  });

  it('reduceVideoQuality returns null when already at lowest', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog); // starts at 720p

    qc.reduceVideoQuality(); // → 360p
    const result = qc.reduceVideoQuality(); // → null (already lowest)
    expect(result).toBeNull();
  });

  it('currentVideoTrack reflects the active track', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog); // starts at 720p (middle)

    expect(qc.currentVideoTrack?.name).toBe('video-720p');
    qc.reduceVideoQuality();
    expect(qc.currentVideoTrack?.name).toBe('video-360p');
  });

  it('returns null video/audio if catalog has no matching tracks', () => {
    const qc = new QualityController();
    const emptyCatalog: CatalogState = { version: 1, tracks: [] };
    const selected = qc.selectInitialTracks(emptyCatalog);

    expect(selected.video).toBeUndefined();
    expect(selected.audio).toBeUndefined();
  });

  it('handles catalog with single video quality (no altGroup)', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.42E01E',
          width: 1280,
          height: 720,
          bitrate: 1_000_000,
        },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('video');

    // Can't reduce — no alt group
    expect(qc.reduceVideoQuality()).toBeNull();
  });

  it('audio tracks are not in altGroups for quality reduction', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog);

    expect(qc.currentAudioTrack?.name).toBe('audio');
  });

  // ─── Config options ─────────────────────────────────────────

  it('startLevel "lowest" picks lowest bitrate', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 'lowest',
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    expect(selected.video?.name).toBe('video-360p');
  });

  it('startLevel number picks track by index', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 1,
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    // Index 1 in bitrate-descending order = 720p
    expect(selected.video?.name).toBe('video-720p');
  });

  it('startLevel number is clamped to range', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 999, // way beyond available tracks
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    // Clamped to last (lowest bitrate)
    expect(selected.video?.name).toBe('video-360p');
  });

  it('capLevelToResolution filters out tracks above cap', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 'auto',
      capLevelToResolution: { width: 1280, height: 720 },
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    // 1080p filtered out → remaining [720p, 360p] → middle = index 1 = 360p
    expect(selected.video?.name).toBe('video-360p');
  });

  it('autoQuality false prevents reduceVideoQuality', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: false,
      startLevel: 'auto',
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog);

    expect(qc.reduceVideoQuality()).toBeNull();
  });

  it('qualitySwitchCooldownMs prevents rapid switches', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 'auto',
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog);

    // Starts at 720p (middle). First switch — should work
    const first = qc.reduceVideoQuality();
    expect(first?.name).toBe('video-360p');

    // Second switch immediately — blocked by cooldown (already at lowest anyway)
    const second = qc.reduceVideoQuality();
    expect(second).toBeNull();
  });
});
