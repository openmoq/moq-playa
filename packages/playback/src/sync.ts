/**
 * A/V sync controller with injectable clock.
 *
 * Audio-master model: the first audio sample establishes a sync reference
 * mapping CaptureTimestamp (wall-clock microseconds) to local clock time.
 * Video render times are computed relative to this reference.
 *
 * Drift detection: reportActualRenderTime measures the gap between expected
 * and actual render times. If drift exceeds the adaptive threshold, needsResync
 * signals and a sync_drift event is emitted — but no automatic re-anchor occurs.
 * The reference is set once to avoid audio glitching from re-anchor jumps.
 * In practice, gap recovery (skip_forward) and seek/pause naturally re-anchor.
 *
 * Live catch-up: measures end-to-end latency by comparing CaptureTimestamp
 * (publisher wall-clock) to subscriber wall-clock. When latency exceeds
 * targetLatency + threshold, activates catch-up (playback rate > 1.0).
 * Hysteresis prevents oscillation near the threshold boundary.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 * @module
 */

import type { ClockSource, CatchUpState } from './types.js';

// ─── Render timing ──────────────────────────────────────────────────

/**
 * Render time calculation result.
 */
export interface RenderTiming {
    /** When to render this frame, in local clock microseconds. */
    readonly renderTimeUs: number;
    /** How far ahead (+) or behind (-) this frame is relative to now. */
    readonly offsetUs: number;
    /** Whether this frame should be dropped (too late to render). */
    readonly shouldDrop: boolean;
}

/** Default: frames more than 500ms late are dropped. */
const DEFAULT_DROP_THRESHOLD_US = 500_000;

// ─── Wall clock ─────────────────────────────────────────────────────

/**
 * Injectable wall-clock source for latency measurement.
 * Returns Unix epoch microseconds (same domain as CaptureTimestamp).
 * Default: `Date.now() * 1000`.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp = wall-clock µs)
 */
export interface WallClockSource {
    /** Current wall-clock time in microseconds since Unix epoch. */
    now(): number;
}

/** Default wall clock — Date.now() converted to microseconds. */
const DEFAULT_WALL_CLOCK: WallClockSource = { now: () => Date.now() * 1000 };

// ─── SyncController config ──────────────────────────────────────────

export interface SyncControllerConfig {
    readonly driftThresholdUs: number;
    readonly dropThresholdUs?: number;
    readonly clock: ClockSource;

    // ── Catch-up (§5.1.16 targetLatency) ───────────────────────
    /** Target end-to-end latency in ms. @see draft-ietf-moq-msf-00 §5.1.16 */
    readonly targetLatencyMs?: number;
    /** Max playback rate for catch-up (e.g., 1.1). Default: 1.0 (disabled). */
    readonly maxCatchUpRate?: number;
    /** Latency above target before catch-up activates (ms). Default: 500. */
    readonly catchUpThresholdMs?: number;
    /** Latency above target before catch-up deactivates (ms, hysteresis). Default: 50. */
    readonly catchUpRecoveryMs?: number;
    /** Injectable wall-clock for testability. Default: Date.now() * 1000. */
    readonly wallClock?: WallClockSource;
}

// ─── SyncController ─────────────────────────────────────────────────

/**
 * A/V sync controller with live catch-up.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1
 * @see draft-ietf-moq-msf-00 §5.1.16
 */
export class SyncController {
    private _driftThresholdUs: number;
    private readonly dropThresholdUs: number;
    private readonly clock: ClockSource;

    /** Local clock time when audio reference was set. */
    private localBaselineUs: number | undefined;
    /** CaptureTimestamp of the audio reference sample. */
    private captureBaselineUs: bigint | undefined;

    /** Accumulated drift measurement. */
    private _currentDriftUs = 0;

    /**
     * Video join offset — shifts video render times forward during live join.
     *
     * When joining a live stream, video starts from the GOP boundary
     * (which has an older CaptureTimestamp than the current audio).
     * This offset shifts video render times forward so the first frames
     * render in the future instead of the past, preventing startup stutter.
     *
     * Snaps to zero when the video timeline catches up to the audio live edge.
     * Audio render times are unaffected.
     */
    private _videoJoinOffsetUs = 0;

    // ── Catch-up state ─────────────────────────────────────────
    private readonly wallClock: WallClockSource;
    private readonly targetLatencyMs: number | undefined;
    private readonly maxCatchUpRate: number;
    private readonly catchUpThresholdMs: number;
    private readonly catchUpRecoveryMs: number;

    private _catchUpActive = false;
    private _currentRate = 1.0;
    private _lastLatencyUs = 0;

