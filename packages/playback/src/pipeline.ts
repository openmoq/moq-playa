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

import type { MoqtObject, MoqtObjectData } from '@openmoq/transport';
import { ObjectStatus } from '@openmoq/transport';
import type { LocHeaders, VideoFrameMarking, VideoChunkInit, AudioChunkInit } from '@openmoq/loc';
import { toVideoChunkInit, toAudioChunkInit } from '@openmoq/loc';

import { isKeyframePayload } from './keyframe-validator.js';
import { JitterBuffer } from './jitter-buffer.js';
import { GapDetector, GapAction } from './gap-detector.js';
import { DecoderStateMachine } from './decoder-state.js';
import { SyncController } from './sync.js';
import { AdaptiveToleranceController, DEFAULT_TOLERANCE_CONFIG } from './adaptive-tolerance.js';
import type { RecoveryController } from './recovery.js';
import { PipelineInputs } from './pipeline-inputs.js';
import type { PlaybackInputObserver, PlaybackInputDiscardReason, PlaybackSample } from './types.js';
import type { ClockSource, DecoderCommand, PlaybackEvent, PlaybackConfig, DecoderFeedback, AudioTimingSource, VideoTimingSource, AudioRenderTiming, VideoRenderTiming } from './types.js';

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
    /** Prospective downstream cushion for shared-clock audio admission only. */
    readonly getAudioPlayoutDelayUs?: () => number;
    /** Video-only mode: set video reference from first CaptureTimestamp. */
    readonly videoOnly?: boolean;
    /** Live stream: enables bounded release + backlog shedding. Default: true. */
    readonly isLive?: boolean;
    /** Total pending logical samples across optional batches. Default: 1024. */
    readonly maxPendingSamples?: number;
    /** Sum of retained backing-byte charges for optional batches. Default: 8 MiB. */
    readonly maxPendingSampleBytes?: number;
}

