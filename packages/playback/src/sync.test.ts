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

    it('advances audio and video together while preserving reference and drift', () => {
        const clock = new MockClock();
        clock.set(9_000_000);
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
        sync.setAudioReference(1_000_000_000n);
        sync.reportPresentationTiming(0, 123);
        clock.advance(1_000_000);
        expect(sync.computeAudioRenderTime(1_004_500_000n)!.offsetUs).toBe(3_500_000);
        sync.advanceReference(3_000_000);
        const audio = sync.computeAudioRenderTime(1_004_500_000n)!;
        expect(audio.renderTimeUs).toBe(10_500_000);
        expect(sync.computeVideoRenderTime(1_004_500_000n)!.renderTimeUs).toBe(audio.renderTimeUs);
        expect(sync.computeAudioRenderTime(1_002_000_000n)!.shouldDrop).toBe(true);
        expect(sync.currentDriftUs).toBe(123);
        expect(sync.hasReference).toBe(true);
    });

    it('ignores reference movement without an anchor or a positive finite amount', () => {
        const clock = new MockClock();
        const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
        sync.advanceReference(1_000_000);
        expect(sync.computeAudioRenderTime(0n)).toBeNull();
        sync.setAudioReference(0n);
        for (const amount of [0, -1_000_000, NaN, Infinity]) {
            sync.advanceReference(amount);
            expect(sync.computeAudioRenderTime(0n)!.renderTimeUs).toBe(0);
        }
    });

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

    // ─── Capture-age diagnostics ─────────────────────

    describe('capture-age diagnostics', () => {
        // Mock wall clock — returns Unix epoch microseconds (same domain as CaptureTimestamp)
        class MockWallClock implements WallClockSource {
            private _now = 0;
            now(): number { return this._now; }
            set(us: number): void { this._now = us; }
        }

        function createCaptureAgeSync(wallClock: MockWallClock) {
            return new SyncController({
                driftThresholdUs: DRIFT_THRESHOLD,
                clock: new MockClock(),
                wallClock,
            });
        }

        it('measureLatency returns wall-clock difference (§2.3.1.1)', () => {
            const wallClock = new MockWallClock();
            const sync = createCaptureAgeSync(wallClock);

            // Publisher captured at t=1000s, subscriber wall clock is at t=1001s
            wallClock.set(1_001_000_000); // 1001 seconds in µs
            const latency = sync.measureLatency(1_000_000_000n); // 1000 seconds in µs
            expect(latency).toBe(1_000_000); // 1 second = 1_000_000 µs
        });

        it('measureLatency returns null for 0n timestamp', () => {
            const wallClock = new MockWallClock();
            const sync = createCaptureAgeSync(wallClock);
            wallClock.set(1_000_000_000);
            expect(sync.measureLatency(0n)).toBeNull();
        });

        it('latencyUs getter returns last measurement', () => {
            const wallClock = new MockWallClock();
            const sync = createCaptureAgeSync(wallClock);

            wallClock.set(1_001_500_000);
            sync.observeCaptureTimestamp(1_000_000_000n);
            expect(sync.latencyUs).toBe(1_500_000); // 1500ms in µs
        });
    });

    // ── Video join re-anchor ──────────────────────────────────────

    describe('slipReference', () => {
        it('moves audio and video render times later together, keeping the reference', () => {
            const clock = new MockClock();
            clock.set(5_000_000);
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
            sync.setAudioReference(1_000_000_000n);
            clock.advance(2_000_000);
            // Two seconds behind: a frame captured at the reference is late.
            expect(sync.computeAudioRenderTime(1_000_100_000n)!.shouldDrop).toBe(true);

            sync.slipReference(2_500_000);

            expect(sync.hasReference).toBe(true);
            const audio = sync.computeAudioRenderTime(1_000_100_000n)!;
            const video = sync.computeVideoRenderTime(1_000_100_000n)!;
            expect(audio.shouldDrop).toBe(false);
            expect(audio.renderTimeUs).toBe(5_000_000 + 100_000 + 2_500_000);
            expect(video.renderTimeUs).toBe(audio.renderTimeUs);
        });

        it('is a no-op without a reference or for a non-positive amount', () => {
            const clock = new MockClock();
            const sync = new SyncController({ driftThresholdUs: DRIFT_THRESHOLD, clock });
            sync.slipReference(1_000_000);
            expect(sync.hasReference).toBe(false);
            sync.setAudioReference(0n);
            sync.slipReference(-1_000_000);
            expect(sync.computeAudioRenderTime(0n)!.renderTimeUs).toBe(0);
        });
    });

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

    describe('SyncController — media-time timestamps', () => {
        it('measureLatency returns null when the timestamp is not wall clock', () => {
            const sync = new SyncController({ clock: new MockClock(), driftThresholdUs: DRIFT_THRESHOLD, wallClock: { now: () => 5_000_000 } });
            expect(sync.measureLatency(1_000_000n)).toBe(4_000_000);
            expect(sync.measureLatency(1_000_000n, true)).toBe(4_000_000);
            expect(sync.measureLatency(1_000_000n, false)).toBeNull();
        });

        it('observeCaptureTimestamp invalidates capture age for media time', () => {
            const sync = new SyncController({ clock: new MockClock(), driftThresholdUs: DRIFT_THRESHOLD, wallClock: { now: () => 5_000_000 } });
            sync.observeCaptureTimestamp(1_000_000n);
            expect(sync.captureTimestampAgeUs).toBe(4_000_000);
            sync.observeCaptureTimestamp(2_000_000n, false);
            expect(sync.latencyUs).toBe(0);
            expect(sync.captureTimestampAgeUs).toBeNull();
        });
    });
});

