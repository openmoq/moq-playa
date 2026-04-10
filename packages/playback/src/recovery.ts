/**
 * Recovery controller — decides how to respond to playback failures.
 *
 * Sits between the pipeline and the player. The pipeline detects problems
 * (gaps, buffer overflow, server signals), the recovery controller decides
 * the response (skip, reduce quality, resubscribe, terminate).
 *
 * Purely event-driven: escalation is based on consecutive gap counts,
 * not timing windows. A successful frame decode (notifySuccess) resets
 * the gap counter, closing the feedback loop.
 *
 * Local policy reacting to transport signals:
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status — gap detection)
 * @see draft-ietf-moq-transport-16 §13.4.3 (TOO_FAR_BEHIND signal)
 * @see draft-ietf-moq-transport-16 §13.4.4 (DELIVERY_TIMEOUT signal)
 * @module
 */

// ─── Trigger types ──────────────────────────────────────────────────

/**
 * What went wrong — input to the recovery controller.
 */
export type RecoveryTrigger =
    | { readonly type: 'gap'; readonly groupId: bigint }
    | { readonly type: 'stall'; readonly durationMs: number }
    | { readonly type: 'buffer_overflow' }
    | { readonly type: 'too_far_behind' }
    | { readonly type: 'delivery_timeout' }
    | { readonly type: 'decode_error'; readonly message: string };

// ─── Action types ───────────────────────────────────────────────────

/**
 * What to do about it — output from the recovery controller.
 */
export type RecoveryAction =
    | { readonly type: 'skip_forward' }
    | { readonly type: 'reduce_quality'; readonly reason: string }
    | { readonly type: 'pause_subscription'; readonly reason: string }
    | { readonly type: 'resubscribe'; readonly startGroup?: bigint }
    | { readonly type: 'terminate'; readonly reason: string };

// ─── Interface ──────────────────────────────────────────────────────

/**
 * Recovery controller interface.
 *
 * Implementations decide how to respond to playback failures.
 * The player layer consumes the returned actions.
 */
export interface RecoveryController {
    evaluate(trigger: RecoveryTrigger): RecoveryAction;
    /** Signal that a frame was successfully decoded — resets gap escalation. */
    notifySuccess?(): void;
    /** Reset all accumulated state (e.g., pause→resume). */
    reset?(): void;
}

// ─── Default implementation ─────────────────────────────────────────

/** Configuration for the default recovery controller. */
export interface DefaultRecoveryConfig {
    /** Number of consecutive gaps that triggers quality reduction. Default: 3. */
    readonly gapEscalationThreshold?: number;
    /** Maximum decode errors before terminating. Default: 2. */
    readonly maxDecodeErrors?: number;
    /**
     * Window-based escalation: emit `reduce_quality` when this many
     * gap events fire within `windowedEscalationWindowMs`, regardless
     * of interleaved `notifySuccess()` calls. Catches the pattern
     * where gaps alternate with successful decodes (so the consecutive
     * counter never reaches threshold) but the overall stall rate is
     * unacceptable. Default: 5.
     */
    readonly windowedEscalationThreshold?: number;
    /**
     * Time window (ms) for the windowed escalation counter.
     * Gap timestamps older than this are evicted before checking the
     * threshold. Default: 30_000 (30 seconds).
     */
    readonly windowedEscalationWindowMs?: number;
    /**
     * Minimum stall duration (ms) to count as a quality-degradation
     * signal. Short stalls (50-100ms) are normal jitter; sustained
     * stalls (300ms+) indicate the network can't keep up. Default: 300.
     */
    readonly stallThresholdMs?: number;
}

/**
 * Default recovery controller — event-driven escalation.
 *
 * Policy:
 * - Single gap → skip_forward
 * - N consecutive gaps → reduce_quality (N = gapEscalationThreshold)
 * - M gaps within W seconds → reduce_quality (windowed escalation,
 *   catches alternating gap/success patterns that reset the
 *   consecutive counter)
 * - After reduce_quality, further gaps → skip_forward until notifySuccess()
 * - notifySuccess() (frame decoded) resets gap counter + re-arms escalation
 * - buffer_overflow → reduce_quality
 * - too_far_behind → reduce_quality (reacting to §13.4.3 signal)
 * - delivery_timeout → resubscribe (reacting to §13.4.4 signal)
 * - decode_error → resubscribe (first), terminate (repeated)
 */
export class DefaultRecoveryController implements RecoveryController {
    private readonly gapEscalationThreshold: number;
    private readonly maxDecodeErrors: number;
    private readonly windowedThreshold: number;
    private readonly windowedWindowUs: number;
    private readonly stallThresholdMs: number;
    private readonly clock: { now(): number } | null;

    /** Consecutive gap events without a successful decode. */
    private consecutiveGaps = 0;

    /**
     * True after reduce_quality fires — gates further escalation until
     * notifySuccess() confirms the quality reduction helped.
     */
    private qualityReductionPending = false;

    /** Number of decode errors seen (for escalation). */
    private decodeErrorCount = 0;

