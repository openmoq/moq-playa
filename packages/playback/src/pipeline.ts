/**
 * Playback pipeline orchestrator.
 *
 * Wires jitter-buffer + gap-detector + decoder-state + sync together.
 * Accepts MoqtObject + LocHeaders, emits DecoderCommand + PlaybackEvent.
 *
 * Sans-I/O: no WebCodecs, no Canvas, no AudioContext — just pure logic.
 * The browser adapter consumes the emitted DecoderCommands.
 *
 * @see draft-ietf-moq-loc-01 §4.2 (decode order)
 * @see draft-ietf-moq-transport-16 §10.2.1.1 (Object Status)
 * @module
 */

import type { MoqtObject, MoqtObjectData } from '@moqt/transport';
import { ObjectStatus } from '@moqt/transport';
import type { LocHeaders } from '@moqt/loc';
import { toVideoChunkInit, toAudioChunkInit } from '@moqt/loc';

import { isKeyframePayload } from './keyframe-validator.js';
import { JitterBuffer } from './jitter-buffer.js';
import { GapDetector, GapAction } from './gap-detector.js';
import { DecoderStateMachine } from './decoder-state.js';
import { SyncController } from './sync.js';
import { AdaptiveToleranceController, DEFAULT_TOLERANCE_CONFIG } from './adaptive-tolerance.js';
import type { RecoveryController } from './recovery.js';
import type { ClockSource, DecoderCommand, PlaybackEvent, PlaybackConfig, DecoderFeedback } from './types.js';

// ─── Pipeline ────────────────────────────────────────────────────────

/**
 * Pipeline constructor options.
 */
export interface PipelineOptions {
    readonly mediaType: 'video' | 'audio';
    readonly config: PlaybackConfig;
    readonly clock: ClockSource;
    readonly sync: SyncController;
    readonly onCommand: (cmd: DecoderCommand) => void;
    readonly onEvent: (evt: PlaybackEvent) => void;
    /** Optional recovery controller for escalation decisions. */
    readonly recovery?: RecoveryController;
    /** Video-only mode: set video reference from first CaptureTimestamp. */
    readonly videoOnly?: boolean;
    /** Live stream: enables bounded release + backlog shedding. Default: true. */
    readonly isLive?: boolean;
}

/**
 * Playback pipeline orchestrator.
 *
 * @see draft-ietf-moq-loc-01 §4.2
 */
export class PlaybackPipeline {
    private readonly mediaType: 'video' | 'audio';
    private readonly clock: ClockSource;
    private readonly sync: SyncController;
    private readonly onCommand: (cmd: DecoderCommand) => void;
    private readonly onEvent: (evt: PlaybackEvent) => void;
    private readonly recovery: RecoveryController | undefined;

    private readonly buffer: JitterBuffer;
    private readonly gapDetector: GapDetector;
    private readonly decoderState: DecoderStateMachine;

    /** Headers stored alongside objects, keyed by "groupId:objectId". */
    private readonly headerMap = new Map<string, LocHeaders>();

    /** Group reference counts in the jitter buffer. */
    private readonly bufferedGroupCounts = new Map<bigint, number>();

    /** Next expected objectId within the current group for contiguity check. */
    private nextExpectedObjectId = 0n;

    /** Highest group from which at least one object was consumed. -1n = nothing consumed yet. */
    private lastConsumedGroupId = -1n;

    /** Groups for which END_OF_GROUP has been observed. */
    private readonly endedGroups = new Set<bigint>();

    /** Timestamp when we first started waiting for active group completion. */
    private activeGroupWaitStartUs: number | null = null;

    /**
     * Minimum group ID accepted by pushObject().
     * Set after SKIP_FORWARD to reject stale objects from pre-skip groups
     * that arrive late due to async QUIC stream delivery.
     */
    private minAcceptGroupId = -1n;

    /** Last group for which keyframe_waiting was emitted (dedup). */
    private lastKeyframeWaitingGroupId = -1n;

    /**
     * When true, the first tick syncs to whatever group is available
     * without gap detection — avoids cascading recovery on initial
     * live join or after pause→resume on a live stream.
     *
     * Starts `true` so the first arriving group is accepted as the
     * starting point (joining mid-broadcast is not a gap).
     */
    private resetPending = true;

    /** True once track_ended has been emitted — prevents re-emission on every tick. */
    private _trackEnded = false;

    /** Last emitted playback rate — dedup to avoid spamming commands. */
    private _lastEmittedRate = 1.0;

