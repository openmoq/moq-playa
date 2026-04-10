/**
 * Group-level gap detection and skip-forward logic.
 *
 * Tracks the expected group sequence for a track. Detects when groups
 * are missing (server dropped them under congestion via priority-based
 * dropping). Decides whether to wait or skip forward.
 *
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @see draft-ietf-moq-transport-16 §7 (Priority-based dropping)
 * @module
 */

import type { ClockSource } from './types.js';

// ─── Action constants ───────────────────────────────────────────────

/**
 * Gap evaluation actions.
 * @see draft-ietf-moq-transport-16 §10.2.1.1
 */
export const GapAction = {
    /** Continue waiting for the missing group. */
    WAIT: 'wait',
    /** Skip forward to the next available group with a keyframe. */
    SKIP_FORWARD: 'skip_forward',
    /** Track has ended. */
    TRACK_ENDED: 'track_ended',
} as const;

export type GapActionValue = (typeof GapAction)[keyof typeof GapAction];

/**
 * Gap evaluation result.
 */
export interface GapDecision {
    readonly action: GapActionValue;
    /** If SKIP_FORWARD, the group to skip to. */
    readonly targetGroupId?: bigint;
}

// ─── GapDetector ────────────────────────────────────────────────────

/**
 * Detects missing groups and decides when to skip forward.
 *
 * @see draft-ietf-moq-transport-16 §10.2.1.1
 */
export class GapDetector {
    private _gapTimeoutUs: number;
    private readonly clock: ClockSource;

    /** Set of group IDs explicitly terminated via END_OF_GROUP. */
    private readonly endedGroups = new Set<bigint>();

    /** Whether END_OF_TRACK has been received. */
    private trackEnded = false;

    /** Earliest observation time for each group. */
    private readonly groupFirstSeenUs = new Map<bigint, number>();

    constructor(config: { gapTimeoutUs: number; clock: ClockSource }) {
        this._gapTimeoutUs = config.gapTimeoutUs;
        this.clock = config.clock;
    }

    /** Current gap timeout in microseconds. Mutable for adaptive tolerance. */
    get gapTimeoutUs(): number { return this._gapTimeoutUs; }
    set gapTimeoutUs(value: number) { this._gapTimeoutUs = value; }

    /**
     * Notify that an object has been received for a group.
     * Records the observation time for timeout calculations.
     */
    observeGroup(groupId: bigint): void {
        if (!this.groupFirstSeenUs.has(groupId)) {
            this.groupFirstSeenUs.set(groupId, this.clock.now());
        }
    }

    /**
     * Notify that an END_OF_GROUP status was received.
     * @see draft-ietf-moq-transport-16 §10.2.1.1 — ObjectStatus 0x3
     */
    observeEndOfGroup(groupId: bigint): void {
        this.endedGroups.add(groupId);
    }

    /**
     * Notify that an END_OF_TRACK status was received.
     * @see draft-ietf-moq-transport-16 §10.2.1.1 — ObjectStatus 0x4
     */
    observeEndOfTrack(): void {
        this.trackEnded = true;
    }

    /** Whether the track has ended. */
    get isTrackEnded(): boolean {
        return this.trackEnded;
    }

    /** Reset all state — used when resuming after pause on a live stream. */
    reset(): void {
        this.endedGroups.clear();
        this.trackEnded = false;
        this.groupFirstSeenUs.clear();
    }

    /**
     * Evaluate the current gap state.
     *
     * @param lastConsumedGroupId The last group fully consumed by the decoder
     * @param availableGroupIds Groups currently buffered (sorted ascending)
     * @returns Decision: WAIT, SKIP_FORWARD, or TRACK_ENDED
     */
    evaluate(lastConsumedGroupId: bigint, availableGroupIds: bigint[]): GapDecision {
        // Track ended → always report
        if (this.trackEnded) {
            return { action: GapAction.TRACK_ENDED };
        }

        // Nothing available → wait
        if (availableGroupIds.length === 0) {
            return { action: GapAction.WAIT };
        }

        const nextExpected = lastConsumedGroupId + 1n;
        const sorted = [...availableGroupIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const firstAvailable = sorted[0]!;

        // Contiguous — next expected is available
        if (firstAvailable <= nextExpected) {
            return { action: GapAction.WAIT };
        }

        // Gap exists: firstAvailable > nextExpected
        // Check if all intermediate groups are explicitly ended
        let allEnded = true;
        for (let g = nextExpected; g < firstAvailable; g++) {
            if (!this.endedGroups.has(g)) {
                allEnded = false;
                break;
            }
        }

        if (allEnded) {
            // All intermediate groups are explicitly ended → skip immediately
            return { action: GapAction.SKIP_FORWARD, targetGroupId: firstAvailable };
        }

        // Implicit gap — check if we've waited long enough since the first
        // available group was observed (that's when the gap became detectable)
        const now = this.clock.now();
        const firstSeenAt = this.groupFirstSeenUs.get(firstAvailable);

        if (firstSeenAt !== undefined) {
            const elapsed = now - firstSeenAt;
            if (elapsed >= this.gapTimeoutUs) {
                return { action: GapAction.SKIP_FORWARD, targetGroupId: firstAvailable };
            }
        }

        return { action: GapAction.WAIT };
    }
}
