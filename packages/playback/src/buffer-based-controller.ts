/**
 * BufferBasedController — hybrid ABR using buffer depth as the primary
 * signal and bandwidth estimation as a secondary corroboration signal.
 *
 * Buffer depth directly measures stall risk (the thing we care about).
 * Bandwidth estimation measures throughput (a proxy for stall risk that
 * can be noisy on bursty networks). Combining them:
 *
 *   buffer < LOW  → downshift immediately (emergency, bandwidth irrelevant)
 *   buffer in [LOW, HIGH] → hold steady (buffer is fine, don't react to noise)
 *   buffer > HIGH AND bandwidth > 2.25× next-higher → upshift (both agree)
 *   buffer > HIGH AND bandwidth insufficient → hold (don't burn buffer)
 *
 * This avoids the EWMA over-reaction problem (bursty delivery tanks the
 * estimate but buffer is healthy) while still enabling proactive upshift
 * when conditions genuinely support it.
 *
 * @module
 */

import type { ClockSource } from './types.js';

/** One entry in the ABR quality ladder. */
export interface AbrTrack {
    readonly name: string;
    readonly bitrateKbps: number;
}

/** Configuration for the buffer-based controller. */
export interface BufferBasedConfig {
    readonly clock: ClockSource;
    /** Quality ladder sorted highest-bitrate-first (index 0 = best). */
    readonly ladder: readonly AbrTrack[];
    /** Starting index into the ladder. */
    readonly initialIndex: number;
    /** Buffer depth below this → emergency downshift (µs). */
    readonly lowThresholdUs: number;
    /** Buffer depth above this → consider upshift (µs). */
    readonly highThresholdUs: number;
    /** Bandwidth must exceed this multiple of the target track's bitrate
     *  for an upshift to be approved. Default 2.25. */
    readonly upshiftBandwidthMultiple?: number;
}

/** Input signals for an ABR evaluation. */
export interface AbrSignals {
    /** Current buffer depth in microseconds. */
    readonly bufferDepthUs: number;
    /** EWMA bandwidth estimate in kbps (0 = unknown). */
    readonly bandwidthEstimateKbps: number;
}

/** ABR decision. */
export interface AbrDecision {
    readonly action: 'downshift' | 'upshift' | 'hold';
    /** Target ladder index (only set for downshift/upshift). */
    readonly targetIndex?: number;
}

export class BufferBasedController {
    private readonly ladder: readonly AbrTrack[];
    readonly lowThresholdUs: number;
    /** Kept for future temporal-buffer mode (playout buffer, not jitter buffer). */
    readonly highThresholdUs: number;
    private readonly upshiftMultiple: number;
    private currentIndex: number;

    constructor(config: BufferBasedConfig) {
        this.ladder = config.ladder;
        this.lowThresholdUs = config.lowThresholdUs;
        this.highThresholdUs = config.highThresholdUs;
        this.upshiftMultiple = config.upshiftBandwidthMultiple ?? 2.25;
        this.currentIndex = config.initialIndex;
    }

    /** Current ladder index. */
    get index(): number { return this.currentIndex; }

    /** Current track. */
    get currentTrack(): AbrTrack | undefined { return this.ladder[this.currentIndex]; }

    /**
     * Evaluate buffer depth + bandwidth and return an ABR decision.
     *
     * Called periodically (e.g., every tick or every group arrival).
     */
    /**
     * Evaluate buffer depth + bandwidth and return an ABR recommendation.
     *
     * Does NOT mutate internal state — the caller must call
     * {@link commitDownshift} or {@link commitUpshift} after a
     * confirmed switch. This prevents index drift when async switches
     * fail or are aborted.
     */
    evaluate(signals: AbrSignals): AbrDecision {
        // Emergency: buffer critically low → recommend downshift
        if (signals.bufferDepthUs < this.lowThresholdUs) {
            if (this.currentIndex < this.ladder.length - 1) {
                return { action: 'downshift', targetIndex: this.currentIndex + 1 };
            }
            return { action: 'hold' }; // already at lowest
        }

        // Upshift: buffer must be above the high threshold — asymmetric
        // hysteresis so upshift is much harder to trigger than downshift.
        // AND bandwidth must corroborate.
        if (this.currentIndex > 0 && signals.bufferDepthUs >= this.highThresholdUs) {
            const higherTrack = this.ladder[this.currentIndex - 1]!;
            if (signals.bandwidthEstimateKbps > higherTrack.bitrateKbps * this.upshiftMultiple) {
                return { action: 'upshift', targetIndex: this.currentIndex - 1 };
            }
        }

        return { action: 'hold' };
    }

    /** Confirm a downshift — advances index to the lower track. */
    commitDownshift(): void {
        if (this.currentIndex < this.ladder.length - 1) this.currentIndex++;
    }

    /** Confirm an upshift — moves index to the higher track. */
    commitUpshift(): void {
        if (this.currentIndex > 0) this.currentIndex--;
    }

    /** Reset to a specific ladder index (e.g., after manual selection). */
    setIndex(index: number): void {
        this.currentIndex = Math.max(0, Math.min(index, this.ladder.length - 1));
    }
}