    /**
     * Throttle flag — set by decoder feedback when queue depth is high.
     * While true, tick() evaluates gaps but does NOT drain the buffer.
     * Objects still enter the jitter buffer (needed for gap detection).
     */
    private _throttled = false;

    /** Adaptive jitter tolerance controller (null if disabled). */
    private readonly adaptiveTolerance: AdaptiveToleranceController | null;

    /** Max objects to release per tick (video only). 0 = unlimited. */
    private readonly maxReleasePerTick: number;
    /** Max groups before shedding old ones. 0 = unlimited. */
    private readonly maxBacklogGroups: number;

    /** Video codec string from catalog (e.g., 'avc1.42c01f'). Used for keyframe validation. */
    private _videoCodec: string | undefined;
    private _videoOnly: boolean;

    constructor(opts: PipelineOptions) {
        this.mediaType = opts.mediaType;
        this.clock = opts.clock;
        this.sync = opts.sync;
        this.onCommand = opts.onCommand;
        this.onEvent = opts.onEvent;
        this.recovery = opts.recovery;
        this._videoOnly = opts.videoOnly ?? false;

        // Bounded release: live video defaults to 5 objects/tick + 3 max
        // backlog groups. VOD/non-live and audio are unlimited — shedding
        // old groups is wrong when you need the full timeline.
        const liveVideo = opts.mediaType === 'video' && (opts.isLive ?? true);
        this.maxReleasePerTick = liveVideo
            ? (opts.config.maxReleasePerTick ?? 5)
            : 0;
        this.maxBacklogGroups = liveVideo
            ? (opts.config.maxBacklogGroups ?? 3)
            : 0;

        this.buffer = new JitterBuffer(opts.config.maxBufferDepth);
        this.gapDetector = new GapDetector({
            gapTimeoutUs: opts.config.gapTimeoutUs,
            clock: opts.clock,
        });
        this.decoderState = new DecoderStateMachine(opts.mediaType);

        // Adaptive tolerance: auto-calibrate gap timeout and drift threshold
        this.adaptiveTolerance = opts.config.adaptiveTolerance
            ? new AdaptiveToleranceController(DEFAULT_TOLERANCE_CONFIG)
            : null;

        // Startup buffer not used — video join re-anchor handles startup timing.
    }

    /**
     * Set the video codec string for keyframe payload validation.
     *
     * @param codec Codec string from catalog (e.g., 'avc1.42c01f', 'hvc1', 'av01.0.08M.10')
     * @see draft-ietf-moq-loc-01 §4.2 (decode order)
     */
    setCodec(codec: string): void {
        this._videoCodec = codec;
    }

    /**
     * Current effective gap timeout in microseconds.
     * When adaptive tolerance is enabled, this is auto-calibrated from jitter.
     * Otherwise, returns the fixed configured value.
     */
    get effectiveGapTimeoutUs(): number {
        if (this.adaptiveTolerance) {
            return this.adaptiveTolerance.effectiveGapTimeoutMs * 1000;
        }
        return this.gapDetector.gapTimeoutUs;
    }

    /** Last consumed group ID — for track switch subscription filters. */
    get currentGroupId(): bigint {
        return this.lastConsumedGroupId;
    }

    /** Number of distinct groups currently in the jitter buffer. */
    get bufferedGroupCount(): number {
        return this.bufferedGroupCounts.size;
    }

    /** Whether draining is throttled due to decoder backpressure. */
    get throttled(): boolean {
        return this._throttled;
    }

