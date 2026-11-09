/**
 * Live catch-up: play slightly faster while more media is buffered ahead of
 * playout than delivery needs, so latency added to ride out congestion drains
 * away without a jump.
 *
 * The excess is media received beyond a floor kept for delivery jitter. Where
 * end-to-end latency is measurable, catch-up also stops at the target latency:
 * it never plays closer to live than the target asks.
 *
 * @see draft-ietf-moq-msf-00 §5.1.16 (targetLatency)
 */
export interface LiveCatchUpOptions {
  /** Fastest playback rate (≥ 1). 1 disables catch-up. */
  readonly maxRate: number;
  /** Excess (µs) above which catch-up starts. */
  readonly thresholdUs: number;
  /** Excess (µs) at or below which catch-up stops (hysteresis). */
  readonly recoveryUs: number;
  /** Media (µs) kept buffered ahead of playout for delivery jitter. */
  readonly floorAheadUs: number;
}

export interface LiveCatchUpDecision {
  readonly active: boolean;
  readonly rate: number;
  /** Excess (µs) the decision was made on. */
  readonly excessUs: number;
}

export class LiveCatchUp {
  private active = false;
  private rate = 1;

  constructor(private readonly options: LiveCatchUpOptions) {}

  /**
   * @param aheadUs Media received ahead of playout.
   * @param latencyUs End-to-end playout latency, or null where unmeasurable.
   * @param targetLatencyUs Target latency, if any.
   */
  evaluate(aheadUs: number, latencyUs: number | null, targetLatencyUs: number | undefined): LiveCatchUpDecision {
    const { maxRate, thresholdUs, recoveryUs, floorAheadUs } = this.options;
    let excessUs = aheadUs - floorAheadUs;
    if (latencyUs !== null && targetLatencyUs !== undefined) excessUs = Math.min(excessUs, latencyUs - targetLatencyUs);
    if (maxRate <= 1) return this.set(false, 1, excessUs);
    if (!this.active && excessUs > thresholdUs) this.active = true;
    else if (this.active && excessUs <= recoveryUs) return this.set(false, 1, excessUs);
    if (!this.active) return this.set(false, 1, excessUs);
    // Proportional to the excess, in 0.05× steps so the rate does not churn —
    // rounded up, so while active any excess still drains.
    const ratio = Math.min(Math.max(excessUs / thresholdUs, 0), 1);
    const stepped = Math.ceil((1 + (maxRate - 1) * ratio) * 20 - 1e-9) / 20;
    return this.set(true, Math.min(Math.max(stepped, 1), maxRate), excessUs);
  }

  get currentRate(): number { return this.rate; }

  private set(active: boolean, rate: number, excessUs: number): LiveCatchUpDecision {
    this.active = active;
    this.rate = rate;
    return { active, rate, excessUs };
  }
}
