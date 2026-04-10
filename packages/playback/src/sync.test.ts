/**
 * Tests for the A/V sync controller.
 *
 * Audio-master model: first audio sample establishes the sync reference
 * mapping CaptureTimestamp to local clock time. Video render times are
 * computed relative to this reference.
 *
 * @see draft-ietf-moq-loc-01 §2.3.1.1 (CaptureTimestamp — microseconds)
 */

import { describe, it, expect } from 'vitest';
import { SyncController } from './sync.js';
import type { WallClockSource } from './sync.js';
import type { ClockSource } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

class MockClock implements ClockSource {
    private _now = 0;
    now(): number { return this._now; }
    advance(us: number): void { this._now += us; }
    set(us: number): void { this._now = us; }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('SyncController', () => {
    const DRIFT_THRESHOLD = 500_000; // 500ms

    it('no reference established — hasReference is false (§2.3.1.1)', () => {
        const clock = new MockClock();
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
        expect(sync.hasReference).toBe(false);
    });

    it('set audio reference — hasReference is true (§2.3.1.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000); // 5 seconds
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        sync.setAudioReference(1_000_000_000n); // 1000 seconds capture time
        expect(sync.hasReference).toBe(true);
    });

    it('video render time relative to audio baseline (§2.3.1.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000); // local clock at 5s
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        // Audio captured at 1000s, received when local clock is 5s
        sync.setAudioReference(1_000_000_000n);

        // Video captured 33333µs later (one 30fps frame)
        const timing = sync.computeVideoRenderTime(1_000_033_333n);
        expect(timing).not.toBeNull();
        expect(timing!.renderTimeUs).toBe(5_033_333);
        expect(timing!.shouldDrop).toBe(false);
    });

