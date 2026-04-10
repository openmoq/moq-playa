/**
 * WatchdogController — timeout-based diagnostic events.
 *
 * Detects "nothing happened" scenarios by setting expectations for
 * events that should arrive within a deadline. If the deadline passes
 * without the event being fulfilled, a timeout callback fires.
 *
 * A warning callback fires at 50% of the deadline as an early signal.
 *
 * Usage:
 * ```ts
 * const wd = new WatchdogController({
 *   onTimeout: (e) => console.warn(`Timeout: ${e.event} after ${e.timeoutMs}ms`),
 *   onWarning: (e) => console.log(`Waiting for ${e.event} (${e.elapsedMs}ms)`),
 * });
 *
 * wd.expect('catalog_received', 10000);
 * // ... later, when catalog arrives:
 * wd.fulfill('catalog_received');
 * ```
 *
 * @module
 */

/** Timeout event — expected event did not arrive within deadline. */
export interface WatchdogTimeout {
  readonly event: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
}

/** Warning event — 50% of deadline elapsed without fulfillment. */
export interface WatchdogWarning {
  readonly event: string;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}

/** WatchdogController configuration. */
export interface WatchdogOptions {
  readonly onTimeout?: (event: WatchdogTimeout) => void;
  readonly onWarning?: (event: WatchdogWarning) => void;
}

interface PendingExpectation {
  timeoutMs: number;
  startedAt: number;
  timeoutTimer: ReturnType<typeof setTimeout>;
  warningTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Watches for expected events and fires diagnostics when they don't arrive.
 */
export class WatchdogController {
  private readonly onTimeout: ((event: WatchdogTimeout) => void) | undefined;
  private readonly onWarning: ((event: WatchdogWarning) => void) | undefined;
  private readonly expectations = new Map<string, PendingExpectation>();

  constructor(options: WatchdogOptions) {
    this.onTimeout = options.onTimeout;
    this.onWarning = options.onWarning;
  }

  /**
   * Set an expectation: `event` should be fulfilled within `timeoutMs`.
   * If already expected, resets the timer.
   */
  expect(event: string, timeoutMs: number): void {
    this.cancel(event);

    const startedAt = Date.now();

    const timeoutTimer = setTimeout(() => {
      this.expectations.delete(event);
      this.onTimeout?.({
        event,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    // Warning at 50% of deadline
    let warningTimer: ReturnType<typeof setTimeout> | null = null;
    if (this.onWarning) {
      const warningMs = Math.floor(timeoutMs / 2);
      warningTimer = setTimeout(() => {
        this.onWarning?.({
          event,
          elapsedMs: warningMs,
          timeoutMs,
        });
      }, warningMs);
    }

    this.expectations.set(event, { timeoutMs, startedAt, timeoutTimer, warningTimer });
  }

  /** Mark an expected event as fulfilled — cancels its pending timers. */
  fulfill(event: string): void {
    this.cancel(event);
  }

  /** Currently pending expectation names. */
  get activeExpectations(): string[] {
    return [...this.expectations.keys()];
  }

  /** Cancel all pending timers and release resources. */
  destroy(): void {
    for (const [, entry] of this.expectations) {
      clearTimeout(entry.timeoutTimer);
      if (entry.warningTimer) clearTimeout(entry.warningTimer);
    }
    this.expectations.clear();
  }

  private cancel(event: string): void {
    const entry = this.expectations.get(event);
    if (entry) {
      clearTimeout(entry.timeoutTimer);
      if (entry.warningTimer) clearTimeout(entry.warningTimer);
      this.expectations.delete(event);
    }
  }
}
