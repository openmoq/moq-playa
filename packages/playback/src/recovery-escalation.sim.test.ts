/**
 * Simulation test: recovery escalation under periodic gaps with
 * interleaved successful frames.
 *
 * Reproduces the exact bug observed in production
 * (observed in production, 2026-04-16): H.264 1080p on a jittery network produces
 * periodic gap → skip_forward → render one frame → notifySuccess()
 * → gap → skip → render → ... forever. The consecutive-gap counter
 * never reaches the escalation threshold because notifySuccess()
 * resets it between every gap. QualityController never receives
 * reduce_quality, so the player sits at 4090kbps and stalls every
 * 1-3 seconds instead of downshifting to a lower variant.
 *
 * This is the textbook multi-component emergent bug: GapDetector,
 * RecoveryController, and QualityController are each correct in
 * isolation. The bug is in the interaction pattern under specific
 * delivery conditions that no single-component unit test exercises.
 *
 * @see recovery.ts — DefaultRecoveryController (consecutive-gap policy)
 * @see gap-detector.ts — GapDetector (timeout-based gap detection)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { GapDetector, GapAction } from './gap-detector.js';
import { DefaultRecoveryController } from './recovery.js';
import type { RecoveryAction } from './recovery.js';
import type { ClockSource } from './types.js';

/** Minimal virtual clock — advances only when told to. */
class SimClock implements ClockSource {
    private _nowUs = 0;
    now(): number { return this._nowUs; }
    advance(deltaUs: number): void { this._nowUs += deltaUs; }
}

/**
 * Simulate the exact production pattern: periodic gaps with interleaved
 * successful frames, using real GapDetector + RecoveryController
 * wired together under a deterministic SimulationClock.
 *
 * Delivery schedule:
 *   - Groups arrive every 2s (30fps GOPs)
 *   - Every Nth group is dropped (simulating network dropout)
 *   - Between drops, frames decode successfully → notifySuccess()
 *
 * Expected behavior (after fix):
 *   After M stalls within W seconds, QualityController MUST receive
 *   a reduce_quality signal regardless of interleaved successes.
 *
 * Current behavior (before fix):
 *   reduce_quality is NEVER emitted because notifySuccess() resets
 *   the consecutive gap counter between every gap event.
 */