    /** Timestamps (µs) of recent gap events for windowed escalation. */
    private readonly gapTimestamps: number[] = [];

    constructor(config?: DefaultRecoveryConfig) {
        this.gapEscalationThreshold = config?.gapEscalationThreshold ?? 3;
        this.maxDecodeErrors = config?.maxDecodeErrors ?? 2;
        this.windowedThreshold = config?.windowedEscalationThreshold ?? 5;
        this.windowedWindowUs = (config?.windowedEscalationWindowMs ?? 30_000) * 1000;
        this.stallThresholdMs = config?.stallThresholdMs ?? 300;
        this.clock = null;
    }

    /**
     * Attach a clock source for windowed escalation. Without a clock
     * the windowed path is silently disabled (consecutive-only policy).
     * Kept as a setter rather than a constructor param so existing
     * callers that don't need windowed escalation don't break.
     */
    setClock(clock: { now(): number }): void {
        (this as unknown as { clock: { now(): number } | null }).clock = clock;
    }

    evaluate(trigger: RecoveryTrigger): RecoveryAction {
        switch (trigger.type) {
            case 'gap':
                return this.handleGap();

            case 'stall':
                return this.handleStall(trigger.durationMs);

            case 'buffer_overflow':
                return this.escalateOrSkip('jitter buffer overflow');

            case 'too_far_behind':
                return this.escalateOrSkip('server reported TOO_FAR_BEHIND');

            case 'delivery_timeout':
                return { type: 'resubscribe' };

            case 'decode_error':
                return this.handleDecodeError(trigger.message);
        }
    }

    /**
     * Signal that a frame was successfully decoded/rendered.
     *
     * Resets the consecutive gap counter and re-arms quality escalation.
     * This closes the feedback loop: gaps → reduce_quality → better frames
     * arrive → notifySuccess → ready for next escalation if needed.
     */
    notifySuccess(): void {
        this.consecutiveGaps = 0;
        this.qualityReductionPending = false;
    }

    /** Reset all state — e.g., after pause→resume. */
    reset(): void {
        this.consecutiveGaps = 0;
        this.qualityReductionPending = false;
        this.decodeErrorCount = 0;
        this.gapTimestamps.length = 0;
    }

    // ─── Internal ───────────────────────────────────────────────────

    /**
     * Request quality reduction, gated by the pending flag.
     * If a reduce_quality is already pending (waiting for notifySuccess),
     * return skip_forward instead to prevent spam.
     */
    private escalateOrSkip(reason: string): RecoveryAction {
        if (this.qualityReductionPending) {
            return { type: 'skip_forward' };
        }
        this.qualityReductionPending = true;
        return { type: 'reduce_quality', reason };
    }

    private handleGap(): RecoveryAction {
        this.consecutiveGaps++;

        // Consecutive-gap escalation (original policy)
        if (this.consecutiveGaps >= this.gapEscalationThreshold) {
            this.consecutiveGaps = 0;
            this.gapTimestamps.length = 0;
            return this.escalateOrSkip('repeated gaps detected');
        }

        // Windowed escalation: catches the alternating gap/success
        // pattern where notifySuccess() resets the consecutive counter
        // between every gap but the overall stall rate is unacceptable.
        if (this.clock) {
            const now = this.clock.now();
            this.gapTimestamps.push(now);
            // Evict timestamps outside the window
            const cutoff = now - this.windowedWindowUs;
            while (this.gapTimestamps.length > 0 && this.gapTimestamps[0]! < cutoff) {
                this.gapTimestamps.shift();
            }
            if (this.gapTimestamps.length >= this.windowedThreshold) {
                this.gapTimestamps.length = 0;
                this.consecutiveGaps = 0;
                return this.escalateOrSkip('repeated stalls within window');
            }
        }

        return { type: 'skip_forward' };
    }

    /**
     * Relay signals overload via PUBLISH_DONE/TOO_FAR_BEHIND (§9.13);
     * network bottlenecks produce no server signal, so the player must
     * self-detect via stall rate.
     */
    private handleStall(durationMs: number): RecoveryAction {
        if (durationMs < this.stallThresholdMs) {
            return { type: 'skip_forward' };
        }
        // Feed into the same windowed counter as gaps — the user doesn't
        // care WHY the video is degraded, only that it is.
        if (this.clock) {
            const now = this.clock.now();
            this.gapTimestamps.push(now);
            const cutoff = now - this.windowedWindowUs;
            while (this.gapTimestamps.length > 0 && this.gapTimestamps[0]! < cutoff) {
                this.gapTimestamps.shift();
            }
            if (this.gapTimestamps.length >= this.windowedThreshold) {
                this.gapTimestamps.length = 0;
                return this.escalateOrSkip('sustained stalls within window');
            }
        }
        return { type: 'skip_forward' };
    }

    private handleDecodeError(message: string): RecoveryAction {
        this.decodeErrorCount++;
        if (this.decodeErrorCount >= this.maxDecodeErrors) {
            return { type: 'terminate', reason: `repeated decode error: ${message}` };
        }
        return { type: 'resubscribe' };
    }
}
