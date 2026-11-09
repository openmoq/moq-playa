import { OpusOutputTiming, type AudioSampleSpan, type OpusTimingSubmission } from './opus-output-timing.js';
import { inspectOpusHead } from './opus-source-packet.js';

/** Scalar timing ownership for one native AudioDecoder generation. No retained encoded bytes. */
export interface AudioTimingInput {
  readonly timestamp: number;
  duration: number | null;
  renderTimeUs: number | null;
  ambiguous: boolean;
}
export interface AudioTimingResult {
  readonly renderTimeUs: number;
  /** Null means input identity is unproven, even when all candidates agree on timing. */
  readonly input: AudioTimingInput | null;
  /** Present only when armed; null is unavailable, never an inferred zero. */
  readonly sourceOffsetUs?: number | null;
}

/**
 * WebCodecs §3.6 may suppress whole priming outputs or advance the first
 * emitted output's timestamp. FIFO cannot identify that output's input.
 * For initial-only priming (AAC/Opus), the first positive output exhausts
 * the remainder. Other registrations retain conservative interval matching.
 *
 * Input identity is only claimed on a unique timestamp match. When timestamp
 * matching yields no render time (missing LOC capture timestamps all collide at
 * 0, or the decoder synthesizes output timestamps that miss jittered inputs),
 * the render time falls back to the submitted-order queue: the nearest pending
 * timestamp within one frame duration, else the oldest pending submission.
 */
export class AudioOutputTiming {
  private readonly inputs = new Map<number, AudioTimingInput>();
  private retiredTimestampFloor = -Infinity;
  private outputSeen = false;
  private historyIncomplete = false;
  /** Every accepted native submission in decode order, until an output consumes it. */
  private pending: PendingSubmission[] = [];
  /** Submission the latest output matched by timestamp; further outputs on it still belong to it. */
  private lastOwner: number | null = null;
  private sourceProof: { tainted: boolean; seenOutput: boolean; outputs: WeakSet<AudioTimingInput>; initialPrimingOnly: boolean } | undefined;
  private opusProof: OpusOutputTiming | undefined;
  private failureReported = false;

  /** Arm before the first producing input; verify the codec's priming rule. */
  enableSourceTiming(initialPrimingOnly = this.initialPrimingOnly, opusDescription?: Uint8Array): void {
    if (this.sourceProof) return;
    const lateArm = this.historyIncomplete || this.inputs.size > 0 || this.outputSeen;
    this.sourceProof = { tainted: lateArm,
      seenOutput: false, outputs: new WeakSet(), initialPrimingOnly };
    if (opusDescription) this.opusProof = new OpusOutputTiming(inspectOpusHead(opusDescription), this.maxInputs, lateArm);
  }
  constructor(private readonly maxInputs = 256, private readonly initialPrimingOnly = true) {
    if (!Number.isSafeInteger(maxInputs) || maxInputs <= 0) throw new TypeError('Expected a positive safe timing limit');
  }

  remember(timestamp: number, duration: number | null | undefined, renderTimeUs: number, opus?: OpusTimingSubmission): AudioTimingInput | undefined {
    if (!Number.isSafeInteger(timestamp)) { this.opusProof?.remember(undefined); if (this.sourceProof) this.sourceProof.tainted = true; if (!this.outputSeen || !this.initialPrimingOnly) this.historyIncomplete = true; return; }
    const span = duration !== null && duration !== undefined && Number.isSafeInteger(duration) && duration > 0
      && Number.isSafeInteger(timestamp + duration) ? duration : null;
    const time = Number.isFinite(renderTimeUs) ? renderTimeUs : null;
    if (timestamp <= this.retiredTimestampFloor && !this.inputs.has(timestamp)) { this.opusProof?.remember(undefined); return; }
    this.pending.push({ timestamp, duration: span, renderTimeUs: time });
    if (this.pending.length > this.maxInputs) {
      // Pending overflow loses unresolved association, even if duplicate PTS
      // occupy just one entry in the identity map.
      if (this.sourceProof) this.sourceProof.tainted = true;
      this.pending.shift();
    }
    const old = this.inputs.get(timestamp);
    if (old) {
      // Repeated PTS remain ambiguous after output; never transfer ownership.
      old.ambiguous = true;
      this.opusProof?.remember(undefined);
      if (old.renderTimeUs !== time) old.renderTimeUs = null;
      old.duration = old.duration === null || span === null ? null : Math.max(old.duration, span);
      return;
    }
    if (this.inputs.size >= this.maxInputs) {
      const first = this.inputs.keys().next().value!;
      // AAC/Opus registrations §5 cannot add priming after the initial prefix.
      // WebCodecs §3.6 therefore leaves later outputs at their input PTS once
      // positive output exhausted that prefix. Consumed history can retire:
      // any extra PCM at its old PTS is fenced below, never rebound to a newer
      // input. This does not assert that all PCM from the input was emitted.
      // Pending loss, pre-output priming, and unverified registrations remain
      // unsafe; neither FIFO consumption nor a prior output proves identity.
      if (this.sourceProof && (!this.sourceProof.initialPrimingOnly || !this.outputSeen
          || this.pending.some(entry => entry.timestamp === first))) this.sourceProof.tainted = true;
      this.inputs.delete(first);
      this.retiredTimestampFloor = Math.max(this.retiredTimestampFloor, first);
      if (!this.outputSeen || !this.initialPrimingOnly) this.historyIncomplete = true;
    }
    const input: AudioTimingInput = { timestamp, duration: span, renderTimeUs: time, ambiguous: false };
    this.inputs.set(timestamp, input);
    this.opusProof?.remember(input, opus);
    return input;
  }

