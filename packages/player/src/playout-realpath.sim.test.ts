/**
 * Deterministic video-only timing tests. The fake browser boundary does not
 * model codec fidelity, audio synchronization, or real network/backend behaviour.
 * Synthetic comparisons are regression evidence, not a production-policy verdict.
 *
 * Real-class playout composition.
 *
 * The sibling `playout-schedule.sim.test.ts` is a POLICY simulator: it uses the
 * real `AdaptiveToleranceController` and `RenderCushionSmoother` but reimplements
 * the wiring around them. That cannot catch a regression in the wiring itself,
 * so this suite drives the production classes:
 *
 *   real  PlaybackPipeline   — jitter buffer, adaptive input, gap detection,
 *                              backlog shedding, decoder commands
 *   real  SyncController     — PTS anchoring, onVideoJoin re-anchor
 *   real  CommandDispatcher  — decoder invocation, render-time recompute,
 *                              cushion application, queue-pressure feedback
 *   fake  decoder + renderer — the browser boundary ONLY, deterministic, on the
 *                              same simulated clock. No WebCodecs, DOM,
 *                              WebTransport, or wall-clock timers.
 *
 * The frozen trace ends at OBJECT ARRIVAL TIMES; decode outputs are produced by
 * the real dispatcher calling the fake decoder, never injected.
 * Every arm is rebuilt from scratch and shares only that immutable trace.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { PlaybackPipeline, SyncController, DefaultRecoveryController } from '@openmoq/playback';
import type { ClockSource, PlaybackConfig, DecoderCommand, PlaybackEvent } from '@openmoq/playback';
import type { LocHeaders } from '@openmoq/loc';
import type { MoqtObjectData, MoqtObjectGap } from '@openmoq/transport';
import { varint, ObjectStatus } from '@openmoq/transport';
import { CommandDispatcher } from './command-dispatcher.js';
import { createPipelines, configurePipelines, handlePipelineCommand, handlePipelineEvent } from './player-pipeline.js';
import { DEFAULT_PLAYER_CONFIG } from './config.js';
import type { MoqtPlayerConfig } from './config.js';
import { RenderCushionSmoother } from './render-cushion.js';
import type { VideoDecoderLike, VideoRendererLike } from './interfaces.js';
import { SerializedLinkModel } from '../../playback/test-support/serialized-link.js';

const MBPS = (n: number) => n * 1_000_000;
const FPS = 30, GOP = 60, TICK_US = 16_667, FLOOR_US = 200_000;
const VIDEO_CODEC = 'avc1.42c01f';


type CushionPolicy = 'adaptive' | 'floor';

/** Simulated clock: advances only when the event loop says so. */
class SimClock implements ClockSource {
  private _nowUs = 0;
  now(): number { return this._nowUs; }
  set(us: number): void { this._nowUs = us; }
}

/** Same-time order: arrivals, pipeline tick, decoder output, renderer tick. */
class SimEventLoop {
  private readonly queue: { at: number; pri: number; seq: number; run: () => void }[] = [];
  private sequence = 0;

  constructor(private readonly clock: SimClock) {}

  schedule = (at: number, pri: number, run: () => void): void => {
    if (!Number.isFinite(at) || at < this.clock.now()) throw new Error('invalid simulation event time');
    const event = { at, pri, seq: this.sequence++, run };
    let lo = 0, hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.queue[mid]!;
      if (other.at < at || (other.at === at && (other.pri < pri || (other.pri === pri && other.seq < event.seq)))) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, event);
  };

  drain(minimumEndUs: number, tick: () => void, render: () => void, pending: () => boolean): void {
    const horizonUs = minimumEndUs + 120_000_000;
    const scheduleTick = (at: number) => {
      this.schedule(at, 1, tick);
      this.schedule(at, 3, () => {
        render();
        if (at < minimumEndUs || this.queue.length > 0 || pending()) scheduleTick(at + TICK_US);
      });
    };
    scheduleTick(0);
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      if (event.at > horizonUs) throw new Error('simulation did not reach quiescence');
      this.clock.set(event.at);
      event.run();
    }
    if (pending()) throw new Error('simulation ended with pending work');
  }
}

interface SourceFrame { index: number; captureUs: number; bytes: number; key: boolean; }
interface Arrival extends SourceFrame { completionUs: number; }

/** Immutable arrival trace — objects and when they finish arriving. Nothing else. */
function freezeTrace(opts: {
  capacityMbps: number; seconds: number;
  keyBytes?: number; deltaBytes?: number;
  jitterUs?: (i: number) => number;
  /** Piecewise-constant capacity, integrated across boundaries. */
  capacitySchedule?: readonly { readonly fromUs: number; readonly bps: number }[];
  /** Per-frame payload override, for post-anchor source steps. */
  bytesFor?: (i: number) => number;
}): readonly Arrival[] {
  const keyBytes = opts.keyBytes ?? 400_000;
  const deltaBytes = opts.deltaBytes ?? 15_000;
  const count = Math.round(FPS * opts.seconds);
  const frames: SourceFrame[] = Array.from({ length: count }, (_, i) => ({
    index: i,
    captureUs: Math.round(i * (1_000_000 / FPS)),
    bytes: opts.bytesFor?.(i) ?? (i % GOP === 0 ? keyBytes : deltaBytes),
    key: i % GOP === 0,
  }));
  const link = new SerializedLinkModel({
    topology: 'fifo',
    capacityBps: MBPS(opts.capacityMbps),
    pathDelayUs: 20_000,
    ...(opts.jitterUs ? { jitterUs: opts.jitterUs } : {}),
    ...(opts.capacitySchedule ? { capacitySchedule: opts.capacitySchedule } : {}),
  });
  // One subgroup stream per GOP, matching what `videoObject()` claims on the
  // wire. With a single shared stream identity a jittered object would hold
  // back later GOPs that ride independent subgroup streams in production
  //. The shared FIFO server remains the bottleneck.
  const completions = link.run(
    frames.map((f) => ({
      id: `f${f.index}`,
      streamId: `video-${Math.floor(f.index / GOP)}`,
      captureUs: f.captureUs,
      bytes: f.bytes,
    })),
    { sourceDurationUs: Math.round(opts.seconds * 1_000_000) },
  );
  const byId = new Map(completions.map((c) => [c.id, c.completionUs]));
  return Object.freeze(frames.map((f) => Object.freeze({ ...f, completionUs: byId.get(`f${f.index}`)! })));
}

/**
 * END_OF_GROUP lifecycle entries. The real adapter synthesizes an
 * `ObjectStatus.END_OF_GROUP` gap when an end-of-group subgroup FINs
 * (`webtransport/src/adapter.ts`), and `PlaybackPipeline` waits at every group
 * boundary without it — which made every ordinary boundary look like a partial
 * group.
 */
function endOfGroupEntries(trace: readonly Arrival[]): { atUs: number; groupId: number; lastObjectId: number }[] {
  const lastOfGroup = new Map<number, Arrival>();
  for (const a of trace) lastOfGroup.set(Math.floor(a.index / GOP), a);
  return [...lastOfGroup.entries()].map(([groupId, last]) => ({
    atUs: last.completionUs,
    groupId,
    lastObjectId: last.index % GOP,
  }));
}

function endOfGroupObject(groupId: number, lastObjectId: number): MoqtObjectGap {
  return {
    kind: 'gap',
    trackAlias: varint(1),
    groupId: varint(groupId),
    subgroupId: varint(0),
    objectId: varint(lastObjectId + 1),
    status: ObjectStatus.END_OF_GROUP,
  };
}

function videoObject(a: Arrival): MoqtObjectData {
  // One object per frame, one subgroup per GOP — the LOC shape the pipeline expects.
  return {
    kind: 'data',
    trackAlias: varint(1),
    groupId: varint(Math.floor(a.index / GOP)),
    subgroupId: varint(0),
    objectId: varint(a.index % GOP),
    publisherPriority: 128,
    extensions: undefined,
    // Payload must be long enough for the keyframe validator to inspect.
    payload: new Uint8Array(Math.min(a.bytes, 32)).fill(a.key ? 0x65 : 0x41),
  };
}

function videoHeaders(a: Arrival): LocHeaders {
  return {
    captureTimestamp: BigInt(a.captureUs),
    videoFrameMarking: {
      startOfFrame: true, endOfFrame: true, independent: a.key,
      discardable: false, baseLayerSync: false, temporalId: 0,
    },
  };
}

interface Presentation {
  frame: number; captureUs: number; decodeOutUs: number; scheduledUs: number; actualUs: number;
}

interface RunResult {
  presentations: Presentation[];
  /** Arrivals whose group was already behind the pipeline's consumed group. */
  staleAtArrival: Set<number>;
  events: PlaybackEvent[];
  commands: DecoderCommand[];
  gapTimeoutSamples: number[];
  cushionSamples: number[];
  /**
 * Every source frame ends in exactly ONE terminal category, by identity
 *. Reconstructing identity from timestamps, or inferring
 * loss from presentation counts, cannot distinguish a frame the fuse
 * abandoned from one a decoder reset or renderer flush silently discarded.
 */
  accounting: {
    presented: Set<number>;
    decodeSubmitted: Set<number>;
    decoderResetDiscarded: Set<number>;
    rendererFlushDiscarded: Set<number>;
    neverDecoded: Set<number>;
  };
  /**
 * Dependent frames submitted to the decoder without their GOP's independent
 * anchor having been submitted first. A real decoder has no reference for
 * these; the fake must not silently accept them.
 */
  dependencyViolations: number[];
  /**
   * One chronological sequence of playout DECISIONS across both channels —
   * gap/fuse events, recovery actions, and reset commands — so cross-arm
   * comparison pins their interleaving, which per-channel comparisons cannot.
   */
  decisionSequence: string[];
  /**
 * Production event-bridge output and recovery-hook actions. Without recording
 * these the handler's `recovery` branch is observationally inert: deleting it
 * would change nothing measurable.
 */
  bridgeEvents: string[];
  recoveryActions: string[];
  /**
   * Every decode submission in order, so MULTIPLICITY is checkable. The terminal
   * Sets cannot see a frame decoded or presented twice.
   */
  decodeSubmissions: number[];
  /**
 * One record per skip-forward reaching the handler. Timestamped so the
 * separate-tick question is settled directly rather than inferred from
 * downstream behaviour. `didReset` is OBSERVED from an actual
 * `SyncController.reset()` call, not derived from guard state — deriving it
 * would still read true if the reset call itself were deleted.
 */
  skipRecords: { atUs: number; fromGroupId: string; toGroupId: string; guardBefore: boolean; didReset: boolean }[];
}

/**
 * Assemble the real classes for one policy arm. The ONLY parameter is the
 * cushion policy — everything else is identical, so a difference between arms
 * cannot come from anywhere but the render cushion.
 */
interface HarnessConfig {
  gapTimeoutUs: number;
  driftThresholdUs: number;
  maxBufferDepth: number;
  /** SyncController late-frame drop threshold. */
  dropThresholdUs: number;
  /** Decoder service time; a function models a post-anchor slowdown. */
  decodeServiceUs?: number | ((bytes: number, captureUs: number) => number);
}

/**
 * Historical harness tuning for this suite — NOT a coherent "playback-core
 * default" set. `PlaybackConfig` requires the gap/drift/buffer values, and the
 * playback package does not define these three together as defaults. The one
 * genuine core default here is the omitted `SyncController` drop threshold,
 * which is 500 ms.
 */
