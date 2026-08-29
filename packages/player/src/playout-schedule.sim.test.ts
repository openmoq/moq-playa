/**
 * Deterministic output-path simulation for playout timing policy.
 *
 * Composes the REAL `AdaptiveToleranceController` and `RenderCushionSmoother`
 * with a causal link, a dependency-ordered decoder model, and a renderer that
 * follows `CanvasRenderer`'s contract (FIFO, fixed-cadence ticks, stop at the
 * first frame whose scheduled time is still future — canvas-renderer.ts:104-168).
 *
 * Four arms run over IDENTICAL arrivals, decoder behaviour, anchor and ticks,
 * and all four feed the controller identically — only the RENDER cushion
 * differs:
 *
 *   adaptive — today's policy: smoothed adaptive gap timeout
 *   floor    — cushion pinned to the static floor (diagnostic control)
 *   oracle   — a constant offset chosen EXTERNALLY, from frame readiness only
 *   phase    — floor, then a raised constant after the first impairment
 *              (positive control; NOT a production candidate)
 *
 * The oracle is the reference for "was smooth playback feasible at all". Raw
 * arrival gaps are NOT a presentation oracle: absorbing them is exactly what a
 * playout buffer is for.
 *
 * Event phases are distinct and dispatched on one non-decreasing clock:
 *   object_complete -> controller.onFrameArrived()
 *   decode_output   -> cushion sampled, render time computed, frame enqueued
 *   render_tick     -> present due FIFO head(s)
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { AdaptiveToleranceController, DEFAULT_TOLERANCE_CONFIG } from '@moqt/playback';
import { RenderCushionSmoother, RENDER_CUSHION_MAX_US } from './render-cushion.js';
import { SerializedLinkModel } from '../../playback/test-support/serialized-link.js';

const MBPS = (n: number) => n * 1_000_000;

type CushionPolicy = 'adaptive' | 'floor' | 'oracle' | 'phase';

/**
 * Phase oracle: floor until `raiseAtUs`, then a raised constant. NOT a
 * production candidate — a positive control proving the harness and metrics can
 * represent the intended benefit of adaptation, i.e. paying latency once to
 * prevent later starvation.
 */
interface PhasePolicy { raiseAtUs: number; raisedUs: number; }

interface SessionOptions {
  capacityMbps: number;
  policy: CushionPolicy;
  fps?: number;
  gop?: number;
  keyBytes?: number;
  deltaBytes?: number;
  seconds?: number;
  pathDelayUs?: number;
  /** Decoder service time, constant or a function of payload bytes. */
  decodeServiceUs?: number | ((bytes: number, captureUs: number) => number);
  tickUs?: number;
  floorUs?: number;
  /** Piecewise-constant capacity schedule (capacity step / recovery). */
  capacitySchedule?: readonly { readonly fromUs: number; readonly bps: number }[];
  /** Per-frame payload override — lets the source itself step mid-trace. */
  bytesFor?: (i: number) => number;
  /** Per-frame stream identity — e.g. one subgroup stream per GOP. */
  streamIdFor?: (i: number) => string;
  /** Deterministic per-frame extra delay (retransmission spikes, path jitter). */
  jitterUs?: (i: number) => number;
  /** Supplied for the 'oracle' arm; computed by `feasibleOffsetUs()`. */
  oracleOffsetUs?: number;
}

interface Presentation {
  frame: number;
  key: boolean;
  captureUs: number;
  completionUs: number;
  decodeOutUs: number;
  scheduledUs: number;
  actualUs: number;
  cushionUs: number;
}

interface SessionResult {
  presentations: Presentation[];
  decodeOrder: number[];
  frameCount: number;
  anchorDeltaUs: number;
  worstCushionUs: number;
  /** Most frames presented on any single render tick. Cause attribution itself
 * lives in `metricsOf()`, computed pairwise from the presentation record. */
  maxCatchupBurst: number;
}

/**
 * An immutable arrival + decode trace. Built ONCE and shared by every policy
 * arm, so the arms cannot differ through anything but the cushion — rerunning a
 * callback-driven link per arm is only identical while callbacks stay pure
 *.
 */
interface ScenarioTrace {
  readonly completions: readonly { id: string; captureUs: number; bytes: number; completionUs: number }[];
  readonly outs: readonly { index: number; captureUs: number; completionUs: number; decodeOutUs: number }[];
  readonly frameCount: number;
  readonly gop: number;
  readonly tickUs: number;
  readonly floorUs: number;
  readonly anchorDeltaUs: number;
}


