/**
 * Deterministic link model for playout-timing simulations. TEST-ONLY.
 *
 * Lives outside `src/` deliberately: `packages/playback/tsconfig.json` compiles
 * every non-test file under `src` into the published `dist`, so a model placed
 * there would ship as product code. Import it from `src/*.sim.test.ts`.
 *
 * ## Why this exists
 *
 * Timing analyses need arrival times, and computing them ad-hoc is a trap: an
 * earlier analysis derived each frame's arrival independently of the frames
 * queued ahead of it, which let simulated time run BACKWARD after every
 * keyframe and invalidated the conclusion drawn from it. Causality here is
 * asserted by construction and covered by direct tests
 * (`src/serialized-link.sim.test.ts`).
 *
 * ## What this is not
 *
 * Not a general network model, and not a claim about MOQT delivery order.
 * Groups and subgroups ride independent QUIC streams and may complete out of
 * capture order; the gap fuse exists precisely to tolerate that. This model
 * therefore guarantees ordering only WITHIN a modeled stream, and guarantees
 * that the event queue dispatches completions in nondecreasing simulated time.
 * `fifo` is one explicitly named topology: a single work-conserving server
 * shared by all streams.
 *
 * @module
 */

/** One frame offered to the link. */
export interface LinkFrame {
  /** Caller-chosen identity, echoed on the completion. */
  readonly id: string;
  /** Frames on the same stream are served in offer order. */
  readonly streamId: string;
  /** When the encoder produced it (µs, simulation domain). */
  readonly captureUs: number;
  /** Payload size driving serialization time. */
  readonly bytes: number;
}

/** What the receiver observes: the moment the whole object is available. */
export interface LinkCompletion extends LinkFrame {
  /** Position in the model's own eligibility ordering — ground truth for per-stream order. */
  readonly offerIndex: number;
  /** Whole-object availability at the receiver (µs). */
  readonly completionUs: number;
  /** Time spent waiting for the server before transmission began (µs). */
  readonly queueDelayUs: number;
  /** Time spent transmitting (µs). */
  readonly serializationUs: number;
}

export interface SerializedLinkOptions {
  /** Named topology. `fifo`: one work-conserving server shared by all streams. */
  readonly topology: 'fifo';
  /** Service rate in bits per second. */
  readonly capacityBps: number;
  /** One-way delay added after transmission completes (µs). */
  readonly pathDelayUs: number;
  /**
 * Optional piecewise-constant capacity schedule, sorted by `fromUs`, the
 * first segment starting at 0. Service is INTEGRATED across segment
 * boundaries, so a capacity change part-way through an object affects the
 * bits still outstanding — start-sampling the rate would misprice exactly
 * the objects a capacity step is meant to stress. Every `bps`
 * must be strictly positive. Overrides `capacityBps` when present.
 */
  readonly capacitySchedule?: readonly { readonly fromUs: number; readonly bps: number }[];
  /**
 * Optional deterministic per-frame extra delay (µs), indexed by offer order.
 * CALLER OBLIGATION: must be pure (no Math.random) so runs replay identically.
 * The model cannot enforce purity; it only rejects negative delays.
 * Applied after transmission, so it can never precede send eligibility.
 */
  readonly jitterUs?: (index: number) => number;
}

export class SerializedLinkModel {
  private readonly opts: SerializedLinkOptions;
  private _overloaded: boolean | null = null;

  constructor(opts: SerializedLinkOptions) {
    if (!(opts.capacityBps > 0)) throw new Error('capacityBps must be > 0');
    if (opts.pathDelayUs < 0) throw new Error('pathDelayUs must be >= 0');
    this.opts = opts;
  }

  /**
 * True when offered load exceeded capacity over the caller-supplied source
 * duration; `null` when no duration was supplied. The model must not guess
 * the source interval from its own service span — a finite trace then
 * overestimates the offered rate and a single frame looks saturated
 *.
 */
  get overloaded(): boolean | null { return this._overloaded; }