const TUNED_CONFIG: HarnessConfig = {
  gapTimeoutUs: 200_000, driftThresholdUs: 100_000, maxBufferDepth: 240, dropThresholdUs: 500_000,
};

/**
 * Derived from `DEFAULT_PLAYER_CONFIG` rather than copied, so a change to the
 * shipping defaults cannot silently leave this arm testing stale values
 *.
 */
const PRODUCTION_DEFAULT_CONFIG: HarnessConfig = {
  gapTimeoutUs: DEFAULT_PLAYER_CONFIG.gapTimeoutMs! * 1000,
  driftThresholdUs: DEFAULT_PLAYER_CONFIG.driftThresholdMs! * 1000,
  maxBufferDepth: DEFAULT_PLAYER_CONFIG.maxBufferDepth!,
  dropThresholdUs: DEFAULT_PLAYER_CONFIG.lateFrameThresholdMs! * 1000,
};

/**
 * Extra delay applied to a group's END_OF_GROUP delivery. Models the publisher's
 * FIN arriving late — which is what makes the pipeline treat a boundary as a
 * partial group and drive the fuse/recovery paths.
 */
type EogDelay = (groupId: number) => number;

/**
 * Groups the receiver never sees at all — a whole GOP lost upstream, which is a
 * delivery failure we have observed in the field. Unlike a late FIN this forces
 * the gap detector to SKIP FORWARD, which is the only path that exercises the
 * once-per-tick sync-reset guard.
 */
type DroppedGroups = ReadonlySet<number>;

