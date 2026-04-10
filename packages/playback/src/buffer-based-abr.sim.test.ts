/**
 * Simulation tests: buffer-based ABR with bandwidth corroboration.
 *
 * Buffer depth is the PRIMARY quality signal — it directly measures
 * stall risk. Bandwidth estimate is SECONDARY — it only corroborates
 * upshift decisions when the buffer is already healthy.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import type { ClockSource } from './types.js';

import { BufferBasedController } from './buffer-based-controller.js';

/** Minimal virtual clock. */
class SimClock implements ClockSource {
    private _nowUs = 0;
    now(): number { return this._nowUs; }
    advance(deltaUs: number): void { this._nowUs += deltaUs; }
}

/** Fake ABR ladder (4 tracks, bitrates in kbps). */
const LADDER = [
    { name: 'video-0', bitrateKbps: 3000 },
    { name: 'video-1', bitrateKbps: 1500 },
    { name: 'video-2', bitrateKbps: 500 },
    { name: 'video-3', bitrateKbps: 200 },
];

describe('Buffer-based ABR — hybrid buffer depth + bandwidth', () => {

    /**
     * Test 1: Buffer draining below emergency threshold → downshift.
     *
     * Buffer depth < 0.5s means a stall is imminent. The controller
     * MUST recommend downshift regardless of bandwidth estimate.
     * This is the "emergency brake."
     */
    it('recommends downshift when buffer depth falls below emergency threshold', () => {
        const clock = new SimClock();
        const ctrl = new BufferBasedController({
            clock,
            ladder: LADDER,
            initialIndex: 1,  // start at 1500kbps
            lowThresholdUs: 500_000,     // 0.5s
            highThresholdUs: 4_000_000,  // 4s
        });

        // Buffer has 0.3s of content — below 0.5s emergency threshold
        const decision = ctrl.evaluate({
            bufferDepthUs: 300_000,
            bandwidthEstimateKbps: 2000, // plenty of bandwidth — doesn't matter
        });

        expect(decision.action).toBe('downshift');
        expect(decision.targetIndex).toBe(2); // one step down from index 1
    });

    /**
     * Test 2: Buffer healthy + low bandwidth → hold steady.
     *
     * Buffer is in the safe zone (0.5s-4s). Even though bandwidth is
     * below the current track's bitrate, the buffer says we're OK.
     * No switch — avoid the EWMA over-reaction problem.
     */
    it('holds steady when buffer is healthy despite low bandwidth estimate', () => {
        const clock = new SimClock();
        const ctrl = new BufferBasedController({
            clock,
            ladder: LADDER,
            initialIndex: 1,  // 1500kbps
            lowThresholdUs: 500_000,
            highThresholdUs: 4_000_000,
        });

        // Buffer has 2s of content (safe zone), bandwidth looks bad
        const decision = ctrl.evaluate({
            bufferDepthUs: 2_000_000,
            bandwidthEstimateKbps: 400, // well below 1500kbps track
        });

        expect(decision.action).toBe('hold');
    });

    /**
     * Test 3: Buffer healthy + high bandwidth → upshift.
     *
     * Buffer is not draining (above low threshold) and bandwidth
     * supports the higher track. For live streams the jitter buffer
     * never gets "deep" — it drains every tick. So upshift requires
     * buffer healthy (not empty) + bandwidth corroboration.
     */
    it('recommends upshift when buffer is healthy AND bandwidth supports higher track', () => {
        const clock = new SimClock();
        const ctrl = new BufferBasedController({
            clock,
            ladder: LADDER,
            initialIndex: 2,  // 500kbps
            lowThresholdUs: 500_000,
            highThresholdUs: 4_000_000,
        });

        // Buffer has 5s of content (above 4s high threshold),
        // bandwidth is 2.25× the next-higher track (1500kbps × 2.25 = 3375kbps)
        const decision = ctrl.evaluate({
            bufferDepthUs: 5_000_000,
            bandwidthEstimateKbps: 4000, // > 3375kbps
        });

        expect(decision.action).toBe('upshift');
        expect(decision.targetIndex).toBe(1); // one step up from index 2
    });

    it('holds when buffer is below highThreshold even with very high bandwidth', () => {
        const clock = new SimClock();
        const ctrl = new BufferBasedController({
            clock,
            ladder: LADDER,
            initialIndex: 2,  // 500kbps
            lowThresholdUs: 500_000,
            highThresholdUs: 4_000_000,
        });

        // Buffer at 3s — above low (0.5s) but below high (4s).
        // Bandwidth is extremely high, but upshift still requires
        // buffer >= highThresholdUs for safety.
        const decision = ctrl.evaluate({
            bufferDepthUs: 3_000_000,
            bandwidthEstimateKbps: 100_000, // 100 Mbps
        });

        expect(decision.action).toBe('hold');
    });

    /**
     * Test 4: Buffer healthy + low bandwidth → hold steady.
     *
     * Buffer is not draining, but bandwidth does NOT support the
     * next-higher track. Buffer says "you're OK" but bandwidth says
     * "don't push it" → hold.
     */
    it('holds steady when buffer is healthy but bandwidth cannot support higher track', () => {
        const clock = new SimClock();
        const ctrl = new BufferBasedController({
            clock,
            ladder: LADDER,
            initialIndex: 2,  // 500kbps
            lowThresholdUs: 500_000,
            highThresholdUs: 4_000_000,
        });

        // Buffer has 2s of content (healthy), but bandwidth is only 800kbps —
        // not enough for the next-higher track (1500kbps × 2.25 = 3375kbps)
        const decision = ctrl.evaluate({
            bufferDepthUs: 2_000_000,
            bandwidthEstimateKbps: 800,
        });

        expect(decision.action).toBe('hold');
    });

    /**
     * Test 5: Already at lowest quality → downshift returns hold.
     *
     * Buffer is critically low, but we're already at the bottom of
     * the ladder. Can't go lower — return hold, not crash.
     */
    it('holds when buffer is low but already at lowest quality', () => {
        const clock = new SimClock();
        const ctrl = new BufferBasedController({
            clock,
            ladder: LADDER,
            initialIndex: 3,  // already at 200kbps (lowest)
            lowThresholdUs: 500_000,
            highThresholdUs: 4_000_000,
        });

        const decision = ctrl.evaluate({
            bufferDepthUs: 200_000,       // critically low
            bandwidthEstimateKbps: 100,   // terrible
        });

        expect(decision.action).toBe('hold'); // can't go lower
    });

    /**
     * Test 6: Already at highest quality → upshift returns hold.
     */
    it('holds when buffer is deep but already at highest quality', () => {
        const clock = new SimClock();
        const ctrl = new BufferBasedController({
            clock,
            ladder: LADDER,
            initialIndex: 0,  // already at 3000kbps (highest)
            lowThresholdUs: 500_000,
            highThresholdUs: 4_000_000,
        });

        const decision = ctrl.evaluate({
            bufferDepthUs: 6_000_000,
            bandwidthEstimateKbps: 10000,
        });

        expect(decision.action).toBe('hold'); // can't go higher
    });
});
