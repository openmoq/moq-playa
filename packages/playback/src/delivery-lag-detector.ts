/**
 * A delivery-lag trend heuristic, not an absolute latency measurement or proof
 * of network congestion. A constant sender/receiver clock offset cancels in
 * the excess; clock-rate skew does not. This is not LEDBAT congestion control.
 *
 * Callers supply microseconds in continuous clock domains, with sufficient
 * Number precision (rebase exact timestamps before conversion when needed).
 * Receiver record/query times must be finite and nondecreasing until reset.
 * Capture reordering is allowed; the backward-jump reset is only a heuristic.
 *
 * Recent/previous minima use exact observations in (from, to]. The baseline
 * uses a per-second bucket approximation, not exact history
 * endpoints. At most 4096 samples and 64 baseline buckets are retained. On
 * overflow the evidence epoch is discarded, and queries remain unknown until
 * the discarded interval cannot affect either window. Sustained overload can
 * therefore keep the detector unavailable. Callers decide how to use evidence.
 *
 * @module
 */

export interface DeliveryLagConfig {
    /** Minimum-lag window (µs). Default 500ms. Zero disables evidence. */
    readonly windowUs?: number;
    /** Strict excess threshold (µs). Default 300ms. Zero is permitted. */
    readonly excessThresholdUs?: number;
    /** Approximate baseline history (µs). Default 60s. Zero disables evidence. */
    readonly baseHistoryUs?: number;
    /** Backward capture-jump reset heuristic (µs). Default 1s. */
    readonly discontinuityUs?: number;
}

const BUCKET_US = 1_000_000;
const MAX_SAMPLES = 4096;
const MAX_BUCKETS = 64;

function finite(value: number): number {
    if (!Number.isFinite(value)) throw new RangeError('Delivery lag values and arithmetic must be finite');
    return value;
}

function duration(value: number): number {
    if (finite(value) < 0) throw new RangeError('Delivery lag configuration must be nonnegative');
    return value;
}

export class DeliveryLagDetector {
    private readonly windowUs: number;
    private readonly retentionUs: number;
    private readonly excessThresholdUs: number;
    private readonly baseHistoryUs: number;
    private readonly discontinuityUs: number;

    private samples: { arrivalUs: number; lagUs: number }[] = [];
    private buckets: { startUs: number; minLagUs: number }[] = [];
    private latestCaptureUs: number | null = null;
    private lastClockUs: number | null = null;
    /** Latest observation refused when an evidence epoch exceeded capacity. */
    private refusedThroughUs: number | null = null;

    constructor(config?: DeliveryLagConfig) {
        this.windowUs = duration(config?.windowUs ?? 500_000);
        this.retentionUs = finite(2 * this.windowUs);
        this.excessThresholdUs = duration(config?.excessThresholdUs ?? 300_000);
        this.baseHistoryUs = duration(config?.baseHistoryUs ?? 60_000_000);
        this.discontinuityUs = duration(config?.discontinuityUs ?? 1_000_000);
    }

    /**
     * Record capture/arrival microseconds. Invalid inputs, backward receiver
     * time or overflowing arithmetic throw RangeError before state changes.
     * Capacity refusal discards evidence without throwing.
     */
    record(captureUs: number, arrivalUs: number): void {
        finite(captureUs);
        this.validateClock(arrivalUs);
        const lagUs = finite(arrivalUs - captureUs);
        const keepFrom = finite(arrivalUs - this.retentionUs);
        const baseFrom = finite(arrivalUs - this.baseHistoryUs);
        const bucketStart = finite(Math.floor(arrivalUs / BUCKET_US) * BUCKET_US);
        finite(bucketStart + BUCKET_US);
        const captureReset = this.latestCaptureUs !== null
            && captureUs < finite(this.latestCaptureUs - this.discontinuityUs);

        this.lastClockUs = arrivalUs;
        if (captureReset) this.clearEvidence();
        this.expireRefusal(keepFrom);
        if (this.windowUs === 0 || this.baseHistoryUs === 0) return;