function runRealPath(
  trace: readonly Arrival[],
  policy: CushionPolicy,
  harness: HarnessConfig = TUNED_CONFIG,
  eogDelay?: EogDelay,
  droppedGroups?: DroppedGroups,
): RunResult {
  const clock = new SimClock();
  const sync = new SyncController({
    clock,
    driftThresholdUs: harness.driftThresholdUs,
    dropThresholdUs: harness.dropThresholdUs,
  });
  const events: PlaybackEvent[] = [];
  const commands: DecoderCommand[] = [];
  const gapTimeoutSamples: number[] = [];
  const cushionSamples: number[] = [];
  const presentations: Presentation[] = [];
  const decisionSequence: string[] = [];
  const bridgeEvents: string[] = [];
  const recoveryActions: string[] = [];
  const skipRecords: RunResult['skipRecords'] = [];
  const decodeSubmissions: number[] = [];
  let syncResetThisTick = false;
  // Count ACTUAL SyncController.reset() calls, so `didReset` reflects the call
  // rather than the guard's permission.
  let syncResetCalls = 0;
  const realSyncReset = sync.reset.bind(sync);
  sync.reset = (): void => { syncResetCalls++; realSyncReset(); };

  const accounting = {
    presented: new Set<number>(),
    decodeSubmitted: new Set<number>(),
    decoderResetDiscarded: new Set<number>(),
    rendererFlushDiscarded: new Set<number>(),
    neverDecoded: new Set<number>(),
  };
  const staleAtArrival = new Set<number>();
  const indexOfCapture = new Map<number, number>(trace.map((a) => [a.captureUs, a.index]));
  const bytesOfCapture = new Map<number, number>(trace.map((a) => [a.captureUs, a.bytes]));
  const dependencyViolations: number[] = [];
  /** GOPs whose independent anchor has been submitted to the decoder. */
  const anchoredGops = new Set<number>();

  // Must match production wiring (`player-pipeline.ts:190-196`), including
  // `adaptiveTolerance: true` — without it the pipeline falls back to the static
  // gap timeout and BOTH arms silently become the floor arm.
  const config: PlaybackConfig = {
    gapTimeoutUs: harness.gapTimeoutUs,
    driftThresholdUs: harness.driftThresholdUs,
    maxBufferDepth: harness.maxBufferDepth,
    adaptiveTolerance: true,
  };

  const loop = new SimEventLoop(clock);
  const schedule = loop.schedule;

  // ── fake browser boundary: decoder ──────────────────────────────────────
  // Serial, dependency-preserving, and its outputs are REAL scheduled events at
  // their ready time rather than delivered opportunistically on the next tick
  //. A generation token invalidates work discarded by reset.
  let decoderFreeUs = 0;
  let nextDecodeOpId = 0;
  // Pending decode operations by identity. Counting alone let stale scheduled
  // callbacks decrement past zero after a reset, corrupting queue-pressure
  // feedback.
  const pendingOps = new Map<number, number>(); // opId -> frameIndex
  const decoder: VideoDecoderLike = {
    configure() { /* codec setup is irrelevant to timing */ },
    decode(chunk, renderTimeUs) {
      const timestampUs = Number((chunk as { timestamp: number | bigint }).timestamp);
      const frameIndex = indexOfCapture.get(timestampUs);
      const chunkBytes = bytesOfCapture.get(timestampUs) ?? 0;
      if (frameIndex !== undefined) {
        accounting.decodeSubmitted.add(frameIndex);
        decodeSubmissions.push(frameIndex);
        // Enforce the source trace's declared dependency contract: this fixture
        // marks every frame non-discardable, so a GOP is only decodable once its
        // independent object 0 has been submitted.
        const gop = Math.floor(frameIndex / GOP);
        if (frameIndex % GOP === 0) anchoredGops.add(gop);
        else if (!anchoredGops.has(gop)) dependencyViolations.push(frameIndex);
      }
      const opId = nextDecodeOpId++;
      const startUs = Math.max(clock.now(), decoderFreeUs);
      const serviceUs = typeof harness.decodeServiceUs === 'function'
        ? harness.decodeServiceUs(chunkBytes, timestampUs)
        : (harness.decodeServiceUs ?? 5_000);
      const readyUs = startUs + serviceUs;
      decoderFreeUs = readyUs;
      pendingOps.set(opId, frameIndex ?? -1);
      schedule(readyUs, 2, () => {
        // A stale callback whose operation was discarded by reset must observe
        // that it no longer exists and return without touching queue depth.
        if (!pendingOps.has(opId)) return;
        pendingOps.delete(opId);
        decoder.onFrame?.({ timestamp: timestampUs }, renderTimeUs);
      });
    },
    async flush() { /* outputs are already scheduled */ },
    reset() {
      // A decoder reset invalidates reference state: the next dependent frame
      // needs a fresh anchor.
      anchoredGops.clear();
      // Classify and remove outstanding work, AND drop the stale service
      // horizon which would otherwise create phantom decoder backlog.
      for (const frameIndex of pendingOps.values()) {
        if (frameIndex >= 0) accounting.decoderResetDiscarded.add(frameIndex);
      }
      pendingOps.clear();
      decoderFreeUs = clock.now();
    },
    get queueDepth() { return pendingOps.size; },
    onFrame: null,
    onError: null,
    destroy() { pendingOps.clear(); },
  };

  // ── fake browser boundary: renderer ─────────────────────────────────────
  const rqueue: { timestampUs: number; renderTimeUs: number; decodeOutUs: number }[] = [];
  const renderer: VideoRendererLike = {
    enqueue(frame, renderTimeUs) {
      const timestampUs = Number((frame as { timestamp: number }).timestamp);
      rqueue.push({ timestampUs, renderTimeUs, decodeOutUs: clock.now() });
    },
    flush() {
      for (const q of rqueue) {
        const idx = indexOfCapture.get(q.timestampUs);
        if (idx !== undefined) accounting.rendererFlushDiscarded.add(idx);
      }
      rqueue.length = 0;
    },
    destroy() { rqueue.length = 0; },
    onFirstFrame: null,
    onFrameRendered: null,
    onStall: null,
  };

  const smoother = new RenderCushionSmoother({ floorUs: FLOOR_US }, clock);
  let pipeline!: PlaybackPipeline;

  const dispatcher = new CommandDispatcher({
    videoDecoder: decoder,
    renderer,
    recomputeVideoRenderTime: (captureTimestampUs: bigint) => {
      const rawUs = pipeline.effectiveGapTimeoutUs;
      gapTimeoutSamples.push(rawUs);
      const adaptiveUs = smoother.update(rawUs);
      const cushionUs = policy === 'adaptive' ? adaptiveUs : FLOOR_US;
      cushionSamples.push(cushionUs);
      const timing = sync.computeVideoRenderTime(captureTimestampUs);
      if (!timing) return clock.now() + cushionUs;
      if (timing.shouldDrop) return clock.now();
      return timing.renderTimeUs + cushionUs;
    },
    hasSyncReference: () => sync.hasReference,
    getPlaybackDelayUs: () => (policy === 'adaptive' ? smoother.currentUs : FLOOR_US),
    // Production routes dispatcher feedback back into the pipeline; without it
    // queue-pressure signals never arrive and burst draining differs.
    onFeedback: (fb) => { pipeline.handleFeedback(fb); },
  });

  pipeline = new PlaybackPipeline({
    mediaType: 'video',
    config,
    clock,
    sync,
    videoOnly: true,
    isLive: true,
    // Match what `createPipelines()` builds from shipping config, so recovery
    // policy cannot differ between the manual and factory arms.
    recovery: new DefaultRecoveryController({
      gapEscalationThreshold: DEFAULT_PLAYER_CONFIG.maxConsecutiveGaps!,
      maxDecodeErrors: DEFAULT_PLAYER_CONFIG.maxDecodeErrors!,
    }),
    onCommand: (cmd) => {
      commands.push(cmd);
      // Reset joins the same chronological sequence as the events above, so
      // its position RELATIVE to them is compared, not just its presence in the
      // command list.
      if (cmd.type === 'reset') {
        decisionSequence.push(JSON.stringify({ type: 'reset', reason: cmd.reason }));
      }
      dispatcher.dispatch(cmd);
    },
    onEvent: (evt) => {
      events.push(evt);
      // Record enough identity for equality to prove identical DECISIONS,
      // not merely identical event counts.
      const detail = JSON.stringify(evt, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      if (evt.type === 'skip_forward' || evt.type === 'partial_group_abandoned'
        || evt.type === 'backlog_shed' || evt.type === 'keyframe_waiting'
        || evt.type === 'gap_detected' || evt.type === 'track_ended'
        // Include recovery in the combined sequence so its ordering relative to
        // reset commands is observable across arms. (Recovery payloads are
        // already covered by the full event comparison; what this adds is
        // cross-channel ordering.)
        || evt.type === 'recovery') {
        decisionSequence.push(detail);
      }
      // Route through the SAME production handler the factory arm uses, so the
      // event-bridge implementation is factored OUT of the comparison and
      // factory construction/wiring remains the variable under test.
      const guardBefore = syncResetThisTick;
      const resetsBefore = syncResetCalls;
      handlePipelineEvent('video', evt, {
        emitEvent: (e) => { bridgeEvents.push(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); },
        log: { debug() {}, info() {}, warn() {}, error() {} } as never,
        syncController: sync,
        syncResetThisTick,
        setSyncResetThisTick: (v) => { syncResetThisTick = v; },
        recoveryHook: (a) => {
          recoveryActions.push(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
          return a;
        },
      });
      if (evt.type === 'skip_forward') {
        skipRecords.push({
          atUs: clock.now(),
          fromGroupId: String(evt.fromGroupId), toGroupId: String(evt.toGroupId),
          guardBefore, didReset: syncResetCalls > resetsBefore,
        });
      }
    },
  });

  // Production configures the pipelines after construction and before media
  // (`configurePipelines()`, player-pipeline.ts:327-354). Without this the
  // DecoderStateMachine stays IDLE and silently skips every video chunk
  // (decoder-state.ts:64,121-127) — the actual cause of the 0031 blocker.
  pipeline.setCodec(VIDEO_CODEC);
  pipeline.configure(new Uint8Array(0));

  // The dispatcher installs its own onFrameRendered; the renderer must actually
  // call it so `frame_rendered` and sync feedback reach production paths.
  const dispatcherRendered = renderer.onFrameRendered;

  // ── seed the queue ──────────────────────────────────────────────────────
  const lastUs = Math.max(...trace.map((a) => a.completionUs)) + 5_000_000;
  for (const a of trace) {
    if (droppedGroups?.has(Math.floor(a.index / GOP))) continue;
    schedule(a.completionUs, 0, () => {
      if (BigInt(Math.floor(a.index / GOP)) < pipeline.currentGroupId) staleAtArrival.add(a.index);
      pipeline.pushObject(videoObject(a), videoHeaders(a));
    });
  }
  for (const eog of endOfGroupEntries(trace)) {
    if (droppedGroups?.has(eog.groupId)) continue;
    // Delivered only after that GOP's final data object is observable, plus any
    // scenario-specified FIN delay.
    const atUs = eog.atUs + (eogDelay?.(eog.groupId) ?? 0);
    schedule(atUs, 0, () => { pipeline.pushObject(endOfGroupObject(eog.groupId, eog.lastObjectId)); });
  }
  loop.drain(lastUs, () => {
    syncResetThisTick = false;
    pipeline.tick();
  }, () => {
    while (rqueue.length > 0 && rqueue[0]!.renderTimeUs <= clock.now()) {
      const q = rqueue.shift()!;
      const idx = indexOfCapture.get(q.timestampUs);
      if (idx !== undefined) accounting.presented.add(idx);
      presentations.push({
        frame: idx ?? -1, captureUs: q.timestampUs, decodeOutUs: q.decodeOutUs,
        scheduledUs: q.renderTimeUs, actualUs: clock.now(),
      });
      (renderer.onFrameRendered ?? dispatcherRendered)?.(BigInt(q.timestampUs), clock.now(), q.renderTimeUs);
    }
  }, () => pendingOps.size > 0 || rqueue.length > 0 || pipeline.bufferedGroupCount > 0);

  for (const a of trace) {
    if (!accounting.decodeSubmitted.has(a.index)) accounting.neverDecoded.add(a.index);
    else if (!accounting.presented.has(a.index)
      && !accounting.decoderResetDiscarded.has(a.index)
      && !accounting.rendererFlushDiscarded.has(a.index)) {
      throw new Error(`submitted frame ${a.index} has no terminal outcome`);
    }
  }

  return {
    presentations, staleAtArrival, events, commands, gapTimeoutSamples, cushionSamples,
    accounting, decisionSequence, dependencyViolations,
    bridgeEvents, recoveryActions, skipRecords, decodeSubmissions,
  };
}

// Invariants this composition depends on, both learned the hard way: the
// subgroup END_OF_GROUP lifecycle must be delivered (without it the pipeline
// treats every clean group boundary as a partial group), and the production
// `setCodec()` + `configure()` step must run (without it the decoder FSM stays
// IDLE and silently skips every chunk). The clean-path test gates both.
describe('real-class playout composition — smoke', () => {
  it('drives the production pipeline/sync/dispatcher end to end', () => {
    const trace = freezeTrace({ capacityMbps: 50, seconds: 8 });
    const r = runRealPath(trace, 'floor');
    // The real pipeline must have issued decoder commands and produced frames.
    expect(r.commands.length).toBeGreaterThan(0);
    expect(r.presentations.length).toBeGreaterThan(0);
  });
});

/**
 * Every source frame must land in exactly one terminal category, and no frame
 * may be submitted without its reference anchor. Applied to every canonical arm
 *, not just one clean run.
 */
function assertTerminalPartition(trace: readonly Arrival[], r: RunResult): void {
  const terminals = [
    r.accounting.presented,
    r.accounting.decoderResetDiscarded,
    r.accounting.rendererFlushDiscarded,
    r.accounting.neverDecoded,
  ];
  for (let i = 0; i < terminals.length; i++) {
    for (let j = i + 1; j < terminals.length; j++) {
      for (const v of terminals[i]!) expect(terminals[j]!.has(v)).toBe(false);
    }
  }
  // Exact source-set equality, not merely equal cardinality.
  const union = [...new Set(terminals.flatMap((t) => [...t]))].sort((a, b) => a - b);
  expect(union).toEqual(trace.map((a) => a.index));
  expect(r.dependencyViolations).toEqual([]);

  // MULTIPLICITY: the Sets above cannot see a frame presented or decoded twice,
  // so duplicates are checked directly. Every surviving identity must appear at
  // most once in each channel.
  const countBy = (xs: readonly number[]) => {
    const m = new Map<number, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  for (const [, n] of countBy(r.presentations.map((p) => p.frame))) expect(n).toBe(1);
  for (const [, n] of countBy(r.decodeSubmissions)) expect(n).toBe(1);
}

/**
 * A run that loses and duplicates nothing. Set-based accounting alone cannot see
 * DUPLICATE delivery — a frame rendered twice still yields the same set — so
 * this also checks multiplicities: the playout sequence, the decode command
 * count, and the submitted set.
 */
function assertLosslessRun(trace: readonly Arrival[], r: RunResult): void {
  assertTerminalPartition(trace, r);
  const sourceIdentities = trace.map((a) => a.index);

  // Each source frame presented exactly once, in playout order.
  expect(r.presentations.map((p) => p.frame)).toEqual(sourceIdentities);
  // Exactly one decode command per source frame — catches duplicate decodes.
  expect(r.commands.filter((c) => c.type === 'decode_video').length).toBe(trace.length);
  // And the submitted set is exactly the source set.
  expect([...r.accounting.decodeSubmitted].sort((a, b) => a - b)).toEqual(sourceIdentities);

  expect(r.accounting.neverDecoded.size).toBe(0);
  expect(r.accounting.decoderResetDiscarded.size).toBe(0);
  expect(r.accounting.rendererFlushDiscarded.size).toBe(0);
  expect(r.decisionSequence).toEqual([]);
}

/** Picture-freeze excess over the nominal source cadence, including missing frames. */
function decompose(ps: readonly Presentation[]) {
  let totalFreezeExcessUs = 0, starvationUs = 0, holdUs = 0, tickUs = 0, maxFreezeUs = 0;
  for (let i = 1; i < ps.length; i++) {
    const prev = ps[i - 1]!, cur = ps[i]!;
    const expectedUs = prev.actualUs + 1_000_000 / FPS;
    const endUs = cur.actualUs;
    maxFreezeUs = Math.max(maxFreezeUs, endUs - prev.actualUs);
    if (endUs <= expectedUs) continue;
    totalFreezeExcessUs += endUs - expectedUs;
    starvationUs += Math.max(0, Math.min(endUs, cur.decodeOutUs) - expectedUs);
    const holdStartUs = Math.max(expectedUs, cur.decodeOutUs);
    holdUs += Math.max(0, Math.min(endUs, cur.scheduledUs) - holdStartUs);
    tickUs += Math.max(0, endUs - Math.max(expectedUs, cur.decodeOutUs, cur.scheduledUs));
  }
  const lat = ps.map((p) => p.actualUs - p.captureUs).sort((a, b) => a - b);
  return {
    totalFreezeExcessUs, starvationUs, holdUs, tickUs, maxFreezeUs,
    latencyP50Us: lat[Math.floor(lat.length / 2)] ?? 0,
    presented: ps.length,
  };
}

const fmt = (d: ReturnType<typeof decompose>) =>
  `frames=${String(d.presented).padStart(4)} freeze=${(d.totalFreezeExcessUs / 1000).toFixed(0).padStart(5)}ms`
  + ` (starve=${(d.starvationUs / 1000).toFixed(0)} hold=${(d.holdUs / 1000).toFixed(0)} tick=${(d.tickUs / 1000).toFixed(0)})`
  + ` max=${(d.maxFreezeUs / 1000).toFixed(0).padStart(4)}ms lat50=${(d.latencyP50Us / 1000).toFixed(0)}ms`;

/**
 * Readiness-only counterfactual on a source-clock schedule. This is not a player
 * arm: it reuses observed decode outputs, adds no sync baseline, and cannot
 * recover frames the pipeline discarded or predict feedback from another policy.
 */
function fixedReadinessSchedule(
  presentations: readonly Presentation[],
  offsetUs: number | ((captureUs: number) => number),
): Presentation[] {
  let previousActualUs = 0;
  return presentations.map((p) => {
    const scheduledUs = p.captureUs + (typeof offsetUs === 'function' ? offsetUs(p.captureUs) : offsetUs);
    const actualUs = Math.ceil(Math.max(scheduledUs, p.decodeOutUs, previousActualUs) / TICK_US) * TICK_US;
    previousActualUs = actualUs;
    return { ...p, scheduledUs, actualUs };
  });
}

describe('simulation driver and scoring', () => {
  it('bounds a driver that cannot drain instead of accepting unfinished work', () => {
    const loop = new SimEventLoop(new SimClock());
    expect(() => loop.drain(0, () => {}, () => {}, () => true)).toThrow('quiescence');
  });

  it('uses a total source-clock offset, including for outputs the player considered late', () => {
    const result = runRealPath(freezeTrace({ capacityMbps: 3, seconds: 8 }), 'floor');
    const offsetUs = Math.max(...result.presentations.map((p) => p.decodeOutUs - p.captureUs));
    const scheduled = fixedReadinessSchedule(result.presentations, offsetUs);
    expect(offsetUs).toBeGreaterThan(1_000_000);
    for (const p of scheduled) {
      expect(p.scheduledUs).toBe(p.captureUs + offsetUs);
      expect(p.decodeOutUs).toBeLessThanOrEqual(p.scheduledUs);
      expect(p.actualUs - p.scheduledUs).toBeLessThan(TICK_US);
    }
    expect(decompose(scheduled).totalFreezeExcessUs).toBeLessThan(TICK_US);
  });

  it('detects both inadequate headroom and a feasible post-anchor schedule', () => {
    const input = Array.from({ length: 180 }, (_, frame) => {
      const captureUs = Math.round(frame * 1_000_000 / FPS);
      return { frame, captureUs, decodeOutUs: captureUs + (frame < 60 ? 50_000 : 300_000), scheduledUs: 0, actualUs: 0 };
    });
    const insufficient = fixedReadinessSchedule(input, 100_000);
    const stepped = fixedReadinessSchedule(input, (captureUs) => captureUs < 2_000_000 ? 100_000 : 350_000);
    expect(insufficient.filter((p) => p.decodeOutUs > p.scheduledUs)).toHaveLength(120);
    expect(stepped.filter((p) => p.decodeOutUs > p.scheduledUs)).toHaveLength(0);
    // Raising latency has a visible one-time picture hold, not free protection.
    expect(decompose(stepped).totalFreezeExcessUs).toBeGreaterThan(200_000);
    expect(decompose(stepped).holdUs).toBeGreaterThan(0);
    expect(decompose(stepped.slice(60)).totalFreezeExcessUs).toBeLessThan(TICK_US);
  });
  it('keeps rendering while a slow decoder drains past the initial tick horizon', () => {
    const trace = freezeTrace({ capacityMbps: 50, seconds: 1 });
    const config = { ...TUNED_CONFIG, decodeServiceUs: 500_000, dropThresholdUs: 60_000_000 };
    for (const result of [runRealPath(trace, 'floor', config), runFactoryPath(trace, config)]) {
      assertTerminalPartition(trace, result);
      const tail = result.presentations.filter((p) => p.decodeOutUs > trace.at(-1)!.completionUs + 5_000_000);
      expect(tail.length).toBeGreaterThan(0);
      for (const p of tail) {
        expect(p.actualUs - Math.max(p.decodeOutUs, p.scheduledUs)).toBeLessThan(TICK_US);
      }
    }
  });

  it('counts a lost GOP as a picture freeze rather than expected source cadence', () => {
    const result = decompose([
      { frame: 0, captureUs: 0, decodeOutUs: 0, scheduledUs: 0, actualUs: 0 },
      { frame: 60, captureUs: 2_000_000, decodeOutUs: 2_000_000, scheduledUs: 2_000_000, actualUs: 2_000_000 },
    ]);
    expect(result.totalFreezeExcessUs).toBeCloseTo(2_000_000 - 1_000_000 / FPS);
    expect(result.starvationUs + result.holdUs + result.tickUs).toBeCloseTo(result.totalFreezeExcessUs);
  });
});

describe('real-class playout composition — canonical regimes', () => {
  it('regime 1: floor-feasible periodic keyframe burst', () => {
    const trace = freezeTrace({ capacityMbps: 8, seconds: 20 });
    const adaptive = runRealPath(trace, 'adaptive');
    const floor = runRealPath(trace, 'floor');
    const dA = decompose(adaptive.presentations), dF = decompose(floor.presentations);
    const acct = (r: RunResult) => `presented=${r.accounting.presented.size}/${trace.length} resetDrop=${r.accounting.decoderResetDiscarded.size} flushDrop=${r.accounting.rendererFlushDiscarded.size} neverDecoded=${r.accounting.neverDecoded.size} decisions=${r.decisionSequence.length}`;
    console.log(`\nREAL regime 1 (8Mbps keyframe burst):\n    floor     ${fmt(dF)}\n              ${acct(floor)}\n    adaptive  ${fmt(dA)}\n              ${acct(adaptive)}\n`);

    // Gap-fuse inputs must be identical across render-policy arms: the render
    // cushion must not feed back into the fuse.
    expect(adaptive.gapTimeoutSamples).toEqual(floor.gapTimeoutSamples);
    expect(adaptive.commands.length).toBe(floor.commands.length);

    // Decisions must be identical across render-policy arms.
    expect(adaptive.decisionSequence).toEqual(floor.decisionSequence);
    for (const arm of [floor, adaptive]) assertLosslessRun(trace, arm);

    // REGIME 1 through production wiring: the fixed floor delivers every frame
    // with NO freeze at all, while the adaptive cushion manufactures freeze and
    // charges latency for headroom that was never needed. Complete accounting
    // and zero fuse activity confirm nothing else is in play.
    expect(floor.accounting.presented.size).toBe(trace.length);
    expect(floor.decisionSequence).toEqual([]);
    // Floor freeze is sub-tick residue; adaptive's is an order of magnitude
    // larger and is manufactured entirely by cushion movement.
    expect(dF.totalFreezeExcessUs).toBeLessThan(TICK_US);
    expect(dA.totalFreezeExcessUs).toBeGreaterThan(10 * dF.totalFreezeExcessUs);
    expect(dA.latencyP50Us).toBeGreaterThan(dF.latencyP50Us);
  });

  it('regime 2: repeated post-anchor 500ms impairment', () => {
    const trace = freezeTrace({
      capacityMbps: 20, seconds: 40,
      jitterUs: (i) => (i >= 180 && i % 90 === 0 ? 500_000 : 0),
    });
    const adaptive = runRealPath(trace, 'adaptive');
    const floor = runRealPath(trace, 'floor');
    const dA = decompose(adaptive.presentations), dF = decompose(floor.presentations);
    const tally = (r: RunResult) => {
      const counts = new Map<string, number>();
      for (const e of r.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      return [...counts].map(([k, v]) => `${k}=${v}`).join(' ');
    };
    console.log(`\nREAL regime 2 (repeating 500ms impairment):\n    floor     ${fmt(dF)}\n    adaptive  ${fmt(dA)}`
      + `\n    floor events: ${tally(floor)}\n    adapt events: ${tally(adaptive)}\n`);

    expect(adaptive.gapTimeoutSamples).toEqual(floor.gapTimeoutSamples);

    // Exact identity AND multiplicity accounting in both arms; the old
    // pre-decode drop must be caught here.
    for (const arm of [floor, adaptive]) assertLosslessRun(trace, arm);

    // REGIME 2 through production wiring: here the adaptive cushion EARNS its
    // keep — it cuts total freeze and starvation substantially, and pays for it
    // in latency. (My 0029 claim that this regime does not reproduce was an
    // artifact of the missing initial configure; withdrawn.)
    expect(dA.totalFreezeExcessUs).toBeLessThan(dF.totalFreezeExcessUs);
    expect(dA.starvationUs).toBeLessThan(dF.starvationUs);
    expect(dA.latencyP50Us).toBeGreaterThan(dF.latencyP50Us);
    expect(adaptive.accounting.presented.size).toBe(floor.accounting.presented.size);
  });
});

/**
 * Clean-path discriminator. Everything downstream depends on the
 * composition behaving correctly when NOTHING is wrong: a clean link, complete
 * GOPs, and their END_OF_GROUP lifecycle should produce every frame exactly once
 * with no fuse activity at all.
 *
 * This is also the test that catches the assembly error which invalidated the
 * 0029 numbers — remove the initial configure and it fails immediately.
 */
describe('real-class playout composition — clean path', () => {
  it('delivers every frame exactly once with no fuse activity', () => {
    // 4 complete GOPs on a link fast enough that nothing queues.
    const trace = freezeTrace({ capacityMbps: 100, seconds: 8 });
    const r = runRealPath(trace, 'floor');

    // 1. exactly one initial configure, before the first decode
    const configureIdx = r.commands.findIndex((c) => c.type === 'configure');
    const firstDecodeIdx = r.commands.findIndex((c) => c.type === 'decode_video');
    expect(configureIdx).toBeGreaterThanOrEqual(0);
    expect(r.commands.filter((c) => c.type === 'configure').length).toBe(1);
    expect(configureIdx).toBeLessThan(firstDecodeIdx);

    // 2. every source frame presented exactly once
    expect(r.accounting.presented.size).toBe(trace.length);
    expect(r.presentations.length).toBe(trace.length);

    // 3. no fuse activity, no discards, nothing unclassified
    expect(r.decisionSequence).toEqual([]);
    expect(r.accounting.decoderResetDiscarded.size).toBe(0);
    expect(r.accounting.rendererFlushDiscarded.size).toBe(0);
    expect(r.accounting.neverDecoded.size).toBe(0);
  });

  it('accounts for every source frame in exactly one terminal category', () => {
    const trace = freezeTrace({ capacityMbps: 8, seconds: 12 });
    const r = runRealPath(trace, 'adaptive');
    assertTerminalPartition(trace, r);
  });
});

/**
 * Module-resolution contract.
 *
 * `@openmoq/playback`'s package `exports` map points at `dist/index.js`. Without a
 * source alias this suite exercises the PUBLISHED BUNDLE, which is how a
 * production pipeline fix appeared to have no effect here and how earlier
 * real-path numbers were measured against whatever `dist` happened to contain.
 *
 * Removing the alias must fail this test rather than silently changing what is
 * under test.
 */
describe('real-class playout composition — resolution contract', () => {
  it('resolves @openmoq/playback to workspace source, not the published bundle', async () => {
    const fromSource = await import('../../playback/src/pipeline.js');
    expect(PlaybackPipeline).toBe(fromSource.PlaybackPipeline);
  });
});

/**
 * Production-factory parity.
 *
 * Everything above builds the real classes BY HAND. That leaves one question
 * open: does the hand assembly still match what `createPipelines()` +
 * `configurePipelines()` actually wire? The missing `configurePipelines()` step
 * — which silently invalidated a whole round of results — is exactly the class
 * of divergence only this comparison catches.
 *
 * Step 1 here is ASSEMBLY parity: the factory is given the same tuned config the
 * manual arm uses, so any difference is wiring rather than policy.
 */
describe('real-class playout composition — production factory parity', () => {
  /** The manual arm's tuned values, so config cannot explain a difference. */
  const TUNED = {
    gapTimeoutMs: 200,
    driftThresholdMs: 100,
    maxBufferDepth: 240,
    lateFrameThresholdMs: 500, // SyncController's default drop threshold
  };

  it('builds the same pipeline/sync/dispatcher shape as the manual assembly', () => {
    const clock = new SimClock();
    const commands: DecoderCommand[] = [];
    const events: PlaybackEvent[] = [];

    // Browser-boundary fakes only — no WebCodecs, DOM, or transport.
    const decoder: VideoDecoderLike = {
      configure() {}, decode() {}, async flush() {}, reset() {},
      get queueDepth() { return 0; }, onFrame: null, onError: null, destroy() {},
    };
    const renderer: VideoRendererLike = {
      enqueue() {}, flush() {}, destroy() {},
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };

    const config: MoqtPlayerConfig = {
      ...DEFAULT_PLAYER_CONFIG,
      url: 'https://example.invalid/moq',
      namespace: 'sim',
      ...TUNED,
      createVideoDecoder: () => decoder,
      createRenderer: () => renderer,
    };

    const pipelines = createPipelines(config, clock, {
      video: { codec: VIDEO_CODEC, width: 1920, height: 1080, packaging: 'loc' },
      audio: undefined,
      isLive: true,
    }, {
      onFirstFrame: () => {},
      onStall: () => {},
      onDecodeError: () => {},
      onFrameRendered: () => {},
      onFeedback: () => {},
      onCommand: (cmd) => { commands.push(cmd); },
      onEvent: (_mediaType, evt) => { events.push(evt); },
    });

    // The factory must produce the same three real classes this suite assembles.
    expect(pipelines.videoPipeline).toBeInstanceOf(PlaybackPipeline);
    expect(pipelines.syncController).toBeInstanceOf(SyncController);
    expect(pipelines.commandDispatcher).toBeInstanceOf(CommandDispatcher);
    // LOC video must NOT create a MediaSource adapter.
    expect(pipelines.mediaSource).toBeNull();
    // And it must expose the render-cushion view the adaptive policy reads.
    expect(typeof pipelines.getRenderCushionUs).toBe('function');

    // configurePipelines() is the step whose absence silently disabled decoding.
    configurePipelines(pipelines, {
      video: { codec: VIDEO_CODEC, width: 1920, height: 1080, packaging: 'loc' },
      audio: undefined,
      isLive: true,
    });
    expect(commands.filter((c) => c.type === 'configure').length).toBe(1);
  });

  it('exposes an adaptive render cushion that starts at the static floor', () => {
    const clock = new SimClock();
    const decoder: VideoDecoderLike = {
      configure() {}, decode() {}, async flush() {}, reset() {},
      get queueDepth() { return 0; }, onFrame: null, onError: null, destroy() {},
    };
    const renderer: VideoRendererLike = {
      enqueue() {}, flush() {}, destroy() {},
      onFirstFrame: null, onFrameRendered: null, onStall: null,
    };
    const config: MoqtPlayerConfig = {
      ...DEFAULT_PLAYER_CONFIG,
      url: 'https://example.invalid/moq', namespace: 'sim', ...TUNED,
      createVideoDecoder: () => decoder, createRenderer: () => renderer,
    };

    const pipelines = createPipelines(config, clock, {
      video: { codec: VIDEO_CODEC, packaging: 'loc' }, audio: undefined, isLive: true,
    }, {
      onFirstFrame: () => {}, onStall: () => {}, onDecodeError: () => {},
      onFrameRendered: () => {}, onFeedback: () => {}, onCommand: () => {},
      onEvent: () => {},
    });

    // Same floor the manual arm uses, so the two arms are comparable.
    expect(pipelines.getRenderCushionUs?.()).toBe(FLOOR_US);
  });
});

/**
 * Factory-built adaptive arm. Deliberately mirrors `runRealPath`'s event loop
 * so any difference is attributable to the wiring rather than the driver.
 */
function runFactoryPath(
  trace: readonly Arrival[],
  harness: HarnessConfig = TUNED_CONFIG,
  eogDelay?: EogDelay,
  droppedGroups?: DroppedGroups,
): RunResult {
  const clock = new SimClock();
  const events: PlaybackEvent[] = [];
  const commands: DecoderCommand[] = [];
  const gapTimeoutSamples: number[] = [];
  const cushionSamples: number[] = [];
  const presentations: Presentation[] = [];
  const decisionSequence: string[] = [];
  const dependencyViolations: number[] = [];
  const anchoredGops = new Set<number>();
  const accounting = {
    presented: new Set<number>(), decodeSubmitted: new Set<number>(),
    decoderResetDiscarded: new Set<number>(), rendererFlushDiscarded: new Set<number>(),
    neverDecoded: new Set<number>(),
  };
  const staleAtArrival = new Set<number>();
  const indexOfCapture = new Map<number, number>(trace.map((a) => [a.captureUs, a.index]));
  const bytesOfCapture = new Map<number, number>(trace.map((a) => [a.captureUs, a.bytes]));

  const loop = new SimEventLoop(clock);
  const schedule = loop.schedule;

  let decoderFreeUs = 0, nextOpId = 0;
  const pendingOps = new Map<number, number>();
  const decoder: VideoDecoderLike = {
    configure() {},
    decode(chunk, renderTimeUs) {
      const timestampUs = Number((chunk as { timestamp: number | bigint }).timestamp);
      const frameIndex = indexOfCapture.get(timestampUs);
      const chunkBytes = bytesOfCapture.get(timestampUs) ?? 0;
      if (frameIndex !== undefined) {
        accounting.decodeSubmitted.add(frameIndex);
        decodeSubmissions.push(frameIndex);
        const gop = Math.floor(frameIndex / GOP);
        if (frameIndex % GOP === 0) anchoredGops.add(gop);
        else if (!anchoredGops.has(gop)) dependencyViolations.push(frameIndex);
      }
      const opId = nextOpId++;
      const serviceUs = typeof harness.decodeServiceUs === 'function'
        ? harness.decodeServiceUs(chunkBytes, timestampUs)
        : (harness.decodeServiceUs ?? 5_000);
      const readyUs = Math.max(clock.now(), decoderFreeUs) + serviceUs;
      decoderFreeUs = readyUs;
      pendingOps.set(opId, frameIndex ?? -1);
      schedule(readyUs, 2, () => {
        if (!pendingOps.has(opId)) return;
        pendingOps.delete(opId);
        decoder.onFrame?.({ timestamp: timestampUs }, renderTimeUs);
        // Sampled here, immediately after production's recompute callback has
        // advanced the smoother — the same lifecycle point the manual arm uses.
        // Sampling at presentation time instead would read a value other
        // decode outputs had already moved.
        gapTimeoutSamples.push(pipelines.videoPipeline!.effectiveGapTimeoutUs);
        cushionSamples.push(pipelines.getRenderCushionUs!());
      });
    },
    async flush() {},
    reset() {
      anchoredGops.clear();
      for (const fi of pendingOps.values()) if (fi >= 0) accounting.decoderResetDiscarded.add(fi);
      pendingOps.clear();
      decoderFreeUs = clock.now();
    },
    get queueDepth() { return pendingOps.size; },
    onFrame: null, onError: null,
    destroy() { pendingOps.clear(); },
  };

  const rqueue: { timestampUs: number; renderTimeUs: number; decodeOutUs: number }[] = [];
  const renderer: VideoRendererLike = {
    enqueue(frame, renderTimeUs) {
      rqueue.push({
        timestampUs: Number((frame as { timestamp: number }).timestamp),
        renderTimeUs, decodeOutUs: clock.now(),
      });
    },
    flush() {
      for (const q of rqueue) {
        const idx = indexOfCapture.get(q.timestampUs);
        if (idx !== undefined) accounting.rendererFlushDiscarded.add(idx);
      }
      rqueue.length = 0;
    },
    destroy() { rqueue.length = 0; },
    onFirstFrame: null, onFrameRendered: null, onStall: null,
  };

  const config: MoqtPlayerConfig = {
    ...DEFAULT_PLAYER_CONFIG,
    url: 'https://example.invalid/moq',
    namespace: 'sim',
    gapTimeoutMs: harness.gapTimeoutUs / 1000,
    driftThresholdMs: harness.driftThresholdUs / 1000,
    maxBufferDepth: harness.maxBufferDepth,
    lateFrameThresholdMs: harness.dropThresholdUs / 1000,
    createVideoDecoder: () => decoder,
    createRenderer: () => renderer,
  };
  const trackInfo = {
    video: { codec: VIDEO_CODEC, width: 1920, height: 1080, packaging: 'loc' as const },
    audio: undefined,
    isLive: true,
  };

  let pipelines!: ReturnType<typeof createPipelines>;
  let syncResetThisTick = false;
  let syncResetCalls = 0;
  const bridgeEvents: string[] = [];
  const recoveryActions: string[] = [];
  const skipRecords: RunResult['skipRecords'] = [];
  const decodeSubmissions: number[] = [];
  pipelines = createPipelines(config, clock, trackInfo, {
    onFirstFrame: () => {},
    onStall: () => {},
    onDecodeError: () => {},
    onFrameRendered: () => {},
    onFeedback: (fb) => { pipelines.videoPipeline?.handleFeedback(fb); },
    onCommand: (cmd) => {
      commands.push(cmd);
      if (cmd.type === 'reset') {
        decisionSequence.push(JSON.stringify({ type: 'reset', reason: cmd.reason }));
      }
      // Production path, rather than dispatching directly.
      handlePipelineCommand(cmd, undefined, pipelines.commandDispatcher, pipelines.mediaSource, () => {});
    },
    onEvent: (_mediaType, evt) => {
      events.push(evt);
      const detail = JSON.stringify(evt, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      if (evt.type === 'skip_forward' || evt.type === 'partial_group_abandoned'
        || evt.type === 'backlog_shed' || evt.type === 'keyframe_waiting'
        || evt.type === 'gap_detected' || evt.type === 'track_ended'
        // Include recovery in the combined sequence so its ordering relative to
        // reset commands is observable across arms. (Recovery payloads are
        // already covered by the full event comparison; what this adds is
        // cross-channel ordering.)
        || evt.type === 'recovery') {
        decisionSequence.push(detail);
      }
      const guardBefore = syncResetThisTick;
      const resetsBefore = syncResetCalls;
      handlePipelineEvent('video', evt, {
        emitEvent: (e) => { bridgeEvents.push(JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); },
        log: { debug() {}, info() {}, warn() {}, error() {} } as never,
        syncController: pipelines.syncController,
        syncResetThisTick,
        setSyncResetThisTick: (v) => { syncResetThisTick = v; },
        recoveryHook: (a) => {
          recoveryActions.push(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
          return a;
        },
      });
      if (evt.type === 'skip_forward') {
        skipRecords.push({
          atUs: clock.now(),
          fromGroupId: String(evt.fromGroupId), toGroupId: String(evt.toGroupId),
          guardBefore, didReset: syncResetCalls > resetsBefore,
        });
      }
    },
  });
  configurePipelines(pipelines, trackInfo);

  // Count ACTUAL SyncController.reset() calls (see manual arm).
  const realSyncReset = pipelines.syncController.reset.bind(pipelines.syncController);
  pipelines.syncController.reset = (): void => { syncResetCalls++; realSyncReset(); };

  const pipeline = pipelines.videoPipeline!;

  const lastUs = Math.max(...trace.map((a) => a.completionUs)) + 5_000_000;
  for (const a of trace) {
    if (droppedGroups?.has(Math.floor(a.index / GOP))) continue;
    schedule(a.completionUs, 0, () => {
      if (BigInt(Math.floor(a.index / GOP)) < pipeline.currentGroupId) staleAtArrival.add(a.index);
      pipeline.pushObject(videoObject(a), videoHeaders(a));
    });
  }
  for (const eog of endOfGroupEntries(trace)) {
    if (droppedGroups?.has(eog.groupId)) continue;
    const atUs = eog.atUs + (eogDelay?.(eog.groupId) ?? 0);
    schedule(atUs, 0, () => { pipeline.pushObject(endOfGroupObject(eog.groupId, eog.lastObjectId)); });
  }
  loop.drain(lastUs, () => {
    syncResetThisTick = false;
    pipeline.tick();
  }, () => {
    while (rqueue.length > 0 && rqueue[0]!.renderTimeUs <= clock.now()) {
      const q = rqueue.shift()!;
      const idx = indexOfCapture.get(q.timestampUs);
      if (idx !== undefined) accounting.presented.add(idx);
      presentations.push({
        frame: idx ?? -1, captureUs: q.timestampUs, decodeOutUs: q.decodeOutUs,
        scheduledUs: q.renderTimeUs, actualUs: clock.now(),
      });
      renderer.onFrameRendered?.(BigInt(q.timestampUs), clock.now(), q.renderTimeUs);
    }
  }, () => pendingOps.size > 0 || rqueue.length > 0 || pipeline.bufferedGroupCount > 0);

  for (const a of trace) {
    if (!accounting.decodeSubmitted.has(a.index)) accounting.neverDecoded.add(a.index);
    else if (!accounting.presented.has(a.index)
      && !accounting.decoderResetDiscarded.has(a.index)
      && !accounting.rendererFlushDiscarded.has(a.index)) {
      throw new Error(`submitted frame ${a.index} has no terminal outcome`);
    }
  }

  const result: RunResult = {
    presentations, staleAtArrival, events, commands, gapTimeoutSamples, cushionSamples,
    accounting, decisionSequence, dependencyViolations,
    bridgeEvents, recoveryActions, skipRecords, decodeSubmissions,
  };
  return result;
}

/**
 * Parity is asserted on BOTH canonical traces. A clean trace alone is too
 * benign: no frame is late enough for `lateFrameThresholdMs` to act on, so a
 * config divergence in the factory arm would go undetected (found by mutating
 * the factory's drop threshold and watching parity still pass).
 */
const parityTraces: { name: string; opts: Parameters<typeof freezeTrace>[0] }[] = [
  { name: 'regime 1 (8Mbps keyframe burst)', opts: { capacityMbps: 8, seconds: 12 } },
  {
    name: 'regime 2 (repeating 500ms impairment)',
    opts: {
      capacityMbps: 20, seconds: 24,
      jitterUs: (i: number) => (i >= 180 && i % 90 === 0 ? 500_000 : 0),
    },
  },
];


/**
 * Production-default results.
 *
 * Everything above runs this suite's historical harness tuning — not a coherent
 * "core default" set. The shipping player differs materially, most
 * consequentially `lateFrameThresholdMs: 100` versus `SyncController`'s implicit
 * 500 ms default, so tuned numbers must never be presented as default-player
 * behaviour. These are gated, not merely logged.
 */
describe('real-class playout composition — production defaults', () => {
  const report = (name: string, floor: RunResult, adaptive: RunResult) => {
    const dF = decompose(floor.presentations), dA = decompose(adaptive.presentations);
    console.log(`\nPRODUCTION DEFAULTS — ${name}:\n    floor     ${fmt(dF)}\n    adaptive  ${fmt(dA)}\n`);
    return { dF, dA };
  };

  it('regime 1: the fixed floor still delivers cleanly and the cushion is pure cost', () => {
    const trace = freezeTrace({ capacityMbps: 8, seconds: 20 });
    // AUTHORITATIVE adaptive arm: built by `createPipelines()` and driven through
    // the production handlers. Behavioural parity with the manual arm is proven
    // on both canonical no-fuse traces, which is what licenses this promotion.
    const adaptive = runFactoryPath(trace, PRODUCTION_DEFAULT_CONFIG);
    // The floor arm stays MANUAL by necessity: no production "floor policy"
    // exists to build from the factory. It is an explicit counterfactual.
    const floor = runRealPath(trace, 'floor', PRODUCTION_DEFAULT_CONFIG);
    for (const arm of [floor, adaptive]) assertLosslessRun(trace, arm);
    const { dF, dA } = report('regime 1 (8Mbps keyframe burst)', floor, adaptive);

    // Floor freeze is sub-tick; the adaptive arm manufactures freeze AND latency.
    expect(dF.totalFreezeExcessUs).toBeLessThan(TICK_US);
    expect(dA.totalFreezeExcessUs).toBeGreaterThan(100_000);
    expect(dA.latencyP50Us).toBeGreaterThan(dF.latencyP50Us + 100_000);
  });

  it('regime 2: adaptation reduces starvation but costs MORE total freeze', () => {
    const trace = freezeTrace({
      capacityMbps: 20, seconds: 40,
      jitterUs: (i) => (i >= 180 && i % 90 === 0 ? 500_000 : 0),
    });
    const adaptive = runFactoryPath(trace, PRODUCTION_DEFAULT_CONFIG);
    const floor = runRealPath(trace, 'floor', PRODUCTION_DEFAULT_CONFIG);
    for (const arm of [floor, adaptive]) assertLosslessRun(trace, arm);
    const { dF, dA } = report('regime 2 (repeating 500ms impairment)', floor, adaptive);

    // Adaptation does buy readiness...
    expect(dA.starvationUs).toBeLessThan(dF.starvationUs / 2);
    // ...but converts it into MORE policy hold than it saves, so the visible
    // freeze burden is worse than the fixed floor — the reversal versus the
    // tuned config, where adaptive won this regime.
    expect(dA.holdUs).toBeGreaterThan(dF.holdUs * 2);
    expect(dA.totalFreezeExcessUs).toBeGreaterThan(dF.totalFreezeExcessUs * 1.2);
    // ...and it still charges latency for it.
    expect(dA.latencyP50Us).toBeGreaterThan(dF.latencyP50Us + 100_000);
  });
});

/**
 * One-factor attribution for the production-default reversal.
 *
 * The shipping 500 ms `gapTimeoutUs` is not the cause: with
 * `adaptiveTolerance` enabled,
 * `PlaybackPipeline.effectiveGapTimeoutUs` returns the ADAPTIVE value and every
 * `tick()` overwrites `gapDetector.gapTimeoutUs` with it, so the configured gap
 * timeout is largely replaced by observed jitter. This isolates each factor
 * instead of inferring.
 */
describe('real-class playout composition — one-factor attribution', () => {
  it('identifies which shipping default actually reverses regime 2', () => {
    const trace = freezeTrace({
      capacityMbps: 20, seconds: 40,
      jitterUs: (i) => (i >= 180 && i % 90 === 0 ? 500_000 : 0),
    });

    const factors: { name: string; cfg: HarnessConfig }[] = [
      { name: 'tuned baseline', cfg: TUNED_CONFIG },
      { name: 'gap timeout 200->500', cfg: { ...TUNED_CONFIG, gapTimeoutUs: 500_000 } },
      { name: 'drift 100->200', cfg: { ...TUNED_CONFIG, driftThresholdUs: 200_000 } },
      { name: 'buffer 240->500', cfg: { ...TUNED_CONFIG, maxBufferDepth: 500 } },
      { name: 'drop threshold 500->100', cfg: { ...TUNED_CONFIG, dropThresholdUs: 100_000 } },
      { name: 'all shipping defaults', cfg: PRODUCTION_DEFAULT_CONFIG },
    ];

    /** The decomposition fields the causal claim is about. */
    const shape = (d: ReturnType<typeof decompose>) => ({
      freeze: d.totalFreezeExcessUs, hold: d.holdUs,
      starve: d.starvationUs, lat: d.latencyP50Us,
    });

    const rows: string[] = [];
    const reversed: string[] = [];
    const results = new Map<string, {
      // BOTH arms: a neutral factor could shift the floor decomposition without
      // crossing the reversal boundary, and adaptive-only equality would miss it
      //.
      outcome: { floor: ReturnType<typeof shape>; adaptive: ReturnType<typeof shape> };
      gapSamples: number[];
      cushionSamples: number[];
    }>();

    for (const { name, cfg } of factors) {
      // Adaptive side through production construction, so the attribution is as
      // authoritative as the promoted default result. The floor arm stays manual
      // because no production floor policy exists to build from the factory.
      const floor = runRealPath(trace, 'floor', cfg);
      const adaptive = runFactoryPath(trace, cfg);
      // Every factor arm must be lossless, or its numbers mean nothing.
      assertLosslessRun(trace, floor);
      assertLosslessRun(trace, adaptive);

      const dF = decompose(floor.presentations), dA = decompose(adaptive.presentations);
      if (dA.totalFreezeExcessUs > dF.totalFreezeExcessUs) reversed.push(name);
      results.set(name, {
        outcome: { floor: shape(dF), adaptive: shape(dA) },
        gapSamples: adaptive.gapTimeoutSamples,
        cushionSamples: adaptive.cushionSamples,
      });
      rows.push(`${name.padEnd(24)} floorFreeze=${(dF.totalFreezeExcessUs / 1000).toFixed(0).padStart(5)}ms`
        + ` adaptFreeze=${(dA.totalFreezeExcessUs / 1000).toFixed(0).padStart(5)}ms`
        + ` ${dA.totalFreezeExcessUs > dF.totalFreezeExcessUs ? 'REVERSED' : 'adaptive wins'}`
        + `  adaptHold=${(dA.holdUs / 1000).toFixed(0).padStart(5)}ms`
        + ` lat50 f/a=${(dF.latencyP50Us / 1000).toFixed(0)}/${(dA.latencyP50Us / 1000).toFixed(0)}ms`);
    }
    console.log('\nONE-FACTOR ATTRIBUTION (regime 2):\n' + rows.join('\n')
      + `\n\nfactors that reverse the result: ${reversed.join(', ') || 'none'}\n`);

    // 1. EXACTLY these factors reverse the outcome.
    expect(reversed).toEqual(['drop threshold 500->100', 'all shipping defaults']);

    const baseline = results.get('tuned baseline')!;
    const neutralFactors = ['gap timeout 200->500', 'drift 100->200', 'buffer 240->500'];

    for (const name of neutralFactors) {
      const r = results.get(name)!;
      // 2. The cushion SIGNAL trajectory is untouched — the evidence that the
      //    configured gap timeout never reaches the render cushion.
      expect(r.gapSamples).toEqual(baseline.gapSamples);
      expect(r.cushionSamples).toEqual(baseline.cushionSamples);
      // 3. ...and so is the whole outcome decomposition, for BOTH arms.
      expect(r.outcome).toEqual(baseline.outcome);
    }

    // 4. The drop-threshold factor alone reproduces the full shipping-default
    //    outcome, which is what makes it the sole cause.
    expect(results.get('drop threshold 500->100')!.outcome)
      .toEqual(results.get('all shipping defaults')!.outcome);
    // 5. And it genuinely differs from baseline.
    expect(results.get('drop threshold 500->100')!.outcome).not.toEqual(baseline.outcome);
  });
});

/**
 * Behavioural factory parity — the authority boundary for any claim phrased as
 * production behaviour.
 *
 * Everything above assembles the real classes by hand. That leaves the question
 * the missing-`configurePipelines()` incident exposed: does the hand assembly
 * still behave identically to what the production factory wires? This drives the
 * SAME frozen trace and the SAME deterministic fakes through
 * `createPipelines()` + `configurePipelines()` and the production
 * command/event handlers, then requires per-frame parity with the manual
 * adaptive arm.
 */
describe('real-class playout composition — behavioural factory parity', () => {
  it.each(parityTraces)('the factory arm matches the manual one frame for frame — $name', ({ opts }) => {
    const trace = freezeTrace(opts);
    const manual = runRealPath(trace, 'adaptive');
    const factory = runFactoryPath(trace);

    assertLosslessRun(trace, manual);
    assertLosslessRun(trace, factory);

    // The COMPLETE command sequence by deep equality. An earlier normalizer
    // reduced every Uint8Array to `u8:<length>`, so two commands with different
    // bytes but equal length compared equal — and in this fixture key and delta
    // payloads are both 32 bytes, so payload divergence could pass while the
    // assertion claimed complete parity. Vitest compares bigints and typed
    // arrays directly, so no normalization is needed.
    expect(factory.commands).toEqual(manual.commands);

    // The signal trajectories under study — the policy itself.
    expect(factory.gapTimeoutSamples).toEqual(manual.gapTimeoutSamples);
    expect(factory.cushionSamples).toEqual(manual.cushionSamples);

    // Pipeline events, including the frame-rendered feedback-derived diagnostics
    // that an inert renderer callback would silently omit.
    const normalizeEvents = (r: RunResult) => r.events.map((e) => JSON.stringify(
      e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ));
    expect(normalizeEvents(factory)).toEqual(normalizeEvents(manual));

    // Presentations: identity, schedule and actual time.
    expect(factory.presentations.map((p) => [p.frame, p.scheduledUs, p.actualUs]))
      .toEqual(manual.presentations.map((p) => [p.frame, p.scheduledUs, p.actualUs]));

    // Fuse/recovery decisions and terminal accounting.
    expect(factory.decisionSequence).toEqual(manual.decisionSequence);
    expect([...factory.accounting.presented].sort((a, b) => a - b))
      .toEqual([...manual.accounting.presented].sort((a, b) => a - b));
    expect(factory.dependencyViolations).toEqual(manual.dependencyViolations);
  });
});

/**
 * Eventful positive control: delayed publisher FIN.
 *
 * Both canonical traces produce an empty fuse sequence, which leaves the
 * gap/recovery/sync-reset comparisons vacuous — correct by inspection only. This
 * control delays END_OF_GROUP delivery past the gap timeout so the pipeline
 * genuinely declares partial groups and drives those paths, letting parity cover
 * them and letting the per-tick sync-reset guard be mutation-checked.
 */
describe('real-class playout composition — delayed FIN control', () => {
  /** Every third group's FIN arrives 1.5 s late — well past the gap timeout. */
  const lateFin: EogDelay = (groupId) => (groupId % 3 === 1 ? 1_500_000 : 0);
  /**
 * And two groups are lost entirely, seconds apart. TWO skip-forwards on
 * SEPARATE ticks are required: the sync-reset guard only suppresses a second
 * reset within one tick, so a single skip cannot detect whether the guard is
 * cleared per tick.
 */
  const lostGroups: DroppedGroups = new Set([4, 8]);

  it('produces real playout decisions, not an empty sequence', () => {
    const trace = freezeTrace({ capacityMbps: 20, seconds: 24 });
    const r = runRealPath(trace, 'adaptive', TUNED_CONFIG, lateFin, lostGroups);

    // Pin the intended shape so a future trace change cannot silently collapse
    // back to a single skip, where the per-tick-guard mutation stops biting.
    const count = (t: string) => r.events.filter((e) => e.type === t).length;
    expect(count('partial_group_abandoned')).toBe(2);
    expect(count('skip_forward')).toBe(2);
    expect(count('recovery')).toBe(2);
    // Pin the corrected drift count. Before the schedule-based metric this trace
    // produced 590 `sync_drift` events purely from the playout cushion; the
    // remaining two are real schedule misses.
    expect(count('sync_drift')).toBe(2);

    // Settle the separate-tick question DIRECTLY from timestamped records
    // rather than inferring it from downstream behaviour.
    expect(r.skipRecords).toHaveLength(2);
    expect(r.skipRecords[0]!.atUs).not.toBe(r.skipRecords[1]!.atUs);
    expect(r.skipRecords.every((k) => k.didReset)).toBe(true);
    expect(r.skipRecords.every((k) => !k.guardBefore)).toBe(true);

    // The control must actually be eventful, or it controls nothing.
    expect(r.decisionSequence.length).toBeGreaterThan(0);
    // Payload checks keep the combined chronological record meaningful — a
    // sequence of bare type names would compare equal while saying nothing. The
    // cross-arm equality assertion below is what pins the interleaving.
    expect(r.decisionSequence.some((e) => e.includes('groupId') || e.includes('fromGroupId'))).toBe(true);
    const decisions = r.decisionSequence.map((e) => JSON.parse(e) as { type: string; reason?: string });
    expect(decisions.some((d) => d.type === 'recovery')).toBe(true);
    const resets = decisions.filter((d) => d.type === 'reset');
    expect(resets.length).toBeGreaterThan(0);
    // A real reason string, not merely the presence of the key.
    expect(resets.every((d) => typeof d.reason === 'string' && d.reason.length > 0)).toBe(true);
    const types = r.events.reduce<Record<string, number>>((acc, e) => {
      acc[e.type] = (acc[e.type] ?? 0) + 1; return acc;
    }, {});
    console.log(`\ndelayed-FIN control: ${r.decisionSequence.length} playout decisions; event types: `
      + Object.entries(types).map(([k, v]) => `${k}=${v}`).join(' ') + '\n');
  });

  it('manual and factory arms agree on playout decisions and terminal outcomes', () => {
    const trace = freezeTrace({ capacityMbps: 20, seconds: 24 });
    const manual = runRealPath(trace, 'adaptive', TUNED_CONFIG, lateFin, lostGroups);
    const factory = runFactoryPath(trace, TUNED_CONFIG, lateFin, lostGroups);

    // Non-empty by construction — this is what the canonical traces could not do.
    expect(manual.decisionSequence.length).toBeGreaterThan(0);
    expect(factory.decisionSequence).toEqual(manual.decisionSequence);

    // Complete command and event parity through the fuse paths.
    expect(factory.commands).toEqual(manual.commands);
    expect(factory.events.map((e) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))))
      .toEqual(manual.events.map((e) => JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));

    // Validate each arm IS a partition before comparing: both could omit or
    // double-classify the same identity and still compare equal.
    assertTerminalPartition(trace, manual);
    assertTerminalPartition(trace, factory);

    // The COMPLETE terminal partition, including non-presented outcomes — which
    // the lossless canonical traces could not exercise.
    const terminals = (r: RunResult) => ({
      presented: [...r.accounting.presented].sort((a, b) => a - b),
      resetDiscarded: [...r.accounting.decoderResetDiscarded].sort((a, b) => a - b),
      flushDiscarded: [...r.accounting.rendererFlushDiscarded].sort((a, b) => a - b),
      neverDecoded: [...r.accounting.neverDecoded].sort((a, b) => a - b),
    });
    expect(terminals(factory)).toEqual(terminals(manual));

    // Signal trajectories still match through recovery.
    expect(factory.gapTimeoutSamples).toEqual(manual.gapTimeoutSamples);
    expect(factory.cushionSamples).toEqual(manual.cushionSamples);

    // Bridge and recovery observations must agree...
    expect(factory.bridgeEvents).toEqual(manual.bridgeEvents);
    expect(factory.recoveryActions).toEqual(manual.recoveryActions);
    expect(factory.skipRecords).toEqual(manual.skipRecords);

    // ...and the FACTORY side must produce the expected outputs in its own
    // right. Shared-handler equality cannot validate the shared handler, so
    // deleting the production `recovery` case must still fail here.
    expect(factory.recoveryActions).toHaveLength(2);
    expect(factory.bridgeEvents.some((e) => e.includes('skip_forward'))).toBe(true);
    expect(factory.bridgeEvents.some((e) => e.includes('recovery_action'))).toBe(true);
  });
});

/**
 * Real-class adverse matrix at shipping defaults.
 *
 * These synthetic traces exercise the production factory at shipping defaults;
 * they do not reproduce a particular customer capture.
 *
 * Arms: the current adaptive policy (factory-built) against a fixed-floor
 * counterfactual (manual, because production has no floor policy to construct).
 * Every scenario asserts complete terminal accounting and dependency safety, so
 * no row's timing numbers can hide unaccounted loss or duplicated frames.
 */
describe('real-class adverse matrix — shipping defaults', () => {
  const MB = (n: number) => n * 1_000_000;

  interface Row {
    name: string;
    opts: Parameters<typeof freezeTrace>[0];
    /** Extra harness overrides, e.g. a post-anchor decoder slowdown. */
    harness?: Partial<HarnessConfig>;
    /** Groups the receiver never sees, for deliberate-loss rows. */
    lostGroups?: DroppedGroups;
    /** Require the trace to actually contain a cross-stream completion inversion. */
    expectInversion?: boolean;
    /**
     * Every row pins a meaningful outcome in addition to shared safety checks.
     */
    gate: (m: {
      a: ReturnType<typeof score>; f: ReturnType<typeof score>; o: ReturnType<typeof score>;
    }) => void;
  }

  const rows: Row[] = [
    {
      name: 'floor-feasible periodic keyframe burst',
      opts: { capacityMbps: 8, seconds: 20 },
      gate: ({ a, f }) => {
        // The floor holds cadence outright; the adaptive cushion manufactures
        // freeze and charges latency for headroom nothing needed.
        expect(f.freeze).toBeLessThan(TICK_US);
        expect(a.freeze).toBeGreaterThan(100_000);
        expect(a.hold).toBeGreaterThan(0);
        expect(a.latP50).toBeGreaterThan(f.latP50 + 100_000);
      },
    },
    {
      name: 'repeated supra-floor delay episodes',
      opts: {
        capacityMbps: 20, seconds: 40,
        jitterUs: (i) => (i >= 180 && i % 90 === 0 ? 500_000 : 0),
      },
      gate: ({ a, f }) => {
        // Stimulus is real...
        expect(f.freeze).toBeGreaterThan(1_000_000);
        // ...adaptation genuinely cuts starvation...
        expect(a.starve).toBeLessThan(f.starve / 2);
        // ...but converts it into hold, so total and worst freeze get WORSE,
        // quarter-second freezes multiply, and latency rises.
        expect(a.hold).toBeGreaterThan(f.hold);
        expect(a.freeze).toBeGreaterThan(f.freeze);
        expect(a.maxFreeze).toBeGreaterThan(f.maxFreeze);
        expect(a.over250).toBeGreaterThan(f.over250);
        expect(a.latP50).toBeGreaterThan(f.latP50);
      },
    },
    {
      name: 'post-anchor capacity step 50 -> 7 -> 50 Mbps',
      opts: {
        capacityMbps: 50, seconds: 30,
        capacitySchedule: [
          { fromUs: 0, bps: MB(50) },
          { fromUs: 8_000_000, bps: MB(7) },
          { fromUs: 20_000_000, bps: MB(50) },
        ],
      },
      gate: ({ f, o }) => {
        expect(f.freeze).toBeGreaterThan(500_000);
        expect(f.readinessMisses).toBeGreaterThan(0);
        expect(o.freeze).toBeLessThan(TICK_US);
      },
    },
    {
      name: 'post-anchor source step (small first GOPs, then 400KB keys)',
      opts: {
        capacityMbps: 8, seconds: 24,
        bytesFor: (i) => (i % GOP === 0 ? (i < 120 ? 60_000 : 400_000) : 15_000),
      },
      gate: ({ f, o }) => {
        expect(f.starve).toBeGreaterThan(1_000_000);
        expect(f.readinessMisses).toBeGreaterThan(0);
        expect(o.freeze).toBeLessThan(TICK_US);
      },
    },
    {
      name: 'post-anchor decoder stress after 8s (service > cadence)',
      opts: { capacityMbps: 50, seconds: 24 },
      harness: {
        // 45ms per frame against a 33.3ms cadence: the decoder genuinely falls
        // behind, unlike a gentler step the floor simply absorbs.
        decodeServiceUs: (bytes, captureUs) =>
          (captureUs < 8_000_000 ? 5_000 : (bytes > 100_000 ? 120_000 : 45_000)),
      },
      gate: ({ a, f, o }) => {
        expect(f.freeze).toBeGreaterThan(5_000_000);
        expect(f.latP95).toBeGreaterThan(5_000_000);
        expect(a.freeze).toBe(f.freeze);
        expect(o.freeze).toBeLessThan(TICK_US);
        expect(o.latP50).toBeGreaterThan(5_000_000);
      },
    },
    {
      name: 'floor-absorbed decoder step (inert control)',
      opts: { capacityMbps: 50, seconds: 16 },
      harness: {
        decodeServiceUs: (bytes) => (bytes > 100_000 ? 90_000 : 20_000),
      },
      gate: ({ a, f }) => {
        expect(a.freeze).toBeLessThan(TICK_US);
        expect(f.freeze).toBeLessThan(TICK_US);
        expect(f.readinessMisses).toBe(0);
      },
    },
    {
      name: 'cross-subgroup completion reordering',
      opts: {
        capacityMbps: 30, seconds: 24,
        // Delay the TAIL of each subgroup enough that the next subgroup's
        // objects, on their own stream, complete first.
        jitterUs: (i) => (i % GOP >= GOP - 3 ? 900_000 : 0),
      },
      expectInversion: true,
      gate: ({ f, o }) => {
        expect(f.presented).toBe(687);
        expect(f.freeze).toBeGreaterThan(1_000_000);
        expect(o.freeze).toBeGreaterThanOrEqual(33 * 1_000_000 / FPS);
      },
    },
    {
      name: 'repeated whole-group loss',
      opts: { capacityMbps: 30, seconds: 30 },
      lostGroups: new Set([3, 7, 11]),
      gate: ({ a, f, o }) => {
        for (const m of [a, f, o]) {
          expect(m.presented).toBe(720);
          expect(m.freeze).toBeGreaterThanOrEqual(6_000_000);
          expect(m.over250).toBe(3);
        }
      },
    },
    {
      name: 'bounded path jitter 0..20ms',
      opts: { capacityMbps: 20, seconds: 24, jitterUs: (i) => (i * 7919) % 20_000 },
      gate: ({ a, f }) => {
        expect(a.freeze).toBeLessThan(TICK_US);
        expect(f.freeze).toBeLessThan(TICK_US);
        expect(f.readinessMisses).toBe(0);
      },
    },
    {
      name: 'sustained overload 5.1Mbps media on 3Mbps link (control)',
      opts: { capacityMbps: 3, seconds: 24 },
      gate: ({ a, f, o }) => {
        expect(f.freeze).toBeGreaterThan(10_000_000);
        expect(f.latP95).toBeGreaterThan(10_000_000);
        expect(a.freeze).toBe(f.freeze);
        expect(o.freeze).toBeLessThan(TICK_US);
        // A finite offline readiness bound cannot promise sustainable live playout.
        expect(o.latP50).toBeGreaterThan(10_000_000);
      },
    },
  ];

  /**
   * Policy-independent readiness reference: the FIXED-FLOOR schedule for each
   * source frame. Counting `decodeOutUs > scheduledUs` per arm is not a common
   * baseline — raising the cushion moves that arm's own target later, so an arm
   * can "improve" readiness purely by deferring its deadline.
   */
  function floorReference(floorArm: RunResult): Map<number, number> {
    // Extrapolated arithmetically from the first frame's anchor at the STATIC
    // floor: `first.scheduled + (capture - first.capture)`. Reading each frame's
    // actual scheduled time instead would not be policy-independent — a frame
    // the pipeline judged late is scheduled at `clock.now()`, i.e. "present
    // immediately", which trivially satisfies any readiness test.
    const first = floorArm.presentations[0];
    if (first === undefined) return new Map();
    return new Map(floorArm.presentations.map((p) => [
      p.frame, first.scheduledUs + (p.captureUs - first.captureUs),
    ]));
  }

  /**
   * Score a set of presentations. `presentations` may be a phase window, in
   * which case every metric — including the frame count — derives from that
   * window rather than from whole-run accounting.
   */
  function score(
    presentations: readonly Presentation[],
    reference: Map<number, number>,
  ) {
    const d = decompose(presentations);
    const ps = presentations;
    let over100 = 0, over250 = 0;
    for (let i = 1; i < ps.length; i++) {
      const gap = ps[i]!.actualUs - ps[i - 1]!.actualUs;
      if (gap > 100_000) over100++;
      if (gap > 250_000) over250++;
    }
    const lat = ps.map((p) => p.actualUs - p.captureUs).sort((a, b) => a - b);
    const at = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
    // Readiness shortfall against the COMMON floor reference: frames whose
    // decode output missed the schedule a fixed-floor policy would have chosen.
    // Neither arm can improve this by moving its own deadline.
    const readinessMisses = ps.filter((p) => {
      const ref = reference.get(p.frame);
      return ref !== undefined && p.decodeOutUs > ref;
    }).length;
    return {
      freeze: d.totalFreezeExcessUs, maxFreeze: d.maxFreezeUs,
      starve: d.starvationUs, hold: d.holdUs,
      over100, over250, readinessMisses,
      latP50: at(0.5), latP95: at(0.95), latMax: lat[lat.length - 1] ?? 0,
      presented: ps.length,
    };
  }

  it('scores the current adaptive policy against a fixed floor on every adverse trace', () => {
    const lines: string[] = [];
    for (const { name, opts, harness, lostGroups, expectInversion, gate } of rows) {
      const cfg: HarnessConfig = { ...PRODUCTION_DEFAULT_CONFIG, ...harness };
      const trace = freezeTrace(opts);

      if (expectInversion) {
        // Prove the stimulus exists before scoring it: some later-indexed frame
        // must actually complete before an earlier one (cross-stream overtake).
        const inverted = trace.some((a, i) => trace.slice(0, i).some((b) => b.completionUs > a.completionUs));
        expect(inverted).toBe(true);
      }

      const adaptive = runFactoryPath(trace, cfg, undefined, lostGroups);
      const floor = runRealPath(trace, 'floor', cfg, undefined, lostGroups);
      // Readiness-only bound for the frames this floor run actually decoded.
      const readyOffsetUs = Math.max(
        FLOOR_US,
        ...floor.presentations.map((p) => p.decodeOutUs - p.captureUs),
      );
      const readySchedule = fixedReadinessSchedule(floor.presentations, readyOffsetUs);

      for (const arm of [adaptive, floor]) {
        // No row's numbers may rest on lost/duplicated frames or a broken
        // reference chain.
        assertTerminalPartition(trace, arm);
        if (expectInversion) {
          const tails = trace.filter((p) => p.index % GOP >= GOP - 3 && Math.floor(p.index / GOP) < 11);
          expect([...arm.accounting.neverDecoded].sort((a, b) => a - b)).toEqual(tails.map((p) => p.index));
          expect([...arm.staleAtArrival].sort((a, b) => a - b)).toEqual(tails.map((p) => p.index));
        } else if (lostGroups !== undefined) {
          const missing = trace.filter((p) => lostGroups.has(Math.floor(p.index / GOP)));
          expect([...arm.accounting.neverDecoded].sort((a, b) => a - b)).toEqual(missing.map((p) => p.index));
          expect(arm.staleAtArrival.size).toBe(0);
        } else {
          expect(arm.accounting.presented.size).toBe(trace.length);
          expect(arm.accounting.neverDecoded.size).toBe(0);
        }
        expect(arm.dependencyViolations).toEqual([]);
        // Early render is prohibited: nothing may present before it is decoded
        // or before its scheduled time.
        for (const p of arm.presentations) {
          expect(p.actualUs).toBeGreaterThanOrEqual(p.decodeOutUs);
          expect(p.actualUs).toBeGreaterThanOrEqual(p.scheduledUs);
        }
      }

      const ref = floorReference(floor);
      const a = score(adaptive.presentations, ref), f = score(floor.presentations, ref);
      const o = score(readySchedule, ref);
      expect(readySchedule.every((p) => p.decodeOutUs <= p.scheduledUs)).toBe(true);
      expect(readySchedule.map((p) => p.frame)).toEqual(floor.presentations.map((p) => p.frame));
      const skippedFrames = readySchedule.at(-1)!.frame - readySchedule[0]!.frame + 1 - readySchedule.length;
      expect(Math.abs(o.freeze - skippedFrames * 1_000_000 / FPS)).toBeLessThan(TICK_US);
      const fmt = (m: ReturnType<typeof score>) =>
        `frames=${m.presented}/${trace.length} freeze=${(m.freeze / 1000).toFixed(0).padStart(5)}ms`
        + ` (starve=${(m.starve / 1000).toFixed(0)} hold=${(m.hold / 1000).toFixed(0)})`
        + ` max=${(m.maxFreeze / 1000).toFixed(0).padStart(4)}ms >100=${String(m.over100).padStart(3)} >250=${String(m.over250).padStart(3)}`
        + ` readyMiss=${String(m.readinessMisses).padStart(4)}`
        + ` lat p50/p95/max=${(m.latP50 / 1000).toFixed(0)}/${(m.latP95 / 1000).toFixed(0)}/${(m.latMax / 1000).toFixed(0)}ms`;
      lines.push(`${name}\n    adaptive  ${fmt(a)}\n    floor     ${fmt(f)}\n    readiness ${fmt(o)}  (source offset ${(readyOffsetUs / 1000).toFixed(0)}ms)`);
      gate({ a, f, o });
    }
    console.log('\n=== ADVERSE MATRIX (shipping defaults, factory-built adaptive) ===\n'
      + lines.join('\n') + '\n');
    expect(lines).toHaveLength(rows.length);
  });

  // Separate the initial impairment from repetitions to measure learned headroom.
  it('pins the repeated-impairment tradeoff between starvation and policy hold', () => {
    // The first impaired GOP starts at 6s and ends before 8s.
    const FIRST_EPISODE_END_US = 8_000_000;
    const trace = freezeTrace({
      capacityMbps: 30, seconds: 48,
      // 300ms episodes — above the 200ms floor, below the fuse threshold.
      jitterUs: (i) => (i >= 180 && i % 90 === 0 ? 300_000 : 0),
    });
    const adaptive = runFactoryPath(trace, PRODUCTION_DEFAULT_CONFIG);
    const floor = runRealPath(trace, 'floor', PRODUCTION_DEFAULT_CONFIG);

    for (const arm of [adaptive, floor]) {
      assertTerminalPartition(trace, arm);
      expect(arm.dependencyViolations).toEqual([]);
      expect(arm.decisionSequence).toEqual([]); // fuse must NOT intervene
    }

    // All timing and frame-count metrics use only the selected window.
    const ref = floorReference(floor);
    const window = (r: RunResult, from: number, to: number) =>
      r.presentations.filter((p) => p.captureUs > from && p.captureUs <= to);
    const END_US = 48_000_000;

    const firstA = window(adaptive, 0, FIRST_EPISODE_END_US);
    const firstF = window(floor, 0, FIRST_EPISODE_END_US);
    const laterA = window(adaptive, FIRST_EPISODE_END_US, END_US);
    const laterF = window(floor, FIRST_EPISODE_END_US, END_US);
    // Both windows must be non-empty or the phase split is meaningless.
    for (const w of [firstA, firstF, laterA, laterF]) expect(w.length).toBeGreaterThan(0);

    const a = score(laterA, ref);
    const f = score(laterF, ref);

    const starvationSaved = f.starve - a.starve;
    const holdAdded = Math.max(0, a.hold - f.hold);

    console.log('\n=== REPEATED IMPAIRMENT (first episode excluded) ==='
      + `\n    adaptive  freeze=${(a.freeze / 1000).toFixed(0)}ms starve=${(a.starve / 1000).toFixed(0)}ms hold=${(a.hold / 1000).toFixed(0)}ms >250=${a.over250} latP50=${(a.latP50 / 1000).toFixed(0)}ms`
      + `\n    floor     freeze=${(f.freeze / 1000).toFixed(0)}ms starve=${(f.starve / 1000).toFixed(0)}ms hold=${(f.hold / 1000).toFixed(0)}ms >250=${f.over250} latP50=${(f.latP50 / 1000).toFixed(0)}ms`
      + `\n    starvation saved=${(starvationSaved / 1000).toFixed(0)}ms; hold added=${(holdAdded / 1000).toFixed(0)}ms\n`);

    expect(a.starve).toBeLessThan(f.starve * 0.5);
    expect(a.hold).toBeGreaterThan(f.hold);
    expect(a.freeze).toBeGreaterThan(f.freeze);
    expect(a.over250).toBeGreaterThan(f.over250);
    expect(holdAdded).toBeGreaterThan(starvationSaved);
    expect(a.presented).toBe(f.presented);
  });
});
