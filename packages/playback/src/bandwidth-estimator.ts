/**
 * BandwidthEstimator — EWMA-smoothed bandwidth estimation from
 * group arrival rate.
 *
 * MoQ/QUIC has no HTTP request/response cycle to time, so traditional
 * ABR segment-download bandwidth estimation doesn't apply. Instead we
 * measure the effective throughput from object arrival timing:
 *
 *   instantaneous_bps = group_size_bytes * 8 / inter_arrival_seconds
 *
 * Smoothed with EWMA (Exponentially Weighted Moving Average) to filter
 * single-sample spikes and bursty delivery patterns (conference WiFi).
 *
 * The estimate drives proactive quality decisions — downshift BEFORE
 * stalls occur, based on arrival rate vs current track bitrate.
 *
 * @module
 */

export class BandwidthEstimator {
    private readonly alpha: number;
    private readonly minSamples: number;
    private estimateBps: number | null = null;
    private lastTimestampUs: number | null = null;
    private lastGroupBytes: number | null = null;
    private sampleCount = 0;

    /**
     * @param alpha EWMA smoothing factor (0-1). Higher = more responsive
     *              to recent samples, lower = smoother. Default 0.3.
     * @param minSamples Minimum group arrivals before reporting a non-zero
     *                   estimate. Early samples include connection latency
     *                   and aren't representative. Default 5 (~10s at 2s GOPs).
     */
    constructor(alpha = 0.3, minSamples = 5) {
        this.alpha = alpha;
        this.minSamples = minSamples;
    }

    /**
     * Record a group arrival. Call once per complete group (GOP).
     *
     * @param bytes Total bytes in the group.
     * @param timestampUs Arrival timestamp in microseconds.
     */
    recordGroup(bytes: number, timestampUs: number): void {
        if (this.lastTimestampUs !== null && this.lastGroupBytes !== null) {
            const deltaUs = timestampUs - this.lastTimestampUs;
            if (deltaUs > 0) {
                this.sampleCount++;
                const instantBps = (bytes * 8) / (deltaUs / 1_000_000);
                if (this.estimateBps === null) {
                    this.estimateBps = instantBps;
                } else {
                    this.estimateBps = this.alpha * instantBps + (1 - this.alpha) * this.estimateBps;
                }
            }
        }
        this.lastTimestampUs = timestampUs;
        this.lastGroupBytes = bytes;
    }

    /**
     * Current smoothed bandwidth estimate in kbps.
     * Returns 0 if fewer than 2 groups have been recorded.
     */
    getEstimateKbps(): number {
        if (this.estimateBps === null || this.sampleCount < this.minSamples) return 0;
        return this.estimateBps / 1000;
    }

    /** Reset all state. */
    reset(): void {
        this.estimateBps = null;
        this.lastTimestampUs = null;
        this.lastGroupBytes = null;
        this.sampleCount = 0;
    }
}