interface SampleBatch {
    readonly wireObject: MoqtObjectData;
    readonly samples: (PlaybackSample | undefined)[];
    cursor: number;
    processing: boolean;
    inputs: PipelineInputs | undefined;
    input: object | undefined;
    discardReported: boolean;
    readonly backfill: boolean;
    readonly allowIndependentGap: boolean;
    byteCharge: number;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sharedByteLength = typeof SharedArrayBuffer === 'undefined' ? undefined
    : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get!;

/** Charge each distinct backing once per batch, even for small/overlapping views. */
function sampleBatchByteCharge(obj: MoqtObjectData, samples: readonly PlaybackSample[], limit: number): number | undefined {
    const buffers = new Set<ArrayBufferLike>();
    const retain = (bytes: Uint8Array | undefined) => {
        if (bytes === undefined) return;
        if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected sample byte view');
        buffers.add(typedBuffer.call(bytes) as ArrayBufferLike);
    };
    retain(obj.payload);
    retain(obj.extensions);
    for (const sample of samples) {
        retain(sample.chunk.data);
        retain(sample.headers.videoConfig);
        retain(sample.headers.audioConfig);
        if (sample.headers.unknown) for (const value of sample.headers.unknown.values()) {
            if (typeof value !== 'bigint') retain(value);
        }
    }
    // All callback-bearing record reads precede the intrinsic size reads.
    let total = 0;
    for (const buffer of buffers) {
        let length: number;
        try { length = bufferByteLength.call(buffer); }
        catch {
            if (!sharedByteLength) throw new TypeError('Invalid sample backing');
            length = sharedByteLength.call(buffer);
        }
        if (length > limit - total) return undefined;
        total += length;
    }
    return total;
}

/** Read host accessors once before admission; bytes remain borrowed immutable. */
function snapshotSample(value: PlaybackSample, index: number, mediaType: 'video' | 'audio'): PlaybackSample {
    const { sampleIndex, headers: rawHeaders, chunk: rawChunk } = value;
    if (sampleIndex !== index) throw new RangeError('Sample indexes must be 0..length-1');
    if (!rawHeaders || typeof rawHeaders !== 'object' || !rawChunk || typeof rawChunk !== 'object') throw new TypeError('Expected sample headers and chunk');
    const headers = { ...rawHeaders };
    if (headers.videoFrameMarking) headers.videoFrameMarking = Object.freeze({ ...headers.videoFrameMarking });
    if (headers.audioLevel) headers.audioLevel = Object.freeze({ ...headers.audioLevel });
    if (headers.unknown) headers.unknown = new Map(headers.unknown);
    const { type, timestamp, duration, data, sourceTimestamp: rawSource } = rawChunk;
    if ((type !== 'key' && type !== 'delta') || (mediaType === 'audio' && type !== 'key')
        || !Number.isFinite(timestamp) || !(data instanceof Uint8Array) || typedByteLength.call(data) === 0
        || (duration !== undefined && (!Number.isFinite(duration) || duration < 0))) {
        throw new TypeError('Invalid coded sample');
    }
    if (headers.captureTimestamp !== undefined && typeof headers.captureTimestamp !== 'bigint') throw new TypeError('Invalid sample time');
    if ((headers.videoConfig !== undefined && !(headers.videoConfig instanceof Uint8Array))
        || (headers.audioConfig !== undefined && !(headers.audioConfig instanceof Uint8Array))
        || (headers.timestampIsWallClock !== undefined && typeof headers.timestampIsWallClock !== 'boolean')) {
        throw new TypeError('Invalid sample headers');
    }
    const marking = headers.videoFrameMarking;
    if (marking && (typeof marking.startOfFrame !== 'boolean' || typeof marking.endOfFrame !== 'boolean'
        || typeof marking.independent !== 'boolean' || typeof marking.discardable !== 'boolean'
        || typeof marking.baseLayerSync !== 'boolean' || !Number.isInteger(marking.temporalId)
        || marking.temporalId < 0 || marking.temporalId > 7)) throw new TypeError('Invalid sample marking');
    if (mediaType === 'video' && headers.videoFrameMarking
        && headers.videoFrameMarking.independent !== (type === 'key')) throw new TypeError('Conflicting sample marking');
    let sourceTimestamp;
    if (rawSource !== undefined) {
        const { ticks, ticksPerSecond, domain } = rawSource;
        if (typeof ticks !== 'bigint' || typeof ticksPerSecond !== 'bigint' || ticksPerSecond <= 0n
            || (domain !== 'media' && domain !== 'unix' && domain !== 'unknown')) throw new TypeError('Invalid sample source time');
        sourceTimestamp = Object.freeze({ ticks, ticksPerSecond, domain });
    }
    return Object.freeze({ sampleIndex, headers: Object.freeze(headers), chunk: Object.freeze({
        type, timestamp, data, ...(duration !== undefined ? { duration } : {}),
        ...(sourceTimestamp ? { sourceTimestamp } : {}),
    }) });
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
    private audioTimingSource: AudioTimingSource;
    private videoTimingSource: VideoTimingSource;
    private readonly onCommand: (cmd: DecoderCommand) => void;
    private readonly onEvent: (evt: PlaybackEvent) => void;
    private readonly recovery: RecoveryController | undefined;
    private readonly getAudioPlayoutDelayUs: (() => number) | undefined;

    private readonly buffer: JitterBuffer;
    private readonly gapDetector: GapDetector;
    private readonly decoderState: DecoderStateMachine;

    /** Headers stored alongside objects, keyed by "groupId:objectId". */
    private readonly headerMap = new Map<string, LocHeaders>();
    /** Allocated only for backfilled inputs; ownership follows the jitter buffer. */
    private backfillObjects: Set<string> | undefined;
    /** Absent on the ordinary LOC path. Keys are original wire G/O only. */
    private sampleBatches: Map<string, SampleBatch> | undefined;
    private pendingBatch: SampleBatch | undefined;
    private pendingSamples = 0;
    private readonly maxPendingSamples: number;
    private pendingSampleBytes = 0;
    private readonly maxPendingSampleBytes: number;
    /** One-shot startup cursor retained until its admitted carrier is extracted/discarded. */
    private initialSampleKey: string | undefined;
    private ticking = false;

    /**
     * Pending optional sample units across queued Objects and the active batch,
     * including a unit currently in a command callback. Pure observation: zero
     * means this seam has no encoded suffix awaiting tick/native feedback. The
     * host must wait for zero before native flush; it is not output readiness.
     * Ordinary LOC Objects remain governed by the existing jitter-buffer policy.
     */
    get pendingSampleCount(): number { return this.pendingSamples; }

    /**
     * Retained backing-byte charges of queued/active optional batches. Shared
     * backing is charged once within each batch, conservatively again across
     * batches; no partial-unit refund. This is not native/output readiness.
     */
    get pendingSampleByteCount(): number { return this.pendingSampleBytes; }

    private _lateAudioHandler: ((offsetUs: number, object: MoqtObjectData) => boolean) | undefined;
    /** For original-timeline, non-backfill audio, receives negative lateness
     * past the output cushion, or zero for an on-time frame, and the borrowed wire Object.
     * Do not mutate the Object. A thrown handler discards the frame as decoder policy.
     * Return true after moving the shared clock to retry admission. Omission preserves dropping.
     * Assignment replaces the handler; undefined removes it. Non-functions throw TypeError. */
    get lateAudioHandler(): ((offsetUs: number, object: MoqtObjectData) => boolean) | undefined { return this._lateAudioHandler; }
    set lateAudioHandler(handler: ((offsetUs: number, object: MoqtObjectData) => boolean) | undefined) {
        if (handler !== undefined && typeof handler !== 'function') throw new TypeError('Expected a late audio handler');
        this._lateAudioHandler = handler;
    }

    private inputState: PipelineInputs | undefined;
    private playbackRevision = 0;
    /** Refused diagnostic associations, not rejected media or missing Objects. */
    get inputEvidenceLossCount(): number { return this.inputState?.lossCount ?? 0; }
    /**
     * Each assignment begins a new evidence lifetime without changing buffered
     * media. Ending observation forgets buffered identities without inventing
     * media discards; a successor observes only newly admitted identities.
     */
    get inputObserver(): PlaybackInputObserver | undefined { return this.inputState?.observer; }
    set inputObserver(observer: PlaybackInputObserver | undefined) {
        if (observer !== undefined && typeof observer !== 'function') throw new TypeError('Expected a pipeline input observer');
        this.inputState?.clear();
        if (this.pendingBatch) {
            this.pendingBatch.inputs = undefined;
            this.pendingBatch.input = undefined;
        }
        if (!observer) { this.inputState = undefined; return; }
        let state: PipelineInputs;
        state = new PipelineInputs(observer, () => this.inputState === state);
        this.inputState = state;
    }

    /** Group reference counts for queued and extracted unfinished wire Objects. */
    private readonly bufferedGroupCounts = new Map<bigint, number>();

    /** Next expected objectId within the current group for contiguity check. */
    private nextExpectedObjectId = 0n;

    /** Highest group from which at least one object was consumed. -1n = nothing consumed yet. */
    private lastConsumedGroupId = -1n;

    /** Groups for which END_OF_GROUP has been observed. */
    private readonly endedGroups = new Set<bigint>();

    /** Timestamp when we first started waiting for active group completion. */
    private activeGroupWaitStartUs: number | null = null;

    /** One missing LOC dependency; unrelated arrivals cannot renew its deadline. */
    private objectWait: { groupId: bigint; objectId: bigint; sinceUs: number } | undefined;
    /** Earliest locally discarded Object, retained only for queued/active Groups. */
    private readonly locallyDroppedObjects = new Map<bigint, bigint>();

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
    private trackEndHolds = 0;

    /** Terminal delivery is draining, or EOT has been observed; absence of new frames is not a live stall. */
    get isEnding(): boolean { return this.trackEndHolds > 0 || this.gapDetector.isTrackEnded || this._trackEnded; }

    /** A known terminal delivery window may still supply media below the EOT boundary. Reset retires the hold. */
    holdTrackEnd(): (completeTrack?: boolean) => void {
        const revision = this.playbackRevision;
        this.trackEndHolds++;
        let released = false;
        return (completeTrack = false) => {
            if (released) return;
            released = true;
            if (this.playbackRevision === revision) {
                this.trackEndHolds--;
                // Application-level completion after a publisher's TRACK_ENDED drain. No Object Location is invented.
                if (completeTrack) this.gapDetector.observeEndOfTrack();
            }
        };
    }

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

    /** Max LOC Objects or explicit samples per tick (video only). 0 = unlimited. */
    private readonly maxReleasePerTick: number;
    /** Max groups before shedding old ones. 0 = unlimited. */
    private readonly maxBacklogGroups: number;

    /** Video codec string from catalog (e.g., 'avc1.42c01f'). Used for keyframe validation. */
    private _videoCodec: string | undefined;
    private _videoOnly: boolean;

    constructor(opts: PipelineOptions) {
        const getAudioPlayoutDelayUs = opts.getAudioPlayoutDelayUs;
        if (getAudioPlayoutDelayUs !== undefined && typeof getAudioPlayoutDelayUs !== 'function') {
            throw new TypeError('Expected an audio playout delay query');
        }
        this.getAudioPlayoutDelayUs = getAudioPlayoutDelayUs;
        const maxPendingSamples = opts.maxPendingSamples ?? 1024;
        if (!Number.isSafeInteger(maxPendingSamples) || maxPendingSamples <= 0) throw new RangeError('maxPendingSamples must be a positive safe integer');
        this.maxPendingSamples = maxPendingSamples;
        const maxPendingSampleBytes = opts.maxPendingSampleBytes ?? 8 * 1024 * 1024;
        if (!Number.isSafeInteger(maxPendingSampleBytes) || maxPendingSampleBytes <= 0) throw new RangeError('maxPendingSampleBytes must be a positive safe integer');
        this.maxPendingSampleBytes = maxPendingSampleBytes;
        this.mediaType = opts.mediaType;
        this.clock = opts.clock;
        this.sync = opts.sync;
        this.audioTimingSource = opts.sync;
        this.videoTimingSource = opts.sync;
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
     * Install engine-owned audio timing without changing raw decoder timestamps.
     * A provider distinct from shared sync uses a mapped source domain, so it
     * cannot control the shared reference, capture age, catch-up or drift
     * threshold. Undefined restores the original timeline. The engine owns mapping composition and
     * must drain or retire buffered inputs before replacing this provider.
     * Emitted commands retain their already captured absolute render times.
     */
    setAudioTimingSource(source: AudioTimingSource | undefined): void {
        if (this.mediaType !== 'audio') throw new Error('Audio timing requires an audio pipeline');
        const next = source ?? this.sync;
        if (next === this.audioTimingSource) return;
        this.audioTimingSource = next;
        // Transit differences cancel one epoch, not a transition between epochs.
        this.adaptiveTolerance?.reset();
    }

    /**
     * Install engine-owned video timing without changing source metadata or shared
     * sync control. The engine must retire buffered old inputs before replacement.
     * Each emitted mapped decode retains its producing provider for native output.
     * Undefined restores the ordinary shared timeline.
     */
    setVideoTimingSource(source: VideoTimingSource | undefined): void {
        if (this.mediaType !== 'video') throw new Error('Video timing requires a video pipeline');
        const next = source ?? this.sync;
        if (next === this.videoTimingSource) return;
        this.videoTimingSource = next;
        this.adaptiveTolerance?.reset();
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

    /** Earliest group admitted after reset, retirement or buffer shedding. */
    get minimumAcceptedGroupId(): bigint {
        return this.minAcceptGroupId;
    }

    /** Distinct Groups with queued Objects or an unfinished sample cursor. */
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
                // PRESENTATION SCHEDULE drift: actual minus the exact time this
                // frame was queued to present. Both are on the SAME local clock,
                // so the old PTS-era guards no longer apply and are deliberately
                // gone: a capture timestamp is not required, an active video-join
                // offset is already represented in the schedule, and there is no
                // cross-epoch case to hide.
                //
                // Without a schedule the whole measurement/event transaction is
                // suppressed — returning BEFORE reading drift, so a stale value
                // from an earlier frame cannot be re-emitted as a new event.
                if (fb.scheduledRenderUs !== undefined) {
                    this.sync.reportPresentationTiming(fb.scheduledRenderUs, fb.actualRenderUs);
                    const drift = this.sync.currentDriftUs;
                    if (this.sync.presentationDriftExceeded) {
                        this.onEvent({ type: 'sync_drift', driftUs: drift });
                    }
                }
                break;

            case 'audio_timing_unavailable':
                // A refused producing/output context is not a native decoder
                // failure and must not reset its FSM or trigger fatal recovery.
                break;

            case 'flush_complete':
                // No-op — included for forward compatibility (quality switch gating).
                break;
        }
    }

    /**
 * Provide codec configuration (from catalog or initial headers).
 *
 * This is also triggered automatically when a LOC object carries the
 * matching config property: Video Config for video, Audio Config for
 * audio.
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
 * @param delivery Backfilled objects are excluded from arrival-jitter estimation.
 */
    pushObject(obj: MoqtObject, headers?: LocHeaders, input?: object, delivery?: { readonly backfill?: boolean }): void {
        this.admitObject(obj, headers, input, delivery);
    }

    /**
     * Optional host-parsed batch on the original wire Object. Invalid records
     * throw before ownership/admission; capacity refusal reports 'buffer full'
     * and returns void. A refused suffix cannot establish host readiness.
     * One receipt/token follows the Object, shared by its decode commands;
     * discarding any untransferred suffix reports that receipt at most once.
     * The host must keep the wire Object, borrowed bytes and their backing sizes
     * immutable until consumed/discarded. Distinct backing buffers of the Object
     * payload/extensions and sample data/config/unknown headers are charged once
     * per batch, held through final retirement, and bounded across this pipeline.
     * An empty batch advances wire contiguity without media readiness or sync.
     * allowIndependentGap is host permission for parsed container input to resume
     * at an independently coded first sample, never a claim about metadata fullness.
     */
    pushSampleObject(obj: MoqtObjectData, samples: readonly PlaybackSample[], input?: object, delivery?: { readonly backfill?: boolean; readonly allowIndependentGap?: boolean }): void {
        const revision = this.playbackRevision, inputs = this.inputState;
        const backfill = delivery?.backfill === true, requestedRecovery = delivery?.allowIndependentGap === true;
        if (obj.kind !== 'data' || !Array.isArray(samples)) throw new TypeError('Expected wire DATA and sample array');
        const length = samples.length;
        if (length > this.maxPendingSamples) {
            if (revision === this.playbackRevision && inputs === this.inputState) inputs?.report(input, 'buffer full');
            return;
        }
        const snapshot: PlaybackSample[] = [];
        for (let i = 0; i < length; i++) snapshot.push(snapshotSample(samples[i]!, i, this.mediaType));
        const byteCharge = sampleBatchByteCharge(obj, snapshot, this.maxPendingSampleBytes);
        // Host getters may reset/reassign the pipeline while snapshotting.
        if (revision !== this.playbackRevision) return;
        if (byteCharge === undefined) { if (inputs === this.inputState) inputs?.report(input, 'buffer full'); return; }
        const first = snapshot[0];
        // Container framing is host-owned. Do not reinterpret parsed sample
        // bytes as four-byte-length AVC here; independence was established
        // against the container's actual codec configuration.
        const allowIndependentGap = requestedRecovery && this.mediaType === 'video' && first?.chunk.type === 'key';
        if (revision !== this.playbackRevision) return;
        this.admitObject(obj, undefined, inputs === this.inputState ? input : undefined,
            { backfill, allowIndependentGap }, snapshot, byteCharge);
    }

    private admitObject(obj: MoqtObject, headers?: LocHeaders, input?: object, delivery?: { readonly backfill?: boolean; readonly allowIndependentGap?: boolean }, samples?: PlaybackSample[], byteCharge = 0): void {
        const inputs = this.inputState;
        const token = inputs ? input : undefined;
        if (obj.kind === 'gap') {
            // Gap signals — notify gap detector
            if (obj.status === ObjectStatus.END_OF_GROUP) {
                this.endGroup(obj.groupId);
            } else if (obj.status === ObjectStatus.END_OF_TRACK) {
                this.gapDetector.observeEndOfTrack();
            }
            return;
        }

        // Reject stale objects: both from before skip/reset targets AND
        // from groups already consumed during normal forward progress.
        // Late-arriving old groups from QUIC reordering can poison decode
        // order and cause blockiness.
        if (obj.groupId < this.minAcceptGroupId) { inputs?.report(token, 'stale group'); return; }
        if (this.lastConsumedGroupId >= 0n && obj.groupId < this.lastConsumedGroupId) { inputs?.report(token, 'stale group'); return; }
        if (this.pendingBatch && obj.groupId < this.pendingBatch.wireObject.groupId) { inputs?.report(token, 'stale group'); return; }
        const initialObject = this.initialSampleKey === undefined ? undefined : this.sampleBatches?.get(this.initialSampleKey)?.wireObject;
        if (initialObject && obj.groupId < initialObject.groupId) { inputs?.report(token, 'stale group'); return; }
        if (initialObject && obj.groupId === initialObject.groupId && obj.objectId < initialObject.objectId) { inputs?.report(token, 'treated as a replay'); return; }
        // Reject already-consumed objects from the current group.
        if (obj.groupId === this.lastConsumedGroupId && obj.objectId < this.nextExpectedObjectId) { inputs?.report(token, 'treated as a replay'); return; }

        // Dedup: reject if this (groupId, objectId) is already buffered.
        const key = `${obj.groupId}:${obj.objectId}`;
        if (this.headerMap.has(key) || (this.pendingBatch?.wireObject.groupId === obj.groupId
            && this.pendingBatch.wireObject.objectId === obj.objectId)) { inputs?.report(token, 'treated as a replay'); return; }
        if (samples && samples.length > this.maxPendingSamples - this.pendingSamples) { inputs?.report(token, 'buffer full'); return; }
        if (samples && byteCharge > this.maxPendingSampleBytes - this.pendingSampleBytes) { inputs?.report(token, 'buffer full'); return; }

        let discarded: object[] | undefined, refused = false;
        // Data object — try to buffer it
        if (this.buffer.insert(obj)) {
            this.headerMap.set(key, headers ?? {});
            inputs?.remember(key, token);
            const count = this.bufferedGroupCounts.get(obj.groupId) ?? 0;
            this.bufferedGroupCounts.set(obj.groupId, count + 1);
        } else if (obj.publisherPriority !== undefined) {
            // Buffer full — try priority-aware eviction (§7)
            if (inputs) discarded = [];
            refused = !this.tryEvictAndInsert(obj, headers, inputs, token, discarded);
        } else {
            refused = true;
        }

        // Install before clock/recovery/discard callbacks can drain or reset it.
        if (!refused && samples) {
            (this.sampleBatches ??= new Map()).set(key, {
                wireObject: obj, samples, cursor: 0, processing: false, inputs: undefined, input: undefined, discardReported: false,
                backfill: delivery?.backfill === true, allowIndependentGap: delivery?.allowIndependentGap === true,
                byteCharge,
            });
            this.pendingSamples += samples.length;
            this.pendingSampleBytes += byteCharge;
        }

        if (!refused && delivery?.backfill && this.headerMap.has(key)) {
            (this.backfillObjects ??= new Set()).add(key);
        }

        if (refused) this.rememberDroppedObject(obj);
        else if (this.locallyDroppedObjects.get(obj.groupId) === obj.objectId) {
            this.locallyDroppedObjects.delete(obj.groupId);
        }
        this.pruneDroppedObjects();

        // Interarrival jitter uses transit differences, so the timestamp epoch
        // cancels out. Media time is suitable here, but not for latency/catch-up.
        if (this.adaptiveTolerance && headers?.captureTimestamp !== undefined && delivery?.backfill !== true) {
            const nowMs = this.clock.now() / 1000; // µs → ms
            const captureUs = Number(headers.captureTimestamp);
            this.adaptiveTolerance.onFrameArrived(nowMs, captureUs, nowMs);
        }

        // Observe group for gap timeout tracking
        this.gapDetector.observeGroup(obj.groupId);
        inputs?.reportAll(discarded, 'buffer eviction');
        if (refused) {
            try {
                if (this.recovery) {
                    const revision = this.playbackRevision;
                    const action = this.recovery.evaluate({ type: 'buffer_overflow' });
                    if (revision === this.playbackRevision) this.onEvent({ type: 'recovery', action });
                }
            } finally { inputs?.report(token, 'buffer full'); }
        }
    }

    /** Caller-established Group closure, without inventing a wire Object Location. */
    endGroup(groupId: bigint): void {
        this.gapDetector.observeEndOfGroup(groupId);
        this.endedGroups.add(groupId);
        if (groupId === this.lastConsumedGroupId) this.activeGroupWaitStartUs = null;
    }

    /** Intake has settled: close observed groups without releasing TrackEnd holds. */
    endBufferedGroups(): void {
        // A discarded Group may have an empty object cursor too. Use actual
        // input observation to distinguish it from a reset's synthetic cursor.
        if (this.lastConsumedGroupId >= 0n && this.gapDetector.hasObservedGroup(this.lastConsumedGroupId)) {
            this.endGroup(this.lastConsumedGroupId);
        }
        for (const groupId of this.bufferedGroupCounts.keys()) this.endGroup(groupId);
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
 * Start a different track: clear old encoded inputs and group tracking,
 * then reset the decoder gate while retaining its codec configuration.
 * Video waits for an independent frame; audio may decode immediately,
 * including after the previous track ended. The shared clock is retained.
 *
 * @param firstGroupId The first group ID from the new track — sets
 *   lastConsumedGroupId to firstGroupId-1 so the gap detector doesn't
 *   see a gap and trigger skip_forward (which would reset sync).
 */
    resetForTrackSwitch(firstGroupId: bigint): void {
        this.playbackRevision++;
        this.trackEndHolds = 0;
        this._trackEnded = false;
        const inputs = this.inputState, dropped = inputs?.clear();
        // Clear the jitter buffer — old-track encoded objects must not
        // survive into the new decoder configuration. Without this,
        // stale P-frames from the old track drain under the new codec
        // and produce decode errors.
        const pending = this.pendingBatch;
        const pendingInput = pending?.inputs === inputs && !pending?.discardReported ? pending?.input : undefined;
        if (pendingInput) dropped?.push(pendingInput);
        this.clearSampleBatches();
        this.buffer.clear();
        this.headerMap.clear();
        this.backfillObjects = undefined;
        this.bufferedGroupCounts.clear();
        this.lastConsumedGroupId = firstGroupId - 1n;
        this.endedGroups.add(this.lastConsumedGroupId);
        this.nextExpectedObjectId = 0n;
        this.minAcceptGroupId = firstGroupId;
        this.lastKeyframeWaitingGroupId = -1n;
        if (this.mediaType === 'video') this.resetPending = true;
        this._throttled = false;
        this.activeGroupWaitStartUs = null;
        this.objectWait = undefined;
        this.locallyDroppedObjects.clear();
        this.gapDetector.reset();
        // Force decoder back to NEEDS_KEYFRAME so partial-group deltas
        // from a mid-stream subscription are skipped, not decoded.
        const decision = this.decoderState.notifyTrackSwitch();
        try { this.emitFsmDecision(decision); }
        finally { inputs?.reportAll(dropped, 'track superseded'); }
    }

    reset(targetGroupId?: bigint): void {
        this.playbackRevision++;
        const inputs = this.inputState, dropped = inputs?.clear();
        const pending = this.pendingBatch;
        const pendingInput = pending?.inputs === inputs && !pending?.discardReported ? pending?.input : undefined;
        if (pendingInput) dropped?.push(pendingInput);
        this.clearSampleBatches();
        this.buffer.clear();
        this.headerMap.clear();
        this.backfillObjects = undefined;
        this.bufferedGroupCounts.clear();
        this.lastConsumedGroupId = -1n;
        this.nextExpectedObjectId = 0n;
        this.minAcceptGroupId = targetGroupId ?? -1n;
        this.lastKeyframeWaitingGroupId = -1n;
        this.resetPending = true;
        this._throttled = false;
        this._trackEnded = false;
        this.trackEndHolds = 0;
        this.endedGroups.clear();
        this.activeGroupWaitStartUs = null;
        this.objectWait = undefined;
        this.locallyDroppedObjects.clear();
        this.gapDetector.reset();
        this.adaptiveTolerance?.reset();
        const decision = this.decoderState.notifyGap();
        try { this.emitFsmDecision(decision); }
        finally { inputs?.reportAll(dropped, 'decoder reset'); }
    }

    /**
 * Process buffered objects: evaluate gaps, feed decoder FSM, emit commands.
 *
 * Call this on a regular interval (e.g., requestAnimationFrame or timer).
 */
    tick(): void {
        if (this.ticking) return;
        this.ticking = true;
        try { this.tickInternal(); } finally { this.ticking = false; }
    }

    private tickInternal(): void {
        const revision = this.playbackRevision;
        let released = 0;
        const budget = this.maxReleasePerTick;
        // An extracted wire Object still owns its undecoded suffix. Neither a
        // gap timeout, backlog shedding nor TrackEnd may overtake those units.
        if (this.pendingBatch) {
            released = this.drainPendingBatch(budget);
            if (revision !== this.playbackRevision || this.pendingBatch || this._throttled) return;
            if (budget > 0 && released >= budget) return;
        }
        // Update adaptive tolerance → push auto-calibrated thresholds to gap detector and sync
        if (this.adaptiveTolerance) {
            const nowMs = this.clock.now() / 1000;
            this.adaptiveTolerance.tick(nowMs);
            this.gapDetector.gapTimeoutUs = this.adaptiveTolerance.effectiveGapTimeoutMs * 1000;
            if (this.audioTimingSource === this.sync && this.videoTimingSource === this.sync) {
                this.sync.driftThresholdUs = this.adaptiveTolerance.effectiveDriftThresholdMs * 1000;
            }
        }

        // One initial batch can establish the actual wire cursor. Its full
        // sample list still passes the decoder's keyframe gate. Ordinary LOC
        // retains the Object0 startup rule; later groups/gaps retain theirs too.
        if (this.resetPending && this.buffer.size > 0) {
            const top = this.buffer.peek()!;
            const initialBatch = this.sampleBatches?.has(`${top.groupId}:${top.objectId}`) === true;
            if (!initialBatch && top.objectId !== 0n) {
                if (this.mediaType === 'audio') {
                    this.buffer.extract();
                    this.decrementGroupCount(top.groupId);
                    const key = `${top.groupId}:${top.objectId}`; this.forgetHeaders(key);
                    this.inputState?.report(this.inputState.take(key), 'awaiting keyframe');
                    return;
                }
                // LOC §4.3 orders Objects across subgroup streams. A delta
                // arriving before Object0 does not establish that RAP's loss.
                const wait = this.waitForVideoObject(top, 0n, revision);
                if (wait === 'expired') this.abandonVideoGroup(top.groupId);
                return;
            }
            this.objectWait = undefined;
            this.lastConsumedGroupId = top.groupId - 1n;
            this.endedGroups.add(this.lastConsumedGroupId);
            if (initialBatch) {
                this.initialSampleKey = `${top.groupId}:${top.objectId}`;
                this.nextExpectedObjectId = top.objectId;
            }
            this.resetPending = false;
        }

        // 1. Evaluate gap state
        const availableGroupIds = [...this.bufferedGroupCounts.keys()];
        const gapDecision = this.gapDetector.evaluate(this.lastConsumedGroupId, availableGroupIds);
        if (revision !== this.playbackRevision) return;

        // 2. Handle gap decision
        if (gapDecision.action === GapAction.TRACK_ENDED && this.buffer.size === 0 && !this.pendingBatch) {
            if (this.trackEndHolds > 0) return;
            if (!this._trackEnded) {
                this._trackEnded = true;
                const decision = this.decoderState.notifyTrackEnded();
                this.emitFsmDecision(decision);
                if (revision !== this.playbackRevision) return;
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
                if (revision !== this.playbackRevision) return;
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
            if (revision !== this.playbackRevision) return;

            // Notify recovery controller for potential escalation
            if (this.recovery) {
                const action = this.recovery.evaluate({ type: 'gap', groupId: target });
                if (revision !== this.playbackRevision) return;
                this.onEvent({ type: 'recovery', action });
                if (revision !== this.playbackRevision) return;
            }

            // Reject future pushObject() calls for groups before the target
            this.minAcceptGroupId = target;

            // Discard old groups from buffer
            this.discardBefore(target);
            if (revision !== this.playbackRevision) return;

            // NOTE: Sync reset is NOT done here. When two pipelines (audio + video)
            // share a SyncController, both would call reset() during skip_forward,
            // causing a double-reset: audio resets → re-establishes reference →
            // video resets → wipes reference. The caller (MoqtPlayer) coordinates
            // sync reset via handlePipelineEvent, resetting once per tick cycle.

            // Notify decoder of gap
            const decision = this.decoderState.notifyGap();
            this.emitFsmDecision(decision);
            if (revision !== this.playbackRevision) return;

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
            if (revision !== this.playbackRevision) return;
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
            const started = this.activeGroupWaitStartUs, groupId = this.lastConsumedGroupId;
            const front = this.buffer.peek(), now = this.clock.now();
            if (revision !== this.playbackRevision) return;
            if (started === this.activeGroupWaitStartUs && groupId === this.lastConsumedGroupId
                && front === this.buffer.peek() && !this.endedGroups.has(groupId)
                && now - started > this.gapDetector.gapTimeoutUs) {
                const nextGroupId = this.lastConsumedGroupId + 1n;
                this.onEvent({
                    type: 'partial_group_abandoned',
                    fromGroupId: this.lastConsumedGroupId,
                    toGroupId: nextGroupId,
                    reason: 'intra-group timeout',
                } as PlaybackEvent);
                if (revision !== this.playbackRevision) return;
                this.endedGroups.add(this.lastConsumedGroupId);
                const decision = this.decoderState.notifyGap();
                this.emitFsmDecision(decision);
                if (revision !== this.playbackRevision) return;
                this.activeGroupWaitStartUs = null;
            }
        }

        // 5. Release contiguous objects from the buffer (bounded).
        // Within a group, objects MUST be contiguous (0, 1, 2, ...) before
        // decoding. A missing objectId means a frame the decoder needs for
        // reference is absent — decoding later objects produces artifacts.
        // Cross-subgroup arrival order is not decode order (LOC §4.3).
        // Wait under the existing gap policy before abandoning a dependency.

        while (this.buffer.size > 0) {
            // Bounded release: one unit per LOC Object or explicit sample.
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
                        const groupId = this.lastConsumedGroupId, now = this.clock.now();
                        if (revision !== this.playbackRevision || groupId !== this.lastConsumedGroupId
                            || this.buffer.peek() !== top || this.endedGroups.has(groupId)) return;
                        this.activeGroupWaitStartUs = now;
                    }
                    break;
                }
            }

            const expectedObjectId = top.groupId > this.lastConsumedGroupId
                ? this.initialSampleKey === `${top.groupId}:${top.objectId}` ? top.objectId : 0n
                : this.nextExpectedObjectId;

            // A later LOC Object alone does not prove its predecessor lost.
            // Audio retains its independent per-Object release policy.
            if (this.mediaType === 'video' && top.objectId > expectedObjectId) {
                const recovery = this.resumeIndependentSample(top, revision);
                if (recovery === 'changed') return;
                if (recovery === 'ready') continue;
                const wait = this.waitForVideoObject(top, expectedObjectId, revision);
                if (wait === 'expired') this.abandonVideoGroup(top.groupId);
                break;
            }
            this.objectWait = undefined;
            if (top.groupId > this.lastConsumedGroupId) {
                this.activeGroupWaitStartUs = null;
                this.endedGroups.delete(this.lastConsumedGroupId);
                this.nextExpectedObjectId = expectedObjectId;
            }

            const obj = this.buffer.extract()!;

            if (obj.kind === 'data') {
                const batch = this.sampleBatches ? this.takeSampleBatch(`${obj.groupId}:${obj.objectId}`) : undefined;
                if (batch) {
                    const key = `${obj.groupId}:${obj.objectId}`;
                    // Extraction transfers unfinished wire ownership to the
                    // cursor; retain its Group reference until final retirement.
                    this.forgetHeaders(key);
                    batch.inputs = this.inputState;
                    batch.input = batch.inputs?.take(key);
                    this.pendingBatch = batch;
                    released += this.drainPendingBatch(budget > 0 ? budget - released : 0);
                    if (revision !== this.playbackRevision || this.pendingBatch) return;
                    continue; // The batch advances its original wire frontier once.
                }
                this.decrementGroupCount(obj.groupId);
                this.processDataObject(obj);
                if (revision !== this.playbackRevision) return;
            } else this.decrementGroupCount(obj.groupId);

            this.nextExpectedObjectId = obj.objectId + 1n;
            released++;

            // Track last consumed group
            if (obj.groupId > this.lastConsumedGroupId) {
                this.lastConsumedGroupId = obj.groupId;
            }
            this.pruneDroppedObjects();
        }
    }

