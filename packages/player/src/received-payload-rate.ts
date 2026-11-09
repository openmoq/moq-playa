/** Received payload rate for one selected source lifetime, not available link capacity. */
export class ReceivedPayloadRate {
  // Measurement policy: one-second windows, five seconds of warmup, and no
  // inference through an observation gap longer than five seconds.
  private static readonly WINDOW_US = 1_000_000;
  private static readonly WARMUP_US = 5_000_000;
  private static readonly MAX_GAP_US = 5_000_000;
  private static readonly TAU_US = -1_000_000 / Math.log(0.7);
  private startUs: number | null = null;
  private lastUs: number | null = null;
  private bytes = 0;
  private observedUs = 0;
  private estimateKbps: number | null = null;

  /** The first arrival seeds the clock; its transfer began before observation. */
  observe(bytes: number, nowUs: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !this.acceptClock(nowUs)) {
      this.reset(); return;
    }
    if (this.startUs === null) { this.startUs = nowUs; return; }
    if (bytes > Number.MAX_SAFE_INTEGER - this.bytes) { this.reset(); return; }
    this.bytes += bytes;
    // A closing arrival belongs to the interval it closes, never both windows.
    this.closeWindow(nowUs);
  }

  /** Called by the existing player tick, including when no payload arrives. */
  advance(nowUs: number): void {
    if (!this.acceptClock(nowUs)) { this.reset(); return; }
    this.closeWindow(nowUs);
  }

  read(nowUs: number): number | null {
    this.advance(nowUs);
    return this.observedUs >= ReceivedPayloadRate.WARMUP_US ? this.estimateKbps : null;
  }

  reset(): void {
    this.startUs = this.lastUs = this.estimateKbps = null;
    this.bytes = this.observedUs = 0;
  }

  private acceptClock(nowUs: number): boolean {
    if (!Number.isFinite(nowUs) || nowUs < 0 || (this.lastUs !== null && nowUs < this.lastUs)) return false;
    if (this.lastUs !== null && nowUs - this.lastUs > ReceivedPayloadRate.MAX_GAP_US) this.reset();
    this.lastUs = nowUs;
    return true;
  }

  private closeWindow(nowUs: number): void {
    if (this.startUs === null) return;
    const elapsedUs = nowUs - this.startUs;
    if (elapsedUs < ReceivedPayloadRate.WINDOW_US) return;
    const rate = this.bytes * 8000 / elapsedUs;
    const weight = -Math.expm1(-elapsedUs / ReceivedPayloadRate.TAU_US);
    this.estimateKbps = this.estimateKbps === null ? rate
      : weight * rate + (1 - weight) * this.estimateKbps;
    this.observedUs = Math.min(ReceivedPayloadRate.WARMUP_US, this.observedUs + elapsedUs);
    this.startUs = nowUs;
    this.bytes = 0;
  }
}
