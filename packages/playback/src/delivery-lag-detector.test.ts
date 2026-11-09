/**
 * Tests for DeliveryLagDetector.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { DeliveryLagDetector } from './delivery-lag-detector.js';
import type { DeliveryLagConfig } from './delivery-lag-detector.js';

const FRAME_US = 33_333;
/** Sender clock offset — the detector must only ever see its trend. */
const EPOCH_US = 1_762_000_000_000_000;

/** Deliver `count` frames from `fromFrame`, each arriving `lagAt(i)` after capture. */
function deliver(d: DeliveryLagDetector, fromFrame: number, count: number, lagAt: (i: number) => number): number {
    const deliveries = Array.from({ length: count }, (_, offset) => {
        const i = fromFrame + offset;
        const captureUs = i * FRAME_US;
        return { captureUs: EPOCH_US + captureUs, arrivalUs: captureUs + lagAt(i) };
    });
    // A burst can reorder captures; calls follow the receiver's arrival clock.
    deliveries.sort((a, b) => a.arrivalUs - b.arrivalUs);
    for (const { captureUs, arrivalUs } of deliveries) d.record(captureUs, arrivalUs);
    return deliveries[deliveries.length - 1]!.arrivalUs;
}

describe('DeliveryLagDetector', () => {
    it('is not congested while lag stays flat, whatever the clock offset', () => {
        const d = new DeliveryLagDetector();
        const now = deliver(d, 0, 300, () => 20_000);
        expect(d.isCongested(now)).toBe(false);
        expect(d.excessLagUs(now)).toBe(0);
    });

    it('rides out a keyframe burst that the link absorbs within the window', () => {
        const d = new DeliveryLagDetector();
        // Every 60th frame queues the next few behind it by up to 400ms.
        const now = deliver(d, 0, 600, i => 20_000 + Math.max(0, 400_000 - (i % 60) * 100_000));
        expect(d.isCongested(now)).toBe(false);
    });

    it('reports congestion when lag grows past the threshold', () => {
        const d = new DeliveryLagDetector();
        deliver(d, 0, 150, () => 20_000);
        // Link at 2/3 of the stream rate: lag grows half a second per second.
        const now = deliver(d, 150, 60, i => 20_000 + (i - 150) * FRAME_US / 2);
        expect(d.excessLagUs(now)!).toBeGreaterThan(300_000);
        expect(d.isCongested(now)).toBe(true);
    });

    it('does not report a draining queue as congestion', () => {
        const d = new DeliveryLagDetector();
        deliver(d, 0, 150, () => 20_000);
        deliver(d, 150, 60, i => 20_000 + (i - 150) * FRAME_US / 2);
        // After a downshift the backlog drains: still far above baseline, shrinking.
        const now = deliver(d, 210, 30, i => 1_000_000 - (i - 210) * 10_000);
        expect(d.excessLagUs(now)!).toBeGreaterThan(300_000);
        expect(d.isCongested(now)).toBe(false);
    });

    it('resets on a backwards capture discontinuity instead of reading it as lag', () => {
        const d = new DeliveryLagDetector();
        deliver(d, 0, 300, () => 20_000);
        // Publisher restarts its timeline: captures jump back 9s, arrivals keep going.
        let now = 0;
        for (let i = 0; i < 30; i++) {
            now = 300 * FRAME_US + i * FRAME_US + 20_000;
            d.record(EPOCH_US + i * FRAME_US, now);
        }
        expect(d.isCongested(now)).toBe(false);
        expect(d.excessLagUs(now)).toBe(0);
    });

    it('has no opinion when nothing arrived in the last window', () => {
        const d = new DeliveryLagDetector();
        const last = deliver(d, 0, 300, () => 20_000);
        expect(d.excessLagUs(last + 2_000_000)).toBeNull();
        expect(d.isCongested(last + 2_000_000)).toBe(false);
    });
});

const BUCKET_US = 1_000_000;