describe('Recovery escalation under periodic gaps (periodic gap repro)', () => {
    const GROUP_DURATION_US = 2_000_000;  // 2s per GOP
    const GAP_TIMEOUT_US = 500_000;       // 500ms gap timeout (player default)
    const DROP_EVERY_N = 3;               // drop every 3rd group
    const TOTAL_GROUPS = 30;              // simulate 60s of content

    function runScenario(): { actions: RecoveryAction[]; stallCount: number } {
        const clock = new SimClock();
        const gapDetector = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT_US, clock });
        const recovery = new DefaultRecoveryController({ gapEscalationThreshold: 3 });
        recovery.setClock(clock);

        const actions: RecoveryAction[] = [];
        let lastConsumedGroupId = -1n;
        let stallCount = 0;

        for (let g = 0; g < TOTAL_GROUPS; g++) {
            const groupId = BigInt(g);
            const dropped = (g % DROP_EVERY_N) === (DROP_EVERY_N - 1);

            // Advance clock by one GOP duration
            clock.advance(GROUP_DURATION_US);

            if (!dropped) {
                // Group arrives on time — observe in gap detector
                gapDetector.observeGroup(groupId);
            }
            // (If dropped, the group never arrives — gap detector won't see it)

            // Pipeline tick: evaluate gap state for the expected next group
            const availableGroups: bigint[] = [];
            for (let a = Number(lastConsumedGroupId) + 1; a <= g; a++) {
                if ((a % DROP_EVERY_N) !== (DROP_EVERY_N - 1)) {
                    availableGroups.push(BigInt(a));
                }
            }

            const decision = gapDetector.evaluate(lastConsumedGroupId, availableGroups);

            if (decision.action === GapAction.SKIP_FORWARD && decision.targetGroupId !== undefined) {
                // Gap detected — feed to recovery controller
                const action = recovery.evaluate({ type: 'gap', groupId: decision.targetGroupId });
                actions.push(action);
                stallCount++;
                // Skip forward to the target group
                lastConsumedGroupId = decision.targetGroupId;
                // Render one frame from the target group → notifySuccess
                recovery.notifySuccess?.();
            } else if (decision.action === GapAction.WAIT && availableGroups.length > 0) {
                // Contiguous group available — consume it
                const nextGroup = availableGroups[0]!;
                if (nextGroup === lastConsumedGroupId + 1n) {
                    lastConsumedGroupId = nextGroup;
                    // Successful decode → notifySuccess
                    recovery.notifySuccess?.();
                }
            }

            // After gap timeout, re-evaluate if we're still waiting
            if (decision.action === GapAction.WAIT && availableGroups.length > 0) {
                clock.advance(GAP_TIMEOUT_US + 1000); // just past timeout
                const retry = gapDetector.evaluate(lastConsumedGroupId, availableGroups);
                if (retry.action === GapAction.SKIP_FORWARD && retry.targetGroupId !== undefined) {
                    const action = recovery.evaluate({ type: 'gap', groupId: retry.targetGroupId });
                    actions.push(action);
                    stallCount++;
                    lastConsumedGroupId = retry.targetGroupId;
                    recovery.notifySuccess?.();
                }
            }
        }

        return { actions, stallCount };
    }

    it('produces multiple stalls (confirming the delivery pattern is adversarial)', () => {
        const { stallCount } = runScenario();
        // With 30 groups and every 3rd dropped, we expect ~10 stalls.
        expect(stallCount).toBeGreaterThanOrEqual(5);
    });

    it('MUST emit reduce_quality after repeated stalls within a window', () => {
        // This is the key assertion. Current code FAILS because
        // notifySuccess() resets consecutiveGaps between every gap,
        // so the threshold is never reached. The fix adds a
        // window-based escalation that fires regardless of
        // interleaved successes.
        const { actions, stallCount } = runScenario();

        const reduceQualityCount = actions.filter(a => a.type === 'reduce_quality').length;

        // After 5+ stalls within 60 seconds, the recovery controller
        // MUST have emitted at least one reduce_quality signal.
        expect(stallCount).toBeGreaterThanOrEqual(5);
        expect(reduceQualityCount).toBeGreaterThanOrEqual(1);
    });
});

// ─── Bug 2: Slow delivery — stalls without gaps ──────────────────────

/**
 * Simulation test: slow-delivery escalation.
 *
 * Reproduces the exact bug observed in production on constrained
 * networks (observed 2026-04-16 against multiple relays):
 * all groups arrive but each is 200-400ms behind its expected playout
 * time. No groups are missing → GapDetector never fires → recovery
 * controller never receives any trigger → QualityController never
 * gets reduce_quality → player sits at 4090kbps playing in slow motion.
 *
 * This is the companion to the gap-escalation test above. Together
 * they define the complete contract: "any sustained quality-degradation
 * signal — gaps OR stalls — must eventually produce a reduce_quality
 * action."
 *
 * Bug 1 (gaps): groups missing → GapDetector fires → recovery receives
 * gap events but notifySuccess() resets counter → never escalates.
 * (Fixed by windowed gap escalation.)
 *
 * Bug 2 (slow delivery): ALL groups arrive late → GapDetector silent →
 * recovery receives NOTHING → stalls are fire-and-forget UI events.
 * (Unfixed — this test MUST FAIL against current code.)
 */