  /**
 * Serve every frame and return completions in dispatch order.
 *
 * Service eligibility is `max(captureUs, whenTheServerIsFree, previousOnThisStream)`,
 * which is what makes the trace causal: a frame cannot begin transmitting
 * before it exists, before the server is free, or before its predecessor on
 * the same stream has finished.
 */
  run(frames: readonly LinkFrame[], observation?: { sourceDurationUs: number }): LinkCompletion[] {
    this._overloaded = null;
    const schedule = this.normalizedSchedule();

    /** Integrate `bits` from `startUs` across capacity segments. */
    const finishOf = (startUs: number, bits: number): number => {
      let t = startUs;
      let remaining = bits;
      let i = schedule.findIndex((seg, idx) => {
        const next = schedule[idx + 1];
        return t >= seg.fromUs && (next === undefined || t < next.fromUs);
      });
      if (i < 0) i = 0;
      while (remaining > 0) {
        const seg = schedule[i]!;
        const next = schedule[i + 1];
        const segmentEndUs = next?.fromUs ?? Number.POSITIVE_INFINITY;
        const usNeeded = (remaining * 1_000_000) / seg.bps;
        if (t + usNeeded <= segmentEndUs) return t + usNeeded;
        // Consume what this segment can carry, then continue in the next.
        remaining -= (segmentEndUs - t) * seg.bps / 1_000_000;
        t = segmentEndUs;
        i += 1;
      }
      return t;
    };
    // Deterministic tie-break: offer order. Sorting is stable in ES2019+, so
    // equal captureUs preserves the caller's ordering rather than an arbitrary one.
    const ordered = [...frames]
      .map((f, index) => ({ f, index }))
      .sort((a, b) => (a.f.captureUs - b.f.captureUs) || (a.index - b.index));
    // Offer order must be well defined before it can be asserted:
    // ids are used for reporting, so they must be unique, and a stream's frames
    // must be offered in nondecreasing capture order.
    const seenIds = new Set<string>();
    const lastCapturePerStream = new Map<string, number>();
    for (const f of frames) {
      if (seenIds.has(f.id)) throw new Error(`duplicate frame id ${f.id}`);
      seenIds.add(f.id);
      const prevCapture = lastCapturePerStream.get(f.streamId);
      if (prevCapture !== undefined && f.captureUs < prevCapture) {
        throw new Error(`stream ${f.streamId} offered out of capture order at ${f.id}`);
      }
      lastCapturePerStream.set(f.streamId, f.captureUs);
    }

    let serverFreeUs = 0;
    const streamFreeUs = new Map<string, number>();
    /** Last delivered completion per stream — enforces per-stream order under jitter. */
    const streamDeliveredUs = new Map<string, number>();
    const out: LinkCompletion[] = [];
    let totalBits = 0;
    let firstCaptureUs: number | undefined;
    let lastCaptureUs = 0;

    for (let offerIndex = 0; offerIndex < ordered.length; offerIndex++) {
      const { f } = ordered[offerIndex]!;
      if (f.bytes < 0) throw new Error(`negative bytes for frame ${f.id}`);
      const streamReadyUs = streamFreeUs.get(f.streamId) ?? 0;
      const startUs = Math.max(f.captureUs, serverFreeUs, streamReadyUs);
      const finishUs = Math.round(finishOf(startUs, f.bytes * 8));
      const serializationUs = finishUs - startUs;
      const extraUs = this.opts.jitterUs?.(offerIndex) ?? 0;
      if (extraUs < 0) throw new Error('jitterUs must be >= 0 — negative delay would break causality');

      serverFreeUs = finishUs;
      streamFreeUs.set(f.streamId, finishUs);
      totalBits += f.bytes * 8;
      if (firstCaptureUs === undefined) firstCaptureUs = f.captureUs;
      lastCaptureUs = Math.max(lastCaptureUs, f.captureUs);

      // Per-stream delivery order must survive jitter: a later object on the
      // SAME stream cannot be handed up before an earlier one, however the
      // per-frame delay falls. Cross-stream overtaking stays legal — that is
      // real MOQT behaviour and the gap fuse exists to tolerate it.
      const jittered = finishUs + this.opts.pathDelayUs + extraUs;
      const prevDeliveryUs = streamDeliveredUs.get(f.streamId);
      const completionUs = prevDeliveryUs === undefined ? jittered : Math.max(jittered, prevDeliveryUs);
      streamDeliveredUs.set(f.streamId, completionUs);

      out.push({
        ...f,
        serializationUs,
        queueDelayUs: startUs - f.captureUs,
        completionUs,
        offerIndex,
      });
    }

    // Dispatch order: nondecreasing completion time. Per-stream order is already
    // guaranteed by the eligibility rule above, so a stable sort cannot reorder
    // two frames of one stream.
    out.sort((a, b) => (a.completionUs - b.completionUs));

    // Overload is a property of the SOURCE. The generator knows its own
    // duration; the link must not infer it.
    if (observation !== undefined && observation.sourceDurationUs > 0) {
      // Compare offered bits with the bits the link could actually carry over
      // the same interval — with a variable schedule, a single nominal rate is
      // not a meaningful comparison.
      const availableBits = this.availableBits(0, observation.sourceDurationUs);
      this._overloaded = totalBits > availableBits;
    }
    void lastCaptureUs; void firstCaptureUs;

    this.assertCausal(out);
    return out;
  }