    // ─── Internal ───────────────────────────────────────────────────

    /** Parsed container input may explicitly resume at an independently coded
     * carrier. Ordinary LOC never opts in; full container metadata alone is not
     * permission. Keep earlier queued media and other Groups intact. */
    private resumeIndependentSample(top: MoqtObject, revision: number): 'none' | 'ready' | 'changed' {
        const batches = this.sampleBatches;
        if (!batches) return 'none';
        let recovery: SampleBatch | undefined;
        for (const batch of batches.values()) {
            if (!batch.allowIndependentGap || batch.wireObject.groupId !== top.groupId
                || batch.wireObject.objectId < top.objectId) continue;
            if (!recovery || batch.wireObject.objectId < recovery.wireObject.objectId) recovery = batch;
        }
        if (!recovery) return 'none';
        const objectId = recovery.wireObject.objectId;
        // Publish the acceptance cursor before discard observers can reenter.
        if (top.groupId === this.lastConsumedGroupId) this.nextExpectedObjectId = objectId;
        else this.initialSampleKey = `${top.groupId}:${objectId}`;
        this.objectWait = undefined;
        const loss = this.locallyDroppedObjects.get(top.groupId);
        if (loss !== undefined && loss < objectId) this.locallyDroppedObjects.delete(top.groupId);
        const inputs = this.inputState, dropped: object[] | undefined = inputs ? [] : undefined;
        while (this.buffer.peek()?.groupId === top.groupId && this.buffer.peek()!.objectId < objectId) {
            const old = this.buffer.extract()!, key = `${old.groupId}:${old.objectId}`;
            this.forgetHeaders(key);
            this.decrementGroupCount(old.groupId);
            const input = inputs?.take(key); if (input) dropped?.push(input);
        }
        inputs?.reportAll(dropped, 'awaiting keyframe');
        return revision === this.playbackRevision ? 'ready' : 'changed';
    }

