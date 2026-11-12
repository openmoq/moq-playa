/**
 * A/V sync controller with injectable clock.
 *
 * Audio-master model: the first audio sample establishes a sync reference
 * mapping CaptureTimestamp (wall-clock microseconds) to local clock time.
 * Video render times are computed relative to this reference.
 *
 * Drift detection: reportPresentationTiming measures VIDEO PRESENTATION SCHEDULE
 * drift — actual presentation time minus the exact scheduled time carried with
 * the frame. If it exceeds the adaptive threshold, presentationDriftExceeded
 * signals and a sync_drift event is emitted — but no automatic re-anchor occurs.
 * Actual audio/video skew is a separate metric (sync_skew).
 * The reference is set once to avoid audio glitching from re-anchor jumps.
 * In practice, gap recovery (skip_forward) and seek/pause naturally re-anchor.
 *
 * Capture-age diagnostics compare timestamps against the receiver wall clock.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
 * @module
 */

import type { ClockSource } from './types.js';

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

    /** Injectable wall-clock for testability. Default: Date.now() * 1000. */
    readonly wallClock?: WallClockSource;
}

// ─── SyncController ─────────────────────────────────────────────────

/**
 * A/V sync controller with capture-age diagnostics.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1
 */
export class SyncController {
    private _driftThresholdUs: number;
    private readonly dropThresholdUs: number;
    private readonly clock: ClockSource;

    /** Local clock time when audio reference was set. */
    private localBaselineUs: number | undefined;
    private referenceRevision = 0;
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

    // ── Capture-age diagnostics ─────────────────────────────────────────
    private readonly wallClock: WallClockSource;
    private _captureTimestampAgeUs: number | null = null;
    /** Latest age per timestamp source whose latest observation was measurable,
     *  in measurement order (the last entry is the most recent). */
    private readonly _captureTimestampAgeBySource = new Map<'audio' | 'video' | '', number>();