    /**
     * Handle feedback from browser adapters (decoder queue, errors, drift).
     *
     * @see draft-ietf-moq-loc-01 §2.3.1.1 (drift detection)
     */
    handleFeedback(fb: DecoderFeedback): void {
        switch (fb.type) {
            case 'queue_pressure':
                this._throttled = fb.depth >= fb.maxRecommended;
                break;

            case 'decode_error':
                // Clear throttle — the decoder has likely been recreated with an
                // empty queue. Without this, the pipeline deadlocks: throttled →
                // no decode commands → no decoder output → no queue_pressure_low
                // feedback → throttled forever.
                this._throttled = false;

                // Reset decoder FSM — the browser adapter has recreated the
                // WebCodecs decoder with an empty queue. Video must wait for
                // the next keyframe; audio resumes immediately (all key).
                // Without this, the FSM stays in DECODING and feeds delta
                // frames to a fresh decoder with no keyframe context → silent
                // failures → permanent stall.
                {
                    const decision = this.decoderState.notifyGap();
                    this.emitFsmDecision(decision);
                }

                if (this.recovery) {
                    const action = this.recovery.evaluate({ type: 'decode_error', message: fb.message });
                    this.onEvent({ type: 'recovery', action });
                }
                break;

            case 'frame_rendered':
                // Guard: only report drift when a real capture timestamp is provided.
                // Renderers that don't track capture timestamps pass 0n (e.g., CanvasRenderer),
                // which would produce absurd drift values (trillions of µs).
                if (fb.captureTimestampUs > 0n) {
                    this.sync.reportActualRenderTime(fb.captureTimestampUs, fb.actualRenderUs);
                    // Guard: suppress drift reporting when audio/video CaptureTimestamps
                    // are on different epochs (>5s drift). This is an epoch mismatch,
                    // not real sync drift — reporting it would flood the event log.
                    const drift = this.sync.currentDriftUs;
                    if (this.sync.needsResync && Math.abs(drift) < 5_000_000) {
                        this.onEvent({ type: 'sync_drift', driftUs: drift });
                    }
                }
                break;

            case 'flush_complete':
                // No-op — included for forward compatibility (quality switch gating).
                break;
        }
    }

    /**
     * Provide codec configuration (from catalog or initial headers).
     *
     * For video, this is also triggered automatically when a videoConfig
     * LOC extension is encountered. For audio, this must be called
     * externally since audio config comes from the MSF catalog.
     *
     * @param config Codec-specific configuration bytes
     */
    configure(config: Uint8Array): void {
        const decision = this.decoderState.configure(config);
        if (decision.action === 'configure') {
            this.onCommand({
                type: 'configure',
                mediaType: this.mediaType,
                config,
            });
        }
    }

    /**
     * Push an object into the pipeline.
     *
     * Data objects are buffered. Gap objects notify the gap detector.
     *
     * @param obj The MoqtObject (data or gap)
     * @param headers Parsed LocHeaders (only meaningful for data objects)
     */
    pushObject(obj: MoqtObject, headers?: LocHeaders): void {
        if (obj.kind === 'gap') {
            // Gap signals — notify gap detector
            if (obj.status === ObjectStatus.END_OF_GROUP) {
                this.gapDetector.observeEndOfGroup(obj.groupId);
                this.endedGroups.add(obj.groupId as bigint);
            } else if (obj.status === ObjectStatus.END_OF_TRACK) {
                this.gapDetector.observeEndOfTrack();
            }
            return;
        }

        // Reject stale objects: both from before skip/reset targets AND
        // from groups already consumed during normal forward progress.
        // Late-arriving old groups from QUIC reordering can poison decode
        // order and cause blockiness.
        if (obj.groupId < this.minAcceptGroupId) return;
        if (this.lastConsumedGroupId >= 0n && obj.groupId < this.lastConsumedGroupId) return;
        // Reject already-consumed objects from the current group.
        if (obj.groupId === this.lastConsumedGroupId && obj.objectId < this.nextExpectedObjectId) return;

        // Dedup: reject if this (groupId, objectId) is already buffered.
        const key = `${obj.groupId}:${obj.objectId}`;
        if (this.headerMap.has(key)) return;

        // Data object — try to buffer it
        if (this.buffer.insert(obj)) {
            this.headerMap.set(key, headers ?? {});
            const count = this.bufferedGroupCounts.get(obj.groupId) ?? 0;
            this.bufferedGroupCounts.set(obj.groupId, count + 1);
        } else if (obj.publisherPriority !== undefined) {
            // Buffer full — try priority-aware eviction (§7)
            if (!this.tryEvictAndInsert(obj, headers) && this.recovery) {
                this.onEvent({
                    type: 'recovery',
                    action: this.recovery.evaluate({ type: 'buffer_overflow' }),
                });
            }
        } else if (this.recovery) {
            // No priority info, can't evict — notify recovery
            this.onEvent({
                type: 'recovery',
                action: this.recovery.evaluate({ type: 'buffer_overflow' }),
            });
        }

        // Feed adaptive tolerance controller
        if (this.adaptiveTolerance && headers?.captureTimestamp !== undefined) {
            const nowMs = this.clock.now() / 1000; // µs → ms
            const captureUs = Number(headers.captureTimestamp);
            this.adaptiveTolerance.onFrameArrived(nowMs, captureUs, nowMs);
        }

        // Observe group for gap timeout tracking
        this.gapDetector.observeGroup(obj.groupId);
    }

