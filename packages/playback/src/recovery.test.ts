/**
 * Tests for the recovery controller.
 *
 * Event-driven escalation: consecutive gap counts (no timing),
 * notifySuccess() closes the feedback loop by resetting gap state.
 *
 * Local policy reacting to transport signals:
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status — gap detection)
 * @see draft-ietf-moq-transport-16 §13.4.3 (TOO_FAR_BEHIND signal)
 * @see draft-ietf-moq-transport-16 §13.4.4 (DELIVERY_TIMEOUT signal)
 */

import { describe, it, expect } from 'vitest';
import { DefaultRecoveryController } from './recovery.js';

describe('DefaultRecoveryController', () => {
    it('single gap → skip_forward', () => {
        const rc = new DefaultRecoveryController();
        const action = rc.evaluate({ type: 'gap', groupId: 5n });
        expect(action.type).toBe('skip_forward');
    });

    it('consecutive gaps at threshold → reduce_quality', () => {
        const rc = new DefaultRecoveryController({ gapEscalationThreshold: 3 });

        rc.evaluate({ type: 'gap', groupId: 5n });
        rc.evaluate({ type: 'gap', groupId: 7n });
        const action = rc.evaluate({ type: 'gap', groupId: 9n });

        expect(action.type).toBe('reduce_quality');
    });

    it('after reduce_quality, further gaps → skip_forward (no spam)', () => {
        const rc = new DefaultRecoveryController({ gapEscalationThreshold: 3 });

        // Trigger reduce_quality
        rc.evaluate({ type: 'gap', groupId: 1n });
        rc.evaluate({ type: 'gap', groupId: 2n });
        const escalated = rc.evaluate({ type: 'gap', groupId: 3n });
        expect(escalated.type).toBe('reduce_quality');

        // Further gaps should NOT fire reduce_quality again — pending flag is set
        for (let i = 0; i < 20; i++) {
            const action = rc.evaluate({ type: 'gap', groupId: BigInt(10 + i) });
            expect(action.type).toBe('skip_forward');
        }
    });

    it('notifySuccess() re-arms escalation after reduce_quality', () => {
        const rc = new DefaultRecoveryController({ gapEscalationThreshold: 3 });

        // Trigger reduce_quality
        rc.evaluate({ type: 'gap', groupId: 1n });
        rc.evaluate({ type: 'gap', groupId: 2n });
        rc.evaluate({ type: 'gap', groupId: 3n }); // reduce_quality

        // Notify success — frame decoded, quality reduction helped
        rc.notifySuccess();

        // Now escalation should be re-armed
        rc.evaluate({ type: 'gap', groupId: 10n });
        rc.evaluate({ type: 'gap', groupId: 11n });
        const action = rc.evaluate({ type: 'gap', groupId: 12n });
        expect(action.type).toBe('reduce_quality');
    });

    it('notifySuccess() resets consecutive gap count', () => {
        const rc = new DefaultRecoveryController({ gapEscalationThreshold: 3 });

        // 2 gaps, then success
        rc.evaluate({ type: 'gap', groupId: 1n });
        rc.evaluate({ type: 'gap', groupId: 2n });
        rc.notifySuccess(); // resets count

        // Next gap is 1st again, not 3rd
        const action = rc.evaluate({ type: 'gap', groupId: 10n });
        expect(action.type).toBe('skip_forward');
    });

    it('buffer_overflow → reduce_quality', () => {
        const rc = new DefaultRecoveryController();
        const action = rc.evaluate({ type: 'buffer_overflow' });
        expect(action.type).toBe('reduce_quality');
    });

    it('buffer_overflow gated by qualityReductionPending — no spam', () => {
        const rc = new DefaultRecoveryController();

        // First overflow → reduce_quality
        const first = rc.evaluate({ type: 'buffer_overflow' });
        expect(first.type).toBe('reduce_quality');

        // Subsequent overflows → skip_forward (pending flag set)
        for (let i = 0; i < 10; i++) {
            const action = rc.evaluate({ type: 'buffer_overflow' });
            expect(action.type).toBe('skip_forward');
        }

        // After success, re-armed
        rc.notifySuccess();
        const rearmed = rc.evaluate({ type: 'buffer_overflow' });
        expect(rearmed.type).toBe('reduce_quality');
    });

    it('too_far_behind → reduce_quality (reacting to §13.4.3 signal)', () => {
        const rc = new DefaultRecoveryController();
        const action = rc.evaluate({ type: 'too_far_behind' });
        expect(action.type).toBe('reduce_quality');
    });

    it('too_far_behind gated by qualityReductionPending', () => {
        const rc = new DefaultRecoveryController();

        rc.evaluate({ type: 'too_far_behind' }); // sets pending
        const second = rc.evaluate({ type: 'too_far_behind' });
        expect(second.type).toBe('skip_forward');
    });

    it('delivery_timeout → resubscribe (reacting to §13.4.4 signal)', () => {
        const rc = new DefaultRecoveryController();
        const action = rc.evaluate({ type: 'delivery_timeout' });
        expect(action.type).toBe('resubscribe');
    });

    it('decode_error → resubscribe first, terminate on repeat', () => {
        const rc = new DefaultRecoveryController();

        const first = rc.evaluate({ type: 'decode_error', message: 'codec failed' });
        expect(first.type).toBe('resubscribe');

        const second = rc.evaluate({ type: 'decode_error', message: 'codec failed again' });
        expect(second.type).toBe('terminate');
    });

    it('reset() clears all state — fresh after pause→resume', () => {
        const rc = new DefaultRecoveryController({ gapEscalationThreshold: 3 });

        // Accumulate state
        rc.evaluate({ type: 'gap', groupId: 5n });
        rc.evaluate({ type: 'gap', groupId: 7n });
        rc.evaluate({ type: 'decode_error', message: 'error' });

        rc.reset();

        // Gap count reset — next gap is 1st, not 3rd
        const action = rc.evaluate({ type: 'gap', groupId: 100n });
        expect(action.type).toBe('skip_forward');

        // Error count reset — next error is 1st, not 2nd
        const errAction = rc.evaluate({ type: 'decode_error', message: 'error' });
        expect(errAction.type).toBe('resubscribe');
    });

    it('reset() clears qualityReductionPending flag', () => {
        const rc = new DefaultRecoveryController({ gapEscalationThreshold: 3 });

        // Trigger reduce_quality → pending = true
        rc.evaluate({ type: 'gap', groupId: 1n });
        rc.evaluate({ type: 'gap', groupId: 2n });
        rc.evaluate({ type: 'gap', groupId: 3n }); // reduce_quality

        rc.reset();

        // Escalation should be re-armed (pending cleared)
        rc.evaluate({ type: 'gap', groupId: 10n });
        rc.evaluate({ type: 'gap', groupId: 11n });
        const action = rc.evaluate({ type: 'gap', groupId: 12n });
        expect(action.type).toBe('reduce_quality');
    });

    // ─── Configurable thresholds ─────────────────────────────────

    it('configurable gapEscalationThreshold — escalates at 5 instead of 3', () => {
        const rc = new DefaultRecoveryController({ gapEscalationThreshold: 5 });

        for (let i = 0; i < 4; i++) {
            const action = rc.evaluate({ type: 'gap', groupId: BigInt(i) });
            expect(action.type).toBe('skip_forward');
        }

        const action = rc.evaluate({ type: 'gap', groupId: 5n });
        expect(action.type).toBe('reduce_quality');
    });

    it('configurable maxDecodeErrors — terminates at custom threshold', () => {
        const rc = new DefaultRecoveryController({ maxDecodeErrors: 5 });

        for (let i = 0; i < 4; i++) {
            const action = rc.evaluate({ type: 'decode_error', message: `error ${i}` });
            expect(action.type).toBe('resubscribe');
        }

        const action = rc.evaluate({ type: 'decode_error', message: 'error 5' });
        expect(action.type).toBe('terminate');
    });
});