/** Submitted estimator, for observations within the retained evidence epoch. */
class SubmittedReference {
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

interface RetainedState {
    samples: { arrivalUs: number; lagUs: number }[];
    buckets: { startUs: number; minLagUs: number }[];
}

function retained(d: DeliveryLagDetector): RetainedState {
    return d as unknown as RetainedState;
}

function snapshot(d: DeliveryLagDetector): string {
    return JSON.stringify(d);
}

function recordLag(d: DeliveryLagDetector, arrivalUs: number, lagUs: number): void {
    d.record(arrivalUs - lagUs, arrivalUs);
}

const configFields = ['windowUs', 'excessThresholdUs', 'baseHistoryUs', 'discontinuityUs'] as const;

describe('configuration and clock admission', () => {
    for (const field of configFields) {
        it.each([NaN, Infinity, -1])('rejects %s for ' + field, value => {
            expect(() => new DeliveryLagDetector({ [field]: value })).toThrow(RangeError);
        });
    }

    it('rejects an overflowing two-window duration', () => {
        expect(() => new DeliveryLagDetector({ windowUs: Number.MAX_VALUE })).toThrow(RangeError);
    });

    it.each(['windowUs', 'baseHistoryUs'] as const)('has no evidence with zero %s', field => {
        const d = new DeliveryLagDetector({ [field]: 0 });
        deliver(d, 0, 100, i => 20_000 + i * 20_000);
        expect(d.excessLagUs(6_000_000)).toBeNull();
        expect(d.isCongested(6_000_000)).toBe(false);
        expect(retained(d).samples).toHaveLength(0);
        expect(retained(d).buckets).toHaveLength(0);
    });

    it('accepts zero threshold and zero discontinuity without retuning them', () => {
        const d = new DeliveryLagDetector({ windowUs: 10, excessThresholdUs: 0, discontinuityUs: 0 });
        recordLag(d, 0, 0);
        recordLag(d, 10, 1);
        recordLag(d, 20, 2);
        expect(d.excessLagUs(20)).toBe(2);
        expect(d.isCongested(20)).toBe(true);
        d.record(0, 21);
        expect(d.excessLagUs(21)).toBe(0);
    });

    for (const value of [NaN, Infinity, -Infinity]) {
        it.each(['capture', 'arrival'] as const)('rejects nonfinite ' + value + ' %s before mutation', field => {
            const d = new DeliveryLagDetector();
            d.record(0, 10);
            const before = snapshot(d);
            expect(() => d.record(field === 'capture' ? value : 1, field === 'arrival' ? value : 11)).toThrow(RangeError);
            expect(snapshot(d)).toBe(before);
            d.record(1, 11);
            expect(d.excessLagUs(11)).toBe(0);
        });
        it.each(['excessLagUs', 'isCongested'] as const)('rejects nonfinite ' + value + ' query via %s before mutation', method => {
            const d = new DeliveryLagDetector();
            d.record(0, 10);
            const before = snapshot(d);
            expect(() => d[method](value)).toThrow(RangeError);
            expect(snapshot(d)).toBe(before);
            d.record(1, 11);
        });
    }

    it('shares a monotonic receiver clock across records and queries, allowing ties', () => {
        const d = new DeliveryLagDetector();
        d.record(0, 10);
        expect(d.excessLagUs(12)).toBe(0);
        const before = snapshot(d);
        expect(() => d.record(1, 11)).toThrow(RangeError);
        expect(() => d.excessLagUs(11)).toThrow(RangeError);
        expect(() => d.isCongested(11)).toThrow(RangeError);
        expect(snapshot(d)).toBe(before);
        d.record(2, 12);
        expect(d.isCongested(12)).toBe(false);
        d.reset();
        d.record(0, 0);
        expect(d.excessLagUs(0)).toBe(0);
    });

    it('rejects lag and window arithmetic overflow before mutation', () => {
        const d = new DeliveryLagDetector();
        const before = snapshot(d);
        expect(() => d.record(-Number.MAX_VALUE, Number.MAX_VALUE)).toThrow(RangeError);
        expect(snapshot(d)).toBe(before);
        const wide = new DeliveryLagDetector({ windowUs: Number.MAX_VALUE / 2 });
        const wideBefore = snapshot(wide);
        expect(() => wide.excessLagUs(-Number.MAX_VALUE)).toThrow(RangeError);
        expect(snapshot(wide)).toBe(wideBefore);
        wide.record(0, 0);
        expect(wide.excessLagUs(0)).toBe(0);
    });

    it('accepts fractional and negative finite timestamps without inventing a precision bound', () => {
        const d = new DeliveryLagDetector();
        d.record(-100.5, -0.5);
        d.record(-100.25, -0.25);
        expect(d.excessLagUs(-0.25)).toBe(0);
        d.record(-99.5, 0.5);
        expect(d.excessLagUs(0.5)).toBe(0);
    });

    it.each([0, 1_000_000])('expires the same bucket at receiver epoch %s', offset => {
        const d = new DeliveryLagDetector({ baseHistoryUs: 1_000_000 });
        const observations: readonly (readonly [number, number])[] = [
            [-500_000, 0], [500_000, 200_000], [1_100_000, 400_000],
        ];
        for (const [arrival, lag] of observations) d.record(arrival - lag + offset, arrival + offset);
        expect(d.excessLagUs(1_100_000 + offset)).toBe(200_000);
        expect(d.isCongested(1_100_000 + offset)).toBe(false);
    });
});

describe('bounded retained evidence', () => {
    it('admits N samples, refuses N+1, and recovers only after both windows exclude the loss', () => {
        const d = new DeliveryLagDetector({ windowUs: 100, discontinuityUs: 1_000_000 });
        for (let i = 0; i < 4096; i++) recordLag(d, 0, 10);
        expect(retained(d).samples).toHaveLength(4096);
        expect(d.excessLagUs(0)).toBe(0);
        recordLag(d, 1, 10);
        expect(d.excessLagUs(1)).toBeNull();
        expect(d.isCongested(1)).toBe(false);
        expect(retained(d).samples.length).toBeLessThanOrEqual(4096);
        recordLag(d, 200, 30);
        expect(d.excessLagUs(200)).toBeNull();
        expect(d.excessLagUs(201)).toBe(0);
    });

    it('withholds excess evidence that a FIFO suffix would overstate after losing its minimum', () => {
        const d = new DeliveryLagDetector({ windowUs: 100 });
        recordLag(d, 0, 0);
        for (let i = 1; i < 4096; i++) recordLag(d, 1, 100);
        expect(d.excessLagUs(1)).toBe(0);
        // A naive 4096-row FIFO drops the sole recent minimum on this insertion.
        const naiveFifo = [...retained(d).samples, { arrivalUs: 2, lagUs: 100 }].slice(-4096);
        const naiveSuffixMinimum = Math.min(...naiveFifo.map(sample => sample.lagUs));
        const retainedBucketMinimum = Math.min(...retained(d).buckets.map(bucket => bucket.minLagUs));
        expect(naiveSuffixMinimum - retainedBucketMinimum).toBe(100);
        recordLag(d, 2, 100);
        expect(d.excessLagUs(2)).toBeNull();
        // No previous-window sample exists: this does not prove a false congestion decision.
        expect(d.isCongested(2)).toBe(false);
    });

    it('keeps sustained high-rate arrivals bounded and unavailable after the latest overflow', () => {
        const d = new DeliveryLagDetector();
        for (let i = 0; i < 100_000; i++) recordLag(d, i, 100 + i);
        expect(retained(d).samples.length).toBeLessThanOrEqual(4096);
        expect(retained(d).buckets.length).toBeLessThanOrEqual(64);
        expect(d.excessLagUs(100_000)).toBeNull();
        expect(d.isCongested(100_000)).toBe(false);
    });

    it('prunes expired samples before deciding whether an insertion exceeds capacity', () => {
        const d = new DeliveryLagDetector({ windowUs: 100 });
        for (let i = 0; i < 4096; i++) recordLag(d, 0, 0);
        recordLag(d, 200, 10);
        expect(retained(d).samples).toHaveLength(1);
        expect(d.excessLagUs(200)).toBe(10);
    });

    it('admits 64 baseline buckets and refuses a 65th unexpired bucket', () => {
        const d = new DeliveryLagDetector({ baseHistoryUs: 1_000_000_000 });
        for (let i = 0; i < 64; i++) recordLag(d, i * BUCKET_US, 0);
        expect(retained(d).buckets).toHaveLength(64);
        expect(d.excessLagUs(63 * BUCKET_US)).toBe(0);
        recordLag(d, 64 * BUCKET_US, 10);
        expect(d.excessLagUs(64 * BUCKET_US)).toBeNull();
        expect(d.isCongested(64 * BUCKET_US)).toBe(false);
        expect(retained(d).buckets.length).toBeLessThanOrEqual(64);
        recordLag(d, 65 * BUCKET_US, 30);
        expect(d.excessLagUs(65 * BUCKET_US)).toBe(0);
    });

    it('expires whole baseline buckets before the budget check and preserves the partial bucket', () => {
        const d = new DeliveryLagDetector({ baseHistoryUs: 63 * BUCKET_US });
        const reference = new SubmittedReference({ baseHistoryUs: 63 * BUCKET_US });
        for (let i = 0; i <= 65; i++) {
            recordLag(d, i * BUCKET_US, i * 10);
            reference.record(i * BUCKET_US - i * 10, i * BUCKET_US);
            expect(d.excessLagUs(i * BUCKET_US)).toBe(reference.excessLagUs(i * BUCKET_US));
            expect(retained(d).buckets.length).toBeLessThanOrEqual(64);
        }
    });

    it('does not let a backwards capture reset bypass overflow coverage', () => {
        const d = new DeliveryLagDetector({ windowUs: 100, discontinuityUs: 10 });
        for (let i = 0; i <= 4096; i++) d.record(1000, 0);
        d.record(0, 1);
        expect(d.excessLagUs(1)).toBeNull();
        expect(d.isCongested(1)).toBe(false);
        d.record(1, 201);
        expect(d.excessLagUs(201)).toBe(199);
    });

    it('reset releases all evidence and overflow coverage and starts a new clock epoch', () => {
        const d = new DeliveryLagDetector();
        for (let i = 0; i <= 4096; i++) recordLag(d, 10, 10);
        expect(d.excessLagUs(10)).toBeNull();
        d.reset();
        expect(retained(d).samples).toHaveLength(0);
        expect(retained(d).buckets).toHaveLength(0);
        expect(d.excessLagUs(0)).toBeNull();
        recordLag(d, 0, 10);
        expect(d.excessLagUs(0)).toBe(0);
    });

    it('releases definitely expired evidence on a known-empty forward query', () => {
        const d = new DeliveryLagDetector({ windowUs: 10, baseHistoryUs: 20 });
        recordLag(d, 0, 0);
        expect(d.excessLagUs(BUCKET_US + 20)).toBeNull();
        expect(d.isCongested(BUCKET_US + 20)).toBe(false);
        expect(retained(d).samples).toHaveLength(0);
        expect(retained(d).buckets).toHaveLength(0);
    });
});

describe('agreement within the retained evidence epoch', () => {
    it.each([
        {},
        { windowUs: 10, baseHistoryUs: 1 },
        { windowUs: 250_000, baseHistoryUs: 3_000_000, excessThresholdUs: 0 },
    ] satisfies DeliveryLagConfig[])('matches the reference at nonnegative receiver times with config %j', config => {
        const d = new DeliveryLagDetector(config);
        const reference = new SubmittedReference(config);
        // The reference truncates negative bucket starts toward zero. That
        // defect has its own clock-epoch regression above.
        let arrivalUs = BUCKET_US - 0.5;
        let random = 0x12345678;
        for (let i = 0; i < 1800; i++) {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            arrivalUs += i % 13 === 0 ? 0 : (random % 40_000) + 0.25;
            const lagUs = 20_000 + (random % 90_000);
            d.record(arrivalUs - lagUs, arrivalUs);
            reference.record(arrivalUs - lagUs, arrivalUs);
            const now = arrivalUs + (i % 7 === 0 ? 0.125 : 0);
            expect(d.excessLagUs(now)).toBe(reference.excessLagUs(now));
            expect(d.isCongested(now)).toBe(reference.isCongested(now));
            arrivalUs = now;
        }
    });

    it('preserves strict window endpoints and threshold equality', () => {
        const d = new DeliveryLagDetector({ windowUs: 10, excessThresholdUs: 2 });
        recordLag(d, 0, 0);
        recordLag(d, 10, 1);
        recordLag(d, 20, 2);
        expect(d.excessLagUs(20)).toBe(2);
        expect(d.isCongested(20)).toBe(false);
        recordLag(d, 20, 3);
        expect(d.excessLagUs(20)).toBe(2);
        recordLag(d, 30, 4);
        expect(d.excessLagUs(30)).toBe(4);
        expect(d.isCongested(30)).toBe(true);
        expect(d.excessLagUs(40)).toBeNull();
    });

    it('preserves whole-bucket baseline approximation with history shorter than a window', () => {
        const d = new DeliveryLagDetector({ windowUs: 10, baseHistoryUs: 1 });
        recordLag(d, 0, 0);
        recordLag(d, 9, 5);
        expect(d.excessLagUs(9)).toBe(0);
        expect(d.excessLagUs(10)).toBe(5);
    });
});