    /**
     * Reset pipeline state for pause→resume or seek.
     *
     * Clears the jitter buffer, gap detector, and decoder FSM so the first
     * arriving group after resume is accepted cleanly without cascading
     * gap-recovery escalation from the stale pre-pause position.
     *
     * Emits a decoder 'reset' command so the WebCodecs decoder clears its
     * queue and waits for the next keyframe (video) or resumes immediately
     * (audio — Opus/AAC-LC frames are independently decodable).
     *
     * @param targetGroupId When seeking, set this to the target group ID.
     *   Objects from groups before this ID are rejected — prevents stale
     *   in-flight objects from corrupting the post-seek decoder state.
     *   @see draft-ietf-moq-transport-16 §9.11.1 — "it might still receive
     *   Objects outside the new range if the publisher sent them before the
     *   update was processed."
     */
    /**
     * Reset for a track switch — clears jitter buffer (old-track objects
     * use the same groupIds as new-track per altGroup alignment), resets
     * gap detector and group tracking. Does NOT reset decoder state or
     * emit flush/reset commands — already-decoded frames in the renderer
     * queue play out naturally for seamless visual transition.
     *
     * @param firstGroupId The first group ID from the new track — sets
     *   lastConsumedGroupId to firstGroupId-1 so the gap detector doesn't
     *   see a gap and trigger skip_forward (which would reset sync).
     */
    resetForTrackSwitch(firstGroupId: bigint): void {
        // Clear the jitter buffer — old-track encoded objects must not
        // survive into the new decoder configuration. Without this,
        // stale P-frames from the old track drain under the new codec
        // and produce decode errors.
        this.buffer.clear();
        this.headerMap.clear();
        this.bufferedGroupCounts.clear();
        this.lastConsumedGroupId = firstGroupId - 1n;
        this.endedGroups.add(this.lastConsumedGroupId);
        this.nextExpectedObjectId = 0n;
        this.minAcceptGroupId = firstGroupId;
        this.lastKeyframeWaitingGroupId = -1n;
        this._throttled = false;
        this.activeGroupWaitStartUs = null;
        this.gapDetector.reset();
        // Force decoder back to NEEDS_KEYFRAME so partial-group deltas
        // from a mid-stream subscription are skipped, not decoded.
        const decision = this.decoderState.notifyGap();
        this.emitFsmDecision(decision);
    }

    reset(targetGroupId?: bigint): void {
        this.buffer.clear();
        this.headerMap.clear();
        this.bufferedGroupCounts.clear();
        this.lastConsumedGroupId = -1n;
        this.nextExpectedObjectId = 0n;
        this.minAcceptGroupId = targetGroupId ?? -1n;
        this.lastKeyframeWaitingGroupId = -1n;
        this.resetPending = true;
        this._throttled = false;
        this._trackEnded = false;
        this.endedGroups.clear();
        this.activeGroupWaitStartUs = null;
        this.gapDetector.reset();
        this.adaptiveTolerance?.reset();
        const decision = this.decoderState.notifyGap();
        this.emitFsmDecision(decision);
    }

