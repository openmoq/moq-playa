/** One player policy; output implementations move audio and video together. */
export interface PlaybackRateOutput {
  getBufferAheadUs(): number | null;
  latencyUs?(): number | null;
  setPlaybackRate(rate: number): void;
}
export interface LiveCatchUpOptions {
  readonly maxRate: number;
  readonly thresholdUs: number;
  readonly recoveryUs: number;
  readonly floorAheadUs: number;
}
const STANDING_WINDOW_US = 2_000_000;
export class LiveCatchUp {
  latencyUs = 0;
  targetUs = 0;
  private active = false;
  private rate = 1;
  private output: PlaybackRateOutput | null = null;
  private readonly window: Array<{ at: number; ahead: number }> = [];
  constructor(private readonly options: LiveCatchUpOptions) {}
  get currentRate(): number { return this.rate; }
  reset(): void {
    const output = this.output, changed = this.rate !== 1;
    this.output = null; this.active = false; this.rate = 1; this.window.length = 0;
    if (changed) output?.setPlaybackRate(1);
  }
  tick(output: PlaybackRateOutput, now: number, current: () => boolean = () => true, targetUs?: number) {
    if (this.output !== output) { this.reset(); this.output = output; }
    const ahead = output.getBufferAheadUs();
    if (this.output !== output || !current()) return null;
    if (ahead === null || !Number.isFinite(ahead) || ahead < 0) {
      const changed = this.rate !== 1; this.reset();
      return changed ? { active: false, rate: 1, excessUs: 0 } : null;
    }
    const window = this.window;
    window.push({ at: now, ahead });
    // Retain the sample spanning the start of the two-second standing window.
    while (window.length > 1 && window[1]!.at <= now - STANDING_WINDOW_US) window.shift();
    let standing = now - window[0]!.at < STANDING_WINDOW_US ? 0 : Infinity;
    for (const sample of window) standing = Math.min(standing, sample.ahead);
    const latency = output.latencyUs?.() ?? null;
    this.latencyUs = latency ?? standing; this.targetUs = targetUs ?? 0;
    const previous = this.rate, decision = this.evaluate(standing, latency, targetUs);
    if (decision.rate === previous) return null;
    output.setPlaybackRate(decision.rate);
    return this.output === output ? decision : null;
  }
  evaluate(aheadUs: number, latencyUs: number | null, targetLatencyUs: number | undefined) {
    const { maxRate, thresholdUs, recoveryUs, floorAheadUs } = this.options;
    let excessUs = aheadUs - floorAheadUs;
    if (latencyUs !== null && targetLatencyUs !== undefined) excessUs = Math.min(excessUs, latencyUs - targetLatencyUs);
    if (maxRate <= 1) this.active = false;
    else if (!this.active && excessUs > thresholdUs) this.active = true;
    else if (this.active && excessUs <= recoveryUs) this.active = false;
    const ratio = Math.min(Math.max(excessUs / Math.max(1, thresholdUs), 0), 1);
    this.rate = this.active ? Math.min(Math.ceil((1 + (maxRate - 1) * ratio) * 20 - 1e-9) / 20, maxRate) : 1;
    return { active: this.active, rate: this.rate, excessUs };
  }
}