        this.expireSamples(keepFrom);
        this.expireBuckets(baseFrom);
        const last = this.buckets[this.buckets.length - 1];
        const newBucket = last === undefined || last.startUs !== bucketStart;
        if (this.samples.length >= MAX_SAMPLES || (newBucket && this.buckets.length >= MAX_BUCKETS)) {
            this.clearEvidence();
            this.refusedThroughUs = arrivalUs;
            return;
        }

        this.latestCaptureUs = this.latestCaptureUs === null ? captureUs : Math.max(this.latestCaptureUs, captureUs);
        this.samples.push({ arrivalUs, lagUs });
        if (newBucket) this.buckets.push({ startUs: bucketStart, minLagUs: lagUs });
        else last!.minLagUs = Math.min(last!.minLagUs, lagUs);
    }

    /**
     * Recent minimum minus the approximate baseline (µs). Null means unknown:
     * no recent arrivals, zero window/history, or incomplete overflow coverage.
     */
    excessLagUs(nowUs: number): number | null {
        return this.query(nowUs).excess;
    }

    /** A rising excess above threshold. False also includes unknown evidence. */
    isCongested(nowUs: number): boolean {
        const { excess, rising } = this.query(nowUs);
        return excess !== null && excess > this.excessThresholdUs && rising;
    }

    /** Release all evidence and begin a new receiver-clock epoch. */
    reset(): void {
        this.clearEvidence();
        this.lastClockUs = null;
        this.refusedThroughUs = null;
    }

    private query(nowUs: number): { excess: number | null; rising: boolean } {
        this.validateClock(nowUs);
        const recentFrom = finite(nowUs - this.windowUs);
        const keepFrom = finite(nowUs - this.retentionUs);
        const baseFrom = finite(nowUs - this.baseHistoryUs);
        const unavailable = this.windowUs === 0 || this.baseHistoryUs === 0
            || (this.refusedThroughUs !== null && keepFrom < this.refusedThroughUs);
        const recent = this.windowMin(recentFrom, nowUs);
        const previous = this.windowMin(keepFrom, recentFrom);
        let excess: number | null = null;
        if (!unavailable && recent !== null && this.buckets.length > 0) {
            let base = this.buckets[0]!.minLagUs;
            for (const bucket of this.buckets) base = Math.min(base, bucket.minLagUs);
            excess = finite(recent - base);
        }

        // All admission/arithmetic checks precede mutation, including query time.
        this.lastClockUs = nowUs;
        this.expireRefusal(keepFrom);
        this.expireSamples(keepFrom);
        // Retain partial buckets on queries with recent observations.
        if (recent === null) this.expireBuckets(baseFrom);
        return { excess, rising: recent !== null && previous !== null && recent > previous };
    }

    private validateClock(nowUs: number): void {
        finite(nowUs);
        if (this.lastClockUs !== null && nowUs < this.lastClockUs) {
            throw new RangeError('Delivery lag receiver time must be nondecreasing until reset');
        }
    }

    private clearEvidence(): void {
        this.samples = [];
        this.buckets = [];
        this.latestCaptureUs = null;
    }

    private expireRefusal(keepFrom: number): void {
        if (this.refusedThroughUs !== null && keepFrom >= this.refusedThroughUs) this.refusedThroughUs = null;
    }

    private expireSamples(keepFrom: number): void {
        let drop = 0;
        while (drop < this.samples.length && this.samples[drop]!.arrivalUs <= keepFrom) drop++;
        if (drop > 0) this.samples = this.samples.slice(drop);
    }

    private expireBuckets(baseFrom: number): void {
        while (this.buckets.length > 0 && this.buckets[0]!.startUs + BUCKET_US <= baseFrom) this.buckets.shift();
    }

    private windowMin(fromUs: number, toUs: number): number | null {
        let min: number | null = null;
        for (const sample of this.samples) {
            if (sample.arrivalUs <= fromUs || sample.arrivalUs > toUs) continue;
            if (min === null || sample.lagUs < min) min = sample.lagUs;
        }
        return min;
    }
}