  poison(timestamp: number): void {
    this.opusProof?.poison();
    if (this.sourceProof) this.sourceProof.tainted = true;
    const input = this.inputs.get(timestamp);
    if (input) { input.ambiguous = true; input.renderTimeUs = null; }
    // The failed submission never reached the decoder, so no output will consume it.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.timestamp === timestamp) { this.pending.splice(i, 1); break; }
    }
  }

  resolve(timestamp: number, pcm?: AudioSampleSpan): AudioTimingResult {
    if (this.opusProof) {
      const result = this.opusProof.resolve(timestamp, pcm);
      this.outputSeen = true;
      if (result.input) {
        const index = this.pending.findIndex(entry => entry.timestamp === result.input!.timestamp);
        if (index >= 0) this.pending.splice(0, index + 1);
      }
      return result;
    }
    if (this.sourceProof && Number.isSafeInteger(timestamp) && timestamp <= this.retiredTimestampFloor && !this.inputs.has(timestamp)) {
      // An input may produce more than one PCM block. Retired PTS cannot supply
      // a source point or consume a fresh pending input via render fallback.
      // Keep refusal local; subsequent uniquely proved inputs may progress.
      this.outputSeen = true;
      this.sourceProof.seenOutput = true;
      return { renderTimeUs: 0, input: null, sourceOffsetUs: null };
    }
    const matched = this.match(timestamp);
    if (matched.renderTimeUs !== null && Number.isFinite(matched.renderTimeUs)) {
      // Outputs arrive in decode order: submissions before this one produced no output.
      const owner = matched.input?.timestamp ?? timestamp;
      const index = this.pending.findIndex(entry => entry.timestamp === owner);
      if (index >= 0) {
        this.pending.splice(0, index + 1);
        this.lastOwner = owner;
        return this.withSourceProof({ renderTimeUs: matched.renderTimeUs, input: matched.input }, timestamp);
      }
      // Common timing does not require a unique input: priming can move the
      // first output inside several unknown-duration spans that agree on time.
      // The agreed interval must still contain a pending submission; ambiguity
      // alone cannot make an already-consumed schedule current again.
      // Repeated outputs from the last matched input still belong to it.
      if (matched.pendingInterval === true || owner === this.lastOwner || this.pending.length === 0) {
        return this.withSourceProof({ renderTimeUs: matched.renderTimeUs, input: matched.input }, timestamp);
      }
      const stale = this.takePending(timestamp);
      return this.withSourceProof({ renderTimeUs: stale?.renderTimeUs ?? 0, input: null }, timestamp, true);
    }
    const fallback = this.takePending(timestamp);
    return this.withSourceProof({ renderTimeUs: fallback?.renderTimeUs ?? 0, input: matched.input }, timestamp);
  }

  private withSourceProof(result: AudioTimingResult, timestamp: number, stale = false): AudioTimingResult {
    const proof = this.sourceProof;
    if (!proof) return result;
    // Ambiguous duplicate/overlapping PTS only refuse THIS output. A timestamp
    // outside every retained input span, or a consumed stale collision, is
    // different: native time/history can no longer establish source position.
    const fits = Number.isSafeInteger(timestamp) && [...this.inputs.values()].some(input =>
      timestamp >= input.timestamp && (input.duration === null || timestamp < input.timestamp + input.duration));
    // Only verified initial-only registrations make a later out-of-history
    // native timestamp evidence of divergence. Unverified priming/matching is
    // refused locally; a later independently proved input may still recover.
    if (stale || !Number.isSafeInteger(timestamp) || (proof.seenOutput && proof.initialPrimingOnly && !fits)) proof.tainted = true;
    proof.seenOutput = true;
    const repeated = result.input !== null && proof.outputs.has(result.input);
    if (result.input) proof.outputs.add(result.input);
    // Input identity alone does not locate a second PCM block from that input.
    // Keep its start unavailable without separate sample-accounting evidence.
    const offset = result.input && !repeated ? timestamp - result.input.timestamp : null;
    return { ...result, sourceOffsetUs: !proof.tainted && offset !== null && Number.isSafeInteger(offset) && offset >= 0 ? offset : null };
  }

  /** Nearest pending timestamp within one frame (FIFO tie-break), else the oldest pending submission. */
  private takePending(timestamp: number): PendingSubmission | undefined {
    let index = -1;
    if (Number.isFinite(timestamp)) {
      let best = Infinity;
      this.pending.forEach((entry, i) => {
        const distance = Math.abs(entry.timestamp - timestamp);
        if (distance < best) { best = distance; index = i; }
      });
      // Select the timestamp before testing its span. Rounded durations can
      // differ for equal timestamps; a longer later span must not skip the
      // earlier submission when the decoder advances its own sample clock.
      const nearest = this.pending[index];
      if (!nearest || nearest.duration === null || best >= nearest.duration) index = -1;
    }
    if (index < 0) index = this.pending.findIndex(entry => entry.renderTimeUs !== null);
    if (index < 0) { this.pending.length = 0; return; }
    const entry = this.pending[index]!;
    this.pending.splice(0, index + 1);
    // An output paired by order proves nothing about its timestamp, so a later
    // exact match on this entry is a stale collision, not a further output.
    this.lastOwner = null;
    return entry;
  }

  private match(timestamp: number): { renderTimeUs: number | null; input: AudioTimingInput | null; pendingInterval?: boolean } {
    const canTrim = !this.outputSeen || !this.initialPrimingOnly;
    // The native callback proves positive output, even when association is refused.
    this.outputSeen = true;
    if (!Number.isSafeInteger(timestamp) || (canTrim && this.historyIncomplete)) return { renderTimeUs: null, input: null };
    if (!canTrim) {
      const input = this.inputs.get(timestamp);
      const time = input?.renderTimeUs;
      return { renderTimeUs: typeof time === 'number' && Number.isFinite(time) ? time : null,
        input: input && !input.ambiguous ? input : null };
    }
    let matched: AudioTimingInput | null = null, count = 0, commonTime: number | null | undefined;
    let pendingInterval = false;
    for (const input of this.inputs.values()) {
      const contains = timestamp >= input.timestamp && (input.duration === null || timestamp < input.timestamp + input.duration);
      if (!contains) continue;
      count++; matched = input;
      if (!pendingInterval) pendingInterval = this.pending.some(entry => entry.timestamp === input.timestamp);
      const time = input.renderTimeUs === null ? null : input.renderTimeUs + (timestamp - input.timestamp);
      commonTime = commonTime === undefined ? time : commonTime === time ? commonTime : null;
    }
    return { renderTimeUs: commonTime !== undefined && commonTime !== null && Number.isFinite(commonTime) ? commonTime : null,
      input: count === 1 && matched && !matched.ambiguous ? matched : null, pendingInterval };
  }

  clear(): void {
    this.inputs.clear(); this.retiredTimestampFloor = -Infinity; this.outputSeen = false; this.historyIncomplete = false; this.pending = []; this.lastOwner = null; this.sourceProof = undefined; this.opusProof = undefined; this.failureReported = false;
  }

  get usesOpusSamples(): boolean { return this.opusProof !== undefined; }
  get sourceTimingFailure(): string | null { return this.opusProof?.unavailableReason ?? null; }
  takeSourceTimingFailure(): string | null {
    if (this.failureReported || !this.sourceTimingFailure) return null;
    this.failureReported = true; return this.sourceTimingFailure;
  }
  finishSourceTiming(): void { this.opusProof?.finish(); }
}

interface PendingSubmission {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly renderTimeUs: number | null;
}
