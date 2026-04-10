/**
 * StatsAccumulator tests — red/green TDD.
 *
 * Tests aggregate stats: TTFF tracking, playback duration, session age,
 * object/frame/error counting, quality tracking, snapshot isolation.
 *
 * @see draft-jennings-moq-metrics-02 (informational)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatsAccumulator } from './stats.js';
import type { PlayerStats, TTFFBreakdown } from './stats.js';

describe('StatsAccumulator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── TTFF tracking ──────────────────────────────────────────

  describe('TTFF tracking', () => {
    it('returns null timeToFirstFrameMs before load', () => {
      const stats = new StatsAccumulator();
      const snap = stats.snapshot();
      expect(snap.timeToFirstFrameMs).toBeNull();
      expect(snap.ttffBreakdown).toBeNull();
    });

    it('returns ttffBreakdown with null stages after loadStart only', () => {
      const stats = new StatsAccumulator();
      stats.recordLoadStart();
      const snap = stats.snapshot();
      expect(snap.ttffBreakdown).not.toBeNull();
      expect(snap.ttffBreakdown!.loadCalledMs).toBe(0);
      expect(snap.ttffBreakdown!.transportConnectedMs).toBeNull();
      expect(snap.ttffBreakdown!.setupCompleteMs).toBeNull();
      expect(snap.ttffBreakdown!.catalogReceivedMs).toBeNull();
      expect(snap.ttffBreakdown!.firstObjectReceivedMs).toBeNull();
      expect(snap.ttffBreakdown!.decoderConfiguredMs).toBeNull();
      expect(snap.ttffBreakdown!.firstFrameRenderedMs).toBeNull();
    });

    it('computes TTFF stages relative to loadStart', () => {
      const stats = new StatsAccumulator();

      stats.recordLoadStart();
      vi.advanceTimersByTime(10);
      stats.recordTransportConnected();
      vi.advanceTimersByTime(5);
      stats.recordSetupComplete();
      vi.advanceTimersByTime(20);
      stats.recordCatalogReceived();
      vi.advanceTimersByTime(30);
      stats.recordFirstObjectReceived();
      vi.advanceTimersByTime(15);
      stats.recordDecoderConfigured();
      vi.advanceTimersByTime(50);
      stats.recordFirstFrameRendered();

      const snap = stats.snapshot();
      expect(snap.ttffBreakdown!.transportConnectedMs).toBe(10);
      expect(snap.ttffBreakdown!.setupCompleteMs).toBe(15);
      expect(snap.ttffBreakdown!.catalogReceivedMs).toBe(35);
      expect(snap.ttffBreakdown!.firstObjectReceivedMs).toBe(65);
      expect(snap.ttffBreakdown!.decoderConfiguredMs).toBe(80);
      expect(snap.ttffBreakdown!.firstFrameRenderedMs).toBe(130);
    });

    it('computes timeToFirstFrameMs from firstFrameRendered', () => {
      const stats = new StatsAccumulator();
      stats.recordLoadStart();
      vi.advanceTimersByTime(200);
      stats.recordFirstFrameRendered();

      const snap = stats.snapshot();
      expect(snap.timeToFirstFrameMs).toBe(200);
    });

    it('TTFF stages are idempotent (first write wins)', () => {
      const stats = new StatsAccumulator();
      stats.recordLoadStart();
      vi.advanceTimersByTime(100);
      stats.recordTransportConnected();
      vi.advanceTimersByTime(100);
      // Second call should be ignored
      stats.recordTransportConnected();

      const snap = stats.snapshot();
      expect(snap.ttffBreakdown!.transportConnectedMs).toBe(100);
    });

    it('timeToFirstFrameMs is null when firstFrameRendered not recorded', () => {
      const stats = new StatsAccumulator();
      stats.recordLoadStart();
      stats.recordTransportConnected();
      stats.recordSetupComplete();
      stats.recordCatalogReceived();
      stats.recordFirstObjectReceived();
      stats.recordDecoderConfigured();

      const snap = stats.snapshot();
      expect(snap.timeToFirstFrameMs).toBeNull();
    });
  });

  // ─── playbackDurationMs ─────────────────────────────────────

  describe('playbackDurationMs', () => {
    it('is 0 before play', () => {
      const stats = new StatsAccumulator();
      expect(stats.snapshot().playbackDurationMs).toBe(0);
    });

    it('accumulates active playback time', () => {
      const stats = new StatsAccumulator();
      stats.recordPlayStart();
      vi.advanceTimersByTime(1000);
      stats.recordPlayStop();

      expect(stats.snapshot().playbackDurationMs).toBe(1000);
    });

    it('excludes paused time', () => {
      const stats = new StatsAccumulator();
      stats.recordPlayStart();
      vi.advanceTimersByTime(500);
      stats.recordPlayStop();
      // Paused for 2 seconds
      vi.advanceTimersByTime(2000);
      stats.recordPlayStart();
      vi.advanceTimersByTime(300);
      stats.recordPlayStop();

      expect(stats.snapshot().playbackDurationMs).toBe(800);
    });

    it('includes in-progress segment in snapshot', () => {
      const stats = new StatsAccumulator();
      stats.recordPlayStart();
      vi.advanceTimersByTime(750);
      // Still playing — snapshot should include the in-progress segment

      expect(stats.snapshot().playbackDurationMs).toBe(750);
    });

    it('handles multiple play/pause cycles', () => {
      const stats = new StatsAccumulator();
      // Cycle 1
      stats.recordPlayStart();
      vi.advanceTimersByTime(100);
      stats.recordPlayStop();
      // Cycle 2
      stats.recordPlayStart();
      vi.advanceTimersByTime(200);
      stats.recordPlayStop();
      // Cycle 3
      stats.recordPlayStart();
      vi.advanceTimersByTime(300);
      stats.recordPlayStop();

      expect(stats.snapshot().playbackDurationMs).toBe(600);
    });

    it('recordPlayStart is idempotent while playing', () => {
      const stats = new StatsAccumulator();
      stats.recordPlayStart();
      vi.advanceTimersByTime(100);
      stats.recordPlayStart(); // Should be ignored
      vi.advanceTimersByTime(100);
      stats.recordPlayStop();

      expect(stats.snapshot().playbackDurationMs).toBe(200);
    });

    it('recordPlayStop is idempotent while stopped', () => {
      const stats = new StatsAccumulator();
      stats.recordPlayStop(); // Should be a no-op
      expect(stats.snapshot().playbackDurationMs).toBe(0);
    });
  });

  // ─── sessionAgeMs ───────────────────────────────────────────

  describe('sessionAgeMs', () => {
    it('is 0 before load', () => {
      const stats = new StatsAccumulator();
      expect(stats.snapshot().sessionAgeMs).toBe(0);
    });

    it('reflects time since load at snapshot time', () => {
      const stats = new StatsAccumulator();
      stats.recordLoadStart();
      vi.advanceTimersByTime(5000);
      expect(stats.snapshot().sessionAgeMs).toBe(5000);
    });

    it('continues to grow after snapshot', () => {
      const stats = new StatsAccumulator();
      stats.recordLoadStart();
      vi.advanceTimersByTime(1000);
      const snap1 = stats.snapshot();
      vi.advanceTimersByTime(2000);
      const snap2 = stats.snapshot();
      expect(snap2.sessionAgeMs).toBe(3000);
      expect(snap2.sessionAgeMs).toBeGreaterThan(snap1.sessionAgeMs);
    });
  });

  // ─── Object tracking ───────────────────────────────────────

  describe('object tracking', () => {
    it('accumulates objectsReceived and bytesReceived', () => {
      const stats = new StatsAccumulator();
      stats.recordMediaObject(1024);
      stats.recordMediaObject(2048);
      stats.recordMediaObject(512);

      const snap = stats.snapshot();
      expect(snap.objectsReceived).toBe(3);
      expect(snap.bytesReceived).toBe(3584);
    });

    it('tracks gapsReceived separately', () => {
      const stats = new StatsAccumulator();
      stats.recordMediaObject(100);
      stats.recordGapObject();
      stats.recordGapObject();

      const snap = stats.snapshot();
      expect(snap.objectsReceived).toBe(1);
      expect(snap.gapsReceived).toBe(2);
    });
  });

  // ─── Frame tracking ─────────────────────────────────────────

  describe('frame tracking', () => {
    it('increments framesDecoded and framesRendered', () => {
      const stats = new StatsAccumulator();
      stats.recordFrameDecoded();
      stats.recordFrameDecoded();
      stats.recordFrameDecoded();
      stats.recordFrameRendered();
      stats.recordFrameRendered();

      const snap = stats.snapshot();
      expect(snap.framesDecoded).toBe(3);
      expect(snap.framesRendered).toBe(2);
    });

    it('dropRatio is 0 when no frames dropped', () => {
      const stats = new StatsAccumulator();
      stats.recordFrameDecoded();
      stats.recordFrameDecoded();

      expect(stats.snapshot().dropRatio).toBe(0);
    });

    it('dropRatio avoids division by zero when no frames', () => {
      const stats = new StatsAccumulator();
      expect(stats.snapshot().dropRatio).toBe(0);
    });

    it('framesDropped defaults to 0 (deferred to Item 7)', () => {
      const stats = new StatsAccumulator();
      expect(stats.snapshot().framesDropped).toBe(0);
    });
  });

  // ─── Error tracking ─────────────────────────────────────────

  describe('error tracking', () => {
    it('increments gapCount', () => {
      const stats = new StatsAccumulator();
      stats.recordGapDetected();
      stats.recordGapDetected();
      stats.recordGapDetected();
      expect(stats.snapshot().gapCount).toBe(3);
    });

    it('tracks stallCount and totalStallDurationMs', () => {
      const stats = new StatsAccumulator();
      stats.recordStall(100);
      stats.recordStall(250);
      stats.recordStall(50);

      const snap = stats.snapshot();
      expect(snap.stallCount).toBe(3);
      expect(snap.totalStallDurationMs).toBe(400);
    });

    it('increments decodeErrorCount', () => {
      const stats = new StatsAccumulator();
      stats.recordDecodeError();
      stats.recordDecodeError();
      expect(stats.snapshot().decodeErrorCount).toBe(2);
    });

    it('increments recoveryActionCount', () => {
      const stats = new StatsAccumulator();
      stats.recordRecoveryAction();
      expect(stats.snapshot().recoveryActionCount).toBe(1);
    });
  });

  // ─── Quality tracking ──────────────────────────────────────

  describe('quality tracking', () => {
    it('setTrackInfo sets codecs, resolution, and bitrate', () => {
      const stats = new StatsAccumulator();
      stats.setTrackInfo(
        { codec: 'av01.0.08M.10', bitrate: 1_500_000, width: 1920, height: 1080 },
        { codec: 'opus' },
      );

      const snap = stats.snapshot();
      expect(snap.currentVideoCodec).toBe('av01.0.08M.10');
      expect(snap.currentAudioCodec).toBe('opus');
      expect(snap.currentBitrate).toBe(1_500_000);
      expect(snap.currentResolution).toEqual({ width: 1920, height: 1080 });
    });

    it('recordQualitySwitch updates track info and increments count', () => {
      const stats = new StatsAccumulator();
      stats.setTrackInfo(
        { codec: 'av01.0.08M.10', bitrate: 1_500_000, width: 1920, height: 1080 },
      );

      stats.recordQualitySwitch({ codec: 'av01.0.04M.10', bitrate: 750_000, width: 1280, height: 720 });

      const snap = stats.snapshot();
      expect(snap.qualitySwitchCount).toBe(1);
      expect(snap.currentVideoCodec).toBe('av01.0.04M.10');
      expect(snap.currentBitrate).toBe(750_000);
      expect(snap.currentResolution).toEqual({ width: 1280, height: 720 });
    });

    it('setTargetLatency sets targetLatencyMs', () => {
      const stats = new StatsAccumulator();
      stats.setTargetLatency(500);
      expect(stats.snapshot().targetLatencyMs).toBe(500);
    });
  });

  // ─── Session tracking ──────────────────────────────────────

  describe('session tracking', () => {
    it('increments reconnectCount', () => {
      const stats = new StatsAccumulator();
      stats.recordReconnect();
      stats.recordReconnect();
      expect(stats.snapshot().reconnectCount).toBe(2);
    });
  });

  // ─── Snapshot isolation ─────────────────────────────────────

  describe('snapshot isolation', () => {
    it('returns a plain object', () => {
      const stats = new StatsAccumulator();
      const snap = stats.snapshot();
      // Not an instance of StatsAccumulator
      expect(snap).not.toBeInstanceOf(StatsAccumulator);
      expect(typeof snap).toBe('object');
    });

    it('snapshot is independent of subsequent mutations', () => {
      const stats = new StatsAccumulator();
      stats.recordLoadStart();
      stats.recordMediaObject(100);
      stats.recordFrameDecoded();

      const snap1 = stats.snapshot();
      stats.recordMediaObject(200);
      stats.recordFrameDecoded();
      const snap2 = stats.snapshot();

      // First snapshot should not be affected by later mutations
      expect(snap1.objectsReceived).toBe(1);
      expect(snap1.bytesReceived).toBe(100);
      expect(snap1.framesDecoded).toBe(1);

      expect(snap2.objectsReceived).toBe(2);
      expect(snap2.bytesReceived).toBe(300);
      expect(snap2.framesDecoded).toBe(2);
    });

    it('deferred fields default to 0', () => {
      const stats = new StatsAccumulator();
      const snap = stats.snapshot();

      // Deferred until Item 7
      expect(snap.framesDropped).toBe(0);
      expect(snap.videoBufferDepth).toBe(0);
      expect(snap.audioBufferDepth).toBe(0);
      expect(snap.videoDecoderQueueDepth).toBe(0);

      // Deferred until Item 8
      expect(snap.currentLatencyMs).toBe(0);

      // Deferred until reconnection logic
      expect(snap.reconnectCount).toBe(0);
    });

    it('resolution and codecs are null before catalog', () => {
      const stats = new StatsAccumulator();
      const snap = stats.snapshot();
      expect(snap.currentResolution).toBeNull();
      expect(snap.currentVideoCodec).toBeNull();
      expect(snap.currentAudioCodec).toBeNull();
    });
  });
});
