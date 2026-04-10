/**
 * Tests for AdaptiveToleranceController.
 *
 * Auto-calibrated gap timeout from jitter EMA, monitoring phase before
 * skip-forward, stall-count escalation with exponential decay,
 * DELIVERY_TIMEOUT as ceiling.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  AdaptiveToleranceController,
  RecoveryPhase,
  DEFAULT_TOLERANCE_CONFIG,
} from './adaptive-tolerance.js';
import type { ToleranceConfig } from './adaptive-tolerance.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function createController(overrides?: Partial<ToleranceConfig>) {
  return new AdaptiveToleranceController({ ...DEFAULT_TOLERANCE_CONFIG, ...overrides });
}

/** Feed N frames with constant interarrival jitter. */
function feedFrames(
  ctrl: AdaptiveToleranceController,
  count: number,
  opts: {
    startMs?: number;
    intervalMs?: number;
    jitterMs?: number;
    captureIntervalUs?: number;
    captureJitterUs?: number;
  } = {},
) {
  const {
    startMs = 0,
    intervalMs = 33.33,
    jitterMs = 0,
    captureIntervalUs = 33333,
    captureJitterUs = 0,
  } = opts;

  let captureUs = 1_000_000;
  for (let i = 0; i < count; i++) {
    const jitter = jitterMs > 0 ? (Math.random() - 0.5) * 2 * jitterMs : 0;
    const captureJitter = captureJitterUs > 0 ? (Math.random() - 0.5) * 2 * captureJitterUs : 0;
    const nowMs = startMs + i * intervalMs + jitter;
    captureUs += captureIntervalUs + captureJitter;
    ctrl.onFrameArrived(nowMs, captureUs, nowMs);
  }
}

// ─── Jitter EMA tests ─────────────────────────────────────────────────

