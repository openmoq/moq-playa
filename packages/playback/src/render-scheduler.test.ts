/**
 * Tests for PTS-anchored render scheduler.
 *
 * Computes wall-clock render times from CaptureTimestamps at decode output,
 * not decode input. Anchors on first rendered frame's PTS and spaces
 * subsequent frames by PTS delta — producing correct 33ms pacing regardless
 * of delivery pattern (burst or real-time).
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { RenderScheduler } from './render-scheduler.js';
import type { ClockSource } from './types.js';

class MockClock implements ClockSource {
    private _now = 0;
    now(): number { return this._now; }
    set(us: number): void { this._now = us; }
}

describe('RenderScheduler', () => {
    it('first frame renders at now + cushion', () => {
        const clock = new MockClock();
        clock.set(1_000_000); // 1s

        const sched = new RenderScheduler(clock);
        const renderTime = sched.schedule(500_000_000n); // captureTs = 500s

        // First frame: anchor, render at now + cushion (default 16ms = 16000µs)
        expect(renderTime).toBe(1_000_000 + 16_000);
    });

    it('subsequent frames spaced by PTS delta (33ms for 30fps)', () => {
        const clock = new MockClock();
        clock.set(1_000_000);

        const sched = new RenderScheduler(clock);
        const t0 = sched.schedule(500_000_000n);

        clock.set(1_005_000); // 5ms later (decode latency)
        const t1 = sched.schedule(500_033_333n); // +33.333ms PTS

        clock.set(1_010_000); // another 5ms
        const t2 = sched.schedule(500_066_666n); // +66.666ms PTS

        // Inter-frame spacing should be 33ms regardless of decode timing
        expect(t1 - t0).toBeCloseTo(33_333, -2);
        expect(t2 - t1).toBeCloseTo(33_333, -2);
    });

    it('burst delivery: 8 frames decoded in 40ms still produce 33ms spacing', () => {
        const clock = new MockClock();
        clock.set(1_000_000);

        const sched = new RenderScheduler(clock);
        const times: number[] = [];

        // 8 frames, each decoded 5ms apart, PTS spaced 33ms
        for (let i = 0; i < 8; i++) {
            clock.set(1_000_000 + i * 5_000); // 5ms decode interval
            const captureTs = BigInt(500_000_000 + i * 33_333);
            times.push(sched.schedule(captureTs));
        }

        // All render times should be 33ms apart
        for (let i = 1; i < times.length; i++) {
            const delta = times[i]! - times[i - 1]!;
            expect(delta).toBeCloseTo(33_333, -2);
        }
    });

    it('detects burst-to-live transition and rebases anchor', () => {
        const clock = new MockClock();
        clock.set(1_000_000);

        const sched = new RenderScheduler(clock);

        // Burst: 4 frames arrive in 20ms
        for (let i = 0; i < 4; i++) {
            clock.set(1_000_000 + i * 5_000);
            sched.schedule(BigInt(500_000_000 + i * 33_333));
        }

        // Live transition: frame #4 arrives 33ms after #3 (real-time delivery)
        // Wall clock: 1_020_000 + 33_000 = 1_053_000
        clock.set(1_053_000);
        const liveFrame = sched.schedule(BigInt(500_000_000 + 4 * 33_333));

        // Live frame should render in the near future, not far in the past
        const offset = liveFrame - clock.now();
        expect(offset).toBeGreaterThanOrEqual(-5_000); // at most 5ms late
    });

    it('reset clears anchor for seek/pause-resume', () => {
        const clock = new MockClock();
        clock.set(1_000_000);

        const sched = new RenderScheduler(clock);
        sched.schedule(500_000_000n);

        sched.reset();

        // After reset, next frame re-anchors
        clock.set(2_000_000);
        const t = sched.schedule(600_000_000n);
        expect(t).toBe(2_000_000 + 16_000); // fresh anchor
    });

    it('custom cushion', () => {
        const clock = new MockClock();
        clock.set(1_000_000);

        const sched = new RenderScheduler(clock, { cushionUs: 50_000 });
        const t = sched.schedule(500_000_000n);
        expect(t).toBe(1_000_000 + 50_000);
    });
});