    constructor(config: SyncControllerConfig) {
        this._driftThresholdUs = config.driftThresholdUs;
        this.dropThresholdUs = config.dropThresholdUs ?? DEFAULT_DROP_THRESHOLD_US;
        this.clock = config.clock;

        // Catch-up config
        this.wallClock = config.wallClock ?? DEFAULT_WALL_CLOCK;
        this.targetLatencyMs = config.targetLatencyMs;
        this.maxCatchUpRate = config.maxCatchUpRate ?? 1.0;
        this.catchUpThresholdMs = config.catchUpThresholdMs ?? 500;
        this.catchUpRecoveryMs = config.catchUpRecoveryMs ?? 50;
    }

    /** Whether a sync reference has been established. */
    get hasReference(): boolean {
        return this.localBaselineUs !== undefined;
    }

    /** Current drift magnitude in microseconds. */
    get currentDriftUs(): number {
        return this._currentDriftUs;
    }

    /** Current drift threshold in microseconds. Mutable for adaptive tolerance. */
    get driftThresholdUs(): number { return this._driftThresholdUs; }
    set driftThresholdUs(value: number) { this._driftThresholdUs = value; }

    /** Whether drift exceeds the threshold and resync is recommended. */
    get needsResync(): boolean {
        // Suppress during video join — the offset would look like drift
        if (this._videoJoinOffsetUs > 0) return false;
        return Math.abs(this._currentDriftUs) >= this._driftThresholdUs;
    }

    /** Whether catch-up is currently active. */
    get catchUpActive(): boolean {
        return this._catchUpActive;
    }

    /** Current playback rate (1.0 when catch-up inactive). */
    get currentRate(): number {
        return this._currentRate;
    }

    /**
     * Last measured latency in microseconds.
     * 0 before first measurement.
     * @see draft-ietf-moq-loc-01 §2.3.1.1
     */
    get latencyUs(): number {
        return this._lastLatencyUs;
    }

    /**
     * Establish sync reference from an audio sample.
     * Maps captureTimestamp to the current local clock time.
     * Resets drift measurement.
     *
     * @param captureTimestampUs CaptureTimestamp in microseconds
     */
    setAudioReference(captureTimestampUs: bigint): void {
        this.localBaselineUs = this.clock.now();
        this.captureBaselineUs = captureTimestampUs;
        this._currentDriftUs = 0;
    }

    /**
     * Establish sync reference from a video frame (video-only mode).
     * No-op if a reference already exists — audio has priority.
     *
     * @param captureTimestampUs CaptureTimestamp of the first video frame
     */
    setVideoReference(captureTimestampUs: bigint): void {
        if (this.hasReference) return;
        this.localBaselineUs = this.clock.now();
        this.captureBaselineUs = captureTimestampUs;
        this._currentDriftUs = 0;
    }

    /** Current video join offset in microseconds. 0 = no offset active. */
    get videoJoinOffsetUs(): number {
        return this._videoJoinOffsetUs;
    }

    /**
     * Apply video join re-anchor for live stream join.
     *
     * Called when the first video keyframe is decoded after a live join.
     * Computes an offset that shifts video render times forward so the
     * first frame renders at `now + cushion` instead of in the past.
     *
     * The offset is a constant added to all video render times. It preserves
     * inter-frame timing (33ms spacing) while shifting the whole timeline.
     * Snaps to zero when video catches up to the live edge.
     *
     * @param firstKeyframeCaptureUs CaptureTimestamp of the first keyframe
     * @param cushionUs Extra future cushion (default: 16ms ≈ 1 rAF tick)
     */
    onVideoJoin(firstKeyframeCaptureUs: bigint, cushionUs: number = 16_000): void {
        if (this.localBaselineUs === undefined || this.captureBaselineUs === undefined) return;

        const naiveRenderTimeUs = this.localBaselineUs +
            Number(firstKeyframeCaptureUs - this.captureBaselineUs);
        const nowUs = this.clock.now();
        const gapUs = nowUs + cushionUs - naiveRenderTimeUs;

        if (gapUs > 0) {
            this._videoJoinOffsetUs = gapUs;
        }
    }

    /**
     * Compute render timing for a video frame.
     *
     * @param captureTimestampUs CaptureTimestamp in microseconds
     */
    computeVideoRenderTime(captureTimestampUs: bigint): RenderTiming | null {
        const timing = this.computeRenderTime(captureTimestampUs);
        if (timing === null) return null;

        if (this._videoJoinOffsetUs > 0) {
            // Apply offset — shift render time forward
            const adjustedRenderTimeUs = timing.renderTimeUs + this._videoJoinOffsetUs;
            const nowUs = this.clock.now();

            // Check if base render time (without offset) is now in the future
            // → video has caught up to live edge, snap offset to zero
            if (timing.renderTimeUs > nowUs) {
                this._videoJoinOffsetUs = 0;
                return timing; // use unmodified timing from here
            }

            const offsetUs = adjustedRenderTimeUs - nowUs;
            return {
                renderTimeUs: adjustedRenderTimeUs,
                offsetUs,
                shouldDrop: offsetUs < -this.dropThresholdUs,
            };
        }

        return timing;
    }