    constructor(config: SyncControllerConfig) {
        this._driftThresholdUs = config.driftThresholdUs;
        this.dropThresholdUs = config.dropThresholdUs ?? DEFAULT_DROP_THRESHOLD_US;
        this.clock = config.clock;

        this.wallClock = config.wallClock ?? DEFAULT_WALL_CLOCK;
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

    /**
     * Whether PRESENTATION SCHEDULE drift exceeds the threshold.
     *
     * Deliberately has NO live-join suppression. The exact queued schedule
     * already contains the join offset, so missing that schedule during a join
     * is a real miss. (The legacy PTS-era metric needed the suppression because
     * the offset itself showed up as drift; see {@link needsResync}.)
     */
    get presentationDriftExceeded(): boolean {
        return Math.abs(this._currentDriftUs) >= this._driftThresholdUs;
    }

    /**
     * @deprecated Threshold check for the legacy {@link reportActualRenderTime}
     * metric, retaining its live-join suppression. Use
     * {@link presentationDriftExceeded} with schedule-based measurement.
     */
    get needsResync(): boolean {
        // Suppress during video join — under the LEGACY PTS-anchored metric the
        // offset itself appeared as drift.
        if (this._videoJoinOffsetUs > 0) return false;
        return Math.abs(this._currentDriftUs) >= this._driftThresholdUs;
    }

    /**
     * Legacy numeric alias for captureTimestampAgeUs; 0 also means unavailable.
     * This uncorrected clock difference is not verified presentation latency.
     * @see draft-ietf-moq-loc-01 §2.3.1.1
     */
    get latencyUs(): number {
        return this._captureTimestampAgeUs ?? 0;
    }

    /** Latest receiver-wall-clock minus capture timestamp, in microseconds.
     * Null before a wall-clock observation, after reset, and while no source's
     * latest observation is measurable (see observeCaptureTimestamp).
     * May be zero or negative; no sender/receiver clock correction is implied.
     */
    get captureTimestampAgeUs(): number | null {
        return this._captureTimestampAgeUs;
    }

    /**
     * Establish sync reference from an audio sample.
     * Maps captureTimestamp to the current local clock time.
     * Resets drift measurement.
     *
     * @param captureTimestampUs CaptureTimestamp in microseconds
     */
    setAudioReference(captureTimestampUs: bigint): void {
        const revision = ++this.referenceRevision;
        const now = this.clock.now();
        // An injected clock may reset or establish a newer reference.
        if (revision !== this.referenceRevision) return;
        this.localBaselineUs = now;
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
        const revision = ++this.referenceRevision;
        const now = this.clock.now();
        // An injected clock may reset or establish a newer reference.
        if (revision !== this.referenceRevision) return;
        this.localBaselineUs = now;
        this.captureBaselineUs = captureTimestampUs;
        this._currentDriftUs = 0;
    }

    /** Move the shared reference later by positive finite microseconds, preserving drift.
     * No-op without a reference or for other amounts. Retire old queued output before resuming. */
    slipReference(byUs: number): void {
        if (this.localBaselineUs === undefined || !Number.isFinite(byUs) || byUs <= 0) return;
        this.localBaselineUs += byUs;
    }

    /** Move the shared reference earlier for audio and video, giving back playout latency.
     * Positive finite microseconds only; otherwise, or without a reference, a no-op.
     * Preserves drift; the caller must retire output scheduled on the old timeline. */
    advanceReference(byUs: number): void {
        if (this.localBaselineUs === undefined || !Number.isFinite(byUs) || byUs <= 0) return;
        this.localBaselineUs -= byUs;
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

        const revision = this.referenceRevision;
        const naiveRenderTimeUs = this.localBaselineUs +
            Number(firstKeyframeCaptureUs - this.captureBaselineUs);
        const nowUs = this.clock.now();
        if (revision !== this.referenceRevision) return;
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
        const revision = this.referenceRevision;
        const timing = this.computeRenderTime(captureTimestampUs);
        if (timing === null) return null;

        if (this._videoJoinOffsetUs > 0) {
            // Apply offset — shift render time forward
            const adjustedRenderTimeUs = timing.renderTimeUs + this._videoJoinOffsetUs;
            const nowUs = this.clock.now();
            if (revision !== this.referenceRevision) return null;

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
     * @param outputDelayUs Downstream delay used only for late admission.
     * Returned render time and offset stay nominal; callers add the delay once.
     */
    computeAudioRenderTime(captureTimestampUs: bigint, outputDelayUs = 0): RenderTiming | null {
        if (!Number.isFinite(outputDelayUs) || outputDelayUs < 0) {
            throw new RangeError('Audio output delay must be finite and nonnegative');
        }
        return this.computeRenderTime(captureTimestampUs, outputDelayUs);
    }

    /**
     * Record PRESENTATION SCHEDULE drift: did the renderer present the frame
     * when it was told to?
     *
     * `scheduledUs` must be the EXACT timestamp stored with the rendered frame.
     * It already accounts for the playout cushion actually applied to that
     * frame, the live-join offset, decode-output recomputation and late-frame
     * handling — none of which may be recomputed or subtracted later, because an
     * adaptive cushion can move between enqueue and presentation.
     *
     * The schedule is REQUIRED here. Optionality lives at
     * `FrameRenderedFeedback`, where the pipeline suppresses the whole
     * measurement/event transaction cleanly: missing evidence is not drift.
     *
     * Actual audio/video skew is measured separately as `sync_skew`.
     */
    reportPresentationTiming(scheduledUs: number, actualUs: number): void {
        this._currentDriftUs = actualUs - scheduledUs;
    }

    /**
     * @deprecated Compares against the UNCUSHIONED PTS-anchored time, so a
     * stream presenting exactly on its intended schedule reports the whole
     * playout cushion as drift. Retained as a compatibility path only; use
     * {@link reportPresentationTiming}.
     */
    reportActualRenderTime(captureTimestampUs: bigint, actualLocalUs: number): void {
        if (this.localBaselineUs === undefined || this.captureBaselineUs === undefined) return;

        const expectedRenderUs = this.localBaselineUs +
            Number(captureTimestampUs - this.captureBaselineUs);

        this._currentDriftUs = actualLocalUs - expectedRenderUs;
    }

    // ─── Capture-age diagnostics ──────────────────────────────────────────────

    /**
     * Measure uncorrected receiver-wall-clock minus capture timestamp.
     *
     * Compares the publisher's wall-clock timestamp to the subscriber's
     * wall clock, both in Unix epoch microseconds. A media-time timestamp
     * (LOC-04 with Timescale) has no wall-clock meaning, so latency is
     * unmeasurable and this returns null.
     *
     * @param captureTimestampUs Timestamp in microseconds
     * @param isWallClock False when the timestamp is media time. Undefined means wall clock.
     * @returns Signed clock difference in microseconds, or null if unmeasurable.
     * This does not measure presentation or establish clock synchronization.
     * @see draft-ietf-moq-loc-01 §2.3.1.1
     * @see draft-ietf-moq-loc-04 §2.3.1.2
     */
    measureLatency(captureTimestampUs: bigint, isWallClock?: boolean): number | null {
        if (captureTimestampUs === 0n || isWallClock === false) return null;
        const ageUs = this.wallClock.now() - Number(captureTimestampUs);
        return Number.isFinite(ageUs) ? ageUs : null;
    }

    /**
     * Record the capture-age diagnostic for a timestamp source.
     *
     * @param captureTimestampUs CaptureTimestamp in microseconds (Unix epoch)
     * @param isWallClock False when the timestamp is media time. Undefined means wall clock.
     * @param source Media role, or the empty source for legacy two-argument callers.
     *   An unmeasurable timestamp invalidates only its own source's age, so a
     *   media-time track cannot null out a wall-clock track's measurement.
     */
    observeCaptureTimestamp(captureTimestampUs: bigint, isWallClock?: boolean, source: 'audio' | 'video' | '' = ''): void {
        if (source !== '' && source !== 'audio' && source !== 'video') {
            throw new TypeError('Capture timestamp source must be audio, video, or the legacy empty source');
        }
        const ageUs = this.measureLatency(captureTimestampUs, isWallClock);
        const ages = this._captureTimestampAgeBySource;
        ages.delete(source);
        if (ageUs !== null) ages.set(source, ageUs);
        let latest: number | null = null;
        for (const age of ages.values()) latest = age;
        this._captureTimestampAgeUs = latest;
    }

    /**
     * Reset the sync reference (e.g., after a skip-forward).
     */
    reset(): void {
        this.referenceRevision++;
        this._captureTimestampAgeUs = null;
        this._captureTimestampAgeBySource.clear();
        this.localBaselineUs = undefined;
        this.captureBaselineUs = undefined;
        this._currentDriftUs = 0;
        this._videoJoinOffsetUs = 0;
    }

    // ─── Internal ───────────────────────────────────────────────────

    private computeRenderTime(captureTimestampUs: bigint, outputDelayUs = 0): RenderTiming | null {
        if (this.localBaselineUs === undefined || this.captureBaselineUs === undefined) {
            return null;
        }

        const revision = this.referenceRevision;
        const now = this.clock.now();
        if (revision !== this.referenceRevision) return null;

        const renderTimeUs = this.localBaselineUs +
            Number(captureTimestampUs - this.captureBaselineUs);

        const offsetUs = renderTimeUs - now;
        const shouldDrop = offsetUs + outputDelayUs < -this.dropThresholdUs;

        return { renderTimeUs, offsetUs, shouldDrop };
    }
}