describe('Recovery escalation under slow delivery (slow delivery repro)', () => {
    const GROUP_DURATION_US = 2_000_000;  // 2s per GOP at ~30fps
    const DELIVERY_DELAY_US = 300_000;    // each group arrives 300ms late
    const GAP_TIMEOUT_US = 500_000;       // 500ms gap timeout (player default)
    const STALL_THRESHOLD_US = 500_000;   // stall detected after 500ms no render
    const TOTAL_GROUPS = 30;              // simulate 60s of content

    /**
     * Simulate slow delivery: every group arrives, but 300ms behind
     * schedule. The GapDetector never fires because the next group
     * always arrives before the gap timeout. But playback stalls
     * repeatedly because frames can't render on time.
     */
    function runScenario(): {
        actions: RecoveryAction[];
        stallCount: number;
        gapCount: number;
    } {
        const clock = new SimClock();
        const gapDetector = new GapDetector({ gapTimeoutUs: GAP_TIMEOUT_US, clock });
        const recovery = new DefaultRecoveryController({
            gapEscalationThreshold: 3,
            stallThresholdMs: 300,
        });
        recovery.setClock(clock);

        const actions: RecoveryAction[] = [];
        let lastConsumedGroupId = -1n;
        let stallCount = 0;
        let gapCount = 0;
        let lastRenderTimeUs = 0;

        for (let g = 0; g < TOTAL_GROUPS; g++) {
            const groupId = BigInt(g);

            // Advance clock to when this group SHOULD play
            const expectedPlayoutUs = g * GROUP_DURATION_US;
            if (clock.now() < expectedPlayoutUs) {
                clock.advance(expectedPlayoutUs - clock.now());
            }

            // Group hasn't arrived yet (it's 300ms late). Check for stall.
            const sinceLastRender = clock.now() - lastRenderTimeUs;
            const stallDurationMs = sinceLastRender / 1000;
            if (sinceLastRender >= STALL_THRESHOLD_US && lastRenderTimeUs > 0) {
                stallCount++;
                const action = recovery.evaluate({
                    type: 'stall',
                    durationMs: stallDurationMs,
                });
                actions.push(action);
            }

            // Group arrives DELIVERY_DELAY_US after expected playout
            clock.advance(DELIVERY_DELAY_US);
            gapDetector.observeGroup(groupId);

            // Evaluate gap state — group IS available, so no gap
            const availableGroups = [groupId];
            const decision = gapDetector.evaluate(lastConsumedGroupId, availableGroups);

            if (decision.action === GapAction.SKIP_FORWARD && decision.targetGroupId !== undefined) {
                const action = recovery.evaluate({ type: 'gap', groupId: decision.targetGroupId });
                actions.push(action);
                gapCount++;
                lastConsumedGroupId = decision.targetGroupId;
                lastRenderTimeUs = clock.now();
                recovery.notifySuccess?.();
            } else if (decision.action === GapAction.WAIT) {
                // Consume the available group (arrived late but present)
                if (groupId === lastConsumedGroupId + 1n) {
                    lastConsumedGroupId = groupId;
                    lastRenderTimeUs = clock.now();
                    recovery.notifySuccess?.();
                }
            }
        }

        return { actions, stallCount, gapCount };
    }

    it('produces stalls but NO gaps (confirming the delivery pattern is slow, not missing)', () => {
        const { stallCount, gapCount } = runScenario();
        expect(stallCount).toBeGreaterThanOrEqual(5);
        expect(gapCount).toBe(0);
    });

    it('MUST emit reduce_quality after repeated stalls within a window', () => {
        // This is the key assertion. Current code FAILS because stall
        // events don't feed into the recovery controller at all —
        // they're emitted to the UI as informational events and nobody
        // acts on them. The fix must make stalls a first-class quality
        // degradation signal alongside gaps.
        const { actions, stallCount, gapCount } = runScenario();

        const reduceQualityCount = actions.filter(a => a.type === 'reduce_quality').length;

        expect(stallCount).toBeGreaterThanOrEqual(5);
        expect(gapCount).toBe(0); // confirms no gaps — this is purely stall-driven
        expect(reduceQualityCount).toBeGreaterThanOrEqual(1);
    });
});