    /**
     * Compute render timing for an audio sample.
     *
     * @param captureTimestampUs CaptureTimestamp in microseconds
     */
    computeAudioRenderTime(captureTimestampUs: bigint): RenderTiming | null {
        return this.computeRenderTime(captureTimestampUs);
    }

    /**
     * Report actual render/playout time for drift detection.
     *
     * @param captureTimestampUs CaptureTimestamp of the rendered frame
     * @param actualLocalUs Actual local clock time when frame was rendered
     */
    reportActualRenderTime(captureTimestampUs: bigint, actualLocalUs: number): void {
        if (this.localBaselineUs === undefined || this.captureBaselineUs === undefined) return;

        const expectedRenderUs = this.localBaselineUs +
            Number(captureTimestampUs - this.captureBaselineUs);

        this._currentDriftUs = actualLocalUs - expectedRenderUs;
    }

    // ─── Live Catch-Up ──────────────────────────────────────────────

    /**
     * Measure end-to-end latency from CaptureTimestamp.
     *
     * Compares publisher wall-clock (CaptureTimestamp) to subscriber
     * wall-clock (Date.now()). Both in Unix epoch microseconds.
     *
     * @param captureTimestampUs CaptureTimestamp in microseconds (Unix epoch)
     * @returns Latency in microseconds, or null if timestamp is missing/zero
     * @see draft-ietf-moq-loc-01 §2.3.1.1
     */
    measureLatency(captureTimestampUs: bigint): number | null {
        if (captureTimestampUs === 0n) return null;
        return this.wallClock.now() - Number(captureTimestampUs);
    }

    /**
     * Evaluate catch-up state based on current latency.
     *
     * Hysteresis: activates when latency > target + threshold,
     * deactivates when latency <= target + recovery.
     *
     * Rate is proportional to overshoot, quantized to 0.05x increments.
     *
     * @param captureTimestampUs CaptureTimestamp in microseconds (Unix epoch)
     * @returns CatchUpState if evaluated, null if catch-up is disabled or no timestamp
     * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
     */
    evaluateCatchUp(captureTimestampUs: bigint): CatchUpState | null {
        // Measure latency
        const latencyUs = this.measureLatency(captureTimestampUs);
        if (latencyUs === null) return null;

        this._lastLatencyUs = latencyUs;

        // Catch-up disabled?
        if (this.targetLatencyMs === undefined || this.maxCatchUpRate <= 1.0) return null;

        const latencyMs = latencyUs / 1000;
        const targetMs = this.targetLatencyMs;

        // Hysteresis: activate/deactivate
        if (!this._catchUpActive && latencyMs > targetMs + this.catchUpThresholdMs) {
            this._catchUpActive = true;
        } else if (this._catchUpActive && latencyMs <= targetMs + this.catchUpRecoveryMs) {
            this._catchUpActive = false;
            this._currentRate = 1.0;
            return { active: false, currentRate: 1.0, latencyMs, targetMs };
        }

        if (this._catchUpActive) {
            // Proportional rate: scale linearly with overshoot
            const overshoot = latencyMs - targetMs;
            const ratio = Math.min(Math.max(overshoot / this.catchUpThresholdMs, 0), 1);
            const rawRate = 1.0 + (this.maxCatchUpRate - 1.0) * ratio;
            // Quantize to 0.05x increments
            const quantized = Math.round(rawRate * 20) / 20;
            // Clamp to [1.0, maxCatchUpRate]
            this._currentRate = Math.min(Math.max(quantized, 1.0), this.maxCatchUpRate);
        }

        return {
            active: this._catchUpActive,
            currentRate: this._currentRate,
            latencyMs,
            targetMs,
        };
    }

    /**
     * Reset the sync reference (e.g., after a skip-forward).
     */
    reset(): void {
        this.localBaselineUs = undefined;
        this.captureBaselineUs = undefined;
        this._currentDriftUs = 0;
        this._videoJoinOffsetUs = 0;
        this._catchUpActive = false;
        this._currentRate = 1.0;
    }

    // ─── Internal ───────────────────────────────────────────────────

    private computeRenderTime(captureTimestampUs: bigint): RenderTiming | null {
        if (this.localBaselineUs === undefined || this.captureBaselineUs === undefined) {
            return null;
        }

        const now = this.clock.now();

        const renderTimeUs = this.localBaselineUs +
            Number(captureTimestampUs - this.captureBaselineUs);

        const offsetUs = renderTimeUs - now;
        const shouldDrop = offsetUs < -this.dropThresholdUs;

        return { renderTimeUs, offsetUs, shouldDrop };
    }
}