    private waitForVideoObject(top: MoqtObject, objectId: bigint, revision: number): 'waiting' | 'expired' | 'changed' {
        if (this.locallyDroppedObjects.get(top.groupId) === objectId) return 'expired';
        const now = this.clock.now();
        // An injected clock can reenter intake/reset. Do not attach old wait
        // ownership to a new playback lifetime or a newly arrived predecessor.
        if (revision !== this.playbackRevision || this.buffer.peek() !== top) return 'changed';
        const wait = this.objectWait;
        if (!wait || wait.groupId !== top.groupId || wait.objectId !== objectId) {
            this.objectWait = { groupId: top.groupId, objectId, sinceUs: now };
        }
        return now - this.objectWait!.sinceUs >= this.gapDetector.gapTimeoutUs ? 'expired' : 'waiting';
    }

    private abandonVideoGroup(groupId: bigint): void {
        // Publish the floor before reset/discard observers can reenter. A late
        // RAP cannot resurrect a Group whose dependants were abandoned.
        if (this.minAcceptGroupId <= groupId) this.minAcceptGroupId = groupId + 1n;
        this.objectWait = undefined;
        this.locallyDroppedObjects.delete(groupId);
        const inputs = this.inputState, dropped: object[] | undefined = inputs ? [] : undefined;
        while (this.buffer.peek()?.groupId === groupId) {
            const obj = this.buffer.extract()!;
            const key = `${obj.groupId}:${obj.objectId}`;
            this.forgetHeaders(key);
            const input = inputs?.take(key); if (input) dropped?.push(input);
            this.decrementGroupCount(groupId);
        }
        this.lastConsumedGroupId = groupId;
        this.nextExpectedObjectId = 0n;
        // Its local lifetime is over; the next RAP must not wait again for
        // a wire EOG from the Group we deliberately abandoned.
        this.endedGroups.add(groupId);
        this.activeGroupWaitStartUs = null;
        this.pruneDroppedObjects();
        const decision = this.decoderState.notifyGap();
        try { this.emitFsmDecision(decision); }
        finally { inputs?.reportAll(dropped, 'skipped'); }
    }

