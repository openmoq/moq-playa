/**
 * Simulation tests: SWMA bandwidth estimation + proactive quality adaptation.
 *
 * Four tests covering the behavioral contract of a bandwidth estimator
 * that drives proactive quality decisions — downshift BEFORE stalls
 * occur, based on object arrival rate vs current track bitrate.
 *
 * Written test-first (red/green TDD). All four MUST FAIL before the
 * BandwidthEstimator class exists.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import type { ClockSource } from './types.js';

// BandwidthEstimator doesn't exist yet — these imports will fail
import { BandwidthEstimator } from './bandwidth-estimator.js';

/** Minimal virtual clock — advances only when told to. */
class SimClock implements ClockSource {
    private _nowUs = 0;
    now(): number { return this._nowUs; }
    advance(deltaUs: number): void { this._nowUs += deltaUs; }
}

/**
 * Simulate group arrivals at a given throughput.
 *
 * Each group is `groupSizeBytes` large and arrives every
 * `groupIntervalUs` microseconds. The effective throughput is
 * `groupSizeBytes / groupIntervalUs * 1e6` bytes/sec.
 */
function deliverGroups(
    estimator: { recordGroup: (bytes: number, timestampUs: number) => void },
    clock: SimClock,
    opts: {
        count: number;
        groupSizeBytes: number;
        groupIntervalUs: number;
    },
): void {
    for (let i = 0; i < opts.count; i++) {
        clock.advance(opts.groupIntervalUs);
        estimator.recordGroup(opts.groupSizeBytes, clock.now());
    }
}

describe('BandwidthEstimator — proactive quality adaptation', () => {

    /**
     * Test 1: Sustained low bandwidth.
     *
     * Throughput is 500kbps, current track is 4090kbps. The estimator
     * must report bandwidth well below the track bitrate so the player
     * can proactively downshift BEFORE stalls occur.
     *
     * This is the core value proposition: no waiting for 5 stalls in
     * 30 seconds — detect the mismatch from arrival rate and act.
     */
    it('reports low bandwidth when throughput is well below track bitrate', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        // 500kbps throughput: 125KB every 2 seconds (one GOP)
        const groupSizeBytes = 125_000;
        const groupIntervalUs = 2_000_000;
        deliverGroups(estimator, clock, {
            count: 10,
            groupSizeBytes,
            groupIntervalUs,
        });

        const estimateKbps = estimator.getEstimateKbps();
        // Should converge to ~500kbps (125000 * 8 / 2 / 1000)
        expect(estimateKbps).toBeGreaterThan(400);
        expect(estimateKbps).toBeLessThan(600);
    });

    /**
     * Test 2: Adequate bandwidth.
     *
     * Throughput is 5000kbps, current track is 4090kbps. The estimator
     * must report bandwidth comfortably above the track bitrate.
     * No quality action should be needed.
     */
    it('reports adequate bandwidth when throughput exceeds track bitrate', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        // 5000kbps throughput: 1.25MB every 2 seconds
        const groupSizeBytes = 1_250_000;
        const groupIntervalUs = 2_000_000;
        deliverGroups(estimator, clock, {
            count: 10,
            groupSizeBytes,
            groupIntervalUs,
        });

        const estimateKbps = estimator.getEstimateKbps();
        expect(estimateKbps).toBeGreaterThan(4000);
        expect(estimateKbps).toBeLessThan(6000);
    });

    /**
     * Test 3: Mid-stream bandwidth drop.
     *
     * Throughput starts at 2000kbps (adequate for a 1500kbps track),
     * then drops to 300kbps. The estimator must track the drop within
     * a reasonable window — not instantly (that would be noise), but
     * within 5-10 seconds (fast enough to prevent stalls).
     */
    it('tracks a mid-stream bandwidth drop within 10 seconds', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        // Phase 1: 2000kbps for 20 seconds
        deliverGroups(estimator, clock, {
            count: 10,
            groupSizeBytes: 500_000,    // 500KB per 2s GOP = 2000kbps
            groupIntervalUs: 2_000_000,
        });

        const beforeDrop = estimator.getEstimateKbps();
        expect(beforeDrop).toBeGreaterThan(1500);

        // Phase 2: bandwidth drops to 300kbps for 10 seconds
        deliverGroups(estimator, clock, {
            count: 5,
            groupSizeBytes: 75_000,     // 75KB per 2s GOP = 300kbps
            groupIntervalUs: 2_000_000,
        });

        const afterDrop = estimator.getEstimateKbps();
        // Must have tracked the drop — estimate should be well below
        // the original 2000kbps. Doesn't need to be exactly 300kbps
        // (EWMA smoothing), but must be low enough to trigger a
        // downshift decision (below 1.5x a 500kbps track = 750kbps).
        expect(afterDrop).toBeLessThan(750);
    });

    /**
     * Test 4: Bursty delivery — the NAB conference WiFi test.
     *
     * Groups arrive in clumps (3 groups back-to-back, then a 4-second
     * pause, then 3 more). Average throughput is adequate (~1500kbps).
     * The estimator must smooth through the bursts and NOT over-react
     * to the instantaneous gaps between clumps.
     *
     * This is critical for NAB: conference WiFi is bursty by nature
     * (shared medium, QoS interference, AP handoffs). An estimator
     * that treats every inter-burst gap as "bandwidth dropped to zero"
     * would trigger constant unnecessary downshifts.
     */
    it('smooths through bursty delivery without over-reacting', () => {
        const clock = new SimClock();
        const estimator = new BandwidthEstimator();

        // Bursty pattern: 3 groups arrive rapidly (100ms apart),
        // then 4s gap, repeat. Average: 3 groups per ~4.2s.
        // Each group is 375KB → 3 * 375KB / 4.2s ≈ 1070kbps average.
        // (Comfortably above a 500kbps track.)
        for (let burst = 0; burst < 5; burst++) {
            // 3 groups arrive 100ms apart
            for (let g = 0; g < 3; g++) {
                clock.advance(100_000); // 100ms
                estimator.recordGroup(375_000, clock.now());
            }
            // 4-second pause between bursts
            clock.advance(4_000_000);
        }

        const estimateKbps = estimator.getEstimateKbps();
        // Must NOT over-react to the 4s gaps. Average throughput is
        // ~1070kbps — estimate should be in that ballpark, not near 0.
        expect(estimateKbps).toBeGreaterThan(700);
    });
});
