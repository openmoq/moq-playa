type RetuneOperations = {
  stop(): Promise<void>;
  start(altGroup: number, signal: AbortSignal): Promise<void>;
};

export function parseVideoAltGroup(value: string | null): number | undefined {
  if (value === null) return undefined;
  const group = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(group)) {
    throw new Error('altGroup must be a safe integer');
  }
  return group;
}

function within(promise: Promise<void>, ms: number, label: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (callback: (value?: unknown) => void, value?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      callback(value);
    };
    const aborted = () => finish(reject, signal?.reason ?? new Error('View change cancelled'));
    const timer = setTimeout(() => finish(reject, new Error(`View ${label} timed out after ${ms}ms`)), ms);
    signal?.addEventListener('abort', aborted, { once: true });
    promise.then(() => finish(() => resolve()), error => finish(reject, error));
    if (signal?.aborted) aborted();
  });
}

/** A timed-out teardown still owns its resources until it actually finishes. */
export class TeardownBarrier {
  private pending: Promise<void> | undefined;
  constructor(private readonly timeoutMs = 15_000) {}
  run(operation: () => Promise<void>): Promise<void> {
    const previous = this.pending;
    const pending = previous ? previous.then(operation) : operation();
    this.pending = pending;
    void pending.then(() => {
      if (this.pending === pending) this.pending = undefined;
    }, () => {});
    return pending;
  }
  wait(): Promise<void> {
    return this.pending ? within(this.pending, this.timeoutMs, 'teardown') : Promise.resolve();
  }
}

/** Owns one stop-and-retune transaction; quality switching stays separate. */
export class ViewRetuner {
  private controller: AbortController | undefined;
  constructor(private readonly operations: RetuneOperations, private readonly timeoutMs = 15_000) {}
  get busy(): boolean { return this.controller !== undefined; }
  cancel(): void { this.controller?.abort(new Error('View change cancelled')); }
  async change(altGroup: number, groups: readonly { altGroup: number }[], current: number | undefined): Promise<boolean> {
    if (this.busy) return false;
    if (!Number.isSafeInteger(altGroup) || !groups.some(group => group.altGroup === altGroup)) {
      throw new Error(`Unknown video altGroup: ${altGroup}`);
    }
    if (altGroup === current) return false;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await within(this.operations.stop(), this.timeoutMs, 'teardown');
      if (controller.signal.aborted) return false;
      try {
        await within(this.operations.start(altGroup, controller.signal), this.timeoutMs, 'startup', controller.signal);
      } catch (error) {
        const cancelled = controller.signal.aborted;
        controller.abort(error);
        await within(this.operations.stop(), this.timeoutMs, 'cleanup');
        if (cancelled) return false;
        throw error;
      }
      return !controller.signal.aborted;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