    private rememberDroppedObject(obj: MoqtObjectData): void {
        if (this.mediaType !== 'video'
            || (!this.bufferedGroupCounts.has(obj.groupId) && obj.groupId !== this.lastConsumedGroupId)) return;
        const previous = this.locallyDroppedObjects.get(obj.groupId);
        if (previous === undefined || obj.objectId < previous) this.locallyDroppedObjects.set(obj.groupId, obj.objectId);
    }

    private pruneDroppedObjects(): void {
        for (const groupId of this.locallyDroppedObjects.keys()) {
            if (groupId < this.minAcceptGroupId
                || (!this.bufferedGroupCounts.has(groupId) && groupId !== this.lastConsumedGroupId)) {
                this.locallyDroppedObjects.delete(groupId);
            }
        }
    }


    private takeSampleBatch(key: string): SampleBatch | undefined {
        const batches = this.sampleBatches, batch = batches?.get(key);
        batches?.delete(key);
        if (batches?.size === 0) this.sampleBatches = undefined;
        return batch;
    }

    private releaseBatchSamples(batch: SampleBatch): void {
        this.pendingSampleBytes -= batch.byteCharge;
        batch.byteCharge = 0;
        this.pendingSamples -= batch.samples.length - batch.cursor + (batch.processing ? 1 : 0);
        batch.processing = false;
        batch.samples.length = 0;
        batch.cursor = 0;
    }