    /**
     * Process buffered objects: evaluate gaps, feed decoder FSM, emit commands.
     *
     * Call this on a regular interval (e.g., requestAnimationFrame or timer).
     */
    tick(): void {
        // Update adaptive tolerance → push auto-calibrated thresholds to gap detector and sync
        if (this.adaptiveTolerance) {
            const nowMs = this.clock.now() / 1000;
            this.adaptiveTolerance.tick(nowMs);
            this.gapDetector.gapTimeoutUs = this.adaptiveTolerance.effectiveGapTimeoutMs * 1000;
            this.sync.driftThresholdUs = this.adaptiveTolerance.effectiveDriftThresholdMs * 1000;
        }

        // After reset (pause→resume, jump-to-live), sync up to the first
        // group that starts with a keyframe (objectId 0). Stale P-frames
        // from the old subscription that arrive after the reset must not
        // become the new starting point — they lack keyframe context and
        // would produce artifacts.
        if (this.resetPending && this.buffer.size > 0) {
            const top = this.buffer.peek()!;
            // Only accept a group that starts with objectId 0 (keyframe).
            // Stale mid-group objects from the old subscription are
            // discarded by extracting + dropping them.
            if (top.objectId !== 0n) {
                this.buffer.extract();
                this.decrementGroupCount(top.groupId);
                return; // wait for a keyframe-starting group
            }
            this.lastConsumedGroupId = top.groupId - 1n;
            this.endedGroups.add(this.lastConsumedGroupId);
            this.resetPending = false;
        }

        // 1. Evaluate gap state
        const availableGroupIds = [...this.bufferedGroupCounts.keys()];
        const gapDecision = this.gapDetector.evaluate(this.lastConsumedGroupId, availableGroupIds);

        // 2. Handle gap decision
        if (gapDecision.action === GapAction.TRACK_ENDED) {
            if (!this._trackEnded) {
                this._trackEnded = true;
                const decision = this.decoderState.notifyTrackEnded();
                this.emitFsmDecision(decision);
                this.onEvent({ type: 'track_ended' });
            }
            return;
        }

        if (gapDecision.action === GapAction.SKIP_FORWARD && gapDecision.targetGroupId !== undefined) {
            const target = gapDecision.targetGroupId;

            // Emit partial_group_abandoned if the current video group wasn't
            // ended normally. This makes the transition observable for diagnostics.
            if (this.mediaType === 'video'
                && this.lastConsumedGroupId >= 0n
                && !this.endedGroups.has(this.lastConsumedGroupId)) {
                this.onEvent({
                    type: 'partial_group_abandoned',
                    fromGroupId: this.lastConsumedGroupId,
                    toGroupId: target,
                    reason: 'gap timeout',
                } as PlaybackEvent);
            }
            // Clean up ended-group tracking for skipped groups
            for (const gid of this.endedGroups) {
                if (gid < target) this.endedGroups.delete(gid);
            }

            this.onEvent({
                type: 'skip_forward',
                fromGroupId: this.lastConsumedGroupId,
                toGroupId: target,
            });

            // Notify recovery controller for potential escalation
            if (this.recovery) {
                const action = this.recovery.evaluate({ type: 'gap', groupId: target });
                this.onEvent({ type: 'recovery', action });
            }

            // Reject future pushObject() calls for groups before the target
            this.minAcceptGroupId = target;

            // Discard old groups from buffer
            this.discardBefore(target);

            // NOTE: Sync reset is NOT done here. When two pipelines (audio + video)
            // share a SyncController, both would call reset() during skip_forward,
            // causing a double-reset: audio resets → re-establishes reference →
            // video resets → wipes reference. The caller (MoqtPlayer) coordinates
            // sync reset via handlePipelineEvent, resetting once per tick cycle.

            // Notify decoder of gap
            const decision = this.decoderState.notifyGap();
            this.emitFsmDecision(decision);

            // Advance consumed position so we start from the target group
            this.lastConsumedGroupId = target - 1n;
            this.endedGroups.add(this.lastConsumedGroupId);
            this.nextExpectedObjectId = 0n;
            this.activeGroupWaitStartUs = null;
        }

        // 3. Backlog shedding: runs BEFORE throttle check so backlog is
        // controlled even when decoder pressure is high. Without this,
        // objects keep entering via pushObject() while throttled, and the
        // shedding path never executes — defeating "move the control
        // point earlier."
        if (this.maxBacklogGroups > 0 && this.bufferedGroupCounts.size > this.maxBacklogGroups) {
            this.shedBacklog();
        }

        // 4. Throttle: if decoder queue is deep, skip draining.
        // Objects still enter via pushObject() (needed for gap detection).
        // Un-throttle signals come from CommandDispatcher on frame output —
        // as the decoder drains its queue, checkQueuePressure() fires on each
        // decoded frame, crossing the low threshold to clear the throttle.
        // @see draft-ietf-moq-transport-16 §7
        if (this._throttled) return;

        // 4b. Intra-group timeout: abandon a partially-consumed video group
        // when its suffix never arrives. The gap detector handles inter-group
        // gaps (N+2 present, N+1 missing). This handles the case where N+1
        // is present but N is incomplete — the gap detector won't fire because
        // the next group IS available.
        if (this.mediaType === 'video' && this.activeGroupWaitStartUs !== null) {
            const elapsed = this.clock.now() - this.activeGroupWaitStartUs;
            if (elapsed > this.gapDetector.gapTimeoutUs) {
                const nextGroupId = this.lastConsumedGroupId + 1n;
                this.onEvent({
                    type: 'partial_group_abandoned',
                    fromGroupId: this.lastConsumedGroupId,
                    toGroupId: nextGroupId,
                    reason: 'intra-group timeout',
                } as PlaybackEvent);
                this.endedGroups.add(this.lastConsumedGroupId);
                const decision = this.decoderState.notifyGap();
                this.emitFsmDecision(decision);
                this.activeGroupWaitStartUs = null;
            }
        }

        // 5. Release contiguous objects from the buffer (bounded).
        // Within a group, objects MUST be contiguous (0, 1, 2, ...) before
        // decoding. A missing objectId means a frame the decoder needs for
        // reference is absent — decoding later objects produces artifacts.
        // Wait for the missing object (QUIC delivers in-order per stream)
        // or let the gap detector timeout and skip the group.
        let released = 0;
        const budget = this.maxReleasePerTick;

        while (this.buffer.size > 0) {
            // Bounded release: stop after budget objects (0 = unlimited).
            if (budget > 0 && released >= budget) break;
            // Mid-tick throttle: decoder feedback during processDataObject
            // may set _throttled via handleFeedback(queue_pressure).
            if (this._throttled) break;

            const top = this.buffer.peek();
            if (!top) break;

            const nextExpectedGroup = this.lastConsumedGroupId + 1n;

            // Don't drain past the next expected group — there might be a gap
            if (top.groupId > nextExpectedGroup) {
                break;
            }

            // New group boundary: for video, don't silently transition from
            // a partial group. If the current group wasn't ended (END_OF_GROUP),
            // wait for the intra-group timeout to explicitly abandon it.
            // Audio is independently decodable — transitions are always safe.
            if (top.groupId > this.lastConsumedGroupId && this.lastConsumedGroupId >= 0n) {
                if (this.mediaType === 'video' && !this.endedGroups.has(this.lastConsumedGroupId)) {
                    if (this.activeGroupWaitStartUs === null) {
                        this.activeGroupWaitStartUs = this.clock.now();
                    }
                    break;
                }
                this.activeGroupWaitStartUs = null;
                this.endedGroups.delete(this.lastConsumedGroupId);
            }

            // New group: reset objectId contiguity tracker
            if (top.groupId > this.lastConsumedGroupId) {
                this.nextExpectedObjectId = 0n;
            }

            // Intra-group contiguity (video only): if object N is missing
            // but N+1 is available, skip the rest of this group — decoding
            // N+1 without N's reference produces artifacts. Audio chunks
            // are independently decodable (LOC §4.1) so gaps are harmless.
            if (this.mediaType === 'video' && top.objectId > this.nextExpectedObjectId) {
                // Discard remaining objects in this group — they can't
                // decode correctly without the missing reference.
                const skipGroupId = top.groupId;
                while (this.buffer.size > 0) {
                    const peek = this.buffer.peek();
                    if (!peek || peek.groupId !== skipGroupId) break;
                    this.buffer.extract();
                    this.decrementGroupCount(skipGroupId);
                }
                this.lastConsumedGroupId = skipGroupId;
                this.nextExpectedObjectId = 0n;
                // Let decoder know it needs a fresh keyframe
                const decision = this.decoderState.notifyGap();
                this.emitFsmDecision(decision);
                break;
            }

            const obj = this.buffer.extract()!;
            this.decrementGroupCount(obj.groupId);

            if (obj.kind === 'data') {
                this.processDataObject(obj);
            }

            this.nextExpectedObjectId = obj.objectId + 1n;
            released++;

            // Track last consumed group
            if (obj.groupId > this.lastConsumedGroupId) {
                this.lastConsumedGroupId = obj.groupId;
            }
        }
    }