describe('AdaptiveToleranceController', () => {
  describe('jitter EMA estimation', () => {
    it('converges to steady-state jitter', () => {
      const ctrl = createController();

      // Feed 100 frames with constant 5ms interarrival jitter
      let captureUs = 1_000_000;
      for (let i = 0; i < 100; i++) {
        const jitter = (i % 2 === 0) ? 5 : -5; // alternating ±5ms
        const nowMs = i * 33.33 + jitter;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      // EMA should be near 10ms (the interarrival difference alternates by ~10ms)
      expect(ctrl.jitterEmaMs).toBeGreaterThan(3);
      expect(ctrl.jitterEmaMs).toBeLessThan(15);
    });

    it('responds to step change in jitter', () => {
      const ctrl = createController();

      // 50 frames with low jitter
      let captureUs = 1_000_000;
      for (let i = 0; i < 50; i++) {
        const nowMs = i * 33.33;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }
      const lowJitter = ctrl.jitterEmaMs;

      // 50 frames with high jitter (±50ms)
      for (let i = 50; i < 100; i++) {
        const jitter = (i % 2 === 0) ? 50 : -50;
        const nowMs = i * 33.33 + jitter;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      expect(ctrl.jitterEmaMs).toBeGreaterThan(lowJitter + 10);
    });
  });

  // ─── Sliding window max ───────────────────────────────────────────

  describe('sliding window max', () => {
    it('tracks burst spike', () => {
      const ctrl = createController();

      // 99 frames with 5ms jitter
      let captureUs = 1_000_000;
      for (let i = 0; i < 99; i++) {
        const jitter = (i % 2 === 0) ? 5 : -5;
        const nowMs = i * 33.33 + jitter;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      // 1 frame with 200ms spike
      const nowMs = 99 * 33.33 + 200;
      captureUs += 33333;
      ctrl.onFrameArrived(nowMs, captureUs, nowMs);

      expect(ctrl.slidingMaxMs).toBeGreaterThan(150);
    });

    it('expires old spikes after window rotates', () => {
      const ctrl = createController({ slidingWindowSize: 32 });

      // 1 spike frame
      let captureUs = 1_000_000;
      const spikeMs = 200;
      ctrl.onFrameArrived(spikeMs, captureUs, spikeMs);
      captureUs += 33333;

      // 64 normal frames to push spike out of window
      for (let i = 1; i <= 64; i++) {
        const nowMs = spikeMs + i * 33.33;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      expect(ctrl.slidingMaxMs).toBeLessThan(50);
    });
  });

  // ─── Auto-calibrated gap timeout ──────────────────────────────────

  describe('auto-calibrated gap timeout', () => {
    it('computes gap timeout from jitter stats', () => {
      const ctrl = createController();

      // Feed frames with ~10ms jitter variance
      let captureUs = 1_000_000;
      for (let i = 0; i < 100; i++) {
        const jitter = (i % 2 === 0) ? 10 : -10;
        const nowMs = i * 33.33 + jitter;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      const timeout = ctrl.effectiveGapTimeoutMs;
      // Should be > minGapTimeoutMs (50) and adaptive
      expect(timeout).toBeGreaterThanOrEqual(50);
      // Should include jitter headroom (EMA + K * variance)
      expect(timeout).toBeGreaterThan(ctrl.jitterEmaMs);
    });

    it('respects minGapTimeoutMs floor', () => {
      const ctrl = createController({ minGapTimeoutMs: 100 });

      // Feed very low-jitter frames
      let captureUs = 1_000_000;
      for (let i = 0; i < 50; i++) {
        const nowMs = i * 33.33;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      expect(ctrl.effectiveGapTimeoutMs).toBeGreaterThanOrEqual(100);
    });

    it('respects maxGapTimeoutMs ceiling', () => {
      const ctrl = createController({ maxGapTimeoutMs: 500 });

      // Feed extremely jittery frames
      let captureUs = 1_000_000;
      for (let i = 0; i < 100; i++) {
        const jitter = (i % 2 === 0) ? 300 : -300;
        const nowMs = i * 33.33 + jitter;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      expect(ctrl.effectiveGapTimeoutMs).toBeLessThanOrEqual(500);
    });

    it('DELIVERY_TIMEOUT caps gap timeout', () => {
      const ctrl = createController();

      // Feed jittery frames so adaptive baseline is high
      let captureUs = 1_000_000;
      for (let i = 0; i < 100; i++) {
        const jitter = (i % 2 === 0) ? 100 : -100;
        const nowMs = i * 33.33 + jitter;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      ctrl.setDeliveryTimeout(80);

      expect(ctrl.effectiveGapTimeoutMs).toBeLessThanOrEqual(80);
    });
  });

  // ─── Recovery phases ──────────────────────────────────────────────

  describe('recovery phases', () => {
    it('starts in Normal phase', () => {
      const ctrl = createController();
      expect(ctrl.phase).toBe(RecoveryPhase.Normal);
    });

    it('Normal → Monitoring on gap', () => {
      const ctrl = createController();
      ctrl.onGapDetected(100, 5);
      expect(ctrl.phase).toBe(RecoveryPhase.Monitoring);
    });

    it('Monitoring → Normal after clean period', () => {
      const ctrl = createController({
        monitorCleanFrames: 10,
        monitorCleanDurationMs: 100,
      });

      ctrl.onGapDetected(100, 5);
      expect(ctrl.phase).toBe(RecoveryPhase.Monitoring);

      // Feed clean frames over sufficient time
      let captureUs = 1_000_000;
      for (let i = 0; i < 15; i++) {
        const nowMs = 200 + i * 33.33;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      // Tick after clean period
      ctrl.tick(200 + 15 * 33.33);
      expect(ctrl.phase).toBe(RecoveryPhase.Normal);
    });

    it('Monitoring → ExtendedWait on 2nd gap within window', () => {
      const ctrl = createController({ monitorWindowMs: 500 });

      ctrl.onGapDetected(100, 5);
      expect(ctrl.phase).toBe(RecoveryPhase.Monitoring);

      ctrl.onGapDetected(300, 7); // 2nd gap within 500ms window
      expect(ctrl.phase).toBe(RecoveryPhase.ExtendedWait);
    });

    it('ExtendedWait emits shouldSkip after timeout', () => {
      const ctrl = createController({ maxExtendedWaitMs: 200 });

      ctrl.onGapDetected(100, 5);
      ctrl.onGapDetected(200, 7);
      expect(ctrl.phase).toBe(RecoveryPhase.ExtendedWait);

      // Tick past the extended wait timeout
      const result = ctrl.tick(500);
      expect(result.shouldSkip).toBe(true);
      expect(ctrl.phase).toBe(RecoveryPhase.Normal);
    });

    it('skip increments stallCount', () => {
      const ctrl = createController({ maxExtendedWaitMs: 100 });

      expect(ctrl.stallCount).toBe(0);

      ctrl.onGapDetected(100, 5);
      ctrl.onGapDetected(150, 7);
      ctrl.tick(300); // triggers skip

      expect(ctrl.stallCount).toBe(1);
    });

    it('repeated skips trigger quality reduction', () => {
      const ctrl = createController({
        maxExtendedWaitMs: 50,
        monitorWindowMs: 100,
        skipFrequencyThreshold: 3,
        skipFrequencyWindowMs: 30000,
      });

      // 3 skip cycles within 30s
      for (let cycle = 0; cycle < 3; cycle++) {
        const base = cycle * 200;
        ctrl.onGapDetected(base + 10, cycle * 2 + 5);
        ctrl.onGapDetected(base + 30, cycle * 2 + 7);
        ctrl.tick(base + 100);
      }

      expect(ctrl.stallCount).toBeGreaterThanOrEqual(3);
      expect(ctrl.shouldReduceQuality).toBe(true);
    });
  });

  // ─── Stall escalation and decay ───────────────────────────────────

  describe('stall escalation and decay', () => {
    it('stallCount increases gap timeout', () => {
      const ctrl = createController({ stallIncrementMs: 50, maxExtendedWaitMs: 50, monitorWindowMs: 100 });

      const baseTimeout = ctrl.effectiveGapTimeoutMs;

      // Simulate stalls: gap → monitoring → 2nd gap → extended wait → tick past timeout → skip
      ctrl.onGapDetected(100, 5);
      ctrl.onGapDetected(150, 7);
      ctrl.tick(300); // skip → stallCount=1

      const afterStall = ctrl.effectiveGapTimeoutMs;
      expect(afterStall).toBe(baseTimeout + 50); // 1 stall × 50ms increment
    });

    it('exponential decay reduces tolerance after clean period', () => {
      const ctrl = createController({
        stallIncrementMs: 100,
        maxExtendedWaitMs: 50,
        monitorWindowMs: 100,
        decayMinCleanFrames: 5,
        decayMinCleanDurationMs: 100,
        decayFactor: 0.5, // aggressive decay for testing
      });

      // Build up stall count
      ctrl.onGapDetected(10, 5);
      ctrl.onGapDetected(30, 7);
      ctrl.tick(100); // skip → stallCount=1
      const escalated = ctrl.effectiveGapTimeoutMs;

      // Feed clean frames
      let captureUs = 1_000_000;
      for (let i = 0; i < 10; i++) {
        const nowMs = 200 + i * 33.33;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      ctrl.tick(600);
      const afterDecay = ctrl.effectiveGapTimeoutMs;

      expect(afterDecay).toBeLessThan(escalated);
    });

    it('gap during decay interrupts and re-escalates', () => {
      const ctrl = createController({
        stallIncrementMs: 100,
        maxExtendedWaitMs: 50,
        monitorWindowMs: 100,
        decayMinCleanFrames: 5,
        decayMinCleanDurationMs: 100,
        decayFactor: 0.5,
      });

      // Build up stall
      ctrl.onGapDetected(10, 5);
      ctrl.onGapDetected(30, 7);
      ctrl.tick(100);

      // Feed some clean frames
      let captureUs = 1_000_000;
      for (let i = 0; i < 10; i++) {
        const nowMs = 200 + i * 33.33;
        captureUs += 33333;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      // New gap before full decay
      ctrl.onGapDetected(700, 20);
      expect(ctrl.phase).toBe(RecoveryPhase.Monitoring);
      // stallCount should still be at least 1
      expect(ctrl.stallCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Reset ────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all state', () => {
      const ctrl = createController();

      ctrl.onGapDetected(100, 5);
      ctrl.onGapDetected(150, 7);

      ctrl.reset();

      expect(ctrl.phase).toBe(RecoveryPhase.Normal);
      expect(ctrl.stallCount).toBe(0);
      expect(ctrl.jitterEmaMs).toBe(0);
      expect(ctrl.shouldReduceQuality).toBe(false);
    });
  });

  // ─── Effective drift threshold ────────────────────────────────────

  describe('effective drift threshold', () => {
    it('returns configured default when no jitter data', () => {
      const ctrl = createController();
      // With no frames, should return the configured baseline
      expect(ctrl.effectiveDriftThresholdMs).toBeGreaterThanOrEqual(80);
    });

    it('auto-calibrates from observed jitter', () => {
      const ctrl = createController();

      // Feed frames with ~50ms CaptureTimestamp jitter (Red5-like)
      let captureUs = 1_000_000;
      for (let i = 0; i < 100; i++) {
        const captureJitter = (i % 2 === 0) ? 50000 : -50000;
        captureUs += 33333 + captureJitter;
        const nowMs = i * 33.33;
        ctrl.onFrameArrived(nowMs, captureUs, nowMs);
      }

      // Should be > minDriftThresholdMs and adapted to jitter
      expect(ctrl.effectiveDriftThresholdMs).toBeGreaterThanOrEqual(80);
    });
  });
});