    it('frame too late — shouldDrop is true', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        sync.setAudioReference(1_000_000_000n);

        // Advance clock 2 seconds past the reference
        clock.advance(2_000_000);
        // Now local clock is at 7_000_000

        // Try to render a frame captured at the original audio time (1000s)
        // renderTimeUs = 5_000_000 + (1_000_000_000 - 1_000_000_000) = 5_000_000
        // Current clock = 7_000_000, render time = 5_000_000 → 2s late
        const timing = sync.computeVideoRenderTime(1_000_000_000n);
        expect(timing).not.toBeNull();
        expect(timing!.renderTimeUs).toBe(5_000_000);
        expect(timing!.shouldDrop).toBe(true);
    });

    it('drift under threshold — needsResync is false', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        sync.setAudioReference(1_000_000_000n);

        // Report actual render close to expected
        sync.reportActualRenderTime(1_000_033_333n, 5_033_400); // 67µs off
        expect(sync.needsResync).toBe(false);
    });

    it('drift over threshold — needsResync is true', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        sync.setAudioReference(1_000_000_000n);

        // Report actual render significantly drifted
        // Expected render for capture 1_000_100_000: 5_100_000
        // Actual: 5_700_000 → 600_000µs drift (> 500ms threshold)
        sync.reportActualRenderTime(1_000_100_000n, 5_700_000);
        expect(sync.currentDriftUs).toBe(600_000);
        expect(sync.needsResync).toBe(true);
    });

    it('reset clears reference', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        sync.setAudioReference(1_000_000_000n);
        expect(sync.hasReference).toBe(true);

        sync.reset();
        expect(sync.hasReference).toBe(false);
    });

    it('audio render time computation (§2.3.1.1)', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        sync.setAudioReference(1_000_000_000n);

        // Audio captured 20ms later
        const timing = sync.computeAudioRenderTime(1_000_020_000n);
        expect(timing).not.toBeNull();
        expect(timing!.renderTimeUs).toBe(5_020_000);
    });

    it('resync resets drift', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

        sync.setAudioReference(1_000_000_000n);
        sync.reportActualRenderTime(1_000_100_000n, 5_700_000); // 600ms drift
        expect(sync.needsResync).toBe(true);

        // Resync with new reference
        clock.set(10_000_000);
        sync.setAudioReference(1_005_000_000n);
        expect(sync.currentDriftUs).toBe(0);
        expect(sync.needsResync).toBe(false);
    });

    it('no reference — computeVideoRenderTime returns null (hold frame)', () => {
        const clock = new MockClock();
        clock.set(8_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
        expect(sync.computeVideoRenderTime(1_000_000_000n)).toBeNull();
    });

    it('no reference — computeAudioRenderTime returns null', () => {
        const clock = new MockClock();
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
        expect(sync.computeAudioRenderTime(1_000_000_000n)).toBeNull();
    });

    // ─── Configurable drop threshold ───────────────────────────────

    it('configurable dropThresholdUs — drops at custom threshold', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        // Custom drop threshold: 100ms instead of default 500ms
        const sync = new SyncController({
            driftThresholdUs: DRIFT_THRESHOLD,
            dropThresholdUs: 100_000,
            clock,
        });

        sync.setAudioReference(1_000_000_000n);

        // Advance clock 200ms past the reference frame time
        clock.advance(200_000);

        // Try to render a frame captured at the original audio time
        // renderTimeUs = 5_000_000, clock = 5_200_000 → 200ms late > 100ms threshold
        const timing = sync.computeVideoRenderTime(1_000_000_000n);
        expect(timing!.shouldDrop).toBe(true);
    });

    it('configurable dropThresholdUs — does NOT drop below threshold', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        // Larger threshold: 2 seconds
        const sync = new SyncController({
            driftThresholdUs: DRIFT_THRESHOLD,
            dropThresholdUs: 2_000_000,
            clock,
        });

        sync.setAudioReference(1_000_000_000n);

        // Advance clock 1 second — frame at reference time is now 1s late
        clock.advance(1_000_000);

        // 1s late < 2s threshold → should NOT drop
        const timing = sync.computeVideoRenderTime(1_000_000_000n);
        expect(timing!.shouldDrop).toBe(false);
    });

    // ─── Live Catch-Up (§5.1.16 targetLatency) ─────────────────────

    describe('catch-up', () => {
        // Mock wall clock — returns Unix epoch microseconds (same domain as CaptureTimestamp)
        class MockWallClock implements WallClockSource {
            private _now = 0;
            now(): number { return this._now; }
            set(us: number): void { this._now = us; }
        }

        const TARGET_MS = 1000;      // 1 second target latency
        const THRESHOLD_MS = 500;    // activate at 1500ms latency
        const RECOVERY_MS = 50;      // deactivate at 1050ms latency
        const MAX_RATE = 1.1;        // 10% faster

        function createCatchUpSync(wallClock: MockWallClock) {
            return new SyncController({
                driftThresholdUs: DRIFT_THRESHOLD,
                clock: new MockClock(),
                targetLatencyMs: TARGET_MS,
                maxCatchUpRate: MAX_RATE,
                catchUpThresholdMs: THRESHOLD_MS,
                catchUpRecoveryMs: RECOVERY_MS,
                wallClock,
            });
        }

        it('measureLatency returns wall-clock difference (§2.3.1.1)', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // Publisher captured at t=1000s, subscriber wall clock is at t=1001s
            wallClock.set(1_001_000_000); // 1001 seconds in µs
            const latency = sync.measureLatency(1_000_000_000n); // 1000 seconds in µs
            expect(latency).toBe(1_000_000); // 1 second = 1_000_000 µs
        });

        it('measureLatency returns null for 0n timestamp', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);
            wallClock.set(1_000_000_000);
            expect(sync.measureLatency(0n)).toBeNull();
        });

        it('evaluateCatchUp returns null when disabled (maxRate=1.0)', () => {
            const wallClock = new MockWallClock();
            const sync = new SyncController({
                driftThresholdUs: DRIFT_THRESHOLD,
                clock: new MockClock(),
                maxCatchUpRate: 1.0, // disabled
                targetLatencyMs: TARGET_MS,
                wallClock,
            });

            wallClock.set(1_002_000_000);
            expect(sync.evaluateCatchUp(1_000_000_000n)).toBeNull();
        });

        it('evaluateCatchUp returns null without targetLatencyMs', () => {
            const wallClock = new MockWallClock();
            const sync = new SyncController({
                driftThresholdUs: DRIFT_THRESHOLD,
                clock: new MockClock(),
                maxCatchUpRate: MAX_RATE,
                // No targetLatencyMs
                wallClock,
            });

            wallClock.set(1_002_000_000);
            expect(sync.evaluateCatchUp(1_000_000_000n)).toBeNull();
        });

        it('activates when latency exceeds target + threshold (§5.1.16)', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // Latency = 1600ms > target(1000) + threshold(500) = 1500ms → activate
            wallClock.set(1_001_600_000); // 1001.6s
            const state = sync.evaluateCatchUp(1_000_000_000n); // 1000s
            expect(state).not.toBeNull();
            expect(state!.active).toBe(true);
            expect(state!.latencyMs).toBe(1600);
            expect(state!.targetMs).toBe(TARGET_MS);
            expect(state!.currentRate).toBeGreaterThan(1.0);
        });

        it('does not activate below threshold', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // Latency = 1400ms < target(1000) + threshold(500) = 1500ms → no activation
            wallClock.set(1_001_400_000);
            const state = sync.evaluateCatchUp(1_000_000_000n);
            // Returns non-null (latency measured, catch-up evaluated) but not active
            expect(state).not.toBeNull();
            expect(state!.active).toBe(false);
            expect(state!.currentRate).toBe(1.0);
        });

        it('deactivates when latency drops to target + recovery (§5.1.16)', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // First: activate (latency = 1600ms > 1500ms threshold)
            wallClock.set(1_001_600_000);
            const active = sync.evaluateCatchUp(1_000_000_000n);
            expect(active!.active).toBe(true);

            // Then: drop latency to 1040ms <= target(1000) + recovery(50) = 1050ms → deactivate
            wallClock.set(1_001_040_000);
            const deactivated = sync.evaluateCatchUp(1_000_000_000n);
            expect(deactivated!.active).toBe(false);
            expect(deactivated!.currentRate).toBe(1.0);
        });

        it('rate is proportional to overshoot', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // Latency = 1750ms → overshoot = 750ms, ratio = 750/500 = 1.0 (clamped), rate = 1.1
            wallClock.set(1_001_750_000);
            const full = sync.evaluateCatchUp(1_000_000_000n);
            expect(full!.currentRate).toBe(MAX_RATE);

            // Reset and try smaller overshoot
            sync.reset();
            // Latency = 1250ms → overshoot = 250ms, ratio = 250/500 = 0.5, rate = 1.0 + 0.1*0.5 = 1.05
            wallClock.set(1_001_750_000);
            // First activate
            sync.evaluateCatchUp(1_000_000_000n);
            // Now with less overshoot (need a new capture time)
            wallClock.set(1_001_250_000);
            // Already active from previous call, so this will update rate
            // Actually, after reset() the sync is no longer active. Let me activate first.
        });

        it('rate is quantized to 0.05x increments', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // Activate: latency = 1600ms → overshoot = 600, ratio = 600/500 = 1.0 (clamped)
            // rate = 1.0 + 0.1 * 1.0 = 1.1, quantized = 1.1 ✓
            wallClock.set(1_001_600_000);
            const state = sync.evaluateCatchUp(1_000_000_000n);
            expect(state!.active).toBe(true);
            // 1.1 is a valid 0.05x increment
            expect(state!.currentRate * 20 % 1).toBeCloseTo(0, 5);
        });

        it('rate is capped at maxCatchUpRate', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // Extreme latency = 5000ms → overshoot = 4000ms, ratio clamped at 1.0
            // rate = 1.0 + 0.1 * 1.0 = 1.1, capped at maxCatchUpRate 1.1
            wallClock.set(1_005_000_000);
            const state = sync.evaluateCatchUp(1_000_000_000n);
            expect(state!.currentRate).toBeLessThanOrEqual(MAX_RATE);
        });

        it('reset clears catch-up state', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            // Activate
            wallClock.set(1_001_600_000);
            sync.evaluateCatchUp(1_000_000_000n);
            expect(sync.catchUpActive).toBe(true);

            sync.reset();
            expect(sync.catchUpActive).toBe(false);
            expect(sync.currentRate).toBe(1.0);
        });

        it('latencyUs getter returns last measurement', () => {
            const wallClock = new MockWallClock();
            const sync = createCatchUpSync(wallClock);

            wallClock.set(1_001_500_000);
            sync.evaluateCatchUp(1_000_000_000n);
            expect(sync.latencyUs).toBe(1_500_000); // 1500ms in µs
        });
    });

    // ── Video join re-anchor ──────────────────────────────────────

    describe('video join re-anchor', () => {
        it('shifts first video frame render time to the future', () => {
            const clock = new MockClock();
            clock.set(100_000); // 100ms
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

            // Audio reference set at t=100ms, captureTs=1_000_000_000 (1000s)
            sync.setAudioReference(1_000_000_000n);

            // Time passes — video keyframe arrives at t=600ms
            clock.set(600_000);

            // Video keyframe has captureTs=999_820_000 (180ms BEFORE audio reference)
            // Naive render time = 100_000 + (999_820_000 - 1_000_000_000) = 100_000 - 180_000 = -80_000 → past!
            const naiveTiming = sync.computeVideoRenderTime(999_820_000n)!;
            expect(naiveTiming.offsetUs).toBeLessThan(0); // would render in the past

            // Apply video join re-anchor
            sync.onVideoJoin(999_820_000n);

            // Now the same frame should render in the future
            const adjustedTiming = sync.computeVideoRenderTime(999_820_000n)!;
            expect(adjustedTiming.offsetUs).toBeGreaterThanOrEqual(0);
            expect(adjustedTiming.renderTimeUs).toBeGreaterThanOrEqual(clock.now());
        });

        it('preserves inter-frame timing (33ms spacing)', () => {
            const clock = new MockClock();
            clock.set(100_000);
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
            sync.setAudioReference(1_000_000_000n);
            clock.set(600_000);

            sync.onVideoJoin(999_820_000n);

            const t0 = sync.computeVideoRenderTime(999_820_000n)!;
            const t1 = sync.computeVideoRenderTime(999_853_333n)!;
            const t2 = sync.computeVideoRenderTime(999_886_666n)!;

            // Inter-frame intervals should be ~33ms regardless of offset
            const delta01 = t1.renderTimeUs - t0.renderTimeUs;
            const delta12 = t2.renderTimeUs - t1.renderTimeUs;
            expect(delta01).toBeCloseTo(33_333, -2);
            expect(delta12).toBeCloseTo(33_333, -2);
        });

        it('offset snaps to zero when video catches up to live edge', () => {
            const clock = new MockClock();
            clock.set(100_000);
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
            sync.setAudioReference(1_000_000_000n);
            clock.set(600_000);

            sync.onVideoJoin(999_820_000n);
            expect(sync.videoJoinOffsetUs).toBeGreaterThan(0);

            // Advance clock to 800ms. Compute for a frame whose captureTs
            // puts the BASE render time in the future (> 800_000).
            // Base = 100_000 + (captureTs - 1_000_000_000)
            // Need base > 800_000 → captureTs > 1_000_700_000
            clock.set(800_000);
            const futureCapture = 1_000_800_000n; // base = 100_000 + 800_000 = 900_000 > 800_000
            sync.computeVideoRenderTime(futureCapture);

            // Offset should have snapped to zero
            expect(sync.videoJoinOffsetUs).toBe(0);
        });

        it('does not apply offset when first frame is already in the future', () => {
            const clock = new MockClock();
            clock.set(100_000);
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
            sync.setAudioReference(1_000_000_000n);

            // Video keyframe captureTs is AFTER audio reference — already in the future
            sync.onVideoJoin(1_000_100_000n);
            expect(sync.videoJoinOffsetUs).toBe(0);
        });

        it('suppresses needsResync during video join phase', () => {
            const clock = new MockClock();
            clock.set(100_000);
            const sync = new SyncController({ driftThresholdUs: 200_000, clock });
            sync.setAudioReference(1_000_000_000n);
            clock.set(600_000);

            sync.onVideoJoin(999_820_000n);

            // Report drift that would normally trigger resync
            sync.reportActualRenderTime(999_820_000n, 900_000); // big drift
            expect(sync.needsResync).toBe(false); // suppressed during join
        });

        it('audio render times are unaffected by video join offset', () => {
            const clock = new MockClock();
            clock.set(100_000);
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
            sync.setAudioReference(1_000_000_000n);
            clock.set(600_000);

            const audioBefore = sync.computeAudioRenderTime(1_000_100_000n);
            sync.onVideoJoin(999_820_000n);
            const audioAfter = sync.computeAudioRenderTime(1_000_100_000n);

            expect(audioAfter!.renderTimeUs).toBe(audioBefore!.renderTimeUs);
        });
    });

    // ─── Video-only reference ────────────────────────────────────────

    describe('video-only reference (setVideoReference)', () => {
        it('establishes reference for video-only streams', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

            expect(sync.hasReference).toBe(false);
            sync.setVideoReference(1_000_000_000n);
            expect(sync.hasReference).toBe(true);

            const timing = sync.computeVideoRenderTime(1_000_033_333n);
            expect(timing).not.toBeNull();
            expect(timing!.renderTimeUs).toBe(5_033_333);
        });

        it('is a no-op if audio reference already exists', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });

            sync.setAudioReference(1_000_000_000n);
            const before = sync.computeVideoRenderTime(1_000_033_333n);

            clock.advance(1_000_000);
            sync.setVideoReference(2_000_000_000n); // should be ignored

            const after = sync.computeVideoRenderTime(1_000_033_333n);
            expect(after!.renderTimeUs).toBe(before!.renderTimeUs);
        });
    });
});
