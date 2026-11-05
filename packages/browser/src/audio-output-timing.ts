/** Scalar timing ownership for one native AudioDecoder generation. No encoded bytes. */
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
  constructor(private readonly maxInputs = 256, private readonly initialPrimingOnly = true) {
    if (!Number.isSafeInteger(maxInputs) || maxInputs <= 0) throw new TypeError('Expected a positive safe timing limit');
  }

  remember(timestamp: number, duration: number | null | undefined, renderTimeUs: number): AudioTimingInput | undefined {
    if (!Number.isSafeInteger(timestamp)) { if (!this.outputSeen || !this.initialPrimingOnly) this.historyIncomplete = true; return; }
    const span = duration !== null && duration !== undefined && Number.isSafeInteger(duration) && duration > 0
      && Number.isSafeInteger(timestamp + duration) ? duration : null;
    const time = Number.isFinite(renderTimeUs) ? renderTimeUs : null;
    if (timestamp <= this.retiredTimestampFloor && !this.inputs.has(timestamp)) return;
    this.pending.push({ timestamp, duration: span, renderTimeUs: time });
    if (this.pending.length > this.maxInputs) this.pending.shift();
    const old = this.inputs.get(timestamp);
    if (old) {
      // Repeated PTS remain ambiguous after output; never transfer ownership.
      old.ambiguous = true;
      if (old.renderTimeUs !== time) old.renderTimeUs = null;
      old.duration = old.duration === null || span === null ? null : Math.max(old.duration, span);
      return;
    }
    if (this.inputs.size >= this.maxInputs) {
      const first = this.inputs.keys().next().value!;
      this.inputs.delete(first);
      this.retiredTimestampFloor = Math.max(this.retiredTimestampFloor, first);
      if (!this.outputSeen || !this.initialPrimingOnly) this.historyIncomplete = true;
    }
    const input: AudioTimingInput = { timestamp, duration: span, renderTimeUs: time, ambiguous: false };
    this.inputs.set(timestamp, input);
    return input;
  }

  poison(timestamp: number): void {
    const input = this.inputs.get(timestamp);
    if (input) { input.ambiguous = true; input.renderTimeUs = null; }
    // The failed submission never reached the decoder, so no output will consume it.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.timestamp === timestamp) { this.pending.splice(i, 1); break; }
    }
  }

  resolve(timestamp: number): AudioTimingResult {
    const matched = this.match(timestamp);
    if (matched.renderTimeUs !== null && Number.isFinite(matched.renderTimeUs)) {
      // Outputs arrive in decode order: submissions before this one produced no output.
      const owner = matched.input?.timestamp ?? timestamp;
      const index = this.pending.findIndex(entry => entry.timestamp === owner);
      if (index >= 0) this.pending.splice(0, index + 1);
      return { renderTimeUs: matched.renderTimeUs, input: matched.input };
    }
    const fallback = this.takePending(timestamp);
    return { renderTimeUs: fallback?.renderTimeUs ?? 0, input: matched.input };
  }

  /** Nearest pending timestamp within one frame (FIFO tie-break), else the oldest pending submission. */
  private takePending(timestamp: number): PendingSubmission | undefined {
    let index = -1;
    if (Number.isFinite(timestamp)) {
      let best = Infinity;
      this.pending.forEach((entry, i) => {
        const distance = Math.abs(entry.timestamp - timestamp);
        if (entry.duration !== null && distance < entry.duration && distance < best) { best = distance; index = i; }
      });
    }
    if (index < 0) index = this.pending.findIndex(entry => entry.renderTimeUs !== null);
    if (index < 0) { this.pending.length = 0; return; }
    const entry = this.pending[index];
    this.pending.splice(0, index + 1);
    return entry;
  }

  private match(timestamp: number): { renderTimeUs: number | null; input: AudioTimingInput | null } {
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
    for (const input of this.inputs.values()) {
      const contains = timestamp >= input.timestamp && (input.duration === null || timestamp < input.timestamp + input.duration);
      if (!contains) continue;
      count++; matched = input;
      const time = input.renderTimeUs === null ? null : input.renderTimeUs + (timestamp - input.timestamp);
      commonTime = commonTime === undefined ? time : commonTime === time ? commonTime : null;
    }
    return { renderTimeUs: commonTime !== undefined && commonTime !== null && Number.isFinite(commonTime) ? commonTime : null,
      input: count === 1 && matched && !matched.ambiguous ? matched : null };
  }

  clear(): void {
    this.inputs.clear(); this.retiredTimestampFloor = -Infinity; this.outputSeen = false; this.historyIncomplete = false; this.pending = [];
  }
}

interface PendingSubmission {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly renderTimeUs: number | null;
}
