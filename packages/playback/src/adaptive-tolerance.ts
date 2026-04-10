/**
 * Adaptive jitter tolerance controller.
 *
 * Auto-calibrates gap timeout and drift threshold from observed network
 * jitter. Implements graduated recovery (monitoring → extended wait → skip)
 * with stall-count escalation and exponential decay.
 *
 * Sans-I/O: time is an explicit parameter, no browser APIs.
 * All state is flat and mutable in place — zero allocations in the hot path.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
 * @module
 */

// ─── Recovery phases ────────────────────────────────────────────────

export const RecoveryPhase = {
  /** Baseline — no active jitter issues. */
  Normal: 'normal',
  /** Gap detected, observing whether transient or persistent. */
  Monitoring: 'monitoring',
  /** Persistent gap — waiting with extended timeout before skipping. */
  ExtendedWait: 'extended_wait',
} as const;

export type RecoveryPhaseValue = (typeof RecoveryPhase)[keyof typeof RecoveryPhase];

// ─── Configuration ──────────────────────────────────────────────────

export interface ToleranceConfig {
  // Jitter estimation
  readonly emaAlpha: number;
  readonly varianceAlpha: number;
  readonly slidingWindowSize: number;
  readonly jitterMultiplier: number;

  // Gap timeout bounds
  readonly minGapTimeoutMs: number;
  readonly maxGapTimeoutMs: number;

  // Drift auto-calibration
  readonly minDriftThresholdMs: number;
  readonly driftThresholdMultiplier: number;

  // Stall escalation
  readonly stallIncrementMs: number;
  readonly maxStallIncrements: number;

  // Recovery phases
  readonly monitorWindowMs: number;
  readonly monitorCleanFrames: number;
  readonly monitorCleanDurationMs: number;
  readonly maxExtendedWaitMs: number;

  // Skip frequency → quality reduction
  readonly skipFrequencyThreshold: number;
  readonly skipFrequencyWindowMs: number;

  // Decay
  readonly decayMinCleanFrames: number;
  readonly decayMinCleanDurationMs: number;
  readonly decayFactor: number;
}

export const DEFAULT_TOLERANCE_CONFIG: ToleranceConfig = {
  emaAlpha: 0.125,            // 1/8 — RFC 6298 gain
  varianceAlpha: 0.25,        // 1/4 — RFC 6298 gain
  slidingWindowSize: 128,     // ~4s at 30fps
  jitterMultiplier: 4.0,      // μ + 4σ ≈ 99.99% of Gaussian

  minGapTimeoutMs: 50,        // floor: ~1.5 video frames
  maxGapTimeoutMs: 2000,      // ceiling

  minDriftThresholdMs: 80,
  driftThresholdMultiplier: 3.0,

  stallIncrementMs: 33,       // 1 video frame interval
  maxStallIncrements: 3,      // max 3 × 33ms = ~100ms added

  monitorWindowMs: 500,       // observe before escalating
  monitorCleanFrames: 60,     // 1s at 60fps tick rate
  monitorCleanDurationMs: 1000,
  maxExtendedWaitMs: 2000,

  skipFrequencyThreshold: 3,  // 3 skips in window → quality reduce
  skipFrequencyWindowMs: 30000,

  decayMinCleanFrames: 120,   // 2s at 60fps
  decayMinCleanDurationMs: 2000,
  decayFactor: 0.9,           // 10% reduction per decay step
};

// ─── Tick result ────────────────────────────────────────────────────

export interface TickResult {
  /** Whether the caller should skip forward past the current gap. */
  readonly shouldSkip: boolean;
}

const TICK_NO_SKIP: TickResult = { shouldSkip: false };
const TICK_SKIP: TickResult = { shouldSkip: true };

// ─── Sliding window max ─────────────────────────────────────────────

/**
 * O(1) amortized sliding window maximum using a monotonic deque.
 * Pre-allocated, zero-alloc after construction.
 */
class SlidingMax {
  private readonly buf: Float64Array;
  private readonly deq: Uint32Array;
  private readonly capacity: number;
  private writePos = 0;
  private count = 0;
  private dHead = 0;
  private dTail = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.deq = new Uint32Array(capacity);
  }

  push(value: number): void {
    const cap = this.capacity;
    const wIdx = this.writePos % cap;

    // Evict expired front
    if (this.count === cap && this.dHead !== this.dTail
        && this.deq[this.dHead % cap] === wIdx) {
      this.dHead++;
    }

    // Maintain monotonicity from back
    while (this.dHead !== this.dTail
           && this.buf[this.deq[(this.dTail - 1) % cap]! % cap]! <= value) {
      this.dTail--;
    }

    this.deq[this.dTail % cap] = wIdx;
    this.dTail++;
    this.buf[wIdx] = value;
    this.writePos++;
    if (this.count < cap) this.count++;
  }

  get max(): number {
    if (this.dHead === this.dTail) return 0;
    return this.buf[this.deq[this.dHead % this.capacity]! % this.capacity]!;
  }

  reset(): void {
    this.writePos = 0;
    this.count = 0;
    this.dHead = 0;
    this.dTail = 0;
  }
}