    // ─── Internal ───────────────────────────────────────────────────

    /**
     * Drop oldest whole groups when backlog exceeds maxBacklogGroups.
     * Keeps the newest maxBacklogGroups groups, discards the rest.
     * After shedding, notifies decoder that a gap occurred (needs keyframe).
     */
    private shedBacklog(): void {
        const groupIds = [...this.bufferedGroupCounts.keys()].sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
        );
        const excess = groupIds.length - this.maxBacklogGroups;
        if (excess <= 0) return;

        const groupsToShed = groupIds.slice(0, excess);
        const cutoff = groupsToShed[groupsToShed.length - 1]! + 1n;
        this.buffer.discardBefore(cutoff);
        for (const gid of groupsToShed) {
            this.bufferedGroupCounts.delete(gid);
        }
        // Clean up leaked header entries for shed groups
        for (const key of this.headerMap.keys()) {
            const groupId = BigInt(key.split(':')[0]!);
            if (groupId < cutoff) this.headerMap.delete(key);
        }

        // Advance consumed position past shed groups
        const lastShed = groupsToShed[groupsToShed.length - 1]!;
        if (lastShed >= this.lastConsumedGroupId) {
            this.lastConsumedGroupId = lastShed;
        }
        this.minAcceptGroupId = lastShed + 1n;