    private clearSampleBatches(): void {
        this.initialSampleKey = undefined;
        if (this.pendingBatch) {
            this.releaseBatchSamples(this.pendingBatch);
            this.pendingBatch.input = undefined;
            this.pendingBatch.inputs = undefined;
        }
        if (this.sampleBatches) for (const batch of this.sampleBatches.values()) this.releaseBatchSamples(batch);
        this.pendingBatch = undefined;
        this.sampleBatches = undefined;
    }

    private reportBatch(batch: SampleBatch, reason: PlaybackInputDiscardReason): void {
        if (batch.discardReported) return;
        batch.discardReported = true; // Reserve notification before observer reentry.
        const input = batch.input;
        // A receipt can describe discarded AND surviving samples. Its association
        // lasts through the remaining units, independently of this notification.
        batch.inputs?.report(input, reason);
    }

    private advanceWireObject(obj: MoqtObjectData): void {
        this.decrementGroupCount(obj.groupId);
        this.nextExpectedObjectId = obj.objectId + 1n;
        if (obj.groupId > this.lastConsumedGroupId) this.lastConsumedGroupId = obj.groupId;
    }

    private drainPendingBatch(budget: number): number {
        const batch = this.pendingBatch!;
        const revision = this.playbackRevision;
        let released = 0;
        try {
            while (batch.cursor < batch.samples.length && !this._throttled && (budget === 0 || released < budget)) {
                const sample = batch.samples[batch.cursor]!;
                batch.samples[batch.cursor++] = undefined;
                batch.processing = true;
                released++;
                const inputs = batch.inputs === this.inputState ? batch.inputs : undefined;
                this.processSample(batch.wireObject, sample.headers, batch.backfill,
                    inputs, inputs ? batch.input : undefined, sample.chunk, batch);
                if (batch.processing) {
                    batch.processing = false;
                    this.pendingSamples--;
                }
                if (revision !== this.playbackRevision || this.pendingBatch !== batch) return released;
            }
        } catch (error) {
            if (revision === this.playbackRevision && this.pendingBatch === batch) {
                this.releaseBatchSamples(batch);
                this.pendingBatch = undefined;
                this.advanceWireObject(batch.wireObject);
                // An exception does not prove native admission of a keyframe.
                this.decoderState.notifyGap();
                this.reportBatch(batch, 'decoder policy');
            }
            throw error;
        }
        if (batch.cursor === batch.samples.length) {
            this.pendingBatch = undefined;
            this.releaseBatchSamples(batch);
            this.advanceWireObject(batch.wireObject);
            batch.input = undefined;
            batch.inputs = undefined;
        }
        return released;
    }

    /**
 * Drop oldest whole groups when backlog exceeds maxBacklogGroups.
 * Keeps the newest maxBacklogGroups groups, discards the rest.
 * After shedding, notifies decoder that a gap occurred (needs keyframe).
 */
    private shedBacklog(): void {
        const revision = this.playbackRevision;
        const inputs = this.inputState, dropped: object[] | undefined = inputs ? [] : undefined;
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
            if (groupId < cutoff) { this.forgetHeaders(key); const input = inputs?.take(key); if (input) dropped?.push(input); }
        }

        // Advance consumed position past shed groups
        const lastShed = groupsToShed[groupsToShed.length - 1]!;
        if (lastShed >= this.lastConsumedGroupId) {
            this.lastConsumedGroupId = lastShed;
        }
        this.minAcceptGroupId = lastShed + 1n;
        this.objectWait = undefined;
        this.pruneDroppedObjects();