// ─── Controller ─────────────────────────────────────────────────────

/**
 * Adaptive jitter tolerance controller.
 *
 * Consumes frame arrival and gap events, produces auto-calibrated
 * thresholds for gap timeout and drift detection.
 */
export class AdaptiveToleranceController {
  private readonly cfg: ToleranceConfig;

  // ── Jitter estimation ──
  private _jitterEma = 0;
  private _jitterVar = 0;
  private _lastTransitMs = 0;
  private _hasLastTransit = false;
  private readonly _slidingMax: SlidingMax;

  // ── Phase state ──
  private _phase: RecoveryPhaseValue = RecoveryPhase.Normal;
  private _phaseEnteredMs = 0;
  private _monitorGapCount = 0;
  private _stallCount = 0;
  private _stallEscalationMs = 0;

  // ── Skip frequency tracking ──
  private _skipTimestamps: number[] = [];

  // ── Clean streak tracking (for monitoring exit + decay) ──
  private _cleanFrameCount = 0;
  private _cleanStreakStartMs = 0;

  // ── Quality reduction ──
  private _shouldReduceQuality = false;

  // ── Protocol signals ──
  private _deliveryTimeoutMs = 0;

  // ── Capture timestamp jitter (for drift threshold) ──
  private _lastCaptureUs = 0;
  private _hasCaptureRef = false;
  private _captureJitterEma = 0;

  constructor(config: ToleranceConfig) {
    this.cfg = config;
    this._slidingMax = new SlidingMax(config.slidingWindowSize);
  }

  // ─── Read-only state ──────────────────────────────────────────

  get phase(): RecoveryPhaseValue { return this._phase; }
  get jitterEmaMs(): number { return this._jitterEma; }
  get jitterVarMs(): number { return this._jitterVar; }
  get slidingMaxMs(): number { return this._slidingMax.max; }
  get stallCount(): number { return this._stallCount; }
  get shouldReduceQuality(): boolean { return this._shouldReduceQuality; }

  /**
   * Auto-calibrated gap timeout in milliseconds.
   *
   * baseline = max(minGap, EMA + K × variance, slidingMax)
   * effective = min(baseline + stallEscalation, maxGap, deliveryTimeout)
   */
  get effectiveGapTimeoutMs(): number {
    const adaptive = Math.max(
      this.cfg.minGapTimeoutMs,
      this._jitterEma + this.cfg.jitterMultiplier * this._jitterVar,
      this._slidingMax.max,
    );
    const withStall = adaptive + this._stallEscalationMs;
    let capped = Math.min(withStall, this.cfg.maxGapTimeoutMs);

    if (this._deliveryTimeoutMs > 0) {
      capped = Math.min(capped, this._deliveryTimeoutMs);
    }

    return capped;
  }

  /**
   * Auto-calibrated drift threshold in milliseconds.
   *
   * Based on observed CaptureTimestamp interarrival jitter.
   */
  get effectiveDriftThresholdMs(): number {
    if (!this._hasCaptureRef || this._captureJitterEma === 0) {
      return this.cfg.minDriftThresholdMs;
    }
    return Math.max(
      this.cfg.minDriftThresholdMs,
      this._captureJitterEma * this.cfg.driftThresholdMultiplier,
    );
  }

  // ─── Events IN ────────────────────────────────────────────────

  /**
   * Notify that a frame arrived.
   *
   * @param nowMs Current time in milliseconds
   * @param captureUs CaptureTimestamp in microseconds
   * @param arrivalMs Arrival time in milliseconds
   */
  onFrameArrived(nowMs: number, captureUs: number, arrivalMs: number): void {
    // Update interarrival jitter EMA (EWMA over transit deltas)
    const transitMs = arrivalMs - captureUs * 0.001;

    if (this._hasLastTransit) {
      const d = transitMs - this._lastTransitMs;
      const absD = d < 0 ? -d : d;

      // EWMA update: α = 1/8, β = 1/4 (RFC 6298)
      const emaErr = absD - this._jitterEma;
      this._jitterEma += this.cfg.emaAlpha * emaErr;
      this._jitterVar += this.cfg.varianceAlpha * (absD - this._jitterVar);

      // Sliding window max
      this._slidingMax.push(absD);
    }

    this._lastTransitMs = transitMs;
    this._hasLastTransit = true;

    // Capture timestamp jitter (for drift threshold)
    if (this._hasCaptureRef) {
      const captureIntervalUs = captureUs - this._lastCaptureUs;
      // Expected ~33333 for 30fps, ~20000 for audio — we don't know, just track variance
      const captureJitterMs = Math.abs(captureIntervalUs) * 0.001;
      // Track the variance of capture intervals, not absolute value
      if (this._captureJitterEma === 0) {
        this._captureJitterEma = captureJitterMs;
      } else {
        this._captureJitterEma += this.cfg.emaAlpha * (captureJitterMs - this._captureJitterEma);
      }
    }
    this._lastCaptureUs = captureUs;
    this._hasCaptureRef = true;

    // Clean streak tracking
    this._cleanFrameCount++;
    if (this._cleanFrameCount === 1) {
      this._cleanStreakStartMs = nowMs;
    }
  }