function buildFrames(
  o: { fps: number; gop: number; keyBytes: number; deltaBytes: number; seconds: number },
  bytesFor?: (i: number) => number,
  streamIdFor?: (i: number) => string,
) {
  const count = Math.round(o.fps * o.seconds);
  return Array.from({ length: count }, (_, i) => ({
    id: `f${i}`,
    streamId: streamIdFor?.(i) ?? 'video',
    captureUs: Math.round(i * (1_000_000 / o.fps)),
    bytes: bytesFor?.(i) ?? (i % o.gop === 0 ? o.keyBytes : o.deltaBytes),
  }));
}

function defaults(opts: SessionOptions) {
  return {
    fps: opts.fps ?? 30,
    gop: opts.gop ?? 60,
    keyBytes: opts.keyBytes ?? 400_000,
    deltaBytes: opts.deltaBytes ?? 15_000,
    seconds: opts.seconds ?? 20,
    pathDelayUs: opts.pathDelayUs ?? 20_000,
    tickUs: opts.tickUs ?? 16_667,
    floorUs: opts.floorUs ?? 200_000,
    decodeService: opts.decodeServiceUs ?? 5_000,
  };
}

/**
 * Decoder outputs, in DECODE ORDER. The decoder is serial and dependency-aware:
 * a frame cannot decode before it arrives, nor before its predecessor in decode
 * order finishes. Without this a cheap delta can be emitted before the keyframe
 * it depends on.
 */