        // Decoder needs a fresh keyframe after shedding
        const decision = this.decoderState.notifyGap();
        try {
            this.emitFsmDecision(decision);
            if (revision !== this.playbackRevision) return;
            this.onEvent({
                type: 'backlog_shed',
                droppedGroups: excess,
                remainingGroups: this.bufferedGroupCounts.size,
                reason: `backlog exceeded ${this.maxBacklogGroups} groups`,
            });
        } finally { inputs?.reportAll(dropped, 'backlog shed'); }
    }

    /**
 * Whether late encoded VIDEO may be discarded before it reaches the decoder.
 *
 * Only explicitly discardable, non-independent frames may be. Everything
 * else is NOT PROVEN SAFE TO DISCARD and is therefore preserved
 * conservatively: RFC 9626 §3.1 defines D=1 as the sender asserting the
 * frame can be removed while the stream stays decodable, so D=0 does not
 * prove the frame is a reference — it means the receiver has no assurance
 * that discarding it is safe. Absent marking is treated the same way, and
 * an independent frame is preserved even if it also claims to be
 * discardable.
 *
 * Lateness of decoded OUTPUT remains the output stage's decision.
 *
 * @see draft-ietf-moq-loc-01 §2.3.2.2 (Video Frame Marking)
 */
    private isPreDecodeDroppable(marking: VideoFrameMarking | undefined): boolean {
        if (marking === undefined) return false;   // unknown dependencies — keep
        if (marking.independent) return false;      // reference anchor — keep
        return marking.discardable === true;        // sender said it is safe
    }

    /**
 * Attempt to evict a lower-importance object to make room.
 * @returns true if the incoming object was inserted.
 * @see draft-ietf-moq-transport-16 §7 (Priority-based dropping)
 */
    private tryEvictAndInsert(obj: MoqtObjectData, headers?: LocHeaders, inputs?: PipelineInputs, token?: object, dropped?: object[]): boolean {
        const evicted = this.buffer.evictLowestImportance();
        if (!evicted) return false; // No evictable candidate

        if (evicted.publisherPriority! > obj.publisherPriority!) {
            // Evicted is less important — insert incoming
            this.decrementGroupCount(evicted.groupId);
            const evictedKey = `${evicted.groupId}:${evicted.objectId}`;
            this.forgetHeaders(evictedKey);
            const evictedInput = inputs?.take(evictedKey); if (evictedInput) dropped?.push(evictedInput);

            this.buffer.insert(obj);
            const key = `${obj.groupId}:${obj.objectId}`;
            this.headerMap.set(key, headers ?? {});
            inputs?.remember(key, token);
            const count = this.bufferedGroupCounts.get(obj.groupId) ?? 0;
            this.bufferedGroupCounts.set(obj.groupId, count + 1);
            this.rememberDroppedObject(evicted);
            return true;
        } else {
            // Evicted is equally or more important — put it back, drop incoming
            this.buffer.insert(evicted);
            return false;
        }
    }

    private forgetHeaders(key: string): void {
        if (this.initialSampleKey === key) this.initialSampleKey = undefined;
        this.headerMap.delete(key);
        const batch = this.takeSampleBatch(key);
        if (batch) this.releaseBatchSamples(batch);
        const backfill = this.backfillObjects;
        backfill?.delete(key);
        if (backfill?.size === 0) this.backfillObjects = undefined;
    }

    private processDataObject(obj: MoqtObjectData): void {
        const key = `${obj.groupId}:${obj.objectId}`;
        const headers = this.headerMap.get(key) ?? {};
        const backfill = this.backfillObjects?.has(key) === true;
        this.forgetHeaders(key);
        const inputs = this.inputState, input = inputs?.take(key);
        this.processSample(obj, headers, backfill, inputs, input);
    }

    private reportSample(inputs: PipelineInputs | undefined, input: object | undefined,
        batch: SampleBatch | undefined, reason: PlaybackInputDiscardReason): void {
        if (batch) this.reportBatch(batch, reason);
        else inputs?.report(input, reason);
    }

    /** The one sync/timing/decoder/FSM path for LOC and explicit coded units. */
    private processSample(obj: MoqtObjectData, headers: LocHeaders, backfill: boolean,
        inputs: PipelineInputs | undefined, input: object | undefined,
        codedChunk?: VideoChunkInit | AudioChunkInit, batch?: SampleBatch): void {
        const revision = this.playbackRevision;

        // 1. Configure decoder if the object carries codec config for this
        //    media type. DecoderStateMachine.configure dedupes equal bytes.
        //    @see draft-ietf-moq-loc-04 §2.3.2.1 (Video Config), §2.3.3.1 (Audio Config)
        const config = this.mediaType === 'video' ? headers.videoConfig : headers.audioConfig;
        if (config) {
            const configDecision = this.decoderState.configure(config);
            if (configDecision.action === 'configure') {
                this.onCommand({
                    type: 'configure',
                    mediaType: this.mediaType,
                    config,
                });
            }
        }

        if (revision !== this.playbackRevision) { this.reportSample(inputs, input, batch, 'decoder reset'); return; }

        // 2. Establish sync reference.
        //    Audio-master: first audio sample sets the reference (ONCE).
        //    Video-only: first video CaptureTimestamp sets the reference.
        const videoTimingSource = this.videoTimingSource;
        const audioTimingSource = this.audioTimingSource;
        const captureTimestamp = headers.captureTimestamp;
        let audioRenderTiming: AudioRenderTiming | undefined;
        if (this.mediaType === 'audio') {
            try {
                const capture = audioTimingSource.captureOutputTiming;
                if (capture !== undefined) {
                    const captured = captureTimestamp === undefined ? null : capture.call(audioTimingSource, captureTimestamp);
                    if (revision !== this.playbackRevision || audioTimingSource !== this.audioTimingSource) { this.reportSample(inputs, input, batch, 'decoder reset'); return; }
                    if (captured == null) { this.reportSample(inputs, input, batch, 'decoder policy'); return; }
                    audioRenderTiming = captured;
                }
            } catch {
                this.reportSample(inputs, input, batch, revision === this.playbackRevision ? 'decoder policy' : 'decoder reset'); return;
            }
        }
        const originalTimeline = this.mediaType === 'video'
            ? videoTimingSource === this.sync : audioTimingSource === this.sync;
        let videoRenderTiming: VideoRenderTiming | undefined;
        if (this.mediaType === 'video' && !originalTimeline) {
            try {
                const capture = videoTimingSource.captureVideoOutputTiming;
                if (capture !== undefined) {
                    const captured = captureTimestamp === undefined ? null : capture.call(videoTimingSource, captureTimestamp);
                    if (revision !== this.playbackRevision || this.videoTimingSource !== videoTimingSource) {
                        this.reportSample(inputs, input, batch, 'decoder reset'); return;
                    }
                    if (captured == null) { this.reportSample(inputs, input, batch, 'decoder policy'); return; }
                    const recompute = captured.recomputeRenderTimeUs;
                    if (revision !== this.playbackRevision || this.videoTimingSource !== videoTimingSource) {
                        this.reportSample(inputs, input, batch, 'decoder reset'); return;
                    }
                    if (typeof recompute !== 'function') { this.reportSample(inputs, input, batch, 'decoder policy'); return; }
                    videoRenderTiming = captured;
                }
            } catch {
                this.reportSample(inputs, input, batch, revision !== this.playbackRevision || this.videoTimingSource !== videoTimingSource
                    ? 'decoder reset' : 'decoder policy'); return;
            }
        }
        if (originalTimeline && headers.captureTimestamp !== undefined && !this.sync.hasReference) {
            if (this.mediaType === 'audio') {
                this.sync.setAudioReference(headers.captureTimestamp);
            } else if (this._videoOnly) {
                this.sync.setVideoReference(headers.captureTimestamp);
            }
        }
        if (!originalTimeline && captureTimestamp !== undefined && !this.sync.hasReference) {
            if (this.mediaType === 'audio') audioTimingSource.establishReference?.(captureTimestamp);
            else videoTimingSource.establishReference?.(captureTimestamp);
        }
        if (revision !== this.playbackRevision) { this.reportSample(inputs, input, batch, 'decoder reset'); return; }

        if (audioRenderTiming !== undefined && audioTimingSource !== this.audioTimingSource) {
            this.reportSample(inputs, input, batch, 'decoder reset'); return;
        }

        // 3. Compute render time.
        //    Returns null when no reference — CommandDispatcher holds the frame.
        // Video dependency marking, resolved BEFORE the lateness decision so the
        // drop policy and DecoderStateMachine see the same marking.
        const videoMarking = this.mediaType === 'video'
            ? (headers.videoFrameMarking
                ?? ((codedChunk ? codedChunk.type === 'key' : obj.objectId === 0n)
                    ? { independent: true, startOfFrame: true, endOfFrame: true,
                        discardable: false, baseLayerSync: false, temporalId: 0 }
                    : undefined))
            : undefined;

        let renderTimeUs: number;
        if (headers.captureTimestamp !== undefined) {
            let outputDelayUs = 0;
            if (this.mediaType === 'audio' && originalTimeline && this.getAudioPlayoutDelayUs) {
                try {
                    outputDelayUs = this.getAudioPlayoutDelayUs();
                    if (!Number.isFinite(outputDelayUs) || outputDelayUs < 0) throw new RangeError('Invalid audio playout delay');
                } catch {
                    this.reportSample(inputs, input, batch, revision === this.playbackRevision ? 'decoder policy' : 'decoder reset');
                    return;
                }
                if (revision !== this.playbackRevision || audioTimingSource !== this.audioTimingSource) {
                    this.reportSample(inputs, input, batch, 'decoder reset'); return;
                }
            }
            let timing = this.mediaType === 'video'
                ? videoTimingSource.computeVideoRenderTime(headers.captureTimestamp)
                : originalTimeline && this.getAudioPlayoutDelayUs
                    ? this.sync.computeAudioRenderTime(headers.captureTimestamp, outputDelayUs)
                    : (audioRenderTiming === undefined ? this.audioTimingSource : audioTimingSource).computeAudioRenderTime(headers.captureTimestamp);
            if (this.mediaType === 'audio' && ((originalTimeline && this.getAudioPlayoutDelayUs) || audioRenderTiming !== undefined)
                && (revision !== this.playbackRevision || audioTimingSource !== this.audioTimingSource)) {
                this.reportSample(inputs, input, batch, 'decoder reset'); return;
            }

            let absorbed = false;
            if (this.mediaType === 'audio' && originalTimeline && !backfill && timing) {
                try { absorbed = this._lateAudioHandler?.(timing.shouldDrop ? timing.offsetUs + outputDelayUs : 0, obj) === true; }
                catch { this.reportSample(inputs, input, batch, 'decoder policy'); return; }
                if (revision !== this.playbackRevision || audioTimingSource !== this.audioTimingSource) {
                    this.reportSample(inputs, input, batch, 'decoder reset'); return;
                }
            }
            if (absorbed) timing = this.sync.computeAudioRenderTime(headers.captureTimestamp, outputDelayUs);
            if (timing === null) {
                // An unavailable mapped schedule cannot become speculative "play now".
                if (!originalTimeline) { this.reportSample(inputs, input, batch, 'decoder policy'); return; }
                // No reference yet — use placeholder. CommandDispatcher will
                // hold this frame and recompute when the reference is ready.
                renderTimeUs = 0;
            } else if (timing.shouldDrop) {
                if (originalTimeline && timing.offsetUs < -5_000_000) {
                    renderTimeUs = this.clock.now();
                } else if (this.mediaType === 'video' && !this.isPreDecodeDroppable(videoMarking)) {
                    // Late, but the sender has not asserted this frame can be
                    // removed with the stream still decodable, so discarding it
                    // here risks every frame that may depend on it — a far
                    // larger cost than one late picture. Decode it and let the
                    // OUTPUT stage decide what to present: the dispatcher
                    // recomputes timing at decoder output and CanvasRenderer
                    // drops sufficiently late frames while keeping the newest.
                    renderTimeUs = originalTimeline ? this.clock.now() : timing.renderTimeUs;
                } else {
                    if (revision !== this.playbackRevision || audioTimingSource !== this.audioTimingSource) {
                        this.reportSample(inputs, input, batch, 'decoder reset'); return;
                    }
                    const retimed = absorbed ? this.sync.computeAudioRenderTime(headers.captureTimestamp, outputDelayUs) : null;
                    if (retimed === null || retimed.shouldDrop) { this.reportSample(inputs, input, batch, 'late frame'); return; }
                    renderTimeUs = retimed.renderTimeUs;
                }
            } else if (originalTimeline && timing.offsetUs > 5_000_000) {
                renderTimeUs = this.clock.now();
            } else {
                renderTimeUs = timing.renderTimeUs;
            }
        } else {
            if (!originalTimeline) { this.reportSample(inputs, input, batch, 'decoder policy'); return; }
            renderTimeUs = this.clock.now();
        }

        // 3b. Backfill primes decoding on the existing A/V timeline; it must
        // not re-anchor that clock or change the live catch-up decision.
        // Evaluate live catch-up from CaptureTimestamp
        // @see draft-ietf-moq-loc-01 §2.3.1.1 (latency measurement)
        // @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
        if (originalTimeline && !backfill && headers.captureTimestamp !== undefined) {
            const catchUp = this.sync.evaluateCatchUp(headers.captureTimestamp, headers.timestampIsWallClock, this.mediaType);
            if (catchUp !== null && catchUp.currentRate !== this._lastEmittedRate) {
                this._lastEmittedRate = catchUp.currentRate;
                this.onEvent({ type: 'catch_up_changed', state: catchUp });
                if (revision !== this.playbackRevision) { this.reportSample(inputs, input, batch, 'decoder reset'); return; }
                this.onCommand({ type: 'set_playback_rate', rate: catchUp.currentRate });
            }
        }

        if (revision !== this.playbackRevision) { this.reportSample(inputs, input, batch, 'decoder reset'); return; }

        // 4. Create chunk init and feed through decoder FSM
        if (this.mediaType === 'video') {
            // Resolved above, before the lateness decision, so the drop policy
            // and the decoder FSM cannot disagree about the same object.
            const marking = videoMarking;
            // Keyframe payload validation: verify bitstream actually starts with a keyframe
            // when the LOC header claims independent. Catches broken publishers.
            // Only check payloads > 5 bytes (too short = can't determine).
            // @see draft-ietf-moq-loc-01 §4.2
            const payload = codedChunk?.data ?? obj.payload;
            if (marking?.independent && this._videoCodec && payload.length > 5) {
                const isKeyframe = isKeyframePayload(this._videoCodec, payload);
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
            const chunk = codedChunk ?? toVideoChunkInit(obj.payload, headersWithMarking);
            if (revision !== this.playbackRevision) { this.reportSample(inputs, input, batch, 'decoder reset'); return; }
            // Join timing can read an injected clock. Prepare it before the
            // keyframe admission that would authorize subsequent deltas.
            if (originalTimeline && !backfill && this.decoderState.state === 'needs_keyframe'
                && marking?.independent === true && headers.captureTimestamp !== undefined) {
                this.sync.onVideoJoin(headers.captureTimestamp);
                const recomputed = this.sync.computeVideoRenderTime(headers.captureTimestamp);
                if (recomputed) renderTimeUs = recomputed.renderTimeUs;
            }

            // Refusing an input must not let its keyframe authorize later deltas.
            // Timing and validation callbacks can replace this input's provider.
            if (revision !== this.playbackRevision || this.videoTimingSource !== videoTimingSource) {
                this.reportSample(inputs, input, batch, 'decoder reset'); return;
            }
            const decision = this.decoderState.processVideoChunk(chunk, marking);

            if (decision.action === 'decode') {
                if (revision !== this.playbackRevision || this.videoTimingSource !== videoTimingSource) {
                    this.reportSample(inputs, input, batch, 'decoder reset'); return;
                }
                const renderTiming = videoRenderTiming ?? (!originalTimeline && captureTimestamp !== undefined
                    ? Object.freeze({ recomputeRenderTimeUs: () =>
                        videoTimingSource.computeVideoRenderTime(captureTimestamp)?.renderTimeUs ?? null })
                    : undefined);
                const command = {
                    type: 'decode_video' as const,
                    ...(input && inputs === this.inputState ? { inputToken: input } : {}),
                    chunk: decision.chunk as typeof chunk,
                    renderTimeUs,
                    ...(headers.captureTimestamp !== undefined
                        ? { captureTimestampUs: headers.captureTimestamp }
                        : {}),
                };
                this.onCommand(renderTiming ? { ...command, renderTiming } : command);
            } else if (decision.action === 'skip') {
                this.reportSample(inputs, input, batch, decision.reason === 'waiting for keyframe' ? 'awaiting keyframe' : 'decoder policy');
                if (revision !== this.playbackRevision) return;
                // Emit keyframe_waiting once per group (avoid per-object spam)
                if (decision.reason === 'waiting for keyframe' && obj.groupId !== this.lastKeyframeWaitingGroupId) {
                    this.lastKeyframeWaitingGroupId = obj.groupId;
                    this.onEvent({ type: 'keyframe_waiting', groupId: obj.groupId });
                }
            }
        } else {
            const chunk = (codedChunk as AudioChunkInit | undefined) ?? toAudioChunkInit(obj.payload, headers);
            if (revision !== this.playbackRevision) { this.reportSample(inputs, input, batch, 'decoder reset'); return; }
            const decision = this.decoderState.processAudioChunk(chunk);

            if (decision.action === 'decode') {
                this.onCommand({
                    type: 'decode_audio',
                    ...(audioRenderTiming ? { renderTiming: audioRenderTiming } : {}),
                    ...(input && inputs === this.inputState ? { inputToken: input } : {}),
                    chunk: decision.chunk as typeof chunk,
                    renderTimeUs,
                });
            } else { this.reportSample(inputs, input, batch, 'decoder policy'); }
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
        this.objectWait = undefined;
        const inputs = this.inputState, dropped: object[] | undefined = inputs ? [] : undefined;
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
                this.forgetHeaders(key);
                const input = inputs?.take(key); if (input) dropped?.push(input);
            }
        }
        this.pruneDroppedObjects();
        inputs?.reportAll(dropped, 'skipped');
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
