/**
 * Tests for group-level gap detection and skip-forward logic.
 *
 * The gap detector tracks the expected group sequence and decides when
 * to skip forward past missing groups (dropped by the server under
 * congestion) vs when to keep waiting.
 *
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status: END_OF_GROUP, END_OF_TRACK)
 * @see draft-ietf-moq-transport-16 §7 (Priority-based dropping)
 */

import { describe, it, expect } from 'vitest';
import { GapDetector, GapAction } from './gap-detector.js';
import type { ClockSource } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────

class MockClock implements ClockSource {
    private _now = 0;
    now(): number { return this._now; }
    advance(us: number): void { this._now += us; }
    set(us: number): void { this._now = us; }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('GapDetector', () => {
    const GAP_TIMEOUT = 500_000; // 500ms in microseconds

    it('sequential groups, no gap — returns WAIT (§10.2.1.1)', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeGroup(0n);
        gd.observeGroup(1n);
        gd.observeGroup(2n);

        // Last consumed group 1, group 2 available — contiguous
        const decision = gd.evaluate(1n, [2n]);
        expect(decision.action).toBe(GapAction.WAIT);
    });

    it('gap detected, timeout not exceeded — returns WAIT', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeGroup(0n);
        gd.observeGroup(1n);
        // Group 2 missing, group 3 available
        gd.observeGroup(3n);

        clock.advance(100_000); // 100ms — well under 500ms timeout

        const decision = gd.evaluate(1n, [3n]);
        expect(decision.action).toBe(GapAction.WAIT);
    });

    it('gap detected, timeout exceeded — returns SKIP_FORWARD (§7)', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeGroup(0n);
        gd.observeGroup(1n);
        gd.observeGroup(3n); // group 2 missing

        clock.advance(600_000); // 600ms — past timeout

        const decision = gd.evaluate(1n, [3n]);
        expect(decision.action).toBe(GapAction.SKIP_FORWARD);
        expect(decision.targetGroupId).toBe(3n);
    });

    it('multiple gaps — skips to nearest available group', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeGroup(0n);
        gd.observeGroup(1n);
        // Groups 2, 3, 4 missing, groups 5 and 7 available
        gd.observeGroup(5n);
        gd.observeGroup(7n);

        clock.advance(600_000);

        const decision = gd.evaluate(1n, [5n, 7n]);
        expect(decision.action).toBe(GapAction.SKIP_FORWARD);
        expect(decision.targetGroupId).toBe(5n); // nearest available
    });

    it('END_OF_GROUP received — immediate skip, no timeout needed (§10.2.1.1)', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeGroup(0n);
        gd.observeGroup(1n);
        gd.observeEndOfGroup(1n); // group 1 explicitly terminated

        // No time advance — skip should be immediate
        const decision = gd.evaluate(1n, [2n]);
        // Group 1 ended, group 2 available — contiguous advancement, WAIT is fine
        expect(decision.action).toBe(GapAction.WAIT);

        // But if we're waiting for group 2 and group 3 is available with 2 ended:
        gd.observeGroup(3n);
        gd.observeEndOfGroup(2n);
        const decision2 = gd.evaluate(1n, [3n]);
        expect(decision2.action).toBe(GapAction.SKIP_FORWARD);
        expect(decision2.targetGroupId).toBe(3n);
    });

    it('END_OF_TRACK — returns TRACK_ENDED (§10.2.1.1)', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeGroup(0n);
        gd.observeEndOfTrack();

        expect(gd.isTrackEnded).toBe(true);

        const decision = gd.evaluate(0n, []);
        expect(decision.action).toBe(GapAction.TRACK_ENDED);
    });

    it('no groups available — returns WAIT', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeGroup(0n);
        clock.advance(600_000);

        const decision = gd.evaluate(0n, []);
        expect(decision.action).toBe(GapAction.WAIT);
    });

    it('reset() clears all state — accepts fresh groups after resume', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        // Build up state
        gd.observeGroup(0n);
        gd.observeGroup(1n);
        gd.observeGroup(3n);
        gd.observeEndOfGroup(2n);
        clock.advance(600_000);

        // Reset — simulate pause→resume
        gd.reset();

        // After reset, observing a much later group should not cause stale gap detection
        gd.observeGroup(500n);
        const decision = gd.evaluate(-1n, [500n]);
        // lastConsumed=-1, firstAvailable=500, nextExpected=0 → gap.
        // But group 500 was JUST observed, so timeout hasn't elapsed → WAIT
        expect(decision.action).toBe(GapAction.WAIT);
    });

    it('reset() clears trackEnded flag', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        gd.observeEndOfTrack();
        expect(gd.isTrackEnded).toBe(true);

        gd.reset();
        expect(gd.isTrackEnded).toBe(false);
    });

    it('out-of-order group observation — tracks without crashing', () => {
        const clock = new MockClock();
        const gd = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT, clock });

        // Groups arrive in non-sequential order (could happen across subgroups)
        gd.observeGroup(5n);
        gd.observeGroup(3n); // earlier group arrives later
        gd.observeGroup(4n);

        // Should not throw — gap detector just tracks what it sees
        const decision = gd.evaluate(2n, [3n, 4n, 5n]);
        expect(decision.action).toBe(GapAction.WAIT);
    });
});
