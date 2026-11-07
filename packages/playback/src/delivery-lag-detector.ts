/**
 * DeliveryLagDetector — congestion from the trend of delivery lag.
 *
 * Delivery lag is `arrival − capture` for each object. A live publisher sends
 * at capture pace, so with spare capacity the lag stays flat whatever the
 * frame sizes: VBR content running below its nominal bitrate cannot look
 * like congestion, as it does to a throughput estimate compared against the
 * catalog bitrate. When the link cannot carry the stream, a queue builds and
 * the lag grows with it — before the playout buffer runs dry.
 *
 * The sender and receiver clocks differ by an unknown offset, so the absolute
 * lag means nothing; only its excess over a baseline does. The baseline is
 * the lowest lag seen over a long history (the LEDBAT "base delay" idea).
 *
 * Congested means: the lowest lag over the last window is more than the
 * threshold above the baseline AND higher than over the window before. The
 * window minimum rides out keyframe bursts and jitter; the rising test stops
 * a draining queue — still above threshold after a downshift, but shrinking —
 * from reading as fresh congestion.
 *
 * @module
 */

/** Configuration for the delivery lag detector. */
export interface DeliveryLagConfig {
    /** Window over which the minimum lag is taken (µs). Default 500ms. */
    readonly windowUs?: number;
    /** Excess over baseline that counts as a standing queue (µs). Default 300ms. */
    readonly excessThresholdUs?: number;
    /** How long the baseline remembers its minimum (µs). Default 60s. */
    readonly baseHistoryUs?: number;
    /**
     * A capture timestamp further than this behind the latest one is a
     * timeline discontinuity (publisher restart), not delivery: the detector
     * resets. Default 1s — larger than any cross-stream reordering.
     */
    readonly discontinuityUs?: number;
}

const BUCKET_US = 1_000_000;

export class DeliveryLagDetector {
    private readonly windowUs: number;
    private readonly excessThresholdUs: number;
    private readonly baseHistoryUs: number;
    private readonly discontinuityUs: number;

    /** Recent samples, oldest first, covering at most two windows. */
    private samples: { arrivalUs: number; lagUs: number }[] = [];
    /** Per-second minimum lag, oldest first, covering the base history. */
    private buckets: { startUs: number; minLagUs: number }[] = [];
    private latestCaptureUs: number | null = null;

    constructor(config?: DeliveryLagConfig) {
        this.windowUs = config?.windowUs ?? 500_000;
        this.excessThresholdUs = config?.excessThresholdUs ?? 300_000;
        this.baseHistoryUs = config?.baseHistoryUs ?? 60_000_000;
        this.discontinuityUs = config?.discontinuityUs ?? 1_000_000;
    }

    /**
     * Record one object's delivery.
     *
     * @param captureUs Sender capture timestamp (µs, sender clock).
     * @param arrivalUs Local arrival time (µs, receiver clock).
     */
    record(captureUs: number, arrivalUs: number): void {
        if (this.latestCaptureUs !== null && captureUs < this.latestCaptureUs - this.discontinuityUs) {
            this.reset();
        }
        this.latestCaptureUs = this.latestCaptureUs === null ? captureUs : Math.max(this.latestCaptureUs, captureUs);

        const lagUs = arrivalUs - captureUs;
        this.samples.push({ arrivalUs, lagUs });
        const keepFrom = arrivalUs - 2 * this.windowUs;
        let drop = 0;
        while (drop < this.samples.length && this.samples[drop]!.arrivalUs <= keepFrom) drop++;
        if (drop > 0) this.samples = this.samples.slice(drop);

        const bucketStart = arrivalUs - (arrivalUs % BUCKET_US);
        const last = this.buckets[this.buckets.length - 1];
        if (last !== undefined && last.startUs === bucketStart) {
            last.minLagUs = Math.min(last.minLagUs, lagUs);
        } else {
            this.buckets.push({ startUs: bucketStart, minLagUs: lagUs });
        }
        while (this.buckets.length > 0 && this.buckets[0]!.startUs + BUCKET_US <= arrivalUs - this.baseHistoryUs) {
            this.buckets.shift();
        }
    }

    /**
     * Excess of the recent window's minimum lag over the baseline (µs), or
     * null when the last window saw no arrivals.
     */
    excessLagUs(nowUs: number): number | null {
        const recent = this.windowMin(nowUs - this.windowUs, nowUs);
        if (recent === null || this.buckets.length === 0) return null;
        const base = Math.min(...this.buckets.map(b => b.minLagUs));
        return recent - base;
    }

    /** True while a queue is standing above the threshold and still growing. */
    isCongested(nowUs: number): boolean {
        const excess = this.excessLagUs(nowUs);
        if (excess === null || excess <= this.excessThresholdUs) return false;
        const recent = this.windowMin(nowUs - this.windowUs, nowUs)!;
        const previous = this.windowMin(nowUs - 2 * this.windowUs, nowUs - this.windowUs);
        return previous !== null && recent > previous;
    }

    /** Reset all state. */
    reset(): void {
        this.samples = [];
        this.buckets = [];
        this.latestCaptureUs = null;
    }

    /** Minimum lag over arrivals in (fromUs, toUs], or null if none. */
    private windowMin(fromUs: number, toUs: number): number | null {
        let min: number | null = null;
        for (const s of this.samples) {
            if (s.arrivalUs <= fromUs || s.arrivalUs > toUs) continue;
            if (min === null || s.lagUs < min) min = s.lagUs;
        }
        return min;
    }
}