function decodeOutputs(
  completions: readonly { id: string; captureUs: number; bytes: number; completionUs: number }[],
  serviceOf: (bytes: number, captureUs: number) => number,
) {
  const inDecodeOrder = [...completions].sort(
    (a, b) => a.captureUs - b.captureUs || Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
  let decoderFreeUs = 0;
  return inDecodeOrder.map((c) => {
    const startUs = Math.max(c.completionUs, decoderFreeUs);
    const outUs = startUs + serviceOf(c.bytes, c.captureUs);
    decoderFreeUs = outUs;
    return { ...c, index: Number(c.id.slice(1)), decodeOutUs: outUs };
  });
}

function buildTrace(opts: Omit<SessionOptions, 'policy' | 'oracleOffsetUs'>): ScenarioTrace {
  const d = defaults({ ...opts, policy: 'floor' });
  const serviceOf = (bytes: number, captureUs: number) => typeof d.decodeService === 'function' ? d.decodeService(bytes, captureUs) : d.decodeService;
  const link = new SerializedLinkModel({
    topology: 'fifo',
    capacityBps: MBPS(opts.capacityMbps),
    pathDelayUs: d.pathDelayUs,
    ...(opts.capacitySchedule ? { capacitySchedule: opts.capacitySchedule } : {}),
    ...(opts.jitterUs ? { jitterUs: opts.jitterUs } : {}),
  });
  const completions = link.run(
    buildFrames(d, opts.bytesFor, opts.streamIdFor),
    { sourceDurationUs: Math.round(d.seconds * 1_000_000) },
  );
  const outs = decodeOutputs(completions, serviceOf);
  return Object.freeze({
    completions: Object.freeze(completions),
    outs: Object.freeze(outs.map((o) => Object.freeze({ index: o.index, captureUs: o.captureUs, completionUs: o.completionUs, decodeOutUs: o.decodeOutUs }))),
    frameCount: Math.round(d.fps * d.seconds),
    gop: d.gop,
    tickUs: d.tickUs,
    floorUs: d.floorUs,
    anchorDeltaUs: outs[0]!.decodeOutUs - outs[0]!.captureUs,
  });
}

/**
 * Smallest constant cushion for which every frame is ready by
 * `capture + anchorDelta + offset` — derived from readiness alone, never from
 * the policy under test.
 */
function feasibleOffsetUs(trace: ScenarioTrace): number {
  const worstReadyOffset = Math.max(...trace.outs.map((o) => o.decodeOutUs - (o.captureUs + trace.anchorDeltaUs)));
  return Math.max(trace.floorUs, worstReadyOffset + trace.tickUs);
}

/** Event kinds, ordered for exact-time ties only: arrival < decode < render. */
const ARRIVAL = 0, DECODE = 1, RENDER = 2;

/**
 * Replay one policy over a frozen trace using ONE chronological event queue.
 * `nowUs` is assigned from the event time; it is never advanced with `Math.max`
 * as an ordering substitute.
 */
function runPolicy(trace: ScenarioTrace, policy: CushionPolicy, oracleOffsetUs?: number, phase?: PhasePolicy): SessionResult {
  const controller = new AdaptiveToleranceController(DEFAULT_TOLERANCE_CONFIG);
  let nowUs = 0;
  const smoother = new RenderCushionSmoother({ floorUs: trace.floorUs }, { now: () => nowUs });

  type Ev = { at: number; pri: number; seq: number; c?: ScenarioTrace['completions'][number]; o?: ScenarioTrace['outs'][number] };
  const events: Ev[] = [];
  let seq = 0;
  for (const c of trace.completions) events.push({ at: c.completionUs, pri: ARRIVAL, seq: seq++, c });
  for (const o of trace.outs) events.push({ at: o.decodeOutUs, pri: DECODE, seq: seq++, o });
  const lastEventUs = Math.max(...events.map((e) => e.at));
  for (let t = 0; t <= lastEventUs + 5_000_000; t += trace.tickUs) events.push({ at: t, pri: RENDER, seq: seq++ });
  events.sort((a, b) => a.at - b.at || a.pri - b.pri || a.seq - b.seq);

  const queue: Omit<Presentation, 'actualUs'>[] = [];
  const presentations: Presentation[] = [];
  const decodeOrder: number[] = [];
  let worstCushionUs = 0;
  let maxCatchupBurst = 0;

  for (const ev of events) {
    nowUs = ev.at;
    if (ev.pri === ARRIVAL) {
      const c = ev.c as ScenarioTrace['completions'][number];
      controller.onFrameArrived(c.completionUs / 1000, c.captureUs, c.completionUs / 1000);
    } else if (ev.pri === DECODE) {
      const o = ev.o as ScenarioTrace['outs'][number];
      const adaptiveUs = smoother.update(controller.effectiveGapTimeoutMs * 1000);
      const cushionUs = policy === 'adaptive' ? adaptiveUs
        : policy === 'floor' ? trace.floorUs
        : policy === 'phase' ? (o.captureUs >= (phase as PhasePolicy).raiseAtUs ? (phase as PhasePolicy).raisedUs : trace.floorUs)
        : (oracleOffsetUs as number);
      worstCushionUs = Math.max(worstCushionUs, cushionUs);
      decodeOrder.push(o.index);
      queue.push({
        frame: o.index, key: o.index % trace.gop === 0, captureUs: o.captureUs,
        completionUs: o.completionUs, decodeOutUs: o.decodeOutUs,
        scheduledUs: o.captureUs + trace.anchorDeltaUs + cushionUs, cushionUs,
      });
    } else {
      let presentedThisTick = 0;
      while (queue.length > 0 && queue[0]!.scheduledUs <= nowUs) {
        presentations.push({ ...(queue.shift() as Omit<Presentation, 'actualUs'>), actualUs: nowUs });
        presentedThisTick++;
      }
      maxCatchupBurst = Math.max(maxCatchupBurst, presentedThisTick);
    }
  }

  return {
    presentations, decodeOrder, frameCount: trace.frameCount,
    anchorDeltaUs: trace.anchorDeltaUs, worstCushionUs,
    maxCatchupBurst,
  };
}

function worstGapUs(ps: readonly Presentation[]): number {
  let g = 0;
  for (let i = 1; i < ps.length; i++) g = Math.max(g, ps[i]!.actualUs - ps[i - 1]!.actualUs);
  return g;
}

/** Mean capture-to-presentation latency — the cost side of any cushion policy. */
function meanLatencyUs(ps: readonly Presentation[]): number {
  return ps.reduce((a, p) => a + (p.actualUs - p.captureUs), 0) / ps.length;
}

/** Frame accounting: every frame presented exactly once, in order, never early. */
function expectWellFormed(r: SessionResult): void {
  expect(r.presentations.length).toBe(r.frameCount);
  expect(r.presentations.map((p) => p.frame)).toEqual([...Array(r.frameCount).keys()]);
  expect(r.decodeOrder).toEqual([...Array(r.frameCount).keys()]);
  for (const p of r.presentations) {
    expect(p.actualUs).toBeGreaterThanOrEqual(p.decodeOutUs);
    expect(p.actualUs).toBeGreaterThanOrEqual(p.scheduledUs);
  }
}

const CAPTURE_DELTA_US = Math.round(1_000_000 / 30);

/**
 * Playout metrics. The previous single count was named `missCount` but measured
 * only adjacent-interval pacing breaks: it could not distinguish a readiness
 * miss, a starved renderer, or total frozen time, and so could not adjudicate
 * "one long freeze vs several short holds".
 */
interface Metrics {
  /** Adjacent presentation intervals beyond capture cadence + one tick. */
  pacingBreakCount: number;
  /**
 * Frames whose decode output landed after the render time chosen for them.
 * `scheduledUs` is computed AT decode output, so this is a target-lateness /
 * headroom-shortfall measure, not a deadline fixed before decode began
 *.
 */
  readinessMissCount: number;
  /** Sum of max(0, gap - cadence): total time the picture was not advancing. */
  totalFreezeExcessUs: number;
  /** Longest single interval without a new frame. */
  maxFreezeUs: number;
  /** Freezes past perceptual thresholds. */
  freezesOver100ms: number;
  freezesOver250ms: number;
  /** Capture-to-presentation latency distribution. */
  latencyP50Us: number;
  latencyP95Us: number;
  latencyMaxUs: number;
  /**
 * Exact decomposition of `totalFreezeExcessUs`. For each
 * adjacent pair the overdue interval is split by what the player was actually
 * waiting on:
 *  - starvation: waiting for the frame to emerge from the decoder;
 *  - policy hold: decoded, but the cushion scheduled it later;
 *  - render quantization: ready and due, waiting for the next render tick.
 * These sum to `totalFreezeExcessUs` exactly.
 */
  starvationExcessUs: number;
  policyHoldExcessUs: number;
  renderQuantExcessUs: number;
}

function metricsOf(ps: readonly Presentation[], tickUs: number): Metrics {
  let pacingBreakCount = 0, totalFreezeExcessUs = 0, maxFreezeUs = 0;
  let freezesOver100ms = 0, freezesOver250ms = 0;
  for (let i = 1; i < ps.length; i++) {
    const gap = ps[i]!.actualUs - ps[i - 1]!.actualUs;
    // Expected advancement comes from THIS pair's capture spacing, so the
    // metric stays correct at any frame rate.
    const cadence = ps[i]!.captureUs - ps[i - 1]!.captureUs;
    if (gap > cadence + tickUs) pacingBreakCount++;
    const excess = Math.max(0, gap - cadence);
    totalFreezeExcessUs += excess;
    maxFreezeUs = Math.max(maxFreezeUs, gap);
    if (gap > 100_000) freezesOver100ms++;
    if (gap > 250_000) freezesOver250ms++;
  }
  // Headroom shortfall: the chosen render time was already in the past when the
  // frame emerged from the decoder.
  const readinessMissCount = ps.filter((p) => p.decodeOutUs > p.scheduledUs).length;

  // Pairwise cause decomposition. Attribution ends AT the presentation that
  // resolves the freeze, so the final overdue interval is charged rather than
  // discarded; a same-tick catch-up burst contributes zero positive gap for its
  // trailing frames, which falls out naturally.
  let starvationExcessUs = 0, policyHoldExcessUs = 0, renderQuantExcessUs = 0;
  for (let i = 1; i < ps.length; i++) {
    const prev = ps[i - 1]!, cur = ps[i]!;
    const expectedUs = prev.actualUs + (cur.captureUs - prev.captureUs);
    const endUs = cur.actualUs;
    if (endUs <= expectedUs) continue;
    starvationExcessUs += Math.max(0, Math.min(endUs, cur.decodeOutUs) - expectedUs);
    const holdStartUs = Math.max(expectedUs, cur.decodeOutUs);
    policyHoldExcessUs += Math.max(0, Math.min(endUs, cur.scheduledUs) - holdStartUs);
    renderQuantExcessUs += Math.max(0, endUs - Math.max(expectedUs, cur.decodeOutUs, cur.scheduledUs));
  }
  const lat = ps.map((p) => p.actualUs - p.captureUs).sort((a, b) => a - b);
  const at = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
  return {
    pacingBreakCount, readinessMissCount, totalFreezeExcessUs, maxFreezeUs,
    freezesOver100ms, freezesOver250ms,
    latencyP50Us: at(0.5), latencyP95Us: at(0.95), latencyMaxUs: lat[lat.length - 1] ?? 0,
    starvationExcessUs, policyHoldExcessUs, renderQuantExcessUs,
  };
}

function fmtMetrics(m: Metrics): string {
  return `breaks=${String(m.pacingBreakCount).padStart(3)} readyMiss=${String(m.readinessMissCount).padStart(3)}`
    + ` freezeTotal=${(m.totalFreezeExcessUs / 1000).toFixed(0).padStart(5)}ms max=${(m.maxFreezeUs / 1000).toFixed(0).padStart(4)}ms`
    + ` >100ms=${String(m.freezesOver100ms).padStart(2)} >250ms=${String(m.freezesOver250ms).padStart(2)}`
    + ` lat p50/p95=${(m.latencyP50Us / 1000).toFixed(0)}/${(m.latencyP95Us / 1000).toFixed(0)}ms`;
}



describe('playout schedule — decoder model', () => {
  it('never emits a dependent frame before the keyframe it follows', () => {
    // Expensive keyframe decode, cheap deltas: a non-dependency-aware model
    // would emit delta 1 before keyframe 0.
    const trace = buildTrace({
      capacityMbps: 50, seconds: 6,
      decodeServiceUs: (bytes) => (bytes > 100_000 ? 100_000 : 5_000),
    });
    const r = runPolicy(trace, 'floor');
    expect(r.decodeOrder).toEqual([...Array(r.frameCount).keys()]);
    expectWellFormed(r);
  });
});

describe('playout schedule — arms over one frozen trace', () => {
  it('presents at capture cadence on a fast link under every policy', () => {
    const trace = buildTrace({ capacityMbps: 100, seconds: 12 });
    const oracle = feasibleOffsetUs(trace);
    for (const policy of ['adaptive', 'floor', 'oracle'] as CushionPolicy[]) {
      const r = runPolicy(trace, policy, oracle);
      expectWellFormed(r);
      expect(worstGapUs(r.presentations)).toBeLessThanOrEqual(CAPTURE_DELTA_US + trace.tickUs);
    }
  });

  it('reproduces policy-induced pacing variation on a floor-feasible trace', () => {
    // 8 Mbps: the keyframe burst queues, yet the externally derived feasible
    // offset equals the STATIC FLOOR — so smooth playback needs no adaptation.
    const trace = buildTrace({ capacityMbps: 8, seconds: 20 });
    const oracleOffsetUs = feasibleOffsetUs(trace);
    const bound = CAPTURE_DELTA_US + trace.tickUs;

    // Feasibility is established independently of any policy.
    expect(oracleOffsetUs).toBe(trace.floorUs);

    const adaptive = runPolicy(trace, 'adaptive');
    const floor = runPolicy(trace, 'floor');
    const oracle = runPolicy(trace, 'oracle', oracleOffsetUs);
    for (const r of [adaptive, floor, oracle]) expectWellFormed(r);

    // Both references are smooth...
    expect(worstGapUs(floor.presentations)).toBeLessThanOrEqual(bound);
    expect(worstGapUs(oracle.presentations)).toBeLessThanOrEqual(bound);
    // ...and today's adaptive policy is not, on the very same trace.
    expect(worstGapUs(adaptive.presentations)).toBeGreaterThan(bound);

    // The adaptive arm pays for that with a cushion well above the floor...
    expect(adaptive.worstCushionUs).toBeGreaterThan(trace.floorUs);
    // ...and with higher capture-to-presentation latency.
    expect(meanLatencyUs(floor.presentations)).toBeLessThan(meanLatencyUs(adaptive.presentations));
    // Causal story for THIS regime: the adaptive arm's extra non-advancement is
    // policy HOLD, not starvation — it is withholding frames it already has,
    // and it starves no less than the floor does.
    const mAdaptive = metricsOf(adaptive.presentations, trace.tickUs);
    const mFloor = metricsOf(floor.presentations, trace.tickUs);
    expect(mAdaptive.policyHoldExcessUs).toBeGreaterThan(mFloor.policyHoldExcessUs);
    expect(mAdaptive.starvationExcessUs).toBeLessThanOrEqual(mFloor.starvationExcessUs);
  });

  it('pins where the adaptive arm loses cadence: at a keyframe', () => {
    const trace = buildTrace({ capacityMbps: 8, seconds: 20 });
    const ps = runPolicy(trace, 'adaptive').presentations;
    let worst = 0, atIdx = -1;
    for (let i = 1; i < ps.length; i++) {
      const g = ps[i]!.actualUs - ps[i - 1]!.actualUs;
      if (g > worst) { worst = g; atIdx = i; }
    }
    expect([ps[atIdx - 1]!, ps[atIdx]!].some((p) => p.key)).toBe(true);
  });

  it('holds the scheduler identity scheduledDelta = captureDelta + cushionDelta', () => {
    const trace = buildTrace({ capacityMbps: 8, seconds: 20 });
    const byFrame = [...runPolicy(trace, 'adaptive').presentations].sort((a, b) => a.frame - b.frame);
    for (let i = 1; i < byFrame.length; i++) {
      const scheduledDelta = byFrame[i]!.scheduledUs - byFrame[i - 1]!.scheduledUs;
      const captureDelta = byFrame[i]!.captureUs - byFrame[i - 1]!.captureUs;
      const cushionDelta = byFrame[i]!.cushionUs - byFrame[i - 1]!.cushionUs;
      // Numeric precision only — the identity is exact in intent.
      expect(scheduledDelta).toBeCloseTo(captureDelta + cushionDelta, 6);
    }
  });

  it('compares worst presentation gap across arms and gates the floor arm', () => {
    const rows: string[] = [];
    for (const capacityMbps of [8, 12, 20, 50]) {
      const trace = buildTrace({ capacityMbps, seconds: 20 });
      const oracleOffsetUs = feasibleOffsetUs(trace);
      const bound = CAPTURE_DELTA_US + trace.tickUs;
      const arms = {
        adaptive: runPolicy(trace, 'adaptive'),
        floor: runPolicy(trace, 'floor'),
        oracle: runPolicy(trace, 'oracle', oracleOffsetUs),
      };
      for (const r of Object.values(arms)) expectWellFormed(r);
      const g = (k: keyof typeof arms) => worstGapUs(arms[k].presentations);
      // Gate: on every one of these traces the floor arm holds capture cadence.
      expect(g('floor')).toBeLessThanOrEqual(bound);
      expect(g('oracle')).toBeLessThanOrEqual(bound);
      rows.push(`${String(capacityMbps).padStart(3)}Mbps  adaptive=${(g('adaptive') / 1000).toFixed(1).padStart(6)}ms  floor=${(g('floor') / 1000).toFixed(1).padStart(6)}ms  oracle=${(g('oracle') / 1000).toFixed(1).padStart(6)}ms  (feasible offset=${(oracleOffsetUs / 1000).toFixed(0)}ms, anchor=${(trace.anchorDeltaUs / 1000).toFixed(0)}ms)`);
    }
    console.log('\nworst presentation gap by cushion policy:\n' + rows.join('\n') + '\n');
  });
});

/**
 * Adverse traces: cases where ADAPTATION should earn its keep. Every impairment
 * lands AFTER the anchor, so the opening buffer cannot have pre-absorbed it.
 *
 * Each row also reports the constant readiness oracle, so a reader can tell
 * whether smooth playback was feasible at all on that trace.
 */
describe('playout schedule — adverse traces', () => {
  const MB = (n: number) => n * 1_000_000;

  const scenarios: { name: string; opts: Omit<SessionOptions, 'policy' | 'oracleOffsetUs'> }[] = [
    {
      name: 'source step (small first GOP, then 400KB keys)',
      opts: { capacityMbps: 8, seconds: 24, bytesFor: (i) => (i % 60 === 0 ? (i < 120 ? 60_000 : 400_000) : 15_000) },
    },
    {
      name: 'capacity step 50 -> 7 -> 50 Mbps',
      opts: {
        capacityMbps: 50, seconds: 30,
        capacitySchedule: [{ fromUs: 0, bps: MB(50) }, { fromUs: 8_000_000, bps: MB(7) }, { fromUs: 20_000_000, bps: MB(50) }],
      },
    },
    {
      name: 'recurring 150ms delay spikes',
      opts: { capacityMbps: 20, seconds: 24, jitterUs: (i) => (i > 150 && i % 90 === 0 ? 150_000 : 0) },
    },
    {
      name: 'bounded extra delay 0..20ms',
      opts: { capacityMbps: 20, seconds: 24, jitterUs: (i) => (i * 7919) % 20_000 },
    },
    {
      name: 'per-GOP subgroup streams (cross-stream reordering)',
      opts: {
        capacityMbps: 12, seconds: 24,
        streamIdFor: (i) => `g${Math.floor(i / 60)}`,
        jitterUs: (i) => (i % 60 === 0 ? 40_000 : 0),
      },
    },
    {
      name: 'post-anchor decoder slowdown (after 8s)',
      opts: {
        capacityMbps: 50, seconds: 24,
        decodeServiceUs: (bytes, captureUs) =>
          captureUs < 8_000_000 ? 5_000 : (bytes > 100_000 ? 90_000 : 20_000),
      },
    },
    {
      name: 'recurring 400ms spikes (2x floor)',
      opts: { capacityMbps: 20, seconds: 30, jitterUs: (i) => (i > 150 && i % 90 === 0 ? 400_000 : 0) },
    },
    {
      name: 'recurring 800ms spikes (4x floor)',
      opts: { capacityMbps: 20, seconds: 30, jitterUs: (i) => (i > 150 && i % 120 === 0 ? 800_000 : 0) },
    },
  ];

  it('scores adaptive against the fixed floor, with feasibility shown per trace', () => {
    const rows: string[] = [];
    for (const { name, opts } of scenarios) {
      const trace = buildTrace(opts);
      const oracleOffsetUs = feasibleOffsetUs(trace);
      const adaptive = runPolicy(trace, 'adaptive');
      const floor = runPolicy(trace, 'floor');
      expectWellFormed(adaptive);
      expectWellFormed(floor);
      const ma = metricsOf(adaptive.presentations, trace.tickUs);
      const mf = metricsOf(floor.presentations, trace.tickUs);
      const feasible = oracleOffsetUs <= RENDER_CUSHION_MAX_US;
      rows.push(`${name}  [oracle=${(oracleOffsetUs / 1000).toFixed(0)}ms ${feasible ? 'within' : 'ABOVE'} render cap]`
        + `\n    adaptive  ${fmtMetrics(ma)}\n    floor     ${fmtMetrics(mf)}`);

      // Gate: neither arm may lose or reorder frames on any adverse trace.
      expect(adaptive.presentations.length).toBe(trace.frameCount);
      expect(floor.presentations.length).toBe(trace.frameCount);
    }
    console.log('\n--- adverse traces ---\n' + rows.join('\n') + '\n');
  });

  it('sustained overload is not solvable by any fixed cushion', () => {
    const trace = buildTrace({ capacityMbps: 3, seconds: 24 });
    const adaptive = runPolicy(trace, 'adaptive');
    const floor = runPolicy(trace, 'floor');
    for (const r of [adaptive, floor]) expectWellFormed(r);
    const bound = CAPTURE_DELTA_US + trace.tickUs;
    expect(metricsOf(adaptive.presentations, trace.tickUs).maxFreezeUs).toBeGreaterThan(bound);
    expect(metricsOf(floor.presentations, trace.tickUs).maxFreezeUs).toBeGreaterThan(bound);
  });
});

/**
 * POSITIVE CONTROL. Before concluding anything about whether
 * adaptation helps, the harness must be able to show a win when a deliberately
 * helpful policy is used. The phase oracle pays latency once, after the first
 * impairment, and holds that headroom for the repeats.
 *
 * If this control cannot beat the floor, the harness cannot validate adaptation
 * and no conclusion about the adaptive policy is admissible.
 */
describe('playout schedule — positive control (phase oracle)', () => {
  const opts = {
    capacityMbps: 20, seconds: 40,
    // One unavoidable first episode at ~6s, then the SAME impairment repeatedly.
    jitterUs: (i: number) => (i >= 180 && i % 90 === 0 ? 500_000 : 0),
  } as const;

  it('a policy that buys headroom after the first episode beats the floor on freezes', () => {
    const trace = buildTrace(opts);
    const floor = runPolicy(trace, 'floor');
    // Raise after the first episode (6s) to cover the 500ms impairment.
    const phase = runPolicy(trace, 'phase', undefined, { raiseAtUs: 6_500_000, raisedUs: 700_000 });
    expectWellFormed(floor);
    expectWellFormed(phase);

    const mFloor = metricsOf(floor.presentations, trace.tickUs);
    const mPhase = metricsOf(phase.presentations, trace.tickUs);
    console.log(`\npositive control (repeating 500ms episodes):\n    floor  ${fmtMetrics(mFloor)}\n    phase  ${fmtMetrics(mPhase)}\n`);

    // The control must demonstrably reduce freezing — otherwise the metrics
    // cannot express the benefit adaptation is supposed to provide.
    expect(mPhase.totalFreezeExcessUs).toBeLessThan(mFloor.totalFreezeExcessUs);
    expect(mPhase.freezesOver250ms).toBeLessThan(mFloor.freezesOver250ms);
    // ...and it pays for that in latency, which the metrics must also show.
    expect(mPhase.latencyP50Us).toBeGreaterThan(mFloor.latencyP50Us);
  });

  it('gates the adaptive tradeoff on repeated supra-floor impairment', () => {
    const trace = buildTrace(opts);
    const adaptive = runPolicy(trace, 'adaptive');
    const floor = runPolicy(trace, 'floor');
    expectWellFormed(adaptive);
    expectWellFormed(floor);
    const mA = metricsOf(adaptive.presentations, trace.tickUs);
    const mF = metricsOf(floor.presentations, trace.tickUs);
    console.log(`\nsame trace, current policy:\n    floor     ${fmtMetrics(mF)}\n    adaptive  ${fmtMetrics(mA)}`
      + `\n    floor  starve=${(mF.starvationExcessUs / 1000).toFixed(0)}ms hold=${(mF.policyHoldExcessUs / 1000).toFixed(0)}ms tick=${(mF.renderQuantExcessUs / 1000).toFixed(0)}ms catchup=${floor.maxCatchupBurst}`
      + `\n    adapt  starve=${(mA.starvationExcessUs / 1000).toFixed(0)}ms hold=${(mA.policyHoldExcessUs / 1000).toFixed(0)}ms tick=${(mA.renderQuantExcessUs / 1000).toFixed(0)}ms catchup=${adaptive.maxCatchupBurst}\n`);

    // What adaptation buys here...
    expect(mA.totalFreezeExcessUs).toBeLessThan(mF.totalFreezeExcessUs);
    expect(mA.readinessMissCount).toBeLessThan(mF.readinessMissCount);
    expect(mA.freezesOver250ms).toBeLessThan(mF.freezesOver250ms);
    // ...and what it costs.
    expect(mA.latencyP50Us).toBeGreaterThan(mF.latencyP50Us);
    expect(mA.pacingBreakCount).toBeGreaterThan(mF.pacingBreakCount);
    // Causal story: adaptation reduces STARVATION specifically — it is buying
    // readiness, not merely rearranging holds.
    expect(mA.starvationExcessUs).toBeLessThan(mF.starvationExcessUs);
  });
});

/**
 * Discriminators for freeze-cause attribution. The first is the
 * test that would have caught the original defect: counting bare
 * zero-presentation ticks made ordinary 30 fps-on-60 Hz cadence look like
 * thousands of holds.
 */
describe('playout schedule — freeze cause attribution', () => {
  it('charges nothing on a clean trace, despite rendering at twice the frame rate', () => {
    // 30 fps source, 60 Hz render clock: half of all ticks present nothing and
    // every one of them is correct behaviour.
    const trace = buildTrace({ capacityMbps: 100, seconds: 12 });
    const r = runPolicy(trace, 'floor');
    expectWellFormed(r);
    const m = metricsOf(r.presentations, trace.tickUs);
    expect(m.starvationExcessUs).toBe(0);
    expect(m.policyHoldExcessUs).toBe(0);
  });

  it('attributes a late undecoded frame to starvation, not to policy', () => {
    // One 500ms delivery spike on an otherwise clean link: the frame simply is
    // not there yet, so no cushion policy could have shown it.
    const trace = buildTrace({
      capacityMbps: 50, seconds: 16,
      jitterUs: (i) => (i === 240 ? 500_000 : 0),
    });
    const r = runPolicy(trace, 'floor');
    expectWellFormed(r);
    const m = metricsOf(r.presentations, trace.tickUs);
    expect(m.starvationExcessUs).toBeGreaterThan(0);
    expect(m.policyHoldExcessUs).toBe(0);
  });

  it('attributes a deliberately deferred but decoded frame to policy hold', () => {
    // Clean delivery throughout; the phase policy raises the cushion mid-stream,
    // so frames already decoded are withheld. That is policy, not starvation.
    const trace = buildTrace({ capacityMbps: 100, seconds: 16 });
    const r = runPolicy(trace, 'phase', undefined, { raiseAtUs: 6_000_000, raisedUs: 600_000 });
    expectWellFormed(r);
    const m = metricsOf(r.presentations, trace.tickUs);
    expect(m.policyHoldExcessUs).toBeGreaterThan(0);
    expect(m.starvationExcessUs).toBe(0);
  });

  it('decomposes freeze excess exactly, leaving nothing unexplained', () => {
    // starvation + policy hold + render quantization == total freeze excess.
    // The previous one-sided bound allowed nearly half of adaptive freeze time
    // to go unattributed.
    const traces = [
      ...[8, 20, 100].map((capacityMbps) => buildTrace({ capacityMbps, seconds: 20 })),
      // The canonical repeating supra-floor trace carries the stated tradeoff,
      // so it must be inside the accounting gate too.
      buildTrace({ capacityMbps: 20, seconds: 40, jitterUs: (i) => (i >= 180 && i % 90 === 0 ? 500_000 : 0) }),
    ];
    for (const trace of traces) {
      for (const policy of ['adaptive', 'floor'] as CushionPolicy[]) {
        const m = metricsOf(runPolicy(trace, policy).presentations, trace.tickUs);
        expect(m.starvationExcessUs + m.policyHoldExcessUs + m.renderQuantExcessUs)
          .toBeCloseTo(m.totalFreezeExcessUs, 6);
      }
    }
  });
});