describe('reference ownership across injected clock callbacks', () => {
    it.each(['audio', 'video'] as const)('does not reinstall an old %s reference after a nested reset', media => {
        let act = () => {};
        const sync = new SyncController({ driftThresholdUs: 500_000, clock: { now: () => { act(); return 10_000_000; } } });
        act = () => { act = () => {}; sync.reset(); };
        if (media === 'audio') sync.setAudioReference(1_000_000n);
        else sync.setVideoReference(1_000_000n);
        expect(sync.hasReference).toBe(false);
        expect(sync.computeAudioRenderTime(1_000_000n)).toBeNull();
        sync.setAudioReference(20_000_000n);
        expect(sync.computeAudioRenderTime(20_000_000n)?.renderTimeUs).toBe(10_000_000);
    });

    it.each(['audio', 'video'] as const)('preserves a newer nested reference instead of the outer %s baseline', media => {
        let act = () => {};
        const sync = new SyncController({ driftThresholdUs: 500_000, clock: { now: () => { act(); return 10_000_000; } } });
        act = () => { act = () => {}; sync.reset(); sync.setAudioReference(20_000_000n); };
        if (media === 'audio') sync.setAudioReference(1_000_000n);
        else sync.setVideoReference(1_000_000n);
        expect(sync.computeAudioRenderTime(20_000_000n)?.renderTimeUs).toBe(10_000_000);
    });

    it.each(['reset', 'replace'] as const)('does not return a timing query spanning a nested %s', change => {
        let act = () => {};
        const sync = new SyncController({ driftThresholdUs: 500_000, clock: { now: () => { act(); return 10_000_000; } } });
        sync.setAudioReference(1_000_000n);
        act = () => { act = () => {}; sync.reset(); if (change === 'replace') sync.setAudioReference(20_000_000n); };
        expect(sync.computeAudioRenderTime(1_000_000n)).toBeNull();
        if (change === 'replace') expect(sync.computeAudioRenderTime(20_000_000n)?.renderTimeUs).toBe(10_000_000);
        else expect(sync.hasReference).toBe(false);
    });
});

it('does not commit a video join offset after the clock callback resets its reference', () => {
    let act = () => {};
    const sync = new SyncController({ driftThresholdUs: 500_000, clock: { now: () => { act(); return 10_000_000; } } });
    sync.setAudioReference(10_000_000n);
    act = () => { act = () => {}; sync.reset(); };
    sync.onVideoJoin(1_000_000n);
    expect(sync.hasReference).toBe(false); expect(sync.videoJoinOffsetUs).toBe(0);
});

it('refuses a video query when its second clock callback retires the join reference', () => {
    let act = () => {};
    const sync = new SyncController({ driftThresholdUs: 500_000, clock: { now: () => { act(); return 10_000_000; } } });
    sync.setAudioReference(10_000_000n); sync.onVideoJoin(1_000_000n);
    expect(sync.videoJoinOffsetUs).toBeGreaterThan(0);
    let reads = 0; act = () => { if (++reads === 2) sync.reset(); };
    expect(sync.computeVideoRenderTime(1_000_000n)).toBeNull();
    expect(reads).toBe(2); expect(sync.hasReference).toBe(false);
});