  /** Capacity segments, validated and sorted; a flat schedule when none given. */
  private normalizedSchedule(): readonly { fromUs: number; bps: number }[] {
    const raw = this.opts.capacitySchedule;
    if (raw === undefined || raw.length === 0) return [{ fromUs: 0, bps: this.opts.capacityBps }];
    const sorted = [...raw].sort((a, b) => a.fromUs - b.fromUs);
    if (sorted[0]!.fromUs !== 0) throw new Error('capacitySchedule must start at fromUs 0');
    for (let i = 0; i < sorted.length; i++) {
      const seg = sorted[i]!;
      if (!Number.isFinite(seg.fromUs)) throw new Error('capacitySchedule boundary must be finite');
      if (!Number.isFinite(seg.bps) || !(seg.bps > 0)) {
        throw new Error(`capacitySchedule segment at ${seg.fromUs} has a non-positive or non-finite rate`);
      }
      // Duplicate boundaries would silently resolve last-entry-wins.
      if (i > 0 && seg.fromUs === sorted[i - 1]!.fromUs) {
        throw new Error(`capacitySchedule has duplicate boundary at ${seg.fromUs}`);
      }
    }
    return sorted;
  }

  /** Bits the link can carry over [fromUs, toUs) under the schedule. */
  private availableBits(fromUs: number, toUs: number): number {
    const schedule = this.normalizedSchedule();
    let bits = 0;
    for (let i = 0; i < schedule.length; i++) {
      const segStart = Math.max(schedule[i]!.fromUs, fromUs);
      const segEnd = Math.min(schedule[i + 1]?.fromUs ?? toUs, toUs);
      if (segEnd > segStart) bits += (segEnd - segStart) * schedule[i]!.bps / 1_000_000;
    }
    return bits;
  }

  /**
 * Fail loudly rather than hand a caller a trace that cannot happen. This is
 * the check whose absence invalidated the earlier analysis.
 */
  private assertCausal(out: readonly LinkCompletion[]): void {
    /** Highest offer index already DISPATCHED for each stream. */
    const lastOfferIndex = new Map<string, number>();
    for (let i = 0; i < out.length; i++) {
      const c = out[i]!;
      if (i > 0 && c.completionUs < out[i - 1]!.completionUs) {
        throw new Error(`link model dispatched out of order at ${c.id}: ${c.completionUs} < ${out[i - 1]!.completionUs}`);
      }
      if (c.completionUs < c.captureUs + c.serializationUs + this.opts.pathDelayUs) {
        throw new Error(`link model completed ${c.id} before it could physically arrive`);
      }
      // Per-stream order is judged on DISPATCH order: as `out` is sorted by
      // completion, an inversion shows up as an offer index going backwards.
      // The previous formulation could never fire.
      const seen = lastOfferIndex.get(c.streamId);
      if (seen !== undefined && c.offerIndex < seen) {
        throw new Error(`link model reordered stream ${c.streamId} at ${c.id}: offer ${c.offerIndex} dispatched after ${seen}`);
      }
      lastOfferIndex.set(c.streamId, Math.max(seen ?? -1, c.offerIndex));
    }
  }
}
