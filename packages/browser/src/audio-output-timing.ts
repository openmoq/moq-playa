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
 */
export class AudioOutputTiming {
  private readonly inputs = new Map<number, AudioTimingInput>();
  private retiredTimestampFloor = -Infinity;
  private outputSeen = false;
  private historyIncomplete = false;
  constructor(private readonly maxInputs = 256, private readonly initialPrimingOnly = true) {
    if (!Number.isSafeInteger(maxInputs) || maxInputs <= 0) throw new TypeError('Expected a positive safe timing limit');
  }

  remember(timestamp: number, duration: number | null | undefined, renderTimeUs: number): AudioTimingInput | undefined {
    if (!Number.isSafeInteger(timestamp)) { if (!this.outputSeen || !this.initialPrimingOnly) this.historyIncomplete = true; return; }
    const span = duration !== null && duration !== undefined && Number.isSafeInteger(duration) && duration > 0
      && Number.isSafeInteger(timestamp + duration) ? duration : null;
    const time = Number.isFinite(renderTimeUs) ? renderTimeUs : null;
    const old = this.inputs.get(timestamp);
    if (old) {
      // Repeated PTS remain ambiguous after output; never transfer ownership.
      old.ambiguous = true;
      if (old.renderTimeUs !== time) old.renderTimeUs = null;
      old.duration = old.duration === null || span === null ? null : Math.max(old.duration, span);
      return;
    }
    if (timestamp <= this.retiredTimestampFloor) return;
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
  }

  resolve(timestamp: number): AudioTimingResult {
    const canTrim = !this.outputSeen || !this.initialPrimingOnly;
    // The native callback proves positive output, even when association is refused.
    this.outputSeen = true;
    if (!Number.isSafeInteger(timestamp) || (canTrim && this.historyIncomplete)) return { renderTimeUs: 0, input: null };
    if (!canTrim) {
      const input = this.inputs.get(timestamp);
      const time = input?.renderTimeUs;
      return { renderTimeUs: typeof time === 'number' && Number.isFinite(time) ? time : 0,
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
    return { renderTimeUs: commonTime !== undefined && commonTime !== null && Number.isFinite(commonTime) ? commonTime : 0,
      input: count === 1 && matched && !matched.ambiguous ? matched : null };
  }

  clear(): void {
    this.inputs.clear(); this.retiredTimestampFloor = -Infinity; this.outputSeen = false; this.historyIncomplete = false;
  }
}
