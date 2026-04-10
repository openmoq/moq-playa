/**
 * rAF-based timeupdate emitter.
 *
 * Fires a callback at ~4Hz (every 250ms), matching the HTMLMediaElement
 * timeupdate event frequency. Uses requestAnimationFrame for power
 * efficiency (pauses when tab is hidden).
 *
 * @module
 */

/** Options for TimeController construction. */
export interface TimeControllerOptions {
  /** Emit interval in ms. Default: 250 (~4Hz like HTMLMediaElement). */
  readonly intervalMs?: number;
}

/**
 * Periodic timer using requestAnimationFrame.
 *
 * More power-efficient than setInterval — automatically pauses when
 * the tab is hidden and resumes when visible.
 */
export class TimeController {
  private rafId: number | null = null;
  private running = false;
  private lastEmitMs = 0;
  private readonly intervalMs: number;
  private readonly onTick: () => void;

  constructor(onTick: () => void, options?: TimeControllerOptions) {
    this.onTick = onTick;
    this.intervalMs = options?.intervalMs ?? 250;
  }

  /** Start emitting ticks. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastEmitMs = 0;
    this.loop();
  }

  /** Stop emitting ticks. */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Whether the controller is currently running. */
  get active(): boolean { return this.running; }

  private loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    if (now - this.lastEmitMs >= this.intervalMs) {
      this.lastEmitMs = now;
      this.onTick();
    }
    this.rafId = requestAnimationFrame(this.loop);
  };
}