  /**
   * Notify that a gap was detected.
   *
   * @param nowMs Current time in milliseconds
   * @param groupId The group ID where the gap was detected
   */
  onGapDetected(nowMs: number, _groupId: number): void {
    this._cleanFrameCount = 0;

    switch (this._phase) {
      case RecoveryPhase.Normal:
        this._phase = RecoveryPhase.Monitoring;
        this._phaseEnteredMs = nowMs;
        this._monitorGapCount = 1;
        break;

      case RecoveryPhase.Monitoring:
        this._monitorGapCount++;
        if (this._monitorGapCount >= 2
            && nowMs - this._phaseEnteredMs <= this.cfg.monitorWindowMs) {
          // Persistent gap — escalate
          this._phase = RecoveryPhase.ExtendedWait;
          this._phaseEnteredMs = nowMs;
        }
        break;

      case RecoveryPhase.ExtendedWait:
        // Already waiting — no further escalation
        break;
    }
  }

  /**
   * Periodic tick — evaluate phase transitions and decay.
   *
   * @param nowMs Current time in milliseconds
   * @returns TickResult indicating whether caller should skip forward
   */
  tick(nowMs: number): TickResult {
    switch (this._phase) {
      case RecoveryPhase.Monitoring: {
        // Check if monitoring window expired without 2nd gap → clean exit
        if (nowMs - this._phaseEnteredMs > this.cfg.monitorWindowMs) {
          // Check clean period
          if (this._cleanFrameCount >= this.cfg.monitorCleanFrames
              && nowMs - this._cleanStreakStartMs >= this.cfg.monitorCleanDurationMs) {
            this._phase = RecoveryPhase.Normal;
            return TICK_NO_SKIP;
          }
        }
        break;
      }

      case RecoveryPhase.ExtendedWait: {
        if (nowMs - this._phaseEnteredMs >= this.cfg.maxExtendedWaitMs) {
          // Timeout — skip forward
          this._stallCount++;
          this._stallEscalationMs = Math.min(
            this._stallCount * this.cfg.stallIncrementMs,
            this.cfg.maxStallIncrements * this.cfg.stallIncrementMs,
          );

          // Track skip frequency for quality reduction
          this._skipTimestamps.push(nowMs);
          this._pruneSkipTimestamps(nowMs);
          if (this._skipTimestamps.length >= this.cfg.skipFrequencyThreshold) {
            this._shouldReduceQuality = true;
          }

          this._phase = RecoveryPhase.Normal;
          this._cleanFrameCount = 0;
          return TICK_SKIP;
        }
        break;
      }

      case RecoveryPhase.Normal: {
        // Decay stall escalation during clean periods
        if (this._stallEscalationMs > 0
            && this._cleanFrameCount >= this.cfg.decayMinCleanFrames
            && this._cleanStreakStartMs > 0
            && nowMs - this._cleanStreakStartMs >= this.cfg.decayMinCleanDurationMs) {
          this._stallEscalationMs *= this.cfg.decayFactor;
          if (this._stallEscalationMs < 1) {
            this._stallEscalationMs = 0;
            this._stallCount = 0;
          }
          // Reset clean counters for next decay step
          this._cleanFrameCount = 0;
          this._cleanStreakStartMs = nowMs;
        }

        // Decay quality reduction flag
        if (this._shouldReduceQuality) {
          this._pruneSkipTimestamps(nowMs);
          if (this._skipTimestamps.length < this.cfg.skipFrequencyThreshold) {
            this._shouldReduceQuality = false;
          }
        }
        break;
      }
    }

    return TICK_NO_SKIP;
  }

  /**
   * Set DELIVERY_TIMEOUT from protocol negotiation.
   * Caps the effective gap timeout.
   *
   * @see draft-ietf-moq-transport-16 §9.2.2.2
   */
  setDeliveryTimeout(timeoutMs: number): void {
    this._deliveryTimeoutMs = timeoutMs;
  }

  /** Reset all state (seek, pause→resume). */
  reset(): void {
    this._jitterEma = 0;
    this._jitterVar = 0;
    this._lastTransitMs = 0;
    this._hasLastTransit = false;
    this._slidingMax.reset();

    this._phase = RecoveryPhase.Normal;
    this._phaseEnteredMs = 0;
    this._monitorGapCount = 0;
    this._stallCount = 0;
    this._stallEscalationMs = 0;

    this._skipTimestamps = [];
    this._cleanFrameCount = 0;
    this._cleanStreakStartMs = 0;
    this._shouldReduceQuality = false;
    this._deliveryTimeoutMs = 0;

    this._lastCaptureUs = 0;
    this._hasCaptureRef = false;
    this._captureJitterEma = 0;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private _pruneSkipTimestamps(nowMs: number): void {
    const windowStart = nowMs - this.cfg.skipFrequencyWindowMs;
    this._skipTimestamps = this._skipTimestamps.filter(t => t >= windowStart);
  }
}