        // Decoder needs a fresh keyframe after shedding
        const decision = this.decoderState.notifyGap();
        this.emitFsmDecision(decision);

        this.onEvent({
            type: 'backlog_shed',
            droppedGroups: excess,
            remainingGroups: this.bufferedGroupCounts.size,
            reason: `backlog exceeded ${this.maxBacklogGroups} groups`,
        });
    }

    /**
     * Attempt to evict a lower-importance object to make room.
     * @returns true if the incoming object was inserted.
     * @see draft-ietf-moq-transport-16 §7 (Priority-based dropping)
     */
    private tryEvictAndInsert(obj: MoqtObjectData, headers?: LocHeaders): boolean {
        const evicted = this.buffer.evictLowestImportance();
        if (!evicted) return false; // No evictable candidate

        if (evicted.publisherPriority! > obj.publisherPriority!) {
            // Evicted is less important — insert incoming
            this.decrementGroupCount(evicted.groupId);
            const evictedKey = `${evicted.groupId}:${evicted.objectId}`;
            this.headerMap.delete(evictedKey);

            this.buffer.insert(obj);
            const key = `${obj.groupId}:${obj.objectId}`;
            this.headerMap.set(key, headers ?? {});
            const count = this.bufferedGroupCounts.get(obj.groupId) ?? 0;
            this.bufferedGroupCounts.set(obj.groupId, count + 1);
            return true;
        } else {
            // Evicted is equally or more important — put it back, drop incoming
            this.buffer.insert(evicted);
            return false;
        }
    }

    private processDataObject(obj: MoqtObjectData): void {
        const key = `${obj.groupId}:${obj.objectId}`;
        const headers = this.headerMap.get(key) ?? {};
        this.headerMap.delete(key);

        // 1. Configure decoder if videoConfig present
        if (headers.videoConfig) {
            const configDecision = this.decoderState.configure(headers.videoConfig);
            if (configDecision.action === 'configure') {
                this.onCommand({
                    type: 'configure',
                    mediaType: this.mediaType,
                    config: headers.videoConfig,
                });
            }
        }

        // 2. Establish sync reference.
        //    Audio-master: first audio sample sets the reference (ONCE).
        //    Video-only: first video CaptureTimestamp sets the reference.
        if (headers.captureTimestamp !== undefined && !this.sync.hasReference) {
            if (this.mediaType === 'audio') {
                this.sync.setAudioReference(headers.captureTimestamp);
            } else if (this._videoOnly) {
                this.sync.setVideoReference(headers.captureTimestamp);
            }
        }

        // 3. Compute render time.
        //    Returns null when no reference — CommandDispatcher holds the frame.
        let renderTimeUs: number;
        if (headers.captureTimestamp !== undefined) {
            const timing = this.mediaType === 'video'
                ? this.sync.computeVideoRenderTime(headers.captureTimestamp)
                : this.sync.computeAudioRenderTime(headers.captureTimestamp);

            if (timing === null) {
                // No reference yet — use placeholder. CommandDispatcher will
                // hold this frame and recompute when the reference is ready.
                renderTimeUs = 0;
            } else if (timing.shouldDrop) {
                if (timing.offsetUs < -5_000_000) {
                    renderTimeUs = this.clock.now();
                } else {
                    return; // Genuinely late — skip
                }
            } else if (timing.offsetUs > 5_000_000) {
                renderTimeUs = this.clock.now();
            } else {
                renderTimeUs = timing.renderTimeUs;
            }
        } else {
            renderTimeUs = this.clock.now();
        }

        // 3b. Evaluate live catch-up from CaptureTimestamp
        // @see draft-ietf-moq-loc-01 §2.3.1.1 (latency measurement)
        // @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
        if (headers.captureTimestamp !== undefined) {
            const catchUp = this.sync.evaluateCatchUp(headers.captureTimestamp);
            if (catchUp !== null && catchUp.currentRate !== this._lastEmittedRate) {
                this._lastEmittedRate = catchUp.currentRate;
                this.onEvent({ type: 'catch_up_changed', state: catchUp });
                this.onCommand({ type: 'set_playback_rate', rate: catchUp.currentRate });
            }
        }

        // 4. Create chunk init and feed through decoder FSM
        if (this.mediaType === 'video') {
            // Infer keyframe from group structure when VideoFrameMarking is absent.
            // MoQ data model: Group = GOP, objectId 0 = keyframe (LOC §4.2).
            // Some publishers omit VideoFrameMarking — fall back to position.
            const marking = headers.videoFrameMarking
                ?? (obj.objectId === 0n
                    ? { independent: true, startOfFrame: true, endOfFrame: true,
                        discardable: false, baseLayerSync: false, temporalId: 0 }
                    : undefined);
            // Keyframe payload validation: verify bitstream actually starts with a keyframe
            // when the LOC header claims independent. Catches broken publishers.
            // Only check payloads > 5 bytes (too short = can't determine).
            // @see draft-ietf-moq-loc-01 §4.2
            if (marking?.independent && this._videoCodec && obj.payload.length > 5) {
                const isKeyframe = isKeyframePayload(this._videoCodec, obj.payload);
                if (isKeyframe === false) {
                    this.onEvent({
                        type: 'keyframe_validation_failed',
                        groupId: obj.groupId,
                        objectId: obj.objectId,
                        codec: this._videoCodec,
                    });
                }
            }

            const headersWithMarking = marking !== undefined
                ? { ...headers, videoFrameMarking: marking }
                : headers;
            const chunk = toVideoChunkInit(obj.payload, headersWithMarking);
            const prevState = this.decoderState.state;
            const decision = this.decoderState.processVideoChunk(chunk, marking);

            // Detect live join: NEEDS_KEYFRAME → DECODING (first keyframe decoded)
            // Apply video join re-anchor to prevent startup stutter.
            if (prevState === 'needs_keyframe' && this.decoderState.state === 'decoding'
                && headers.captureTimestamp !== undefined) {
                this.sync.onVideoJoin(headers.captureTimestamp);
                // Recompute render time with the offset applied
                const recomputed = this.sync.computeVideoRenderTime(headers.captureTimestamp);
                if (recomputed) {
                    renderTimeUs = recomputed.renderTimeUs;
                }
            }

            if (decision.action === 'decode') {
                this.onCommand({
                    type: 'decode_video',
                    chunk: decision.chunk as typeof chunk,
                    renderTimeUs,
                    ...(headers.captureTimestamp !== undefined
                        ? { captureTimestampUs: headers.captureTimestamp }
                        : {}),
                });
            } else if (decision.action === 'skip') {
                // Emit keyframe_waiting once per group (avoid per-object spam)
                if (decision.reason === 'waiting for keyframe' && obj.groupId !== this.lastKeyframeWaitingGroupId) {
                    this.lastKeyframeWaitingGroupId = obj.groupId;
                    this.onEvent({ type: 'keyframe_waiting', groupId: obj.groupId });
                }
            }
        } else {
            const chunk = toAudioChunkInit(obj.payload, headers);
            const decision = this.decoderState.processAudioChunk(chunk);

            if (decision.action === 'decode') {
                this.onCommand({
                    type: 'decode_audio',
                    chunk: decision.chunk as typeof chunk,
                    renderTimeUs,
                });
            }
        }
    }

    private emitFsmDecision(decision: { action: string; reason?: string }): void {
        if (decision.action === 'reset') {
            this.onCommand({
                type: 'reset',
                mediaType: this.mediaType,
                reason: (decision as any).reason ?? 'gap',
            });
        } else if (decision.action === 'flush') {
            this.onCommand({
                type: 'flush',
                mediaType: this.mediaType,
            });
        }
    }

    private discardBefore(groupId: bigint): void {
        // Remove from buffer
        this.buffer.discardBefore(groupId);

        // Clean up group counts and headers for removed groups
        for (const [gid] of this.bufferedGroupCounts) {
            if (gid < groupId) {
                this.bufferedGroupCounts.delete(gid);
            }
        }

        // Clean up headers for discarded objects
        for (const [key] of this.headerMap) {
            const colonIdx = key.indexOf(':');
            const gid = BigInt(key.slice(0, colonIdx));
            if (gid < groupId) {
                this.headerMap.delete(key);
            }
        }
    }

    private decrementGroupCount(groupId: bigint): void {
        const count = this.bufferedGroupCounts.get(groupId);
        if (count !== undefined) {
            if (count <= 1) {
                this.bufferedGroupCounts.delete(groupId);
            } else {
                this.bufferedGroupCounts.set(groupId, count - 1);
            }
        }
    }
}
